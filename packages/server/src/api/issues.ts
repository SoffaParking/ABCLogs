import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { badRequest, bodyObject, notFound } from '../http.js';
import {
  encodeRef,
  likePattern,
  parseRange,
  projectBySlug,
  type Query,
  type Range,
} from './params.js';

type Params = { Params: { slug: string }; Querystring: Query };
type IdParams = { Params: { slug: string; id: string }; Querystring: Query };

const STATUSES = ['unresolved', 'resolved', 'ignored'] as const;
type Status = (typeof STATUSES)[number];
const PAGE_SIZE = 50;
const SPARK_BINS = 24;
const HOUR_MS = 3_600_000;
// The detail page lists this many recent occurrences, and reads affected routes from them.
const RECENT = 50;
const ROUTE_SAMPLE = 500;

interface IssueRow {
  id: number;
  service: string;
  error_type: string | null;
  title: string;
  culprit: string | null;
  level: number;
  status: Status;
  count: number;
  first_seen: Date;
  last_seen: Date;
  resolved_at: Date | null;
  regressed_at: Date | null;
  grouping_key?: string;
  last_event_time?: Date | null;
  last_event_id?: string | null;
}

function issueOut(row: IssueRow) {
  return {
    id: Number(row.id),
    service: row.service,
    errorType: row.error_type,
    title: row.title,
    culprit: row.culprit,
    level: row.level,
    status: row.status,
    count: row.count,
    firstSeen: row.first_seen.toISOString(),
    lastSeen: row.last_seen.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    regressedAt: row.regressed_at?.toISOString() ?? null,
  };
}

const ISSUE_COLUMNS = `id, service, error_type, title, culprit, level, status, count, first_seen, last_seen,
  resolved_at, regressed_at`;

/** Sparkline buckets: hours for a day or less, wider for longer ranges; always whole hours. */
function sparkStep(range: Range): number {
  const span = range.to.getTime() - range.from.getTime();
  return Math.max(1, Math.ceil(span / SPARK_BINS / HOUR_MS)) * HOUR_MS;
}

/** Grouped errors: the list, one issue, status changes, and the top few for the overview. */
export function issueRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Occurrences per issue within the range, read from the events themselves. */
  async function rangeCounts(
    projectId: number,
    ids: number[],
    range: Range,
  ): Promise<Map<number, number>> {
    if (ids.length === 0) return new Map();
    const { rows } = await ctx.pool.query<{ issue_id: number; n: number }>(
      `SELECT issue_id, count(*)::int AS n FROM log_events
        WHERE project_id = $1 AND issue_id = ANY($2) AND time >= $3 AND time < $4
        GROUP BY issue_id`,
      [projectId, ids, range.from, range.to],
    );
    return new Map(rows.map((row) => [Number(row.issue_id), row.n]));
  }

  app.get<Params>('/projects/:slug/issues', async (req) => {
    requireUser(req);
    const q = req.query;
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(q, ctx.config.retentionDays);
    const status = q.status ?? 'unresolved';
    if (status !== 'all' && !STATUSES.includes(status as Status)) {
      throw badRequest('status must be unresolved, resolved, ignored or all');
    }
    const order =
      q.sort === 'count'
        ? 'count DESC, last_seen DESC'
        : q.sort === 'first_seen'
          ? 'first_seen DESC'
          : 'last_seen DESC';
    const page = Math.max(0, Number(q.page ?? 0) || 0);
    const params: unknown[] = [project.id, range.from];
    let where = 'project_id = $1 AND last_seen >= $2';
    if (status !== 'all') {
      params.push(status);
      where += ` AND status = $${params.length}`;
    }
    if (q.q) {
      params.push(likePattern(q.q));
      where += ` AND (title ILIKE $${params.length} ESCAPE '\\' OR culprit ILIKE $${params.length} ESCAPE '\\')`;
    }
    if (q.service) {
      params.push(q.service);
      where += ` AND service = $${params.length}`;
    }
    const [{ rows }, totals] = await Promise.all([
      ctx.pool.query<IssueRow>(
        `SELECT ${ISSUE_COLUMNS} FROM issues WHERE ${where}
          ORDER BY ${order}, id DESC LIMIT ${PAGE_SIZE + 1} OFFSET ${page * PAGE_SIZE}`,
        params,
      ),
      ctx.pool.query<{ status: Status; n: number }>(
        `SELECT status, count(*)::int AS n FROM issues
          WHERE project_id = $1 AND last_seen >= $2 GROUP BY status`,
        [project.id, range.from],
      ),
    ]);
    const items = rows.slice(0, PAGE_SIZE);
    const ids = items.map((row) => Number(row.id));
    const step = sparkStep(range);
    const start = Math.floor(range.from.getTime() / step) * step;
    const bins = Math.ceil((range.to.getTime() - start) / step);
    const [counts, spark] = await Promise.all([
      rangeCounts(project.id, ids, range),
      ids.length === 0
        ? Promise.resolve({ rows: [] as { issue_id: number; t: Date; n: number }[] })
        : ctx.pool.query<{ issue_id: number; t: Date; n: number }>(
            `SELECT issue_id, date_bin(make_interval(secs => $4), hour, TIMESTAMPTZ '1970-01-01Z') AS t,
                    sum(count)::int AS n
               FROM issue_counts_hourly
              WHERE issue_id = ANY($1) AND hour >= $2 AND hour < $3
              GROUP BY 1, 2`,
            [ids, new Date(start), range.to, step / 1000],
          ),
    ]);
    const sparks = new Map<number, number[]>();
    for (const row of spark.rows) {
      const id = Number(row.issue_id);
      const series = sparks.get(id) ?? new Array<number>(bins).fill(0);
      const i = Math.floor((row.t.getTime() - start) / step);
      if (i >= 0 && i < bins) series[i] = row.n;
      sparks.set(id, series);
    }
    return {
      items: items.map((row) => ({
        ...issueOut(row),
        rangeCount: counts.get(Number(row.id)) ?? 0,
        spark: sparks.get(Number(row.id)) ?? new Array<number>(bins).fill(0),
      })),
      totals: Object.fromEntries(
        STATUSES.map((s) => [s, totals.rows.find((r) => r.status === s)?.n ?? 0]),
      ),
      hasMore: rows.length > PAGE_SIZE,
    };
  });

  app.get<Params>('/projects/:slug/issues/top', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(req.query, ctx.config.retentionDays);
    const { rows } = await ctx.pool.query<IssueRow & { n: number }>(
      `SELECT ${ISSUE_COLUMNS.split(',')
        .map((c) => `i.${c.trim()}`)
        .join(', ')}, c.n
         FROM (SELECT issue_id, count(*)::int AS n FROM log_events
                WHERE project_id = $1 AND issue_id IS NOT NULL AND time >= $2 AND time < $3
                GROUP BY issue_id) c
         JOIN issues i ON i.id = c.issue_id
        WHERE i.status = 'unresolved'
        ORDER BY c.n DESC, i.last_seen DESC LIMIT 5`,
      [project.id, range.from, range.to],
    );
    const fresh = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM issues WHERE project_id = $1 AND first_seen >= $2 AND first_seen < $3`,
      [project.id, range.from, range.to],
    );
    return {
      items: rows.map((row) => ({ ...issueOut(row), rangeCount: row.n })),
      newIssues: fresh.rows[0]?.n ?? 0,
    };
  });

  app.get<IdParams>('/projects/:slug/issues/:id', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(req.query, ctx.config.retentionDays);
    const id = Number(req.params.id);
    const { rows } = await ctx.pool.query<IssueRow>(
      `SELECT ${ISSUE_COLUMNS}, grouping_key, last_event_time, last_event_id FROM issues
        WHERE project_id = $1 AND id = $2`,
      [project.id, Number.isInteger(id) ? id : 0],
    );
    const issue = rows[0];
    if (!issue) throw notFound('no such issue');

    const binWhere = [project.id, id, range.from, range.to, range.stepSeconds];
    const [series, recent] = await Promise.all([
      ctx.pool.query<{ t: Date; n: number }>(
        `SELECT date_bin(make_interval(secs => $5), time, TIMESTAMPTZ '1970-01-01Z') AS t, count(*)::int AS n
           FROM log_events WHERE project_id = $1 AND issue_id = $2 AND time >= $3 AND time < $4
          GROUP BY 1`,
        binWhere,
      ),
      // The newest occurrences with the request each happened in, if any.
      ctx.pool.query<{
        time: Date;
        id: string;
        service: string;
        level: number;
        message: string;
        request_id: string | null;
        error_message: string | null;
        r_time: Date | null;
        r_id: string | null;
        method: string | null;
        route: string | null;
        path: string | null;
        status: number | null;
        duration_ms: number | null;
      }>(
        `SELECT l.time, l.id, l.service, l.level, left(l.message, 300) AS message, l.request_id,
                left(l.error_message, 300) AS error_message,
                r.time AS r_time, r.id AS r_id, r.method, r.route, r.path, r.status, r.duration_ms
           FROM (SELECT * FROM log_events
                  WHERE project_id = $1 AND issue_id = $2 AND time >= $3 AND time < $4
                  ORDER BY time DESC, id DESC LIMIT ${ROUTE_SAMPLE}) l
           LEFT JOIN LATERAL (
             SELECT time, id, method, route, path, status, duration_ms FROM request_events r
              WHERE r.project_id = l.project_id AND r.request_id = l.request_id
                AND r.time >= l.time - interval '1 hour' AND r.time <= l.time + interval '1 hour'
              ORDER BY abs(extract(epoch FROM r.time - l.time)) LIMIT 1) r ON l.request_id IS NOT NULL
          ORDER BY l.time DESC, l.id DESC`,
        [project.id, id, range.from, range.to],
      ),
    ]);

    // The newest occurrence in full: in the range if there is one, else the latest stored.
    const latestRef = recent.rows[0]
      ? { time: recent.rows[0].time, id: recent.rows[0].id }
      : issue.last_event_time && issue.last_event_id
        ? { time: issue.last_event_time, id: issue.last_event_id }
        : null;
    const latest = latestRef
      ? (
          await ctx.pool.query<{
            time: Date;
            id: string;
            service: string;
            level: number;
            message: string;
            request_id: string | null;
            error_type: string | null;
            error_message: string | null;
            error_stack: string | null;
            attrs: unknown;
          }>(
            `SELECT time, id, service, level, message, request_id, error_type, error_message, error_stack, attrs
               FROM log_events WHERE project_id = $1 AND time = $2 AND id = $3`,
            [project.id, latestRef.time, latestRef.id],
          )
        ).rows[0]
      : undefined;

    const routes = new Map<string, { method: string; route: string; count: number }>();
    let withRequest = 0;
    for (const row of recent.rows) {
      if (!row.method || !row.route) continue;
      withRequest += 1;
      const key = `${row.method} ${row.route}`;
      const entry = routes.get(key) ?? { method: row.method, route: row.route, count: 0 };
      entry.count += 1;
      routes.set(key, entry);
    }
    const byTime = new Map(series.rows.map((row) => [row.t.getTime(), row.n]));
    const step = range.stepSeconds * 1000;
    const points: { t: string; count: number }[] = [];
    for (
      let t = Math.floor(range.from.getTime() / step) * step;
      t < range.to.getTime();
      t += step
    ) {
      points.push({ t: new Date(t).toISOString(), count: byTime.get(t) ?? 0 });
    }

    return {
      issue: { ...issueOut(issue), groupingKey: issue.grouping_key },
      rangeCount: series.rows.reduce((sum, row) => sum + row.n, 0),
      series: points,
      latest: latest
        ? {
            ref: encodeRef(latest.time.getTime(), latest.id),
            time: latest.time.toISOString(),
            service: latest.service,
            level: latest.level,
            message: latest.message,
            requestId: latest.request_id,
            errorType: latest.error_type,
            errorMessage: latest.error_message,
            errorStack: latest.error_stack,
            attrs: latest.attrs,
          }
        : null,
      occurrences: recent.rows.slice(0, RECENT).map((row) => ({
        ref: encodeRef(row.time.getTime(), row.id),
        time: row.time.toISOString(),
        service: row.service,
        level: row.level,
        message: row.message,
        errorMessage: row.error_message,
        requestId: row.request_id,
        request:
          row.r_time && row.r_id
            ? {
                ref: encodeRef(row.r_time.getTime(), row.r_id),
                method: row.method,
                path: row.path,
                status: row.status,
                durationMs: row.duration_ms,
              }
            : null,
      })),
      routes: {
        sampled: recent.rows.length,
        withRequest,
        items: [...routes.values()].sort((a, b) => b.count - a.count).slice(0, 10),
      },
    };
  });

  app.patch<IdParams>('/projects/:slug/issues/:id', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const status = bodyObject(req.body).status;
    if (!STATUSES.includes(status as Status)) {
      throw badRequest('status must be unresolved, resolved or ignored');
    }
    const { rows } = await ctx.pool.query<IssueRow>(
      `UPDATE issues SET status = $3,
              resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END
        WHERE project_id = $1 AND id = $2
        RETURNING ${ISSUE_COLUMNS}`,
      [project.id, Number(req.params.id) || 0, status],
    );
    if (!rows[0]) throw notFound('no such issue');
    return { issue: issueOut(rows[0]) };
  });
}
