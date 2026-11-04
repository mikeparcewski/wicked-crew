// DES-KNOWLEDGE-DATA-001 §19 B3b against REAL Postgres (CI: 16 and 17), through the routes a person and a unit use:
//
// - the describe -> knowledge.replace_source projection is value-free: markers seeded in rows, in a column DEFAULT
//   and in a column COMMENT appear in no payload, and no row estimate does;
// - NEGATIVE CONTROL: a chat in project A sees support-pg's structure only after a person ticks A;
// - NEGATIVE CONTROL: its answer can cite `src:support-pg@…` only once "query" is on (a query-off read is refused);
// - NEGATIVE CONTROL (K0's marker test, as §9.3 amends it): with D-7 narrowed (the engine admits an Apps unit's
//   reads, as wicked-core does after DES-KNOWLEDGE-DATA-001 §9.3), a marker in a query-off source's rows appears in
//   no Apps unit's tools, package or output, and a source the project may not see answers nothing at all. The
//   query-on control shows the harness would catch the marker.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { chatKnowledgeFor } from '../src/api/chat-mcp.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpCallResponse } from '../src/core/types.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { SourceReadLog } from '../src/knowledge/gate/record.js';
import { registerGateRoutes } from '../src/knowledge/gate/routes.js';
import { knowledgePackageFor, packageJson } from '../src/knowledge/package.js';
import { SourceProjector } from '../src/knowledge/projector.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { countingResolver, DB_HOST, DB_REQUIRED, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

const SECRET = `kd-b3b-${randomUUID().slice(0, 8)}`;
const SUPPORT_ID = '3f0c9a1e-0000-4000-8000-00000000b3b1';
const MARKERS = { row: 'MARKER-b3b-row-7f3c', region: 'MARKER-b3b-region-91ab', def: 'MARKER-b3b-default-c0de', comment: 'MARKER-b3b-comment-5e11' };
const LOOPBACK = { allow: ['127.0.0.0/8'], plaintext: false };

class NoSecrets implements SecretStore {
  readonly available = true;
  async get(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

const unit = (runId: string) => ({ runId, ord: 1, attempt: 1, phase: 'unit-1', seat: 'claude' });
// The engine's binding of each token: a chat answer step and an apps-turn builder in project A, a builder in B.
const TOKENS: Record<string, { unit: ReturnType<typeof unit>; projectId: string; apps: boolean }> = {
  wmt_chat: { unit: unit('chat-a'), projectId: 'proj_a', apps: false },
  wmt_apps: { unit: unit('apps-a'), projectId: 'proj_a', apps: true },
  wmt_apps_b: { unit: unit('apps-b'), projectId: 'proj_b', apps: true },
};
const resolver = () => async (json: string) => {
  const t = TOKENS[(JSON.parse(json) as { token: string }).token];
  if (t === undefined) throw new Error('invalid_token: unknown');
  return JSON.stringify({ unit: t.unit, projectId: t.projectId, repoId: null, codeGraphDb: null });
};
/**
 * wicked-core's lister after DES-KNOWLEDGE-DATA-001 §9.3: an Apps unit is refused a tool only when its class is
 * write or destructive (`classify`: the override, else readOnlyHint); a read is judged like any unit's (here: a
 * first-use ask, which the gate admits because the person's switches are the consent).
 */
const narrowedCore = () => async (json: string) => {
  const { token, calls } = JSON.parse(json) as { token: string; calls: Array<{ server: string; tool: string; classOverride?: string | null; annotations?: { readOnlyHint?: boolean } | null }> };
  const t = TOKENS[token];
  if (t === undefined) throw new Error('invalid_token: unknown');
  const cls = (c: (typeof calls)[number]) => c.classOverride ?? (c.annotations?.readOnlyHint === true ? 'read' : 'write');
  return JSON.stringify({
    unit: t.unit,
    // The engine's first-use ask on a store with the mcp-defaults pack: MCP-POSTURE-READ fires on a read (crew#1333).
    tools: calls
      .filter((c) => !(t.apps && cls(c) !== 'read'))
      .map((c) => ({ subject: `mcp:${c.server}/${c.tool}`, class: cls(c), decision: 'ask', ...(cls(c) === 'read' ? { ruleIds: ['engine:mcp-first-use', 'MCP-POSTURE-READ'], firstUseOnly: true } : { ruleIds: ['engine:mcp-first-use', 'MCP-POSTURE-WRITE'] }) })),
  });
};

const stamp = new Date().toISOString();

if (PG_TARGETS.length === 0) {
  describe('the knowledge package on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them; WICKED_SOURCES_DB=required fails here instead of skipping)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the knowledge package on ${target.label}`, () => {
    let db: FreshPg;
    let app: FastifyInstance;
    let base: string;
    let gate: DataGate;
    let projector: SourceProjector;
    const projected: Array<Record<string, unknown>> = [];
    const role = `kd_b3b_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const seen: string[] = [];

    beforeAll(async () => {
      db = await freshPgDatabase(target);
      await db.admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${SECRET}'`);
      await db.admin.unsafe(`GRANT CONNECT ON DATABASE ${db.database} TO ${role}`);
      await db.admin.unsafe("CREATE SCHEMA support; CREATE TYPE support.ticket_status AS ENUM ('open', 'pending', 'closed')");
      await db.admin.unsafe(
        `CREATE TABLE support.tickets (id bigint PRIMARY KEY, status support.ticket_status NOT NULL, region text, subject text DEFAULT '${MARKERS.def}');
         COMMENT ON COLUMN support.tickets.subject IS '${MARKERS.comment}';
         INSERT INTO support.tickets SELECT g, (ARRAY['open','pending','closed']::support.ticket_status[])[1 + g % 3], CASE WHEN g = 7 THEN '${MARKERS.region}' ELSE 'emea' END, '${MARKERS.row} ' || g FROM generate_series(1, 40) g;
         ANALYZE support.tickets;`,
      );
      await db.admin.unsafe(`GRANT USAGE ON SCHEMA support TO ${role}; GRANT SELECT ON support.tickets TO ${role}`);
      base = mkdtempSync(join(tmpdir(), 'kd-b3b-db-'));
      const mcpDir = join(base, 'mcp');
      mkdirSync(mcpDir, { recursive: true });
      const server = {
        id: SUPPORT_ID,
        name: 'support-pg',
        kind: 'sql',
        command: null,
        args: [],
        url: null,
        enabled: true,
        health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null },
        registeredAt: stamp,
        updatedAt: stamp,
        tools: [],
        auth: { ref: 'env:KD_B3B_PG_SECRET' },
        sql: { driver: 'postgres', host: DB_HOST, port: db.port, database: db.database, user: role, tls: 'disable' },
        viewsAllowed: [],
        address: LOOPBACK,
      };
      writeFileSync(join(mcpDir, 'registry.json'), JSON.stringify({ version: 1, servers: [server] }));
      const store = new McpRegistryStore(mcpDir);
      const dial = { resolver: countingResolver() };
      const registry = new McpRegistry({ store, secrets: new NoSecrets(), probe: async () => ({ ok: false, error: 'no probe' }) as never, discover: () => [], env: { KD_B3B_PG_SECRET: SECRET } });
      const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
      const record = new SourceReadLog(mcpDir);
      gate = new DataGate({ store, catalogs: registry.catalogs, secret: async (ref) => (ref === 'env:KD_B3B_PG_SECRET' ? SECRET : null), record, audit, resolver, lister: narrowedCore, dial });
      // The describe -> estate writer, with estate replaced by a recorder of what it would be sent.
      projector = new SourceProjector({ store, catalogs: registry.catalogs, call: async (tool, args) => void projected.push({ tool, ...args }) });
      registry.catalogs.onWritten = (name) => projector.written(name);
      const broker = new McpBroker({ registry, engine: () => null, records: new McpCallRecordFile(mcpDir), gate });
      app = Fastify({ logger: false });
      registerMcpRoutes(app, { registry, broker, toolLister: narrowedCore, gate, audit, actorOf: () => LOCAL_ACTOR });
      registerSourceRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR, gate, dial });
      registerGateRoutes(app, { store, record, audit, actorOf: () => LOCAL_ACTOR });
      await app.ready();
      const t = await app.inject({ method: 'POST', url: '/api/v1/sources/support-pg/test' });
      expect(t.json(), t.body).toMatchObject({ ok: true });
      await projector.idle();
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await db?.drop();
      const b = await import('postgres');
      const admin = b.default(target.url.href, { max: 1, onnotice: () => undefined });
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.end();
      if (base !== undefined) rmSync(base, { recursive: true, force: true });
    }, 60_000);

    const agents = async (body: Record<string, unknown>) => {
      const r = await app.inject({ method: 'PUT', url: '/api/v1/sources/support-pg/agents', payload: body });
      expect(r.statusCode, r.body).toBe(200);
    };
    const listed = async (token: string): Promise<string[]> => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/mcp/tools', payload: { token } });
      seen.push(r.body);
      return ((r.json() as { tools?: Array<{ subject: string }> }).tools ?? []).map((t) => t.subject);
    };
    const call = async (token: string, tool: string, args: Record<string, unknown> = {}) => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token, subject: `mcp:support-pg/${tool}`, args } });
      seen.push(r.body);
      const body = r.json() as McpCallResponse;
      const text = (body.result as { content?: Array<{ text: string }> } | undefined)?.content?.[0]?.text;
      return { status: r.statusCode, body, raw: r.body, answer: text === undefined ? null : (JSON.parse(text) as Record<string, unknown>) };
    };
    const noMarker = (text: string) => {
      for (const m of Object.values(MARKERS)) expect(text, `marker ${m}`).not.toContain(m);
    };

    it('projects the described structure into estate keyed by the registry id: no row, default, comment or row estimate', () => {
      expect(projected).toHaveLength(1);
      const p = projected[0]!;
      expect(p['tool']).toBe('knowledge.replace_source');
      expect(p['sourceId']).toBe(SUPPORT_ID);
      expect((p['docs'] as Array<{ key: string }>).map((d) => d.key)).toEqual(['support.tickets']);
      const text = JSON.stringify(p);
      noMarker(text);
      expect(text).not.toContain('rowEstimate');
      expect(text).not.toContain(db.database);
      expect(text).toContain('one of: open, pending, closed');
    });

    it("NEGATIVE CONTROL: a chat in project A sees support-pg's structure only after A is ticked", async () => {
      expect(await chatKnowledgeFor(gate, 'proj_a')).toBeNull();
      expect(await listed('wmt_chat')).toEqual([]);
      expect((await call('wmt_chat', 'list_tables')).answer).toMatchObject({ refused: 'unknown_source' });
      await agents({ projects: ['proj_a'] });
      const block = (await chatKnowledgeFor(gate, 'proj_a')) ?? '';
      expect(block).toContain('support-pg');
      expect(block).toContain('support.tickets');
      noMarker(block);
      expect(await chatKnowledgeFor(gate, 'proj_b')).toBeNull();
    });

    it('NEGATIVE CONTROL: the answer can cite src:support-pg@… only once query is on', async () => {
      expect(await listed('wmt_chat')).toEqual(['mcp:support-pg/list_tables']);
      const off = await call('wmt_chat', 'execute_sql', { sql: 'SELECT region, count(*) FROM support.tickets GROUP BY region' });
      expect(off.answer).toMatchObject({ refused: 'query_off' });
      expect(off.raw).not.toContain('src:support-pg@');
      expect(await chatKnowledgeFor(gate, 'proj_a')).not.toContain('execute_sql');
      await agents({ query: true });
      expect(await listed('wmt_chat')).toEqual(['mcp:support-pg/list_tables', 'mcp:support-pg/execute_sql']);
      expect(await chatKnowledgeFor(gate, 'proj_a')).toContain('execute_sql');
      const on = await call('wmt_chat', 'execute_sql', { sql: 'SELECT region, count(*) AS n FROM support.tickets GROUP BY region ORDER BY region' });
      expect(on.status, on.raw).toBe(200);
      expect(String(on.answer?.['cite'])).toMatch(/^src:support-pg@\d{4}-\d\d-\d\dT[^#]+#[0-9a-f]{8}$/);
      expect(on.answer?.['deps']).toEqual([`source:${SUPPORT_ID}`]);
      await agents({ query: false });
    });

    it("NEGATIVE CONTROL (K0's marker, amended): a query-off source's rows reach no Apps unit, and a hidden source answers it nothing", async () => {
      seen.length = 0;
      // The builder's prelaunch package: structure only, authorized by the app's project.
      const pkg = packageJson(await knowledgePackageFor({ projectId: 'proj_a' }, gate));
      expect(pkg).toContain('support.tickets');
      seen.push(pkg);
      // At run time, under the narrowed D-7: the read tools are offered and run, the rows tool is refused.
      expect(await listed('wmt_apps')).toEqual(['mcp:support-pg/list_tables']);
      expect((await call('wmt_apps', 'list_tables')).answer).toMatchObject({ source: 'support-pg', query: false });
      expect((await call('wmt_apps', 'execute_sql', { sql: 'SELECT subject, region FROM support.tickets' })).answer).toMatchObject({ refused: 'query_off' });
      // Project B may not see the source: nothing, not even its structure.
      expect(await listed('wmt_apps_b')).toEqual([]);
      expect((await call('wmt_apps_b', 'list_tables')).answer).toMatchObject({ refused: 'unknown_source' });
      expect(packageJson(await knowledgePackageFor({ projectId: 'proj_b' }, gate))).not.toContain('support');
      for (const s of seen) noMarker(s);

      // The control: with query on, the same builder reads the rows, and the harness sees the marker.
      await agents({ query: true });
      const on = await call('wmt_apps', 'execute_sql', { sql: 'SELECT subject, region FROM support.tickets ORDER BY id' });
      expect(on.status, on.raw).toBe(200);
      expect(on.raw).toContain(MARKERS.row);
      await agents({ query: false });
    });
  });
}
