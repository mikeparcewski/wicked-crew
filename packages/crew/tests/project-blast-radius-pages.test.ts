// Operator ruling "full graph" (estate#279, wicked-estate 0.28.0): estate PAGES a wide blast radius.
// A page carries `next_cursor` (null on the last page), and passing it back as `--cursor` returns the
// next rows of the SAME answer. `projectBlastRadius` read page 1 only, so a symbol with more
// dependents than one page silently lost the rest. Live shape (estate 0.28.0, 250 callers): page 1 =
// 235 rows, `truncated_dependents: 16`, `next_cursor: "p1.235.…"`; page 2 = 16 rows, cursor null.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { projectBlastRadius, type Queryable } from '../src/projects/graph.js';
import { removeScratch } from './setup/scratch.js';

const dir = mkdtempSync(join(tmpdir(), 'project-blast-pages-'));
afterAll(() => removeScratch(dir));

/** A fake estate serving `pages[k]` for `--cursor c<k>` (page 0 without one); logs each argv. */
function pagedEstate(pages: Array<Record<string, unknown>>): { env: NodeJS.ProcessEnv; calls: () => string[][] } {
  const tag = Math.random().toString(36).slice(2);
  const exe = join(dir, `estate-${tag}.mjs`);
  const log = join(dir, `calls-${tag}.jsonl`);
  writeFileSync(
    exe,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
const at = argv.indexOf('--cursor');
const k = at >= 0 ? Number(argv[at + 1].slice(1)) : 0;
const pages = ${JSON.stringify(pages)};
process.stdout.write(JSON.stringify(pages[k]));
`,
  );
  chmodSync(exe, 0o755);
  return {
    env: { ...process.env, WICKED_ESTATE_EXE: exe },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]),
  };
}

const q = {
  ok: true,
  dbPath: join(dir, 'graph.db'),
  labels: new Map([['api', 'repo-api'], ['web', 'repo-web']]),
  status: { projectId: 'p1', missingRepos: [] },
} as unknown as Extract<Queryable, { ok: true }>;

const hit = (repo: string, n: number) => ({ id: `sym ${repo}/f${n}`, name: `f${n}`, kind: 'Function', file: `${repo}/src/f${n}.ts`, line: n });

describe.skipIf(process.platform === 'win32')('projectBlastRadius follows estate\'s cursor to the end of the answer', () => {
  it('a 2-page answer returns every dependent, and the completeness causes are the last page\'s', async () => {
    const { env, calls } = pagedEstate([
      {
        target: 'charge', unresolved: 0, searched_depth: 12, depth_horizon_reached: false, node_cap_reached: false,
        dependents: [hit('api', 1), hit('api', 2)], truncated_dependents: 1, next_cursor: 'c1',
        page: { count: 2, from: 0, total: 3 },
      },
      {
        target: 'charge', unresolved: 0, searched_depth: 12, depth_horizon_reached: false, node_cap_reached: false,
        dependents: [hit('web', 3)], truncated_dependents: 0, next_cursor: null,
        page: { count: 1, from: 2, total: 3 },
      },
    ]);
    const out = await projectBlastRadius(q, 'charge', env);
    expect(out.dependents.map((d) => d.name)).toEqual(['f1', 'f2', 'f3']);
    expect(out.byRepo).toEqual([
      { repoId: 'repo-api', repo: 'api', count: 2 },
      { repoId: 'repo-web', repo: 'web', count: 1 },
    ]);
    // Nothing is left unread, so nothing reads as truncated.
    expect(out.truncated_dependents).toBe(0);
    const argvs = calls();
    expect(argvs).toHaveLength(2);
    expect(argvs[0]).not.toContain('--cursor');
    expect(argvs[1]?.slice(argvs[1].indexOf('--cursor'))).toEqual(['--cursor', 'c1']);
  });

  it('an estate that does not page (no next_cursor) is one call, unchanged', async () => {
    const { env, calls } = pagedEstate([
      { target: 'charge', unresolved: 0, dependents: [hit('api', 1)], truncated_dependents: 2 },
    ]);
    const out = await projectBlastRadius(q, 'charge', env);
    expect(out.dependents).toHaveLength(1);
    expect(out.truncated_dependents).toBe(2);
    expect(calls()).toHaveLength(1);
  });
});
