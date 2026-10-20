import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { runImport } from '@apiloupe/importer';
import { createApiloupe, type Apiloupe } from '@apiloupe/node';
import express from 'express';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, projectWithKey, setupAdmin, testApp, type TestApp } from './helpers.js';

/**
 * The SDK against the real server: live events land in the dashboard, and
 * importing the same app's stdout afterwards (a backfill) adds nothing.
 */
describe.skipIf(!hasDatabase)('@apiloupe/node → server', () => {
  let t: TestApp;
  let cookie: string;
  let endpoint: string;

  beforeAll(async () => {
    t = await testApp();
    cookie = await setupAdmin(t.app);
    endpoint = await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await t?.close();
  });

  const range = () => `from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`;
  async function get<T>(slug: string, path: string): Promise<T> {
    const res = await t.app.inject({ url: `/api/v1/projects/${slug}${path}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    return res.json<T>();
  }

  /** An Express app on a random port; returns its base URL and a closer. */
  async function serve(app: express.Express) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  function capture(lines: string[]) {
    return new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
  }

  it('pino only, the way an app with its own access log is wired', async () => {
    const { slug, key } = await projectWithKey(t.app, cookie, 'Pino only');
    const apiloupe: Apiloupe = createApiloupe({ endpoint, key, onError: false });
    const stdout: string[] = [];
    const logger = pino(
      { base: { service: 'parking-backend' }, timestamp: pino.stdTimeFunctions.isoTime },
      pino.multistream([{ stream: capture(stdout) }, { stream: apiloupe.pinoStream() }]),
    );
    let counter = 0;
    const app = express();
    // An access log like Soffa's: one line per request, written on finish.
    app.use((req, res, next) => {
      const started = process.hrtime.bigint();
      const requestId = `req-${++counter}`;
      res.locals.requestId = requestId;
      res.on('finish', () => {
        const status = res.statusCode;
        logger[status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'](
          {
            requestId,
            method: req.method,
            path: req.originalUrl.split('?')[0],
            status,
            durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          },
          'request',
        );
      });
      next();
    });
    app.get('/api/users/:id', (req, res) => {
      if (req.params.id === '13') {
        logger.error(
          { err: new Error('lock wait timeout'), requestId: res.locals.requestId as string },
          'Request error',
        );
        res.status(500).end();
        return;
      }
      res.json({ id: req.params.id });
    });
    const server = await serve(app);
    for (let i = 10; i < 30; i++) await fetch(`${server.base}/api/users/${i}`);
    await server.close();
    await apiloupe.shutdown();
    expect(apiloupe.stats()).toMatchObject({ sent: 21, queued: 0, dropped: 0 });

    const overview = await get<{ totals: { requests: number; status: Record<string, number> } }>(
      slug,
      `/overview?${range()}`,
    );
    expect(overview.totals.requests).toBe(20);
    expect(overview.totals.status['5xx']).toBe(1);
    const failed = await get<{ items: { ref: string }[] }>(slug, `/requests?${range()}&status=5xx`);
    const detail = await get<{ logs: { message: string; errorMessage: string }[] }>(
      slug,
      `/requests/${encodeURIComponent(failed.items[0]!.ref)}`,
    );
    expect(detail.logs).toEqual([
      expect.objectContaining({ message: 'Request error', errorMessage: 'lock wait timeout' }),
    ]);

    // The backfill: the same stdout, imported later, is already there.
    const backfill = await runImport(stdout, { endpoint, key, retryBaseMs: 10 });
    expect(backfill.events).toBe(21);
    expect(backfill.accepted).toBe(0);
    expect(backfill.duplicates).toBe(21);
  });

  it('Express middleware, with errors from the error handler', async () => {
    const { slug, key } = await projectWithKey(t.app, cookie, 'Middleware');
    const apiloupe = createApiloupe({ endpoint, key, onError: false, service: 'orders' });
    const app = express();
    app.use(apiloupe.express());
    app.get('/orders/:id', (req, res) => {
      if (req.params.id === 'bad')
        throw new TypeError("Cannot read properties of null (reading 'total')");
      res.json({ id: req.params.id });
    });
    app.use(apiloupe.expressErrorHandler());
    app.use(
      (
        _err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res.status(500).json({ error: 'internal' });
      },
    );
    const server = await serve(app);
    for (const id of ['1', '2', 'bad']) {
      await fetch(`${server.base}/orders/${id}`, { headers: { 'x-request-id': `o-${id}` } });
    }
    await server.close();
    await apiloupe.shutdown();

    const overview = await get<{ totals: { requests: number }; routes: { route: string }[] }>(
      slug,
      `/overview?${range()}`,
    );
    expect(overview.totals.requests).toBe(3);
    expect(overview.routes.map((r) => r.route)).toEqual(['/orders/:id']);
    const errors = await get<{ items: { ref: string; requestId: string; errorType: string }[] }>(
      slug,
      `/logs?${range()}&minLevel=error`,
    );
    expect(errors.items).toEqual([
      expect.objectContaining({ requestId: 'o-bad', errorType: 'TypeError' }),
    ]);
    const log = await get<{ log: { errorStack: string }; request: { status: number } }>(
      slug,
      `/logs/${encodeURIComponent(errors.items[0]!.ref)}`,
    );
    expect(log.log.errorStack).toContain('sdk-e2e.test.ts');
    expect(log.request.status).toBe(500);
  });
});
