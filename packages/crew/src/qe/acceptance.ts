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
import type {
  GovernanceClaim,
  RecordedEvent,
  RepoEntry,
  SessionView,
  WorkflowDef,
} from '../core/types.js';
import { basename } from 'node:path';
import { DELIVER_PHASE_ID } from '../core/deliver.js';
import { DELIVERABLE_FLOOR_PHASE_ID } from '../core/deliverable-floor.js';
import type {
  QeAcceptanceState,
  QeAttribution,
  QeManifestSummary,
  ReadSubject,
  RunLinkage,
} from './ledger.js';
import { describeAttribution, readAcceptanceState, summarizeManifest } from './ledger.js';
import type { QeGateCache, QeGateEventEntry } from './gate-events.js';
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
 *
 * PER-RUN COMPOSITION (crew#293/#311, default-on since crew#393): a launch can append run-scoped
 * phases the definition never had — the deliverable floor, then the deliver phase — so a
 * delivered run's unit sequence is `<def's phases…, [verify-deliverables,] [deliver]>`. When the
 * exact sequence matches nothing, the trailing appendages are stripped (in reverse composition
 * order) and the match retried: the acceptance requirement lives on the DEFINITION, and a run
 * must not lose its gate because it also delivered. A def that carries its own `deliver` phase
 * (an operator overlay) still wins the EXACT match first, so stripping never mistakes a declared
 * phase for an appendage.
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
  const bySequence = (seq: string[]): WorkflowDef | null =>
    workflows.find(
      (w) => w.phases.length === seq.length && w.phases.every((p, i) => p.id === seq[i]),
    ) ?? null;
  const exact = bySequence(phases);
  if (exact !== null) return exact;
  const stripped = [...phases];
  if (stripped[stripped.length - 1] === DELIVER_PHASE_ID) stripped.pop();
  if (stripped[stripped.length - 1] === DELIVERABLE_FLOOR_PHASE_ID) stripped.pop();
  return stripped.length < phases.length ? bySequence(stripped) : null;
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
  /** The latest matching `wicked.qe.*` bus event, when the bus seam is armed and one was seen. */
  busEvent: QeGateEventEntry | null;
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
 * The crew run's lifetime as its durable event log records it — the window a QE run must have
 * started inside to count as this run's evidence (F-E2E-013).
 *
 * `startedAt` is the capture time of the `sessionStarted` frame (the earliest frame's, for a log
 * that lacks one); `finishedAt` is the capture time of the FIRST terminal frame found anywhere in
 * the log — once a run has ended, no later frame (a straggling non-terminal one, or a second
 * terminal one after a resume of a failed run) reopens the window (F1 hardening, F4). A log with
 * no terminal frame belongs to a live run, whose window stays open. A `null` or empty log places
 * the run nowhere in time, so it can link nothing — and when the log could not be READ (`unreadable`),
 * the linkage carries that cause so the denial names it instead of "no sessionStarted" (F5).
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
    if (!TERMINAL_EVENT_TYPES.has(e.type)) continue;
    const t = at(e);
    if (t !== null && (finishedAt === null || t < finishedAt)) finishedAt = t;
  }
  return { runId, startedAt, finishedAt };
}

/**
 * Assemble the acceptance view for one crew run: read the run's event log,
 * read the ledger SCOPED TO THIS RUN (a read-only canonical-JSON read — the
 * fallback that needs no bus), resolve the gate, and attach the freshest
 * matching bus event when the opt-in subscription has seen one.
 */
export async function buildAcceptanceView(opts: {
  runId: string;
  repo: RepoEntry | null;
  workflow: WorkflowDef | null;
  gateEvents: QeGateCache;
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
  const phases = acceptancePhaseIds(opts.workflow);
  const required = phases.length > 0;

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
  const gate = resolveAcceptanceGate(required, state);

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
    busEvent,
  };
}
