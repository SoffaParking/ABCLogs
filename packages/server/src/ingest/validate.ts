import { createHash } from 'node:crypto';
import {
  levelForStatus,
  LIMITS,
  normalizeLevel,
  parseTime,
  pathOnly,
  redact,
  redactString,
  routeFromPath,
  sampleWeight,
} from '@apiloupe/shared';

export interface StoredRequest {
  kind: 'request';
  id: string;
  time: number;
  service: string;
  level: number;
  method: string;
  route: string;
  path: string;
  status: number;
  durationMs: number | null;
  requestId: string | null;
  attrs: string | null;
  /** How many events this one stands for (sampling); 1 normally. */
  weight: number;
}

export interface StoredLog {
  kind: 'log';
  id: string;
  time: number;
  service: string;
  level: number;
  message: string;
  requestId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  errorStack: string | null;
  attrs: string | null;
  weight: number;
}

export type StoredEvent = StoredRequest | StoredLog;

export interface Window {
  /** Oldest accepted time (the retention cutoff), epoch ms. */
  oldest: number;
  /** Newest accepted time (now plus clock-skew allowance), epoch ms. */
  newest: number;
}

export type Checked = { ok: true; event: StoredEvent } | { ok: false; reason: string };

const HTTP_METHOD = /^[A-Z]{1,16}$/;

/** Validates one event from an ingest batch and turns it into a row to store. */
export function checkEvent(raw: unknown, window: Window): Checked {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('event must be an object');
  }
  const e = raw as Record<string, unknown>;

  const time = parseTime(e.time);
  if (time === undefined) return fail('time is missing or not a valid timestamp');
  if (time < window.oldest) return fail('time is older than the retention period');
  if (time > window.newest) return fail('time is in the future');

  let id: string;
  if (e.id === undefined || e.id === null) {
    // No id given: the content is the identity, so an identical resend is a duplicate.
    id = createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 32);
  } else if (typeof e.id === 'string' && e.id !== '' && e.id.length <= LIMITS.id) {
    id = clean(e.id);
  } else {
    return fail(`id must be a string of 1 to ${LIMITS.id} characters`);
  }

  const service = optional(e.service, LIMITS.service);
  if (service === false) return fail('service must be a string');
  const requestId = optionalId(e.requestId);
  if (requestId === false) return fail('requestId must be a string');
  const attrs = serializeAttrs(e.attrs);
  if (attrs === false) return fail('attrs must be an object');
  let weight = 1;
  if (e.sampleRate !== undefined && e.sampleRate !== null) {
    if (typeof e.sampleRate !== 'number' || !(e.sampleRate > 0) || e.sampleRate > 1) {
      return fail('sampleRate must be a number above 0 and at most 1');
    }
    weight = sampleWeight(e.sampleRate);
  }

  if (e.type === 'request') {
    const method = typeof e.method === 'string' ? e.method.toUpperCase() : '';
    if (!HTTP_METHOD.test(method)) return fail('method must be an HTTP method');
    if (typeof e.path !== 'string' || e.path === '') return fail('path is required');
    const status = e.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
      return fail('status must be an HTTP status code');
    }
    let durationMs: number | null = null;
    if (e.durationMs !== undefined && e.durationMs !== null) {
      if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0) {
        return fail('durationMs must be a non-negative number');
      }
      durationMs = e.durationMs;
    }
    const level = e.level === undefined ? levelForStatus(status) : normalizeLevel(e.level);
    if (level === undefined) return fail('level is not a known level');
    const path = cut(pathOnly(e.path), LIMITS.path);
    const route = optional(e.route, LIMITS.route);
    if (route === false) return fail('route must be a string');
    return {
      ok: true,
      event: {
        kind: 'request',
        id,
        time,
        service: service ?? '',
        level,
        method,
        route: route || routeFromPath(path),
        path,
        status,
        durationMs,
        requestId,
        attrs,
        weight,
      },
    };
  }

  if (e.type === 'log') {
    const level = normalizeLevel(e.level);
    if (level === undefined) return fail('level is missing or not a known level');
    if (typeof e.message !== 'string') return fail('message must be a string');
    let errorType: string | null = null;
    let errorMessage: string | null = null;
    let errorStack: string | null = null;
    if (e.error !== undefined && e.error !== null) {
      if (typeof e.error !== 'object' || Array.isArray(e.error))
        return fail('error must be an object');
      const err = e.error as Record<string, unknown>;
      const type = optional(err.type, LIMITS.errorType);
      const message = optional(err.message, LIMITS.errorMessage);
      const stack = optional(err.stack, LIMITS.errorStack);
      if (type === false || message === false || stack === false) {
        return fail('error fields must be strings');
      }
      errorType = type || null;
      errorMessage = message ? redactString(message) : null;
      errorStack = stack || null;
    }
    return {
      ok: true,
      event: {
        kind: 'log',
        id,
        time,
        service: service ?? '',
        level,
        message: redactString(cut(e.message, LIMITS.message)),
        requestId,
        errorType,
        errorMessage,
        errorStack,
        attrs,
        weight,
      },
    };
  }

  return fail('type must be "request" or "log"');
}

function fail(reason: string): Checked {
  return { ok: false, reason };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Postgres refuses NUL characters and unpaired surrogates in text and jsonb,
 * and one bad string would fail the whole batch, so they are removed here.
 */
function clean(text: string): string {
  return text.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD');
}

function cut(text: string, max: number): string {
  return clean(text.length > max ? text.slice(0, max) : text);
}

/** A trimmed-to-limit string, undefined when absent, false when the wrong type. */
function optional(value: unknown, max: number): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return false;
  return cut(value, max);
}

function optionalId(value: unknown): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return false;
  return cut(value, LIMITS.requestId);
}

function serializeAttrs(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length === 0) return null;
  const json = JSON.stringify(redact(value), (_key, item: unknown) =>
    typeof item === 'string' ? clean(item) : item,
  );
  if (Buffer.byteLength(json) > LIMITS.attrsBytes) {
    return JSON.stringify({ _truncated: true, _bytes: Buffer.byteLength(json) });
  }
  return json;
}
