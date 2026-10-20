import { randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';

// No 0/O, 1/I/L: the code is read off a terminal and typed into a form.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '');
}

/**
 * First-run setup. Until the first admin exists, anyone who can reach the
 * server could claim it, so setup also needs a code that only the person
 * running the server can see: it is printed in the server log (or set with
 * SETUP_CODE).
 */
export class SetupGate {
  private code: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: FastifyBaseLogger,
    private readonly configured: string | undefined,
  ) {}

  async required(): Promise<boolean> {
    const { rows } = await this.pool.query<{ any: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM users) AS any',
    );
    const required = !rows[0]?.any;
    if (required && this.code === null) {
      this.code = this.configured ?? randomCode();
      this.log.warn(
        this.configured
          ? 'No users yet. Open the dashboard and enter SETUP_CODE to create the first admin.'
          : `No users yet. Open the dashboard and enter setup code ${this.code} to create the first admin.`,
      );
    }
    if (!required) this.code = null;
    return required;
  }

  matches(candidate: unknown): boolean {
    if (this.code === null || typeof candidate !== 'string') return false;
    const a = Buffer.from(normalize(candidate));
    const b = Buffer.from(normalize(this.code));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  done(): void {
    this.code = null;
  }
}
