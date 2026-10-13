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
//   3. the engine notices (reader-thread disconnect) and resolves the unit LOUDLY with an
//      `acpFallback` frame naming the CLI: an ungoverned unit (`session_died`) is re-executed
//      on the single-shot fallback path; a governed one (`governed_requires_acp`) is refused
//      and fails over to another seat (wicked-core#925),
//   4. the run reaches a TERMINAL state (completed) within the watchdog window — it
//      never sits forever,
//   5. and a SECOND run launched afterwards gets a fresh, working `session/new`
//      (acpSessionStarted + a clean ACP turn, zero acpFallback frames) — the daemon's
//      ACP client is NOT wedged.
//
// wicked-core#925 (crew#998) splits step 3 by whether the unit is GOVERNED. A governed unit on a
// seat admitted to ACP input governance (any seat but claude) must not fall back to the wrapped
// carrier, which arms no input governance for that seat: the engine refuses it
// (`fallbackKind: "governed_requires_acp"`) and the run fails the unit over to another seat. An
// UNGOVERNED unit (the store is `:memory:`, so the engine arms no input governance at all) still
// takes the single-shot fallback (`session_died` -> the fallback twin's output). Both branches are
// covered below, each on its own real engine.
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
import { registerDef } from '../support/register-def.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

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

const WORKFLOW_ID = 'bridge-kill-wf';
const CLI_KEY = 'codex-acp';
/** A plain single-shot seat (no ACP config): the governed run's failover target. */
const FAILOVER_KEY = 'stub-failover';

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let pidFile: string;
let completeFlag: string;
let agentPath: string;
let fallbackPath: string;
let failoverPath: string;

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

/** The failover seat's single-shot CLI: a different marker, so the test can tell who ran the unit. */
const FAILOVER_CLI = `
process.stdout.write('FAILOVER-COMPLETED: another seat took the refused unit. ' + 'x'.repeat(240) + '\\n');
`;

/** One real engine + daemon + /ws frame stream. `dbPath` decides governance: a file-backed SQLite
 *  store arms input governance for every unit, `:memory:` arms none. */
interface Harness {
  adapter: CoreAdapter;
  app: Awaited<ReturnType<typeof createServer>>;
  baseUrl: string;
  ws: WebSocket;
  frames: Frame[];
  waitForFrame(pred: (f: Frame) => boolean, label: string, ms?: number): Promise<Frame>;
  launchRun(sessionId: string, seats: Array<Record<string, string>>): Promise<void>;
  registerWorkflow(): Promise<void>;
  close(): Promise<void>;
}

async function startHarness(dbPath: string): Promise<Harness> {
  const frames: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }> = [];
  const onFrame = (f: Frame): void => {
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w && w.pred(f)) {
        clearTimeout(w.timer);
        w.resolve(f);
        waiters.splice(i, 1);
      }
    }
  };
  const waitForFrame = (pred: (f: Frame) => boolean, label: string, ms = 90_000): Promise<Frame> => {
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
  };

  // REAL engine — stub: false. The stub engine has no ACP runner; only the production
  // spawn exercises the session cache, the reader-thread death detection, and the
  // fallback/refusal under test.
  const adapter = new CoreAdapter({ dbPath, stub: false });
  baseSkillOff(); // run mechanics, not grounding — no published generation here (see tests/setup/base-skill-off.ts)
  const app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

  return {
    adapter,
    app,
    baseUrl,
    ws,
    frames,
    waitForFrame,
    async launchRun(sessionId, seats) {
      const res = await fetch(`${baseUrl}/api/v1/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problem: 'Do one unit of work on the stub seat',
          sessionId,
          workflow: WORKFLOW_ID,
          entityMode: 'shared',
          clisJson: JSON.stringify(seats),
        }),
      });
      expect(res.status).toBe(201);
    },
    async registerWorkflow() {
      const res = await registerDef(adapter, {
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
      });
      expect(res.status).toBe(201);
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      await app.close();
      adapter.close();
    },
  };
}

const stubSeat = (): Record<string, string> => ({
  key: CLI_KEY,
  display_name: 'Stub Kill Agent',
  binary: process.execPath,
  headless_invocation: `${process.execPath} ${fallbackPath} {PROMPT}`,
});
const failoverSeat = (): Record<string, string> => ({
  key: FAILOVER_KEY,
  display_name: 'Stub Failover',
  binary: process.execPath,
  headless_invocation: `${process.execPath} ${failoverPath} {PROMPT}`,
});

/** Waits until the stub's ACP turn is genuinely in flight, then delivers the real `kill -9`. */
async function killMidTurn(h: Harness, run: string): Promise<void> {
  // The turn is genuinely in flight: the ACP session opened and the stub streamed
  // its first delta from inside session/prompt.
  await h.waitForFrame((f) => f.type === 'acpSessionStarted' && f.session === run, `${run} acpSessionStarted`);
  await h.waitForFrame(
    (f) => f.type === 'unitOutputDelta' && f.session === run && (f.text ?? '').includes('TURN-IN-FLIGHT'),
    `${run} mid-turn delta`,
  );
  // The real kill. SIGKILL — no handler, no cleanup, exactly the field event.
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  process.kill(pid, 'SIGKILL');
}

async function unitOutput(h: Harness, run: string): Promise<string> {
  const unit = (await (await fetch(`${h.baseUrl}/api/v1/runs/${run}/units/work/output`)).json()) as {
    output: string | null;
  };
  return unit.output ?? '';
}

async function runStatus(h: Harness, run: string): Promise<string> {
  const body = (await (await fetch(`${h.baseUrl}/api/v1/runs/${run}`)).json()) as {
    run: { session: { status: string } };
  };
  return body.run.session.status;
}

beforeAll(() => {
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
  failoverPath = join(dir, 'failover-cli.mjs');
  writeFileSync(failoverPath, FAILOVER_CLI);
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
      // wicked-core#433 (F-3R2-009): an `executes_code: false` unit on an ACP seat NOT admitted to
      // input governance no longer starts an ACP turn — it is rerouted to the wrapped carrier
      // (`acpFallback {fallbackKind: "read_only_requires_wrapped"}`), which would take this stub off
      // the very transport under test. Admit it: the engine then holds the seat read-only by
      // answering write-class `session/request_permission` calls with the reject option — vacuous
      // here, the stub makes no tool calls — and the unit stays on ACP. Admission is also what
      // makes a GOVERNED unit's death a refusal rather than a fallback (wicked-core#925).
      'acp_input_governance = true',
      '',
      '[[cli]]',
      `key = ${JSON.stringify(FAILOVER_KEY)}`,
      'display_name = "Stub Failover"',
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${failoverPath} {PROMPT}`)}`,
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  removeScratch(dir);
});

describe('kill -9 of an ACP worker mid-turn, GOVERNED unit (crew#340, wicked-core#925)', () => {
  const RUN = 'it-bridge-kill-governed';
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness(join(dir, 'governed-core.db'));
    await h.registerWorkflow();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  it('refuses the single-shot fallback (governed_requires_acp) and fails the unit over to another seat', async () => {
    await h.launchRun(RUN, [stubSeat(), failoverSeat()]);
    await killMidTurn(h, RUN);

    // LOUD resolution, and a REFUSAL: the wrapped carrier arms no input governance for this
    // (non-claude, ACP-admitted) seat, so running the governed unit there would run it unchecked.
    const fallback = await h.waitForFrame(
      (f) => f.type === 'acpFallback' && f.session === RUN,
      'governed acpFallback after kill -9',
    );
    expect(fallback.fallbackKind).toBe('governed_requires_acp');
    expect(fallback.cliKey).toBe(CLI_KEY);
    expect(fallback.reason ?? '').toContain(CLI_KEY);

    // Never a wedge: the run still reaches a terminal state, on the OTHER seat.
    await h.waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN, 'governed run terminal', 120_000);
    expect(await runStatus(h, RUN)).toBe('completed');
    const out = await unitOutput(h, RUN);
    expect(out).toContain('FAILOVER-COMPLETED');
    // The stub seat's single-shot twin never ran: no unchecked fallback.
    expect(out).not.toContain('FALLBACK-COMPLETED');
    // The refusal reads as a seat failure, so the actor failed the unit over (a `stepFailed`
    // naming the next seat, then attempt 1 on it).
    const failed = h.frames.find((f) => f.type === 'stepFailed' && f.session === RUN);
    expect(String(failed?.['detail'] ?? '')).toContain(`failing over to '${FAILOVER_KEY}'`);
  }, 180_000);
});

describe('kill -9 of an ACP worker mid-turn, UNGOVERNED unit (crew#340)', () => {
  const RUN_1 = 'it-bridge-kill-run-1';
  const RUN_2 = 'it-bridge-kill-run-2';
  let h: Harness;
  let priorCwd: string;
  beforeAll(async () => {
    // `:memory:` — the engine arms no input governance for any unit (actor `in_process_governance`
    // is None), so the single-shot fallback is not refused. The engine still anchors its event log
    // to the store path (`<store>.events`, relative to the cwd for `:memory:`), so the block runs
    // from the scratch dir and that log is removed with it, never left in the package.
    priorCwd = process.cwd();
    process.chdir(dir);
    h = await startHarness(':memory:');
    await h.registerWorkflow();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
    process.chdir(priorCwd);
  });

  it('a REAL kill -9 mid-turn resolves the unit loudly and the run still terminates', async () => {
    await h.launchRun(RUN_1, [stubSeat()]);
    await killMidTurn(h, RUN_1);

    // LOUD resolution: a named fallback frame, not a silent stall. `session_died` is the
    // stable slug the diagnostics fold groups on — this is what makes the death
    // triage-eligible instead of invisible.
    const fallback = await h.waitForFrame(
      (f) => f.type === 'acpFallback' && f.session === RUN_1,
      'run-1 acpFallback after kill -9',
    );
    expect(fallback.fallbackKind).toBe('session_died');
    expect(fallback.cliKey).toBe(CLI_KEY);
    expect(fallback.reason ?? '').toContain(CLI_KEY);

    // The run reaches a terminal state well inside the watchdog window — the unit was
    // re-executed on the single-shot fallback path and completed. Never a wedge.
    await h.waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN_1, 'run-1 terminal', 120_000);
    expect(await runStatus(h, RUN_1)).toBe('completed');

    // The fallback's output is the unit's output — proof the re-execution really ran.
    expect(await unitOutput(h, RUN_1)).toContain('FALLBACK-COMPLETED');
  }, 180_000);

  it('the ACP client is NOT wedged: a later run gets a fresh, working session/new', async () => {
    // Run 2's turns complete normally — the stub sees the flag file.
    writeFileSync(completeFlag, '1');
    await h.launchRun(RUN_2, [stubSeat()]);

    // The wedge crew#340 describes was exactly here: after the kill, session/new never
    // succeeded again until a daemon restart. A fresh acpSessionStarted plus a clean ACP
    // turn is the direct counter-evidence.
    await h.waitForFrame((f) => f.type === 'acpSessionStarted' && f.session === RUN_2, 'run-2 acpSessionStarted');
    await h.waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN_2, 'run-2 terminal', 120_000);

    expect(h.frames.filter((f) => f.type === 'acpFallback' && f.session === RUN_2)).toEqual([]);
    expect(await unitOutput(h, RUN_2)).toContain('ACP-TURN-COMPLETED');
  }, 180_000);
});
