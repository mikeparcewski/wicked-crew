// DES-APPS-001 §9.2 step 3 (K2b): the source stage, K2a's `AppSourceStage` seam implemented over K1's checks.
// A version holding queries or actions lands when their check passes (before: 409 source_check_unavailable),
// and is refused with findings, in crew's words, when it does not. The real-database half runs on Postgres
// 16 and 17 (CI job sources-db); locally it skips without APPS_PG16_URL / APPS_PG17_URL.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AppAction, AppDetail, AppQuery, AppVersion } from '../src/core/types.js';
import { AppsSourceStage } from '../src/apps/exec/source-stage.js';
import type { McpRegistry } from '../src/mcp/registry.js';
import type { McpToolRecord } from '../src/mcp/registry-store.js';
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

  it('fail closed (codex/pi r1): a path argument hidden by a same-named query value, a bad path literal, a __proto__ key, an id the spec lacks', async () => {
    h = await appsHarness();
    await h.newApp('runs-board');
    const one: AppQuery = { ...runsQuery, id: 'one_run', rowPath: '$.run' };
    const first = async (text: string) => {
      const r = await h.land('runs-board', specWith([one]), { one_run: text });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      return (r.body as unknown as Landed).findings![0]!;
    };
    expect(await first(JSON.stringify({ route: '/runs/:id', params: { id: { kind: 'param', name: 'undeclared' } }, query: { id: { kind: 'literal', value: 'mask' } } }))).toMatchObject({ code: 'unknown_param' });
    for (const bad of ['', '.', '..', '\uD800']) expect(await first(JSON.stringify({ route: '/runs/:id', params: { id: { kind: 'literal', value: bad } } }))).toMatchObject({ code: 'crew_route' });
    // r2: a path parameter with a bad default, or optional with none.
    const withParam = (decl: Record<string, unknown>): AppQuery => ({ ...one, params: { type: 'object', properties: { id: decl as never } } });
    const text = JSON.stringify({ route: '/runs/:id', params: { id: { kind: 'param', name: 'id' } } });
    for (const decl of [{ type: 'string', default: '.' }, { type: 'string' }]) {
      const r = await h.land('runs-board', specWith([withParam(decl)]), { one_run: text });
      expect((r.body as unknown as Landed).findings?.[0], JSON.stringify(decl)).toMatchObject({ code: 'crew_route' });
    }
    expect(await first('{"route": "/runs", "query": {"__proto__": {"kind": "param", "name": "missing"}}}')).toMatchObject({ code: 'query_text' });
    const stage = new AppsSourceStage({ registry: null });
    const r = await stage.check({ app: 'x', spec: specWith([]), queryText: {}, queries: ['ghost'], actions: ['phantom'] });
    expect(r.findings.map((f) => f.code)).toEqual(['unknown_query', 'unknown_action']);
  });

  it('a tool read with config A whose registry answers config B (a save between the two reads) is refused, never pinned to A (codex r1)', async () => {
    const config = (url: string) => ({ name: 'api', kind: 'rest' as const, command: null, args: [], url, auth: null });
    const tool: McpToolRecord = { name: 'list', description: null, inputSchema: null, outputSchema: null, annotations: { readOnlyHint: true }, classOverride: null, enabled: true, schemaHash: 'h', observedSchemaHash: 'h', present: true };
    const registry = {
      inspectTarget: async () => config('https://a.example/v1'),
      appTool: async () => ({ config: config('https://b.example/v1'), tool, bound: true }),
    } as unknown as McpRegistry;
    const stage = new AppsSourceStage({ registry });
    const q: AppQuery = { id: 'q', source: 'api', kind: 'rest', rowPath: '$.items[*]', output: [{ name: 'id', type: 'integer' }] };
    const r = await stage.check({ app: 'x', spec: specWith([q]), queryText: { q: JSON.stringify({ tool: 'list' }) }, queries: ['q'], actions: [] });
    expect(r.findings[0]).toMatchObject({ code: 'source_changed' });
    expect(r.queries).toEqual({});
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
        { id: 'list_gql', source: 'tix', kind: 'graphql', rowPath: '$.data.tickets[*]', params: { type: 'object', properties: { status: { type: 'string', enum: ['OPEN', 'CLOSED'], default: 'OPEN' } } }, output: [{ name: 'id', type: 'integer' }] },
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

  it('a GraphQL read through a root fragment and __typename lands (codex r1)', async () => {
    const q: AppQuery = { id: 'frag', source: 'tix', kind: 'graphql', rowPath: '$.data.tickets[*]', output: [{ name: 'id', type: 'integer' }] };
    const r = await land([q], { frag: 'query { __typename ...T } fragment T on Query { tickets { id } }' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
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
    // Typed arguments (codex r1): a literal the tool's schema refuses, a GraphQL Int filled from a string.
    expect(await first([tool('q', 'tickets', 'rest')], { q: JSON.stringify({ tool: 'listTickets', args: { page: { kind: 'literal', value: 'bad' } } }) })).toMatchObject({ code: 'argument_type' });
    const gq: AppQuery = { id: 'g', source: 'tix', kind: 'graphql', rowPath: '$.data.ticket', params: { type: 'object', properties: { id: { type: 'string', default: 'not an integer' } } }, output: [{ name: 'id', type: 'integer' }] };
    expect(await first([gq], { g: 'query ($id: Int!) { ticket(id: $id) { id } }' })).toMatchObject({ code: 'variable_type' });
    const lit: AppAction = { ...noArg, args: { id: { kind: 'literal', value: 'x' }, owner: { kind: 'viewer', claim: 'email' } } };
    expect(await first([], {}, [lit])).toMatchObject({ code: 'variable_type' });
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

    it('codex r1: a fraction for an integral placeholder; a description older than the table; a reorder of SQL parameters changes the contract', async () => {
      const asNumber = { ...byId, params: { type: 'object' as const, properties: { id: { type: 'number' as const, default: 1.5 } } } };
      expect(await findingOf([asNumber], { by_id: text })).toMatchObject({ code: 'param_type' });
      await db.admin.unsafe('ALTER TABLE s.w ALTER COLUMN owner TYPE varchar(200)');
      try {
        // A changed description makes the stage check the query again.
        expect(await findingOf([{ ...byId, description: 'stale' }], { by_id: text })).toMatchObject({ code: 'catalog_stale' });
        expect((await h.call('POST', '/sources/support/describe', {})).status).toBe(200);
        expect((await h.land('tickets', specWith([{ ...byId, description: 'fresh' }]), { by_id: text })).status).toBe(200);
      } finally {
        await db.admin.unsafe('ALTER TABLE s.w ALTER COLUMN owner TYPE text');
        await h.call('POST', '/sources/support/describe', {});
      }
      // r2: an enum array gaining a label, and row security turning forced, are changes to what the read relies on.
      await db.admin.unsafe("CREATE TYPE s.st2 AS ENUM ('open', 'closed'); CREATE TABLE s.arr (id int PRIMARY KEY, states s.st2[]); GRANT SELECT ON s.arr TO apps_reader");
      try {
        expect((await h.call('POST', '/sources/support/describe', {})).status).toBe(200);
        const arr: AppQuery = { id: 'arr', source: 'support', kind: 'sql', output: [{ name: 'id', type: 'integer' }, { name: 'states', type: 'string' }] };
        expect((await h.land('tickets', specWith([arr]), { arr: 'SELECT a.id, a.states FROM s.arr AS a' })).status).toBe(200);
        await db.admin.unsafe("ALTER TYPE s.st2 ADD VALUE 'held'");
        expect(await findingOf([{ ...arr, description: 'x' }], { arr: 'SELECT a.id, a.states FROM s.arr AS a' })).toMatchObject({ code: 'catalog_stale' });
      } finally {
        await db.admin.unsafe('DROP TABLE s.arr; DROP TYPE s.st2');
        await h.call('POST', '/sources/support/describe', {});
      }
      const two = (order: Array<'a' | 'b'>): AppQuery => ({ ...byId, params: { type: 'object', properties: Object.fromEntries(order.map((n) => [n, { type: 'integer' as const, default: 4821 }])) } });
      const t2 = 'SELECT w.id, w.owner FROM s.w AS w WHERE w.id = $1 AND w.id = $2';
      const ab = await h.land('tickets', specWith([two(['a', 'b'])]), { by_id: t2 });
      expect(ab.status, JSON.stringify(ab.body)).toBe(200);
      const ba = await h.land('tickets', specWith([two(['b', 'a'])]), { by_id: t2 });
      expect((ba.body as unknown as Landed).landed.check.checked).toEqual(['by_id']);
      expect((ba.body as unknown as Landed).app.lock.queries['by_id']?.contractHash).not.toBe((ab.body as unknown as Landed).app.lock.queries['by_id']?.contractHash);
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
      // pi r1: a fixed value the column's typmod would change is refused when the action lands (P28).
      const code: AppAction = { ...assign, table: 's.money', set: { code: { kind: 'literal', value: 'abcd' } } };
      expect(await findingOf([], {}, [code])).toMatchObject({ code: 'value_does_not_fit' });
      const amount: AppAction = { ...assign, table: 's.money', set: { amount: { kind: 'literal', value: '1.234' } } };
      expect(await findingOf([], {}, [amount])).toMatchObject({ code: 'value_does_not_fit' });
      await db.admin.unsafe('CREATE TABLE s.ts0 (id int PRIMARY KEY, at timestamp(0), at3 timestamptz(3), code varchar(3))');
      try {
        const at: AppAction = { ...assign, table: 's.ts0', set: { at: { kind: 'crew', value: 'now' } } };
        expect(await findingOf([], {}, [at])).toMatchObject({ code: 'value_does_not_fit' });
        // r2: crew fills milliseconds, which timestamptz(3) keeps; a uuid does not fit varchar(3).
        const at3: AppAction = { ...assign, table: 's.ts0', set: { at3: { kind: 'crew', value: 'now' } } };
        expect((await h.land('tickets', specWith([], [at3]))).status).toBe(200);
        const uuid: AppAction = { ...assign, table: 's.ts0', set: { code: { kind: 'crew', value: 'uuid' } } };
        expect(await findingOf([], {}, [uuid])).toMatchObject({ code: 'value_does_not_fit' });
        // r3: a viewer-bound parameter's declared values are known values too.
        const named: AppAction = { ...assign, table: 's.ts0', set: { code: { kind: 'param', name: 'me' } }, params: { type: 'object', properties: { id: { type: 'integer' }, me: { type: 'string', from: 'viewer.name', enum: ['Alice'] } }, required: ['id'] } };
        expect(await findingOf([], {}, [named])).toMatchObject({ code: 'value_does_not_fit' });
      } finally {
        await db.admin.unsafe('DROP TABLE s.ts0');
      }
      // r2: a parameter's default is a known value too.
      const dflt: AppAction = { ...assign, table: 's.money', set: { amount: { kind: 'param', name: 'amt' } }, params: { type: 'object', properties: { id: { type: 'integer' }, amt: { type: 'string', default: '1.234' } }, required: ['id'] } };
      expect(await findingOf([], {}, [dflt])).toMatchObject({ code: 'value_does_not_fit' });
      const ratio: AppAction = { ...assign, table: 's.money', set: { ratio: { kind: 'literal', value: 1 } } };
      expect(await findingOf([], {}, [ratio])).toMatchObject({ code: 'written_type' }); // P31: floating point
    });
  });
}
