// build.mjs: the server artifact an Apps publish copies into its image context (crew's apps/publish/pack.ts).
//
//   dist/Dockerfile                          the product image (image/Dockerfile)
//   dist/server/lib/bundle/server.mjs        src/main.ts with crew's sources inlined (esbuild); libpg-query external
//   dist/server/node_modules/libpg-query/    its wasm build, from the workspace's lockfile
//   dist/server/shim/host.js, host.css       the in-process host (IIFE) and its rules
//   dist/server/shim/host.test.js            TESTS ONLY: the host with the framed-token seam on (never packed)
//   dist/runners/sqlite-runner.mjs           crew's SQLite reader (the driver resolves it three levels up)
//
// Cross-platform: pure Node fs, no shell.

import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const crew = resolve(pkg, '..', 'crew');
const { values } = parseArgs({ options: { outdir: { type: 'string' } } });
const dist = values.outdir === undefined ? join(pkg, 'dist') : resolve(values.outdir);
const require = createRequire(join(crew, 'package.json'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'server', 'shim'), { recursive: true });

await build({
  entryPoints: [join(pkg, 'src', 'main.ts')],
  outfile: join(dist, 'server', 'lib', 'bundle', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['libpg-query'],
  // Bundled CommonJS dependencies (mysql2, …) call require(): give the ESM bundle one.
  banner: { js: "import { createRequire as __wkCreateRequire } from 'node:module'; const require = __wkCreateRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});

// The framed-token seam belongs only to the apps-server test build, never crew's shipped artifact.
const hosts = values.outdir === undefined ? [['host.js', false], ['host.test.js', true]] : [['host.js', false]];
for (const [name, test] of hosts) {
  await build({
    entryPoints: [join(pkg, 'shim', 'host.ts')],
    outfile: join(dist, 'server', 'shim', name),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    define: { __WK_TEST_FRAMED_TOKEN__: test ? 'true' : 'false' },
    legalComments: 'none',
    logLevel: 'warning',
  });
}
cpSync(join(pkg, 'shim', 'host.css'), join(dist, 'server', 'shim', 'host.css'));

// The external packages and everything they need at run time (their `dependencies`, recursively), as the
// workspace's lockfile installed them.
const copied = new Set();
function copyPackage(name) {
  if (copied.has(name)) return;
  copied.add(name);
  const from = dirname(require.resolve(`${name}/package.json`));
  const pkgJson = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
  cpSync(from, join(dist, 'server', 'node_modules', name), { recursive: true, filter: (src) => !/[\\/]node_modules[\\/]/.test(src.slice(from.length)) });
  for (const dep of Object.keys(pkgJson.dependencies ?? {})) copyPackage(dep);
}
copyPackage('libpg-query');

mkdirSync(join(dist, 'runners'), { recursive: true });
cpSync(join(crew, 'runners', 'sqlite-runner.mjs'), join(dist, 'runners', 'sqlite-runner.mjs'));
cpSync(join(pkg, 'image', 'Dockerfile'), join(dist, 'Dockerfile'));

console.log(`[apps-server] built ${dist}`);
