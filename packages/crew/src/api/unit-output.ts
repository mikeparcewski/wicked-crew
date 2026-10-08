/**
 * Unit-key resolution and the reason a unit's transcript is absent — the read half of
 * `GET /runs/:id/units/:unitKey/output`.
 *
 * The endpoint used to answer `200 {"output": null}` for four different facts: an unknown
 * run, an unknown unit key, a unit that had not run yet, and a unit whose gate DENIED. The
 * last is the one an operator reaches for during triage, so the one case that most needs an
 * answer was the case that yielded nothing — with a success status and no error (FINDING-006).
 *
 * `null` here is never bare. Either the run/unit does not exist (the route 404s), or the unit
 * exists and this module says which of the remaining causes applies, in the unit's own terms.
 *
 * ## Why a rejected unit has no transcript
 *
 * This is not a gap in the endpoint — it is wicked-core's deny-dominates rule, working. Core
 * writes a `work_output` node ONLY when the unit's phase resolved approved
 * (`wicked-core/src/execute.rs`, "on approval: record the work-output node"; a
 * validator/evaluator deny lands there as `!approved` and writes none). A unit is `done` iff
 * it was approved and `rejected` otherwise (`wicked-core/src/pipeline.rs`), so
 * `rejected` ⇒ no stored output, by design: no output can leak past a deny.
 *
 * What survives a deny is the REASON, on the unit record itself — `denial_reason`, which
 * carries the gate's citation for a governance/validator deny and a bounded head+tail excerpt
 * of the worker's failure output for a step failure (`wicked-core/src/actor.rs`). That is what
 * this module points the operator at. It does NOT claim the transcript is recoverable
 * elsewhere: the streamed text rode `cliOutputDelta`, which `wicked-core/src/event_log.rs`
 * excludes from the durable log as high-volume, and no `work_output` node was written.
 */

import type { SessionView, WorkUnit } from '../core/types.js';
import { API_PREFIX } from './api-prefix.js';

/**
 * The unit a caller's path segment names, or `null`.
 *
 * Matching runs against the run's ACTUAL unit records rather than string-concatenating
 * `<run>:<segment>` and hoping core keyed it that way. Four spellings resolve, tried
 * most-specific first so a bare ord can never shadow a phase id:
 *
 *   1. the fully-qualified id      `run-1:survey`
 *   2. the id suffix               `survey`   (workflow runs) / `u3` (free-text runs)
 *   3. the ordinal in `u<ord>` form `u3`
 *   4. the bare ordinal            `3`
 *
 * Passes 3 and 4 exist because the id suffix and the ordinal diverge on workflow runs: the
 * unit at ord 3 is keyed `<run>:domain`, so `3` and `u3` addressed nothing at all. An
 * operator reading `#3` off the run list had no working key for that unit.
 */
export function resolveUnit(run: SessionView, unitKey: string): WorkUnit | null {
  const runId = run.session.id;
  const prefix = `${runId}:`;
  const byId = run.units.find((u) => u.id === unitKey);
  if (byId !== undefined) return byId;
  const bySuffix = run.units.find((u) => u.id.startsWith(prefix) && u.id.slice(prefix.length) === unitKey);
  if (bySuffix !== undefined) return bySuffix;
  const byOrdU = run.units.find((u) => `u${u.ord}` === unitKey);
  if (byOrdU !== undefined) return byOrdU;
  const byOrd = run.units.find((u) => String(u.ord) === unitKey);
  return byOrd ?? null;
}

/**
 * Every key `resolveUnit` accepts for this run, in `ord` order — the body of the 404 for an
 * unknown key. A caller who guessed wrong gets the working keys back rather than a second
 * round of guessing; the operator on FINDING-006 tried three spellings and stopped.
 */
export function unitKeysFor(run: SessionView): string[] {
  const prefix = `${run.session.id}:`;
  return [...run.units]
    .sort((a, b) => a.ord - b.ord)
    .map((u) => (u.id.startsWith(prefix) ? u.id.slice(prefix.length) : u.id));
}

/**
 * Why this unit's stored output is absent, in the unit's own terms. Call ONLY when the read
 * came back `null` — a unit with output has nothing to explain.
 *
 * Every branch names a DIFFERENT cause. Collapsing them into one message is the shape this
 * whole endpoint was filed for: an operator cannot act on "no output" without knowing whether
 * the unit was denied, has not run, or is a record core disagrees with.
 */
export function outputUnavailableReason(unit: WorkUnit): string {
  const where =
    `The gate decision and the run's event trail are in GET ${API_PREFIX}/runs/${unit.session_id}/evidence.`;

  if (unit.status === 'rejected') {
    const why =
      unit.denial_reason === null || unit.denial_reason === undefined || unit.denial_reason === ''
        ? 'core recorded no denial_reason on this unit'
        : unit.denial_reason;
    // Deliberately does NOT call this a governance deny. `rejected` is reached two ways — a gate
    // deny AND a worker step failure — and only `denial_reason` distinguishes them (core prefixes
    // it "Governance DENIED unit N …" or "Worker FAILED on unit N (triage: …)"). Naming one cause
    // for both would be this endpoint committing the FINDING-050 error while fixing FINDING-006.
    //
    // `${where}` is placed BEFORE `${why}` (crew#322): a step-failure denial_reason carries
    // core's bounded head+tail excerpt, which contains embedded newlines. Any line-based
    // consumer (log forwarder, UI card, shell head -1) that stops at the first newline would
    // silently drop everything after it — including the evidence pointer. Putting the pointer
    // first guarantees it survives regardless of how long or how multi-line denial_reason is.
    return (
      `Unit ${unit.ord} was REJECTED, so wicked-core stored no transcript for it: a work_output ` +
      `record is written only for a unit whose phase resolved approved, and this one's did not. ` +
      `That is the deny-dominates rule holding, not a lost or unreadable record — and the text ` +
      `the unit streamed is not retained anywhere else, so this is the whole of what survives. ` +
      `${where} Why it was rejected: ${why}`
    );
  }

  if (unit.status === 'pending' || unit.status === 'distributed') {
    return (
      `Unit ${unit.ord} has not finished (status: ${unit.status}). wicked-core writes a unit's ` +
      `transcript when its gate resolves, so there is nothing stored yet — this is not a ` +
      `statement about what the unit will produce. Live output for a running unit streams on /ws.`
    );
  }

  // `done` means the gate APPROVED, and an approved unit always gets a work_output node. Reaching
  // here means the record core holds disagrees with the record it served — report that as the
  // anomaly it is rather than as an ordinary empty answer.
  return (
    `Unit ${unit.ord} is recorded as ${unit.status} (approved), which in wicked-core always ` +
    `carries a stored work_output — but the transcript read for '${unit.id}' returned nothing. ` +
    `Treat this as an inconsistent store, not as a unit that produced no output. ${where}`
  );
}

// ── Which attempt the stored transcript is (crew#848) ─────────────────────────────────────────
//
// wicked-core keeps ONE `work_output` record per unit and writes it only when an attempt's output
// FOLDS (step status `ok`); a re-dispatch that folds overwrites it, but an attempt that ends
// `timed_out` / `cancelled` / `failed` leaves by the backstop and writes nothing. So after a
// rework whose attempt 1 timed out, the stored record is still attempt 0's — and the endpoint used
// to serve it as "the" output with no attempt named, so a skin showed a superseded transcript as
// the current one. The run's durable event log does carry one `unitOutputCaptured {attempt,
// outputBytes, stepStatus}` per attempt; this module reads it to say which attempt the stored
// bytes are, which attempts exist, and why a later one has no transcript.

/** One captured attempt of one unit, from the run's durable event log. */
export interface CapturedAttempt {
  attempt: number;
  outputBytes: number | null;
  stepStatus: string | null;
}

/** Every `unitOutputCaptured` for `ord`, one per attempt (the last frame per attempt wins), ascending. */
export function capturedAttempts(events: readonly Record<string, unknown>[], ord: number): CapturedAttempt[] {
  const byAttempt = new Map<number, CapturedAttempt>();
  for (const e of events) {
    if (e['type'] !== 'unitOutputCaptured') continue;
    const evOrd = typeof e['ord'] === 'number' ? e['ord'] : typeof e['unitOrd'] === 'number' ? e['unitOrd'] : undefined;
    if (evOrd !== ord) continue;
    const attempt = typeof e['attempt'] === 'number' ? e['attempt'] : 0;
    byAttempt.set(attempt, {
      attempt,
      outputBytes: typeof e['outputBytes'] === 'number' ? e['outputBytes'] : null,
      stepStatus: typeof e['stepStatus'] === 'string' ? e['stepStatus'] : null,
    });
  }
  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
}

/**
 * The attempt the stored transcript belongs to: the LATEST captured attempt that folded (`ok`)
 * whose byte count matches the stored text, else the latest `ok` attempt (an engine that does not
 * report `outputBytes`), else `null` when the log cannot say.
 */
export function storedAttempt(attempts: readonly CapturedAttempt[], output: string): number | null {
  const bytes = Buffer.byteLength(output, 'utf8');
  const folded = attempts.filter((a) => a.stepStatus === 'ok' || a.stepStatus === null);
  const exact = [...folded].reverse().find((a) => a.outputBytes === bytes);
  if (exact !== undefined) return exact.attempt;
  const last = folded[folded.length - 1];
  return last === undefined ? null : last.attempt;
}

/** Why `attempt` has no transcript of its own while the stored one is `served`'s. */
export function attemptUnavailableReason(unit: WorkUnit, attempt: CapturedAttempt, served: number | null): string {
  const status = attempt.stepStatus ?? 'unknown';
  const kept =
    served === null
      ? 'wicked-core holds no transcript for this unit.'
      : `The transcript wicked-core holds for this unit is attempt ${served}'s (GET ${API_PREFIX}/runs/${unit.session_id}/units/${unit.ord}/output?attempt=${served}).`;
  return (
    `Attempt ${attempt.attempt} of unit ${unit.ord} ended ${status}` +
    (attempt.outputBytes !== null ? ` after ${attempt.outputBytes} bytes of output` : '') +
    `. wicked-core stores one transcript per unit and writes it only when an attempt's output folds ` +
    `(status ok), so this attempt's text was not retained. ${kept}`
  );
}
