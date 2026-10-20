import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { scheduleMaintenance } from './maintenance.js';
import { migrate } from './migrate.js';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('DATABASE_URL is required, e.g. postgres://user:password@localhost:5432/apiloupe');
  process.exit(1);
}
const pool = createPool(config.databaseUrl)!;
const app = await buildApp({ config, pool });

// Postgres may still be starting (a fresh container, a host reboot): keep
// trying for two minutes before giving up.
for (let attempt = 1; ; attempt++) {
  try {
    const applied = await migrate(pool);
    if (applied.length > 0) app.log.info({ applied }, 'database migrated');
    break;
  } catch (err) {
    if (attempt >= 24) {
      app.log.fatal({ err }, 'could not migrate the database');
      process.exit(1);
    }
    app.log.warn({ err: (err as Error).message, attempt }, 'database not ready, retrying in 5 s');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

const stopMaintenance = scheduleMaintenance(
  pool,
  app.ctx!.partitions,
  config.retentionDays,
  app.log,
);
// Prints the setup code when there are no users yet.
await app.ctx!.setup.required();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  stopMaintenance();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
