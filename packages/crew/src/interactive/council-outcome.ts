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
 * when the engine says why. Since wave 6 the engine sets `degradedReason` on EVERY routing arm
 * whenever the eligible set is smaller than the configured roster (`"4 of 5 seats benched: codex
 * (signed out — launcher), …"`), so a benched council reads as degraded in the thread even when
 * every convened ballot came back.
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

// ── Wave 6 — the honest gate, the fenced worker, the benched seat ────────────────────────────

/**
 * `gateEvaluated.ungated` (wave 6, F-7R2-005): `true` when NOTHING gated the unit — no
 * deterministic floor, no agent judge, an empty evaluator-policy selection — the exact default-allow
 * shape run b86c14c1 passed seven times. The line a thread must show instead of "approved":
 * `"UNGATED — <ungatedReason>"`. `null` when the frame is not an ungated gate (an older engine never
 * sends the field; a gated unit sends `false`).
 */
export function ungatedGateNote(event: CoreEvent): string | null {
  if ((event as { ungated?: unknown }).ungated !== true) return null;
  const reason = str(event, 'ungatedReason', 'ungated_reason');
  return `UNGATED — ${reason ?? 'nothing gated this unit (no floor, no judge, no policy applied)'}`;
}

/**
 * `workerToolCallDenied` (wave 6, F-7R2-012): a worker seat asked to run a REMOTE-WRITING command
 * (`git push`, `gh pr create`, a `gh api` mutation, …) and the engine refused it — delivery is the
 * run's deliver phase's job. One line naming who, what, and the remedy the seat was handed.
 */
export function workerToolCallDeniedLine(event: CoreEvent): string {
  const who = str(event, 'cli') ?? 'a worker';
  const role = str(event, 'role');
  const command = str(event, 'command');
  const remedy = str(event, 'remedy') ?? 'delivery is performed by the run’s deliver phase';
  const what = command !== null ? ` asked to run \`${command}\`` : ' asked to run a remote-writing command';
  return `${who}${role !== null ? ` (${role})` : ''}${what} — refused: ${remedy}`;
}

/** The `acpFallback` kinds that mean the seat's ACCOUNT, not its transport, is the problem (wave 6
 *  adds `auth_failed` / `unauthenticated` beside the older `auth_required`). */
export const AUTH_FALLBACK_KINDS: ReadonlySet<string> = new Set(['auth_required', 'auth_failed', 'unauthenticated']);

/**
 * The `acpFallback` line, by `fallbackKind`: an authentication failure benches the seat for the run
 * (the wave-6 engine never retries the single-shot carrier for it — it fails the same way); a
 * deliberate `*_requires_wrapped` reroute is routing, not a drop; anything else is the classic
 * "live session dropped — continuing in single-shot mode".
 */
export function acpFallbackLine(event: CoreEvent): string {
  const who = str(event, 'cliKey', 'cli') ?? 'the worker';
  const kind = str(event, 'fallbackKind', 'fallback_kind');
  if (kind !== null && AUTH_FALLBACK_KINDS.has(kind)) {
    return `${who} is not signed in (${kind.replace(/_/g, ' ')}) — benched for this run; sign it in from the System page…`;
  }
  if (kind !== null && kind.endsWith('_requires_wrapped')) {
    return `${who} routed to single-shot mode (${kind.replace(/_/g, ' ')})…`;
  }
  return `${who}'s live session dropped — continuing in single-shot mode…`;
}
