// crew#1223: the named-files deadline retry re-runs ONLY the files vitest named, so it may stand for the whole
// run only when every failure the first pass reported is a deadline failure, the named files reconcile with
// vitest's own `Test Files  N failed` count, and the summary reports no unhandled errors. Otherwise the first
// pass's exit is recorded as-is, with a WICKED-RETRY line naming the rule that refused. Driven through
// runTargeted's io seams; no vitest is spawned.
import { beforeAll, describe, expect, it } from 'vitest';

type RunResult = { status: number; output: string; spawnError: string | null };
interface TestRelated {
  RETRY_MARKER: string;
  runTargeted(
    files: string[],
    io: {
      run: (argv: string[], cwd: string) => Promise<RunResult>;
      build: (argv: string[], cwd: string) => Promise<RunResult>;
      cleanDist: () => void;
      out: (line: string) => void;
      err: (line: string) => void;
      host: () => Record<string, unknown>;
      coreDir: () => string | null;
      budgetS: number;
    },
  ): Promise<number>;
}

let mod: TestRelated;
beforeAll(async () => {
  const url = new URL('../../../scripts/test-related.mjs', import.meta.url).href;
  mod = (await import(/* @vite-ignore */ url)) as unknown as TestRelated;
});

const TIMEOUT_A = [' FAIL  tests/a.test.ts > slow', 'Error: Test timed out in 30000ms.'];
const ASSERT_B = [' FAIL  tests/b.test.ts > wrong', 'AssertionError: expected 1 to be 2 // Object.is equality'];
const pass: RunResult = { status: 0, output: ' Test Files  1 passed (1)', spawnError: null };

async function drive(firstOutput: string, rerun: RunResult = pass) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const results: RunResult[] = [{ status: 1, output: firstOutput, spawnError: null }, rerun];
  const code = await mod.runTargeted(['packages/crew/src/x.ts'], {
    run: async (argv) => {
      calls.push(argv);
      return results[Math.min(calls.length - 1, 1)]!;
    },
    build: async () => ({ status: 0, output: '', spawnError: null }),
    cleanDist: () => {},
    out: (l) => lines.push(l),
    err: () => {},
    host: () => ({}),
    coreDir: () => '/sibling/wicked-core',
    budgetS: 1800,
  });
  return { code, calls, text: lines.join('\n') };
}

describe('crew#1223 — the named-files retry needs a purely-deadline failure set', () => {
  it('an assertion failure beside a timeout in another file is recorded as-is, with no re-run', async () => {
    const out = [...TIMEOUT_A, '', ...ASSERT_B, '', ' Test Files  2 failed | 8 passed (10)'].join('\n');
    const r = await drive(out);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toContain(`${mod.RETRY_MARKER} none`);
    expect(r.text).toContain('not deadline failures');
  });

  it('a timeout plus an unhandled error vitest attributes to no file is recorded as-is', async () => {
    const out = [...TIMEOUT_A, '', ' Test Files  1 failed | 9 passed (10)', '      Errors  1 error'].join('\n');
    const r = await drive(out);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toContain('unhandled error');
  });

  it("a deadline marker in the Unhandled Errors section is not the last FAIL block's own", async () => {
    const out = [
      ...ASSERT_B,
      '⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
      'Error: Test timed out in 30000ms.',
      ' Test Files  1 failed (10)',
    ].join('\n');
    const r = await drive(out);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
  });

  it("FAIL headers fewer than the summary's failed-file count is recorded as-is", async () => {
    const out = [...TIMEOUT_A, '', ' Test Files  2 failed | 8 passed (10)'].join('\n');
    const r = await drive(out);
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toContain("summary counts 2 failed file(s) but 1 are named");
  });

  it('a pure deadline failure whose files reconcile is still re-run once, and exit 0 when the re-run passes', async () => {
    const out = [...TIMEOUT_A, '', ' Test Files  1 failed | 9 passed (10)'].join('\n');
    const r = await drive(out);
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toContain('--no-file-parallelism');
    expect(r.calls[1]).toContain('tests/a.test.ts');
  });

  it('a pure deadline failure that fails again on re-run keeps its non-zero exit', async () => {
    const out = [...TIMEOUT_A, '', ' Test Files  1 failed | 9 passed (10)'].join('\n');
    const r = await drive(out, { status: 1, output: '', spawnError: null });
    expect(r.code).toBe(1);
    expect(r.calls).toHaveLength(2);
  });
});
