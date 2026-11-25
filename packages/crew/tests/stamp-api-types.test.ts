// The api-types stamp (coord ruling 2026-11-25, train 15): a feature PR tags what it adds to the
// contract `(api-types next)` and leaves the version alone; the train's crew version PR runs
// `npm run stamp:api-types -- <X.Y.Z>` once, and the release workflows run `--check`.
//
// Every case spawns the REAL script entry (`node scripts/stamp-api-types.mjs --root <fixture>`).
// The small fixture is a crew-shaped workspace whose lockfile npm itself wrote, so "the stamp's
// in-place lockfile edit is what npm would write" is checked by asking npm afterwards. The second
// fixture carries crew's own root manifest, workspace manifests and package-lock.json, so the edit
// is also checked against the lockfile shape this repo really has.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(REPO, 'scripts', 'stamp-api-types.mjs');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The fields these cases read from a package.json, a lockfile entry or the endpoint manifest. */
interface Manifest {
  version?: string;
  apiTypesVersion?: string;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packages?: Record<string, Manifest>;
}

function readJson(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(root: string, ...args: string[]) {
  return spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
}

/** Generators shaped like crew's: they read the version from packages/crew-api-types/package.json. */
function stubGenerators(root: string): Record<string, string> {
  const read =
    "const v = JSON.parse(readFileSync(fileURLToPath(new URL('../../crew-api-types/package.json', import.meta.url)), 'utf8')).version;";
  const head = "import { readFileSync, writeFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url';";
  mkdirSync(join(root, 'packages/crew/tests/generated'), { recursive: true });
  write(
    join(root, 'packages/crew/scripts/gen-manifest.mjs'),
    `${head}\n${read}\nwriteFileSync(fileURLToPath(new URL('../endpoint-manifest.json', import.meta.url)), JSON.stringify({ version: 1, apiTypesVersion: v, endpoints: [] }, null, 2) + '\\n');\n`,
  );
  write(
    join(root, 'packages/crew/scripts/gen-apitests.mjs'),
    `${head}\n${read}\nwriteFileSync(fileURLToPath(new URL('../tests/generated/api-sample.generated.test.ts', import.meta.url)), '// GENERATED. Manifest: wicked-crew-api-types ' + v + '.\\n');\n`,
  );
  return { 'manifest:endpoints': 'node scripts/gen-manifest.mjs', 'generate:api-tests': 'node scripts/gen-apitests.mjs' };
}

function commitAll(root: string, msg: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', msg);
}

function initGit(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@test');
  git(root, 'config', 'user.name', 'fixture');
  // The host's signing settings stay out of a throwaway repo.
  git(root, 'config', 'commit.gpgSign', 'false');
  git(root, 'config', 'tag.gpgSign', 'false');
}

/** A small crew-shaped workspace at api-types 0.19.0, its lockfile written by npm. */
function smallWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-stamp-'));
  roots.push(root);
  writeJson(join(root, 'package.json'), {
    name: 'fixture-workspace',
    private: true,
    version: '0.0.0',
    workspaces: ['packages/crew-api-types', 'packages/crew'],
  });
  writeJson(join(root, 'packages/crew-api-types/package.json'), { name: 'wicked-crew-api-types', version: '0.19.0' });
  write(
    join(root, 'packages/crew-api-types/index.d.ts'),
    [
      '/** A change tags what it adds `(api-types next)`: prose about the rule, never stamped. */',
      '/** (api-types 0.19.0) An old field. */',
      'export interface Old { a?: string }',
      '/** (api-types next, crew#1) A new field. */',
      'export interface New { b?: string }',
      '/** (crew#2, api-types next) Another. */',
      'export interface Other { c?: string }',
      '',
    ].join('\n'),
  );
  const scripts = stubGenerators(root);
  writeJson(join(root, 'packages/crew/package.json'), {
    name: 'wicked-crew',
    private: true,
    version: '0.18.0',
    devDependencies: { 'wicked-crew-api-types': '^0.19.0' },
    scripts,
  });
  write(join(root, 'packages/crew/src/api/routes.ts'), '// (api-types next) the route answers New.\nexport {};\n');
  write(join(root, 'packages/crew/tests/fixture.test.ts'), "// a fixture may spell 'api-types next' on purpose\n");
  write(join(root, 'CHANGELOG.md'), '## [Unreleased]\n- New (api-types next).\n');
  writeJson(join(root, 'packages/crew/endpoint-manifest.json'), { version: 1, apiTypesVersion: '0.19.0', endpoints: [] });
  write(join(root, 'packages/crew/tests/generated/api-sample.generated.test.ts'), '// GENERATED. Manifest: wicked-crew-api-types 0.19.0.\n');
  write(join(root, '.gitignore'), 'node_modules\n');
  // npm writes the lockfile (offline: the only dependency is the local workspace).
  execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: root, stdio: 'ignore' });
  initGit(root);
  commitAll(root, 'base: api-types 0.19.0 with two next tags');
  return root;
}

describe('npm run stamp:api-types -- <X.Y.Z>', () => {
  it('writes the version, the caret, the lockfile and every next tag, then runs both generators', () => {
    const root = smallWorkspace();
    const before = run(root, '--check');
    expect(before.status).toBe(1);
    expect(before.stderr).toContain("packages/crew-api-types/index.d.ts:4 still says 'api-types next'");
    expect(before.stderr).not.toContain('index.d.ts:1 ');

    const r = run(root, '0.20.0');
    expect(r.status, r.stderr).toBe(0);

    expect(readJson(join(root, 'packages/crew-api-types/package.json')).version).toBe('0.20.0');
    expect(readJson(join(root, 'packages/crew/package.json')).devDependencies?.['wicked-crew-api-types']).toBe('^0.20.0');
    const lock = readJson(join(root, 'package-lock.json'));
    expect(lock.packages?.['packages/crew-api-types']?.version).toBe('0.20.0');
    expect(lock.packages?.['packages/crew']?.devDependencies?.['wicked-crew-api-types']).toBe('^0.20.0');

    const types = readFileSync(join(root, 'packages/crew-api-types/index.d.ts'), 'utf8');
    expect(types).toContain('(api-types 0.20.0, crew#1) A new field.');
    expect(types).toContain('(crew#2, api-types 0.20.0) Another.');
    expect(types).toContain('(api-types 0.19.0) An old field.');
    expect(types).toContain('tags what it adds `(api-types next)`: prose');
    expect(readFileSync(join(root, 'packages/crew/src/api/routes.ts'), 'utf8')).toContain('(api-types 0.20.0) the route');
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('- New (api-types 0.20.0).');
    // Tests are not stamped.
    expect(readFileSync(join(root, 'packages/crew/tests/fixture.test.ts'), 'utf8')).toContain("'api-types next'");

    expect(readJson(join(root, 'packages/crew/endpoint-manifest.json')).apiTypesVersion).toBe('0.20.0');
    expect(readFileSync(join(root, 'packages/crew/tests/generated/api-sample.generated.test.ts'), 'utf8')).toContain('0.20.0');

    // npm agrees with the in-place lockfile edit: re-resolving it offline changes nothing.
    const stamped = readFileSync(join(root, 'package-lock.json'), 'utf8');
    execFileSync('npm', ['install', '--package-lock-only', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], {
      cwd: root,
      stdio: 'ignore',
    });
    expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(stamped);

    const after = run(root, '--check');
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toContain('wicked-crew-api-types 0.20.0 is stamped (api-types-v0.20.0 is not tagged yet)');
  });

  it('refuses a version that is not X.Y.Z or that moves the package back, and writes nothing', () => {
    const root = smallWorkspace();
    for (const bad of ['0.20', 'v0.20.0', '0.18.9']) {
      const r = run(root, bad);
      expect(r.status).toBe(1);
      expect(git(root, 'status', '--porcelain')).toBe('');
    }
    expect(run(root, '0.18.9').stderr).toContain('is at 0.19.0; 0.18.9 would move it back');
  });

  it("edits crew's real lockfile in exactly the two places that name the version", () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-stamp-real-'));
    roots.push(root);
    for (const f of ['package.json', 'package-lock.json', 'packages/crew-api-types/package.json', 'packages/apps-server/package.json']) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(join(REPO, f), join(root, f));
    }
    // crew's real manifest, with only its two generator scripts swapped for stubs.
    const crew = readJson(join(REPO, 'packages/crew/package.json'));
    writeJson(join(root, 'packages/crew/package.json'), { ...crew, scripts: { ...crew.scripts, ...stubGenerators(root) } });
    initGit(root);
    commitAll(root, 'crew at main');

    const version = readJson(join(root, 'packages/crew-api-types/package.json')).version ?? '';
    const [major, minor, patch] = version.split('.');
    const next = `${major}.${minor}.${Number(patch) + 1}`;
    const r = run(root, next);
    expect(r.status, r.stderr).toBe(0);

    const diff = git(root, 'diff', '-U0', '--', 'package-lock.json')
      .split('\n')
      .filter((l) => /^[-+] /.test(l));
    expect(diff).toEqual([
      `-        "wicked-crew-api-types": "^${version}",`,
      `+        "wicked-crew-api-types": "^${next}",`,
      `-      "version": "${version}",`,
      `+      "version": "${next}",`,
    ]);
    expect(run(root, '--check').status).toBe(0);
  });
});

describe('npm run stamp:api-types -- --check (the release guard)', () => {
  it('fails when the contract changed after its version was tagged, and passes once it is stamped', () => {
    const root = smallWorkspace();
    expect(run(root, '0.20.0').status).toBe(0);
    commitAll(root, 'stamp 0.20.0');
    git(root, 'tag', '-a', '-m', 'api-types 0.20.0', 'api-types-v0.20.0');
    expect(run(root, '--check').stdout).toContain('0.20.0 is stamped (matches api-types-v0.20.0)');

    // A feature PR after the release, tagged as the rule says, with no stamp.
    const types = join(root, 'packages/crew-api-types/index.d.ts');
    writeFileSync(types, `${readFileSync(types, 'utf8')}/** (api-types next) Later. */\nexport interface Later { d?: string }\n`);
    commitAll(root, 'feature: Later');
    const missed = run(root, '--check');
    expect(missed.status).toBe(1);
    expect(missed.stderr).toContain("still says 'api-types next'");

    // The same change with its tag removed by hand: the tree still differs from the published one.
    writeFileSync(types, readFileSync(types, 'utf8').replace('(api-types next) Later.', 'Later.'));
    commitAll(root, 'feature: untagged');
    const untagged = run(root, '--check');
    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toContain(
      'packages/crew-api-types changed since api-types-v0.20.0 was tagged (packages/crew-api-types/index.d.ts), and its version did not move',
    );

    expect(run(root, '0.21.0').status).toBe(0);
    expect(run(root, '--check').status).toBe(0);
  });

  it('fails when a caret or the lockfile does not name the version', () => {
    const root = smallWorkspace();
    expect(run(root, '0.20.0').status).toBe(0);
    const pj = join(root, 'packages/crew/package.json');
    const crew = readJson(pj);
    crew.devDependencies = { ...crew.devDependencies, 'wicked-crew-api-types': '^0.19.0' };
    writeJson(pj, crew);
    const r = run(root, '--check');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('packages/crew/package.json asks for wicked-crew-api-types ^0.19.0, not ^0.20.0');
  });
});
