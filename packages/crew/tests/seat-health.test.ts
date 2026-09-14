// crew#274 — seat health: the fold transitions. (The `--version` recovery probe is retired —
// perf recon fix #3; readiness lives engine-side as the wicked-core#355 bench. Recovery here
// is a real `ok` output only.)
//
// Pure in-memory: events are hand-built CoreEvent frames (the exact wire shapes from
// wicked-crew-api-types). No CLI is ever spawned here.

import { describe, expect, it } from 'vitest';
import {
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

  it('stepFailed workerError naming the cli in its detail stamps lastErrorAt on THAT seat — and never flips it inactive (R5, F-RC2-006)', () => {
    const t = new SeatHealthTracker();
    // The exact wrapped-runner shape from wicked-core execute_wrapped.rs — no assignment needed.
    t.ingest(stepFailed('r1', 4, '(cli `agy` exited 1) three narration lines and no verdict'));
    const h = t.healthFor('agy');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(h.lastErrorAt).toBeDefined();
    // No other seat was touched.
    expect(t.healthFor('claude').status).toBe('active');
  });

  it('stepFailed workerError without a named cli resolves the seat via unitDistributed (crew#277)', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r2', 1, 'codex'));
    t.ingest(stepFailed('r2', 1, 'worker exited before producing output', 'workerError'));
    const h = t.healthFor('codex');
    expect(h.status).toBe('active');
    expect(h.lastErrorAt).toBeDefined();
    expect(t.healthFor('claude').lastErrorAt).toBeUndefined();
  });

  it('quota / timeout phrases never flip a seat; only an AUTH refusal flips `auth` (R5 — the engine benches per run)', () => {
    const cases: [string, string, boolean][] = [
      ['codex', '401 Unauthorized (run codex login)', true],
      ['copilot', 'quota exceeded for this billing period', false],
      ['pi', 'ACP timeout waiting for response id=42', false],
    ];
    for (const [seat, detail, auth] of cases) {
      const t = new SeatHealthTracker();
      t.ingest(distributed('r3', 2, seat));
      t.ingest(stepFailed('r3', 2, detail, 'environmentRefused'));
      expect(t.healthFor(seat).status, detail).toBe('active');
      expect(t.healthFor(seat).lastErrorAt, detail).toBeDefined();
      expect(t.authFailureFor(seat) !== null, detail).toBe(auth);
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

  it('repeated acpFallbacks stamp lastErrorAt and never flip the seat inactive (R5 — the flip is deleted)', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited', t0));
    t.ingest(acpFallback('claude', 'binary_unavailable', 'spawn failed', t0 + 60_000));
    t.ingest(acpFallback('claude', 'session_died', 'bridge exited again', t0 + 120_000));
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(h.lastErrorAt).toBe(new Date(t0 + 120_000).toISOString());
  });

  it('fallbacks far apart stamp lastErrorAt each time — there is no count or window any more (R5)', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'a', t0));
    t.ingest(acpFallback('claude', 'session_died', 'b', t0 + 11 * 60_000));
    t.ingest(acpFallback('claude', 'session_died', 'c', t0 + 22 * 60_000));
    const h = t.healthFor('claude');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    expect(h.lastErrorAt).toBe(new Date(t0 + 22 * 60_000).toISOString());
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

  it('an ok unit output for the assigned seat keeps it active and the historical lastErrorAt visible', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r6', 1, '(cli `agy` exited 1) transient'));
    expect(t.healthFor('agy').status).toBe('active');

    t.ingest(distributed('r7', 2, 'agy'));
    t.ingest(outputOk('r7', 2));
    const h = t.healthFor('agy');
    expect(h.status).toBe('active');
    expect(h.message).toBeUndefined();
    // The historical error stays visible.
    expect(h.lastErrorAt).toBeDefined();
  });

  it('a failed/cancelled unit output is NOT a recovery — the seat\'s own auth refusal stands until an ok output', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r8', 1, '(cli `codex` exited 1) 401 Unauthorized'));
    expect(t.authFailureFor('codex')).not.toBeNull();
    t.ingest(distributed('r9', 3, 'codex'));
    t.ingest(
      ev({ type: 'unitOutputCaptured', session: 'r9', ord: 3, attempt: 0, outputBytes: 0, stepStatus: 'failed', governed: false }),
    );
    expect(t.authFailureFor('codex')).not.toBeNull();
    expect(t.healthFor('codex').status).toBe('active');
    t.ingest(outputOk('r9', 3));
    expect(t.authFailureFor('codex')).toBeNull();
  });

  it('fallbacks around an ok output never add up to anything — there is no window to reset (R5)', () => {
    const t = new SeatHealthTracker();
    const t0 = Date.parse('2026-08-15T10:00:00Z');
    t.ingest(acpFallback('claude', 'session_died', 'a', t0));
    t.ingest(acpFallback('claude', 'session_died', 'b', t0 + 1_000));
    t.ingest(distributed('r10', 1, 'claude'));
    t.ingest(ev({ ...outputOk('r10', 1), ts: t0 + 2_000 }));
    t.ingest(acpFallback('claude', 'session_died', 'c', t0 + 3_000));
    expect(t.healthFor('claude').status).toBe('active');
    expect(t.healthFor('claude').lastErrorAt).toBe(new Date(t0 + 3_000).toISOString());
  });

  it('unitReassigned repoints the correlation to the new seat', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r11', 1, 'agy'));
    t.ingest(ev({ type: 'unitReassigned', session: 'r11', ord: 1, attempt: 1, previousCli: 'agy', newCli: 'claude' }));
    t.ingest(stepFailed('r11', 1, 'worker crashed with no output', 'workerError'));
    expect(t.healthFor('claude').lastErrorAt).toBeDefined();
    expect(t.healthFor('agy').lastErrorAt).toBeUndefined();
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

  it('the recogniser is narrow: a seat that merely says "deliver" in its own failure is still observed on the seat (lastErrorAt)', () => {
    const t = new SeatHealthTracker();
    t.ingest(stepFailed('r-seat', 2, '(cli `codex` exited 1) the agent could not deliver: the tests still fail'));
    expect(t.healthFor('codex').status).toBe('active');
    expect(t.healthFor('codex').lastErrorAt).toBeDefined();
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

// ── DES-L9 (FIX-IT-ALL row 0.11, PR-L9-crew-0 — tests first for the engine arm) ─────────────────
//
// The F1 arm (PR-L9-core, core-ts 0.7.27): a failed deliver unit whose output is not a LIFT-CONFLICT
// strand emits `stepFailed{failureKind: "workerError"}` and then PARKS the run at
// `awaitingHuman{gateKind: "escalation", ord: <deliver>}` — no LLM triage, regardless of
// `humanConfirm`. The revision + identity refusals PR-L9-crew adds to the script ride that arm.
// Seat health must read the whole sequence as an operator escalation: the assigned seat (a deliver
// unit is a Tool unit, but the roster may still name one) flips nowhere, stamps nothing.
describe('DES-L9 deliver refusals park at an escalation gate — seat health flips no seat (PR-L9-crew-0)', () => {
  const PR_BRANCH = 'wicked/cd3ea61d-9f4f-406d-972b-13ace3a87595';
  const IDENTITY_MISMATCH =
    "deliver: identity mismatch — GH_ACCOUNT is release-bot but gh's active login is someone-else; nothing was staged, committed or pushed. Fix the daemon's gh login (gh auth switch, or GH_TOKEN in the daemon environment) and approve to retry the deliver phase";
  const L9_REFUSALS: [string, string][] = [
    ['identity mismatch (D-18)', IDENTITY_MISMATCH],
    [
      'identity unreadable (D-18)',
      "deliver: identity mismatch — GH_ACCOUNT is release-bot but gh's active login is unreadable; nothing was staged, committed or pushed. Fix the daemon's gh login (gh auth switch, or GH_TOKEN in the daemon environment) and approve to retry the deliver phase",
    ],
    ['revision: PR branch gone', `deliver: pull request #273's branch origin/${PR_BRANCH} no longer exists on the remote; nothing was staged, committed or pushed`],
    [
      'revision: PR branch moved',
      `deliver: pull request #273's branch moved since this run based on it (origin/${PR_BRANCH} is no longer an ancestor of wicked/r-l9); nothing was staged, committed or pushed — launch a new revision on the current head, or rebase wicked/r-l9 onto origin/${PR_BRANCH} by hand and approve to retry`,
    ],
    ['revision: nothing on top', 'deliver: nothing to deliver — the run added no commit on top of PR #273'],
  ];
  const escalation = (session: string, ord: number, detail: string): CoreEvent =>
    ev({
      type: 'awaitingHuman',
      session,
      ord,
      reviewingOrd: ord,
      gateKind: 'escalation',
      prompt:
        `The deliver phase refused: ${detail}. Approve to re-run the deliver phase now (the engine re-lifts and ` +
        're-verifies first; no second deliver gate), reject to cancel the run and keep the worktree.',
    });

  it('a deliver stepFailed carrying a DES-L9 refusal, followed by awaitingHuman{gateKind: escalation}, flips NO seat', () => {
    for (const [label, detail] of L9_REFUSALS) {
      const t = new SeatHealthTracker();
      t.ingest(distributed('r-l9', 5, 'claude'));
      t.ingest(stepFailed('r-l9', 5, detail, 'workerError'));
      t.ingest(escalation('r-l9', 5, detail));
      expect(t.healthFor('claude').status, label).toBe('active');
      expect(t.healthFor('claude').message, label).toBeUndefined();
      expect(t.healthFor('claude').lastErrorAt, label).toBeUndefined();
    }
  });

  it('the escalation frame alone never flips a seat (a gate is a question to a person, not seat evidence)', () => {
    const t = new SeatHealthTracker();
    t.ingest(distributed('r-l9g', 5, 'claude'));
    t.ingest(escalation('r-l9g', 5, IDENTITY_MISMATCH));
    expect(t.healthFor('claude').status).toBe('active');
    expect(t.healthFor('claude').lastErrorAt).toBeUndefined();
  });
});

// ── councilSeatFailed: observed, never counted (R5b — DES-L3 PR-3D) ──────────────────────────────
//
// The crew council-count bench (`council_bench`, 30-min window) is DELETED: the engine's per-run
// ballot ledger (`session.benched_seats`, `unitDistributed.degradedReason`) is the one bench, and it
// now also benches an unclassified PERSISTENT failure at the ballot threshold. Here a ballot
// failure stamps `lastErrorAt` (an auth one flips `auth`); nothing crosses runs except `auth`.
import { SeatHealthTracker as BenchTracker } from '../src/api/seat-health.js';
import type { CoreEvent as BenchEvent } from '../src/core/types.js';

const failed = (cli: string, kind: string, ts: number, extra: Record<string, unknown> = {}): BenchEvent =>
  ({ type: 'councilSeatFailed', session: 'bb28ad5a-febb-411f-b8db-aed1dee8e515', ord: 1, round: 1, cli, kind, detail: '', ts, ...extra }) as BenchEvent;

describe('SeatHealthTracker — councilSeatFailed is observed, never a bench', () => {
  const T0 = 1_789_121_684_284;

  it('two timed-out ballots stamp lastErrorAt and leave the seat active with no bench of any kind', () => {
    const t = new BenchTracker();
    t.ingest(failed('opencode', 'timed_out', T0, { detail: 'exceeded 40s dispatch budget' }));
    t.ingest(failed('opencode', 'timed_out', T0 + 40_000, { detail: 'exceeded 40s dispatch budget', ord: 2 }));
    expect(t.healthFor('opencode')).toEqual({ status: 'active', since: expect.any(String), lastErrorAt: new Date(T0 + 40_000).toISOString() });
    expect(t.authFailureFor('opencode')).toBeNull();
    expect('councilBenchFor' in t).toBe(false);
  });

  it('a `benched` frame is the engine\'s derivative, not a new observation; an auth ballot flips `auth`', () => {
    const t = new BenchTracker();
    t.ingest(failed('codex', 'benched', T0, { detail: 'seat benched for 23s more (span 30s)' }));
    expect(t.healthFor('codex').lastErrorAt).toBeUndefined();
    // stderr is the detail when the frame carries no `detail` (a non_zero_exit).
    t.ingest(failed('codex', 'non_zero_exit', T0 + 2000, { stderr: 'Not logged in. Run `codex login`.' }));
    expect(t.healthFor('codex').status).toBe('active');
    expect(t.authFailureFor('codex', T0 + 3000)).toMatchObject({ source: 'ballot', detail: 'Not logged in. Run `codex login`.' });
  });

  it('a frame without a cli or a kind is ignored', () => {
    const t = new BenchTracker();
    t.ingest({ type: 'councilSeatFailed', session: 's', ord: 1, kind: 'timed_out', ts: T0 } as BenchEvent);
    t.ingest({ type: 'councilSeatFailed', session: 's', ord: 1, cli: 'agy', ts: T0 } as BenchEvent);
    expect(t.healthFor('agy').lastErrorAt).toBeUndefined();
  });
});
