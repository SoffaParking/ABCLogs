// Bundles the SDK (with the shared helpers it uses) into one ESM and one
// CommonJS file with no runtime dependencies, then writes type declarations.
// CommonJS matters: many Node apps, and executables built with pkg, require().
import { execFileSync } from 'node:child_process';
import { copyFileSync, readdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
rmSync(`${root}dist`, { recursive: true, force: true });

const common = {
  entryPoints: [`${root}src/index.ts`],
  bundle: true,
  platform: 'node',
  target: 'node20',
  // Workspace packages are read from source, and bundled in.
  conditions: ['source'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'warning',
};
await build({ ...common, format: 'esm', outfile: `${root}dist/index.js` });
await build({ ...common, format: 'cjs', outfile: `${root}dist/index.cjs` });

execFileSync(
  process.execPath,
  [`${root}../../node_modules/typescript/bin/tsc`, '-p', `${root}tsconfig.build.json`],
  {
    stdio: 'inherit',
  },
);
// The public types live in index.d.ts alone (it imports nothing), so the same
// file serves require(), and the other modules' declarations are not shipped.
for (const name of readdirSync(`${root}dist`)) {
  if (name.endsWith('.d.ts') && name !== 'index.d.ts') rmSync(`${root}dist/${name}`);
}
copyFileSync(`${root}dist/index.d.ts`, `${root}dist/index.d.cts`);
