// DES-MCP-TOOLS-001 slice S2 — the MCP tools registry and its `/api/v1/mcp/*` routes.
//
// The slice's proving tests:
//   1. a secret never appears in a response, a log, the audit trail or any file crew writes;
//   2. a save without a previewHash (or with one this daemon did not issue, or an expired one) is a 409;
//   3. a changed schema puts the tool back to unregistered (and an added tool is unregistered, a
//      dropped one `gone`), until it is previewed and saved again.
// Real stdio and HTTP MCP servers answer the probes (tests/fixtures/mcp/fixture-server.mjs and an
// in-test streamable HTTP server); the OS keychain is replaced by an in-memory store.

import Fastify, { type FastifyInstance } from 'fastify';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Server as McpServerImpl } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpPreviewResponse, McpServer, McpServersResponse, McpServerTestResponse, McpTool } from '../src/core/types.js';
import { deriveToolClass, parseMcpSubject } from '../src/mcp/classify.js';
import { codexServerNames, discoverMcpServers } from '../src/mcp/discovery.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry, PREVIEW_TTL_MS } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { SECRET_REDACTION, scrubSecrets, type SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');

/** The OS keychain's stand-in: a test never touches a real one. */
class MemorySecretStore implements SecretStore {
  readonly available = true;
  readonly values = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

interface Tools {
  tools: Array<Record<string, unknown>>;
  serverName?: string;
  crash?: boolean;
}

const BASE_TOOLS: Tools['tools'] = [
  { name: 'wt_echo', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name: 'wt_note', description: 'write a note', inputSchema: { type: 'object', properties: { note: { type: 'string' } } }, annotations: { destructiveHint: true } },
  { name: 'wt_plain', description: 'no annotations', inputSchema: { type: 'object' } },
];

let base: string;
let specPath: string;
let secrets: MemorySecretStore;
let logs: string[];
let answered: string[];
let app: FastifyInstance;
let audit: AuditLog;
let clock: number;
let registry: McpRegistry;

function writeSpec(spec: Tools): void {
  writeFileSync(specPath, JSON.stringify(spec));
}

function stdioConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], ...extra };
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, raw?: string) {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    ...(raw !== undefined ? { payload: raw, headers: { 'content-type': 'application/json' } } : payload !== undefined ? { payload: payload as object } : {}),
  });
  answered.push(res.body);
  return res;
}

async function previewAndSave(config: Record<string, unknown> = stdioConfig()): Promise<McpServer> {
  const preview = await call('POST', '/mcp/servers/preview', config);
  expect(preview.statusCode, preview.body).toBe(200);
  const saved = await call('POST', '/mcp/servers', { previewHash: (preview.json() as McpPreviewResponse).previewHash });
  expect(saved.statusCode, saved.body).toBe(201);
  return saved.json() as McpServer;
}

function toolOf(server: McpServer, name: string): McpTool {
  const t = server.tools.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name} in ${JSON.stringify(server.tools.map((x) => x.name))}`);
  return t;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-registry-'));
  specPath = join(base, 'spec.json');
  writeSpec({ tools: BASE_TOOLS });
  secrets = new MemorySecretStore();
  logs = [];
  answered = [];
  clock = Date.parse('2026-09-28T12:00:00Z');
  audit = new AuditLog(join(base, 'audit.log'), (m) => logs.push(m));
  registry = new McpRegistry({
    store: new McpRegistryStore(join(base, 'state', 'mcp')),
    secrets,
    probe: probeMcpServer,
    discover: () => [],
    now: () => clock,
  });
  // Every log line fastify writes, at every level, is kept for the leak scan.
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logs.push(chunk.toString('utf8'));
      done();
    },
  });
  app = Fastify({ logger: { level: 'trace', stream } });
  registerMcpRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env['WICKED_PROBE_LEAK'];
  removeScratch(base);
});

describe('a secret never leaves the broker (D-2)', () => {
  it('stdio: the secret reaches the upstream, and no response, log, audit entry or file carries it', async () => {
    const secret = `wkd-sentinel-${randomUUID()}`;
    process.env['WICKED_PROBE_LEAK'] = 'leaky';
    writeSpec({
      serverName: 'fixture ${TOKEN}',
      tools: [...BASE_TOOLS, { name: 'wt_echo_secret', description: 'token is ${TOKEN}; daemon env ${LEAK}', inputSchema: { type: 'object', default: '${TOKEN}' } }],
    });

    // (crew#719) The value rides the PREVIEW and is committed by the save: nothing is in the OS
    // store until the registry row lands, so the pair can no longer half-write.
    const auth = { ref: 'keychain:wicked-mcp/fx', env: 'FIXTURE_TOKEN' };
    const preview = await call('POST', '/mcp/servers/preview', stdioConfig({ auth, secret }));
    expect(preview.statusCode, preview.body).toBe(200);
    expect(secrets.values.has('fx'), 'a preview writes no secret').toBe(false);
    const echoed = (preview.json() as McpPreviewResponse).tools.find((t) => t.name === 'wt_echo_secret');
    // The upstream got the secret (it echoed it), the probe scrubbed it, and the daemon's own env
    // did not reach the upstream (the hardened env).
    expect(echoed?.description).toBe(`token is ${SECRET_REDACTION}; daemon env absent`);
    expect((preview.json() as McpPreviewResponse).serverInfo?.name).toBe(`fixture ${SECRET_REDACTION}`);

    const saved = await call('POST', '/mcp/servers', { previewHash: (preview.json() as McpPreviewResponse).previewHash });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(secrets.values.get('fx'), 'the save commits the staged secret').toBe(secret);
    expect((saved.json() as McpServer).authState).toBe('set');

    // A re-key of the registered server: a malformed body is answered without any of it.
    const malformed = await call('PUT', '/mcp/servers/fx/secret', undefined, `{"value": "${secret}`);
    expect(malformed.statusCode).toBe(400);
    const put = await call('PUT', '/mcp/servers/fx/secret', { value: secret });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ ref: 'keychain:wicked-mcp/fx', set: true });
    expect(secrets.values.get('fx')).toBe(secret);

    expect((await call('POST', '/mcp/servers/fx/test')).json()).toMatchObject({ ok: true });
    const listed = (await call('GET', '/mcp/servers')).json() as McpServersResponse;
    expect(listed.servers[0]?.auth).toEqual(auth);

    // A failing upstream prints the secret to stderr; the error that comes back is scrubbed.
    writeSpec({ tools: [], crash: true });
    const failed = (await call('POST', '/mcp/servers/fx/test')).json() as McpServerTestResponse;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain(`token=${SECRET_REDACTION}`);
    const failedPreview = await call('POST', '/mcp/servers/preview', stdioConfig({ auth }));
    expect(failedPreview.statusCode).toBe(502);
    expect(failedPreview.body).toContain(SECRET_REDACTION);

    await audit.flush();
    expect(answered.length).toBeGreaterThan(5);
    for (const body of answered) expect(body).not.toContain(secret);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(secret);
    const written = filesUnder(base).filter((f) => f !== specPath);
    expect(written).toContain(join(base, 'state', 'mcp', 'registry.json'));
    expect(written).toContain(join(base, 'audit.log'));
    for (const file of written) expect(readFileSync(file, 'utf8'), file).not.toContain(secret);
  });

  it('http: the secret goes out in the configured header only, and never comes back', async () => {
    const secret = `wkd-sentinel-${randomUUID()}`;
    const seen: Array<string | undefined> = [];
    const upstream = await startHttpUpstream(seen, secret);
    try {
      const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
      const saved = await previewAndSave({ name: 'web', kind: 'mcp-http', url, secret, auth: { ref: 'keychain:wicked-mcp/web', header: 'Authorization', prefix: 'Bearer ' } });
      expect(saved.authState).toBe('set');
      expect(secrets.values.get('web')).toBe(secret);
      expect(toolOf(saved, 'web_lookup').description).toBe(`authorized as ${SECRET_REDACTION}`);
      expect(seen.length).toBeGreaterThan(0);
      for (const h of seen) expect(h).toBe(`Bearer ${secret}`);
      for (const body of answered) expect(body).not.toContain(secret);
      for (const line of logs) expect(line).not.toContain(secret);
    } finally {
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  });

  it('an unset secret fails closed: no unauthenticated probe; an env: reference resolves from the daemon env', async () => {
    const auth = { ref: 'env:WKD_TEST_MCP_TOKEN', env: 'FIXTURE_TOKEN' };
    writeSpec({ tools: [{ name: 'wt_whoami', description: 'token=${TOKEN}', inputSchema: { type: 'object' } }] });
    const refused = await call('POST', '/mcp/servers/preview', stdioConfig({ auth }));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'secret_missing' });

    process.env['WKD_TEST_MCP_TOKEN'] = 'wkd-env-secret-value';
    try {
      const saved = await previewAndSave(stdioConfig({ auth }));
      expect(saved.authState).toBe('set');
      expect(toolOf(saved, 'wt_whoami').description).toBe(`token=${SECRET_REDACTION}`);
    } finally {
      delete process.env['WKD_TEST_MCP_TOKEN'];
    }
    // Unset again: the listing says so, and a test probe fails without connecting.
    expect(((await call('GET', '/mcp/servers')).json() as McpServersResponse).servers[0]?.authState).toBe('missing');
    const tested = (await call('POST', '/mcp/servers/fx/test')).json() as McpServerTestResponse;
    expect(tested.ok).toBe(false);
    expect(tested.error).toContain('resolves to no secret');
  });

  it('the secret route refuses a short or multi-line value and a bad name', async () => {
    expect((await call('PUT', '/mcp/servers/fx/secret', { value: 'short' })).statusCode).toBe(400);
    expect((await call('PUT', '/mcp/servers/fx/secret', { value: 'two\nlines-here' })).statusCode).toBe(400);
    expect((await call('PUT', '/mcp/servers/Bad%20Name/secret', { value: 'long-enough-value' })).statusCode).toBe(400);
    // A value inside its own reference would be echoed by the answer and the audit entry.
    const inRef = await call('PUT', '/mcp/servers/abc12345/secret', { value: 'abc12345' });
    expect(inRef.statusCode).toBe(400);
    expect(inRef.json()).toMatchObject({ code: 'secret_in_ref' });
    expect(secrets.values.size).toBe(0);
  });

  // crew#719: the secret and the registry row commit TOGETHER.
  //
  // Studio used to write the keychain itself (`PUT /mcp/servers/:name/secret`) and then save the
  // server, because `preview` refuses to probe an authenticated upstream without a secret. A
  // failure between the two writes left either a keychain entry with no server — invisible,
  // because a keychain service's entries cannot be enumerated — or a server whose secret never
  // landed. The value is now STAGED with the preview and written inside the save.
  it('a failed save takes the staged secret back out, and a re-key needs a server that references it', async () => {
    const secret = `wkd-sentinel-${randomUUID()}`;
    const auth = { ref: 'keychain:wicked-mcp/fx', env: 'FIXTURE_TOKEN' };

    // 1. A staged secret must belong to THIS server's own keychain entry: an `env:` reference is
    //    read from the daemon's environment, and an unauthenticated server has nowhere to put it.
    for (const bad of [{ auth: { ref: 'env:WKD_TEST_MCP_TOKEN', env: 'FIXTURE_TOKEN' } }, { auth: null }]) {
      const refused = await call('POST', '/mcp/servers/preview', stdioConfig({ ...bad, secret }));
      expect(refused.statusCode, refused.body).toBe(400);
      expect(refused.json()).toMatchObject({ code: 'secret_not_staged_here' });
    }
    expect(secrets.values.size, 'a refused preview writes nothing').toBe(0);

    // 2. A save whose REGISTRY write fails leaves no keychain entry behind.
    const failing = new McpRegistry({
      store: {
        read: async () => ({ version: 1, servers: [] }),
        mutate: async () => {
          throw new Error('registry.json could not be written');
        },
      } as unknown as McpRegistryStore,
      secrets,
      probe: probeMcpServer,
      discover: () => [],
      now: () => clock,
    });
    const held = await failing.preview({ name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], url: null, auth }, secret);
    expect(secrets.values.has('fx'), 'the preview stages, it does not write').toBe(false);
    await expect(failing.save(held.previewHash)).rejects.toThrow(/registry.json could not be written/);
    expect(secrets.values.has('fx'), 'a failed save leaves no orphan secret').toBe(false);

    // 2b. (review of PR #724, HIGH) A RE-KEY staged through the preview, whose registry write then
    //     fails, puts the PRIOR value back. Leaving the new one behind under an unchanged row would
    //     silently change the credential the server's running calls use — worse than the orphan
    //     this whole change exists to prevent.
    secrets.values.set('fx', 'the-live-secret-value');
    const rekey = await failing.preview({ name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, specPath], url: null, auth }, secret);
    await expect(failing.save(rekey.previewHash)).rejects.toThrow(/registry.json could not be written/);
    expect(secrets.values.get('fx'), 'the live credential is untouched by a failed save').toBe('the-live-secret-value');
    secrets.values.delete('fx');

    // 3. A re-key for a name no registered server references is refused, and writes nothing —
    //    that write was the first half of the non-atomic add.
    const orphan = await call('PUT', '/mcp/servers/nosuch/secret', { value: secret });
    expect(orphan.statusCode, orphan.body).toBe(404);
    expect(orphan.json()).toMatchObject({ code: 'unknown_server' });
    expect(secrets.values.size).toBe(0);

    // 4. …and refused for a REGISTERED server whose auth.ref points somewhere else, where the
    //    value would sit unreachable.
    process.env['WKD_TEST_MCP_TOKEN'] = 'wkd-env-secret-value';
    try {
      writeSpec({ tools: BASE_TOOLS });
      await previewAndSave(stdioConfig({ auth: { ref: 'env:WKD_TEST_MCP_TOKEN', env: 'FIXTURE_TOKEN' } }));
    } finally {
      delete process.env['WKD_TEST_MCP_TOKEN'];
    }
    const elsewhere = await call('PUT', '/mcp/servers/fx/secret', { value: secret });
    expect(elsewhere.statusCode, elsewhere.body).toBe(400);
    expect(elsewhere.json()).toMatchObject({ code: 'secret_not_referenced' });
    expect(secrets.values.size).toBe(0);

    for (const body of answered) expect(body).not.toContain(secret);
    for (const line of logs) expect(line).not.toContain(secret);
  });

  it('scrubSecrets replaces every occurrence, in keys too, longest secret first', () => {
    expect(scrubSecrets({ 'k-abcdefgh': ['x abcdefgh y', 'abcdefgh-longer'] }, ['abcdefgh', 'abcdefgh-longer'])).toEqual({
      [`k-${SECRET_REDACTION}`]: [`x ${SECRET_REDACTION} y`, SECRET_REDACTION],
    });
  });
});

describe('a save is bound to a preview', () => {
  it('no previewHash, an unknown one, an expired one, or a reused one is a 409; a fresh one saves', async () => {
    const none = await call('POST', '/mcp/servers', {});
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'preview_required' });
    expect((await call('POST', '/mcp/servers')).statusCode).toBe(409);
    const unknown = await call('POST', '/mcp/servers', { previewHash: 'f'.repeat(64) });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ code: 'preview_stale' });

    const first = (await call('POST', '/mcp/servers/preview', stdioConfig())).json() as McpPreviewResponse;
    clock += PREVIEW_TTL_MS + 1;
    expect((await call('POST', '/mcp/servers', { previewHash: first.previewHash })).statusCode).toBe(409);

    const fresh = (await call('POST', '/mcp/servers/preview', stdioConfig())).json() as McpPreviewResponse;
    expect(fresh.previewHash).toBe(first.previewHash);
    const saved = await call('POST', '/mcp/servers', { previewHash: fresh.previewHash });
    expect(saved.statusCode, saved.body).toBe(201);
    expect((await call('POST', '/mcp/servers', { previewHash: fresh.previewHash })).statusCode).toBe(409);

    expect(((await call('GET', '/mcp/servers')).json() as McpServersResponse).servers.map((s) => s.name)).toEqual(['fx']);
  });

  it('nothing is registered by a refused save', async () => {
    await call('POST', '/mcp/servers/preview', stdioConfig());
    await call('POST', '/mcp/servers', {});
    expect(((await call('GET', '/mcp/servers')).json() as McpServersResponse).servers).toEqual([]);
  });

  it('a config the schema refuses is a 400, and an unreachable server a 502', async () => {
    expect((await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-stdio' })).statusCode).toBe(400);
    expect((await call('POST', '/mcp/servers/preview', { name: 'fx', kind: 'mcp-http', url: 'file:///etc/passwd' })).statusCode).toBe(400);
    expect((await call('POST', '/mcp/servers/preview', stdioConfig({ auth: { ref: 'plain-text-token', env: 'X' } }))).statusCode).toBe(400);
    const dead = await call('POST', '/mcp/servers/preview', stdioConfig({ command: join(base, 'no-such-binary') }));
    expect(dead.statusCode).toBe(502);
    expect(dead.json()).toMatchObject({ code: 'probe_failed' });
  });
});

describe('the tool diff: a changed schema is unregistered again (D-5)', () => {
  it('classes come from annotations; test records changed / added / removed; a re-save registers them', async () => {
    const saved = await previewAndSave();
    expect(saved.tools.map((t) => [t.name, t.class, t.status])).toEqual([
      ['wt_echo', 'read', 'registered'],
      ['wt_note', 'destructive', 'registered'],
      ['wt_plain', 'write', 'registered'],
    ]);
    expect(toolOf(saved, 'wt_note').subject).toBe('mcp:fx/wt_note');

    // An operator override, then the upstream changes under it.
    const patched = await call('PATCH', `/mcp/tools/${encodeURIComponent('mcp:fx/wt_note')}`, { classOverride: 'read', enabled: false });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json()).toMatchObject({ class: 'read', derivedClass: 'destructive', enabled: false });

    writeSpec({
      tools: [
        BASE_TOOLS[0]!,
        { ...BASE_TOOLS[1]!, inputSchema: { type: 'object', properties: { note: { type: 'string' }, path: { type: 'string' } } } },
        { name: 'wt_extra', description: 'added later', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      ],
    });
    const tested = (await call('POST', '/mcp/servers/fx/test')).json() as McpServerTestResponse;
    expect(tested.ok).toBe(true);
    expect(tested.diff).toEqual({ added: ['wt_extra'], removed: ['wt_plain'], changed: ['wt_note'], unchanged: ['wt_echo'] });
    const after = tested.server;
    expect(toolOf(after, 'wt_echo').status).toBe('registered');
    expect(toolOf(after, 'wt_note').status).toBe('unregistered');
    expect(toolOf(after, 'wt_extra').status).toBe('unregistered');
    expect(toolOf(after, 'wt_plain').status).toBe('gone');
    expect(after.counts).toMatchObject({ total: 3, registered: 1 });

    // Durable: a fresh registry over the same file reads the same statuses.
    const reread = await new McpRegistry({ store: new McpRegistryStore(join(base, 'state', 'mcp')), secrets, probe: probeMcpServer, discover: () => [] }).get('fx');
    expect(reread.tools.map((t) => [t.name, t.status])).toEqual(after.tools.map((t) => [t.name, t.status]));

    // Previewing again diffs against the registry as the test left it (`wt_plain` is already
    // `gone`, so it is not removed twice); saving it registers the new schema.
    const again = (await call('POST', '/mcp/servers/preview', stdioConfig())).json() as McpPreviewResponse;
    expect(again.diff).toEqual({ added: ['wt_extra'], removed: [], changed: ['wt_note'], unchanged: ['wt_echo'] });
    const resaved = (await call('POST', '/mcp/servers', { previewHash: again.previewHash })).json() as McpServer;
    expect(toolOf(resaved, 'wt_note')).toMatchObject({ status: 'registered', enabled: false, classOverride: null, class: 'destructive' });
    expect(toolOf(resaved, 'wt_extra').status).toBe('registered');
    expect(toolOf(resaved, 'wt_plain').status).toBe('gone');
  });

  it('health turns failing after 3 consecutive failed probes and ok on the next success', async () => {
    await previewAndSave();
    writeSpec({ tools: [], crash: true });
    const states: string[] = [];
    for (let i = 0; i < 3; i++) states.push(((await call('POST', '/mcp/servers/fx/test')).json() as McpServerTestResponse).server.health.state);
    expect(states).toEqual(['ok', 'ok', 'failing']);
    writeSpec({ tools: BASE_TOOLS });
    const back = ((await call('POST', '/mcp/servers/fx/test')).json() as McpServerTestResponse).server.health;
    expect(back).toMatchObject({ state: 'ok', consecutiveFailures: 0, lastError: null });
  });

  it('a test whose server was saved again mid-probe is refused, not applied to the new config', async () => {
    await previewAndSave();
    const gate: { release?: () => void; parked?: () => void } = {};
    const held = new Promise<void>((r) => (gate.release = r));
    const parked = new Promise<void>((r) => (gate.parked = r));
    let calls = 0;
    const racing = new McpRegistry({
      store: new McpRegistryStore(join(base, 'state', 'mcp')),
      secrets,
      probe: async (config, secret) => {
        calls += 1;
        if (calls === 1) {
          gate.parked?.();
          await held;
        }
        return probeMcpServer(config, secret);
      },
      discover: () => [],
    });
    const testing = racing.test('fx');
    await parked;
    // While the first probe is parked, fx is saved again with different args.
    writeSpec({ tools: [BASE_TOOLS[0]!] });
    const altSpec = join(base, 'spec-alt.json');
    writeFileSync(altSpec, JSON.stringify({ tools: [BASE_TOOLS[1]!] }));
    const preview = await racing.preview({ name: 'fx', kind: 'mcp-stdio', command: process.execPath, args: [FIXTURE_SERVER, altSpec], url: null, auth: null });
    await racing.save(preview.previewHash);
    gate.release?.();
    await expect(testing).rejects.toMatchObject({ status: 409, code: 'server_changed' });
    const now = await racing.get('fx');
    expect(now.args).toEqual([FIXTURE_SERVER, altSpec]);
    expect(now.tools.filter((t) => t.status === 'registered').map((t) => t.name)).toEqual(['wt_note']);
  });

  it('disable, remove and unknown names', async () => {
    secrets.values.set('fx', 'wkd-secret-value');
    await previewAndSave(stdioConfig({ auth: { ref: 'keychain:wicked-mcp/fx', env: 'FIXTURE_TOKEN' } }));
    expect(((await call('PATCH', '/mcp/servers/fx', { enabled: false })).json() as McpServer).enabled).toBe(false);
    expect((await call('PATCH', '/mcp/servers/nope', { enabled: false })).statusCode).toBe(404);
    expect((await call('PATCH', `/mcp/tools/${encodeURIComponent('mcp:fx/none')}`, { enabled: false })).statusCode).toBe(404);
    expect((await call('PATCH', `/mcp/tools/${encodeURIComponent('mcp:fx/wt_echo')}`, {})).statusCode).toBe(400);
    expect((await call('POST', '/mcp/servers/nope/test')).statusCode).toBe(404);
    expect((await call('DELETE', '/mcp/servers/fx')).json()).toEqual({ removed: 'fx' });
    expect(secrets.values.has('fx')).toBe(false);
    expect((await call('DELETE', '/mcp/servers/fx')).statusCode).toBe(404);
  });

  it('a corrupt registry is a 503, never silently emptied', async () => {
    mkdirSync(join(base, 'state', 'mcp'), { recursive: true });
    writeFileSync(join(base, 'state', 'mcp', 'registry.json'), '{not json');
    expect((await call('GET', '/mcp/servers')).statusCode).toBe(503);
    expect(readFileSync(join(base, 'state', 'mcp', 'registry.json'), 'utf8')).toBe('{not json');
  });
});

describe('classification and subjects', () => {
  it('derives the class from annotations (§4.2, D-4)', () => {
    expect(deriveToolClass(null)).toBe('write');
    expect(deriveToolClass({ readOnlyHint: true, destructiveHint: true })).toBe('read');
    // No readOnlyHint and no destructiveHint = no hints declared = write, as the engine derives it (S6 parity).
    expect(deriveToolClass({ title: 'x' })).toBe('write');
    expect(deriveToolClass({ openWorldHint: true })).toBe('write');
    expect(deriveToolClass({ destructiveHint: true })).toBe('destructive');
    expect(deriveToolClass({ destructiveHint: false })).toBe('write');
    expect(deriveToolClass({ readOnlyHint: false, destructiveHint: false })).toBe('write');
  });

  it('parses subjects and refuses anything else', () => {
    expect(parseMcpSubject('mcp:jira/create_issue')).toEqual({ server: 'jira', tool: 'create_issue' });
    expect(parseMcpSubject('mcp:jira/a/b')).toEqual({ server: 'jira', tool: 'a/b' });
    for (const bad of ['jira/x', 'mcp:/x', 'mcp:jira/', 'mcp:Jira/x', 'mcp:jira']) expect(parseMcpSubject(bad)).toBeNull();
  });
});

describe('discovery: names only', () => {
  it('lists servers from operator and worker CLI homes, and nothing of their config', () => {
    const home = join(base, 'home');
    const worker = join(base, 'worker');
    const secret = 'wkd-config-token-123456';
    const put = (root: string, rel: string, text: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put(home, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'x' }, mcpServers: { github: { command: 'gh-mcp', env: { TOKEN: secret } } } }));
    put(home, '.codex/config.toml', `[mcp_servers.jira]\ncommand = "jira"\nenv = { TOKEN = "${secret}" }\n[mcp_servers.jira.tools.x]\napproval_mode = "prompt"\n[mcp_servers."quoted.one"]\nurl = "https://x"\n`);
    put(home, '.config/opencode/opencode.json', JSON.stringify({ mcp: { sentry: { url: `https://x?token=${secret}` } } }));
    put(worker, 'copilot/mcp-config.json', JSON.stringify({ mcpServers: { stray: { command: 'x' } } }));
    put(worker, 'claude/.claude.json', '{broken');
    // An instance seat's root (core#591), and a directory that only looks like one.
    put(worker, 'claude-2/.claude.json', JSON.stringify({ mcpServers: { second: { command: 'x' } } }));
    put(worker, 'claude-2.bak/.claude.json', JSON.stringify({ mcpServers: { debris: { command: 'x' } } }));

    const found = discoverMcpServers({ home, workerHome: worker }, new Set(['jira']));
    expect(found).toEqual([
      { name: 'github', cli: 'claude', origin: 'operator', source: '~/.claude.json', managed: false },
      { name: 'second', cli: 'claude', origin: 'worker', source: '<worker home>/claude-2/.claude.json', managed: false },
      { name: 'jira', cli: 'codex', origin: 'operator', source: '~/.codex/config.toml', managed: true },
      { name: 'quoted.one', cli: 'codex', origin: 'operator', source: '~/.codex/config.toml', managed: false },
      { name: 'stray', cli: 'copilot', origin: 'worker', source: '<worker home>/copilot/mcp-config.json', managed: false },
      { name: 'sentry', cli: 'opencode', origin: 'operator', source: '~/.config/opencode/opencode.json', managed: false },
    ]);
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(codexServerNames('')).toEqual([]);
    // A torn table header names nothing.
    expect(codexServerNames(`[mcp_servers.${secret}\ncommand = "x"\n`)).toEqual([]);
  });

  it('the registry listing carries discovery through, names only', async () => {
    const home = join(base, 'home');
    const secret = 'wkd-config-token-654321';
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', args: ['--token', secret] } } }));
    const listing = new McpRegistry({
      store: new McpRegistryStore(join(base, 'state', 'mcp')),
      secrets,
      probe: probeMcpServer,
      discover: (managed) => discoverMcpServers({ home, workerHome: null }, managed),
    });
    const listed = await listing.list();
    expect(listed.discovered.map((d) => d.name)).toEqual(['github']);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });
});

// ── An authenticated streamable-HTTP upstream ─────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

/** A stateless streamable-HTTP MCP server that records each request's Authorization header and
 *  echoes the bearer token into a tool description (the leak the probe must scrub). */
async function startHttpUpstream(seen: Array<string | undefined>, expected: string): Promise<HttpServer> {
  const server = createHttpServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization;
      seen.push(auth);
      if (auth !== `Bearer ${expected}`) {
        res.writeHead(401).end();
        return;
      }
      const mcp = new McpServerImpl({ name: 'web', version: '1.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'web_lookup', description: `authorized as ${expected}`, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
      }));
      // No sessionIdGenerator: a stateless transport, one per request.
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
      await transport.handleRequest(req, res, await readBody(req));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return server;
}
