import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY = /^alk_([a-z0-9]{8})_([a-z0-9]{32})$/;
const CACHE_MS = 60_000;

function random(length: number): string {
  return Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

/**
 * A new ingest key: `alk_<prefix>_<secret>`. The prefix (shown in the
 * dashboard) finds the key; the whole key is only ever shown once.
 */
export function generateIngestKey(): { key: string; prefix: string; hash: Buffer } {
  const prefix = random(8);
  const key = `alk_${prefix}_${random(32)}`;
  return { key, prefix, hash: sha256(key) };
}

export interface ResolvedKey {
  keyId: number;
  projectId: number;
}

interface CacheEntry {
  hash: Buffer;
  resolved: ResolvedKey | null;
  expires: number;
}

/**
 * Checks ingest keys, remembering each for a minute so a busy sender does not
 * cost a database lookup per batch. Revoking through the dashboard clears the
 * entry at once; another server process notices within the minute.
 */
export class IngestKeys {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly lastUsed = new Map<number, number>();

  constructor(private readonly pool: pg.Pool) {}

  async resolve(authorization: string | undefined): Promise<ResolvedKey | null> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    const key = match?.[1];
    const parts = key ? KEY.exec(key) : null;
    if (!key || !parts) return null;
    const prefix = parts[1]!;
    const hash = sha256(key);

    let entry = this.cache.get(prefix);
    if (!entry || entry.expires < Date.now()) {
      const { rows } = await this.pool.query<{
        id: number;
        project_id: number;
        secret_hash: Buffer;
      }>(
        'SELECT id, project_id, secret_hash FROM ingest_keys WHERE prefix = $1 AND revoked_at IS NULL',
        [prefix],
      );
      const row = rows[0];
      entry = {
        hash: row?.secret_hash ?? Buffer.alloc(32),
        resolved: row ? { keyId: Number(row.id), projectId: Number(row.project_id) } : null,
        expires: Date.now() + CACHE_MS,
      };
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(prefix, entry);
    }
    if (!entry.resolved || !timingSafeEqual(hash, entry.hash)) return null;
    this.touch(entry.resolved.keyId);
    return entry.resolved;
  }

  forget(prefix: string): void {
    this.cache.delete(prefix);
  }

  /** Records that a key was used, at most once a minute per key. */
  private touch(keyId: number): void {
    const now = Date.now();
    if ((this.lastUsed.get(keyId) ?? 0) > now - 60_000) return;
    this.lastUsed.set(keyId, now);
    this.pool
      .query('UPDATE ingest_keys SET last_used_at = now() WHERE id = $1', [keyId])
      .catch(() => undefined);
  }
}
