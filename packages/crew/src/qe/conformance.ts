/**
 * The acceptance view's CONFORMANCE section (AW-14 / arch-R13a + arch-R16).
 *
 * `GET /runs/:id/acceptance` used to resolve ONLY the QE ledger verdict, while
 * governance conformance claims were served on a separate route
 * (`/governance/claims`) nobody stands in front of — so a wiki-rule violation
 * never appeared where humans actually look at a run's "is it done?". This
 * module derives the missing half and `buildAcceptanceView` serves it BESIDE
 * the QE gate: two verdicts, one page, deny-dominates on both.
 *
 * Three honesty rules, all deny-dominant:
 *
 * 1. **Run-scoped claims, cited.** Claims are filtered to THIS run's scope
 *    (`wicked-agent/<runId>/shared` | `wicked-agent/<runId>/unit/<u>`, the
 *    engine's `scope.rs` grammar) and each `conform:` obligation is parsed
 *    back into the wiki/conformance rule it cites (severity, rule id,
 *    statement — the `attach_recalled_rules` format), so a denial names the
 *    rule that was violated instead of an opaque string.
 *
 * 2. **"Guardrailed" is a verified claim, never a default.** A run whose
 *    workflow declared governed units but whose CLI has no gate-hook adapter
 *    runs with UNCHECKED tool calls and only leaves a `governanceUnenforced`
 *    event behind (gate-hook injection is claude-only — FINDING-063,
 *    `execute_wrapped.rs`). This section reads the run's durable event log and
 *    reports `enforcement.status` accordingly; `guardrailed` is true ONLY when
 *    enforcement was positively observed armed and nothing reported unenforced.
 *    An unreadable event log is `unverifiable` — unknown is never guardrailed.
 *
 * 3. **Unreadable is not clean.** A claims wire that cannot be read yields
 *    `claimsAvailable: false` plus the error — never an empty list wearing a
 *    "no denials" face.
 *
 * COVERAGE BOUNDARY (write-it-down half of arch-R16): deterministic per-tool-
 * call input governance exists for claude only. Units routed to any other CLI
 * (Antigravity, Codex, local, …) get phase-boundary coverage only — the
 * in-process `apply_unit` output gate and the deliverable floor — which
 * evaluates the unit's OUTPUT after the fact and cannot block a tool call
 * mid-flight. A governed unit on a non-claude CLI is therefore reported here
 * as `unenforced`, not silently folded into "guardrailed". The same boundary
 * is documented in the README's acceptance section.
 *
 * Coordinates crew#311 (vacuous unit completion passes gates): same
 * gate-honesty seam, different defect — #311 is about "done" being asserted
 * from an empty turn; this section is about governance claims/enforcement
 * being invisible or overclaimed. Neither fix closes the other.
 */

import type { GovernanceClaim, RecordedEvent } from '../core/types.js';

/** Scope prefix the engine stamps on every run-scoped governance artifact (`scope.rs`). */
const RUN_SCOPE_PREFIX = 'wicked-agent/';

/** Evaluator identity of filesystem-boundary denies (`gate_hook.rs` BOUNDARY_EVALUATOR). */
const BOUNDARY_EVALUATOR = 'wicked-governance-boundary';
/** Claim-id prefix of an ADVISORY boundary READ deny (`gate_hook.rs` BOUNDARY_READ_DENY_PREFIX). */
const BOUNDARY_READ_DENY_PREFIX = 'boundary-read-deny:';

/** A wiki/conformance rule cited by a claim's `conform:` obligation. */
export interface ConformanceRuleCitation {
  /** `Critical` | `Error` | `Warn` | `Info` — the rule's `ConfSeverity`, as serialized. */
  severity: string;
  /** The conformance-rule id (`PAT-*` / `POL-*`) — the wiki rule the claim cites. */
  ruleId: string;
  /** The rule's prescriptive statement. */
  statement: string;
}

/** One of this run's governance decisions, run-scoped and with its rule citations parsed. */
export interface RunConformanceClaimView {
  claimId: string;
  scope: string;
  phase: string;
  decision: 'allow' | 'deny' | 'allow_with_conditions';
  policyIds: string[];
  /** Wiki/conformance rules cited by `conform:` obligations — the ruleset the output had to meet. */
  rules: ConformanceRuleCitation[];
  /** Every obligation, verbatim (includes the unparsed originals of `rules`). */
  obligations: string[];
  evaluator: string;
  /** Unix-seconds timestamp of evaluation. */
  evaluatedAt: number;
  /**
   * True for an ADVISORY boundary READ deny: the tool call WAS blocked, but a blocked read leaks
   * nothing, so it is audit-only and not unit-fatal (core#219). Mirrors the engine's
   * `is_advisory_boundary_read_deny` exactly — evaluator identity AND claim-id prefix, so a policy
   * deny can never be downgraded to advisory.
   */
  advisory: boolean;
}

/** A unit the workflow declared governed that ran with UNCHECKED tool calls (FINDING-063). */
export interface UnenforcedUnit {
  ord: number;
  attempt: number;
  cli: string;
  reason: string;
}

/** What the run's durable event log says about whether governance was actually IN FORCE. */
export interface GovernanceEnforcementView {
  /**
   * - `enforced`     — enforcement positively observed armed; nothing reported unenforced.
   * - `unenforced`   — ≥1 governed unit ran with unchecked tool calls (`governanceUnenforced`).
   * - `ungoverned`   — the log is readable and carries no governance signal at all: the run never
   *                    asked for governance. Not a failure — but never "guardrailed" either.
   * - `unverifiable` — the event log could not be read; unknown is never guardrailed.
   */
  status: 'enforced' | 'unenforced' | 'ungoverned' | 'unverifiable';
  /** The governed-but-unchecked units, verbatim from their events. Empty unless `unenforced`. */
  unenforced: UnenforcedUnit[];
  /** Ords of units whose governance context was confirmed armed (`governanceContextArmed`). */
  armedUnits: number[];
  /** Why the status is what it is — always populated. */
  reason: string;
}

/** The conformance half of the acceptance view — served beside the QE gate. */
export interface RunConformance {
  /** Whether the claims wire could be read at all. False is NOT "no denials". */
  claimsAvailable: boolean;
  /** The read failure, when `claimsAvailable` is false for a reason other than a missing binding. */
  claimsError?: string;
  /** This run's claims (run-scope filtered), oldest first. */
  claims: RunConformanceClaimView[];
  /** Non-advisory deny claims — the ones that stand against the run. */
  denials: number;
  /** Advisory boundary-read denies — blocked, audited, not unit-fatal. */
  advisoryDenials: number;
  /** Deny-dominates over the run's READ claims: true when any non-advisory deny stands. */
  denied: boolean;
  enforcement: GovernanceEnforcementView;
  /**
   * The ONE headline, deny-dominates across everything above: true ONLY when the claims wire was
   * readable, no non-advisory denial stands, AND enforcement was positively verified. An
   * unenforced, ungoverned, or unverifiable run is NEVER guardrailed (arch-R16).
   */
  guardrailed: boolean;
  /** One honest sentence for the surface beside the QE verdict. */
  summary: string;
}

/** Whether `scope` belongs to run `runId` under the engine's scope grammar. */
export function isRunScope(scope: string, runId: string): boolean {
  if (!scope.startsWith(RUN_SCOPE_PREFIX)) return false;
  const rest = scope.slice(RUN_SCOPE_PREFIX.length);
  // `<runId>/shared` or `<runId>/unit/<discriminator>` — exact segment match, so run id `r-1`
  // can never claim `r-10`'s scope by prefix accident.
  return rest === `${runId}/shared` || rest.startsWith(`${runId}/unit/`);
}

/**
 * Parse one `conform:<Severity>:<id>:<statement>` obligation (the `attach_recalled_rules` format)
 * into its rule citation. Statements may contain `:` freely — only the first three separators
 * split. Returns null for any obligation that is not a rule citation (boundary reasons, policy
 * obligations, free text): those stay visible verbatim in `obligations`.
 */
export function parseRuleCitation(obligation: string): ConformanceRuleCitation | null {
  if (!obligation.startsWith('conform:')) return null;
  const rest = obligation.slice('conform:'.length);
  const sevEnd = rest.indexOf(':');
  if (sevEnd <= 0) return null;
  const idEnd = rest.indexOf(':', sevEnd + 1);
  if (idEnd <= sevEnd + 1) return null;
  const severity = rest.slice(0, sevEnd);
  const ruleId = rest.slice(sevEnd + 1, idEnd);
  const statement = rest.slice(idEnd + 1);
  if (statement === '') return null;
  return { severity, ruleId, statement };
}

/** Mirror of the engine's `is_advisory_boundary_read_deny` (`gate_hook.rs`). */
export function isAdvisoryBoundaryReadDeny(claim: GovernanceClaim): boolean {
  return (
    claim.decision === 'deny' &&
    claim.evaluator_identity === BOUNDARY_EVALUATOR &&
    claim.claim_id.startsWith(BOUNDARY_READ_DENY_PREFIX)
  );
}

/** Map one store claim to its view row (citations parsed, advisory flagged). */
function toClaimView(claim: GovernanceClaim): RunConformanceClaimView {
  const rules: ConformanceRuleCitation[] = [];
  for (const ob of claim.obligations) {
    const cite = parseRuleCitation(ob);
    if (cite !== null) rules.push(cite);
  }
  return {
    claimId: claim.claim_id,
    scope: claim.scope,
    phase: claim.phase,
    decision: claim.decision,
    policyIds: claim.policy_ids,
    rules,
    obligations: claim.obligations,
    evaluator: claim.evaluator_identity,
    evaluatedAt: claim.evaluated_at,
    advisory: isAdvisoryBoundaryReadDeny(claim),
  };
}

/** Safe field reads off the loose `RecordedEvent` bag. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : -1;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Derive the enforcement view from the run's durable event log.
 *
 * `events === null` means the log could NOT be read (no binding, or the loader was not wired) —
 * which is `unverifiable`, never a quiet "enforced". An empty log is a real answer: no governance
 * signal ⇒ `ungoverned`.
 */
export function resolveEnforcement(events: RecordedEvent[] | null): GovernanceEnforcementView {
  if (events === null) {
    return {
      status: 'unverifiable',
      unenforced: [],
      armedUnits: [],
      reason:
        'run event log unavailable — enforcement cannot be verified (unknown is never guardrailed)',
    };
  }

  const unenforced: UnenforcedUnit[] = [];
  const armed = new Set<number>();
  let governedSignal = false;

  for (const ev of events) {
    switch (ev.type) {
      case 'governanceUnenforced':
        unenforced.push({
          ord: num(ev['ord']),
          attempt: num(ev['attempt']),
          cli: str(ev['cli']),
          reason: str(ev['reason']),
        });
        break;
      case 'governanceContextArmed':
        armed.add(num(ev['ord']));
        governedSignal = true;
        break;
      case 'governanceHookFired':
      case 'validationPinAttached':
        governedSignal = true;
        break;
      case 'unitOutputCaptured':
        if (ev['governed'] === true) governedSignal = true;
        break;
      default:
        break;
    }
  }
  const armedUnits = [...armed].sort((a, b) => a - b);

  if (unenforced.length > 0) {
    // Deny-dominates: ONE unchecked governed unit breaks the whole run's guardrail claim, even
    // when every other unit was armed — a chain with a named missing link.
    const clis = [...new Set(unenforced.map((u) => u.cli))].join(', ');
    return {
      status: 'unenforced',
      unenforced,
      armedUnits,
      reason:
        `${unenforced.length} governed unit(s) ran with UNCHECKED tool calls on ${clis} ` +
        '(gate-hook injection is claude-only; phase-boundary output gating still applied)',
    };
  }
  if (governedSignal) {
    return {
      status: 'enforced',
      unenforced: [],
      armedUnits,
      reason:
        armedUnits.length > 0
          ? `input governance confirmed armed for unit(s) ${armedUnits.join(', ')}; none reported unenforced`
          : 'governance activity recorded and no unit reported unenforced',
    };
  }
  return {
    status: 'ungoverned',
    unenforced: [],
    armedUnits: [],
    reason:
      'the run recorded no governance signal — nothing was enforced, so nothing is claimed guardrailed',
  };
}

/**
 * Assemble the conformance section: run-scoped claims + enforcement, resolved deny-dominates.
 *
 * `claims === null` means the claims wire could not be read (`claimsError` says why when known) —
 * reported as unavailable, never as an empty clean list.
 */
export function resolveConformance(opts: {
  runId: string;
  claims: GovernanceClaim[] | null;
  claimsError?: string;
  events: RecordedEvent[] | null;
}): RunConformance {
  const enforcement = resolveEnforcement(opts.events);

  const claimsAvailable = opts.claims !== null;
  const claims = (opts.claims ?? [])
    .filter((c) => isRunScope(c.scope, opts.runId))
    .sort((a, b) => a.evaluated_at - b.evaluated_at)
    .map(toClaimView);

  const denials = claims.filter((c) => c.decision === 'deny' && !c.advisory).length;
  const advisoryDenials = claims.filter((c) => c.decision === 'deny' && c.advisory).length;
  const denied = denials > 0;

  // The headline. Every conjunct is a positive verification; absence of evidence never passes.
  const guardrailed = claimsAvailable && !denied && enforcement.status === 'enforced';

  let summary: string;
  if (!claimsAvailable) {
    summary = `conformance claims unreadable${opts.claimsError !== undefined ? `: ${opts.claimsError}` : ''} — not claimed clean (unreadable is not clean)`;
  } else if (denied) {
    const cited = claims
      .filter((c) => c.decision === 'deny' && !c.advisory)
      .flatMap((c) => c.rules.map((r) => r.ruleId));
    summary =
      `${denials} governance denial(s) stand against this run` +
      (cited.length > 0 ? ` (rules cited: ${[...new Set(cited)].join(', ')})` : '') +
      ` — deny-dominates`;
  } else if (enforcement.status === 'enforced') {
    summary = `guardrailed — enforcement verified and ${claims.length} claim(s) carry no standing denial`;
  } else {
    // No denial read, but enforcement not verified: the enforcement reason IS the story.
    summary = `no standing denial, but NOT guardrailed — ${enforcement.reason}`;
  }

  return {
    claimsAvailable,
    ...(opts.claimsError !== undefined ? { claimsError: opts.claimsError } : {}),
    claims,
    denials,
    advisoryDenials,
    denied,
    enforcement,
    guardrailed,
    summary,
  };
}
