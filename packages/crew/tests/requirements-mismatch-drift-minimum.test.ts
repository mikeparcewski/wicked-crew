/**
 * Operator rulings 2026-11-06 on the requirements graph:
 *  - P2: a true requirement whose code is wrong counts; the mismatch is a finding on the row (`codeMismatch`),
 *    counted on the page (`mismatches`) and filterable (`?mismatch=yes|no`).
 *  - P1: the page says how old the code behind the listed build is (`codeDrift`), as the engine counted it.
 *  - P3 is withdrawn by J6 M1: the minimum is gone (a domain model has no share to reach). An engine before J6 C3
 *    still sends its `target` and `min_pct`; the page carries no minimum, and the label keeps its counts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeDriftOf,
  engineRowOf,
  forgetRequirementsReads,
  listRequirements,
  listRequirementsRead,
  coverageOf,
  retireRequirement,
  type EstateRequirementsRead,
  type RequirementsGraphReader,
} from '../src/api/requirements.js';
import type { RepoEntry } from '../src/core/types.js';

const live = { real_pct: 66, min_pct: 66, behavior_bearing: 3, real: 2, placeholders: 1, unmapped: 0, not_product: 5 };
const rule = (statement: string) => ({ id: 'RULE-1', statement, confidence: 0.9 });
const graph = {
  metadata: { coverage: live },
  domains: {
    src: {
      requirements: {
        'REQ-001': { title: 'clamp', status: 'active', business_rules: [rule('clamp bounds n to [lo, hi]')] },
        'REQ-002': { title: 'mean', status: 'active', business_rules: [rule('mean is sum over length')] },
        'REQ-003': { title: 'sum', status: 'active', business_rules: [rule('sum adds every element')] },
      },
    },
  },
};
const rows = {
  src: {
    'REQ-001': { real: true, uncounted: null, code_mismatch: null },
    'REQ-002': { real: true, uncounted: null, code_mismatch: '  inherits sum’s skip,\n so mean([2,4]) is 2 ' },
    'REQ-003': { real: true, uncounted: null, code_mismatch: 'the loop starts at index 1, so it skips the first element' },
  },
};
const HEAD = '1111111111111111111111111111111111111111';
const BUILT = '8cc32aabde358bf81042ed116623a51c0ef03a96';

describe('requirements: mismatches and code age (operator rulings 2026-11-06); no minimum (J6 M1)', () => {
  const roots: string[] = [];
  beforeEach(() => forgetRequirementsReads());
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });
  async function repo(): Promise<RepoEntry> {
    const root = await mkdtemp(join(tmpdir(), 'req-p123-'));
    roots.push(root);
    const db = join(root, '.codegraph', 'estate.db');
    await mkdir(join(root, '.codegraph'), { recursive: true });
    await writeFile(db, '', 'utf8');
    return { id: 'tiny', name: 'tiny', root_path: root, default_branch: 'main', registered_at: 0, code_graph_db: db };
  }
  function engine(extra: Partial<EstateRequirementsRead>): RequirementsGraphReader {
    return {
      async getRequirementsGraphForRepo() {
        return { graph, coverage: live, rows, ...extra } as EstateRequirementsRead;
      },
    };
  }
  const read = {
    build: { generation: 3, coverage: live },
    code: { built_from: { commit: BUILT, at: '2026-11-01T13:57:56-05:00', basis: 'build' }, head: HEAD, commits_behind: 69 },
    target: { repo: 66, daemon: 80 },
  };

  it('a row whose code does not meet it still counts, and carries the mismatch as a finding', async () => {
    const page = await listRequirements(await repo(), { offset: 0, limit: 10 }, engine(read));
    const sum = page!.items.find((i) => i.reqId === 'REQ-003')!;
    expect(sum.placeholder).toBe(false);
    expect(sum.risk).toBe(false);
    expect(sum.codeMismatch).toBe('the loop starts at index 1, so it skips the first element');
    expect(page!.items.find((i) => i.reqId === 'REQ-002')!.codeMismatch).toBe('inherits sum’s skip, so mean([2,4]) is 2');
    expect(page!.items.find((i) => i.reqId === 'REQ-001')!.codeMismatch).toBeNull();
    expect(page!.mismatches).toBe(2);
  });

  it('?mismatch=yes lists the findings, ?mismatch=no the others', async () => {
    const r = await repo();
    const yes = await listRequirements(r, { offset: 0, limit: 10, mismatch: 'yes' }, engine(read));
    expect(yes!.items.map((i) => i.reqId).sort()).toEqual(['REQ-002', 'REQ-003']);
    const no = await listRequirements(r, { offset: 0, limit: 10, mismatch: 'no' }, engine(read));
    expect(no!.items.map((i) => i.reqId)).toEqual(['REQ-001']);
  });

  it('the page says how old the code behind the build is, and carries no minimum though the engine sent its target', async () => {
    const page = await listRequirements(await repo(), { offset: 0, limit: 1 }, engine(read));
    expect(page!.codeDrift).toEqual({
      builtFromCommit: BUILT,
      builtAt: '2026-11-01T13:57:56-05:00',
      basis: 'build',
      commitsBehind: 69,
      headCommit: HEAD,
    });
    expect(page).not.toHaveProperty('minimum');
  });

  it('an older engine says nothing: no drift, no mismatch (never a guess)', async () => {
    const old = { src: { 'REQ-001': { real: true, uncounted: null }, 'REQ-002': { real: true, uncounted: null }, 'REQ-003': { real: true, uncounted: null } } };
    const page = await listRequirements(await repo(), { offset: 0, limit: 10 }, engine({ rows: old }));
    expect(page!.codeDrift).toBeNull();
    expect(page!.mismatches).toBe(0);
    expect(page!.items.every((i) => i.codeMismatch === null)).toBe(true);
  });

  it('drift parses defensively; the coverage label no longer needs a minimum', () => {
    expect(codeDriftOf({ built_from: { commit: 'not a sha', basis: 'build' } })).toBeNull();
    expect(codeDriftOf({ built_from: { commit: BUILT, basis: 'guess' } })).toBeNull();
    expect(codeDriftOf({ built_from: { commit: BUILT, basis: 'index', at: null }, commits_behind: null })).toEqual({
      builtFromCommit: BUILT, builtAt: null, basis: 'index', commitsBehind: null, headCommit: null,
    });
    // J6 M1: an engine after C3 sends no min_pct; the label stands on its counts. One out of range is left off.
    const noMin: Record<string, unknown> = { ...live };
    delete noMin['min_pct'];
    expect(coverageOf(noMin)).toEqual({ realPct: 66, behaviorBearing: 3, real: 2, placeholders: 1, unmapped: 0, notProduct: 5 });
    expect(coverageOf({ ...live, min_pct: 0 })).toEqual(coverageOf(noMin));
    expect(coverageOf(live)).toEqual({ ...coverageOf(noMin), minPct: 66 });
    expect(engineRowOf({ s: { R: { real: true, uncounted: null, code_mismatch: '   ' } } }, 's', 'R')).toEqual({
      real: true, uncounted: null, codeMismatch: null,
    });
  });

  it('a repository with no graph yet says how far it is, with no minimum', async () => {
    const r = await repo();
    const none: RequirementsGraphReader = {
      async getRequirementsGraphForRepo() {
        return { graph: null, coverage: { ...live, real_pct: 0, real: 0, placeholders: 0, unmapped: 3 }, target: { repo: null, daemon: 80 } } as unknown as EstateRequirementsRead;
      },
    };
    const out = await listRequirementsRead(r, { offset: 0, limit: 1 }, none);
    expect(out.page).toBeNull();
    expect(out).not.toHaveProperty('minimum');
    expect(out.coverage).toMatchObject({ realPct: 0, unmapped: 3 });
  });

  it('retireRequirement sends only a row whose code was deleted to the engine (wicked-core#1698)', async () => {
    const r = await repo();
    const calls: string[][] = [];
    const HELP = 'wicked-core domain-graph [--db <path>] --retire <domain>::<REQ-NNN>';
    const run = async (args: string[]) => { calls.push(args); return args.includes('--help') ? HELP : ''; };
    let reads = 0;
    let retired = false;
    const gone: RequirementsGraphReader = {
      async getRequirementsGraphForRepo() {
        reads += 1;
        const src = { ...graph.domains.src.requirements };
        if (retired) delete (src as Record<string, unknown>)['REQ-003'];
        return {
          graph: { ...graph, domains: { src: { requirements: src } } },
          coverage: live,
          rows: { src: { ...rows.src, 'REQ-003': { real: false, uncounted: 'unindexed', code_mismatch: null } } },
        } as EstateRequirementsRead;
      },
    };
    expect(await retireRequirement(r, 'src::REQ-001', gone, run)).toBe('not_unindexed');
    expect(await retireRequirement(r, 'src::REQ-404', gone, run)).toBe('not_found');
    expect(calls).toEqual([]);
    const okRun = async (args: string[]) => { await run(args); if (!args.includes('--help')) retired = true; return args.includes('--help') ? HELP : ''; };
    expect(await retireRequirement(r, 'src::REQ-003', gone, okRun)).toBe('retired');
    expect(calls).toEqual([['domain-graph', '--help'], ['domain-graph', '--db', r.code_graph_db, '--retire', 'src::REQ-003']]);
    // The next read asks the engine again and no longer lists it.
    const before = reads;
    const page = await listRequirements(r, { offset: 0, limit: 50 }, gone);
    expect(reads).toBe(before + 1);
    expect(page?.items.map((i) => i.key)).not.toContain('src::REQ-003');
  });

  it('retireRequirement never sends --retire to an engine that does not know it, and reads a refusal again', async () => {
    const r = await repo();
    const gone = engine({ rows: { src: { ...rows.src, 'REQ-003': { real: false, uncounted: 'unindexed', code_mismatch: null } } } });
    const calls: string[][] = [];
    const old = async (args: string[]) => { calls.push(args); return 'wicked-core domain-graph [--db <path>] [--out <F>]'; };
    expect(await retireRequirement(r, 'src::REQ-003', gone, old)).toBe('engine_too_old');
    expect(calls).toEqual([['domain-graph', '--help']]);
    // Another request retired it meanwhile: the engine refuses, the fresh read says it is gone.
    forgetRequirementsReads();
    let first = true;
    const raced: RequirementsGraphReader = {
      async getRequirementsGraphForRepo() {
        const read = await gone.getRequirementsGraphForRepo('tiny');
        if (first) { first = false; return read; }
        return { ...read, rows: { src: { ...rows.src } }, graph: { ...graph, domains: { src: { requirements: { 'REQ-001': graph.domains.src.requirements['REQ-001'] } } } } } as EstateRequirementsRead;
      },
    };
    const refusing = async (args: string[]) => {
      if (args.includes('--help')) return '--retire';
      throw new Error('domain-graph: src::REQ-003 not retired: the requirements graph has no src::REQ-003');
    };
    expect(await retireRequirement(r, 'src::REQ-003', raced, refusing)).toBe('not_found');
  });
});
