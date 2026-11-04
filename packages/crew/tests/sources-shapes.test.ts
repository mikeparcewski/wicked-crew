// DES-KNOWLEDGE-DATA-001 §10.2, §19 B4 against REAL Postgres (CI: 16 and 17): the value-free profiler, started by a
// person (POST /sources/:name/profile), reads a support-like schema through the data gate's person read and files
// one data-shape proposal per relation into estate's review queue (a recording fake here; the real estate binary is
// knowledge-shapes-estate-live.test.ts).
//
// NEGATIVE CONTROL: a marker seeded in every text value, in a column DEFAULT and in a COMMENT appears in no estate
// call, no answer and no audit line; no exact row count is kept; every statement the profiler sends is a fixed
// aggregate. (Red with the example-value mutant: scripts/mutants.py in the lane.)

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { catalogDocId } from '../src/knowledge/shapes/shapes.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { countingResolver, DB_HOST, DB_REQUIRED, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

const MARKER = `kdb4mark${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const SECRET = `kd-b4-${randomUUID().slice(0, 8)}`;
const SID = '3f0c9a1e-0000-4000-8000-00000000b4a1';
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

if (PG_TARGETS.length === 0) {
  describe('the profiler on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the value-free profiler on ${target.label}`, () => {
    let db: FreshPg;
    let app: FastifyInstance;
    let base: string;
    const role = `kd_b4_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const texts: string[] = [];
    const estateCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const queue: Array<{ id: string; state: string; payload: unknown }> = [];
    let auditPath = '';
    let gateRef: DataGate;
    let auditRef: AuditLog;
    let registryRef: McpRegistry;

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
      auditRef = audit;
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
      gateRef = gate;
      registryRef = registry;
      // Estate as the review queue sees it: the source's structure is there (B3b's writer), the queue records.
      const estate = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
        estateCalls.push({ tool, args: structuredClone(args) });
        if (tool === 'knowledge.source_catalog') {
          if (args['sourceId'] !== SID || !(args['visible'] as string[]).includes(`source:${SID}`)) throw new Error('unknown or hidden source');
          // B3b's documents: the key quotes a name that is not a plain identifier; the entry names schema and name.
          const docs = [['support."order-items"', 'order-items'], ['support.assignments', 'assignments'], ['support.regions', 'regions'], ['support.tickets', 'tickets']];
          return { sourceId: SID, generation: 3, page: 0, pages: 1, docs: docs.map(([key, name]) => ({ key, entry: { relation: key, schema: 'support', name } })) };
        }
        if (tool === 'proposal.list') return { proposals: queue };
        if (tool === 'proposal.submit') {
          const id = `p${queue.length + 1}`;
          queue.push({ id, state: 'pending', payload: args['payload'] });
          return { id };
        }
        throw new Error(`unexpected estate tool ${tool}`);
      };
      const graphDb = join(base, 'escalations.db');
      writeFileSync(graphDb, '');
      app = Fastify({ logger: false });
      registerSourceRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR, gate, dial });
      registerShapeRoutes(app, {
        registry,
        gate,
        estate,
        repos: async () => [{ id: 'escalations', name: 'escalations', root_path: base, default_branch: 'main', registered_at: 0, code_graph_db: graphDb, findings: [] } as unknown as RepoEntry],
        lookup: async (_repo, name) => (name === 'Ticket' ? [{ symbol_id: 'scip-typescript npm escalations 1.0 src/`ticket.ts`/Ticket#', name: 'Ticket', kind: 'class', file: 'src/ticket.ts' }] : []),
        audit,
        actorOf: () => LOCAL_ACTOR,
        dial,
      });
      await app.ready();
      const t = await app.inject({ method: 'POST', url: '/api/v1/sources/support-pg/test' });
      expect(t.json(), t.body).toMatchObject({ ok: true });
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

    it('profiles every relation in bands, finds the joins, and files one shape per relation', async () => {
      texts.length = 0;
      const res = await app.inject({ method: 'POST', url: '/api/v1/sources/support-pg/profile' });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as SourceProfileResponse;
      expect(body.relations.map((r) => [r.key, r.rows, r.error])).toEqual([
        ['support."order-items"', '1-99', null],
        ['support.assignments', '100-9,999', null],
        ['support.regions', '1-99', null],
        ['support.tickets', '100-9,999', null],
      ]);
      const note = body.relations.find((r) => r.key === 'support.tickets')!.columns.find((c) => c.name === 'note');
      expect(note).toEqual({ name: 'note', type: 'text', nullPct: 10, hasNulls: true, cardinality: 'unique', keyCandidate: false });
      const status = body.relations.find((r) => r.key === 'support.tickets')!.columns.find((c) => c.name === 'status');
      expect(status).toMatchObject({ cardinality: 'low', nullPct: 0, hasNulls: false });
      expect(body.joins).toEqual([
        { from: 'support."order-items"', columns: ['ticket_id'], to: 'support.tickets', references: ['id'], basis: 'fk', overlap: 'all' },
        { from: 'support.assignments', columns: ['ticket_id'], to: 'support.tickets', references: ['id'], basis: 'name_type', overlap: 'all' },
        { from: 'support.tickets', columns: ['region_id'], to: 'support.regions', references: ['id'], basis: 'fk', overlap: 'all' },
      ]);
      expect(body.describes).toEqual([{ relation: 'support.tickets', repo: 'escalations', name: 'Ticket', kind: 'class', file: 'src/ticket.ts' }]);
      expect(body.proposed.map((p) => p.relation)).toEqual(['support."order-items"', 'support.assignments', 'support.regions', 'support.tickets']);
      // The quoted key links estate's own document id (percent-encoded as estate does).
      const items = queue.find((q) => (q.payload as { shape: { relation: string } }).shape.relation === 'support."order-items"')!.payload as Record<string, unknown>;
      expect((items['relate'] as Array<{ to: string }>)[0]!.to).toBe(`kdoc synthetic source:${SID}/support.%22order-items%22:`);
      const tickets = queue.find((q) => (q.payload as { shape: { relation: string } }).shape.relation === 'support.tickets')!.payload as Record<string, unknown>;
      expect(tickets['relate']).toEqual([
        { rel: 'derived_from', to: catalogDocId(SID, 'support.tickets'), confidence: 1 },
        { rel: 'joins', from: catalogDocId(SID, 'support.tickets'), to: catalogDocId(SID, 'support.regions'), confidence: 0.95, evidence: { basis: 'fk', on: [{ columns: ['region_id'], references: ['id'], basis: 'fk', overlap: 'all' }] } },
      ]);
      expect(tickets['relate_code']).toMatchObject([{ rel: 'describes', repo: 'escalations', code_id: 'scip-typescript npm escalations 1.0 src/`ticket.ts`/Ticket#' }]);
      // Every statement sent is a fixed aggregate under the gate's LIMIT rewrite.
      expect(texts.length).toBe(7);
      for (const t of texts) {
        expect(t).toMatch(/^SELECT \* FROM \(\s*SELECT count\(/);
        expect(t).not.toMatch(/\b(min|max|array_agg|string_agg|mode)\(/i);
      }
    });

    it('NEGATIVE CONTROL: no seeded value, default or comment, and no exact count, reaches estate, the answer or the audit', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/sources/support-pg/profile' });
      expect(res.statusCode, res.body).toBe(200);
      const outbound = JSON.stringify(estateCalls);
      expect(outbound).toContain('support.tickets');
      await auditRef.flush();
      const auditText = readFileSync(auditPath, 'utf8');
      const profiled = auditText.split('\n').filter((l) => l.includes('knowledge.source.profiled'));
      expect(profiled.length).toBeGreaterThanOrEqual(1);
      for (const text of [outbound, res.body, auditText]) {
        expect(text).not.toContain(MARKER);
        expect(text).not.toContain('region ');
        expect(text).not.toMatch(/\b437\b|\b120\b/);
      }
      // The same profile again files nothing new (an identical shape is in the queue).
      expect((res.json() as SourceProfileResponse).alreadyProposed).toBe(4);
      expect(estateCalls.filter((c) => c.tool === 'proposal.submit')).toHaveLength(4);
    });

    it('refuses a source whose structure estate does not hold yet (a shape must link live catalog documents)', async () => {
      const bare = Fastify({ logger: false });
      registerShapeRoutes(bare, {
        registry: registryRef,
        gate: gateRef,
        estate: async (tool) => {
          if (tool === 'knowledge.source_catalog') throw new Error('unknown or hidden source');
          throw new Error(`nothing else is called: ${tool}`);
        },
        repos: async () => [],
        audit: { record: () => undefined },
        actorOf: () => LOCAL_ACTOR,
      });
      await bare.ready();
      texts.length = 0;
      const r = await bare.inject({ method: 'POST', url: '/api/v1/sources/support-pg/profile' });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ code: 'not_in_knowledge' });
      expect(texts).toEqual([]);
      await bare.close();
    });
  });
}
