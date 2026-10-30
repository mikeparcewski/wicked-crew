// wicked-core#1198: when a test check fails, the engine's retry and its base comparison run ONLY the failing
// test files, through the command `.wicked/checks.json` declares under `rerun`. For `test` that is vitest
// itself over the files; for `test_targeted` it is this script's `--tests` mode, which runs the named files
// the way the targeted command runs its selection (clean build, cross-repo filter, one deadline retry), and
// `self_retry: true` tells the engine not to retry it a second time.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-related.mjs');

type RunResult = { status: number; output: string; spawnError: string | null };
type Plan = { skip?: string; refuse?: string; argv?: string[]; cwd?: string };
interface TestRelated {
  CROSS_REPO_FILTER: string[];
  planTests(files: string[]): Plan;
  runTargeted(
    files: string[],
    io: {
      plan?: (files: string[]) => Plan;
      run: (argv: string[], cwd: string) => Promise<RunResult>;
      build?: (argv: string[], cwd: string) => Promise<RunResult>;
      cleanDist?: () => void;
      out: (line: string) => void;
      err?: (line: string) => void;
      host?: () => Record<string, unknown>;
      now?: () => number;
      budgetS?: number;
      coreDir?: () => string | null;
      crossRepoTests?: () => { count: number; files: string[] };
    },
  ): Promise<number>;
}

let mod: TestRelated;
beforeAll(async () => {
  const url = new URL('../../../scripts/test-related.mjs', import.meta.url).href;
  mod = (await import(/* @vite-ignore */ url)) as unknown as TestRelated;
});

function dryRun(files: string[]): Plan {
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--tests', ...files], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Plan;
}

describe('wicked-core#1198 — the failing-set re-run', () => {
  it('.wicked/checks.json declares how test and test_targeted re-run their failing files', () => {
    const checks = JSON.parse(readFileSync(join(ROOT, '.wicked', 'checks.json'), 'utf8')) as {
      test?: string[];
      rerun?: Record<string, { command?: string[]; by?: string; root?: string; self_retry?: boolean }>;
    };
    // The same runner and environment as the check itself; only the selection differs.
    // crew#1221: the full suite runs through the script too (`--all`, which does not retry itself), so its
    // failing set re-runs through `--tests` (clean build, cross-repo filter) and the engine's retry decides.
    expect(checks.test).toEqual(['node', 'scripts/test-related.mjs', '--all']);
    expect(checks.rerun?.['test']).toEqual({
      command: ['node', 'scripts/test-related.mjs', '--tests', '{files}'],
      by: 'file',
      root: 'packages/crew',
    });
    expect(checks.rerun?.['test_targeted']).toEqual({
      command: ['node', 'scripts/test-related.mjs', '--tests', '{files}'],
      by: 'file',
      root: 'packages/crew',
      self_retry: true,
    });
    expect(Object.keys(checks.rerun ?? {}).sort()).toEqual(['test', 'test_targeted']);
  });

  it('--tests runs exactly the named files with vitest run inside packages/crew', () => {
    const plan = dryRun(['tests/a.test.ts', 'tests/integration/b.test.ts', 'tests\\c.spec.mjs']);
    expect(plan).toEqual({
      argv: ['npx', 'vitest', 'run', '--passWithNoTests', 'tests/a.test.ts', 'tests/integration/b.test.ts', 'tests/c.spec.mjs'],
      cwd: 'packages/crew',
    });
  });

  it('--tests refuses an empty or malformed list instead of passing it', () => {
    for (const bad of [[], ['-x.test.ts'], ['../a.test.ts'], ['tests/../a.test.ts'], ['/abs/a.test.ts'], ['src/a.ts'], ['tests/{x}.test.ts']]) {
      expect(dryRun(bad).refuse, JSON.stringify(bad)).toBeTruthy();
      const real = spawnSync(process.execPath, [SCRIPT, '--tests', ...bad], { encoding: 'utf8' });
      expect(real.status, JSON.stringify(bad)).toBe(2);
      expect(real.stdout).toMatch(/^test-related: (no test file named|not a test file)/);
    }
  });

  it('--tests builds first, keeps the cross-repo filter and retries a deadline failure once', async () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    let built = 0;
    const results: RunResult[] = [
      { status: 1, output: ' FAIL  tests/a.test.ts > x\nError: Test timed out in 30000ms.\n Test Files  1 failed (2)', spawnError: null },
      { status: 0, output: ' Test Files  1 passed (1)', spawnError: null },
    ];
    const code = await mod.runTargeted(['tests/a.test.ts', 'tests/b.test.ts'], {
      plan: mod.planTests,
      run: async (argv) => {
        calls.push(argv);
        return results[calls.length - 1]!;
      },
      build: async () => {
        built += 1;
        expect(calls).toHaveLength(0);
        return { status: 0, output: '', spawnError: null };
      },
      cleanDist: () => {},
      out: (l) => lines.push(l),
      err: () => {},
      host: () => ({}),
      now: () => 0,
      budgetS: 1800,
      coreDir: () => null,
      crossRepoTests: () => ({ count: 1, files: ['tests/x.test.ts'] }),
    });
    expect(code).toBe(0);
    expect(built).toBe(1);
    expect(calls[0]).toEqual(['npx', 'vitest', 'run', '--passWithNoTests', 'tests/a.test.ts', 'tests/b.test.ts', ...mod.CROSS_REPO_FILTER]);
    expect(calls[1]).toEqual(['npx', 'vitest', 'run', '--no-file-parallelism', ...mod.CROSS_REPO_FILTER, 'tests/a.test.ts']);
  });
});
