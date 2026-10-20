/**
 * The wire format of `POST /ingest/v1/events`: a JSON object
 * `{ "events": [ ... ] }` holding up to {@link MAX_BATCH_EVENTS} of these.
 *
 * Times are an ISO 8601 string or epoch milliseconds. Levels are a pino number
 * or a name (`"warn"`, `"warning"`, `"error"` …, see `normalizeLevel`).
 */

/** One HTTP request your API served. */
export interface RequestEventInput {
  type: 'request';
  /** Deduplication key. Sending the same id twice stores the event once. */
  id?: string;
  time: string | number;
  service?: string;
  /** Defaults from the status: 5xx error, 4xx warn, otherwise info. */
  level?: string | number;
  method: string;
  /** The URL path, without the query string. */
  path: string;
  /** The route pattern (`/users/:id`). Derived from the path when missing. */
  route?: string;
  status: number;
  durationMs?: number;
  /** Links the request to the log lines written while serving it. */
  requestId?: string;
  /** Set when the sender keeps only a share of events like this one; see `sampling.ts`. */
  sampleRate?: number;
  attrs?: Record<string, unknown>;
}

/** One log line, with an optional error. */
export interface LogEventInput {
  type: 'log';
  id?: string;
  time: string | number;
  service?: string;
  level: string | number;
  message: string;
  requestId?: string;
  error?: ErrorInput;
  sampleRate?: number;
  attrs?: Record<string, unknown>;
}

export interface ErrorInput {
  /** `TypeError`, `ECONNRESET` … */
  type?: string;
  message?: string;
  stack?: string;
}

export type EventInput = RequestEventInput | LogEventInput;

/** The body of a successful ingest call (HTTP 202). */
export interface IngestResult {
  /** Newly stored events. */
  accepted: number;
  /** Valid events already stored earlier (same id), skipped. */
  duplicates: number;
  /** Events refused, by their index in the batch. */
  rejected: { index: number; reason: string }[];
}

export const MAX_BATCH_EVENTS = 1000;

/**
 * Field limits. Longer strings are cut, not refused, so a huge stack trace
 * costs its tail instead of the whole event.
 */
export const LIMITS = {
  id: 128,
  service: 128,
  method: 16,
  path: 2048,
  route: 512,
  requestId: 128,
  message: 8192,
  errorType: 256,
  errorMessage: 8192,
  errorStack: 32768,
  /** Serialised JSON size of `attrs`; larger attrs are replaced by a marker. */
  attrsBytes: 16384,
} as const;

export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx'];

/** The class a status code is charted under. 1xx counts with 2xx. */
export function statusClass(status: number): StatusClass {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}
