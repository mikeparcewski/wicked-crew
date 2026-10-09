/**
 * Deliver-failure triage — wicked-core#431 follow-through (crew consumes wicked-core#433).
 *
 * The deliver phase is a TOOL unit: a bash script the engine spawns (`run_tool_cmd`); no CLI seat
 * runs it. When it exits non-zero the engine still emits `stepFailed {failureKind: "workerError"}` —
 * the Tool path has no finer kind — and hands the excerpt to its agent triage judge, which answers
 * `escalate` (a human decides). Crew's own folds over `stepFailed` must not read that `workerError`
 * literally: `api/seat-health.ts` used to mark the unit's ASSIGNED seat inactive on ANY
 * `workerError`, so a `deliver: LIFT-CONFLICT` refusal blamed a CLI for a git state.
 *
 * Since wicked-core#433 the refusal can also be ENGINE-authored — the deliver LIFT + RE-VERIFY runs
 * BEFORE the script (`wicked-core/src/deliver_lift.rs` `lift_and_reverify`); its texts, in order:
 *   - `deliver: the worktree's HEAD is attached to `<ref>` / is detached, not the run branch
 *     `wicked/<run>` — nothing was lifted, reset or pushed; …` (the run-branch precondition);
 *   - `deliver: the lift onto <base> (<tip>) could not be applied cleanly — …` (a partial worktree);
 *   - `deliver: LIFT-CONFLICT — lifting the run's work onto <base> (<tip>) would conflict in: …`
 *     (the worktree was left exactly as verified; carries crew's own marker ON PURPOSE so the
 *     strand derivation — `completed` + `delivery: 'stranded'`, `POST /runs/:id/deliver` — fires);
 *   - `deliver: the worktree could not be snapshotted before delivery (…); nothing was pushed …`;
 *   - `deliver: <why>, and the repository's own checks FAILED on it: …` — the RE-VERIFY the engine
 *     runs whenever the worktree's tree is not the tree the run verified (`<why>` = "the lift
 *     changed the tree" | "the worktree's tree X is not the tree the run verified (Y)" | "the run
 *     recorded no verified tree"); the worktree holds an UNVERIFIED tree — NOT a strand, a post-hoc
 *     lift would push it;
 *   - `deliver: the repository's checks passed but CHANGED the worktree while running …` /
 *     `deliver: the repository's checks passed but the worktree could not be re-snapshotted …`
 *     (a check script that edits tracked files; inspect).
 * Every one of them — and every refusal crew's own script prints (`core/deliver.ts`: nothing to
 * deliver, the default branch, a moved verified base, a failed `gh`) — is an OPERATOR decision,
 * never a seat fault. This module recognises them from the excerpt the engine puts on
 * `stepFailed.detail` / the unit's `denial_reason` — head 150 + tail 250 chars of the WHOLE Tool
 * output (`bounded_excerpt` in `actor.rs`). The engine's refusals ARE the whole output (the command
 * never ran) and every phrase matched here sits inside the first 150 chars of that text, so they
 * survive in the head. The script's refusals come AFTER real fetch / install / codegen chatter, so
 * only the tail is theirs: every script marker (`LIFT-CONFLICT`, `BASE MOVED`, `PREFLIGHT CHANGED`)
 * TRAILS its last line and lands in the tail-250 (review F-527-001).
 *
 * ORDERING: this is a TEXT classifier and assumes nothing about the event stream. In particular a
 * deliver unit refused for a wrong HEAD ref (`deliver: the worktree's HEAD is attached to …`) emits
 * its `stepFailed` WITHOUT a preceding `deliverLiftEvaluated` — the run-branch precondition runs
 * before any lift — so no consumer (this one, the strand derivation, seat health, the studio's
 * delivery card) may treat the lift event as a prerequisite of a deliver failure.
 */

import {
  DELIVER_BASE_MOVED_MARKER,
  DELIVER_LIFT_CONFLICT_MARKER,
  DELIVER_NONCE_VAR,
  DELIVER_OUTCOME_MARKER,
  DELIVER_PREFLIGHT_CHANGED_MARKER,
  DELIVER_PUSH_REJECTED_MARKER,
} from './deliver.js';

/**
 * (crew#739) The nonce a nonce-bearing deliver script declares (`DELIVER_NONCE=<hex>`, optionally
 * quoted), read from the unit's `tool_cmd` — the engine's `deliver_nonce` (wicked-core#807), same
 * rule: 16-64 hex digits, else not a nonce. `null` for a legacy script, which keeps the last-marker
 * rule.
 */
export function deliverNonceOf(toolCmd: readonly string[] | null | undefined): string | null {
  const needle = `${DELIVER_NONCE_VAR}=`;
  for (const arg of toolCmd ?? []) {
    let at = arg.indexOf(needle);
    while (at !== -1) {
      const hex = /^['"]*([0-9a-fA-F]*)/.exec(arg.slice(at + needle.length))?.[1] ?? '';
      if (hex.length >= 16 && hex.length <= 64) return hex;
      at = arg.indexOf(needle, at + needle.length);
    }
  }
  return null;
}

/**
 * (crew#739) The verdict of the LAST `deliver: OUTCOME <nonce> <verdict>` line carrying `nonce`
 * exactly (the engine's `trusted_outcome`), or `null` when there is none. A sentinel with another
 * nonce — a remote's echo — is not a sentinel.
 */
export function trustedOutcomeIn(text: string, nonce: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith(DELIVER_OUTCOME_MARKER)) continue;
    const words = line.slice(DELIVER_OUTCOME_MARKER.length).trim().split(/\s+/);
    if (words.length === 2 && words[0] === nonce) return words[1]!;
  }
  return null;
}

/**
 * (crew#739) How a deliver unit's output reads under the trusted sentinel: `undefined` for a legacy
 * script (no nonce in `toolCmd` — the caller keeps the last-marker rule), else the sentinel's
 * verdict, with NO sentinel reading `failed` (fail closed: a script killed before its trap, or an
 * excerpt the remote filled, is never a strand).
 */
export function trustedDeliverOutcome(toolCmd: readonly string[] | null | undefined, text: string): string | undefined {
  const nonce = deliverNonceOf(toolCmd);
  if (nonce === null) return undefined;
  return trustedOutcomeIn(text, nonce) ?? 'failed';
}

/** The engine's lift-conflict remedy (`LiftOutcome::Conflict`) — crew's marker plus the engine's words. */
export const ENGINE_LIFT_CONFLICT_PHRASE = `${DELIVER_LIFT_CONFLICT_MARKER} — lifting the run's work onto`;
/** The engine refused before any lift: the worktree is not on its run branch (`require_run_branch`). */
export const ENGINE_RUN_BRANCH_PHRASE =
  'nothing was lifted, reset or pushed; the deliver script only pushes the run branch';
/** The engine's apply failure (`LiftOutcome::Failed`) — the line starts `deliver: the lift onto`. */
export const ENGINE_LIFT_APPLY_FAILED_PHRASE = 'could not be applied cleanly';
/** The engine could not identify the tree it was about to ship (pre-check snapshot failed). */
export const ENGINE_SNAPSHOT_FAILED_PHRASE = 'deliver: the worktree could not be snapshotted before delivery';
/** The engine's re-verify: the repository's checks FAILED on the tree that would ship. */
export const ENGINE_REVERIFY_FAILED_PHRASE = "repository's own checks FAILED on";
/** The engine's post-check proof failing: the checks changed the tree, or it could not be re-snapshotted. */
export const ENGINE_CHECKS_MUTATED_PHRASE = "deliver: the repository's checks passed but";

/**
 * What kind of deliver refusal a failed deliver unit's excerpt carries.
 * - `lift_conflict` — the engine's lift or the script's rebase hit a collision (recoverable);
 * - `push_rejected` — the REMOTE refused the push after the commit (hook, auth, transport, a moved
 *   run branch); the engine parks the run at its deliver-refusal gate, and an approve retries (N4);
 * - `run_branch_refused` — the worktree is not on its run branch; nothing was touched (engine);
 * - `lift_apply_failed` — the lift could not be applied cleanly, partial worktree (engine);
 * - `snapshot_failed` — the worktree could not be snapshotted before delivery (engine);
 * - `reverify_failed` — the repository's checks FAILED on the tree that would ship (engine);
 * - `checks_mutated` — the checks passed but changed the tree / could not be re-proven (engine);
 * - `base_moved` — the script found origin/<default> past `WICKED_DELIVER_VERIFIED_BASE` (script);
 * - `preflight_changed` — the crew#426 lockfile/codegen re-sync changed the verified tree (script);
 * - `script_refusal` — any other loud `deliver: …` refusal the script prints (script).
 */
export type DeliverFailureKind =
  | 'lift_conflict'
  | 'push_rejected'
  | 'run_branch_refused'
  | 'lift_apply_failed'
  | 'snapshot_failed'
  | 'reverify_failed'
  | 'checks_mutated'
  | 'base_moved'
  | 'preflight_changed'
  | 'script_refusal';

export interface DeliverFailureTriage {
  kind: DeliverFailureKind;
  /** Who wrote the refusal: the engine's deliver lift, or crew's own deliver script. */
  author: 'engine' | 'script';
  /** Always `'escalate'`: a deliver refusal is an operator decision, never a seat (worker) fault. */
  disposition: 'escalate';
  /**
   * Whether the run's work is intact and post-hoc deliverable (`POST /runs/:id/deliver` after the
   * operator clears the collision) — `true` only for a lift conflict, the shape crew's strand
   * derivation already keys on (`isDeliverConflictStranded`). A failed re-verify, an apply failure
   * or a moved base must NOT be offered a post-hoc push: that would deliver a tree nobody verified.
   */
  recoverable: boolean;
}

const APPLY_FAILED = /deliver: the lift onto [^\n]*? could not be applied cleanly/;
/** A `deliver: …` line of the script's — at the start, after a newline, or after the engine's
 *  framing: `Worker FAILED on unit N (triage: …): ` (today's terminal path) and, since the DES-L9
 *  F1 arm (wicked-core-ts ≥ 0.7.27), `deliver refused on unit N: ` — the parked unit's
 *  `denial_reason`, which the post-hoc route and `deliver-text.ts` classify. `: ` covers both
 *  framings (the `): ` form ends with it). The classifier's informational
 *  `deliver: EXCLUDED (<reason>): <path>` lines are not refusals and do not count. */
const SCRIPT_REFUSAL = /(?:^|\n|: )deliver: (?!EXCLUDED \()/;

const ENGINE = (kind: DeliverFailureKind): DeliverFailureTriage => ({
  kind,
  author: 'engine',
  disposition: 'escalate',
  recoverable: false,
});

/**
 * Which of the two post-commit markers appears LAST in a deliver transcript — `null` when neither
 * does. The script prints its own marker as its last line, so the last one is the script's verdict;
 * an earlier one may be remote-controlled text echoed from `git push`.
 */
export function lastDeliverMarker(
  text: string,
): typeof DELIVER_LIFT_CONFLICT_MARKER | typeof DELIVER_PUSH_REJECTED_MARKER | null {
  const lift = text.lastIndexOf(DELIVER_LIFT_CONFLICT_MARKER);
  const push = text.lastIndexOf(DELIVER_PUSH_REJECTED_MARKER);
  if (lift === -1 && push === -1) return null;
  return push > lift ? DELIVER_PUSH_REJECTED_MARKER : DELIVER_LIFT_CONFLICT_MARKER;
}

/**
 * Classify a failed deliver unit's excerpt (`stepFailed.detail`, or the unit's `denial_reason`).
 * `null` when the text carries no deliver refusal at all — a spawn/infra failure (`bash: gh:
 * command not found`), or a unit that is not the deliver phase — so callers fall back to their
 * default reading of `failureKind`.
 */
export function triageDeliverFailure(
  detail: string | null | undefined,
  toolCmd?: readonly string[] | null,
): DeliverFailureTriage | null {
  if (typeof detail !== 'string' || detail.length === 0) return null;
  // (crew#739) A nonce-bearing script is judged on its trusted sentinel alone for the two
  // post-commit classes: only `stranded` is a liftable strand and only `rejected` a refused push.
  // Any other verdict (or none) falls through to the engine/script refusal phrases below with the
  // two markers ignored, since text before the sentinel may be the remote's.
  const trusted = trustedDeliverOutcome(toolCmd, detail);
  if (trusted !== undefined) {
    if (trusted === 'rejected') return { kind: 'push_rejected', author: 'script', disposition: 'escalate', recoverable: false };
    if (trusted === 'stranded') {
      return {
        kind: 'lift_conflict',
        author: detail.includes(ENGINE_LIFT_CONFLICT_PHRASE) ? 'engine' : 'script',
        disposition: 'escalate',
        recoverable: true,
      };
    }
    return triageRefusalPhrases(detail);
  }
  // The script prints its OWN marker last; text before it can be the remote's (a pre-receive hook
  // may print anything, `deliver: LIFT-CONFLICT` included). So the LAST marker decides (codex
  // review of N4) — a refused push is never read as a liftable strand.
  if (lastDeliverMarker(detail) === DELIVER_PUSH_REJECTED_MARKER) {
    return { kind: 'push_rejected', author: 'script', disposition: 'escalate', recoverable: false };
  }
  if (detail.includes(DELIVER_LIFT_CONFLICT_MARKER)) {
    return {
      kind: 'lift_conflict',
      author: detail.includes(ENGINE_LIFT_CONFLICT_PHRASE) ? 'engine' : 'script',
      disposition: 'escalate',
      recoverable: true,
    };
  }
  return triageRefusalPhrases(detail);
}

/** The engine's and the script's refusal phrases other than the two post-commit markers. */
function triageRefusalPhrases(detail: string): DeliverFailureTriage | null {
  if (detail.includes(ENGINE_RUN_BRANCH_PHRASE)) return ENGINE('run_branch_refused');
  if (APPLY_FAILED.test(detail)) return ENGINE('lift_apply_failed');
  if (detail.includes(ENGINE_SNAPSHOT_FAILED_PHRASE)) return ENGINE('snapshot_failed');
  if (detail.includes(ENGINE_REVERIFY_FAILED_PHRASE)) return ENGINE('reverify_failed');
  if (detail.includes(ENGINE_CHECKS_MUTATED_PHRASE)) return ENGINE('checks_mutated');
  if (detail.includes(DELIVER_BASE_MOVED_MARKER)) {
    return { kind: 'base_moved', author: 'script', disposition: 'escalate', recoverable: false };
  }
  if (detail.includes(DELIVER_PREFLIGHT_CHANGED_MARKER)) {
    return { kind: 'preflight_changed', author: 'script', disposition: 'escalate', recoverable: false };
  }
  if (SCRIPT_REFUSAL.test(detail)) {
    return { kind: 'script_refusal', author: 'script', disposition: 'escalate', recoverable: false };
  }
  return null;
}
