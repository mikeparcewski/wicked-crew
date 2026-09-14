// FIX-IT-ALL L8-0b — mirror-first EXPECTATION for L3 PR-3A (DES-L3 §4/§5; des-adjudicated §1 row 0.3
// and §4.7; register BC-13 / D-10), landing BEFORE the engine change: a run whose EVERY seat is benched
// at DISTRIBUTION — the council's ballots all fail dead-class — parks at an escalation gate instead of
// failing in ~2 s with nothing to approve after a sign-in.
//
//   TODAY (wicked-core ≤ 425de81): `distribute.rs:580-585` bails "every seat was benched on its
//   council ballot" → `Command::PlanFailed` → `fail_run_by_id` → `sessionFailed` ("council distribution
//   failed: no eligible seat for <run>: N of N seats benched: …").
//   AFTER 3A (core-ts 0.7.27): the same refusal is the typed `NoEligibleSeat` carrying the bench; the
//   PlanFailed arm persists it, seats every agent unit PROVISIONALLY on `clis[0]` and escalates the
//   cursor: `gateEscalated{condition: 'dead_seat', denialSource: 'dead_seat', attempt: 0, defGate: false}`
//   → `awaitingHuman{gateKind: 'escalation'}`; `GET /runs/:id` = `awaiting_human`, `benched_seats`
//   filled, units `pending`; 0 `sessionFailed`. Reject cancels; Approve retries on that seat; /reassign
//   names another.
//
// This is NOT the intake refusal `tests/no-eligible-seat-route.test.ts` pins (crew#556): a roster the
// LAUNCHER already benched (`health.usable: false`) is refused synchronously — 409 `no_eligible_seat`
// — and L3 keeps that Display byte-identical. Here crew believes both seats eligible; the ENGINE's
// council discovers they are dead. Real engine (`stub: false`, the `acp-bridge-kill` rig's boot), two
// WRAPPED seats whose CLI prints the signed-out line the ballot classifier reads
// (`SeatFailureReason::NotLoggedIn`) and exits 1. Two seats on purpose: a single seat takes the
// FINDING-010 short-circuit (no council convened) and would fail at the UNIT instead.
//
// Engine-version-tolerant (the #592 shape; wicked-core#523 = L3 PR-3A, core-ts 0.7.27): crew CI
// builds core-ts from core MAIN, so this file must pass on BOTH sides of the engine change. The first
// case proves the harness reaches the distribution refusal on either engine (a run that never
// launched, or a boot error, can never pass it). The second case asserts the 3A gate shape whenever
// the engine PARKED the run (`awaiting_human`) and returns early on a pre-3A engine that booked
// `sessionFailed` — the first case already pinned that terminal. No NOT_FIXED_YET marker: the flip is
// observed, not scheduled.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const RUN_ID = 'it-dead-seat-distribution-1';
const WORKFLOW_ID = 'dead-seat-distribution-wf';
const SEAT_KEYS = ['dead-a', 'dead-b'] as const;

/** The wrapped seat every ballot lands on: the exact signed-out line wicked-core's own tests use. */
const DEAD_CLI = `
process.stderr.write('Not logged in · Please run /login\\n');
process.exit(1);
`;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let deadPath: string;
/** The run's rest state and trail, read ONCE after the run settled (shared by both cases). */
let settled: { session: Record<string, unknown>; units: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };

function seats(): Array<Record<string, unknown>> {
  return SEAT_KEYS.map((key) => ({
    key,
    display_name: `Dead ${key}`,
    binary: process.execPath,
    headless_invocation: `${process.execPath} ${deadPath} {PROMPT}`,
  }));
}

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-dead-seat-distribution-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  deadPath = join(dir, 'dead-seat-cli.mjs');
  writeFileSync(deadPath, DEAD_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    SEAT_KEYS.flatMap((key) => [
      '[[cli]]',
      `key = ${JSON.stringify(key)}`,
      `display_name = ${JSON.stringify(`Dead ${key}`)}`,
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${deadPath} {PROMPT}`)}`,
      '',
    ]).join('\n'),
  );

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: false });
  baseSkillOff(); // run mechanics, not grounding — no published generation here (see tests/setup/base-skill-off.ts)
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // One neutral agent phase — the council must seat it, which is where every ballot dies.
  const wf = await postJson('/api/v1/workflows', {
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
  expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);

  const launch = await postJson('/api/v1/runs', {
    problem: 'Do one unit of work on a roster whose every seat is signed out',
    sessionId: RUN_ID,
    workflow: WORKFLOW_ID,
    entityMode: 'shared',
    clisJson: JSON.stringify(seats()),
  });
  expect(launch.status, JSON.stringify(launch.body)).toBe(201);

  // Follow the run to rest: terminal, or the escalation gate the expectation names.
  const deadline = Date.now() + 90_000;
  let last: Record<string, unknown> = {};
  for (;;) {
    const { body } = await getJson(`/api/v1/runs/${RUN_ID}`);
    const run = body['run'] as { session: Record<string, unknown>; units: Array<Record<string, unknown>> } | undefined;
    if (run) {
      last = run.session;
      const status = String(run.session['status']);
      if (TERMINAL.has(status) || status === 'awaiting_human') {
        const { body: evBody } = await getJson(`/api/v1/runs/${RUN_ID}/events`);
        settled = { session: run.session, units: run.units, events: evBody['events'] as Array<Record<string, unknown>> };
        break;
      }
    }
    if (Date.now() > deadline) throw new Error(`run never settled; last session: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}, 120_000);

afterAll(async () => {
  // Once 3A lands the run rests at the gate: reject it so the engine cancels and reaps before close.
  if (settled?.session['status'] === 'awaiting_human') {
    await postJson(`/api/v1/runs/${RUN_ID}/gate`, { approve: false }).catch(() => undefined);
  }
  await app.close();
  adapter.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  removeScratch(dir);
});

describe('every seat benched at DISTRIBUTION (DES-L3 PR-3A / D-10)', () => {
  it('the harness reaches the distribution refusal: the run rests failed (today) or at the dead-seat gate (3A) — never completed, never a unit-level failure', () => {
    const status = String(settled.session['status']);
    expect(['failed', 'awaiting_human'], `status ${status}`).toContain(status);
    // No unit ever ran: the council refused before any dispatch (no unitDispatched, no stepFailed).
    expect(settled.events.some((e) => e['type'] === 'unitDispatched')).toBe(false);
    expect(settled.events.some((e) => e['type'] === 'stepFailed')).toBe(false);
    // The council DID convene and every ballot died signed-out: one `councilSeatFailed` per seat
    // classified `not_logged_in`, and nothing was seated (no `unitDistributed`).
    const ballots = settled.events.filter((e) => e['type'] === 'councilSeatFailed');
    const deadSeats = new Set(ballots.filter((b) => b['reason'] === 'not_logged_in' || b['kind'] === 'not_logged_in').map((b) => String(b['cli'])));
    expect([...deadSeats].sort()).toEqual([...SEAT_KEYS]);
    expect(settled.events.some((e) => e['type'] === 'unitDistributed')).toBe(false);
    if (status === 'failed') {
      // TODAY's terminal: exactly one `sessionFailed` — which, recorded here as a fact for L3/L8, carries
      // NO reason text on the wire (`{type, session, ord, seq, ts}`); the bench summary reaches only
      // the daemon log. The distribution refusal is therefore proven by the ballots above, not by text.
      expect(settled.events.filter((e) => e['type'] === 'sessionFailed')).toHaveLength(1);
    }
  });

  it('L3 PR-3A (core-ts 0.7.27): when the engine parks the run, it is at gateEscalated{dead_seat} → awaitingHuman{escalation}; benched_seats names both seats; every agent unit pending on clis[0]; 0 sessionFailed', () => {
    if (settled.session['status'] !== 'awaiting_human') {
      // Pre-3A engine: the run rested `failed` (pinned by the case above). Nothing more to assert.
      return;
    }
    const gates = settled.events.filter((e) => e['type'] === 'gateEscalated');
    expect(gates.length).toBeGreaterThanOrEqual(1);
    const gate = gates[gates.length - 1]!;
    expect(gate).toMatchObject({ condition: 'dead_seat', denialSource: 'dead_seat', attempt: 0, defGate: false, outputCaptured: false });
    expect(String(gate['verdictSummary'])).toContain('2 of 2 seats benched');
    const gateIx = settled.events.indexOf(gate);
    const awaiting = settled.events.slice(gateIx).find((e) => e['type'] === 'awaitingHuman');
    expect(awaiting).toMatchObject({ gateKind: 'escalation', ord: gate['ord'] });
    expect(settled.events.some((e) => e['type'] === 'sessionFailed')).toBe(false);
    const benched = settled.session['benched_seats'] as Array<{ cli: string }> | undefined;
    expect(benched?.map((b) => b.cli).sort()).toEqual([...SEAT_KEYS]);
    for (const u of settled.units) {
      expect(u['status']).toBe('pending');
      expect(u['assigned_cli']).toBe(SEAT_KEYS[0]);
    }
  });
});
