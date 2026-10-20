import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';
import {
  LEVEL,
  mapLogLine,
  MAX_BATCH_EVENTS,
  normalizeLevel,
  redact,
  sample,
  type EventInput,
  type IngestResult,
} from '@apiloupe/shared';
import { eventIdForLine } from '@apiloupe/shared/node';
import { expressErrorHandler, expressMiddleware } from './express.js';
import type {
  Apiloupe,
  ApiloupeOptions,
  ApiloupeStats,
  ExceptionDetails,
  ExpressOptions,
  LevelInput,
  LogDetails,
  PinoStream,
  PinoStreamOptions,
} from './index.js';
import { createPinoStream } from './pino.js';
import { Ring } from './ring.js';
import { post } from './transport.js';

const gzip = promisify(gzipCallback);

export const VERSION = '1.0.0';

/** A queued item: a ready event, or a raw log line mapped only when sent (off the hot path). */
type Item = { event: EventInput } | { line: string; stream: StreamConfig };

interface StreamConfig {
  minLevel: number;
  requests: boolean;
}

const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BACKOFF_MS = 60_000;
const WARN_EVERY_MS = 5 * 60_000;
const EXIT_FLUSH_MS = 2000;
// Statuses worth retrying; any other refusal will not get better by resending.
const RETRY = new Set([408, 425, 429, 500, 502, 503, 504]);

function positive(value: number | undefined, fallback: number, max = Infinity): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

export class Client implements Apiloupe {
  readonly enabled: boolean;
  readonly service: string | undefined;
  readonly captureBodies: boolean;
  readonly #sampleRate: number;
  readonly #url: URL | null;
  readonly #key: string;
  readonly #batchSize: number;
  readonly #timeoutMs: number;
  readonly #onError: ((error: Error) => void) | false | undefined;
  readonly #queue: Ring<Item>;
  /** Serialised events taken from the queue and not yet accepted. */
  #pending: string[] = [];
  #sending: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #retryAt = 0;
  #backoffMs = 0;
  #stopped = false;
  #exitFlushed = false;
  #lastWarnAt = 0;
  readonly #stats = { sent: 0, dropped: 0, failedAttempts: 0, sampledOut: 0 };
  #lastError: string | null = null;
  readonly #onBeforeExit = () => {
    if (this.#exitFlushed || this.#stopped || this.#backlog() === 0) return;
    this.#exitFlushed = true;
    void this.flush(EXIT_FLUSH_MS);
  };

  constructor(options: ApiloupeOptions) {
    this.#url = ingestUrl(options.endpoint);
    this.#key = options.key ?? '';
    this.enabled = Boolean(this.#url && this.#key);
    this.service = options.service || undefined;
    this.captureBodies = options.captureBodies ?? false;
    this.#sampleRate =
      typeof options.sampleRate === 'number' && options.sampleRate >= 0
        ? Math.min(options.sampleRate, 1)
        : 1;
    this.#batchSize = positive(options.batchSize, 500, MAX_BATCH_EVENTS);
    this.#timeoutMs = positive(options.timeoutMs, 10_000);
    this.#onError = options.onError;
    this.#queue = new Ring<Item>(this.enabled ? Math.floor(positive(options.maxQueue, 10_000)) : 1);
    if (!this.enabled) return;
    this.#timer = setInterval(() => this.#kick(), positive(options.flushIntervalMs, 2000));
    this.#timer.unref();
    if (options.flushOnExit !== false) process.on('beforeExit', this.#onBeforeExit);
  }

  express(options: ExpressOptions = {}) {
    return expressMiddleware(this, options);
  }

  expressErrorHandler() {
    return expressErrorHandler(this);
  }

  pinoStream(options: PinoStreamOptions = {}): PinoStream {
    const config: StreamConfig = {
      minLevel: options.minLevel === undefined ? 0 : (normalizeLevel(options.minLevel) ?? 0),
      requests: options.requests ?? true,
    };
    return createPinoStream((line) => this.#push({ line, stream: config }));
  }

  log(level: LevelInput, message: string, details: LogDetails = {}): void {
    try {
      const error = details.error === undefined ? undefined : describeError(details.error);
      this.enqueue({
        type: 'log',
        time: Date.now(),
        level: normalizeLevel(level) ?? LEVEL.info,
        message: String(message),
        ...(details.requestId ? { requestId: details.requestId } : {}),
        ...(error ? { error } : {}),
        ...(details.attrs ? { attrs: details.attrs } : {}),
      });
    } catch {
      // never throw into the caller
    }
  }

  captureException(error: unknown, details: ExceptionDetails = {}): void {
    try {
      const described = describeError(error);
      this.enqueue({
        type: 'log',
        time: Date.now(),
        level: normalizeLevel(details.level ?? 'error') ?? LEVEL.error,
        message: details.message ?? described.message ?? 'error',
        error: described,
        ...(details.requestId ? { requestId: details.requestId } : {}),
        ...(details.attrs ? { attrs: details.attrs } : {}),
      });
    } catch {
      // never throw into the caller
    }
  }

  /** Queues a ready event (used by the middleware and the methods above). */
  enqueue(event: EventInput): void {
    const id = event.id ?? randomUUID();
    const kept = sample({ ...event, id }, id, this.#sampleRate);
    if (kept) this.#push({ event: kept });
    else if (this.enabled) this.#stats.sampledOut += 1;
  }

  async flush(timeoutMs = 5000): Promise<void> {
    if (!this.enabled) return;
    const deadline = Date.now() + timeoutMs;
    // Background sends do not keep the process alive; a flush does, until it
    // is done or its deadline passes, and it never waits past the deadline
    // for a send already in flight.
    let expire!: () => void;
    const expired = new Promise<false>((resolve) => {
      expire = () => resolve(false);
    });
    const timer = setTimeout(expire, timeoutMs);
    try {
      while (this.#backlog() > 0 && Date.now() < deadline) {
        if (this.#sending) {
          await Promise.race([this.#sending, expired]);
          continue;
        }
        const progressed = await Promise.race([this.#run(true, deadline - Date.now()), expired]);
        // Unreachable or refusing: one try per flush, not a busy loop.
        if (!progressed) break;
      }
    } catch {
      // never reject
    } finally {
      clearTimeout(timer);
      expire();
    }
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    process.off('beforeExit', this.#onBeforeExit);
    await this.flush(timeoutMs);
    this.#stopped = true;
  }

  stats(): ApiloupeStats {
    return {
      enabled: this.enabled,
      queued: this.#backlog(),
      sent: this.#stats.sent,
      dropped: this.#stats.dropped,
      sampledOut: this.#stats.sampledOut,
      failedAttempts: this.#stats.failedAttempts,
      lastError: this.#lastError,
    };
  }

  #backlog(): number {
    return this.#queue.size + this.#pending.length;
  }

  #push(item: Item): void {
    if (!this.enabled || this.#stopped) return;
    if (this.#queue.push(item)) this.#stats.dropped += 1;
    if (this.#queue.size >= this.#batchSize && !this.#sending) setImmediate(() => this.#kick());
  }

  /** Starts a background send if one is due and none is running. */
  #kick(): void {
    if (this.#sending || this.#stopped || Date.now() < this.#retryAt || this.#backlog() === 0)
      return;
    void this.#run(false, this.#timeoutMs).then((progressed) => {
      // Keep going while a full batch is waiting; otherwise the timer picks it up.
      if (progressed && this.#queue.size >= this.#batchSize) setImmediate(() => this.#kick());
    });
  }

  /** Sends one batch. Resolves true when the batch is done with (sent or given up on). */
  #run(holdOpen: boolean, timeoutMs: number): Promise<boolean> {
    let progressed = false;
    const work = (async () => {
      try {
        progressed = await this.#sendBatch(
          holdOpen,
          Math.max(1, Math.min(timeoutMs, this.#timeoutMs)),
        );
      } catch (err) {
        this.#report(err as Error);
      }
    })();
    this.#sending = work.finally(() => {
      this.#sending = null;
    });
    return this.#sending.then(() => progressed);
  }

  async #sendBatch(holdOpen: boolean, timeoutMs: number): Promise<boolean> {
    if (this.#pending.length === 0) {
      this.#pending = this.#serialize(this.#queue.take(this.#batchSize));
      if (this.#pending.length === 0) return true;
    }
    let bytes = 0;
    let count = 0;
    while (count < this.#pending.length) {
      const size = this.#pending[count]!.length + 1;
      if (count > 0 && bytes + size > MAX_BATCH_BYTES) break;
      bytes += size;
      count += 1;
    }
    const events = this.#pending.slice(0, count);
    const body = await gzip(Buffer.from(`{"events":[${events.join(',')}]}`));
    const result = await post(
      this.#url!,
      body,
      {
        authorization: `Bearer ${this.#key}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'user-agent': `apiloupe-node/${VERSION}`,
      },
      { timeoutMs, holdOpen },
    );

    if (result.ok && result.status === 202) {
      this.#pending = this.#pending.slice(count);
      let refused: number;
      try {
        refused = (JSON.parse(result.body) as IngestResult).rejected.length;
      } catch {
        refused = 0;
      }
      this.#stats.sent += count - refused;
      this.#stats.dropped += refused;
      this.#backoffMs = 0;
      this.#retryAt = 0;
      return true;
    }
    if (result.ok && !RETRY.has(result.status)) {
      // Refused for good (bad key, malformed): resending will not help.
      this.#pending = this.#pending.slice(count);
      this.#stats.dropped += count;
      this.#report(new Error(refusal(result.status, result.body)));
      return true;
    }
    this.#stats.failedAttempts += 1;
    this.#backoffMs = Math.min(Math.max(this.#backoffMs * 2, 1000), MAX_BACKOFF_MS);
    const wait = result.ok ? (result.retryAfterMs ?? this.#backoffMs) : this.#backoffMs;
    this.#retryAt = Date.now() + wait;
    this.#report(
      result.ok
        ? new Error(`apiloupe answered ${result.status}; retrying in ${Math.round(wait / 1000)} s`)
        : new Error(`could not reach apiloupe: ${result.error.message}`),
    );
    return false;
  }

  /** Items → JSON strings, one per event, skipping anything that cannot be mapped or serialised. */
  #serialize(items: Item[]): string[] {
    const out: string[] = [];
    for (const item of items) {
      try {
        let event: EventInput;
        if ('line' in item) {
          const mapped = mapLogLine(item.line, {
            ...(this.service ? { service: this.service } : {}),
            ...(this.captureBodies ? { includeBodies: true } : {}),
          });
          if (!mapped.ok) continue;
          event = mapped.event;
          if (event.type === 'request' && !item.stream.requests) continue;
          const level = normalizeLevel(event.level) ?? LEVEL.info;
          if (level < item.stream.minLevel) continue;
          const id = eventIdForLine(item.line);
          // By line hash: an import of the same logs at the same rate keeps the same lines.
          const kept = sample({ ...event, id }, id, this.#sampleRate);
          if (!kept) {
            this.#stats.sampledOut += 1;
            continue;
          }
          event = kept;
        } else {
          event = item.event;
          if (this.service && !event.service) event.service = this.service;
          if (event.attrs) event.attrs = redact(event.attrs) as Record<string, unknown>;
        }
        out.push(JSON.stringify(event));
      } catch {
        this.#stats.dropped += 1;
      }
    }
    return out;
  }

  #report(error: Error): void {
    this.#lastError = error.message;
    try {
      if (this.#onError === false) return;
      if (this.#onError) {
        this.#onError(error);
        return;
      }
      const now = Date.now();
      if (now - this.#lastWarnAt < WARN_EVERY_MS) return;
      this.#lastWarnAt = now;
      console.warn(
        `[apiloupe] ${error.message} (queued ${this.#backlog()}, dropped ${this.#stats.dropped})`,
      );
    } catch {
      // a broken onError must not break sending
    }
  }
}

function ingestUrl(endpoint: string | undefined): URL | null {
  if (!endpoint) return null;
  try {
    return new URL('/ingest/v1/events', endpoint);
  } catch {
    return null;
  }
}

function refusal(status: number, body: string): string {
  let detail: string;
  try {
    detail = (JSON.parse(body) as { error?: string }).error ?? '';
  } catch {
    detail = '';
  }
  const what = status === 401 ? 'refused the ingest key' : `refused a batch (${status})`;
  return `apiloupe ${what}${detail ? `: ${detail}` : ''}; those events were dropped`;
}

/** `{type, message, stack}` from anything thrown. */
export function describeError(error: unknown): { type?: string; message?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      type: error.name || 'Error',
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: Object.prototype.toString.call(error) };
  }
}
