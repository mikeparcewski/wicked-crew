// Wave 6 END TO END — the governed test-authoring journey through the daemon's own surfaces, nothing
// stubbed but the LLM (stub engine), the coding agent's hands (a deterministic Tool stand-in that
// writes the produced files — the deliver-e2e premise) and GitHub (a LOCAL bare origin + a stub `gh`):
//
//   1. GREEN: a fixture repo with a Playwright-SHAPED harness (a repo-local `node_modules/.bin/
//      playwright` shim standing in for `@playwright/test`, offline). The author stand-in writes
//      `e2e/launch.spec.mjs` + `tests/PLAN-launch.md`; the SHIPPED verify phase then RUNS the produced
//      e2e under the repository's harness (the shim prints `QE-E2E-RAN <file>` — the marker in the
//      unit's transcript), the review (stub evaluator) passes, and the ENGINE's deliver phase — never
//      a worker — pushes the run branch to the local origin and "opens" the PR through the stub gh;
//      the run wire reads `delivery: 'delivered'`; `GET /campaigns` carries the registered test set
//      (`verified: true`, the file, the harness, the plan, the PR URL); `GET /runs/:id/diff` still
//      answers after completion (`source` worktree or branch — the files view never goes dark).
//   2. RED (R4-r2's floor): the same flow with a produced spec that FAILS under the harness — the
//      verify unit fails the run, the deliver phase never runs (no branch on origin, `delivery:
//      'none'`), and the test set is registered `verified: false, failed: 1` (shown red, not hidden).
//   3. SHIPPED DEF via `POST /testing/author`: the stub agents write nothing, so the author's evidence
//      floor denies the run before any PR could exist — a run that produced no tests cannot deliver.
//
// NEVER touches GitHub or the operator's HOME (redirected to scratch; stub `gh` first on PATH via the
// scratch .bash_profile — the engine's tool spawns are `bash -lc`); the audit trail and the workflow
// overlay dir are redirected by the suite-wide setup; every push targets a file-backed bare repo.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { EVIDENCE_FLOOR_PIN } from '../../src/core/deliver.js';
import type { PhaseDef, WorkflowDef } from '../../src/core/types.js';
import {
  QE_AUTHOR_TESTS_WORKFLOW,
  QE_AUTHOR_TESTS_WORKFLOW_DEF,
  QE_VERIFY_PHASE_ID,
  QE_VERIFY_SUMMARY_MARKER,
} from '../../src/qe/author-workflow.js';
import type { TestSet } from '../../src/qe/test-sets.js';
import { removeScratch } from '../setup/scratch.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * The shipped def with the AUTHOR phase's hands replaced by a deterministic Tool that writes the
 * produced files (`spec` is the spec body; the PLAN always rides along) — everything else (recon,
 * the SHIPPED verify script, review, and the engine-appended deliver phase) is the real thing.
 * `role: 'neutral'` on the stand-in keeps the engine's creator-floor machinery out of a Tool unit
 * (the deliver-e2e idiom); `executes_code: true` keeps it a CODE-WORK def so the crew#393 default
 * delivers it. The evidence-floor pin stays: the floor re-derives that the tree changed.
 */
function standInDef(id: string, spec: string): WorkflowDef {
  const write = [
    'set -euo pipefail',
    'mkdir -p e2e tests',
    `cat > e2e/launch.spec.mjs <<'QE_E2E_SPEC'\n${spec}\nQE_E2E_SPEC`,
    "cat > tests/PLAN-launch.md <<'QE_E2E_PLAN'\n# PLAN — launch\n\n| id | file | command | result |\n|---|---|---|---|\n| LC-1 | e2e/launch.spec.mjs | node_modules/.bin/playwright test e2e/launch.spec.mjs | see verify |\nQE_E2E_PLAN",
    'echo "author stand-in: wrote e2e/launch.spec.mjs + tests/PLAN-launch.md"',
  ].join('\n');
  // `skill_ref` is stripped from EVERY phase of the stand-in: the stub engine has no skills root
  // (no `WICKED_SKILLS_SNAPSHOT`; an installed wicked-garden plugin is not a contained tree and is
  // refused as the fallback), and a run that names a skill is refused at dispatch — before verify
  // could ever run. Skill routing (recon/author/review through `wicked-garden-qe`) is pinned on the
  // SHIPPED def by tests/qe-author-workflow.test.ts; this e2e is about verify → review → deliver.
  // The REVIEW stand-in keeps the evaluator AGENT (a stub seat, council-routed, evaluator ≠ creator)
  // but drops its judge pin: the pinned floor convenes the layer-2 agent judge, and the stub engine
  // cannot render a `PASS`/`REJECT` verdict — the gate fails closed, `human_confirm_if` escalates to a
  // human, and an approve RE-RUNS the unit into the same escalation (the engine's designed semantics),
  // so a pinned review can never pass under the stub. The SHIPPED def keeps its pin (asserted in
  // tests/qe-author-workflow.test.ts); the verdict's content is an LLM matter no stub can produce.
  const phases: PhaseDef[] = QE_AUTHOR_TESTS_WORKFLOW_DEF.phases.map((p) => {
    if (p.id === 'author') {
      return {
        ...p,
        executor: { type: 'tool', cmd: ['bash', '-lc', write] },
        role: 'neutral',
        skill_ref: null,
        validator_pin: EVIDENCE_FLOOR_PIN,
      };
    }
    if (p.id === 'review') return { ...p, skill_ref: null, validator_pin: null };
    return { ...p, skill_ref: null };
  });
  // `instructions` ride only on agent phases; a Tool phase carries none.
  const withoutInstructions = (p: PhaseDef): PhaseDef =>
    Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'instructions')) as unknown as PhaseDef;
  return { id, phases: phases.map((p) => (p.id === 'author' ? withoutInstructions(p) : p)) };
}

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let origin: string;
let clone: string;
let baseUrl: string;
let repoId: string;
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function originBranches(): string[] {
  return git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function postJson(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Unit = { id: string; ord: number; status: string; denial_reason?: string | null; tool_cmd?: string[] | null };
function runOf(body: Record<string, unknown>): { session: Record<string, unknown>; units: Unit[] } {
  return body['run'] as { session: Record<string, unknown>; units: Unit[] };
}

/** Linux CI: keep scratch out of the temp dir the engine's validator sandbox masks (deliver-e2e). */
function scratchBase(): string {
  const runnerTemp = process.env['RUNNER_TEMP'];
  return process.platform === 'linux' && runnerTemp !== undefined && runnerTemp !== '' ? runnerTemp : tmpdir();
}

async function waitFor<T>(read: () => Promise<T | null>, label: string, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await read();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out (${ms}ms) waiting for: ${label}`);
}

async function waitForRun(runId: string, pred: (s: Record<string, unknown>) => boolean, label: string, ms = 120_000) {
  return waitFor(async () => {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    const run = runOf(body);
    if (pred(run.session)) return run;
    return null;
  }, label, ms).catch(async (err: unknown) => {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    const run = runOf(body);
    const rejected = run.units.filter((u) => u.status === 'rejected').map((u) => `${u.id}: ${String(u.denial_reason ?? '').slice(0, 400)}`);
    throw new Error(`${err instanceof Error ? err.message : String(err)} — status=${String(run.session['status'])} delivery=${String(run.session['delivery'])}; rejected: ${rejected.join(' | ')}`);
  });
}

async function unitOutput(runId: string, ord: number): Promise<string> {
  const { status, body } = await getJson(`/api/v1/runs/${runId}/units/${ord}/output`);
  if (status !== 200) return '';
  return String(body['output'] ?? '');
}

beforeAll(async () => {
  dir = mkdtempSync(join(scratchBase(), 'crew-qe-author-e2e-'));

  // ── Scratch HOME every tool spawn inherits: stub `gh` first on PATH ──
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  for (const rel of ['.aws', '.ssh', '.gnupg', '.claude', join('.config', 'wicked-council'), join('.config', 'gh')]) {
    mkdirSync(join(home, rel), { recursive: true });
  }
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  api) echo "tester";;',
      '  auth) echo "gh: switched account";;',
      '  pr) echo "${GH_STUB_OUT:-https://github.com/o/r/pull/7}";;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  for (const [k, v] of Object.entries({ HOME: home, GH_ACCOUNT: '', WICKED_CREW_AUDIT_LOG: join(dir, 'audit.log') })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  // ── The fixture repo: a Playwright-SHAPED harness whose runner is a committed, repo-local shim ──
  origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  clone = join(dir, 'workspace');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  mkdirSync(join(seed, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(seed, 'README.md'), '# qe-author e2e fixture\n');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'qe-fixture', private: true, devDependencies: { '@playwright/test': '1.0.0' } }, null, 2));
  writeFileSync(join(seed, 'playwright.config.mjs'), 'export default { testDir: "e2e" };\n');
  writeFileSync(
    join(seed, 'node_modules', '.bin', 'playwright'),
    ['#!/bin/sh', '# repo-local runner shim: "playwright test <spec>" → run the spec with node', 'if [ "$1" = "test" ]; then echo "QE-E2E-RAN $2"; node "$2"; exit $?; fi', 'echo "shim: unexpected $*" >&2; exit 2'].join('\n'),
  );
  chmodSync(join(seed, 'node_modules', '.bin', 'playwright'), 0o755);
  git(seed, 'add', '-A', '-f');
  git(seed, 'commit', '-qm', 'base: fixture with a Playwright-shaped harness');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');

  // ── The daemon in-process over the STUB engine, real HTTP surface ──
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const repo = await adapter.registerRepo('qe-author-e2e-ws', clone);
  repoId = repo.id;

  // The two stand-in variants, registered through the API (the engine validates them as authored).
  const green = await postJson('/api/v1/workflows', standInDef('qe-author-tests-e2e-green', 'console.log("launch spec ok");'));
  expect(green.status).toBe(201);
  const red = await postJson('/api/v1/workflows', standInDef('qe-author-tests-e2e-red', 'console.log("launch spec about to fail"); process.exit(1);'));
  expect(red.status).toBe(201);
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    adapter?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    removeScratch(dir);
  }
});

describe('wave 6 end to end — the governed test-authoring journey', () => {
  it('GREEN: verify RUNS the produced e2e under the repo harness, the ENGINE deliver phase opens the PR, the test set is registered, the diff survives completion', async () => {
    process.env['GH_STUB_OUT'] = 'https://github.com/o/r/pull/601';
    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: functional tests for the launch flow',
      clisJson: SEATS,
      workflow: 'qe-author-tests-e2e-green',
      repoRef: repoId,
      humanConfirm: 'none',
      // deliver DELIBERATELY OMITTED — a repo-scoped code-work def delivers by default (crew#393).
    });
    expect(launch.status).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    // The run completes AND the wire reports the delivery (the post-terminal resolution is async, so
    // wait for the delivery field itself — status alone is not the finish line).
    const run = await waitForRun(runId, (s) => s['delivery'] === 'delivered', 'delivery:delivered on the run wire', 480_000);
    expect(run.session['status']).toBe('completed');
    expect(run.session['deliverUrl']).toBe('https://github.com/o/r/pull/601');
    const unitIds = run.units.sort((a, b) => a.ord - b.ord).map((u) => u.id.slice(u.id.indexOf(':') + 1));
    expect(unitIds).toEqual(['recon', 'author', QE_VERIFY_PHASE_ID, 'review', 'deliver']);
    expect(run.units.every((u) => u.status === 'done')).toBe(true);

    // (1) The VERIFY phase RAN the produced e2e under the repository's own harness — the marker the
    //     shim prints is in the verify unit's transcript, and the summary counts it (R4-r2 / F-7R2-015).
    const verify = run.units.find((u) => u.id.endsWith(`:${QE_VERIFY_PHASE_ID}`))!;
    const verifyOut = await unitOutput(runId, verify.ord);
    expect(verifyOut).toContain('QE-E2E-RAN e2e/launch.spec.mjs');
    expect(verifyOut).toContain('launch spec ok');
    expect(verifyOut).toContain(`${QE_VERIFY_SUMMARY_MARKER} produced=1 executed=1 passed=1 failed=0 not_executed=0 plan=tests/PLAN-launch.md`);
    expect(verifyOut).toContain('qe-verify: PASS');

    // (2) The DELIVER phase — not the worker — opened the PR: the author unit is a file-writing tool
    //     with no gh in its command, the deliver unit's transcript ends in the PR URL, and the
    //     delivery record (which only the engine's deliver phase can produce) is on the wire.
    const author = run.units.find((u) => u.id.endsWith(':author'))!;
    expect((author.tool_cmd ?? []).join(' ')).not.toContain('gh ');
    expect(await unitOutput(runId, author.ord)).not.toContain('pull/601');
    const deliver = run.units.find((u) => u.id.endsWith(':deliver'))!;
    expect((deliver.tool_cmd ?? []).join(' ')).toContain('gh pr create');
    expect((await unitOutput(runId, deliver.ord)).trim().endsWith('https://github.com/o/r/pull/601')).toBe(true);
    // …and the delivery is REAL on the local origin: the run branch carries the produced files.
    expect(originBranches()).toContain(`wicked/${runId}`);
    const files = git(origin, 'show', '--name-only', '--format=', `wicked/${runId}`).trim().split('\n');
    expect(files).toContain('e2e/launch.spec.mjs');
    expect(files).toContain('tests/PLAN-launch.md');

    // (3) The TEST SET is registered on the campaigns surface (F-7R2-014) — the Test landing's data.
    const set = await waitFor(async () => {
      const { body } = await getJson('/api/v1/campaigns');
      const sets = (body['test_sets'] as TestSet[] | undefined) ?? [];
      return sets.find((s) => s.run_id === runId) ?? null;
    }, 'the registered test set on GET /campaigns', 120_000);
    expect(set).toMatchObject({
      id: `testset-${runId}`,
      workflow_id: QE_AUTHOR_TESTS_WORKFLOW,
      repo_ref: repoId,
      repo_name: 'qe-author-e2e-ws',
      run_status: 'completed',
      verify_status: 'done',
      verified: true,
      produced: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      not_executed: 0,
      plan: 'tests/PLAN-launch.md',
      harnesses: ['playwright'],
      deliverUrl: 'https://github.com/o/r/pull/601',
    });
    expect(set.files).toEqual([{ path: 'e2e/launch.spec.mjs', harness: 'playwright', status: 'passed' }]);

    // (4) The run page keeps its files view after completion (F-7R2-013): worktree or branch, the
    //     diff answers 200 and names the produced files.
    const diff = await getJson(`/api/v1/runs/${runId}/diff?base=merge-base`);
    expect(diff.status).toBe(200);
    expect(['worktree', 'branch']).toContain(diff.body['source']);
    expect(String(diff.body['diff'])).toContain('launch.spec.mjs');
  }, 540_000);

  it('RED (R4-r2 floor): a produced e2e that FAILS under the harness fails the run — no PR, no branch, a red test set', async () => {
    process.env['GH_STUB_OUT'] = 'https://github.com/o/r/pull/602';
    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: tests that do not pass must not ship',
      clisJson: SEATS,
      workflow: 'qe-author-tests-e2e-red',
      repoRef: repoId,
      humanConfirm: 'none',
    });
    expect(launch.status).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    const run = await waitForRun(runId, (s) => TERMINAL.has(String(s['status'])), 'terminal status', 480_000);
    expect(run.session['status']).toBe('failed');
    expect(run.session['delivery']).toBe('none');
    const verify = run.units.find((u) => u.id.endsWith(`:${QE_VERIFY_PHASE_ID}`))!;
    expect(verify.status).toBe('rejected');
    expect(String(verify.denial_reason ?? '')).toMatch(/failed under the repository harness|QE-VERIFY|status=failed|exit/);
    // The deliver phase never ran: nothing reached the origin, no PR-equivalent exists anywhere.
    expect(run.units.find((u) => u.id.endsWith(':deliver'))?.status).not.toBe('done');
    expect(originBranches()).not.toContain(`wicked/${runId}`);

    const set = await waitFor(async () => {
      const { body } = await getJson('/api/v1/campaigns');
      return ((body['test_sets'] as TestSet[] | undefined) ?? []).find((s) => s.run_id === runId) ?? null;
    }, 'the red test set on GET /campaigns', 120_000);
    expect(set).toMatchObject({ verified: false, run_status: 'failed', verify_status: 'rejected' });
    expect('deliverUrl' in set).toBe(false);
  }, 540_000);

  it('SHIPPED DEF via POST /testing/author: a run whose author produced nothing cannot pass its floor — and never delivers', async () => {
    process.env['GH_STUB_OUT'] = 'https://github.com/o/r/pull/603';
    const launch = await postJson('/api/v1/testing/author', {
      problem: 'e2e: functional tests for the launch flow',
      repoRefs: [repoId],
      ungated: true,
    });
    expect(launch.status).toBe(201);
    expect(launch.body['workflow']).toBe(QE_AUTHOR_TESTS_WORKFLOW);
    const runId = (launch.body as { runId: string }).runId;
    // The catalog serves the def the launch used, and the run's units are the def's phases + deliver.
    const wf = await getJson(`/api/v1/workflows/${QE_AUTHOR_TESTS_WORKFLOW}`);
    expect(wf.status).toBe(200);

    const run = await waitForRun(runId, (s) => TERMINAL.has(String(s['status'])), 'terminal status', 480_000);
    expect(run.session['status']).toBe('failed');
    expect(run.session['delivery']).toBe('none');
    // Nothing was produced, so nothing ships: under the stub engine the run is refused at the first
    // skill-routed unit when no skills root is available (this rig has none), and otherwise at the
    // author's evidence floor / verify's `produced=0` refusal — every one of those is a rejection
    // BEFORE the deliver phase, which therefore never ran. The units the def planned are the def's.
    const planned = run.units.sort((a, b) => a.ord - b.ord).map((u) => u.id.slice(u.id.indexOf(':') + 1));
    expect(planned.slice(0, 4)).toEqual(['recon', 'author', QE_VERIFY_PHASE_ID, 'review']);
    expect(run.units.some((u) => u.status === 'rejected')).toBe(true);
    expect(run.units.find((u) => u.id.endsWith(':deliver'))?.status).not.toBe('done');
    expect(originBranches()).not.toContain(`wicked/${runId}`);
    // …and it is filed under its repo's label group from launch (F-7R2-014).
    const { body } = await getJson('/api/v1/campaigns');
    const groups = body['groups'] as Array<{ label: string; runs: Array<{ runId: string }> }>;
    expect(groups.find((g) => g.label === 'qe-tests-qe-author-e2e-ws')?.runs.some((r) => r.runId === runId)).toBe(true);
    expect(existsSync(join(dir, 'audit.log'))).toBe(true);
  }, 540_000);
});
