#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { defaultCheckpointPath } from './checkpoint.js';
import { cloudWatchSource, runCloudWatchImport } from './cloudwatch.js';
import { readLines } from './lines.js';
import { ImportError, runImport, type ImportOptions, type ImportStats } from './run.js';
import { synthesizeLines } from './synthetic.js';
import { parseDuration, parseWhen, shortTime } from './time.js';

const USAGE = `Usage: apiloupe-import [options] [file ...]
       apiloupe-import --cloudwatch --log-group <name> [options]

Sends JSON log lines (pino, pino-http, bunyan and most JSON loggers) to an
apiloupe server: from the files given (gzipped or not), standard input, or
AWS CloudWatch Logs. Importing the same lines twice stores them once.

Options:
  --endpoint <url>    apiloupe server (env APILOUPE_ENDPOINT, default http://localhost:8080)
  --key <key>         the project's ingest key (env APILOUPE_KEY)
  --service <name>    service name for lines that do not carry one
  --include-bodies    keep request bodies, query strings, headers and IPs (redacted)
  --plain-text        import lines that are not JSON as info logs
  --batch-size <n>    events per request, 1 to 1000 (default 500)
  --sample-rate <r>   keep this share (0 to 1) of successful requests and logs below warn
  --dry-run           read and count only; send nothing
  --demo [minutes]    send synthetic demo traffic for the last N minutes (default 120)
  -q, --quiet         no progress output
  -h, --help

CloudWatch Logs (uses the same credentials as the aws CLI):
  --cloudwatch            read from CloudWatch Logs instead of files
  --log-group <name>      the log group, e.g. /ecs/my-api
  --stream-prefix <p>     only streams whose names start with this
  --filter-pattern <p>    a CloudWatch filter pattern, e.g. '{ $.level >= 50 }'
  --since <when>          where to start without a checkpoint: 14d, 6h, 30m, or a time (default 1h)
  --until <when>          where to stop (default now)
  --follow                keep importing new logs as they arrive (Ctrl-C to stop)
  --poll <duration>       how often --follow looks for new logs (default 30s)
  --region <region>       AWS region (default: AWS_REGION or your profile's)
  --profile <name>        AWS profile (default: AWS_PROFILE or default)
  --checkpoint <file>     where progress is saved (default: named after the log group)
  --restart               ignore the checkpoint and start from --since
  --aws-endpoint <url>    a different CloudWatch Logs endpoint (VPC endpoint, LocalStack)

  The checkpoint moves forward only after a whole hour of logs has been
  accepted by apiloupe, so an interrupted import resumes where it stopped.
  The credentials need logs:FilterLogEvents on the log group.

Examples:
  apiloupe-import --key alk_... app.log app.log.1.gz
  kubectl logs deploy/api | apiloupe-import --key alk_...
  apiloupe-import --key alk_... --cloudwatch --log-group /ecs/my-api --stream-prefix api --since 14d`;

function exit(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: 'string' },
      key: { type: 'string' },
      service: { type: 'string' },
      'include-bodies': { type: 'boolean' },
      'plain-text': { type: 'boolean' },
      'batch-size': { type: 'string' },
      'sample-rate': { type: 'string' },
      'dry-run': { type: 'boolean' },
      demo: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
      cloudwatch: { type: 'boolean' },
      'log-group': { type: 'string' },
      'stream-prefix': { type: 'string' },
      'filter-pattern': { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      follow: { type: 'boolean' },
      poll: { type: 'string' },
      region: { type: 'string' },
      profile: { type: 'string' },
      checkpoint: { type: 'string' },
      restart: { type: 'boolean' },
      'aws-endpoint': { type: 'string' },
    },
  });
} catch (err) {
  exit(`${(err as Error).message}\n\n${USAGE}`, 2);
}
const { values, positionals } = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const batchSize = values['batch-size'] === undefined ? 500 : Number(values['batch-size']);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
  exit('--batch-size must be 1 to 1000', 2);
}

const sampleRate = values['sample-rate'] === undefined ? undefined : Number(values['sample-rate']);
if (sampleRate !== undefined && !(sampleRate > 0 && sampleRate <= 1)) {
  exit('--sample-rate must be above 0 and at most 1', 2);
}

const quiet = values.quiet ?? false;
const dryRun = values['dry-run'] ?? false;
const progress = (stats: ImportStats) => {
  if (!quiet && process.stderr.isTTY) {
    process.stderr.write(
      `\r${stats.lines} lines, ${stats.events} events, ${stats.accepted} stored`,
    );
  }
};
const options: ImportOptions = {
  endpoint: values.endpoint ?? process.env.APILOUPE_ENDPOINT ?? 'http://localhost:8080',
  key: values.key ?? process.env.APILOUPE_KEY,
  ...(values.service ? { service: values.service } : {}),
  includeBodies: values['include-bodies'] ?? false,
  plainText: values['plain-text'] ?? false,
  batchSize,
  dryRun,
  ...(sampleRate !== undefined ? { sampleRate } : {}),
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function report(stats: ImportStats): void {
  const skipped = stats.skipped;
  const lines = [
    `${plural(stats.lines, 'line')} read, ${plural(stats.events, 'event')}`,
    dryRun
      ? 'dry run: nothing sent'
      : `${stats.accepted} stored, ${stats.duplicates} already there, ${stats.rejected} refused`,
  ];
  if (skipped.notJson > 0) {
    lines.push(`${plural(skipped.notJson, 'line')} not JSON, skipped (--plain-text imports them)`);
  }
  if (skipped.noTime > 0)
    lines.push(`${plural(skipped.noTime, 'JSON line')} without a timestamp, skipped`);
  if (stats.sampledOut > 0)
    lines.push(`${plural(stats.sampledOut, 'event')} left out by --sample-rate`);
  for (const r of stats.rejections) lines.push(`  line ${r.line}: ${r.reason}`);
  if (stats.rejected > stats.rejections.length) {
    lines.push(`  … and ${stats.rejected - stats.rejections.length} more refused`);
  }
  console.log(lines.join('\n'));
}

async function* inputs(): AsyncGenerator<string> {
  if (values.demo) {
    const minutes = positionals[0] === undefined ? 120 : Number(positionals[0]);
    if (!Number.isInteger(minutes) || minutes < 1) exit('--demo takes a number of minutes', 2);
    yield* synthesizeLines({ minutes, seed: Date.now() });
    return;
  }
  if (positionals.length === 0 || (positionals.length === 1 && positionals[0] === '-')) {
    if (process.stdin.isTTY) exit(`no input: give files or pipe logs in\n\n${USAGE}`, 2);
    yield* readLines(process.stdin);
    return;
  }
  for (const file of positionals) yield* readLines(file === '-' ? process.stdin : file);
}

async function cloudwatch(): Promise<ImportStats> {
  const logGroup = values['log-group'] ?? exit('--cloudwatch needs --log-group', 2);
  if (positionals.length > 0) exit('--cloudwatch reads from AWS; it takes no files', 2);
  let since: number;
  let until: number | undefined;
  let pollMs: number | undefined;
  try {
    since = parseWhen(values.since ?? '1h');
    until = values.until === undefined ? undefined : parseWhen(values.until);
    pollMs = values.poll === undefined ? undefined : parseDuration(values.poll, '--poll');
  } catch (err) {
    exit((err as Error).message, 2);
  }
  if (values.follow && values.until) exit('--follow and --until do not go together', 2);
  const source = {
    logGroup,
    streamPrefix: values['stream-prefix'] ?? null,
    filterPattern: values['filter-pattern'] ?? null,
  };
  const reader = await cloudWatchSource({
    logGroup,
    streamPrefix: values['stream-prefix'],
    filterPattern: values['filter-pattern'],
    region: values.region,
    profile: values.profile,
    awsEndpoint: values['aws-endpoint'],
  });
  const controller = new AbortController();
  const stop = () => {
    if (!quiet)
      console.error('\nstopping after the current window; the checkpoint keeps your place');
    controller.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const checkpointFile = values.checkpoint ?? defaultCheckpointPath(source);
  const result = await runCloudWatchImport(reader, {
    ...options,
    source,
    since,
    until,
    follow: values.follow ?? false,
    ...(pollMs !== undefined ? { pollMs } : {}),
    checkpointFile,
    restart: values.restart ?? false,
    signal: controller.signal,
    onResume: (position, file) => {
      if (!quiet) console.error(`resuming from ${shortTime(position)} UTC (${file})`);
    },
    onWindow: (w) => {
      if (quiet) return;
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      const sent = dryRun ? '' : `, ${w.accepted} stored, ${w.duplicates} already there`;
      console.error(
        `${shortTime(w.start)} → ${shortTime(w.end).slice(11)} UTC: ${plural(w.lines, 'line')}${sent}`,
      );
    },
  });
  if (!quiet && !dryRun)
    console.error(`checkpoint: ${shortTime(result.position)} UTC in ${checkpointFile}`);
  return result;
}

try {
  const stats = values.cloudwatch
    ? await cloudwatch()
    : await runImport(inputs(), { ...options, onProgress: progress });
  if (!quiet && process.stderr.isTTY && !values.cloudwatch) process.stderr.write('\n');
  report(stats);
} catch (err) {
  if (err instanceof ImportError) exit(`apiloupe-import: ${err.message}`, 1);
  throw err;
}
