import { GROUPING_VERSION } from '@apiloupe/shared';
import type pg from 'pg';
import { withTransaction } from './db.js';
import { ISSUE_LEVEL, issueGroupFor, type IssueGroup } from './issues.js';

const HOUR_MS = 3_600_000;
const CHUNK = 5000;

export interface ReprocessResult {
  events: number;
  /** Events whose issue changed (including ones that had none). */
  moved: number;
  issuesBefore: number;
  issuesAfter: number;
}

interface Group extends IssueGroup {
  count: number;
  first: number;
  last: number;
  lastId: string;
  level: number;
  hours: Map<number, number>;
  /** How many of its events each old issue held: the new issue inherits the status of the biggest. */
  votes: Map<number, number>;
}

interface StoredError {
  time: Date;
  id: string;
  service: string;
  level: number;
  message: string;
  error_type: string | null;
  error_message: string | null;
  error_stack: string | null;
  issue_id: number | null;
  weight: number;
}

interface ExistingIssue {
  id: number;
  fingerprint: string;
  grouping_version: number;
  status: string;
  resolved_at: Date | null;
  regressed_at: Date | null;
  count: number;
  first_seen: Date;
  last_seen: Date;
}

/**
 * Regroups a project's stored error events with the current grouping rules.
 * Run after the rules change, and (automatically, at boot) for events stored
 * before issues existed. Idempotent: with unchanged rules and nothing
 * ungrouped, it changes nothing.
 *
 * An issue whose grouping is unchanged keeps its id, status and history. A
 * new group inherits the status of the old issue most of its events came
 * from, so a resolved issue stays resolved through a regrouping. Old issues
 * left with none of their events are removed.
 *
 * Runs in one transaction holding a lock on `issues`, so ingest of error
 * events waits while it runs.
 */
export async function reprocessIssues(pool: pg.Pool, projectId: number): Promise<ReprocessResult> {
  return withTransaction(pool, async (client) => {
    await client.query('LOCK TABLE issues IN SHARE ROW EXCLUSIVE MODE');
    const existing = (
      await client.query<ExistingIssue>(
        `SELECT id, fingerprint, grouping_version, status, resolved_at, regressed_at, count, first_seen, last_seen
           FROM issues WHERE project_id = $1`,
        [projectId],
      )
    ).rows.map((row) => ({ ...row, id: Number(row.id) }));
    const byFingerprint = new Map(existing.map((issue) => [issue.fingerprint, issue]));

    // 1. Every stored error event, regrouped.
    const groups = new Map<string, Group>();
    const events: { time: Date; id: string; fingerprint: string; oldIssue: number | null }[] = [];
    let cursor: { time: Date; id: string } | null = null;
    for (;;) {
      const { rows }: pg.QueryResult<StoredError> = await client.query<StoredError>(
        `SELECT time, id, service, level, message, error_type, error_message, error_stack, issue_id, weight
           FROM log_events
          WHERE project_id = $1 AND level >= $2 ${cursor ? 'AND (time, id) > ($4, $5)' : ''}
          ORDER BY time, id LIMIT $3`,
        cursor
          ? [projectId, ISSUE_LEVEL, CHUNK, cursor.time, cursor.id]
          : [projectId, ISSUE_LEVEL, CHUNK],
      );
      for (const row of rows) {
        const group = issueGroupFor({
          service: row.service,
          message: row.message,
          errorType: row.error_type,
          errorMessage: row.error_message,
          errorStack: row.error_stack,
        });
        const t = row.time.getTime();
        let g = groups.get(group.fingerprint);
        if (!g) {
          g = {
            ...group,
            count: 0,
            first: t,
            last: t,
            lastId: row.id,
            level: row.level,
            hours: new Map(),
            votes: new Map(),
          };
          groups.set(group.fingerprint, g);
        }
        g.count += row.weight;
        g.first = Math.min(g.first, t);
        if (t >= g.last) {
          g.last = t;
          g.lastId = row.id;
        }
        g.level = Math.max(g.level, row.level);
        const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
        g.hours.set(hour, (g.hours.get(hour) ?? 0) + row.weight);
        const oldIssue = row.issue_id === null ? null : Number(row.issue_id);
        if (oldIssue !== null) g.votes.set(oldIssue, (g.votes.get(oldIssue) ?? 0) + 1);
        events.push({ time: row.time, id: row.id, fingerprint: group.fingerprint, oldIssue });
      }
      if (rows.length < CHUNK) break;
      const last: StoredError = rows[rows.length - 1]!;
      cursor = { time: last.time, id: last.id };
    }

    // 2. An issue for every group: the same issue when the grouping is
    // unchanged, otherwise a new one carrying the old status.
    const issueOf = new Map<string, number>();
    const kept = new Set<number>();
    const byId = new Map(existing.map((issue) => [issue.id, issue]));
    for (const g of [...groups.values()].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))) {
      const same = byFingerprint.get(g.fingerprint);
      if (same) {
        kept.add(same.id);
        issueOf.set(g.fingerprint, same.id);
        await client.query(
          // Same grouping, so the title and culprit it was created with stay.
          `UPDATE issues SET grouping_version = $2, grouping_key = $3, level = greatest(level, $4),
                  count = greatest(count, $5), first_seen = least(first_seen, $6),
                  last_seen = greatest(last_seen, $7),
                  last_event_time = CASE WHEN last_event_time IS NULL OR $7 >= last_event_time THEN $7 ELSE last_event_time END,
                  last_event_id = CASE WHEN last_event_time IS NULL OR $7 >= last_event_time THEN $8 ELSE last_event_id END
            WHERE id = $1`,
          [
            same.id,
            GROUPING_VERSION,
            g.key,
            g.level,
            g.count,
            new Date(g.first),
            new Date(g.last),
            g.lastId,
          ],
        );
        continue;
      }
      const heir = [...g.votes.entries()].sort((a, b) => b[1] - a[1])[0];
      const from = heir ? byId.get(heir[0]) : undefined;
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO issues (project_id, fingerprint, grouping_version, grouping_key, service, error_type, title,
                             culprit, level, count, first_seen, last_seen, last_event_time, last_event_id,
                             status, resolved_at, regressed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
          projectId,
          g.fingerprint,
          GROUPING_VERSION,
          g.key,
          g.service,
          g.errorType,
          g.title,
          g.culprit,
          g.level,
          g.count,
          new Date(g.first),
          new Date(g.last),
          g.lastId,
          from?.status ?? 'unresolved',
          from?.resolved_at ?? null,
          from?.regressed_at ?? null,
        ],
      );
      issueOf.set(g.fingerprint, Number(rows[0]!.id));
    }

    // 3. Point events at their (possibly new) issue, only where it changed.
    const moves = events.filter((e) => e.oldIssue !== issueOf.get(e.fingerprint));
    for (let i = 0; i < moves.length; i += CHUNK) {
      const chunk = moves.slice(i, i + CHUNK);
      await client.query(
        `UPDATE log_events l SET issue_id = u.issue
           FROM unnest($2::timestamptz[], $3::text[], $4::bigint[]) AS u(time, id, issue)
          WHERE l.project_id = $1 AND l.time = u.time AND l.id = u.id`,
        [
          projectId,
          chunk.map((e) => e.time),
          chunk.map((e) => e.id),
          chunk.map((e) => issueOf.get(e.fingerprint)),
        ],
      );
    }

    // 4. Hourly counts over the stored events' span, rebuilt. Older hours
    // (from events past retention) are kept.
    const touched = [...issueOf.values()];
    const oldest =
      events.length > 0 ? Math.floor(events[0]!.time.getTime() / HOUR_MS) * HOUR_MS : null;
    if (oldest !== null && touched.length > 0) {
      await client.query(
        'DELETE FROM issue_counts_hourly WHERE issue_id = ANY($1) AND hour >= $2',
        [touched, new Date(oldest)],
      );
      const ids: number[] = [];
      const hours: Date[] = [];
      const counts: number[] = [];
      for (const g of groups.values()) {
        for (const [hour, n] of g.hours) {
          ids.push(issueOf.get(g.fingerprint)!);
          hours.push(new Date(hour));
          counts.push(n);
        }
      }
      await client.query(
        `INSERT INTO issue_counts_hourly (issue_id, hour, count)
         SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::int[])`,
        [ids, hours, counts],
      );
    }

    // 5. Old issues that lost their events to other groups go. Issues whose
    // events simply expired stay, with their status, for regressions.
    const hadEvents = new Set(events.map((e) => e.oldIssue));
    const lost = existing
      .filter((issue) => !kept.has(issue.id) && hadEvents.has(issue.id))
      .map((issue) => issue.id);
    if (lost.length > 0) await client.query('DELETE FROM issues WHERE id = ANY($1)', [lost]);

    const { rows: after } = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM issues WHERE project_id = $1',
      [projectId],
    );
    return {
      events: events.length,
      moved: moves.length,
      issuesBefore: existing.length,
      issuesAfter: after[0]!.n,
    };
  });
}

/** Projects with error events that belong to no issue (stored before issues existed). */
export async function projectsWithUngroupedErrors(pool: pg.Pool): Promise<number[]> {
  const { rows } = await pool.query<{ project_id: number }>(
    `SELECT p.id AS project_id FROM projects p
      WHERE EXISTS (SELECT 1 FROM log_events l
                     WHERE l.project_id = p.id AND l.level >= $1 AND l.issue_id IS NULL)`,
    [ISSUE_LEVEL],
  );
  return rows.map((row) => Number(row.project_id));
}

/**
 * At boot: groups error events stored before issues existed (upgrades from
 * 0.2), project by project. Logs what it did; never throws.
 */
export async function groupStoredErrors(
  pool: pg.Pool,
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
): Promise<void> {
  try {
    for (const projectId of await projectsWithUngroupedErrors(pool)) {
      const result = await reprocessIssues(pool, projectId);
      log.info({ projectId, ...result }, 'grouped stored errors into issues');
    }
  } catch (err) {
    log.error({ err }, 'could not group stored errors into issues');
  }
}
