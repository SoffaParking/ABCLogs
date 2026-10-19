import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ config, pool });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
