import {
  addHistograms,
  emptyHistogram,
  histogramQuantile,
  LEVEL_NAMES,
  levelName,
  type LevelName,
} from '@apiloupe/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import {
  bucketStarts,
  parseRange,
  projectBySlug,
  Where,
  type Query,
  type Range,
} from './params.js';

type Params = { Params: { slug: string }; Querystring: Query };

function bin(range: Range, where: Where): string {
  return `date_bin(make_interval(secs => ${where.param(range.stepSeconds)}), bucket, TIMESTAMPTZ '1970-01-01Z')`;
}

function round(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms * 10) / 10;
}

/** Overview numbers and the severity breakdown, all read from the per-minute rollups. */
export function statsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<Params>('/projects/:slug/overview', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(req.query, ctx.config.retentionDays);
    const where = () => {
      const w = new Where('project_id = ?', project.id)
        .add('bucket >= ?', range.from)
        .add('bucket < ?', range.to);
      if (req.query.service) w.add('service = ?', req.query.service);
      return w;
    };

    const seriesWhere = where();
    const t = bin(range, seriesWhere);
    const counts = await ctx.pool.query<{
      t: Date;
      c2: number;
      c3: number;
      c4: number;
      c5: number;
      ds: number;
      mx: number | null;
    }>(
      `SELECT ${t} AS t,
              coalesce(sum(count) FILTER (WHERE status < 300), 0)::float8 AS c2,
              coalesce(sum(count) FILTER (WHERE status >= 300 AND status < 400), 0)::float8 AS c3,
              coalesce(sum(count) FILTER (WHERE status >= 400 AND status < 500), 0)::float8 AS c4,
              coalesce(sum(count) FILTER (WHERE status >= 500), 0)::float8 AS c5,
              sum(duration_sum)::float8 AS ds,
              max(duration_max)::float8 AS mx
         FROM rollup_requests_1m WHERE ${seriesWhere.sql()} GROUP BY 1`,
      seriesWhere.params,
    );

    const histWhere = where();
    const ht = bin(range, histWhere);
    const hists = await ctx.pool.query<{ t: Date; i: number; n: number }>(
      `SELECT ${ht} AS t, x.i::int AS i, sum(x.n)::float8 AS n
         FROM rollup_requests_1m CROSS JOIN LATERAL unnest(hist) WITH ORDINALITY AS x(n, i)
        WHERE ${histWhere.sql()} GROUP BY 1, 2`,
      histWhere.params,
    );

    const byTime = new Map<number, number[]>();
    for (const row of hists.rows) {
      const key = row.t.getTime();
      const hist = byTime.get(key) ?? emptyHistogram();
      hist[row.i - 1] = row.n;
      byTime.set(key, hist);
    }
    const countsByTime = new Map(counts.rows.map((row) => [row.t.getTime(), row]));

    const total = emptyHistogram();
    let max: number | null = null;
    let durationSum = 0;
    const status = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    const series = bucketStarts(range).map((start) => {
      const row = countsByTime.get(start);
      const hist = byTime.get(start) ?? emptyHistogram();
      addHistograms(total, hist);
      if (row) {
        status['2xx'] += row.c2;
        status['3xx'] += row.c3;
        status['4xx'] += row.c4;
        status['5xx'] += row.c5;
        durationSum += row.ds ?? 0;
        if (row.mx !== null) max = Math.max(max ?? 0, row.mx);
      }
      return {
        t: new Date(start).toISOString(),
        '2xx': row?.c2 ?? 0,
        '3xx': row?.c3 ?? 0,
        '4xx': row?.c4 ?? 0,
        '5xx': row?.c5 ?? 0,
        p50: round(histogramQuantile(hist, 0.5, row?.mx)),
        p95: round(histogramQuantile(hist, 0.95, row?.mx)),
      };
    });

    const requests = status['2xx'] + status['3xx'] + status['4xx'] + status['5xx'];
    const timed = total.reduce((sum, n) => sum + n, 0);
    const minutes = (range.to.getTime() - range.from.getTime()) / 60_000;

    const routeWhere = where();
    const routeRows = await ctx.pool.query<{
      method: string;
      route: string;
      n: number;
      c4: number;
      c5: number;
      ds: number;
      mx: number | null;
    }>(
      `SELECT method, route, sum(count)::float8 AS n,
              coalesce(sum(count) FILTER (WHERE status >= 400 AND status < 500), 0)::float8 AS c4,
              coalesce(sum(count) FILTER (WHERE status >= 500), 0)::float8 AS c5,
              sum(duration_sum)::float8 AS ds, max(duration_max)::float8 AS mx
         FROM rollup_requests_1m WHERE ${routeWhere.sql()}
        GROUP BY method, route ORDER BY n DESC, route LIMIT 15`,
      routeWhere.params,
    );
    const routeHists = new Map<string, number[]>();
    if (routeRows.rows.length > 0) {
      const w = where();
      const methods = w.param(routeRows.rows.map((r) => r.method));
      const names = w.param(routeRows.rows.map((r) => r.route));
      const { rows } = await ctx.pool.query<{
        method: string;
        route: string;
        i: number;
        n: number;
      }>(
        `SELECT method, route, x.i::int AS i, sum(x.n)::float8 AS n
           FROM rollup_requests_1m CROSS JOIN LATERAL unnest(hist) WITH ORDINALITY AS x(n, i)
          WHERE ${w.sql()} AND (method, route) IN (SELECT * FROM unnest(${methods}::text[], ${names}::text[]))
          GROUP BY 1, 2, 3`,
        w.params,
      );
      for (const row of rows) {
        const key = `${row.method} ${row.route}`;
        const hist = routeHists.get(key) ?? emptyHistogram();
        hist[row.i - 1] = row.n;
        routeHists.set(key, hist);
      }
    }

    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      stepSeconds: range.stepSeconds,
      totals: {
        requests,
        perMinute: minutes > 0 ? requests / minutes : 0,
        status,
        clientErrorRate: requests > 0 ? status['4xx'] / requests : 0,
        serverErrorRate: requests > 0 ? status['5xx'] / requests : 0,
        avgMs: timed > 0 ? round(durationSum / timed) : null,
        p50: round(histogramQuantile(total, 0.5, max)),
        p95: round(histogramQuantile(total, 0.95, max)),
        p99: round(histogramQuantile(total, 0.99, max)),
      },
      series,
      routes: routeRows.rows.map((row) => {
        const hist = routeHists.get(`${row.method} ${row.route}`) ?? emptyHistogram();
        const timedRoute = hist.reduce((sum, n) => sum + n, 0);
        return {
          method: row.method,
          route: row.route,
          count: row.n,
          clientErrors: row.c4,
          serverErrors: row.c5,
          avgMs: timedRoute > 0 ? round(row.ds / timedRoute) : null,
          p50: round(histogramQuantile(hist, 0.5, row.mx)),
          p95: round(histogramQuantile(hist, 0.95, row.mx)),
        };
      }),
    };
  });

  app.get<Params>('/projects/:slug/levels', async (req) => {
    requireUser(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const range = parseRange(req.query, ctx.config.retentionDays);
    const w = new Where('project_id = ?', project.id)
      .add('bucket >= ?', range.from)
      .add('bucket < ?', range.to);
    if (req.query.service) w.add('service = ?', req.query.service);
    if (req.query.kind === 'request' || req.query.kind === 'log') w.add('kind = ?', req.query.kind);
    const t = bin(range, w);
    const { rows } = await ctx.pool.query<{ t: Date; level: number; n: number }>(
      `SELECT ${t} AS t, level, sum(count)::float8 AS n FROM rollup_levels_1m
        WHERE ${w.sql()} GROUP BY 1, 2`,
      w.params,
    );
    const empty = () =>
      Object.fromEntries(LEVEL_NAMES.map((name) => [name, 0])) as Record<LevelName, number>;
    const totals = empty();
    const byTime = new Map<number, Record<LevelName, number>>();
    for (const row of rows) {
      const name = levelName(row.level);
      totals[name] += row.n;
      const key = row.t.getTime();
      const cell = byTime.get(key) ?? empty();
      cell[name] += row.n;
      byTime.set(key, cell);
    }
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      stepSeconds: range.stepSeconds,
      totals,
      series: bucketStarts(range).map((start) => ({
        t: new Date(start).toISOString(),
        ...(byTime.get(start) ?? empty()),
      })),
    };
  });
}
