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
 *      pushing. A conflict whose conflicted paths are ALL `CHANGELOG.md` is union-merged (both
 *      sides' additive lines kept) and the rebase continues — the crew#418 collision magnet, made
 *      to just deliver; ANY other conflict aborts the rebase (pushing nothing) and exits carrying
 *      {@link DELIVER_LIFT_CONFLICT_MARKER}, which crew reads as a recoverable STRAND, never a
 *      pushed conflicted tree;
 *  (d) `git push -u origin <branch>` — every rejected push carries the recovery marker. The run
 *      work is already committed locally, so an operator can repair auth/transport and retry;
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

/**
 * The sentinel the deliver script prints when the RUN'S WORK has been committed but its LIFT did
 * not complete (crew#418/#432): a rebase conflict or any failed push. The work is safe on its
 * `wicked/<id>` branch; an operator can fix the remote condition and retry delivery.
 *
 * crew keys the "stranded, recoverable" reinterpretation on this EXACT substring appearing in
 * the deliver unit's `denial_reason` (which carries the head+TAIL excerpt of the script's
 * output, and the marker is always the script's last line — see {@link isDeliverConflictStranded}
 * in `api/delivery-index.ts`). The script's OTHER loud refusals — wrong worktree branch, nothing
 * to deliver, `gh` failure — and a spawn/infra failure deliberately OMIT the marker, so they stay
 * terminal run failures exactly as before (the crew#400 refusal-vs-infra posture).
 */
export const DELIVER_LIFT_CONFLICT_MARKER = 'deliver: LIFT-CONFLICT';

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
    // A failed PUSH happens after the product was committed. Keep its worktree from being reaped
    // by leaving this reserved, untracked recovery sentinel; it is removed HERE (before staging)
    // so a normal delivery never sees it, and a retry removes it before another attempt (crew#432).
    'S=.wicked-crew-delivery-stranded',
    'rm -f -- "$S"',
    // (c1) COMMIT THE RUN'S WORK (crew#317). Agents write files; they do not commit — which is
    // the premise of core#291 and the reason `d1bc72c2` pushed a branch identical to origin/main.
    // Author identity is deliberately NOT set here: the run worktree belongs to the operator's
    // own clone, so `git commit` uses the repo/user config that already exists (and fails loudly,
    // pushing nothing, if that config is missing). Staging is two passes (see below): tracked
    // changes always ride; untracked paths ride UNLESS a scratch/key-material classifier excludes
    // them — and every exclusion is reported loudly (crew#434).
    `I='${commitSubjectIntent(intent)}'`,
    'if [ -n "$I" ]; then M="wicked-crew run $R: $I"; else M="wicked-crew run $R"; fi',
    // (c0) DELIVER PREFLIGHT (crew#426) — a governed run that bumps an internal WORKSPACE package's
    // version (e.g. packages/crew-api-types) leaves its version-derived codegen AND the lockfile
    // stale. A per-run worktree is provisioned with `git worktree add` alone — no `node_modules` —
    // so the version-stamping generators resolve the PARENT checkout's node_modules (its UN-bumped
    // version) and nothing ever re-syncs package-lock.json to the worktree's own package.json. CI
    // then reddens on the delivered PR: `endpoint-manifest.test.ts` fails once CI's `npm ci` relinks
    // api-types to the worktree's bumped version and the committed manifest disagrees, and the
    // lockfile↔package.json drift is a latent install hazard (a repo that pins the dep instead of `*`
    // would fail `npm ci` outright). This blocks EVERY governed run that changes an API field. Re-sync
    // BOTH here, BEFORE the commit, so the tracked-only staging below stages the regenerated
    // endpoint-manifest.json, the generated api-sample test, and the re-synced package-lock.json.
    //
    // Scoped to the CREW WORKSPACE — the whole preflight (lockfile re-sync AND codegen) runs only
    // when the root package.json + package-lock.json AND packages/crew + packages/crew-api-types are
    // present. `deliverPrScript` is otherwise repo-agnostic, so a bare `npm install` on any repo that
    // merely happens to carry a root lockfile would run its install-time scripts, add latency, and —
    // worse — strand an otherwise-deliverable run whose external deps are not cached under a
    // restricted network (Copilot, crew#428). The #426 invariant only applies to crew's own codegen,
    // so gate the entire block on crew's machinery; every other repo is a byte-for-byte NO-OP. For the
    // crew workspace it is also unchanged when nothing was bumped (an already-in-sync `npm install`
    // rewrites neither the lockfile nor the codegen). `npm install` (never `npm ci`, which cannot
    // re-sync a lockfile and would itself fail on a pinned-dep mismatch) re-syncs the lockfile;
    // `--prefer-offline` keeps it off the registry
    // for a workspace-internal bump (no new tarball to fetch), so a restricted network does not fail
    // delivery. A genuine failure of a step that DID apply stays LOUD (no LIFT-CONFLICT marker →
    // terminal run failure), preserving the phase's refusal posture — the preflight adds no new strand.
    'if [ -f package.json ] && [ -f package-lock.json ] && [ -f packages/crew/package.json ] && [ -f packages/crew-api-types/package.json ]; then',
    '  npm install --prefer-offline --no-audit --no-fund',
    '  npm run manifest:endpoints -w packages/crew',
    '  npm run generate:api-tests -w packages/crew',
    'fi',
    // (c1a) TRACKED CHANGES ALWAYS RIDE. `git add -u` stages every modification/deletion to an
    // already-tracked path (the run's product for that class), including the crew#426 preflight's
    // regenerated, already-tracked lockfile/manifest/codegen above.
    'git add -u',
    // (c1b) UNTRACKED PATHS — the crew#434 classifier. `git add -A` swept EVERY non-ignored
    // untracked path into the governed PR, so a repo whose `.gitignore` missed its own test
    // scratch (a `bus.db`, a `socket.path` with a username, `.webm`/`.gif` recordings) leaked ~31
    // files into a run's PR. The fix cannot lean on the target repo's `.gitignore` being right, so
    // each untracked candidate (`git ls-files --others --exclude-standard` — gitignore honored
    // first, NUL-delimited so odd names survive) is classified per-file: it is staged (it is the
    // run's deliberately-produced product) UNLESS it looks like scratch or key material —
    //   • denylisted name/extension: databases (.db/.sqlite*), sockets (.sock), pids (.pid),
    //     dotenv (.env*), recordings (.gif/.webm/.mp4/.mov), key material
    //     (*.pem/*.key/*.p12/*.pfx/id_rsa*/*credentials*);
    //   • a basename containing `socket` (covers `socket.path`, which has no fixed extension);
    //   • a path under an obvious scratch/cache dir (tmp/ .tmp/ scratch/ .cache/ coverage/) or
    //     a `.DS_Store`;
    //   • any otherwise-unrecognised file larger than 1 MiB (a generic net for future scratch).
    // EVERYTHING ELSE RIDES — the floor's job is hygiene, not taste; an allowlist would silently
    // drop a legitimate new asset. This is a GUARD, NOT A SILENT DROP (the issue's own words):
    // every excluded path is printed with its reason, so a clean delivery that skipped files is
    // still fully auditable in the phase output (retained + served on the run wire), never
    // laundered. `git add` here never touches the untracked recovery sentinel: it was removed
    // above, before this pass.
    'while IFS= read -r -d "" F; do',
    '  [ -n "$F" ] || continue',
    '  BN=${F##*/}; RN=""',
    '  case "$BN" in',
    '    *.db|*.db-wal|*.db-shm|*.sqlite|*.sqlite2|*.sqlite3|*.sqlite-wal|*.sqlite-shm|*.sock|*.pid|*.env|*.env.*|.envrc|*.gif|*.webm|*.mp4|*.mov|*.pem|*.key|*.p12|*.pfx|id_rsa*|*credentials*) RN="denylisted-name";;',
    '  esac',
    '  case "$BN" in *[Ss][Oo][Cc][Kk][Ee][Tt]*) [ -n "$RN" ] || RN="socket-name";; esac',
    '  [ "$BN" = ".DS_Store" ] && [ -z "$RN" ] && RN="ds-store"',
    '  case "/$F" in */tmp/*|*/.tmp/*|*/scratch/*|*/.cache/*|*/coverage/*) [ -n "$RN" ] || RN="scratch-dir";; esac',
    '  if [ -z "$RN" ]; then SZ=$(wc -c < "$F" 2>/dev/null || echo 0); [ "${SZ:-0}" -gt 1048576 ] && RN="oversize-1mib"; fi',
    '  if [ -n "$RN" ]; then echo "deliver: EXCLUDED ($RN): $F"; else git add -- "$F"; fi',
    'done < <(git ls-files --others --exclude-standard -z)',
    // Only commit when something is staged — a run that committed incrementally (core#280's
    // liveness contract) leaves a clean tree and must not gain an empty commit here.
    'git diff --cached --quiet || git commit -q -m "$M"',
    // (c2) NOTHING TO DELIVER — no staged work AND no commits of its own. Fail LOUDLY before the
    // remote is touched: an empty ref pushed under a run id is worse than a failed phase.
    'A=$(git rev-list --count "$D..$B")',
    '[ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run produced no committed change ($B is not ahead of $D); nothing was pushed"; exit 1; }',
    // (c3) Rebase onto origin's default branch so the PR opens mergeable.
    //
    // crew#418 B — the CHANGELOG collision magnet: two runs that both append to CHANGELOG's
    // `[Unreleased]` section conflict on the rebase BY CONSTRUCTION, though their added bullet
    // lines never truly disagree. A conflict whose conflicted paths are ALL `CHANGELOG.md`
    // (matched by basename) is resolved automatically with a UNION merge — `git merge-file
    // --union` keeps BOTH sides' lines, no markers — and the rebase continues. This is scoped to
    // the changelog and touches NOTHING else: a conflict in any other file is left exactly as
    // loud as before (the "never weaken rebase loudness for non-changelog files" rule).
    //
    // crew#418 A — a conflict that is NOT changelog-only (or a changelog union that fails) is a
    // real LIFT collision: abort the rebase (nothing pushed; the abort leaves the worktree on the
    // pre-rebase branch tip, not mid-rebase) and exit carrying DELIVER_LIFT_CONFLICT_MARKER. The
    // run's committed work is safe on its branch, so crew reinterprets THIS refusal as `completed`
    // + `delivery: 'stranded'` (recoverable via POST /runs/:id/deliver) rather than a run failure.
    '_rebasing() { [ -d "$(git rev-parse --git-path rebase-merge 2>/dev/null)" ] || [ -d "$(git rev-parse --git-path rebase-apply 2>/dev/null)" ]; }',
    'if ! git rebase "$D" "$B"; then',
    // A rebase that failed WITHOUT leaving in-progress state never started — a preflight error
    // (bad ref, unexpected worktree state), not a conflict. Fail LOUD rather than fall through to
    // the push as if the rebase had succeeded; nothing was pushed.
    '  if ! _rebasing; then echo "deliver: git rebase of $B onto $D failed before it started (preflight error); nothing was pushed"; exit 1; fi',
    '  while _rebasing; do',
    '    CF=$(git diff --name-only --diff-filter=U || true)',
    '    [ -n "$CF" ] || break',
    // Any conflicted path that is not a CHANGELOG.md → a real collision; stop resolving and strand.
    '    if printf "%s\\n" "$CF" | grep -qvE "(^|/)CHANGELOG\\.md$"; then break; fi',
    // Union-merge every conflicted changelog — but ONLY when the two sides differ SOLELY within
    // the `## [Unreleased]` section. A union keeps both sides of every conflict hunk, so a
    // whole-file union of two edits to the SAME released-version line would silently combine
    // them; we refuse that. Guard: strip the [Unreleased] block (from `## [Unreleased]` up to the
    // next `## [` heading) from both stage-2 (ours) and stage-3 (theirs); if the remainder is not
    // byte-identical, the divergence is outside [Unreleased] → a real conflict → break (strand).
    // When they ARE identical outside it, the only conflicting hunks are within [Unreleased], so
    // the whole-file --union affects nothing else. A missing base stage (add/add) unions against
    // an empty base; any git failure breaks out to the loud abort below.
    '    if ! printf "%s\\n" "$CF" | while IFS= read -r F; do',
    '          [ -n "$F" ] || continue;',
    '          TB=$(mktemp); TO=$(mktemp); TT=$(mktemp);',
    '          git show ":1:$F" >"$TB" 2>/dev/null || : >"$TB";',
    '          git show ":2:$F" >"$TO" 2>/dev/null || { rm -f "$TB" "$TO" "$TT"; exit 1; };',
    '          git show ":3:$F" >"$TT" 2>/dev/null || { rm -f "$TB" "$TO" "$TT"; exit 1; };',
    "          _strip='/^## \\[Unreleased\\]/{s=1;next} s&&/^## \\[/{s=0} !s{print}';",
    '          SO=$(awk "$_strip" "$TO"); ST=$(awk "$_strip" "$TT");',
    '          if [ "$SO" != "$ST" ]; then rm -f "$TB" "$TO" "$TT"; exit 1; fi;',
    '          git merge-file -q --union "$TO" "$TB" "$TT" || { rm -f "$TB" "$TO" "$TT"; exit 1; };',
    '          cat "$TO" >"$F"; git add -- "$F"; rm -f "$TB" "$TO" "$TT";',
    '        done; then break; fi',
    '    GIT_EDITOR=true git -c core.editor=true rebase --continue >/dev/null 2>&1 || break;',
    '  done',
    `  if _rebasing; then git rebase --abort >/dev/null 2>&1 || true; echo "${DELIVER_LIFT_CONFLICT_MARKER} — rebase of $B onto $D hit conflicts outside the changelog; resolve on the branch and re-run; nothing was pushed"; exit 1; fi`,
    'fi',
    // Re-derive after the rebase: it drops commits already upstream (patch-id equal), so a branch
    // that WAS ahead can come out of a rebase carrying nothing of its own.
    'A=$(git rev-list --count "$D..$B")',
    '[ "$A" -ge 1 ] || { echo "deliver: nothing to deliver — the run produced no committed change (after rebasing onto $D, $B carries no commit of its own); nothing was pushed"; exit 1; }',
    // (d) Push. Any push failure happens AFTER the work was committed and its branch was proven
    // ahead. It is therefore a recoverable lift failure, whether the remote branch moved, auth
    // returned 403, the transport is down, or a hook rejected it. Preserve git's own output AND
    // print the marker last, so crew strands the run and POST /runs/:id/deliver can retry it.
    'if PUSHOUT=$(git push -u origin "$B" 2>&1); then echo "$PUSHOUT"; else',
    '  echo "$PUSHOUT"',
    '  case "$PUSHOUT" in',
    `    *non-fast-forward*|*"fetch first"*|*"[rejected]"*|*"Updates were rejected"*) : > "$S"; echo "${DELIVER_LIFT_CONFLICT_MARKER} — push of $B was rejected because the remote branch moved (non-fast-forward); rebase and re-run; nothing was pushed"; exit 1;;`,
    `    *) : > "$S"; PUSHERR="\${PUSHOUT:0:96} ... \${PUSHOUT: -128}"; PUSHERR=\${PUSHERR//$'\\n'/ }; echo "deliver: git push of $B failed after commit: $PUSHERR; retry POST /runs/:id/deliver; nothing was pushed; ${DELIVER_LIFT_CONFLICT_MARKER}"; exit 1;;`,
    '  esac',
    'fi',
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
    'P=$(git rev-list --count "$D..origin/$B")',
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
