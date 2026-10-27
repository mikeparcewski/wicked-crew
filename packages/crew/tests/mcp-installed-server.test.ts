// PRODUCT-WORKS J6, the MCP leg: an MCP server that a /workflow-mcp-server run BUILT is installed the way garden's
// install.py installs it, and a worker USES it. The operator's complaint (2026-10-26) was "no tests that show the
// plugins being exercised": every other MCP test here talks to a hand-written fixture server.
//
// The server is the real artifact. tests/fixtures/mcp/unit-convert/ is the installed copy that
// `install.py --from-run` staged from the run's delivered tree (wicked-e2e-j6-plugins#2, run 306fae88,
// commit 9e27bf4): its tsc output (`built/`, which is `dist/` in the install; `dist/` is gitignored here),
// package.json, the package-lock.json the install resolved, tools.json and mcp-server.config.json. It is a
// fastmcp + OpenTelemetry server with two read tools, convert_length and convert_temperature, and no credential.
//
// The install is replayed as install.py does it: the copy goes to <root>/unit-convert/current/,
// `npm ci --omit=dev --ignore-scripts` installs its runtime dependencies from the lock (this needs the npm
// registry, as crew's CI has for its own `npm ci`), and the registry gets exactly install.py's body:
// `{name, kind: "mcp-stdio", command: "node", args: [<current>/dist/server.js]}`, with no auth for a
// credential-free server. Then:
//   1. LISTED: GET /mcp/servers holds unit-convert, healthy, with both tools as `read` and their schemas;
//   2. USED: a worker's POST /mcp/call reaches the real server through the broker and gets real conversions
//      (5 km = 3.10685596119 mi; 100 C = 212 F); a temperature below absolute zero is the tool's own error.
//   3. USED FROM CHAT (crew#1155): a floating-chat turn's answer step names the installed tools and the broker command,
//      and the seat's call through that command (the shim's POST /mcp/call) returns the real conversion.
// The engine's gate is a fake (only core's carriers mint a capability token; tests/mcp-broker.test.ts says why).

import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { CHAT_MCP_SHIM } from '../src/api/chat-mcp.js';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpEngineGate } from '../src/core/adapter.js';
import type { McpCallResponse, McpPreviewResponse, McpServersResponse } from '../src/core/types.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { deriveToolClass } from '../src/mcp/classify.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { removeScratch } from './setup/scratch.js';

const ARTIFACT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'unit-convert');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// npm ci of the server's runtime dependencies (283 packages) on a cold cache, then a cold start of a
// fastmcp + OpenTelemetry server for the preview's probe.
const INSTALL_TIMEOUT_MS = 240_000;

/** A credential-free server reads no secret: any read is a bug. */
class NoSecrets implements SecretStore {
  readonly available = true;
  reads = 0;
  async get(): Promise<string | null> {
    this.reads += 1;
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

/** The engine's gate: allow a registered tool for the bound token (core's own tests judge real calls). */
class AllowGate implements McpEngineGate {
  async evaluateCall(requestJson: string): Promise<string> {
    const req = JSON.parse(requestJson) as { token: string; call: { server: string; tool: string; registered: boolean; annotations: Record<string, boolean> | null } };
    if (req.token !== 'wmt_unit') throw new Error('invalid_token: the MCP token is not bound to a running unit');
    const allow = req.call.registered;
    return JSON.stringify({
      decision: allow ? 'allow' : 'deny',
      subject: `mcp:${req.call.server}/${req.call.tool}`,
      class: deriveToolClass(req.call.annotations),
      ruleIds: allow ? [] : ['engine:mcp-unregistered'],
      obligations: [],
      ...(allow ? {} : { reason: 'unregistered', remedy: 'register it' }),
      claimId: `mcp-${allow ? 'allow' : 'deny'}:unit-3`,
      unit: { runId: 'run-j6', ord: 3, attempt: 0, phase: 'build', seat: 'claude' },
    });
  }
  async evaluateOutput(requestJson: string): Promise<string> {
    const req = JSON.parse(requestJson) as { call: { server: string; tool: string } };
    return JSON.stringify({ decision: 'allow', subject: `mcp:${req.call.server}/${req.call.tool}`, ruleIds: [] });
  }
}

let base: string;
let serverJs: string;
let secrets: NoSecrets;
let app: FastifyInstance;

async function api<T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method, url: `/api/v1${url}`, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
  return { status: res.statusCode, body: res.json() as T };
}

function textOf(r: McpCallResponse): string {
  return ((r.result?.['content'] as Array<{ type: string; text: string }> | undefined) ?? []).map((c) => c.text).join('\n');
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'crew-mcp-installed-'));
  // install.py's layout: <root>/<key>/current/{dist,package.json,package-lock.json,tools.json,mcp-server.config.json}.
  const current = join(base, 'mcp-servers', 'unit-convert', 'current');
  mkdirSync(dirname(current), { recursive: true });
  cpSync(ARTIFACT, current, { recursive: true });
  renameSync(join(current, 'built'), join(current, 'dist'));
  execFileSync(NPM, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: current,
    stdio: 'pipe',
    timeout: INSTALL_TIMEOUT_MS,
    shell: process.platform === 'win32',
  });
  serverJs = join(current, 'dist', 'server.js');

  secrets = new NoSecrets();
  const state = join(base, 'state', 'mcp');
  const registry = new McpRegistry({ store: new McpRegistryStore(state), secrets, probe: probeMcpServer, discover: () => [] });
  const broker = new McpBroker({ registry, engine: () => new AllowGate(), records: new McpCallRecordFile(state), sleep: async () => undefined, publish: () => undefined, log: () => undefined });
  app = Fastify({ logger: false });
  registerMcpRoutes(app, { registry, broker, audit: new AuditLog(join(base, 'audit.log'), () => undefined), actorOf: () => LOCAL_ACTOR });
  await app.ready();

  // install.py smokes the staged server before it registers (probe.py, 30 s); this is that warm start, so the
  // preview's 10 s probe meets a server whose modules are already in the page cache, as it does after a real
  // install. (A cold first start under heavy load can exceed 10 s: j6-cert saw one at load ~118.)
  await probeMcpServer({ name: 'unit-convert', kind: 'mcp-stdio', command: 'node', args: [serverJs], url: null, auth: null }, null).catch(() => undefined);

  // install.py's register step, byte for byte: preview, then save the preview hash.
  const preview = await api<McpPreviewResponse>('POST', '/mcp/servers/preview', { name: 'unit-convert', kind: 'mcp-stdio', command: 'node', args: [serverJs] });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const saved = await api<{ name: string }>('POST', '/mcp/servers', { previewHash: preview.body.previewHash });
  expect(saved.status, JSON.stringify(saved.body)).toBe(201);
}, INSTALL_TIMEOUT_MS + 60_000);

afterAll(async () => {
  await app?.close();
  if (base) removeScratch(base);
});

describe('J6: the MCP server a /workflow-mcp-server run built, installed and used', () => {
  it('is listed with both of its tools, read-only, and their input schemas', async () => {
    const { status, body } = await api<McpServersResponse>('GET', '/mcp/servers');
    expect(status).toBe(200);
    const server = body.servers.find((s) => s.name === 'unit-convert');
    expect(server, JSON.stringify(body.servers.map((s) => s.name))).toBeDefined();
    expect(server).toMatchObject({ kind: 'mcp-stdio', command: 'node', args: [serverJs], auth: null, enabled: true });
    expect(server!.health.state).toBe('ok');
    const tools = server!.tools.map((t) => [t.name, t.class, t.enabled, t.status]);
    expect(tools.sort()).toEqual([
      ['convert_length', 'read', true, 'registered'],
      ['convert_temperature', 'read', true, 'registered'],
    ]);
    const length = server!.tools.find((t) => t.name === 'convert_length')!;
    expect(length.subject).toBe('mcp:unit-convert/convert_length');
    expect(Object.keys((length.inputSchema?.['properties'] as Record<string, unknown>) ?? {}).sort()).toEqual(['from', 'to', 'value']);
    expect(server!.counts).toMatchObject({ total: 2, enabled: 2, read: 2, write: 0, destructive: 0 });
  });

  it('answers a worker call through the broker with a real conversion', async () => {
    const km = await api<McpCallResponse>('POST', '/mcp/call', { token: 'wmt_unit', subject: 'mcp:unit-convert/convert_length', args: { value: 5, from: 'km', to: 'mi' } });
    expect(km.status, JSON.stringify(km.body)).toBe(200);
    expect(km.body.outcome).toBe('ok');
    expect(textOf(km.body)).toBe('5 km = 3.10685596119 mi');
    expect(km.body.result?.['structuredContent']).toEqual({ value: 3.10685596119 });

    const c = await api<McpCallResponse>('POST', '/mcp/call', { token: 'wmt_unit', subject: 'mcp:unit-convert/convert_temperature', args: { value: 100, from: 'C', to: 'F' } });
    expect(c.body.outcome).toBe('ok');
    expect(textOf(c.body)).toBe('100 C = 212 F');
  });

  it("returns the tool's own error for an impossible temperature, and never reads a secret", async () => {
    const r = await api<McpCallResponse>('POST', '/mcp/call', { token: 'wmt_unit', subject: 'mcp:unit-convert/convert_temperature', args: { value: -500, from: 'C', to: 'K' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.outcome).toBe('ok');
    expect(r.body.result?.['isError']).toBe(true);
    expect(textOf(r.body).toLowerCase()).toContain('absolute zero');
    expect(secrets.reads).toBe(0);
  });
});

// crew#1155: the chat seat's only native MCP tool is the engine's `ask`, so it must be TOLD what is installed and
// the one command that reaches it. This drives the real server assembly (createServer) over a fake engine: the
// operator installs unit-convert through the MCP routes, opens a floating chat, asks for a conversion; the answer
// step's instructions carry the tool and the shim command, and the fake seat runs exactly what the shim sends
// (`POST /api/v1/mcp/call {token, subject, args}`) through the daemon's broker to the real server.
describe('crew#1155: the floating chat uses the installed MCP server', () => {
  const armedStateHome = crewStateHome();
  let chatApp: FastifyInstance;
  const launches: LaunchRunInput[] = [];
  const proposals: Array<{ steps: Array<{ instructions: string }> }> = [];
  let seq = 0;
  let emit: (frame: CoreEvent) => void = () => undefined;

  beforeAll(async () => {
    const home = join(base, 'chat-state-home');
    mkdirSync(home, { recursive: true });
    setCrewStateHome(home);
    const listeners = new Set<(e: CoreEvent) => void>();
    emit = (frame) => {
      for (const l of listeners) l(frame);
    };
    const adapter = {
      dbPath: join(home, 'core.db'),
      projectsSupported: () => false,
      getSettings: async () => ({}),
      ping: async () => 'ok',
      onLaunch: (): (() => void) => () => undefined,
      onEvent: (l: (e: CoreEvent) => void): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      listRepos: async () => [],
      launchRun: async (input: LaunchRunInput) => {
        launches.push(input);
        return `run-chat-${++seq}`;
      },
      // Each path run waits at its answer step's turn gate.
      sessionsDetail: async () => launches.map((_, i) => ({
        session: { id: `run-chat-${i + 1}`, status: 'awaiting_human', repo_ref: null },
        units: [{ id: `run-chat-${i + 1}:answer-1`, ord: 1, status: 'done' }],
      })),
      workOutput: async () => '',
      proposePlan: async (_runId: string, plan: { steps: Array<{ instructions: string }> }) => {
        proposals.push(plan);
        return { ok: true };
      },
      confirmGate: async () => 'awaiting_human',
      cancelRun: async () => 'cancelled',
      chatClose: async () => undefined,
      chatList: async () => [],
      onboardedRepoOf: () => undefined,
    } as unknown as CoreAdapter;
    chatApp = await createServer(adapter, {
      auth: { mode: 'off' },
      seats: { signedIn: () => true },
      auditPath: join(base, 'chat-audit.log'),
      evalStoreRoot: join(base, 'chat-evals'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
      mcpEngineGate: () => new AllowGate(),
    });
    await chatApp.ready();
    // The operator's install, as install.py registers it: preview, then save.
    const preview = await chatApp.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: { name: 'unit-convert', kind: 'mcp-stdio', command: 'node', args: [serverJs] } });
    expect(preview.statusCode, preview.body).toBe(200);
    const saved = await chatApp.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: (preview.json() as McpPreviewResponse).previewHash } });
    expect(saved.statusCode, saved.body).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await chatApp?.close();
    setCrewStateHome(armedStateHome);
  });

  /** The answer step's instructions of the newest launch. */
  const lastInstructions = (): string =>
    (launches.at(-1)!.plan as unknown as { steps: Array<{ instructions: string }> }).steps[0]!.instructions;

  it("hands the chat turn the installed tools and the broker command, and the seat's call returns the tool's answer", async () => {
    const opened = await chatApp.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId: 'mcp-chat-1', clis: ['claude'], scopeKind: 'system' } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await chatApp.inject({
      method: 'POST',
      url: '/api/v1/chats/mcp-chat-1/messages',
      payload: { text: "Use unit-convert's convert_length to convert 5 km to miles and quote what it returned." },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const instructions = lastInstructions();
    // What is installed, each tool's class, and that they are not native tools.
    expect(instructions).toContain('## MCP tools installed on this daemon');
    expect(instructions).toContain('- `mcp:unit-convert/convert_length` (read)');
    expect(instructions).toContain('- `mcp:unit-convert/convert_temperature` (read)');
    expect(instructions).toContain('NOT native tools');
    // The one way to them: the shim's list and call, on the launcher every governed seat has.
    expect(instructions).toContain(`${CHAT_MCP_SHIM} list`);
    const call = new RegExp(`${CHAT_MCP_SHIM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} call (mcp:<server>/<tool>) --args`);
    expect(instructions).toMatch(call);
    // The operator's question still reaches the seat, after the block.
    expect(instructions.indexOf('## MCP tools installed')).toBeLessThan(instructions.indexOf('convert 5 km to miles'));

    // The seat follows the instructions: the subject it read, the arguments from the schema, and the request the
    // shim sends with its unit's token. The daemon's broker runs it on the real installed server.
    const subject = /- `(mcp:unit-convert\/convert_length)`/.exec(instructions)![1]!;
    const res = await chatApp.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_unit', subject, args: { value: 5, from: 'km', to: 'mi' } } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as McpCallResponse;
    expect(body.outcome).toBe('ok');
    expect(textOf(body)).toBe('5 km = 3.10685596119 mi');
  });

  it('carries the block on a follow-up turn too, and drops a server the operator disabled', async () => {
    const off = await chatApp.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/unit-convert', payload: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    const opened = await chatApp.inject({ method: 'POST', url: '/api/v1/chats', payload: { chatId: 'mcp-chat-2', clis: ['claude'], scopeKind: 'system' } });
    expect(opened.statusCode, opened.body).toBe(201);
    const sent = await chatApp.inject({ method: 'POST', url: '/api/v1/chats/mcp-chat-2/messages', payload: { text: 'What MCP tools can you use?' } });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(lastInstructions()).not.toContain('## MCP tools installed');
    const on = await chatApp.inject({ method: 'PATCH', url: '/api/v1/mcp/servers/unit-convert', payload: { enabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    // The follow-up on the first chat's path (an answer step proposed onto its run) names the tools again.
    emit({ type: 'chatReply', chat: 'mcp-chat-1', cliKey: 'claude', ok: true, text: '5 km = 3.10685596119 mi' } as unknown as CoreEvent);
    const follow = await chatApp.inject({ method: 'POST', url: '/api/v1/chats/mcp-chat-1/messages', payload: { text: 'And 100 C in F?' } });
    expect(follow.statusCode, follow.body).toBe(202);
    const next = proposals.at(-1)!.steps[0]!.instructions;
    expect(next).toContain('- `mcp:unit-convert/convert_temperature` (read)');
    expect(next).toContain(`${CHAT_MCP_SHIM} call mcp:<server>/<tool>`);
  });
});
