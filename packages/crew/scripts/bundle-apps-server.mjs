// bundle-apps-server.mjs: build the Apps standalone server (packages/apps-server) and carry its artifact in crew's
// dist (`dist/apps-server`), so an installed crew can produce a publish's image without the workspace
// (DES-APPS-001 §9.3 step 4). The host's TEST build (host.test.js, a framed-token seam) is never carried.
//
// Runs as part of `build:with-studio` (the release-shaped build). Cross-platform: pure Node fs, no shell.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/crew/scripts
const crewDir = resolve(here, '..');
const serverPkg = resolve(crewDir, '..', 'apps-server');
const dest = resolve(crewDir, 'dist', 'apps-server');

execFileSync(process.execPath, [resolve(serverPkg, 'scripts', 'build.mjs')], { stdio: 'inherit' });
const built = resolve(serverPkg, 'dist');
if (!existsSync(resolve(built, 'Dockerfile'))) throw new Error(`[bundle-apps-server] ${built} has no Dockerfile: the app server build failed`);
rmSync(dest, { recursive: true, force: true });
cpSync(built, dest, { recursive: true, filter: (src) => !src.endsWith('host.test.js') });
console.log(`[bundle-apps-server] ${built} -> ${dest}`);
