// DES-KNOWLEDGE-DATA-001 §5 (brief B1): the one registry. Entry ids; Postgres sources stored as Toolbox's own
// source document behind the read-path projection; descriptor v1 compatibility (the rig's real `support-pg` lock
// pin reproduces exactly) and v2 on a save; the Postgres deployment policy; per-tool disclosure classes; the
// agent-safe view and human-only management reads (crew#1310); 10 generations and a fail-closed restore.
// The executor regression (`escalations`' open_tickets, `refund-approvals`' pending_total) runs on a real
// Postgres when APPS_PG16_URL / APPS_PG17_URL is set (CI's sources-db job).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR, registerAuthHooks } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { pinOf } from '../src/apps/exec/sources.js';
import type { Actor, AppQuery, AppQueryResponse, McpPreviewResponse, McpServer, McpServersAgentResponse, McpServersResponse } from '../src/core/types.js';
import { checkSourceDocument, DeploymentPolicyError } from '../src/knowledge/registry/policy.js';
import type { McpPolicies } from '../src/mcp/policies.js';
import { canonicalJson } from '../src/mcp/classify.js';
import { probeMcpServer, type Prober } from '../src/mcp/probe.js';
import { configOf, McpRegistry, normalizeRegistryFile } from '../src/mcp/registry.js';
import { GENERATIONS_KEPT, type McpRegistryFile, McpRegistryStore, type McpServerRecord } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { sourceDescriptorHash } from '../src/sources/kinds.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { removeScratch } from './setup/scratch.js';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';
import { DB_REQUIRED, type FreshPg, freshPgDatabase, LOOPBACK, PG_TARGETS } from './support/sources-db.js';

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');

/**
 * The rig's `support-pg` pin, exactly as both rig apps' locks hold it (`escalations` v8 and `refund-approvals` v2,
 * read from :7721 with GETs on 2026-11-04). A K1 record with these settings must project to exactly this pin.
 */
const RIG_PIN = {
  kind: 'sql',
  descriptor: {
    address: { allow: ['127.0.0.1/32'], plaintext: false },
    auth: { header: null, prefix: null, ref: 'keychain:wicked-mcp/support-pg' },
    kind: 'sql',
    sql: { ca: null, database: 'support', driver: 'postgres', host: '127.0.0.1', port: 55431, snapshot: null, tls: 'disable', user: 'reader' },
    url: null,
  },
  descriptorHash: '771eeb932fe4bdd30b6e0e8f2f2ed68fe7d2ed6556ddc869ab777a48b76753f9',
};

/** K1's descriptor function as it shipped (frozen here, so the v1 branch can never drift from it unnoticed). */
function k1Hash(r: { url: string | null; auth: { ref: string } | null; sql: Record<string, unknown>; address: unknown }): string {
  const sql = r.sql;
  const descriptor = {
    kind: 'sql',
    url: r.url,
    auth: r.auth === null ? null : { ref: r.auth.ref, header: null, prefix: null },
    sql: { driver: sql['driver'], host: sql['host'] ?? null, port: sql['port'] ?? null, database: sql['database'] ?? null, user: sql['user'] ?? null, tls: sql['tls'] ?? 'verify-full', ca: sql['ca'] == null ? null : createHash('sha256').update(String(sql['ca'])).digest('hex'), snapshot: sql['snapshot'] ?? null },
    address: r.address ?? null,
  };
  return createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
}

function k1Record(extra: Partial<McpServerRecord> = {}): McpServerRecord {
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
    allowWrites: false,
    enabled: true,
    health: { state: 'ok', consecutiveFailures: 0, checkedAt: '2026-11-03T10:00:00.000Z', lastError: null },
    registeredAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    tools: [],
    ...extra,
  };
}

describe('descriptor v1: a K1 Postgres record maps to the Toolbox form and keeps its hash', () => {
  it("the rig's support-pg: the mapped entry projects to exactly the pin both rig apps' locks hold", () => {
    const before = configOf(k1Record());
    expect(pinOf(before)).toEqual(RIG_PIN); // K1's own projection (the regression baseline)
    const file = normalizeRegistryFile({ version: 1, servers: [k1Record()] });
    const mapped = file.servers[0]!;
    expect(mapped.kind).toBe('toolbox-source');
    expect(mapped.sql).toBeUndefined();
    expect(mapped).toMatchObject({ runtime: 'native', descriptorVersion: 1, tls: { mode: 'disable', ca: null }, policyVersion: 'postgres/1@toolbox-v1.15.0' });
    expect(mapped.toolbox).toEqual({ kind: 'source', type: 'postgres', host: '127.0.0.1', port: '55431', database: 'support', user: 'reader', password: '${WICKED_SRC_1}' });
    const after = configOf(mapped);
    expect(after.kind).toBe('sql'); // the read-path projection
    expect(after.sql).toEqual(before.sql);
    expect(pinOf(after)).toEqual(RIG_PIN);
    expect(sourceDescriptorHash(after)).toBe(RIG_PIN.descriptorHash);
    expect(k1Hash({ url: null, auth: mapped.auth, sql: after.sql as unknown as Record<string, unknown>, address: after.address })).toBe(RIG_PIN.descriptorHash);
  });

  it('a record gets a stable id before any write; a name registered again (new registeredAt) is a new id', () => {
    const a = normalizeRegistryFile({ version: 1, servers: [k1Record()] }).servers[0]!.id;
    const b = normalizeRegistryFile({ version: 1, servers: [k1Record()] }).servers[0]!.id;
    const c = normalizeRegistryFile({ version: 1, servers: [k1Record({ registeredAt: '2026-11-04T00:00:00.000Z' })] }).servers[0]!.id;
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(normalizeRegistryFile({ version: 1, servers: [k1Record({ id: 'kept-id' })] }).servers[0]!.id).toBe('kept-id');
  });

  it('a record the policy or the projection cannot carry exactly stays in K1 form (MySQL, a host list, no port, a snapshot field)', () => {
    const keep = (r: McpServerRecord): McpServerRecord => normalizeRegistryFile({ version: 1, servers: [r] }).servers[0]!;
    expect(keep(k1Record({ sql: { driver: 'mysql', host: '127.0.0.1', port: 3306, database: 'd', user: 'u', tls: 'disable' } })).kind).toBe('sql');
    expect(keep(k1Record({ sql: { driver: 'postgres', host: 'a.example,b.example', port: 5432, database: 'd', user: 'u' } })).kind).toBe('sql');
    expect(keep(k1Record({ sql: { driver: 'postgres', host: 'db.example', database: 'd', user: 'u' } })).kind).toBe('sql');
    expect(keep(k1Record({ sql: { driver: 'postgres', host: 'db.example', port: 5432, database: 'd', user: 'u', snapshot: 'x' } })).kind).toBe('sql');
    const kept = keep(k1Record({ sql: { driver: 'postgres', host: 'db.example', database: 'd', user: 'u' } }));
    expect(sourceDescriptorHash(configOf(kept))).toBe(sourceDescriptorHash(configOf(k1Record({ sql: { driver: 'postgres', host: 'db.example', database: 'd', user: 'u' } }))));
  });
});

describe('the Postgres deployment policy (Toolbox v1.15.0)', () => {
  const ok = { kind: 'source', type: 'postgres', host: 'db.internal.test', port: '5432', database: 'warehouse_db', user: 'reader_login', password: '${WICKED_SRC_1}' };
  const refused = (doc: Record<string, unknown>, runtime: 'native' | 'toolbox' = 'native'): string => {
    try {
      checkSourceDocument(doc, { runtime });
    } catch (err) {
      if (err instanceof DeploymentPolicyError) return `${err.code}:${err.field ?? ''}`;
      throw err;
    }
    return 'accepted';
  };
  it('accepts the schema fields; refuses bypass, crew-written, unknown, literal-secret and interpolating fields', () => {
    expect(refused(ok)).toBe('accepted');
    expect(refused({ ...ok, port: 5432 })).toBe('accepted');
    expect(refused({ ...ok, connectionString: 'postgres://x@evil.example/db' })).toBe('refused_field:connectionString');
    expect(refused({ ...ok, queryExecMode: 'simple_protocol' })).toBe('refused_field:queryExecMode');
    expect(refused({ ...ok, queryParams: { sslrootcert: '/etc/passwd' } })).toBe('crew_written_field:queryParams');
    expect(refused({ ...ok, connectTimeout: 5 })).toBe('crew_written_field:connectTimeout');
    expect(refused({ ...ok, name: 'x' })).toBe('crew_written_field:name');
    expect(refused({ ...ok, tnsAdmin: '/opt/oracle' })).toBe('unknown_field:tnsAdmin');
    expect(refused({ ...ok, password: 'hunter2-literal' })).toBe('secret_literal:password');
    expect(refused({ ...ok, user: '${HOME}' })).toBe('interpolation:user');
    expect(refused({ ...ok, host: 'a.example,b.example' })).toBe('bad_field:host');
    expect(refused({ ...ok, host: '/var/run/postgresql' })).toBe('bad_field:host');
    expect(refused({ ...ok, port: '70000' })).toBe('bad_field:port');
    expect(refused({ ...ok, type: 'mysql' })).toBe('unsupported_type:type');
    const { password: _pw, ...nopw } = ok;
    void _pw;
    expect(refused(nopw)).toBe('accepted');
    expect(refused(nopw, 'toolbox')).toBe('missing_field:password');
  });
});

// ── Routes: views, policy at preview and save, disclosure, generations ──────────────────────────

const HUMAN: Actor = { id: 'priya', kind: 'human', trust: 'operator' };
const AGENT: Actor = { id: 'seat-codex', kind: 'agent', trust: 'operator' };
const TOKENS: Record<string, Actor> = { human: HUMAN, agent: AGENT };

/** A describe with structure only, so a `sql` preview never dials. */
const fakeDescribe: Prober = async (config, secret) => {
  if (config.kind !== 'sql') return probeMcpServer(config, secret);
  return {
    ok: true,
    serverInfo: null,
    tools: [],
    source: { catalog: { dialect: 'postgres', database: config.sql?.database ?? null, relations: [], describedAt: '2026-11-04T05:00:00.000Z' }, privileges: { readOnly: true, writable: [] } as never },
  };
};

class MemorySecrets implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  /** A keychain whose metadata answers while reading the value does not (codex r1 #2). */
  unreadable = false;
  async get(a: string) {
    return this.unreadable ? null : (this.values.get(a) ?? null);
  }
  async has(a: string) {
    return this.values.has(a);
  }
  async set(a: string, v: string) {
    this.values.set(a, v);
  }
  async delete(a: string) {
    this.values.delete(a);
  }
}

describe('the one registry over its routes', () => {
  let base: string;
  let app: FastifyInstance;
  let registry: McpRegistry;
  let store: McpRegistryStore;
  let env: Record<string, string>;
  let specPath: string;
  let secrets: MemorySecrets;
  const SQL_BODY = { name: 'wh', kind: 'sql', sql: { driver: 'postgres', host: 'pg.internal.test', port: 6543, database: 'warehouse_db', user: 'reader_login', tls: 'disable' }, auth: { ref: 'env:KD_WH_PASSWORD' } };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-b1-registry-'));
    specPath = join(base, 'spec.json');
    writeFileSync(specPath, JSON.stringify({ tools: [{ name: 'wt_echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }));
    env = { KD_WH_PASSWORD: 'kd-b1-fixture-password' };
    store = new McpRegistryStore(join(base, 'mcp'));
    secrets = new MemorySecrets();
    registry = new McpRegistry({ store, secrets, probe: fakeDescribe, discover: () => [], env });
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
    const actorOf = (req: { actor?: Actor | null }): Actor => req.actor ?? LOCAL_ACTOR;
    registerMcpRoutes(app, { registry, audit, actorOf });
    registerSourceRoutes(app, { registry, audit, actorOf });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    removeScratch(base);
  });

  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, as: 'human' | 'agent', payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${as}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & { code?: string }, text: res.body };
  };
  const save = async (config: Record<string, unknown>, as: 'human' | 'agent' = 'human', extra: Record<string, unknown> = {}) => {
    const p = await call('POST', '/mcp/servers/preview', as, config);
    expect(p.status, p.text).toBe(200);
    const s = await call('POST', '/mcp/servers', as, { previewHash: (p.body as unknown as McpPreviewResponse).previewHash, ...extra });
    return s;
  };
  const onDisk = (): McpRegistryFile => JSON.parse(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')) as McpRegistryFile;

  it('a sql Postgres body is SAVED as a Toolbox document (descriptor v2, no sql, the password a placeholder); every reader still sees kind sql', async () => {
    const saved = await save(SQL_BODY);
    expect(saved.status, saved.text).toBe(201);
    const rec = onDisk().servers[0]!;
    expect(rec).toMatchObject({ kind: 'toolbox-source', runtime: 'native', descriptorVersion: 2, toolbox: { kind: 'source', type: 'postgres', host: 'pg.internal.test', port: '6543', database: 'warehouse_db', user: 'reader_login', password: '${WICKED_SRC_1}' } });
    expect(rec.sql).toBeUndefined();
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')).not.toContain(env['KD_WH_PASSWORD']);
    const server = saved.body as unknown as McpServer;
    expect(server).toMatchObject({ id: rec.id, kind: 'sql', sql: { driver: 'postgres', host: 'pg.internal.test', port: 6543 }, runtime: 'native', descriptorVersion: 2, allowWrites: false, agents: { see: true, query: false, projects: [], everyProject: false } });
    const src = await registry.source('wh');
    expect(src.config.kind).toBe('sql');
    expect(src.descriptorHash).toBe(sourceDescriptorHash(configOf(rec)));
    expect(src.descriptorHash).not.toBe(k1Hash({ url: null, auth: rec.auth, sql: src.config.sql as unknown as Record<string, unknown>, address: src.config.address }));
    // A re-save keeps the id; the same settings keep the v2 hash.
    const again = await save(SQL_BODY);
    expect((again.body as unknown as McpServer).id).toBe(rec.id);
    expect((await registry.source('wh')).descriptorHash).toBe(src.descriptorHash);
  });

  it('a toolbox-source body (native runtime) is the same entry; runtime toolbox is 501 on a daemon without the Toolbox runtime', async () => {
    const doc = { kind: 'source', type: 'postgres', host: 'pg.internal.test', port: '6543', database: 'warehouse_db', user: 'reader_login', password: '${WICKED_SRC_1}' };
    const saved = await save({ name: 'wh', kind: 'toolbox-source', toolbox: doc, tls: { mode: 'disable' }, auth: { ref: 'env:KD_WH_PASSWORD' } });
    expect(saved.status, saved.text).toBe(201);
    expect(saved.body).toMatchObject({ kind: 'sql', toolbox: doc, runtime: 'native' });
    const t = await call('POST', '/mcp/servers/preview', 'human', { name: 'wh2', kind: 'toolbox-source', runtime: 'toolbox', toolbox: doc, auth: { ref: 'env:KD_WH_PASSWORD' } });
    expect([t.status, t.body.code]).toEqual([501, 'runtime_unavailable']);
  });

  it('NEGATIVE CONTROL: a Toolbox document with connectionString is refused at the preview, and nothing is saved', async () => {
    const doc = { kind: 'source', type: 'postgres', host: 'pg.internal.test', port: '6543', database: 'warehouse_db', user: 'reader_login', password: '${WICKED_SRC_1}', connectionString: 'postgres://reader@evil.example:5432/db' };
    const p = await call('POST', '/mcp/servers/preview', 'human', { name: 'wh', kind: 'toolbox-source', toolbox: doc, auth: { ref: 'env:KD_WH_PASSWORD' } });
    expect([p.status, p.body.code]).toEqual([400, 'refused_field']);
    expect(String(p.body['error'])).toContain('address check');
    expect(p.body['previewHash']).toBeUndefined();
    expect((await registry.list()).servers).toEqual([]);
  });

  it('NEGATIVE CONTROL: a stored document carrying connectionString is refused when the write lands (a restored generation edited by hand)', async () => {
    expect((await save(SQL_BODY)).status).toBe(201);
    expect((await save(SQL_BODY)).status).toBe(201); // generation 1 is kept
    const genPath = join(base, 'mcp', 'registry.json.1');
    const kept = JSON.parse(readFileSync(genPath, 'utf8')) as McpRegistryFile;
    (kept.servers[0]!.toolbox as unknown as Record<string, unknown>)['connectionString'] = 'postgres://reader@evil.example/db';
    (kept.servers[0]!.toolbox as unknown as Record<string, unknown>)['host'] = 'evil.example';
    writeFileSync(genPath, JSON.stringify(kept));
    const before = readFileSync(join(base, 'mcp', 'registry.json'), 'utf8');
    const r = await call('POST', '/mcp/registry/restore', 'human', { generation: 1 });
    expect([r.status, r.body.code]).toEqual([400, 'refused_field']);
    expect(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')).toBe(before);
  });

  it('codex r2: a write that changes only the runtime a document is judged for is checked too', async () => {
    const { auth: _auth, ...noPassword } = SQL_BODY;
    void _auth;
    expect((await save(noPassword)).status).toBe(201); // passwordless: valid for the native runtime only
    const before = readFileSync(join(base, 'mcp', 'registry.json'), 'utf8');
    const mutate = (registry as unknown as { mutate(fn: (f: McpRegistryFile) => void): Promise<void> }).mutate.bind(registry);
    await expect(mutate((f) => void (f.servers[0]!.runtime = 'toolbox'))).rejects.toMatchObject({ code: 'missing_field' });
    expect(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')).toBe(before);
  });

  it('NEGATIVE CONTROL (crew#1310): an agent-kind bearer gets the projection on GET /mcp/servers, and 403 on every management read', async () => {
    expect((await save(SQL_BODY)).status).toBe(201);
    expect((await save({ name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] })).status).toBe(201);
    const human = await call('GET', '/mcp/servers', 'human');
    expect((human.body as unknown as McpServersResponse).servers.find((s) => s.name === 'wh')).toMatchObject({ sql: { host: 'pg.internal.test' }, toolbox: { database: 'warehouse_db' } });
    const agent = await call('GET', '/mcp/servers', 'agent');
    expect(agent.status).toBe(200);
    const view = agent.body as unknown as McpServersAgentResponse;
    expect(view.view).toBe('agent');
    expect(view.servers.map((s) => s.name).sort()).toEqual(['fx', 'wh']);
    expect(view.servers.find((s) => s.name === 'wh')).toEqual({ id: expect.any(String), name: 'wh', kind: 'sql', enabled: true, health: { state: 'ok' }, tools: [], agents: { see: true, query: false } });
    expect(view.servers.find((s) => s.name === 'fx')?.tools).toEqual([{ name: 'wt_echo', subject: 'mcp:fx/wt_echo', class: 'read', disclosure: null, enabled: true, status: 'registered' }]);
    for (const leak of ['pg.internal.test', '6543', 'warehouse_db', 'reader_login', 'KD_WH_PASSWORD', 'env:', FIXTURE_SERVER, specPath, process.execPath, 'discovered']) expect(agent.text).not.toContain(leak);
    // A human may ask for the projection too.
    expect((await call('GET', '/mcp/servers?view=agent', 'human')).body['view']).toBe('agent');
    // The answers that carry a server are projected for an agent as well.
    const patched = await call('PATCH', '/mcp/servers/wh', 'agent', { enabled: true });
    expect(patched.status).toBe(200);
    expect(patched.text).not.toContain('pg.internal.test');
    const tested = await call('POST', '/mcp/servers/fx/test', 'agent');
    expect(tested.status).toBe(200);
    expect(tested.text).not.toContain(FIXTURE_SERVER);
    // Management reads: 403 for the agent whatever its trust; the human's catalog read answers.
    for (const [method, url, payload] of [
      ['GET', '/sources/wh/catalog', undefined],
      ['POST', '/sources/wh/describe', {}],
      ['POST', '/sources/wh/privileges', {}],
      ['POST', '/sources/wh/check', { text: 'SELECT 1' }],
      ['POST', '/sources/wh/safety', { schema: 's', table: 't' }],
      ['POST', '/sources/wh/test', {}],
    ] as const) {
      const r = await call(method, url, 'agent', payload);
      expect([url, r.status, r.body.code]).toEqual([url, 403, 'human_only']);
    }
    expect((await call('GET', '/sources/wh/catalog', 'human')).status).toBe(200);
    // codex r1 #6: another spelling of the same route (the router decodes it) is the same route.
    expect((await call('GET', '/sources/wh/%63atalog', 'human')).status).toBe(200);
    expect((await call('GET', '/sources/wh/%63atalog', 'agent')).body.code).toBe('human_only');
    // pi r1 S1: an unknown query parameter is ignored, as it always was.
    expect((await call('GET', '/mcp/servers?_=1', 'human')).status).toBe(200);
    // codex r1 #9: a refused re-key does not echo the stored reference.
    const rekey = await call('PUT', '/mcp/servers/wh/secret', 'agent', { value: 'another-value-1' });
    expect([rekey.status, rekey.body.code]).toEqual([400, 'secret_not_referenced']);
    expect(rekey.text).not.toContain('KD_WH_PASSWORD');
    // A preview by an agent answers no structure of the source.
    const p = await call('POST', '/mcp/servers/preview', 'agent', SQL_BODY);
    expect(p.status).toBe(200);
    expect((p.body as unknown as McpPreviewResponse).source).toBeUndefined();
  });

  it("disclosure: reviewed by a human at save or patch, bound to the tool's saved schema, exposed to the broker", async () => {
    const fx = { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] };
    const p = await call('POST', '/mcp/servers/preview', 'human', fx);
    expect((p.body as unknown as McpPreviewResponse).tools[0]?.disclosure).toBeNull();
    const byAgent = await call('POST', '/mcp/servers', 'agent', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash, disclosures: { wt_echo: 'rows' } });
    expect([byAgent.status, byAgent.body.code]).toEqual([403, 'disclosure_review_human_only']);
    const unknown = await call('POST', '/mcp/servers', 'human', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash, disclosures: { nope: 'rows' } });
    expect([unknown.status, unknown.body.code]).toEqual([400, 'unknown_tool']);
    const saved = await call('POST', '/mcp/servers', 'human', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash, disclosures: { wt_echo: 'rows' } });
    expect(saved.status, saved.text).toBe(201);
    expect((saved.body as unknown as McpServer).tools[0]?.disclosure).toBe('rows');
    expect((await registry.callableTools()).map((t) => [t.tool, t.disclosure, typeof t.id])).toEqual([['wt_echo', 'rows', 'string']]);
    expect((await registry.resolveCall('fx', 'wt_echo'))?.disclosure).toBe('rows');
    // The same schema saved again keeps it; a changed schema drops it until it is reviewed again.
    expect(((await save(fx)).body as unknown as McpServer).tools[0]?.disclosure).toBe('rows');
    writeFileSync(specPath, JSON.stringify({ tools: [{ name: 'wt_echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' }, more: { type: 'string' } } }, annotations: { readOnlyHint: true } }] }));
    expect(((await save(fx)).body as unknown as McpServer).tools[0]?.disclosure).toBeNull();
    expect((await call('PATCH', `/mcp/tools/${encodeURIComponent('mcp:fx/wt_echo')}`, 'agent', { disclosure: 'structure' })).body.code).toBe('disclosure_review_human_only');
    const patched = await call('PATCH', `/mcp/tools/${encodeURIComponent('mcp:fx/wt_echo')}`, 'human', { disclosure: 'structure' });
    expect([patched.status, patched.body['disclosure']]).toEqual([200, 'structure']);
    // Clearing needs no review.
    expect((await call('PATCH', `/mcp/tools/${encodeURIComponent('mcp:fx/wt_echo')}`, 'agent', { disclosure: null })).body['disclosure']).toBeNull();
  });

  it(`generations: every write keeps the one it replaces, and only the last ${GENERATIONS_KEPT} are kept`, async () => {
    for (let i = 0; i < 13; i++) await registry.setServerEnabled('wh', i % 2 === 0).catch(async () => save(SQL_BODY));
    const g = await call('GET', '/mcp/registry/generations', 'human');
    const body = g.body as { current: number; generations: Array<{ generation: number }> };
    expect(body.generations).toHaveLength(GENERATIONS_KEPT);
    expect(body.generations[0]!.generation).toBe(body.current - 1);
    expect(readdirSync(join(base, 'mcp')).filter((n) => /^registry\.json\.\d+$/.test(n))).toHaveLength(GENERATIONS_KEPT);
    expect((await call('GET', '/mcp/registry/generations', 'agent')).status).toBe(403);
  });

  it('codex r1 #1 / pi r1 C2: pruning that fails after the write committed never fails the write', async () => {
    expect((await save(SQL_BODY)).status).toBe(201);
    for (let i = 0; i < 3; i++) await registry.setServerEnabled('wh', true);
    // Generation 1 becomes something rm cannot remove; it is pruned (never kept again) once 11 more writes land.
    const g1 = join(base, 'mcp', 'registry.json.1');
    removeScratch(g1);
    mkdirSync(join(g1, 'held'), { recursive: true });
    for (let i = 0; i < 11; i++) await registry.setServerEnabled('wh', i % 2 === 0);
    expect(onDisk().generation).toBe(15);
    expect((await registry.get('wh')).enabled).toBe(true); // the last write (i = 10) landed
    expect(readdirSync(join(base, 'mcp'))).toContain('registry.json.1'); // the prune that failed is retried next time
    // codex r1 #12: a generation holding JSON null is unreadable (409), not a crash.
    writeFileSync(join(base, 'mcp', 'registry.json.14'), 'null');
    expect((await call('POST', '/mcp/registry/restore', 'human', { generation: 14 })).body.code).toBe('generation_unreadable');
  });

  it('NEGATIVE CONTROL: a restored generation comes back with "query" off, Allow writes off, and a server whose secret is gone disabled', async () => {
    expect((await save(SQL_BODY)).status).toBe(201);
    env['KD_GONE'] = 'kd-b1-gone-password';
    expect((await save({ ...SQL_BODY, name: 'wh-env', auth: { ref: 'env:KD_GONE' } })).status).toBe(201);
    expect((await save({ ...SQL_BODY, name: 'wh-kc', auth: { ref: 'keychain:wicked-mcp/wh-kc' }, secret: 'kd-b1-keychain-pass' })).status).toBe(201);
    // The person's switches as they stand in this generation: query on (B2's route sets it), Allow writes on.
    await store.mutate((file) => {
      for (const s of file.servers) s.agents = { see: true, query: true, projects: ['proj_1'], everyProject: false };
    });
    expect((await call('PUT', '/sources/wh/allow-writes', 'human', { allowed: true })).status).toBe(200);
    const kept = (await registry.generations()).current;
    expect((await call('PATCH', '/mcp/servers/wh', 'human', { enabled: true })).status).toBe(200); // one more write
    delete env['KD_GONE'];
    secrets.unreadable = true; // codex r1 #2: the entry is listed, its value cannot be read
    expect((await call('POST', '/mcp/registry/restore', 'agent', { generation: kept })).status).toBe(403);
    // codex r1 #10: a generation edited to judge its document for another runtime is checked too (passwordless
    // is native-only), and refused with nothing changed.
    const genPath = join(base, 'mcp', `registry.json.${kept}`);
    const original = readFileSync(genPath, 'utf8');
    const edited = JSON.parse(original) as McpRegistryFile;
    edited.servers[0]!.runtime = 'toolbox';
    delete (edited.servers[0]!.toolbox as { password?: string }).password;
    writeFileSync(genPath, JSON.stringify(edited));
    const before = readFileSync(join(base, 'mcp', 'registry.json'), 'utf8');
    expect((await call('POST', '/mcp/registry/restore', 'human', { generation: kept })).body.code).toBe('missing_field');
    expect(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')).toBe(before);
    writeFileSync(genPath, original);
    const r = await call('POST', '/mcp/registry/restore', 'human', { generation: kept });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ restored: kept, queryReset: ['wh', 'wh-env', 'wh-kc'], writesReset: ['wh'], disabled: [{ name: 'wh-env', code: 'secret_missing' }, { name: 'wh-kc', code: 'secret_missing' }] });
    expect(r.text).not.toContain('kd-b1-keychain-pass');
    const list = (await registry.list()).servers;
    expect(list.find((s) => s.name === 'wh')).toMatchObject({ enabled: true, allowWrites: false, agents: { see: true, query: false, projects: ['proj_1'] } });
    expect(list.find((s) => s.name === 'wh-env')).toMatchObject({ enabled: false, agents: { query: false } });
    expect(list.find((s) => s.name === 'wh-env')?.health.lastError).toMatch(/^secret_missing/);
    expect(list.find((s) => s.name === 'wh-kc')).toMatchObject({ enabled: false });
    for (const f of readdirSync(join(base, 'mcp'))) if (f.startsWith('registry.json')) expect(readFileSync(join(base, 'mcp', f), 'utf8')).not.toContain('kd-b1-keychain-pass');
    // The registry in force before the restore was kept, so the restore can be undone.
    expect((await registry.generations()).generations.some((x) => x.generation === kept + 1)).toBe(true);
    expect((await call('POST', '/mcp/registry/restore', 'human', { generation: 999 })).body.code).toBe('unknown_generation');
    writeFileSync(join(base, 'mcp', `registry.json.${kept}`), '{torn');
    const torn = await call('POST', '/mcp/registry/restore', 'human', { generation: kept });
    expect([torn.status, torn.body.code]).toEqual([409, 'generation_unreadable']);
  });
});

// ── Restore and approvals (codex r1 #3, #4, #5, #13; pi r1 C1, T1) ─────────────────────────────────

/** The approvals ledger's stand-in: the real per-server lock, the real token naming, a withdrawal that can fail. */
class StubPolicies {
  readonly tokens = new Set<string>();
  readonly withdrawCalls: string[][] = [];
  failWithdraw = false;
  gate: Promise<void> | null = null;
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Every lock asked for, in order. */
  readonly asked: string[] = [];
  exclusive<T>(server: string, fn: () => Promise<T>): Promise<T> {
    this.asked.push(server);
    const result = (this.tails.get(server) ?? Promise.resolve()).then(fn);
    this.tails.set(server, result.catch(() => undefined));
    return result;
  }
  async tokensOf(server: string): Promise<string[]> {
    return [...this.tokens].filter((t) => t === `mcp:${server}` || t.startsWith(`mcp:${server}/`));
  }
  async withdraw(tokens: readonly string[]): Promise<string[]> {
    this.withdrawCalls.push([...tokens]);
    if (this.gate !== null) await this.gate;
    if (this.failWithdraw) throw new Error('the ledger is down');
    for (const t of tokens) this.tokens.delete(t);
    return ['MCP-FIRST-USE'];
  }
  async withdrawnBySave(): Promise<string[]> {
    return [];
  }
  async previewUnsaved(): Promise<null> {
    return null;
  }
}

describe('a restore withdraws the approvals the restored generation does not cover, under every server lock', () => {
  let base: string;
  let app: FastifyInstance;
  let registry: McpRegistry;
  let policies: StubPolicies;
  let specPath: string;
  const tool = (name: string, props: string[]) => ({ name, description: name, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) }, annotations: { readOnlyHint: true } });
  const spec = (tools: Array<ReturnType<typeof tool>>): void => writeFileSync(specPath, JSON.stringify({ tools }));
  const fx = (name = 'fx') => ({ name, kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath] });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-b1-restore-'));
    specPath = join(base, 'spec.json');
    spec([tool('wt_echo', ['text'])]);
    registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'mcp')), secrets: new MemorySecrets(), probe: probeMcpServer, discover: () => [], env: {} });
    policies = new StubPolicies();
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    const actorOf = (req: { actor?: Actor | null }): Actor => req.actor ?? LOCAL_ACTOR;
    registerMcpRoutes(app, { registry, audit: new AuditLog(join(base, 'audit.log'), () => undefined), actorOf, policies: policies as unknown as McpPolicies });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    removeScratch(base);
  });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: 'Bearer human' }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & { code?: string }, text: res.body };
  };
  const save = async (config: Record<string, unknown>) => {
    const p = await call('POST', '/mcp/servers/preview', config);
    expect(p.status, p.text).toBe(200);
    const s = await call('POST', '/mcp/servers', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash });
    expect(s.status, s.text).toBe(201);
  };
  const current = async (): Promise<number> => (await registry.generations()).current;

  it('a changed schema, a tool saved only since (null hash then), and a server added since lose their approvals', async () => {
    await save(fx());
    spec([tool('wt_echo', ['text']), tool('wt_new', ['q'])]);
    expect((await call('POST', '/mcp/servers/fx/test')).status).toBe(200); // wt_new seen, never saved: schemaHash null
    const kept = await current();
    spec([tool('wt_echo', ['text', 'more']), tool('wt_new', ['q'])]);
    await save(fx()); // wt_echo's schema changed, wt_new saved
    await save(fx('fx2'));
    for (const t of ['mcp:fx', 'mcp:fx/wt_echo', 'mcp:fx/wt_new', 'mcp:fx2/wt_echo']) policies.tokens.add(t);
    const r = await call('POST', '/mcp/registry/restore', { generation: kept });
    expect(r.status, r.text).toBe(200);
    expect(r.body['withdrawnApprovals']).toEqual(['mcp:fx', 'mcp:fx/wt_echo', 'mcp:fx/wt_new', 'mcp:fx2/wt_echo']);
    expect([...policies.tokens]).toEqual([]);
    expect((await registry.list()).servers.map((s) => s.name)).toEqual(['fx']);
  });

  it('an approval for a tool the restored generation saved under the same schema survives', async () => {
    await save(fx());
    const kept = await current();
    await registry.setServerEnabled('fx', true);
    policies.tokens.add('mcp:fx/wt_echo');
    const r = await call('POST', '/mcp/registry/restore', { generation: kept });
    expect(r.body['withdrawnApprovals']).toEqual([]);
    expect([...policies.tokens]).toEqual(['mcp:fx/wt_echo']);
  });

  it('a refused generation withdraws nothing; a failed withdrawal restores nothing', async () => {
    await save(fx());
    const kept = await current();
    spec([tool('wt_echo', ['text', 'more'])]);
    await save(fx());
    policies.tokens.add('mcp:fx/wt_echo');
    writeFileSync(join(base, 'mcp', `registry.json.${kept}`), '{torn');
    expect((await call('POST', '/mcp/registry/restore', { generation: kept })).body.code).toBe('generation_unreadable');
    expect(policies.withdrawCalls).toEqual([]);
    await registry.setServerEnabled('fx', true);
    const kept2 = (await current()) - 1;
    spec([tool('wt_echo', ['text', 'more', 'again'])]);
    await save(fx());
    policies.failWithdraw = true;
    const before = readFileSync(join(base, 'mcp', 'registry.json'), 'utf8');
    const r = await call('POST', '/mcp/registry/restore', { generation: kept2 });
    expect([r.status, r.body.code]).toEqual([500, 'withdraw_failed']);
    expect(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')).toBe(before);
    expect([...policies.tokens]).toEqual(['mcp:fx/wt_echo']);
  });

  it('codex r2: a generation holding a record crew could not have written is refused before anything is withdrawn', async () => {
    await save(fx());
    const kept = await current();
    spec([tool('wt_echo', ['text', 'more'])]);
    await save(fx());
    policies.tokens.add('mcp:fx/wt_echo');
    const genPath = join(base, 'mcp', `registry.json.${kept}`);
    const edited = JSON.parse(readFileSync(genPath, 'utf8')) as { servers: Array<Record<string, unknown>> };
    delete edited.servers[0]!['auth'];
    writeFileSync(genPath, JSON.stringify(edited));
    const before = readFileSync(join(base, 'mcp', 'registry.json'), 'utf8');
    const r = await call('POST', '/mcp/registry/restore', { generation: kept });
    expect([r.status, r.body.code]).toEqual([409, 'generation_unreadable']);
    expect(policies.withdrawCalls).toEqual([]);
    expect([...policies.tokens]).toEqual(['mcp:fx/wt_echo']);
    expect(readFileSync(join(base, 'mcp', 'registry.json'), 'utf8')).toBe(before);
  });

  it('codex r2: a server registered while the restore waits for its locks is covered too (its approval is withdrawn)', async () => {
    await save(fx());
    const kept = await current();
    await registry.setServerEnabled('fx', true); // generation `kept` is now a kept file
    let release!: () => void;
    const holding = policies.exclusive('fx', () => new Promise<void>((resolve) => (release = resolve)));
    const restoring = call('POST', '/mcp/registry/restore', { generation: kept });
    while (policies.asked.filter((n) => n === 'fx').length < 2) await new Promise((r) => setTimeout(r, 5)); // it waits for fx's lock
    await save(fx('fx2')); // a new server, and its approval, while the restore waits
    policies.tokens.add('mcp:fx2/wt_echo');
    release();
    await holding;
    const r = await restoring;
    expect(r.status, r.text).toBe(200);
    expect(r.body['withdrawnApprovals']).toEqual(['mcp:fx2/wt_echo']);
    expect([...policies.tokens]).toEqual([]);
    expect((await registry.list()).servers.map((s) => s.name)).toEqual(['fx']);
    expect(policies.asked.filter((n) => n === 'fx2')).toHaveLength(2); // the save's, then the restore's second pass
  });

  it('codex r2: an approval naming a server that is not registered is withdrawn by the save that registers that name', async () => {
    policies.tokens.add('mcp:ghost/wt_echo');
    policies.tokens.add('mcp:ghost');
    await save(fx('ghost'));
    expect(policies.withdrawCalls.map((c) => [...c].sort())).toEqual([['mcp:ghost', 'mcp:ghost/wt_echo']]);
    expect([...policies.tokens]).toEqual([]);
  });

  it('an approval that arrives while a restore withdraws is judged against the registration the restore left', async () => {
    await save(fx());
    const kept = await current();
    const restoredHash = (await registry.get('fx')).tools[0]!.schemaHash;
    spec([tool('wt_echo', ['text', 'more'])]);
    await save(fx());
    policies.tokens.add('mcp:fx/wt_echo');
    let open!: () => void;
    policies.gate = new Promise<void>((resolve) => (open = resolve));
    const restoring = call('POST', '/mcp/registry/restore', { generation: kept });
    while (policies.withdrawCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
    // An approval of fx queued now (the approve route takes fx's lock the same way) waits for the commit.
    const seen = policies.exclusive('fx', async () => (await registry.get('fx')).tools[0]!.schemaHash);
    open();
    expect((await restoring).status).toBe(200);
    expect(await seen).toBe(restoredHash);
  });
});

// ── The executor regression on a real Postgres ───────────────────────────────────────────────────

const SUPPORT_SEED = `
CREATE SCHEMA support;
CREATE TYPE support.ticket_status AS ENUM ('open', 'pending', 'escalated', 'closed');
CREATE TABLE support.tickets (id int PRIMARY KEY, status support.ticket_status NOT NULL);
INSERT INTO support.tickets SELECT g, (ARRAY['open','pending','escalated','closed'])[1 + g % 4]::support.ticket_status FROM generate_series(1, 400) g;
GRANT USAGE ON SCHEMA support TO apps_reader;
GRANT SELECT ON support.tickets TO apps_reader;
`;
/** The rig apps' query texts, verbatim. */
const OPEN_TICKETS = "SELECT count(*)::int AS open FROM support.tickets WHERE status = 'open'";
const PENDING_TOTAL = "SELECT count(*)::int AS pending FROM support.tickets WHERE status = 'pending'";

if (PG_TARGETS.length === 0) {
  describe('the rig apps through the unchanged executor on a migrated entry', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the rig apps through the unchanged executor on a migrated entry (${target.label})`, () => {
    let db: FreshPg;
    let h: Harness;
    const legacy = (port: number, database: string): McpServerRecord =>
      k1Record({ auth: { ref: 'env:KD_SUPPORT_PG' }, sql: { driver: 'postgres', host: '127.0.0.1', port, database, user: 'apps_reader', tls: 'disable' }, address: { ...LOOPBACK, allow: [...LOOPBACK.allow] } });
    beforeAll(async () => {
      db = await freshPgDatabase(target);
      await db.admin.unsafe(SUPPORT_SEED);
      h = await appsHarness();
      h.env['KD_SUPPORT_PG'] = 'apps-reader';
      // The registry as the rig's crew left it: a K1 `sql` record, no id, no generation.
      mkdirSync(join(h.dir, 'mcp'), { recursive: true });
      writeFileSync(join(h.dir, 'mcp', 'registry.json'), JSON.stringify({ version: 1, servers: [legacy(db.port, db.database)] }));
    }, 60_000);
    afterAll(async () => {
      await h?.close();
      await db?.drop();
    });
    const queryOf = (id: string, out: string): AppQuery => ({ id, source: 'support-pg', kind: 'sql', output: [{ name: out, type: 'integer' }] });

    it('open_tickets (escalations) and pending_total (refund-approvals) lock to K1 hash and read, before and after the rewrite; a re-save is v2', async () => {
      const k1 = k1Hash(legacy(db.port, db.database) as unknown as { url: null; auth: { ref: string }; sql: Record<string, unknown>; address: unknown });
      // Describe (as the person's Test would): the first write after the upgrade, which persists the mapped entry.
      const d = await h.call('POST', '/sources/support-pg/describe', {});
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      expect(d.body['descriptorHash']).toBe(k1);
      const disk = JSON.parse(readFileSync(join(h.dir, 'mcp', 'registry.json'), 'utf8')) as McpRegistryFile;
      expect(disk.servers[0]).toMatchObject({ kind: 'toolbox-source', runtime: 'native', descriptorVersion: 1, id: expect.any(String) });
      expect(disk.servers[0]!.sql).toBeUndefined();
      for (const [slug, q, text, out] of [['escalations', 'open_tickets', OPEN_TICKETS, 'open'], ['refund-approvals', 'pending_total', PENDING_TOTAL, 'pending']] as const) {
        await h.newApp(slug);
        const landed = await h.land(slug, specWith([queryOf(q, out)]), { [q]: text });
        expect(landed.status, JSON.stringify(landed.body)).toBe(200);
        const lock = (landed.body.app as unknown as { lock: { sources: Record<string, { descriptorHash: string; kind: string }> } }).lock;
        expect(lock.sources['support-pg']).toMatchObject({ kind: 'sql', descriptorHash: k1 });
        const version = (landed.body.app as unknown as { head: { version: number } }).head.version;
        const r = await h.call('POST', `/apps/${slug}/query`, { version, query: q });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect((r.body as unknown as AppQueryResponse).rows).toEqual([[100]]);
      }
      // Another write (the entry is already in its new form): the locks still verify.
      await h.registry.setServerEnabled('support-pg', true);
      for (const [slug, q] of [['escalations', 'open_tickets'], ['refund-approvals', 'pending_total']] as const) {
        const version = (await h.store.detail(slug)).head.version;
        const r = await h.call('POST', `/apps/${slug}/query`, { version, query: q });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      // A person's re-save, with the SAME settings, writes descriptor version 2 (§5.4): a descriptor change, so the
      // old pins no longer hold (the design's stated cost of a re-save).
      const p = await h.call('POST', '/mcp/servers/preview', { name: 'support-pg', kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: db.port, database: db.database, user: 'apps_reader', tls: 'disable' }, auth: { ref: 'env:KD_SUPPORT_PG' }, address: LOOPBACK });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect((await h.call('POST', '/mcp/servers', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash })).status).toBe(201);
      expect((await h.registry.source('support-pg')).config.entry?.descriptorVersion).toBe(2);
      expect((await h.registry.source('support-pg')).descriptorHash).not.toBe(k1);
      const version = (await h.store.detail('escalations')).head.version;
      const after = await h.call('POST', '/apps/escalations/query', { version, query: 'open_tickets' });
      expect(after.status).toBe(409);
    }, 60_000);
  });
}
