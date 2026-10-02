// A seat the ENGINE benched in a run is kept out of the next launches for a bounded window
// (`seatBenched`, wicked-core after #590 S5).
//
// crew 0.7.45's release smoke (wicked-ci S04, run 36946090323): copilot reads signed in (its
// credential file is there) but every turn ends "You've exceeded your monthly quota". Before S5 the
// per-phase ballots found that before routing. Since S5 nothing does: every new run planned units
// onto copilot, its first refusal benched it for that run only, and the next run handed it work
// again. The engine now says so on the wire (`seatBenched {cli, reason, source}`); crew carries that
// verdict to the next launches as `council_eligible: false`, which `engineRosterJson` turns into
// the engine's launcher bench (`health.usable: false`).
//
// Pinned here, over an injected registry and sign-in probe (no native addon, no CLI spawned):
//  * dead but signed in → benched up front at the next launch, with a reason the operator reads;
//  * the bench lifts after SEAT_BENCH_WINDOW_MS (or at once on an ok output) → eligible again;
//  * a launcher bench never comes back this way, and a frame without a seat or reason is ignored;
//  * every seat recently benched → no seat left to launch on (the engine's intake refuses the
//    launch by name, `no_eligible_seat` 409, never a silent hang).

import { describe, expect, it } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SEAT_BENCH_WINDOW_MS, SeatHealthTracker } from '../src/api/seat-health.js';
import { eligibleSeatKeys, engineRosterJson } from '../src/core/engine-roster.js';
import type { CoreEvent } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const REGISTRY = [
  { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true, headless_invocation: 'claude -p {PROMPT}' },
  { key: 'copilot', display_name: 'Copilot', binary: 'copilot', enabled_for_council: true, headless_invocation: 'copilot -p {PROMPT}' },
  { key: 'opencode', display_name: 'OpenCode', binary: 'opencode', enabled_for_council: true, headless_invocation: 'opencode run {PROMPT}' },
];

const RUN = '1a2b3c4d-0000-4000-8000-000000000001';

/** The engine's frame when copilot's worker refused on quota in RUN (wicked-core `seatBenched`). */
const copilotBenched = (ts: number): CoreEvent =>
  ev({ type: 'seatBenched', session: RUN, ord: 2, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', source: 'worker', ts });

/** Every seat reads signed in (copilot's credential file is there — the smoke's exact shape). */
function rosterOver(tracker: SeatHealthTracker) {
  return rosterWithStandingFactory({
    seatHealth: tracker,
    registry: () => REGISTRY.map((s) => ({ ...s })),
    signedIn: () => true,
    env: { WICKED_WORKER_HOME: '' },
  });
}

type EngineSeat = { key: string; health?: { usable: boolean; reason?: string } };
const engineSeats = (roster: unknown[]): EngineSeat[] => JSON.parse(engineRosterJson(JSON.stringify(roster))) as EngineSeat[];

describe('a seat the engine benched in a run is benched at the next launch (seatBenched)', () => {
  it('dead but signed in: the next launch benches it up front, and the roster says why and until when', () => {
    const tracker = new SeatHealthTracker();
    const now = Date.now();
    tracker.ingest(copilotBenched(now));

    const roster = rosterOver(tracker)();
    const copilot = roster.find((s) => s.key === 'copilot')!;
    // Its sign-in still reads fine — that is the case this exists for.
    expect(copilot.auth).toBe('signed_in');
    expect(copilot.council_eligible).toBe(false);
    const reason = String(copilot.council_ineligible_reason);
    expect(reason).toMatch(/^recent quota_exhausted — the engine benched it in run 1a2b3c4d at \d\d:\d\dZ \(worker: quota_exhausted \(no success in the run\)\); eligible again at \d\d:\d\dZ/);
    expect(reason).toContain(`eligible again at ${new Date(now + SEAT_BENCH_WINDOW_MS).toISOString().slice(11, 16)}Z`);

    // What `launchRun` hands the engine: the launcher's bench verdict, with the short cause the
    // engine prints in `unitDistributed.degradedReason` (`copilot (recent quota_exhausted — launcher)`).
    const seats = engineSeats(roster);
    expect(seats.find((s) => s.key === 'copilot')!.health).toEqual({ usable: false, reason: 'recent quota_exhausted' });
    expect(seats.find((s) => s.key === 'claude')!.health).toEqual({ usable: true });
    expect(eligibleSeatKeys(roster)).toEqual(['claude', 'opencode']);
  });

  it('recovers: eligible again once the window has passed, still benched inside it', () => {
    const inside = new SeatHealthTracker();
    inside.ingest(copilotBenched(Date.now() - SEAT_BENCH_WINDOW_MS + 60_000));
    expect(rosterOver(inside)().find((s) => s.key === 'copilot')!.council_eligible).toBe(false);

    const expired = new SeatHealthTracker();
    expired.ingest(copilotBenched(Date.now() - SEAT_BENCH_WINDOW_MS - 1_000));
    const copilot = rosterOver(expired)().find((s) => s.key === 'copilot')!;
    expect(copilot.council_eligible).toBe(true);
    expect(copilot.council_ineligible_reason).toBeUndefined();
    expect(eligibleSeatKeys(rosterOver(expired)())).toEqual(['claude', 'copilot', 'opencode']);
    expect(expired.recentBenchFor('copilot')).toBeNull();
  });

  it('recovers at once when the seat completes a turn (an ok output)', () => {
    const tracker = new SeatHealthTracker();
    const now = Date.now();
    tracker.ingest(copilotBenched(now));
    expect(tracker.recentBenchFor('copilot', now + 1_000)).toMatchObject({ reason: 'quota_exhausted (no success in the run)', source: 'worker', run: RUN });
    tracker.ingest(ev({ type: 'unitDistributed', session: 'r2', ord: 1, cli: 'copilot', routingMethod: 'teamed' }));
    tracker.ingest(ev({ type: 'unitOutputCaptured', session: 'r2', ord: 1, attempt: 0, outputBytes: 10, stepStatus: 'ok', governed: true }));
    expect(tracker.recentBenchFor('copilot', now + 2_000)).toBeNull();
    expect(rosterOver(tracker)().find((s) => s.key === 'copilot')!.council_eligible).toBe(true);
  });

  it("an ok output of a unit that was planned on the benched seat but failed over does NOT clear the bench (it ran elsewhere)", () => {
    const tracker = new SeatHealthTracker();
    const now = Date.now();
    // The run planned unit 2 on copilot; copilot refused, the engine benched it and failed the unit
    // over to opencode (a stepFailed, no unitReassigned), and unit 2 then completed there.
    tracker.ingest(ev({ type: 'unitDistributed', session: RUN, ord: 2, cli: 'copilot', routingMethod: 'evaluator_distinct' }));
    tracker.ingest(copilotBenched(now));
    tracker.ingest(ev({ type: 'stepFailed', session: RUN, ord: 2, attempt: 0, detail: "seat 'copilot' failed (worker error); failing over to 'opencode' (seats worker-failed on this unit: 1/3)", failureKind: 'workerError' }));
    tracker.ingest(ev({ type: 'unitOutputCaptured', session: RUN, ord: 2, attempt: 1, outputBytes: 10, stepStatus: 'ok', governed: false }));
    expect(tracker.recentBenchFor('copilot', now + 1_000)).toMatchObject({ reason: 'quota_exhausted (no success in the run)' });
    expect(rosterOver(tracker)().find((s) => s.key === 'copilot')!.council_eligible).toBe(false);
  });

  it('recovers at once when the seat answers a chat turn (chatReply ok), but not on a failed one', () => {
    const tracker = new SeatHealthTracker();
    const now = Date.now();
    tracker.ingest(copilotBenched(now));
    tracker.ingest(ev({ type: 'chatReply', chat: 'c1', cliKey: 'copilot', text: 'quota', ok: false, usage: null }));
    expect(tracker.recentBenchFor('copilot', now + 1_000)).not.toBeNull();
    tracker.ingest(ev({ type: 'chatReply', chat: 'c1', cliKey: 'copilot', text: 'hello', ok: true, usage: null }));
    expect(tracker.recentBenchFor('copilot', now + 2_000)).toBeNull();
  });

  it("carries only the engine's in-run bench (worker or judge): a launcher bench, or a frame with no seat, reason or known source, changes nothing", () => {
    const tracker = new SeatHealthTracker();
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, cli: 'codex', reason: 'signed out', source: 'launcher' }));
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, reason: 'quota_exhausted' }));
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, cli: 'opencode' }));
    // A frame with no source, or one the engine does not emit, is malformed: it benches nothing.
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, cli: 'claude', reason: 'quota_exhausted' }));
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, cli: 'copilot', reason: 'quota_exhausted', source: 'ballot' }));
    expect(tracker.recentBenchFor('codex')).toBeNull();
    expect(tracker.recentBenchFor('opencode')).toBeNull();
    expect(tracker.recentBenchFor('claude')).toBeNull();
    expect(tracker.recentBenchFor('copilot')).toBeNull();
    expect(eligibleSeatKeys(rosterOver(tracker)())).toEqual(['claude', 'copilot', 'opencode']);
  });

  it('all seats recently benched: no seat is left to launch on, and every seat says why (the intake refuses by name)', () => {
    const tracker = new SeatHealthTracker();
    const now = Date.now();
    for (const [cli, reason] of [
      ['claude', 'not_logged_in'],
      ['copilot', 'quota_exhausted (no success in the run)'],
      ['opencode', 'not_installed'],
    ] as const) {
      tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, cli, reason, source: 'worker', ts: now }));
    }
    const roster = rosterOver(tracker)();
    expect(eligibleSeatKeys(roster)).toEqual([]);
    // What the engine receives: every seat benched, each with its cause — the engine's intake then
    // refuses the launch with `no eligible seat for <run>: 3 of 3 seats benched: claude (recent
    // not_logged_in — launcher), …` and crew answers 409 `no_eligible_seat` with the remedy
    // (no-eligible-seat-route.test.ts pins that seam).
    expect(engineSeats(roster).map((s) => [s.key, s.health])).toEqual([
      ['claude', { usable: false, reason: 'recent not_logged_in' }],
      ['copilot', { usable: false, reason: 'recent quota_exhausted' }],
      ['opencode', { usable: false, reason: 'recent not_installed' }],
    ]);
  });
});
