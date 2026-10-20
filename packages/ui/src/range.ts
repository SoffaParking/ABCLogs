/** The time ranges the dashboard offers, newest data at the right edge. */
export const RANGES = [
  { id: '15m', label: '15 min', ms: 15 * 60_000 },
  { id: '1h', label: '1 hour', ms: 3_600_000 },
  { id: '6h', label: '6 hours', ms: 6 * 3_600_000 },
  { id: '24h', label: '24 hours', ms: 24 * 3_600_000 },
  { id: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { id: '14d', label: '14 days', ms: 14 * 86_400_000 },
] as const;

export type RangeId = (typeof RANGES)[number]['id'];

export const DEFAULT_RANGE: RangeId = '1h';

export function rangeFor(id: string | null): (typeof RANGES)[number] {
  return RANGES.find((r) => r.id === id) ?? RANGES.find((r) => r.id === DEFAULT_RANGE)!;
}

/** `from`/`to` for a relative range, computed at request time so polling moves the window. */
export function rangeParams(id: string | null): { from: number; to: number } {
  const to = Date.now();
  return { from: to - rangeFor(id).ms, to };
}
