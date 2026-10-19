import { existsSync } from 'node:fs';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { LEVEL_NAMES } from '@apiloupe/shared';
import type { Config } from './config.js';
import { pingDatabase } from './db.js';

export interface AppDeps {
  config: Config;
  pool: pg.Pool | null;
}

export async function buildApp({ config, pool }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });

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

  // A tiny API route so the placeholder page can prove the UI reaches the server.
  app.get('/api/v1/meta', () => ({ name: 'apiloupe', levels: LEVEL_NAMES }));

  if (existsSync(config.publicDir)) {
    await app.register(fastifyStatic, { root: config.publicDir });
    // Client-side routes fall back to the app shell; unknown API and ingest
    // paths stay 404s.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !/^\/(api|ingest)\//.test(req.url)) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
