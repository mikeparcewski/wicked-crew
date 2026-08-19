/**
 * The first-class deliver phase (crew#293) — a run opens its own PR, opt-in.
 *
 * Productizes the operator-side `feature-pr` overlay proven during the DES-MERGE-001 campaign:
 * a Tool phase appended after the workflow's last phase that pushes the run's branch and opens
 * a PR via `gh`. What was data on one machine becomes a launch option (`deliver: "pr"` on
 * `POST /runs`), composed PER RUN — the shared workflow def is never mutated.
 *
 * Field-proven hardening, replicated here:
 *  (a) the branch is derived from the run worktree's basename (`wicked/<run-id>`), falling back
 *      to the current branch when that ref does not exist;
 *  (b) the script REFUSES to push `main`/`master` (or an empty/detached branch name) — the
 *      deliver phase only ever pushes run branches;
 *  (c) it rebases onto origin's default branch before pushing, and a conflicting rebase FAILS
 *      the phase visibly (aborting the rebase, pushing nothing) rather than pushing a
 *      conflicted tree;
 *  (d) `git push -u origin <branch>`;
 *  (e) `gh pr create --head <branch> --fill`;
 *  (f) the PR URL is the last line of the phase output.
 *
 * One deliberate change from the field version: NO gh account is baked into crew code (the
 * overlay guarded a personal account). Instead, when the `GH_ACCOUNT` env var is set the script
 * compares it against `gh api user -q .login` and runs
 * `gh auth switch --hostname github.com --user "$GH_ACCOUNT"` only when they differ.
 *
 * Merge stays human: the phase opens the PR, never merges it.
 */

import type { PhaseDef, WorkflowDef } from './types.js';

/** The id of the appended phase — also the collision probe when a def already delivers. */
export const DELIVER_PHASE_ID = 'deliver';

/**
 * The hardened deliver script, run as `bash -lc <script>` (login shell so the operator's PATH —
 * where `gh` lives — is loaded, same as the field overlay).
 *
 * `set -euo pipefail` is load-bearing: without `pipefail` the trailing `| tail -1` on
 * `gh pr create` would swallow a gh failure and report the phase as passed with an error line
 * where the PR URL belongs.
 */
export function deliverPrScript(): string {
  return [
    'set -euo pipefail',
    // Account guard — env-driven, never a name baked into crew code. Unset ⇒ whatever account
    // gh already holds is used as-is.
    'if [ -n "${GH_ACCOUNT:-}" ]; then L=$(gh api user -q .login); [ "$L" = "$GH_ACCOUNT" ] || gh auth switch --hostname github.com --user "$GH_ACCOUNT"; fi',
    // (a) The run branch: wicked/<worktree-basename> (the engine names run worktrees by run id),
    // falling back to the currently checked-out branch when that ref does not exist.
    'B="wicked/$(basename "$PWD")"',
    'git rev-parse --verify "$B" >/dev/null 2>&1 || B=$(git branch --show-current)',
    // (b) Refuse the default branch — and an empty name (detached HEAD), which would otherwise
    // turn the push into a garbage ref.
    'case "$B" in ""|main|master) echo "deliver: refusing to push branch \'$B\' — the deliver phase only pushes run branches, never main/master"; exit 1;; esac',
    // (c) Rebase onto origin's default branch so the PR opens mergeable. A conflict must fail
    // the phase VISIBLY with nothing pushed — the abort leaves the worktree on the pre-rebase
    // branch tip instead of mid-rebase.
    'git fetch origin',
    'D=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)',
    'git rebase "$D" "$B" || { git rebase --abort >/dev/null 2>&1 || true; echo "deliver: rebase of $B onto $D failed (conflicts) — resolve on the branch and re-run; nothing was pushed"; exit 1; }',
    // (d) + (e) + (f): push, open the PR, and print its URL as the last line.
    'git push -u origin "$B"',
    'gh pr create --head "$B" --fill 2>&1 | tail -1',
  ].join('\n');
}

/**
 * The deliver phase definition — the PhaseDef JSON shape core accepts, fully spelled out so the
 * composed def round-trips through `registerWorkflow` (core's serde) and crew's own `WorkflowDef`
 * type without casts. `gate: 'auto'` + `executes_code: false`: the phase is deterministic tooling,
 * not governed agent work — its failure surface is the exit code + output, which core reports as
 * a failed unit.
 */
export function deliverPrPhase(dependsOn: string[] = []): PhaseDef {
  return {
    id: DELIVER_PHASE_ID,
    kind: 'build',
    executor: { type: 'tool', cmd: ['bash', '-lc', deliverPrScript()] },
    gate_type: null,
    gate: 'auto',
    executes_code: false,
    verified_evidence: false,
    required_deliverables: [],
    depends_on: dependsOn,
    role: 'neutral',
    skill_ref: null,
    allowed_skills: [],
    validator_pin: null,
  };
}

/**
 * Compose a PER-RUN workflow def: `base`'s phases (untouched — the shared def is never mutated)
 * plus the deliver phase appended last, under a run-scoped id. The caller registers the result
 * with the engine for THIS run only; nothing is written to the overlay dir and the composed id
 * never enters the user-workflow registry, so the catalog (`GET /workflows`) stays clean.
 *
 * Throws when `base` already carries a `deliver` phase — appending a second phase with the same
 * id would be ambiguous at best; the caller launches such a def as-is instead (see
 * `CoreAdapter.launchRun`).
 */
export function composeDeliverWorkflow(base: WorkflowDef, runId: string): WorkflowDef {
  if (base.phases.some((p) => p.id === DELIVER_PHASE_ID)) {
    throw new Error(
      `workflow '${base.id}' already has a '${DELIVER_PHASE_ID}' phase — launch it without deliver: "pr"`,
    );
  }
  const last = base.phases[base.phases.length - 1];
  // Run ids are UUIDs from the route, but the CLI path accepts caller-supplied ids — keep the
  // composed id inside the same safe charset `registerWorkflow` enforces for user defs.
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return {
    // No `is_system` on purpose: core's overlay/register schema rejects unknown fields, and the
    // composed def is engine-input, not catalog data.
    id: `${base.id}-deliver-${safeRunId}`,
    phases: [...base.phases, deliverPrPhase(last !== undefined ? [last.id] : [])],
  };
}
