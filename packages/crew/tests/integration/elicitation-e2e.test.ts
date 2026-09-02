// Integration test: ACP elicitation END-TO-END through the daemon (crew#357 / crew#358).
//
// The full wire, no layer skipped and no LLM anywhere:
//   stub ACP agent raises `elicitation/create`
//     → REAL engine (Core.spawn — acp_runner registers it, emits `elicitationCreated`)
//     → daemon event fan-out caches the prompt (ElicitationCache) + relays the frame to /ws
//     → GET  /api/v1/runs/:id/elicitation surfaces the question a human can answer
//     → POST /api/v1/runs/:id/elicitation forwards the answer via the (previously stubbed,
//       now wired) CoreAdapter.resolveElicitation NAPI binding
//     → the engine delivers the resolution to the suspended turn
//     → the stub agent RECEIVES the human's answer, echoes it into its transcript, ends
//       the turn, and the run completes.
//
// Determinism: the "agent" is a scripted node process (the mock-ACP pattern from
// packages/agent-acp-bridges/tests and wicked-core's own DES-002 T5 mocks) registered as a
// user CLI in a scratch $HOME's ~/.config/wicked-council/clis.toml. The registry key is
// `codex-acp` — one of the engine's ELICITATION_VERIFIED_ADAPTERS keys — because the engine
// allow-lists which adapters may suspend a turn on an elicitation (OQ-R-6); any other key
// would get the elicitation auto-cancelled rather than surfaced. A single-seat roster means
// no council convenes (FINDING-010) and a single-phase registered workflow means no LLM
// planning — the whole run is offline and deterministic.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

interface Frame {
  type: string;
  session?: string;
  elicitationId?: string;
  message?: string;
  options?: string[] | null;
  action?: string;
  reason?: string;
  [k: string]: unknown;
}

const RUN_ID = 'it-elicit-run-1';
const WORKFLOW_ID = 'elicit-e2e-wf';
/** MUST be an engine ELICITATION_VERIFIED_ADAPTERS key — see the header. */
const CLI_KEY = 'codex-acp';

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let priorDeadletter: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let ws: WebSocket;

const frames: Frame[] = [];
const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }> = [];

function onFrame(f: Frame): void {
  frames.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w && w.pred(f)) {
      clearTimeout(w.timer);
      w.resolve(f);
      waiters.splice(i, 1);
    }
  }
}

function waitForFrame(pred: (f: Frame) => boolean, label: string, ms = 60000): Promise<Frame> {
  const found = frames.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out (${ms}ms) waiting for: ${label}`)), ms);
    waiters.push({ pred, resolve, timer });
  });
}

/**
 * The scripted ACP agent (stdio JSON-RPC): handshake, then on session/prompt it raises ONE
 * enum-constrained elicitation and BLOCKS until the resolution arrives. The received answer is
 * echoed into the transcript (`ELICIT-ANSWER:<answer>`) — the assertion that the human's
 * response actually reached the worker, not merely that the POST returned 200.
 */
const STUB_AGENT = `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const w = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
let promptId = null;
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    w({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, capabilities: {}, serverInfo: { name: 'stub-elicit', version: '0' } } });
  } else if (msg.method === 'session/new') {
    w({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'stub-elicit-session' } });
  } else if (msg.method === 'session/prompt') {
    promptId = msg.id;
    w({ jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create', params: {
      message: 'Ship the release?',
      requestedSchema: { type: 'object', required: ['response'], properties: { response: { type: 'string', enum: ['ship-it', 'hold-off'] } } },
    } });
  } else if (msg.id === 'elicit-1' && msg.method === undefined) {
    const r = msg.result ?? {};
    const answer = r.action === 'accept' ? String((r.content ?? {}).response ?? '') : '(' + String(r.action) + ')';
    w({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'stub-elicit-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ELICIT-ANSWER:' + answer } } } });
    w({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
});
rl.on('close', () => process.exit(0));
`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-elicit-e2e-'));

  // Scratch $HOME: the engine reads ~/.config/wicked-council/clis.toml per call, so pointing
  // HOME here both registers the stub CLI and keeps the whole run out of the operator's real
  // home. Restored in afterAll; safe because vitest runs each test file in its own process.
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  // crew#396: the engine's bus emit must never append to the operator's real store.
  priorDeadletter = process.env['WICKED_APPS_EMIT_DEADLETTER'];
  if (process.env['WICKED_APPS_EMIT_DEADLETTER'] === undefined) {
    process.env['WICKED_APPS_EMIT_DEADLETTER'] = join(dir, 'deadletter.ndjson');
  }

  // The stub agent script + its user-registry record. Since wicked-core#346, a seat only
  // advertises (and serves) elicitation when its ACP binary STEM is a verified adapter — so
  // the stub node binary is exposed through a symlink named `claude-agent-acp` (the engine
  // resolves the stem of the configured path; the link IS node, the script rides start_args).
  const agentPath = join(dir, 'stub-elicit-agent.mjs');
  writeFileSync(agentPath, STUB_AGENT);
  const verifiedShim = join(dir, 'claude-agent-acp');
  symlinkSync(process.execPath, verifiedShim);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    [
      '[[cli]]',
      `key = ${JSON.stringify(CLI_KEY)}`,
      'display_name = "Stub Elicit Agent"',
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${agentPath} {PROMPT}`)}`,
      '',
      '[cli.acp]',
      `binary = ${JSON.stringify(verifiedShim)}`,
      `start_args = [${JSON.stringify(agentPath)}]`,
      'transport = "stdio"',
      '',
    ].join('\n'),
  );

  // REAL engine — stub: false. The stub engine has no ACP runner, so only the production
  // spawn exercises the elicitation path end-to-end.
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (data: Buffer | string) => {
    try {
      onFrame(JSON.parse(data.toString()) as Frame);
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}, 60000);

afterAll(async () => {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  await app.close();
  adapter.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  if (priorDeadletter === undefined) delete process.env['WICKED_APPS_EMIT_DEADLETTER'];
  else process.env['WICKED_APPS_EMIT_DEADLETTER'] = priorDeadletter;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('ACP elicitation end-to-end (real engine + scripted agent)', () => {
  it('registers the single-phase workflow', async () => {
    const res = await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: WORKFLOW_ID,
        phases: [
          {
            id: 'ask',
            kind: 'build',
            gate_type: null,
            gate: 'auto',
            executes_code: false,
            verified_evidence: false,
            required_deliverables: [],
            depends_on: [],
            role: 'neutral',
            skill_ref: null,
            allowed_skills: [],
            validator_pin: null,
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
  });

  it('launches the run on the single-seat stub roster', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Ask the operator whether to ship',
        sessionId: RUN_ID,
        workflow: WORKFLOW_ID,
        entityMode: 'shared',
        clisJson: JSON.stringify([
          {
            key: CLI_KEY,
            display_name: 'Stub Elicit Agent',
            binary: process.execPath,
            // Matches the clis.toml registration above — the run stays on the ACP transport,
            // but the seat record must not contradict what the registry advertises.
            headless_invocation: `${process.execPath} ${join(dir, 'stub-elicit-agent.mjs')} {PROMPT}`,
          },
        ]),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe(RUN_ID);
  });

  it('the elicitation surfaces: elicitationCreated on /ws and the prompt on GET', async () => {
    const created = await waitForFrame(
      (f) => f.type === 'elicitationCreated' && f.session === RUN_ID,
      'elicitationCreated',
    );
    expect(typeof created.elicitationId).toBe('string');
    expect(created.message).toBe('Ship the release?');
    expect(created.options).toEqual(['ship-it', 'hold-off']);

    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; elicitationId: string; message: string; options: string[] };
    expect(body.runId).toBe(RUN_ID);
    expect(body.elicitationId).toBe(created.elicitationId);
    expect(body.message).toBe('Ship the release?');
    expect(body.options).toEqual(['ship-it', 'hold-off']);
  });

  it('rejects a stale elicitationId (409) and an out-of-enum answer (400) without losing the prompt', async () => {
    const stale = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elicitationId: 'e-not-current', action: 'accept', content: { response: 'ship-it' } }),
    });
    expect(stale.status).toBe(409);

    const current = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`)).json()) as {
      elicitationId: string;
    };
    const offEnum = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elicitationId: current.elicitationId, action: 'accept', content: { response: 'maybe' } }),
    });
    expect(offEnum.status).toBe(400);

    // Neither rejection may consume the prompt — the human still has to answer.
    const after = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`);
    expect(after.status).toBe(200);
  });

  it('a syntactically invalid JSON body is the CLIENT error (400, never 500) and the prompt stands', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);

    const after = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`);
    expect(after.status).toBe(200);
  });

  it('the human answer routes back to the agent and the run completes', async () => {
    const current = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`)).json()) as {
      elicitationId: string;
    };
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        elicitationId: current.elicitationId,
        action: 'accept',
        content: { response: 'ship-it' },
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('resolved');

    // LOUD terminal record on the event stream: resolved by a human, action accept.
    const resolved = await waitForFrame(
      (f) => f.type === 'elicitationResolved' && f.session === RUN_ID,
      'elicitationResolved',
    );
    expect(resolved.action).toBe('accept');
    expect(resolved.reason).toBe('human');

    await waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN_ID, 'sessionCompleted');
  }, 90000);

  it('the answer REACHED the worker: its transcript carries the echoed response', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/units/ask/output`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string | null };
    expect(body.output).toContain('ELICIT-ANSWER:ship-it');
  });

  it('the prompt is gone after resolution: GET answers 404, POST answers 409', async () => {
    const get = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`);
    expect(get.status).toBe(404);

    const post = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/elicitation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elicitationId: 'e-gone', action: 'cancel' }),
    });
    expect(post.status).toBe(409);
  });
});
