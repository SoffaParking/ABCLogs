/**
 * How error events are grouped into issues. The server computes a grouping
 * key for every error and fatal log line; lines with the same key are one
 * issue. The dashboard uses the same stack parser to show which frames are
 * your code.
 *
 * With a stack trace: service, error type, and the top five frames of the
 * app's own code, without line and column numbers (a deploy that moves code
 * down a few lines must not split an issue) and with paths cut to their last
 * two segments (the same code deployed in another directory is the same code).
 *
 * Without one: service, error type and the message, with the parts that vary
 * from one occurrence to the next (numbers, ids, emails, addresses) masked.
 */

/** Bump when the rules change; `apiloupe-server reprocess-issues` regroups stored events. */
export const GROUPING_VERSION = 1;

const IN_APP_FRAMES = 5;
const MAX_TITLE = 300;

export interface StackFrame {
  /** The function, or null for top-level code. */
  fn: string | null;
  /** The file as written in the stack. */
  file: string;
  line: number | null;
  column: number | null;
  /** False for dependencies (node_modules) and the runtime itself. */
  inApp: boolean;
}

const FRAME = /^\s*at\s+(?:(.+?)\s+\((.+)\)|(.+))\s*$/;
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;

/** The frames of a V8 (Node.js, Chrome) stack trace, top first. Other lines are skipped. */
export function parseStack(stack: string | null | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n')) {
    const match = FRAME.exec(line);
    if (!match) continue;
    let fn = match[1] ?? null;
    let location = (match[2] ?? match[3] ?? '').trim();
    // `at eval (eval at f (file.js:1:2), <anonymous>:1:1)`: the caller is what matters.
    const evalAt = /^eval at .*?\((.+?)\)/.exec(location);
    if (evalAt) location = evalAt[1]!;
    const parts = LOCATION.exec(location);
    const file = parts ? parts[1]! : location;
    if (fn) {
      fn = fn
        .replace(/^async\s+/, '')
        .replace(/^new\s+/, '')
        .replace(/\s+\[as [^\]]+\]$/, '')
        .trim();
    }
    frames.push({
      fn: fn || null,
      file,
      line: parts ? Number(parts[2]) : null,
      column: parts?.[3] ? Number(parts[3]) : null,
      inApp: isInApp(file),
    });
  }
  return frames;
}

function isInApp(file: string): boolean {
  if (file === '' || file === 'native' || file === '<anonymous>') return false;
  if (file.startsWith('node:') || file.startsWith('internal/')) return false;
  return !/[\\/]node_modules[\\/]/.test(file);
}

/** `/srv/app/src/services/sessionService.js` → `services/sessionService.js`. */
export function shortPath(file: string): string {
  const clean = file
    .replace(/^file:\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/\\/g, '/')
    // Content hashes in bundled file names change every build.
    .replace(/[.-][0-9a-f]{6,}(?=\.[a-z]+$)/i, '');
  return clean.split('/').filter(Boolean).slice(-2).join('/');
}

/**
 * A message with what varies between occurrences masked, so that
 * `user 42 not found` and `user 97 not found` group together. Quoted text is
 * kept unless it holds digits: `reading 'plate'` names the bug, `'B12345'`
 * is data.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[^\s@'"]+@[^\s@'"]+\.[a-z]{2,}\b/gi, '<email>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/'[^'\n]*\d[^'\n]*'|"[^"\n]*\d[^"\n]*"/g, '<str>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{16,}\b/gi, '<token>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

export interface GroupingInput {
  service: string;
  message: string;
  errorType?: string | null | undefined;
  errorMessage?: string | null | undefined;
  errorStack?: string | null | undefined;
}

export interface Grouping {
  /** Equal keys mean the same issue. Readable, for showing why things were grouped. */
  key: string;
  title: string;
  /** Where it happens: the top frame of the app's code, when there is a stack. */
  culprit: string | null;
}

export function groupingFor(input: GroupingInput): Grouping {
  const type = input.errorType?.trim() || null;
  const text = (input.errorMessage?.trim() || input.message.trim() || '(no message)').split(
    '\n',
  )[0]!;
  const title = (type && !text.startsWith(type) ? `${type}: ${text}` : text).slice(0, MAX_TITLE);
  const frames = parseStack(input.errorStack);
  const inApp = frames.filter((f) => f.inApp);
  const chosen = (inApp.length > 0 ? inApp : frames).slice(0, IN_APP_FRAMES);
  const head = [`v${GROUPING_VERSION}`, `service: ${input.service}`, `type: ${type ?? ''}`];
  if (chosen.length > 0) {
    const where = chosen.map((f) => `at ${f.fn ?? '<top level>'} (${shortPath(f.file)})`);
    return { key: [...head, ...where].join('\n'), title, culprit: where[0]!.slice(3) };
  }
  return { key: [...head, `message: ${normalizeMessage(text)}`].join('\n'), title, culprit: null };
}
