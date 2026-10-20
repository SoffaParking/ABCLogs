import type { EventInput } from './events.js';
import { normalizeLevel } from './levels.js';

/**
 * Sampling, for apps too busy to send everything. Only the routine is
 * sampled: successful requests (status below 400) and logs below warn.
 * Errors, warnings and failed requests are always kept.
 *
 * A kept event carries its `sampleRate`; the server counts it as 1/rate
 * events, so charts and totals stay right. The choice depends only on the
 * event id, so the SDK shipping a line live and the importer reading the
 * same line later (at the same rate) keep exactly the same lines.
 */
export function isSampleable(event: EventInput): boolean {
  if (event.type === 'request') return event.status < 400;
  return (normalizeLevel(event.level) ?? 30) < 40;
}

/** Whether the event with this id is in a sample of `rate` (0 to 1). */
export function inSample(id: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  // Ids are hashes or UUIDs: their leading hex digits are evenly spread.
  const hex = id.replace(/[^0-9a-f]/gi, '').slice(0, 8);
  const fraction = hex.length === 8 ? parseInt(hex, 16) / 0x1_0000_0000 : Math.random();
  return fraction < rate;
}

/**
 * Applies sampling to an event with its id: returns the event (marked with
 * its rate when it was sampled) or null when it falls outside the sample.
 */
export function sample<E extends EventInput>(
  event: E,
  id: string,
  rate: number | undefined,
): E | null {
  if (rate === undefined || rate >= 1 || !isSampleable(event)) return event;
  return inSample(id, rate) ? { ...event, sampleRate: rate } : null;
}

/** How many events one sampled event stands for (1 to 1000). */
export function sampleWeight(rate: number | undefined): number {
  if (rate === undefined || !(rate > 0) || rate >= 1) return 1;
  return Math.min(1000, Math.max(1, Math.round(1 / rate)));
}
