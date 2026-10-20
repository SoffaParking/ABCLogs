import { Writable } from 'node:stream';
import { runCloudWatchImport, type LogSource } from '@apiloupe/importer';
import { createApiloupe } from '@apiloupe/node';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, projectWithKey, setupAdmin, testApp, type TestApp } from './helpers.js';

/**
 * M4's acceptance test. An app ships its logs live with the SDK, then loses
 * the connection for a while; everything it wrote is also in CloudWatch.
 * Backfilling from CloudWatch afterwards must store exactly what was missed:
 * nothing shipped live is stored or counted twice.
 */
describe.skipIf(!hasDatabase)('live SDK + CloudWatch backfill', () => {
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

  it('a backfill of a period already shipped live adds only what was missed', async () => {
    const { slug, key } = await projectWithKey(t.app, cookie, 'Backfill');
    // stdout, which the container's log driver sends to CloudWatch.
    const stdout: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _encoding, done) {
        stdout.push(chunk.toString().trimEnd());
        done();
      },
    });
    const options = {
      base: { service: 'parking-backend' },
      timestamp: pino.stdTimeFunctions.isoTime,
    };
    const apiloupe = createApiloupe({ endpoint, key, onError: false });
    const live = pino(
      options,
      pino.multistream([{ stream: capture }, { stream: apiloupe.pinoStream() }]),
    );
    // The same app while apiloupe was unreachable: its lines only reach stdout.
    const offline = pino(options, capture);

    const request = (logger: pino.Logger, i: number) =>
      logger[i % 10 === 0 ? 'error' : 'info'](
        {
          requestId: `r${i}`,
          method: 'GET',
          path: `/api/users/${i}`,
          status: i % 10 === 0 ? 500 : 200,
          durationMs: 5,
        },
        'request',
      );
    for (let i = 0; i < 150; i++) {
      request(live, i);
      if (i % 10 === 0)
        live.error({ requestId: `r${i}`, err: 'lock wait timeout' }, 'Request error');
    }
    for (let i = 150; i < 200; i++) {
      request(offline, i);
      if (i % 10 === 0)
        offline.error({ requestId: `r${i}`, err: 'lock wait timeout' }, 'Request error');
    }
    await apiloupe.shutdown();
    expect(apiloupe.stats()).toMatchObject({ sent: 165, queued: 0 });

    // CloudWatch holds every stdout line, stamped with when it was written.
    const events = stdout.map((message) => ({
      timestamp: Date.parse((JSON.parse(message) as { time: string }).time),
      message,
    }));
    const logs: LogSource = {
      fetchPage: ({ start, end }) =>
        Promise.resolve({
          events: events.filter((e) => e.timestamp >= start && e.timestamp < end),
        }),
    };
    const times = events.map((e) => e.timestamp);
    const backfill = await runCloudWatchImport(logs, {
      endpoint,
      key,
      source: { logGroup: '/ecs/parking', streamPrefix: 'api', filterPattern: null },
      since: Math.min(...times) - 60_000,
      until: Math.max(...times) + 60_000,
      checkpointFile: null,
    });
    expect(backfill).toMatchObject({ lines: 220, accepted: 55, duplicates: 165 });

    const range = `from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`;
    const overview = await t.app.inject({
      url: `/api/v1/projects/${slug}/overview?${range}`,
      headers: { cookie },
    });
    expect(
      overview.json<{ totals: { requests: number; status: { '5xx': number } } }>().totals,
    ).toMatchObject({
      requests: 200,
      status: { '5xx': 20 },
    });
    const issues = await t.app.inject({
      url: `/api/v1/projects/${slug}/issues?${range}`,
      headers: { cookie },
    });
    expect(issues.json<{ items: { title: string; count: number }[] }>().items).toEqual([
      expect.objectContaining({ title: 'lock wait timeout', count: 20 }),
    ]);
  });

  it('sampled live shipping and a backfill at the same rate store the same lines once', async () => {
    const { slug, key } = await projectWithKey(t.app, cookie, 'Sampled');
    const stdout: string[] = [];
    const capture = new Writable({
      write(chunk: Buffer, _encoding, done) {
        stdout.push(chunk.toString().trimEnd());
        done();
      },
    });
    const apiloupe = createApiloupe({ endpoint, key, onError: false, sampleRate: 0.2 });
    const logger = pino(
      { base: { service: 'api' }, timestamp: pino.stdTimeFunctions.isoTime },
      pino.multistream([{ stream: capture }, { stream: apiloupe.pinoStream() }]),
    );
    for (let i = 0; i < 500; i++) {
      const failed = i % 25 === 0;
      logger[failed ? 'error' : 'info'](
        {
          requestId: `q${i}`,
          method: 'GET',
          path: '/api/x',
          status: failed ? 500 : 200,
          durationMs: 4,
        },
        'request',
      );
    }
    await apiloupe.shutdown();
    const sent = apiloupe.stats().sent;

    const events = stdout.map((message) => ({
      timestamp: Date.parse((JSON.parse(message) as { time: string }).time),
      message,
    }));
    const times = events.map((e) => e.timestamp);
    const backfill = await runCloudWatchImport(
      {
        fetchPage: ({ start, end }) =>
          Promise.resolve({
            events: events.filter((e) => e.timestamp >= start && e.timestamp < end),
          }),
      },
      {
        endpoint,
        key,
        sampleRate: 0.2,
        source: { logGroup: '/ecs/sampled', streamPrefix: null, filterPattern: null },
        since: Math.min(...times) - 60_000,
        until: Math.max(...times) + 60_000,
        checkpointFile: null,
      },
    );
    // Same rate, same lines: nothing new.
    expect(backfill.accepted).toBe(0);
    expect(backfill.duplicates).toBe(sent);

    const range = `from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`;
    const overview = await t.app.inject({
      url: `/api/v1/projects/${slug}/overview?${range}`,
      headers: { cookie },
    });
    const totals = overview.json<{ totals: { requests: number; status: Record<string, number> } }>()
      .totals;
    // Failures are never sampled: exact. The rest is an estimate of 480.
    expect(totals.status['5xx']).toBe(20);
    expect(totals.requests).toBeGreaterThan(300);
    expect(totals.requests).toBeLessThan(700);
  });
});
