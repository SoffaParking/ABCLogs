/**
 * @apiloupe/node: send a Node.js API's requests, logs and errors to apiloupe.
 *
 * ```js
 * const { createApiloupe } = require('@apiloupe/node');
 * const apiloupe = createApiloupe({
 *   endpoint: process.env.APILOUPE_ENDPOINT,
 *   key: process.env.APILOUPE_KEY,
 *   service: 'orders-api',
 * });
 * app.use(apiloupe.express());
 * ```
 *
 * Guarantees: nothing here throws into your code or blocks a request. Events
 * wait in a bounded in-memory queue and are sent in the background; when the
 * server is slow or down, the oldest are dropped first and counted.
 */
import { Client } from './client.js';

export interface ApiloupeOptions {
  /** The apiloupe server, e.g. `https://apiloupe.example.com`. Without it the client does nothing. */
  endpoint?: string | undefined;
  /** The project's ingest key (`alk_…`). Without it the client does nothing. */
  key?: string | undefined;
  /** Names this app when several send to one project. */
  service?: string | undefined;
  /** Events held in memory while sending is slow or failing. Default 10 000. */
  maxQueue?: number;
  /** Events per request, at most 1000. Default 500. */
  batchSize?: number;
  /** How often queued events are sent. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Per-request timeout. Default 10 000 ms. */
  timeoutMs?: number;
  /**
   * Also send request bodies, query strings, headers and client IPs, with
   * secrets masked. Off by default: that is where personal data lives.
   */
  captureBodies?: boolean;
  /**
   * Told about sending problems. The default prints one `console.warn` at
   * most every five minutes; `false` stays silent.
   */
  onError?: ((error: Error) => void) | false;
  /** Try to send what is queued when the event loop empties at exit. Default true. */
  flushOnExit?: boolean;
}

/** The shape of an Express (4 or 5) request that the middleware reads. */
export interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  id?: unknown;
  ip?: string | undefined;
  body?: unknown;
  query?: unknown;
}

/** The shape of a response that the middleware listens to. */
export interface ResponseLike {
  statusCode: number;
  on(event: 'finish' | 'close', listener: () => void): unknown;
}

export interface ExpressOptions {
  /**
   * The request id that links a request to its log lines. Default: `req.id`,
   * then the `x-request-id` header.
   */
  requestId?: (req: RequestLike) => string | undefined;
  /** Requests to leave out, such as health checks. */
  skip?: (req: RequestLike) => boolean;
}

export interface PinoStreamOptions {
  /** Lines below this level are not sent. Default: everything pino writes. */
  minLevel?: string | number;
  /**
   * Send request lines (an access log written through pino) as requests.
   * Default true; set false when `express()` already records requests, or
   * they would be counted twice.
   */
  requests?: boolean;
}

/** An object with `write`, which pino accepts as a destination or in `pino.multistream`. */
export interface PinoStream {
  write(chunk: string | Uint8Array): boolean;
}

export type LevelInput = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | number;

export interface LogDetails {
  requestId?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  error?: unknown;
}

export interface ExceptionDetails {
  requestId?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  /** Default `error`. */
  level?: LevelInput;
  /** Default: the error's own message. */
  message?: string;
}

export interface ApiloupeStats {
  /** False when no endpoint or key was given: everything is a no-op. */
  enabled: boolean;
  /** Waiting to be sent. */
  queued: number;
  /** Accepted by the server (including ones it already had). */
  sent: number;
  /** Lost: pushed out of a full queue, refused by the server, or unsendable. */
  dropped: number;
  /** Failed attempts (each is retried). */
  failedAttempts: number;
  lastError: string | null;
}

export interface Apiloupe {
  readonly enabled: boolean;
  /** Express middleware recording every request: method, path, route, status, duration. */
  express(
    options?: ExpressOptions,
  ): (req: RequestLike, res: ResponseLike, next: () => void) => void;
  /**
   * Express error middleware: records the error with its stack and request
   * id, then passes it on. Add it after your routes, before your own error handler.
   */
  expressErrorHandler(): (
    error: unknown,
    req: RequestLike,
    res: ResponseLike,
    next: (error?: unknown) => void,
  ) => void;
  /** A stream for pino (`pino.multistream([{ stream: process.stdout }, { stream: apiloupe.pinoStream() }])`). */
  pinoStream(options?: PinoStreamOptions): PinoStream;
  /** Records one log line. */
  log(level: LevelInput, message: string, details?: LogDetails): void;
  /** Records an error with its stack. */
  captureException(error: unknown, details?: ExceptionDetails): void;
  /** Sends what is queued, waiting at most `timeoutMs` (default 5000). Never rejects. */
  flush(timeoutMs?: number): Promise<void>;
  /** Flushes, then stops. Call it in your graceful shutdown. Never rejects. */
  shutdown(timeoutMs?: number): Promise<void>;
  stats(): ApiloupeStats;
}

export function createApiloupe(options: ApiloupeOptions = {}): Apiloupe {
  return new Client(options);
}
