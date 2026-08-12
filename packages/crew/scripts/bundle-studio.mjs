// bundle-studio.mjs — copy the wicked-studio DIST ARTIFACT into the crew
// package so the published tarball (files: ["dist"]) carries the UI.
//
// Since the #98 carve, wicked-studio is its own product
// (github.com/mikeparcewski/wicked-studio) and crew consumes it the way a
// control plane ships a default skin: as a BUILT ARTIFACT from the installed
// `wicked-studio` package (a devDependency of packages/crew, whose npm/git
// tarball ships `dist/` only — no source coupling in either direction; the
// only shared type surface is `wicked-crew-api-types`, which studio consumes
// as a published contract).
//
// Wiring (unchanged from task #84): crew's default `build` is `tsc` ONLY; this
// script runs via `build:with-studio`, the RELEASE-time build the CI/release
// workflows use so the published tarball still ships the UI. A crew built
// without it serves headless API+WS (server.ts degrades gracefully).
//
// Cross-platform: pure Node `fs` — NO shell cp/rm (repo CLAUDE.md rule).

import { createRequire } from 'node:module';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/crew/scripts
const crewDir = resolve(here, '..'); // packages/crew
const dest = resolve(crewDir, 'dist', 'studio');

// Resolve the installed wicked-studio package (hoisted or nested — let Node
// find it). require.resolve on the package.json works because wicked-studio
// declares no `exports` map; if it ever grows one, add `./package.json` to it.
const require = createRequire(resolve(crewDir, 'package.json'));
let studioPkgJson;
try {
  studioPkgJson = require.resolve('wicked-studio/package.json');
} catch {
  throw new Error(
    '[bundle-studio] the `wicked-studio` package is not installed. ' +
      'It is a devDependency of packages/crew — run `npm install` at the repo root first.',
  );
}
const studioDist = resolve(dirname(studioPkgJson), 'dist');

if (!existsSync(resolve(studioDist, 'index.html'))) {
  throw new Error(
    `[bundle-studio] ${studioDist}/index.html missing — the installed wicked-studio ` +
      'package carries no built dist. Its npm tarball ships dist/ and its git installs ' +
      'build one via the `prepare` hook, so an empty dist means the install is broken ' +
      '(reinstall) or the dependency points at a raw checkout that was never built.',
  );
}

console.log(`[bundle-studio] copying ${studioDist} -> ${dest}`);
rmSync(dest, { recursive: true, force: true });
cpSync(studioDist, dest, { recursive: true });

console.log('[bundle-studio] done: studio bundle nested under packages/crew/dist/studio');
