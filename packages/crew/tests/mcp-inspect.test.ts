// The MCP inspector bridge (DES-MCP-INSPECTOR-001 §3): real stdio sessions against a tiny fixture
// server, through the routes, with the human-only rule, the method allowlist, the log long-poll,
// secret scrubbing, server-request refusal, timeouts, the session cap and close.

import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { McpInspectLogResponse, McpInspectRpcResponse, McpInspectStartResponse } from '../src/core/types.js';
import { registerMcpInspectRoutes, type InspectRegistry } from '../src/mcp-inspect/routes.js';
import { commandName, InspectSessions, MAX_SESSIONS } from '../src/mcp-inspect/session.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';

const SERVER = join(import.meta.dirname, 'fixtures', 'mcp', 'inspect-server.mjs');
const HUMAN = { 'x-actor': 'human:operator' };
const AGENT = { 'x-actor': 'agent:operator' };
const OBSERVER = { 'x-actor': 'human:observer' };
const TOKEN = 'tok-1234567890-secret';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

async function harness(opts: { registry?: InspectRegistry; callTimeoutMs?: number } = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest('actor', null as unknown as never);
  app.addHook('onRequest', async (req) => {
    const h = req.headers['x-actor'];
    if (typeof h === 'string') {
      const [kind, trust] = h.split(':');
      (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
    }
  });
  const sessions = new InspectSessions();
  registerMcpInspectRoutes(app, { sessions, ...(opts.registry !== undefined ? { registry: opts.registry } : {}), ...(opts.callTimeoutMs !== undefined ? { callTimeoutMs: opts.callTimeoutMs } : {}) });
  await app.ready();
  apps.push(app);
  const start = async (target: unknown, headers = HUMAN) => app.inject({ method: 'POST', url: '/api/v1/mcp-inspect/sessions', headers, payload: { target } });
  const rpc = async (id: string, method: string, params?: unknown, headers = HUMAN) =>
    app.inject({ method: 'POST', url: `/api/v1/mcp-inspect/sessions/${id}/rpc`, headers, payload: { method, ...(params !== undefined ? { params } : {}) } });
  const log = async (id: string, after = 0, wait = 0, headers = HUMAN) => app.inject({ method: 'GET', url: `/api/v1/mcp-inspect/sessions/${id}/log?after=${after}&wait=${wait}`, headers });
  return { app, sessions, start, rpc, log };
}

const stdio = (env?: Record<string, string>) => ({ command: process.execPath, args: [SERVER], ...(env !== undefined ? { env } : {}) });

describe('the MCP inspector bridge', () => {
  it('connects over stdio, runs the handshake, lists, calls, reads, gets, and logs every message with timings', async () => {
    const h = await harness();
    const res = await h.start(stdio());
    expect(res.statusCode, res.body).toBe(201);
    const { session } = res.json() as McpInspectStartResponse;
    expect(session.state).toBe('ready');
    expect(session.initialize).toMatchObject({ serverInfo: { name: 'inspect-fixture', version: '1.2.3' }, capabilities: { tools: {} }, instructions: 'a fixture' });
    expect(session.target).toMatchObject({ kind: 'stdio', name: 'inspect-server.mjs', envNames: [] });
    expect(session.target.label).toContain('inspect-server.mjs');

    const listed = (await h.rpc(session.id, 'tools/list')).json() as McpInspectRpcResponse;
    expect((listed.response.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['echo', 'boom', 'whoami', 'slow']);
    const echoed = await h.rpc(session.id, 'tools/call', { name: 'echo', arguments: { text: 'hi there' } });
    expect(echoed.statusCode).toBe(200);
    const echo = echoed.json() as McpInspectRpcResponse;
    expect(echo.response.result).toEqual({ content: [{ type: 'text', text: 'hi there' }] });
    expect(echo.ms).toBeGreaterThanOrEqual(0);
    const boom = (await h.rpc(session.id, 'tools/call', { name: 'boom', arguments: {} })).json() as McpInspectRpcResponse;
    expect(boom.response.error).toMatchObject({ code: -32000, message: 'boom failed on purpose' });
    const read = (await h.rpc(session.id, 'resources/read', { uri: 'fixture://readme' })).json() as McpInspectRpcResponse;
    expect(JSON.stringify(read.response.result)).toContain('hello from the fixture');
    const prompt = (await h.rpc(session.id, 'prompts/get', { name: 'greet', arguments: { who: 'ada' } })).json() as McpInspectRpcResponse;
    expect(JSON.stringify(prompt.response.result)).toContain('hello ada');

    const l = (await h.log(session.id)).json() as McpInspectLogResponse;
    const kinds = l.entries.map((e) => `${e.dir}:${e.kind}:${e.method ?? ''}`);
    expect(kinds).toContain('out:request:initialize');
    expect(kinds).toContain('out:notification:notifications/initialized');
    expect(kinds).toContain('in:notification:notifications/message');
    expect(kinds).toContain('out:request:tools/call');
    expect(l.entries.some((e) => e.kind === 'stderr' && e.text.includes('inspect-server: starting'))).toBe(true);
    expect(l.entries.some((e) => e.kind === 'stderr' && e.text.includes('boom: about to fail'))).toBe(true);
    const errResp = l.entries.find((e) => e.kind === 'response' && e.error === true);
    expect(errResp?.text).toContain('boom failed on purpose');
    expect(l.entries.filter((e) => e.kind === 'response' && e.dir === 'in').every((e) => typeof e.ms === 'number')).toBe(true);
    // The server's own request (roots/list) is answered -32601: the inspector serves no client capability.
    expect(kinds).toContain('in:request:roots/list');
    expect(l.entries.filter((e) => e.dir === 'out').map((e) => e.text).join('\n')).toContain('-32601');
    expect(l.state).toBe('ready');
    expect(l.next).toBe(l.entries[l.entries.length - 1]!.seq);
  });

  it('start, send and delete are HUMAN-only; the log needs operator; an unknown method or bad target is refused', async () => {
    const h = await harness();
    expect((await h.start(stdio(), AGENT)).statusCode).toBe(403);
    expect(h.sessions.size).toBe(0);
    const { session } = (await h.start(stdio())).json() as McpInspectStartResponse;
    expect((await h.rpc(session.id, 'tools/list', undefined, AGENT)).statusCode).toBe(403);
    expect((await h.log(session.id, 0, 0, OBSERVER)).statusCode).toBe(403);
    const bad = await h.rpc(session.id, 'initialize', {});
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'method_not_allowed' });
    expect((await h.rpc(session.id, 'sampling/createMessage', {})).statusCode).toBe(400);
    expect((await h.start({ url: 'file:///etc/passwd' })).statusCode).toBe(400);
    expect((await h.start({ command: 'x', cwd: 'relative/dir' })).statusCode).toBe(400);
    expect((await h.start({ command: 'x', env: { 'BAD-NAME': 'v' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/mcp-inspect/sessions/${session.id}`, headers: AGENT })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'DELETE', url: `/api/v1/mcp-inspect/sessions/${session.id}`, headers: HUMAN })).statusCode).toBe(204);
    expect((await h.rpc(session.id, 'tools/list')).statusCode).toBe(404);
    expect((await h.log(session.id)).statusCode).toBe(404);
  });

  it('a typed env value is injected but scrubbed from every log entry and reply; the daemon env does not leak', async () => {
    process.env['WICKED_LEAK'] = 'daemon-only';
    try {
      const h = await harness();
      const { session } = (await h.start(stdio({ INSPECT_TOKEN: TOKEN }))).json() as McpInspectStartResponse;
      expect(session.target.envNames).toEqual(['INSPECT_TOKEN']);
      expect(JSON.stringify(session)).not.toContain(TOKEN);
      const who = (await h.rpc(session.id, 'tools/call', { name: 'whoami', arguments: {} })).json() as McpInspectRpcResponse;
      const text = JSON.stringify(who);
      expect(text).not.toContain(TOKEN);
      expect(text).toMatch(/token=\[REDACTED/);
      expect(text).toContain('home=set');
      expect(text).toContain('leak=none');
      const l = (await h.log(session.id)).body;
      expect(l).not.toContain(TOKEN);
      // A credential-shaped string the server sends is replaced too.
    } finally {
      delete process.env['WICKED_LEAK'];
    }
  });

  it('codex r1: a secret is scrubbed in its JSON-escaped form, across split stderr chunks, and out of the target label', async () => {
    const h = await harness();
    const quoted = 'a"b\\c-secret-value';
    const script = `process.stderr.write('opaque-${TOKEN.slice(0, 6)}'); setTimeout(() => process.stderr.write('${TOKEN.slice(6)}\\n'), 30);` +
      `require('readline').createInterface({input: process.stdin}).on('line', (l) => { const m = JSON.parse(l);` +
      ` if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: m.id, result: {protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {name: process.env.Q, version: '1'}}}) + '\\n'); });`;
    const res = await h.start({ command: process.execPath, args: ['-e', script, TOKEN], env: { INSPECT_TOKEN: TOKEN, Q: quoted } });
    const { session } = res.json() as McpInspectStartResponse;
    expect(session.state).toBe('ready');
    expect(JSON.stringify(session)).not.toContain(TOKEN);
    expect(session.target.label).toContain('[redacted:secret]');
    await new Promise((r) => setTimeout(r, 400));
    const body = (await h.log(session.id)).body;
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain(TOKEN.slice(6));
    expect(body).not.toContain('c-secret-value');
    expect(body).toContain('opaque-[redacted:secret]');
  });

  it('the log long-polls: it waits for the next entry, and answers at once when there is one', async () => {
    const h = await harness();
    const { session } = (await h.start(stdio())).json() as McpInspectStartResponse;
    await h.rpc(session.id, 'tools/list'); // the server's own roots/list request has landed by now
    const first = (await h.log(session.id)).json() as McpInspectLogResponse;
    const t0 = Date.now();
    const waiting = h.log(session.id, first.next, 10);
    setTimeout(() => void h.rpc(session.id, 'ping'), 150);
    const got = (await waiting).json() as McpInspectLogResponse;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(got.entries.length).toBeGreaterThan(0);
    expect(got.entries[0]!.seq).toBe(first.next + 1);
    expect(got.entries[0]!.method).toBe('ping');
  });

  it('a call with no answer is a 504 after the deadline; a server that dies leaves a closed session', async () => {
    const h = await harness({ callTimeoutMs: 300 });
    const { session } = (await h.start(stdio())).json() as McpInspectStartResponse;
    const slow = await h.rpc(session.id, 'tools/call', { name: 'slow', arguments: {} });
    expect(slow.statusCode).toBe(504);
    expect(slow.json()).toMatchObject({ code: 'timeout' });
    // A command that is not an MCP server fails the handshake, with its stderr in the log.
    const dead = (await h.start({ command: process.execPath, args: ['-e', 'process.stderr.write("not a server\\n"); process.exit(3)'] })).json() as McpInspectStartResponse;
    expect(dead.session.state).toBe('failed');
    const l = (await h.log(dead.session.id)).json() as McpInspectLogResponse;
    expect(l.state).toBe('failed');
    expect(l.entries.some((e) => e.kind === 'stderr' && e.text.includes('not a server'))).toBe(true);
    expect((await h.rpc(dead.session.id, 'tools/list')).statusCode).toBe(409);
  });

  it(`holds at most ${MAX_SESSIONS} sessions, and closes them all when the daemon closes`, async () => {
    const h = await harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) ids.push(((await h.start(stdio())).json() as McpInspectStartResponse).session.id);
    const over = await h.start(stdio());
    expect(over.statusCode).toBe(429);
    const s = h.sessions.get(ids[0]!)!;
    await h.app.close();
    apps.splice(apps.indexOf(h.app), 1);
    expect(h.sessions.size).toBe(0);
    expect(s.state).toBe('closed');
  });

  it('a registry server resolves through the registry; a missing secret is never connected; rest is refused', async () => {
    const config = (over: Partial<McpUpstreamConfig>): McpUpstreamConfig => ({ name: 'fixture', kind: 'mcp-stdio', command: process.execPath, args: [SERVER], url: null, auth: { ref: 'env:FIXTURE_TOKEN', env: 'INSPECT_TOKEN' } as McpUpstreamConfig['auth'], ...over });
    let secret: string | null = TOKEN;
    const registry: InspectRegistry = {
      inspectTarget: async (name) => (name === 'fixture' ? config({}) : name === 'api' ? config({ name: 'api', kind: 'rest' }) : null),
      callSecret: async () => ({ secret, missing: secret === null }),
    };
    const h = await harness({ registry });
    const res = await h.start({ server: 'fixture' });
    expect(res.statusCode, res.body).toBe(201);
    const { session } = res.json() as McpInspectStartResponse;
    expect(session.target).toMatchObject({ kind: 'server', name: 'fixture', envNames: ['INSPECT_TOKEN'] });
    const who = JSON.stringify((await h.rpc(session.id, 'tools/call', { name: 'whoami', arguments: {} })).json());
    expect(who).not.toContain(TOKEN);
    expect(who).toMatch(/token=\[REDACTED/);
    expect((await h.start({ server: 'nope' })).statusCode).toBe(404);
    expect((await h.start({ server: 'api' })).statusCode).toBe(400);
    secret = null;
    const missing = await h.start({ server: 'fixture' });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: 'secret_missing' });
  });

  it('names a stdio command by its script, never its path', () => {
    expect(commandName('/usr/local/bin/node', ['--enable-x', '/home/u/srv/build/index.js'])).toBe('index.js');
    expect(commandName('/opt/bin/my-server', [])).toBe('my-server');
  });
});
