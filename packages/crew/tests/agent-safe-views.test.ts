// DES-KNOWLEDGE-DATA-001 §5.2: the agent-safe view outside the registry's own reads.
// - crew#1316: a non-human preview cannot name a secret crew already holds (another entry's keychain secret, an
//   `env:` variable), so it cannot have crew send that secret to a host it chose. The prober is never called.
// - crew#1317: a non-human reader of `GET /audit` gets the MCP and source lines without their connection data, and
//   of `GET /apps/:app` gets the lock's sources as `{kind, descriptorHash}` and no query text. Humans read both whole.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { agentAuditKeys, auditEntryFor, auditFor } from '../src/api/audit-view.js';
import { LOCAL_ACTOR, registerAuthHooks, tokenHash } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import { createServer } from '../src/api/server.js';
import { appDetailFor } from '../src/apps/views.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor, AppDetail, AppQuery, AuditEntry, AuditPage, McpPreviewResponse } from '../src/core/types.js';
import type { McpUpstreamConfig, Prober } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { startMcpServer } from './fixtures/apps-sources/servers.mjs';
import { removeScratch } from './setup/scratch.js';
import { appsHarness, type Harness, specWith } from './support/apps-harness.js';

const HUMAN: Actor = { id: 'priya', kind: 'human', trust: 'operator' };
const AGENT: Actor = { id: 'seat-codex', kind: 'agent', trust: 'operator' };
const PLUGIN: Actor = { id: 'plugin:x@1.0.0', kind: 'plugin', trust: 'observer' };
const SYSTEM: Actor = { id: 'ci', kind: 'system', trust: 'admin' };
const TOKENS: Record<string, Actor> = { human: HUMAN, agent: AGENT, system: SYSTEM };

class MemorySecrets implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  async get(a: string) {
    return this.values.get(a) ?? null;
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

const VICTIM_SECRET = 'victim-stored-secret-7f3a';
const ENV_SECRET = 'daemon-env-secret-91c2';
/** A host the caller chose (TEST-NET-3): the prober is faked, so nothing dials it. */
const CHOSEN = 'https://203.0.113.7/mcp';

describe('crew#1316: a non-human preview cannot name a secret crew already holds', () => {
  let base: string;
  let app: FastifyInstance;
  let secrets: MemorySecrets;
  let probed: Array<{ config: McpUpstreamConfig; secret: string | null }>;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'kd-sec-views-preview-'));
    secrets = new MemorySecrets();
    probed = [];
    const probe: Prober = async (config, secret) => {
      probed.push({ config, secret });
      return { ok: true, serverInfo: null, tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' }, outputSchema: null, annotations: { readOnlyHint: true } }] };
    };
    const registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'mcp')), secrets, probe, discover: () => [], env: { KD_DAEMON_TOKEN: ENV_SECRET } });
    app = Fastify({ logger: false });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    const actorOf = (req: { actor?: Actor | null }): Actor => req.actor ?? LOCAL_ACTOR;
    registerMcpRoutes(app, { registry, audit: new AuditLog(join(base, 'audit.log'), () => undefined), actorOf });
    await app.ready();
    // A person registered `victim`, its secret staged with the preview and stored in the keychain.
    const p = await call('POST', '/mcp/servers/preview', 'human', { name: 'victim', kind: 'mcp-http', url: 'https://victim.example/mcp', auth: { ref: 'keychain:wicked-mcp/victim', header: 'Authorization' }, secret: VICTIM_SECRET });
    expect(p.status, p.text).toBe(200);
    const s = await call('POST', '/mcp/servers', 'human', { previewHash: (p.body as unknown as McpPreviewResponse).previewHash });
    expect(s.status, s.text).toBe(201);
    expect(secrets.values.get('victim')).toBe(VICTIM_SECRET);
    probed = [];
  });
  afterEach(async () => {
    await app.close();
    removeScratch(base);
  });

  const call = async (method: 'GET' | 'POST', url: string, as: keyof typeof TOKENS, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${as}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> & { code?: string }, text: res.body };
  };

  it("NEGATIVE CONTROL: another entry's keychain ref and an env: ref, against a chosen host, are 403 for an agent bearer; the prober is never called", async () => {
    const bodies = [
      { name: 'mine', kind: 'mcp-http', url: CHOSEN, auth: { ref: 'keychain:wicked-mcp/victim', header: 'Authorization' } },
      { name: 'mine', kind: 'mcp-http', url: CHOSEN, auth: { ref: 'env:KD_DAEMON_TOKEN', header: 'Authorization' } },
      // The entry's own name, re-pointed: its saved secret would go to the chosen host just the same.
      { name: 'victim', kind: 'mcp-http', url: CHOSEN, auth: { ref: 'keychain:wicked-mcp/victim', header: 'Authorization' } },
      // A keychain entry that holds nothing is refused the same way (no oracle for which entries exist).
      { name: 'mine', kind: 'mcp-http', url: CHOSEN, auth: { ref: 'keychain:wicked-mcp/nobody', header: 'Authorization' } },
    ];
    for (const as of ['agent', 'system'] as const) {
      for (const body of bodies) {
        const r = await call('POST', '/mcp/servers/preview', as, body);
        expect([r.status, r.body.code], `${as} ${JSON.stringify(body)}`).toEqual([403, 'stored_secret_human_only']);
        expect(r.text).not.toContain(VICTIM_SECRET);
        expect(r.text).not.toContain(ENV_SECRET);
      }
    }
    expect(probed).toEqual([]);
  });

  it('an agent that stages its own secret still previews; the probe gets only the staged value', async () => {
    const r = await call('POST', '/mcp/servers/preview', 'agent', { name: 'mine', kind: 'mcp-http', url: CHOSEN, auth: { ref: 'keychain:wicked-mcp/mine', header: 'Authorization' }, secret: 'agent-own-value-1' });
    expect(r.status, r.text).toBe(200);
    expect(probed.map((p) => p.secret)).toEqual(['agent-own-value-1']);
    // A staged secret under another entry's reference is still the registry's 400, before any probe.
    const other = await call('POST', '/mcp/servers/preview', 'agent', { name: 'mine', kind: 'mcp-http', url: CHOSEN, auth: { ref: 'keychain:wicked-mcp/victim', header: 'Authorization' }, secret: 'agent-own-value-1' });
    expect([other.status, other.body.code]).toEqual([400, 'secret_not_staged_here']);
    expect(probed).toHaveLength(1);
    // An unauthenticated preview is unchanged.
    expect((await call('POST', '/mcp/servers/preview', 'agent', { name: 'open', kind: 'mcp-http', url: CHOSEN })).status).toBe(200);
  });

  it('REGRESSION: a human preview with a staged secret, a stored keychain ref or an env: ref still works', async () => {
    const staged = await call('POST', '/mcp/servers/preview', 'human', { name: 'fresh', kind: 'mcp-http', url: 'https://fresh.example/mcp', auth: { ref: 'keychain:wicked-mcp/fresh', header: 'Authorization' }, secret: 'human-staged-1' });
    expect(staged.status, staged.text).toBe(200);
    const stored = await call('POST', '/mcp/servers/preview', 'human', { name: 'victim', kind: 'mcp-http', url: 'https://victim.example/mcp', auth: { ref: 'keychain:wicked-mcp/victim', header: 'Authorization' } });
    expect(stored.status, stored.text).toBe(200);
    const env = await call('POST', '/mcp/servers/preview', 'human', { name: 'envy', kind: 'mcp-http', url: 'https://envy.example/mcp', auth: { ref: 'env:KD_DAEMON_TOKEN', header: 'Authorization' } });
    expect(env.status, env.text).toBe(200);
    expect(probed.map((p) => p.secret)).toEqual(['human-staged-1', VICTIM_SECRET, ENV_SECRET]);
  });
});

// ── crew#1317: GET /audit ──────────────────────────────────────────────────────────────────────────────────────────

/** The MCP and source lines as their emitters write them (api/mcp.ts, sources/routes.ts), plus lines outside them. */
const SOURCE_LINES: AuditEntry[] = [
  { ts: 1_000, action: 'mcp.server.saved', actor: HUMAN, detail: { name: 'wh', kind: 'sql', tools: 2, authRef: 'keychain:wicked-mcp/wh', disabledWrites: ['mcp:wh/del'] } },
  { ts: 1_001, action: 'mcp.server.address_confirmed', actor: HUMAN, detail: { name: 'wh', kind: 'sql', allow: ['10.20.0.0/16'], plaintext: true } },
  { ts: 1_002, action: 'mcp.server.egress_confirmed', actor: HUMAN, detail: { name: 'tickets', origin: 'https://tickets.corp.test', basePath: '/api/v3', matches: false, privateAddress: true, resolved: ['10.9.8.7'], servers: ['https://tickets.corp.test/api/v3'] } },
  { ts: 1_003, action: 'mcp.secret.set', actor: HUMAN, detail: { name: 'wh', ref: 'env:WH_PASSWORD' } },
  { ts: 1_004, action: 'apps.source.test_call', actor: HUMAN, detail: { source: 'tickets', summary: 'GET https://tickets.corp.test/api/v3/tickets?page=1', ok: true, status: 200 } },
  { ts: 1_005, action: 'apps.source.queried', actor: HUMAN, detail: { source: 'wh', ok: true, relations: ['finance.payroll'], rows: 3, truncated: false, ms: 12 } },
  // A line of these families with no allowlist entry keeps only its identity (a later field stays hidden).
  { ts: 1_006, action: 'knowledge.source.future_line', actor: HUMAN, detail: { source: 'wh', host: 'pg.corp.test', projects: ['p1'] } },
  { ts: 1_007, action: 'mcp.tool.write_granted', actor: HUMAN, detail: { subject: 'mcp:wh/del', class: 'destructive', via: 'save' } },
];
const OTHER_LINES: AuditEntry[] = [{ ts: 2_000, action: 'run.launched', actor: HUMAN, runId: 'r1', detail: { workflow: 'feature', repo: '/repos/x' } }];
const LEAKS = ['authRef', 'keychain:wicked-mcp/wh', 'env:WH_PASSWORD', '10.20.0.0/16', 'tickets.corp.test', '/api/v3', '10.9.8.7', 'finance.payroll', 'pg.corp.test', 'plaintext'];

describe('crew#1317: a non-human GET /audit reads the MCP and source lines without connection data', () => {
  let scratch: string;
  let auditPath: string;
  let app: FastifyInstance;
  let savedLogLevel: string | undefined;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'kd-sec-views-audit-'));
    auditPath = join(scratch, 'audit.log');
    writeFileSync(auditPath, [...SOURCE_LINES, ...OTHER_LINES].map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const tokens = join(scratch, 'tokens.json');
    writeFileSync(tokens, JSON.stringify({
      tokens: [
        { sha256: tokenHash('human-token'), actor: HUMAN },
        { sha256: tokenHash('agent-token'), actor: AGENT },
      ],
    }));
    savedLogLevel = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'error';
    const adapter = { stub: true, projectsSupported: () => false, getSettings: async () => ({}), onLaunch: (): (() => void) => () => undefined, onEvent: () => () => {} } as unknown as CoreAdapter;
    app = await createServer(adapter, {
      auth: { mode: 'required', tokensPath: tokens },
      auditPath,
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      studioRoot: join(scratch, 'no-studio'),
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
    else process.env['LOG_LEVEL'] = savedLogLevel;
    removeScratch(scratch);
  });

  const read = async (token: string): Promise<{ status: number; page: AuditPage; text: string }> => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=100', headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, page: res.json() as AuditPage, text: res.body };
  };

  it('NEGATIVE CONTROL: an agent bearer sees no authRef, ranges, origin, base path, resolved address, URL or relations', async () => {
    const { status, page, text } = await read('agent-token');
    expect(status).toBe(200);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
    const by = (action: string) => page.entries.find((e) => e.action === action)?.detail;
    // What happened, and to what, still reads.
    expect(by('mcp.server.saved')).toEqual({ name: 'wh', kind: 'sql', tools: 2, disabledWrites: ['mcp:wh/del'] });
    expect(by('mcp.server.address_confirmed')).toEqual({ name: 'wh', kind: 'sql' });
    expect(by('mcp.server.egress_confirmed')).toEqual({ name: 'tickets' });
    expect(by('mcp.secret.set')).toEqual({ name: 'wh' });
    expect(by('apps.source.test_call')).toEqual({ source: 'tickets', ok: true, status: 200 });
    expect(by('apps.source.queried')).toEqual({ source: 'wh', ok: true, rows: 3, truncated: false, ms: 12 });
    expect(by('knowledge.source.future_line')).toEqual({ source: 'wh' });
    expect(by('mcp.tool.write_granted')).toEqual({ subject: 'mcp:wh/del', class: 'destructive', via: 'save' });
    // A line outside those families is unchanged.
    expect(page.entries.find((e) => e.action === 'run.launched')).toEqual(OTHER_LINES[0]);
  });

  it('REGRESSION: a human bearer reads every line whole, and the trail on disk is unchanged', async () => {
    const { page } = await read('human-token');
    expect(page.entries).toEqual([...SOURCE_LINES, ...OTHER_LINES].reverse());
    expect(readFileSync(auditPath, 'utf8')).toBe([...SOURCE_LINES, ...OTHER_LINES].map((e) => JSON.stringify(e)).join('\n') + '\n');
  });

  it('the projection: every non-human kind gets it, a human never does; lines outside the families keep their detail', () => {
    for (const actor of [AGENT, PLUGIN, SYSTEM, null]) {
      expect(JSON.stringify(auditFor(actor, SOURCE_LINES))).not.toContain('authRef');
    }
    expect(auditFor(HUMAN, SOURCE_LINES)).toEqual(SOURCE_LINES);
    expect(auditEntryFor(AGENT, OTHER_LINES[0]!)).toBe(OTHER_LINES[0]);
    expect(agentAuditKeys('run.launched')).toBeNull();
    expect(agentAuditKeys('mcp.something_new')).toEqual(['name', 'source', 'subject', 'subjects']);
  });

  it("the lines crew's own MCP routes write, read back through the projection, hold no connection data", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kd-sec-views-emit-'));
    try {
      const secrets = new MemorySecrets();
      const probe: Prober = async () => ({ ok: true, serverInfo: null, tools: [] });
      const registry = new McpRegistry({ store: new McpRegistryStore(join(dir, 'mcp')), secrets, probe, discover: () => [], env: {} });
      const audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
      const a = Fastify({ logger: false });
      registerAuthHooks(a, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
      registerMcpRoutes(a, { registry, audit, actorOf: (req: { actor?: Actor | null }) => req.actor ?? LOCAL_ACTOR });
      await a.ready();
      const inject = (url: string, payload: object) => a.inject({ method: 'POST', url: `/api/v1${url}`, headers: { authorization: 'Bearer human' }, payload });
      const p = await inject('/mcp/servers/preview', { name: 'pg-wh', kind: 'mcp-http', url: 'https://10.20.30.40/mcp', address: { allow: ['10.20.0.0/16'] }, auth: { ref: 'keychain:wicked-mcp/pg-wh', header: 'Authorization' }, secret: 'emit-secret-1' });
      expect(p.statusCode, p.body).toBe(200);
      expect((await inject('/mcp/servers', { previewHash: (p.json() as McpPreviewResponse).previewHash })).statusCode).toBe(201);
      await audit.flush();
      const written = await audit.read();
      expect(JSON.stringify(written)).toContain('keychain:wicked-mcp/pg-wh');
      const seen = JSON.stringify(auditFor(AGENT, written));
      for (const leak of ['keychain:wicked-mcp/pg-wh', '10.20.0.0/16', '10.20.30.40', 'authRef']) expect(seen, leak).not.toContain(leak);
      await a.close();
    } finally {
      removeScratch(dir);
    }
  });
});

// ── crew#1317: GET /apps/:app ──────────────────────────────────────────────────────────────────────────────────────

type Fixture = { origin: string; hits: unknown[]; close: () => Promise<void> };

describe('crew#1317: a non-human GET /apps/:app reads the lock without source descriptors and no query text', () => {
  let h: Harness;
  let mcp: Fixture;
  const listQuery: AppQuery = { id: 'list_mcp', source: 'ref', kind: 'mcp', rowPath: '$.data.items[*]', output: [{ name: 'id', type: 'integer' }] };
  const QUERY_TEXT = JSON.stringify({ tool: 'list_tickets', args: {} });

  beforeAll(async () => {
    mcp = (await startMcpServer()) as Fixture;
    h = await appsHarness();
    await h.register({ name: 'ref', kind: 'mcp-http', url: `${mcp.origin}/mcp`, address: { allow: ['127.0.0.0/8'] } });
    await h.newApp('desk');
    const landed = await h.land('desk', specWith([listQuery]), { list_mcp: QUERY_TEXT });
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    await mcp?.close();
  });

  it('NEGATIVE CONTROL: an agent bearer gets {kind, descriptorHash} per source, no descriptor host and no queryText', async () => {
    const full = await h.store.detail('desk');
    const host = new URL(mcp.origin).host;
    expect(JSON.stringify(full.lock.sources['ref']?.descriptor)).toContain(host);
    const r = await h.call('GET', '/apps/desk', undefined, 'seat');
    expect(r.status).toBe(200);
    const app = (r.body as { app: Record<string, unknown> & { lock: AppDetail['lock'] } }).app;
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(host);
    expect(text).not.toContain('list_tickets');
    expect(app).not.toHaveProperty('queryText');
    expect(app.lock.sources).toEqual({ ref: { kind: 'mcp-http', descriptorHash: full.lock.sources['ref']!.descriptorHash } });
    // The rest of the detail (spec, versions, the lock's query and action pins) is the same as a person's.
    expect(app.lock.queries).toEqual(full.lock.queries);
    expect(app['spec']).toEqual(full.spec);
    expect(app['versions']).toEqual(full.versions);
  });

  it("REGRESSION: studio's app viewers (human bearers, operator or observer) get the full lock and the query text", async () => {
    const full = await h.store.detail('desk');
    for (const as of ['priya', 'olga'] as const) {
      const r = await h.call('GET', '/apps/desk', undefined, as);
      expect(r.status).toBe(200);
      expect((r.body as { app: AppDetail }).app).toEqual(full);
      expect((r.body as { app: AppDetail }).app.queryText).toEqual({ list_mcp: QUERY_TEXT });
    }
  });

  it('the projection helper: a human detail is returned as is; any other kind gets the reduced lock', async () => {
    const full = await h.store.detail('desk');
    expect(appDetailFor(HUMAN, full)).toBe(full);
    for (const actor of [AGENT, PLUGIN, SYSTEM, null]) {
      const v = appDetailFor(actor, full) as Record<string, unknown>;
      expect(v).not.toHaveProperty('queryText');
      expect(JSON.stringify(v)).not.toContain('"descriptor"');
    }
  });
});
