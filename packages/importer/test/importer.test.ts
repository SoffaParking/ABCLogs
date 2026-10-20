import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportError, readLines, runImport, synthesizeLines } from '../src/index.js';

const T = '2026-10-19T12:00:00.000Z';
const LINES = [
  JSON.stringify({
    level: 30,
    time: T,
    method: 'GET',
    path: '/a',
    status: 200,
    durationMs: 3,
    msg: 'request',
  }),
  JSON.stringify({ level: 50, time: T, err: 'boom', msg: 'Request error' }),
  'plain text',
  '',
  JSON.stringify({ msg: 'no time' }),
];

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

describe('readLines', () => {
  it('reads plain and gzipped files alike, by content rather than name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apiloupe-import-'));
    writeFileSync(join(dir, 'plain.log'), 'a\nb\r\nc');
    writeFileSync(join(dir, 'packed.log'), gzipSync('x\ny\n'));
    writeFileSync(join(dir, 'empty.log'), '');
    expect(await collect(readLines(join(dir, 'plain.log')))).toEqual(['a', 'b', 'c']);
    expect(await collect(readLines(join(dir, 'packed.log')))).toEqual(['x', 'y']);
    expect(await collect(readLines(join(dir, 'empty.log')))).toEqual([]);
  });
});

describe('runImport', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /** A fake ingest server; `handle` decides each response. */
  async function fake(
    handle: (
      req: IncomingMessage,
      body: Buffer,
      n: number,
    ) => { status: number; body?: unknown; headers?: Record<string, string> },
  ): Promise<string> {
    let n = 0;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const out = handle(req, Buffer.concat(chunks), n++);
        res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
        res.end(JSON.stringify(out.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('counts what it would send in a dry run, without a key or a server', async () => {
    const stats = await runImport(LINES, { endpoint: 'http://127.0.0.1:1', dryRun: true });
    expect(stats).toMatchObject({
      lines: 5,
      events: 2,
      skipped: { blank: 1, notJson: 1, noTime: 1 },
      accepted: 0,
    });
  });

  it('sends gzipped batches with ids derived from the lines, and retries 429 and 503', async () => {
    const batches: { events: { id: string }[] }[] = [];
    const endpoint = await fake((req, body, n) => {
      if (req.url === '/ingest/v1/check') return { status: 200, body: { ok: true } };
      expect(req.headers.authorization).toBe('Bearer alk_k');
      expect(req.headers['content-encoding']).toBe('gzip');
      if (n === 1) return { status: 429, headers: { 'retry-after': '0' } };
      if (n === 2) return { status: 503 };
      const parsed = JSON.parse(gunzipSync(body).toString()) as { events: { id: string }[] };
      batches.push(parsed);
      return { status: 202, body: { accepted: parsed.events.length, duplicates: 0, rejected: [] } };
    });
    const stats = await runImport(LINES, { endpoint, key: 'alk_k', retryBaseMs: 1 });
    expect(stats.accepted).toBe(2);
    expect(batches).toHaveLength(1);
    const ids = batches[0]!.events.map((e) => e.id);
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true);
  });

  it('reports refused events by line number', async () => {
    const endpoint = await fake((req) =>
      req.url === '/ingest/v1/check'
        ? { status: 200 }
        : {
            status: 202,
            body: { accepted: 1, duplicates: 0, rejected: [{ index: 1, reason: 'nope' }] },
          },
    );
    const stats = await runImport(LINES, { endpoint, key: 'alk_k' });
    // The second event came from line 2.
    expect(stats.rejections).toEqual([{ line: 2, reason: 'nope' }]);
  });

  it('stops at once on a refused key', async () => {
    const endpoint = await fake(() => ({ status: 401, body: { error: 'bad key' } }));
    await expect(runImport(LINES, { endpoint, key: 'alk_bad' })).rejects.toBeInstanceOf(
      ImportError,
    );
  });

  it('gives up on an unreachable server after its retries', async () => {
    await expect(
      runImport(LINES, {
        endpoint: 'http://127.0.0.1:1',
        key: 'alk_k',
        retryBaseMs: 1,
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/could not reach/);
  });
});

describe('synthesizeLines', () => {
  it('is deterministic per seed and ends before now', () => {
    const now = Date.parse(T);
    const a = synthesizeLines({ now, minutes: 10, seed: 1 });
    expect(synthesizeLines({ now, minutes: 10, seed: 1 })).toEqual(a);
    expect(synthesizeLines({ now, minutes: 10, seed: 2 })).not.toEqual(a);
    const times = a.flatMap((line) => {
      try {
        return [Date.parse((JSON.parse(line) as { time: string }).time)];
      } catch {
        return [];
      }
    });
    expect(Math.max(...times)).toBeLessThan(now);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(now - 11 * 60_000);
  });
});

describe('--sample-rate', () => {
  it('keeps the routine lines the SDK would keep at the same rate, and every error', async () => {
    const { eventIdForLine } = await import('@apiloupe/shared/node');
    const { inSample } = await import('@apiloupe/shared');
    const T2 = new Date().toISOString();
    const lines = Array.from(
      { length: 300 },
      (_, i) => `{"level":30,"time":"${T2}","msg":"m${i}"}`,
    );
    lines.push(`{"level":50,"time":"${T2}","msg":"boom"}`);
    const stats = await runImport(lines, {
      endpoint: 'http://127.0.0.1:1',
      dryRun: true,
      sampleRate: 0.2,
    });
    const expected = lines.slice(0, 300).filter((l) => inSample(eventIdForLine(l), 0.2)).length;
    expect(stats.events).toBe(expected + 1);
    expect(stats.sampledOut).toBe(300 - expected);
  });
});
