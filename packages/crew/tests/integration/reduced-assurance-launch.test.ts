// wicked-core#850 EX-01 at crew's real entry point: `POST /runs` on the real engine (`stub: false`),
// a ONE-seat roster, a build → review workflow — the one-CLI quickstart.
//
//   FULL (the default; nothing sent): the engine refuses to seat the review on its builder's seat.
//     The run parks at the `dead_seat` gate before any unit runs, the session's contract reads
//     `full`, and the 201 answer carries `assuranceNotice` naming the one seat and the explicit
//     opt-in (`retryWith: {retryOf, reducedAssurance: true}`). crew does not apply it.
//   REDUCED (`reducedAssurance: true`, the caller's explicit choice): the contract reads `reduced`,
//     no `assuranceNotice`, the review runs on the creator's seat with the fallback disclosed
//     (`distinctnessFallback: creator_seat`), and the receipts say `reduced`.
//   `reducedAssurance: false` is the explicit full choice: same as omitting it.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const SEAT = 'solo';
const WORKFLOW = 'reduced-assurance-launch-wf';
const RUN_FULL = 'it-assurance-full-1';
const RUN_REDUCED = 'it-assurance-reduced-1';

/** The one seat: it answers every prompt and closes with the verdict line an evaluator owes. */
const SEAT_CLI = `
process.stdout.write('did the work\\nVERDICT: PASS\\n');
process.exit(0);
`;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
type Ev = Record<string, unknown>;
type Settled = { launch: Record<string, unknown>; session: Record<string, unknown>; units: Array<Record<string, unknown>>; events: Ev[] };

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let cliPath: string;
let full: Settled;
let reduced: Settled;

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function phase(id: string, kind: 'build' | 'review', role: 'neutral' | 'evaluator', dependsOn: string[]): Record<string, unknown> {
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

async function launchAndSettle(runId: string, extra: Record<string, unknown>): Promise<Settled> {
  const launch = await postJson('/api/v1/runs', {
    problem: 'Build the thing, then review it.',
    sessionId: runId,
    workflow: WORKFLOW,
    entityMode: 'shared',
    clisJson: JSON.stringify([{ key: SEAT, display_name: 'Solo', binary: process.execPath, headless_invocation: `${process.execPath} ${cliPath} {PROMPT}` }]),
    ...extra,
  });
  expect(launch.status, JSON.stringify(launch.body)).toBe(201);
  const deadline = Date.now() + 60_000;
  let last: Record<string, unknown> = {};
  for (;;) {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    const run = body['run'] as { session: Record<string, unknown>; units: Array<Record<string, unknown>> } | undefined;
    if (run) {
      last = run.session;
      const status = String(run.session['status']);
      if (TERMINAL.has(status) || status === 'awaiting_human') {
        const { body: evBody } = await getJson(`/api/v1/runs/${runId}/events`);
        return { launch: launch.body, session: run.session, units: run.units, events: evBody['events'] as Ev[] };
      }
    }
    if (Date.now() > deadline) throw new Error(`${runId} never settled; last session: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ofType = (evs: Ev[], type: string): Ev[] => evs.filter((e) => e['type'] === type);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-reduced-assurance-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  cliPath = join(dir, 'solo-seat-cli.mjs');
  writeFileSync(cliPath, SEAT_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    ['[[cli]]', `key = "${SEAT}"`, 'display_name = "Solo"', `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${cliPath} {PROMPT}`)}`, ''].join('\n'),
  );

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false });
  baseSkillOff(); // run mechanics, not grounding (tests/setup/base-skill-off.ts)
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const wf = await postJson('/api/v1/workflows', {
    id: WORKFLOW,
    phases: [phase('build', 'build', 'neutral', []), phase('review', 'review', 'evaluator', ['build'])],
  });
  expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);

  full = await launchAndSettle(RUN_FULL, {});
  reduced = await launchAndSettle(RUN_REDUCED, { reducedAssurance: true, humanConfirm: 'none' });
}, 150_000);

afterAll(async () => {
  for (const id of [RUN_FULL, RUN_REDUCED]) {
    const { body } = await getJson(`/api/v1/runs/${id}`).catch(() => ({ body: {} as Record<string, unknown> }));
    const status = (body['run'] as { session?: Record<string, unknown> } | undefined)?.session?.['status'];
    if (status === 'awaiting_human') await postJson(`/api/v1/runs/${id}/gate`, { approve: false }).catch(() => undefined);
  }
  await app.close();
  adapter.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  removeScratch(dir);
});

describe('a one-seat build → review launch under FULL assurance (the default)', () => {
  it('the contract reads full and the engine refuses the creator-seat review: the run parks at the dead_seat gate before any unit runs', () => {
    expect(full.session['assurance']).toEqual({ mode: 'full', required: ['distinct_evaluator', 'judge'] });
    expect(ofType(full.events, 'sessionStarted')[0]?.['assurance']).toEqual({ mode: 'full', required: ['distinct_evaluator', 'judge'] });
    expect(String(full.session['status'])).toBe('awaiting_human');
    const gates = ofType(full.events, 'gateEscalated');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ condition: 'dead_seat', denialSource: 'dead_seat' });
    expect(String(gates[0]!['verdictSummary'])).toContain('requires a distinct evaluator');
    expect(ofType(full.events, 'unitDispatched')).toHaveLength(0);
  });

  it('the 201 answer names the one seat and the explicit opt-in, and crew did not apply it', () => {
    expect(full.launch['assuranceNotice']).toMatchObject({
      code: 'single_cli_roster',
      seats: [SEAT],
      retryWith: { retryOf: RUN_FULL, reducedAssurance: true },
    });
    expect(String((full.launch['assuranceNotice'] as { message: string }).message)).toContain('reducedAssurance');
  });
});

describe('the same launch with reducedAssurance: true (the explicit opt-in)', () => {
  it('the contract reads reduced, nothing parks at the dead_seat gate, and no notice is answered', () => {
    expect(reduced.session['assurance']).toEqual({ mode: 'reduced', required: ['distinct_evaluator', 'judge'] });
    expect(reduced.launch['assuranceNotice']).toBeUndefined();
    expect(ofType(reduced.events, 'gateEscalated').filter((g) => g['condition'] === 'dead_seat')).toHaveLength(0);
  });

  it('the review ran on the creator seat, disclosed: distinctnessFallback creator_seat, and the receipt says reduced', () => {
    const review = ofType(reduced.events, 'unitDistributed').find((e) => e['ord'] === 2);
    expect(review, JSON.stringify(ofType(reduced.events, 'unitDistributed'))).toMatchObject({ cli: SEAT, distinctnessFallback: 'creator_seat' });
    const receipts = ofType(reduced.events, 'gateEvaluated').map((e) => e['assurance'] as Record<string, unknown> | undefined);
    expect(receipts.length).toBeGreaterThan(0);
    for (const r of receipts) expect(r?.['mode']).toBe('reduced');
  });

  it('reducedAssurance: false is the explicit full choice — the same answer as omitting it', async () => {
    const res = await postJson('/api/v1/runs', {
      problem: 'Build the thing, then review it.',
      sessionId: 'it-assurance-full-explicit-1',
      workflow: WORKFLOW,
      reducedAssurance: false,
      clisJson: JSON.stringify([{ key: SEAT, display_name: 'Solo', binary: process.execPath, headless_invocation: `${process.execPath} ${cliPath} {PROMPT}` }]),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body['assuranceNotice']).toMatchObject({ code: 'single_cli_roster' });
    await postJson('/api/v1/runs/it-assurance-full-explicit-1/cancel', {}).catch(() => undefined);
  });
});
