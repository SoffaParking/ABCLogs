import type { ErrorInput, EventInput } from './events.js';
import { levelForStatus, normalizeLevel } from './levels.js';
import { redact } from './redact.js';
import { pathOnly } from './routes.js';

/**
 * Maps one line of a JSON log (pino, pino-http, bunyan and most JSON loggers)
 * onto an apiloupe event. Shared by the importer and the SDK's pino
 * destination, so a line shipped live and the same line imported later become
 * the same event.
 *
 * A line is a **request** when it carries a method, a path or URL and a status
 * code, flat (`method`, `path`, `status`, `durationMs`) or pino-http style
 * (`req.method`, `req.url`, `res.statusCode`, `responseTime`). Anything else
 * is a **log** line.
 */

export interface MapOptions {
  /** The service for lines that do not name one. */
  service?: string;
  /**
   * Keep request bodies, query strings, headers and client IPs (still
   * redacted). Off by default: they are where personal data lives.
   */
  includeBodies?: boolean;
  /** Import lines that are not JSON as info-level logs. */
  plainText?: boolean;
  /** The time given to lines without one. Without it such lines are skipped. */
  fallbackTime?: number;
}

export type MapResult =
  { ok: true; event: EventInput } | { ok: false; reason: 'blank' | 'not-json' | 'no-time' };

const TIME_KEYS = ['time', 'timestamp', '@timestamp', 'ts'];
const LEVEL_KEYS = ['level', 'severity', 'lvl'];
const MESSAGE_KEYS = ['msg', 'message'];
const SERVICE_KEYS = ['service', 'name', 'app'];
const REQUEST_ID_KEYS = ['requestId', 'reqId', 'req_id', 'request_id', 'correlationId'];
const METHOD_KEYS = ['method'];
const PATH_KEYS = ['path', 'url', 'originalUrl'];
const STATUS_KEYS = ['status', 'statusCode'];
const DURATION_KEYS = ['durationMs', 'duration_ms', 'responseTime', 'response_time'];
const ROUTE_KEYS = ['route'];
const ERROR_KEYS = ['err', 'error'];

/** Logger bookkeeping that says nothing about the event. */
const NOISE_KEYS = ['pid', 'hostname', 'v'];

/** Where personal data lives; dropped unless `includeBodies` is set. */
const PRIVATE_KEYS = [
  'body',
  'query',
  'headers',
  'cookies',
  'ip',
  'ips',
  'remoteAddress',
  'remotePort',
  'req',
  'res',
];

const HTTP_METHOD = /^[A-Z]{3,10}$/;

export function mapLogLine(line: string, options: MapOptions = {}): MapResult {
  const text = line.trim();
  if (text === '') return { ok: false, reason: 'blank' };

  let parsed: unknown;
  try {
    parsed = text.startsWith('{') ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    if (!options.plainText) return { ok: false, reason: 'not-json' };
    if (options.fallbackTime === undefined) return { ok: false, reason: 'no-time' };
    return {
      ok: true,
      event: {
        type: 'log',
        time: options.fallbackTime,
        level: 30,
        message: text,
        ...(options.service ? { service: options.service } : {}),
      },
    };
  }

  const rest: Record<string, unknown> = { ...parsed };
  const find = (keys: readonly string[]): string | undefined =>
    keys.find((key) => rest[key] !== undefined && rest[key] !== null);
  const peek = (keys: readonly string[]): unknown => {
    const key = find(keys);
    return key === undefined ? undefined : rest[key];
  };
  const take = (keys: readonly string[]): unknown => {
    const key = find(keys);
    if (key === undefined) return undefined;
    const value = rest[key];
    delete rest[key];
    return value;
  };

  const time = parseTime(take(TIME_KEYS)) ?? options.fallbackTime;
  if (time === undefined) return { ok: false, reason: 'no-time' };

  const rawLevel = take(LEVEL_KEYS);
  const service = asString(take(SERVICE_KEYS)) ?? options.service;
  const req = isRecord(parsed.req) ? parsed.req : undefined;
  const res = isRecord(parsed.res) ? parsed.res : undefined;
  const requestId = asId(take(REQUEST_ID_KEYS)) ?? asId(req?.id);
  for (const key of NOISE_KEYS) delete rest[key];

  // Only peeked: an error line can carry a path and status without being the
  // request itself, and then they stay in its attrs.
  const method = asString(peek(METHOD_KEYS)) ?? asString(req?.method);
  const url = asString(peek(PATH_KEYS)) ?? asString(req?.url) ?? asString(req?.originalUrl);
  const status = asStatus(peek(STATUS_KEYS)) ?? asStatus(res?.statusCode);
  const common = {
    time,
    ...(service ? { service } : {}),
    ...(requestId ? { requestId } : {}),
  };

  if (method && HTTP_METHOD.test(method.toUpperCase()) && url && status !== undefined) {
    take(METHOD_KEYS);
    take(PATH_KEYS);
    take(STATUS_KEYS);
    const durationMs = asNumber(take(DURATION_KEYS));
    const route = asString(take(ROUTE_KEYS));
    const level = normalizeLevel(rawLevel) ?? levelForStatus(status);
    // A request line's own message ("request", "request completed") says nothing.
    take(MESSAGE_KEYS);
    const attrs = finishAttrs(rest, options);
    return {
      ok: true,
      event: {
        type: 'request',
        ...common,
        level,
        method: method.toUpperCase(),
        path: pathOnly(url),
        status,
        ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
        ...(route ? { route } : {}),
        ...(attrs ? { attrs } : {}),
      },
    };
  }

  const error = takeError(take(ERROR_KEYS), take(['stack']));
  let message = asString(take(MESSAGE_KEYS)) ?? '';
  if (message === '' && error?.message) message = error.message;
  const attrs = finishAttrs(rest, options);
  return {
    ok: true,
    event: {
      type: 'log',
      ...common,
      level: normalizeLevel(rawLevel) ?? 30,
      message,
      ...(error ? { error } : {}),
      ...(attrs ? { attrs } : {}),
    },
  };
}

/** Epoch milliseconds from an ISO string, epoch seconds or epoch milliseconds. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 1e11 seconds is the year 5138; 1e11 milliseconds is 1973.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseTime(Number(trimmed));
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function takeError(err: unknown, stack: unknown): ErrorInput | undefined {
  const out: ErrorInput = {};
  if (isRecord(err)) {
    const type = asString(err.type) ?? asString(err.name) ?? asString(err.code);
    if (type) out.type = type;
    const message = asString(err.message);
    if (message) out.message = message;
    const errStack = asString(err.stack);
    if (errStack) out.stack = errStack;
  } else if (typeof err === 'string' && err !== '') {
    out.message = err;
  }
  if (!out.stack && typeof stack === 'string' && stack !== '') out.stack = stack;
  if (!out.type && out.stack) {
    const head = /^\s*((?:[A-Za-z_$][\w$.]*)?(?:Error|Exception))\b/.exec(out.stack);
    if (head) out.type = head[1];
  }
  return out.type || out.message || out.stack ? out : undefined;
}

function finishAttrs(
  rest: Record<string, unknown>,
  options: MapOptions,
): Record<string, unknown> | undefined {
  if (!options.includeBodies) for (const key of PRIVATE_KEYS) delete rest[key];
  if (Object.keys(rest).length === 0) return undefined;
  return redact(rest) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return asString(value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

function asStatus(value: unknown): number | undefined {
  const n = asNumber(value);
  return n !== undefined && Number.isInteger(n) && n >= 100 && n <= 599 ? n : undefined;
}
