/**
 * `qe-author-tests` — the governed test-authoring workflow (wave 6: F-7R2-003/004/005/012/014/015,
 * acceptance verdict R4-r2), workflows-as-data.
 *
 * ## Why a workflow, not a free-text run
 *
 * The studio's "New test" used to `POST /testing/recon` a plain free-text governed run: the planner
 * split the brief at sentence boundaries into seven alternating agent units, two of them chat
 * replies ("Gate protocol acknowledged … What is the next task?"), every gate a vacuous
 * default-allow, no `skill_ref` anywhere (the 40-specialist QE domain never routed), no deliver
 * phase (the LAST worker opened the PR from its own shell — invisible to the ledger), no campaign
 * registered (the Test landing stayed empty), and the produced Playwright e2e was never executed by
 * the run — it failed at its first check on the first independent run (R4-r2: 0 of 12 checks).
 *
 * This def is the fix, as data the engine validates AS AUTHORED (wicked-core#414 — a code-writing
 * agent phase carries the evidence-floor pin, the verified-evidence phase carries it too):
 *
 *   recon   (agent, neutral, `wicked-garden-qe` plan)   — read the repo + its tests, detect the
 *                                                          harness, map intent → behaviours → gaps
 *   author  (agent, CREATOR, `wicked-garden-qe` author,  — write behaviour tests against the repo's
 *            executes_code, evidence-floor pinned)         own harness + `tests/PLAN-<slug>.md`
 *   verify  (TOOL, verified_evidence, pinned)            — {@link qeVerifyScript}: run the repo's own
 *                                                          checks INCLUDING every produced test;
 *                                                          FAIL if any fails or was never executed
 *   review  (agent, EVALUATOR, `wicked-garden-qe` review,— independent fitness verdict; escalates a
 *            pinned, human_confirm_if verdict_not_pass)     not-pass to a human, never auto-denies
 *   deliver — NOT here. Appended per run by the ENGINE-side composition (`deliver: "pr"`, the
 *             crew#393 default for a repo-scoped code-work def): the engine lifts, re-verifies,
 *             pushes and opens the PR so the ledger records the delivery. A worker seat never
 *             pushes (the wave-6 engine's remote-write fence refuses `git push`/`gh pr create`).
 *
 * The METHOD lives in the garden skill (`wicked-garden-qe`, actions plan/author/review) — each
 * phase's inline `instructions` is a one-line orientation only, because a governed worker's prompt
 * rides a single PTY line capped at 1022 bytes (wicked-core execute_wrapped.rs) and the planner
 * folds the instructions onto that line beside the run intent.
 *
 * Crew-authored drop-in (like `capture-learnings`): NOT core-seeded, so `launchRun`'s
 * `_writeBuiltinOverlay` write is the only way the engine resolves the id. Not `is_system`: it IS an
 * operator-selectable work mode (the catalog finally carries something labelled test/QE — F-075).
 */

import { EVIDENCE_FLOOR_PIN } from '../core/deliver.js';
import type { PhaseDef, WorkflowDef } from '../core/types.js';

/** The workflow id — `GET /workflows` lists it; `POST /testing/author` launches it. */
export const QE_AUTHOR_TESTS_WORKFLOW = 'qe-author-tests';

/** The garden skill every agent phase routes through (`skills/qe/SKILL.md`, actions by name). */
export const QE_SKILL = 'wicked-garden-qe';

/** The deterministic verification phase's id (its unit is `<run>:verify` on the wire). */
export const QE_VERIFY_PHASE_ID = 'verify';

/** Per-produced-file marker the verify phase prints: `QE-VERIFY: file=… harness=… exit=… status=…`. */
export const QE_VERIFY_MARKER = 'QE-VERIFY:';
/** Repo-own-checks marker: `QE-VERIFY-CHECK: harness=… cmd="…" exit=…`. */
export const QE_VERIFY_CHECK_MARKER = 'QE-VERIFY-CHECK:';
/** The one summary line: `QE-VERIFY-SUMMARY: produced=N executed=N passed=N failed=N …`. */
export const QE_VERIFY_SUMMARY_MARKER = 'QE-VERIFY-SUMMARY:';

/** Where the author phase must record its plan (glob, repo-relative). */
export const QE_PLAN_GLOB = 'tests/PLAN-*.md';

/** Ceiling for each phase's inline orientation — the PTY line also carries the intent. */
export const QE_MAX_INLINE_INSTRUCTION_BYTES = 600;

const RECON_INSTRUCTIONS =
  'Phase 1/4 PLAN (qe skill, plan action): read the repository and its existing tests, detect the ' +
  'test harness (vitest/jest/pytest/Playwright and any loopback e2e fixture), map the operator ' +
  'intent to behaviours, and list the coverage gaps — cite file:line for anything you claim is ' +
  'already covered. Analysis only: write no files.';

const AUTHOR_INSTRUCTIONS =
  'Phase 2/4 AUTHOR (qe skill, author action): write BEHAVIOUR tests for the planned gaps against ' +
  "the repository's own harness, plus tests/PLAN-<slug>.md recording each test, the exact command " +
  'that runs it and its observed result. RUN every test you write before claiming it. Never push, ' +
  "never open or edit a pull request — the run's deliver phase does that.";

const REVIEW_INSTRUCTIONS =
  'Phase 4/4 REVIEW (qe skill, review action): judge the produced tests independently — behaviour ' +
  'vs implementation coupling, every claim of existing coverage verified at file:line, no sleeps ' +
  "or flaky waits, the PLAN matches what shipped, and the verify phase's QE-VERIFY report shows " +
  'every produced test executed. Verdict PASS or FAIL with reasons. Read-only: change nothing.';

/**
 * The verify phase's script — the R4-r2 floor: a produced test that fails, or was never run, FAILS
 * the unit. Runs in the run worktree as `bash -lc`:
 *
 *  1. BASE — the run branch's fork point off origin's default branch (the engine's own derivation
 *     order: origin/HEAD, origin/main, origin/master; then a local main/master; else HEAD).
 *  2. PRODUCED — every path changed/added since BASE plus every untracked file: the run's own work,
 *     committed or not. Test files are the conventional shapes (`*.test.*`, `*.spec.*`, `*_test.py`,
 *     `test_*.py`, `__tests__/`); fixtures, factories and the PLAN are produced but not "tests".
 *  3. HARNESS per file — the REPOSITORY's own, resolved PER FILE by walking up from the file's
 *     directory to the nearest marker (monorepo-aware — review H-1/M-1 of #536): Playwright
 *     (`playwright.config.*` / `@playwright/test` in the nearest package.json) for `*.spec.*`, a
 *     Python Playwright rig (imports `playwright`), vitest/jest from the nearest package.json that
 *     declares them, pytest for every other test-shaped `.py` (nearest `pytest.ini` / `conftest.py`
 *     / `tox.ini` / `pyproject.toml [tool.pytest]` / `setup.cfg [tool:pytest]` dir, else the root).
 *     The RUNNER is the nearest `node_modules/.bin/<tool>` (or `.venv/bin/pytest` / an importable
 *     pytest) from that package dir up to the worktree root — NEVER `npx` (a registry fetch on the
 *     verify path) and NEVER a plain interpreter for a test-shaped file (a pytest module run as
 *     `python3 file.py` defines its functions and exits 0 with zero assertions — a vacuous PASS).
 *     A missing/unrunnable runner is NOT EXECUTED = fail, with "harness not available: <tool>" and
 *     the remedy (install the dependencies in the worktree in the author phase). The runner runs
 *     FROM its package dir with a package-relative path.
 *  4. COLLECTED — every executed file must show ≥ 1 test in the RUNNER's own summary (pytest
 *     `N passed` / `collected N items`, vitest `Tests N passed`, jest `N total`, Playwright
 *     `N passed`, a Python rig's check/pass lines); exit 0 with 0 tests reported = NOT EXECUTED.
 *  5. REPO CHECKS — the full unit suite of every (harness, package dir) a produced test used
 *     (vitest/jest/pytest) runs once too, so the produced tests are verified INSIDE the repository's
 *     own check, not beside it. The Playwright suite is not re-run whole (its produced specs ran
 *     individually).
 *  6. VERDICT — `QE-VERIFY-SUMMARY:` then exit 0 only when: ≥ 1 produced test, every one executed
 *     with ≥ 1 test collected, none failed, the PLAN exists, and the repo checks passed. Every
 *     refusal names its reason.
 *
 * `set -u -o pipefail` but NOT `-e`: each command's exit is captured deliberately. `exec 2>&1`
 * keeps the transcript chronological (the engine appends stderr after stdout otherwise).
 */
export function qeVerifyScript(): string {
  return [
    'set -uo pipefail',
    'exec 2>&1',
    'echo "QE-VERIFY-BEGIN worktree=$PWD"',
    // 1. base
    'D=$(git symbolic-ref -q --short refs/remotes/origin/HEAD || true)',
    'if [ -z "$D" ] || ! git rev-parse --verify -q "$D^{commit}" >/dev/null; then',
    '  if git rev-parse --verify -q origin/main^{commit} >/dev/null; then D=origin/main;',
    '  elif git rev-parse --verify -q origin/master^{commit} >/dev/null; then D=origin/master;',
    '  elif git rev-parse --verify -q main^{commit} >/dev/null; then D=main;',
    '  elif git rev-parse --verify -q master^{commit} >/dev/null; then D=master;',
    '  else D=""; fi',
    'fi',
    'if [ -n "$D" ]; then BASE=$(git merge-base "$D" HEAD 2>/dev/null || git rev-parse HEAD); else BASE=$(git rev-parse HEAD); fi',
    'echo "QE-VERIFY-BASE ref=${D:-HEAD} commit=$BASE"',
    // 2. produced
    'PRODUCED=$( { git diff --name-only --diff-filter=AMR "$BASE" -- . ; git ls-files --others --exclude-standard ; } | sort -u )',
    'is_test_path() {',
    '  case "$1" in *.md|*.json|*.snap|*.txt|*.yml|*.yaml|*.toml|*.lock|*.html|*.css|*.png|*.svg) return 1;; esac',
    '  case "$1" in *.test.*|*.spec.*|*_test.py|test_*.py|*/test_*.py|__tests__/*|*/__tests__/*) return 0;; esac',
    '  return 1',
    '}',
    // 3. harness detection — PER FILE, nearest marker dir walking UP from the file (monorepo-aware)
    'pkg_has_dep() { [ -f "$1/package.json" ] && grep -Eq "\\"$2\\"[[:space:]]*:" "$1/package.json"; }',
    'is_pw_dir() { ls "$1"/playwright.config.* >/dev/null 2>&1 || pkg_has_dep "$1" "@playwright/test"; }',
    'is_vitest_dir() { pkg_has_dep "$1" vitest; }',
    'is_jest_dir() { pkg_has_dep "$1" jest; }',
    'is_py_dir() { [ -f "$1/pytest.ini" ] || [ -f "$1/conftest.py" ] || [ -f "$1/tox.ini" ] || { [ -f "$1/pyproject.toml" ] && grep -q "tool.pytest" "$1/pyproject.toml"; } || { [ -f "$1/setup.cfg" ] && grep -q "tool:pytest" "$1/setup.cfg"; }; }',
    'nearest() { local d; d=$(dirname "$1"); while :; do if "$2" "$d"; then echo "$d"; return 0; fi; [ "$d" = "." ] && break; d=$(dirname "$d"); done; echo ""; return 1; }',
    // the runner: the nearest node_modules/.bin/<tool> from the package dir up to the worktree root,
    // spelled RELATIVE TO the package dir (every command runs from there: `./…` or `../…`) — NEVER npx
    'find_bin() { local d="$1" up=""; while :; do if [ -x "$d/node_modules/.bin/$2" ]; then echo "${up:-./}node_modules/.bin/$2"; return 0; fi; [ "$d" = "." ] && break; d=$(dirname "$d"); up="../$up"; done; echo ""; return 1; }',
    'find_pytest() { local d="$1" up=""; while :; do if [ -x "$d/.venv/bin/pytest" ]; then echo "${up:-./}.venv/bin/pytest"; return 0; fi; [ "$d" = "." ] && break; d=$(dirname "$d"); up="../$up"; done; if python3 -c "import pytest" >/dev/null 2>&1; then echo "python3 -m pytest"; return 0; fi; echo ""; return 1; }',
    'resolve() {',
    '  local d',
    '  case "$1" in',
    '    *.py)',
    '      if grep -Eq "^[[:space:]]*(from|import)[[:space:]]+playwright" "$1" 2>/dev/null; then echo "playwright-python	$(dirname "$1")"; return; fi',
    '      d=$(nearest "$1" is_py_dir); [ -n "$d" ] || d="."',
    '      echo "pytest	$d"; return;;',
    '  esac',
    '  case "$1" in *.spec.*) d=$(nearest "$1" is_pw_dir); if [ -n "$d" ]; then echo "playwright	$d"; return; fi;; esac',
    '  d=$(nearest "$1" is_vitest_dir); if [ -n "$d" ]; then echo "vitest	$d"; return; fi',
    '  d=$(nearest "$1" is_jest_dir); if [ -n "$d" ]; then echo "jest	$d"; return; fi',
    '  d=$(nearest "$1" is_pw_dir); if [ -n "$d" ]; then echo "playwright	$d"; return; fi',
    '  echo "unknown	."',
    '}',
    // how many tests the RUNNER says it executed (its own summary line) — 0 = nothing ran
    'sum_counts() { grep -E "$2" "$1" | tail -1 | awk \'{s=0; for(i=1;i<=NF;i++) if($i ~ /^[0-9]+$/ && $(i+1) ~ /^(passed|failed|flaky|skipped|total)/) s+=$i; print s}\'; }',
    'collected() {',
    '  local n=""',
    '  case "$1" in',
    '    pytest) n=$(sum_counts "$2" "[0-9]+ (passed|failed)"); [ "${n:-0}" -gt 0 ] || n=$(grep -Eo "collected [0-9]+ item" "$2" | tail -1 | grep -Eo "[0-9]+");;',
    '    vitest) n=$(sum_counts "$2" "^[[:space:]]*Tests[[:space:]]");;',
    '    jest) n=$(grep -Eo "[0-9]+ total" "$2" | tail -1 | grep -Eo "[0-9]+");;',
    '    playwright) n=$(sum_counts "$2" "[0-9]+ (passed|failed|flaky)");;',
    '    playwright-python) n=$(grep -Eci "passed|\\bpass\\b|✓|\\"checks\\"|\\bok\\b" "$2");;',
    '  esac',
    '  echo "${n:-0}"',
    '}',
    'P=0; E=0; PASS=0; FAIL=0; NX=0; PLAN=""; HARNESSES=""',
    'not_executed() { NX=$((NX+1)); echo "QE-VERIFY: file=$1 harness=$2 pkg=$3 cmd=\\"\\" exit=- tests=0 status=not-executed reason=\\"$4\\""; echo "qe-verify: $1 — $4"; }',
    'while IFS= read -r f; do',
    '  [ -n "$f" ] || continue',
    '  case "$f" in tests/PLAN-*.md|*/tests/PLAN-*.md) PLAN="$f";; esac',
    '  is_test_path "$f" || continue',
    '  P=$((P+1))',
    '  R=$(resolve "$f"); H="${R%%	*}"; PKG="${R#*	}"',
    '  rel="$f"; [ "$PKG" = "." ] || rel="${f#$PKG/}"',
    '  case "$H" in',
    '    playwright) BIN=$(find_bin "$PKG" playwright) || { not_executed "$f" "$H" "$PKG" "harness not available: playwright (@playwright/test) — no node_modules/.bin/playwright from $PKG up to the worktree root; install the repository dependencies in the worktree (npm ci) in the author phase. The verify path never runs npx"; continue; }; CMD=("$BIN" test "$rel");;',
    '    vitest) BIN=$(find_bin "$PKG" vitest) || { not_executed "$f" "$H" "$PKG" "harness not available: vitest — no node_modules/.bin/vitest from $PKG up to the worktree root; install the repository dependencies in the worktree (npm ci) in the author phase. The verify path never runs npx"; continue; }; CMD=("$BIN" run "$rel");;',
    '    jest) BIN=$(find_bin "$PKG" jest) || { not_executed "$f" "$H" "$PKG" "harness not available: jest — no node_modules/.bin/jest from $PKG up to the worktree root; install the repository dependencies in the worktree (npm ci) in the author phase. The verify path never runs npx"; continue; }; CMD=("$BIN" "$rel");;',
    '    pytest) PT=$(find_pytest "$PKG") || { not_executed "$f" "$H" "$PKG" "harness not available: pytest — no .venv/bin/pytest from $PKG up to the worktree root and python3 cannot import pytest; a test-shaped .py file is NEVER run as a plain script (it would pass with zero assertions). Install pytest in the worktree in the author phase"; continue; }; if [ "$PT" = "python3 -m pytest" ]; then CMD=(python3 -m pytest -q "$rel"); else CMD=("$PT" -q "$rel"); fi;;',
    '    playwright-python) python3 -c "import playwright" >/dev/null 2>&1 || { not_executed "$f" "$H" "$PKG" "harness not available: playwright (python) — python3 cannot import playwright; pip install playwright && playwright install chromium in the author phase"; continue; }; CMD=(python3 "$rel");;',
    '    *) not_executed "$f" unknown "$PKG" "no harness recognised — declare one the repository owns (playwright.config.*, vitest/jest in the nearest package.json, a pytest marker)"; continue;;',
    '  esac',
    '  case " $HARNESSES " in *" $H|$PKG "*) ;; *) HARNESSES="$HARNESSES $H|$PKG";; esac',
    '  echo "QE-VERIFY-RUN file=$f harness=$H pkg=$PKG cmd=\\"${CMD[*]}\\""',
    '  OUT=$(mktemp)',
    '  ( cd "$PKG" && "${CMD[@]}" ) 2>&1 | tee "$OUT"; RC=${PIPESTATUS[0]}',
    '  N=$(collected "$H" "$OUT"); rm -f "$OUT"',
    '  E=$((E+1))',
    '  if [ "$RC" -ne 0 ]; then FAIL=$((FAIL+1)); ST=failed;',
    '  elif [ "${N:-0}" -lt 1 ]; then NX=$((NX+1)); E=$((E-1)); ST=not-executed; echo "qe-verify: $f — the $H runner exited 0 but reported 0 tests (nothing was collected or executed)";',
    '  else PASS=$((PASS+1)); ST=passed; fi',
    '  echo "QE-VERIFY: file=$f harness=$H pkg=$PKG cmd=\\"${CMD[*]}\\" exit=$RC tests=${N:-0} status=$ST"',
    "done < <(printf '%s\\n' \"$PRODUCED\")",
    // 4. repo checks — the full unit suite once per (harness, package dir) the produced tests used
    'C=0; CF=0',
    'for HP in $HARNESSES; do',
    '  H="${HP%%|*}"; PKG="${HP#*|}"',
    '  case "$H" in',
    '    vitest) BIN=$(find_bin "$PKG" vitest); CMD=("$BIN" run);;',
    '    jest) BIN=$(find_bin "$PKG" jest); CMD=("$BIN");;',
    '    pytest) PT=$(find_pytest "$PKG"); if [ "$PT" = "python3 -m pytest" ]; then CMD=(python3 -m pytest -q); else CMD=("$PT" -q); fi;;',
    '    *) echo "QE-VERIFY-CHECK: harness=$H pkg=$PKG skipped=full-suite (produced files ran individually)"; continue;;',
    '  esac',
    '  C=$((C+1))',
    '  echo "QE-VERIFY-CHECK-RUN harness=$H pkg=$PKG cmd=\\"${CMD[*]}\\""',
    '  ( cd "$PKG" && "${CMD[@]}" ); RC=$?',
    '  [ "$RC" -eq 0 ] || CF=$((CF+1))',
    '  echo "QE-VERIFY-CHECK: harness=$H pkg=$PKG cmd=\\"${CMD[*]}\\" exit=$RC"',
    'done',
    // 5. verdict
    'echo "QE-VERIFY-SUMMARY: produced=$P executed=$E passed=$PASS failed=$FAIL not_executed=$NX plan=${PLAN:-missing} checks=$C checks_failed=$CF"',
    '[ "$P" -gt 0 ] || { echo "qe-verify: FAIL — the author phase produced no test files; nothing was verified, so done cannot be asserted"; exit 1; }',
    '[ -n "$PLAN" ] || { echo "qe-verify: FAIL — no tests/PLAN-*.md was produced (the plan records every test, the command that ran it and its result)"; exit 1; }',
    '[ "$NX" -eq 0 ] || { echo "qe-verify: FAIL — $NX produced test file(s) were never executed (no available harness, or the runner reported 0 tests); a test that never ran proves nothing"; exit 1; }',
    '[ "$FAIL" -eq 0 ] || { echo "qe-verify: FAIL — $FAIL of $E produced test file(s) failed under the repository harness"; exit 1; }',
    '[ "$CF" -eq 0 ] || { echo "qe-verify: FAIL — $CF repository check(s) failed with the produced tests in the tree"; exit 1; }',
    'echo "qe-verify: PASS — $E produced test file(s) executed and passed under the repository harness; plan $PLAN"',
  ].join('\n');
}

function agentPhase(
  id: string,
  kind: PhaseDef['kind'],
  instructions: string,
  over: Partial<PhaseDef>,
): PhaseDef {
  return {
    id,
    kind,
    instructions,
    gate_type: 'execution',
    gate: 'auto',
    executes_code: false,
    verified_evidence: false,
    required_deliverables: [],
    depends_on: [],
    role: 'neutral',
    skill_ref: QE_SKILL,
    allowed_skills: [],
    validator_pin: null,
    ...over,
  };
}

/** The verify TOOL phase — deterministic, pinned to the evidence floor (the run left a change),
 *  `executes_code: false` like the deliver phase: engine-owned tooling, not governed agent work
 *  (a Tool unit is never worktree-guarded, so the harness's caches cannot deny it). */
export function qeVerifyPhase(dependsOn: string[] = ['author']): PhaseDef {
  return {
    id: QE_VERIFY_PHASE_ID,
    kind: 'test',
    executor: { type: 'tool', cmd: ['bash', '-lc', qeVerifyScript()] },
    gate_type: 'execution',
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

/** The shipped definition (see the module doc). Exported as data — tests assert it, the adapter
 *  serves it from `BUILTIN_WORKFLOWS`, and the engine validates it as authored at the overlay write. */
export const QE_AUTHOR_TESTS_WORKFLOW_DEF: WorkflowDef = {
  id: QE_AUTHOR_TESTS_WORKFLOW,
  phases: [
    agentPhase('recon', 'recon', RECON_INSTRUCTIONS, { gate_type: 'strategy', role: 'neutral' }),
    agentPhase('author', 'build', AUTHOR_INSTRUCTIONS, {
      depends_on: ['recon'],
      role: 'creator',
      executes_code: true,
      validator_pin: EVIDENCE_FLOOR_PIN,
    }),
    qeVerifyPhase(['author']),
    agentPhase('review', 'review', REVIEW_INSTRUCTIONS, {
      depends_on: [QE_VERIFY_PHASE_ID],
      role: 'evaluator',
      gate: { human_confirm_if: 'verdict_not_pass' },
      validator_pin: EVIDENCE_FLOOR_PIN,
    }),
  ],
};

// ── The verify report, parsed back from the unit's transcript ─────────────────────────────────

/** One produced test file as the verify phase judged it. */
export interface QeVerifiedFile {
  path: string;
  /** `playwright` | `playwright-python` | `vitest` | `jest` | `pytest` | `python` | `unknown`. */
  harness: string;
  cmd: string;
  /** The process exit code; `null` when the file was never executed. */
  exit: number | null;
  /** How many tests the RUNNER reported for the file (its own summary line); `0` when nothing was
   *  collected — which reads as `not-executed` even on exit 0 (review H-1 of #536). */
  tests: number;
  /** The package dir (worktree-relative, `.` = root) the harness was resolved in and run from. */
  pkg: string;
  status: 'passed' | 'failed' | 'not-executed';
  /** Why a `not-executed` file was not executed ("harness not available: pytest — …"). */
  reason?: string;
}

/** One repository-own check the verify phase ran. */
export interface QeVerifiedCheck {
  harness: string;
  cmd: string;
  exit: number;
}

/** The verify phase's report — what the campaign/test-set registration and the studio read. */
export interface QeVerifyReport {
  files: QeVerifiedFile[];
  checks: QeVerifiedCheck[];
  produced: number;
  executed: number;
  passed: number;
  failed: number;
  notExecuted: number;
  /** The produced `tests/PLAN-*.md` path, `null` when none was produced. */
  plan: string | null;
  checksFailed: number;
}

/** `key=value` and `key="quoted value"` pairs of one marker line. */
function fields(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z_]+)=("([^"]*)"|\S*)/g;
  for (const m of rest.matchAll(re)) out[m[1]!] = m[3] !== undefined ? m[3] : (m[2] ?? '');
  return out;
}

function int(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Parse the verify unit's transcript into a {@link QeVerifyReport}. `null` when the transcript
 * carries no `QE-VERIFY-SUMMARY:` line (the phase never reached its verdict — the unit's status
 * and `denial_reason` say why).
 */
export function parseQeVerifyOutput(text: string): QeVerifyReport | null {
  const files: QeVerifiedFile[] = [];
  const checks: QeVerifiedCheck[] = [];
  let summary: Record<string, string> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(QE_VERIFY_SUMMARY_MARKER)) {
      summary = fields(line.slice(QE_VERIFY_SUMMARY_MARKER.length));
    } else if (line.startsWith(QE_VERIFY_CHECK_MARKER)) {
      const f = fields(line.slice(QE_VERIFY_CHECK_MARKER.length));
      if (f['skipped'] !== undefined || f['harness'] === undefined || f['exit'] === undefined) continue;
      checks.push({ harness: f['harness'], cmd: f['cmd'] ?? '', exit: int(f['exit']) });
    } else if (line.startsWith(QE_VERIFY_MARKER)) {
      const f = fields(line.slice(QE_VERIFY_MARKER.length));
      if (f['file'] === undefined) continue;
      const status =
        f['status'] === 'passed' || f['status'] === 'failed' ? f['status'] : ('not-executed' as const);
      // A file the runner ran but reported 0 tests for carries its exit code; a file never handed
      // to a runner has `exit=-` (→ null).
      const exit = f['exit'] === undefined || f['exit'] === '-' ? null : int(f['exit']);
      files.push({
        path: f['file'],
        harness: f['harness'] ?? 'unknown',
        cmd: f['cmd'] ?? '',
        exit,
        tests: int(f['tests']),
        pkg: f['pkg'] === undefined || f['pkg'] === '' ? '.' : f['pkg'],
        status,
        ...(f['reason'] !== undefined && f['reason'] !== '' ? { reason: f['reason'] } : {}),
      });
    }
  }
  if (summary === null) return null;
  return {
    files,
    checks,
    produced: int(summary['produced']),
    executed: int(summary['executed']),
    passed: int(summary['passed']),
    failed: int(summary['failed']),
    notExecuted: int(summary['not_executed']),
    plan: summary['plan'] === undefined || summary['plan'] === 'missing' ? null : summary['plan'],
    checksFailed: int(summary['checks_failed']),
  };
}

// ── The intake plan (F-7R2-008) ───────────────────────────────────────────────────────────────

/** One planned phase as the intake gate shows it — derived from the DEF, not from prose. */
export interface QeAuthorPlanPhase {
  id: string;
  kind: PhaseDef['kind'];
  role: PhaseDef['role'];
  executor: 'agent' | 'tool';
  skillRef: string | null;
  /** `auto` | `human` (unconditional confirm) | `human_if_not_pass`. */
  gate: 'auto' | 'human' | 'human_if_not_pass';
  executesCode: boolean;
  /** `true` for the phase the ENGINE appends and owns (the deliver phase). */
  engine?: boolean;
}

/** The plan the intake gate shows: the def's phases in order, then the engine's deliver phase when
 *  the launch delivers, and the seats the council may pick from (the launcher's eligible roster). */
export interface QeAuthorPlan {
  workflow: string;
  phases: QeAuthorPlanPhase[];
  seats: string[];
}

function gateLabel(gate: PhaseDef['gate']): QeAuthorPlanPhase['gate'] {
  if (typeof gate === 'object' && gate !== null && 'human_confirm' in gate) return 'human';
  if (typeof gate === 'object' && gate !== null && 'human_confirm_if' in gate) return 'human_if_not_pass';
  return 'auto';
}

export function qeAuthorPlan(
  def: WorkflowDef,
  seats: string[],
  deliver: boolean,
): QeAuthorPlan {
  const phases: QeAuthorPlanPhase[] = def.phases.map((p) => ({
    id: p.id,
    kind: p.kind,
    role: p.role,
    executor: p.executor?.type === 'tool' ? 'tool' : 'agent',
    skillRef: p.skill_ref,
    gate: gateLabel(p.gate),
    executesCode: p.executes_code,
  }));
  if (deliver) {
    phases.push({
      id: 'deliver',
      kind: 'build',
      role: 'neutral',
      executor: 'tool',
      skillRef: null,
      gate: 'auto',
      executesCode: false,
      engine: true,
    });
  }
  return { workflow: def.id, phases, seats };
}
