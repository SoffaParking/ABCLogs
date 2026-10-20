const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();

/** 1234 → "1.2K" when compact, "1,234" otherwise. */
export function formatCount(n: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact && Math.abs(n) >= 10_000) return compact.format(n);
  return whole.format(Math.round(n));
}

export function formatRate(n: number): string {
  if (n === 0) return '0';
  if (n < 0.1) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return formatCount(n, { compact: true });
}

/** A share 0–1 as a percentage with sensible precision. */
export function formatPercent(share: number): string {
  if (share === 0) return '0%';
  const pct = share * 100;
  if (pct < 0.1) return '<0.1%';
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const full = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** A chart axis label: time of day for short ranges, day and time for long ones. */
export function formatTick(iso: string, spanMs: number): string {
  const date = new Date(iso);
  return spanMs > 36 * 3_600_000 ? dayAndTime.format(date) : timeOfDay.format(date);
}

/** An event time in a table: seconds and milliseconds matter there. */
export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const sameDay = new Date().toDateString() === date.toDateString();
  const base = sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  return `${base}.${ms}`;
}

export function formatFullTime(iso: string): string {
  return full.format(new Date(iso));
}

/** "3 min ago", "2 h ago", or a date. */
export function formatAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = now - Date.parse(iso);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
