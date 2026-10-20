#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readLines } from './lines.js';
import { ImportError, runImport, type ImportStats } from './run.js';
import { synthesizeLines } from './synthetic.js';

const USAGE = `Usage: apiloupe-import [options] [file ...]

Sends JSON log lines (pino, pino-http, bunyan and most JSON loggers) to an
apiloupe server. Reads the files given (gzipped or not), or standard input.
Importing the same lines twice stores them once.

Options:
  --endpoint <url>    apiloupe server (env APILOUPE_ENDPOINT, default http://localhost:8080)
  --key <key>         the project's ingest key (env APILOUPE_KEY)
  --service <name>    service name for lines that do not carry one
  --include-bodies    keep request bodies, query strings, headers and IPs (redacted)
  --plain-text        import lines that are not JSON as info logs, timestamped now
  --batch-size <n>    events per request, 1 to 1000 (default 500)
  --dry-run           parse and count only; send nothing
  --demo [minutes]    send synthetic demo traffic for the last N minutes (default 120)
  -q, --quiet         no progress output
  -h, --help

Examples:
  apiloupe-import --key alk_... app.log app.log.1.gz
  kubectl logs deploy/api | apiloupe-import --key alk_...
  aws logs filter-log-events --log-group-name /ecs/api --start-time 1760000000000 \\
    --output json | jq -r '.events[].message' | apiloupe-import --key alk_...`;

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
      'dry-run': { type: 'boolean' },
      demo: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const quiet = values.quiet ?? false;
const progress = (stats: ImportStats) => {
  if (!quiet && process.stderr.isTTY) {
    process.stderr.write(
      `\r${stats.lines} lines, ${stats.events} events, ${stats.accepted} stored`,
    );
  }
};

try {
  const stats = await runImport(inputs(), {
    endpoint: values.endpoint ?? process.env.APILOUPE_ENDPOINT ?? 'http://localhost:8080',
    key: values.key ?? process.env.APILOUPE_KEY,
    ...(values.service ? { service: values.service } : {}),
    includeBodies: values['include-bodies'] ?? false,
    plainText: values['plain-text'] ?? false,
    batchSize,
    dryRun: values['dry-run'] ?? false,
    onProgress: progress,
  });
  if (!quiet && process.stderr.isTTY) process.stderr.write('\n');
  const skipped = stats.skipped;
  const report = [
    `${plural(stats.lines, 'line')} read, ${plural(stats.events, 'event')}`,
    values['dry-run']
      ? 'dry run: nothing sent'
      : `${stats.accepted} stored, ${stats.duplicates} already there, ${stats.rejected} refused`,
  ];
  if (skipped.notJson > 0) {
    report.push(`${plural(skipped.notJson, 'line')} not JSON, skipped (--plain-text imports them)`);
  }
  if (skipped.noTime > 0)
    report.push(`${plural(skipped.noTime, 'JSON line')} without a timestamp, skipped`);
  for (const r of stats.rejections) report.push(`  line ${r.line}: ${r.reason}`);
  if (stats.rejected > stats.rejections.length) {
    report.push(`  … and ${stats.rejected - stats.rejections.length} more refused`);
  }
  console.log(report.join('\n'));
} catch (err) {
  if (err instanceof ImportError) exit(`apiloupe-import: ${err.message}`, 1);
  throw err;
}
