/**
 * The acceptance gate: deny-dominates resolution of a workflow's acceptance
 * requirement from the QE evidence ledger (Phase 6a made crew the
 * control-plane owner of the gate; Phase 6c retired wicked-testing, so the
 * QE pipeline is garden's qe skills writing through wicked-ledger).
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
 *
 *   Verdict vocabulary (garden ≥ 12.37.0, fixall L6): a garden evaluator's
 *   OUTPUT line is `VERDICT: PASS` or `VERDICT: FAIL` only — the engine's
 *   evaluator gate reads the LAST such line and passes on the token PASS
 *   alone, so CONDITIONAL, PARTIAL, INCONCLUSIVE, N-A and SKIP are legacy
 *   RECORD values that older ledgers (and the specialists' DomainStore
 *   records) still carry. This mapping keeps resolving them 1:1 — the enum
 *   and the table are unchanged — so a ledger written by any generation
 *   reads the same here.
 *   missing ledger / verdict   → denied (no evidence is never a pass)
 *   unreadable ledger          → denied, naming the read failure
 *
 * The verdict enum and the status mapping follow garden's qe `accept` action
 * (VERDICT_TO_STATUS) and wicked-ledger's `RunStatus` — this module maps 1:1
 * and never collapses distinct non-PASS outcomes into one another; only the
 * GATE decision collapses (everything not PASS denies), and each denial keeps
 * its own reason.
 */

import type { Verdict } from 'wicked-ledger/manifest';
import { VERDICT_VALUES } from 'wicked-ledger/manifest';
import type {
  GovernanceClaim,
  RecordedEvent,
  RepoEntry,
  SessionView,
  WorkflowDef,
} from '../core/types.js';
import { runIdentityOf, runWorkflowDef } from '../core/run-identity.js';
import { basename } from 'node:path';
import type {
  QeAcceptanceState,
  QeAttribution,
  QeManifestSummary,
  ReadSubject,
  RunLinkage,
} from './ledger.js';
import { describeAttribution, readAcceptanceState, summarizeManifest } from './ledger.js';
import type { RunConformance } from './conformance.js';
import { resolveConformance } from './conformance.js';

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
 * A run's acceptance requirement, read from what the run CONTAINS (seam X2, round 2).
 *
 *   - A preset or user-plan run: its units whose catalog entry declares `verified_evidence`
 *     (`test`, `domain_coverage` today — read from the engine's `Core.catalog()`, never a list
 *     here). No registered def is consulted, so a preset whose def is deleted, and a user plan
 *     (which has none), declare exactly what they will run.
 *   - A non-team run of a registered workflow: that def's `verified_evidence` phases.
 *   - A free-text run: nothing.
 *   - Anything the daemon cannot read — an UNKNOWN run, a plan run whose steps carry no catalog
 *     ids yet, an engine whose catalog does not say which entries carry verified evidence, a
 *     workflow run whose def is no longer registered — is DECLARED and fails closed: `failClosed`
 *     names why, and the gate denies with that reason whatever the ledger holds.
 */
export interface AcceptanceRequirement {
  declared: boolean;
  phases: string[];
  /** Set when the requirement could not be read: the gate denies with this reason. */
  failClosed?: string;
}

/** The unit's phase id — the `<run>:<phase>` suffix. */
function unitPhaseId(unitId: string): string {
  const at = unitId.indexOf(':');
  return at >= 0 ? unitId.slice(at + 1) : unitId;
}

/**
 * Resolve {@link AcceptanceRequirement} for a run. `verifiedCatalog` is the set of catalog ids whose
 * entry declares `verified_evidence` (`null`: the engine's catalog does not say — fail closed for a
 * plan run). Pure.
 */
export function acceptanceRequirementOf(
  view: SessionView,
  workflows: WorkflowDef[],
  verifiedCatalog: ReadonlySet<string> | null,
): AcceptanceRequirement {
  const identity = runIdentityOf(view);
  const closed = (why: string): AcceptanceRequirement => ({
    declared: true,
    phases: [],
    failClosed: `${why} (unknown ⇒ deny)`,
  });
  switch (identity.kind) {
    case 'unknown':
      return closed(
        "the run's identity is unknown — the daemon has no record of what its launch named, so its acceptance requirement cannot be read",
      );
    case 'free_text':
      return { declared: false, phases: [] };
    case 'workflow': {
      const def = runWorkflowDef(view, workflows);
      if (def === null) {
        return closed(`the run's workflow \`${identity.name ?? '?'}\` is not registered, so its acceptance requirement cannot be read`);
      }
      const phases = acceptancePhaseIds(def);
      return { declared: phases.length > 0, phases };
    }
    case 'preset':
    case 'user_plan': {
      // X1 (wicked-core#633): while the PA scopes a plan that declared no `touch`, the run's only
      // unit is the read-only `pa-scope` step — what it will contain is not decided yet, so reading
      // its units now would declare no requirement (fail OPEN).
      if (view.session.team_plan?.scope != null) {
        return closed("the run's plan is still being scoped by its PA, so its steps are not decided yet");
      }
      const units = [...(view.units ?? [])].sort((a, b) => a.ord - b.ord);
      if (units.length === 0) return closed("the run's plan has no planned steps yet");
      if (units.some((u) => typeof u.catalog !== 'string' || u.catalog === '')) {
        return closed("the run's steps do not all carry a catalog id, so which of them re-verify evidence cannot be read");
      }
      if (verifiedCatalog === null) {
        return closed(
          "the engine's phase catalog does not say which entries declare verified evidence (an engine before `CatalogEntry.verified_evidence`)",
        );
      }
      const phases = units.filter((u) => verifiedCatalog.has(u.catalog as string)).map((u) => unitPhaseId(u.id));
      return { declared: phases.length > 0, phases };
    }
  }
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
  failClosed?: string,
): AcceptanceGateResolution {
  const verdictValue = state?.verdict?.verdict ?? null;
  const verdict = verdictValue !== null ? asVerdict(verdictValue) : null;
  const runStatus = verdict !== null ? (VERDICT_TO_STATUS[verdict] ?? 'inconclusive') : null;
  const base = { required: required || failClosed !== undefined, verdict, runStatus };

  if (failClosed !== undefined) {
    // The requirement itself could not be read: deny, naming why — never a vacuous pass.
    return { ...base, satisfied: false, reason: failClosed };
  }

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
    // F-E2E-034: say what THIS gate reads — the QE ledger — and only that. `required` is true for
    // engine-gated defs too (`bug.verify`, `feature.test`), so "no acceptance evidence recorded"
    // was false for a bug run whose repo-check and evaluator evidence sits on GET /runs/:id/evidence.
    // Verdict unchanged: missing ⇒ deny (deny-dominates).
    return {
      ...base,
      satisfied: false,
      reason:
        `no QE ledger at ${state.root} — no QE run has recorded a verdict for this repository; ` +
        'this gate reads the QE ledger only (the run\'s own repo-check and evaluator evidence is on ' +
        'GET /runs/:id/evidence) (missing ⇒ deny)',
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
    if (state.ledgerVerdicts === 0) {
      return {
        ...base,
        satisfied: false,
        reason: `QE ledger at ${state.root} records no verdict (missing ⇒ deny)`,
      };
    }
    // The ledger has verdicts — none of them is THIS run's (F-E2E-013). A verdict that
    // predates the run, or belongs to a QE run nothing ties to it, is evidence about the repo's
    // past, not about this run; serving it as the run's PASS was the regression.
    const why = state.attribution.kind === 'none' ? state.attribution.reason : 'not attributed';
    return {
      ...base,
      satisfied: false,
      reason: `QE ledger at ${state.root} holds no verdict attributed to this run — ${why} (unattributed ⇒ deny)`,
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

  // HOW the verdict is this run's rides the reason (review of #539, F6): an inferred lifetime
  // linkage must read differently from a writer's stamp or a caller's pin — and when several QE
  // runs are attributed, the reader must know the answer was resolved deny-dominates across them.
  const breadth =
    state.attributedVerdicts > 1
      ? `; ${state.attributedVerdicts} QE runs are attributed to this run — deny-dominates across their newest verdicts`
      : '';
  const cite = `verdict ${state.verdict.id} by ${state.verdict.reviewer} (${describeAttribution(state.attribution)}${breadth})`;
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
    /**
     * How `verdict` was tied to THIS run (`pinned` by `?qeRun`, `stamped` with the run id by the
     * writer, or a QE run inside the run's lifetime) — or `none`, with the reason naming what the
     * ledger does hold. The body never serves a repo-wide "newest verdict" as the run's (F-E2E-013).
     */
    attribution: QeAttribution;
    /** How many live verdicts the whole ledger holds, attributed or not. */
    ledgerVerdicts: number;
    /**
     * How many QE runs are attributed to this run — the deny-dominates set `verdict` was resolved
     * over (each contributes its newest verdict; any non-PASS among them denies). 0 when none.
     */
    attributedVerdicts: number;
    error?: string;
  } | null;
  gate: AcceptanceGateResolution;
  /**
   * The governance half, BESIDE the QE gate (AW-14 / arch-R13a + R16): this run's conformance
   * claims (wiki rule ids cited), its enforcement status, and the deny-dominates `guardrailed`
   * headline. Never claims guardrailed for an unenforced, ungoverned, or unverifiable run.
   */
  conformance: RunConformance;
}

/**
 * The frames that close a run's lifetime — one per terminal `SessionStatus` the engine defines
 * (wicked-core `src/domain.rs`: `Completed`, `Failed`, `Cancelled`), spelled as the engine emits
 * them (`src/event.rs` `event_to_json`: `sessionCompleted`, `sessionFailed`, `runCancelled`).
 * Pinned from the source, not from memory: the first cut named a `sessionCancelled` frame the
 * engine never emits, so a CANCELLED run's window never closed and any later QE PASS on the repo
 * was attributed to it (review of #539, F1). `runOrphaned` is deliberately absent — an orphaned
 * run is still `executing` and resumable, not finished.
 */
export const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'sessionCompleted',
  'sessionFailed',
  'runCancelled',
]);

/**
 * The terminal frames the engine will NOT resume from: `resume_run_inner` returns a `Completed` or
 * `Cancelled` run's status unchanged (wicked-core `src/actor.rs`, the `Completed | Cancelled`
 * early return) and re-dispatches only a `Failed` one. So once one of these is recorded the window
 * is closed for good; `sessionFailed` alone can be followed by a `resumed` frame (r2 review, N1).
 */
export const FINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['sessionCompleted', 'runCancelled']);

/**
 * The frames that prove a run is LIVE AGAIN after a non-final terminal frame — the engine emits
 * each of them only for a run it is actively driving (wicked-core `src/event.rs` `event_to_json`):
 *   - `resumed` — emitted by `confirm_gate` when a human approves a gate (`src/actor.rs`, the only
 *     `CoreEvent::Resumed` emission). NOT by the failed-run resume path: `resume_run_inner` emits
 *     no frame of its own (r3 review, N3 — an earlier comment here claimed otherwise);
 *   - `unitDispatched` / `unitExecuting` / `toolExecutorDispatched` — `dispatch_unit`'s frames, the
 *     first thing a rescued run records after `POST /runs/:id/resume` re-dispatches its cursor unit;
 *   - `unitDistributed` — a (re)distribution for a unit, run-scoped and live-only as well.
 * `unitDone` / `unitDenied` / `unitPlanned` are deliberately NOT here: a straggling completion or
 * denial frame after a failure is not evidence the run went on (F4).
 */
export const REOPEN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'resumed',
  'unitDispatched',
  'unitExecuting',
  'toolExecutorDispatched',
  'unitDistributed',
]);

/**
 * The crew run's lifetime as its durable event log records it — the window a QE run must have
 * started inside to count as this run's evidence (F-E2E-013).
 *
 * `startedAt` is the capture time of the `sessionStarted` frame (the earliest frame's, for a log
 * that lacks one). `finishedAt` follows the frames IN LOG ORDER: a terminal frame closes the window
 * at its capture time; a later {@link REOPEN_EVENT_TYPES} frame reopens it — a FAILED run is
 * resumable under the same id (`POST /runs/:id/resume` → engine `resume_run_inner`, which
 * re-dispatches the cursor unit and runs the run on to its own `sessionCompleted`), so QE evidence
 * recorded after the rescue is that run's, whether the run is still executing (its execution
 * frames reopen the window — r3 review, N3) or has since completed (r2 review, N1).
 * `sessionCompleted` / `runCancelled` are FINAL: the engine refuses to resume either, so nothing
 * after them reopens the window. Any other frame is ignored — a straggling non-terminal frame
 * after the end does not reopen anything (F4). A log with no terminal frame (or one whose last
 * terminal frame was followed by execution) belongs to a live run, whose window stays open. A
 * `null` or empty log places the run nowhere in time, so it can link nothing — and when the log
 * could not be READ (`unreadable`), the linkage carries that cause so the denial names it instead
 * of "no sessionStarted" (F5).
 *
 * Chosen over gating on `session.status`: the log is what the route already reads for this
 * purpose, it needs no second engine call, and it yields the same answer — a rescued run's
 * persisted status is non-terminal from its re-dispatch until its next terminal frame, which is
 * exactly the span between the reopening frame and the frame that closes the scan again.
 */
export function runWindowFromEvents(
  events: RecordedEvent[] | null,
  runId: string,
  unreadable?: string,
): RunLinkage {
  if (unreadable !== undefined) return { runId, startedAt: null, finishedAt: null, logUnreadable: unreadable };
  if (events === null || events.length === 0) return { runId, startedAt: null, finishedAt: null };
  const at = (e: RecordedEvent): number | null =>
    typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : null;
  const started = events.find((e) => e.type === 'sessionStarted');
  let startedAt = started !== undefined ? at(started) : null;
  if (startedAt === null) {
    for (const e of events) {
      const t = at(e);
      if (t !== null && (startedAt === null || t < startedAt)) startedAt = t;
    }
  }
  let finishedAt: number | null = null;
  for (const e of events) {
    if (TERMINAL_EVENT_TYPES.has(e.type)) {
      finishedAt = at(e) ?? finishedAt;
      if (FINAL_EVENT_TYPES.has(e.type)) break; // nothing the engine emits after these reopens the run
    } else if (REOPEN_EVENT_TYPES.has(e.type) && finishedAt !== null) {
      finishedAt = null; // a failed run rescued and executing again: live until its next terminal frame
    }
  }
  return { runId, startedAt, finishedAt };
}

/**
 * Assemble the acceptance view for one crew run: read the run's event log,
 * read the ledger SCOPED TO THIS RUN (a read-only canonical-JSON read — the
 * read that needs no bus) and resolve the gate.
 */
export async function buildAcceptanceView(opts: {
  runId: string;
  repo: RepoEntry | null;
  /** What the run must prove ({@link acceptanceRequirementOf}). */
  requirement: AcceptanceRequirement;
  qeRunId?: string;
  /**
   * Loader for the conformance store's claims (the adapter's `listConformanceClaims`). Optional so
   * older callers keep compiling — but ABSENT reads as "claims unreadable", never as "no claims":
   * the conformance section reports `claimsAvailable: false` rather than a clean empty list.
   */
  claims?: () => Promise<GovernanceClaim[]>;
  /**
   * Loader for the run's durable event log (the adapter's `runEvents`; `null` = no binding).
   * Optional with the same contract: absent or failing reads as `unverifiable` enforcement — an
   * unknown enforcement state is never reported guardrailed (arch-R16).
   */
  events?: (runId: string) => Promise<RecordedEvent[] | null>;
}): Promise<AcceptanceView> {
  const { phases, failClosed } = opts.requirement;
  const required = opts.requirement.declared;

  // The run's durable event log, read FIRST: it is both the conformance section's enforcement
  // record and the ledger read's linkage — a verdict is this run's only if its QE run falls inside
  // the lifetime the log records (or the writer stamped the run id). An unreadable or absent log
  // means an unknown window, and an unknown window links nothing (F-E2E-013).
  let eventRows: RecordedEvent[] | null = null;
  let eventsError: string | undefined;
  if (opts.events !== undefined) {
    try {
      eventRows = await opts.events(opts.runId);
    } catch (err) {
      eventRows = null; // unreadable log ⇒ unverifiable enforcement, by resolveConformance's rule
      eventsError = err instanceof Error ? err.message : String(err);
    }
  }
  const subject: ReadSubject =
    opts.qeRunId !== undefined
      ? { qeRunId: opts.qeRunId }
      : { run: runWindowFromEvents(eventRows, opts.runId, eventsError) };

  const state = opts.repo !== null ? await readAcceptanceState(opts.repo.root_path, subject) : null;
  const gate = resolveAcceptanceGate(required, state, failClosed);

  // The conformance half. Loader failures are NAMED, not flattened into an empty list — the
  // section's own resolution turns "unreadable" into "not claimed clean" (deny-dominates).
  let claimRows: GovernanceClaim[] | null = null;
  let claimsError: string | undefined;
  if (opts.claims !== undefined) {
    try {
      claimRows = await opts.claims();
    } catch (err) {
      claimsError = err instanceof Error ? err.message : String(err);
    }
  } else {
    claimsError = 'claims loader not wired';
  }
  const conformance = resolveConformance({
    runId: opts.runId,
    claims: claimRows,
    ...(claimsError !== undefined ? { claimsError } : {}),
    events: eventRows,
  });

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
            // The dirname actually resolved (dual-read may have picked the
            // legacy `.wicked-testing` root) — not the configured default.
            ledgerDir: basename(state.root),
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
            attribution: state.attribution,
            ledgerVerdicts: state.ledgerVerdicts,
            attributedVerdicts: state.attributedVerdicts,
            ...(state.error !== undefined ? { error: state.error } : {}),
          }
        : null,
    gate,
    conformance,
  };
}
