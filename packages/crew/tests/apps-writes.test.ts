// DES-APPS-001 §7.3, §7.4, §9.4 (K2b): the write path through the product, on real Postgres 16 and 17 and the
// K1 test services. Each acceptance item of the slice's brief is a test here; the P1-P43 regression suite is
// tests/apps-pgwrite-probes.test.ts.

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { callMutation, capped, mutationField } from '../src/apps/actions/api-action.js';
import { AppActionStore } from '../src/apps/actions/store.js';
import { AppWritePath } from '../src/apps/actions/write-path.js';
import type { AppAction, AppActionPrepareResponse } from '../src/core/types.js';
import { startGraphqlServer, startMcpServer, startOpenApiService } from './fixtures/apps-sources/servers.mjs';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';
import { updateAction, type WriteRig, writeRig } from './support/apps-writes.js';
import { DB_REQUIRED, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

type Fixture = { origin: string; hits: Array<{ method: string; path: string; body: string; headers?: Record<string, string> }>; close: () => Promise<void> };
const LOOP = { allow: ['127.0.0.0/8'] };

const assign = updateAction('assign', 'writer', 's.tickets', { owner: { kind: 'viewer', claim: 'email' } });
const note: AppAction = {
  id: 'add_note',
  kind: 'row-write',
  source: 'writer',
  table: 's.notes',
  op: 'insert',
  set: { id: { kind: 'param', name: 'id' }, body: { kind: 'param', name: 'body' }, created_at: { kind: 'crew', value: 'now' }, amount: { kind: 'param', name: 'amount' } },
  key: { id: { kind: 'param', name: 'id' } },
  params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, body: { type: 'string' }, amount: { type: 'string' } }, required: ['id', 'body', 'amount'] },
  description: 'Adds a handover note',
};
const drop: AppAction = { id: 'drop_note', kind: 'row-write', source: 'writer', table: 's.notes', op: 'delete', key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } };
const NEW_NOTE = 'b1ffcd88-8d1a-4ef9-ac7e-7cc0ce491b22';

if (PG_TARGETS.length === 0) {
  describe('the write path on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the write path on ${target.label}`, () => {
    let db: FreshPg;
    let rig: WriteRig;
    beforeAll(async () => {
      db = await freshPgDatabase(target);
      rig = await writeRig(db, ['writer', 'colwriter', 'inserter', 'repl']);
      await rig.land([assign, note, drop]);
    }, 90_000);
    afterAll(async () => {
      await rig?.h.close();
      await db?.drop();
    });
    afterEach(() => {
      delete rig.h.hooks.afterLock;
      delete rig.h.hooks.afterCheck;
      delete rig.h.writeEnv['APPS_READ_ONLY'];
    });

    it('update: grant once, then every run shows its card and changes exactly the row on it, with the audit line (no values)', async () => {
      const { card, run, record } = await rig.act('assign', { id: 4821 });
      expect(card).toMatchObject({
        kind: 'row-write',
        source: 'writer',
        login: 'apps_k2b_writer',
        verb: 'UPDATE',
        table: 's.tickets',
        columns: [{ name: 'owner', value: 'priya@example.com', from: 'viewer', label: 'your sign-in' }],
        key: [{ name: 'id', value: 4821, from: 'param' }],
        rows: 'exactly 1 row, verified',
      });
      expect(card.kind === 'row-write' && card.statement).toContain('UPDATE ONLY "s"."tickets" AS "w"');
      expect(run).toMatchObject({ state: 'succeeded', result: { table: 's.tickets', op: 'update', key: { id: 4821 } } });
      expect(await rig.one('SELECT string_agg(id || \'=\' || owner, \',\' ORDER BY id) AS v FROM s.tickets')).toBe('4821=priya@example.com,4822=nobody,4823=nobody');
      await rig.h.audit.flush();
      const lines = (await rig.h.audit.read()).filter((e) => e.action.startsWith('apps.action.'));
      const ran = lines.find((e) => e.action === 'apps.action.ran' && (e.detail as { record?: string }).record === record);
      expect(ran?.detail).toMatchObject({ app: 'desk', action: 'assign', operation: 'UPDATE s.tickets', outcome: 'succeeded', viewer: 'priya' });
      expect((ran?.detail as { fingerprint?: string }).fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(ran)).not.toContain('priya@example.com'); // the audit line holds no values
      expect(lines.some((e) => e.action === 'apps.action.granted')).toBe(true);
      expect((await rig.h.call('GET', `/apps/desk/actions/records/${record}`)).body).toMatchObject({ state: 'succeeded' });
    });

    it('insert sets every column (crew fills now) and delete removes exactly that row; a missing key writes nothing', async () => {
      const ins = await rig.act('add_note', { id: NEW_NOTE, body: "'; drop table s.notes; --", amount: '2.5' });
      expect(ins.run.state).toBe('succeeded');
      const crewNowCell = ins.card.kind === 'row-write' ? ins.card.columns.find((c) => c.name === 'created_at') : undefined;
      expect(crewNowCell).toMatchObject({ from: 'crew', label: 'filled by studio: now' });
      expect(ins.card).toMatchObject({ appSays: 'Adds a handover note' });
      // S2: the injection string is stored as text; the table survives.
      expect(await rig.one(`SELECT body AS v FROM s.notes WHERE id = '${NEW_NOTE}'`)).toBe("'; drop table s.notes; --");
      expect(await rig.one('SELECT count(*)::text AS v FROM s.notes')).toBe('2');
      const del = await rig.act('drop_note', { id: NEW_NOTE });
      expect(del.run.state).toBe('succeeded');
      expect(await rig.one('SELECT count(*)::text AS v FROM s.notes')).toBe('1');
      const missing = await rig.act('drop_note', { id: NEW_NOTE }); // P3: no such row
      expect(missing.run).toMatchObject({ state: 'failed' });
      expect(missing.run.reason).toContain('no such row');
      expect(await rig.one('SELECT count(*)::text AS v FROM s.notes')).toBe('1');
    });

    it('a value that would round is refused before any card (P28); a viewer-bound value from the request is refused (S15)', async () => {
      const p = await rig.prepare('add_note', { id: NEW_NOTE, body: 'x', amount: '1.24' });
      expect(p.status).toBe(409);
      expect(p.body).toMatchObject({ code: 'value_does_not_fit' });
      expect(String(p.body.error)).toContain('numeric(3,1)');
      const forged = updateAction('forge', 'writer', 's.tickets', { owner: { kind: 'param', name: 'me' } }, { params: { type: 'object', properties: { me: { type: 'string', from: 'viewer.email' } }, required: [] } });
      await rig.land([assign, note, drop, forged]);
      expect((await rig.grant('forge')).status).toBe(200);
      const r = await rig.prepare('forge', { id: 4822, me: 'boss@example.com' });
      expect(r.body).toMatchObject({ code: 'bad_params' });
    });

    it('Allow writes off: grant, prepare and run are each refused; turned off between prepare and run, the run is refused (S17)', async () => {
      const p = await rig.prepare('assign', { id: 4822 });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      const off = await rig.h.call('PUT', '/sources/writer/allow-writes', { allowed: false });
      expect(off.body).toMatchObject({ allowWrites: false });
      expect((off.body as { withdrawnGrants: number }).withdrawnGrants).toBeGreaterThan(0);
      const run = await rig.run('assign', (p.body as unknown as AppActionPrepareResponse).record);
      expect(run.status).toBe(409);
      expect(await rig.one('SELECT owner AS v FROM s.tickets WHERE id = 4822')).toBe('nobody');
      expect((await rig.grant('assign')).body).toMatchObject({ code: 'writes_off' });
      expect((await rig.prepare('assign', { id: 4822 })).body).toMatchObject({ code: 'not_granted' });
      // Turning it back on needs new grants (they were withdrawn).
      await rig.h.call('PUT', '/sources/writer/allow-writes', { allowed: true });
      expect((await rig.prepare('assign', { id: 4822 })).body).toMatchObject({ code: 'not_granted' });
      expect((await rig.grant('assign')).status).toBe(200);
    });

    it('S9: a replayed record is refused; a revoke between prepare and run wins; a source host change between them wins', async () => {
      const done = await rig.act('assign', { id: 4823 });
      expect((await rig.run('assign', done.record)).body).toMatchObject({ code: 'record_used' });
      const p1 = await rig.prepare('assign', { id: 4823 });
      expect((await rig.h.call('DELETE', '/apps/desk/actions/assign/grant')).body).toEqual({ revoked: true });
      expect((await rig.run('assign', (p1.body as unknown as AppActionPrepareResponse).record)).body).toMatchObject({ code: 'not_granted' });
      expect((await rig.grant('assign')).status).toBe(200);
      const p2 = await rig.prepare('assign', { id: 4823 });
      // Save the source again with another connection descriptor (here its login; the host is in it the same way).
      const p = await rig.h.call('POST', '/mcp/servers/preview', { name: 'writer', kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: rig.db.port, database: rig.db.database, user: 'apps_k2b_colwriter', tls: 'disable' }, auth: { ref: 'env:APPS_K2B_COLWRITER' }, address: LOOP });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect((await rig.h.call('POST', '/mcp/servers', { previewHash: (p.body as { previewHash: string }).previewHash })).status).toBe(201);
      const r = await rig.run('assign', (p2.body as unknown as AppActionPrepareResponse).record);
      expect(r.status).toBe(409);
      expect(['contract_changed', 'writes_off']).toContain(r.body.code);
      expect(await rig.one('SELECT owner AS v FROM s.tickets WHERE id = 4823')).toBe('priya@example.com'); // only the first run wrote
      // Put the source back as it was, and grant again.
      await rig.h.addPg('writer', { port: rig.db.port, database: rig.db.database, user: 'apps_k2b_writer', password: 'apps-k2b-writer' });
      await rig.h.call('PUT', '/sources/writer/allow-writes', { allowed: true });
    });

    it('APPS_READ_ONLY stops every prepare and run at once', async () => {
      if (rig.h.writePath.getGrant('desk', 'assign') === null) expect((await rig.grant('assign')).status).toBe(200);
      const p = await rig.prepare('assign', { id: 4821 });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      rig.h.writeEnv['APPS_READ_ONLY'] = '1';
      expect((await rig.run('assign', (p.body as unknown as AppActionPrepareResponse).record)).body).toMatchObject({ code: 'read_only' });
      expect((await rig.prepare('assign', { id: 4821 })).body).toMatchObject({ code: 'read_only' });
    });

    it('the writer without table-level SELECT or UPDATE is told the missing GRANT (P36, P42), and nothing runs', async () => {
      const col = updateAction('col', 'colwriter', 's.tickets', { owner: { kind: 'literal', value: 'x' } });
      const ins: AppAction = { ...note, id: 'ins_only', source: 'inserter' };
      await rig.land([assign, note, drop, col, ins]);
      const c = await rig.grant('col');
      expect(c.body).toMatchObject({ code: 'missing_grants' });
      expect(String(c.body.error)).toContain('GRANT SELECT ON TABLE "s"."tickets" TO "apps_k2b_colwriter";');
      expect(String(c.body.error)).toContain('GRANT UPDATE ON TABLE "s"."tickets" TO "apps_k2b_colwriter";');
      const i = await rig.grant('ins_only');
      expect(String(i.body.error)).toContain('GRANT UPDATE ON TABLE "s"."notes" TO "apps_k2b_inserter";');
    });

    it('S13: an action an agent added lands without a grant and cannot run; an agent cannot grant, prepare or run', async () => {
      const r = await rig.h.call('POST', '/apps/desk/actions/drop_note/grant', { version: rig.version() }, 'seat');
      expect(r.status).toBe(403);
      expect((await rig.h.call('POST', '/apps/desk/actions/assign/prepare', { version: rig.version(), params: { id: 1 } }, 'seat')).status).toBe(403);
    });

    it('codex r1: a connection lost inside the write never continues elsewhere: failed, nothing written', async () => {
      if (rig.h.writePath.getGrant('desk', 'assign') === null) expect((await rig.grant('assign')).status).toBe(200);
      const p = await rig.prepare('assign', { id: 4822 });
      rig.h.hooks.afterCheck = async () => {
        await db.admin.unsafe("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'apps_k2b_writer' AND datname = current_database() AND state LIKE 'idle in transaction%'");
      };
      const r = await rig.run('assign', (p.body as unknown as AppActionPrepareResponse).record);
      expect(r.body).toMatchObject({ state: 'failed' });
      expect(await rig.one('SELECT owner AS v FROM s.tickets WHERE id = 4822')).toBe('nobody');
    });

    it('codex r1: preparing an older version of an action is refused and leaves the newer grant in place', async () => {
      const v1 = updateAction('old_new', 'writer', 's.tickets', { owner: { kind: 'literal', value: 'v1' } });
      const older = await rig.land([assign, note, drop, v1]);
      const v2 = updateAction('old_new', 'writer', 's.tickets', { owner: { kind: 'literal', value: 'v2' } });
      await rig.land([assign, note, drop, v2]);
      expect((await rig.grant('old_new')).status).toBe(200);
      const p = await rig.prepare('old_new', { id: 4821 }, older);
      expect(p.body).toMatchObject({ code: 'not_granted' });
      expect(rig.h.writePath.getGrant('desk', 'old_new')).not.toBeNull();
    });

    it('S14: a used column changes type: the grant is withdrawn at the next prepare, with the reason', async () => {
      if (rig.h.writePath.getGrant('desk', 'assign') === null) expect((await rig.grant('assign')).status).toBe(200);
      await db.admin.unsafe('ALTER TABLE s.tickets ALTER COLUMN owner TYPE varchar(200)');
      try {
        const p = await rig.prepare('assign', { id: 4821 });
        expect(p.status).toBe(409);
        expect(['table_changed', 'contract_changed']).toContain(p.body.code);
        expect(rig.h.writePath.getGrant('desk', 'assign')).toBeNull();
      } finally {
        await db.admin.unsafe('ALTER TABLE s.tickets ALTER COLUMN owner TYPE text');
      }
    });
  });
}

describe('API actions (DES §7.3) over the K1 test services', () => {
  let h: Harness;
  let api: Fixture;
  let mcp: Fixture;
  let gql: Fixture;
  let version = 2;
  const params = { type: 'object' as const, properties: { id: { type: 'integer' as const } }, required: ['id'] };
  const actions: AppAction[] = [
    { id: 'approve', kind: 'api', source: 'tickets', call: { kind: 'tool', tool: 'assignTicket' }, args: { id: { kind: 'param', name: 'id' }, owner: { kind: 'viewer', claim: 'email' } }, params, description: 'Assigns the ticket to you' },
    { id: 'mcp_assign', kind: 'api', source: 'ref', call: { kind: 'tool', tool: 'assign_ticket' }, args: { id: { kind: 'param', name: 'id' }, owner: { kind: 'literal', value: 'team-b' } }, params },
    { id: 'gql_assign', kind: 'api', source: 'tix', call: { kind: 'mutation', mutation: 'mutation ($id: Int!, $owner: String!) { assign(id: $id, owner: $owner) { id owner } }' }, args: { id: { kind: 'param', name: 'id' }, owner: { kind: 'viewer', claim: 'email' } }, params },
  ];
  beforeAll(async () => {
    api = (await startOpenApiService()) as Fixture;
    mcp = (await startMcpServer()) as Fixture;
    gql = (await startGraphqlServer()) as Fixture;
    h = await appsHarness();
    await h.register({ name: 'tickets', kind: 'rest', url: `${api.origin}/v1`, openapiUrl: `${api.origin}/openapi.json`, address: LOOP });
    await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: LOOP });
    await h.register({ name: 'tix', kind: 'graphql', url: `${gql.origin}/graphql`, address: LOOP });
    await h.newApp('desk');
    const r = await h.land('desk', specWith([], actions));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    version = 2;
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    for (const f of [api, mcp, gql]) await f?.close();
  });
  const call = async (id: string, args: Record<string, unknown>) => {
    if (h.writePath.getGrant('desk', id) === null) expect((await h.call('POST', `/apps/desk/actions/${id}/grant`, { version })).status).toBe(200);
    const p = await h.call('POST', `/apps/desk/actions/${id}/prepare`, { version, params: args });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const prepared = p.body as unknown as AppActionPrepareResponse;
    const r = await h.call('POST', `/apps/desk/actions/${id}/run`, { record: prepared.record });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { card: prepared.card, run: r.body, record: prepared.record };
  };

  it('a REST operation: the card names the method, the full path and every argument; one call goes out; the audit line names the operation, no values', async () => {
    const before = api.hits.length;
    const { card, run, record } = await call('approve', { id: 4821 });
    expect(card).toMatchObject({ kind: 'api', source: 'tickets', sourceKind: 'rest', operation: 'POST /v1/tickets/4821/assign', appSays: 'Assigns the ticket to you' });
    expect(card.kind === 'api' && card.args).toEqual([
      { name: 'id', value: 4821, from: 'param', label: 'you entered it' },
      { name: 'owner', value: 'priya@example.com', from: 'viewer', label: 'your sign-in' },
    ]);
    expect(card.kind === 'api' && card.request).toContain(`${api.origin}/v1/tickets/4821/assign`);
    expect(run).toMatchObject({ state: 'succeeded' });
    expect(api.hits.slice(before).filter((x) => x.method === 'POST')).toHaveLength(1);
    await h.audit.flush();
    const ran = (await h.audit.read()).find((e) => e.action === 'apps.action.ran' && (e.detail as { record?: string }).record === record);
    expect(ran?.detail).toMatchObject({ operation: 'POST assignTicket', outcome: 'succeeded' });
    expect(JSON.stringify(ran)).not.toContain('priya@example.com');
  });

  it('an MCP write tool (a literal on the card, marked fixed by the app) and a GraphQL mutation', async () => {
    const m = await call('mcp_assign', { id: 4802 });
    expect(m.card.kind === 'api' && m.card.args.find((a) => a.name === 'owner')).toMatchObject({ value: 'team-b', from: 'app', label: 'fixed by the app' });
    expect(m.run).toMatchObject({ state: 'succeeded' });
    const g = await call('gql_assign', { id: 4803 });
    expect(g.card).toMatchObject({ operation: 'mutation assign' });
    expect(g.run).toMatchObject({ state: 'succeeded', result: { assign: { id: 4803, owner: 'priya@example.com' } } });
  });

  it('codex r1: a source re-saved, a grant replaced, or APPS_READ_ONLY set after the run’s checks and before running: refused, nothing sent', async () => {
    const prep = async (id: string, args: Record<string, unknown>) => {
      if (h.writePath.getGrant('desk', id) === null) expect((await h.call('POST', `/apps/desk/actions/${id}/grant`, { version })).status).toBe(200);
      const p = await h.call('POST', `/apps/desk/actions/${id}/prepare`, { version, params: args });
      return (p.body as unknown as AppActionPrepareResponse).record;
    };
    const before = mcp.hits.filter((x) => x.body.includes('assign_ticket')).length;
    const r1 = await prep('mcp_assign', { id: 4805 });
    h.hooks.beforeRunning = async () => {
      await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp?moved=1`, address: LOOP });
    };
    expect((await h.call('POST', '/apps/desk/actions/mcp_assign/run', { record: r1 })).body).toMatchObject({ code: 'contract_changed' });
    delete h.hooks.beforeRunning;
    await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: LOOP });
    const r2 = await prep('approve', { id: 4806 });
    h.writeEnv['APPS_READ_ONLY'] = '';
    h.hooks.beforeRunning = async () => {
      h.writeEnv['APPS_READ_ONLY'] = '1';
    };
    expect((await h.call('POST', '/apps/desk/actions/approve/run', { record: r2 })).body).toMatchObject({ code: 'read_only' });
    delete h.hooks.beforeRunning;
    delete h.writeEnv['APPS_READ_ONLY'];
    expect(mcp.hits.filter((x) => x.body.includes('assign_ticket')).length).toBe(before);
  });

  it('codex/pi r1: a value that looks like a placeholder is sent as shown; an outcome that cannot be saved is still answered and audited', async () => {
    const lit: AppAction = { id: 'lit', kind: 'api', source: 'ref', call: { kind: 'tool', tool: 'assign_ticket' }, args: { id: { kind: 'param', name: 'id' }, owner: { kind: 'literal', value: '{record}' } }, params };
    const r = await h.land('desk', specWith([], [...actions, lit]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    version = 3;
    const { run } = await call('lit', { id: 4807 });
    expect(run).toMatchObject({ state: 'succeeded' });
    expect(JSON.stringify(run)).toContain('{record}'); // the tool echoes the owner it set: the card's value
    // The terminal save fails (twice): the person still gets the outcome; the audit says it was not saved.
    const store = (h.writePath as unknown as { deps: { actions: AppActionStore } }).deps.actions;
    const locked = store.locked.bind(store);
    let calls = 0;
    store.locked = (async (fn: Parameters<typeof locked>[0]) => {
      calls++;
      if (calls >= 3) throw new Error('disk full');
      return locked(fn);
    }) as typeof store.locked;
    try {
      const p = await h.call('POST', '/apps/desk/actions/lit/prepare', { version, params: { id: 4808 } });
      calls = 1; // the prepare's own lock does not count; next: running (2), then the outcome (3, 4)
      const out = await h.call('POST', '/apps/desk/actions/lit/run', { record: (p.body as unknown as AppActionPrepareResponse).record });
      expect(out.body).toMatchObject({ state: 'succeeded' });
    } finally {
      store.locked = locked;
    }
    await h.audit.flush();
    expect((await h.audit.read()).some((e) => e.action === 'apps.action.ran' && (e.detail as { recordNotSaved?: boolean }).recordNotSaved === true)).toBe(true);
  });

  it('S9: a daemon that stopped during a run ends the record unknown at the next start, before and after its deadline, and never runs it again', async () => {
    if (h.writePath.getGrant('desk', 'mcp_assign') === null) expect((await h.call('POST', '/apps/desk/actions/mcp_assign/grant', { version })).status).toBe(200);
    const p = await h.call('POST', '/apps/desk/actions/mcp_assign/prepare', { version, params: { id: 4804 } });
    const record = (p.body as unknown as AppActionPrepareResponse).record;
    // The crash: the record was moved to running by an earlier process and that process is gone.
    const file = join(h.dir, 'daemon-apps-actions.json');
    const state = JSON.parse(readFileSync(file, 'utf8')) as { records: Record<string, { state: string; epoch: string }> };
    state.records[record]!.state = 'running';
    state.records[record]!.epoch = 'an-earlier-process';
    writeFileSync(file, JSON.stringify(state));
    const reborn = new AppActionStore(file);
    expect(reborn.record(record)).toMatchObject({ state: 'unknown' });
    expect(reborn.record(record)?.reason).toContain('not run again');
    const later = new AppActionStore(file, () => Date.now() + 10 * 60 * 1000); // past its 2-minute deadline
    expect(later.record(record)?.state).toBe('unknown');
    // The recovered run gets its audit line when the write path starts over that store (codex r1).
    const lines: Array<[string, unknown]> = [];
    void new AppWritePath({ store: h.store, actions: reborn, registry: h.registry, audit: { record: (a: string, _actor: unknown, f?: { detail?: unknown }) => lines.push([a, f?.detail]) as never }, viewerOf: async (a) => ({ id: a.id, email: null, name: null, groups: null }) });
    expect(lines).toEqual(expect.arrayContaining([['apps.action.ran', expect.objectContaining({ record, outcome: 'unknown', recovered: true })]]));
  });
});

describe('API outcomes (codex r1)', () => {
  it('a GraphQL 200 without a result is unknown; an error status with an HTML body is failed; a result is cut at 64 KB of UTF-8; the card names the root field', async () => {
    const { createServer } = await import('node:http');
    let answer: { status: number; body: string; type: string } = { status: 200, body: '{}', type: 'application/json' };
    const server = createServer((_req, res) => {
      res.writeHead(answer.status, { 'content-type': answer.type });
      res.end(answer.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const config = { name: 'g', kind: 'graphql' as const, command: null, args: [], url: `http://127.0.0.1:${port}/graphql`, auth: null, address: { allow: ['127.0.0.0/8'], plaintext: true } };
    try {
      expect(await callMutation(config, null, 'mutation { assign(id: 1) { id } }', {}, 'assign')).toMatchObject({ state: 'unknown' });
      answer = { status: 200, body: '{"status":"ok"}', type: 'application/json' };
      expect(await callMutation(config, null, 'mutation { assign(id: 1) { id } }', {}, 'assign')).toMatchObject({ state: 'unknown' });
      answer = { status: 502, body: '<html>bad gateway</html>', type: 'text/html' };
      expect(await callMutation(config, null, 'mutation { assign(id: 1) { id } }', {}, 'assign')).toMatchObject({ state: 'failed' });
      answer = { status: 200, body: '{"data":{"assign":{"id":1}}}', type: 'application/json' };
      expect(await callMutation(config, null, 'mutation { assign(id: 1) { id } }', {}, 'assign')).toEqual({ state: 'succeeded', result: { assign: { id: 1 } } });
    } finally {
      await new Promise((r) => server.close(r));
    }
    const wide = capped({ s: '漢'.repeat(60_000) }) as { truncated?: boolean; text?: string };
    expect(wide.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wide), 'utf8')).toBeLessThanOrEqual(64 * 1024 + 64);
    expect(mutationField('mutation { assign(id: 1) { aaa: id } }')).toBe('assign');
  });
});

describe('the record view and the human boundary', () => {
  it('a record answers only the person who prepared it', async () => {
    const h = await appsHarness();
    try {
      await h.newApp('desk');
      expect((await h.call('GET', '/apps/desk/actions/records/00000000-0000-4000-8000-000000000000')).body).toMatchObject({ code: 'unknown_record' });
      expect((await h.call('GET', '/apps/desk/actions/records/x', undefined, 'seat')).status).toBe(403);
    } finally {
      await h.close();
    }
  });
});
