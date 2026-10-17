// crew#1058 — the seats the ENGINE refuses as a reassign target for a unit, read from the run view.
//
// Mirrors wicked-core's `refuse_author_reassign` (src/actor.rs), with `seats_off_authors` and
// `pipeline::work_authors`: on a run whose contract enforces a distinct evaluator, a Review/Test
// AGENT unit (no `tool_cmd`, not a team member's step, not team-owned) may not be reassigned onto a
// seat that authored the work it checks — the current seat of every EARLIER Build/Recon agent unit
// plus every seat that unit was ever dispatched on (`authored_by`). Every other target is the
// engine's to judge.
//
// The ENGINE stays the authority: `POST /runs/:id/reassign` re-seats a parked unit first and the
// engine's own refusal is the 409. This is the read side only — the run DTO serves the set as
// `WorkUnit.reassign_refused`, so a skin never offers a seat the engine would refuse.
import type { SessionView } from './types.js';

type Unit = SessionView['units'][number];

const field = (u: Unit, key: string): unknown => (u as unknown as Record<string, unknown>)[key];

/** wicked-core `seats_off_authors`: a Review/Test agent unit the engine seats away from the authors. */
function seatsOffAuthors(u: Unit): boolean {
  return (
    u.tool_cmd == null &&
    (u.stage === 'review' || u.stage === 'test') &&
    field(u, 'member_step') == null &&
    field(u, 'owner') !== 'team'
  );
}

/** `RunAssurance::enforces("distinct_evaluator")`. A session persisted before the contract existed
 *  reads back `full` with the default requirements, which include it. */
function enforcesDistinctEvaluator(view: SessionView): boolean {
  const a = (view.session as { assurance?: { mode?: unknown; required?: unknown } | null }).assurance;
  if (a == null) return true;
  const required = Array.isArray(a.required) ? a.required : [];
  return required.includes('distinct_evaluator') && a.mode !== 'reduced';
}

/** wicked-core `work_authors`: every seat that authored the work the unit at `ord` checks. */
function workAuthors(units: readonly Unit[], ord: number): string[] {
  const out: string[] = [];
  for (const u of units) {
    if (u.ord >= ord || u.tool_cmd != null || (u.stage !== 'build' && u.stage !== 'recon')) continue;
    const authored = field(u, 'authored_by');
    const seats = [u.assigned_cli, ...(Array.isArray(authored) ? authored : [])];
    for (const s of seats) if (typeof s === 'string' && s !== '' && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The seats a reassign of the unit at `ord` is refused for — the work's authors when the rule
 * applies, else `[]`.
 */
export function reassignRefusedSeats(view: SessionView, ord: number): string[] {
  const unit = view.units.find((u) => u.ord === ord);
  if (unit === undefined || !seatsOffAuthors(unit) || !enforcesDistinctEvaluator(view)) return [];
  return workAuthors(view.units, ord);
}
