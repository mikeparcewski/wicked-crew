// crew#426 — the deliver preflight, DRIVEN FOR REAL against a crew-shaped npm workspace.
//
// A governed run that bumps an internal WORKSPACE package's version (here packages/crew-api-types)
// used to deliver a branch whose version-derived codegen (endpoint-manifest.json, the generated api
// tests) AND package-lock.json were STALE — the worktree has no node_modules, so nothing re-syncs
// the lockfile and the generators resolve the parent checkout's version. CI's install/drift checks
// then fail on the delivered PR. The fix is a preflight in `deliverPrScript` (BEFORE staging):
// `npm install` (re-syncs the lockfile to the worktree's own package.json) + the two `npm run`
// codegen commands (regenerate the version-stamped artifacts), so the commit carries all three at
// the bumped version.
//
// This suite reproduces the exact shape core leaves behind — a bare origin, a clone on `main`, a run
// worktree on `wicked/<id>` cut from the base tip with a CLEAN tree — but the repo is a crew-shaped
// npm workspace: a root package.json + committed package-lock.json, packages/crew-api-types with a
// version, and packages/crew whose `manifest:endpoints` / `generate:api-tests` scripts stamp that
// version into an endpoint-manifest.json and a generated test (the same version-derivation shape the
// real generators have — Part B: read the workspace-local package.json). The run bumps the api-types
// version and the REAL `deliverPrScript` runs; we assert the delivered branch on the bare origin
// carries all four versions in agreement and that a fresh `npm ci` on it succeeds.
//
// LOCAL bare remotes + a fake `gh` only — never a real GitHub PR. `gh` is a script on a PATH we
// control; the script runs as a login shell (`bash -lc`, the production invocation), so HOME points
// at a temp dir whose `.bash_profile` prepends the fake bin (sourced after /etc/profile's
// path_helper, so it wins).

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { deliverPrScript } from '../src/core/deliver.js';

const RUN_ID = 'c0de9e17-4326-4215-87c1-000000000426';

/** git with a hermetic identity — no dependence on the developer's ~/.gitconfig. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

interface Fixture {
  workdir: string;
  clone: string;
  origin: string;
  root: string;
}

const roots: string[] = [];

/**
 * A bare origin + a clone on `main` (a crew-shaped npm workspace, lockfile committed at 0.19.0) + a
 * run worktree on `wicked/<RUN_ID>` cut from the base tip with a clean tree.
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'crew-preflight-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');

  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');

  // --- a crew-shaped workspace ---
  writeJson(join(seed, 'package.json'), {
    name: 'fixture-workspace',
    private: true,
    version: '0.0.0',
    workspaces: ['packages/crew-api-types', 'packages/crew'],
  });
  mkdirSync(join(seed, 'packages', 'crew-api-types'), { recursive: true });
  writeJson(join(seed, 'packages', 'crew-api-types', 'package.json'), {
    name: 'wicked-crew-api-types',
    version: '0.19.0',
  });
  mkdirSync(join(seed, 'packages', 'crew', 'scripts'), { recursive: true });
  mkdirSync(join(seed, 'packages', 'crew', 'tests', 'generated'), { recursive: true });
  writeJson(join(seed, 'packages', 'crew', 'package.json'), {
    name: 'wicked-crew',
    private: true,
    dependencies: { 'wicked-crew-api-types': '*' },
    scripts: {
      'manifest:endpoints': 'node scripts/gen-manifest.mjs',
      'generate:api-tests': 'node scripts/gen-apitests.mjs',
    },
  });
  // The generators derive the version the SAME way the real ones do post-fix: read the
  // workspace-local packages/crew-api-types/package.json (no node_modules needed). Plain-node,
  // zero external deps, so the worktree runs them without an install of its own.
  writeFileSync(
    join(seed, 'packages', 'crew', 'scripts', 'gen-manifest.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../crew-api-types/package.json', import.meta.url)), 'utf8')).version;",
      "const out = fileURLToPath(new URL('../endpoint-manifest.json', import.meta.url));",
      "writeFileSync(out, JSON.stringify({ version: 1, apiTypesVersion: v, endpoints: [] }, null, 2) + '\\n');",
      'console.log(`wrote endpoint-manifest.json (wicked-crew-api-types ${v})`);',
    ].join('\n'),
  );
  writeFileSync(
    join(seed, 'packages', 'crew', 'scripts', 'gen-apitests.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { fileURLToPath } from 'node:url';",
      "const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../crew-api-types/package.json', import.meta.url)), 'utf8')).version;",
      "const out = fileURLToPath(new URL('../tests/generated/api-sample.generated.test.ts', import.meta.url));",
      "writeFileSync(out, `// GENERATED. Manifest: wicked-crew-api-types ${v}.\\n`);",
      'console.log(`wrote api-sample.generated.test.ts (wicked-crew-api-types ${v})`);',
    ].join('\n'),
  );
  // Committed artifacts, generated against 0.19.0 (the pre-bump state).
  writeJson(join(seed, 'packages', 'crew', 'endpoint-manifest.json'), {
    version: 1,
    apiTypesVersion: '0.19.0',
    endpoints: [],
  });
  writeFileSync(
    join(seed, 'packages', 'crew', 'tests', 'generated', 'api-sample.generated.test.ts'),
    '// GENERATED. Manifest: wicked-crew-api-types 0.19.0.\n',
  );
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');

  // Materialize a package-lock.json at 0.19.0 (offline: the only dep is the local workspace).
  execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: seed });

  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base: crew-shaped workspace at api-types 0.19.0');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');

  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');

  const workdir = join(root, RUN_ID);
  git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, 'main');
  return { workdir, clone, origin, root };
}

/**
 * Run the REAL deliver script in `workdir` as core does, with a fake `gh` + temp HOME.
 *
 * `extraEnv` is merged over the base env last — the offline test uses it to blackhole the npm
 * registry (`npm_config_registry` at an unreachable host) and prove the preflight's `npm install`
 * touches no registry for a workspace-internal bump.
 */
function runDeliver(
  fx: Fixture,
  intent?: string,
  extraEnv: Record<string, string> = {},
): { status: number; output: string } {
  const home = join(fx.root, 'home');
  const bin = join(fx.root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  api) echo tester;;',
      '  pr) echo "https://github.com/o/r/pull/426";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);

  const res = spawnSync('bash', ['-lc', deliverPrScript(intent)], {
    cwd: fx.workdir,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GH_ACCOUNT: '', ...extraEnv },
  });
  return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Check out `ref` from the bare origin into a fresh dir and return its path. */
function checkoutFromOrigin(fx: Fixture, ref: string): string {
  const dst = join(fx.root, `co-${ref.replace(/\W/g, '_')}`);
  execFileSync('git', ['clone', '-q', '--branch', ref, '--single-branch', fx.origin, dst]);
  return dst;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('deliver preflight — internal version bump propagates to codegen + lockfile (crew#426)', () => {
  it('regenerates codegen AND re-syncs the lockfile so the delivered branch is drift-free and npm-ci-clean', () => {
    const fx = fixture();
    // The run's work: bump the internal api-types package. Left UNCOMMITTED, exactly as an agent
    // leaves file edits (core#291's premise) — nothing regenerated, nothing re-locked.
    writeJson(join(fx.workdir, 'packages', 'crew-api-types', 'package.json'), {
      name: 'wicked-crew-api-types',
      version: '0.20.0',
    });

    const r = runDeliver(fx, 'add an API wire field (bumps api-types)');
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('https://github.com/o/r/pull/426');

    // Inspect the DELIVERED tree on the bare origin (not the worktree) — this is what the PR carries.
    const branch = `wicked/${RUN_ID}`;
    const show = (p: string): string => git(fx.origin, 'show', `${branch}:${p}`);
    const pkgVersion = JSON.parse(show('packages/crew-api-types/package.json')).version;
    const manifestVersion = JSON.parse(show('packages/crew/endpoint-manifest.json')).apiTypesVersion;
    const generated = show('packages/crew/tests/generated/api-sample.generated.test.ts');
    const lockVersion = JSON.parse(show('package-lock.json')).packages['packages/crew-api-types']
      .version;

    // (1) the source bump the run made.
    expect(pkgVersion).toBe('0.20.0');
    // (2) the version-derived codegen followed — the two files the old worktree left stale.
    expect(manifestVersion).toBe('0.20.0');
    expect(generated).toContain('wicked-crew-api-types 0.20.0');
    // (3) the lockfile followed — the third stale artifact, the one only `npm install` repairs.
    expect(lockVersion).toBe('0.20.0');
    // The anti-drift invariant: every version-derived artifact agrees with the source.
    expect(new Set([pkgVersion, manifestVersion, lockVersion]).size).toBe(1);

    // And it is genuinely installable from the lockfile — `npm ci` on the delivered branch succeeds
    // (the failure the issue reported), proving the lockfile ↔ package.json are in sync.
    const delivered = checkoutFromOrigin(fx, branch);
    const ci = spawnSync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: delivered,
      encoding: 'utf8',
    });
    expect(ci.status, `${ci.stdout ?? ''}${ci.stderr ?? ''}`).toBe(0);
  }, 120_000);

  it('touches NO registry for a workspace-internal bump — delivers drift-free with the registry unreachable (offline-safe)', () => {
    // The whole offline claim (crew#426): a per-run worktree is cold (no node_modules) and a
    // restricted network can reach no registry, yet the preflight `npm install --prefer-offline`
    // must still re-sync the lockfile. A workspace-INTERNAL version bump changes only a local
    // workspace link — there is no tarball to fetch — so the install needs neither the registry
    // NOR a warm cache. This test PROVES that by pointing npm at an unreachable registry
    // (`http://127.0.0.1:1/`, connection refused, retries off) for the whole deliver AND the
    // `npm ci` check. Without the fix's `--prefer-offline` (or if a future change reintroduced a
    // registry round-trip), this reddens with ECONNREFUSED. HOME is already a temp dir, so npm's
    // cache is cold too — the install leans on nothing external.
    const fx = fixture();
    writeJson(join(fx.workdir, 'packages', 'crew-api-types', 'package.json'), {
      name: 'wicked-crew-api-types',
      version: '0.20.0',
    });

    const offline = {
      npm_config_registry: 'http://127.0.0.1:1/',
      npm_config_fetch_retries: '0',
    };
    const r = runDeliver(fx, 'add an API wire field (bumps api-types)', offline);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('https://github.com/o/r/pull/426');
    // The tell-tale of a registry round-trip — must never appear for an internal bump.
    expect(r.output).not.toContain('ECONNREFUSED');

    const branch = `wicked/${RUN_ID}`;
    const show = (p: string): string => git(fx.origin, 'show', `${branch}:${p}`);
    const pkgVersion = JSON.parse(show('packages/crew-api-types/package.json')).version;
    const manifestVersion = JSON.parse(show('packages/crew/endpoint-manifest.json')).apiTypesVersion;
    const lockVersion = JSON.parse(show('package-lock.json')).packages['packages/crew-api-types']
      .version;
    expect(new Set([pkgVersion, manifestVersion, lockVersion]).size).toBe(1);
    expect(pkgVersion).toBe('0.20.0');

    // `npm ci` on the delivered branch ALSO succeeds with the registry unreachable.
    const delivered = checkoutFromOrigin(fx, branch);
    const ci = spawnSync('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: delivered,
      encoding: 'utf8',
      env: { ...process.env, ...offline },
    });
    expect(ci.status, `${ci.stdout ?? ''}${ci.stderr ?? ''}`).toBe(0);
  }, 120_000);

  it('is a NO-OP for a non-npm repo — no lockfile, nothing to re-sync (guard holds)', () => {
    // A plain git repo (no package.json / package-lock.json): the preflight guard must skip cleanly
    // and deliver exactly as before — the fix must not regress delivery for every non-crew repo.
    const root = mkdtempSync(join(tmpdir(), 'crew-preflight-plain-'));
    roots.push(root);
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-b', 'main', seed]);
    git(seed, 'config', 'user.email', 'seed@test');
    git(seed, 'config', 'user.name', 'seed');
    writeFileSync(join(seed, 'README.md'), 'plain repo\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'base');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', origin, clone]);
    git(clone, 'config', 'user.email', 'runner@test');
    git(clone, 'config', 'user.name', 'runner');
    git(clone, 'config', 'commit.gpgsign', 'false');
    const workdir = join(root, RUN_ID);
    git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, 'main');
    writeFileSync(join(workdir, 'doc.md'), 'the run wrote a doc\n');

    const r = runDeliver({ workdir, clone, origin, root }, 'edit a doc');
    expect(r.status, r.output).toBe(0);
    // No npm install ran (there was nothing to install), and the doc was delivered.
    expect(git(origin, 'show', `wicked/${RUN_ID}:doc.md`)).toContain('the run wrote a doc');
    expect(existsSync(join(workdir, 'node_modules'))).toBe(false);
  }, 60_000);

  it('is a NO-OP for a non-crew npm repo — a root lockfile alone must NOT trigger npm install (Copilot, crew#428)', () => {
    // The narrowing Copilot asked for: a generic npm repo (root package.json + committed
    // package-lock.json) that is NOT the crew workspace. The OLD guard ran `npm install` here — its
    // install-time scripts, latency, and (worst) a strand of an otherwise-deliverable run whose deps
    // are not cached under a restricted network. The crew-scoped guard must skip the whole preflight
    // and deliver exactly as a plain repo does.
    const root = mkdtempSync(join(tmpdir(), 'crew-preflight-noncrew-'));
    roots.push(root);
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['init', '-b', 'main', seed]);
    git(seed, 'config', 'user.email', 'seed@test');
    git(seed, 'config', 'user.name', 'seed');
    // A root npm package with a real committed lockfile but no packages/crew — the case the old
    // outer `[ -f package.json ] && [ -f package-lock.json ]` guard would have npm-installed.
    writeJson(join(seed, 'package.json'), { name: 'some-other-repo', version: '1.0.0', private: true });
    writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
    execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: seed });
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'base: a non-crew npm repo with a lockfile');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '-q', origin, clone]);
    git(clone, 'config', 'user.email', 'runner@test');
    git(clone, 'config', 'user.name', 'runner');
    git(clone, 'config', 'commit.gpgsign', 'false');
    const workdir = join(root, RUN_ID);
    git(clone, 'worktree', 'add', '-q', '-b', `wicked/${RUN_ID}`, workdir, 'main');
    writeFileSync(join(workdir, 'doc.md'), 'the run wrote a doc\n');

    const r = runDeliver({ workdir, clone, origin, root }, 'edit a doc');
    expect(r.status, r.output).toBe(0);
    // Delivered — and the crew-scoped guard skipped npm install: no node_modules materialized in the
    // cold worktree (the tell-tale that the preflight did NOT run for this non-crew repo).
    expect(git(origin, 'show', `wicked/${RUN_ID}:doc.md`)).toContain('the run wrote a doc');
    expect(existsSync(join(workdir, 'node_modules'))).toBe(false);
  }, 60_000);
});
