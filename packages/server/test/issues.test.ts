import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectsWithUngroupedErrors, reprocessIssues } from '../src/reprocess.js';
import {
  cookieFrom,
  hasDatabase,
  ORIGIN,
  projectWithKey,
  setupAdmin,
  testApp,
  type TestApp,
} from './helpers.js';

const STACK = (line: number, fn = 'closeSession') =>
  `TypeError: Cannot read properties of null (reading 'id')
    at ${fn} (/app/src/services/sessionService.js:${line}:31)
    at async reconcile (/app/src/jobs/reconciler.js:88:7)
    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)`;

interface IssueItem {
  id: number;
  title: string;
  culprit: string | null;
  status: string;
  count: number;
  rangeCount: number;
  spark: number[];
  regressedAt: string | null;
  firstSeen: string;
}

describe.skipIf(!hasDatabase)('issues', () => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let key: string;
  let projectId: number;
  const now = Date.now();
  const range = `from=${now - 3 * 3_600_000}&to=${now + 60_000}`;

  beforeAll(async () => {
    t = await testApp();
    cookie = await setupAdmin(t.app);
    ({ slug, key } = await projectWithKey(t.app, cookie, 'Issues'));
    projectId = Number(
      (await t.pool.query<{ id: number }>('SELECT id FROM projects WHERE slug = $1', [slug]))
        .rows[0]!.id,
    );
  });
  afterAll(async () => {
    await t?.close();
  });

  const send = async (events: object[]) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ events }),
    });
    expect(res.statusCode).toBe(202);
    return res.json<{ accepted: number; duplicates: number }>();
  };
  const get = async <T>(path: string, as = cookie): Promise<T> => {
    const res = await t.app.inject({
      url: `/api/v1/projects/${slug}${path}`,
      headers: { cookie: as },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };
  const setStatus = (id: number, status: string, as = cookie) =>
    t.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${slug}/issues/${id}`,
      headers: { cookie: as, origin: ORIGIN },
      payload: { status },
    });
  const error = (id: string, minutesAgo: number, extra: object = {}) => ({
    type: 'log',
    id,
    time: now - minutesAgo * 60_000,
    level: 'error',
    message: 'handler failed',
    service: 'api',
    ...extra,
  });
  const issues = (query = '') =>
    get<{ items: IssueItem[]; totals: Record<string, number> }>(`/issues?${range}${query}`);

  it('groups errors by type and code location, ignoring line numbers and messages', async () => {
    await send([
      error('a1', 30, {
        requestId: 'r-1',
        error: { type: 'TypeError', message: "reading 'id'", stack: STACK(212) },
      }),
      error('a2', 20, {
        error: { type: 'TypeError', message: "reading 'name'", stack: STACK(230) },
      }),
      error('b1', 10, { error: { type: 'RangeError', message: 'bad', stack: STACK(212) } }),
      error('c1', 9, { error: { message: 'lock wait timeout on row 17' } }),
      error('c2', 8, { error: { message: 'lock wait timeout on row 9001' } }),
      {
        type: 'log',
        id: 'w1',
        time: now - 60_000,
        level: 'warn',
        message: 'warnings are not issues',
      },
      {
        type: 'request',
        time: now - 30 * 60_000 + 5,
        method: 'POST',
        path: '/api/sessions/7/close',
        status: 500,
        requestId: 'r-1',
      },
    ]);
    const list = await issues();
    // Newest first; the title is the first occurrence's.
    expect(list.items.map((i) => [i.title, i.count])).toEqual([
      ['lock wait timeout on row 17', 2],
      ['RangeError: bad', 1],
      ["TypeError: reading 'id'", 2],
    ]);
    expect(list.items[2]!.culprit).toBe('closeSession (services/sessionService.js)');
    expect(list.totals).toEqual({ unresolved: 3, resolved: 0, ignored: 0 });
    expect(list.items[2]!.rangeCount).toBe(2);
    expect(list.items[2]!.spark.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('a resent batch adds nothing to an issue', async () => {
    await send([
      error('a1', 30, { error: { type: 'TypeError', message: "reading 'id'", stack: STACK(212) } }),
    ]);
    const typeError = (await issues()).items.find((i) => i.title.startsWith('TypeError'))!;
    expect(typeError.count).toBe(2);
  });

  it('shows an issue with its stack, occurrences, the requests they hit, and why it was grouped', async () => {
    const typeError = (await issues()).items.find((i) => i.title.startsWith('TypeError'))!;
    const detail = await get<{
      issue: { groupingKey: string };
      rangeCount: number;
      series: { count: number }[];
      latest: { errorStack: string; errorMessage: string };
      occurrences: {
        requestId: string | null;
        request: { method: string; status: number } | null;
      }[];
      routes: { items: { method: string; route: string; count: number }[]; withRequest: number };
    }>(`/issues/${typeError.id}?${range}`);
    expect(detail.rangeCount).toBe(2);
    expect(detail.series.reduce((a, p) => a + p.count, 0)).toBe(2);
    expect(detail.latest.errorMessage).toBe("reading 'name'");
    expect(detail.latest.errorStack).toContain('sessionService.js:230');
    expect(detail.issue.groupingKey).toContain('at closeSession (services/sessionService.js)');
    const linked = detail.occurrences.find((o) => o.requestId === 'r-1')!;
    expect(linked.request).toMatchObject({ method: 'POST', status: 500 });
    expect(detail.routes.items).toEqual([
      { method: 'POST', route: '/api/sessions/:id/close', count: 1 },
    ]);

    const log = await get<{ items: { ref: string }[] }>(`/logs?${range}&minLevel=error&q=reading`);
    const logDetail = await get<{ log: { issueId: number } }>(
      `/logs/${encodeURIComponent(log.items[0]!.ref)}`,
    );
    expect(logDetail.log.issueId).toBe(typeError.id);
  });

  it('a resolved issue reopens as a regression when it happens again, but not for older events', async () => {
    const lock = (await issues()).items.find((i) => i.title.startsWith('lock wait'))!;
    expect((await setStatus(lock.id, 'resolved')).statusCode).toBe(200);
    expect((await issues('&status=resolved')).items.map((i) => i.id)).toEqual([lock.id]);

    // Backfilled from before the resolution: stays resolved.
    await send([error('c-old', 60, { error: { message: 'lock wait timeout on row 3' } })]);
    let again = (await issues('&status=all')).items.find((i) => i.id === lock.id)!;
    expect(again.status).toBe('resolved');
    expect(again.count).toBe(3);

    // Stamped from the clock now, not from `now`: on a busy machine the
    // resolution can land more than a few seconds after this file loaded.
    await send([
      {
        ...error('c-new', 0, { error: { message: 'lock wait timeout on row 4' } }),
        time: Date.now() + 1_000,
      },
    ]);
    again = (await issues()).items.find((i) => i.id === lock.id)!;
    expect(again.status).toBe('unresolved');
    expect(again.regressedAt).not.toBeNull();
  });

  it('an ignored issue stays ignored, and members can triage', async () => {
    const range = (await issues()).items.find((i) => i.title.startsWith('RangeError'))!;
    const invite = await t.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie, origin: ORIGIN },
      payload: { email: 'member@example.com', role: 'member' },
    });
    const member = cookieFrom(
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/auth/invites/${invite.json<{ token: string }>().token}/accept`,
        headers: { origin: ORIGIN },
        payload: { name: 'M', password: 'correct horse battery' },
      }),
    );
    expect((await setStatus(range.id, 'ignored', member)).statusCode).toBe(200);
    await send([
      error('b2', -0.1, { error: { type: 'RangeError', message: 'bad', stack: STACK(1) } }),
    ]);
    const ignored = (await issues('&status=ignored')).items.find((i) => i.id === range.id)!;
    expect(ignored.count).toBe(2);
    expect((await setStatus(range.id, 'bogus')).statusCode).toBe(400);
  });

  it('a viewer sees the issues but cannot change them', async () => {
    const range = (await issues('&status=ignored')).items.find((i) =>
      i.title.startsWith('RangeError'),
    )!;
    const invite = await t.app.inject({
      method: 'POST',
      url: '/api/v1/invites',
      headers: { cookie, origin: ORIGIN },
      payload: { email: 'viewer@example.com', role: 'viewer' },
    });
    const viewer = cookieFrom(
      await t.app.inject({
        method: 'POST',
        url: `/api/v1/auth/invites/${invite.json<{ token: string }>().token}/accept`,
        headers: { origin: ORIGIN },
        payload: { name: 'V', password: 'correct horse battery' },
      }),
    );
    const seen = await get<{ items: IssueItem[] }>('/issues?status=ignored', viewer);
    expect(seen.items.map((i) => i.id)).toContain(range.id);
    await get(`/issues/${range.id}`, viewer);

    expect((await setStatus(range.id, 'unresolved', viewer)).statusCode).toBe(403);
    const after = (await issues('&status=ignored')).items.find((i) => i.id === range.id)!;
    expect(after.status).toBe('ignored');
  });

  it('numbers issues densely: batches that only add occurrences use up no numbers', async () => {
    const before = Number(
      (await t.pool.query<{ max: number }>('SELECT max(id) AS max FROM issues')).rows[0]!.max,
    );
    for (let i = 0; i < 5; i++) {
      await send([error(`dense-${i}`, 1, { error: { message: 'pool is closed' } })]);
    }
    // The next new issue takes the very next number.
    await send([error('dense-new', 1, { error: { message: 'disk full' } })]);
    const ids = (
      await t.pool.query<{ id: number }>('SELECT id FROM issues WHERE id > $1 ORDER BY id', [
        before,
      ])
    ).rows;
    expect(ids.map((r) => Number(r.id))).toEqual([before + 1, before + 2]);
  });

  it('lists the top unresolved issues for the overview', async () => {
    const top = await get<{ items: { title: string; rangeCount: number }[]; newIssues: number }>(
      `/issues/top?${range}`,
    );
    expect(top.items.map((i) => i.title)).toEqual([
      'pool is closed',
      'lock wait timeout on row 17',
      "TypeError: reading 'id'",
      'disk full',
    ]);
    expect(top.newIssues).toBe(5);
  });

  it('regroups stored errors, keeping statuses, and finds errors stored before issues existed', async () => {
    const before = (await issues('&status=all')).items;
    // Errors from before issues existed: no issue at all.
    await t.pool.query(`UPDATE log_events SET issue_id = NULL WHERE project_id = $1`, [projectId]);
    await t.pool.query(`DELETE FROM issues WHERE project_id = $1 AND title LIKE 'RangeError%'`, [
      projectId,
    ]);
    expect(await projectsWithUngroupedErrors(t.pool)).toContain(projectId);

    const first = await reprocessIssues(t.pool, projectId);
    expect(first).toMatchObject({ events: 14, moved: 14, issuesAfter: 5 });
    const after = (await issues('&status=all')).items;
    expect(after.map((i) => [i.title, i.count, i.status]).sort()).toEqual(
      before
        .map((i) => [i.title, i.count, i.title.startsWith('RangeError') ? 'unresolved' : i.status])
        .sort(),
    );
    expect(await projectsWithUngroupedErrors(t.pool)).not.toContain(projectId);

    // Nothing changed since: nothing to do.
    expect(await reprocessIssues(t.pool, projectId)).toMatchObject({
      moved: 0,
      issuesBefore: 5,
      issuesAfter: 5,
    });

    // A grouping change (here: a fingerprint that no longer matches) moves the
    // events to a new issue, which inherits the old one's status.
    const typeError = after.find((i) => i.title.startsWith('TypeError'))!;
    await setStatus(typeError.id, 'resolved');
    await t.pool.query(`UPDATE issues SET fingerprint = 'from-older-rules' WHERE id = $1`, [
      typeError.id,
    ]);
    const regrouped = await reprocessIssues(t.pool, projectId);
    expect(regrouped.moved).toBe(2);
    const replaced = (await issues('&status=all')).items.find((i) =>
      i.title.startsWith('TypeError'),
    )!;
    expect(replaced.id).not.toBe(typeError.id);
    expect(replaced.status).toBe('resolved');
    expect(
      (await t.pool.query('SELECT 1 FROM issues WHERE id = $1', [typeError.id])).rowCount,
    ).toBe(0);
  });
});
