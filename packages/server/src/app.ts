import { existsSync, readFileSync } from 'node:fs';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { LEVEL_NAMES } from '@apiloupe/shared';
import { eventRoutes } from './api/events.js';
import { issueRoutes } from './api/issues.js';
import { projectRoutes } from './api/projects.js';
import { statsRoutes } from './api/stats.js';
import { userRoutes } from './api/users.js';
import { installSessionHooks } from './auth/guard.js';
import { authRoutes } from './auth/routes.js';
import { SetupGate } from './auth/setup.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { pingDatabase } from './db.js';
import { HttpError } from './http.js';
import { IngestKeys } from './ingest/keys.js';
import { ingestRoutes } from './ingest/routes.js';
import { Partitions } from './partitions.js';

/** This server's version, from its package.json (next to src/ and dist/ alike). */
export const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export interface AppDeps {
  config: Config;
  pool: pg.Pool | null;
}

export interface App extends FastifyInstance {
  /** Shared state for the routes; null without a database. */
  ctx: AppContext | null;
}

export async function buildApp({ config, pool }: AppDeps): Promise<App> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    // Every ingest batch is a request; logging each one would drown the
    // server's own log. Failures are still logged by the error handler.
    logController: new LogController({ disableRequestLogging: true }),
  }) as unknown as App;

  // The dashboard loads nothing from other origins, so the policy can be tight.
  // Every directive is listed (useDefaults off): helmet's defaults would add a
  // looser font-src and `upgrade-insecure-requests`, which breaks the page
  // when it is opened over plain http.
  const https = config.publicUrl?.startsWith('https://') ?? false;
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: https ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (err instanceof HttpError) {
      for (const [name, value] of Object.entries(err.headers)) void reply.header(name, value);
    }
    if (status >= 500) {
      req.log.error({ err, url: req.url, method: req.method }, 'request failed');
      return reply.code(status).send({ error: status === 503 ? err.message : 'internal error' });
    }
    return reply.code(status).send({ error: err.message });
  });

  // Liveness: the process is up. Never touches the database, so a database
  // outage does not get the container restarted in a loop.
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: the process can serve real traffic, which needs Postgres.
  app.get('/readyz', async (_req, reply) => {
    if (!pool) {
      return reply.code(503).send({ status: 'unavailable', database: 'not configured' });
    }
    const ok = await pingDatabase(pool);
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? 'ok' : 'unavailable', database: ok ? 'ok' : 'unreachable' });
  });

  app.ctx = pool
    ? {
        config,
        pool,
        partitions: new Partitions(pool),
        keys: new IngestKeys(pool),
        setup: new SetupGate(pool, app.log, config.setupCode),
      }
    : null;
  const ctx = app.ctx;

  await app.register(
    (api, _opts, done) => {
      // Dashboard data is private; no cache along the way may keep a copy.
      api.addHook('onRequest', (_req, reply, next) => {
        void reply.header('cache-control', 'no-store');
        next();
      });
      api.get('/meta', () => ({ name: 'apiloupe', version: VERSION, levels: LEVEL_NAMES }));
      if (ctx) {
        installSessionHooks(api, ctx);
        authRoutes(api, ctx);
        userRoutes(api, ctx);
        projectRoutes(api, ctx);
        statsRoutes(api, ctx);
        eventRoutes(api, ctx);
        issueRoutes(api, ctx);
      }
      done();
    },
    { prefix: '/api/v1' },
  );

  if (ctx) {
    await app.register(
      (ingest, _opts, done) => {
        ingestRoutes(ingest, ctx);
        done();
      },
      { prefix: '/ingest/v1' },
    );
  }

  const hasUi = existsSync(config.publicDir);
  if (hasUi) {
    await app.register(fastifyStatic, {
      root: config.publicDir,
      setHeaders: (res, path) => {
        // Built assets have content hashes in their names; the page itself must
        // be re-fetched so a new release is picked up.
        void res.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }
  // Client-side routes fall back to the app shell; unknown API and ingest
  // paths stay JSON 404s.
  app.setNotFoundHandler((req, reply) => {
    if (
      hasUi &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !/^\/(api|ingest)\//.test(req.url)
    ) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}
