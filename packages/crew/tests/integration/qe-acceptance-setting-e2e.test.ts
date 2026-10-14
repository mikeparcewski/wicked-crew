// The daemon's QE acceptance setting at crew's real entry points, on the REAL engine (`stub: false`):
// `PUT /settings {qeAcceptance}` writes the hermetic settings file, `GET /health` reports it, and a
// `POST /runs` of a workflow that requires QE acceptance persists the engine's own skip with the
// setting's reason — `assurance.qe {status: 'skipped', basis: 'operator'}` on the run — which the
// delivery checks read as a skip (`qeDecisionBypasses`), not a refusal. A workflow that does not
// require QE acceptance launches with no QE decision at all (the engine would refuse a skip on it),
// `forceQeAcceptance` still requires it, and with the setting back on `required` nothing is skipped.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter, addonSupportsQeOverride } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { qeDecisionBypasses, qeDecisionOf } from '../../src/api/delivery-assurance.js';
import { QE_OFF_REASON } from '../../src/core/qe-acceptance-setting.js';
import type { SessionView } from '../../src/core/types.js';
import { registerDef } from '../support/register-def.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const QE_WF = 'qe-setting-e2e-qe-wf';
const PLAIN_WF = 'qe-setting-e2e-plain-wf';
const SEATS = ['alpha', 'beta'];
const SEAT_CLI = `
process.stdout.write('did the work\\nVERDICT: PASS\\n');
process.exit(0);
`;

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let cliPath: string;
const launched: string[] = [];

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

/** Launch over POST /runs and read the persisted run back (the contract is written at launch). */
async function launch(runId: string, workflow: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown>; session: Record<string, unknown> | null }> {
  const res = await call('POST', '/api/v1/runs', { problem: 'Build the thing, then review it.', sessionId: runId, workflow, entityMode: 'shared', humanConfirm: 'all', clisJson: clisJson(), ...extra });
  if (res.status !== 201) return { ...res, session: null };
  launched.push(runId);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const { body } = await call('GET', `/api/v1/runs/${runId}`);
    const run = body['run'] as { session: Record<string, unknown> } | undefined;
    if (run?.session['assurance'] !== undefined) return { ...res, session: run.session };
    if (Date.now() > deadline) throw new Error(`${runId}: no contract on the run`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-setting-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  cliPath = join(dir, 'seat-cli.mjs');
  writeFileSync(cliPath, SEAT_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    SEATS.flatMap((key) => ['[[cli]]', `key = "${key}"`, `display_name = "${key}"`, `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${cliPath} {PROMPT}`)}`, '']).join('\n'),
  );
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false });
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
  for (const id of launched) await call('POST', `/api/v1/runs/${id}/cancel`, {}).catch(() => undefined);
  await app.close();
  adapter.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  removeScratch(dir);
});

describe.skipIf(!addonSupportsQeOverride())('qeAcceptance on a real daemon', () => {
  it("PUT /settings 'off' persists, GET /settings and /health report it", async () => {
    const put = await call('PUT', '/api/v1/settings', { qeAcceptance: 'off' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect((await call('GET', '/api/v1/settings')).body['settings']).toMatchObject({ qeAcceptance: 'off' });
    expect(((await call('GET', '/api/v1/health')).body['capabilities'] as Record<string, unknown>)['qeAcceptance']).toBe('off');
  });

  it("'off': a QE workflow's run carries the engine's skip with the setting's reason, and delivery reads a skip", async () => {
    const r = await launch('it-qe-setting-off-1', QE_WF);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const qe = (r.session!['assurance'] as Record<string, unknown>)['qe'] as Record<string, unknown>;
    expect(qe).toMatchObject({ status: 'skipped', basis: 'operator', reason: `QE acceptance skipped by operator: ${QE_OFF_REASON}` });
    const decision = qeDecisionOf({ session: r.session, units: [] } as unknown as SessionView);
    expect(decision).not.toBeNull();
    expect(qeDecisionBypasses(decision!)).toBe(true);
  }, 60_000);

  it("'off': deliverGate 'auto' on the QE workflow is accepted (nothing left to check)", async () => {
    const r = await launch('it-qe-setting-off-auto-1', QE_WF, { deliverGate: 'auto' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(((r.session!['assurance'] as Record<string, unknown>)['qe'] as Record<string, unknown>)['status']).toBe('skipped');
  }, 60_000);

  it("'off': a workflow that does not require QE acceptance launches with no QE decision (no skip the engine would refuse)", async () => {
    const r = await launch('it-qe-setting-off-plain-1', PLAIN_WF);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.session!['assurance'] as Record<string, unknown>)['qe']).toBeUndefined();
  }, 60_000);

  it('GET /workflows says which built-in presets require QE acceptance (the composer offers its QE choice from it)', async () => {
    const { body } = await call('GET', '/api/v1/workflows');
    const byId = new Map((body['workflows'] as Array<{ id: string; required_instruments?: string[] | null }>).map((w) => [w.id, w.required_instruments ?? null]));
    for (const id of ['bug', 'feature', 'migration', 'mcp-server']) expect(byId.get(id), id).toContain('qe_acceptance');
    expect(byId.get('chat') ?? null).toBeNull();
  });

  it("'off': a BUILT-IN QE preset (bug) resolved by the engine carries the skip too", async () => {
    const r = await launch('it-qe-setting-off-preset-1', 'bug');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.session!['assurance'] as Record<string, unknown>)['qe']).toMatchObject({ status: 'skipped', basis: 'operator', reason: `QE acceptance skipped by operator: ${QE_OFF_REASON}` });
  }, 60_000);

  it("'off': a launch with its own plan (no workflow) gets no skip", async () => {
    const res = await call('POST', '/api/v1/runs', { problem: 'Build it.', sessionId: 'it-qe-setting-off-plan-1', plan: { steps: [{ catalog: 'build' }] }, humanConfirm: 'all', clisJson: clisJson() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    launched.push('it-qe-setting-off-plan-1');
    const deadline = Date.now() + 30_000;
    let session: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      session = ((await call('GET', '/api/v1/runs/it-qe-setting-off-plan-1')).body['run'] as { session: Record<string, unknown> } | undefined)?.session;
      if (session?.['assurance'] !== undefined) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((session!['assurance'] as Record<string, unknown>)['qe']).toBeUndefined();
  }, 60_000);

  it("'off': every gate the run evaluates carries a receipt with the skip (the label rides the gates)", async () => {
    const id = 'it-qe-setting-off-receipt-1';
    const r = await launch(id, QE_WF, { humanConfirm: 'none' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // Wait for the run to settle (terminal, or parked for a person), then read every gate evaluation.
    const deadline = Date.now() + 60_000;
    let status = '';
    for (;;) {
      status = String(((await call('GET', `/api/v1/runs/${id}`)).body['run'] as { session: Record<string, unknown> }).session['status']);
      if (['completed', 'failed', 'cancelled', 'awaiting_human'].includes(status)) break; // settled: asserted below
      if (Date.now() > deadline) throw new Error(`${id} never settled (last ${status})`);
      await new Promise((res) => setTimeout(res, 250));
    }
    const events = ((await call('GET', `/api/v1/runs/${id}/events`)).body['events'] ?? []) as Array<Record<string, unknown>>;
    // The run went the whole way (build, then review), so both of its gates were evaluated.
    expect(status, events.map((e) => e['type']).join(',')).toBe('completed');
    const evaluated = events.filter((e) => e['type'] === 'gateEvaluated');
    expect(new Set(evaluated.map((e) => e['ord'])), JSON.stringify(evaluated.map((e) => e['ord']))).toEqual(new Set([1, 2]));
    for (const e of evaluated) {
      expect(e['assurance'], JSON.stringify(e)).toBeTruthy();
      expect((e['assurance'] as Record<string, unknown>)['qe']).toMatchObject({ status: 'skipped', basis: 'operator', reason: `QE acceptance skipped by operator: ${QE_OFF_REASON}` });
    }
  }, 80_000);

  it('why the skip is only added to QE work: the engine refuses an explicit skip on a workflow that does not require it', async () => {
    const r = await launch('it-qe-setting-plain-skip-1', PLAIN_WF, { skipQeAcceptance: { reason: 'blanket skip' } });
    expect(r.status, JSON.stringify(r.body)).not.toBe(201);
    expect(JSON.stringify(r.body)).toMatch(/nothing to skip/);
  }, 60_000);

  it("'off': forceQeAcceptance still requires it", async () => {
    const r = await launch('it-qe-setting-off-force-1', QE_WF, { forceQeAcceptance: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.session!['assurance'] as Record<string, unknown>)['qe']).toMatchObject({ status: 'required', basis: 'operator' });
  }, 60_000);

  it("back to 'required': nothing is skipped", async () => {
    expect((await call('PUT', '/api/v1/settings', { qeAcceptance: 'required' })).status).toBe(200);
    const r = await launch('it-qe-setting-required-1', QE_WF);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(((r.session!['assurance'] as Record<string, unknown>)['qe'] as Record<string, unknown>)['status']).toBe('required');
  }, 60_000);
});
