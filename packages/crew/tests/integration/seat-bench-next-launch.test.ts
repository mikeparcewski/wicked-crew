// A seat that reads signed in but cannot work is handed at most ONE unit, then kept out of the
// next launches — through crew's REAL engine seam (`stub: false`, `POST /runs` → `GET /runs/:id`
// + `/events`, `GET /roster`).
//
// crew 0.7.45's release smoke (wicked-ci S04, run 36946090323): since wicked-core#590 S5 no ballot
// finds a dead seat before routing. The smoke's copilot reads signed in and answers every turn
// "You've exceeded your monthly quota"; distribution put both review units on it, it was
// dispatched for both, and every new run did the same again. Now:
//
//   (1) THE RUN — the dead seat is dispatched once (the turn that finds it dead): the engine
//       benches it (`seatBenched {source: 'worker'}`), that unit fails over, and the second unit
//       planned on it is re-seated before it runs (`unitReassigned`). The run completes.
//   (2) THE NEXT LAUNCH — `GET /roster` reads the seat `council_eligible: false` with the engine's
//       cause and when it lifts; a launch built from that roster benches it up front
//       (`degradedReason` names it, no unit is planned on it, it is never spawned).
//   (3) NO SEAT LEFT — a launch whose every seat is recently benched is refused at once with
//       `409 no_eligible_seat` naming the seat and its cause; nothing hangs.
//
// crew CI builds `wicked-core-ts` from core MAIN (`scripts/use-local-core-ts.mjs`); the engine half
// (`seatBenched`, the re-seat) needs a core-ts that carries it.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const WORKFLOW = 'seat-bench-two-reviews';
const BUILDER = 'live-a';
const DEAD = 'dead-q';
const OTHER = 'live-b';
const SEATS = [BUILDER, DEAD, OTHER] as const;
const RUN_1 = 'it-seat-bench-run-1';
const RUN_2 = 'it-seat-bench-run-2';
const RUN_3 = 'it-seat-bench-run-3';

/** Reads signed in to any probe; every turn is copilot's quota refusal. */
const DEAD_CLI = `
process.stderr.write("You've exceeded your monthly quota for premium requests. Upgrade your plan or wait for the quota to reset.\\n");
process.exit(1);
`;
/** A live seat: does the unit, and an evaluator's answer ends with core#498's verdict line. */
const LIVE_CLI = `
process.stdout.write('Checked the work; it does what the unit asked.\\nVERDICT: PASS\\n');
process.exit(0);
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
let run1: Settled;
let rosterAfter1: Array<Record<string, unknown>>;
let run2: Settled;

const ofType = (evs: Ev[], type: string): Ev[] => evs.filter((e) => e['type'] === type);

/** How many times a run DISPATCHED the dead seat, read off the wire: each dispatch of it refuses,
 *  and the engine fails the unit over with `stepFailed` "seat '<key>' failed (worker error); failing
 *  over to …". (A worker-side counter file is not used: a read-only unit's worker may run under an
 *  OS write boundary.) */
const deadDispatches = (evs: Ev[]): number =>
  ofType(evs, 'stepFailed').filter((e) => String(e['detail']).startsWith(`seat '${DEAD}' failed`)).length;

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

/** The studio's launch: the seats it shows, taken from `GET /roster` verbatim (standing and all). */
async function rosterSeats(keys: readonly string[]): Promise<Array<Record<string, unknown>>> {
  const { body } = await getJson('/api/v1/roster');
  const roster = body['roster'] as Array<Record<string, unknown>>;
  return keys.map((k) => {
    const seat = roster.find((s) => s['key'] === k);
    if (!seat) throw new Error(`seat ${k} is not on the roster: ${roster.map((s) => String(s['key'])).join(',')}`);
    return seat;
  });
}

async function launchAndSettle(runId: string, clis: unknown[]): Promise<Settled> {
  const launch = await postJson('/api/v1/runs', {
    problem: 'Fix the thing, then check it twice.',
    sessionId: runId,
    workflow: WORKFLOW,
    entityMode: 'shared',
    clisJson: JSON.stringify(clis),
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


beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-seat-bench-next-launch-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'wicked-council'), { recursive: true });
  priorHome = process.env['HOME'];
  priorUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  const deadPath = join(dir, 'dead-seat-cli.cjs');
  const livePath = join(dir, 'live-seat-cli.cjs');
  writeFileSync(deadPath, DEAD_CLI);
  writeFileSync(livePath, LIVE_CLI);
  writeFileSync(
    join(home, '.config', 'wicked-council', 'clis.toml'),
    SEATS.flatMap((key) => [
      '[[cli]]',
      `key = ${JSON.stringify(key)}`,
      `display_name = ${JSON.stringify(`Seat ${key}`)}`,
      `binary = ${JSON.stringify(process.execPath)}`,
      `headless_invocation = ${JSON.stringify(`${process.execPath} ${key === DEAD ? deadPath : livePath} {PROMPT}`)}`,
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

  // build → two reviews: the build lands on the first seat, and BOTH reviews move off that builder
  // seat onto the next one (`evaluator_distinct`) — the dead seat, second in the roster.
  const wf = await postJson('/api/v1/workflows', {
    id: WORKFLOW,
    phases: [
      phase('build', 'build', 'neutral', []),
      phase('review', 'review', 'evaluator', ['build']),
      phase('verify', 'review', 'evaluator', ['build']),
    ],
  });
  expect(wf.status, JSON.stringify(wf.body)).toBeLessThan(300);

  run1 = await launchAndSettle(RUN_1, await rosterSeats(SEATS));
  rosterAfter1 = await rosterSeats(SEATS);
  run2 = await launchAndSettle(RUN_2, rosterAfter1);
}, 150_000);

afterAll(async () => {
  await app?.close();
  adapter?.close();
  if (priorHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = priorHome;
  if (priorUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = priorUserProfile;
  removeScratch(dir);
});

describe('(1) the run that finds the dead seat hands it one unit, not two', () => {
  it('both reviews were planned on the dead seat (the precondition)', () => {
    const planned = ofType(run1.events, 'unitDistributed').filter((d) => d['cli'] === DEAD).map((d) => d['ord']);
    expect(planned).toEqual([2, 3]);
  });

  it('the dead seat is dispatched exactly once, benched on the wire, and the run completes on the live seats', () => {
    expect(String(run1.session['status']), JSON.stringify(run1.session)).toBe('completed');
    expect(deadDispatches(run1.events)).toBe(1);
    expect(ofType(run1.events, 'seatBenched')).toEqual([
      expect.objectContaining({ session: RUN_1, ord: 2, cli: DEAD, reason: 'quota_exhausted (no success in the run)', source: 'worker' }),
    ]);
    expect(ofType(run1.events, 'unitReassigned')).toEqual(
      expect.arrayContaining([expect.objectContaining({ ord: 3, previousCli: DEAD, newCli: OTHER })]),
    );
  });
});

describe('(2) the next launch benches it up front', () => {
  it('GET /roster reads the dead seat ineligible, with the cause and when it lifts', () => {
    const dead = rosterAfter1.find((s) => s['key'] === DEAD)!;
    expect(dead['council_eligible']).toBe(false);
    expect(String(dead['council_ineligible_reason'])).toMatch(/^recent quota_exhausted — the engine benched it in run it-seat-b at \d\d:\d\dZ .*eligible again at \d\d:\d\dZ/);
    for (const key of [BUILDER, OTHER]) expect(rosterAfter1.find((s) => s['key'] === key)!['council_eligible']).toBe(true);
  });

  it('a launch from that roster plans no unit on it, names it in degradedReason, never dispatches it, and completes', () => {
    expect(String(run2.session['status']), JSON.stringify(run2.session)).toBe('completed');
    const distributed = ofType(run2.events, 'unitDistributed');
    expect(distributed.length).toBeGreaterThan(0);
    expect(distributed.map((d) => d['cli'])).not.toContain(DEAD);
    for (const d of distributed) expect(String(d['degradedReason'])).toContain(`${DEAD} (recent quota_exhausted — launcher)`);
    expect(deadDispatches(run2.events)).toBe(0);
    expect(ofType(run2.events, 'unitReassigned').map((e) => e['newCli'])).not.toContain(DEAD);
    expect(ofType(run2.events, 'seatBenched')).toHaveLength(0);
  });
});

describe('(3) no seat left: refused at once by name, never a hang', () => {
  it('a launch whose only seat is recently benched answers 409 no_eligible_seat naming the seat and its cause', async () => {
    const res = await postJson('/api/v1/runs', {
      problem: 'Fix the thing, then check it twice.',
      sessionId: RUN_3,
      workflow: WORKFLOW,
      entityMode: 'shared',
      clisJson: JSON.stringify(await rosterSeats([DEAD])),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ code: 'no_eligible_seat', runId: RUN_3 });
    expect(String(res.body['benched'])).toContain(`${DEAD} (recent quota_exhausted — launcher)`);
    expect(String(res.body['remedy'])).toMatch(/Sign a seat in/);
  });
});
