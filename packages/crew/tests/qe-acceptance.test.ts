// Deny-dominates resolution of the acceptance requirement (Phase 6a).
//
// The gate's one rule: nothing but an affirmative PASS satisfies a declared requirement. Every
// other state — FAIL, CONDITIONAL, PARTIAL, INCONCLUSIVE, N-A, SKIP, a missing ledger, a missing
// verdict, an unreadable store, a repo-less run — denies, each with its OWN reason, because the
// remedies differ (re-run QE, fix the store, clear the conditions, register a repo) and one
// collapsed message would hide which remedy applies. The verdict→status mapping is pinned 1:1
// against garden's qe accept action (VERDICT_TO_STATUS) so the two products cannot drift on what
// CONDITIONAL means.

import { describe, expect, it } from 'vitest';
import type { Verdict } from 'wicked-ledger';
import {
  acceptancePhaseIds,
  resolveAcceptanceGate,
  resolveRunWorkflow,
  runWindowFromEvents,
  TERMINAL_EVENT_TYPES,
  VERDICT_TO_STATUS,
} from '../src/qe/acceptance.js';
import type { QeAcceptanceState } from '../src/qe/ledger.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { RecordedEvent, SessionView, WorkflowDef } from '../src/core/types.js';

/** A minimal ledger state carrying one verdict. */
function stateWith(verdict: string, reason: string | null = null): QeAcceptanceState {
  return {
    root: '/repo/.wicked-qe',
    found: true,
    run: null,
    verdict: {
      id: 'v-1',
      run_id: 'r-1',
      verdict: verdict as Verdict,
      reviewer: 'reviewer-x',
      reason,
      created_at: '2026-08-12T00:00:00Z',
      updated_at: '2026-08-12T00:00:00Z',
      deleted: 0,
      deleted_at: null,
    },
    manifest: null,
    manifestPath: null,
    attribution: { kind: 'run-window', qeRunId: 'r-1', qeRunStartedAt: '2026-08-12T00:00:00Z' },
    ledgerVerdicts: 1,
    attributedVerdicts: 1,
  };
}

describe('VERDICT_TO_STATUS', () => {
  // Garden's qe accept action, verbatim, extended over the full enum via its own
  // `?? 'inconclusive'` fallback. A drift here means crew and garden disagree on
  // what a verdict MEANS, which is worse than either being wrong alone.
  it('matches the garden convention 1:1 across the whole verdict enum', () => {
    expect(VERDICT_TO_STATUS).toEqual({
      PASS: 'passed',
      FAIL: 'failed',
      PARTIAL: 'partial',
      CONDITIONAL: 'partial',
      INCONCLUSIVE: 'inconclusive',
      'N-A': 'inconclusive',
      SKIP: 'inconclusive',
    });
  });
});

describe('acceptancePhaseIds', () => {
  it('reads the requirement off verified_evidence phases of the built-ins', () => {
    const byId = new Map(BUILTIN_WORKFLOWS.map((w) => [w.id, w]));
    expect(acceptancePhaseIds(byId.get('feature') ?? null)).toEqual(['test']);
    expect(acceptancePhaseIds(byId.get('bug') ?? null)).toEqual(['verify']);
    expect(acceptancePhaseIds(byId.get('migration') ?? null)).toEqual(['verify']);
    expect(acceptancePhaseIds(byId.get('chat') ?? null)).toEqual([]);
    expect(acceptancePhaseIds(null)).toEqual([]);
  });
});

describe('resolveAcceptanceGate', () => {
  it('is vacuously satisfied when nothing is required — and says so', () => {
    const res = resolveAcceptanceGate(false, null);
    expect(res).toMatchObject({ required: false, satisfied: true });
    expect(res.reason).toMatch(/no acceptance requirement/);
  });

  it('denies a repo-less run: evidence that cannot be located is missing evidence', () => {
    const res = resolveAcceptanceGate(true, null);
    expect(res.satisfied).toBe(false);
    expect(res.reason).toMatch(/no repo context/);
  });

  it('denies a missing ledger, naming the path it probed', () => {
    const res = resolveAcceptanceGate(true, {
      root: '/repo/.wicked-qe',
      found: false,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
      attribution: { kind: 'none', reason: 'no ledger' },
      ledgerVerdicts: 0,
      attributedVerdicts: 0,
    });
    expect(res.satisfied).toBe(false);
    expect(res.reason).toContain('/repo/.wicked-qe');
    expect(res.reason).toMatch(/missing ⇒ deny/);
  });

  it('denies an unreadable ledger with the read failure, not "absent"', () => {
    // Unreadable and absent have different remedies (fix the store vs run QE);
    // conflating them sends the operator to the wrong one.
    const res = resolveAcceptanceGate(true, {
      root: '/repo/.wicked-qe',
      found: true,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
      attribution: { kind: 'none', reason: 'the ledger could not be read' },
      ledgerVerdicts: 0,
      attributedVerdicts: 0,
      error: 'verdicts/7ae4f27c.json: not valid JSON (Unexpected end of JSON input)',
    });
    expect(res.satisfied).toBe(false);
    expect(res.reason).toContain('verdicts/7ae4f27c.json: not valid JSON');
    expect(res.reason).toMatch(/unreadable ⇒ deny/);
  });

  it('denies a ledger with no verdict rows', () => {
    const res = resolveAcceptanceGate(true, {
      root: '/repo/.wicked-qe',
      found: true,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
      attribution: { kind: 'none', reason: 'the ledger records no verdict' },
      ledgerVerdicts: 0,
      attributedVerdicts: 0,
    });
    expect(res.satisfied).toBe(false);
    expect(res.reason).toMatch(/records no verdict/);
  });

  it("denies a ledger whose verdicts are none of THIS run's, naming what it holds (F-E2E-013)", () => {
    // The regression: a repo's committed legacy ledger held a two-month-old PASS, and a run that
    // recorded no evidence was served it as its own. "Has verdicts" and "has this run's verdict"
    // are different facts, and the denial must say which one failed.
    const res = resolveAcceptanceGate(true, {
      root: '/repo/.wicked-testing',
      found: true,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
      attribution: {
        kind: 'none',
        reason:
          'the ledger holds 1 verdict, newest PASS (v-old) at 2026-07-15T22:00:00.000Z, recorded ' +
          'before this run started (2026-09-12T04:17:21.914Z); none is stamped with run 4f67808a',
      },
      ledgerVerdicts: 1,
      attributedVerdicts: 0,
    });
    expect(res).toMatchObject({ satisfied: false, verdict: null, runStatus: null });
    expect(res.reason).toMatch(/no verdict attributed to this run/);
    expect(res.reason).toContain('before this run started');
    expect(res.reason).toMatch(/unattributed ⇒ deny/);
    // Not the "empty ledger" wording — that remedy (run QE) is the wrong one here.
    expect(res.reason).not.toMatch(/records no verdict/);
  });

  it('satisfies on a clean PASS, citing the verdict', () => {
    const res = resolveAcceptanceGate(true, stateWith('PASS'));
    expect(res).toMatchObject({ satisfied: true, verdict: 'PASS', runStatus: 'passed' });
    expect(res.reason).toContain('v-1');
    expect(res.reason).toContain('reviewer-x');
  });

  it('denies FAIL and surfaces the reviewer reason', () => {
    const res = resolveAcceptanceGate(true, stateWith('FAIL', 'step 3 asserted 200, got 500'));
    expect(res).toMatchObject({ satisfied: false, verdict: 'FAIL', runStatus: 'failed' });
    expect(res.reason).toContain('step 3 asserted 200, got 500');
  });

  it('denies CONDITIONAL: ship-with-conditions maps to partial and does not pass on its own', () => {
    const res = resolveAcceptanceGate(true, stateWith('CONDITIONAL', 'fix the flaky retry first'));
    expect(res).toMatchObject({ satisfied: false, verdict: 'CONDITIONAL', runStatus: 'partial' });
    expect(res.reason).toMatch(/partial/);
    expect(res.reason).toMatch(/human approves/);
    expect(res.reason).toContain('fix the flaky retry first');
  });

  it.each(['PARTIAL', 'INCONCLUSIVE', 'N-A', 'SKIP'] as const)(
    'denies %s — anything not affirmatively PASS holds the gate',
    (verdict) => {
      const res = resolveAcceptanceGate(true, stateWith(verdict));
      expect(res.satisfied).toBe(false);
      expect(res.verdict).toBe(verdict);
      expect(res.runStatus).toBe(VERDICT_TO_STATUS[verdict]);
    },
  );

  it('denies an out-of-enum verdict value instead of crashing or passing', () => {
    const res = resolveAcceptanceGate(true, stateWith('BOGUS'));
    expect(res.satisfied).toBe(false);
    expect(res.verdict).toBeNull();
    expect(res.reason).toContain("'BOGUS'");
  });
});

describe('resolveRunWorkflow', () => {
  const USER_WF: WorkflowDef = {
    id: 'qe-accept',
    phases: [
      { id: 'accept', kind: 'test', gate_type: 'execution', gate: 'auto', executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: [], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
    ],
  };
  const registry = [...BUILTIN_WORKFLOWS, USER_WF];

  function view(workflowId: string, unitPhaseIds: string[]): SessionView {
    return {
      session: { id: 'run-1', workflow_id: workflowId },
      units: unitPhaseIds.map((p, i) => ({ id: `run-1:${p}`, ord: i + 1 })),
    } as unknown as SessionView;
  }

  it('resolves a patched-back built-in id directly', () => {
    const wf = resolveRunWorkflow(view('feature', []), registry);
    expect(wf?.id).toBe('feature');
  });

  it('resolves a user workflow from the unit phase sequence when the id is an instance id', () => {
    // sessionsDetail() only patches BUILT-IN ids back; a user workflow's run
    // still carries `wf-<uuid>` — the requirement must still resolve.
    const wf = resolveRunWorkflow(view('wf-abc123', ['accept']), registry);
    expect(wf?.id).toBe('qe-accept');
  });

  it('resolves nothing for a free-text run (planned units are u1, u2, …)', () => {
    expect(resolveRunWorkflow(view('wf-abc123', ['u1', 'u2']), registry)).toBeNull();
  });

  it('resolves nothing for an unknown id that is not an instance id', () => {
    expect(resolveRunWorkflow(view('not-registered', ['accept']), registry)).toBeNull();
  });

  it('resolves a DELIVERED run — the per-run deliver phase is stripped before matching (crew#393)', () => {
    // Default-on delivery appends a `deliver` unit the definition never had; the acceptance
    // requirement must not vanish because the run also opened its PR.
    const wf = resolveRunWorkflow(view('wf-abc123', ['accept', 'deliver']), registry);
    expect(wf?.id).toBe('qe-accept');
  });

  it('strips the deliverable floor + deliver pair (composition order) and still matches', () => {
    const wf = resolveRunWorkflow(
      view('wf-abc123', ['accept', 'verify-deliverables', 'deliver']),
      registry,
    );
    expect(wf?.id).toBe('qe-accept');
  });

  it('a def carrying its OWN deliver phase wins the exact match — stripping never fires', () => {
    const OWN_DELIVER: WorkflowDef = {
      id: 'own-deliver',
      phases: [
        { id: 'accept', kind: 'test', gate_type: 'execution', gate: 'auto', executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: [], role: 'evaluator', skill_ref: null, allowed_skills: [], validator_pin: null },
        { id: 'deliver', kind: 'build', gate_type: null, gate: 'auto', executes_code: false, verified_evidence: true, required_deliverables: [], depends_on: ['accept'], role: 'neutral', skill_ref: null, allowed_skills: [], validator_pin: null },
      ],
    };
    const wf = resolveRunWorkflow(view('wf-abc123', ['accept', 'deliver']), [...registry, OWN_DELIVER]);
    expect(wf?.id).toBe('own-deliver');
  });

  it('a bare deliver-only sequence resolves nothing rather than a phantom empty def', () => {
    expect(resolveRunWorkflow(view('wf-abc123', ['deliver']), registry)).toBeNull();
  });
});

describe('runWindowFromEvents — the run lifetime the ledger read links against (review of #539: F1, F4, F5)', () => {
  const T = (iso: string): number => Date.parse(iso);
  const ev = (type: string, ts: number, seq: number): RecordedEvent =>
    ({ type, session: 'r', ts, seq }) as unknown as RecordedEvent;

  it("pins the engine's terminal frames from its source — runCancelled, never a `sessionCancelled` it does not emit", () => {
    // wicked-core domain.rs: terminal SessionStatus = Completed | Failed | Cancelled;
    // event.rs event_to_json: sessionCompleted | sessionFailed | runCancelled. runOrphaned is
    // NOT terminal (the run is still executing and resumable).
    expect([...TERMINAL_EVENT_TYPES].sort()).toEqual(['runCancelled', 'sessionCompleted', 'sessionFailed']);
    expect(TERMINAL_EVENT_TYPES.has('sessionCancelled')).toBe(false);
    expect(TERMINAL_EVENT_TYPES.has('runOrphaned')).toBe(false);
  });

  it("closes the window at the engine's real cancel frame (F1)", () => {
    // The observed failure: a run cancelled at 01:05 kept an OPEN window, so a QE PASS recorded
    // at 02:17 was attributed to it.
    const w = runWindowFromEvents(
      [ev('sessionStarted', T('2026-08-12T01:00:00Z'), 1), ev('runCancelled', T('2026-08-12T01:05:00Z'), 2)],
      'r',
    );
    expect(w).toEqual({ runId: 'r', startedAt: T('2026-08-12T01:00:00Z'), finishedAt: T('2026-08-12T01:05:00Z') });
  });

  it('closes at the FIRST terminal frame anywhere in the log — later frames never reopen it (F4)', () => {
    const w = runWindowFromEvents(
      [
        ev('sessionStarted', T('2026-08-12T01:00:00Z'), 1),
        ev('sessionFailed', T('2026-08-12T01:05:00Z'), 2),
        ev('heartbeat', T('2026-08-12T01:06:00Z'), 3),
        ev('resumed', T('2026-08-12T01:07:00Z'), 4),
        ev('sessionCompleted', T('2026-08-12T01:30:00Z'), 5),
      ],
      'r',
    );
    expect(w.startedAt).toBe(T('2026-08-12T01:00:00Z'));
    expect(w.finishedAt).toBe(T('2026-08-12T01:05:00Z'));
  });

  it('keeps the window open for a live run (no terminal frame yet)', () => {
    const w = runWindowFromEvents(
      [ev('sessionStarted', T('2026-08-12T01:00:00Z'), 1), ev('unitExecuting', T('2026-08-12T01:01:00Z'), 2)],
      'r',
    );
    expect(w).toEqual({ runId: 'r', startedAt: T('2026-08-12T01:00:00Z'), finishedAt: null });
  });

  it('falls back to the earliest frame when the log carries no sessionStarted', () => {
    const w = runWindowFromEvents(
      [ev('unitPlanned', T('2026-08-12T01:02:00Z'), 1), ev('unitExecuting', T('2026-08-12T01:01:00Z'), 2)],
      'r',
    );
    expect(w.startedAt).toBe(T('2026-08-12T01:01:00Z'));
  });

  it('an absent or empty log places the run nowhere — and is not "unreadable"', () => {
    expect(runWindowFromEvents(null, 'r')).toEqual({ runId: 'r', startedAt: null, finishedAt: null });
    expect(runWindowFromEvents([], 'r')).toEqual({ runId: 'r', startedAt: null, finishedAt: null });
  });

  it('an UNREADABLE log carries its cause instead of masquerading as an empty one (F5)', () => {
    const w = runWindowFromEvents(null, 'r', 'event-log read binding missing (older addon)');
    expect(w).toEqual({
      runId: 'r',
      startedAt: null,
      finishedAt: null,
      logUnreadable: 'event-log read binding missing (older addon)',
    });
  });
});

describe('resolveAcceptanceGate — the linkage rides the reason (review of #539: F6, F2)', () => {
  it('labels an inferred lifetime linkage as INFERRED, not stamped', () => {
    const res = resolveAcceptanceGate(true, stateWith('PASS'));
    expect(res.satisfied).toBe(true);
    expect(res.reason).toContain("INFERRED from this run's lifetime");
    expect(res.reason).toContain('not stamped by the writer');
    expect(res.reason).not.toContain('QE runs are attributed');
  });

  it("names a writer's stamp and a caller's pin for what they are", () => {
    const stamped = resolveAcceptanceGate(true, {
      ...stateWith('PASS'),
      attribution: { kind: 'stamped', qeRunId: 'r-1' },
    });
    expect(stamped.reason).toContain('stamped crew_run_id');
    expect(stamped.reason).not.toContain('INFERRED');
    const pinned = resolveAcceptanceGate(true, {
      ...stateWith('PASS'),
      attribution: { kind: 'pinned', qeRunId: 'r-1' },
    });
    expect(pinned.reason).toContain('caller-asserted linkage');
    expect(pinned.reason).not.toContain('INFERRED');
  });

  it('says when the answer was resolved deny-dominates across several attributed QE runs (F2)', () => {
    const res = resolveAcceptanceGate(true, {
      ...stateWith('FAIL', 'scenario X: step 3 asserted 200, got 500'),
      attributedVerdicts: 2,
    });
    expect(res).toMatchObject({ satisfied: false, verdict: 'FAIL' });
    expect(res.reason).toContain('2 QE runs are attributed to this run');
    expect(res.reason).toContain('deny-dominates across their newest verdicts');
    expect(res.reason).toContain('scenario X');
  });
});
