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
 *  3. HARNESS per file — the REPOSITORY's own: Playwright (`playwright.config.*` / `@playwright/test`)
 *     for `*.spec.*`, a Python Playwright rig (imports `playwright`) run as a script, vitest/jest from
 *     package.json, pytest otherwise for `.py`. A repo-local `node_modules/.bin/<tool>` is preferred
 *     over `npx` (offline, the repo's pinned version). No recognised harness = NOT EXECUTED = fail.
 *  4. REPO CHECKS — the full unit suite of every harness a produced test used (vitest/jest/pytest)
 *     runs once too, so the produced tests are verified INSIDE the repository's own check, not
 *     beside it. The Playwright suite is not re-run whole (its produced specs ran individually).
 *  5. VERDICT — `QE-VERIFY-SUMMARY:` then exit 0 only when: ≥ 1 produced test, every one executed,
 *     none failed, the PLAN exists, and the repo checks passed. Every refusal names its reason.
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
    'has_dep() { [ -f package.json ] && grep -Eq "\\"$1\\"[[:space:]]*:" package.json; }',
    'has_pw_config() { ls playwright.config.* >/dev/null 2>&1; }',
    'harness_for() {',
    '  case "$1" in',
    '    *.py)',
    '      if grep -Eq "^[[:space:]]*(from|import)[[:space:]]+playwright" "$1" 2>/dev/null; then echo playwright-python; return; fi',
    '      if [ -f pytest.ini ] || [ -f conftest.py ] || [ -f tests/conftest.py ] || python3 -c "import pytest" >/dev/null 2>&1; then echo pytest; return; fi',
    '      echo python; return;;',
    '  esac',
    '  case "$1" in *.spec.*) if has_pw_config || has_dep "@playwright/test"; then echo playwright; return; fi;; esac',
    '  if has_dep vitest; then echo vitest; return; fi',
    '  if has_dep jest; then echo jest; return; fi',
    '  if has_pw_config; then echo playwright; return; fi',
    '  echo unknown',
    '}',
    'P=0; E=0; PASS=0; FAIL=0; NX=0; PLAN=""; HARNESSES=""',
    'while IFS= read -r f; do',
    '  [ -n "$f" ] || continue',
    '  case "$f" in tests/PLAN-*.md|*/tests/PLAN-*.md) PLAN="$f";; esac',
    '  is_test_path "$f" || continue',
    '  P=$((P+1))',
    '  H=$(harness_for "$f")',
    '  case "$H" in',
    '    playwright) if [ -x node_modules/.bin/playwright ]; then CMD=(node_modules/.bin/playwright test "$f"); else CMD=(npx playwright test "$f"); fi;;',
    '    playwright-python|python) CMD=(python3 "$f");;',
    '    pytest) CMD=(python3 -m pytest -q "$f");;',
    '    vitest) if [ -x node_modules/.bin/vitest ]; then CMD=(node_modules/.bin/vitest run "$f"); else CMD=(npx vitest run "$f"); fi;;',
    '    jest) if [ -x node_modules/.bin/jest ]; then CMD=(node_modules/.bin/jest "$f"); else CMD=(npx jest "$f"); fi;;',
    '    *) NX=$((NX+1)); echo "QE-VERIFY: file=$f harness=unknown cmd=\\"\\" exit=- status=not-executed"; echo "qe-verify: no harness recognised for $f — declare one (playwright.config.*, vitest/jest in package.json, pytest)"; continue;;',
    '  esac',
    '  case " $HARNESSES " in *" $H "*) ;; *) HARNESSES="$HARNESSES $H";; esac',
    '  echo "QE-VERIFY-RUN file=$f harness=$H cmd=\\"${CMD[*]}\\""',
    '  "${CMD[@]}"; RC=$?',
    '  E=$((E+1))',
    '  if [ "$RC" -eq 0 ]; then PASS=$((PASS+1)); ST=passed; else FAIL=$((FAIL+1)); ST=failed; fi',
    '  echo "QE-VERIFY: file=$f harness=$H cmd=\\"${CMD[*]}\\" exit=$RC status=$ST"',
    'done <<QE_VERIFY_PRODUCED_EOF',
    '$PRODUCED',
    'QE_VERIFY_PRODUCED_EOF',
    // 4. repo checks
    'C=0; CF=0',
    'for H in $HARNESSES; do',
    '  case "$H" in',
    '    vitest) if [ -x node_modules/.bin/vitest ]; then CMD=(node_modules/.bin/vitest run); else CMD=(npx vitest run); fi;;',
    '    jest) if [ -x node_modules/.bin/jest ]; then CMD=(node_modules/.bin/jest); else CMD=(npx jest); fi;;',
    '    pytest) CMD=(python3 -m pytest -q);;',
    '    *) echo "QE-VERIFY-CHECK: harness=$H skipped=full-suite (produced files ran individually)"; continue;;',
    '  esac',
    '  C=$((C+1))',
    '  echo "QE-VERIFY-CHECK-RUN harness=$H cmd=\\"${CMD[*]}\\""',
    '  "${CMD[@]}"; RC=$?',
    '  [ "$RC" -eq 0 ] || CF=$((CF+1))',
    '  echo "QE-VERIFY-CHECK: harness=$H cmd=\\"${CMD[*]}\\" exit=$RC"',
    'done',
    // 5. verdict
    'echo "QE-VERIFY-SUMMARY: produced=$P executed=$E passed=$PASS failed=$FAIL not_executed=$NX plan=${PLAN:-missing} checks=$C checks_failed=$CF"',
    '[ "$P" -gt 0 ] || { echo "qe-verify: FAIL — the author phase produced no test files; nothing was verified, so done cannot be asserted"; exit 1; }',
    '[ -n "$PLAN" ] || { echo "qe-verify: FAIL — no tests/PLAN-*.md was produced (the plan records every test, the command that ran it and its result)"; exit 1; }',
    '[ "$NX" -eq 0 ] || { echo "qe-verify: FAIL — $NX produced test file(s) were never executed (no recognised harness); a test that never ran proves nothing"; exit 1; }',
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
  status: 'passed' | 'failed' | 'not-executed';
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
      const exit = status === 'not-executed' ? null : int(f['exit']);
      files.push({ path: f['file'], harness: f['harness'] ?? 'unknown', cmd: f['cmd'] ?? '', exit, status });
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
