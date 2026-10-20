const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * A point in time from the command line: a duration back from now (`14d`,
 * `6h`, `30m`), an ISO 8601 time, or epoch milliseconds.
 */
export function parseWhen(value: string, now = Date.now()): number {
  const text = value.trim();
  const ago = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(text);
  if (ago) return Math.round(now - Number(ago[1]) * UNITS[ago[2]!.toLowerCase()]!);
  if (/^\d{12,}$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (Number.isNaN(ms))
    throw new Error(`"${value}" is not a time: use 14d, 6h, 30m, an ISO time or epoch ms`);
  return ms;
}

export function parseDuration(value: string, name: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(value.trim());
  if (!match) throw new Error(`${name} must be a duration like 30s, 5m or 1h`);
  return Math.round(Number(match[1]) * UNITS[match[2]!.toLowerCase()]!);
}

/** `2026-10-06 14:00` in UTC, for progress lines. */
export function shortTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
