// Operator ruling "full graph" (estate#279, wicked-estate 0.28.0): estate PAGES a wide blast radius.
// A page carries `next_cursor` (null on the last page), and passing it back as `--cursor` returns the
// next rows of the SAME answer. `projectBlastRadius` read page 1 only, so a symbol with more
// dependents than one page silently lost the rest. Live shape (estate 0.28.0, 250 callers): page 1 =
// 235 rows, `truncated_dependents: 16`, `next_cursor: "p1.235.…"`; page 2 = 16 rows, cursor null.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { projectBlastRadius, readBlastRadiusPages, type Queryable } from '../src/projects/graph.js';
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

  it('the repo route\'s reader joins the pages too: every row, the last page\'s fields, the joined window', async () => {
    const { env } = pagedEstate([
      { target: 'charge', unresolved: 1, dependents: [hit('api', 1)], truncated_dependents: 1, next_cursor: 'c1', page: { count: 1, from: 0, total: 2 } },
      { target: 'charge', unresolved: 1, dependents: [hit('api', 2)], truncated_dependents: 0, next_cursor: null, page: { count: 1, from: 1, total: 2 } },
    ]);
    const out = await readBlastRadiusPages(env['WICKED_ESTATE_EXE']!, 'charge', q.dbPath, { timeout: 10_000 });
    expect((out['dependents'] as Array<{ name: string }>).map((d) => d.name)).toEqual(['f1', 'f2']);
    expect(out).toMatchObject({ unresolved: 1, truncated_dependents: 0, next_cursor: null, page: { count: 2, from: 0, total: 2 } });
  });
});

// crew#1556: estate checks freshness per reply page, including rows whose stale mark was budgeted out.
const freshness = (overrides: Record<string, unknown> = {}) => ({
  commits_behind: 0, indexing: [], roots: ['host/root'], stale_files: [], stale_files_total: 0,
  unindexed_files: null, checked_files: 1, not_file_backed: 0, ...overrides,
});

describe.skipIf(process.platform === 'win32')('blast freshness (crew#1555, crew#1556)', () => {
  it('merges earlier drift, page counts, worst lag, and whole-index counts', async () => {
    const { env } = pagedEstate([
      { dependents: [hit('api', 1)], next_cursor: 'c1', freshness: freshness({
        stale_files: [{ file: 'api/src/f1.ts', status: 'modified' }], stale_files_total: 1,
        checked_files: 2, not_file_backed: 1, unindexed_files: 7, indexing: ['api'],
      }) },
      { dependents: [hit('web', 2)], next_cursor: null, freshness: freshness({
        commits_behind: 3, unindexed_files: 2, indexing: ['api', 'web'], roots: ['last/root'],
      }) },
    ]);
    const out = await readBlastRadiusPages(env['WICKED_ESTATE_EXE']!, 'charge', q.dbPath, { timeout: 10_000 });
    expect(out['freshness']).toEqual(freshness({
      stale_files: [{ file: 'api/src/f1.ts', status: 'modified' }], stale_files_total: 1,
      checked_files: 3, not_file_backed: 1, commits_behind: 3, unindexed_files: 7,
      indexing: ['api', 'web'], roots: ['last/root'],
    }));
  });

  it("keeps unknown lag unknown and unions stale files in page order with estate's cap", async () => {
    const files = Array.from({ length: 22 }, (_, i) => ({ file: `api/f${i}.ts`, status: 'modified' }));
    const { env } = pagedEstate([
      { next_cursor: 'c1', freshness: freshness({ commits_behind: null, stale_files: files.slice(0, 15), stale_files_total: 15 }) },
      { freshness: freshness({ stale_files: [{ file: 'api/f0.ts', status: 'deleted' }, ...files.slice(15)], stale_files_total: 8 }) },
    ]);
    const out = await readBlastRadiusPages(env['WICKED_ESTATE_EXE']!, 'x', q.dbPath, { timeout: 10_000 });
    expect(out['freshness']).toMatchObject({ commits_behind: null, stale_files: files.slice(0, 20), stale_files_total: 23, unindexed_files: null });
  });

  it('leaves a single page verbatim, skips absent blocks, and preserves all-absent freshness', async () => {
    const page = { target: 'x', dependents: [], freshness: freshness({ commits_behind: null }) };
    const one = pagedEstate([page]);
    expect(await readBlastRadiusPages(one.env['WICKED_ESTATE_EXE']!, 'x', q.dbPath, { timeout: 10_000 })).toEqual(page);
    const partial = pagedEstate([{ next_cursor: 'c1', freshness: page.freshness }, { dependents: [] }]);
    expect((await readBlastRadiusPages(partial.env['WICKED_ESTATE_EXE']!, 'x', q.dbPath, { timeout: 10_000 }))['freshness']).toEqual(page.freshness);
    const absent = pagedEstate([{ next_cursor: 'c1' }, {}]);
    expect(await readBlastRadiusPages(absent.env['WICKED_ESTATE_EXE']!, 'x', q.dbPath, { timeout: 10_000 })).not.toHaveProperty('freshness');
  });

  it('attributes project drift, depth, resolved and coverage only to current members', async () => {
    const { env } = pagedEstate([{
      dependents: [{ ...hit('api', 1), depth: 2, stale: 'modified' }, { ...hit('web', 2), depth: 'bad', stale: 'bad' }],
      resolved: false, freshness: freshness({ stale_files: [
        { file: 'api/src/f1.ts', status: 'modified' }, { file: 'gone/src/a.ts', status: 'deleted' },
      ], stale_files_total: 2 }),
      link: [{ project: 'other', coverage: [{ label: 'api', links_in: 999 }] }, { project: 'p1', coverage: [
        { label: 'api', links_in: 2, links_out: 3, incomplete: true, package_imports: 4, manifests: 1, boundary_counts: { unknown: 2 } },
        { label: 'web' }, { label: 'gone', links_in: 99 },
      ] }],
    }]);
    const out = await projectBlastRadius(q, 'charge', env);
    expect(out.dependents[0]).toMatchObject({ depth: 2, stale: 'modified' });
    expect(out.dependents[1]).not.toHaveProperty('depth');
    expect(out.dependents[1]).not.toHaveProperty('stale');
    expect(out).toMatchObject({ resolved: false, freshness: { stale_files_total: 2, stale_files: [
      { repoId: 'repo-api', repo: 'api', file: 'src/f1.ts', status: 'modified' },
    ] }, coverage: [
      { repoId: 'repo-api', repo: 'api', links_in: 2, links_out: 3, incomplete: true, package_imports: 4, manifests: 1, boundary_counts: { unknown: 2 } },
      { repoId: 'repo-web', repo: 'web' },
    ] });
    expect(out.freshness).not.toHaveProperty('roots');
    const absent = pagedEstate([{ dependents: [] }]);
    const empty = await projectBlastRadius(q, 'x', absent.env);
    expect(empty).not.toHaveProperty('freshness');
    expect(empty).not.toHaveProperty('coverage');
  });
});
