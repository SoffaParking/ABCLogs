import { emptyHistogram, histogramBucket } from '@apiloupe/shared';
import type pg from 'pg';
import {
  ISSUE_LEVEL,
  issueGroupFor,
  recordOccurrences,
  upsertIssues,
  type IssueGroup,
} from '../issues.js';
import type { StoredEvent, StoredLog, StoredRequest } from './validate.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface StoreResult {
  accepted: number;
  duplicates: number;
}

interface InsertedRequest {
  time: Date;
  service: string;
  level: number;
  method: string;
  route: string;
  status: number;
  duration_ms: number | null;
}

interface InsertedLog {
  time: Date;
  id: string;
  service: string;
  level: number;
  issue_id: number | null;
}

/**
 * Writes a batch in one transaction: the raw events, skipping any already
 * stored, then the per-minute rollups and the issues' counts, built from the
 * rows that were actually inserted. Counting only inserted rows is what keeps
 * a re-sent batch from double-counting anywhere.
 *
 * Events and rollup keys are sorted first so concurrent batches take row
 * locks in the same order and cannot deadlock.
 */
export async function storeBatch(
  client: pg.PoolClient,
  projectId: number,
  events: StoredEvent[],
  rejected: number,
): Promise<StoreResult> {
  const byTime = (a: StoredEvent, b: StoredEvent) =>
    a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const requests = events.filter((e): e is StoredRequest => e.kind === 'request').sort(byTime);
  const logs = events.filter((e): e is StoredLog => e.kind === 'log').sort(byTime);

  const issueOf = await assignIssues(client, projectId, logs);
  const insertedRequests = requests.length ? await insertRequests(client, projectId, requests) : [];
  const insertedLogs = logs.length ? await insertLogs(client, projectId, logs, issueOf) : [];
  await recordOccurrences(client, insertedLogs);

  await upsertRequestRollups(client, projectId, insertedRequests);
  await upsertLevelRollups(client, projectId, insertedRequests, insertedLogs);

  const accepted = insertedRequests.length + insertedLogs.length;
  const duplicates = events.length - accepted;
  const hour = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS).toISOString();
  await client.query(
    `INSERT INTO ingest_stats_hourly AS s (project_id, hour, accepted, duplicates, rejected)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, hour) DO UPDATE SET
       accepted = s.accepted + EXCLUDED.accepted,
       duplicates = s.duplicates + EXCLUDED.duplicates,
       rejected = s.rejected + EXCLUDED.rejected`,
    [projectId, hour, accepted, duplicates, rejected],
  );
  return { accepted, duplicates };
}

async function insertRequests(
  client: pg.PoolClient,
  projectId: number,
  rows: StoredRequest[],
): Promise<InsertedRequest[]> {
  const { rows: inserted } = await client.query<InsertedRequest>(
    `INSERT INTO request_events
       (project_id, time, id, service, level, method, route, path, status, duration_ms, request_id, attrs)
     SELECT $1::bigint, u.*
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int2[], $6::text[], $7::text[],
                   $8::text[], $9::int2[], $10::real[], $11::text[], $12::jsonb[]) AS u
     ON CONFLICT DO NOTHING
     RETURNING time, service, level, method, route, status, duration_ms`,
    [
      projectId,
      rows.map((r) => new Date(r.time).toISOString()),
      rows.map((r) => r.id),
      rows.map((r) => r.service),
      rows.map((r) => r.level),
      rows.map((r) => r.method),
      rows.map((r) => r.route),
      rows.map((r) => r.path),
      rows.map((r) => r.status),
      rows.map((r) => r.durationMs),
      rows.map((r) => r.requestId),
      rows.map((r) => r.attrs),
    ],
  );
  return inserted;
}

/** The issue id for each error-level log, creating issues as needed. */
async function assignIssues(
  client: pg.PoolClient,
  projectId: number,
  logs: StoredLog[],
): Promise<Map<StoredLog, number>> {
  const groups = new Map<
    string,
    IssueGroup & { level: number; firstSeen: number; lastSeen: number }
  >();
  const fingerprintOf = new Map<StoredLog, string>();
  for (const log of logs) {
    if (log.level < ISSUE_LEVEL) continue;
    const group = issueGroupFor(log);
    fingerprintOf.set(log, group.fingerprint);
    const seen = groups.get(group.fingerprint);
    if (seen) {
      seen.level = Math.max(seen.level, log.level);
      seen.firstSeen = Math.min(seen.firstSeen, log.time);
      seen.lastSeen = Math.max(seen.lastSeen, log.time);
    } else {
      groups.set(group.fingerprint, {
        ...group,
        level: log.level,
        firstSeen: log.time,
        lastSeen: log.time,
      });
    }
  }
  const ids = await upsertIssues(client, projectId, [...groups.values()]);
  const out = new Map<StoredLog, number>();
  for (const [log, fingerprint] of fingerprintOf) out.set(log, ids.get(fingerprint)!);
  return out;
}

async function insertLogs(
  client: pg.PoolClient,
  projectId: number,
  rows: StoredLog[],
  issueOf: Map<StoredLog, number>,
): Promise<InsertedLog[]> {
  const { rows: inserted } = await client.query<InsertedLog>(
    `INSERT INTO log_events
       (project_id, time, id, service, level, message, request_id, error_type, error_message,
        error_stack, attrs, issue_id)
     SELECT $1::bigint, u.*
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int2[], $6::text[], $7::text[],
                   $8::text[], $9::text[], $10::text[], $11::jsonb[], $12::bigint[]) AS u
     ON CONFLICT DO NOTHING
     RETURNING time, id, service, level, issue_id`,
    [
      projectId,
      rows.map((r) => new Date(r.time).toISOString()),
      rows.map((r) => r.id),
      rows.map((r) => r.service),
      rows.map((r) => r.level),
      rows.map((r) => r.message),
      rows.map((r) => r.requestId),
      rows.map((r) => r.errorType),
      rows.map((r) => r.errorMessage),
      rows.map((r) => r.errorStack),
      rows.map((r) => r.attrs),
      rows.map((r) => issueOf.get(r) ?? null),
    ],
  );
  return inserted;
}

function minute(time: Date): number {
  return Math.floor(time.getTime() / MINUTE_MS) * MINUTE_MS;
}

interface RequestCell {
  bucket: number;
  service: string;
  method: string;
  route: string;
  status: number;
  count: number;
  sum: number;
  max: number | null;
  hist: number[];
}

async function upsertRequestRollups(
  client: pg.PoolClient,
  projectId: number,
  rows: InsertedRequest[],
): Promise<void> {
  if (rows.length === 0) return;
  const cells = new Map<string, RequestCell>();
  for (const row of rows) {
    const bucket = minute(row.time);
    const key = JSON.stringify([bucket, row.service, row.method, row.route, row.status]);
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        bucket,
        service: row.service,
        method: row.method,
        route: row.route,
        status: row.status,
        count: 0,
        sum: 0,
        max: null,
        hist: emptyHistogram(),
      };
      cells.set(key, cell);
    }
    cell.count += 1;
    if (row.duration_ms !== null) {
      cell.sum += row.duration_ms;
      cell.max = Math.max(cell.max ?? 0, row.duration_ms);
      cell.hist[histogramBucket(row.duration_ms)]! += 1;
    }
  }
  const sorted = [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, c]) => c);
  await client.query(
    `INSERT INTO rollup_requests_1m AS r
       (project_id, bucket, service, method, route, status, count, duration_sum, duration_max, hist)
     SELECT $1::bigint, u.b, u.s, u.m, u.rt, u.st, u.c, u.ds, u.dm, u.h::int[]
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::int2[], $7::int[],
                   $8::float8[], $9::real[], $10::text[]) AS u(b, s, m, rt, st, c, ds, dm, h)
     ON CONFLICT (project_id, bucket, service, method, route, status) DO UPDATE SET
       count = r.count + EXCLUDED.count,
       duration_sum = r.duration_sum + EXCLUDED.duration_sum,
       duration_max = greatest(r.duration_max, EXCLUDED.duration_max),
       hist = ARRAY(
         SELECT x.a + x.b FROM unnest(r.hist, EXCLUDED.hist) WITH ORDINALITY AS x(a, b, i)
          ORDER BY x.i)`,
    [
      projectId,
      sorted.map((c) => new Date(c.bucket).toISOString()),
      sorted.map((c) => c.service),
      sorted.map((c) => c.method),
      sorted.map((c) => c.route),
      sorted.map((c) => c.status),
      sorted.map((c) => c.count),
      sorted.map((c) => c.sum),
      sorted.map((c) => c.max),
      sorted.map((c) => `{${c.hist.join(',')}}`),
    ],
  );
}

async function upsertLevelRollups(
  client: pg.PoolClient,
  projectId: number,
  requests: InsertedRequest[],
  logs: InsertedLog[],
): Promise<void> {
  const cells = new Map<
    string,
    { bucket: number; service: string; kind: string; level: number; count: number }
  >();
  const add = (kind: string, row: { time: Date; service: string; level: number }) => {
    const bucket = minute(row.time);
    const key = JSON.stringify([bucket, row.service, kind, row.level]);
    const cell = cells.get(key);
    if (cell) cell.count += 1;
    else cells.set(key, { bucket, service: row.service, kind, level: row.level, count: 1 });
  };
  for (const row of requests) add('request', row);
  for (const row of logs) add('log', row);
  if (cells.size === 0) return;
  const sorted = [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, c]) => c);
  await client.query(
    `INSERT INTO rollup_levels_1m AS r (project_id, bucket, service, kind, level, count)
     SELECT $1::bigint, u.*
       FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::int2[], $6::int[]) AS u
     ON CONFLICT (project_id, bucket, service, kind, level) DO UPDATE SET count = r.count + EXCLUDED.count`,
    [
      projectId,
      sorted.map((c) => new Date(c.bucket).toISOString()),
      sorted.map((c) => c.service),
      sorted.map((c) => c.kind),
      sorted.map((c) => c.level),
      sorted.map((c) => c.count),
    ],
  );
}
