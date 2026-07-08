// bundle-studio.mjs — build the studio SPA and copy its dist into the crew
// package so the published tarball (files: ["dist"]) carries the UI.
//
// Self-contained + order-independent (DES-STUDIO-SERVING-001 §2.3 shape 2,
// "Recommended"): it builds the studio itself, so it works regardless of
// workspace build order. Cross-platform: pure Node `fs` — NO shell cp/rm
// (repo CLAUDE.md cross-platform rule).
//
// Wiring: crew `build` = `tsc -p tsconfig.json && node scripts/bundle-studio.mjs`.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/crew/scripts
const crewDir = resolve(here, '..'); // packages/crew
const repoRoot = resolve(crewDir, '..', '..'); // repo root
const studioDist = resolve(repoRoot, 'packages', 'studio', 'dist');
const dest = resolve(crewDir, 'dist', 'studio');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log('[bundle-studio] building studio SPA (npm run -w packages/studio build)…');
execFileSync(npm, ['run', '-w', 'packages/studio', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (!existsSync(studioDist)) {
  throw new Error(
    `[bundle-studio] studio build did not produce ${studioDist}. ` +
      'Expected packages/studio/dist to exist after the studio build.',
  );
}

console.log(`[bundle-studio] copying ${studioDist} -> ${dest}`);
rmSync(dest, { recursive: true, force: true });
cpSync(studioDist, dest, { recursive: true });

console.log('[bundle-studio] done: studio bundle nested under packages/crew/dist/studio');
