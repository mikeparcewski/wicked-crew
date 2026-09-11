// crew#274 — seat health: the fold transitions. (The `--version` recovery probe is retired —
// perf recon fix #3; readiness lives engine-side as the wicked-core#355 bench. Recovery here
// is a real `ok` output only.)
//
// Pure in-memory: events are hand-built CoreEvent frames (the exact wire shapes from
// wicked-crew-api-types). No CLI is ever spawned here.

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_THRESHOLD,
  FALLBACK_WINDOW_MS,
  SeatHealthTracker,
} from '../src/api/seat-health.js';
import type { CoreEvent } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const distributed = (session: string, ord: number, cli: string): CoreEvent =>
  ev({ type: 'unitDistributed', session, ord, cli, routing_method: 'council' });

const outputOk = (session: string, ord: number): CoreEvent =>
  ev({ type: 'unitOutputCaptured', session, ord, attempt: 0, outputBytes: 10, stepStatus: 'ok', governed: true });

const stepFailed = (
  session: string,
  ord: number,
  detail: string,
  failureKind = 'workerError',
): CoreEvent => ev({ type: 'stepFailed', session, ord, attempt: 0, detail, failureKind });

const acpFallback = (cliKey: string, fallbackKind: string, reason: string, ts?: number): CoreEvent =>
  ev({ type: 'acpFallback', session: 'r-acp', cliKey, reason, fallbackKind, ...(ts !== undefined ? { ts } : {}) });

describe('SeatHealthTracker fold (crew#274)', () => {
  it('defaults every never-seen seat to active with no message', () => {
    const t = new SeatHealthTracker();
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(typeof h.since).toBe('string');
  });

  it('stepFailed workerError naming the cli in its detail marks THAT seat inactive with the excerpt', () => {
    const t = new SeatHealthTracker();
    // The exact wrapped-runner shape from wicked-core execute_wrapped.rs — no assignment needed.
    t.ingest(stepFailed('r1', 4, '(cli `agy` exited 1) three narration lines and no verdict'));
    const h = t.healthFor('agy');
    expect(h.status).toBe('inactive');
    expect(h.message).toContain('(cli `agy` exited 1)');
    expect(h.lastErrorAt).toBeDefined();
    // No other seat was touched.
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('stepFailed workerError without a named cli resolves the seat via unitDistributed (crew#277)', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r2', 1, 'codex'));
    t.ingest(stepFailed('r2', 1, 'worker exited before producing output', 'workerError'));
    const h = t.healthFor('codex');
    expect(h.status).toBe('inactive');
    expect(h.message).toBe('worker exited before producing output');
  });

  it('auth/quota/timeout detail strings are seat-level even when failureKind is not workerError', () => {
    const cases: [string, string][] = [
      ['codex', '401 Unauthorized (run codex login)'],
      ['copilot', 'quota exceeded for this billing period'],
      ['pi', 'ACP timeout waiting for response id=42'],
    ];
    for (const [seat, detail] of cases) {
      const t = new SeatHealthTracker();
      t.ingest(distributed('r3', 2, seat));
      t.ingest(stepFailed('r3', 2, detail, 'environmentRefused'));
      expect(t.healthFor(seat).status, detail).toBe('inactive');
      expect(t.healthFor(seat).message).toContain(detail.slice(0, 20));
    }
  });

  it('a non-seat-level stepFailed leaves the seat active', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r4', 1, 'claude'));
    t.ingest(
      stepFailed('r4', 1, 'unit reported done but did not produce its declared deliverable(s)', 'environmentRefused'),
    );
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('a stepFailed for an unknown unit (no assignment, no named cli) marks nobody', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r5', 9, '401 Unauthorized'));
    expect(t.healthFor('codex').status).toBe('active');
  });

  it('one acpFallback is NOT inactive (session death falls back and can still work) but stamps lastErrorAt', () => {
    const t = new SeatHealthTracker();
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited mid-run'));
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(h.lastErrorAt).toBeDefined();
  });

  it(`${FALLBACK_THRESHOLD}+ acpFallbacks within 10 min mark the seat inactive with the reason`, () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited', t0));
    t.ingest(acpFallback('claude', 'binary_unavailable', 'spawn failed', t0 + 60_000));
    expect(t.healthFor('claude').status).toBe('active');
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited again', t0 + 120_000));
    const h = t.healthFor('claude');
    expect(h.status).toBe('inactive');
    expect(h.message).toContain('repeated ACP fallback (3 in 10 min)');
    expect(h.message).toContain('bridge exited again');
  });

  it('fallbacks outside the 10-minute window age out of the count', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'a', t0));
    t.ingest(acpFallback('claude', 'session_died', 'b', t0 + FALLBACK_WINDOW_MS + 1_000));
    t.ingest(acpFallback('claude', 'session_died', 'c', t0 + FALLBACK_WINDOW_MS + 2_000));
    // Only two fall inside any 10-min window — never three.
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('governance_requires_wrapped is deliberate routing, never counted toward inactive', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      t.ingest(acpFallback('claude', 'governance_requires_wrapped', 'governed unit', t0 + i * 1_000));
    }
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.lastErrorAt).toBeUndefined();
  });

  it('an ok unit output for the assigned seat flips it back to active and clears the message', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r6', 1, '(cli `agy` exited 1) transient'));
    expect(t.healthFor('agy').status).toBe('inactive');

    t.ingest(distributed('r7', 2, 'agy'));
    t.ingest(outputOk('r7', 2));
    const h = t.healthFor('agy');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    // The historical error stays visible.
    expect(h.lastErrorAt).toBeDefined();
  });

  it('a failed/cancelled unit output does NOT activate the seat', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r8', 1, '(cli `codex` exited 1) 401 Unauthorized'));
    t.ingest(distributed('r9', 3, 'codex'));
    t.ingest(
      ev({ type: 'unitOutputCaptured', session: 'r9', ord: 3, attempt: 0, outputBytes: 0, stepStatus: 'failed', governed: false }),
    );
    expect(t.healthFor('codex').status).toBe('inactive');
  });

  it('an ok output also resets the repeated-fallback window', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'a', t0));
    t.ingest(acpFallback('claude', 'session_died', 'b', t0 + 1_000));
    t.ingest(distributed('r10', 1, 'claude'));
    t.ingest(ev({ ...outputOk('r10', 1), ts: t0 + 2_000 }));
    // The two pre-ok fallbacks no longer count: this third one starts a fresh window.
    t.ingest(acpFallback('claude', 'session_died', 'c', t0 + 3_000));
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('unitReassigned repoints the correlation to the new seat', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r11', 1, 'agy'));
    t.ingest(ev({ type: 'unitReassigned', session: 'r11', ord: 1, attempt: 1, previousCli: 'agy', newCli: 'claude' }));
    t.ingest(stepFailed('r11', 1, 'worker crashed with no output', 'workerError'));
    expect(t.healthFor('claude').status).toBe('inactive');
    expect(t.healthFor('agy').status).toBe('active');
  });

  it('terminal run events drop the run assignments (a finished run cannot flip seats later)', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r12', 1, 'codex'));
    t.ingest(ev({ type: 'sessionCompleted', session: 'r12' }));
    t.ingest(stepFailed('r12', 1, 'worker crashed', 'workerError'));
    expect(t.healthFor('codex').status).toBe('active');
  });

  it('bounds the health message to an excerpt', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r13', 1, `(cli \`agy\` exited 1) ${'x'.repeat(5_000)}`));
    const msg = t.healthFor('agy').message ?? '';
    expect(msg.length).toBeLessThanOrEqual(240);
  });
});

// wicked-core#431 follow-through — a DELIVER refusal is an operator escalation, never a seat fault.
// The deliver phase is a Tool command no seat ran; the engine stamps its failure `workerError` only
// because the Tool path has no finer kind, and since wicked-core#433 the refusal can be the engine's
// own (the pre-push lift). Reading `workerError` literally blamed the unit's assigned seat for a git
// state (`core/deliver-triage.ts` is the recogniser).
describe('deliver refusals are escalations, not seat faults (wicked-core#431 follow-through)', () => {
  const REFUSALS: [string, string][] = [
    [
      'engine lift conflict',
      "deliver: LIFT-CONFLICT — lifting the run's work onto origin/main (f57069d) would conflict in: " +
        'testid-inventory.json. The worktree was left exactly as verified (base 1432c96); nothing was rebased and nothing was pushed.',
    ],
    [
      'engine re-verify failed',
      "deliver: the lift changed the tree, and the repository's own checks FAILED on it: typecheck: exit 2. Nothing was pushed",
    ],
    ['engine apply failed', 'deliver: the lift onto origin/main (f57069d) could not be applied cleanly — read-tree failed. Nothing was pushed'],
    [
      'engine run-branch precondition',
      "deliver: the worktree's HEAD is attached to `refs/heads/main`, not the run branch `wicked/x` — nothing was lifted, reset or pushed; the deliver script only pushes the run branch. Switch the worktree back to `wicked/x` and approve to retry.",
    ],
    ['engine snapshot failed', 'deliver: the worktree could not be snapshotted before delivery (git status: exit 128); nothing was pushed'],
    ['engine checks mutated', "deliver: the repository's checks passed but CHANGED the worktree while running (tree a → b, HEAD c → c)"],
    [
      'script rebase conflict',
      'CONFLICT (content): Merge conflict in src/thing.ts\ndeliver: LIFT-CONFLICT — rebase of wicked/x onto origin/main hit conflicts outside the changelog; resolve on the branch and re-run; nothing was pushed',
    ],
    ['script base moved', 'deliver: the engine verified this work against f57069d but origin/main is now 9f3c1a2 — refusing to rebase past the verified base; … Nothing was staged, committed or pushed; deliver: BASE MOVED since verification (origin/main now 9f3c1a2, verified f57069d)'],
    ['script nothing to deliver', 'deliver: nothing to deliver — the run produced no committed change (wicked/x is not ahead of origin/main); nothing was pushed'],
    ['script preflight changed', 'deliver: the crew#426 lockfile/codegen re-sync CHANGED the worktree after the engine verified it — … Nothing was staged, committed or pushed; deliver: PREFLIGHT CHANGED the verified tree: packages/crew/endpoint-manifest.json '],
  ];

  it('a workerError stepFailed carrying a deliver refusal flips NO seat — not even the assigned one', () => {
    for (const [label, detail] of REFUSALS) {
      const t = new SeatHealthTracker();
      t.ingest(distributed('r-deliver', 5, 'claude'));
      t.ingest(stepFailed('r-deliver', 5, detail, 'workerError'));
      expect(t.healthFor('claude').status, label).toBe('active');
      expect(t.healthFor('claude').message, label).toBeUndefined();
      expect(t.healthFor('claude').lastErrorAt, label).toBeUndefined();
    }
  });

  it('the recogniser is narrow: a seat that merely says "deliver" in its own failure is still a seat fault', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r-seat', 2, '(cli `codex` exited 1) the agent could not deliver: the tests still fail'));
    expect(t.healthFor('codex').status).toBe('inactive');
  });

  it('read_only_requires_wrapped is deliberate routing, never counted toward inactive (wicked-core#431)', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-09-10T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      t.ingest(
        acpFallback('pi', 'read_only_requires_wrapped', 'executes_code:false unit on an unadmitted ACP seat', t0 + i * 1_000),
      );
    }
    const h = t.healthFor('pi');
    expect(h.status).toBe('active');
    expect(h.lastErrorAt).toBeUndefined();
  });
});

// ── The council bench fold (independent review of #533, F-1) ─────────────────────────────────────
//
// `councilSeatFailed { cli, kind }` is the engine's own evidence that a seat cannot hold a ballot.
// The fold is bounded — primary kinds only, a rolling window, a threshold — feeds `council_eligible`
// through `councilBenchFor`, never flips `health`, and is cleared by the seat's next ok output.
import {
  COUNCIL_BENCH_THRESHOLD,
  COUNCIL_BENCH_WINDOW_MS,
  SeatHealthTracker as BenchTracker,
} from '../src/api/seat-health.js';
import type { CoreEvent as BenchEvent } from '../src/core/types.js';

const failed = (cli: string, kind: string, ts: number, extra: Record<string, unknown> = {}): BenchEvent =>
  ({ type: 'councilSeatFailed', session: 'bb28ad5a-febb-411f-b8db-aed1dee8e515', ord: 1, round: 1, cli, kind, detail: '', ts, ...extra }) as BenchEvent;

describe('SeatHealthTracker — council bench fold (councilSeatFailed)', () => {
  const T0 = 1_789_121_684_284;

  it('two primary failures inside the window bench the seat with the LAST failure named; one is weather; health is untouched', () => {
    const t = new BenchTracker();
    t.ingest(failed('opencode', 'timed_out', T0, { detail: 'exceeded 40s dispatch budget' }));
    expect(t.councilBenchFor('opencode', T0 + 1000)).toBeNull();
    // Observed, stamped — not flipped.
    expect(t.healthFor('opencode')).toMatchObject({ status: 'active', lastErrorAt: new Date(T0).toISOString() });
    t.ingest(failed('opencode', 'timed_out', T0 + 40_000, { detail: 'exceeded 40s dispatch budget', ord: 2 }));
    expect(COUNCIL_BENCH_THRESHOLD).toBe(2);
    expect(t.councilBenchFor('opencode', T0 + 41_000)).toEqual({
      failures: 2,
      last_kind: 'timed_out',
      last_at: new Date(T0 + 40_000).toISOString(),
      last_run: 'bb28ad5a-febb-411f-b8db-aed1dee8e515',
      last_detail: 'exceeded 40s dispatch budget',
      window_ms: COUNCIL_BENCH_WINDOW_MS,
    });
    expect(t.healthFor('opencode').status).toBe('active');
  });

  it('the derivative `benched` kind is NOT a new observation; a seat the engine only re-benched stays where the primary evidence put it', () => {
    const t = new BenchTracker();
    t.ingest(failed('codex', 'benched', T0, { detail: 'seat benched for 23s more (span 30s)' }));
    t.ingest(failed('codex', 'benched', T0 + 1000, { detail: 'probationary ballot in flight' }));
    expect(t.councilBenchFor('codex', T0 + 2000)).toBeNull();
    expect(t.healthFor('codex').lastErrorAt).toBeUndefined();
    // stderr is the detail when the frame carries no `detail` (a non_zero_exit).
    t.ingest(failed('codex', 'non_zero_exit', T0 + 2000, { stderr: 'Not logged in. Run `codex login`.' }));
    t.ingest(failed('codex', 'non_zero_exit', T0 + 3000, { stderr: 'Not logged in. Run `codex login`.' }));
    expect(t.councilBenchFor('codex', T0 + 4000)).toMatchObject({ failures: 2, last_kind: 'non_zero_exit', last_detail: 'Not logged in. Run `codex login`.' });
  });

  it('failures age out of the window; an ok unit output clears the bench at once (recovery by real work)', () => {
    const t = new BenchTracker();
    t.ingest(failed('pi', 'non_zero_exit', T0));
    t.ingest(failed('pi', 'non_zero_exit', T0 + 1000));
    expect(t.councilBenchFor('pi', T0 + 2000)).not.toBeNull();
    // Just past the window from the FIRST failure: only one remains → below threshold → null.
    expect(t.councilBenchFor('pi', T0 + COUNCIL_BENCH_WINDOW_MS + 1)).toBeNull();
    // Re-bench, then the seat completes a unit: cleared.
    t.ingest(failed('pi', 'non_zero_exit', T0 + COUNCIL_BENCH_WINDOW_MS + 2000));
    t.ingest(failed('pi', 'non_zero_exit', T0 + COUNCIL_BENCH_WINDOW_MS + 3000));
    expect(t.councilBenchFor('pi', T0 + COUNCIL_BENCH_WINDOW_MS + 4000)).not.toBeNull();
    t.ingest({ type: 'unitDistributed', session: 's2', ord: 1, cli: 'pi', ts: T0 + COUNCIL_BENCH_WINDOW_MS + 5000 } as BenchEvent);
    t.ingest({ type: 'unitOutputCaptured', session: 's2', ord: 1, stepStatus: 'ok', ts: T0 + COUNCIL_BENCH_WINDOW_MS + 6000 } as BenchEvent);
    expect(t.councilBenchFor('pi', T0 + COUNCIL_BENCH_WINDOW_MS + 7000)).toBeNull();
    expect(t.healthFor('pi').status).toBe('active');
  });

  it('a frame without a cli or a kind, or an unknown kind, is ignored', () => {
    const t = new BenchTracker();
    t.ingest({ type: 'councilSeatFailed', session: 's', ord: 1, kind: 'timed_out', ts: T0 } as BenchEvent);
    t.ingest({ type: 'councilSeatFailed', session: 's', ord: 1, cli: 'agy', ts: T0 } as BenchEvent);
    t.ingest(failed('agy', 'spawn_error', T0));
    t.ingest(failed('agy', 'spawn_error', T0 + 1));
    expect(t.councilBenchFor('agy', T0 + 2)).toBeNull();
  });
});
