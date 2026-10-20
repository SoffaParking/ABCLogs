import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudWatchSource, runCloudWatchImport } from '../src/cloudwatch.js';
import { ImportError } from '../src/run.js';
import { fakeIngest } from './fake-ingest.js';

/**
 * The real AWS SDK client against a stand-in CloudWatch Logs endpoint that
 * speaks its JSON protocol: checks the request it signs and sends, paging,
 * and how AWS errors come out.
 */
describe('cloudWatchSource (AWS SDK)', () => {
  const requests: {
    target: string | undefined;
    auth: string | undefined;
    body: Record<string, unknown>;
  }[] = [];
  let server: Server;
  let url: string;
  const saved = { ...process.env };
  const T = Date.UTC(2026, 9, 18, 12);

  beforeAll(async () => {
    // Credentials from the environment, as the default chain finds them first.
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'example-secret';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        requests.push({
          target: req.headers['x-amz-target'] as string | undefined,
          auth: req.headers.authorization,
          body,
        });
        res.setHeader('content-type', 'application/x-amz-json-1.1');
        const fail = (type: string, message: string) => {
          res.statusCode = 400;
          res.end(JSON.stringify({ __type: type, message }));
        };
        if (body.logGroupName === '/missing')
          return fail('ResourceNotFoundException', 'The specified log group does not exist.');
        if (body.logGroupName === '/denied')
          return fail('AccessDeniedException', 'User is not authorized');
        const line = (i: number) =>
          `{"level":30,"time":"${new Date(T + i).toISOString()}","msg":"m${i}"}`;
        const page =
          body.nextToken === 'page-2'
            ? {
                events: [
                  { timestamp: T + 2, message: line(2), logStreamName: 'api/web/2', eventId: 'e2' },
                ],
              }
            : {
                events: [
                  { timestamp: T, message: line(0), logStreamName: 'api/web/1', eventId: 'e0' },
                  { timestamp: T + 1, message: line(1), logStreamName: 'api/web/1', eventId: 'e1' },
                ],
                nextToken: 'page-2',
              };
        res.end(JSON.stringify(page));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    process.env = saved;
    await new Promise((resolve) => server.close(resolve));
  });

  const source = (logGroup: string) =>
    cloudWatchSource({ logGroup, streamPrefix: 'api', region: 'eu-central-1', awsEndpoint: url });

  it('sends a signed FilterLogEvents for the window and follows nextToken', async () => {
    const logs = await source('/ecs/api');
    const first = await logs.fetchPage({ start: T, end: T + 3_600_000 });
    expect(first.events).toHaveLength(2);
    expect(first.nextToken).toBe('page-2');
    const second = await logs.fetchPage({ start: T, end: T + 3_600_000 }, first.nextToken);
    expect(second).toEqual({
      events: [expect.objectContaining({ timestamp: T + 2 })],
      nextToken: undefined,
    });

    expect(requests[0]!.target).toBe('Logs_20140328.FilterLogEvents');
    expect(requests[0]!.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/logs\/aws4_request/,
    );
    expect(requests[0]!.body).toEqual({
      logGroupName: '/ecs/api',
      logStreamNamePrefix: 'api',
      startTime: T,
      endTime: T + 3_600_000 - 1,
      limit: 10000,
    });
    expect(requests[1]!.body.nextToken).toBe('page-2');
  });

  it('explains a missing log group and missing permissions', async () => {
    await expect((await source('/missing')).fetchPage({ start: T, end: T + 1 })).rejects.toThrow(
      new ImportError('no log group /missing in eu-central-1'),
    );
    const denied = (await source('/denied')).fetchPage({ start: T, end: T + 1 });
    await expect(denied).rejects.toBeInstanceOf(ImportError);
    await expect(denied).rejects.toThrow(/logs:FilterLogEvents on \/denied/);
  });

  it('imports end to end through the SDK', async () => {
    const ingest = await fakeIngest();
    try {
      const result = await runCloudWatchImport(await source('/ecs/api'), {
        endpoint: ingest.url,
        key: 'alk_k',
        source: { logGroup: '/ecs/api', streamPrefix: 'api', filterPattern: null },
        since: T,
        until: T + 3_600_000,
        checkpointFile: null,
      });
      expect(result).toMatchObject({ lines: 3, accepted: 3 });
    } finally {
      await ingest.close();
    }
  });
});
