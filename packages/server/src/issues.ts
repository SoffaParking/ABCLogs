import { createHash } from 'node:crypto';
import { GROUPING_VERSION, groupingFor, LEVEL } from '@apiloupe/shared';
import type pg from 'pg';

/** Log lines at this level and above become issues. */
export const ISSUE_LEVEL = LEVEL.error;

const HOUR_MS = 3_600_000;

export interface ErrorFields {
  service: string;
  message: string;
  errorType: string | null;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface IssueGroup {
  fingerprint: string;
  key: string;
  service: string;
  errorType: string | null;
  title: string;
  culprit: string | null;
}

export function issueGroupFor(event: ErrorFields): IssueGroup {
  const grouping = groupingFor(event);
  return {
    fingerprint: createHash('sha256').update(grouping.key).digest('hex').slice(0, 32),
    key: grouping.key,
    service: event.service,
    errorType: event.errorType,
    title: grouping.title,
    culprit: grouping.culprit,
  };
}

/**
 * Finds or creates the issue for each group and returns their ids. Existing
 * rows are locked for the rest of the transaction in fingerprint order, so
 * concurrent batches touching the same issues queue up rather than deadlock.
 * Only groups never seen before are inserted, so issue numbers stay dense.
 */
export async function upsertIssues(
  client: pg.PoolClient,
  projectId: number,
  groups: (IssueGroup & { level: number; firstSeen: number; lastSeen: number })[],
): Promise<Map<string, number>> {
  if (groups.length === 0) return new Map();
  const ids = new Map<string, number>();
  const lockExisting = async (fingerprints: string[]) => {
    const { rows } = await client.query<{ id: number; fingerprint: string }>(
      `SELECT id, fingerprint FROM issues WHERE project_id = $1 AND fingerprint = ANY($2)
        ORDER BY fingerprint FOR UPDATE`,
      [projectId, fingerprints],
    );
    for (const row of rows) ids.set(row.fingerprint, Number(row.id));
  };
  await lockExisting(groups.map((g) => g.fingerprint));
  const missing = groups
    .filter((g) => !ids.has(g.fingerprint))
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
  if (missing.length === 0) return ids;
  const { rows } = await client.query<{ id: number; fingerprint: string }>(
    `INSERT INTO issues (project_id, fingerprint, grouping_version, grouping_key, service, error_type,
                         title, culprit, level, first_seen, last_seen)
     SELECT $1::bigint, u.*
       FROM unnest($2::text[], $3::int2[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                   $9::int2[], $10::timestamptz[], $11::timestamptz[]) AS u
     ON CONFLICT (project_id, fingerprint) DO NOTHING
     RETURNING id, fingerprint`,
    [
      projectId,
      missing.map((g) => g.fingerprint),
      missing.map(() => GROUPING_VERSION),
      missing.map((g) => g.key),
      missing.map((g) => g.service),
      missing.map((g) => g.errorType),
      missing.map((g) => g.title),
      missing.map((g) => g.culprit),
      missing.map((g) => g.level),
      missing.map((g) => new Date(g.firstSeen).toISOString()),
      missing.map((g) => new Date(g.lastSeen).toISOString()),
    ],
  );
  for (const row of rows) ids.set(row.fingerprint, Number(row.id));
  // Another batch created some of them in the meantime: take those too.
  const raced = missing.filter((g) => !ids.has(g.fingerprint)).map((g) => g.fingerprint);
  if (raced.length > 0) await lockExisting(raced);
  return ids;
}

export interface InsertedOccurrence {
  issue_id: number | null;
  time: Date;
  id: string;
  level: number;
}

/**
 * Adds newly stored occurrences to their issues: counts, first and last seen,
 * highest level, newest event, the hourly counts, and regressions. A resolved
 * issue with an occurrence newer than its resolution reopens; backfilled
 * older events do not reopen it, and ignored issues stay ignored.
 */
export async function recordOccurrences(
  client: pg.PoolClient,
  rows: InsertedOccurrence[],
): Promise<void> {
  const byIssue = new Map<
    number,
    { n: number; first: number; last: number; lastId: string; level: number }
  >();
  const byHour = new Map<string, { issue: number; hour: number; n: number }>();
  for (const row of rows) {
    if (row.issue_id === null) continue;
    const issue = Number(row.issue_id);
    const t = row.time.getTime();
    const cell = byIssue.get(issue);
    if (!cell) {
      byIssue.set(issue, { n: 1, first: t, last: t, lastId: row.id, level: row.level });
    } else {
      cell.n += 1;
      cell.first = Math.min(cell.first, t);
      if (t >= cell.last) {
        cell.last = t;
        cell.lastId = row.id;
      }
      cell.level = Math.max(cell.level, row.level);
    }
    const hour = Math.floor(t / HOUR_MS) * HOUR_MS;
    const key = `${issue}|${hour}`;
    const h = byHour.get(key);
    if (h) h.n += 1;
    else byHour.set(key, { issue, hour, n: 1 });
  }
  if (byIssue.size === 0) return;

  const issues = [...byIssue.entries()].sort(([a], [b]) => a - b);
  await client.query(
    `UPDATE issues i SET
       count = i.count + u.n,
       first_seen = least(i.first_seen, u.first),
       last_seen = greatest(i.last_seen, u.last),
       level = greatest(i.level, u.level),
       last_event_time = CASE WHEN i.last_event_time IS NULL OR u.last >= i.last_event_time
                              THEN u.last ELSE i.last_event_time END,
       last_event_id = CASE WHEN i.last_event_time IS NULL OR u.last >= i.last_event_time
                            THEN u.last_id ELSE i.last_event_id END,
       status = CASE WHEN i.status = 'resolved' AND u.last > i.resolved_at THEN 'unresolved' ELSE i.status END,
       regressed_at = CASE WHEN i.status = 'resolved' AND u.last > i.resolved_at THEN now() ELSE i.regressed_at END,
       resolved_at = CASE WHEN i.status = 'resolved' AND u.last > i.resolved_at THEN NULL ELSE i.resolved_at END
     FROM unnest($1::bigint[], $2::int[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::int2[])
          AS u(id, n, first, last, last_id, level)
     WHERE i.id = u.id`,
    [
      issues.map(([id]) => id),
      issues.map(([, c]) => c.n),
      issues.map(([, c]) => new Date(c.first).toISOString()),
      issues.map(([, c]) => new Date(c.last).toISOString()),
      issues.map(([, c]) => c.lastId),
      issues.map(([, c]) => c.level),
    ],
  );

  const hours = [...byHour.values()].sort((a, b) => a.issue - b.issue || a.hour - b.hour);
  await client.query(
    `INSERT INTO issue_counts_hourly AS h (issue_id, hour, count)
     SELECT * FROM unnest($1::bigint[], $2::timestamptz[], $3::int[])
     ON CONFLICT (issue_id, hour) DO UPDATE SET count = h.count + EXCLUDED.count`,
    [
      hours.map((h) => h.issue),
      hours.map((h) => new Date(h.hour).toISOString()),
      hours.map((h) => h.n),
    ],
  );
}
