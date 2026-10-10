/**
 * What assures a DELIVERY (wicked-core#850, codex audit EX-03 / EX-04) — pure helpers the deliver
 * paths in `routes.ts` share.
 *
 * EX-03: a run whose assurance contract requires `qe_acceptance` (a workflow's
 * `required_instruments`; the engine carries it on `AgentSession.assurance.required` and leaves the
 * enforcement to the launcher) delivers ONLY on a QE verdict that is a PASS attributed to the run.
 * A FAIL, any other verdict, no verdict, an unattributed verdict or an unreadable ledger refuses the
 * delivery — at the deliver gate's approve, at a gated resume, and at a post-hoc lift. Nothing is
 * pushed, and a deliver gate stays open for the approve to be retried once the PASS is recorded.
 *
 * EX-04: a post-hoc lift (`POST /runs/:id/deliver`) has no engine verification behind the tree it
 * pushes, so it is labelled UNVERIFIED with the run's tree before and after the lift — in the PR
 * body (the deliver script, `DELIVER_UNVERIFIED_MARKER`) and in the run record
 * (`AgentSession.delivery_assurance`, rehydrated from the `run.delivered` audit entry).
 */

import type {
  AssuranceInstrument,
  AssuranceReceipt,
  AssuranceSkip,
  DeliveryAssurance,
  QeAcceptanceCheck,
  QeAcceptanceRefusal,
  SessionView,
  WorkUnit,
} from '../core/types.js';
import type { AcceptanceView } from '../qe/acceptance.js';

/** The contract token whose enforcement the engine leaves to the launcher. */
export const QE_ACCEPTANCE = 'qe_acceptance';

/** `QeAcceptanceRefusal.code`. */
export const QE_ACCEPTANCE_REQUIRED_CODE = 'qe_acceptance_required' as const;

/** Whether the run's persisted contract requires a QE acceptance PASS before delivery. A run from an
 *  engine without the contract carries none and requires nothing here (its gate is the old one). */
export function requiresQeAcceptance(view: SessionView): boolean {
  return (view.session.assurance?.required ?? []).includes(QE_ACCEPTANCE);
}

/** The check a delivery ran, from the acceptance view resolved with the requirement FORCED on (a
 *  contract that requires QE acceptance owes a verdict even when no phase raises `verified_evidence`). */
export function qeAcceptanceFromView(view: AcceptanceView): QeAcceptanceCheck {
  const verdict = view.acceptance?.verdict ?? null;
  return {
    satisfied: view.gate.satisfied,
    reason: view.gate.reason,
    verdictId: verdict?.id ?? null,
    reviewer: verdict?.reviewer ?? null,
  };
}

/** A check that could not be read at all is a refusal, naming why (deny-dominates). */
export function unreadableQeAcceptance(err: unknown): QeAcceptanceCheck {
  return {
    satisfied: false,
    reason: `the QE acceptance answer could not be read: ${err instanceof Error ? err.message : String(err)} (unreadable ⇒ deny)`,
    verdictId: null,
    reviewer: null,
  };
}

/** The 409 body of a delivery the QE acceptance requirement refused. */
export function qeAcceptanceRefusal(
  runId: string,
  check: QeAcceptanceCheck,
  assurance: AssuranceReceipt | null,
  where: 'gate' | 'post_hoc',
): QeAcceptanceRefusal {
  return {
    code: QE_ACCEPTANCE_REQUIRED_CODE,
    error:
      `run ${runId} requires QE acceptance (qe_acceptance) and its delivery is refused: ${check.reason}. ` +
      (where === 'gate'
        ? 'Nothing was pushed and the deliver gate stays open — record a PASS attributed to this run (garden qe accept), then approve again.'
        : 'Nothing was pushed — record a PASS attributed to this run (garden qe accept), then deliver again.'),
    acceptance: check,
    assurance,
  };
}

/** A unit's persisted receipt (`WorkUnit.assurance`), or `null`. */
export function receiptOf(unit: WorkUnit | undefined): AssuranceReceipt | null {
  return unit?.assurance ?? null;
}

/**
 * The run's receipts aggregated for a delivery no engine lift preceded (a post-hoc one): the
 * contract from the session (else the first receipt), every instrument any gate ran, every skip
 * (first reason per instrument), the delivered `tree`. The who-fields are per-gate facts with no
 * single answer across a run, so they are `null` here — each unit's receipt keeps its own.
 * `null` when the run carries neither a contract nor a receipt (an engine before the contract).
 */
export function aggregateReceipt(view: SessionView, tree: string | null): AssuranceReceipt | null {
  const receipts = (view.units ?? [])
    .slice()
    .sort((a, b) => a.ord - b.ord)
    .map((u) => u.assurance)
    .filter((r): r is AssuranceReceipt => r !== undefined && r !== null);
  const contract = view.session.assurance ?? (receipts[0] !== undefined ? { mode: receipts[0].mode, required: receipts[0].required } : null);
  if (contract === null) return null;
  const ran: AssuranceInstrument[] = [];
  const skipped: AssuranceSkip[] = [];
  for (const r of receipts) {
    for (const i of r.ran) if (!ran.includes(i)) ran.push(i);
    for (const s of r.skipped) if (!skipped.some((k) => k.instrument === s.instrument)) skipped.push(s);
  }
  return {
    mode: contract.mode,
    required: [...contract.required],
    ran,
    skipped,
    creator: null,
    evaluator: null,
    judge: null,
    tree,
    attempt: 0,
  };
}

/** The post-hoc delivery's assurance (EX-04): never verified, both trees named. */
export function postHocDeliveryAssurance(
  view: SessionView,
  trees: { treeBefore: string | null; treeAfter: string | null } | null,
  qeAcceptance: QeAcceptanceCheck | null,
): DeliveryAssurance {
  const treeAfter = trees?.treeAfter ?? null;
  return {
    verified: false,
    via: 'post_hoc',
    receipt: aggregateReceipt(view, treeAfter),
    treeBefore: trees?.treeBefore ?? null,
    treeAfter,
    qeAcceptance,
  };
}
