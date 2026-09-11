/**
 * What a `unitDistributed` frame says about the council that produced it, in the reader's words
 * (F-4R2-007).
 *
 * The engine convenes every roster seat and benches the ones that fail (`councilSeatFailed`:
 * `non_zero_exit`, `timed_out`, `benched`); the assignment then rides on `unitDistributed` with
 * `seated` (seats convened) and `returned` (ballots that came back). On the fresh rig four of five
 * seats were signed out: every council routed to claude on one or two ballots of five while the
 * thread still read "Convening a 5-seat council…" and `degradedReason` stayed `null` — the engine
 * sets it only for its `Degraded` routing (no vote at all), never for a council that held on a
 * fraction of its seats (`wicked-core/src/pipeline.rs`, `apply_distributions`, the `Council` arm).
 *
 * Crew does not own that field, so it is not set here (the rule is filed as a wicked-core
 * follow-up). What crew DOES own is the narration, and the frame already carries enough to be
 * honest: when fewer ballots returned than seats were convened, say so; when the engine names a
 * reason, quote it. The engine's wire spelling is camelCase (`CoreEvent::to_json`); the snake_case
 * spellings are read too so a normalising relay cannot silence the line.
 */

import type { CoreEvent } from '../core/types.js';

function num(e: CoreEvent, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = (e as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function str(e: CoreEvent, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = (e as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** The council's agreement as the wire carries it, or `null` when the frame has none. */
export function councilAgreementPct(event: CoreEvent): number | null {
  return num(event, 'agreementPct', 'agreement_pct');
}

/**
 * A suffix for the "Council picked X…" line — empty when the council was whole and the engine
 * named no degradation. `" (1 of 5 seats answered — 4 benched)"`, plus `"; <degradedReason>"`
 * when the engine says why.
 */
export function councilOutcomeSuffix(event: CoreEvent): string {
  const seated = num(event, 'seated');
  const returned = num(event, 'returned');
  const reason = str(event, 'degradedReason', 'degraded_reason');
  const parts: string[] = [];
  if (seated !== null && returned !== null && returned < seated) {
    const benched = seated - returned;
    parts.push(`${returned} of ${seated} seat${seated === 1 ? '' : 's'} answered — ${benched} benched`);
  }
  if (reason !== null) parts.push(reason);
  return parts.length === 0 ? '' : ` (${parts.join('; ')})`;
}
