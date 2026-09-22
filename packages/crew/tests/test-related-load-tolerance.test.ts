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
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'test-related.mjs');

/**
 * Vitest's own output, COLOURED, captured verbatim from
 * `CI=true FORCE_COLOR=1 npx vitest run <a test that blows its deadline>` in this package and
 * committed as a fixture. This is the input production actually hands the classifiers — the floor
 * runs checks with `CI=1`, and Windows colours by default — and it is the input the first cut of
 * #656 could not parse: hand-written plain-text fixtures passed while the real thing returned `[]`.
 * Regenerate with the command above if vitest's reporter changes.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const COLORED = readFileSync(join(HERE, 'fixtures', 'vitest-colored-failure-output.txt'), 'utf8');

type RunResult = { status: number; output: string; spawnError: string | null };
interface TestRelated {
  HOST_MARKER: string;
  RETRY_MARKER: string;
  stripAnsi(output: string): string;
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

  // ── The input production actually hands these functions (review of #656, defect 1) ───────────
  // The floor runs checks with `CI=1`, vitest colours on that, and Windows colours by default. `\s`
  // does not match `\x1b`, so `^\s*FAIL` matched nothing in production and the retry never fired —
  // while the hand-written plain-text fixtures above passed. Everything below runs on the real bytes.
  describe('COLOURED vitest output — the shape the floor actually produces', () => {
    // Passes on head too, by construction: it asserts a property of the FIXTURE, not of the code.
    // It ships because the two cases below are only worth anything while this one holds — a future
    // edit that "tidies" the escapes out of the fixture would make them green and blind again.
    it('the fixture really is coloured (a "tidied" fixture would make the guard vacuous again)', () => {
      expect(COLORED, 'regenerate with CI=true FORCE_COLOR=1 npx vitest run').toContain('[');
      expect(COLORED).toMatch(/\[[0-9;]*m\[[0-9;]*m FAIL /);
    });

    it('finds the failing file inside the escape codes', () => {
      expect(mod.failedTestFiles(COLORED)).toEqual(['tests/zz-probe-timeout.test.ts']);
    });

    // DISCLOSED: this one also passes on head. `retryableFailureReason` is unanchored and vitest does
    // not split the marker phrase with escapes, so colour never broke it — which is exactly why the
    // defect was invisible: the classifier said "retry" while the file finder returned nothing. It
    // ships as the control that pins that asymmetry, not as evidence of the fix.
    it('still classifies the deadline that output carries', () => {
      expect(mod.retryableFailureReason(COLORED)).toMatch(/in-suite deadline/);
    });

    it('RETRIES the named file — the end the whole fix exists for, on production-shaped input', async () => {
      const rec = recorder([
        { status: 1, output: COLORED, spawnError: null },
        { status: 0, output: ' Test Files  1 passed (1)', spawnError: null },
      ]);
      const code = await mod.runTargeted([CREW_FILE], rec.io);

      expect(code).toBe(0);
      expect(rec.calls, 'a coloured deadline must re-run the FILE, not the whole suite').toHaveLength(2);
      expect(rec.calls[1]!.argv).toEqual([
        'npx',
        'vitest',
        'run',
        '--no-file-parallelism',
        'tests/zz-probe-timeout.test.ts',
      ]);
      expect(rec.lines.join('\n')).not.toContain('named no test file');
    });

    it('stripAnsi removes styling and hyperlinks without touching plain text', () => {
      expect(mod.stripAnsi('plain FAIL tests/a.test.ts')).toBe('plain FAIL tests/a.test.ts');
      expect(mod.stripAnsi('[41m[1m FAIL [22m[49m tests/a.test.ts[2m > [22mx')).toBe(
        ' FAIL  tests/a.test.ts > x',
      );
      expect(mod.stripAnsi(']8;;file:///xlink]8;;')).toBe('link');
      expect(mod.stripAnsi(undefined as unknown as string)).toBe('');
    });
  });

  // Defect 2 of the same review. This one is a SOURCE-level guard, deliberately and with its limits
  // stated: the failure it prevents — `process.exit()` tearing down before node drains an
  // asynchronous piped stdout — only shows up under real pipe backpressure, which a unit test cannot
  // manufacture against this entry point (the fast paths print two lines, far under the 64 KiB pipe
  // buffer). What it does guarantee is that the discipline cannot be reintroduced silently. The
  // BEHAVIOURAL half is covered by the subprocess cases here and in the mapper test: with
  // `process.exitCode` the script must still exit with the right status and must still terminate —
  // a stray handle would hang them.
  it('the entry point sets process.exitCode and never calls process.exit (the last line is the telemetry)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // CODE only: the block carries a comment explaining why `process.exit()` is refused, and a
    // guard that its own rationale trips is a guard nobody can keep.
    const entry = src
      .slice(src.indexOf('const isMain'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(entry).toContain('process.exitCode = await runTargeted(files)');
    expect(entry, 'process.exit() can drop buffered stdout under pipe backpressure').not.toMatch(
      /process\.exit\s*\(/,
    );
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
