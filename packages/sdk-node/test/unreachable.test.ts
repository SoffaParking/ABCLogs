import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiloupe } from '../src/index.js';
import { blackhole, fakeServer } from './fake-server.js';

/**
 * The SDK's promise to its host: with the server down or hanging, the app
 * neither throws, nor slows down, nor fails to exit.
 */
describe('when apiloupe is unreachable', () => {
  let hole: Awaited<ReturnType<typeof blackhole>>;
  beforeAll(async () => {
    hole = await blackhole();
  });
  afterAll(async () => {
    await hole.close();
  });

  it('costs the app well under a millisecond per request and per log line', async () => {
    const apiloupe = createApiloupe({
      endpoint: hole.url,
      key: 'alk_abcdefgh_x',
      onError: false,
      maxQueue: 5000,
    });
    const middleware = apiloupe.express();
    const stream = apiloupe.pinoStream();
    const line = `{"level":30,"time":"${new Date().toISOString()}","requestId":"r","method":"GET","path":"/api/x","status":200,"durationMs":3,"msg":"request"}\n`;
    const n = 20_000;
    const started = performance.now();
    for (let i = 0; i < n; i++) {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      middleware({ method: 'GET', url: `/api/items/${i}?q=1`, headers: {} }, res, () => undefined);
      res.emit('finish');
      stream.write(line);
    }
    const perRequestMs = (performance.now() - started) / n;
    // The milestone's bar is 1 ms; the real figure is a few microseconds.
    expect(perRequestMs).toBeLessThan(0.1);
    expect(apiloupe.stats().dropped).toBeGreaterThan(0); // the queue stayed bounded
    await apiloupe.shutdown(100);
  });

  it('never throws, and flush and shutdown return by their deadline', async () => {
    const apiloupe = createApiloupe({ endpoint: hole.url, key: 'alk_abcdefgh_x', onError: false });
    apiloupe.log('error', 'nobody is listening');
    apiloupe.captureException(new Error('still fine'));
    const started = Date.now();
    await expect(apiloupe.flush(300)).resolves.toBeUndefined();
    await expect(apiloupe.shutdown(300)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(apiloupe.stats().queued).toBe(2);
    // Logging after shutdown is a no-op, not an error.
    expect(() => apiloupe.log('info', 'late')).not.toThrow();
  });

  it('flush returns by its deadline even while a background send hangs', async () => {
    const apiloupe = createApiloupe({
      endpoint: hole.url,
      key: 'alk_abcdefgh_x',
      onError: false,
      batchSize: 5,
      timeoutMs: 30_000,
    });
    // A full batch starts a background send, which the black hole never answers.
    for (let i = 0; i < 5; i++) apiloupe.log('info', `m${i}`);
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await apiloupe.flush(300);
    expect(Date.now() - started).toBeLessThan(800);
    await apiloupe.shutdown(100);
  });

  function runChild(
    endpoint: string,
    mode: string,
  ): Promise<{ code: number | null; ms: number; out: string }> {
    return new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '--conditions=source',
          new URL('./fixtures/exit-child.ts', import.meta.url).pathname,
          endpoint,
          mode,
        ],
        { cwd: new URL('..', import.meta.url).pathname },
      );
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, ms: Date.now() - started, out }));
    });
  }

  it('a script that just ends still delivers what it logged', async () => {
    const server = await fakeServer();
    try {
      const { code, out } = await runChild(server.url, 'none');
      expect(code).toBe(0);
      expect(out).toContain('done');
      // 2000 log calls and 2000 pino lines, sent by the exit flush.
      expect(server.events()).toHaveLength(4000);
    } finally {
      await server.close();
    }
  }, 20_000);

  it.each([
    ['hanging server, no shutdown call', 'hole', 'none'],
    ['hanging server, shutdown(1000)', 'hole', 'shutdown'],
    ['nothing listening, no shutdown call', 'refused', 'none'],
  ])(
    'the process exits cleanly: %s',
    async (_name, target, mode) => {
      const endpoint = target === 'hole' ? hole.url : 'http://127.0.0.1:1';
      const { code, ms, out } = await runChild(endpoint, mode);
      expect(out).toContain('done');
      expect(out).not.toContain('UNHANDLED');
      expect(code).toBe(0);
      // Process start-up (with the TypeScript loader) plus at most the 2 s exit
      // flush, never the 30 s request timeout.
      expect(ms).toBeLessThan(8000);
    },
    20_000,
  );
});
