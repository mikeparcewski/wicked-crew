/**
 * Operator rulings 2026-11-06 on the requirements graph:
 *  - P2: a true requirement whose code is wrong counts; the mismatch is a finding on the row (`codeMismatch`),
 *    counted on the page (`mismatches`) and filterable (`?mismatch=yes|no`).
 *  - P1: the page says how old the code behind the listed build is (`codeDrift`), as the engine counted it.
 *  - P3: the page says which minimum is in force and why (`minimum`), and the repository's own minimum can be set or
 *    cleared through the engine's own command (`setRepoMinimum`).
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
  minimumOf,
  setRepoMinimum,
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

describe('requirements: mismatches, code age and the minimum in force (operator rulings 2026-11-06)', () => {
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

  it('the page says how old the code behind the build is, and which minimum is in force', async () => {
    const page = await listRequirements(await repo(), { offset: 0, limit: 1 }, engine(read));
    expect(page!.codeDrift).toEqual({
      builtFromCommit: BUILT,
      builtAt: '2026-11-01T13:57:56-05:00',
      basis: 'build',
      commitsBehind: 69,
      headCommit: HEAD,
    });
    expect(page!.minimum).toEqual({ pct: 66, source: 'repo', repoPct: 66, settingsPct: 80 });
  });

  it('an older engine says nothing: no drift, no minimum, no mismatch (never a guess)', async () => {
    const old = { src: { 'REQ-001': { real: true, uncounted: null }, 'REQ-002': { real: true, uncounted: null }, 'REQ-003': { real: true, uncounted: null } } };
    const page = await listRequirements(await repo(), { offset: 0, limit: 10 }, engine({ rows: old }));
    expect(page!.codeDrift).toBeNull();
    expect(page!.minimum).toBeNull();
    expect(page!.mismatches).toBe(0);
    expect(page!.items.every((i) => i.codeMismatch === null)).toBe(true);
  });

  it('drift and minimum parse defensively', () => {
    expect(codeDriftOf({ built_from: { commit: 'not a sha', basis: 'build' } })).toBeNull();
    expect(codeDriftOf({ built_from: { commit: BUILT, basis: 'guess' } })).toBeNull();
    expect(codeDriftOf({ built_from: { commit: BUILT, basis: 'index', at: null }, commits_behind: null })).toEqual({
      builtFromCommit: BUILT, builtAt: null, basis: 'index', commitsBehind: null, headCommit: null,
    });
    expect(minimumOf({ repo: null, daemon: 80 }, null)).toEqual({ pct: 80, source: 'settings', repoPct: null, settingsPct: 80 });
    expect(minimumOf({ repo: 0, daemon: 101 }, null)).toBeNull();
    expect(engineRowOf({ s: { R: { real: true, uncounted: null, code_mismatch: '   ' } } }, 's', 'R')).toEqual({
      real: true, uncounted: null, codeMismatch: null,
    });
  });

  it('a repository with no graph yet still says which minimum it is held to', async () => {
    const r = await repo();
    const none: RequirementsGraphReader = {
      async getRequirementsGraphForRepo() {
        return { graph: null, coverage: { ...live, real_pct: 0, real: 0, placeholders: 0, unmapped: 3 }, target: { repo: null, daemon: 80 } } as unknown as EstateRequirementsRead;
      },
    };
    const out = await listRequirementsRead(r, { offset: 0, limit: 1 }, none);
    expect(out.page).toBeNull();
    expect(out.minimum).toEqual({ pct: 66, source: 'settings', repoPct: null, settingsPct: 80 });
  });

  it('setRepoMinimum runs the engine command against the repository store: set, clear, and nothing without a store', async () => {
    const r = await repo();
    const calls: string[][] = [];
    const run = async (args: string[]) => { calls.push(args); };
    expect(await setRepoMinimum(r, 90, run)).toBe(true);
    expect(await setRepoMinimum(r, null, run)).toBe(true);
    expect(calls).toEqual([
      ['requirements-target', '--db', r.code_graph_db, '--set', '90'],
      ['requirements-target', '--db', r.code_graph_db, '--clear'],
    ]);
    const bare: RepoEntry = { ...r, code_graph_db: join(r.root_path, 'none', 'estate.db') };
    expect(await setRepoMinimum(bare, 90, run)).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
