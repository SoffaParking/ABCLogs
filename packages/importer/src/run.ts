import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import { mapLogLine, type EventInput, type IngestResult } from '@apiloupe/shared';
import { eventIdForLine } from '@apiloupe/shared/node';

const gzip = promisify(gzipCb);

export interface ImportOptions {
  /** The apiloupe server, e.g. `http://localhost:8080`. */
  endpoint: string;
  /** The project's ingest key. Not needed for a dry run. */
  key?: string;
  /** The service for lines that do not name one. */
  service?: string;
  /** Keep request bodies, query strings, headers and IPs (redacted). */
  includeBodies?: boolean;
  /** Import lines that are not JSON as info logs, timestamped now. */
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

/** A failure that retrying will not fix (bad key, bad request). */
export class ImportError extends Error {}

const MAX_REPORTED_REJECTIONS = 20;

/**
 * Reads log lines, maps each to an event (with an id derived from the line,
 * so importing the same file twice stores nothing new), and sends them in
 * gzip-compressed batches, retrying on rate limits and outages.
 */
export async function runImport(
  lines: AsyncIterable<string> | Iterable<string>,
  options: ImportOptions,
): Promise<ImportStats> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 500, 1), 1000);
  const stats: ImportStats = {
    lines: 0,
    events: 0,
    skipped: { blank: 0, notJson: 0, noTime: 0 },
    batches: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    rejections: [],
  };
  const endpoint = options.endpoint.replace(/\/+$/, '');
  if (!options.dryRun) await checkKey(endpoint, options);

  let batch: EventInput[] = [];
  let lineNumbers: number[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    if (!options.dryRun) {
      const result = await send(endpoint, batch, options);
      stats.accepted += result.accepted;
      stats.duplicates += result.duplicates;
      stats.rejected += result.rejected.length;
      for (const r of result.rejected) {
        if (stats.rejections.length >= MAX_REPORTED_REJECTIONS) break;
        stats.rejections.push({ line: lineNumbers[r.index] ?? -1, reason: r.reason });
      }
    }
    stats.batches += 1;
    batch = [];
    lineNumbers = [];
    options.onProgress?.(stats);
  };

  for await (const line of lines) {
    stats.lines += 1;
    const mapped = mapLogLine(line, {
      ...(options.service ? { service: options.service } : {}),
      ...(options.includeBodies ? { includeBodies: true } : {}),
      ...(options.plainText ? { plainText: true, fallbackTime: Date.now() } : {}),
    });
    if (!mapped.ok) {
      if (mapped.reason === 'blank') stats.skipped.blank += 1;
      else if (mapped.reason === 'not-json') stats.skipped.notJson += 1;
      else stats.skipped.noTime += 1;
      continue;
    }
    stats.events += 1;
    batch.push({ ...mapped.event, id: eventIdForLine(line) });
    lineNumbers.push(stats.lines);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return stats;
}

async function checkKey(endpoint: string, options: ImportOptions): Promise<void> {
  if (!options.key) throw new ImportError('an ingest key is required (--key or APILOUPE_KEY)');
  const res = await request(`${endpoint}/ingest/v1/check`, { method: 'GET' }, options);
  if (res.status === 401) throw new ImportError('the server refused the ingest key');
  if (!res.ok) throw new ImportError(`key check failed: HTTP ${res.status} ${await res.text()}`);
}

async function send(
  endpoint: string,
  events: EventInput[],
  options: ImportOptions,
): Promise<IngestResult> {
  const body = await gzip(JSON.stringify({ events }));
  const res = await request(
    `${endpoint}/ingest/v1/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body,
    },
    options,
  );
  if (res.status !== 202) {
    throw new ImportError(`the server refused a batch: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as IngestResult;
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
