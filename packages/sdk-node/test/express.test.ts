import type { AddressInfo } from 'node:net';
import express4 from 'express';
import express5 from 'express5';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiloupe, type Apiloupe } from '../src/index.js';
import { fakeServer } from './fake-server.js';

const KEY = 'alk_abcdefgh_0123456789abcdefghijklmnopqrstuv';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type ExpressFactory = typeof express4;

async function setup(express: ExpressFactory, options: Parameters<typeof createApiloupe>[0] = {}) {
  const ingest = await fakeServer();
  const apiloupe: Apiloupe = createApiloupe({
    endpoint: ingest.url,
    key: KEY,
    onError: false,
    flushIntervalMs: 60_000,
    ...options,
  });
  const app = express();
  app.use(express.json());
  app.use(apiloupe.express({ skip: (req) => req.url === '/health' }));
  const users = express.Router();
  users.get('/:id', (req, res) => {
    res.status(req.params.id === '0' ? 404 : 200).json({ id: req.params.id });
  });
  app.use('/api/users', users);
  app.post('/login', (_req, res) => {
    res.sendStatus(204);
  });
  app.get('/health', (_req, res) => {
    res.send('ok');
  });
  app.get('/boom', () => {
    throw new RangeError('out of range');
  });
  app.use(apiloupe.expressErrorHandler());
  app.use(
    (
      _err: unknown,
      _req: unknown,
      res: { status(n: number): { send(b: string): void } },
      _next: unknown,
    ) => {
      res.status(500).send('failed');
    },
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () => ingest.close(),
    () => new Promise((r) => server.close(r)),
    () => apiloupe.shutdown(100),
  );
  return { base, apiloupe, ingest };
}

for (const [name, express] of [
  ['Express 4', express4],
  ['Express 5', express5],
] as const) {
  describe(name, () => {
    it('records method, path without query, route pattern, status, duration and request id', async () => {
      const { base, apiloupe, ingest } = await setup(express);
      await fetch(`${base}/api/users/42?token=secret`, { headers: { 'x-request-id': 'req-1' } });
      await fetch(`${base}/api/users/0`);
      await fetch(`${base}/health`);
      await apiloupe.flush();
      const events = ingest.events();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'request',
        method: 'GET',
        path: '/api/users/42',
        route: '/api/users/:id',
        status: 200,
        requestId: 'req-1',
      });
      expect(events[0]!.durationMs).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain('secret');
      expect(events[1]).toMatchObject({ status: 404, route: '/api/users/:id' });
    });

    it('records errors with their stack, linked to the request', async () => {
      const { base, apiloupe, ingest } = await setup(express);
      const res = await fetch(`${base}/boom`, { headers: { 'x-request-id': 'req-boom' } });
      expect(res.status).toBe(500);
      await apiloupe.flush();
      const events = ingest.events();
      const error = events.find((e) => e.type === 'log');
      expect(error).toMatchObject({
        level: 50,
        requestId: 'req-boom',
        error: { type: 'RangeError', message: 'out of range' },
        attrs: { method: 'GET', path: '/boom', route: '/boom' },
      });
      expect(events.find((e) => e.type === 'request')).toMatchObject({
        status: 500,
        requestId: 'req-boom',
      });
    });

    it('sends bodies and headers only when asked, with secrets masked', async () => {
      const off = await setup(express);
      await fetch(`${off.base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer abcdefghijkl' },
        body: JSON.stringify({ email: 'a@example.com', password: 'hunter22' }),
      });
      await off.apiloupe.flush();
      expect(off.ingest.events()[0]!.attrs).toBeUndefined();

      const on = await setup(express, { captureBodies: true });
      await fetch(`${on.base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer abcdefghijkl' },
        body: JSON.stringify({ email: 'a@example.com', password: 'hunter22' }),
      });
      await on.apiloupe.flush();
      const attrs = on.ingest.events()[0]!.attrs as {
        body: object;
        headers: Record<string, string>;
      };
      expect(attrs.body).toEqual({ email: 'a@example.com', password: '[redacted]' });
      expect(attrs.headers.authorization).toBe('[redacted]');
    });
  });
}

it('the middleware is a pass-through when the client is off', () => {
  const apiloupe = createApiloupe({});
  let called = 0;
  apiloupe.express()({ url: '/' }, { statusCode: 200, on: () => undefined }, () => called++);
  expect(called).toBe(1);
});
