import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from '../auth/guard.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import {
  badRequest,
  bodyObject,
  conflict,
  notFound,
  optionalString,
  requiredString,
} from '../http.js';
import { generateIngestKey } from '../ingest/keys.js';
import { projectBySlug } from './params.js';

type SlugParams = { Params: { slug: string } };
type KeyParams = { Params: { slug: string; id: string } };

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return slug || 'project';
}

interface ProjectListRow {
  id: number;
  slug: string;
  name: string;
  created_at: Date;
  last_ingest_at: Date | null;
}

/** Projects and their ingest keys. Everyone signed in can see projects; admins change them. */
export function projectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/projects', async (req) => {
    requireUser(req);
    const { rows } = await ctx.pool.query<ProjectListRow>(
      `SELECT p.id, p.slug, p.name, p.created_at,
              (SELECT max(hour) FROM ingest_stats_hourly s
                WHERE s.project_id = p.id AND s.accepted > 0) AS last_ingest_at
         FROM projects p ORDER BY p.name, p.id`,
    );
    return {
      projects: rows.map((row) => ({
        id: Number(row.id),
        slug: row.slug,
        name: row.name,
        createdAt: row.created_at.toISOString(),
        lastIngestAt: row.last_ingest_at?.toISOString() ?? null,
      })),
    };
  });

  app.post('/projects', async (req, reply) => {
    requireAdmin(req);
    const body = bodyObject(req.body);
    const name = requiredString(body, 'name', 100);
    const wanted = optionalString(body, 'slug', 63);
    if (wanted !== undefined && !SLUG.test(wanted)) {
      throw badRequest('slug must be lowercase letters, digits and dashes');
    }
    const base = wanted ?? slugify(name);
    for (let n = 1; n <= 50; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const { rows } = await ctx.pool.query<{ id: number; slug: string; name: string }>(
        `INSERT INTO projects (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO NOTHING RETURNING id, slug, name`,
        [slug, name],
      );
      if (rows[0]) return reply.code(201).send({ project: { ...rows[0], id: Number(rows[0].id) } });
      if (wanted !== undefined) throw conflict('a project with this slug exists');
    }
    throw conflict('could not find a free slug; pass one explicitly');
  });

  app.patch<SlugParams>('/projects/:slug', async (req) => {
    requireAdmin(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const name = requiredString(bodyObject(req.body), 'name', 100);
    await ctx.pool.query('UPDATE projects SET name = $2 WHERE id = $1', [project.id, name]);
    return { project: { ...project, name } };
  });

  app.delete<SlugParams>('/projects/:slug', async (req, reply) => {
    requireAdmin(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const prefixes = await withTransaction(ctx.pool, async (client) => {
      const { rows } = await client.query<{ prefix: string }>(
        'SELECT prefix FROM ingest_keys WHERE project_id = $1',
        [project.id],
      );
      for (const table of [
        'request_events',
        'log_events',
        'rollup_requests_1m',
        'rollup_levels_1m',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE project_id = $1`, [project.id]);
      }
      // Keys, routes and ingest stats go with the project (ON DELETE CASCADE).
      await client.query('DELETE FROM projects WHERE id = $1', [project.id]);
      return rows.map((row) => row.prefix);
    });
    for (const prefix of prefixes) ctx.keys.forget(prefix);
    return reply.code(204).send();
  });

  app.get<SlugParams>('/projects/:slug/keys', async (req) => {
    requireAdmin(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const { rows } = await ctx.pool.query<{
      id: number;
      name: string;
      prefix: string;
      created_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT id, name, prefix, created_at, last_used_at, revoked_at FROM ingest_keys
        WHERE project_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC`,
      [project.id],
    );
    return {
      keys: rows.map((row) => ({
        id: Number(row.id),
        name: row.name,
        prefix: row.prefix,
        createdAt: row.created_at.toISOString(),
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })),
    };
  });

  app.post<SlugParams>('/projects/:slug/keys', async (req, reply) => {
    const user = requireAdmin(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const name = requiredString(bodyObject(req.body), 'name', 100);
    const { key, prefix, hash } = generateIngestKey();
    const { rows } = await ctx.pool.query<{ id: number; created_at: Date }>(
      `INSERT INTO ingest_keys (project_id, name, prefix, secret_hash, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [project.id, name, prefix, hash, user.id],
    );
    return reply.code(201).send({
      // The only time the full key is ever returned.
      key,
      id: Number(rows[0]!.id),
      name,
      prefix,
      createdAt: rows[0]!.created_at.toISOString(),
    });
  });

  app.delete<KeyParams>('/projects/:slug/keys/:id', async (req, reply) => {
    requireAdmin(req);
    const project = await projectBySlug(ctx.pool, req.params.slug);
    const { rows } = await ctx.pool.query<{ prefix: string }>(
      `UPDATE ingest_keys SET revoked_at = coalesce(revoked_at, now())
        WHERE id = $1 AND project_id = $2 RETURNING prefix`,
      [Number(req.params.id) || 0, project.id],
    );
    if (!rows[0]) throw notFound('no such key');
    ctx.keys.forget(rows[0].prefix);
    return reply.code(204).send();
  });
}
