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
 *  (e) `gh pr create --head <branch> --title … --body-file …`, with gh's output and exit status
 *      captured SEPARATELY so a gh failure fails the phase carrying gh's own message. The title
 *      and body are COMPOSED FROM THE RUN (crew#524 / F-3R2-014, `core/deliver-text.ts`): the
 *      script asks the daemon that launched it (`GET /runs/:id/deliver-text`) for the text derived
 *      from the persisted run record — intent, `Fixes #N`, run link, phases + seats + gate
 *      outcomes, repo checks with exit codes, the evaluator verdict — and falls back to the same
 *      composer's launch-time text (embedded in the script) when the daemon cannot answer. The
 *      commit message is that same text (`git commit -F`), so subject and title never drift;
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
import {
  composeDeliverText,
  factsFromWorkflow,
  framedDeliverText,
  runUrlFor,
  type DeliverTextFacts,
} from './deliver-text.js';

/**
 * The content-address of wicked-core's built-in evidence floor (`builtin_floors::EVIDENCE_FLOOR_PIN`,
 * criterion "the run left a change in its worktree (done is re-derived from the diff, never
 * asserted)"). Carried explicitly on every phase crew composes or mirrors that declares
 * `verified_evidence` or writes code: since wicked-core#414 the engine judges a def AS AUTHORED at
 * registration — it REFUSES an `executes_code` agent phase with no pin and no human gate, and a
 * `verified_evidence` phase with no pin — so nothing is armed on crew's behalf any more.
 *
 * Duplicating a hash is a real cost, paid because the alternative is worse: a `null` here would
 * be a refused registration for every deliver-composed run. The floor is seeded on core's plan
 * path (`pre_distribute`), so this pin always resolves without a provision/approve step. The drift
 * guards in `tests/armed-workflow-served.test.ts` and `tests/deliver-phase.test.ts` fail loudly on
 * a developer machine the moment core's value moves.
 */
export const EVIDENCE_FLOOR_PIN = 'e2e7af1db9e48454';

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

/** What the script carries for its PR/commit text (crew#524). All optional: the bare script still
 *  composes a title and a body from the intent alone. */
export interface DeliverScriptOptions {
  /** The run this script delivers; names the run in the fallback text. */
  runId?: string;
  /** Everything known when the script was composed — the embedded fallback is built from it.
   *  Defaults to the intent + run id alone (no workflow, no phases). */
  facts?: DeliverTextFacts;
  /** The launching daemon's own origin (`http://127.0.0.1:7701`). When set, the script first asks
   *  it for the run-derived text; unset (or unreachable) ⇒ the embedded fallback. */
  apiOrigin?: string | null;
}

/**
 * The BASE heredoc delimiter the script writes its fallback text through. A QUOTED heredoc expands
 * nothing — `$`, backticks, quotes and backslashes in the intent are inert — so the only way the
 * caller-supplied text could break out is a line equal to the delimiter. That line is never
 * removed or altered (it may be the title itself — Copilot on #525): {@link heredocDelimiter}
 * picks a delimiter no line of the text equals, so the text rides verbatim and the heredoc still
 * ends exactly where the script says it ends.
 */
export const DELIVER_TEXT_HEREDOC = 'WICKED_CREW_DELIVER_TEXT_EOF';

/**
 * The framed PR/commit text as heredoc body lines. This is a containment boundary, not cosmetics:
 * the intent is caller-supplied free text off `POST /runs` and it is being spliced into a bash
 * script. CR and every control character other than tab and newline are removed (a bare CR could
 * split a line in the CLI's eyes); nothing else is touched.
 */
export function heredocLines(framed: string): string[] {
  return framed
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n$/, '')
    .split('\n');
}

/**
 * A heredoc delimiter none of `lines` equals: the base, or the base with a numeric suffix
 * (`…_EOF_1`, `…_EOF_2`, …) when the text happens to carry the base as a whole line. The framing
 * (line 1 = title) is therefore never disturbed by containment.
 */
export function heredocDelimiter(lines: readonly string[]): string {
  let delimiter = DELIVER_TEXT_HEREDOC;
  for (let n = 1; lines.includes(delimiter); n += 1) delimiter = `${DELIVER_TEXT_HEREDOC}_${n}`;
  return delimiter;
}

/**
 * The daemon origin as a single-quoted shell literal, or `''` when it is not a plain http(s)
 * origin. Same containment logic as the heredoc: nothing that is not `scheme://host[:port]` is
 * ever spliced into the script, so a hostile value can only cost the callback, never a line.
 */
function apiOriginLiteral(origin: string | null | undefined): string {
  if (origin === null || origin === undefined) return '';
  const trimmed = origin.replace(/\/+$/, '');
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(trimmed) ? trimmed : '';
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
 * `intent` (the run's problem statement) is what the PR title and the commit subject are composed
 * from (`core/deliver-text.ts`); `opts` carries the rest of the launch-time facts and the daemon
 * origin the script asks for the run-derived text (crew#524).
 */
export function deliverPrScript(intent?: string, opts: DeliverScriptOptions = {}): string {
  const runId = opts.runId ?? opts.facts?.runId ?? '';
  const fallback = composeDeliverText(
    opts.facts ??
      factsFromWorkflow({
        runId,
        intent,
        workflowId: null,
        repoRef: null,
        phases: [],
        runUrl: null,
      }),
  );
  const api = apiOriginLiteral(opts.apiOrigin);
  const fallbackLines = heredocLines(framedDeliverText(fallback));
  const heredoc = heredocDelimiter(fallbackLines);
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
    //
    // (c1-text) THE PR TITLE + BODY AND THE COMMIT MESSAGE (crew#524 / F-3R2-014). `--fill` gave
    // wicked-studio#249 a title cut mid-word and an EMPTY body. The text now comes from the run:
    // the script asks the daemon that launched it for `GET /runs/<id>/deliver-text` — composed from
    // the persisted run record (phases + seats + gate outcomes, repo checks with exit codes, the
    // evaluator verdict, the run link) — and falls back to the launch-time composition embedded
    // below (intent, `Fixes #N`, run id, phase list) when the daemon cannot answer: no origin
    // known, no `curl`, an auth-required daemon (401), a daemon that went away. Either way the text
    // is FRAMED the same (line 1 title, line 2 blank, then the body), it is the commit message
    // verbatim (`git commit -F`: git takes the first paragraph as the subject), and the PR is
    // opened with `--title` + `--body-file` from it. WHICH text was used is always said in the
    // output — every branch below prints its reason (Copilot on #525): no origin known, no curl,
    // the daemon did not answer, or the run record was fetched.
    'TD=$(mktemp -d)',
    "trap 'rm -rf \"$TD\"' EXIT",
    'RUNID="${B#wicked/}"',
    `API='${api}'`,
    'if [ -z "$API" ]; then',
    '  echo "deliver: no daemon origin was known when this run launched — using the launch-time PR text"',
    'elif ! command -v curl >/dev/null 2>&1; then',
    '  echo "deliver: curl is not available in this shell — using the launch-time PR text"',
    // `--noproxy "*"`: the daemon is loopback; an operator shell's http_proxy must not swallow it.
    'elif curl -fsS -m 20 --noproxy "*" -H "Accept: text/plain" "$API/api/v1/runs/$RUNID/deliver-text" -o "$TD/text" 2>/dev/null && [ -s "$TD/text" ] && [ -n "$(sed -n 1p "$TD/text")" ]; then',
    '  echo "deliver: PR text composed from the run record ($API)"',
    'else',
    '  rm -f "$TD/text"',
    '  echo "deliver: the daemon at $API did not answer with the run record — using the launch-time PR text"',
    'fi',
    'if [ ! -s "$TD/text" ]; then',
    // The delimiter is chosen so no line of the text equals it (heredocDelimiter) — the text,
    // title line included, is never filtered.
    `  cat > "$TD/text" <<'${heredoc}'`,
    ...fallbackLines,
    heredoc,
    'fi',
    'TITLE=$(sed -n 1p "$TD/text")',
    "sed '1,2d' \"$TD/text\" > \"$TD/body\"",
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
    // Classify on a LOWERCASED basename so DEPLOY.KEY / .ENV / SOCKET.PATH cannot bypass the
    // denylist by case (review, #439).
    '  LBN=$(printf "%s" "$BN" | tr "[:upper:]" "[:lower:]")',
    '  case "$LBN" in',
    '    *.db|*.db-wal|*.db-shm|*.sqlite|*.sqlite2|*.sqlite3|*.sqlite-wal|*.sqlite-shm|*.sock|*.pid|*.env|*.env.*|.envrc|*.gif|*.webm|*.mp4|*.mov|*.pem|*.key|*.p12|*.pfx|id_rsa*|*credentials*) RN="denylisted-name";;',
    '  esac',
    '  case "$LBN" in *socket*) [ -n "$RN" ] || RN="socket-name";; esac',
    '  [ "$BN" = ".DS_Store" ] && [ -z "$RN" ] && RN="ds-store"',
    '  case "/$F" in */tmp/*|*/.tmp/*|*/scratch/*|*/.cache/*|*/coverage/*) [ -n "$RN" ] || RN="scratch-dir";; esac',
    '  if [ -z "$RN" ]; then SZ=$(wc -c < "$F" 2>/dev/null || echo 0); [ "${SZ:-0}" -gt 1048576 ] && RN="oversize-1mib"; fi',
    '  if [ -n "$RN" ]; then echo "deliver: EXCLUDED ($RN): $F"; else git add -- "$F"; fi',
    'done < <(git ls-files --others --exclude-standard -z)',
    // Only commit when something is staged — a run that committed incrementally (core#280's
    // liveness contract) leaves a clean tree and must not gain an empty commit here.
    'git diff --cached --quiet || git commit -q -F "$TD/text"',
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
    // Title and body are the composed text (c1-text) — never `--fill` (crew#524).
    'if ! OUT=$(gh pr create --head "$B" --title "$TITLE" --body-file "$TD/body" 2>&1); then echo "$OUT"; echo "deliver: gh pr create failed for $B — no PR was opened"; exit 1; fi',
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
 * ## Why `verified_evidence: true` AND `validator_pin: EVIDENCE_FLOOR_PIN` (crew#317, core#414)
 *
 * The phase that touches the remote was the one phase nothing re-derived. The engine's phase model
 * DOES let a Tool-executor phase carry a deterministic floor: the flag says the phase's evidence is
 * re-verified, the pin says by what.
 *
 *  - a pin is a CONTENT ADDRESS into core's validator vault, and `attach_pinned_validators` is
 *    fail-closed on one that does not resolve — it BAILS the run at plan time. Authoring and
 *    approving a validator is `wicked-core provision-validator` + `approve-validator`, neither of
 *    which is exposed through the napi surface crew drives, so a pin crew INVENTED would fail
 *    every run on a machine nobody seeded by hand;
 *  - the built-in evidence floor is different: `pre_distribute` seeds it on the plan path so it
 *    ALWAYS resolves — it is the same pin core's own `feature/test`, `bug/verify` and
 *    `migration/verify` carry;
 *  - and since wicked-core#414 (codex review) the engine no longer arms a flagged phase that names
 *    no pin — registration judges the def AS AUTHORED and REFUSES it ("verified_evidence declared
 *    but nothing pinned: deliver-pr"). A `null` pin here would refuse every deliver-composed run.
 *
 * The floor then re-runs against the run's worktree at the gate, INDEPENDENTLY of anything this
 * script printed, and denies the phase when the run left no change. Layer 2 (the agent judge)
 * stays out of it: core hands the Tool path `agent_verdict: None`, so a tool phase's floor is
 * deterministic and costs no LLM call. The PR-URL and branch-ahead assertions stay in the script
 * because no vaulted floor can see the remote.
 */
export function deliverPrPhase(
  dependsOn: string[] = [],
  intent?: string,
  opts: DeliverScriptOptions = {},
): PhaseDef {
  return {
    id: DELIVER_PHASE_ID,
    kind: 'build',
    executor: { type: 'tool', cmd: ['bash', '-lc', deliverPrScript(intent, opts)] },
    gate_type: null,
    gate: 'auto',
    executes_code: false,
    verified_evidence: true,
    required_deliverables: [],
    depends_on: dependsOn,
    role: 'neutral',
    skill_ref: null,
    allowed_skills: [],
    validator_pin: EVIDENCE_FLOOR_PIN,
  };
}

/**
 * Compose a PER-RUN workflow def: `base`'s phases (untouched — the shared def is never mutated)
 * plus the deliver phase appended last, under a run-scoped id. The caller registers the result
 * with the engine for THIS run only; nothing is written to the overlay dir and the composed id
 * never enters the user-workflow registry, so the catalog (`GET /workflows`) stays clean.
 *
 * `intent` is the run's problem statement — the PR title and commit subject are composed from it
 * (`core/deliver-text.ts`); omit it and they name the run id alone. `launch` carries what else is
 * known here (the repo, the daemon's own origin) so the phase's embedded fallback text names the
 * workflow, its phases and the run link, and so the script knows which daemon to ask for the
 * run-derived text at delivery time (crew#524).
 *
 * Throws when `base` already carries a `deliver` phase — appending a second phase with the same
 * id would be ambiguous at best; the caller launches such a def as-is instead (see
 * `CoreAdapter.launchRun`).
 */
export interface DeliverLaunchContext {
  repoRef?: string | null;
  apiOrigin?: string | null;
}

export function composeDeliverWorkflow(
  base: WorkflowDef,
  runId: string,
  intent?: string,
  launch: DeliverLaunchContext = {},
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
  const apiOrigin = launch.apiOrigin ?? null;
  const facts = factsFromWorkflow({
    runId,
    intent,
    workflowId: base.id,
    repoRef: launch.repoRef ?? null,
    phases: base.phases,
    runUrl: runUrlFor(apiOrigin, runId),
  });
  return {
    // No `is_system` on purpose: core's overlay/register schema rejects unknown fields, and the
    // composed def is engine-input, not catalog data.
    id: composedId,
    phases: [
      ...base.phases,
      deliverPrPhase(last !== undefined ? [last.id] : [], intent, { runId, facts, apiOrigin }),
    ],
  };
}
