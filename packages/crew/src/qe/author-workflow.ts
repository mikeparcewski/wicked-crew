/**
 * `qe-author-tests` — the governed test-authoring workflow (wave 6: F-7R2-003/004/005/012/014/015,
 * acceptance verdict R4-r2). It is wicked-core's built-in preset (X-MIG M10; its steps, the verify
 * Tool script included, live in core's `src/presets/qe-author-tests.json`): recon → author (the
 * creator, evidence-floor pinned) → verify (the Tool step that runs the repo's own checks INCLUDING
 * every produced test) → review (the evaluator, `human_confirm_if verdict_not_pass`). Crew serves
 * it from the engine (`core/builtin-catalog.ts`, X-MIG M11) and keeps here only what it READS back:
 * the verify report's markers and parser, and the plan summary the testing route answers with.
 */

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
  /** Present when exit is non-zero: how the failure was classified by base comparison. */
  class?: 'produced-test-failure' | 'pre-existing-on-base' | 'unclassified';
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
      const cls = f['class'] as QeVerifiedCheck['class'] | undefined;
      checks.push({
        harness: f['harness'],
        cmd: f['cmd'] ?? '',
        exit: int(f['exit']),
        ...(cls !== undefined ? { class: cls } : {}),
      });
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
