import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../http.js';
import {
  decodeCursor,
  decodeRef,
  encodeCursor,
  encodeRef,
  likePattern,
  limitParam,
  minLevelParam,
  parseRange,
  projectBySlug,
  Where,
  type Query,
} from './params.js';

type Params = { Params: { slug: string }; Querystring: Query };
type RefParams = { Params: { slug: string; ref: string } };

// Logs written while serving a request are looked for this far either side of it.
const RELATED_WINDOW_MS = 60 * 60_000;
const PREVIEW_CHARS = 500;

interface RequestRow {
  time: Date;
  id: string;
  service: string;
  level: number;
  method: string;
  route: string;
  path: string;
  status: number;
  duration_ms: number | null;
  request_id: string | null;
  attrs?: unknown;
}

interface LogRow {
  time: Date;
  id: string;
  service: string;
  level: number;
  message: string;
  request_id: string | null;
  error_type: string | null;
  error_message: string | null;
  has_stack?: boolean;
  error_stack?: string | null;
  attrs?: unknown;
}

function requestOut(row: RequestRow) {
  return {
    ref: encodeRef(row.time.getTime(), row.id),
    time: row.time.toISOString(),
    service: row.service,
    level: row.level,
    method: row.method,
    route: row.route,
    path: row.path,
    status: row.status,
    durationMs: row.duration_ms,
    requestId: row.request_id,
    ...(row.attrs !== undefined ? { attrs: row.attrs } : {}),
  };
}

function logOut(row: LogRow) {
  return {
    ref: encodeRef(row.time.getTime(), row.id),
    time: row.time.toISOString(),
    service: row.service,
    level: row.level,
    message: row.message,
    requestId: row.request_id,
    errorType: row.error_type,
    errorMessage: row.error_message,
    ...(row.has_stack !== undefined ? { hasStack: row.has_stack } : {}),
    ...(row.error_stack !== undefined ? { errorStack: row.error_stack } : {}),
    ...(row.attrs !== undefined ? { attrs: row.attrs } : {}),
  };
}

const REQUEST_COLUMNS =
  'time, id, service, level, method, route, path, status, duration_ms, request_id';
const LOG_PREVIEW_COLUMNS = `time, id, service, level, left(message, ${PREVIEW_CHARS}) AS message,
  request_id, error_type, left(error_message, ${PREVIEW_CHARS}) AS error_message,
  error_stack IS NOT NULL AS has_stack`;

/** Raw request and log events: filtered lists, newest first, and single-event detail. */
export function eventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<Params>('/projects/:slug/requests', async (req) => {
    requireUser(req);
    const q = req.query;
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(q, ctx.config.retentionDays);
    const limit = limitParam(q.limit);
    const w = new Where('project_id = ?', project.id)
      .add('time >= ?', range.from)
      .add('time < ?', range.to);
    if (q.service) w.add('service = ?', q.service);
    if (q.method) w.add('method = ?', q.method.toUpperCase());
    if (q.route) w.add('route = ?', q.route);
    if (q.status) {
      const cls = /^([1-5])xx$/i.exec(q.status);
      if (cls) {
        const base = Number(cls[1]) * 100;
        // 1xx is charted with 2xx, and filtered with it too.
        w.add('status >= ? AND status < ?', base === 200 ? 100 : base, base + 100);
      } else if (/^[1-5]\d\d$/.test(q.status)) {
        w.add('status = ?', Number(q.status));
      } else {
        throw badRequest('status must be a code (404) or a class (4xx)');
      }
    }
    const minLevel = minLevelParam(q.minLevel);
    if (minLevel !== undefined) w.add('level >= ?', minLevel);
    if (q.minDurationMs) {
      const ms = Number(q.minDurationMs);
      if (!Number.isFinite(ms) || ms < 0) throw badRequest('minDurationMs must be a number');
      w.add('duration_ms >= ?', ms);
    }
    if (q.q) w.add(`path ILIKE ? ESCAPE '\\'`, likePattern(q.q));
    if (q.requestId) w.add('request_id = ?', q.requestId);
    const cursor = decodeCursor(q.cursor);
    if (cursor) w.add('(time, id) < (?, ?)', new Date(cursor.time), cursor.id);
    const { rows } = await ctx.pool.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM request_events WHERE ${w.sql()}
        ORDER BY time DESC, id DESC LIMIT ${limit + 1}`,
      w.params,
    );
    return page(rows, limit, requestOut);
  });

  app.get<RefParams>('/projects/:slug/requests/:ref', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const ref = decodeRef(req.params.ref);
    const { rows } = await ctx.pool.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS}, attrs FROM request_events
        WHERE project_id = $1 AND time = $2 AND id = $3`,
      [project.id, new Date(ref.time), ref.id],
    );
    const row = rows[0];
    if (!row) throw notFound('no such request (it may have passed the retention period)');
    const logs = row.request_id
      ? (
          await ctx.pool.query<LogRow>(
            `SELECT ${LOG_PREVIEW_COLUMNS} FROM log_events
              WHERE project_id = $1 AND request_id = $2 AND time >= $3 AND time <= $4
              ORDER BY time, id LIMIT 200`,
            [
              project.id,
              row.request_id,
              new Date(ref.time - RELATED_WINDOW_MS),
              new Date(ref.time + RELATED_WINDOW_MS),
            ],
          )
        ).rows
      : [];
    return { request: requestOut(row), logs: logs.map(logOut) };
  });

  app.get<Params>('/projects/:slug/logs', async (req) => {
    requireUser(req);
    const q = req.query;
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(q, ctx.config.retentionDays);
    const limit = limitParam(q.limit);
    const w = new Where('project_id = ?', project.id)
      .add('time >= ?', range.from)
      .add('time < ?', range.to);
    if (q.service) w.add('service = ?', q.service);
    const minLevel = minLevelParam(q.minLevel);
    if (minLevel !== undefined) w.add('level >= ?', minLevel);
    if (q.errorsOnly === 'true')
      w.add('(error_type IS NOT NULL OR error_message IS NOT NULL OR error_stack IS NOT NULL)');
    if (q.q) {
      const pattern = likePattern(q.q);
      w.add(
        `(message ILIKE ? ESCAPE '\\' OR error_message ILIKE ? ESCAPE '\\' OR error_type ILIKE ? ESCAPE '\\')`,
        pattern,
        pattern,
        pattern,
      );
    }
    if (q.requestId) w.add('request_id = ?', q.requestId);
    const cursor = decodeCursor(q.cursor);
    if (cursor) w.add('(time, id) < (?, ?)', new Date(cursor.time), cursor.id);
    const { rows } = await ctx.pool.query<LogRow>(
      `SELECT ${LOG_PREVIEW_COLUMNS} FROM log_events WHERE ${w.sql()}
        ORDER BY time DESC, id DESC LIMIT ${limit + 1}`,
      w.params,
    );
    return page(rows, limit, logOut);
  });

  app.get<RefParams>('/projects/:slug/logs/:ref', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const ref = decodeRef(req.params.ref);
    const { rows } = await ctx.pool.query<LogRow>(
      `SELECT time, id, service, level, message, request_id, error_type, error_message,
              error_stack, attrs
         FROM log_events WHERE project_id = $1 AND time = $2 AND id = $3`,
      [project.id, new Date(ref.time), ref.id],
    );
    const row = rows[0];
    if (!row) throw notFound('no such log line (it may have passed the retention period)');
    let request: ReturnType<typeof requestOut> | null = null;
    let related: ReturnType<typeof logOut>[] = [];
    if (row.request_id) {
      const window = [
        project.id,
        row.request_id,
        new Date(ref.time - RELATED_WINDOW_MS),
        new Date(ref.time + RELATED_WINDOW_MS),
      ];
      const [requests, logs] = await Promise.all([
        ctx.pool.query<RequestRow>(
          `SELECT ${REQUEST_COLUMNS} FROM request_events
            WHERE project_id = $1 AND request_id = $2 AND time >= $3 AND time <= $4
            ORDER BY time LIMIT 1`,
          window,
        ),
        ctx.pool.query<LogRow>(
          `SELECT ${LOG_PREVIEW_COLUMNS} FROM log_events
            WHERE project_id = $1 AND request_id = $2 AND time >= $3 AND time <= $4
            ORDER BY time, id LIMIT 200`,
          window,
        ),
      ]);
      request = requests.rows[0] ? requestOut(requests.rows[0]) : null;
      related = logs.rows.map(logOut);
    }
    return { log: logOut(row), request, related };
  });

  app.get<Params>('/projects/:slug/facets', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(req.query, ctx.config.retentionDays);
    const args = [project.id, range.from, range.to];
    const [services, routes] = await Promise.all([
      ctx.pool.query<{ service: string }>(
        `SELECT DISTINCT service FROM rollup_levels_1m
          WHERE project_id = $1 AND bucket >= $2 AND bucket < $3 ORDER BY service`,
        args,
      ),
      ctx.pool.query<{ method: string; route: string; n: number }>(
        `SELECT method, route, sum(count)::float8 AS n FROM rollup_requests_1m
          WHERE project_id = $1 AND bucket >= $2 AND bucket < $3
          GROUP BY 1, 2 ORDER BY n DESC, route LIMIT 300`,
        args,
      ),
    ]);
    return {
      services: services.rows.map((row) => row.service),
      routes: routes.rows.map((row) => ({ method: row.method, route: row.route, count: row.n })),
    };
  });
}

function page<Row extends { time: Date; id: string }, Out>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Out,
): { items: Out[]; nextCursor: string | null } {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items: items.map(map),
    nextCursor: more && last ? encodeCursor({ time: last.time.getTime(), id: last.id }) : null,
  };
}
