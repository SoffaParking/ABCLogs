import { createHash } from 'node:crypto';

/**
 * Node-only helpers, published as `@apiloupe/shared/node` so the main entry
 * stays free of Node built-ins and safe to bundle into the dashboard.
 */

/**
 * The event id for a log line: a hash of the line itself. The SDK's pino
 * destination and the importer both use it, so a line shipped live and the
 * same line imported from a file later are stored once.
 */
export function eventIdForLine(line: string): string {
  return createHash('sha256').update(line.trim()).digest('hex').slice(0, 32);
}
