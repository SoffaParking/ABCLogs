import {
  defaultCheckpointPath,
  readCheckpoint,
  sameSource,
  writeCheckpoint,
  type CheckpointSource,
} from './checkpoint.js';
import { ImportError, Sender, type ImportOptions, type ImportStats } from './run.js';

/** One page of `FilterLogEvents`. */
export interface LogPage {
  events: { timestamp: number; message: string }[];
  nextToken?: string | undefined;
}

/** Reads a log group, one page at a time, for a time window `[start, end)`. */
export interface LogSource {
  fetchPage(window: { start: number; end: number }, nextToken?: string): Promise<LogPage>;
}

export interface CloudWatchOptions {
  logGroup: string;
  streamPrefix?: string | undefined;
  filterPattern?: string | undefined;
  region?: string | undefined;
  profile?: string | undefined;
  /** A different CloudWatch Logs endpoint (tests, VPC endpoints, LocalStack). */
  awsEndpoint?: string | undefined;
}

export interface CloudWatchImportOptions extends ImportOptions {
  source: CheckpointSource;
  /** Where to start when there is no checkpoint, epoch ms. */
  since: number;
  /** Where to stop (without `follow`), epoch ms. Default: now. */
  until?: number | undefined;
  /** Keep importing new logs as they arrive, until stopped. */
  follow?: boolean;
  /** How often `follow` looks for new logs. Default 30 s. */
  pollMs?: number;
  /**
   * How far behind now to stay. CloudWatch makes events searchable a little
   * after their timestamp; reading too close to now would miss some. Default 2 min.
   */
  lagMs?: number;
  /** How far back each resumed or repeated read starts, to catch late arrivals. Default 5 min. */
  overlapMs?: number;
  /** Window size: the checkpoint advances once per window. Default 1 h. */
  windowMs?: number;
  /** The checkpoint file; null for none. Default: named after the log group. */
  checkpointFile?: string | null;
  /** Ignore an existing checkpoint and start from `since`. */
  restart?: boolean;
  signal?: AbortSignal;
  onWindow?: (window: WindowReport) => void;
  onResume?: (position: number, file: string) => void;
}

export interface WindowReport {
  start: number;
  end: number;
  lines: number;
  accepted: number;
  duplicates: number;
}

const HOUR = 3_600_000;

/**
 * Imports CloudWatch Logs window by window. After each window is fully
 * accepted by apiloupe the checkpoint moves to the window's end, so an
 * interrupted import resumes where it stopped and loses nothing. Windows are
 * read again a little before the checkpoint, which costs nothing: events
 * apiloupe already has come back as duplicates.
 */
export async function runCloudWatchImport(
  source: LogSource,
  options: CloudWatchImportOptions,
): Promise<ImportStats & { position: number }> {
  const sender = new Sender(options);
  await sender.check();
  const windowMs = options.windowMs ?? HOUR;
  const overlap = options.overlapMs ?? 5 * 60_000;
  const lag = options.lagMs ?? 2 * 60_000;
  const file =
    options.checkpointFile === null || options.dryRun
      ? null
      : (options.checkpointFile ?? defaultCheckpointPath(options.source));

  let position = options.since;
  let readFrom = options.since;
  const saved = file && !options.restart ? readCheckpoint(file) : null;
  if (saved) {
    if (!sameSource(saved.source, options.source)) {
      throw new ImportError(
        `${file} is the checkpoint of another import (${describe(saved.source)}); ` +
          'pass --checkpoint with another file, or --restart',
      );
    }
    position = Date.parse(saved.position);
    readFrom = position - overlap;
    options.onResume?.(position, file!);
  }

  for (;;) {
    const end = options.follow ? Date.now() - lag : (options.until ?? Date.now());
    while (readFrom < end) {
      if (options.signal?.aborted) return { ...sender.stats, position };
      const windowEnd = Math.min(readFrom + windowMs, end);
      const before = { ...sender.stats };
      const complete = await readWindow(source, sender, readFrom, windowEnd, options.signal);
      await sender.flush();
      if (!complete) return { ...sender.stats, position };
      if (windowEnd > position) {
        position = windowEnd;
        if (file) writeCheckpoint(file, options.source, position);
      }
      options.onWindow?.({
        start: readFrom,
        end: windowEnd,
        lines: sender.stats.lines - before.lines,
        accepted: sender.stats.accepted - before.accepted,
        duplicates: sender.stats.duplicates - before.duplicates,
      });
      readFrom = windowEnd;
    }
    if (!options.follow) return { ...sender.stats, position };
    if (!(await sleep(options.pollMs ?? 30_000, options.signal)))
      return { ...sender.stats, position };
    readFrom = Math.max(position - overlap, options.since);
  }
}

/** Reads every page of one window into the sender. False when stopped part way. */
async function readWindow(
  source: LogSource,
  sender: Sender,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let token: string | undefined;
  do {
    if (signal?.aborted) return false;
    const page = await source.fetchPage({ start, end }, token);
    for (const event of page.events)
      await sender.add({ line: event.message, time: event.timestamp });
    // A token that does not change would loop forever.
    token = page.nextToken && page.nextToken !== token ? page.nextToken : undefined;
  } while (token);
  return true;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve(true);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function describe(source: CheckpointSource): string {
  return [
    source.logGroup,
    source.streamPrefix ? `streams ${source.streamPrefix}*` : null,
    source.filterPattern ? `filter ${source.filterPattern}` : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** CloudWatch Logs through the AWS SDK, with its usual credentials (environment, profiles, SSO, roles). */
export async function cloudWatchSource(options: CloudWatchOptions): Promise<LogSource> {
  const { CloudWatchLogsClient, FilterLogEventsCommand } =
    await import('@aws-sdk/client-cloudwatch-logs');
  const client = new CloudWatchLogsClient({
    ...(options.region ? { region: options.region } : {}),
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.awsEndpoint ? { endpoint: options.awsEndpoint } : {}),
    // FilterLogEvents allows a few calls a second per account; back off and retry when throttled.
    maxAttempts: 10,
    retryMode: 'adaptive',
  });
  return {
    async fetchPage(window, nextToken) {
      try {
        const out = await client.send(
          new FilterLogEventsCommand({
            logGroupName: options.logGroup,
            ...(options.streamPrefix ? { logStreamNamePrefix: options.streamPrefix } : {}),
            ...(options.filterPattern ? { filterPattern: options.filterPattern } : {}),
            startTime: window.start,
            // endTime is inclusive; windows are half-open.
            endTime: window.end - 1,
            ...(nextToken ? { nextToken } : {}),
            limit: 10_000,
          }),
        );
        return {
          events: (out.events ?? []).flatMap((e) =>
            typeof e.message === 'string'
              ? [{ timestamp: e.timestamp ?? window.start, message: e.message }]
              : [],
          ),
          nextToken: out.nextToken,
        };
      } catch (err) {
        throw explainAwsError(err, options);
      }
    },
  };
}

/** AWS errors, said in terms of what to do about them. */
export function explainAwsError(err: unknown, options: CloudWatchOptions): Error {
  const e = err as { name?: string; message?: string };
  const name = e.name ?? '';
  const message = e.message ?? String(err);
  if (name === 'CredentialsProviderError' || /credential/i.test(message)) {
    return new ImportError(
      `no usable AWS credentials (${message}). Use the same setup as the aws CLI: ` +
        'AWS_PROFILE or --profile, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or an instance role',
    );
  }
  if (/region is missing/i.test(message)) {
    return new ImportError('no AWS region: pass --region or set AWS_REGION');
  }
  if (name === 'ResourceNotFoundException') {
    return new ImportError(
      `no log group ${options.logGroup}${options.region ? ` in ${options.region}` : ''}`,
    );
  }
  if (name === 'AccessDeniedException' || name === 'UnrecognizedClientException') {
    return new ImportError(
      `AWS refused the request (${message}); the credentials need logs:FilterLogEvents on ${options.logGroup}`,
    );
  }
  return err instanceof Error ? err : new Error(message);
}
