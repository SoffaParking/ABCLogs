import { redact } from '@apiloupe/shared';
import type { Client } from './client.js';
import type { ExpressOptions, RequestLike, ResponseLike } from './index.js';

/** nginx's convention for a client that went away before the response was sent. */
const CLIENT_CLOSED = 499;

function defaultRequestId(req: RequestLike): string | undefined {
  const id = req.id;
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number') return String(id);
  const header = req.headers?.['x-request-id'];
  return typeof header === 'string' && header !== '' ? header : undefined;
}

function routeOf(req: RequestLike): string | undefined {
  const route = req.route as { path?: unknown } | undefined;
  if (route && typeof route.path === 'string') return `${req.baseUrl ?? ''}${route.path}`;
  return undefined;
}

/**
 * Records each request when its response finishes. Everything that costs
 * anything (serialising, compressing, sending) happens later, in batches.
 */
export function expressMiddleware(client: Client, options: ExpressOptions) {
  const requestIdOf = options.requestId ?? defaultRequestId;
  return (req: RequestLike, res: ResponseLike, next: () => void): void => {
    if (!client.enabled) {
      next();
      return;
    }
    try {
      if (options.skip?.(req)) {
        next();
        return;
      }
      const start = process.hrtime.bigint();
      let recorded = false;
      const record = (aborted: boolean) => {
        if (recorded) return;
        recorded = true;
        try {
          const url = req.originalUrl ?? req.url ?? '/';
          const query = url.indexOf('?');
          const requestId = requestIdOf(req);
          const route = routeOf(req);
          const attrs = client.captureBodies ? captured(req) : undefined;
          client.enqueue({
            type: 'request',
            time: Date.now(),
            method: req.method ?? 'GET',
            path: query === -1 ? url : url.slice(0, query),
            status: aborted ? CLIENT_CLOSED : res.statusCode,
            durationMs: Number(process.hrtime.bigint() - start) / 1e6,
            ...(route ? { route } : {}),
            ...(requestId ? { requestId } : {}),
            ...(attrs ? { attrs } : {}),
          });
        } catch {
          // never throw into the app
        }
      };
      res.on('finish', () => record(false));
      // 'close' without 'finish' means the client hung up first.
      res.on('close', () => record(true));
    } catch {
      // fall through to next() whatever happened
    }
    next();
  };
}

function captured(req: RequestLike): Record<string, unknown> {
  return redact({
    ...(req.query && Object.keys(req.query).length > 0 ? { query: req.query } : {}),
    ...(req.body !== undefined && req.body !== null && req.body !== '' ? { body: req.body } : {}),
    ...(req.headers ? { headers: req.headers } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
  }) as Record<string, unknown>;
}

export function expressErrorHandler(client: Client) {
  return (
    error: unknown,
    req: RequestLike,
    _res: ResponseLike,
    next: (error?: unknown) => void,
  ): void => {
    try {
      const requestId = defaultRequestId(req);
      const route = routeOf(req);
      client.captureException(error, {
        ...(requestId ? { requestId } : {}),
        attrs: {
          method: req.method,
          path: (req.originalUrl ?? req.url ?? '').split('?')[0],
          ...(route ? { route } : {}),
        },
      });
    } catch {
      // never throw into the app
    }
    next(error);
  };
}
