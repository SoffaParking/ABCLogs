import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventIdForLine } from '@apiloupe/shared/node';
import { afterEach, describe, expect, it } from 'vitest';
import { readCheckpoint, writeCheckpoint } from '../src/checkpoint.js';
import { runCloudWatchImport, type LogSource } from '../src/cloudwatch.js';
import { ImportError } from '../src/run.js';
import { parseDuration, parseWhen } from '../src/time.js';
import { fakeIngest } from './fake-ingest.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 18, 0, 0);
const SOURCE = { logGroup: '/ecs/api', streamPrefix: 'api', filterPattern: null };

/** A pino line written at `time`, as CloudWatch stores it. */
const line = (time: number, msg: string) =>
  `{"level":30,"time":"${new Date(time).toISOString()}","msg":"${msg}"}`;

/** An in-memory log group: pages of `pageSize`, and a record of every request. */
function fakeLogs(events: { timestamp: number; message: string }[], pageSize = 3) {
  const calls: { start: number; end: number; token?: string | undefined }[] = [];
  const source: LogSource = {
    fetchPage: ({ start, end }, token) => {
      calls.push({ start, end, token });
      const inWindow = events.filter((e) => e.timestamp >= start && e.timestamp < end);
      const offset = token ? Number(token) : 0;
      const page = inWindow.slice(offset, offset + pageSize);
      const next = offset + pageSize < inWindow.length ? String(offset + pageSize) : undefined;
      return Promise.resolve({ events: page, nextToken: next });
    },
  };
  return { source, calls, events };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function ingest(fail?: (batch: number) => number | undefined) {
  const server = await fakeIngest(fail);
  cleanups.push(server.close);
  return server;
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'apiloupe-cw-')), 'checkpoint.json');
}

// Ten events spread over three hours.
const EVENTS = Array.from({ length: 10 }, (_, i) => {
  const timestamp = T0 + i * 18 * 60_000;
  return { timestamp, message: line(timestamp, `event ${i}`) };
});

describe('parseWhen / parseDuration', () => {
  it('reads durations back from now, ISO times and epoch ms', () => {
    const now = T0;
    expect(parseWhen('14d', now)).toBe(now - 14 * 24 * HOUR);
    expect(parseWhen('90m', now)).toBe(now - 90 * 60_000);
    expect(parseWhen('2026-10-01T00:00:00Z')).toBe(Date.UTC(2026, 9, 1));
    expect(parseWhen(String(T0))).toBe(T0);
    expect(() => parseWhen('yesterday')).toThrow(/not a time/);
    expect(parseDuration('30s', 'x')).toBe(30_000);
    expect(() => parseDuration('soon', '--poll')).toThrow(/--poll/);
  });
});

describe('runCloudWatchImport', () => {
  it('imports every page of every window and moves the checkpoint after each window', async () => {
    const server = await ingest();
    const logs = fakeLogs(EVENTS);
    const file = tempFile();
    const windows: { start: number; end: number; lines: number }[] = [];
    const result = await runCloudWatchImport(logs.source, {
      endpoint: server.url,
      key: 'alk_k',
      source: SOURCE,
      since: T0,
      until: T0 + 3 * HOUR,
      checkpointFile: file,
      onWindow: (w) => windows.push(w),
    });
    expect(result).toMatchObject({ lines: 10, accepted: 10, position: T0 + 3 * HOUR });
    expect(windows.map((w) => [w.start, w.end, w.lines])).toEqual([
      [T0, T0 + HOUR, 4],
      [T0 + HOUR, T0 + 2 * HOUR, 3],
      [T0 + 2 * HOUR, T0 + 3 * HOUR, 3],
    ]);
    // Paged: window 1 holds 4 events, at 3 per page.
    expect(logs.calls.filter((c) => c.start === T0).map((c) => c.token)).toEqual([undefined, '3']);
    expect(readCheckpoint(file)).toMatchObject({
      source: SOURCE,
      position: new Date(T0 + 3 * HOUR).toISOString(),
    });
    // The ids are the line hashes, as for the same lines shipped live.
    expect([...server.stored.keys()].sort()).toEqual(
      EVENTS.map((e) => eventIdForLine(e.message)).sort(),
    );
  });

  it('resumes from the checkpoint, re-reading a little before it at no cost', async () => {
    const server = await ingest();
    const file = tempFile();
    writeCheckpoint(file, SOURCE, T0 + 2 * HOUR);
    const logs = fakeLogs(EVENTS);
    let resumedAt = 0;
    const result = await runCloudWatchImport(logs.source, {
      endpoint: server.url,
      key: 'alk_k',
      source: SOURCE,
      since: T0 - 14 * 24 * HOUR, // ignored: the checkpoint wins
      until: T0 + 3 * HOUR,
      checkpointFile: file,
      overlapMs: 10 * 60_000,
      onResume: (position) => (resumedAt = position),
    });
    expect(resumedAt).toBe(T0 + 2 * HOUR);
    expect(logs.calls[0]!.start).toBe(T0 + 2 * HOUR - 10 * 60_000);
    // Events at 2:06, 2:24, 2:42 (and none in the 10-minute overlap).
    expect(result.accepted).toBe(3);
  });

  it('a failure part way leaves the checkpoint at the last whole window', async () => {
    // Batches of 2: window 1 is batches 0-1, window 2 fails at batch 2.
    const server = await ingest((batch) => (batch === 2 ? 401 : undefined));
    const file = tempFile();
    await expect(
      runCloudWatchImport(fakeLogs(EVENTS).source, {
        endpoint: server.url,
        key: 'alk_k',
        batchSize: 2,
        source: SOURCE,
        since: T0,
        until: T0 + 3 * HOUR,
        checkpointFile: file,
      }),
    ).rejects.toBeInstanceOf(ImportError);
    expect(readCheckpoint(file)!.position).toBe(new Date(T0 + HOUR).toISOString());

    // Running again finishes the job; what was already sent is a duplicate.
    const healthy = await ingest();
    const again = await runCloudWatchImport(fakeLogs(EVENTS).source, {
      endpoint: healthy.url,
      key: 'alk_k',
      source: SOURCE,
      since: T0,
      until: T0 + 3 * HOUR,
      checkpointFile: file,
    });
    expect(again.position).toBe(T0 + 3 * HOUR);
    expect(healthy.stored.size).toBe(6);
  });

  it('stopped mid-window, it does not move the checkpoint past what was read', async () => {
    const server = await ingest();
    const file = tempFile();
    const controller = new AbortController();
    const logs = fakeLogs(EVENTS);
    const source: LogSource = {
      fetchPage: (w, token) => {
        // Stop while reading the first page of a two-page window.
        if (w.start === T0 && !token) controller.abort();
        return logs.source.fetchPage(w, token);
      },
    };
    const result = await runCloudWatchImport(source, {
      endpoint: server.url,
      key: 'alk_k',
      source: SOURCE,
      since: T0,
      until: T0 + 3 * HOUR,
      checkpointFile: file,
      signal: controller.signal,
    });
    expect(result.position).toBe(T0);
    expect(readCheckpoint(file)).toBeNull();
    // What was read is sent (a later run sees it as duplicates); the second page was not read.
    expect(server.stored.size).toBe(3);
    expect(logs.calls).toHaveLength(1);
  });

  it('refuses a checkpoint written for another log group', async () => {
    const server = await ingest();
    const file = tempFile();
    writeCheckpoint(file, { ...SOURCE, logGroup: '/ecs/other' }, T0);
    await expect(
      runCloudWatchImport(fakeLogs(EVENTS).source, {
        endpoint: server.url,
        key: 'alk_k',
        source: SOURCE,
        since: T0,
        until: T0 + HOUR,
        checkpointFile: file,
      }),
    ).rejects.toThrow(/another import/);
  });

  it('gives plain-text lines the time CloudWatch recorded, so re-imports stay duplicates', async () => {
    const server = await ingest();
    const plain = [
      { timestamp: T0 + 1000, message: 'DB init failed: connect ECONNREFUSED' },
      {
        timestamp: T0 + 2000,
        message: JSON.stringify({ log: `${line(T0 + 2000, 'wrapped')}\n`, stream: 'stdout' }),
      },
    ];
    const options = {
      endpoint: server.url,
      key: 'alk_k',
      plainText: true,
      source: SOURCE,
      since: T0,
      until: T0 + HOUR,
      checkpointFile: null,
    };
    expect((await runCloudWatchImport(fakeLogs(plain).source, options)).accepted).toBe(2);
    expect((await runCloudWatchImport(fakeLogs(plain).source, options)).duplicates).toBe(2);
    const stored = [...server.stored.values()];
    expect(stored[0]).toMatchObject({
      type: 'log',
      time: T0 + 1000,
      message: 'DB init failed: connect ECONNREFUSED',
    });
    // The Docker envelope is taken off: same id as the bare line.
    expect(server.stored.has(eventIdForLine(line(T0 + 2000, 'wrapped')))).toBe(true);
  });

  it('follows new logs until stopped, staying behind now by the lag', async () => {
    const server = await ingest();
    const now = Date.now();
    const events = [{ timestamp: now - 10 * 60_000, message: line(now - 10 * 60_000, 'old') }];
    const logs = fakeLogs(events);
    const controller = new AbortController();
    const file = tempFile();
    let polls = 0;
    const source: LogSource = {
      fetchPage: (w, token) => {
        polls += 1;
        // A new event appears after the first round.
        if (polls === 2)
          events.push({ timestamp: now - 3 * 60_000, message: line(now - 3 * 60_000, 'new') });
        if (polls >= 3) setTimeout(() => controller.abort(), 0);
        return logs.source.fetchPage(w, token);
      },
    };
    const result = await runCloudWatchImport(source, {
      endpoint: server.url,
      key: 'alk_k',
      source: SOURCE,
      since: now - 15 * 60_000,
      follow: true,
      pollMs: 10,
      lagMs: 60_000,
      checkpointFile: file,
      signal: controller.signal,
    });
    expect(server.stored.size).toBe(2);
    expect(result.position).toBeLessThanOrEqual(Date.now() - 60_000);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('writes no checkpoint on a dry run', async () => {
    const file = tempFile();
    writeFileSync(file, '');
    const result = await runCloudWatchImport(fakeLogs(EVENTS).source, {
      endpoint: 'http://127.0.0.1:1',
      dryRun: true,
      source: SOURCE,
      since: T0,
      until: T0 + 3 * HOUR,
      checkpointFile: file,
    });
    expect(result.events).toBe(10);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
