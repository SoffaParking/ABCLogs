/**
 * Severity levels, on pino's numeric scale. Every event is stored with one of
 * these numbers, whatever the sender called it, so "show warn and above" is a
 * single `level >= 40` everywhere.
 */
export const LEVEL = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type LevelName = keyof typeof LEVEL;
export type LevelNumber = (typeof LEVEL)[LevelName];

export const LEVEL_NAMES: readonly LevelName[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];

const ALIASES: Record<string, LevelNumber> = {
  trace: 10,
  verbose: 10,
  silly: 10,
  debug: 20,
  fine: 20,
  info: 30,
  information: 30,
  notice: 30,
  log: 30,
  warn: 40,
  warning: 40,
  error: 50,
  err: 50,
  severe: 50,
  fatal: 60,
  critical: 60,
  crit: 60,
  alert: 60,
  emerg: 60,
  emergency: 60,
  panic: 60,
};

/**
 * Map whatever a log line calls its level onto the six numbers above.
 *
 * Numbers use pino's bands (anything up to 10 is trace, up to 20 debug, and so
 * on; above 50 is fatal). Strings are matched case-insensitively against the
 * common names from pino, winston, syslog and Java logging, so `"warning"` and
 * `"WARN"` both land on 40. Returns `undefined` for anything unrecognised so
 * the caller decides the default and can keep the raw value.
 */
export function normalizeLevel(value: unknown): LevelNumber | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 10) return 10;
    if (value <= 20) return 20;
    if (value <= 30) return 30;
    if (value <= 40) return 40;
    if (value <= 50) return 50;
    return 60;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && /^\d+$/.test(trimmed)) return normalizeLevel(Number(trimmed));
    return ALIASES[trimmed.toLowerCase()];
  }
  return undefined;
}

/** The level a request event gets when its sender did not say: 5xx error, 4xx warn, else info. */
export function levelForStatus(status: number): LevelNumber {
  if (status >= 500) return LEVEL.error;
  if (status >= 400) return LEVEL.warn;
  return LEVEL.info;
}

/** The name for a stored level number. */
export function levelName(level: number): LevelName {
  return LEVEL_NAMES[Math.min(Math.max(Math.ceil(level / 10) - 1, 0), 5)] ?? 'info';
}
