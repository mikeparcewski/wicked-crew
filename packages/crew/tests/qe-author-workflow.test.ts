// Wave 6 — the governed test-authoring workflow `qe-author-tests` (F-7R2-003/004/005/012/014/015,
// acceptance R4-r2): the def as DATA, the engine's validation of it AS AUTHORED (wicked-core#414),
// and the verify phase's script driven for REAL against temp git repos — the R4-r2 floor is "a
// produced test that fails, or was never run, FAILS the unit", and that is asserted here by
// running the very script the phase ships, not by reading its text.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BUILTIN_WORKFLOWS, CoreAdapter } from '../src/core/adapter.js';
import { DELIVER_PHASE_ID, EVIDENCE_FLOOR_PIN } from '../src/core/deliver.js';
import type { WorkflowDef } from '../src/core/types.js';
import {
  QE_AUTHOR_TESTS_WORKFLOW,
  QE_AUTHOR_TESTS_WORKFLOW_DEF,
  QE_MAX_INLINE_INSTRUCTION_BYTES,
  QE_SKILL,
  QE_VERIFY_MARKER,
  QE_VERIFY_PHASE_ID,
  QE_VERIFY_SUMMARY_MARKER,
  parseQeVerifyOutput,
  qeAuthorPlan,
  qeVerifyScript,
} from '../src/qe/author-workflow.js';
import { buildTestSet, qeTestsGroupLabel } from '../src/qe/test-sets.js';
import type { SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const def = QE_AUTHOR_TESTS_WORKFLOW_DEF;
const phase = (id: string) => {
  const p = def.phases.find((x) => x.id === id);
  if (!p) throw new Error(`phase ${id} missing`);
  return p;
};

describe('qe-author-tests — the def as data', () => {
  it('is served from BUILTIN_WORKFLOWS as an operator-selectable work mode (F-075: the catalog carries a test/QE workflow)', () => {
    const served = BUILTIN_WORKFLOWS.find((w) => w.id === QE_AUTHOR_TESTS_WORKFLOW);
    expect(served).toBe(def);
    expect(served?.is_system).toBeUndefined();
  });

  it('runs recon → author → verify → review as a dependent chain, and NEVER carries a deliver phase of its own', () => {
    expect(def.phases.map((p) => p.id)).toEqual(['recon', 'author', QE_VERIFY_PHASE_ID, 'review']);
    expect(phase('recon').depends_on).toEqual([]);
    expect(phase('author').depends_on).toEqual(['recon']);
    expect(phase(QE_VERIFY_PHASE_ID).depends_on).toEqual(['author']);
    expect(phase('review').depends_on).toEqual([QE_VERIFY_PHASE_ID]);
    // The ENGINE appends the deliver phase per run (`deliver: "pr"`); a def-carried one would make
    // `composeDeliverWorkflow` refuse and would put delivery on the def's own terms (F-7R2-004/012).
    expect(def.phases.some((p) => p.id === DELIVER_PHASE_ID)).toBe(false);
  });

  it('is evaluator ≠ creator: author creates (code-writing, floor-pinned), review evaluates (read-only, pinned, escalates a not-pass to a human)', () => {
    const author = phase('author');
    expect(author.role).toBe('creator');
    expect(author.executes_code).toBe(true);
    expect(author.validator_pin).toBe(EVIDENCE_FLOOR_PIN);
    expect(author.kind).toBe('build');
    const review = phase('review');
    expect(review.role).toBe('evaluator');
    expect(review.executes_code).toBe(false);
    expect(review.validator_pin).toBe(EVIDENCE_FLOOR_PIN);
    expect(review.gate).toEqual({ human_confirm_if: 'verdict_not_pass' });
    expect(phase('recon').role).toBe('neutral');
    expect(phase('recon').executes_code).toBe(false);
  });

  it('verify is a deterministic TOOL phase — verified_evidence, floor-pinned, executes_code:false (a Tool unit is never worktree-guarded)', () => {
    const verify = phase(QE_VERIFY_PHASE_ID);
    expect(verify.executor).toEqual({ type: 'tool', cmd: ['bash', '-lc', qeVerifyScript()] });
    expect(verify.kind).toBe('test');
    expect(verify.role).toBe('neutral');
    expect(verify.verified_evidence).toBe(true);
    expect(verify.validator_pin).toBe(EVIDENCE_FLOOR_PIN);
    expect(verify.executes_code).toBe(false);
    expect(verify.skill_ref).toBeNull();
    expect(verify.gate).toBe('auto');
  });

  it('routes every agent phase through the garden QE skill, naming its action, with a short single-line orientation (the PTY line is 1022 bytes)', () => {
    const actions: Record<string, string> = { recon: 'plan action', author: 'author action', review: 'review action' };
    for (const [id, action] of Object.entries(actions)) {
      const p = phase(id);
      expect(p.skill_ref, `${id} must route through ${QE_SKILL}`).toBe(QE_SKILL);
      const instr = p.instructions ?? '';
      expect(instr).toContain(action);
      expect(instr.includes('\n'), `${id} instruction must be single-line`).toBe(false);
      expect(Buffer.byteLength(instr, 'utf8')).toBeLessThan(QE_MAX_INLINE_INSTRUCTION_BYTES);
    }
    // The author is told — in the skill's own words — that delivery is not its job (F-7R2-012).
    expect(phase('author').instructions).toMatch(/never push/i);
    expect(phase('author').instructions).toMatch(/deliver phase/);
    // …and to RUN what it wrote before claiming it (R4-r2 / F-7R2-015).
    expect(phase('author').instructions).toMatch(/RUN every test/);
  });

  it('honours the wicked-core#414 rule as authored: a code-writing agent phase carries a pin or a human gate; a verified_evidence phase carries a pin', () => {
    for (const p of def.phases) {
      const humanGate = typeof p.gate === 'object' && p.gate !== null;
      if (p.executes_code && p.executor?.type !== 'tool') {
        expect(p.validator_pin !== null || humanGate, `${p.id}: executes_code needs a pin or a human gate`).toBe(true);
      }
      if (p.verified_evidence) expect(p.validator_pin, `${p.id}: verified_evidence needs a pin`).not.toBeNull();
    }
  });
});

describe('qe-author-tests — the ENGINE validates the def as authored', () => {
  let dir: string;
  let adapter: CoreAdapter;
  type Register = (json: string) => Promise<string>;
  const register = (d: WorkflowDef): Promise<string> => {
    const core = (adapter as unknown as { core: Record<string, unknown> }).core;
    const fn = core['registerWorkflow'];
    if (typeof fn !== 'function') throw new Error('the installed wicked-core-ts has no registerWorkflow binding');
    return (fn as Register).call(core, JSON.stringify(d));
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'qe-author-def-'));
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  });
  afterAll(() => {
    adapter.close();
    removeScratch(dir);
  });

  it('the shipped def registers — the core validator accepts the pins it carries', async () => {
    await expect(register({ ...def, id: 'qe-author-tests-probe' })).resolves.toBeDefined();
  });

  it('the same def with the author pin removed is REFUSED (the validator has teeth — a def that dropped its floor could never ship)', async () => {
    const unpinned: WorkflowDef = {
      id: 'qe-author-tests-unpinned',
      phases: def.phases.map((p) => (p.id === 'author' ? { ...p, validator_pin: null } : p)),
    };
    await expect(register(unpinned)).rejects.toThrow();
  });
});

// ── The verify script, driven for real ─────────────────────────────────────────────────────────

const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0 && process.platform !== 'win32';
/** Each verify case spawns a login bash + git + the harness shim: generous under a loaded host. */
const VERIFY_TEST_TIMEOUT_MS = 60_000;

/** A repo with a Playwright-SHAPED harness whose runner is a repo-local shim (offline: `npx` is
 *  never reached because `node_modules/.bin/playwright` exists — exactly the repo's-own-harness
 *  path the script prefers). The shim prints `QE-E2E-RAN <file>` and runs the spec with node. */
function harnessRepo(root: string): void {
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(join(root, 'e2e'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, devDependencies: { '@playwright/test': '1.0.0' } }));
  writeFileSync(join(root, 'playwright.config.mjs'), 'export default {};\n');
  // The shim prints Playwright's own summary line (`N passed (…)`) — the script counts tests from
  // the RUNNER's summary, so a runner that reports nothing reads as not executed (review H-1).
  writeFileSync(
    join(root, 'node_modules', '.bin', 'playwright'),
    ['#!/bin/sh', 'if [ "$1" = "test" ]; then echo "QE-E2E-RAN $2"; node "$2"; rc=$?; [ $rc -eq 0 ] && echo "  1 passed (0.1s)" || echo "  1 failed"; exit $rc; fi', 'echo "shim: unexpected $*" >&2; exit 2'].join('\n'),
  );
  chmodSync(join(root, 'node_modules', '.bin', 'playwright'), 0o755);
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // The run branch, as the engine mints it — the produced files below are the run's UNCOMMITTED work.
  git('checkout', '-q', '-b', 'wicked/run-verify');
}

function runVerify(cwd: string): { status: number; out: string } {
  const r = spawnSync('bash', ['-lc', qeVerifyScript()], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd } });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!bashAvailable)('the verify phase RUNS the produced tests under the repository harness (R4-r2)', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'qe-verify-'));
  }, VERIFY_TEST_TIMEOUT_MS);
  afterAll(() => removeScratch(base));

  it('PASS: a produced e2e spec + PLAN → the spec is EXECUTED by the repo harness (marker in output), counted, and the phase exits 0', () => {
    const root = join(base, 'pass');
    mkdirSync(root);
    harnessRepo(root);
    writeFileSync(join(root, 'e2e', 'launch.spec.mjs'), 'console.log("launch spec ok");\n');
    writeFileSync(join(root, 'tests', 'PLAN-launch.md'), '# plan\n| LC-1 | e2e/launch.spec.mjs | node_modules/.bin/playwright test e2e/launch.spec.mjs | passed |\n');
    const { status, out } = runVerify(root);
    expect(out).toContain('QE-E2E-RAN e2e/launch.spec.mjs'); // the repo harness actually ran the file
    expect(out).toContain(`${QE_VERIFY_MARKER} file=e2e/launch.spec.mjs harness=playwright`);
    expect(out).toMatch(/status=passed/);
    expect(out).toContain(`${QE_VERIFY_SUMMARY_MARKER} produced=1 executed=1 passed=1 failed=0 not_executed=0 plan=tests/PLAN-launch.md`);
    expect(out).toContain('qe-verify: PASS');
    expect(status).toBe(0);
    const report = parseQeVerifyOutput(out);
    expect(report).not.toBeNull();
    expect(report!.files).toEqual([{ path: 'e2e/launch.spec.mjs', harness: 'playwright', cmd: './node_modules/.bin/playwright test e2e/launch.spec.mjs', exit: 0, tests: 1, pkg: '.', status: 'passed' }]);
    expect(report!.plan).toBe('tests/PLAN-launch.md');
  }, VERIFY_TEST_TIMEOUT_MS);

  it('H-1: a pytest-style module in a repo WITHOUT pytest is NOT run as a plain script — "harness not available: pytest", the phase FAILS', () => {
    const root = join(base, 'pyplain');
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "fixture"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    writeFileSync(join(root, 'README.md'), '# py\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'wicked/run-verify');
    // The R4-r2 shape: a module whose functions DEFINE assertions — run as `python3 file.py` it
    // defines them and exits 0 with zero assertions executed (the review's reproduction).
    writeFileSync(join(root, 'tests', 'test_math.py'), 'def test_add():\n    assert 1 + 1 == 3\n');
    writeFileSync(join(root, 'tests', 'PLAN-math.md'), '# plan\n');
    // A python3 on PATH that has NO pytest (the host's real python3 may), so the runner lookup fails.
    // The shim rides in a scratch HOME's .bash_profile: the engine runs Tool phases under `bash -l`,
    // and macOS path_helper re-orders a PATH handed in through env (system dirs first).
    const home = join(base, 'pyplain-home');
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'python3'),
      ['#!/bin/sh', 'case "$*" in *pytest*) echo "ModuleNotFoundError: No module named pytest" >&2; exit 1;; esac', 'echo "plain python3 ran $*"; exit 0'].join('\n'),
    );
    chmodSync(join(bin, 'python3'), 0o755);
    writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
    const r = spawnSync('bash', ['-lc', qeVerifyScript()], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home } });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).not.toContain('plain python3 ran'); // NEVER run as a script
    expect(out).toMatch(/file=tests\/test_math\.py harness=pytest pkg=\. .*status=not-executed reason="harness not available: pytest/);
    expect(out).toContain('not_executed=1');
    expect(out).toContain('qe-verify: FAIL');
    expect(r.status).not.toBe(0);
    const report = parseQeVerifyOutput(out)!;
    expect(report.files[0]).toMatchObject({ harness: 'pytest', status: 'not-executed', exit: null, tests: 0 });
    expect(report.files[0]!.reason).toMatch(/harness not available: pytest/);
  }, VERIFY_TEST_TIMEOUT_MS);

  it('M-1: a monorepo declares the harness in the PACKAGE that owns the test — detected per file, runner + full-suite check run from that package dir', () => {
    const root = join(base, 'monorepo');
    mkdirSync(join(root, 'packages', 'app', 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(root, 'packages', 'app', 'tests'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] })); // NO vitest at the root
    writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app', private: true, devDependencies: { vitest: '^3.0.0' } }));
    writeFileSync(
      join(root, 'packages', 'app', 'node_modules', '.bin', 'vitest'),
      ['#!/bin/sh', 'echo "QE-VITEST-RAN cwd=$(basename "$PWD") args=$*"', 'echo " Test Files  1 passed (1)"', 'echo "      Tests  2 passed (2)"', 'exit 0'].join('\n'),
    );
    chmodSync(join(root, 'packages', 'app', 'node_modules', '.bin', 'vitest'), 0o755);
    writeFileSync(join(root, 'README.md'), '# mono\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('add', '-A', '-f');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'wicked/run-verify');
    writeFileSync(join(root, 'packages', 'app', 'tests', 'sum.test.ts'), 'import { it, expect } from "vitest"; it("adds", () => expect(1 + 1).toBe(2));\n');
    writeFileSync(join(root, 'tests', 'PLAN-sum.md'), '# plan\n');
    const { status, out } = runVerify(root);
    // Resolved in the package, run FROM it with a package-relative path.
    expect(out).toContain('QE-VITEST-RAN cwd=app args=run tests/sum.test.ts');
    expect(out).toMatch(/file=packages\/app\/tests\/sum\.test\.ts harness=vitest pkg=packages\/app .*exit=0 tests=2 status=passed/);
    // The repository's own check ran once for (vitest, packages/app).
    expect(out).toMatch(/^QE-VITEST-RAN cwd=app args=run$/m);
    expect(out).toMatch(/QE-VERIFY-CHECK: harness=vitest pkg=packages\/app .*exit=0/);
    expect(out).toContain('produced=1 executed=1 passed=1 failed=0 not_executed=0');
    expect(status).toBe(0);
    expect(parseQeVerifyOutput(out)!.files[0]).toMatchObject({ pkg: 'packages/app', tests: 2 });
  }, VERIFY_TEST_TIMEOUT_MS);

  it('a runner that exits 0 but reports 0 tests is NOT EXECUTED (nothing was collected), and a declared-but-uninstalled harness is "not available" — never npx', () => {
    const root = join(base, 'zero-and-missing');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'z', private: true, devDependencies: { vitest: '^3.0.0' } }));
    writeFileSync(join(root, 'node_modules', '.bin', 'vitest'), ['#!/bin/sh', 'echo "      Tests  0 passed (0)"', 'exit 0'].join('\n'));
    chmodSync(join(root, 'node_modules', '.bin', 'vitest'), 0o755);
    writeFileSync(join(root, 'README.md'), '# z\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('add', '-A', '-f');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'wicked/run-verify');
    writeFileSync(join(root, 'tests', 'empty.test.ts'), '// no tests in here\n');
    writeFileSync(join(root, 'tests', 'PLAN-empty.md'), '# plan\n');
    const zero = runVerify(root);
    expect(zero.out).toMatch(/file=tests\/empty\.test\.ts harness=vitest pkg=\. .*exit=0 tests=0 status=not-executed/);
    expect(zero.out).toContain('reported 0 tests');
    expect(zero.status).not.toBe(0);
    // Now the declared runner is not installed: no node_modules/.bin/vitest anywhere → not available, no npx.
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    const missing = runVerify(root);
    expect(missing.out).toMatch(/status=not-executed reason="harness not available: vitest/);
    expect(missing.out).toContain('never runs npx');
    expect(missing.out).not.toContain('npx vitest');
    expect(missing.status).not.toBe(0);
  }, VERIFY_TEST_TIMEOUT_MS);

  it('FAIL: a produced spec that fails under the harness fails the phase — and says which file', () => {
    const root = join(base, 'fail');
    mkdirSync(root);
    harnessRepo(root);
    writeFileSync(join(root, 'e2e', 'broken.spec.mjs'), 'console.log("about to fail"); process.exit(1);\n');
    writeFileSync(join(root, 'tests', 'PLAN-broken.md'), '# plan\n');
    const { status, out } = runVerify(root);
    expect(out).toContain('QE-E2E-RAN e2e/broken.spec.mjs');
    expect(out).toMatch(/file=e2e\/broken\.spec\.mjs harness=playwright .*exit=1 tests=1 status=failed/);
    expect(out).toContain('qe-verify: FAIL — 1 of 1 produced test file(s) failed');
    expect(status).not.toBe(0);
    expect(parseQeVerifyOutput(out)?.failed).toBe(1);
  }, VERIFY_TEST_TIMEOUT_MS);

  it('FAIL: the author produced NO test files (the b86c14c1 shape — prose and a plan, nothing runnable)', () => {
    const root = join(base, 'none');
    mkdirSync(root);
    harnessRepo(root);
    writeFileSync(join(root, 'tests', 'PLAN-empty.md'), '# plan with no tests\n');
    const { status, out } = runVerify(root);
    expect(out).toContain(`${QE_VERIFY_SUMMARY_MARKER} produced=0 executed=0`);
    expect(out).toContain('produced no test files');
    expect(status).not.toBe(0);
  }, VERIFY_TEST_TIMEOUT_MS);

  it('FAIL: a produced test with no PLAN under tests/ — the plan is part of the deliverable', () => {
    const root = join(base, 'noplan');
    mkdirSync(root);
    harnessRepo(root);
    writeFileSync(join(root, 'e2e', 'ok.spec.mjs'), 'console.log("ok");\n');
    const { status, out } = runVerify(root);
    expect(out).toContain('plan=missing');
    expect(out).toContain('no tests/PLAN-*.md was produced');
    expect(status).not.toBe(0);
  }, VERIFY_TEST_TIMEOUT_MS);

  it('FAIL: a produced test no recognised harness can run counts as NEVER EXECUTED — a test that never ran proves nothing (F-7R2-015)', () => {
    const root = join(base, 'unknown');
    mkdirSync(join(root, 'tests'), { recursive: true });
    // A repo with NO harness at all: no playwright config, no vitest/jest in package.json, no pytest.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bare', private: true }));
    writeFileSync(join(root, 'README.md'), '# bare\n');
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'wicked/run-verify');
    // `.test.js` with neither vitest nor jest in package.json and no Playwright config — nothing claims it.
    writeFileSync(join(root, 'tests', 'orphan.test.js'), 'console.log("nobody runs me");\n');
    writeFileSync(join(root, 'tests', 'PLAN-orphan.md'), '# plan\n');
    const { status, out } = runVerify(root);
    expect(out).toMatch(/file=tests\/orphan\.test\.js harness=unknown .*status=not-executed/);
    expect(out).toContain('not_executed=1');
    expect(out).toContain('were never executed');
    expect(status).not.toBe(0);
    expect(parseQeVerifyOutput(out)?.notExecuted).toBe(1);
  }, VERIFY_TEST_TIMEOUT_MS);

  it('fixtures, factories and the PLAN are produced but not "tests": only conventional test shapes are executed', () => {
    const root = join(base, 'fixture-only');
    mkdirSync(root);
    harnessRepo(root);
    writeFileSync(join(root, 'e2e', 'uxfix_fixture.py'), 'print("a fixture, not a test")\n');
    writeFileSync(join(root, 'tests', 'factories.mjs'), 'export const make = () => 1;\n');
    writeFileSync(join(root, 'e2e', 'flow.spec.mjs'), 'console.log("flow ok");\n');
    writeFileSync(join(root, 'tests', 'PLAN-flow.md'), '# plan\n');
    const { status, out } = runVerify(root);
    expect(out).toContain('produced=1 executed=1 passed=1');
    expect(out).not.toContain('uxfix_fixture.py harness=');
    expect(status).toBe(0);
  }, VERIFY_TEST_TIMEOUT_MS);
});

describe('parseQeVerifyOutput', () => {
  it('returns null without a summary line (the phase never reached its verdict)', () => {
    expect(parseQeVerifyOutput('QE-VERIFY-BEGIN worktree=/x\nsomething crashed')).toBeNull();
  });
  it('reads files, checks and the summary; a not-executed file has a null exit', () => {
    const out = [
      'QE-VERIFY: file=tests/a.test.ts harness=vitest cmd="node_modules/.bin/vitest run tests/a.test.ts" exit=0 status=passed',
      'QE-VERIFY: file=tests/b.test.js harness=unknown cmd="" exit=- status=not-executed',
      'QE-VERIFY-CHECK: harness=vitest cmd="node_modules/.bin/vitest run" exit=0',
      'QE-VERIFY-CHECK: harness=playwright skipped=full-suite (produced files ran individually)',
      'QE-VERIFY-SUMMARY: produced=2 executed=1 passed=1 failed=0 not_executed=1 plan=tests/PLAN-x.md checks=1 checks_failed=0',
    ].join('\n');
    const r = parseQeVerifyOutput(out)!;
    expect(r.files.map((f) => [f.path, f.status, f.exit])).toEqual([
      ['tests/a.test.ts', 'passed', 0],
      ['tests/b.test.js', 'not-executed', null],
    ]);
    expect(r.checks).toEqual([{ harness: 'vitest', cmd: 'node_modules/.bin/vitest run', exit: 0 }]);
    expect(r).toMatchObject({ produced: 2, executed: 1, passed: 1, failed: 0, notExecuted: 1, plan: 'tests/PLAN-x.md', checksFailed: 0 });
  });
});

describe('the intake plan + the registered test set', () => {
  it('qeAuthorPlan lists the def phases with kind/role/executor/skill/gate and the ENGINE deliver phase last (F-7R2-008)', () => {
    const plan = qeAuthorPlan(def, ['claude', 'codex'], true);
    expect(plan.workflow).toBe(QE_AUTHOR_TESTS_WORKFLOW);
    expect(plan.seats).toEqual(['claude', 'codex']);
    expect(plan.phases.map((p) => p.id)).toEqual(['recon', 'author', 'verify', 'review', 'deliver']);
    expect(plan.phases[1]).toEqual({ id: 'author', kind: 'build', role: 'creator', executor: 'agent', skillRef: QE_SKILL, gate: 'auto', executesCode: true });
    expect(plan.phases[2]).toMatchObject({ executor: 'tool', skillRef: null });
    expect(plan.phases[3]).toMatchObject({ role: 'evaluator', gate: 'human_if_not_pass' });
    expect(plan.phases[4]).toMatchObject({ id: 'deliver', executor: 'tool', engine: true });
    expect(qeAuthorPlan(def, [], false).phases.map((p) => p.id)).not.toContain('deliver');
  });

  const view = (verifyStatus: string): SessionView =>
    ({
      session: { id: 'run-1', workflow_id: QE_AUTHOR_TESTS_WORKFLOW, status: 'completed', repo_ref: 'repo-1' },
      units: [
        { id: 'run-1:recon', ord: 1, status: 'done' },
        { id: 'run-1:author', ord: 2, status: 'done' },
        { id: 'run-1:verify', ord: 3, status: verifyStatus },
        { id: 'run-1:review', ord: 4, status: 'done' },
      ],
    }) as unknown as SessionView;

  it('buildTestSet is verified ONLY for a clean verify verdict; a failed or absent report registers red, never hidden', () => {
    const clean = parseQeVerifyOutput(
      'QE-VERIFY: file=e2e/a.spec.ts harness=playwright cmd="x" exit=0 status=passed\nQE-VERIFY-SUMMARY: produced=1 executed=1 passed=1 failed=0 not_executed=0 plan=tests/PLAN-a.md checks=0 checks_failed=0',
    );
    const ok = buildTestSet(view('done'), clean, { registeredAt: 5, label: 'qe-tests-r', repoName: 'r', deliverUrl: 'https://x/pull/1' });
    expect(ok).toMatchObject({ id: 'testset-run-1', run_id: 'run-1', verified: true, produced: 1, passed: 1, plan: 'tests/PLAN-a.md', harnesses: ['playwright'], deliverUrl: 'https://x/pull/1', label: 'qe-tests-r', repo_name: 'r', verify_status: 'done' });
    const red = parseQeVerifyOutput('QE-VERIFY: file=e2e/a.spec.ts harness=playwright cmd="x" exit=1 status=failed\nQE-VERIFY-SUMMARY: produced=1 executed=1 passed=0 failed=1 not_executed=0 plan=tests/PLAN-a.md checks=0 checks_failed=0');
    expect(buildTestSet(view('rejected'), red, { registeredAt: 5 })).toMatchObject({ verified: false, failed: 1, verify_status: 'rejected' });
    expect(buildTestSet(view('rejected'), null, { registeredAt: 5 })).toMatchObject({ verified: false, produced: 0, plan: null, files: [] });
  });

  it('qeTestsGroupLabel is one group per repo, SAFE_ID-shaped', () => {
    expect(qeTestsGroupLabel('wicked-studio')).toBe('qe-tests-wicked-studio');
    expect(qeTestsGroupLabel('my repo/with spaces')).toBe('qe-tests-my-repo-with-spaces');
    expect(qeTestsGroupLabel(null)).toBe('qe-tests');
  });
});
