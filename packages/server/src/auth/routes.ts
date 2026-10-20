import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import {
  badRequest,
  bodyObject,
  conflict,
  HttpError,
  notFound,
  optionalString,
  requiredEmail,
  requiredString,
  unauthorized,
} from '../http.js';
import { requireUser, secureCookies } from './guard.js';
import { FailureLimiter } from './limiter.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  setSessionCookie,
  type SessionUser,
} from './sessions.js';
import { hashToken } from './tokens.js';

const LOGIN_WINDOW_MS = 15 * 60_000;

// A real hash to verify against when the email is unknown, so a login for a
// missing account takes as long as a wrong password and does not reveal
// which emails exist.
const DUMMY_HASH = hashPassword('not a real password');

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: SessionUser['role'];
}

function publicUser(row: UserRow): SessionUser {
  return { id: Number(row.id), email: row.email, name: row.name, role: row.role };
}

function password(body: Record<string, unknown>, key = 'password'): string {
  const problem = passwordProblem(body[key]);
  if (problem) throw badRequest(problem);
  return body[key] as string;
}

/** `/api/v1/auth/*`: first-run setup, sign-in and out, invites, own password. */
export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cookies = { secure: secureCookies(ctx) };
  const byIp = new FailureLimiter(30, LOGIN_WINDOW_MS);
  const byEmail = new FailureLimiter(10, LOGIN_WINDOW_MS);

  async function signIn(reply: FastifyReply, userId: number): Promise<void> {
    const token = await createSession(ctx.pool, userId);
    setSessionCookie(reply, token, cookies);
  }

  app.get('/auth/state', async (req) => ({
    setupRequired: await ctx.setup.required(),
    user: req.user,
  }));

  app.post('/auth/setup', async (req, reply) => {
    const body = bodyObject(req.body);
    if (!(await ctx.setup.required())) throw conflict('setup is already done');
    const retry = byIp.retryAfter(req.ip);
    if (retry > 0) throw new HttpError(429, 'too many attempts', { 'retry-after': String(retry) });
    if (!ctx.setup.matches(body.code)) {
      byIp.fail(req.ip);
      throw new HttpError(403, 'wrong setup code (it is in the server log)');
    }
    const email = requiredEmail(body);
    const name = optionalString(body, 'name') ?? '';
    const hash = await hashPassword(password(body));
    const user = await withTransaction(ctx.pool, async (client) => {
      // Two setup requests racing: the lock makes the second one see the first admin.
      await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const { rows: existing } = await client.query('SELECT 1 FROM users LIMIT 1');
      if (existing.length > 0) throw conflict('setup is already done');
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, 'admin')
         RETURNING id, email, name, role`,
        [email, name, hash],
      );
      return publicUser(rows[0]!);
    });
    ctx.setup.done();
    await signIn(reply, user.id);
    req.log.info({ userId: user.id }, 'first admin created');
    return reply.code(201).send({ user });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = bodyObject(req.body);
    const email = requiredEmail(body);
    const given = typeof body.password === 'string' ? body.password : '';
    const retry = Math.max(byIp.retryAfter(req.ip), byEmail.retryAfter(email));
    if (retry > 0) {
      throw new HttpError(429, 'too many failed sign-ins, try again later', {
        'retry-after': String(retry),
      });
    }
    const { rows } = await ctx.pool.query<UserRow & { password_hash: string }>(
      `SELECT id, email, name, role, password_hash FROM users
        WHERE lower(email) = $1 AND disabled_at IS NULL`,
      [email],
    );
    const row = rows[0];
    const ok = await verifyPassword(given.slice(0, 1000), row?.password_hash ?? (await DUMMY_HASH));
    if (!row || !ok) {
      byIp.fail(req.ip);
      byEmail.fail(email);
      throw unauthorized('wrong email or password');
    }
    byEmail.reset(email);
    await signIn(reply, Number(row.id));
    return { user: publicUser(row) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionToken) await deleteSession(ctx.pool, req.sessionToken);
    clearSessionCookie(reply, cookies);
    return reply.code(204).send();
  });

  app.get('/auth/me', (req) => ({ user: requireUser(req) }));

  app.post('/auth/password', async (req, reply) => {
    const user = requireUser(req);
    const body = bodyObject(req.body);
    const next = password(body, 'newPassword');
    const { rows } = await ctx.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [user.id],
    );
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) {
      throw new HttpError(403, 'current password is wrong');
    }
    await ctx.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      user.id,
      await hashPassword(next),
    ]);
    // Every other session ends: a changed password should lock out whoever had the old one.
    await ctx.pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [
      user.id,
      hashToken(req.sessionToken ?? ''),
    ]);
    return reply.code(204).send();
  });

  app.get<{ Params: { token: string } }>('/auth/invites/:token', async (req) => {
    const { rows } = await ctx.pool.query<{ email: string; role: string }>(
      `SELECT email, role FROM invites
        WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [hashToken(req.params.token)],
    );
    if (!rows[0]) throw notFound('this invite link is invalid, used or expired');
    return { email: rows[0].email, role: rows[0].role };
  });

  app.post<{ Params: { token: string } }>('/auth/invites/:token/accept', async (req, reply) => {
    const body = bodyObject(req.body);
    const name = requiredString(body, 'name');
    const hash = await hashPassword(password(body));
    const user = await withTransaction(ctx.pool, async (client) => {
      const { rows: invites } = await client.query<{
        id: number;
        email: string;
        role: UserRow['role'];
      }>(
        `SELECT id, email, role FROM invites
          WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [hashToken(req.params.token)],
      );
      const invite = invites[0];
      if (!invite) throw notFound('this invite link is invalid, used or expired');
      const { rows: taken } = await client.query('SELECT 1 FROM users WHERE lower(email) = $1', [
        invite.email.toLowerCase(),
      ]);
      if (taken.length > 0) throw conflict('an account with this email already exists');
      const { rows } = await client.query<UserRow>(
        `INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role`,
        [invite.email, name, hash, invite.role],
      );
      await client.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [invite.id]);
      return publicUser(rows[0]!);
    });
    await signIn(reply, user.id);
    return reply.code(201).send({ user });
  });
}
