/**
 * The first-class deliver phase (crew#293) — a run opens its own PR, opt-in.
 *
 * Productizes the operator-side `feature-pr` overlay proven during the DES-MERGE-001 campaign:
 * a Tool phase appended after the workflow's last phase that COMMITS the run's work, pushes the
 * run's branch and opens a PR via `gh`. What was data on one machine becomes a launch option
 * (`deliver: "pr"` on `POST /runs`), composed PER RUN — the shared workflow def is never mutated.
 *
 * Field-proven hardening, replicated here:
 *  (a) the branch is derived from the run worktree's basename (`wicked/<run-id>`), falling back
 *      to the current branch when that ref does not exist;
 *  (b) the script REFUSES to push `main`/`master` (or an empty/detached branch name) — the
 *      deliver phase only ever pushes run branches;
 *  (c) it STAGES AND COMMITS the run's work, then rebases onto origin's default branch before
 *      pushing, and a conflicting rebase FAILS the phase visibly (aborting the rebase, pushing
 *      nothing) rather than pushing a conflicted tree;
 *  (d) `git push -u origin <branch>`;
 *  (e) `gh pr create --head <branch> --fill`, with gh's output and exit status captured
 *      SEPARATELY so a gh failure fails the phase carrying gh's own message;
 *  (f) the PR URL is the last line of the phase output.
 *
 * One deliberate change from the field version: NO gh account is baked into crew code (the
 * overlay guarded a personal account). Instead, when the `GH_ACCOUNT` env var is set the script
 * compares it against `gh api user -q .login` and runs
 * `gh auth switch --hostname github.com --user "$GH_ACCOUNT"` only when they differ.
 *
 * Merge stays human: the phase opens the PR, never merges it.
 *
 * ## crew#317 — "pushed an empty branch and reported success"
 *
 * Run `d1bc72c2` (wicked-studio) delivered nothing while reporting `completed`. The persisted
 * unit is the evidence, and it names the cause precisely. Its `tool_cmd` was NOT this script —
 * it was the operator's hand-written `feature-pr` OVERLAY def, which begins `set -e` with **no
 * `pipefail`**, so `gh pr create … | tail -1` reported `tail`'s status (0) and the phase passed
 * with gh's error text where the PR URL belongs:
 *
 * ```text
 * could not compute title or body defaults: could not find any commits between origin/main and
 * wicked/d1bc72c2-…
 * ```
 *
 * So the masking mechanism the issue hypothesised is real, but it belonged to the overlay, not
 * here: `pipefail` IS in force for this executor (it is line 1 of this script, `bash -lc` runs it
 * verbatim, and core's `run_tool_cmd` maps any non-zero exit to `StepStatus::Failed`). The three
 * defects this script genuinely shared with the overlay are fixed below:
 *
 *  1. **No commit.** Agents write files and do not commit, so the pushed branch equalled the
 *     default branch. The script now stages and commits the run's work itself, and REFUSES to
 *     push when there is nothing to deliver.
 *  2. **A masked result.** `| tail -1` discarded everything gh said except one line and made the
 *     phase's verdict depend on a pipe option. gh's output and status are now captured
 *     separately, and success is re-derived from a real PR URL rather than from an exit code.
 *  3. **Ungoverned.** The phase shipped `verified_evidence: false` / `validator_pin: null`, so
 *     nothing re-derived what it claimed. It now declares `verified_evidence: true` — see
 *     {@link deliverPrPhase}.
 */

import type { PhaseDef, WorkflowDef } from './types.js';

/** The id of the appended phase — also the collision probe when a def already delivers. */
export const DELIVER_PHASE_ID = 'deliver';

/** How much of the run's intent rides in the commit subject before it is truncated. */
const INTENT_SUBJECT_CAP = 72;

/**
 * The run's intent, reduced to something safe to embed in a single-quoted shell assignment and
 * to use as a one-line commit subject.
 *
 * The intent is caller-supplied free text off `POST /runs`, and it is being spliced into a bash
 * script — so this is a containment boundary, not cosmetics. Control characters (newlines
 * included) and the single quote are REMOVED: with no `'` left, the value cannot escape the
 * single-quoted assignment the script wraps it in, and with no control characters it cannot add
 * a line. Everything else (unicode, `$`, backticks, backslashes) is inert inside single quotes
 * and is kept, so the subject still reads like the intent it came from.
 */
function commitSubjectIntent(intent: string | undefined): string {
  return (intent ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters IS the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, INTENT_SUBJECT_CAP)
    .trim();
}

/**
 * The hardened deliver script, run as `bash -lc <script>` (login shell so the operator's PATH —
 * where `gh` lives — is loaded, same as the field overlay).
 *
 * `set -euo pipefail` is load-bearing and verified in force for this executor (crew#317): the
 * engine spawns `bash -lc` with this text verbatim, and `run_tool_cmd` turns a non-zero exit into
 * `StepStatus::Failed`. It is no longer the ONLY thing standing between a failed `gh` and a green
 * phase, though — the gh result is captured explicitly and success is re-derived from evidence.
 *
 * `intent` (the run's problem statement) rides in the commit subject; it is sanitised by
 * {@link commitSubjectIntent} before it is spliced in.
 */
export function deliverPrScript(intent?: string): string {
  return [
    'set -euo pipefail',
    // The engine concatenates the child's stdout and THEN its stderr, so anything git writes to
    // stderr would land after the PR URL and break "(f) the URL is the last line". Folding stderr
    // into stdout for the whole phase keeps the output in true chronological order and makes the
    // final `echo "$URL"` genuinely last.
    'exec 2>&1',
    // Account guard — env-driven, never a name baked into crew code. Unset ⇒ whatever account
    // gh already holds is used as-is.
    'if [ -n "${GH_ACCOUNT:-}" ]; then L=$(gh api user -q .login); [ "$L" = "$GH_ACCOUNT" ] || gh auth switch --hostname github.com --user "$GH_ACCOUNT"; fi',
    // (a) The run branch: wicked/<worktree-basename> (the engine names run worktrees by run id),
    // falling back to the currently checked-out branch when that ref does not exist.
    'R=$(basename "$PWD")',
    'B="wicked/$R"',
    'git rev-parse --verify "$B" >/dev/null 2>&1 || B=$(git branch --show-current)',
    // Derive origin's default branch FIRST — the refusal below must cover a repo whose
    // default is trunk/develop/anything, not just main/master (Copilot on #303).
    'git fetch origin',
    'D=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)',
    'DEF="${D#origin/}"',
    // (b) Refuse the repo's own default branch (by derived name), the classic names, and an
    // empty name (detached HEAD), which would otherwise turn the push into a garbage ref.
    'case "$B" in ""|main|master|"$DEF") echo "deliver: refusing to push branch \'$B\' — the deliver phase only pushes run branches, never the default branch"; exit 1;; esac',
    // The commit below writes to whatever HEAD is, while the push sends $B. When those differ
    // (a `wicked/<run-id>` ref exists but is NOT what this worktree has checked out) committing
    // would put one branch's work on another and push a branch that never saw it. Refuse instead.
    'C=$(git branch --show-current)',
    '[ "$C" = "$B" ] || { echo "deliver: the worktree is on \'$C\' but the run branch is \'$B\' — refusing to commit one branch\'s work onto another; nothing was pushed"; exit 1; }',
    // (c1) COMMIT THE RUN'S WORK (crew#317). Agents write files; they do not commit — which is
    // the premise of core#291 and the reason `d1bc72c2` pushed a branch identical to origin/main.
    // Author identity is deliberately NOT set here: the run worktree belongs to the operator's
    // own clone, so `git commit` uses the repo/user config that already exists (and fails loudly,
    // pushing nothing, if that config is missing). `git add -A` respects .gitignore.
    `I='${commitSubjectIntent(intent)}'`,
    'if [ -n "$I" ]; then M="wicked-crew run $R: $I"; else M="wicked-crew run $R"; fi',
    'git add -A',
    // Only commit when something is staged — a run that committed incrementally (core#280's
    // liveness contract) leaves a clean tree and must not gain an empty commit here.
    'git diff --cached --quiet || git commit -q -m "$M"',
    // (c2) NOTHING TO DELIVER — no staged work AND no commits of its own. Fail LOUDLY before the
    // remote is touched: an empty ref pushed under a run id is worse than a failed phase.
    'A=$(git rev-list --count "$D".."$B")',
    '[ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run produced no committed change ($B is not ahead of $D); nothing was pushed"; exit 1; }',
    // (c3) Rebase onto origin's default branch so the PR opens mergeable. A conflict must fail
    // the phase VISIBLY with nothing pushed — the abort leaves the worktree on the pre-rebase
    // branch tip instead of mid-rebase.
    'git rebase "$D" "$B" || { git rebase --abort >/dev/null 2>&1 || true; echo "deliver: rebase of $B onto $D failed (conflicts) — resolve on the branch and re-run; nothing was pushed"; exit 1; }',
    // Re-derive after the rebase: it drops commits already upstream (patch-id equal), so a branch
    // that WAS ahead can come out of a rebase carrying nothing of its own.
    'A=$(git rev-list --count "$D".."$B")',
    '[ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run produced no committed change (after rebasing onto $D, $B carries no commit of its own); nothing was pushed"; exit 1; }',
    // (d) Push.
    'git push -u origin "$B"',
    // (e) Open the PR with gh's OUTPUT and EXIT STATUS captured separately (crew#317). The old
    // `| tail -1` threw away everything gh said but one line and made the phase's verdict a
    // property of a shell option; a gh failure now fails the phase carrying gh's own message.
    'if ! OUT=$(gh pr create --head "$B" --fill 2>&1); then echo "$OUT"; echo "deliver: gh pr create failed for $B — no PR was opened"; exit 1; fi',
    'echo "$OUT"',
    // (f) DONE IS RE-DERIVED, NOT ASSERTED — twice, from two independent facts, before the phase
    // is allowed to report a delivery:
    //   1. gh actually produced a PR URL (an exit code alone is a claim, not evidence);
    //   2. the ref ON THE REMOTE is ahead of origin's default branch by at least one commit.
    "URL=$(printf '%s\\n' \"$OUT\" | grep -Eo 'https://[^[:space:]]+/pull/[0-9]+' | tail -1 || true)",
    '[ -n "$URL" ] || { echo "deliver: gh pr create exited 0 but produced no PR URL for $B — refusing to report a delivery nothing can be pointed at"; exit 1; }',
    'P=$(git rev-list --count "$D".."origin/$B")',
    '[ "$P" -ge 1 ] || { echo "deliver: $B is not ahead of $D on the remote after the push — refusing to report a delivery with no commits"; exit 1; }',
    'echo "$URL"',
  ].join('\n');
}

/**
 * The deliver phase definition — the PhaseDef JSON shape core accepts, fully spelled out so the
 * composed def round-trips through `registerWorkflow` (core's serde) and crew's own `WorkflowDef`
 * type without casts. `gate: 'auto'` + `executes_code: false`: the phase is deterministic tooling,
 * not governed agent work — its failure surface is the exit code + output, which core reports as
 * a failed unit.
 *
 * ## Why `verified_evidence: true` and `validator_pin: null` (crew#317)
 *
 * The phase that touches the remote was the one phase nothing re-derived. The engine's phase model
 * DOES let a Tool-executor phase carry a deterministic floor, and the mechanism is the flag rather
 * than a pin crew mints itself:
 *
 *  - a pin is a CONTENT ADDRESS into core's validator vault, and `attach_pinned_validators` is
 *    fail-closed on one that does not resolve — it BAILS the run at plan time. Authoring and
 *    approving a validator is `wicked-core provision-validator` + `approve-validator`, neither of
 *    which is exposed through the napi surface crew drives, so a pin invented here would fail
 *    every run of every deliver-composed workflow on a machine that had not been seeded by hand;
 *  - `verified_evidence: true` with no pin of its own is armed AT REGISTRATION by
 *    `enforce_verified_evidence` with the built-in evidence floor (`EVIDENCE_FLOOR_PIN`,
 *    criterion: "the run left a change in its worktree (done is re-derived from the diff, never
 *    asserted)"), which `pre_distribute` seeds on the plan path so it always resolves. Same
 *    mechanism `feature/test`, `bug/verify` and `migration/verify` reach it by.
 *
 * The floor then re-runs against the run's worktree at the gate, INDEPENDENTLY of anything this
 * script printed, and denies the phase when the run left no change. Layer 2 (the agent judge)
 * stays out of it: core hands the Tool path `agent_verdict: None`, so a tool phase's floor is
 * deterministic and costs no LLM call. The PR-URL and branch-ahead assertions stay in the script
 * because no vaulted floor can see the remote.
 */
export function deliverPrPhase(dependsOn: string[] = [], intent?: string): PhaseDef {
  return {
    id: DELIVER_PHASE_ID,
    kind: 'build',
    executor: { type: 'tool', cmd: ['bash', '-lc', deliverPrScript(intent)] },
    gate_type: null,
    gate: 'auto',
    executes_code: false,
    verified_evidence: true,
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
 * `intent` is the run's problem statement — it names WHAT was delivered in the commit subject
 * (`wicked-crew run <run-id>: <intent>`); omit it and the subject carries the run id alone.
 *
 * Throws when `base` already carries a `deliver` phase — appending a second phase with the same
 * id would be ambiguous at best; the caller launches such a def as-is instead (see
 * `CoreAdapter.launchRun`).
 */
export function composeDeliverWorkflow(
  base: WorkflowDef,
  runId: string,
  intent?: string,
): WorkflowDef {
  if (base.phases.some((p) => p.id === DELIVER_PHASE_ID)) {
    throw new Error(
      `workflow '${base.id}' already has a '${DELIVER_PHASE_ID}' phase — launch it without deliver: "pr"`,
    );
  }
  const last = base.phases[base.phases.length - 1];
  // Run ids are UUIDs from the route, but the CLI path accepts caller-supplied ids — keep the
  // composed id inside the same safe charset `registerWorkflow` enforces for user defs.
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  // registerWorkflow enforces id.length <= 128; a caller-supplied CLI session id can be long.
  // Truncate the run-id TAIL, keeping the base+marker prefix intact (Copilot on #303).
  const composedId = `${base.id}-deliver-${safeRunId}`.slice(0, 128);
  return {
    // No `is_system` on purpose: core's overlay/register schema rejects unknown fields, and the
    // composed def is engine-input, not catalog data.
    id: composedId,
    phases: [...base.phases, deliverPrPhase(last !== undefined ? [last.id] : [], intent)],
  };
}
