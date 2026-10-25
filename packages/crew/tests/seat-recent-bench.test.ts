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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { auditSeatBenchStore, readSeatBenchEntries, SEAT_BENCHED_ACTION } from '../src/api/seat-bench-trail.js';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SEAT_BENCH_MAX_MS, SEAT_BENCH_WINDOW_MS, SeatHealthTracker, quotaBackoffMs } from '../src/api/seat-health.js';
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
    // (J4) A first quota bench lifts after the first backoff step (15 min), not the 30-min window.
    expect(reason).toContain(`eligible again at ${new Date(now + quotaBackoffMs(1)).toISOString().slice(11, 16)}Z`);

    // What `launchRun` hands the engine: the launcher's bench verdict, with the short cause the
    // engine prints in `unitDistributed.degradedReason` (`copilot (recent quota_exhausted — launcher)`).
    const seats = engineSeats(roster);
    expect(seats.find((s) => s.key === 'copilot')!.health).toEqual({ usable: false, reason: 'recent quota_exhausted' });
    expect(seats.find((s) => s.key === 'claude')!.health).toEqual({ usable: true });
    expect(eligibleSeatKeys(roster)).toEqual(['claude', 'opencode']);
  });

  it('recovers: eligible again once the bench has lifted, still benched before', () => {
    const inside = new SeatHealthTracker();
    inside.ingest(copilotBenched(Date.now() - quotaBackoffMs(1) + 60_000));
    expect(rosterOver(inside)().find((s) => s.key === 'copilot')!.council_eligible).toBe(false);

    const expired = new SeatHealthTracker();
    expired.ingest(copilotBenched(Date.now() - quotaBackoffMs(1) - 1_000));
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

// crew#1071: the bench lived in the tracker's memory only, and the boot replay re-reads only LIVE
// runs. A quota failure normally ends its run, so after a restart copilot read Ready 12 minutes
// before its stated retry, and the next ask was seated on it alone and got the same 429.
describe('a bench survives a daemon restart (crew#1071)', () => {
  /** A daemon's tracker over the trail at `path`, booted the way `createServer` boots it. */
  async function boot(path: string, nowMs = Date.now()): Promise<{ tracker: SeatHealthTracker; audit: AuditLog }> {
    const audit = new AuditLog(path, () => undefined);
    const tracker = new SeatHealthTracker();
    tracker.hydrateBenches(await readSeatBenchEntries(audit, nowMs), nowMs);
    tracker.attachBenchStore(auditSeatBenchStore(audit));
    return { tracker, audit };
  }

  function withTrail(fn: (path: string) => Promise<void>): () => Promise<void> {
    return async () => {
      const dir = mkdtempSync(join(tmpdir(), 'seat-bench-trail-'));
      try {
        await fn(join(dir, 'audit.log'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it('benched, the run ended, the daemon restarted: the seat is still benched, with the same reason, run and lift time', withTrail(async (path) => {
    const now = Date.now();
    const first = await boot(path, now);
    first.tracker.ingest(copilotBenched(now - 60_000));
    first.tracker.ingest(ev({ type: 'runCancelled', session: RUN }));
    await first.audit.flush();

    const second = await boot(path, now);
    expect(second.tracker.recentBenchFor('copilot', now)).toEqual(first.tracker.recentBenchFor('copilot', now));
    const copilot = rosterOver(second.tracker)().find((s) => s.key === 'copilot')!;
    expect(copilot.council_eligible).toBe(false);
    expect(copilot.recent_bench).toMatchObject({ kind: 'quota_exhausted', lifts_at: new Date(now - 60_000 + quotaBackoffMs(1)).toISOString(), strikes: 1, until_source: 'backoff' });
    // …and the ask path refuses it by the same verdict.
    expect((copilot.chat_admission as Record<string, unknown>)['unscoped']).toMatchObject({ ok: false, source: 'engine' });
  }));

  it('a bench lifted before the restart (an ok turn) stays lifted; one past its window is not restored', withTrail(async (path) => {
    const now = Date.now();
    const first = await boot(path, now);
    first.tracker.ingest(copilotBenched(now - 60_000));
    first.tracker.ingest(ev({ type: 'chatReply', chat: 'c1', cliKey: 'copilot', text: 'hello', ok: true, usage: null, ts: now - 30_000 }));
    first.tracker.ingest(ev({ type: 'seatBenched', session: 'old', ord: 1, cli: 'opencode', reason: 'not_installed', source: 'worker', ts: now - SEAT_BENCH_WINDOW_MS - 5_000 }));
    await first.audit.flush();

    const second = await boot(path, now);
    expect(second.tracker.recentBenchFor('copilot', now)).toBeNull();
    expect(second.tracker.recentBenchFor('opencode', now)).toBeNull();
    expect(eligibleSeatKeys(rosterOver(second.tracker)())).toEqual(['claude', 'copilot', 'opencode']);
  }));

  it('the same frame folded again (a live run replayed at boot) writes nothing new', withTrail(async (path) => {
    const now = Date.now();
    const first = await boot(path, now);
    first.tracker.ingest(copilotBenched(now - 1_000));
    first.tracker.ingest(copilotBenched(now - 1_000));
    await first.audit.flush();
    const second = await boot(path, now);
    second.tracker.ingest(copilotBenched(now - 1_000));
    await second.audit.flush();
    expect(await second.audit.readAll({ action: SEAT_BENCHED_ACTION })).toHaveLength(1);
    expect(second.tracker.recentBenchFor('copilot', now)?.runs).toBe(1);
  }));

  it('(J4) two records of one millisecond are folded in the order they were written', withTrail(async (path) => {
    const now = Date.now();
    const first = await boot(path, now);
    const at = now - 20 * 60_000;
    // The second (a reprobe re-bench, 30 min) lands in the same millisecond as the first (15 min).
    first.tracker.ingest(ev({ type: 'seatBenched', session: 'r1', ord: 1, cli: 'copilot', reason: 'quota_exhausted', source: 'worker', ts: at }));
    first.tracker.ingest(ev({ type: 'seatBenched', session: 'r2', ord: 1, cli: 'copilot', reason: 'quota_exhausted', source: 'reprobe', benchedUntilMs: at + 30 * 60_000, ts: at }));
    await first.audit.flush();
    const second = await boot(path, now);
    expect(second.tracker.recentBenchFor('copilot', now)).toMatchObject({ until: new Date(at + 30 * 60_000).toISOString() });
  }));

  it("(J4) a restart keeps a bench's own lift time and its strikes, even after it lifted", withTrail(async (path) => {
    const now = Date.now();
    const first = await boot(path, now);
    // Benched 40 min ago (lifted after 15), benched again 5 min ago: the second step, 30 min.
    first.tracker.ingest(ev({ type: 'seatBenched', session: 'r1', ord: 1, cli: 'copilot', reason: 'quota_exhausted', source: 'worker', ts: now - 40 * 60_000 }));
    first.tracker.ingest(ev({ type: 'seatBenched', session: 'r2', ord: 1, cli: 'copilot', reason: 'quota_exhausted', source: 'worker', ts: now - 5 * 60_000 }));
    // The engine's own lift time survives too.
    first.tracker.ingest(ev({ type: 'seatBenched', session: 'r3', ord: 1, cli: 'opencode', reason: 'quota_exhausted', source: 'judge', benchedUntilMs: now + 3 * 60 * 60_000, ts: now - 60_000 }));
    await first.audit.flush();
    const second = await boot(path, now);
    expect(second.tracker.recentBenchFor('copilot', now)).toMatchObject({ strikes: 2, until: new Date(now - 5 * 60_000 + quotaBackoffMs(2)).toISOString() });
    expect(second.tracker.recentBenchFor('opencode', now)).toMatchObject({ untilSource: 'engine', until: new Date(now + 3 * 60 * 60_000).toISOString() });
  }));
});

// PRODUCT-WORKS J4: on the rig, copilot was benched for quota (429) on 10-24 and never re-checked, so
// every later review had no distinct judge and the operator judged instead. A quota bench now lifts on
// its own clock: the engine's lift time when the frame carries one, else a 15 / 30 / 60-minute backoff.
describe('a quota bench expires and backs off (PRODUCT-WORKS J4)', () => {
  const MIN = 60_000;
  const benched = (ts: number, extra: Record<string, unknown> = {}, session = RUN): CoreEvent =>
    ev({ type: 'seatBenched', session, ord: 2, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', source: 'worker', ts, ...extra });

  it('the backoff is 15, then 30, then 60 minutes, and stays at 60', () => {
    expect([1, 2, 3, 4, 9].map(quotaBackoffMs)).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 60 * MIN, 60 * MIN]);
  });

  it('a bench expires and the seat returns; a refusal again re-benches it for longer; a good turn resets the backoff', () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now() - 3 * 60 * MIN;
    tracker.ingest(benched(t0));
    expect(tracker.recentBenchFor('copilot', t0 + 14 * MIN)).toMatchObject({ strikes: 1, untilSource: 'backoff' });
    expect(tracker.recentBenchFor('copilot', t0 + 15 * MIN)).toBeNull();
    // Still out of quota on its next run: benched again, for 30 minutes.
    const t1 = t0 + 20 * MIN;
    tracker.ingest(benched(t1, {}, 'run-2'));
    expect(tracker.recentBenchFor('copilot', t1 + 1)).toMatchObject({ strikes: 2, until: new Date(t1 + 30 * MIN).toISOString() });
    expect(tracker.recentBenchFor('copilot', t1 + 30 * MIN)).toBeNull();
    const t2 = t1 + 31 * MIN;
    tracker.ingest(benched(t2, {}, 'run-3'));
    expect(tracker.recentBenchFor('copilot', t2 + 1)).toMatchObject({ strikes: 3, until: new Date(t2 + 60 * MIN).toISOString() });
    // A good turn: the bench lifts and the backoff starts over.
    tracker.markActive('copilot', t2 + 2);
    expect(tracker.recentBenchFor('copilot', t2 + 3)).toBeNull();
    tracker.ingest(benched(t2 + 10, {}, 'run-4'));
    expect(tracker.recentBenchFor('copilot', t2 + 11)).toMatchObject({ strikes: 1, until: new Date(t2 + 10 + 15 * MIN).toISOString() });
  });

  it("the same run benching the seat twice while it is out is one step, not two", () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(benched(t0));
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 3, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', source: 'judge', ts: t0 + 1_000 }));
    expect(tracker.recentBenchFor('copilot', t0 + 2_000)).toMatchObject({ strikes: 1, runs: 1 });
  });

  it("uses the engine's lift time (the provider's reset time), bounded to a week", () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(benched(t0, { benchedUntilMs: t0 + 95 * MIN }));
    expect(tracker.recentBenchFor('copilot', t0 + 1)).toMatchObject({ untilSource: 'engine', until: new Date(t0 + 95 * MIN).toISOString() });
    const far = new SeatHealthTracker();
    far.ingest(benched(t0, { benchedUntilMs: t0 + 30 * 24 * 60 * MIN }));
    expect(far.recentBenchFor('copilot', t0 + 1)?.until).toBe(new Date(t0 + SEAT_BENCH_MAX_MS).toISOString());
    // A lift time in the past is not a lift time: the backoff applies.
    const stale = new SeatHealthTracker();
    stale.ingest(benched(t0, { benchedUntilMs: t0 - 1 }));
    expect(stale.recentBenchFor('copilot', t0 + 1)).toMatchObject({ untilSource: 'backoff', until: new Date(t0 + 15 * MIN).toISOString() });
  });

  it("a failed engine re-probe (source `reprobe`) re-benches it; the engine's `seatBenchLifted` brings it back", () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(benched(t0));
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 4, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', source: 'reprobe', benchedUntilMs: t0 + 75 * MIN, ts: t0 + 15 * MIN }));
    expect(tracker.recentBenchFor('copilot', t0 + 16 * MIN)).toMatchObject({ source: 'reprobe', strikes: 2, untilSource: 'engine', until: new Date(t0 + 75 * MIN).toISOString() });
    tracker.ingest(ev({ type: 'seatBenchLifted', session: RUN, ord: 5, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', ts: t0 + 76 * MIN }));
    expect(tracker.recentBenchFor('copilot', t0 + 76 * MIN + 1)).toBeNull();
    expect(eligibleSeatKeys(rosterOver(tracker)())).toEqual(['claude', 'copilot', 'opencode']);
  });

  it("concurrent runs benching it while it is out are one step, interleaved or not (A, B, A)", () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(benched(t0, {}, 'run-a'));
    tracker.ingest(benched(t0 + 1_000, {}, 'run-b'));
    tracker.ingest(ev({ type: 'seatBenched', session: 'run-a', ord: 3, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', source: 'judge', ts: t0 + 2_000 }));
    expect(tracker.recentBenchFor('copilot', t0 + 3_000)).toMatchObject({ strikes: 1, until: new Date(t0 + 2_000 + 15 * MIN).toISOString() });
  });

  it("the engine's per-run 15 minutes never cuts crew's cross-run backoff short", () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now() - 2 * 60 * MIN;
    tracker.ingest(benched(t0, { benchedUntilMs: t0 + 15 * MIN }, 'run-1'));
    const t1 = t0 + 20 * MIN;
    tracker.ingest(benched(t1, { benchedUntilMs: t1 + 15 * MIN }, 'run-2'));
    expect(tracker.recentBenchFor('copilot', t1 + 1)).toMatchObject({ strikes: 2, untilSource: 'backoff', until: new Date(t1 + 30 * MIN).toISOString() });
  });

  it('a second frame with a shorter clock does not cut an active bench short', () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(benched(t0, { benchedUntilMs: t0 + 180 * MIN }, 'run-1'));
    tracker.ingest(ev({ type: 'seatBenched', session: 'run-1', ord: 3, cli: 'copilot', reason: 'quota_exhausted (no success in the run)', source: 'judge', ts: t0 + 1_000 }));
    expect(tracker.recentBenchFor('copilot', t0 + 2_000)).toMatchObject({ untilSource: 'engine', until: new Date(t0 + 180 * MIN).toISOString() });
  });

  it('a live sign-in check after an already-lifted bench clears the strikes it left', () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now() - 60 * MIN;
    tracker.ingest(benched(t0));
    expect(tracker.recentBenchFor('copilot', t0 + 16 * MIN)).toBeNull();
    // An answer from before the bench clears nothing; one after it does.
    tracker.clearQuotaStrikesAfterLiveCheck('copilot', t0 - 1);
    tracker.ingest(benched(t0 + 20 * MIN, {}, 'run-2'));
    expect(tracker.recentBenchFor('copilot', t0 + 21 * MIN)?.strikes).toBe(2);
    expect(tracker.recentBenchFor('copilot', t0 + 51 * MIN)).toBeNull();
    tracker.clearQuotaStrikesAfterLiveCheck('copilot', t0 + 52 * MIN);
    tracker.ingest(benched(t0 + 55 * MIN, {}, 'run-3'));
    expect(tracker.recentBenchFor('copilot', t0 + 56 * MIN)?.strikes).toBe(1);
  });

  it('a frame older than the latest bench or lift is a replay and changes nothing', () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(benched(t0, {}, 'run-1'));
    tracker.markActive('copilot', t0 + 1_000);
    // run-1's frame re-read at boot (a live run's events replayed) after the lift.
    tracker.ingest(benched(t0, {}, 'run-1'));
    expect(tracker.recentBenchFor('copilot', t0 + 2_000)).toBeNull();
  });

  it('a non-quota bench keeps the 30-minute window', () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now();
    tracker.ingest(ev({ type: 'seatBenched', session: RUN, ord: 1, cli: 'opencode', reason: 'not_installed', source: 'worker', ts: t0 }));
    expect(tracker.recentBenchFor('opencode', t0 + 1)).toMatchObject({ strikes: 0, untilSource: 'window', until: new Date(t0 + SEAT_BENCH_WINDOW_MS).toISOString() });
  });

  it('the roster carries benchedUntil and benchReason for the Nerve Center while the bench stands', () => {
    const tracker = new SeatHealthTracker();
    const now = Date.now();
    tracker.ingest(benched(now, { benchedUntilMs: now + 20 * MIN }));
    const roster = rosterOver(tracker)();
    const copilot = roster.find((s) => s.key === 'copilot')!;
    expect(copilot.benchedUntil).toBe(new Date(now + 20 * MIN).toISOString());
    expect(copilot.benchReason).toBe(copilot.council_ineligible_reason);
    expect(String(copilot.benchReason)).toMatch(/^recent quota_exhausted — the engine benched it in run 1a2b3c4d/);
    expect(copilot.recent_bench).toMatchObject({ lifts_at: copilot.benchedUntil, until_source: 'engine', strikes: 1 });
    const claude = roster.find((s) => s.key === 'claude')!;
    expect(claude.benchedUntil).toBeUndefined();
    expect(claude.benchReason).toBeUndefined();
  });
});
