// DES-APPS-001 §7.2, §7.5 (K2b): the query executor behind POST /apps/:app/query. Receipt → query →
// parameters (viewer-bound filled, a client value refused) → descriptor and contract recomputed against
// the lock → the read → projection, coercion, row and more paths → cache with generation. Against the K1
// test services (REST, MCP, GraphQL), the built-in crew source and, when set, real Postgres 16 and 17.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppReadCache } from '../src/apps/exec/cache.js';
import { AppLimits, RateLimited } from '../src/apps/exec/limits.js';
import { coerceCell, morePathSays, projectRows, selectPath } from '../src/apps/exec/project.js';
import type { AppQuery, AppQueryResponse } from '../src/core/types.js';
import { SECRET_REDACTION } from '../src/mcp/secrets.js';
import { startGraphqlServer, startMcpServer, startOpenApiService } from './fixtures/apps-sources/servers.mjs';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';
import { DB_REQUIRED, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

type Fixture = { origin: string; hits: Array<{ method: string; path: string }>; close: () => Promise<void> };
const LOOP = { allow: ['127.0.0.0/8'] };

describe('the executor: projection, coercion, paths, cache, limits (units)', () => {
  it('coerces int8 and numeric strings, refuses past 2^53, normalizes Postgres datetimes, renders objects as text', () => {
    expect(coerceCell('integer', '4821')).toEqual({ ok: true, cell: 4821 });
    expect(coerceCell('integer', '9007199254740993')).toMatchObject({ ok: false });
    expect(coerceCell('number', '12.50')).toEqual({ ok: true, cell: 12.5 });
    expect(coerceCell('number', 'NaN')).toMatchObject({ ok: false });
    expect(coerceCell('datetime', '2026-11-03 08:32:00.123456+00')).toEqual({ ok: true, cell: '2026-11-03T08:32:00.123456+00:00' });
    expect(coerceCell('date', '2026-11-03')).toEqual({ ok: true, cell: '2026-11-03' });
    expect(coerceCell('boolean', 1)).toEqual({ ok: true, cell: true });
    expect(coerceCell('string', { a: [1] })).toEqual({ ok: true, cell: '{"a":[1]}' });
    expect(coerceCell('integer', 'four')).toEqual({ ok: false, why: 'is not an integer' });
  });

  it('codex/pi r1: numbers underflowing or past 2^53, impossible dates and times are refused; a secret leaves no cell, before any cut; a selection is bounded', () => {
    expect(coerceCell('number', '1e-4000')).toMatchObject({ ok: false });
    expect(coerceCell('number', '9007199254740993.5')).toMatchObject({ ok: false });
    expect(coerceCell('number', '0.000')).toEqual({ ok: true, cell: 0 });
    expect(coerceCell('date', '2026-02-30')).toMatchObject({ ok: false });
    expect(coerceCell('datetime', '2026-13-40 99:99:99+99')).toMatchObject({ ok: false });
    expect(coerceCell('datetime', '2026-11-03 08:32+0530')).toEqual({ ok: true, cell: '2026-11-03T08:32+05:30' });
    const out = [{ name: 'n', type: 'integer' as const }, { name: 's', type: 'string' as const }];
    const r = projectRows(out, [{ n: 123456, s: `${'x'.repeat(65_530)}123456abc` }], false, ['123456']);
    expect(r.rows[0]![0]).toBeNull(); // a number that IS the secret is no value
    expect(String(r.rows[0]![1])).not.toContain('123'); // scrubbed before the 64 KB cut, so no fragment survives
    const big = { items: Array.from({ length: 200_000 }, (_v, i) => ({ id: i })) };
    const sel = selectPath(big, '$.items[*]', 5_000);
    expect(sel).toHaveLength(5_000);
    expect(sel.more).toBe(true);
  });

  it('selects rows and reads the more path with the subset ($, .name, [*], [n]), own properties only', () => {
    const body = { data: { items: [{ id: 1 }, { id: 2 }], page: { next: 2 } } };
    expect(selectPath(body, '$.data.items[*]')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(selectPath(body, '$.data.items[1]')).toEqual([{ id: 2 }]);
    expect(selectPath(body, '$.data.constructor')).toEqual([]);
    expect(morePathSays(body, '$.data.page.next')).toBe(true);
    expect(morePathSays({ data: { page: { next: null } } }, '$.data.page.next')).toBe(false);
  });

  it('the cache: hits within the TTL, coalesces identical reads, and a read started before an invalidation never writes back', async () => {
    let t = 1_000;
    const cache = new AppReadCache<number>(() => t);
    let calls = 0;
    const fn = async () => ({ value: ++calls, bytes: 10 });
    const [a, b] = await Promise.all([cache.read('app', 'k', 5_000, fn), cache.read('app', 'k', 5_000, fn)]);
    expect([a.value, b.value, calls]).toEqual([1, 1, 1]); // one source call
    expect((await cache.read('app', 'k', 5_000, fn)).cachedAt).toBe(1_000);
    t += 6_000;
    expect((await cache.read('app', 'k', 5_000, fn)).value).toBe(2); // expired
    let release!: () => void;
    const slow = cache.read('app', 'k2', 5_000, () => new Promise((r) => (release = () => r({ value: 99, bytes: 1 }))));
    cache.invalidate('app');
    release();
    expect((await slow).value).toBe(99);
    expect(cache.size('app')).toBe(0); // the pre-invalidation read was not kept
  });

  it('limits: 4 at once per source per app, 16 waiting, then refused; 60 queries a minute per viewer', async () => {
    const limits = new AppLimits(() => 0);
    const gates: Array<() => void> = [];
    const running = Array.from({ length: 20 }, () => limits.run('app', 'src', () => new Promise<void>((r) => gates.push(r))));
    await new Promise((r) => setTimeout(r, 10));
    expect(gates).toHaveLength(4);
    await expect(limits.run('app', 'src', async () => undefined)).rejects.toBeInstanceOf(RateLimited);
    while (gates.length > 0) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all(running);
    for (let i = 0; i < 60; i++) limits.rate('query', 'app', 'priya');
    expect(() => limits.rate('query', 'app', 'priya')).toThrow(RateLimited);
    expect(() => limits.rate('query', 'app', 'sam')).not.toThrow();
  });
});

describe('the executor over the K1 test services and the crew source', () => {
  let h: Harness;
  let api: Fixture;
  let mcp: Fixture;
  let mcp2: Fixture;
  let gql: Fixture;
  beforeAll(async () => {
    api = (await startOpenApiService()) as Fixture;
    mcp = (await startMcpServer()) as Fixture;
    mcp2 = (await startMcpServer()) as Fixture;
    gql = (await startGraphqlServer()) as Fixture;
    h = await appsHarness({
      extra: (app) => {
        app.get('/api/v1/runs', async (req) => ({ runs: [{ id: 'run-1', status: 'completed', who: req.headers.authorization ?? null }] }));
      },
    });
    await h.register({ name: 'tickets', kind: 'rest', url: `${api.origin}/v1`, openapiUrl: `${api.origin}/openapi.json`, address: LOOP });
    await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: LOOP });
    await h.register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    await h.newApp('desk');
    const queries: AppQuery[] = [
      {
        id: 'page',
        source: 'tickets',
        kind: 'rest',
        params: { type: 'object', properties: { page: { type: 'integer', default: 1 } } },
        rowPath: '$.data.items[*]',
        morePath: '$.data.page.next',
        output: [
          { name: 'id', type: 'integer' },
          { name: 'owner', type: 'string' },
        ],
      },
      { id: 'mcp_open', source: 'ref', kind: 'mcp', rowPath: '$.tickets[*]', output: [{ name: 'id', type: 'integer' }, { name: 'status', type: 'string' }] },
      {
        id: 'gql',
        source: 'tix',
        kind: 'graphql',
        params: { type: 'object', properties: { status: { type: 'string', enum: ['OPEN', 'CLOSED'], default: 'OPEN' } } },
        rowPath: '$.data.tickets[*]',
        output: [{ name: 'id', type: 'integer' }],
      },
      { id: 'runs', source: 'crew', kind: 'crew', rowPath: '$.runs[*]', output: [{ name: 'id', type: 'string' }, { name: 'who', type: 'string' }] },
      {
        id: 'mine',
        source: 'tickets',
        kind: 'rest',
        params: { type: 'object', properties: { page: { type: 'integer', default: 1 }, me: { type: 'string', from: 'viewer.email' } } },
        rowPath: '$.data.items[*]',
        output: [{ name: 'id', type: 'integer' }],
      },
      { id: 'bad_type', source: 'ref', kind: 'mcp', rowPath: '$.tickets[*]', output: [{ name: 'owner', type: 'integer' }] },
      { id: 'one', source: 'tix', kind: 'graphql', params: { type: 'object', properties: { id: { type: 'integer', default: 4801 } } }, rowPath: '$.data.ticket', output: [{ name: 'id', type: 'integer' }] },
      { id: 'maybe', source: 'ref', kind: 'mcp', params: { type: 'object', properties: { status: { type: 'string', enum: ['OPEN', 'CLOSED'] } } }, rowPath: '$.tickets[*]', output: [{ name: 'id', type: 'integer' }] },
    ];
    const r = await h.land('desk', specWith(queries), {
      page: JSON.stringify({ tool: 'listTickets', args: { page: { kind: 'param', name: 'page' } } }),
      mcp_open: JSON.stringify({ tool: 'list_tickets', args: { status: { kind: 'literal', value: 'OPEN' } } }),
      gql: 'query ($status: Status) { tickets(status: $status) { id } }',
      runs: JSON.stringify({ route: '/runs' }),
      mine: JSON.stringify({ tool: 'listTickets', args: { page: { kind: 'param', name: 'page' } } }),
      bad_type: JSON.stringify({ tool: 'list_tickets', args: {} }),
      one: 'query ($id: Int!) { ticket(id: $id) { id } }',
      maybe: JSON.stringify({ tool: 'list_tickets', args: { status: { kind: 'param', name: 'status' } } }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    for (const f of [api, mcp, mcp2, gql]) await f?.close();
  });

  const query = (q: string, params?: Record<string, unknown>, as: 'priya' | 'sam' | 'seat' | 'olga' = 'priya') => h.call('POST', '/apps/desk/query', { version: 2, query: q, ...(params !== undefined ? { params } : {}) }, as);

  it('a REST read: the row path, the declared columns only, the more path; the next page says it is the last', async () => {
    const r = await query('page');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const body = r.body as unknown as AppQueryResponse;
    expect(body.columns.map((c) => c.name)).toEqual(['id', 'owner']);
    expect(body.rows).toHaveLength(10);
    expect(body.rows[0]).toEqual([4800, 'nobody']);
    expect(body).toMatchObject({ truncated: false, hasMore: true, cachedAt: null });
    const last = (await query('page', { page: 3 })).body as unknown as AppQueryResponse;
    expect(last.rows).toHaveLength(5);
    expect(last.hasMore).toBe(false);
  });

  it('an MCP read (structured content), a GraphQL read (variables = parameters) and a crew read as the viewer', async () => {
    const m = (await query('mcp_open')).body as unknown as AppQueryResponse;
    expect(m.rows.every((row) => row[1] === 'OPEN')).toBe(true);
    const g = await query('gql', { status: 'CLOSED' });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect((g.body as unknown as AppQueryResponse).rows.length).toBeGreaterThan(0);
    const c = (await query('runs')).body as unknown as AppQueryResponse;
    expect(c.rows).toEqual([['run-1', 'Bearer priya']]); // in process, with the viewer's own credentials
  });

  it('parameters: an unknown one or a client value for a viewer-bound one is refused; a viewer value crew does not know is refused, never guessed', async () => {
    expect((await query('page', { nope: 1 })).body).toMatchObject({ code: 'bad_params' });
    expect((await query('page', { page: 'two' })).body).toMatchObject({ code: 'bad_params' });
    const forged = await query('mine', { me: 'boss@example.com' });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toContain('viewer.email');
    expect((await query('mine')).status).toBe(200);
    h.viewers['priya'] = { id: 'priya', email: null, name: null, groups: null };
    try {
      expect((await query('mine')).body).toMatchObject({ code: 'viewer_unavailable' });
    } finally {
      delete h.viewers['priya'];
    }
  });

  it('r2: bound GraphQL variables pass graphql-js coercion before anything is sent; an absent optional parameter is left out of a tool call', async () => {
    const before = gql.hits.length;
    const r = await query('one', { id: 2_147_483_648 });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'bad_params' });
    expect(gql.hits.length).toBe(before); // nothing sent
    expect(((await query('one', { id: 4801 })).body as unknown as AppQueryResponse).rows).toEqual([[4801]]);
    const all = (await query('maybe')).body as unknown as AppQueryResponse;
    expect(all.rows).toHaveLength(25); // `status` left out, not sent as null
  });

  it('codex r1: a read that waited for its slot is planned again (a source re-saved meanwhile refuses it), and a full queue is 429', async () => {
    const limits = h.executor.limits;
    const run = limits.run.bind(limits);
    let once = true;
    limits.run = (async (app: string, source: string, fn: () => Promise<unknown>) =>
      run(app, source, async () => {
        if (once) {
          once = false;
          await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp2.origin}/mcp`, address: LOOP }); // the save lands while it waits
        }
        return fn();
      })) as typeof limits.run;
    try {
      h.executor.invalidate('desk');
      expect((await query('mcp_open')).body).toMatchObject({ code: 'contract_changed' });
    } finally {
      limits.run = run;
      await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: LOOP });
    }
    // The queue past 16 (distinct reads, so none coalesce) answers 429, not 502.
    const gate: Array<() => void> = [];
    const hold = Array.from({ length: 20 }, () => limits.run('desk', 'tickets', () => new Promise<void>((r) => gate.push(r))));
    await new Promise((r) => setTimeout(r, 10));
    const r = await query('page', { page: 9 });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ code: 'rate_limited' });
    while (gate.length > 0) {
      gate.shift()!();
      await new Promise((x) => setTimeout(x, 1));
    }
    await Promise.all(hold);
  });

  it('an agent seat or a plugin cannot read an app: no row value goes to a model', async () => {
    const r = await query('page', undefined, 'seat');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'human_only' });
  });

  it('a value that does not fit its declared column refuses the read, naming the column, never the value', async () => {
    const r = await query('bad_type');
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'result_invalid' });
    expect(String(r.body.error)).toContain('owner');
    expect(String(r.body.error)).not.toMatch(/nobody|agent\d/);
  });

  it('the cache serves a repeat within 5 s without a source call; an invalidation (an action ran) reads again', async () => {
    const before = mcp.hits.length;
    await query('mcp_open');
    const again = (await query('mcp_open')).body as unknown as AppQueryResponse;
    expect(again.cachedAt).not.toBeNull();
    const afterHit = mcp.hits.length;
    h.executor.invalidate('desk');
    const fresh = (await query('mcp_open')).body as unknown as AppQueryResponse;
    expect(fresh.cachedAt).toBeNull();
    expect(mcp.hits.length).toBeGreaterThan(afterHit);
    expect(afterHit).toBeGreaterThanOrEqual(before);
    expect(h.executor.callRecords('desk').some((c) => c.query === 'mcp_open' && c.outcome === 'cached')).toBe(true);
    expect(JSON.stringify(h.executor.callRecords('desk'))).not.toContain('OPEN'); // no row in a call record
  });

  it('S14: a source whose connection changed under an accepted version refuses its queries until the version is checked again; other sources still run', async () => {
    await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp2.origin}/mcp`, address: LOOP });
    expect((await query('mcp_open')).body).toMatchObject({ code: 'contract_changed' });
    expect((await query('page')).status).toBe(200);
  });
});

describe('the executor: a crew read that never answers, an MCP error with its own metadata (codex r1)', () => {
  it('a hung crew route releases its slot at the deadline (504); an MCP server’s error metadata never becomes crew’s words', async () => {
    const h = await appsHarness({
      crewDeadlineMs: 200,
      extra: (app) => {
        app.get('/api/v1/system', () => new Promise(() => undefined)); // never answers
      },
    });
    try {
      const META = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apps-sources', 'meta-mcp.mjs');
      await h.register({ name: 'meta', kind: 'mcp-stdio', command: process.execPath, args: [META] });
      await h.newApp('desk');
      const q: AppQuery[] = [
        { id: 'sys', source: 'crew', kind: 'crew', output: [{ name: 'x', type: 'string' }] },
        { id: 'meta_rows', source: 'meta', kind: 'mcp', rowPath: '$.rows[*]', output: [{ name: 'x', type: 'string' }] },
      ];
      const landed = await h.land('desk', specWith(q), { sys: JSON.stringify({ route: '/system' }), meta_rows: JSON.stringify({ tool: 'rows' }) });
      expect(landed.status, JSON.stringify(landed.body)).toBe(200);
      const t0 = Date.now();
      const hung = await h.call('POST', '/apps/desk/query', { version: 2, query: 'sys' });
      expect(hung.status).toBe(504);
      expect(Date.now() - t0).toBeLessThan(5_000);
      const m = await h.call('POST', '/apps/desk/query', { version: 2, query: 'meta_rows' });
      expect(m.status).toBe(502);
      expect(String(m.body.error)).not.toContain('SERVER-CHOSEN-WORDS');
    } finally {
      await h.close();
    }
  }, 30_000);
});

if (PG_TARGETS.length === 0) {
  describe('the executor on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the executor on ${target.label}`, () => {
    let db: FreshPg;
    let h: Harness;
    const queries: AppQuery[] = [
      {
        id: 'search',
        source: 'support',
        kind: 'sql',
        params: { type: 'object', properties: { owner: { type: 'string', default: 'nobody' } } },
        output: [
          { name: 'id', type: 'integer' },
          { name: 'owner', type: 'string' },
        ],
      },
      { id: 'totals', source: 'support', kind: 'sql', output: [{ name: 'n', type: 'integer' }, { name: 'total', type: 'number' }] },
      { id: 'mine', source: 'support', kind: 'sql', params: { type: 'object', properties: { me: { type: 'string', from: 'viewer.email' } } }, output: [{ name: 'id', type: 'integer' }] },
      { id: 'kids', source: 'support', kind: 'sql', output: [{ name: 'id', type: 'integer' }] },
    ];
    const texts = {
      search: 'SELECT w.id, w.owner FROM s.w AS w WHERE w.owner = $1 ORDER BY w.id',
      totals: 'SELECT count(*)::int8 AS n, sum(p.amount) AS total FROM s.plain AS p',
      mine: 'SELECT w.id FROM s.w AS w WHERE w.owner = $1',
      kids: 'SELECT k.id FROM s.kids AS k',
    };
    beforeAll(async () => {
      db = await freshPgDatabase(target);
      h = await appsHarness();
      await h.addPg('support', { port: db.port, database: db.database, user: 'apps_reader', password: 'apps-reader' });
      await h.newApp('tickets');
      const r = await h.land('tickets', specWith(queries), texts);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }, 60_000);
    afterAll(async () => {
      await h?.close();
      await db?.drop();
    });
    const query = (q: string, params?: Record<string, unknown>) => h.call('POST', '/apps/tickets/query', { version: 2, query: q, ...(params !== undefined ? { params } : {}) });

    it('reads through the policy, READ ONLY, $n = the n-th declared parameter; int8 and numeric arrive as numbers', async () => {
      const r = await query('search');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((r.body as unknown as AppQueryResponse).rows).toEqual([[4821, 'nobody'], [4822, 'nobody']]);
      expect((await query('totals')).body).toMatchObject({ rows: [[2, 3]] });
    });

    it("S2: the injection string as a parameter matches literally (0 rows) and the table survives", async () => {
      const r = await query('search', { owner: "'; drop table s.w; --" });
      expect((r.body as unknown as AppQueryResponse).rows).toEqual([]);
      expect((await db.admin.unsafe<Array<{ n: string }>>('SELECT count(*)::text AS n FROM s.w'))[0]?.n).toBe('2');
    });

    it('a viewer-bound parameter is the viewer’s email, from crew, never the client', async () => {
      await db.admin.unsafe("UPDATE s.w SET owner = 'priya@example.com' WHERE id = 4822");
      try {
        expect((await query('mine')).body).toMatchObject({ rows: [[4822]] });
        expect((await query('mine', { me: 'nobody' })).status).toBe(400);
      } finally {
        await db.admin.unsafe("UPDATE s.w SET owner = 'nobody' WHERE id = 4822");
      }
    });

    it('S1: the source secret never reaches a row, an error or a call record (scrubbed even when a row holds it)', async () => {
      await db.admin.unsafe("UPDATE s.w SET owner = 'apps-reader' WHERE id = 4821");
      try {
        const r = await query('search', { owner: 'apps-reader' });
        expect(JSON.stringify(r.body)).not.toContain('apps-reader');
        expect((r.body as unknown as AppQueryResponse).rows).toEqual([[4821, SECRET_REDACTION]]);
        expect(JSON.stringify(h.executor.callRecords('tickets'))).not.toContain('apps-reader');
      } finally {
        await db.admin.unsafe("UPDATE s.w SET owner = 'nobody' WHERE id = 4821");
      }
    });

    it('S14: a used column changes type (still executable) and the source is described again: that query refuses, the others run', async () => {
      await db.admin.unsafe('ALTER TABLE s.kids ALTER COLUMN id TYPE int8');
      try {
        expect((await h.call('POST', '/sources/support/describe', {})).status).toBe(200);
        expect((await query('kids')).body).toMatchObject({ code: 'contract_changed' });
        expect((await query('search')).status).toBe(200);
      } finally {
        await db.admin.unsafe('ALTER TABLE s.kids ALTER COLUMN id TYPE int4');
        await h.call('POST', '/sources/support/describe', {});
      }
    });

    it('codex r1: a source switched off reads nothing', async () => {
      await h.registry.setServerEnabled('support', false);
      try {
        expect((await query('search')).body).toMatchObject({ code: 'query_refused' });
      } finally {
        await h.registry.setServerEnabled('support', true);
      }
      expect((await query('search')).status).toBe(200);
    });

    it('a query this version does not hold is 404, with nothing sent', async () => {
      expect((await query('nosuch')).body).toMatchObject({ code: 'unknown_query' });
    });
  });
}
