// crew#1173 — the repo-checks floor leaves the cross-repo tests out, and says so; nothing else does.
//
// A few tests read the sibling wicked-core checkout (tests/support/core-checkout.ts). The floor runs
// `scripts/test-related.mjs` on a lone clone with no sibling, so those tests failed on every crew
// floor, base and head alike. The operator's ruling: CI runs them (it checks crew and core out as
// siblings), the floor leaves them out and prints one line saying what and why. Pinned here:
//   1. no checkout → `--tags-filter=!cross-repo` on the first run AND the retry, and one line naming
//      the count, the files and the reason;
//   2. a checkout → no filter and no line (CI and a developer with the sibling run everything);
//   3. the script's checkout test is the support module's resolver, candidate for candidate;
//   4. every test that reads the checkout carries the tag, on the test (the count is honest), and
//      the tag is what vitest is configured with.
//
// The script is a root-level `.mjs` outside this package's rootDir, so it is imported through a
// computed URL, as in test-related-load-tolerance.test.ts.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../vitest.config.js';
import { CORE_DIR, CREW_REPO_ROOT } from './support/core-checkout.js';

type RunResult = { status: number; output: string; spawnError: string | null };
interface TestRelated {
  CROSS_REPO_TAG: string;
  CROSS_REPO_FILTER: string[];
  coreCheckoutDir(opts?: { override?: string; repoRoot?: string }): string | null;
  crossRepoTests(crewDir?: string): { count: number; files: string[] };
  crossRepoLine(t: { count: number; files: string[] }): string;
  runTargeted(
    files: string[],
    io: {
      run: (argv: string[], cwd: string) => Promise<RunResult>;
      build?: (argv: string[], cwd: string) => Promise<RunResult>;
      cleanDist?: () => void;
      out: (line: string) => void;
      host?: () => Record<string, unknown>;
      now?: () => number;
      budgetS?: number;
      coreDir?: () => string | null;
      crossRepoTests?: () => { count: number; files: string[] };
    },
  ): Promise<number>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_DIR = resolve(HERE, '..');
/** The sibling directory's name, spelled so the one-resolver audit in core-checkout-policy.test.ts
 *  (which looks for the quoted segment) does not count this file: it tests the script's resolver,
 *  it is not one. */
const SIBLING = ['wicked', 'core'].join('-');

let mod: TestRelated;
beforeAll(async () => {
  const url = new URL('../../../scripts/test-related.mjs', import.meta.url).href;
  mod = (await import(/* @vite-ignore */ url)) as unknown as TestRelated;
});

const DEADLINE = [
  ' FAIL  tests/deliver-e2e.test.ts > a deliver flow',
  'Error: Test timed out in 30000ms.',
  ' Test Files  1 failed (40)',
].join('\n');

function recorder(coreDir: string | null, results: RunResult[]) {
  const calls: string[][] = [];
  const lines: string[] = [];
  let i = 0;
  return {
    calls,
    lines,
    io: {
      run: async (argv: string[]): Promise<RunResult> => {
        calls.push(argv);
        const r = results[Math.min(i, results.length - 1)]!;
        i += 1;
        return r;
      },
      build: async (): Promise<RunResult> => ({ status: 0, output: '', spawnError: null }),
      cleanDist: () => {},
      out: (line: string) => lines.push(line),
      host: () => ({ load1: 1, load5: 1, cpus: 1, loadPerCpu: 1, freeMemMb: 1, swapFreeMb: 1, swapUsedMb: 1 }),
      now: () => 0,
      budgetS: 1800,
      coreDir: () => coreDir,
      crossRepoTests: () => ({ count: 7, files: ['tests/a.test.ts', 'tests/b.test.ts'] }),
    },
  };
}

describe('the floor leaves the cross-repo tests out when there is no sibling checkout (crew#1173)', () => {
  it('no checkout: the filter rides the first run and the retry, and ONE line says what and why', async () => {
    const rec = recorder(null, [
      { status: 1, output: DEADLINE, spawnError: null },
      { status: 0, output: ' Test Files  1 passed (1)', spawnError: null },
    ]);
    expect(await mod.runTargeted(['packages/crew/src/api/routes.ts'], rec.io)).toBe(0);

    expect(rec.calls[0]).toEqual([
      'npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/api/routes.ts', '--tags-filter=!cross-repo',
    ]);
    expect(rec.calls[1]).toEqual([
      'npx', 'vitest', 'run', '--no-file-parallelism', '--tags-filter=!cross-repo', 'tests/deliver-e2e.test.ts',
    ]);
    const said = rec.lines.filter((l) => l.includes('cross-repo test'));
    expect(said).toEqual([
      'test-related: left out 7 cross-repo test(s) (vitest tag `cross-repo`, in tests/a.test.ts, tests/b.test.ts): ' +
        'no sibling wicked-core checkout; CI runs them (crew#1173).',
    ]);
    // Said before the tests run, and the host telemetry stays the last line.
    expect(rec.lines.indexOf(said[0]!)).toBeLessThan(rec.lines.findIndex((l) => l.includes('vitest related')));
    expect(rec.lines[rec.lines.length - 1]).toMatch(/^WICKED-HOST label=post /);
  });

  it('no checkout, whole-command retry: the filter is kept on the re-run too', async () => {
    const rec = recorder(null, [
      { status: 1, output: 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"', spawnError: null },
      { status: 0, output: '', spawnError: null },
    ]);
    expect(await mod.runTargeted(['packages/crew/src/x.ts'], rec.io)).toBe(0);
    expect(rec.calls[1]).toEqual([
      'npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/x.ts', '--tags-filter=!cross-repo', '--no-file-parallelism',
    ]);
  });

  it('a checkout: nothing is filtered and nothing is said — CI and a developer with the sibling run everything', async () => {
    const rec = recorder('/somewhere/core', [{ status: 0, output: '', spawnError: null }]);
    expect(await mod.runTargeted(['packages/crew/src/x.ts'], rec.io)).toBe(0);
    expect(rec.calls).toEqual([['npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/x.ts']]);
    expect(rec.lines.join('\n')).not.toContain('cross-repo');
  });

  it('a change with no crew file says nothing about cross-repo tests (nothing runs)', async () => {
    const rec = recorder(null, [{ status: 0, output: '', spawnError: null }]);
    expect(await mod.runTargeted(['README.md'], rec.io)).toBe(0);
    expect(rec.calls).toEqual([]);
    expect(rec.lines.join('\n')).not.toContain('cross-repo');
  });
});

describe("the script's checkout test is the support module's resolver", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crew-crossrepo-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const makeCore = (dir: string): string => {
    mkdirSync(join(dir, 'crates', 'wicked-core-ts'), { recursive: true });
    writeFileSync(join(dir, 'crates', 'wicked-core-ts', 'package.json'), '{}');
    return dir;
  };

  it('agrees with the support module (CORE_DIR) in THIS environment, checkout or not', () => {
    expect(mod.coreCheckoutDir()).toBe(CORE_DIR);
    // The support module and the script anchor on the same repo root.
    expect(mod.coreCheckoutDir({ repoRoot: CREW_REPO_ROOT, override: '' })).toBe(
      mod.coreCheckoutDir({ override: '' }),
    );
  });

  it('finds <repo>/../<sibling> and the nested <repo>/../../<sibling>, and only with the artifacts', () => {
    const flat = join(tmp, 'flat');
    const repo = join(flat, 'crew');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(flat, SIBLING));
    expect(mod.coreCheckoutDir({ repoRoot: repo, override: '' }), 'a bare directory is not a checkout').toBeNull();
    makeCore(join(flat, SIBLING));
    expect(mod.coreCheckoutDir({ repoRoot: repo, override: '' })).toBe(join(flat, SIBLING));

    const nested = join(tmp, 'nested');
    const deep = join(nested, 'ws', 'crew');
    mkdirSync(deep, { recursive: true });
    makeCore(join(nested, SIBLING));
    expect(mod.coreCheckoutDir({ repoRoot: deep, override: '' })).toBe(join(nested, SIBLING));
  });

  it('an explicit override is the ONLY candidate — an unusable one does not fall back to the sibling', () => {
    const root = join(tmp, 'override');
    const repo = join(root, 'crew');
    mkdirSync(repo, { recursive: true });
    makeCore(join(root, SIBLING));
    expect(mod.coreCheckoutDir({ repoRoot: repo, override: join(root, 'nope') })).toBeNull();
    const elsewhere = makeCore(join(tmp, 'elsewhere'));
    expect(mod.coreCheckoutDir({ repoRoot: repo, override: elsewhere })).toBe(elsewhere);
  });

  it('a RELATIVE override is read from packages/crew, where vitest and the support module run (review of #1183)', () => {
    const root = join(tmp, 'relative');
    const repo = join(root, 'crew');
    mkdirSync(join(repo, 'packages', 'crew'), { recursive: true });
    makeCore(join(root, SIBLING));
    // From packages/crew, three levels up is <root>; from the repo root it would be above <root>.
    const rel = join('..', '..', '..', SIBLING);
    expect(mod.coreCheckoutDir({ repoRoot: repo, override: rel })).toBe(join(root, SIBLING));
  });
});

describe('every test that reads the checkout is tagged cross-repo, on the test', () => {
  const testFiles = (): string[] => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walk(p) : /\.test\.ts$/.test(e) ? [p] : [];
      });
    return walk(HERE);
  };
  const READS_CHECKOUT = /\b(requireCoreDir|readCoreJson|resolveCoreDir)\(/;
  const TAG = /tags:\s*\[\s*['"]cross-repo['"]\s*\]/;

  it('a test file that reads the checkout carries the tag (or the floor would fail on it again)', () => {
    const untagged = testFiles()
      .filter((f) => READS_CHECKOUT.test(readFileSync(f, 'utf8')) && !TAG.test(readFileSync(f, 'utf8')))
      .map((f) => relative(CREW_DIR, f));
    expect(untagged).toEqual([]);
  });

  it('the tag sits on tests, never on a suite, so the count the floor prints is the number left out', () => {
    const onSuites = testFiles().flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /\bdescribe\b/.test(l) && TAG.test(l))
        .map((l) => `${relative(CREW_DIR, f)}: ${l.trim()}`),
    );
    expect(onSuites).toEqual([]);
  });

  it('counts the seven cross-repo tests crew has today, in their four files', () => {
    expect(mod.crossRepoTests(CREW_DIR)).toEqual({
      count: 7,
      files: [
        'tests/core-checkout-policy.test.ts',
        'tests/deliver-phase.test.ts',
        'tests/engine-range-admits-built.test.ts',
        'tests/state-home-subtrees.test.ts',
      ],
    });
  });

  it('the tag the script filters on is the one vitest is configured with', () => {
    expect(mod.CROSS_REPO_TAG).toBe('cross-repo');
    expect(mod.CROSS_REPO_FILTER).toEqual(['--tags-filter=!cross-repo']);
    expect((config.test?.tags ?? []).map((t) => t.name)).toContain(mod.CROSS_REPO_TAG);
  });
});
