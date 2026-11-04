// DES-KNOWLEDGE-DATA-001 §19 B2 (coord, 2026-11-04): ticking a project in a source's Agents box is step 1 of the
// morning journey, so the agent switches are POLICY, never connection: `PUT /sources/support-pg/agents` must leave
// support-pg's descriptor hash (the pin both rig apps' locks hold) and its Allow writes switch exactly as they were.
//
// - The rig's own `support-pg` (crew 0.16.13's K1 record, read from :7721 with GETs on 2026-11-04): its pin
//   771eeb93…53f9 holds over every toggle, in K1 form and in the mapped v1 form, and Allow writes is untouched.
// - On a real Postgres (CI's sources-db job), the `escalations` (open_tickets) and `refund-approvals`
//   (pending_total) locks still verify and read after each toggle, through the unchanged executor.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { pinOf } from '../src/apps/exec/sources.js';
import type { AppQuery, AppQueryResponse } from '../src/core/types.js';
import { registerGateRoutes } from '../src/knowledge/gate/routes.js';
import { configOf, normalizeRegistryFile } from '../src/mcp/registry.js';
import { type McpRegistryFile, McpRegistryStore, type McpServerRecord } from '../src/mcp/registry-store.js';
import { sourceDescriptorHash } from '../src/sources/kinds.js';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';
import { DB_REQUIRED, type FreshPg, freshPgDatabase, LOOPBACK, PG_TARGETS } from './support/sources-db.js';

/** The pin both rig apps' locks hold for support-pg (`escalations` v8, `refund-approvals` v2). */
const RIG_PIN = '771eeb932fe4bdd30b6e0e8f2f2ed68fe7d2ed6556ddc869ab777a48b76753f9';

/** The rig's support-pg record as crew 0.16.13 stored it (K1 form), with Allow writes ON to prove a toggle keeps it. */
function rigRecord(extra: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    name: 'support-pg',
    kind: 'sql',
    command: null,
    args: [],
    url: null,
    auth: { ref: 'keychain:wicked-mcp/support-pg' },
    sql: { driver: 'postgres', host: '127.0.0.1', port: 55431, database: 'support', user: 'reader', tls: 'disable' },
    viewsAllowed: [],
    address: { allow: ['127.0.0.1/32'], plaintext: false },
    allowWrites: true,
    enabled: true,
    health: { state: 'ok', consecutiveFailures: 0, checkedAt: '2026-11-03T10:00:00.000Z', lastError: null },
    registeredAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    tools: [],
    ...extra,
  };
}

const TOGGLES: Array<Record<string, unknown>> = [
  { projects: ['proj_morning'] },
  { query: true },
  { see: false },
  { see: true, everyProject: true },
  { projects: [], everyProject: false, query: false },
];

async function routes(dir: string) {
  const store = new McpRegistryStore(join(dir, 'mcp'));
  const app = Fastify({ logger: false });
  registerGateRoutes(app, { store, audit: new AuditLog(join(dir, 'audit.log'), () => undefined), actorOf: () => LOCAL_ACTOR });
  await app.ready();
  return { app, store };
}

const onDisk = (dir: string): McpServerRecord => (JSON.parse(readFileSync(join(dir, 'mcp', 'registry.json'), 'utf8')) as McpRegistryFile).servers.find((s) => s.name === 'support-pg') as McpServerRecord;
const hashOf = (r: McpServerRecord): string => sourceDescriptorHash(configOf(normalizeRegistryFile({ version: 1, servers: [structuredClone(r)] }).servers[0] as McpServerRecord));

describe("the agent switches are policy, not connection: the rig's support-pg keeps its lock pin and Allow writes", () => {
  for (const [form, record] of [
    ['K1 form (as the rig stores it today)', rigRecord()],
    ['mapped v1 form (after B1 persists the Toolbox document)', normalizeRegistryFile({ version: 1, servers: [rigRecord()] }).servers[0] as McpServerRecord],
  ] as const) {
    it(form, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kd-b2-pin-'));
      mkdirSync(join(dir, 'mcp'), { recursive: true });
      writeFileSync(join(dir, 'mcp', 'registry.json'), JSON.stringify({ version: 1, servers: [record] }));
      expect(hashOf(onDisk(dir))).toBe(RIG_PIN);
      expect(pinOf(configOf(normalizeRegistryFile({ version: 1, servers: [onDisk(dir)] }).servers[0] as McpServerRecord)).descriptorHash).toBe(RIG_PIN);
      const { app } = await routes(dir);
      for (const body of TOGGLES) {
        const res = await app.inject({ method: 'PUT', url: '/api/v1/sources/support-pg/agents', payload: body });
        expect(res.statusCode, `${JSON.stringify(body)}: ${res.body}`).toBe(200);
        const now = onDisk(dir);
        expect(hashOf(now), JSON.stringify(body)).toBe(RIG_PIN);
        expect(now.allowWrites, JSON.stringify(body)).toBe(true);
        expect(now.kind).toBe(record.kind);
      }
      await app.close();
    });
  }
});

// ── The rig apps' locks through the unchanged executor, on a real Postgres ──────────────────────────────────

const SUPPORT_SEED = `
CREATE SCHEMA support;
CREATE TYPE support.ticket_status AS ENUM ('open', 'pending', 'escalated', 'closed');
CREATE TABLE support.tickets (id int PRIMARY KEY, status support.ticket_status NOT NULL);
INSERT INTO support.tickets SELECT g, (ARRAY['open','pending','escalated','closed'])[1 + g % 4]::support.ticket_status FROM generate_series(1, 400) g;
GRANT USAGE ON SCHEMA support TO apps_reader;
GRANT SELECT ON support.tickets TO apps_reader;
`;
const OPEN_TICKETS = "SELECT count(*)::int AS open FROM support.tickets WHERE status = 'open'";
const PENDING_TOTAL = "SELECT count(*)::int AS pending FROM support.tickets WHERE status = 'pending'";

if (PG_TARGETS.length === 0) {
  describe('the rig apps after Agents-box toggles', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the rig apps' locks after Agents-box toggles (${target.label})`, () => {
    let db: FreshPg;
    let h: Harness;
    let storeRef: McpRegistryStore | null = null;
    beforeAll(async () => {
      db = await freshPgDatabase(target);
      await db.admin.unsafe(SUPPORT_SEED);
      h = await appsHarness({
        // The switches route, over the harness's own registry file (its directory is known once the harness exists).
        extra: (app, x) => registerGateRoutes(app, { store: { mutate: (fn) => (storeRef as McpRegistryStore).mutate(fn) }, audit: x.audit, actorOf: () => LOCAL_ACTOR }),
      });
      storeRef = new McpRegistryStore(join(h.dir, 'mcp'));
      h.env['KD_SUPPORT_PG'] = 'apps-reader';
      mkdirSync(join(h.dir, 'mcp'), { recursive: true });
      const legacy = rigRecord({ auth: { ref: 'env:KD_SUPPORT_PG' }, sql: { driver: 'postgres', host: '127.0.0.1', port: db.port, database: db.database, user: 'apps_reader', tls: 'disable' }, address: { ...LOOPBACK, allow: [...LOOPBACK.allow] } });
      writeFileSync(join(h.dir, 'mcp', 'registry.json'), JSON.stringify({ version: 1, servers: [legacy] }));
    }, 60_000);
    afterAll(async () => {
      await h?.close();
      await db?.drop();
    });
    const queryOf = (id: string, out: string): AppQuery => ({ id, source: 'support-pg', kind: 'sql', output: [{ name: out, type: 'integer' }] });

    it('escalations and refund-approvals still verify and read after every toggle; the pin and Allow writes hold', async () => {
      const d = await h.call('POST', '/sources/support-pg/describe', {});
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      const pin = (await h.registry.source('support-pg')).descriptorHash;
      const versions: Record<string, number> = {};
      for (const [slug, q, text, out] of [['escalations', 'open_tickets', OPEN_TICKETS, 'open'], ['refund-approvals', 'pending_total', PENDING_TOTAL, 'pending']] as const) {
        await h.newApp(slug);
        const landed = await h.land(slug, specWith([queryOf(q, out)]), { [q]: text });
        expect(landed.status, JSON.stringify(landed.body)).toBe(200);
        const lock = (landed.body.app as unknown as { lock: { sources: Record<string, { descriptorHash: string }> } }).lock;
        expect(lock.sources['support-pg']?.descriptorHash).toBe(pin);
        versions[slug] = (landed.body.app as unknown as { head: { version: number } }).head.version;
      }
      for (const body of TOGGLES) {
        const res = await h.call('PUT', '/sources/support-pg/agents', body);
        expect(res.status, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`).toBe(200);
        const src = await h.registry.source('support-pg');
        expect(src.descriptorHash, JSON.stringify(body)).toBe(pin);
        expect(src.allowWrites, JSON.stringify(body)).toBe(true);
        for (const [slug, q] of [['escalations', 'open_tickets'], ['refund-approvals', 'pending_total']] as const) {
          const r = await h.call('POST', `/apps/${slug}/query`, { version: versions[slug], query: q });
          expect(r.status, `${slug} after ${JSON.stringify(body)}: ${JSON.stringify(r.body)}`).toBe(200);
          expect((r.body as unknown as AppQueryResponse).rows).toEqual([[100]]);
        }
      }
    }, 90_000);
  });
}
