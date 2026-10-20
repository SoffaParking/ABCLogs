import type pg from 'pg';
import type { SetupGate } from './auth/setup.js';
import type { Config } from './config.js';
import type { IngestKeys } from './ingest/keys.js';
import type { Partitions } from './partitions.js';

/** What every route plugin needs. */
export interface AppContext {
  config: Config;
  pool: pg.Pool;
  partitions: Partitions;
  keys: IngestKeys;
  setup: SetupGate;
}
