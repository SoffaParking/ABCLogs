// Run as its own process by unreachable.test.ts: does some work against a
// sender that cannot reach its server, then stops doing anything. The test
// measures how long the process takes to exit on its own.
import { createApiloupe } from '../../src/index.js';

const [endpoint, mode] = process.argv.slice(2);
const apiloupe = createApiloupe({
  endpoint,
  key: 'alk_abcdefgh_0123456789abcdefghijklmnopqrstuv',
  timeoutMs: 30_000,
});
const stream = apiloupe.pinoStream();
for (let i = 0; i < 2000; i++) {
  apiloupe.log('info', `line ${i}`);
  stream.write(`{"level":30,"time":${Date.now()},"msg":"pino ${i}"}\n`);
}
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED', reason);
  process.exitCode = 3;
});
if (mode === 'shutdown') {
  await apiloupe.shutdown(1000);
}
console.log('done');
