#!/usr/bin/env node
/**
 * Every dependency the publishable packages declare must be OBTAINABLE from the registry.
 *
 * # The defect this exists to catch (FINDING-096)
 *
 * `packages/crew` declared `agent-acp-bridges: ^1.0.0` — a workspace member that was never
 * published. It resolved fine in CI, in local dev, and in the release job's own test step, because
 * all three resolve workspace members from the workspace. The only place it failed was the one
 * place nobody looked:
 *
 *     $ npm install wicked-crew
 *     npm error 404  The requested resource 'agent-acp-bridges@^1.0.0' could not be found
 *
 * Every published wicked-crew, back through 0.3.x, was uninstallable. Six green release jobs and a
 * successful npm publish, for an artifact nobody could install.
 *
 * # Why this check and not a full clean-room install
 *
 * A full `npm install <tarball>` in a temp dir is the more faithful test and catches strictly more
 * (bad `files`, broken `main`, missing bins). It is also minutes of network per run, and FINDING-073
 * already put an entrypoint test on the `files`/`main` half. This targets the specific blind spot:
 * a declared dependency that the WORKSPACE can satisfy and the REGISTRY cannot.
 *
 * The rule is deliberately about obtainability, not about versions matching: `npm view <name>@<range>`
 * answers exactly "could an operator get this?", which is the question the workspace can never be
 * asked.
 *
 * Cross-platform: node and `node:path` rather than shell builtins, so this runs the same on
 * macOS, Linux and Windows. (`npm` itself needs `shell: true` on win32 — it is a `.cmd` shim there.)
 *
 *   node scripts/check-deps-obtainable.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/** Names declared inside this workspace — the set that can mask an unpublished dependency. */
function workspaceNames() {
  const names = new Map();
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const manifest = join(PACKAGES_DIR, entry, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.name) names.set(pkg.name, { dir: entry, private: pkg.private === true });
  }
  return names;
}

/** Can the registry serve this range? */
function obtainable(name, range) {
  const r = spawnSync('npm', ['view', `${name}@${range}`, 'version'], {
    encoding: 'utf8',
    // npm on Windows is a .cmd shim, which spawnSync cannot exec without a shell.
    shell: process.platform === 'win32',
  });
  if (r.error) return { ok: false, why: `could not run npm: ${r.error.message}` };
  if (r.status !== 0) {
    const err = `${r.stdout}${r.stderr}`;
    return { ok: false, why: /E404|404 Not Found/.test(err) ? 'not published' : err.trim().slice(0, 200) };
  }
  // A range with no matching version exits 0 with EMPTY stdout — the silent half of this check.
  const got = r.stdout.trim();
  return got.length > 0
    ? { ok: true, why: got.split('\n').pop() }
    : { ok: false, why: `published, but no version satisfies ${range}` };
}

const ws = workspaceNames();
const failures = [];
let checked = 0;

for (const meta of ws.values()) {
  if (meta.private) continue; // a private package is never installed by an operator
  const pkg = JSON.parse(readFileSync(join(PACKAGES_DIR, meta.dir, 'package.json'), 'utf8'));
  // devDependencies are deliberately out of scope: they are not installed by consumers.
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) };
  for (const [dep, range] of Object.entries(deps)) {
    if (range.startsWith('file:') || range.startsWith('workspace:')) {
      failures.push(`${pkg.name} -> ${dep}@${range}: a local path can never resolve for an operator`);
      continue;
    }
    checked += 1;
    const { ok, why } = obtainable(dep, range);
    if (!ok) {
      const inWorkspace = ws.has(dep) ? ' [declared in THIS workspace — that is why nothing caught it]' : '';
      failures.push(`${pkg.name} -> ${dep}@${range}: ${why}${inWorkspace}`);
    }
  }
}

console.log(`  checked ${checked} declared dependencies across ${ws.size} workspace packages`);
if (failures.length > 0) {
  console.error('\nUNOBTAINABLE DEPENDENCIES — the published package cannot be installed:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\n  An operator running `npm install` gets a 404 and no install at all. Publish the missing\n' +
      '  package, or stop depending on it. A workspace member is not a dependency an operator has.',
  );
  process.exit(1);
}
console.log('  ok — every declared dependency is obtainable from the registry');
