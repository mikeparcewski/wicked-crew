// DES-KNOWLEDGE-DATA-001 §9.1 against a REAL wicked-estate-mcp, when WICKED_ESTATE_MCP_EXE names one (skipped
// otherwise; CI has no estate binary). Every store is a temp file. An app's recall reads, with estate's own wire:
// a source's structure only in a project that may see it, memories only under the project's facet, and one source's
// tables from its catalog.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AppKnowledgeDeps, readRecall } from '../src/apps/exec/recall.js';
import { callEstateTool } from '../src/core/estate-mcp-client.js';
import { agentAccessOf } from '../src/knowledge/gate/access.js';
import type { GateSource } from '../src/knowledge/gate/sources.js';
import { visibleDeps } from '../src/knowledge/package.js';
import { sourceGeneration } from '../src/knowledge/projector.js';
import { fileShapes, shapeProposals } from '../src/knowledge/shapes/shapes.js';
import { projectKnowledge } from '../src/knowledge/summary.js';
import type { CatalogRelation, SqlCatalog } from '../src/sources/catalog/types.js';
import { removeScratch } from './setup/scratch.js';
import { appsHarness, specWith } from './support/apps-harness.js';
import type { AppQueryResponse, ConformanceRule } from '../src/core/types.js';

const EXE = process.env['WICKED_ESTATE_MCP_EXE'] ?? '';
const SOURCE_ID = '3f0c9a1e-0000-4000-8000-00000000a9e1';

const rel = (name: string): CatalogRelation => ({
  schema: 'support',
  name,
  kind: 'table',
  rowEstimate: 41_234,
  columns: [
    { name: 'id', type: 'bigint', nullable: false },
    { name: 'status', type: 'text', nullable: false },
    { name: 'region', type: 'text', nullable: true },
  ],
  primaryKey: ['id'],
  foreignKeys: [],
});

describe.skipIf(EXE === '' || process.platform === 'win32')('recall queries against a real wicked-estate-mcp', () => {
  let base: string;
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: base,
    WICKED_HOME: join(base, 'wicked'),
    WICKED_MEMORY_DB: join(base, 'memory.db'),
    WICKED_KNOWLEDGE_DB: join(base, 'knowledge.db'),
    WICKED_XEDGE_DB: join(base, 'xedge.db'),
    WICKED_ESTATE_DB: ':memory:',
  });
  const estate = (tool: string, args: Record<string, unknown>) => callEstateTool(tool, args, { spawn: () => spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env() } }), timeoutMs: 60_000 });
  const support = (projects: string[]): GateSource =>
    ({
      id: SOURCE_ID,
      name: 'support-pg',
      enabled: true,
      access: agentAccessOf({ agents: { projects } }),
      descriptorHash: 'h',
      description: { catalog: { dialect: 'postgres', database: 'd', relations: [rel('tickets'), rel('regions')], describedAt: '2026-11-04T22:00:00Z' } satisfies SqlCatalog, descriptorHash: 'h' },
      viewsAllowed: [],
      tools: [],
      dialect: 'postgres',
      runtime: 'native',
      queryable: true,
    }) as unknown as GateSource;
  let sources: GateSource[] = [];
  const deps = (): AppKnowledgeDeps => ({
    sources: async () => sources,
    visible: async (projectId) => visibleDeps(sources, projectId, []),
    estate,
    rules: async () => [],
  });

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'apps-recall-estate-'));
    sources = [support(['p1'])];
    await estate('knowledge.replace_source', sourceGeneration(sources[0]!, 1000)! as never);
    await estate('knowledge.ingest', { title: 'Refund policy', chunks: ['Refunds over 500 need a second approver before they settle.'], source: 'docs/refunds.md' });
    await estate('memory.capture', { content: 'We decided refunds settle nightly in project one.', tier: 'semantic', facets: { project: 'p1' } });
    await estate('memory.capture', { content: 'We decided refunds settle weekly in project two.', tier: 'semantic', facets: { project: 'p2' } });
    // Two approved shapes, filed and approved the way the profiler and a person do: regions on the source alone; tickets
    // also describes code in repo `escalations`, which p1 does not hold, so estate derives that repo into its deps.
    const profile = {
      relations: [
        { key: 'support.tickets', rows: '100-9,999' as const, error: null, columns: [{ name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique' as const, keyCandidate: true }] },
        { key: 'support.regions', rows: '1-99' as const, error: null, columns: [{ name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique' as const, keyCandidate: true }] },
      ],
      joins: [{ from: 'support.tickets', columns: ['region'], to: 'support.regions', references: ['id'], basis: 'fk' as const, overlap: 'all' as const }],
    };
    const code = new Map([['support.tickets', [{ repo: 'escalations', symbolId: 'scip-typescript npm escalations 1.0.0 src/ticket.ts/Ticket#', name: 'Ticket', kind: 'class', file: 'src/ticket.ts' }]]]);
    const filed = await fileShapes(estate, shapeProposals({ id: SOURCE_ID, name: 'support-pg' }, profile, code, new Date().toISOString()));
    for (const f of filed.filed) await estate('proposal.approve', { id: f.id });
    expect(filed.filed.map((f) => f.relation).sort()).toEqual(['support.regions', 'support.tickets']);
  }, 120_000);

  afterAll(() => {
    if (base !== undefined) removeScratch(base);
  });

  it('knowledge: the source\'s structure reaches p1 (it is ticked) and never p2; the document reaches both', async () => {
    const p1 = await readRecall(deps(), 'p1', { from: 'knowledge', query: { kind: 'literal', value: 'support tickets status region refunds' } }, 'support tickets status region refunds');
    const kinds1 = p1.rows.map((r) => r['kind']);
    expect(kinds1).toContain('table');
    expect(kinds1).toContain('document');
    expect(p1.rows.find((r) => r['kind'] === 'table')).toMatchObject({ source: 'support-pg', untrusted: true });
    const p2 = await readRecall(deps(), 'p2', { from: 'knowledge', query: { kind: 'literal', value: 'x' } }, 'support tickets status region refunds');
    expect(p2.rows.map((r) => r['kind'])).not.toContain('table');
    expect(p2.rows.map((r) => r['content'])).toContain('Refunds over 500 need a second approver before they settle.');
    // A source's structure is cited by the source's name, never its registry id.
    expect(p1.rows.find((r) => r['kind'] === 'table')!['cite']).toMatch(/^src:support-pg\/support\.(tickets|regions)#columns$/);
    expect(p1.rows.find((r) => r['kind'] === 'document')!['cite']).toBe('docs/refunds.md');
  }, 120_000);

  it('memories: under the project\'s facet only', async () => {
    const p1 = await readRecall(deps(), 'p1', { from: 'memories', query: { kind: 'literal', value: 'x' } }, 'refunds settle decided');
    const words = p1.rows.map((r) => String(r['content']));
    expect(words.some((w) => w.includes('project one'))).toBe(true);
    expect(words.some((w) => w.includes('project two'))).toBe(false);
    expect(p1.rows[0]!['cite']).toMatch(/^memory:/);
  }, 120_000);

  it('the connected path: an app\'s recall queries land through crew\'s check and answer through the query route', async () => {
    const rules: ConformanceRule[] = [{ id: 'r1', rule_type: 'policy', statement: 'Never log a card number', severity: 'error', confidence: 1, targets: {}, provenance: { source: 'ui', source_kinds: [] }, steering_type: 'security' } as ConformanceRule];
    const h = await appsHarness({ knowledge: { ...deps(), rules: async () => rules } });
    try {
      await h.newApp('know-live');
      const S = (name: string, nullable = false) => ({ name, type: 'string' as const, ...(nullable ? { nullable: true } : {}) });
      const spec = specWith([
        { id: 'remembered', source: 'estate', kind: 'recall', output: [S('title'), S('cite')] },
        { id: 'tables', source: 'estate', kind: 'recall', output: [S('title'), { name: 'columns', type: 'integer' }, S('cite')] },
        { id: 'found', source: 'estate', kind: 'recall', params: { type: 'object', properties: { q: { type: 'string', default: 'support tickets status region refunds' } } }, output: [S('title'), S('kind'), S('source', true)] },
        { id: 'rules_by_type', source: 'estate', kind: 'recall', output: [S('key'), { name: 'count', type: 'integer' }] },
      ]);
      const landed = await h.land('know-live', spec, {
        remembered: JSON.stringify({ from: 'memories', query: { kind: 'literal', value: 'refunds settle decided' } }),
        tables: JSON.stringify({ from: 'tables', source: 'support-pg' }),
        found: JSON.stringify({ from: 'knowledge', query: { kind: 'param', name: 'q' } }),
        rules_by_type: JSON.stringify({ from: 'steering', group: 'kind' }),
      });
      expect(landed.status, JSON.stringify(landed.body)).toBe(200);
      const run = async (query: string): Promise<AppQueryResponse> => {
        const r = await h.call('POST', '/apps/know-live/query', { version: 2, query });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        return r.body as unknown as AppQueryResponse;
      };
      const mem = await run('remembered');
      expect(mem.rows.map((r) => String(r[0]))).toEqual(['We decided refunds settle nightly in project one.']);
      expect(String(mem.rows[0]![1])).toMatch(/^memory:/u);
      expect((await run('tables')).rows.map((r) => r[0]).sort()).toEqual(['support.regions', 'support.tickets']);
      const found = await run('found');
      expect(found.rows.some((r) => r[1] === 'table' && r[2] === 'support-pg')).toBe(true);
      expect((await run('rules_by_type')).rows).toEqual([['security', 1]]);
    } finally {
      await h.close();
    }
  }, 180_000);

  it('tables: one source\'s tables from its catalog in p1; refused in p2; the summary agrees', async () => {
    const t = await readRecall(deps(), 'p1', { from: 'tables', source: 'support-pg' }, null);
    expect(t.rows.map((r) => r['title']).sort()).toEqual(['support.regions', 'support.tickets']);
    // Verified against estate's own node: regions' shape shows; tickets' (it stands on repo escalations too) does not.
    const byTitle = Object.fromEntries(t.rows.map((r) => [r['title'], r]));
    expect(byTitle['support.regions']).toMatchObject({ columns: 3, untrusted: true });
    expect(String(byTitle['support.regions']!['shape'])).toMatch(/support\.regions/u);
    expect(byTitle['support.tickets']!['shape']).toBeNull();
    // With the repo in the project's set, the tickets shape (and what it joins) shows too.
    const withRepo = await readRecall({ ...deps(), visible: async (pid) => visibleDeps(sources, pid, ['escalations']) }, 'p1', { from: 'tables', source: 'support-pg' }, null);
    expect(String(Object.fromEntries(withRepo.rows.map((r) => [r['title'], r]))['support.tickets']!['shape'])).toMatch(/joins support\.regions/u);
    await expect(readRecall(deps(), 'p2', { from: 'tables', source: 'support-pg' }, null)).rejects.toThrow(/not a data source this app's project may see/);
    const s = await projectKnowledge('p1', deps());
    expect(s.sources).toEqual([{ name: 'support-pg', described: true, query: false, shapes: 1 }]);
    expect(s.memories).toEqual({ project: 1, shared: 0 });
  }, 120_000);
});
