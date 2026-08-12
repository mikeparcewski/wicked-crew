/**
 * The acceptance gate: deny-dominates resolution of a workflow's acceptance
 * requirement from the QE evidence ledger (Phase 6a — crew becomes the
 * control-plane owner of the gate before wicked-testing retires in 6c).
 *
 * A workflow DECLARES an acceptance requirement through its phases: any phase
 * carrying `verified_evidence: true` requires its "done" to be re-derived from
 * evidence rather than asserted (the same field the engine's evidence floor
 * keys on). When a governed run's workflow declares one, crew resolves it from
 * the ledger's newest verdict — deny-dominates throughout:
 *
 *   PASS                       → satisfied
 *   FAIL                       → denied (the reviewer's reason is surfaced)
 *   CONDITIONAL                → denied — garden's VERDICT_TO_STATUS maps it to
 *                                run status `partial` ("approve with listed
 *                                fixes", a deliberate ship-with-conditions
 *                                outcome, distinct from PASS and FAIL). Under
 *                                deny-dominates a conditional approval does not
 *                                satisfy the gate on its own: the conditions
 *                                are unmet work, and the hold stands until a
 *                                clean PASS is recorded or a human approves at
 *                                the crew gate with the conditions in view.
 *   PARTIAL                    → denied (some criteria met — not all)
 *   INCONCLUSIVE / N-A / SKIP  → denied (evidence missing or not evaluated —
 *                                map to `inconclusive`, the `?? 'inconclusive'`
 *                                fallback of garden's convention)
 *   missing ledger / verdict   → denied (no evidence is never a pass)
 *   unreadable ledger          → denied, naming the read failure
 *
 * The verdict enum and the status mapping follow garden's qe `accept` action
 * (VERDICT_TO_STATUS) and wicked-ledger's `RunStatus` — this module maps 1:1
 * and never collapses distinct non-PASS outcomes into one another; only the
 * GATE decision collapses (everything not PASS denies), and each denial keeps
 * its own reason.
 */

import type { Verdict } from 'wicked-ledger';
import { VERDICT_VALUES } from 'wicked-ledger';
import type { RepoEntry, SessionView, WorkflowDef } from '../core/types.js';
import type { QeAcceptanceState, QeManifestSummary } from './ledger.js';
import { qeLedgerDirName, readAcceptanceState, summarizeManifest } from './ledger.js';
import type { QeGateCache, QeGateEventEntry } from './gate-events.js';

/**
 * Verdict → run-status, 1:1 with garden's qe `accept` action (VERDICT_TO_STATUS)
 * extended over the full ledger enum: N-A and SKIP take the convention's
 * `?? 'inconclusive'` fallback ("couldn't evaluate"), exactly as the accept
 * action computes `runStatus`. CONDITIONAL → `partial` is deliberate — a
 * ship-with-conditions outcome, not a clean pass and not a failure.
 */
export const VERDICT_TO_STATUS: Record<Verdict, string> = {
  PASS: 'passed',
  FAIL: 'failed',
  PARTIAL: 'partial',
  CONDITIONAL: 'partial',
  INCONCLUSIVE: 'inconclusive',
  'N-A': 'inconclusive',
  SKIP: 'inconclusive',
};

/** Ids of a workflow's phases that declare the acceptance requirement (`verified_evidence: true`). */
export function acceptancePhaseIds(workflow: WorkflowDef | null): string[] {
  if (workflow === null) return [];
  return workflow.phases.filter((p) => p.verified_evidence === true).map((p) => p.id);
}

/**
 * Resolve the workflow DEFINITION a run was launched with.
 *
 * The engine stores `workflow_id` as an instance id (`wf-<session-uuid>`), and
 * `sessionsDetail()` patches it back to the definition name by matching phase
 * sequences — against BUILT-INS only, so a run of a user-registered workflow
 * still carries the instance id here. The acceptance requirement lives on the
 * DEFINITION, so this falls back to the same phase-sequence match over the
 * full registry (built-ins + user workflows). Free-text runs are excluded by
 * construction: their planned units are `u1`, `u2`, … — not phase ids — and
 * they declare nothing.
 */
export function resolveRunWorkflow(
  run: SessionView,
  workflows: WorkflowDef[],
): WorkflowDef | null {
  const direct = workflows.find((w) => w.id === run.session.workflow_id);
  if (direct !== undefined) return direct;
  if (!run.session.workflow_id.startsWith('wf-')) return null;
  const phases = [...run.units]
    .sort((a, b) => a.ord - b.ord)
    .map((u) => {
      const colonIdx = u.id.indexOf(':');
      return colonIdx >= 0 ? u.id.slice(colonIdx + 1) : '';
    });
  if (phases.length === 0 || phases.some((p) => p === '' || /^u\d+$/.test(p))) return null;
  return (
    workflows.find(
      (w) => w.phases.length === phases.length && w.phases.every((p, i) => p.id === phases[i]),
    ) ?? null
  );
}

/** The gate's resolution of one run's acceptance requirement. */
export interface AcceptanceGateResolution {
  /** Whether the run's workflow declares an acceptance requirement at all. */
  required: boolean;
  /** Deny-dominates decision. `true` only for a clean PASS (or when nothing is required). */
  satisfied: boolean;
  /** The governing ledger verdict, when one was read. */
  verdict: Verdict | null;
  /** That verdict mapped through {@link VERDICT_TO_STATUS} (null when no verdict). */
  runStatus: string | null;
  /** Why the gate decided what it decided — always populated, never empty. */
  reason: string;
}

/** Narrow an arbitrary string from the store to the ledger's verdict enum. */
function asVerdict(value: string): Verdict | null {
  return (VERDICT_VALUES as readonly string[]).includes(value) ? (value as Verdict) : null;
}

/**
 * Resolve the acceptance requirement for one run — pure, deny-dominates.
 *
 * `state === null` means the run has no repo context at all (a repo-less run
 * has nowhere a ledger could live), which is its own denial reason: evidence
 * that cannot be LOCATED is indistinguishable from evidence that does not
 * exist, and neither satisfies a gate.
 */
export function resolveAcceptanceGate(
  required: boolean,
  state: QeAcceptanceState | null,
): AcceptanceGateResolution {
  const verdictValue = state?.verdict?.verdict ?? null;
  const verdict = verdictValue !== null ? asVerdict(verdictValue) : null;
  const runStatus = verdict !== null ? (VERDICT_TO_STATUS[verdict] ?? 'inconclusive') : null;
  const base = { required, verdict, runStatus };

  if (!required) {
    // Vacuous, and labeled as such: nothing was required, so nothing is held.
    // NOT a statement that evidence exists — the acceptance body says what was found.
    return {
      ...base,
      satisfied: true,
      reason: 'workflow declares no acceptance requirement (no verified_evidence phase)',
    };
  }
  if (state === null) {
    return {
      ...base,
      satisfied: false,
      reason: 'run has no repo context — acceptance evidence cannot be located (missing ⇒ deny)',
    };
  }
  if (!state.found) {
    return {
      ...base,
      satisfied: false,
      reason: `no QE ledger at ${state.root} — no acceptance evidence recorded (missing ⇒ deny)`,
    };
  }
  if (state.error !== undefined) {
    // Unreadable is NOT "absent": the remedy is fixing the store, not running QE again.
    return {
      ...base,
      satisfied: false,
      reason: `QE ledger at ${state.root} could not be read: ${state.error} (unreadable ⇒ deny)`,
    };
  }
  if (state.verdict === null) {
    return {
      ...base,
      satisfied: false,
      reason: `QE ledger at ${state.root} records no verdict (missing ⇒ deny)`,
    };
  }
  if (verdict === null) {
    // A verdict row outside the enum should be impossible (the store enforces
    // the enum pre-write and via CHECK constraint) — but an impossible row is
    // still not a PASS, and saying which row broke beats crashing the route.
    return {
      ...base,
      satisfied: false,
      reason: `verdict ${state.verdict.id} carries an out-of-enum value '${verdictValue}' (unrecognized ⇒ deny)`,
    };
  }

  const cite = `verdict ${state.verdict.id} by ${state.verdict.reviewer}`;
  switch (verdict) {
    case 'PASS':
      return { ...base, satisfied: true, reason: `PASS — ${cite}` };
    case 'FAIL':
      return {
        ...base,
        satisfied: false,
        reason: `FAIL — ${cite}${state.verdict.reason ? `: ${state.verdict.reason}` : ''}`,
      };
    case 'CONDITIONAL':
      return {
        ...base,
        satisfied: false,
        reason:
          `CONDITIONAL (run status 'partial') — approve-with-listed-fixes does not satisfy the gate on its own; ` +
          `hold until a clean PASS or a human approves with the conditions in view. ${cite}` +
          `${state.verdict.reason ? `: ${state.verdict.reason}` : ''}`,
      };
    case 'PARTIAL':
      return {
        ...base,
        satisfied: false,
        reason: `PARTIAL — some criteria met, not all; not a pass. ${cite}`,
      };
    default:
      // INCONCLUSIVE / N-A / SKIP — could not be (or was not) evaluated.
      return {
        ...base,
        satisfied: false,
        reason: `${verdict} — evidence was not conclusively evaluated; not a pass. ${cite}`,
      };
  }
}

/** The body `GET /runs/:id/acceptance` serves. */
export interface AcceptanceView {
  runId: string;
  repo: { id: string; name: string; rootPath: string } | null;
  requirement: { declared: boolean; phases: string[] };
  acceptance: {
    ledgerDir: string;
    ledgerRoot: string;
    found: boolean;
    qeRun: {
      id: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      projectId: string;
      scenarioId: string;
    } | null;
    verdict: {
      id: string;
      verdict: string;
      reviewer: string;
      reason: string | null;
      createdAt: string;
      qeRunId: string;
    } | null;
    manifest: QeManifestSummary | null;
    error?: string;
  } | null;
  gate: AcceptanceGateResolution;
  /** The latest matching `wicked.qe.*` bus event, when the bus seam is armed and one was seen. */
  busEvent: QeGateEventEntry | null;
}

/**
 * Assemble the acceptance view for one crew run: read the ledger (lazy read —
 * the fallback that needs no bus), resolve the gate, and attach the freshest
 * matching bus event when the opt-in subscription has seen one.
 */
export async function buildAcceptanceView(opts: {
  runId: string;
  repo: RepoEntry | null;
  workflow: WorkflowDef | null;
  gateEvents: QeGateCache;
  qeRunId?: string;
}): Promise<AcceptanceView> {
  const phases = acceptancePhaseIds(opts.workflow);
  const required = phases.length > 0;

  const state =
    opts.repo !== null
      ? await readAcceptanceState(
          opts.repo.root_path,
          opts.qeRunId !== undefined ? { qeRunId: opts.qeRunId } : undefined,
        )
      : null;
  const gate = resolveAcceptanceGate(required, state);

  // Freshness signal only — the ledger stays the system of record for the
  // gate. Keyed by the QE run id when the ledger named one, else by context
  // (the gate emitter's `context` is the QE project id).
  const busEvent =
    (state?.verdict !== null && state?.verdict !== undefined
      ? opts.gateEvents.forRun(state.verdict.run_id)
      : undefined) ??
    (state?.run != null ? opts.gateEvents.forContext(state.run.project_id) : undefined) ??
    null;

  return {
    runId: opts.runId,
    repo:
      opts.repo !== null
        ? { id: opts.repo.id, name: opts.repo.name, rootPath: opts.repo.root_path }
        : null,
    requirement: { declared: required, phases },
    acceptance:
      state !== null
        ? {
            ledgerDir: qeLedgerDirName(),
            ledgerRoot: state.root,
            found: state.found,
            qeRun:
              state.run !== null
                ? {
                    id: state.run.id,
                    status: state.run.status,
                    startedAt: state.run.started_at,
                    finishedAt: state.run.finished_at ?? null,
                    projectId: state.run.project_id,
                    scenarioId: state.run.scenario_id,
                  }
                : null,
            verdict:
              state.verdict !== null
                ? {
                    id: state.verdict.id,
                    verdict: state.verdict.verdict,
                    reviewer: state.verdict.reviewer,
                    reason: state.verdict.reason ?? null,
                    createdAt: state.verdict.created_at,
                    qeRunId: state.verdict.run_id,
                  }
                : null,
            manifest: state.manifest !== null ? summarizeManifest(state.manifest) : null,
            ...(state.error !== undefined ? { error: state.error } : {}),
          }
        : null,
    gate,
    busEvent,
  };
}
