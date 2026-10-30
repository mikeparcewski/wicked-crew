// crew#1221: the floor's FULL `test` check (a power run at high rigor or above hands off on it) runs the
// whole suite through `scripts/test-related.mjs --all`, in the environment the targeted check gets: a clean
// `dist/` build first, the cross-repo filter (with its one disclosed line) when there is no sibling
// wicked-core checkout. Plain `vitest run` had neither the build nor the filter,
// so on the floor's lone checkout the base was always red and every such floor escalated
// `base_red_unseparated`. Nothing else is left out: the plan selects every test. It does not retry itself:
// the engine retries the check, and its retry never lets a scoped pass stand alone (review of #1222).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-related.mjs');

type RunResult = { status: number; output: string; spawnError: string | null };
type Plan = { skip?: string; refuse?: string; argv?: string[]; cwd?: string; retry?: boolean };
interface TestRelated {
  CROSS_REPO_FILTER: string[];
  planAll(files?: string[]): Plan;
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

const ok: RunResult = { status: 0, output: ' Test Files  409 passed (409)', spawnError: null };

function harness(coreDir: string | null, results: RunResult[]) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const order: string[] = [];
  const io = {
    plan: (files: string[]) => mod.planAll(files),
    run: async (argv: string[]) => {
      order.push('run');
      calls.push(argv);
      return results[Math.min(calls.length - 1, results.length - 1)]!;
    },
    build: async () => {
      order.push('build');
      return { status: 0, output: '', spawnError: null };
    },
    cleanDist: () => order.push('clean'),
    out: (l: string) => lines.push(l),
    err: () => {},
    host: () => ({}),
    now: () => 0,
    budgetS: 1800,
    coreDir: () => coreDir,
    crossRepoTests: () => ({ count: 3, files: ['tests/core-checkout-policy.test.ts'] }),
  };
  return { calls, lines, order, io };
}

describe('crew#1221 — the full-suite floor check', () => {
  it('.wicked/checks.json runs the full test check through the script, and re-runs its failing set with --tests', () => {
    const checks = JSON.parse(readFileSync(join(ROOT, '.wicked', 'checks.json'), 'utf8')) as {
      test?: string[];
      rerun?: Record<string, { command?: string[]; self_retry?: boolean }>;
    };
    expect(checks.test).toEqual(['node', 'scripts/test-related.mjs', '--all']);
    expect(checks.rerun?.['test']?.command).toEqual(['node', 'scripts/test-related.mjs', '--tests', '{files}']);
    // Not self_retry: `--all` records its exit as-is and the engine's retry decides.
    expect(checks.rerun?.['test']?.self_retry).toBeUndefined();
  });

  it('--all plans the whole suite (vitest run, no selection) inside packages/crew', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--all'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ argv: ['npx', 'vitest', 'run'], cwd: 'packages/crew', retry: false });
  });

  it('--all refuses a file list instead of ignoring it', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--all', 'tests/a.test.ts'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^test-related: `--all` runs the whole suite and takes no files/);
  });

  it('no checkout: a clean build first, then the whole suite with the cross-repo filter and the left-out line', async () => {
    const h = harness(null, [ok]);
    expect(await mod.runTargeted([], h.io)).toBe(0);
    expect(h.order).toEqual(['clean', 'build', 'run']);
    expect(h.calls).toEqual([['npx', 'vitest', 'run', ...mod.CROSS_REPO_FILTER]]);
    const leftOut = h.lines.filter((l) => l.startsWith('test-related: left out '));
    expect(leftOut).toHaveLength(1);
    expect(leftOut[0]).toContain('3 cross-repo test(s)');
    expect(leftOut[0]).toContain('tests/core-checkout-policy.test.ts');
  });

  it('a sibling checkout: the whole suite with no filter and no left-out line', async () => {
    const h = harness('/somewhere/wicked-core', [ok]);
    expect(await mod.runTargeted([], h.io)).toBe(0);
    expect(h.calls).toEqual([['npx', 'vitest', 'run']]);
    expect(h.lines.some((l) => l.startsWith('test-related: left out '))).toBe(false);
  });

  it('a deadline failure is recorded as-is too: the engine retries the check, not the script', async () => {
    const h = harness(null, [
      { status: 1, output: ' FAIL  tests/a.test.ts > x\nError: Test timed out in 30000ms.\n Test Files  1 failed (409)', spawnError: null },
      ok,
    ]);
    expect(await mod.runTargeted([], h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.lines.some((l) => l.startsWith('WICKED-RETRY none — the full suite does not retry itself'))).toBe(true);
  });

  it('an assertion failure beside a timeout is not re-run alone into a pass (review of #1222)', async () => {
    const mixed =
      ' FAIL  tests/a.test.ts > x\nAssertionError: expected 1 to be 2\n' +
      ' FAIL  tests/b.test.ts > y\nError: Test timed out in 30000ms.\n Test Files  2 failed (409)';
    const h = harness(null, [{ status: 1, output: mixed, spawnError: null }, ok]);
    expect(await mod.runTargeted([], h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('a worker death that names no file is recorded as-is (no serial or whole re-run inside the check)', async () => {
    const h = harness(null, [{ status: 1, output: '[vitest-worker]: Timeout calling "onTaskUpdate"', spawnError: null }, ok]);
    expect(await mod.runTargeted([], h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
  });

  it('a failed build fails the check even when the suite passes', async () => {
    const h = harness(null, [ok]);
    h.io.build = async () => {
      h.order.push('build');
      return { status: 2, output: 'error TS2322', spawnError: null };
    };
    expect(await mod.runTargeted([], h.io)).toBe(2);
    expect(h.calls).toHaveLength(1);
  });

  it('an assertion failure is recorded as-is, with no retry', async () => {
    const h = harness(null, [{ status: 1, output: ' FAIL  tests/a.test.ts > x\nAssertionError: expected 1 to be 2', spawnError: null }]);
    expect(await mod.runTargeted([], h.io)).toBe(1);
    expect(h.calls).toHaveLength(1);
  });
});
