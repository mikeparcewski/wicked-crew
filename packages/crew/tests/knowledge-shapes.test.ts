// DES-KNOWLEDGE-DATA-001 §10, §19 B4: the value-free profiler's pieces, the shape proposals, the Knowledge map's
// assembly and the two routes' human-only rule (no database, no estate: the real ones are in
// sources-shapes.test.ts and knowledge-shapes-estate-live.test.ts).

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { Actor } from '../src/core/types.js';
import { cliRows, searchableRepos, searchEntities } from '../src/knowledge/shapes/code-search.js';
import { buildKnowledgeMap, MAP_TABLES_MAX, symbolName } from '../src/knowledge/shapes/map.js';
import {
  cardinalityOf,
  entityNames,
  joinCandidates,
  overlapBand,
  overlapSql,
  profileSource,
  type ProfileRelation,
  relationSql,
  relationSqls,
  rowsBand,
} from '../src/knowledge/shapes/profile.js';
import { registerShapeRoutes, relationsFromCatalog } from '../src/knowledge/shapes/routes.js';
import { CatalogChangedError, catalogDocId, codeEvidence, encodeKey, fileShapes, joinEvidence, proposalIdOfNode, proposalNodeId, readCatalog, shapeContent, shapeProposals } from '../src/knowledge/shapes/shapes.js';
import type { SqlCatalog } from '../src/sources/catalog/types.js';
import type { SqlReadResult } from '../src/sources/drivers/types.js';

const rel = (key: string, cols: Array<[string, string]>, pk: string[], fks: ProfileRelation['foreignKeys'] = []): ProfileRelation => {
  const [schema, name] = key.split('.') as [string, string];
  return { key, schema, name, columns: cols.map(([n, t]) => ({ name: n, type: t, nullable: !pk.includes(n) })), primaryKey: pk, foreignKeys: fks };
};

const REGIONS = rel('support.regions', [['id', 'integer'], ['name', 'text'], ['sla_hours', 'integer']], ['id']);
const TICKETS = rel('support.tickets', [['id', 'integer'], ['subject', 'text'], ['status', 'support.ticket_status'], ['region_id', 'integer'], ['doc', 'json']], ['id'], [
  { columns: ['region_id'], references: { schema: 'support', table: 'regions', columns: ['id'] } },
]);
const ASSIGN = rel('support.assignments', [['id', 'integer'], ['ticket_id', 'integer'], ['owner', 'text']], ['id']);
const SID = '3f0c9a1e-0000-4000-8000-00000000b401';

describe('the profiler', () => {
  it('builds one fixed aggregate statement per relation, with no count(DISTINCT) on a type without equality', () => {
    expect(relationSql(TICKETS)).toBe(
      'SELECT count(*) AS n, count("id") AS nn0, count(DISTINCT "id") AS d0, count("subject") AS nn1, count(DISTINCT "subject") AS d1, count("status") AS nn2, count(DISTINCT "status") AS d2, count("region_id") AS nn3, count(DISTINCT "region_id") AS d3, count("doc") AS nn4 FROM "support"."tickets"',
    );
    expect(relationSql(rel('a"b.c"d', [['x"y', 'text']], []))).toContain('FROM "a""b"."c""d"');
  });

  it('measures key overlap at the source: two counts, never a key value', () => {
    expect(overlapSql(ASSIGN, 'ticket_id', TICKETS, 'id')).toBe(
      'SELECT count(DISTINCT a."ticket_id") AS d, count(DISTINCT a."ticket_id") FILTER (WHERE EXISTS (SELECT 1 FROM "support"."tickets" b WHERE b."id" = a."ticket_id")) AS hit FROM "support"."assignments" a',
    );
  });

  it('keeps bands only', () => {
    expect([0, 1, 99, 100, 9_999, 10_000, 999_999, 1_000_000].map(rowsBand)).toEqual(['0', '1-99', '1-99', '100-9,999', '100-9,999', '10,000-999,999', '10,000-999,999', '1,000,000+']);
    expect([cardinalityOf(null, 5), cardinalityOf(0, 0), cardinalityOf(1, 9), cardinalityOf(9, 9), cardinalityOf(5, 9), cardinalityOf(2, 9)]).toEqual(['unknown', 'none', 'single', 'unique', 'high', 'low']);
    expect([overlapBand(0, 0), overlapBand(0, 4), overlapBand(1, 4), overlapBand(2, 4), overlapBand(4, 4)]).toEqual(['empty', 'none', 'some', 'most', 'all']);
  });

  it('finds join candidates: declared foreign keys, and <x>_id by name and type', () => {
    const c = joinCandidates([REGIONS, TICKETS, ASSIGN]).map((j) => ({ from: j.from, columns: j.columns, to: j.to, references: j.references, basis: j.basis }));
    expect(c).toEqual([
      { from: 'support.tickets', columns: ['region_id'], to: 'support.regions', references: ['id'], basis: 'fk' },
      { from: 'support.assignments', columns: ['ticket_id'], to: 'support.tickets', references: ['id'], basis: 'name_type' },
    ]);
    // A text <x>_id never matches an integer key.
    const odd = rel('support.notes', [['id', 'integer'], ['ticket_id', 'text']], ['id']);
    expect(joinCandidates([TICKETS, odd]).filter((j) => j.from === 'support.notes')).toEqual([]);
  });

  it('answers counts as bands, keeps a name-and-type join only when the data agrees, and drops every exact count', async () => {
    const res = (cols: Record<string, number>): SqlReadResult => ({ columns: Object.keys(cols).map((name) => ({ name, type: 'bigint' })), rows: [Object.values(cols)], truncated: false, ms: 1 });
    const read = async (sql: string): Promise<SqlReadResult> => {
      if (sql.includes('FILTER') && sql.includes('"ticket_id"')) return res({ d: 37, hit: 37 });
      if (sql.includes('FILTER')) return res({ d: 4, hit: 3 });
      if (sql.includes('FROM "support"."regions"')) return res({ n: 4, nn0: 4, d0: 4, nn1: 4, d1: 4, nn2: 4, d2: 2 });
      if (sql.includes('FROM "support"."tickets"')) return res({ n: 437, nn0: 437, d0: 437, nn1: 437, d1: 431, nn2: 437, d2: 3, nn3: 400, d3: 4, nn4: 12 });
      throw Object.assign(new Error('relation "support.assignments" leaked value k3-secret'), { errorClass: 'source' });
    };
    const p = await profileSource([REGIONS, TICKETS, ASSIGN], read);
    expect(p.relations.find((r) => r.key === 'support.tickets')).toEqual({
      key: 'support.tickets',
      rows: '100-9,999',
      error: null,
      columns: [
        { name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique', keyCandidate: true },
        { name: 'subject', type: 'text', nullPct: 0, hasNulls: false, cardinality: 'high', keyCandidate: false },
        { name: 'status', type: 'support.ticket_status', nullPct: 0, hasNulls: false, cardinality: 'low', keyCandidate: false },
        { name: 'region_id', type: 'integer', nullPct: 10, hasNulls: true, cardinality: 'low', keyCandidate: false },
        { name: 'doc', type: 'json', nullPct: 95, hasNulls: true, cardinality: 'unknown', keyCandidate: false },
      ],
    });
    // A failed read is a class, never the source's words.
    expect(p.relations.find((r) => r.key === 'support.assignments')).toEqual({ key: 'support.assignments', rows: null, columns: [], error: 'source' });
    expect(p.joins).toEqual([
      { from: 'support.tickets', columns: ['region_id'], to: 'support.regions', references: ['id'], basis: 'fk', overlap: 'most' },
      { from: 'support.assignments', columns: ['ticket_id'], to: 'support.tickets', references: ['id'], basis: 'name_type', overlap: 'all' },
    ]);
    const text = JSON.stringify(p);
    for (const exact of ['437', '431', '"400"', '37', 'k3-secret']) expect(text).not.toContain(exact);
  });

  it('names the entity a relation holds as code would', () => {
    expect(entityNames('tickets')).toEqual(['Ticket', 'Tickets']);
    expect(entityNames('sla_events')).toEqual(['SlaEvent', 'SlaEvents']);
    expect(entityNames('companies')).toEqual(['Company', 'Companies']);
    expect(entityNames('addresses')).toEqual(['Address', 'Addresses']);
    expect(entityNames('audit_log')).toEqual(['AuditLog']);
    expect(entityNames('status')).toEqual(['Status']);
    expect(entityNames('UserAccounts')).toEqual(['UserAccount', 'UserAccounts']);
  });
});

describe('shapes are proposals', () => {
  it('ids a catalog document as estate does (kdoc synthetic source:<id>/<percent-encoded key>:)', () => {
    expect(encodeKey('support.tickets')).toBe('support.tickets');
    expect(encodeKey('a b/é:')).toBe('a%20b%2F%C3%A9%3A');
    expect(catalogDocId(SID, 'support.tickets')).toBe(`kdoc synthetic source:${SID}/support.tickets:`);
  });

  it('files one knowledge concept per relation: derived_from its table, joins, describes; no declared deps', () => {
    const profile = {
      relations: [
        { key: 'support.tickets', rows: '100-9,999' as const, error: null, columns: [{ name: 'id', type: 'integer', nullPct: 0, hasNulls: false, cardinality: 'unique' as const, keyCandidate: true }] },
        { key: 'support.regions', rows: '1-99' as const, error: null, columns: [] },
      ],
      joins: [{ from: 'support.tickets', columns: ['region_id'], to: 'support.regions', references: ['id'], basis: 'fk' as const, overlap: 'all' as const }],
    };
    const code = new Map([['support.tickets', [{ repo: 'escalations', symbolId: 'ts . . . src/ticket.ts/Ticket#', name: 'Ticket', kind: 'class', file: 'src/ticket.ts' }]]]);
    const [t, r] = shapeProposals({ id: SID, name: 'support-pg' }, profile, code, '2026-11-04T10:00:00.000Z');
    expect(t!.kind_type).toBe('knowledge');
    expect(t!.payload).toMatchObject({ class: 'concept', scope: `source:${SID}`, capture: 'profile', source: 'crew:profile/support-pg/support.tickets' });
    expect(t!.payload).not.toHaveProperty('deps');
    expect(t!.payload.relate).toEqual([
      { rel: 'derived_from', to: catalogDocId(SID, 'support.tickets'), confidence: 1 },
      { rel: 'joins', from: catalogDocId(SID, 'support.tickets'), to: catalogDocId(SID, 'support.regions'), confidence: 0.95, evidence: { basis: 'fk', on: [{ columns: ['region_id'], references: ['id'], basis: 'fk', overlap: 'all' }] } },
    ]);
    expect(t!.payload.relate_code).toEqual([{ rel: 'describes', from: catalogDocId(SID, 'support.tickets'), code_id: 'ts . . . src/ticket.ts/Ticket#', repo: 'escalations', confidence: 0.6, evidence: { basis: 'name', name: 'Ticket', kind: 'class', file: 'src/ticket.ts' } }]);
    expect(t!.payload.content).toContain('support.tickets in data source support-pg: 100-9,999 rows.');
    expect(t!.payload.content).toContain('joins support.regions on region_id = support.regions.id (a foreign key; every value matches)');
    // The referenced side says it too, but only the referencing side's shape asserts the edge.
    expect(r!.payload.content).toContain('joins support.tickets on id = support.tickets.region_id');
    expect(r!.payload.relate).toEqual([{ rel: 'derived_from', to: catalogDocId(SID, 'support.regions'), confidence: 1 }]);
  });

  it('says an unread relation was not profiled, and keeps no value', () => {
    expect(shapeContent('pg', { key: 's.t', rows: null, columns: [], error: 'timeout' }, [], [], '2026-11-04T00:00:00Z')).toBe('s.t in data source pg: not profiled (timeout). Profiled 2026-11-04; no value kept.');
  });

  it('does not file a shape the queue already holds (pending, approved or declined)', async () => {
    const calls: string[] = [];
    const [one] = shapeProposals({ id: SID, name: 'pg' }, { relations: [{ key: 's.t', rows: '1-99', error: null, columns: [] }], joins: [] }, new Map(), '2026-11-04T00:00:00Z');
    let stored: unknown[] = [];
    const estate = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push(tool);
      if (tool === 'proposal.list') return { proposals: stored };
      if (tool === 'proposal.submit') {
        stored = [...stored, { id: 'p1', state: 'rejected', payload: args['payload'] }];
        return { id: 'p1' };
      }
      throw new Error(tool);
    };
    expect(await fileShapes(estate, [one!])).toEqual({ filed: [{ id: 'p1', relation: 's.t' }], skipped: 0 });
    expect(await fileShapes(estate, [one!])).toEqual({ filed: [], skipped: 1 });
    expect(calls).toEqual(['proposal.list', 'proposal.submit', 'proposal.list']);
  });
});

describe('describes: exact-name code search', () => {
  it('searches repos with a built graph, class-like kinds only, exact names, and names what it did not search', async () => {
    const repos = searchableRepos(
      [
        { id: 'b', code_graph_db: '/g/b.db' },
        { id: 'a', code_graph_db: '/g/a.db' },
        { id: 'none', code_graph_db: null },
        { id: 'gone', code_graph_db: '/g/gone.db' },
      ],
      (p) => p !== '/g/gone.db',
    );
    expect(repos.repos.map((r) => r.id)).toEqual(['a', 'b']);
    const got = await searchEntities(new Map([['support.tickets', ['Ticket', 'Tickets']]]), repos, async (repo, name) => {
      if (repo.id === 'b') throw new Error('graph locked');
      return name === 'Ticket'
        ? [
            { symbol_id: 'x/Ticket#', name: 'Ticket', kind: 'class', file: 'x.ts' },
            { symbol_id: 'x/Ticket().', name: 'Ticket', kind: 'function', file: 'x.ts' },
            { symbol_id: 'x/TicketRow#', name: 'TicketRow', kind: 'class', file: 'x.ts' },
          ]
        : [];
    });
    expect(got.matches.get('support.tickets')).toEqual([{ repo: 'a', symbolId: 'x/Ticket#', name: 'Ticket', kind: 'class', file: 'x.ts' }]);
    expect(got.searched).toEqual(['a']);
    expect(got.notSearched).toEqual(['b']);
  });
});

describe('the Knowledge map', () => {
  const SHAPE = 'kconcept synthetic proposal:p-ok:';
  const T = catalogDocId(SID, 'support.tickets');
  const R = catalogDocId(SID, 'support.regions');
  const fakeEstate = (approved: Array<{ id: string; payload: Record<string, unknown> }>) => async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === 'knowledge.source_catalog') return { sourceId: SID, generation: 7, page: 0, pages: 1, docs: [{ key: 'support.tickets' }, { key: 'support.regions' }] };
    if (tool === 'proposal.list') {
      expect(args).toEqual({ kind_type: 'knowledge', state: 'approved' });
      return { proposals: approved };
    }
    if (tool === 'knowledge.neighbors') {
      if (args['id'] !== SHAPE) throw new Error('unknown or hidden knowledge node');
      expect(args['visible']).toEqual([`source:${SID}`, 'repo:escalations']);
      return {
        nodes: [
          { store: 'knowledge', id: SHAPE, class: 'kconcept', label: 'support.tickets in data source …', scope: `source:${SID}`, deps: [`source:${SID}`, 'repo:escalations'], hydrated: true },
          { store: 'knowledge', id: T, class: 'kdoc', label: 'support-pg · support.tickets', scope: `source:${SID}`, deps: [`source:${SID}`], hydrated: true },
          { store: 'knowledge', id: R, class: 'kdoc', label: 'support-pg · support.regions', scope: `source:${SID}`, deps: [`source:${SID}`], hydrated: true },
          { store: 'estate', id: 'ts . . . src/ticket.ts/Ticket#', class: null, label: 'ts . . . src/ticket.ts/Ticket#', deps: ['repo:escalations'], hydrated: false },
        ],
        edges: [
          { rel: 'derived_from', from: { store: 'knowledge', id: SHAPE }, to: { store: 'knowledge', id: T }, owner: SHAPE, confidence: 1, meta: {} },
          { rel: 'joins', from: { store: 'knowledge', id: T }, to: { store: 'knowledge', id: R }, owner: SHAPE, confidence: 0.95, meta: { evidence: { basis: 'fk', columns: ['region_id'] } } },
          { rel: 'describes', from: { store: 'knowledge', id: T }, to: { store: 'estate', id: 'ts . . . src/ticket.ts/Ticket#' }, owner: SHAPE, confidence: 0.6, meta: { repo: 'escalations' } },
        ],
        truncated: false,
      };
    }
    throw new Error(tool);
  };

  it('draws the catalogs, the approved shapes and their typed edges; a shape estate does not hold is skipped and counted', async () => {
    const m = await buildKnowledgeMap(
      fakeEstate([
        { id: 'p-ok', payload: { content: 'support.tickets in data source support-pg: …', class: 'concept', relate: [], shape: { relation: 'support.tickets' } } },
        { id: 'p-gone', payload: { content: 'x', relate: [] } },
        { id: 'memo', payload: { content: 'a plain knowledge note, no links' } },
      ]),
      [{ id: SID, name: 'support-pg', described: true }],
      ['escalations'],
    );
    const kinds = Object.fromEntries(m.nodes.map((n) => [n.key, n.kind]));
    expect(kinds).toEqual({
      [`knowledge:${T}`]: 'table',
      [`knowledge:${R}`]: 'table',
      [`source:${SID}`]: 'source',
      [`knowledge:${SHAPE}`]: 'shape',
      'estate:ts . . . src/ticket.ts/Ticket#': 'code',
      'repo:escalations': 'repo',
    });
    expect(m.nodes.find((n) => n.kind === 'code')).toMatchObject({ label: 'Ticket', repo: 'escalations' });
    expect(m.nodes.find((n) => n.kind === 'shape')).toMatchObject({ label: 'support.tickets shape', proposalId: 'p-ok' });
    expect(m.edges.map((e) => e.rel).sort()).toEqual(['contains', 'contains', 'contains', 'derived_from', 'describes', 'joins']);
    expect(m.edges.find((e) => e.rel === 'joins')?.evidence).toEqual({ basis: 'fk', columns: ['region_id'] });
    expect(m).toMatchObject({ shapes: 1, skipped: 1, truncated: false, sources: [{ id: SID, name: 'support-pg', described: true, inKnowledge: true, tables: 2 }] });
  });

  it('ids an approved proposal\'s node as estate does (class default chunk)', () => {
    expect(proposalNodeId('p1', 'concept')).toBe('kconcept synthetic proposal:p1:');
    expect(proposalNodeId('p1', undefined)).toBe('kchunk synthetic proposal:p1:');
    expect(proposalIdOfNode('kconcept synthetic proposal:p1:')).toBe('p1');
    expect(proposalIdOfNode(catalogDocId(SID, 'support.tickets'))).toBeNull();
  });

  it('reads a symbol id down to its name', () => {
    expect(symbolName('scip-typescript npm app 1.0 src/models/`ticket.ts`/Ticket#')).toBe('Ticket');
    expect(symbolName('rule synthetic billing/REQ-1/RULE-001:')).toBe('RULE-001');
  });
});

describe('the routes are a human operator\'s only', () => {
  it('refuses an agent-kind actor on both, whatever its trust', async () => {
    const agent: Actor = Object.freeze({ id: 'unit', kind: 'agent', trust: 'admin' }) as Actor;
    const app = Fastify({ logger: false });
    const touched: string[] = [];
    registerShapeRoutes(app, {
      estate: async (tool) => {
        touched.push(tool);
        return null;
      },
      repos: async () => [],
      audit: { record: () => undefined },
      actorOf: () => agent,
    });
    await app.ready();
    const p = await app.inject({ method: 'POST', url: '/api/v1/sources/support-pg/profile' });
    expect(p.statusCode).toBe(403);
    expect(p.json()).toMatchObject({ code: 'profile_human_only' });
    const m = await app.inject({ method: 'GET', url: '/api/v1/knowledge/map' });
    expect(m.statusCode).toBe(403);
    expect(m.json()).toMatchObject({ code: 'knowledge_map_human_only' });
    expect(touched).toEqual([]);
    await app.close();
  });
});

describe('review r1 folds', () => {
  const res = (cols: Record<string, number>): SqlReadResult => ({ columns: Object.keys(cols).map((name) => ({ name, type: 'bigint' })), rows: [Object.values(cols)], truncated: false, ms: 1 });

  it('reads a wide table in chunks of at most 8 distinct counts, each chunk agreeing on the row count', async () => {
    const wide = rel('s.wide', Array.from({ length: 20 }, (_, i): [string, string] => [`c${i}`, i === 5 ? 'json' : 'integer']), ['c0']);
    const sqls = relationSqls(wide);
    expect(sqls).toHaveLength(3);
    for (const q of sqls) expect((q.match(/count\(DISTINCT/g) ?? []).length).toBeLessThanOrEqual(8);
    const seen: string[] = [];
    const p = await profileSource([wide], async (sql) => {
      seen.push(sql);
      const cols: Record<string, number> = { n: 50 };
      for (const m of sql.matchAll(/ AS (nn\d+|d\d+)/g)) cols[m[1]!] = 50;
      return res(cols);
    });
    expect(seen).toEqual(sqls);
    expect(p.relations[0]!.columns).toHaveLength(20);
    expect(p.relations[0]!.columns.every((c) => c.cardinality === (c.name === 'c5' ? 'unknown' : 'unique'))).toBe(true);
  });

  it('stops at the profile budget: nothing more is read, the rest is reported "budget"', async () => {
    let t = 0;
    const reads: string[] = [];
    const p = await profileSource([REGIONS, TICKETS], async (sql) => {
      reads.push(sql);
      t += 1000;
      return res({ n: 4, nn0: 4, d0: 4, nn1: 4, d1: 4, nn2: 4, d2: 2 });
    }, { now: () => t, endsAt: 500 });
    expect(reads).toHaveLength(1);
    expect(p.relations.map((r) => [r.key, r.error])).toEqual([['support.regions', null], ['support.tickets', 'budget']]);
    expect(p.joins.every((j) => j.overlap === null)).toBe(true);
  });

  it('keeps two foreign keys on the same columns, and picks a name-and-type target of the right type first', () => {
    const a = rel('s.a', [['id', 'integer']], ['id'], [
      { columns: ['id'], references: { schema: 's', table: 'b', columns: ['id'] } },
      { columns: ['id'], references: { schema: 's', table: 'c', columns: ['id'] } },
    ]);
    const b = rel('s.b', [['id', 'integer']], ['id']);
    const c = rel('s.c', [['id', 'integer']], ['id']);
    expect(joinCandidates([a, b, c]).map((j) => j.to)).toEqual(['s.b', 's.c']);
    const orders = rel('s.orders', [['id', 'integer'], ['customer_id', 'uuid']], ['id']);
    const customer = rel('s.customer', [['id', 'integer']], ['id']);
    const customers = rel('s.customers', [['id', 'uuid']], ['id']);
    expect(joinCandidates([orders, customer, customers]).map((j) => j.to)).toEqual(['s.customers']);
  });

  it('one joins edge per related table with every condition, under estate\'s evidence bound; a self-join is said, not drawn', () => {
    const j = (columns: string[], references: string[], to = 's.users'): JoinProfileT => ({ from: 's.tickets', columns, to, references, basis: 'fk', overlap: 'all' });
    const profile = {
      relations: [{ key: 's.tickets', rows: '1-99' as const, error: null, columns: [] }],
      joins: [j(['reporter_id'], ['id']), j(['assignee_id'], ['id']), j(['parent_id'], ['id'], 's.tickets')],
    };
    const [t] = shapeProposals({ id: SID, name: 'pg' }, profile, new Map(), '2026-11-04T00:00:00Z');
    expect(t!.payload.relate.filter((r) => r.rel === 'joins')).toEqual([
      { rel: 'joins', from: catalogDocId(SID, 's.tickets'), to: catalogDocId(SID, 's.users'), confidence: 0.95, evidence: { basis: 'fk', on: [{ columns: ['reporter_id'], references: ['id'], basis: 'fk', overlap: 'all' }, { columns: ['assignee_id'], references: ['id'], basis: 'fk', overlap: 'all' }] } },
    ]);
    expect(t!.payload.content).toContain('It joins itself on parent_id = id (a foreign key).');
    const long = Array.from({ length: 9 }, (_, i) => `${'x'.repeat(60)}_${i}`);
    const ev = joinEvidence([j(long, long), j(long, long), j(long, long)]);
    expect(Buffer.byteLength(JSON.stringify(ev))).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(ev)).toContain('"cut":true');
  });

  it('a shape profiled again another day, unchanged, is not filed again; a changed code endpoint is', async () => {
    const profile = { relations: [{ key: 's.t', rows: '1-99' as const, error: null, columns: [] }], joins: [] };
    const code = (symbolId: string) => new Map([['s.t', [{ repo: 'r', symbolId, name: 'T', kind: 'class', file: 'x' }]]]);
    const stored: unknown[] = [];
    const estate = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      if (tool === 'proposal.list') return { proposals: stored };
      // Estate hands a payload back with its keys in its own (sorted) order.
      const sortDeep = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortDeep) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v);
      stored.push({ id: `p${stored.length}`, state: 'rejected', payload: sortDeep(args['payload']) });
      return { id: `p${stored.length - 1}` };
    };
    expect((await fileShapes(estate, shapeProposals({ id: SID, name: 'pg' }, profile, code('a#'), '2026-11-04T00:00:00Z'))).filed).toHaveLength(1);
    expect(await fileShapes(estate, shapeProposals({ id: SID, name: 'pg' }, profile, code('a#'), '2026-11-09T00:00:00Z'))).toEqual({ filed: [], skipped: 1 });
    expect((await fileShapes(estate, shapeProposals({ id: SID, name: 'pg' }, profile, code('b#'), '2026-11-09T00:00:00Z'))).filed).toHaveLength(1);
  });

  it('reads a catalog as one generation: a replaced generation starts again, and one that keeps changing is an error', async () => {
    let gen = 1;
    const calls: Array<Record<string, unknown>> = [];
    const estate = async (_tool: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push(args);
      if (args['generation'] !== undefined && args['generation'] !== gen) throw new Error('source_catalog: generation changed during the read');
      const page = args['page'] as number;
      if (page === 0 && calls.length === 1) gen = 2; // replaced right after page 0 of the first attempt
      return { generation: calls.length === 1 ? 1 : gen, pages: 2, docs: [{ key: `t${page}` }] };
    };
    expect(await readCatalog(estate, SID, [`source:${SID}`])).toEqual({ docs: [{ key: 't0', title: null, entry: null }, { key: 't1', title: null, entry: null }], generation: 2, truncated: false });
    const always = async (_t: string, args: Record<string, unknown>): Promise<unknown> => {
      if (args['page'] === 1) throw new Error('source_catalog: generation changed during the read');
      return { generation: 1, pages: 2, docs: [{ key: 't0' }] };
    };
    await expect(readCatalog(always, SID, [])).rejects.toBeInstanceOf(CatalogChangedError);
    expect(await readCatalog(async () => { throw new Error('no visible catalog for source "x"'); }, SID, [])).toBeNull();
    // A replacement seen on page 0 is retried too; a transport failure on a later page is estate failing, said so.
    let n = 0;
    const page0 = async (): Promise<unknown> => {
      n++;
      if (n === 1) throw new Error('source_catalog: generation changed during the read');
      return { generation: 3, pages: 1, docs: [{ key: 't0' }] };
    };
    expect((await readCatalog(page0, SID, []))?.generation).toBe(3);
    const broken = async (_t: string, args: Record<string, unknown>): Promise<unknown> => {
      if (args['page'] === 1) throw new Error('estate-mcp exited early');
      return { generation: 1, pages: 2, docs: [{ key: 't0' }] };
    };
    await expect(readCatalog(broken, SID, [])).rejects.toThrow('exited early');
  });

  it('profiles estate\'s documents by their own keys (quoted ones too), matched to crew\'s catalog; others are counted', () => {
    const cat = { dialect: 'postgres', database: 'd', describedAt: '', relations: [
      { schema: 'support', name: 'order-items', kind: 'table', rowEstimate: 1, comment: null, columns: [{ name: 'ticket_id', type: 'integer', nullable: true, default: null, comment: null }], primaryKey: [], foreignKeys: [{ name: 'f', columns: ['ticket_id'], references: { schema: 'support', table: 'tickets', columns: ['id'] } }], enums: [] },
      { schema: 'support', name: 'tickets', kind: 'table', rowEstimate: 1, comment: null, columns: [{ name: 'id', type: 'integer', nullable: false, default: null, comment: null }], primaryKey: ['id'], foreignKeys: [], enums: [] },
      { schema: 'support', name: 'v', kind: 'view', rowEstimate: null, comment: null, columns: [], primaryKey: [], foreignKeys: [], enums: [] },
    ] } as unknown as SqlCatalog;
    const got = relationsFromCatalog([
      { key: 'support."order-items"', entry: { schema: 'support', name: 'order-items' } },
      { key: 'support.tickets', entry: null },
      { key: 'support.v', entry: { schema: 'support', name: 'v' } },
      { key: 'support.gone', entry: { schema: 'support', name: 'gone' } },
    ], cat, []);
    expect(got.relations.map((r) => r.key)).toEqual(['support."order-items"', 'support.tickets']);
    expect(got.notInCatalog).toBe(2);
    // Its key is estate's; the join to tickets resolves by schema and name, not by the key's spelling.
    expect(joinCandidates(got.relations).map((j) => [j.from, j.to])).toEqual([['support."order-items"', 'support.tickets']]);
  });

  it('a describes edge\'s evidence stays under estate\'s bound (cut and marked)', () => {
    const ev = codeEvidence({ repo: 'r', symbolId: 'x', name: 'T', kind: 'class', file: `${'deep/'.repeat(300)}t.ts` });
    expect(Buffer.byteLength(JSON.stringify(ev))).toBeLessThanOrEqual(1000);
    expect(ev).toMatchObject({ basis: 'name', name: 'T', cut: true });
  });

  it('a column type the source cannot count distinct: the relation is read again without distinct counts', async () => {
    const reads: string[] = [];
    const p = await profileSource([REGIONS], async (sql) => {
      reads.push(sql);
      if (sql.includes('DISTINCT')) throw Object.assign(new Error('could not identify an equality operator'), { errorClass: 'source' });
      return res({ n: 4, nn0: 4, nn1: 4, nn2: 4 });
    });
    expect(reads).toHaveLength(2);
    expect(p.relations[0]).toMatchObject({ rows: '1-99', error: null });
    expect(p.relations[0]!.columns.every((c) => c.cardinality === 'unknown')).toBe(true);
  });

  it('the map never redraws a source it could not read, nor more tables than its bound, from a neighbourhood', async () => {
    const doc = (k: string): string => catalogDocId(SID, k);
    const m = await buildKnowledgeMap(async (tool, args) => {
      if (tool === 'knowledge.source_catalog') {
        if (args['page'] === 1) throw new Error('source_catalog: generation changed during the read');
        return { generation: 1, pages: 2, docs: [{ key: 't0' }] };
      }
      if (tool === 'proposal.list') return { proposals: [{ id: 'p1', payload: { class: 'concept', relate: [] } }] };
      return {
        nodes: [
          { store: 'knowledge', id: 'kconcept synthetic proposal:p1:', class: 'kconcept', label: 's', scope: `source:${SID}`, deps: [], hydrated: true },
          { store: 'knowledge', id: doc('t0'), class: 'kdoc', label: 't0', scope: `source:${SID}`, deps: [], hydrated: true },
        ],
        edges: [{ rel: 'derived_from', from: { store: 'knowledge', id: 'kconcept synthetic proposal:p1:' }, to: { store: 'knowledge', id: doc('t0') }, owner: 'x', confidence: 1, meta: {} }],
      };
    }, [{ id: SID, name: 'pg', described: true }], []);
    expect(m.nodes.filter((n) => n.kind === 'table')).toEqual([]);
  });

  it('code search: a deadline mid-repo stops it (repo not searched), CLI kinds like TypeAlias count, stale-graph output parses, capped repos are named', async () => {
    expect(cliRows('STALENESS: 3 commits since the index\n[{"symbol_id":"x","name":"T","kind":"TypeAlias","file":"a.ts"}]\n')).toEqual([{ symbol_id: 'x', name: 'T', kind: 'TypeAlias', file: 'a.ts' }]);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, code_graph_db: `/g/${i}.db` }));
    const target = searchableRepos(many, () => true);
    expect(target.capped).toEqual(['r8', 'r9']);
    let calls = 0;
    let clock = 0;
    // Each lookup takes 30 (fake) ms of a 50 ms budget: the second starts at 30, the third would start at 60.
    const got = await searchEntities(new Map([['s.t', ['T', 'Ts']], ['s.u', ['U', 'Us']]]), { repos: target.repos.slice(0, 1), capped: target.capped }, async (_repo, name, left) => {
      calls++;
      expect(left).toBeGreaterThan(0);
      clock += 30;
      return name === 'T' ? [{ symbol_id: 'x/T#', name: 'T', kind: 'TypeAlias', file: 'a.ts' }] : [];
    }, 50, () => clock);
    expect(calls).toBe(2);
    expect(got.matches.get('s.t')).toEqual([{ repo: 'r0', symbolId: 'x/T#', name: 'T', kind: 'TypeAlias', file: 'a.ts' }]);
    expect(got.searched).toEqual([]);
    expect(got.notSearched).toEqual(['r0', 'r8', 'r9']);
  });

  it('the map leaves out a catalog estate replaced mid-read (with a note), never half of it', async () => {
    const m = await buildKnowledgeMap(async (tool, args) => {
      if (tool === 'knowledge.source_catalog') {
        if (args['page'] === 1) throw new Error('source_catalog: generation changed during the read');
        return { generation: 1, pages: 2, docs: [{ key: 't0' }] };
      }
      return { proposals: [] };
    }, [{ id: SID, name: 'pg', described: true }], []);
    expect(m.nodes.filter((n) => n.kind === 'table')).toEqual([]);
    expect(m.notes).toEqual(["pg's tables could not be read from estate just now"]);
    expect(m.truncated).toBe(true);
  });

  it('the profile reads at the profile priority through the person path', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = Fastify({ logger: false });
    const catalog = { dialect: 'postgres', database: 'd', describedAt: '2026-11-04T00:00:00Z', relations: [{ schema: 's', name: 't', kind: 'table', rowEstimate: 1, comment: null, columns: [{ name: 'id', type: 'integer', nullable: false, default: null, comment: null }], primaryKey: ['id'], foreignKeys: [], enums: [] }] };
    const src = { id: SID, name: 'pg', enabled: true, runtime: 'native', dialect: 'postgres', viewsAllowed: [], description: { catalog }, config: { name: 'pg', kind: 'sql', auth: null, sql: { driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'd', user: 'u', tls: 'disable' }, address: { allow: ['127.0.0.0/8'], plaintext: true } } };
    registerShapeRoutes(app, {
      registry: { callSecret: async () => ({ secret: 'pw', missing: false }) },
      gate: {
        sources: async () => [src] as never,
        personRead: async (_name: string, r: Record<string, unknown>) => {
          seen.push(r);
          return res({ n: 3, nn0: 3, d0: 3 });
        },
      } as never,
      estate: async (tool) => (tool === 'knowledge.source_catalog' ? { generation: 1, pages: 1, docs: [{ key: 's.t' }] } : tool === 'proposal.list' ? { proposals: [] } : { id: 'p1' }),
      repos: async () => {
        throw new Error('adapter down');
      },
      audit: { record: () => undefined },
      actorOf: () => Object.freeze({ id: 'me', kind: 'human', trust: 'admin' }) as Actor,
    });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/api/v1/sources/pg/profile' });
    expect(r.statusCode, r.body).toBe(200);
    expect(seen.map((x) => x['cls'])).toEqual(['profile']);
    expect(seen[0]).toMatchObject({ rowCap: 1, maxBytes: 64 * 1024, deadlineMs: 10_000 });
    expect(r.json()).toMatchObject({ codeSearch: { searched: [], notSearched: [] }, proposed: [{ id: 'p1', relation: 's.t' }] });
    await app.close();
  });
});

describe('review r3 folds', () => {
  const res = (cols: Record<string, number>): SqlReadResult => ({ columns: Object.keys(cols).map((name) => ({ name, type: 'bigint' })), rows: [Object.values(cols)], truncated: false, ms: 1 });

  it('a name-and-type guess needs a known key type: a date key is no candidate, the text one is', () => {
    const orders = rel('s.orders', [['id', 'integer'], ['customer_id', 'text']], ['id']);
    const customer = rel('s.customer', [['id', 'date']], ['id']);
    const customers = rel('s.customers', [['id', 'text']], ['id']);
    expect(joinCandidates([orders, customer, customers]).map((j) => j.to)).toEqual(['s.customers']);
  });

  it('a shape holds at most 200 links (relate + relate_code); joins beyond are counted, never sent', () => {
    const others = Array.from({ length: 199 }, (_, i) => `s.t${i}`);
    const profile = {
      relations: [{ key: 's.hub', rows: '1-99' as const, error: null, columns: [] }],
      joins: others.map((to) => ({ from: 's.hub', columns: [`${to.slice(2)}_id`], to, references: ['id'], basis: 'fk' as const, overlap: 'all' as const })),
    };
    const code = new Map([['s.hub', [1, 2, 3].map((i) => ({ repo: 'r', symbolId: `x${i}`, name: 'Hub', kind: 'class', file: 'f' }))]]);
    const [hub] = shapeProposals({ id: SID, name: 'pg' }, profile, code, '2026-11-04T00:00:00Z');
    expect(hub!.payload.relate.length + hub!.payload.relate_code.length).toBe(200);
    expect(hub!.payload.shape.linksNotListed).toBe(3);
    expect(hub!.payload.shape.joins).toHaveLength(199);
  });

  it('the map counts and bounds shapes by what it draws, and bounds tables through neighbourhoods too', async () => {
    const approved = Array.from({ length: 2 }, (_, i) => ({ id: `p${i}`, payload: { class: 'concept', relate: [], shape: { relation: `t${i}` } } }));
    const tables = Array.from({ length: MAP_TABLES_MAX }, (_, i) => ({ key: `s.c${i}` }));
    const m = await buildKnowledgeMap(async (tool, args) => {
      if (tool === 'knowledge.source_catalog') return { generation: 1, pages: 1, docs: tables };
      if (tool === 'proposal.list') return { proposals: approved };
      const me = String(args['id']);
      return {
        nodes: [
          { store: 'knowledge', id: me, class: 'kconcept', label: 's', scope: `source:${SID}`, deps: [], hydrated: true },
          // Another approved shape reached through a table, and a table the catalog bound left out.
          { store: 'knowledge', id: 'kconcept synthetic proposal:other:', class: 'kconcept', label: 'o', scope: `source:${SID}`, deps: [], hydrated: true },
          { store: 'knowledge', id: catalogDocId(SID, 's.extra'), class: 'kdoc', label: 's.extra', scope: `source:${SID}`, deps: [], hydrated: true },
        ],
        edges: [],
      };
    }, [{ id: SID, name: 'pg', described: true }], []);
    expect(m.nodes.filter((n) => n.kind === 'table')).toHaveLength(MAP_TABLES_MAX);
    expect(m.shapes).toBe(m.nodes.filter((n) => n.kind === 'shape').length);
    expect(m.shapes).toBe(3);
    expect(m.truncated).toBe(true);
  });

  it('a source switched off, re-saved or narrowed mid-profile stops the next read and files nothing', async () => {
    const catalog = { dialect: 'postgres', database: 'd', describedAt: '', relations: ['a', 'b'].map((n) => ({ schema: 's', name: n, kind: 'table', rowEstimate: 1, comment: null, columns: [{ name: 'id', type: 'integer', nullable: false, default: null, comment: null }], primaryKey: ['id'], foreignKeys: [], enums: [] })) };
    for (const change of ['off', 'resaved', 'views'] as const) {
      let reads = 0;
      const submits: unknown[] = [];
      const src = (): Record<string, unknown> => ({
        id: SID, name: 'pg', runtime: 'native', dialect: 'postgres', description: { catalog },
        enabled: !(reads > 0 && change === 'off'),
        descriptorHash: reads > 0 && change === 'resaved' ? 'h2' : 'h1',
        viewsAllowed: reads > 0 && change === 'views' ? [] : ['s.v'],
        config: { name: 'pg', kind: 'sql', auth: null, sql: { driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'd', user: 'u', tls: 'disable' }, address: { allow: ['127.0.0.0/8'], plaintext: true } },
      });
      const app = Fastify({ logger: false });
      registerShapeRoutes(app, {
        registry: { callSecret: async () => ({ secret: null, missing: false }) },
        gate: { sources: async () => [src()] as never, personRead: async () => { reads++; return res({ n: 1, nn0: 1, d0: 1 }); } } as never,
        estate: async (tool, args) => {
          if (tool === 'knowledge.source_catalog') return { generation: 1, pages: 1, docs: [{ key: 's.a' }, { key: 's.b' }] };
          if (tool === 'proposal.list') return { proposals: [] };
          submits.push(args);
          return { id: 'x' };
        },
        repos: async () => [],
        audit: { record: () => undefined },
        actorOf: () => Object.freeze({ id: 'me', kind: 'human', trust: 'admin' }) as Actor,
      });
      await app.ready();
      const r = await app.inject({ method: 'POST', url: '/api/v1/sources/pg/profile' });
      expect(r.statusCode, `${change}: ${r.body}`).toBe(409);
      expect(r.json()).toMatchObject({ code: 'source_changed' });
      expect(reads, change).toBe(1);
      expect(submits, change).toEqual([]);
      await app.close();
    }
  });

  it('the map answers 503 when the registry cannot be read (never an undeclared 500)', async () => {
    const app = Fastify({ logger: false });
    registerShapeRoutes(app, {
      gate: { sources: async () => { throw new Error('EIO'); } } as never,
      estate: async () => null,
      repos: async () => [],
      audit: { record: () => undefined },
      actorOf: () => Object.freeze({ id: 'me', kind: 'human', trust: 'admin' }) as Actor,
    });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/v1/knowledge/map' });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'registry_unavailable' });
    await app.close();
  });
});

type JoinProfileT = import('../src/knowledge/shapes/profile.js').JoinProfile;
