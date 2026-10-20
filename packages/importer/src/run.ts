import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import { mapLogLine, unwrapLine, type EventInput, type IngestResult } from '@apiloupe/shared';
import { eventIdForLine } from '@apiloupe/shared/node';

const gzip = promisify(gzipCb);

export interface ImportOptions {
  /** The apiloupe server, e.g. `http://localhost:8080`. */
  endpoint: string;
  /** The project's ingest key. Not needed for a dry run. */
  key?: string | undefined;
  /** The service for lines that do not name one. */
  service?: string | undefined;
  /** Keep request bodies, query strings, headers and IPs (redacted). */
  includeBodies?: boolean;
  /** Import lines that are not JSON as info logs. */
  plainText?: boolean;
  /** Events per request, at most 1000. */
  batchSize?: number;
  /** Parse and count, send nothing. */
  dryRun?: boolean;
  /** Called after every batch. */
  onProgress?: (stats: ImportStats) => void;
  /** Base delay of the retry backoff. */
  retryBaseMs?: number;
  maxAttempts?: number;
  userAgent?: string;
}

/** A line to import, with the time its source recorded it, when known. */
export interface SourceLine {
  line: string;
  /**
   * Epoch ms, used for lines that carry no time of their own (plain text, or
   * JSON without a time field), so their time and id do not depend on when
   * the import ran.
   */
  time?: number;
}

export interface ImportStats {
  lines: number;
  /** Lines that became events. */
  events: number;
  skipped: { blank: number; notJson: number; noTime: number };
  batches: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  /** The first rejections, by input line number. */
  rejections: { line: number; reason: string }[];
}

/** A failure that retrying will not fix (bad key, bad request, unreachable after retries). */
export class ImportError extends Error {}

const MAX_REPORTED_REJECTIONS = 20;

export function emptyStats(): ImportStats {
  return {
    lines: 0,
    events: 0,
    skipped: { blank: 0, notJson: 0, noTime: 0 },
    batches: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    rejections: [],
  };
}

/**
 * Turns lines into events and sends them in gzip batches, retrying on rate
 * limits and outages. `flush()` resolves once everything added so far has
 * been accepted by the server, which is when a caller may record progress.
 */
export class Sender {
  readonly stats: ImportStats = emptyStats();
  private batch: EventInput[] = [];
  private lineNumbers: number[] = [];
  private readonly endpoint: string;
  private readonly batchSize: number;

  constructor(private readonly options: ImportOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 1000);
  }

  /** Checks the key with the server; throws ImportError when it is refused. */
  async check(): Promise<void> {
    if (this.options.dryRun) return;
    if (!this.options.key)
      throw new ImportError('an ingest key is required (--key or APILOUPE_KEY)');
    const res = await request(`${this.endpoint}/ingest/v1/check`, { method: 'GET' }, this.options);
    if (res.status === 401) throw new ImportError('the server refused the ingest key');
    if (!res.ok) throw new ImportError(`key check failed: HTTP ${res.status} ${await res.text()}`);
  }

  async add(input: string | SourceLine): Promise<void> {
    const { line, time } = typeof input === 'string' ? { line: input, time: undefined } : input;
    this.stats.lines += 1;
    // The id is the hash of the app's own line, so it matches the same line shipped live.
    const own = unwrapLine(line);
    // Lines without a time of their own take the source's, else (plain text
    // only) the import's.
    const fallbackTime = time ?? (this.options.plainText ? Date.now() : undefined);
    const mapped = mapLogLine(own, {
      ...(this.options.service ? { service: this.options.service } : {}),
      ...(this.options.includeBodies ? { includeBodies: true } : {}),
      ...(this.options.plainText ? { plainText: true } : {}),
      ...(fallbackTime !== undefined ? { fallbackTime } : {}),
    });
    if (!mapped.ok) {
      if (mapped.reason === 'blank') this.stats.skipped.blank += 1;
      else if (mapped.reason === 'not-json') this.stats.skipped.notJson += 1;
      else this.stats.skipped.noTime += 1;
      return;
    }
    this.stats.events += 1;
    this.batch.push({ ...mapped.event, id: eventIdForLine(own) });
    this.lineNumbers.push(this.stats.lines);
    if (this.batch.length >= this.batchSize) await this.send();
  }

  async flush(): Promise<void> {
    if (this.batch.length > 0) await this.send();
  }

  private async send(): Promise<void> {
    const events = this.batch;
    const lineNumbers = this.lineNumbers;
    this.batch = [];
    this.lineNumbers = [];
    if (!this.options.dryRun) {
      const body = await gzip(JSON.stringify({ events }));
      const res = await request(
        `${this.endpoint}/ingest/v1/events`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
          body,
        },
        this.options,
      );
      if (res.status !== 202) {
        throw new ImportError(`the server refused a batch: HTTP ${res.status} ${await res.text()}`);
      }
      const result = (await res.json()) as IngestResult;
      this.stats.accepted += result.accepted;
      this.stats.duplicates += result.duplicates;
      this.stats.rejected += result.rejected.length;
      for (const r of result.rejected) {
        if (this.stats.rejections.length >= MAX_REPORTED_REJECTIONS) break;
        this.stats.rejections.push({ line: lineNumbers[r.index] ?? -1, reason: r.reason });
      }
    }
    this.stats.batches += 1;
    this.options.onProgress?.(this.stats);
  }
}

/**
 * Reads log lines, maps each to an event (with an id derived from the line,
 * so importing the same file twice stores nothing new), and sends them.
 */
export async function runImport(
  lines: AsyncIterable<string | SourceLine> | Iterable<string | SourceLine>,
  options: ImportOptions,
): Promise<ImportStats> {
  const sender = new Sender(options);
  await sender.check();
  for await (const line of lines) await sender.add(line);
  await sender.flush();
  return sender.stats;
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** fetch with the key attached, retrying network errors and transient statuses. */
async function request(url: string, init: RequestInit, options: ImportOptions): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 8;
  const base = options.retryBaseMs ?? 500;
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    authorization: `Bearer ${options.key ?? ''}`,
    'user-agent': options.userAgent ?? 'apiloupe-import',
  };
  for (let attempt = 1; ; attempt++) {
    let wait: number;
    try {
      const res = await fetch(url, { ...init, headers });
      if (!RETRY_STATUSES.has(res.status) || attempt >= maxAttempts) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      wait =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(base, attempt);
      await res.body?.cancel();
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new ImportError(`could not reach ${url}: ${(err as Error).message}`);
      }
      wait = backoff(base, attempt);
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function backoff(base: number, attempt: number): number {
  return Math.min(30_000, base * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
}
