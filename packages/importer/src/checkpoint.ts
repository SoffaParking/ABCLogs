import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where a CloudWatch import has got to: every event before `position` is stored. */
export interface Checkpoint {
  version: 1;
  source: CheckpointSource;
  position: string;
  updatedAt: string;
}

export interface CheckpointSource {
  logGroup: string;
  streamPrefix: string | null;
  filterPattern: string | null;
}

export function defaultCheckpointPath(source: CheckpointSource): string {
  const name = [source.logGroup, source.streamPrefix ?? '']
    .join('-')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `apiloupe-cloudwatch-${name || 'logs'}.checkpoint.json`;
}

export function readCheckpoint(file: string): Checkpoint | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as Checkpoint;
  if (parsed.version !== 1 || Number.isNaN(Date.parse(parsed.position))) {
    throw new Error(`${file} is not an apiloupe-import checkpoint`);
  }
  return parsed;
}

export function sameSource(a: CheckpointSource, b: CheckpointSource): boolean {
  return (
    a.logGroup === b.logGroup &&
    a.streamPrefix === b.streamPrefix &&
    a.filterPattern === b.filterPattern
  );
}

/**
 * Writes the checkpoint atomically: to a temporary file in the same
 * directory, then renamed over the old one, so a crash mid-write never
 * leaves a truncated checkpoint behind.
 */
export function writeCheckpoint(file: string, source: CheckpointSource, position: number): void {
  const checkpoint: Checkpoint = {
    version: 1,
    source,
    position: new Date(position).toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
  renameSync(temporary, file);
}
