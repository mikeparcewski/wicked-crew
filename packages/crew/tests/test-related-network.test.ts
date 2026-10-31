// wicked-core DES-FLOOR-CONTAINER — the container checks floor has no network, and leaves the network
// tests out; nothing else does.
//
// The repo-checks floor can run crew's checks in a fresh Linux container with `--network none`, and it
// sets WICKED_CHECKS_FLOOR=container inside. A test that installs from the npm registry (the installed
// MCP server's `npm ci`) cannot pass there. It carries the vitest tag `network`, and test-related.mjs,
// in that floor only, passes `--tags-filter=!network` (beside the cross-repo filter when that applies:
// vitest ANDs repeated flags) and prints ONE line naming what it left out. Pinned here:
//   1. in the container floor → the network filter rides the first run and the retry, with its line;
//   2. with no sibling checkout too → both filters and both lines;
//   3. anywhere else (CI, `npm test`, the macOS floor) → no network filter and no line;
//   4. the probe reads WICKED_CHECKS_FLOOR=container only;
//   5. every test of the registry-installing file carries the tag, and the tag is declared.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

type RunResult = { status: number; output: string; spawnError: string | null };
interface TestRelated {
  NETWORK_TAG: string;
  NETWORK_FILTER: string[];
  noNetwork(env?: Record<string, string | undefined>): boolean;
  networkTests(crewDir?: string): { count: number; files: string[] };
  networkLine(t: { count: number; files: string[] }): string;
  runTargeted(files: string[], io: Record<string, unknown>): Promise<number>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CREW_DIR = resolve(HERE, '..');

let mod: TestRelated;
beforeAll(async () => {
  const url = new URL('../../../scripts/test-related.mjs', import.meta.url).href;
  mod = (await import(/* @vite-ignore */ url)) as unknown as TestRelated;
});

const DEADLINE = [' FAIL  tests/deliver-e2e.test.ts > a deliver flow', 'Error: Test timed out in 30000ms.', ' Test Files  1 failed (40)'].join('\n');

function recorder(opts: { coreDir: string | null; offline: boolean }, results: RunResult[]) {
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
      err: () => {},
      host: () => ({ load1: 1, load5: 1, cpus: 1, loadPerCpu: 1, freeMemMb: 1, swapFreeMb: 1, swapUsedMb: 1 }),
      now: () => 0,
      budgetS: 1800,
      coreDir: () => opts.coreDir,
      crossRepoTests: () => ({ count: 7, files: ['tests/a.test.ts'] }),
      noNetwork: () => opts.offline,
      networkTests: () => ({ count: 5, files: ['tests/mcp-installed-server.test.ts'] }),
    },
  };
}

const NETWORK_LINE =
  'test-related: left out the tests tagged `network` (5 in the repository, in tests/mcp-installed-server.test.ts; ' +
  'only those this run selected were affected): the container checks floor has no network ' +
  '(WICKED_CHECKS_FLOOR=container); CI runs them.';

describe('the container floor leaves the network tests out (DES-FLOOR-CONTAINER)', () => {
  it('in the container floor: the filter rides the first run and the retry, and ONE line says what and why', async () => {
    const rec = recorder({ coreDir: '/somewhere/core', offline: true }, [
      { status: 1, output: DEADLINE, spawnError: null },
      { status: 0, output: ' Test Files  1 passed (1)', spawnError: null },
    ]);
    expect(await mod.runTargeted(['packages/crew/src/api/routes.ts'], rec.io)).toBe(0);
    expect(rec.calls[0]).toEqual([
      'npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/api/routes.ts', '--tags-filter=!network',
    ]);
    expect(rec.calls[1]).toEqual([
      'npx', 'vitest', 'run', '--no-file-parallelism', '--tags-filter=!network', 'tests/deliver-e2e.test.ts',
    ]);
    expect(rec.lines.filter((l) => l.includes('tagged `network`'))).toEqual([NETWORK_LINE]);
    expect(rec.lines[rec.lines.length - 1]).toMatch(/^WICKED-HOST label=post /);
  });

  it('in the container floor with no sibling checkout: both filters (vitest ANDs them) and both lines', async () => {
    const rec = recorder({ coreDir: null, offline: true }, [{ status: 0, output: '', spawnError: null }]);
    expect(await mod.runTargeted(['packages/crew/src/x.ts'], rec.io)).toBe(0);
    expect(rec.calls).toEqual([
      ['npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/x.ts', '--tags-filter=!cross-repo', '--tags-filter=!network'],
    ]);
    expect(rec.lines.some((l) => l.includes('cross-repo test'))).toBe(true);
    expect(rec.lines.filter((l) => l.includes('tagged `network`'))).toEqual([NETWORK_LINE]);
  });

  it('anywhere else: no network filter and nothing said', async () => {
    const rec = recorder({ coreDir: '/somewhere/core', offline: false }, [{ status: 0, output: '', spawnError: null }]);
    expect(await mod.runTargeted(['packages/crew/src/x.ts'], rec.io)).toBe(0);
    expect(rec.calls).toEqual([['npx', 'vitest', 'related', '--run', '--passWithNoTests', 'src/x.ts']]);
    expect(rec.lines.join('\n')).not.toContain('tagged `network`');
  });

  it('a caller that does not say runs with the network (the CLI passes the probe)', async () => {
    const rec = recorder({ coreDir: '/somewhere/core', offline: true }, [{ status: 0, output: '', spawnError: null }]);
    const io: Record<string, unknown> = { ...rec.io };
    delete io['noNetwork'];
    expect(await mod.runTargeted(['packages/crew/src/x.ts'], io)).toBe(0);
    expect(rec.calls[0]).not.toContain('--tags-filter=!network');
  });

  it('the probe reads WICKED_CHECKS_FLOOR=container and nothing else', () => {
    expect(mod.noNetwork({ WICKED_CHECKS_FLOOR: 'container' })).toBe(true);
    expect(mod.noNetwork({ WICKED_CHECKS_FLOOR: 'sandbox' })).toBe(false);
    expect(mod.noNetwork({})).toBe(false);
    expect(mod.NETWORK_FILTER).toEqual(['--tags-filter=!network']);
  });

  it('every test of the registry-installing file carries the tag in its own options, and the tag is declared', () => {
    const src = readFileSync(resolve(CREW_DIR, 'tests/mcp-installed-server.test.ts'), 'utf8');
    // Each test declaration, from `it(` to the start of its body: the options object sits between
    // the title and the body, so a tag in a comment or another call never counts for it.
    const heads = [...src.matchAll(/\bit(?:\.\w+)?\(([\s\S]*?)(?:async\s*)?\(\)\s*=>\s*\{/g)].map((m) => m[1]!);
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) {
      expect(head.replace(/\/\/[^\n]*/g, ''), head).toMatch(/\{\s*tags:\s*\[\s*'network'\s*\]\s*\}\s*,\s*$/);
    }
    const tagged = mod.networkTests(CREW_DIR);
    expect(tagged.files).toContain('tests/mcp-installed-server.test.ts');
    const tags = (config as { test?: { tags?: { name: string }[] } }).test?.tags ?? [];
    expect(tags.map((t) => t.name)).toContain(mod.NETWORK_TAG);
  });
});
