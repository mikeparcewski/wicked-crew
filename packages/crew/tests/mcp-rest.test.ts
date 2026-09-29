// DES-MCP-TOOLS-001 slice S5a — REST upstreams: an OpenAPI 3 API wrapped as brokered tools
// (src/mcp/rest.ts), registered through the real registry routes and called through the real broker.
//
// The slice's proving tests:
//   1. an unmapped argument is DROPPED: the API receives only the allowlisted arguments, and the
//      result discloses the dropped names;
//   2. an off-host request is REFUSED: a path value that would climb out of the base path, and a
//      redirect to another host, never reach (or are never followed to) anything but the pinned
//      host, and are recorded as `guard_error` (`rest_host_escape`, I6).
//
// A real HTTP server plays the API (and a second one plays "another host"). The engine's gate is a
// fake, as in tests/mcp-broker.test.ts: only core's carriers can mint a capability token.

import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpEngineGate } from '../src/core/adapter.js';
import type { McpCallRecord, McpCallResponse, McpPreviewResponse, McpServer } from '../src/core/types.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { deriveToolClass } from '../src/mcp/classify.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import { buildRestRequest, importOpenApi, pinnedUrl, RestBoundaryError } from '../src/mcp/rest.js';
import { SECRET_REDACTION, type SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

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

interface CallJson {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  annotations: Record<string, boolean> | null;
  registered: boolean;
  kind?: string;
}

/** Allows every registered call; records what the engine was handed. */
class FakeGate implements McpEngineGate {
  calls: CallJson[] = [];
  async evaluateCall(requestJson: string): Promise<string> {
    const req = JSON.parse(requestJson) as { token: string; call: CallJson };
    this.calls.push(req.call);
    if (req.token !== 'wmt_good') throw new Error('invalid_token: not bound');
    const decision = req.call.registered ? 'allow' : 'deny';
    return JSON.stringify({
      decision,
      subject: `mcp:${req.call.server}/${req.call.tool}`,
      class: deriveToolClass(req.call.annotations),
      ruleIds: decision === 'deny' ? ['engine:mcp-unregistered'] : [],
      obligations: [],
      claimId: `mcp-${decision}:unit-2`,
      unit: { runId: 'run-1', ord: 2, attempt: 0, phase: 'unit-2', seat: 'codex' },
    });
  }
  async evaluateOutput(requestJson: string): Promise<string> {
    const req = JSON.parse(requestJson) as { call: CallJson };
    return JSON.stringify({ decision: 'allow', subject: `mcp:${req.call.server}/${req.call.tool}`, ruleIds: [] });
  }
}

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** An HTTP server that records every request and answers with `respond`. */
async function httpServer(respond: (req: Seen) => { status: number; headers?: Record<string, string>; body?: string }): Promise<{ server: Server; origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body };
      seen.push(s);
      const out = respond(s);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

/** The API's OpenAPI document. */
const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Tracker API', version: '1.2.0' },
  paths: {
    '/issues/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'getIssue',
        summary: 'Read one issue',
        parameters: [
          { name: 'expand', in: 'query', schema: { type: 'string' } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
          { name: 'Authorization', in: 'header', schema: { type: 'string' } },
        ],
      },
      delete: { operationId: 'deleteIssue', summary: 'Delete an issue' },
    },
    '/issues': {
      post: {
        operationId: 'createIssue',
        summary: 'Create an issue',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewIssue' } } } },
      },
    },
    '/files': {
      put: { operationId: 'upload', requestBody: { content: { 'application/octet-stream': { schema: { type: 'string' } } } } },
    },
  },
  components: {
    schemas: {
      NewIssue: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' }, parent: { $ref: '#/components/schemas/NewIssue' } },
      },
    },
  },
};

let base: string;
let secret: string;
let secrets: MemorySecretStore;
let gate: FakeGate;
let registry: McpRegistry;
let records: McpCallRecordFile;
let app: FastifyInstance;
let api: Awaited<ReturnType<typeof httpServer>>;
let other: Awaited<ReturnType<typeof httpServer>>;
let apiRespond: (req: Seen) => { status: number; headers?: Record<string, string>; body?: string };
let answered: string[];
let logs: string[];

function recorded(): McpCallRecord[] {
  try {
    return readFileSync(records.path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as McpCallRecord);
  } catch {
    return [];
  }
}

async function register(body: Record<string, unknown>): Promise<McpServer> {
  const preview = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: body });
  answered.push(preview.body);
  expect(preview.statusCode, preview.body).toBe(200);
  const saved = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: (preview.json() as McpPreviewResponse).previewHash } });
  answered.push(saved.body);
  expect(saved.statusCode, saved.body).toBe(201);
  return saved.json() as McpServer;
}

async function mcpCall(subject: string, args: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_good', subject, args } });
  answered.push(res.body);
  return { status: res.statusCode, body: res.json() as McpCallResponse };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-rest-'));
  secret = `wkd-rest-${randomUUID()}`;
  secrets = new MemorySecretStore();
  secrets.values.set('tracker', secret);
  gate = new FakeGate();
  answered = [];
  logs = [];
  apiRespond = (req) => ({ status: 200, body: JSON.stringify({ ok: true, path: req.url }) });
  api = await httpServer((req) => apiRespond(req));
  other = await httpServer(() => ({ status: 200, body: '{"stolen":true}' }));
  records = new McpCallRecordFile(join(base, 'state', 'mcp'));
  registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'state', 'mcp')), secrets, probe: probeMcpServer, discover: () => [] });
  const broker = new McpBroker({ registry, engine: () => gate, records, sleep: async () => undefined, log: (m) => logs.push(m) });
  app = Fastify({ logger: false });
  registerMcpRoutes(app, { registry, broker, audit: new AuditLog(join(base, 'audit.log'), (m) => logs.push(m)), actorOf: () => LOCAL_ACTOR });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  await new Promise((r) => api.server.close(r));
  await new Promise((r) => other.server.close(r));
  removeScratch(base);
});

const tracker = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'tracker',
  kind: 'rest',
  url: `${api.origin}/v1`,
  openapi: SPEC,
  auth: { ref: 'keychain:wicked-mcp/tracker', header: 'Authorization', prefix: 'Bearer ' },
  ...extra,
});

describe('PROVING (S5a): an unmapped argument is dropped', () => {
  it('the API receives only the allowlisted arguments; the dropped names are disclosed', async () => {
    await register(tracker());
    const r = await mcpCall('mcp:tracker/getIssue', {
      id: 'ABC-1',
      expand: 'comments',
      'X-Trace': 't-1',
      Authorization: 'Bearer forged', // a declared-but-forbidden header: never argument-settable
      sneaky: 'x', // not in the spec at all
      url: 'http://evil.example/', // not in the spec at all
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(api.seen).toHaveLength(1);
    const req = api.seen[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/v1/issues/ABC-1?expand=comments');
    expect(req.headers['x-trace']).toBe('t-1');
    // The auth header is the broker's, from the secret; the forged one was dropped.
    expect(req.headers['authorization']).toBe(`Bearer ${secret}`);
    expect(req.headers['sneaky']).toBeUndefined();
    expect(req.body).toBe('');
    const meta = (r.body.result?.['_meta'] as Record<string, { droppedArgs: string[]; status: number }>)['wicked/rest'];
    expect(meta?.droppedArgs).toEqual(['Authorization', 'sneaky', 'url']);
    expect(meta?.status).toBe(200);
    expect(r.body.result?.['structuredContent']).toEqual({ ok: true, path: '/v1/issues/ABC-1?expand=comments' });
  });

  it('a JSON body is built from its mapped keys only', async () => {
    await register(tracker());
    const r = await mcpCall('mcp:tracker/createIssue', { title: 'Broken', parent: { title: 'Epic' }, owner: 'mallory' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const req = api.seen[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/issues');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual({ title: 'Broken', parent: { title: 'Epic' } });
    expect((r.body.result?.['_meta'] as Record<string, { droppedArgs: string[] }>)['wicked/rest']?.droppedArgs).toEqual(['owner']);
  });

  it('buildRestRequest never sends an argument outside the allowlist', () => {
    const [tool] = importOpenApi(SPEC as never, { operations: ['getIssue'], authHeader: 'Authorization' }).tools;
    const built = buildRestRequest(
      { name: 't', kind: 'rest', command: null, args: [], url: 'https://api.example.com/v1', auth: null },
      null,
      tool!.rest,
      { id: '7', expand: 'x', extra: 'y', Host: 'evil.example' },
    );
    expect(built.url.href).toBe('https://api.example.com/v1/issues/7?expand=x');
    expect(built.droppedArgs).toEqual(['Host', 'extra']);
    expect(Object.keys(built.init.headers).map((h) => h.toLowerCase())).not.toContain('host');
  });
});

describe('PROVING (S5a): an off-host request is refused (I6)', () => {
  it('a path value that climbs out of the base path is refused unsent and recorded as guard_error', async () => {
    await register(tracker());
    const r = await mcpCall('mcp:tracker/deleteIssue', { id: '..' });
    expect(r.status).toBe(500);
    expect(r.body.outcome).toBe('guard_error');
    expect(r.body.result).toBeUndefined();
    expect(api.seen).toHaveLength(0);
    const [rec] = recorded();
    expect(rec?.decision).toMatchObject({ decision: 'guard_error', by: 'broker:rest-host-pin' });
    expect(rec?.status).toEqual({ code: 'error', errorClass: 'rest_host_escape' });
    expect(rec?.attrs['mcp.kind']).toBe('rest');
  });

  it('a redirect to another host is not followed, and refused as a host escape', async () => {
    await register(tracker());
    apiRespond = () => ({ status: 302, headers: { location: `${other.origin}/steal` } });
    const r = await mcpCall('mcp:tracker/getIssue', { id: '1' });
    expect(r.body.outcome).toBe('guard_error');
    expect(api.seen).toHaveLength(1);
    expect(other.seen).toHaveLength(0);
    expect(recorded()[0]?.status.errorClass).toBe('rest_host_escape');
    // A same-host redirect is not followed either; it is an upstream error, not an escape.
    apiRespond = () => ({ status: 301, headers: { location: '/v1/elsewhere' } });
    const same = await mcpCall('mcp:tracker/getIssue', { id: '1' });
    expect(same.body.outcome).toBe('upstream_error');
    expect(api.seen.map((s) => s.url)).toEqual(['/v1/issues/1', '/v1/issues/1']);
  });

  it('pinnedUrl refuses every way out: dot segments, a scheme-relative path, a path off the base', () => {
    const b = new URL('https://api.example.com/v1/');
    expect(pinnedUrl(b, '/issues/{id}', { id: 'a/b?c#d' }).href).toBe('https://api.example.com/v1/issues/a%2Fb%3Fc%23d');
    expect(() => pinnedUrl(b, '/issues/{id}', { id: '..' })).toThrow(RestBoundaryError);
    expect(() => pinnedUrl(b, '/issues/{id}', { id: '.' })).toThrow(RestBoundaryError);
    expect(() => pinnedUrl(b, '/../admin', {})).toThrow(RestBoundaryError);
    expect(() => pinnedUrl(b, 'https://evil.example/x', {})).toThrow(RestBoundaryError);
    // `//evil.example/x` stays a PATH on the pinned host.
    expect(pinnedUrl(b, '//evil.example/x', {}).origin).toBe('https://api.example.com');
  });

  it('a spec whose path cannot be pinned is refused at preview', async () => {
    const bad = { ...SPEC, paths: { '/../admin': { get: { operationId: 'escape' } } } };
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: tracker({ openapi: bad }) });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('leaves the pinned base path');
  });
});

describe('the OpenAPI import', () => {
  it('classes come from the method; $refs resolve (a cycle is cut to {}); a non-JSON body is skipped and disclosed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: tracker() });
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json() as McpPreviewResponse;
    expect(p.serverInfo).toEqual({ name: 'Tracker API', version: '1.2.0' });
    expect(Object.fromEntries(p.tools.map((t) => [t.name, t.class]))).toEqual({ getIssue: 'read', deleteIssue: 'destructive', createIssue: 'write' });
    expect(p.skipped).toEqual(['PUT /files: its request body is not JSON']);
    const create = p.tools.find((t) => t.name === 'createIssue')!;
    expect(create.subject).toBe('mcp:tracker/createIssue');
    expect(create.rest).toMatchObject({ method: 'POST', pathTemplate: '/issues', bodyMap: { title: 'title', parent: 'parent' }, argAllowlist: ['parent', 'title'] });
    expect(create.inputSchema).toMatchObject({ required: ['title'], properties: { title: { type: 'string' }, parent: {} } });
    const get = p.tools.find((t) => t.name === 'getIssue')!;
    // The Authorization header parameter is not an argument at all.
    expect(get.rest?.argAllowlist).toEqual(['X-Trace', 'expand', 'id']);
    expect(p.server).toMatchObject({ kind: 'rest', url: `${api.origin}/v1`, openapiUrl: null, operations: null });
    expect(JSON.stringify(p.server)).not.toContain('Tracker API'); // the pasted document is not echoed
  });

  it('operations picks the tools; an unknown name is refused rather than wrapping less', async () => {
    const saved = await register(tracker({ operations: ['getIssue'] }));
    expect(saved.tools.map((t) => t.name)).toEqual(['getIssue']);
    expect(saved.operations).toEqual(['getIssue']);
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: tracker({ operations: ['getIssue', 'nope'] }) });
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('the OpenAPI document could not be imported: operations names \\"nope\\"');
  });

  it('openapiUrl: fetched with the auth header on the same origin only; the secret never comes back', async () => {
    apiRespond = (req) => (req.url === '/openapi.json' ? { status: 200, body: JSON.stringify(SPEC) } : { status: 404 });
    await register(tracker({ openapi: undefined, openapiUrl: `${api.origin}/openapi.json` }));
    expect(api.seen[0]?.headers['authorization']).toBe(`Bearer ${secret}`);
    // A document on another origin is fetched WITHOUT the secret.
    other.server.removeAllListeners('request');
    other.server.on('request', (req: IncomingMessage, res) => {
      other.seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      res.writeHead(200, { 'content-type': 'application/yaml' });
      res.end('openapi: 3.1.0\ninfo: {title: Y, version: "1"}\npaths:\n  /ping:\n    get: {operationId: ping}\n');
    });
    const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: tracker({ name: 'yaml', openapi: undefined, openapiUrl: `${other.origin}/spec.yaml` }) });
    expect(res.statusCode, res.body).toBe(200);
    expect(other.seen[0]?.headers['authorization']).toBeUndefined();
    expect((res.json() as McpPreviewResponse).tools.map((t) => t.name)).toEqual(['ping']);
    for (const text of [...answered, ...logs, readFileSync(join(base, 'state', 'mcp', 'registry.json'), 'utf8')]) expect(text).not.toContain(secret);
  });

  it('the config schema: a rest server needs a clean base url and exactly one of openapiUrl / openapi', async () => {
    const cases: Array<Record<string, unknown>> = [
      tracker({ url: 'ftp://x.example' }),
      tracker({ url: 'https://u:p@x.example' }),
      tracker({ url: 'https://x.example/?q=1' }),
      tracker({ openapiUrl: 'https://x.example/o.json' }),
      tracker({ openapi: undefined }),
      tracker({ auth: { ref: 'env:TOKEN', env: 'TOKEN' } }),
      tracker({ command: 'node' }),
      { name: 'm', kind: 'mcp-http', url: 'https://x.example/mcp', openapiUrl: 'https://x.example/o.json' },
    ];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('the broker over a REST tool', () => {
  it('a read tool is retried on 503; a write tool never is; a 4xx is the tool\'s own error result', async () => {
    await register(tracker());
    let n = 0;
    apiRespond = () => (++n <= 2 ? { status: 503 } : { status: 200, body: '{"ok":true}' });
    const read = await mcpCall('mcp:tracker/getIssue', { id: '1' });
    expect(read.body.outcome).toBe('ok');
    expect(api.seen).toHaveLength(3);
    expect(recorded().at(-1)?.attrs.retries).toBe(2);

    n = 0;
    api.seen.length = 0;
    const write = await mcpCall('mcp:tracker/createIssue', { title: 't' });
    expect(write.body.outcome).toBe('upstream_error');
    expect(api.seen).toHaveLength(1);

    apiRespond = () => ({ status: 404, body: '{"error":"no such issue"}' });
    const missing = await mcpCall('mcp:tracker/getIssue', { id: 'nope' });
    expect(missing.body.outcome).toBe('ok');
    expect(missing.body.result?.['isError']).toBe(true);
    expect(recorded().at(-1)?.status.errorClass).toBe('tool_error');
  });

  it('the secret the API echoes comes back scrubbed', async () => {
    await register(tracker());
    apiRespond = (req) => ({ status: 200, body: JSON.stringify({ echoed: String(req.headers['authorization']) }) });
    const r = await mcpCall('mcp:tracker/getIssue', { id: '1' });
    expect(JSON.stringify(r.body)).not.toContain(secret);
    expect(JSON.stringify(r.body)).toContain(SECRET_REDACTION);
    expect(gate.calls[0]).toMatchObject({ kind: 'rest', registered: true, annotations: { readOnlyHint: true } });
  });

  it('a changed mapping sends the tool back to unregistered until it is saved again (D-5)', async () => {
    await register(tracker());
    const changed = JSON.parse(JSON.stringify(SPEC)) as typeof SPEC;
    (changed.paths['/issues/{id}'].get.parameters as unknown[]).push({ name: 'fields', in: 'query', schema: { type: 'string' } });
    // Re-point the registered server at a document with one more query parameter, via openapiUrl.
    apiRespond = (req) => (req.url === '/openapi.json' ? { status: 200, body: JSON.stringify(changed) } : { status: 200, body: '{}' });
    await registry['deps'].store.mutate((file) => {
      const s = file.servers.find((x) => x.name === 'tracker')!;
      s.openapi = null;
      s.openapiUrl = `${api.origin}/openapi.json`;
    });
    const t = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/tracker/test' });
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json()).toMatchObject({ ok: true, diff: { changed: ['getIssue'] } });
    const r = await mcpCall('mcp:tracker/getIssue', { id: '1', fields: 'x' });
    expect(r.body.outcome).toBe('denied');
    expect(api.seen.filter((s) => s.url.startsWith('/v1/'))).toHaveLength(0);
  });
});
