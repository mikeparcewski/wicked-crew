// The acceptance view's conformance section (AW-14 / arch-R13a + arch-R16).
//
// Three claims under test, all deny-dominant:
//  1. run scoping + rule citation: only THIS run's claims appear, each `conform:` obligation
//     parsed back to the wiki rule it cites — a wiki-rule violation is visible where humans look.
//  2. "guardrailed" is a verified claim: a `governanceUnenforced` event, an ungoverned run, or an
//     unreadable event log each block it — never claimed for a run that wasn't actually enforced.
//  3. unreadable wires are named, never flattened into a clean empty answer.

import { describe, expect, it } from 'vitest';
import {
  isAdvisoryBoundaryReadDeny,
  isRunScope,
  parseRuleCitation,
  resolveConformance,
  resolveEnforcement,
} from '../src/qe/conformance.js';
import { buildAcceptanceView } from '../src/qe/acceptance.js';
import type { GovernanceClaim, RecordedEvent } from '../src/core/types.js';

/** A minimal store claim. */
function claim(over: Partial<GovernanceClaim> = {}): GovernanceClaim {
  return {
    claim_id: 'clm-1',
    scope: 'wicked-agent/run-1/shared',
    phase: 'build',
    policy_ids: [],
    decision: 'allow',
    obligations: [],
    evaluated_context_ref: 'sha256:x',
    criteria: '',
    evaluator_identity: 'wicked-governance',
    evaluated_at: 100,
    ...over,
  };
}

/** A minimal recorded event (the durable log's loose bag). */
function ev(fields: Record<string, unknown>): RecordedEvent {
  return { ts: 1, seq: 1, type: 'unknown', ...fields } as RecordedEvent;
}

describe('isRunScope — the engine scope grammar, exact-segment', () => {
  it('accepts both run-scoped shapes and nothing else', () => {
    expect(isRunScope('wicked-agent/run-1/shared', 'run-1')).toBe(true);
    expect(isRunScope('wicked-agent/run-1/unit/u2', 'run-1')).toBe(true);
    expect(isRunScope('wicked-agent/run-2/shared', 'run-1')).toBe(false);
    expect(isRunScope('run-1', 'run-1')).toBe(false);
    expect(isRunScope('', 'run-1')).toBe(false);
  });

  it('cannot be claimed by prefix accident: run-1 does not match run-10', () => {
    expect(isRunScope('wicked-agent/run-10/shared', 'run-1')).toBe(false);
    expect(isRunScope('wicked-agent/run-10/unit/u1', 'run-1')).toBe(false);
  });
});

describe('parseRuleCitation — the attach_recalled_rules obligation format', () => {
  it('parses conform:<Severity>:<id>:<statement>, keeping colons inside the statement', () => {
    expect(
      parseRuleCitation('conform:Error:PAT-001:never use printf without %s: see CLAUDE.md'),
    ).toEqual({
      severity: 'Error',
      ruleId: 'PAT-001',
      statement: 'never use printf without %s: see CLAUDE.md',
    });
  });

  it('returns null for non-citation obligations, which stay visible verbatim', () => {
    expect(parseRuleCitation('write outside worktree (write)')).toBeNull();
    expect(parseRuleCitation('conform:Error')).toBeNull();
    expect(parseRuleCitation('conform:Error:PAT-001:')).toBeNull();
    expect(parseRuleCitation('conform::PAT-001:statement')).toBeNull();
  });
});

describe('isAdvisoryBoundaryReadDeny — mirrors the engine exactly', () => {
  it('requires BOTH the boundary evaluator AND the read prefix', () => {
    const advisory = claim({
      decision: 'deny',
      evaluator_identity: 'wicked-governance-boundary',
      claim_id: 'boundary-read-deny:build',
    });
    expect(isAdvisoryBoundaryReadDeny(advisory)).toBe(true);
    // A policy deny wearing the prefix is NOT advisory (different evaluator).
    expect(
      isAdvisoryBoundaryReadDeny(claim({ decision: 'deny', claim_id: 'boundary-read-deny:build' })),
    ).toBe(false);
    // A boundary WRITE deny is NOT advisory (different prefix — the escape attempt).
    expect(
      isAdvisoryBoundaryReadDeny(
        claim({
          decision: 'deny',
          evaluator_identity: 'wicked-governance-boundary',
          claim_id: 'boundary-deny:build',
        }),
      ),
    ).toBe(false);
  });
});

describe('resolveEnforcement — arch-R16, unknown is never guardrailed', () => {
  it('reports unverifiable when the event log cannot be read', () => {
    const res = resolveEnforcement(null);
    expect(res.status).toBe('unverifiable');
    expect(res.reason).toMatch(/cannot be verified/);
  });

  it('reports ungoverned on a readable log with zero governance signal', () => {
    const res = resolveEnforcement([ev({ type: 'unitDispatched', ord: 0 })]);
    expect(res.status).toBe('ungoverned');
    expect(res.reason).toMatch(/no governance signal/);
  });

  it('reports enforced only on a positive armed signal with nothing unenforced', () => {
    const res = resolveEnforcement([
      ev({ type: 'governanceContextArmed', ord: 1, attempt: 0, path: 'wrapped_cli' }),
      ev({ type: 'unitOutputCaptured', ord: 1, attempt: 0, outputBytes: 10, governed: true }),
    ]);
    expect(res.status).toBe('enforced');
    expect(res.armedUnits).toEqual([1]);
  });

  it('deny-dominates: ONE unenforced governed unit breaks the claim even with others armed (FINDING-063)', () => {
    const res = resolveEnforcement([
      ev({ type: 'governanceContextArmed', ord: 0, attempt: 0 }),
      ev({
        type: 'governanceUnenforced',
        ord: 2,
        attempt: 0,
        cli: 'codex',
        reason: "unit is governed but 'codex' has no input-governance adapter",
      }),
    ]);
    expect(res.status).toBe('unenforced');
    expect(res.unenforced).toEqual([
      {
        ord: 2,
        attempt: 0,
        cli: 'codex',
        reason: "unit is governed but 'codex' has no input-governance adapter",
        kind: 'unchecked_tool_calls',
      },
    ]);
    expect(res.armedUnits).toEqual([0]);
    expect(res.reason).toMatch(/UNCHECKED tool calls on codex/);
  });
});

describe('resolveConformance — the deny-dominates headline', () => {
  const armedEvents = [ev({ type: 'governanceContextArmed', ord: 0, attempt: 0 })];

  it('scopes claims to the run and parses the wiki rules a denial cites', () => {
    const res = resolveConformance({
      runId: 'run-1',
      claims: [
        claim({
          claim_id: 'clm-deny',
          scope: 'wicked-agent/run-1/unit/u1',
          decision: 'deny',
          policy_ids: ['no-unsafe'],
          obligations: [
            'conform:Critical:POL-002:all governed outputs must cite their evidence',
            'free-text obligation',
          ],
          evaluated_at: 5,
        }),
        claim({ claim_id: 'clm-other-run', scope: 'wicked-agent/run-9/shared' }),
      ],
      events: armedEvents,
    });
    expect(res.claims).toHaveLength(1);
    expect(res.claims[0]).toMatchObject({
      claimId: 'clm-deny',
      decision: 'deny',
      policyIds: ['no-unsafe'],
      advisory: false,
      rules: [
        {
          severity: 'Critical',
          ruleId: 'POL-002',
          statement: 'all governed outputs must cite their evidence',
        },
      ],
    });
    // Verbatim obligations survive alongside the parsed citations.
    expect(res.claims[0]?.obligations).toContain('free-text obligation');
    expect(res.denied).toBe(true);
    expect(res.guardrailed).toBe(false);
    expect(res.summary).toMatch(/POL-002/);
  });

  it('is guardrailed ONLY when claims are readable, undenied, and enforcement is verified', () => {
    const clean = resolveConformance({ runId: 'run-1', claims: [claim()], events: armedEvents });
    expect(clean.guardrailed).toBe(true);
    expect(clean.summary).toMatch(/guardrailed/);

    // Unenforced run: same clean claims, but a governed unit ran unchecked.
    const unenforced = resolveConformance({
      runId: 'run-1',
      claims: [claim()],
      events: [ev({ type: 'governanceUnenforced', ord: 1, attempt: 0, cli: 'codex', reason: 'r' })],
    });
    expect(unenforced.guardrailed).toBe(false);
    expect(unenforced.enforcement.status).toBe('unenforced');
    expect(unenforced.summary).toMatch(/NOT guardrailed/);

    // Ungoverned run: nothing asked for governance — nothing is claimed.
    const ungoverned = resolveConformance({ runId: 'run-1', claims: [], events: [] });
    expect(ungoverned.guardrailed).toBe(false);
    expect(ungoverned.enforcement.status).toBe('ungoverned');

    // Unverifiable: the log could not be read.
    const unverifiable = resolveConformance({ runId: 'run-1', claims: [], events: null });
    expect(unverifiable.guardrailed).toBe(false);
    expect(unverifiable.enforcement.status).toBe('unverifiable');
  });

  it('advisory boundary READ denies are counted separately and never deny the run', () => {
    const res = resolveConformance({
      runId: 'run-1',
      claims: [
        claim({
          claim_id: 'boundary-read-deny:build',
          decision: 'deny',
          evaluator_identity: 'wicked-governance-boundary',
        }),
      ],
      events: armedEvents,
    });
    expect(res.denials).toBe(0);
    expect(res.advisoryDenials).toBe(1);
    expect(res.denied).toBe(false);
    expect(res.guardrailed).toBe(true);
    expect(res.claims[0]?.advisory).toBe(true);
  });

  it('an unreadable claims wire is named, never a clean empty list', () => {
    const res = resolveConformance({
      runId: 'run-1',
      claims: null,
      claimsError: 'store locked',
      events: armedEvents,
    });
    expect(res.claimsAvailable).toBe(false);
    expect(res.claimsError).toBe('store locked');
    expect(res.guardrailed).toBe(false);
    expect(res.summary).toMatch(/unreadable is not clean/);
  });

  it('sorts the run claims oldest first', () => {
    const res = resolveConformance({
      runId: 'run-1',
      claims: [
        claim({ claim_id: 'late', evaluated_at: 200 }),
        claim({ claim_id: 'early', evaluated_at: 50 }),
      ],
      events: armedEvents,
    });
    expect(res.claims.map((c) => c.claimId)).toEqual(['early', 'late']);
  });
});

describe('buildAcceptanceView — the conformance section rides the acceptance body', () => {
  it('serves run-scoped claims + enforcement beside the QE gate, from the wired loaders', async () => {
    const view = await buildAcceptanceView({
      runId: 'run-1',
      repo: null,
      requirement: { declared: false, phases: [] },
      claims: async () => [
        claim({
          claim_id: 'clm-deny',
          scope: 'wicked-agent/run-1/shared',
          decision: 'deny',
          obligations: ['conform:Error:PAT-042:worktree writes must stay inside the sandbox'],
        }),
      ],
      events: async () => [
        ev({ type: 'governanceUnenforced', ord: 1, attempt: 0, cli: 'codex', reason: 'no adapter' }),
      ],
    });
    // The QE gate resolves as before (free-text run: nothing required) …
    expect(view.gate.required).toBe(false);
    // … and the conformance section sits BESIDE it, deny-dominates on its own facts.
    expect(view.conformance.denied).toBe(true);
    expect(view.conformance.claims[0]?.rules[0]?.ruleId).toBe('PAT-042');
    expect(view.conformance.enforcement.status).toBe('unenforced');
    expect(view.conformance.guardrailed).toBe(false);
  });

  it('a throwing claims loader reads as unavailable; a throwing events loader as unverifiable', async () => {
    const view = await buildAcceptanceView({
      runId: 'run-1',
      repo: null,
      requirement: { declared: false, phases: [] },
      claims: async () => {
        throw new Error('claims wire down');
      },
      events: async () => {
        throw new Error('log gone');
      },
    });
    expect(view.conformance.claimsAvailable).toBe(false);
    expect(view.conformance.claimsError).toBe('claims wire down');
    expect(view.conformance.enforcement.status).toBe('unverifiable');
    expect(view.conformance.guardrailed).toBe(false);
  });

  it('absent loaders (an older caller) still never read as clean or guardrailed', async () => {
    const view = await buildAcceptanceView({
      runId: 'run-1',
      repo: null,
      requirement: { declared: false, phases: [] },
    });
    expect(view.conformance.claimsAvailable).toBe(false);
    expect(view.conformance.enforcement.status).toBe('unverifiable');
    expect(view.conformance.guardrailed).toBe(false);
  });
});

describe('resolveEnforcement — evaluatorMutatedWorktree (wicked-core F-036)', () => {
  it('a DENYING mutation is an enforcement failure: unenforced, named by phase and path, never guardrailed', () => {
    const res = resolveEnforcement([
      ev({ type: 'governanceContextArmed', ord: 3, attempt: 0, path: 'acp' }),
      ev({
        type: 'evaluatorMutatedWorktree',
        ord: 4,
        attempt: 0,
        cli: 'codex',
        phase: 'verify',
        beforeTree: 'aaaa',
        afterTree: 'bbbb',
        headMoved: false,
        changed: [
          { status: 'M', path: 'src/components/WorkPage.tsx' },
          { status: 'M', path: 'e2e/seed_surfaces_test.py' },
        ],
      }),
    ]);
    expect(res.status).toBe('unenforced');
    expect(res.unenforced).toHaveLength(1);
    expect(res.unenforced[0]).toMatchObject({ ord: 4, attempt: 0, cli: 'codex' });
    expect(res.unenforced[0]!.reason).toMatch(/evaluator≠creator violated/);
    expect(res.unenforced[0]!.reason).toMatch(/`verify`/);
    expect(res.unenforced[0]!.reason).toMatch(/M src\/components\/WorkPage\.tsx/);
    expect(res.reason).toMatch(/CHANGED the worktree under review/);
    expect(res.reason).not.toMatch(/UNCHECKED tool calls/);
    expect(res.armedUnits).toEqual([3]);

    const view = resolveConformance({
      runId: 'run-1',
      claims: [claim()],
      events: [
        ev({
          type: 'evaluatorMutatedWorktree',
          ord: 4,
          attempt: 0,
          cli: 'codex',
          phase: 'verify',
          changed: [{ status: 'D', path: 'src/fix.ts' }],
          headMoved: false,
        }),
      ],
    });
    expect(view.guardrailed).toBe(false);
    expect(view.enforcement.status).toBe('unenforced');
  });

  it('a documentation-only write is a violation too — the guard has NO exemptions (codex on wicked-core#414)', () => {
    const res = resolveEnforcement([
      ev({ type: 'governanceContextArmed', ord: 4, attempt: 0, path: 'wrapped_cli' }),
      ev({
        type: 'evaluatorMutatedWorktree',
        ord: 4,
        attempt: 0,
        cli: 'claude',
        phase: 'adversarial-review',
        changed: [{ status: 'A', path: 'docs/review.md' }],
        headMoved: false,
      }),
    ]);
    expect(res.status).toBe('unenforced');
    expect(res.unenforced).toHaveLength(1);
    expect(res.unenforced[0]).toMatchObject({ ord: 4, kind: 'worktree_mutation' });
    expect(res.unenforced[0]!.reason).toMatch(/A docs\/review\.md/);
  });

  it('the event is gate evidence, not a governance signal: alone it never makes a run enforced (Copilot on #507)', () => {
    // An UNGOVERNED run whose evaluator rewrote a file: no armed signal anywhere. The mutation is a
    // violation on its own (`unenforced`) — what the event must never do is stand in for a
    // governed signal: strip the mutation and the same run is `ungoverned`, never `enforced`.
    const res = resolveEnforcement([
      ev({
        type: 'evaluatorMutatedWorktree',
        ord: 4,
        attempt: 0,
        cli: 'codex',
        phase: 'verify',
        changed: [{ status: 'M', path: 'README.md' }],
        headMoved: false,
      }),
    ]);
    expect(res.status).toBe('unenforced');
    expect(res.armedUnits).toEqual([]);
    const view = resolveConformance({ runId: 'run-1', claims: [claim()], events: [
      ev({ type: 'evaluatorMutatedWorktree', ord: 4, attempt: 0, cli: 'codex', phase: 'verify', changed: [{ status: 'M', path: 'README.md' }], headMoved: false }),
    ] });
    expect(view.guardrailed).toBe(false);
    expect(view.enforcement.status).toBe('unenforced');
    // The counterfactual: with no mutation event at all, the same (ungoverned) run is `ungoverned`.
    expect(resolveEnforcement([]).status).toBe('ungoverned');
  });

  it('each class of the unenforced headline names ONLY its own seats, classified by kind (Copilot on #507)', () => {
    const res = resolveEnforcement([
      ev({ type: 'governanceUnenforced', ord: 2, attempt: 0, cli: 'codex', reason: 'no adapter' }),
      ev({
        type: 'evaluatorMutatedWorktree',
        ord: 4,
        attempt: 0,
        cli: 'pi',
        phase: 'verify',
        changed: [{ status: 'M', path: 'src/app.ts' }],
        headMoved: false,
      }),
    ]);
    expect(res.status).toBe('unenforced');
    expect(res.unenforced.map((u) => u.kind)).toEqual(['unchecked_tool_calls', 'worktree_mutation']);
    expect(res.reason).toMatch(/UNCHECKED tool calls on codex \(/);
    expect(res.reason).not.toMatch(/UNCHECKED tool calls on codex, pi/);
    expect(res.reason).toMatch(/CHANGED the worktree under review on pi/);
  });

  it('a moved HEAD with an identical tree is still a violation (the run branch is no longer the creator\'s)', () => {
    const res = resolveEnforcement([
      ev({
        type: 'evaluatorMutatedWorktree',
        ord: 4,
        attempt: 1,
        cli: 'pi',
        phase: 'verify',
        changed: [],
        headMoved: true,
      }),
    ]);
    expect(res.status).toBe('unenforced');
    expect(res.unenforced[0]!.reason).toMatch(/HEAD moved/);
  });
});

describe('IG1-crew-2 — per-unit governance records + contained', () => {
  const seats: Record<string, Record<string, unknown>> = {
    claude: { key: 'claude', governance_class: 'acp_input_governance', acp: { acp_input_governance: true } },
    pi: { key: 'pi', governance_class: 'os_sandbox', acp: { acp_input_governance: false, os_sandbox: false } },
    codex: { key: 'codex', governance_class: 'os_sandbox', trust_flags: ['--sandbox', 'workspace-write'] },
  };
  const ctx = (bound: boolean) => ({
    bound,
    worktree: bound ? '/w/run-1' : null,
    extraWriteRoots: ['/w/evidence'],
    seatOf: (cli: string) => seats[cli] as never,
  });

  it('a gate-armed unit is admitted; the run stays enforced and lists it', () => {
    const view = resolveEnforcement(
      [
        ev({ type: 'unitDistributed', ord: 0, cli: 'claude' }),
        ev({ type: 'governanceContextArmed', ord: 0, attempt: 0 }),
        ev({ type: 'unitOutputCaptured', ord: 0, attempt: 0, governed: true }),
      ],
      ctx(true),
    );
    expect(view.status).toBe('enforced');
    expect(view.units).toEqual([
      expect.objectContaining({ ord: 0, attempt: 0, cli: 'claude', mode: 'admitted', source: 'acp_input_governance' }),
    ]);
  });

  it("governed: true without a hook on a floor seat (the engine's os_sandbox marker) ⇒ os_sandbox, status contained, the fence naming the worktree", () => {
    const view = resolveEnforcement(
      [
        ev({ type: 'unitDistributed', ord: 1, cli: 'pi' }),
        ev({ type: 'sandboxPosture', ord: 1, cli: 'pi', posture: 'os', reason: '' }),
        ev({ type: 'unitOutputCaptured', ord: 1, attempt: 0, governed: true }),
      ],
      ctx(true),
    );
    expect(view.status).toBe('contained');
    expect(view.units[0]).toMatchObject({ cli: 'pi', mode: 'os_sandbox', source: 'repo_boundary', fence: { write_roots: ['/w/run-1', '/w/evidence'], network: 'open' } });
    expect(view.reason).toMatch(/OS-sandbox floor, not a per-call gate — writes fenced to \/w\/run-1, \/w\/evidence/);
    // codex is held by its own sandbox.
    const codex = resolveEnforcement(
      [ev({ type: 'unitDistributed', ord: 2, cli: 'codex' }), ev({ type: 'unitOutputCaptured', ord: 2, attempt: 0, governed: true })],
      ctx(true),
    );
    expect(codex.units[0]).toMatchObject({ mode: 'os_sandbox', source: 'self' });
  });

  it('governanceUnenforced on a BOUND run ⇒ os_sandbox / repo_boundary, enforced: undisclosed, status contained (never guardrailed)', () => {
    const events = [
      ev({ type: 'unitDistributed', ord: 1, cli: 'pi' }),
      ev({ type: 'sandboxPosture', ord: 1, cli: 'pi', posture: 'advisory', reason: 'no_launcher' }),
      ev({ type: 'governanceUnenforced', ord: 1, attempt: 0, cli: 'pi', reason: 'the floor did not arm: no_launcher' }),
      ev({ type: 'sandboxUnenforced', ord: 1, attempt: 0, cli: 'pi', level: 'best-effort', reason: 'no_launcher' }),
      ev({ type: 'unitOutputCaptured', ord: 1, attempt: 0, governed: false }),
    ];
    const view = resolveEnforcement(events, ctx(true));
    expect(view.status).toBe('contained');
    expect(view.unenforced).toEqual([]);
    expect(view.units).toEqual([
      expect.objectContaining({ ord: 1, cli: 'pi', mode: 'os_sandbox', source: 'repo_boundary', enforced: 'undisclosed', fence: expect.objectContaining({ write_roots: ['/w/run-1', '/w/evidence'] }) }),
    ]);
    const conf = resolveConformance({ runId: 'run-1', claims: [], events, enforcementContext: ctx(true) });
    expect(conf.guardrailed).toBe(false);
    // The same unit on an UNBOUND run is none and still unenforced (deny-dominates).
    const unbound = resolveEnforcement(events, ctx(false));
    expect(unbound.status).toBe('unenforced');
    expect(unbound.units[0]).toMatchObject({ mode: 'none', source: 'none' });
  });

  it('without a context the record still lists units, and the pre-IG1 reading holds (unenforced stays unenforced)', () => {
    const view = resolveEnforcement([ev({ type: 'governanceUnenforced', ord: 3, attempt: 1, cli: 'agy', reason: 'no adapter' })]);
    expect(view.status).toBe('unenforced');
    expect(view.units).toEqual([expect.objectContaining({ ord: 3, attempt: 1, cli: 'agy', mode: 'none' })]);
    const governed = resolveEnforcement([ev({ type: 'unitOutputCaptured', ord: 0, attempt: 0, governed: true })]);
    expect(governed.status).toBe('enforced');
    expect(governed.units[0]).toMatchObject({ mode: 'admitted' });
  });
});
