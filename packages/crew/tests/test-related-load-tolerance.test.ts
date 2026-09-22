// crew#649 — the `test_targeted` floor's verdict must describe the DIFF, not the host it ran on.
//
// The observed defect: on a loaded box vitest's workers miss the birpc deadline, die with
// `[vitest-worker]: Timeout calling "onTaskUpdate"`, and every test in that worker's file is
// recorded FAILED. The repo-checks floor then diffs head's failures against the base's and denies
// whatever is unique to head. Across seven attempts on one byte-stable diff the named failures never
// repeated, nine re-ran individually at exit 0, and the single attempt at load 23 passed — the
// verdict tracked ambient load.
//
// What is pinned here:
//   1. the retry is NARROW — a non-zero exit with no worker-IPC marker is recorded as-is, with no
//      second run (a tolerance that launders assertion failures is worse than the defect);
//   2. a worker-IPC death re-runs the NAMED FILES once, serially, and a clean re-run reports exit 0;
//   3. a re-run that fails again is recorded as the failure it is;
//   4. every invocation prints host load + free swap, and the LAST line it prints is that telemetry
//      — the floor keeps only the last 4 KiB of stdout, so a verdict at load 130 has to be
//      distinguishable in the ledger from the same verdict at load 10.
//
// The script is a root-level `.mjs` outside this package's rootDir, so it is imported through a
// computed URL (tsc does not resolve it; the shape below is the contract this test pins).

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-related.mjs');

type RunResult = { status: number; output: string; spawnError: string | null };
interface TestRelated {
  HOST_MARKER: string;
  RETRY_MARKER: string;
  retryableFailureReason(output: string): string | null;
  failedTestFiles(output: string): string[];
  formatHostLine(snap: Record<string, unknown>, label: string): string;
  hostSnapshot(): Record<string, unknown>;
  runTargeted(
    files: string[],
    io: {
      run: (argv: string[], cwd: string) => Promise<RunResult>;
      out: (line: string) => void;
      host?: () => Record<string, unknown>;
      now?: () => number;
      budgetS?: number;
    },
  ): Promise<number>;
}

let mod: TestRelated;
beforeAll(async () => {
  const url = new URL('../../../scripts/test-related.mjs', import.meta.url).href;
  mod = (await import(/* @vite-ignore */ url)) as unknown as TestRelated;
});

/** The verbatim tail from the run in #649 — the shape every one of those "regressions" carried. */
const IPC_DEATH_OUTPUT = [
  ' FAIL  tests/run-diff-base-route.test.ts > run diff base route',
  'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
  ' ❯ Object.onTimeoutError vitest/dist/chunks/rpc.js:48:16',
  ' ❯ listOnTimeout node:internal/timers:605:17',
  '',
  ' Test Files  1 failed (147)',
].join('\n');

/**
 * The OTHER contention shape, captured on this host at load 45 running the targeted check over an
 * UNMODIFIED tree: `evals-internal-corpus` — one of the tests #649 names as re-running at exit 0 —
 * blew its in-suite deadline twice, with no worker-IPC marker anywhere in the output.
 */
const DEADLINE_OUTPUT = [
  ' FAIL  tests/evals-internal-corpus.test.ts > pin — the constant resolved once > resolves every tag',
  'Error: Test timed out in 30000ms.',
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally.',
  '',
  ' Test Files  1 failed (109)',
].join('\n');

/** A genuine failure: an assertion, verbatim from this repo's reporter. */
const REAL_FAILURE_OUTPUT = [
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/zz-probe-fail.test.ts > probe fails on purpose',
  'AssertionError: expected 1 to be 2 // Object.is equality',
  ' ❯ tests/zz-probe-fail.test.ts:2:48',
  '',
  ' Test Files  1 failed (1)',
].join('\n');

const CREW_FILE = 'packages/crew/src/api/routes.ts';

/** A recorder for `runTargeted`'s io seam: every command it ran, and every line it printed. */
function recorder(results: RunResult[]) {
  const calls: { argv: string[]; cwd: string }[] = [];
  const lines: string[] = [];
  let i = 0;
  return {
    calls,
    lines,
    io: {
      run: async (argv: string[], cwd: string): Promise<RunResult> => {
        calls.push({ argv, cwd });
        const r = results[Math.min(i, results.length - 1)]!;
        i += 1;
        return r;
      },
      out: (line: string) => lines.push(line),
      host: () => ({ load1: 130.4, load5: 120, cpus: 12, loadPerCpu: 10.87, freeMemMb: 300, swapFreeMb: 12.5, swapUsedMb: 15800 }),
      now: () => 0,
      budgetS: 1800,
    },
  };
}

describe('crew#649 — the targeted check tolerates worker-IPC deaths and records the host', () => {
  it('classifies ONLY deadline failures as retryable — an assertion failure is not', () => {
    expect(mod.retryableFailureReason(IPC_DEATH_OUTPUT)).toMatch(/IPC deadline/);
    expect(mod.retryableFailureReason(DEADLINE_OUTPUT)).toMatch(/in-suite deadline/);
    expect(mod.retryableFailureReason(REAL_FAILURE_OUTPUT), 'an AssertionError is a verdict about the code').toBeNull();
    expect(mod.retryableFailureReason('')).toBeNull();
  });

  it('reads the failing test files off the reporter output', () => {
    expect(mod.failedTestFiles(IPC_DEATH_OUTPUT)).toEqual(['tests/run-diff-base-route.test.ts']);
    expect(mod.failedTestFiles(REAL_FAILURE_OUTPUT)).toEqual(['tests/zz-probe-fail.test.ts']);
    // A FAIL line that names something that is not a test file is not handed back to vitest.
    expect(mod.failedTestFiles(' FAIL  some-check')).toEqual([]);
  });

  it('a worker-IPC death re-runs the NAMED files once, serially, and a clean re-run reports exit 0', async () => {
    const rec = recorder([
      { status: 1, output: IPC_DEATH_OUTPUT, spawnError: null },
      { status: 0, output: ' Test Files  1 passed (1)', spawnError: null },
    ]);
    const code = await mod.runTargeted([CREW_FILE], rec.io);

    expect(code, 'a failure that does not reproduce on its own is not evidence').toBe(0);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]!.argv).toEqual(['npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/api/routes.ts']);
    expect(rec.calls[1]!.argv).toEqual(['npx', 'vitest', 'run', '--no-file-parallelism', 'tests/run-diff-base-route.test.ts']);
    expect(rec.lines.join('\n')).toContain(`${mod.RETRY_MARKER} the re-run passed`);
  });

  it('an in-suite deadline is re-run the same way — the marker is not the only contention shape', async () => {
    const rec = recorder([
      { status: 1, output: DEADLINE_OUTPUT, spawnError: null },
      { status: 0, output: ' Test Files  1 passed (1)', spawnError: null },
    ]);
    const code = await mod.runTargeted([CREW_FILE], rec.io);

    expect(code).toBe(0);
    expect(rec.calls[1]!.argv).toEqual([
      'npx',
      'vitest',
      'run',
      '--no-file-parallelism',
      'tests/evals-internal-corpus.test.ts',
    ]);
  });

  it('does NOT retry a real failure — one run, the exit code recorded as-is', async () => {
    const rec = recorder([{ status: 1, output: REAL_FAILURE_OUTPUT, spawnError: null }]);
    const code = await mod.runTargeted([CREW_FILE], rec.io);

    expect(code).toBe(1);
    expect(rec.calls, 'an assertion failure must never be re-run into a pass').toHaveLength(1);
    expect(rec.lines.join('\n')).toContain(`${mod.RETRY_MARKER} none`);
  });

  it('a re-run that fails AGAIN is recorded as the failure it is', async () => {
    const rec = recorder([
      { status: 1, output: IPC_DEATH_OUTPUT, spawnError: null },
      { status: 1, output: REAL_FAILURE_OUTPUT, spawnError: null },
    ]);
    const code = await mod.runTargeted([CREW_FILE], rec.io);

    expect(code).toBe(1);
    expect(rec.calls).toHaveLength(2);
    expect(rec.lines.join('\n')).toContain(`${mod.RETRY_MARKER} the re-run FAILED too`);
  });

  it('prints host load and free swap, and the LAST line is that telemetry (the floor keeps only the tail)', async () => {
    const rec = recorder([{ status: 0, output: 'ok', spawnError: null }]);
    const code = await mod.runTargeted([CREW_FILE], rec.io);

    expect(code).toBe(0);
    const pre = rec.lines.find((l) => l.startsWith(`${mod.HOST_MARKER} label=pre`));
    expect(pre, 'the conditions the check STARTED under').toBeDefined();
    expect(pre).toContain('load1=130.40');
    expect(pre).toContain('swapFreeMb=12.50');
    expect(rec.lines[rec.lines.length - 1]!.startsWith(`${mod.HOST_MARKER} label=post`)).toBe(true);
  });

  it('end to end: a real invocation prints a real host snapshot as its last line', () => {
    // The skip path (no crew file touched) — fast, spawns no vitest, and still has to say what the
    // host looked like: a verdict with no host record cannot be told apart from one taken at load 10.
    const r = spawnSync(process.execPath, [SCRIPT, 'README.md'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0], 'the skip line stays first — its prefix is pinned by the mapper test').toMatch(
      /^test-related: no crew files touched/,
    );
    const last = lines[lines.length - 1]!;
    expect(last).toMatch(/^WICKED-HOST label=post /);
    expect(last).toMatch(/load1=(\d+\.\d+|unknown)/);
    expect(last).toMatch(/loadPerCpu=(\d+\.\d+|unknown)/);
    expect(last).toMatch(/swapFreeMb=(\d+\.\d+|unknown)/);
  });
});
