// Integration test: `kill -9` on an ACP worker MID-TURN must never wedge the run or the
// daemon's ACP client (crew#340).
//
// The evidenced failure (run a8b3e548, filed off crew#288): SIGKILLing a worker left the
// unit neither failed nor retried and — worse — `session/new` for later runs never
// succeeded again until the daemon itself was restarted. This test drives the REAL engine
// (Core.spawn, no stub) with a scripted ACP agent and proves the whole recovery chain:
//
//   1. a run's ACP turn is genuinely IN FLIGHT (the stub streamed a delta and then hung),
//   2. the test delivers a REAL `kill -9` to the worker process,
//   3. the engine notices (reader-thread disconnect), resolves the unit LOUDLY — an
//      `acpFallback` frame with `fallbackKind: "session_died"` and a reason naming the
//      CLI — and re-executes the unit on the single-shot fallback path,
//   4. the run reaches a TERMINAL state (completed) within the watchdog window — it
//      never sits forever,
//   5. and a SECOND run launched afterwards gets a fresh, working `session/new`
//      (acpSessionStarted + a clean ACP turn, zero acpFallback frames) — the daemon's
//      ACP client is NOT wedged.
//
// Deterministic + offline: the "worker" is a scripted node process registered as a user
// CLI in a scratch $HOME's ~/.config/wicked-council/clis.toml (the elicitation-e2e
// pattern); its single-shot `headless_invocation` twin completes immediately, so the
// fallback path needs no LLM either.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

interface Frame {
  type: string;
  session?: string;
  ord?: number;
  text?: string;
  cliKey?: string;
  reason?: string;
  fallbackKind?: string;
  [k: string]: unknown;
}

const RUN_1 = 'it-bridge-kill-run-1';
const RUN_2 = 'it-bridge-kill-run-2';
const WORKFLOW_ID = 'bridge-kill-wf';
const CLI_KEY = 'codex-acp';

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let ws: WebSocket;
let pidFile: string;
let completeFlag: string;
let agentPath: string;
let fallbackPath: string;

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

function waitForFrame(pred: (f: Frame) => boolean, label: string, ms = 90_000): Promise<Frame> {
  const found = frames.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise<Frame>((resolve, reject) => {
    const waiter = { pred, resolve, timer: undefined as unknown as NodeJS.Timeout };
    waiter.timer = setTimeout(() => {
      // A timed-out waiter leaves the list — a later matching frame must not "resolve" a
      // promise that already rejected, and stale entries must not leak across the file.
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error(`timed out (${ms}ms) waiting for: ${label}`));
    }, ms);
    waiters.push(waiter);
  });
}

/**
 * The scripted ACP worker. Handshakes normally; on session/prompt it records its pid,
 * streams one delta (proof the turn is in flight), then either
 *   - HANGS (no result frame — the mid-turn window the test kills into), or
 *   - completes with end_turn, when the `completeFlag` file exists (run 2's mode).
 */
const STUB_AGENT = `
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';
const [pidFile, completeFlag] = process.argv.slice(2);
const rl = createInterface({ input: process.stdin });
const w = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
writeFileSync(pidFile, String(process.pid));
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    w({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, capabilities: {}, serverInfo: { name: 'stub-kill', version: '0' } } });
  } else if (msg.method === 'session/new') {
    w({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'stub-kill-session' } });
  } else if (msg.method === 'session/prompt') {
    w({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'stub-kill-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'TURN-IN-FLIGHT' } } } });
    if (existsSync(completeFlag)) {
      w({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'stub-kill-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP-TURN-COMPLETED: ' + 'x'.repeat(240) } } } });
      w({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
    // else: hang — the reply never comes; the test kill -9s this process mid-turn.
  }
});
rl.on('close', () => process.exit(0));
`;

/** The single-shot fallback twin: prints a substantive line and exits 0. */
const FALLBACK_CLI = `
process.stdout.write('FALLBACK-COMPLETED: recovered after worker death. ' + 'x'.repeat(240) + '\\n');
`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-bridge-kill-'));
  pidFile = join(dir, 'stub-worker.pid');
  completeFlag = join(dir, 'complete-turns.flag');

  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  agentPath = join(dir, 'stub-kill-agent.mjs');
  writeFileSync(agentPath, STUB_AGENT);
  fallbackPath = join(dir, 'fallback-cli.mjs');
  writeFileSync(fallbackPath, FALLBACK_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    [
      '[[cli]]',
      `key = ${JSON.stringify(CLI_KEY)}`,
      'display_name = "Stub Kill Agent"',
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${fallbackPath} {PROMPT}`)}`,
      '',
      '[cli.acp]',
      `binary = ${JSON.stringify(process.execPath)}`,
      `start_args = [${JSON.stringify(agentPath)}, ${JSON.stringify(pidFile)}, ${JSON.stringify(completeFlag)}]`,
      'transport = "stdio"',
      '',
    ].join('\n'),
  );

  // REAL engine — stub: false. The stub engine has no ACP runner; only the production
  // spawn exercises the session cache, the reader-thread death detection, and the
  // single-shot fallback under test.
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
}, 60_000);

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
  removeScratch(dir);
});

async function launchRun(sessionId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem: 'Do one unit of work on the stub seat',
      sessionId,
      workflow: WORKFLOW_ID,
      entityMode: 'shared',
      clisJson: JSON.stringify([
        {
          key: CLI_KEY,
          display_name: 'Stub Kill Agent',
          binary: process.execPath,
          headless_invocation: `${process.execPath} ${fallbackPath} {PROMPT}`,
        },
      ]),
    }),
  });
  expect(res.status).toBe(201);
}

describe('kill -9 of an ACP worker mid-turn (crew#340)', () => {
  it('registers the single-phase workflow', async () => {
    const res = await fetch(`${baseUrl}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: WORKFLOW_ID,
        phases: [
          {
            id: 'work',
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

  it('a REAL kill -9 mid-turn resolves the unit loudly and the run still terminates', async () => {
    await launchRun(RUN_1);

    // The turn is genuinely in flight: the ACP session opened and the stub streamed
    // its first delta from inside session/prompt.
    await waitForFrame((f) => f.type === 'acpSessionStarted' && f.session === RUN_1, 'run-1 acpSessionStarted');
    await waitForFrame(
      (f) => f.type === 'unitOutputDelta' && f.session === RUN_1 && (f.text ?? '').includes('TURN-IN-FLIGHT'),
      'run-1 mid-turn delta',
    );

    // The real kill. SIGKILL — no handler, no cleanup, exactly the field event.
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    process.kill(pid, 'SIGKILL');

    // LOUD resolution: a named fallback frame, not a silent stall. `session_died` is the
    // stable slug the diagnostics fold groups on — this is what makes the death
    // triage-eligible instead of invisible.
    const fallback = await waitForFrame(
      (f) => f.type === 'acpFallback' && f.session === RUN_1,
      'run-1 acpFallback after kill -9',
    );
    expect(fallback.fallbackKind).toBe('session_died');
    expect(fallback.cliKey).toBe(CLI_KEY);
    expect(fallback.reason ?? '').toContain(CLI_KEY);

    // The run reaches a terminal state well inside the watchdog window — the unit was
    // re-executed on the single-shot fallback path and completed. Never a wedge.
    await waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN_1, 'run-1 terminal', 120_000);

    const body = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_1}`)).json()) as {
      run: { session: { status: string } };
    };
    expect(body.run.session.status).toBe('completed');

    // The fallback's output is the unit's output — proof the re-execution really ran.
    const unit = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_1}/units/work/output`)).json()) as {
      output: string | null;
    };
    expect(unit.output ?? '').toContain('FALLBACK-COMPLETED');
  }, 180_000);

  it('the ACP client is NOT wedged: a later run gets a fresh, working session/new', async () => {
    // Run 2's turns complete normally — the stub sees the flag file.
    writeFileSync(completeFlag, '1');
    await launchRun(RUN_2);

    // The wedge crew#340 describes was exactly here: after the kill, session/new never
    // succeeded again until a daemon restart. A fresh acpSessionStarted plus a clean ACP
    // turn is the direct counter-evidence.
    await waitForFrame((f) => f.type === 'acpSessionStarted' && f.session === RUN_2, 'run-2 acpSessionStarted');
    await waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN_2, 'run-2 terminal', 120_000);

    expect(frames.filter((f) => f.type === 'acpFallback' && f.session === RUN_2)).toEqual([]);

    const unit = (await (await fetch(`${baseUrl}/api/v1/runs/${RUN_2}/units/work/output`)).json()) as {
      output: string | null;
    };
    expect(unit.output ?? '').toContain('ACP-TURN-COMPLETED');
  }, 180_000);
});
