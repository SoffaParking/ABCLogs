import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { forbidden, unauthorized } from '../http.js';
import { cookieName, readCookie, userForToken, type SessionUser } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Hooks for the dashboard API: reads the session cookie into `req.user`, and
 * refuses state-changing requests sent from another origin. The cookie is
 * SameSite=Strict already; the Origin check is the second lock on the door.
 */
export function installSessionHooks(app: FastifyInstance, ctx: AppContext): void {
  const name = cookieName({ secure: secureCookies(ctx) });
  const publicHost = ctx.config.publicUrl ? new URL(ctx.config.publicUrl).host : undefined;

  app.decorateRequest('user', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (req) => {
    if (!SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let host: string | undefined;
        try {
          host = new URL(origin).host;
        } catch {
          host = undefined;
        }
        if (host === undefined || (host !== ownHost(req) && host !== publicHost)) {
          throw forbidden('cross-origin request refused');
        }
      }
    }
    const token = readCookie(req, name);
    if (token) {
      req.user = await userForToken(ctx.pool, token);
      if (req.user) req.sessionToken = token;
    }
  });
}

/** The host the request was sent to, normalised the way an Origin header is (no default port). */
function ownHost(req: FastifyRequest): string | undefined {
  try {
    return new URL(`${req.protocol}://${req.host}`).host;
  } catch {
    return undefined;
  }
}

export function secureCookies(ctx: AppContext): boolean {
  return ctx.config.publicUrl?.startsWith('https://') ?? false;
}

/** The signed-in user, or a 401. */
export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** The signed-in admin, or a 401/403. */
export function requireAdmin(req: FastifyRequest): SessionUser {
  const user = requireUser(req);
  if (user.role !== 'admin') throw forbidden('admins only');
  return user;
}
