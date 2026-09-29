// DES-MCP-TOOLS-001 slice S4, the proving test: shim → broker END TO END on a real governed unit of
// each carrier, through crew's REAL engine seam (`stub: false`).
//
// A build → review run on two seats: the build (a CREATOR) lands on a WRAPPED seat (codex's carrier:
// one process per unit, `headless_invocation`), the review (an EVALUATOR) on an ACP seat (pi's
// carrier: a long-lived `session/prompt` process). Each worker does exactly what the garden shim
// (`wicked-garden run scripts/mcp/shim.py list|call`) does: it reads `WICKED_MCP_TOKEN` and
// `WICKED_CREW_URL` from the environment the ENGINE handed it, lists its tools
// (`POST /api/v1/mcp/tools`) and calls a read and a destructive tool (`POST /api/v1/mcp/call`).
// With `WICKED_GARDEN_SHIM` pointing at a garden checkout's `scripts/mcp/shim.py`, the workers run
// that script itself (CI has no garden checkout; the shim's own suite is garden
// tests/mcp/test_mcp_shim.py).
//
// Pinned:
//   - core armed both units with a token and this daemon's URL, and the token resolves to THAT unit
//     (the list's `unit.seat` / `unit.phase`);
//   - the creator's list offers the destructive tool, and its call runs (autonomous mode, the
//     server approved for first use);
//   - the evaluator's list never offers it, and its call is denied by `engine:mcp-phase-role`
//     (D-1: evaluator ≠ creator) without reaching the server; its read call runs;
//   - every call is recorded with `wicked.carrier: shim` and the seat that made it (D-3).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { McpCallRecord } from '../../src/core/types.js';
import { mcpStateDir } from '../../src/mcp/registry-store.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const CALL_SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp', 'call-server.mjs');
const RUN_ID = 'it-mcp-shim-e2e-1';
const WORKFLOW_ID = 'mcp-shim-e2e-wf';
const WRAPPED_SEAT = 'codex-shim';
const ACP_SEAT = 'pi-shim';
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * The shim's two requests, as one module both workers import: `list`, then a read call and a
 * destructive call. Each result lands in `<out>/<label>-<pid>-<n>.json` (never the token).
 */
const SHIM_CLIENT = `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
let n = 0;
async function post(path, body) {
  const res = await fetch(process.env.WICKED_CREW_URL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
function shim(args) {
  const r = spawnSync('python3', [process.env.WICKED_GARDEN_SHIM, ...args], { encoding: 'utf8' });
  return { status: r.status, body: JSON.parse(r.stdout) };
}
export async function useMcp(out, label) {
  const token = process.env.WICKED_MCP_TOKEN;
  const armed = { token: typeof token === 'string' && token.startsWith('wmt_'), url: typeof process.env.WICKED_CREW_URL === 'string' };
  const result = { label, armed, viaGardenShim: Boolean(process.env.WICKED_GARDEN_SHIM) };
  if (armed.token && armed.url) {
    const call = (subject) => result.viaGardenShim
      ? shim(['call', subject, '--args', JSON.stringify({ text: 'hi' })])
      : post('/api/v1/mcp/call', { token, subject, args: { text: 'hi' } });
    result.list = result.viaGardenShim ? shim(['list']) : await post('/api/v1/mcp/tools', { token });
    result.read = await call('mcp:fx/wt_echo');
    result.destructive = await call('mcp:fx/wt_note');
  }
  n += 1;
  writeFileSync(join(out, label + '-' + process.pid + '-' + n + '.json'), JSON.stringify(result));
  return result;
}
`;

/** The wrapped seat's CLI: one process per unit. */
const WRAPPED_CLI = (client: string, out: string): string => `
import { useMcp } from ${JSON.stringify(client)};
await useMcp(${JSON.stringify(out)}, 'wrapped');
process.stdout.write('WRAPPED-UNIT-DONE: listed and called the MCP tools through the broker. ' + 'x'.repeat(240) + '\\n');
`;

/** The ACP seat's agent: on each prompt it uses the tools, then ends the turn. */
const ACP_AGENT = (client: string, out: string): string => `
import { createInterface } from 'node:readline';
import { useMcp } from ${JSON.stringify(client)};
const rl = createInterface({ input: process.stdin });
const w = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    w({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, capabilities: {}, serverInfo: { name: 'mcp-shim-agent', version: '0' } } });
  } else if (msg.method === 'session/new') {
    w({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'mcp-shim-session' } });
  } else if (msg.method === 'session/prompt') {
    await useMcp(${JSON.stringify(out)}, 'acp');
    w({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mcp-shim-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP-UNIT-DONE: VERDICT: PASS. listed and called the MCP tools through the broker. ' + 'x'.repeat(240) } } } });
    w({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
rl.on('close', () => process.exit(0));
`;

interface Answer {
  /** The HTTP status, or the garden shim's exit code when the worker ran the shim. */
  status: number;
  body: Record<string, unknown>;
}
interface WorkerResult {
  label: 'wrapped' | 'acp';
  armed: { token: boolean; url: boolean };
  viaGardenShim: boolean;
  list?: Answer;
  read?: Answer;
  destructive?: Answer;
}

let dir: string;
let home: string;
let out: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let priorCrewUrl: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let results: WorkerResult[] = [];
let settledStatus = '';

async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function phase(id: string, kind: 'build' | 'review', role: 'creator' | 'evaluator', dependsOn: string[]): Record<string, unknown> {
  return {
    id,
    kind,
    gate_type: null,
    gate: 'auto',
    executes_code: false,
    verified_evidence: false,
    required_deliverables: [],
    depends_on: dependsOn,
    role,
    skill_ref: null,
    allowed_skills: [],
    validator_pin: null,
  };
}

function readResults(): WorkerResult[] {
  return readdirSync(out)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')) as WorkerResult);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-mcp-shim-e2e-'));
  home = join(dir, 'home');
  out = join(dir, 'out');
  mkdirSync(out);
  mkdirSync(join(dir, 'counters'));
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  priorCrewUrl = process.env['WICKED_CREW_URL'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  const client = join(dir, 'shim-client.mjs');
  writeFileSync(client, SHIM_CLIENT);
  const wrappedCli = join(dir, 'wrapped-cli.mjs');
  writeFileSync(wrappedCli, WRAPPED_CLI(client, out));
  const acpAgent = join(dir, 'acp-agent.mjs');
  writeFileSync(acpAgent, ACP_AGENT(client, out));
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    [
      '[[cli]]',
      `key = ${JSON.stringify(WRAPPED_SEAT)}`,
      'display_name = "Wrapped shim seat"',
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${wrappedCli} {PROMPT}`)}`,
      '',
      '[[cli]]',
      `key = ${JSON.stringify(ACP_SEAT)}`,
      'display_name = "ACP shim seat"',
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${wrappedCli} {PROMPT}`)}`,
      '',
      '[cli.acp]',
      `binary = ${JSON.stringify(process.execPath)}`,
      `start_args = [${JSON.stringify(acpAgent)}]`,
      'transport = "stdio"',
      // Keep the read-only review unit on ACP (wicked-core#433): the engine holds the seat
      // read-only through `session/request_permission`; this agent asks for no native tool.
      'acp_input_governance = true',
      '',
    ].join('\n'),
  );

  // The engine's db in a directory of its own: its parent is the daemon's state home, and the
  // fixtures above must not sit inside it (the state-home registry would flag each one).
  mkdirSync(join(dir, 'state'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'state', 'core.db'), stub: false });
  baseSkillOff();
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  // What `startServer` does after listening: the engine hands each governed worker this URL.
  process.env['WICKED_CREW_URL'] = baseUrl;

  // Register the fixture server (preview → save) and approve its first use, as the operator does.
  const preview = await postJson('/api/v1/mcp/servers/preview', {
    name: 'fx',
    kind: 'mcp-stdio',
    command: process.execPath,
    args: [CALL_SERVER, join(dir, 'counters')],
    auth: null,
  });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const saved = await postJson('/api/v1/mcp/servers', { previewHash: preview.body['previewHash'] });
  expect(saved.status, JSON.stringify(saved.body)).toBeLessThan(300);
  const approved = await postJson('/api/v1/mcp/approvals', { subject: 'mcp:fx' });
  expect(approved.status, JSON.stringify(approved.body)).toBeLessThan(300);

  const wf = await postJson('/api/v1/workflows', {
    id: WORKFLOW_ID,
    phases: [phase('build', 'build', 'creator', []), phase('review', 'review', 'evaluator', ['build'])],
  });
  expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);

  const seat = (key: string): Record<string, unknown> => ({
    key,
    display_name: key,
    binary: process.execPath,
    headless_invocation: `${process.execPath} ${wrappedCli} {PROMPT}`,
  });
  const launch = await postJson('/api/v1/runs', {
    problem: 'Look up the fixture through the MCP tools, then review that lookup.',
    sessionId: RUN_ID,
    workflow: WORKFLOW_ID,
    entityMode: 'shared',
    clisJson: JSON.stringify([seat(WRAPPED_SEAT), seat(ACP_SEAT)]),
  });
  expect(launch.status, JSON.stringify(launch.body)).toBe(201);

  // Follow the run until both units have used the tools and the run is at rest.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}`);
    const body = (await res.json()) as { run?: { session: Record<string, unknown> } };
    settledStatus = String(body.run?.session['status'] ?? '');
    results = readResults();
    const both = results.some((r) => r.label === 'wrapped') && results.some((r) => r.label === 'acp');
    if (both && (TERMINAL.has(settledStatus) || settledStatus === 'awaiting_human')) break;
    if (Date.now() > deadline) throw new Error(`the run never used the tools on both seats; status ${settledStatus}, results ${JSON.stringify(results)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 180_000);

afterAll(async () => {
  await app?.close();
  adapter?.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  if (priorCrewUrl === undefined) delete process.env['WICKED_CREW_URL'];
  else process.env['WICKED_CREW_URL'] = priorCrewUrl;
  removeScratch(dir);
});

const subjectsOf = (r: WorkerResult): string[] =>
  ((r.list?.body['tools'] as Array<{ subject: string }> | undefined) ?? []).map((t) => t.subject);

describe('PROVING (S4): shim → broker end to end on a wrapped and an ACP unit', () => {
  it('the creator on the WRAPPED seat is armed, lists the destructive tool and calls it', () => {
    const wrapped = results.find((r) => r.label === 'wrapped');
    expect(wrapped?.armed, JSON.stringify(wrapped)).toEqual({ token: true, url: true });
    expect(wrapped?.list?.status).toBe(wrapped?.viaGardenShim ? 0 : 200);
    expect(wrapped?.list?.body['unit']).toMatchObject({ runId: RUN_ID, seat: WRAPPED_SEAT });
    expect(subjectsOf(wrapped!)).toEqual(expect.arrayContaining(['mcp:fx/wt_echo', 'mcp:fx/wt_note']));
    expect(wrapped?.read?.body).toMatchObject({ outcome: 'ok', subject: 'mcp:fx/wt_echo' });
    expect(wrapped?.destructive?.body).toMatchObject({ outcome: 'ok', subject: 'mcp:fx/wt_note' });
    expect(JSON.stringify(wrapped?.destructive?.body['result'])).toContain('noted');
  });

  it('the evaluator on the ACP seat never sees the destructive tool, and its call is denied by the engine', () => {
    const acp = results.filter((r) => r.label === 'acp');
    expect(acp.length).toBeGreaterThan(0);
    for (const r of acp) {
      expect(r.armed, JSON.stringify(r)).toEqual({ token: true, url: true });
      expect(r.list?.status).toBe(r.viaGardenShim ? 0 : 200);
      expect(r.list?.body['unit']).toMatchObject({ runId: RUN_ID, seat: ACP_SEAT });
      expect(subjectsOf(r)).toContain('mcp:fx/wt_echo');
      expect(subjectsOf(r), 'an evaluator is never offered a write').not.toContain('mcp:fx/wt_note');
      expect(r.read?.body).toMatchObject({ outcome: 'ok' });
      expect(r.destructive?.status).toBe(r.viaGardenShim ? 3 : 403);
      expect(r.destructive?.body).toMatchObject({ outcome: 'denied', denied: true, ruleIds: ['engine:mcp-phase-role'] });
    }
    // The denied write never reached the server: only the creator's call is counted.
    const noted = join(dir, 'counters', 'wt_note.count');
    expect(existsSync(noted) ? readFileSync(noted, 'utf8').trim().split('\n').length : 0).toBe(1);
  });

  it('every call is recorded with the shim carrier and the seat that made it', () => {
    const file = join(mcpStateDir(), 'calls.ndjson');
    const records = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as McpCallRecord);
    const calls = results.filter((r) => r.read !== undefined).length * 2;
    expect(records).toHaveLength(calls);
    for (const rec of records) expect(rec.attrs['wicked.carrier']).toBe('shim');
    expect(records.find((r) => r.attrs['wicked.seat'] === ACP_SEAT && r.attrs['mcp.subject'] === 'mcp:fx/wt_note')?.decision).toMatchObject({
      decision: 'deny',
      by: 'engine:mcp-phase-role',
    });
    expect(records.find((r) => r.attrs['wicked.seat'] === WRAPPED_SEAT && r.attrs['mcp.subject'] === 'mcp:fx/wt_note')?.outcome).toBe('ok');
  });
});
