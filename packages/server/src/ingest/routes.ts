import { createGunzip } from 'node:zlib';
import { MAX_BATCH_EVENTS, type IngestResult } from '@apiloupe/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, HttpError, unauthorized } from '../http.js';
import { EventRateLimiter, WriteGate } from './limits.js';
import { RouteCap } from './routecap.js';
import { storeBatch } from './store.js';
import { checkEvent, type StoredEvent, type StoredRequest } from './validate.js';

const DAY_MS = 86_400_000;
// How far ahead of the server's clock an event may be.
const CLOCK_SKEW_MS = 60 * 60_000;
// Decompressed; a full batch of 1000 events is far below this.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const BUSY_RETRY_SECONDS = 2;

/** `/ingest/v1/*`: where the SDK, the importer, or anything else sends events. */
export function ingestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new EventRateLimiter(ctx.config.ingest.eventsPerSecond);
  const gate = new WriteGate(ctx.config.ingest.concurrency, ctx.config.ingest.concurrency * 8);
  const routes = new RouteCap(ctx.pool, ctx.config.ingest.maxRoutes);

  async function authenticate(authorization: string | undefined) {
    const key = await ctx.keys.resolve(authorization);
    if (!key) throw unauthorized('missing, invalid or revoked ingest key');
    return key;
  }

  app.get('/check', async (req) => {
    const key = await authenticate(req.headers.authorization);
    const { rows } = await ctx.pool.query<{ slug: string; name: string }>(
      'SELECT slug, name FROM projects WHERE id = $1',
      [key.projectId],
    );
    return { ok: true, project: rows[0] ?? null };
  });

  app.post(
    '/events',
    {
      bodyLimit: MAX_BODY_BYTES,
      // gzip bodies are inflated as they stream in, so bodyLimit applies to the
      // inflated size and a small compressed bomb cannot exhaust memory.
      preParsing: async (req, _reply, payload) => {
        const encoding = (req.headers['content-encoding'] ?? 'identity').toLowerCase();
        if (encoding === 'identity') return payload;
        if (encoding !== 'gzip')
          throw new HttpError(415, 'content-encoding must be gzip or identity');
        const inflated = Object.assign(createGunzip(), { receivedEncodedLength: 0 });
        payload.on('data', (chunk: Buffer) => {
          inflated.receivedEncodedLength += chunk.length;
        });
        payload.on('error', (err) => inflated.destroy(err));
        return payload.pipe(inflated);
      },
    },
    async (req, reply) => {
      const key = await authenticate(req.headers.authorization);
      const body = req.body as { events?: unknown } | null;
      const events = body && typeof body === 'object' ? body.events : undefined;
      if (!Array.isArray(events)) throw badRequest('expected {"events": [...]}');
      if (events.length === 0) throw badRequest('events is empty');
      if (events.length > MAX_BATCH_EVENTS) {
        throw badRequest(`at most ${MAX_BATCH_EVENTS} events per batch`);
      }

      const wait = limiter.take(key.keyId, events.length);
      if (wait > 0) {
        throw new HttpError(429, 'rate limit exceeded', { 'retry-after': String(wait) });
      }

      const now = Date.now();
      const window = {
        oldest: now - ctx.config.retentionDays * DAY_MS,
        newest: now + CLOCK_SKEW_MS,
      };
      const valid: StoredEvent[] = [];
      const rejected: IngestResult['rejected'] = [];
      events.forEach((raw, index) => {
        const checked = checkEvent(raw, window);
        if (checked.ok) valid.push(checked.event);
        else rejected.push({ index, reason: checked.reason });
      });

      const outcome = await gate.run(async () => {
        await routes.apply(
          key.projectId,
          valid.filter((e): e is StoredRequest => e.kind === 'request'),
        );
        await ctx.partitions.ensureFor(valid.map((e) => e.time));
        return withTransaction(ctx.pool, (client) =>
          storeBatch(client, key.projectId, valid, rejected.length),
        );
      });
      if (!outcome) {
        throw new HttpError(503, 'busy, retry shortly', {
          'retry-after': String(BUSY_RETRY_SECONDS),
        });
      }
      const result: IngestResult = { ...outcome.value, rejected };
      return reply.code(202).send(result);
    },
  );
}
