// The daemon's QE acceptance setting on the launches the ENGINE makes on its own, on the REAL engine
// (`stub: false`): campaign nodes (POST /campaigns → the engine's scheduler dispatches each node)
// and `wicked.crew.run.requested` bus requests (the engine's own bus bridge launches them). Neither
// passes through `CoreAdapter.launchRun`, so crew hands the setting to the engine
// (`Core.setQeAcceptanceOff`) with every settings read. With `qeAcceptance: 'off'`, a node or request
// that gives no QE word of its own and whose contract requires QE acceptance persists the engine's
// skip with the setting's reason; one that does not require it gets no decision (never a refusal);
// a request's own `force_qe_acceptance` still requires it; and back on `required`, nothing is skipped.
//
// Requires an addon carrying `setQeAcceptanceOff` (wicked-core after core-ts 0.11.0); on an older
// addon this file SKIPS. To run it against a local engine: `node scripts/use-local-core-ts.mjs`
// (workspace root), then `npx vitest run` this file.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, settingsFilePath } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { emitOnBus } from '../../src/core/bus.js';
import { qeDecisionBypasses, qeDecisionOf } from '../../src/api/delivery-assurance.js';
import { QE_OFF_REASON } from '../../src/core/qe-acceptance-setting.js';
import type { SessionView } from '../../src/core/types.js';
import { registerDef } from '../support/register-def.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';
import { quiesceCampaign } from '../setup/quiesce.js';

// Presence-gated at COLLECTION time: napi class methods live on the prototype.
const require = createRequire(import.meta.url);
const { Core } = require('wicked-core-ts') as { Core: { prototype: Record<string, unknown>; registryRoster(): string } };
const supported = typeof Core.prototype['setQeAcceptanceOff'] === 'function' && typeof Core.prototype['launchCampaign'] === 'function';

const QE_WF = 'qe-engine-e2e-qe-wf';
const PLAIN_WF = 'qe-engine-e2e-plain-wf';
const SEATS = ['alpha', 'beta'];
const SEAT_CLI = `
process.stdout.write('did the work\\nVERDICT: PASS\\n');
process.exit(0);
`;
const SKIPPED = { status: 'skipped', basis: 'operator', reason: `QE acceptance skipped by operator: ${QE_OFF_REASON}` };

let dir: string;
let busDb: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let cliPath: string;
const savedEnv: Record<string, string | undefined> = {};
const campaigns: string[] = [];
const runs: string[] = [];

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function phase(id: string, kind: 'build' | 'review', role: 'neutral' | 'evaluator', dependsOn: string[]): Record<string, unknown> {
  return {
    id, kind, gate_type: null, gate: 'auto', executes_code: false, verified_evidence: false, required_deliverables: [],
    depends_on: dependsOn, role, skill_ref: null, allowed_skills: [], validator_pin: null,
  };
}

const clisJson = (): string => JSON.stringify(SEATS.map((key) => ({ key, display_name: key, binary: process.execPath, headless_invocation: `${process.execPath} ${cliPath} {PROMPT}` })));

/** The run's persisted contract, once the engine has written it (the launch writes it first). */
async function contractOf(runId: string, timeoutMs = 45_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call('GET', `/api/v1/runs/${encodeURIComponent(runId)}`);
    const session = (body['run'] as { session: Record<string, unknown> } | undefined)?.session;
    if (session?.['assurance'] !== undefined) return session;
    if (Date.now() > deadline) throw new Error(`${runId}: no contract on the run (${JSON.stringify(body).slice(0, 400)})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** What a run that did not settle was doing: its units and its last events (a failure message). */
async function runDump(runId: string): Promise<string> {
  const run = (await call('GET', `/api/v1/runs/${encodeURIComponent(runId)}`)).body['run'] as
    | { session?: Record<string, unknown>; units?: Array<Record<string, unknown>> }
    | undefined;
  const units = (run?.units ?? []).map((u) => ({ ord: u['ord'], status: u['status'], cli: u['cli'] ?? u['assigned_cli'], attempt: u['attempt'] }));
  const events = (((await call('GET', `/api/v1/runs/${encodeURIComponent(runId)}/events`)).body['events'] ?? []) as Array<Record<string, unknown>>)
    .slice(-40)
    .map((e) => [e['type'], e['ord'], e['cli'], e['status'], e['message'], e['reason']].filter((v) => v !== undefined && v !== null).join(':'));
  return JSON.stringify({ status: run?.session?.['status'], units, events }).slice(0, 6000);
}

const qeOf = (session: Record<string, unknown>): Record<string, unknown> | undefined =>
  (session['assurance'] as Record<string, unknown>)['qe'] as Record<string, unknown> | undefined;

/** Launch a two-node campaign (a QE node and a plain one) over POST /campaigns → its node run ids. */
async function launchCampaign(id: string): Promise<{ qe: string; plain: string }> {
  const res = await call('POST', '/api/v1/campaigns', {
    id,
    scenarios: [
      { id: 'qe', agent: { problem: 'Build the thing, then review it.', workflow: QE_WF } },
      { id: 'plain', agent: { problem: 'Build the thing, then review it.', workflow: PLAIN_WF } },
    ],
    policy: 'continue_independent',
    clisJson: clisJson(),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  campaigns.push(id);
  return { qe: `${id}:qe:a0`, plain: `${id}:plain:a0` };
}

/** Put a launch request on the daemon's bus, as any producer does (through the engine's one bus connection). */
async function requestRun(sessionId: string, workflow: string, args: Record<string, unknown> = {}): Promise<void> {
  await emitOnBus(busDb, {
    event_type: 'wicked.crew.run.requested',
    domain: 'wicked-cli',
    subdomain: 'cli.run',
    payload: { workflow, problem: 'Build the thing, then review it.', args: { session_id: sessionId, ...args } },
  });
  runs.push(sessionId);
}

beforeAll(async () => {
  if (!supported) return;
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-engine-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  for (const k of ['HOME', 'USERPROFILE', 'WICKED_BUS_DB', 'WICKED_BUS_EXEC']) savedEnv[k] = process.env[k];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  delete process.env['WICKED_BUS_EXEC'];
  cliPath = join(dir, 'seat-cli.mjs');
  writeFileSync(cliPath, SEAT_CLI);
  // The engine's bus bridge launches with the PRODUCTION roster (the registry: built-ins ∪ the HOME's
  // clis.toml), so the scratch clis.toml seats the two fake seats and takes every built-in seat off
  // the roster (never a real agent CLI from a test).
  const builtins = (JSON.parse(Core.registryRoster()) as Array<{ key: string }>).map((c) => c.key);
  const entry = (key: string, seated: boolean): string[] => [
    '[[cli]]', `key = "${key}"`, `display_name = "${key}"`, `binary = ${JSON.stringify(process.execPath)}`,
    `headless_invocation = ${JSON.stringify(`${process.execPath} ${cliPath} {PROMPT}`)}`,
    ...(seated ? [] : ['enabled_for_council = false', 'seat_eligible_for_work = false']), '',
  ];
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    [...SEATS.flatMap((key) => entry(key, true)), ...builtins.filter((k) => !SEATS.includes(k)).flatMap((key) => entry(key, false))].join('\n'),
  );
  expect((JSON.parse(Core.registryRoster()) as Array<{ key: string }>).map((c) => c.key).sort()).toEqual([...SEATS].sort());
  busDb = join(dir, 'bus.db');
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false, busDbPath: busDb });
  baseSkillOff();
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const phases = [phase('build', 'build', 'neutral', []), phase('review', 'review', 'evaluator', ['build'])];
  for (const def of [
    { id: QE_WF, phases, required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] },
    { id: PLAIN_WF, phases },
  ]) {
    const wf = await registerDef(adapter, def);
    expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);
  }
}, 120_000);

afterAll(async () => {
  if (!supported) return;
  // Whatever setup got to (or failed at), the environment and the scratch dir are restored.
  try {
    if (adapter !== undefined) {
      for (const id of campaigns) await quiesceCampaign(adapter, id).catch(() => undefined);
    }
    if (app !== undefined) {
      for (const id of runs) await call('POST', `/api/v1/runs/${encodeURIComponent(id)}/cancel`, {}).catch(() => undefined);
      await app.close().catch(() => undefined);
    }
    try {
      adapter?.close();
    } catch {
      /* restored below regardless */
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir !== undefined) removeScratch(dir);
  }
}, 60_000);

describe.skipIf(!supported)('qeAcceptance on the launches the engine makes on its own', () => {
  it("PUT /settings 'off' hands the setting to the engine", async () => {
    const put = await call('PUT', '/api/v1/settings', { qeAcceptance: 'off' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(adapter.engineQeSettingSupported()).toBe(true);
    const core = (adapter as unknown as { core: { qeAcceptanceOff(): string | null } }).core;
    expect(core.qeAcceptanceOff()).toBe(QE_OFF_REASON);
  });

  it("'off': a campaign's QE node carries the engine's skip with the setting's reason; its plain node gets no decision", async () => {
    const ids = await launchCampaign('qe-engine-camp-off');
    const qe = await contractOf(ids.qe);
    expect(qeOf(qe)).toMatchObject(SKIPPED);
    const decision = qeDecisionOf({ session: qe, units: [] } as unknown as SessionView);
    expect(decision).not.toBeNull();
    expect(qeDecisionBypasses(decision!)).toBe(true);
    // The engine left the plain node alone: no skip it would refuse, so the node launched.
    expect(qeOf(await contractOf(ids.plain))).toBeUndefined();
  }, 90_000);

  it("'off': a bus request of a QE workflow carries the skip; a plain one gets none; a request's own force still requires it", async () => {
    await requestRun('qe-engine-bus-off', QE_WF);
    await requestRun('qe-engine-bus-plain', PLAIN_WF);
    await requestRun('qe-engine-bus-forced', QE_WF, { force_qe_acceptance: true });
    expect(qeOf(await contractOf('qe-engine-bus-off'))).toMatchObject(SKIPPED);
    expect(qeOf(await contractOf('qe-engine-bus-plain'))).toBeUndefined();
    expect(qeOf(await contractOf('qe-engine-bus-forced'))).toMatchObject({ status: 'required', basis: 'operator' });
  }, 90_000);

  it("'off': every gate of a bus-launched QE run carries the skip on its receipt", async () => {
    const id = 'qe-engine-bus-off';
    const deadline = Date.now() + 60_000;
    let status = '';
    for (;;) {
      status = String((await contractOf(id))['status']);
      if (['completed', 'failed', 'cancelled', 'awaiting_human'].includes(status)) break;
      if (Date.now() > deadline) throw new Error(`${id} never settled (last ${status}): ${await runDump(id)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const events = ((await call('GET', `/api/v1/runs/${id}/events`)).body['events'] ?? []) as Array<Record<string, unknown>>;
    expect(status, events.map((e) => e['type']).join(',')).toBe('completed');
    const evaluated = events.filter((e) => e['type'] === 'gateEvaluated');
    expect(evaluated.length).toBeGreaterThan(0);
    for (const e of evaluated) expect((e['assurance'] as Record<string, unknown>)['qe'], JSON.stringify(e)).toMatchObject(SKIPPED);
  }, 90_000);

  it("back to 'required': the engine skips nothing — a new campaign node and a new bus request require QE acceptance", async () => {
    const put = await call('PUT', '/api/v1/settings', { qeAcceptance: 'required' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const core = (adapter as unknown as { core: { qeAcceptanceOff(): string | null } }).core;
    expect(core.qeAcceptanceOff()).toBeNull();
    const ids = await launchCampaign('qe-engine-camp-on');
    expect(qeOf(await contractOf(ids.qe))).toMatchObject({ status: 'required', basis: 'plan' });
    await requestRun('qe-engine-bus-on', QE_WF);
    expect(qeOf(await contractOf('qe-engine-bus-on'))).toMatchObject({ status: 'required', basis: 'plan' });
  }, 90_000);

  it('a hand-edited settings file is followed on the next settings read', async () => {
    const core = (adapter as unknown as { core: { qeAcceptanceOff(): string | null } }).core;
    const file = settingsFilePath();
    const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...current, qeAcceptance: 'off' }, null, 2));
    expect((await call('GET', '/api/v1/settings')).body['settings']).toMatchObject({ qeAcceptance: 'off' });
    expect(core.qeAcceptanceOff()).toBe(QE_OFF_REASON);
    writeFileSync(file, JSON.stringify({ ...current, qeAcceptance: 'required' }, null, 2));
    await call('GET', '/api/v1/settings');
    expect(core.qeAcceptanceOff()).toBeNull();
  });

  it("a node reads the setting when it DISPATCHES: a dependent QE node held behind another is skipped once the setting goes off", async () => {
    expect((await call('PUT', '/api/v1/settings', { qeAcceptance: 'required' })).status).toBe(200);
    // Node `hold` is a tool that waits for a marker file; `later` (the QE node) depends on it.
    const marker = join(dir, 'release-hold');
    const holdScript = join(dir, 'hold.mjs');
    writeFileSync(
      holdScript,
      `import { existsSync } from 'node:fs';\nconst t = Date.now();\nwhile (!existsSync(${JSON.stringify(marker)})) {\n  if (Date.now() - t > 60000) process.exit(1);\n  await new Promise((r) => setTimeout(r, 100));\n}\n`,
    );
    const id = 'qe-engine-camp-later';
    const res = await call('POST', '/api/v1/campaigns', {
      id,
      scenarios: [
        { id: 'hold', tool: { cmd: [process.execPath, holdScript] } },
        { id: 'later', deps: ['hold'], agent: { problem: 'Build the thing, then review it.', workflow: QE_WF } },
      ],
      clisJson: clisJson(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    campaigns.push(id);
    await contractOf(`${id}:hold:a0`);
    // The setting goes off while `later` waits; it has not launched yet.
    expect((await call('PUT', '/api/v1/settings', { qeAcceptance: 'off' })).status).toBe(200);
    expect(((await call('GET', `/api/v1/runs/${encodeURIComponent(`${id}:later:a0`)}`)).body['run'] as unknown) ?? null).toBeNull();
    writeFileSync(marker, 'go');
    expect(qeOf(await contractOf(`${id}:later:a0`, 90_000))).toMatchObject(SKIPPED);
  }, 150_000);

  it('a daemon that boots with the setting off starts its engine with it (before the bus bridge is armed), and the variable is not left behind', async () => {
    const file = settingsFilePath();
    const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
    writeFileSync(file, JSON.stringify({ ...current, qeAcceptance: 'off' }, null, 2));
    const second = new CoreAdapter({ dbPath: join(dir, 'core-boot.db'), stub: false });
    try {
      // No settings read yet: the engine has the boot value from spawn.
      const core = (second as unknown as { core: { qeAcceptanceOff(): string | null } }).core;
      expect(core.qeAcceptanceOff()).toBe(QE_OFF_REASON);
      expect(process.env['WICKED_QE_ACCEPTANCE_OFF']).toBeUndefined();
    } finally {
      second.close();
      writeFileSync(file, JSON.stringify({ ...current, qeAcceptance: 'required' }, null, 2));
    }
  }, 60_000);
});
