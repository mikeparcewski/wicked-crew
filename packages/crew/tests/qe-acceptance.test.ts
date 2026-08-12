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
  VERDICT_TO_STATUS,
} from '../src/qe/acceptance.js';
import type { QeAcceptanceState } from '../src/qe/ledger.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { SessionView, WorkflowDef } from '../src/core/types.js';

/** A minimal ledger state carrying one verdict. */
function stateWith(verdict: string, reason: string | null = null): QeAcceptanceState {
  return {
    root: '/repo/.wicked-testing',
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
      root: '/repo/.wicked-testing',
      found: false,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
    });
    expect(res.satisfied).toBe(false);
    expect(res.reason).toContain('/repo/.wicked-testing');
    expect(res.reason).toMatch(/missing ⇒ deny/);
  });

  it('denies an unreadable ledger with the read failure, not "absent"', () => {
    // Unreadable and absent have different remedies (fix the store vs run QE);
    // conflating them sends the operator to the wrong one.
    const res = resolveAcceptanceGate(true, {
      root: '/repo/.wicked-testing',
      found: true,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
      error: 'SQLITE_CORRUPT: database disk image is malformed',
    });
    expect(res.satisfied).toBe(false);
    expect(res.reason).toContain('SQLITE_CORRUPT');
    expect(res.reason).toMatch(/unreadable ⇒ deny/);
  });

  it('denies a ledger with no verdict rows', () => {
    const res = resolveAcceptanceGate(true, {
      root: '/repo/.wicked-testing',
      found: true,
      run: null,
      verdict: null,
      manifest: null,
      manifestPath: null,
    });
    expect(res.satisfied).toBe(false);
    expect(res.reason).toMatch(/records no verdict/);
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
});
