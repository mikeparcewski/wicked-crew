// DES-APPS-001 §9.2 step 3 (K2b): the source stage, K2a's `AppSourceStage` seam implemented over K1's checks.
// A version holding queries or actions lands when their check passes (before: 409 source_check_unavailable),
// and is refused with findings, in crew's words, when it does not. The real-database half runs on Postgres
// 16 and 17 (CI job sources-db); locally it skips without APPS_PG16_URL / APPS_PG17_URL.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AppAction, AppDetail, AppQuery, AppVersion } from '../src/core/types.js';
import { startGraphqlServer, startMcpServer, startOpenApiService } from './fixtures/apps-sources/servers.mjs';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';
import { DB_REQUIRED, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

type Landed = { app: AppDetail; landed: AppVersion; findings?: Array<{ stage: string; code: string; path: string; message: string }> };

const runsQuery: AppQuery = { id: 'my_runs', source: 'crew', kind: 'crew', rowPath: '$.runs[*]', output: [{ name: 'id', type: 'string' }] };

describe('the source stage without a database', () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it('a version holding a query lands once the stage is wired; without it, 409 source_check_unavailable (the seam K2a left)', async () => {
    h = await appsHarness();
    await h.newApp('runs-board');
    const stage = h.store.sourceStage;
    h.store.sourceStage = null; // the daemon before this slice
    const before = await h.land('runs-board', specWith([runsQuery]), { my_runs: JSON.stringify({ route: '/runs' }) });
    expect(before.status).toBe(409);
    expect(before.body.code).toBe('source_check_unavailable');
    h.store.sourceStage = stage;
    const after = await h.land('runs-board', specWith([runsQuery]), { my_runs: JSON.stringify({ route: '/runs' }) });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    const body = after.body as unknown as Landed;
    expect(body.landed.receipt?.kind).toBe('you');
    expect(body.landed.check).toEqual({ level: 'data', checked: ['my_runs'] });
    expect(body.app.lock.sources['crew']).toMatchObject({ kind: 'crew', descriptor: { kind: 'crew' } });
    expect(body.app.lock.queries['my_runs']?.contractHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses what the source cannot answer, naming the query: an unknown crew route, a missing :param, an unknown source', async () => {
    h = await appsHarness();
    await h.newApp('runs-board');
    const refused = async (q: AppQuery, text: string) => {
      const r = await h.land('runs-board', specWith([q]), { [q.id]: text });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return (r.body as unknown as Landed).findings!;
    };
    expect((await refused(runsQuery, JSON.stringify({ route: '/audit' })))[0]).toMatchObject({ stage: 'source', code: 'crew_route', path: '$.queries[0]' });
    expect((await refused(runsQuery, JSON.stringify({ route: '/runs/:id' })))[0]?.message).toContain(':id');
    expect((await refused(runsQuery, JSON.stringify({ route: '/runs', extra: 1 })))[0]).toMatchObject({ stage: 'spec', code: 'query_text' });
    const sql: AppQuery = { id: 'tickets', source: 'support', kind: 'sql', output: [{ name: 'n', type: 'integer' }] };
    expect((await refused(sql, 'SELECT 1 AS n'))[0]).toMatchObject({ code: 'unknown_source', message: 'query tickets: no source named support' });
  });

  it('`$n` binds the n-th declared parameter, so reordering the parameters is checked again (canonical JSON alone would not see it)', async () => {
    h = await appsHarness();
    await h.newApp('runs-board');
    const q = (order: Array<'id' | 'note'>): AppQuery => ({
      ...runsQuery,
      id: 'one_run',
      rowPath: '$.run',
      params: { type: 'object', properties: Object.fromEntries(order.map((n) => [n, { type: 'string' as const, default: 'x' }])) },
    });
    const text = { one_run: JSON.stringify({ route: '/runs/:id', params: { id: { kind: 'param', name: 'id' } } }) };
    const first = await h.land('runs-board', specWith([q(['id', 'note'])]), text);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const same = await h.land('runs-board', specWith([q(['id', 'note'])], [], { name: 'K2b renamed' }), text);
    expect((same.body as unknown as Landed).landed.check).toEqual({ level: 'spec', checked: [] });
    const reordered = await h.land('runs-board', specWith([q(['note', 'id'])]), text);
    expect((reordered.body as unknown as Landed).landed.check).toEqual({ level: 'data', checked: ['one_run'] });
  });
});

type Fixture = { origin: string; hits: unknown[]; close: () => Promise<void> };

describe('the source stage over REST, MCP and GraphQL sources (the K1 test services)', () => {
  let h: Harness;
  let api: Fixture;
  let mcp: Fixture;
  let gql: Fixture;
  const LOOP = { allow: ['127.0.0.0/8'] };
  beforeAll(async () => {
    api = (await startOpenApiService()) as Fixture;
    mcp = (await startMcpServer()) as Fixture;
    gql = (await startGraphqlServer()) as Fixture;
    h = await appsHarness();
    await h.register({ name: 'tickets', kind: 'rest', url: `${api.origin}/v1`, openapiUrl: `${api.origin}/openapi.json`, address: LOOP });
    await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: LOOP });
    await h.register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    await h.newApp('desk');
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await api?.close();
    await mcp?.close();
    await gql?.close();
  });

  const tool = (id: string, source: string, kind: 'rest' | 'mcp'): AppQuery => ({ id, source, kind, rowPath: '$.data.items[*]', output: [{ name: 'id', type: 'integer' }] });
  const land = (queries: AppQuery[], texts: Record<string, string>, actions: AppAction[] = []) => h.land('desk', specWith(queries, actions), texts);

  it('a REST read, an MCP read and a GraphQL query land, each with its contract; a tool action and a one-field mutation too', async () => {
    const assignArgs = { id: { kind: 'param' as const, name: 'id' }, owner: { kind: 'viewer' as const, claim: 'email' as const } };
    const params = { type: 'object' as const, properties: { id: { type: 'integer' as const } }, required: ['id'] };
    const r = await land(
      [
        tool('list_rest', 'tickets', 'rest'),
        tool('list_mcp', 'ref', 'mcp'),
        { id: 'list_gql', source: 'tix', kind: 'graphql', rowPath: '$.data.tickets[*]', params: { type: 'object', properties: { status: { type: 'string', default: 'OPEN' } } }, output: [{ name: 'id', type: 'integer' }] },
      ],
      {
        list_rest: JSON.stringify({ tool: 'listTickets', args: { page: { kind: 'literal', value: 1 } } }),
        list_mcp: JSON.stringify({ tool: 'list_tickets', args: {} }),
        list_gql: 'query ($status: Status) { tickets(status: $status) { id } }',
      },
      [
        { id: 'assign_mcp', kind: 'api', source: 'ref', call: { kind: 'tool', tool: 'assign_ticket' }, args: assignArgs, params },
        { id: 'assign_gql', kind: 'api', source: 'tix', call: { kind: 'mutation', mutation: 'mutation ($id: Int!, $owner: String!) { assign(id: $id, owner: $owner) { id } }' }, args: assignArgs, params },
      ],
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lock = (r.body as unknown as Landed).app.lock;
    expect(Object.keys(lock.queries).sort()).toEqual(['list_gql', 'list_mcp', 'list_rest']);
    expect(Object.keys(lock.actions).sort()).toEqual(['assign_gql', 'assign_mcp']);
    expect(Object.keys(lock.sources).sort()).toEqual(['ref', 'tickets', 'tix']);
    expect(lock.sources['ref']?.descriptor).toMatchObject({ kind: 'mcp-http', command: null });
  });

  it('refuses a write tool as a read, an argument the tool does not take, two root fields, a variable with no argument', async () => {
    const first = async (queries: AppQuery[], texts: Record<string, string>, actions: AppAction[] = []) => {
      const r = await land(queries, texts, actions);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return (r.body as unknown as Landed).findings![0]!;
    };
    expect(await first([tool('q', 'ref', 'mcp')], { q: JSON.stringify({ tool: 'assign_ticket', args: {} }) })).toMatchObject({ code: 'not_a_read' });
    expect(await first([tool('q', 'tickets', 'rest')], { q: JSON.stringify({ tool: 'assignTicket', args: {} }) })).toMatchObject({ code: 'not_a_read' });
    expect(await first([tool('q', 'ref', 'mcp')], { q: JSON.stringify({ tool: 'list_tickets', args: { nope: { kind: 'literal', value: 1 } } }) })).toMatchObject({ code: 'unknown_argument' });
    expect(await first([tool('q', 'ref', 'mcp')], { q: JSON.stringify({ tool: 'list_tickets', args: { status: { kind: 'param', name: 'missing' } } }) })).toMatchObject({ code: 'unknown_param' });
    const params = { type: 'object' as const, properties: { id: { type: 'integer' as const } }, required: ['id'] };
    const two: AppAction = { id: 'a', kind: 'api', source: 'tix', call: { kind: 'mutation', mutation: 'mutation ($id: Int!) { a: assign(id: $id, owner: "x") { id } b: assign(id: $id, owner: "y") { id } }' }, args: { id: { kind: 'param', name: 'id' } }, params };
    expect(await first([], {}, [two])).toMatchObject({ code: 'root_fields' });
    const noArg: AppAction = { ...two, call: { kind: 'mutation', mutation: 'mutation ($id: Int!, $owner: String!) { assign(id: $id, owner: $owner) { id } }' } };
    expect(await first([], {}, [noArg])).toMatchObject({ code: 'unknown_argument' });
    const rowOnRest: AppAction = { id: 'w', kind: 'row-write', source: 'tickets', table: 's.w', op: 'delete', key: { id: { kind: 'param', name: 'id' } }, params };
    expect(await first([], {}, [rowOnRest])).toMatchObject({ code: 'writes_not_supported' });
  });
});

if (PG_TARGETS.length === 0) {
  describe('the source stage on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the source stage on ${target.label}`, () => {
    let db: FreshPg;
    let h: Harness;
    let descriptorHash = '';
    beforeAll(async () => {
      db = await freshPgDatabase(target);
      h = await appsHarness();
      descriptorHash = (await h.addPg('support', { port: db.port, database: db.database, user: 'apps_reader', password: 'apps-reader' })).descriptorHash ?? '';
      await h.newApp('tickets');
    }, 60_000);
    afterAll(async () => {
      await h?.close();
      await db?.drop();
    });

    const byId: AppQuery = {
      id: 'by_id',
      source: 'support',
      kind: 'sql',
      params: { type: 'object', properties: { id: { type: 'integer', default: 4821 } } },
      output: [
        { name: 'id', type: 'integer' },
        { name: 'owner', type: 'string' },
      ],
    };
    const text = 'SELECT w.id, w.owner FROM s.w AS w WHERE w.id = $1';

    it('a SQL query lands with its contract and the source pin (the descriptor K1 saved)', async () => {
      const r = await h.land('tickets', specWith([byId]), { by_id: text });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const app = (r.body as unknown as Landed).app;
      expect(app.lock.sources['support']).toMatchObject({ kind: 'sql', descriptorHash });
      expect(app.lock.queries['by_id']?.contractHash).toMatch(/^[0-9a-f]{64}$/);
    });

    const findingOf = async (queries: AppQuery[], texts: Record<string, string>, actions: AppAction[] = []) => {
      const r = await h.land('tickets', specWith(queries, actions), texts);
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return (r.body as unknown as Landed).findings![0]!;
    };

    it('refuses, in crew words: the read policy, the declared output, the parameter count and types, a source prepare error', async () => {
      expect(await findingOf([byId], { by_id: 'SELECT pg_sleep(1) AS id, 1 AS owner' })).toMatchObject({ stage: 'policy', code: 'function' });
      expect(await findingOf([{ ...byId, output: [{ name: 'id', type: 'integer' }] }], { by_id: text })).toMatchObject({ code: 'output_columns' });
      expect(await findingOf([{ ...byId, output: [{ name: 'id', type: 'integer' }, { name: 'owner', type: 'integer' }] }], { by_id: text })).toMatchObject({ code: 'output_type' });
      const two = { ...byId, params: { type: 'object' as const, properties: { id: { type: 'integer' as const, default: 1 }, extra: { type: 'string' as const, default: 'x' } } } };
      expect(await findingOf([two], { by_id: text })).toMatchObject({ code: 'params' });
      const asString = { ...byId, params: { type: 'object' as const, properties: { id: { type: 'string' as const, default: '4821' } } } };
      expect(await findingOf([asString], { by_id: text })).toMatchObject({ code: 'param_type' });
      // The source's own words never reach a finding (an agent reads them): the SQLSTATE does.
      const f = await findingOf([byId], { by_id: 'SELECT w.id, w.nosuch AS owner FROM s.w AS w WHERE w.id = $1' });
      expect(f.stage === 'policy' || f.message.includes('SQLSTATE 42703')).toBe(true);
      expect(f.message).not.toContain('does not exist');
    });

    const assign: AppAction = {
      id: 'assign',
      kind: 'row-write',
      source: 'support',
      table: 's.w',
      op: 'update',
      set: { owner: { kind: 'viewer', claim: 'email' } },
      key: { id: { kind: 'param', name: 'id' } },
      params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    };

    it('a row write lands on a plain table with its fingerprint inside the contract; an insert and a delete too', async () => {
      const insert: AppAction = { ...assign, id: 'add', op: 'insert', set: { id: { kind: 'param', name: 'id' }, owner: { kind: 'literal', value: 'nobody' } } };
      const del: AppAction = { id: 'drop', kind: 'row-write', source: 'support', table: 's.w', op: 'delete', key: { id: { kind: 'param', name: 'id' } }, params: assign.params! };
      const r = await h.land('tickets', specWith([], [assign, insert, del]));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const lock = (r.body as unknown as Landed).app.lock;
      expect(Object.keys(lock.actions).sort()).toEqual(['add', 'assign', 'drop']);
      expect(new Set(Object.values(lock.actions).map((a) => a.contractHash)).size).toBe(3);
    });

    it('refuses an unsafe table by its reason, and a value its column cannot take exactly', async () => {
      expect(await findingOf([], {}, [{ ...assign, table: 's.trig' }])).toMatchObject({ path: '$.actions[0]', code: 'user_trigger' });
      expect(await findingOf([], {}, [{ ...assign, table: 's.plain' }])).toMatchObject({ code: 'cascading_key' });
      const stringKey: AppAction = { ...assign, params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } };
      expect(await findingOf([], {}, [stringKey])).toMatchObject({ code: 'value_type' });
      const numberOwner: AppAction = { ...assign, set: { owner: { kind: 'literal', value: 5 } } };
      expect(await findingOf([], {}, [numberOwner])).toMatchObject({ code: 'value_type' });
      const nowOwner: AppAction = { ...assign, set: { owner: { kind: 'crew', value: 'now' } } };
      expect(await findingOf([], {}, [nowOwner])).toMatchObject({ code: 'value_type' });
      const ratio: AppAction = { ...assign, table: 's.money', set: { ratio: { kind: 'literal', value: 1 } } };
      expect(await findingOf([], {}, [ratio])).toMatchObject({ code: 'written_type' }); // P31: floating point
    });
  });
}
