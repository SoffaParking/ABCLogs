import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/guard.js';
import type { Role } from '../auth/sessions.js';
import { hashToken, newToken } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { badRequest, bodyObject, conflict, notFound, requiredEmail } from '../http.js';

const INVITE_DAYS = 7;

type IdParams = { Params: { id: string } };

const ROLES: readonly Role[] = ['admin', 'member', 'viewer'];

function role(value: unknown): Role {
  if (!ROLES.includes(value as Role)) {
    throw badRequest('role must be "admin", "member" or "viewer"');
  }
  return value as Role;
}

/** Admin-only: the user list, role and access changes, and invite links. */
export function userRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/users', async (req) => {
    requireAdmin(req);
    const [users, invites] = await Promise.all([
      ctx.pool.query<{
        id: number;
        email: string;
        name: string;
        role: Role;
        created_at: Date;
        disabled_at: Date | null;
      }>(
        'SELECT id, email, name, role, created_at, disabled_at FROM users ORDER BY created_at, id',
      ),
      ctx.pool.query<{ id: number; email: string; role: Role; created_at: Date; expires_at: Date }>(
        `SELECT id, email, role, created_at, expires_at FROM invites
          WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
      ),
    ]);
    return {
      users: users.rows.map((row) => ({
        id: Number(row.id),
        email: row.email,
        name: row.name,
        role: row.role,
        createdAt: row.created_at.toISOString(),
        disabled: row.disabled_at !== null,
      })),
      invites: invites.rows.map((row) => ({
        id: Number(row.id),
        email: row.email,
        role: row.role,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      })),
    };
  });

  app.patch<IdParams>('/users/:id', async (req) => {
    const me = requireAdmin(req);
    const id = Number(req.params.id);
    const body = bodyObject(req.body);
    const newRole = body.role === undefined ? undefined : role(body.role);
    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
      throw badRequest('disabled must be true or false');
    }
    const disable = body.disabled;
    if (id === me.id && (disable === true || (newRole !== undefined && newRole !== 'admin'))) {
      throw conflict('you cannot disable or demote yourself; ask another admin');
    }
    await withTransaction(ctx.pool, async (client) => {
      // Serialises admin changes so two of them cannot each remove "the other" last admin.
      await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const { rows } = await client.query<{ id: number }>('SELECT id FROM users WHERE id = $1', [
        id,
      ]);
      if (!rows[0]) throw notFound('no such user');
      if (newRole) await client.query('UPDATE users SET role = $2 WHERE id = $1', [id, newRole]);
      if (disable !== undefined) {
        await client.query(
          `UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) END WHERE id = $1`,
          [id, disable],
        );
        if (disable) await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      const { rows: admins } = await client.query(
        `SELECT 1 FROM users WHERE role = 'admin' AND disabled_at IS NULL LIMIT 1`,
      );
      if (admins.length === 0) throw conflict('there must be at least one active admin');
    });
    return { ok: true };
  });

  app.post('/invites', async (req, reply) => {
    const me = requireAdmin(req);
    const body = bodyObject(req.body);
    const email = requiredEmail(body);
    const inviteRole = role(body.role ?? 'member');
    const { rows: taken } = await ctx.pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [
      email,
    ]);
    if (taken.length > 0) throw conflict('a user with this email already exists');
    const token = newToken();
    const { rows } = await ctx.pool.query<{ id: number; expires_at: Date }>(
      `INSERT INTO invites (token_hash, email, role, created_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [hashToken(token), email, inviteRole, me.id, INVITE_DAYS],
    );
    return reply.code(201).send({
      // Shown once, as a link the admin passes on. No email is sent.
      token,
      invite: {
        id: Number(rows[0]!.id),
        email,
        role: inviteRole,
        expiresAt: rows[0]!.expires_at.toISOString(),
      },
    });
  });

  app.delete<IdParams>('/invites/:id', async (req, reply) => {
    requireAdmin(req);
    const { rowCount } = await ctx.pool.query(
      'DELETE FROM invites WHERE id = $1 AND accepted_at IS NULL',
      [Number(req.params.id) || 0],
    );
    if (!rowCount) throw notFound('no such invite');
    return reply.code(204).send();
  });
}
