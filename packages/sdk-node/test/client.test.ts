import { Writable } from 'node:stream';
import { eventIdForLine } from '@apiloupe/shared/node';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiloupe, type Apiloupe } from '../src/index.js';
import { Ring } from '../src/ring.js';
import { fakeServer } from './fake-server.js';

const KEY = 'alk_abcdefgh_0123456789abcdefghijklmnopqrstuv';
const clients: Apiloupe[] = [];
const servers: { close: () => Promise<void> }[] = [];

function client(options: Parameters<typeof createApiloupe>[0]) {
  const c = createApiloupe({ onError: false, flushIntervalMs: 60_000, ...options });
  clients.push(c);
  return c;
}

async function server(...args: Parameters<typeof fakeServer>) {
  const s = await fakeServer(...args);
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.shutdown(100)));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('Ring', () => {
  it('keeps the newest items when full and says when it dropped one', () => {
    const ring = new Ring<number>(3);
    expect([1, 2, 3].map((n) => ring.push(n))).toEqual([false, false, false]);
    expect(ring.push(4)).toBe(true);
    expect(ring.take(2)).toEqual([2, 3]);
    ring.push(5);
    expect(ring.take(10)).toEqual([4, 5]);
    expect(ring.size).toBe(0);
  });
});

describe('client', () => {
  it('does nothing without an endpoint and key', async () => {
    const c = client({ endpoint: undefined, key: KEY });
    expect(c.enabled).toBe(false);
    c.log('error', 'ignored');
    c.pinoStream().write('{"level":30,"time":1,"msg":"x"}\n');
    await c.flush();
    expect(c.stats()).toMatchObject({ enabled: false, queued: 0, sent: 0 });
  });

  it('sends logs and exceptions, gzipped, with ids, the service and masked secrets', async () => {
    const s = await server();
    const c = client({ endpoint: s.url, key: KEY, service: 'orders' });
    c.log('warn', 'disk filling up', { requestId: 'r1', attrs: { password: 'p', disk: '/var' } });
    c.captureException(new TypeError('x is undefined'), { requestId: 'r2' });
    c.captureException('a plain string');
    await c.flush();
    expect(s.received[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.received[0]!.headers['user-agent']).toMatch(/^apiloupe-node\//);
    const [warn, crash, plain] = s.events();
    expect(warn).toMatchObject({
      type: 'log',
      level: 40,
      message: 'disk filling up',
      service: 'orders',
      requestId: 'r1',
      attrs: { password: '[redacted]', disk: '/var' },
    });
    expect(warn!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(crash).toMatchObject({
      level: 50,
      message: 'x is undefined',
      error: { type: 'TypeError', message: 'x is undefined' },
    });
    expect((crash!.error as { stack: string }).stack).toContain('client.test.ts');
    expect(plain).toMatchObject({
      message: 'a plain string',
      error: { message: 'a plain string' },
    });
    expect(c.stats()).toMatchObject({ sent: 3, queued: 0, dropped: 0 });
  });

  it('ships pino lines, with the same ids the importer would give them', async () => {
    const s = await server();
    const c = client({ endpoint: s.url, key: KEY });
    const stdout: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _enc, done) {
        stdout.push(chunk.toString());
        done();
      },
    });
    const logger = pino(
      { base: { service: 'parking-backend' }, timestamp: pino.stdTimeFunctions.isoTime },
      pino.multistream([{ stream: capture }, { stream: c.pinoStream() }]),
    );
    logger.info(
      { requestId: 'r9', method: 'GET', path: '/api/users/7', status: 200, durationMs: 4 },
      'request',
    );
    logger.error({ err: new Error('boom'), requestId: 'r9' }, 'handler failed');
    logger.debug('not written: below the logger level');
    await c.flush();
    const events = s.events();
    expect(events.map((e) => e.type)).toEqual(['request', 'log']);
    expect(events[0]).toMatchObject({
      method: 'GET',
      path: '/api/users/7',
      status: 200,
      service: 'parking-backend',
    });
    expect(events[1]).toMatchObject({
      level: 50,
      message: 'handler failed',
      error: { message: 'boom' },
    });
    // The live id equals the id of the same line imported from stdout later.
    expect(events.map((e) => e.id)).toEqual(stdout.map((line) => eventIdForLine(line)));
  });

  it('can leave request lines and low levels out of the pino stream', async () => {
    const s = await server();
    const c = client({ endpoint: s.url, key: KEY });
    const stream = c.pinoStream({ requests: false, minLevel: 'warn' });
    const T = new Date().toISOString();
    stream.write(
      `{"level":30,"time":"${T}","method":"GET","path":"/","status":200,"msg":"request"}\n`,
    );
    stream.write(
      `{"level":30,"time":"${T}","msg":"info line"}\n{"level":40,"time":"${T}","msg":"warn line"}\n`,
    );
    stream.write('not json\n');
    await c.flush();
    expect(s.events().map((e) => e.message)).toEqual(['warn line']);
  });

  it('retries 429 and 503, honouring Retry-After', async () => {
    const s = await server((n) =>
      n === 0
        ? { status: 429, headers: { 'retry-after': '1' } }
        : n === 1
          ? { status: 503 }
          : { status: 202 },
    );
    const c = client({ endpoint: s.url, key: KEY });
    c.log('info', 'eventually');
    await c.flush(200);
    expect(c.stats()).toMatchObject({ sent: 0, queued: 1, failedAttempts: 1 });
    await c.flush(200);
    await c.flush(200);
    expect(c.stats()).toMatchObject({ sent: 1, queued: 0, failedAttempts: 2 });
    expect(s.events()).toHaveLength(1);
  });

  it('drops a batch the server refuses for good, and says why', async () => {
    const s = await server(() => ({
      status: 401,
      body: { error: 'missing, invalid or revoked ingest key' },
    }));
    const errors: string[] = [];
    const c = client({ endpoint: s.url, key: KEY, onError: (e) => errors.push(e.message) });
    c.log('info', 'lost');
    await c.flush();
    expect(c.stats()).toMatchObject({ sent: 0, dropped: 1, queued: 0 });
    expect(errors[0]).toContain('refused the ingest key');
  });

  it('keeps memory bounded: past maxQueue the oldest events go', () => {
    const c = client({ endpoint: 'http://127.0.0.1:1', key: KEY, maxQueue: 10, batchSize: 1000 });
    for (let i = 0; i < 25; i++) c.log('info', `m${i}`);
    expect(c.stats()).toMatchObject({ queued: 10, dropped: 15 });
  });

  it('splits into batches of batchSize', async () => {
    const s = await server();
    const c = client({ endpoint: s.url, key: KEY, batchSize: 10 });
    for (let i = 0; i < 25; i++) c.log('info', `m${i}`);
    await c.flush();
    expect(s.received.map((r) => r.events.length)).toEqual([10, 10, 5]);
  });

  it('sends attrs it cannot serialise as far as it can, never failing the batch', async () => {
    const s = await server();
    const c = client({ endpoint: s.url, key: KEY });
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    c.log('info', 'odd attrs', { attrs: { circular, big: 10n } });
    c.log('info', 'normal');
    await c.flush();
    expect(s.events().map((e) => e.message)).toEqual(['odd attrs', 'normal']);
    expect(s.events()[0]!.attrs).toMatchObject({ big: '10', circular: { name: 'loop' } });
  });

  it('a throwing onError does not break sending', async () => {
    const s = await server(() => ({ status: 400 }));
    const c = client({
      endpoint: s.url,
      key: KEY,
      onError: () => {
        throw new Error('bad handler');
      },
    });
    c.log('info', 'x');
    await expect(c.flush()).resolves.toBeUndefined();
  });

  it('sends on its own timer and when a batch fills up', async () => {
    const s = await server();
    const c = client({ endpoint: s.url, key: KEY, flushIntervalMs: 50, batchSize: 5 });
    c.log('info', 'by timer');
    await new Promise((r) => setTimeout(r, 200));
    expect(s.events()).toHaveLength(1);
    for (let i = 0; i < 5; i++) c.log('info', `full ${i}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.events()).toHaveLength(6);
  });
});
