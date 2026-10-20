// Run after `pnpm build`: checks what npm would ship. Both module formats
// load, there are no runtime dependencies, the type declarations stand alone,
// and the version the client reports matches package.json.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
const fail = (message) => {
  console.error(`check-package: ${message}`);
  process.exit(1);
};

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0)
  fail('it must have no runtime dependencies');

const cjs = createRequire(import.meta.url)(`${root}dist/index.cjs`);
const esm = await import(`${root}dist/index.js`);
for (const [format, mod] of [
  ['CommonJS', cjs],
  ['ESM', esm],
]) {
  if (typeof mod.createApiloupe !== 'function')
    fail(`${format} build does not export createApiloupe`);
  if (mod.createApiloupe({}).enabled !== false)
    fail(`${format} build: a client without a key must be off`);
}

for (const file of ['index.cjs', 'index.js']) {
  const code = readFileSync(`${root}dist/${file}`, 'utf8');
  const required = [...code.matchAll(/(?:require\(|from\s+)["']([^"']+)["']/g)].map((m) => m[1]);
  const external = required.filter((name) => !name.startsWith('node:'));
  if (external.length > 0)
    fail(`${file} imports ${external.join(', ')}; everything but Node built-ins must be bundled`);
  if (!code.includes(`apiloupe-node/${pkg.version}`) && !code.includes(`"${pkg.version}"`)) {
    fail(`${file} does not carry version ${pkg.version}; update VERSION in src/client.ts`);
  }
}

const types = readFileSync(`${root}dist/index.d.ts`, 'utf8');
if (/^\s*import\s|from\s+['"]/m.test(types)) fail('index.d.ts must not import anything');

console.log(`check-package: @apiloupe/node ${pkg.version} OK`);
