// DES-KNOWLEDGE-DATA-001 §19 B4 END TO END, on B3b's describe writer: a person tests a real Postgres source (B3b's
// SourceProjector writes its structure into a REAL wicked-estate-mcp), profiles it (this lane's route), approves one
// shape and declines another, and the Knowledge map draws exactly the approved one. Stores in a temp dir; skipped
// without WICKED_ESTATE_MCP_EXE or a Postgres URL.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import type { RepoEntry, SourceProfileResponse } from '../src/core/types.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { SourceReadLog } from '../src/knowledge/gate/record.js';
import { registerShapeRoutes } from '../src/knowledge/shapes/routes.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { spawn } from 'node:child_process';
import { callEstateTool } from '../src/core/estate-mcp-client.js';
import { SourceProjector } from '../src/knowledge/projector.js';
import { buildKnowledgeMap } from '../src/knowledge/shapes/map.js';
import { proposalNodeId } from '../src/knowledge/shapes/shapes.js';
import { countingResolver, DB_HOST, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

const MARKER = `kdb4mark${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const SECRET = `kd-b4-${randomUUID().slice(0, 8)}`;
const SID = '3f0c9a1e-0000-4000-8000-00000000b4e2';
const EXE = process.env['WICKED_ESTATE_MCP_EXE'] ?? '';
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

if (PG_TARGETS.length === 0 || EXE === '') {
  describe('data shapes end to end', () => {
    it.skip('needs APPS_PG16_URL and WICKED_ESTATE_MCP_EXE', () => undefined);
  });
}

for (const target of EXE === '' ? [] : PG_TARGETS) {
  describe(`data shapes end to end on ${target.label}`, () => {
    let db: FreshPg;
    let app: FastifyInstance;
    let base: string;
    const role = `kd_b4_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const texts: string[] = [];
    let auditPath = '';
    let projector: SourceProjector;
    let estate: (tool: string, args: Record<string, unknown>) => Promise<unknown>;

    beforeAll(async () => {
      db = await freshPgDatabase(target);
      await db.admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${SECRET}'`);
      await db.admin.unsafe(`GRANT CONNECT ON DATABASE ${db.database} TO ${role}`);
      await db.admin.unsafe(`
        CREATE SCHEMA support;
        CREATE TYPE support.ticket_status AS ENUM ('open', 'pending', 'closed');
        CREATE TABLE support.regions (id int PRIMARY KEY, name text NOT NULL, sla_hours int);
        CREATE TABLE support.tickets (id int PRIMARY KEY, subject text NOT NULL DEFAULT '${MARKER}-default', status support.ticket_status NOT NULL,
          region_id int REFERENCES support.regions (id), note text);
        COMMENT ON COLUMN support.tickets.note IS '${MARKER}-comment';
        COMMENT ON TABLE support.tickets IS '${MARKER}-table-comment';
        CREATE TABLE support.assignments (id int PRIMARY KEY, ticket_id int, owner text);
        INSERT INTO support.regions SELECT g, 'region ${MARKER} ' || g, 24 * g FROM generate_series(1, 4) g;
        INSERT INTO support.tickets SELECT g, 'subject ${MARKER} ' || g, (ARRAY['open', 'pending', 'closed'])[1 + g % 3]::support.ticket_status,
          1 + g % 4, CASE WHEN g % 10 = 0 THEN NULL ELSE 'note ${MARKER} ' || g END FROM generate_series(1, 437) g;
        INSERT INTO support.assignments SELECT g, 1 + (g * 7) % 437, 'owner ${MARKER}' FROM generate_series(1, 120) g;
        CREATE TABLE support."order-items" (id int PRIMARY KEY, ticket_id int REFERENCES support.tickets (id), note text);
        INSERT INTO support."order-items" SELECT g, 1 + g % 400, 'item ${MARKER}' FROM generate_series(1, 50) g;
        GRANT USAGE ON SCHEMA support TO ${role};
        GRANT SELECT ON ALL TABLES IN SCHEMA support TO ${role};
      `);
      base = mkdtempSync(join(tmpdir(), 'kd-b4-db-'));
      const mcpDir = join(base, 'mcp');
      mkdirSync(mcpDir, { recursive: true });
      const stamp = new Date().toISOString();
      writeFileSync(
        join(mcpDir, 'registry.json'),
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: SID,
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
              agents: { see: true, query: false, projects: [], everyProject: false },
              auth: { ref: 'env:KD_B4_PG_SECRET' },
              sql: { driver: 'postgres', host: DB_HOST, port: db.port, database: db.database, user: role, tls: 'disable' },
              viewsAllowed: [],
              address: LOOPBACK,
            },
          ],
        }),
      );
      const store = new McpRegistryStore(mcpDir);
      const dial = { resolver: countingResolver() };
      const registry = new McpRegistry({ store, secrets: new NoSecrets(), probe: async () => ({ ok: false, error: 'no probe' }) as never, discover: () => [], env: { KD_B4_PG_SECRET: SECRET } });
      auditPath = join(base, 'audit.log');
      const audit = new AuditLog(auditPath, () => undefined);
      const gate = new DataGate({
        store,
        catalogs: registry.catalogs,
        secret: async (ref) => (ref === 'env:KD_B4_PG_SECRET' ? SECRET : null),
        record: new SourceReadLog(mcpDir),
        audit,
        resolver: () => null,
        lister: () => null,
        dial,
        onText: (t) => texts.push(t),
      });
      const stores = join(base, 'estate');
      mkdirSync(stores, { recursive: true });
      estate = (tool: string, args: Record<string, unknown>): Promise<unknown> =>
        callEstateTool(tool, args, {
          spawn: () =>
            spawn(EXE, [], {
              stdio: ['pipe', 'pipe', 'pipe'],
              // The hermetic arming stays (tests/setup/hermetic-home.ts); every store is this test's own.
              env: { ...process.env, HOME: stores, WICKED_HOME: stores, WICKED_ESTATE_DB: join(stores, 'estate.db'), WICKED_MEMORY_DB: join(stores, 'memory.db'), WICKED_KNOWLEDGE_DB: join(stores, 'knowledge.db'), WICKED_XEDGE_DB: join(stores, 'xedge.db') },
            }),
        });
      // B3b's describe writer: every stored catalog is projected into estate as one generation.
      projector = new SourceProjector({ store, catalogs: registry.catalogs, call: estate });
      registry.catalogs.onWritten = (n) => projector.written(n);
      const graphDb = join(base, 'escalations.db');
      writeFileSync(graphDb, '');
      app = Fastify({ logger: false });
      registerSourceRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR, gate, dial });
      registerShapeRoutes(app, {
        registry,
        gate,
        estate: (tool, args) => estate(tool, args),
        repos: async () => [{ id: 'escalations', name: 'escalations', root_path: base, default_branch: 'main', registered_at: 0, code_graph_db: graphDb, findings: [] } as unknown as RepoEntry],
        lookup: async (_repo, name) => (name === 'Ticket' ? [{ symbol_id: 'scip-typescript npm escalations 1.0 src/`ticket.ts`/Ticket#', name: 'Ticket', kind: 'class', file: 'src/ticket.ts' }] : []),
        audit,
        actorOf: () => LOCAL_ACTOR,
        dial,
      });
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

    it('Test -> Profile -> Approve one, Decline one -> the map draws exactly the approved shape', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/sources/support-pg/profile' });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as SourceProfileResponse;
      // Every relation B3b projected is profiled under its own key (the quoted one too).
      expect(body.relations.map((r) => r.key).sort()).toEqual(['support."order-items"', 'support.assignments', 'support.regions', 'support.tickets']);
      expect(body.relations.every((r) => r.error === null)).toBe(true);
      const id = (rel: string): string => body.proposed.find((p) => p.relation === rel)!.id;
      // Nothing is knowledge yet.
      const recall = async (): Promise<string> => JSON.stringify(await estate('knowledge.recall', { query: 'support.tickets joins support.regions value-free', visible: [`source:${SID}`, 'repo:escalations'] }));
      expect(await recall()).not.toContain('value-free: counts in bands');
      expect(((await estate('proposal.approve', { id: id('support.tickets') })) as { outcome: string }).outcome).toBe('promoted');
      expect(((await estate('proposal.approve', { id: id('support."order-items"') })) as { outcome: string }).outcome).toBe('promoted');
      await estate('proposal.reject', { id: id('support.regions') });
      const m = await buildKnowledgeMap(estate, [{ id: SID, name: 'support-pg', described: true }], ['escalations']);
      expect(m.nodes.filter((n) => n.kind === 'shape').map((n) => n.proposalId).sort()).toEqual([id('support."order-items"'), id('support.tickets')].sort());
      expect(JSON.stringify(m)).not.toContain(id('support.regions'));
      expect(m.sources).toEqual([{ id: SID, name: 'support-pg', described: true, inKnowledge: true, tables: 4 }]);
      const joins = m.edges.filter((e) => e.rel === 'joins').map((e) => [m.nodes.find((n) => n.key === e.from)?.label, m.nodes.find((n) => n.key === e.to)?.label]);
      expect(joins.sort()).toEqual([['support."order-items"', 'support.tickets'], ['support.tickets', 'support.regions']]);
      expect(m.edges.some((e) => e.rel === 'describes')).toBe(true);
      expect(await recall()).toContain('value-free: counts in bands');
      expect(proposalNodeId(id('support.tickets'), 'concept')).toContain('kconcept synthetic proposal:');
    }, 120_000);
  });
}
