import { createHash, randomBytes } from 'node:crypto';

/** A random, URL-safe secret (session cookies, invite links). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores in place of a token. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}
