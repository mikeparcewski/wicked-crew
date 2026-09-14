// core#482 ship half — FIX-IT-ALL L10-8: `.wicked/checks.json` declares
// `test_targeted: ["node", "scripts/test-related.mjs", "{files}"]`; the engine's repo-checks floor
// splices WORKTREE-ROOT-relative paths into `{files}` and runs the argv from the root, at the creator's
// AND the verifier's floor (`full: false` — the full suite stays CI's PR gate). The mapper is the one
// deterministic translation from those paths to a `vitest related` invocation inside packages/crew:
//
//   - a diff with no file under packages/crew (docs, root files, another workspace) → a skip, exit 0,
//     no vitest spawned;
//   - a diff touching packages/crew → `npx vitest related --run --passWithNoTests <files relative to
//     packages/crew>` with cwd packages/crew (vitest resolves `related` against ITS root; without the
//     cwd crew's hermetic setup files are not loaded, with `--root` + root-relative files the prefix
//     doubles).
//
// Observed through the script's `--dry-run` plan so the test needs no import of a root .mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-related.mjs');

function dryRun(files: string[]): { skip?: string; argv?: string[]; cwd?: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', ...files], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as { skip?: string; argv?: string[]; cwd?: string };
}

describe('scripts/test-related.mjs — the test_targeted mapper', () => {
  it('.wicked/checks.json declares it as test_targeted with {files}, full: false', () => {
    const checks = JSON.parse(readFileSync(join(ROOT, '.wicked', 'checks.json'), 'utf8')) as {
      test_targeted?: string[];
      full?: boolean;
    };
    expect(checks.test_targeted).toEqual(['node', 'scripts/test-related.mjs', '{files}']);
    expect(checks.full).toBe(false);
  });

  it('a diff with no crew file → skip, exit 0, no vitest', () => {
    const plan = dryRun(['README.md', 'packages/crew-api-types/index.d.ts', '.wicked/checks.json']);
    expect(plan.argv).toBeUndefined();
    expect(plan.skip).toMatch(/no crew files touched/);
    const real = spawnSync(process.execPath, [SCRIPT, 'README.md'], { encoding: 'utf8' });
    expect(real.status).toBe(0);
    expect(real.stdout).toMatch(/^test-related: no crew files touched/);
  });

  it('a crew diff → vitest related inside packages/crew with the paths re-spelled', () => {
    const plan = dryRun([
      'packages/crew/src/api/requirements.ts',
      'README.md',
      './packages/crew/tests/requirements.test.ts',
      'packages\\crew\\src\\cli\\index.ts',
    ]);
    expect(plan.cwd).toBe('packages/crew');
    expect(plan.argv).toEqual([
      'npx',
      'vitest',
      'related',
      '--run',
      '--passWithNoTests',
      'src/api/requirements.ts',
      'tests/requirements.test.ts',
      'src/cli/index.ts',
    ]);
  });
});
