import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { hashToken, newToken } from './tokens.js';

export const SESSION_DAYS = 14;
const DAY_MS = 86_400_000;
// Sliding expiry: a session in use is extended, but at most this often, so a
// busy dashboard does not write on every request.
const TOUCH_EVERY_MS = 10 * 60_000;

/** Admins manage everything; members also triage issues; viewers only look. */
export type Role = 'admin' | 'member' | 'viewer';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface CookieSettings {
  /** Set when the dashboard is served over https. */
  secure: boolean;
}

/** `__Host-` pins the cookie to this exact origin, but browsers allow it only on https. */
export function cookieName(settings: CookieSettings): string {
  return settings.secure ? '__Host-apiloupe_session' : 'apiloupe_session';
}

export async function createSession(
  pool: pg.Pool | pg.PoolClient,
  userId: number,
): Promise<string> {
  const token = newToken();
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS],
  );
  return token;
}

/** The signed-in user for a session token, or null when it is unknown, expired or disabled. */
export async function userForToken(pool: pg.Pool, token: string): Promise<SessionUser | null> {
  const { rows } = await pool.query<SessionUser & { last_seen_at: Date }>(
    `SELECT u.id, u.email, u.name, u.role, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > TOUCH_EVERY_MS) {
    await pool.query(
      `UPDATE sessions SET last_seen_at = now(), expires_at = now() + make_interval(days => $2)
        WHERE token_hash = $1`,
      [hashToken(token), SESSION_DAYS],
    );
  }
  return { id: Number(row.id), email: row.email, name: row.name, role: row.role };
}

export async function deleteSession(pool: pg.Pool, token: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  settings: CookieSettings,
): void {
  const parts = [
    `${cookieName(settings)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${(SESSION_DAYS * DAY_MS) / 1000}`,
  ];
  if (settings.secure) parts.push('Secure');
  reply.header('set-cookie', parts.join('; '));
}

export function clearSessionCookie(reply: FastifyReply, settings: CookieSettings): void {
  const parts = [`${cookieName(settings)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (settings.secure) parts.push('Secure');
  reply.header('set-cookie', parts.join('; '));
}
