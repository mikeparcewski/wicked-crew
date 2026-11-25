// A dead seat under TEAMED routing (wicked-core#590 S5; crew#668's mirror) — the two paths the
// engine's own suites pin (`tests/dead_seat_gate.rs`, `tests/seat_failover.rs` on core main), driven
// through crew's REAL engine seam (`stub: false`, `POST /runs` → `GET /runs/:id` + `/events`).
//
// Before S5 this file expected the council's ballots to discover a dead roster at DISTRIBUTION:
// every ballot exited signed-out (`councilSeatFailed{not_logged_in}` per seat), nothing was seated,
// and the run parked at the dead-seat gate (L3 PR-3A, wicked-core#523) with `benched_seats` naming
// both seats. Since S5 distribution convenes NO council: every seated unit takes the first eligible
// seat its skills admit (`unitDistributed{routingMethod: "teamed"}`), so no ballot can bench a seat
// and the pass that moved units off ballot-benched seats is gone. What remains are exactly two ways
// a dead seat surfaces, and this file pins both:
//
//   (A) is now refused at LAUNCH (DES-STANDIN-001 §2.1, §4): one usable helper and no other means the review has
//       no seat that did not build the work, so crew's preflight answers `409 stand_in_choice` before anything is
//       created. What follows is the distribution gate it replaced, which the engine's own suites still pin
//       (`tests/dead_seat_gate.rs`) for a launch that does not ask:
//
//       DISTRIBUTION — the typed `NoEligibleSeat` now comes from the bench that is left, the
//       LAUNCHER's: a build→review plan on a roster whose only seat distinct from the builder was
//       benched by the launcher (`health.usable: false`, which crew stamps from `council_eligible:
//       false` and passes through verbatim when handed engine-shaped) makes evaluator ≠ creator
//       unsatisfiable (core#560 — refused, never a creator-seat review). The intake ADMITS the run
//       (one seat is usable — this is NOT the all-benched 409 `tests/no-eligible-seat-route.test.ts`
//       pins), and the `PlanFailed` arm parks it: `gateEscalated{condition: 'dead_seat',
//       denialSource: 'dead_seat', attempt: 0, defGate: false}` → `awaitingHuman{gateKind:
//       'escalation'}`, every unit `pending` and provisionally seated on `clis[0]`, the launcher's
//       bench persisted, 0 ballots, 0 `unitDistributed`, 0 `sessionFailed` — even under
//       `humanConfirm: none` (the prompt discloses why it paused anyway). Reject cancels.
//
//   (B) THE UNIT — a roster whose seats are all signed out is routed anyway (nothing convened to
//       find out), so the dead seat is discovered by the WORKER: the wrapped CLI prints the
//       signed-out line and exits 1, the seat is benched `source: 'worker'`, the unit fails over to
//       the next eligible seat (`stepFailed` "failing over to …"), and when that one dies too there
//       is no seat left. Under crew's default `humanConfirm: none` (autonomous — no operator to
//       ask) the run keeps the standard fail contract: exactly one `sessionFailed`, the unit
//       `rejected` on the last seat it tried (`seat_failover.rs`:
//       `an_autonomous_run_on_a_dead_single_seat_still_fails_closed`; an ATTENDED run would pause at
//       the same escalation gate instead — `…_with_no_seat_left_pauses_at_the_escalation_gate`).
//
// crew CI builds `wicked-core-ts` from core MAIN (`scripts/use-local-core-ts.mjs`); against the npm
// pin (≤ 0.7.30, pre-S5) case (B) is the council-era shape and this file is expected to differ.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { registerDef } from '../support/register-def.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

/** (A) the distribution refusal: a usable builder + a launcher-benched seat, build→review. */
const RUN_A = 'it-dead-seat-distribution-1';
const WORKFLOW_A = 'dead-seat-distribution-wf';
const BUILDER = 'builder-a';
const BENCHED = 'benched-b';
/** (B) the unit-level discovery: two signed-out wrapped seats, one build phase. */
const RUN_B = 'it-dead-seat-unit-1';
const WORKFLOW_B = 'dead-seat-unit-wf';
const DEAD_SEATS = ['dead-a', 'dead-b'] as const;

const ALL_SEATS = [BUILDER, BENCHED, ...DEAD_SEATS] as const;

/** The wrapped seat every dispatch lands on: the exact signed-out line wicked-core's own tests use. */
const DEAD_CLI = `
process.stderr.write('Not logged in · Please run /login\\n');
process.exit(1);
`;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

type Ev = Record<string, unknown>;
type Settled = { session: Record<string, unknown>; units: Array<Record<string, unknown>>; events: Ev[] };

let dir: string;
let priorHome: string | undefined;
let priorUserProfile: string | undefined;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let deadPath: string;
/** Each run's rest state and trail, read ONCE after it settled. */
let refusedA: { status: number; body: Record<string, unknown> };
let settledB: Settled;

function seat(key: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    display_name: `Seat ${key}`,
    binary: process.execPath,
    headless_invocation: `${process.execPath} ${deadPath} {PROMPT}`,
    ...extra,
  };
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

/** Launch and follow the run to rest: terminal, or the escalation gate. */
async function launchAndSettle(runId: string, workflow: string, problem: string, clis: unknown[], extra: Record<string, unknown> = {}): Promise<Settled> {
  const launch = await postJson('/api/v1/runs', {
    problem,
    sessionId: runId,
    workflow,
    entityMode: 'shared',
    clisJson: JSON.stringify(clis),
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
        return { session: run.session, units: run.units, events: evBody['events'] as Ev[] };
      }
    }
    if (Date.now() > deadline) throw new Error(`${runId} never settled; last session: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const ofType = (evs: Ev[], type: string): Ev[] => evs.filter((e) => e['type'] === type);

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
    ALL_SEATS.flatMap((key) => [
      '[[cli]]',
      `key = ${JSON.stringify(key)}`,
      `display_name = ${JSON.stringify(`Seat ${key}`)}`,
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

  // (A) build→review: the review must run on a seat that did not build.
  const wfA = await registerDef(adapter, {
    id: WORKFLOW_A,
    phases: [phase('build', 'build', 'neutral', []), phase('review', 'review', 'evaluator', ['build'])],
  });
  expect(wfA.status, JSON.stringify(wfA.body)).toBeLessThan(300);
  // (B) one neutral agent phase — routed teamed to the first seat, which is where the worker dies.
  const wfB = await registerDef(adapter, { id: WORKFLOW_B, phases: [phase('work', 'build', 'neutral', [])] });
  expect(wfB.status, JSON.stringify(wfB.body)).toBeLessThan(300);

  // (A) `BUILDER` is usable; `BENCHED` — the only seat distinct from the builder — was found signed
  // out by the launcher (engine-shaped `health`, passed through verbatim by `toEngineSeat`).
  refusedA = await postJson('/api/v1/runs', {
    problem: 'Build the thing, then review it.',
    sessionId: RUN_A,
    workflow: WORKFLOW_A,
    entityMode: 'shared',
    clisJson: JSON.stringify([seat(BUILDER), seat(BENCHED, { health: { usable: false, reason: 'signed out' } })]),
  });
  // (B) both seats believed usable; the WORKER finds them signed out.
  settledB = await launchAndSettle(
    RUN_B,
    WORKFLOW_B,
    'Do one unit of work on a roster whose every seat is signed out',
    DEAD_SEATS.map((key) => seat(key)),
    // Both fake seats run one binary (`node`): one identity, so a full-assurance launch has no independent judge
    // and is refused 409 stand_in_choice (DES-STANDIN-001 §4). This case is about the worker finding a dead
    // seat, not the judge: reduced assurance (an author may judge, disclosed) keeps the path it pins.
    { reducedAssurance: true },
  );
}, 150_000);

afterAll(async () => {
  await app.close();
  adapter.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  removeScratch(dir);
});

describe('(A) one usable helper and a launcher-benched other: the review has no distinct seat (DES-STANDIN-001 §2.1)', () => {
  it('is refused 409 stand_in_choice at launch, before anything is created: the reviewer is short and a stand-in could fill it', async () => {
    expect(refusedA.status, JSON.stringify(refusedA.body)).toBe(409);
    expect(refusedA.body).toMatchObject({ code: 'stand_in_choice', retryWith: { standIns: true } });
    const preflight = refusedA.body['preflight'] as { signedIn: string[]; roles: Array<{ role: string; shortBy: number }> };
    expect(preflight.signedIn).toEqual([BUILDER]);
    expect(preflight.roles.filter((r) => r.shortBy > 0).map((r) => r.role)).toContain('evaluator');
    expect(refusedA.body['runId']).toBeUndefined();
    expect((await getJson(`/api/v1/runs/${RUN_A}`)).status).toBe(404);
  });
});

describe('(B) every seat dies at the UNIT — teamed routing seats a signed-out roster and the worker finds out (core#590 S5 / seat_failover)', () => {
  it('routes the unit teamed to the first seat with no council: exactly one unitDistributed{routingMethod: teamed}, council fields null, 0 ballots', () => {
    expect(ofType(settledB.events, 'councilConvened')).toHaveLength(0);
    expect(ofType(settledB.events, 'councilSeatFailed')).toHaveLength(0);
    const distributed = ofType(settledB.events, 'unitDistributed');
    expect(distributed).toHaveLength(1);
    expect(distributed[0]).toMatchObject({
      ord: 1,
      cli: DEAD_SEATS[0],
      routingMethod: 'teamed',
      agreementPct: null,
      returned: null,
      seated: null,
      dissent: null,
    });
    // (crew#477, core#648; IG1-core-2) The stub seats run no claude template and carry no ACP
    // adapter, so the engine classes them `os_sandbox` (the OS-sandbox floor) — a governed class:
    // the build unit is not degraded for governance, and with nothing benched yet there is no
    // bench summary either.
    expect(distributed[0]!['degradedReason']).toBeNull();
  });

  it('the worker exit benches the seat and fails over to the next one; with none left an autonomous run fails closed: one sessionFailed, no gate', () => {
    expect(settledB.session['human_confirm']).toBe('none');
    expect(String(settledB.session['status'])).toBe('failed');
    expect(ofType(settledB.events, 'unitDispatched').map((e) => e['attempt'])).toEqual([0, 1]);
    const failed = ofType(settledB.events, 'stepFailed');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ ord: 1, attempt: 0, failureKind: 'workerError' });
    expect(String(failed[0]!['detail'])).toContain(`seat '${DEAD_SEATS[0]}' failed (worker error); failing over to '${DEAD_SEATS[1]}'`);
    expect(failed[1]).toMatchObject({ ord: 1, attempt: 1, failureKind: 'workerError' });
    expect(String(failed[1]!['detail'])).toContain(`cli \`${DEAD_SEATS[1]}\` exited 1`);
    expect(ofType(settledB.events, 'sessionFailed')).toHaveLength(1);
    expect(ofType(settledB.events, 'gateEscalated')).toHaveLength(0);
    expect(ofType(settledB.events, 'awaitingHuman')).toHaveLength(0);
  });

  it("persists both seats benched by the WORKER as not_logged_in; the unit is rejected on the last seat it tried", () => {
    const benched = settledB.session['benched_seats'] as Array<{ cli: string; reason: string; source: string }>;
    expect(benched.map((b) => [b.cli, b.reason, b.source])).toEqual(DEAD_SEATS.map((k) => [k, 'not_logged_in', 'worker']));
    expect(settledB.units).toHaveLength(1);
    const unit = settledB.units[0]!;
    expect(unit['status']).toBe('rejected');
    expect(unit['assigned_cli']).toBe(DEAD_SEATS[1]);
    expect((unit['denial'] as { source?: string } | null)?.source).toBe('worker_failure');
  });
});
