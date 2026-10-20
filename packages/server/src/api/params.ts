import { normalizeLevel } from '@apiloupe/shared';
import type pg from 'pg';
import { badRequest, notFound } from '../http.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type Query = Record<string, string | undefined>;

export interface Range {
  from: Date;
  to: Date;
  /** The chart bucket width, picked from the span so a chart has 60 to 170 points. */
  stepSeconds: number;
}

function timeParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) throw badRequest(`${name} is not a valid time`);
  return ms;
}

/** `from` and `to` (ISO or epoch ms; the last hour by default), aligned to whole minutes. */
export function parseRange(query: Query, retentionDays: number): Range {
  const now = Date.now();
  const to = timeParam(query.to, 'to') ?? now;
  const from = timeParam(query.from, 'from') ?? to - HOUR_MS;
  if (from >= to) throw badRequest('from must be before to');
  const maxSpan = (retentionDays + 1) * 24 * HOUR_MS;
  if (to - from > maxSpan) throw badRequest(`the range can be at most ${retentionDays + 1} days`);
  const span = to - from;
  const stepSeconds =
    span <= 2 * HOUR_MS
      ? 60
      : span <= 6 * HOUR_MS
        ? 300
        : span <= 24 * HOUR_MS
          ? 900
          : span <= 7 * 24 * HOUR_MS
            ? 3600
            : 10800;
  return {
    from: new Date(Math.floor(from / MINUTE_MS) * MINUTE_MS),
    to: new Date(Math.ceil(to / MINUTE_MS) * MINUTE_MS),
    stepSeconds,
  };
}

/** The start of every chart bucket in the range, so empty buckets show as zero. */
export function bucketStarts(range: Range): number[] {
  const step = range.stepSeconds * 1000;
  const out: number[] = [];
  for (let t = Math.floor(range.from.getTime() / step) * step; t < range.to.getTime(); t += step) {
    out.push(t);
  }
  return out;
}

export function minLevelParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const level = normalizeLevel(value);
  if (level === undefined) throw badRequest('minLevel is not a known level');
  return level;
}

export function limitParam(value: string | undefined, fallback = 50, max = 200): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`limit must be 1 to ${max}`);
  return n;
}

/** `%`, `_` and `\` are literal in a search box; escape them for ILIKE … ESCAPE '\'. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface Cursor {
  time: number;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.time, cursor.id])).toString('base64url');
}

export function decodeCursor(value: string | undefined): Cursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'number' && typeof parsed[1] === 'string') {
      return { time: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw badRequest('cursor is not valid');
}

/** An event's address in URLs: its time (which picks the partition) and id. */
export function encodeRef(time: number, id: string): string {
  return `${time}.${id}`;
}

export function decodeRef(ref: string): Cursor {
  const dot = ref.indexOf('.');
  const time = Number(ref.slice(0, dot));
  if (dot <= 0 || !Number.isInteger(time)) throw notFound();
  return { time, id: ref.slice(dot + 1) };
}

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
}

export async function projectBySlug(pool: pg.Pool, slug: string): Promise<ProjectRow> {
  const { rows } = await pool.query<ProjectRow>(
    'SELECT id, slug, name FROM projects WHERE slug = $1',
    [slug],
  );
  if (!rows[0]) throw notFound('no such project');
  return { ...rows[0], id: Number(rows[0].id) };
}

/** Builds a WHERE clause from optional conditions, numbering parameters as it goes. */
export class Where {
  readonly params: unknown[] = [];
  private readonly parts: string[] = [];

  constructor(first: string, ...values: unknown[]) {
    this.add(first, ...values);
  }

  /** Adds a condition; each `?` in it becomes the next `$n`. */
  add(condition: string, ...values: unknown[]): this {
    let i = 0;
    this.parts.push(
      condition.replace(/\?/g, () => {
        this.params.push(values[i++]);
        return `$${this.params.length}`;
      }),
    );
    return this;
  }

  /** The next parameter placeholder, for values used outside the WHERE clause. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  sql(): string {
    return this.parts.join(' AND ');
  }
}
