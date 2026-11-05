// DES-KNOWLEDGE-DATA-001 §9.1 (M6 part 1): an app's `recall` query reads the knowledge its OWN project may see, on the
// reserved source `estate`. Checked like every query (text, columns, parameters, a named source the project can see),
// read host side under the project's visible set, re-checked before release, studio-hosted only.

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { registerShapeRoutes } from '../src/knowledge/shapes/routes.js';
import type { Actor } from '../src/core/types.js';

import { recallProblem } from '../src/apps/exec/recall.js';
import { SPEC_SHAPE_GUIDE, turnProblem } from '../src/apps/turns.js';
import type { AppQuery, AppQueryResponse, AppSpec, ConformanceRule, KnowledgeSummaryResponse } from '../src/core/types.js';
import type { GateSource } from '../src/knowledge/gate/sources.js';
import { visibleDeps } from '../src/knowledge/package.js';
import { projectKnowledge } from '../src/knowledge/summary.js';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';

/** A registry source as the gate reads it (only what the predicate and the projection look at). */
function source(id: string, name: string, access: { see?: boolean; projects?: string[]; everyProject?: boolean; query?: boolean }, described = true): GateSource {
  return {
    id,
    name,
    enabled: true,
    queryable: true,
    access: { see: access.see ?? true, query: access.query ?? false, projects: access.projects ?? [], everyProject: access.everyProject ?? false },
    descriptorHash: `h-${id}`,
    description: described ? ({ catalog: { relations: [] }, describedAt: 1 } as never) : null,
    viewsAllowed: [],
    tools: [],
    address: {} as never,
    runtime: 'native',
    dialect: 'postgres',
    config: {} as never,
  } as unknown as GateSource;
}

interface Fake {
  sources: GateSource[];
  repos: Record<string, string[]>;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  visibleCalls: number;
  /** TESTS: narrow the set from the Nth read on (the release re-check). */
  narrowFrom: number | null;
  answers: Record<string, unknown>;
  rules: ConformanceRule[];
}

function fakeKnowledge(f: Fake) {
  return {
    sources: async () => f.sources,
    visible: async (projectId: string) => {
      f.visibleCalls++;
      const set = visibleDeps(f.sources, projectId, f.repos[projectId] ?? []);
      return f.narrowFrom !== null && f.visibleCalls >= f.narrowFrom ? set.filter((d) => d !== 'source:s-support') : set;
    },
    // estate here IGNORES `visible` and answers everything: only crew's own release re-check stands between a hidden
    // item and a tile (the negative control's point).
    estate: async (tool: string, args: Record<string, unknown>) => {
      f.calls.push({ tool, args });
      if (!(tool in f.answers)) throw new Error(`estate fake has no ${tool}`);
      const a = f.answers[tool];
      return typeof a === 'function' ? await (a as (x: Record<string, unknown>) => unknown)(args) : a;
    },
    rules: async () => f.rules,
  };
}

const rule = (id: string, steering_type: string, statement: string, extra: Partial<ConformanceRule> = {}): ConformanceRule =>
  ({ id, rule_type: 'policy', statement, severity: 'warn', confidence: 1, targets: {}, provenance: { source: 'ui', source_kinds: [] }, steering_type, ...extra }) as ConformanceRule;

const KNOWLEDGE_ITEMS = [
  { node_id: 'kdoc a', class: 'kdoc', label: 'Refund policy', body_snippet: 'Refunds over 500 need a second approver.', score: 0.9, source: 'docs/refunds.md', scope: 'wiki:billing', deps: [], untrusted: false },
  { node_id: 'kdoc synthetic source:s-support/support.tickets:', class: 'kdoc', label: 'support-pg · support.tickets', body_snippet: 'support.tickets: a table in data source support-pg.', score: 0.8, source: '', scope: 'source:s-support', deps: ['source:s-support'], untrusted: true },
  { node_id: 'kdoc synthetic source:s-hr/hr.salaries:', class: 'kdoc', label: 'hr-pg · hr.salaries', body_snippet: 'hr.salaries: a table in data source hr-pg.', score: 0.7, source: '', scope: 'source:s-hr', deps: ['source:s-hr'], untrusted: true },
  { node_id: 'kconcept other', class: 'kconcept', label: 'A note from another repo', body_snippet: 'about repo other', score: 0.6, source: 'x', scope: '', deps: ['repo:other'], untrusted: false },
];

const CATALOG = {
  generation: 3,
  pages: 1,
  docs: [
    { key: 'support.tickets', title: 'support-pg · support.tickets', entry: { kind: 'table', columns: [{ name: 'id' }, { name: 'region_id' }, { name: 'status' }] } },
    { key: 'support.regions', title: 'support-pg · support.regions', entry: { kind: 'table', columns: [{ name: 'id' }, { name: 'name' }] } },
  ],
};

const APPROVED = {
  proposals: [
    { id: 'p-1', state: 'approved', payload: { class: 'concept', content: 'support.tickets: ~12k rows; status has 3 values; joins support.regions on region_id.', shape: { sourceId: 's-support', relation: 'support.tickets', joins: [{ to: 'support.regions' }], describes: [{ repo: 'billing-api' }] } } },
    // A shape describing code in a repo the project does not hold: estate derives that repo into its deps, so it is hidden.
    { id: 'p-2', state: 'approved', payload: { class: 'concept', content: 'support.regions: describes code elsewhere', shape: { sourceId: 's-support', relation: 'support.regions', joins: [], describes: [{ repo: 'secret-repo' }] } } },
    { id: 'p-3', state: 'approved', payload: { class: 'concept', content: 'hr shape', shape: { sourceId: 's-hr', relation: 'hr.salaries', joins: [], describes: [] } } },
    // codex r1: a record that names only support-pg but whose node estate derived from hr-pg too (it relates to hr's
    // catalog): its record's metadata would pass; estate's own deps do not.
    { id: 'p-4', state: 'approved', payload: { class: 'concept', content: 'support.order-items: mentions hr.salaries columns', shape: { sourceId: 's-support', relation: 'support.order-items', joins: [], describes: [] } } },
    // A pending shape is never one (the queue filter is not trusted).
    { id: 'p-5', state: 'pending', payload: { class: 'concept', content: 'pending', shape: { sourceId: 's-support', relation: 'support.regions', joins: [], describes: [] } } },
  ],
};
/** Estate's own deps per shape node (what it derived at approve): what `knowledge.neighbors` answers for it. */
const SHAPE_DEPS: Record<string, string[]> = {
  'p-1': ['source:s-support', 'repo:billing-api'],
  'p-2': ['source:s-support', 'repo:secret-repo'],
  'p-3': ['source:s-hr'],
  'p-4': ['source:s-support', 'source:s-hr'],
  'p-5': ['source:s-support'],
};
const neighbors = (args: Record<string, unknown>) => {
  const id = String(args['id']);
  const pid = /proposal:(.+):$/.exec(id)?.[1] ?? '';
  const deps = SHAPE_DEPS[pid];
  // Estate's own answer for a hidden or unknown node.
  if (deps === undefined) throw new Error(`no visible knowledge node "${id}"`);
  // estate here IGNORES `visible` too: crew's re-check against the fresh set is what stands.
  return { nodes: [{ store: 'knowledge', id, class: 'kconcept', label: pid, deps }], edges: [], truncated: false };
};

function freshFake(): Fake {
  return {
    sources: [
      source('s-support', 'support-pg', { projects: ['p1'] }),
      source('s-hr', 'hr-pg', { projects: ['p2'] }),
      source('s-new', 'new-pg', { projects: ['p1'] }, false),
    ],
    repos: { p1: ['billing-api'] },
    calls: [],
    visibleCalls: 0,
    narrowFrom: null,
    answers: {
      'knowledge.recall': { items: KNOWLEDGE_ITEMS },
      // estate here answers a p2 memory (m3) and a cli-faceted one (m4) to a p1 recall: crew's own check drops them.
      'memory.recall': { items: [
        { memory_id: 'm1', scope: '', content: 'We decided refunds settle nightly.\nBecause the ledger batch runs at 02:00.', tier: 'semantic', score: 0.7 },
        { memory_id: 'm2', scope: '', content: 'Lesson: regions are keyed by id', tier: 'procedural', score: 0.5 },
        { memory_id: 'm3', scope: '', content: 'Project two decided refunds settle weekly', tier: 'semantic', score: 0.4 },
        { memory_id: 'm4', scope: '', content: 'Codex-only memory', tier: 'semantic', score: 0.3 },
      ] },
      'knowledge.source_catalog': (args: Record<string, unknown>) => {
        if (args['sourceId'] !== 's-support' || !(args['visible'] as string[]).includes('source:s-support')) throw new Error('no visible catalog for that source');
        return { sourceId: 's-support', ...CATALOG };
      },
      'proposal.list': APPROVED,
      'knowledge.neighbors': neighbors,
      'memory.list': { items: [
        { memory_id: 'm1', tier: 'semantic', facets: { project: 'p1' } },
        { memory_id: 'm2', tier: 'procedural', facets: {} },
        { memory_id: 'm3', tier: 'semantic', facets: { project: 'p2' } },
        { memory_id: 'm4', tier: 'semantic', facets: { project: 'p1', cli: 'codex' } },
        { memory_id: 'm5', tier: 'working', facets: { project: 'p1' } },
      ] },
    },
    rules: [
      rule('r1', 'security', 'Never log a card number'),
      rule('r2', 'security', 'Refunds over 500 need a second approver', { severity: 'error' }),
      rule('r3', 'testing', 'Every refund path has a test'),
      rule('r4', 'testing', 'A rule of project p2 only', { targets: { project: 'p2' } }),
      rule('r5', 'architecture', 'Retired rule', { retired: true }),
    ],
  };
}

const q = (id: string, output: AppQuery['output'], extra: Partial<AppQuery> = {}): AppQuery => ({ id, source: 'estate', kind: 'recall', output, ...extra });
const S = (name: string, nullable = false) => ({ name, type: 'string' as const, ...(nullable ? { nullable: true } : {}) });

describe('recall: what the declaration and the text must hold (unit)', () => {
  it('needs the fields its from needs, a group it allows, a subset of its columns with crew\'s types, and only the query\'s string parameter', () => {
    expect(recallProblem({ output: [S('title')] }, { from: 'tables' })).toMatch(/names its source/);
    expect(recallProblem({ output: [S('title')], params: { type: 'object', properties: { q: { type: 'string' } } } }, { from: 'tables', source: 'support-pg', query: { kind: 'param', name: 'q' } })).toMatch(/takes no query/);
    expect(recallProblem({ output: [{ name: 'joins', type: 'integer' }] }, { from: 'tables', source: 'support-pg' })).toMatch(/no column "joins"/);
    expect(recallProblem({ output: [S('title')] }, { from: 'memories' })).toMatch(/needs a query/);
    expect(recallProblem({ output: [S('title')] }, { from: 'steering', source: 'support-pg' })).toMatch(/names no source/);
    expect(recallProblem({ output: [S('key')] }, { from: 'memories', query: { kind: 'literal', value: 'x' }, group: 'severity' })).toMatch(/groups by kind/);
    expect(recallProblem({ output: [S('salary')] }, { from: 'steering' })).toMatch(/no column "salary"/);
    expect(recallProblem({ output: [{ name: 'score', type: 'integer' }] }, { from: 'knowledge', query: { kind: 'literal', value: 'x' } })).toMatch(/number, not integer/);
    expect(recallProblem({ output: [S('source')] }, { from: 'knowledge', query: { kind: 'literal', value: 'x' } })).toMatch(/nullable/);
    expect(recallProblem({ output: [S('key'), { name: 'count', type: 'integer' }] }, { from: 'steering', group: 'kind' })).toBeNull();
    expect(recallProblem({ output: [S('title')], params: { type: 'object', properties: { q: { type: 'integer' } } } }, { from: 'memories', query: { kind: 'param', name: 'q' } })).toMatch(/string/);
    expect(recallProblem({ output: [S('title')], params: { type: 'object', properties: { q: { type: 'string' }, extra: { type: 'string' } } } }, { from: 'memories', query: { kind: 'param', name: 'q' } })).toMatch(/extra is not used/);
    expect(recallProblem({ output: [S('title')], params: { type: 'object', properties: { q: { type: 'string', from: 'viewer.email' } } } }, { from: 'memories', query: { kind: 'param', name: 'q' } })).toMatch(/never comes from the viewer/);
    expect(recallProblem({ output: [S('title')], rowPath: '$.x' }, { from: 'steering' })).toMatch(/no row or more path/);
  });
});

describe('recall queries through the check and the executor (the app\'s project, its visible set)', () => {
  let h: Harness;
  let f: Fake;
  const knowledgeQueries: AppQuery[] = [
    q('found', [S('title'), S('kind'), S('cite'), S('source', true), { name: 'untrusted', type: 'boolean' }]),
    q('from_support', [S('title'), S('kind')]),
    q('remembered', [S('title'), S('content'), S('kind'), S('cite')]),
    q('memory_kinds', [S('key'), { name: 'count', type: 'integer' }]),
    q('rules', [S('title'), S('kind'), S('severity'), S('cite')]),
    q('rules_by_type', [S('key'), { name: 'count', type: 'integer' }]),
    q('refund_rules', [S('title')], { params: { type: 'object', properties: { words: { type: 'string', default: 'refund' } } } }),
    q('tables', [S('title'), S('content'), { name: 'columns', type: 'integer' }, S('shape', true), S('cite')]),
    q('rule_titles', [S('title'), S('cite')]),
    q('table_kinds', [S('key'), { name: 'count', type: 'integer' }]),
  ];
  const texts: Record<string, string> = {
    found: JSON.stringify({ from: 'knowledge', query: { kind: 'literal', value: 'refunds tickets' } }),
    from_support: JSON.stringify({ from: 'knowledge', query: { kind: 'literal', value: 'tickets' }, source: 'support-pg' }),
    remembered: JSON.stringify({ from: 'memories', query: { kind: 'literal', value: 'decisions' } }),
    memory_kinds: JSON.stringify({ from: 'memories', query: { kind: 'literal', value: 'decisions' }, group: 'kind' }),
    rules: JSON.stringify({ from: 'steering' }),
    rules_by_type: JSON.stringify({ from: 'steering', group: 'kind' }),
    refund_rules: JSON.stringify({ from: 'steering', query: { kind: 'param', name: 'words' } }),
    tables: JSON.stringify({ from: 'tables', source: 'support-pg' }),
    rule_titles: JSON.stringify({ from: 'steering' }),
    table_kinds: JSON.stringify({ from: 'tables', source: 'support-pg', group: 'kind' }),
  };
  beforeAll(async () => {
    f = freshFake();
    h = await appsHarness({ knowledge: fakeKnowledge(f) });
    await h.newApp('know');
    const r = await h.land('know', specWith(knowledgeQueries), texts);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  const run = async (id: string, params?: Record<string, unknown>): Promise<AppQueryResponse> => {
    const r = await h.call('POST', '/apps/know/query', { version: 2, query: id, ...(params !== undefined ? { params } : {}) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as unknown as AppQueryResponse;
  };

  it('the lock pins source estate and every recall query', async () => {
    const d = await h.store.detail('know');
    expect(d.head.receipt).not.toBeNull();
    const lock = (await h.store.acceptedFiles('know', 2)).files.lock;
    expect(lock.sources['estate']).toMatchObject({ kind: 'estate' });
    expect(Object.keys(lock.queries).sort()).toEqual(knowledgeQueries.map((x) => x.id).sort());
  });

  it('NEGATIVE CONTROL: a knowledge tile never shows an item from a source or repo outside the app project\'s visible set, even when estate answers it', async () => {
    const body = await run('found');
    const titles = body.rows.map((r) => r[0]);
    expect(titles).toEqual(['Refund policy', 'support-pg · support.tickets']);
    expect(titles).not.toContain('hr-pg · hr.salaries');
    expect(titles).not.toContain('A note from another repo');
    // estate was asked with the project's set (p1: support-pg described, its repo), never the hidden source.
    const call = f.calls.find((c) => c.tool === 'knowledge.recall')!;
    expect(call.args['visible']).toEqual(['repo:billing-api', 'source:s-support']);
    // A source's structure is named, cited and marked untrusted; a document is not.
    expect(body.rows[1]).toEqual(['support-pg · support.tickets', 'table', 'knowledge:kdoc synthetic src:support-pg/support.tickets:', 'support-pg', true]);
    expect(JSON.stringify(body.rows)).not.toContain('s-support');
    expect(body.rows[0]).toEqual(['Refund policy', 'document', 'docs/refunds.md', null, false]);
  });

  it('NEGATIVE CONTROL: a source switched off for the project between the read and the release is not released, nor cached (the release re-check)', async () => {
    // Reads of the set: the plan, the plan again once the slot is held, the read itself, then the release re-check.
    f.narrowFrom = f.visibleCalls + 4;
    try {
      h.executor.cache.invalidate('know');
      const r = await h.call('POST', '/apps/know/query', { version: 2, query: 'found' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('contract_changed');
      expect(JSON.stringify(r.body)).not.toContain('support.tickets');
      // The next read plans under the narrowed set: only what that set holds.
      expect((await run('found')).rows.map((x) => x[0])).toEqual(['Refund policy']);
    } finally {
      f.narrowFrom = null;
      h.executor.cache.invalidate('know');
    }
  });

  it('NEGATIVE CONTROL (codex r1): a warm cache never serves a wider answer once the set narrows', async () => {
    h.executor.cache.invalidate('know');
    expect((await run('found')).rows.map((x) => x[0])).toContain('support-pg · support.tickets');
    const support = f.sources[0]!;
    f.sources[0] = { ...support, access: { ...support.access, projects: [] } } as GateSource;
    try {
      // No invalidation: the cache is warm with the wider answer.
      const again = await run('found');
      expect(again.cachedAt).toBeNull();
      expect(again.rows.map((x) => x[0])).toEqual(['Refund policy']);
    } finally {
      f.sources[0] = support;
      h.executor.cache.invalidate('know');
    }
  });

  it('`source` keeps only what that source was derived from, asking estate under the WHOLE set (a two-source shape stays) with the larger budget', async () => {
    f.sources.push(source('s-billing', 'billing-pg', { projects: ['p1'] }));
    const real = f.answers['knowledge.recall'];
    f.answers['knowledge.recall'] = { items: [...KNOWLEDGE_ITEMS, { node_id: 'kconcept synthetic proposal:x:', class: 'kconcept', label: 'tickets join accounts', body_snippet: 'support.tickets joins billing.accounts', score: 0.5, source: '', scope: 'source:s-support', deps: ['source:s-support', 'source:s-billing'], untrusted: false }] };
    try {
      h.executor.cache.invalidate('know');
      const before = f.calls.length;
      const body = await run('from_support');
      expect(body.rows).toEqual([['support-pg · support.tickets', 'table'], ['tickets join accounts', 'shape']]);
      const call = f.calls.slice(before).find((c) => c.tool === 'knowledge.recall')!;
      expect(call.args['visible']).toEqual(['repo:billing-api', 'source:s-billing', 'source:s-support']);
      expect(call.args['token_budget']).toBe(16_000);
    } finally {
      f.sources.pop();
      f.answers['knowledge.recall'] = real;
      h.executor.cache.invalidate('know');
    }
  });

  it('NEGATIVE CONTROL (pi + codex r1): memories are released only when the project\'s facet admits them, whatever estate answers', async () => {
    const body = await run('remembered');
    expect(body.rows.map((r) => r[3])).toEqual(['memory:m1', 'memory:m2']);
    expect(JSON.stringify(body.rows)).not.toMatch(/Project two|Codex-only/u);
    const call = f.calls.find((c) => c.tool === 'memory.recall')!;
    expect(call.args).toMatchObject({ query: 'decisions', scope_prefix: '', intent: { project: 'p1' } });
    expect(body.rows[0]).toEqual(['We decided refunds settle nightly.', 'We decided refunds settle nightly. Because the ledger batch runs at 02:00.', 'semantic', 'memory:m1']);
    const grouped = await run('memory_kinds');
    expect(grouped.rows).toEqual([['procedural', 1], ['semantic', 1]]);
  });

  it('steering: the active rules with no project or this one; grouped by type; a parameter narrows by words', async () => {
    const body = await run('rules');
    expect(body.rows.map((r) => r[3])).toEqual(['rule:r1', 'rule:r2', 'rule:r3']);
    expect(body.rows[1]).toEqual(['Refunds over 500 need a second approver', 'security', 'error', 'rule:r2']);
    expect((await run('rules_by_type')).rows).toEqual([['security', 2], ['testing', 1]]);
    expect((await run('refund_rules')).rows).toEqual([['Refunds over 500 need a second approver'], ['Every refund path has a test']]);
    expect((await run('refund_rules', { words: 'card' })).rows).toEqual([['Never log a card number']]);
  });

  it('NEGATIVE CONTROL (codex r1): tables shows a shape only when estate\'s own node and deps are in the set, never on its record alone', async () => {
    const body = await run('tables');
    expect(body.rows).toEqual([
      ['support.tickets', 'support.tickets: ~12k rows; status has 3 values; joins support.regions on region_id.', 3, 'support.tickets: ~12k rows; status has 3 values; joins support.regions on region_id.', 'src:support-pg/support.tickets'],
      ['support.regions', '2 columns: id, name', 2, null, 'src:support-pg/support.regions'],
    ]);
    // p-2 (describes a repo outside the project), p-4 (estate derived hr-pg into it) and p-5 (pending) are not shown.
    expect(JSON.stringify(body.rows)).not.toMatch(/elsewhere|hr\.salaries|pending/u);
  });

  it('NEGATIVE CONTROL (codex r1): a catalog estate answers for another source is refused, never relabelled', async () => {
    const real = f.answers['knowledge.source_catalog'];
    f.answers['knowledge.source_catalog'] = () => ({ sourceId: 's-hr', ...CATALOG, docs: [{ key: 'hr.salaries', title: 'hr-pg · hr.salaries', entry: { kind: 'table', columns: [{ name: 'salary' }] } }] });
    try {
      h.executor.cache.invalidate('know');
      const r = await h.call('POST', '/apps/know/query', { version: 2, query: 'tables' });
      expect(r.status).toBe(502);
      expect(JSON.stringify(r.body)).not.toContain('salar');
    } finally {
      f.answers['knowledge.source_catalog'] = real;
      h.executor.cache.invalidate('know');
    }
  });

  it('a catalog cut at its page cap says truncated, grouped or not', async () => {
    const real = f.answers['knowledge.source_catalog'];
    let page = 0;
    f.answers['knowledge.source_catalog'] = (args: Record<string, unknown>) => {
      page = Number(args['page'] ?? 0);
      return { sourceId: 's-support', generation: 3, pages: 99, docs: [{ key: `support.t${page}`, title: 't', entry: { kind: 'table', columns: [] } }] };
    };
    try {
      h.executor.cache.invalidate('know');
      const body = await run('tables');
      expect(body.truncated).toBe(true);
      expect(page).toBe(19);
      // codex r3: grouped, the many tables fall into one group, and the answer still says it is cut.
      const grouped = await run('table_kinds');
      expect(grouped.rows).toEqual([['table', 20]]);
      expect(grouped.truncated).toBe(true);
    } finally {
      f.answers['knowledge.source_catalog'] = real;
      h.executor.cache.invalidate('know');
    }
  });

  it('NEGATIVE CONTROL (codex r2): a warm steering answer is not served once a rule moves to another project', async () => {
    h.executor.cache.invalidate('know');
    expect((await run('rule_titles')).rows.map((r) => r[1])).toEqual(['rule:r1', 'rule:r2', 'rule:r3']);
    const r1 = f.rules[0]!;
    f.rules[0] = { ...r1, targets: { project: 'p2' } };
    try {
      expect((await run('rule_titles')).rows.map((r) => r[1])).toEqual(['rule:r2', 'rule:r3']);
    } finally {
      f.rules[0] = r1;
      h.executor.cache.invalidate('know');
    }
  });

  it('(pi r2) a source name that now points at another registry entry is contract_changed', async () => {
    const support = f.sources[0]!;
    f.sources[0] = { ...support, id: 's-support-2' } as GateSource;
    try {
      h.executor.cache.invalidate('know');
      const r = await h.call('POST', '/apps/know/query', { version: 2, query: 'tables' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('contract_changed');
    } finally {
      f.sources[0] = support;
      h.executor.cache.invalidate('know');
    }
  });

  it('NEGATIVE CONTROL (codex r3): a memory re-faceted away from the project is not served from a warm read', async () => {
    h.executor.cache.invalidate('know');
    expect((await run('remembered')).rows.map((r) => r[3])).toContain('memory:m1');
    const inv = f.answers['memory.list'] as { items: Array<Record<string, unknown>> };
    const m1 = inv.items[0]!;
    inv.items[0] = { ...m1, facets: { project: 'p2' } };
    try {
      expect((await run('remembered')).rows.map((r) => r[3])).not.toContain('memory:m1');
    } finally {
      inv.items[0] = m1;
    }
  });

  it('(codex r3) a relation too large for its record is said, never a quiet zero-column table', async () => {
    const real = f.answers['knowledge.source_catalog'];
    f.answers['knowledge.source_catalog'] = () => ({ sourceId: 's-support', generation: 3, pages: 1, docs: [{ key: 'support.wide', title: 't', entry: { relation: 'support.wide', schema: 'support', name: 'wide', kind: 'table', tooLarge: true } }] });
    try {
      h.executor.cache.invalidate('know');
      const body = await run('tables');
      expect(body.truncated).toBe(true);
      expect(body.rows[0]![1]).toMatch(/Too large to list/u);
    } finally {
      f.answers['knowledge.source_catalog'] = real;
      h.executor.cache.invalidate('know');
    }
  });

  it('(codex r2) shapes that could not be verified make the tables answer say truncated, never a quiet "no shape"', async () => {
    const real = f.answers['knowledge.neighbors'];
    f.answers['knowledge.neighbors'] = () => {
      throw new Error('estate is busy');
    };
    try {
      h.executor.cache.invalidate('know');
      const body = await run('tables');
      expect(body.truncated).toBe(true);
      expect(body.rows.every((r) => r[3] === null)).toBe(true);
    } finally {
      f.answers['knowledge.neighbors'] = real;
      h.executor.cache.invalidate('know');
    }
  });

  it('NEGATIVE CONTROL: the check refuses a recall naming a source the app\'s project cannot see, or one not described yet', async () => {
    const hidden = await h.land('know', specWith([...knowledgeQueries, q('hr', [S('title')])]), { ...texts, hr: JSON.stringify({ from: 'tables', source: 'hr-pg' }) });
    expect(hidden.status).toBe(422);
    expect(JSON.stringify(hidden.body)).toMatch(/not_visible/);
    const fresh = await h.land('know', specWith([...knowledgeQueries, q('fresh', [S('title')])]), { ...texts, fresh: JSON.stringify({ from: 'tables', source: 'new-pg' }) });
    expect(fresh.status).toBe(422);
    expect(JSON.stringify(fresh.body)).toMatch(/not_described/);
  });

  it('a source the project stops seeing after the check is refused at run time (409), and nothing is read from it', async () => {
    const support = f.sources[0]!;
    f.sources[0] = { ...support, access: { ...support.access, projects: [] } } as GateSource;
    const before = f.calls.length;
    try {
      h.executor.cache.invalidate('know');
      const r = await h.call('POST', '/apps/know/query', { version: 2, query: 'tables' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('query_refused');
      expect(f.calls.slice(before).some((c) => c.tool === 'knowledge.source_catalog')).toBe(false);
    } finally {
      f.sources[0] = support;
    }
  });

  it('the spec ties recall to estate both ways, and no public query reads knowledge', async () => {
    const bad = await h.land('know', specWith([{ id: 'x', source: 'support-pg', kind: 'recall', output: [S('title')] }]), { x: JSON.stringify({ from: 'steering' }) });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toMatch(/source estate/);
    const pub = await h.land('know', specWith([q('x', [S('title')], { public: true })]), { x: JSON.stringify({ from: 'steering' }) });
    expect(pub.status).toBe(422);
    expect(JSON.stringify(pub.body)).toMatch(/no public app/);
  });
});

describe('a recall past its deadline answers 504 and starts no further estate call (codex r1)', () => {
  it('a slow catalog read times out; its read stops before the shapes', async () => {
    const f = freshFake();
    const real = f.answers['knowledge.source_catalog'] as (a: Record<string, unknown>) => unknown;
    f.answers['knowledge.source_catalog'] = async (a: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 400));
      return real(a);
    };
    const h = await appsHarness({ knowledge: fakeKnowledge(f), crewDeadlineMs: 150 });
    try {
      await h.newApp('slow');
      const r = await h.land('slow', specWith([q('tables', [S('title')])]), { tables: JSON.stringify({ from: 'tables', source: 'support-pg' }) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const res = await h.call('POST', '/apps/slow/query', { version: 2, query: 'tables' });
      expect(res.status).toBe(504);
      await new Promise((r2) => setTimeout(r2, 600));
      expect(f.calls.some((c) => c.tool === 'proposal.list' || c.tool === 'knowledge.neighbors')).toBe(false);
    } finally {
      await h.close();
    }
  });
});

describe('recall is studio-hosted only in v1', () => {
  it('an executor without the knowledge seam (the app server) answers 503 apps_unavailable', async () => {
    const f = freshFake();
    const h = await appsHarness({ knowledge: fakeKnowledge(f) });
    try {
      await h.newApp('know');
      const r = await h.land('know', specWith([q('rules', [S('title')])]), { rules: JSON.stringify({ from: 'steering' }) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      (h.executor as unknown as { deps: { knowledge?: unknown } }).deps.knowledge = undefined;
      const res = await h.call('POST', '/apps/know/query', { version: 2, query: 'rules' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('apps_unavailable');
    } finally {
      await h.close();
    }
  });
});

describe('the knowledge summary (what a suggestion and the builder may name)', () => {
  it('NEGATIVE CONTROL: names only sources the project may see; counts memories a project recall reaches and the rules that apply', async () => {
    const f = freshFake();
    const s = await projectKnowledge('p1', fakeKnowledge(f));
    expect(s.sources).toEqual([
      { name: 'new-pg', described: false, query: false, shapes: 0 },
      // Only p-1 is verified against estate's node (p-2, p-4 stand on what p1 may not see; p-5 is pending).
      { name: 'support-pg', described: true, query: false, shapes: 1 },
    ]);
    expect(s.sources.map((x) => x.name)).not.toContain('hr-pg');
    // m1 (p1) and m2 (shared); not m3 (p2), m4 (also cli-faceted) or m5 (a working memory).
    expect(s.memories).toEqual({ project: 1, shared: 1 });
    expect(s.steering).toEqual({ total: 3, byType: { security: 2, testing: 1 } });
    const p2 = await projectKnowledge('p2', fakeKnowledge(f));
    expect(p2.sources.map((x) => x.name)).toEqual(['hr-pg']);
    expect(p2.steering?.total).toBe(4);
  });

  it('GET /knowledge/summary: a human operator\'s; names the project; 503 without the plane', async () => {
    const f = freshFake();
    const actors: Record<string, Actor> = { priya: { id: 'priya', kind: 'human', trust: 'operator' }, seat: { id: 'seat', kind: 'agent', trust: 'operator' }, olga: { id: 'olga', kind: 'human', trust: 'observer' } };
    const build = async (withKnowledge: boolean) => {
      const app = Fastify({ logger: false });
      registerShapeRoutes(app, { estate: async () => null, repos: async () => [], audit: AuditLog.noop(), actorOf: (req) => actors[String(req.headers['x-as'])]!, ...(withKnowledge ? { knowledge: fakeKnowledge(f) } : {}) });
      await app.ready();
      return app;
    };
    const app = await build(true);
    try {
      const get = (url: string, as = 'priya') => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { 'x-as': as } });
      const ok = await get('/knowledge/summary?project=p1');
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as KnowledgeSummaryResponse).sources.map((x) => x.name)).toEqual(['new-pg', 'support-pg']);
      expect((await get('/knowledge/summary?project=p1', 'seat')).statusCode).toBe(403);
      expect((await get('/knowledge/summary?project=p1', 'olga')).statusCode).toBe(403);
      expect((await get('/knowledge/summary')).statusCode).toBe(400);
    } finally {
      await app.close();
    }
    const bare = await build(false);
    try {
      expect((await bare.inject({ method: 'GET', url: '/api/v1/knowledge/summary?project=p1', headers: { 'x-as': 'priya' } })).statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('a part estate cannot answer is null, never zero (memories; a source\'s shapes)', async () => {
    const f = freshFake();
    delete f.answers['memory.list'];
    delete f.answers['proposal.list'];
    const s = await projectKnowledge('p1', fakeKnowledge(f));
    expect(s.memories).toBeNull();
    expect(s.sources.find((x) => x.name === 'support-pg')!.shapes).toBeNull();
  });

  it('(codex r2) shapes not established are null: every check failed, or the budget ran out', async () => {
    const f = freshFake();
    f.answers['knowledge.neighbors'] = () => {
      throw new Error('estate is busy');
    };
    expect((await projectKnowledge('p1', fakeKnowledge(f))).sources.find((x) => x.name === 'support-pg')!.shapes).toBeNull();
    const g = freshFake();
    let t = 0;
    const s = await projectKnowledge('p1', fakeKnowledge(g), { budgetMs: 5, now: () => (t += 10) });
    expect(s.sources.find((x) => x.name === 'support-pg')!.shapes).toBeNull();
    expect(s.memories).toBeNull();
    // The rules are crew's own (no estate call): they still answer.
    expect(s.steering?.total).toBe(3);
  });

  it('(codex r2) a shape whose repo leaves the project while the summary is read is not counted', async () => {
    const f = freshFake();
    const k = fakeKnowledge(f);
    let reads = 0;
    const s = await projectKnowledge('p1', {
      ...k,
      visible: async (pid) => {
        reads++;
        const set = visibleDeps(f.sources, pid, reads <= 2 ? (f.repos[pid] ?? []) : []);
        return set;
      },
    });
    expect(s.sources.find((x) => x.name === 'support-pg')!.shapes).toBe(0);
  });

  it('(codex r3) a capped count that falls below the cap at release, with candidates unchecked, is unknown', async () => {
    const f = freshFake();
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    f.answers['proposal.list'] = { proposals: ids.map((x) => ({ id: `q-${x}`, state: 'approved', payload: { class: 'concept', content: x, shape: { sourceId: 's-support', relation: `support.${x}`, describes: [] } } })) };
    f.answers['knowledge.neighbors'] = (args: Record<string, unknown>) => {
      const id = String(args['id']);
      return { nodes: [{ store: 'knowledge', id, deps: id.includes('q-a') ? ['source:s-support', 'repo:billing-api'] : ['source:s-support'] }], edges: [] };
    };
    const k = fakeKnowledge(f);
    let reads = 0;
    const s = await projectKnowledge('p1', { ...k, visible: async (pid) => visibleDeps(f.sources, pid, ++reads <= 6 ? (f.repos[pid] ?? []) : []) });
    expect(s.sources.find((x) => x.name === 'support-pg')!.shapes).toBeNull();
  });

  it('a source the project stops seeing while the summary is read is not named (the release re-check)', async () => {
    const f = freshFake();
    const k = fakeKnowledge(f);
    let calls = 0;
    const s = await projectKnowledge('p1', {
      ...k,
      sources: async () => {
        calls++;
        return calls === 1 ? f.sources : f.sources.map((x) => (x.name === 'support-pg' ? ({ ...x, access: { ...x.access, projects: [] } } as GateSource) : x));
      },
    });
    expect(s.sources.map((x) => x.name)).toEqual(['new-pg']);
  });
});

describe('the builder is told how to build on knowledge, and the guide\'s own example passes the check and runs', () => {
  it('the turn prompt carries the summary (counts and names only) and the recall guide', () => {
    const summary: KnowledgeSummaryResponse = { projectId: 'p1', sources: [{ name: 'support-pg', described: true, query: false, shapes: 2 }], memories: { project: 3, shared: 1 }, steering: { total: 4, byType: { security: 4 } } };
    const spec = specWith([]);
    const text = turnProblem({ slug: 'a', name: 'A', base: 1, message: 'Steering rules by type', about: [], spec, recent: [], knowledge: { package: 'wicked.knowledge/v1', projectId: 'p1', sources: [] }, summary });
    expect(text).toContain('"memories":{"project":3,"shared":1}');
    expect(text).toContain('`kind` is `recall`');
    expect(text).not.toContain('projectId":"p1","sources":[{"name":"support-pg","described":true,"query"');
    const none = turnProblem({ slug: 'a', name: 'A', base: 1, message: 'x', about: [], spec, recent: [], knowledge: { package: 'wicked.knowledge/v1', projectId: 'p1', sources: [] }, summary: null });
    expect(none).toContain('{"unavailable":true}');
  });

  it('the example in SPEC_SHAPE_GUIDE lands through crew\'s check and both of its queries render rows', async () => {
    const block = SPEC_SHAPE_GUIDE.split('```json\n').at(-1)!.split('\n```')[0]!;
    const example = JSON.parse(block) as Pick<AppSpec, 'pages' | 'queries'>;
    const qtexts: Record<string, string> = {};
    for (const m of SPEC_SHAPE_GUIDE.matchAll(/queries\/([a-z_]+)\.json `([^`]+)`/g)) qtexts[m[1]!] = m[2]!;
    expect(Object.keys(qtexts).sort()).toEqual(['remembered', 'rules_by_type']);
    const f = freshFake();
    const h = await appsHarness({ knowledge: fakeKnowledge(f) });
    try {
      await h.newApp('guide');
      const spec: AppSpec = { schema: 'wicked.apps/v1', name: 'What we know', pages: example.pages, queries: example.queries, actions: [], linkHosts: [] };
      const r = await h.land('guide', spec, qtexts);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const rules = await h.call('POST', '/apps/guide/query', { version: 2, query: 'rules_by_type' });
      expect((rules.body as unknown as AppQueryResponse).rows).toEqual([['security', 2], ['testing', 1]]);
      const mem = await h.call('POST', '/apps/guide/query', { version: 2, query: 'remembered' });
      expect((mem.body as unknown as AppQueryResponse).rows[0]).toEqual(['We decided refunds settle nightly.', 'semantic', 'memory:m1']);
    } finally {
      await h.close();
    }
  });
});
