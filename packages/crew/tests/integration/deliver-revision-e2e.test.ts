// DES-L9 §7 END TO END — a run that REVISES an open pull request, through the REAL daemon and REAL
// engine (stub LLM), with a LOCAL bare origin standing in for GitHub and a stub `gh`. This is the
// real-engine half the route-level `deliver-refusal-gate.test.ts` could only mark `it.todo`; it
// needs core-ts ≥ 0.7.27 under crew (`LaunchSpec.base_ref` + the deliver-refusal arm), which the
// row-6.9 pin brings in.
//
// The flow (nothing stubbed but the model and GitHub), DES-L9 §7:
//   1. origin carries a PR-shaped branch `wicked/prior-run` (one commit on top of main) — the head
//      of the pull request the run revises. `POST /runs {revisesPr: N}` resolves it via the stub
//      `gh pr view` and the engine bases the run worktree on `origin/wicked/prior-run`
//      (`base_commit` on the wire == the PR head).
//   2. `humanConfirm` is OMITTED and `GH_ACCOUNT` ≠ the stub gh login, so at the deliver gate the
//      operator approves, the deliver script reads the identity FIRST and REFUSES (D-18), and the
//      engine's deterministic arm PARKS the run at `awaitingHuman{gateKind:"escalation"}` — no
//      `sessionFailed`, the worktree kept.
//   3. Fix the daemon's gh login (set GH_ACCOUNT to the stub's login) and approve the escalation
//      gate: the phase re-runs, pushes the run's one commit onto `refs/heads/wicked/prior-run`
//      (no new PR), comments the run record, and the run completes. The PR branch gained exactly
//      one commit; no `wicked/<run>` branch appears on origin.
//
// NEVER touches GitHub or the operator's HOME (scratch HOME with a stub `gh`, redirected audit log,
// file-backed bare origin) — the same discipline as deliver-conflict-strand-e2e.test.ts.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';
import { baseSkillOff } from '../setup/base-skill-off.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

const PR_NUM = 273;
const PR_BRANCH = 'wicked/prior-run';
const PR_URL = 'https://github.com/o/r/pull/273';
const STUB_LOGIN = 'release-bot';

/** A one-phase code-work Tool def whose phase writes a NEW file — the run's one commit on top of the
 *  revised PR head. `executes_code: true` makes it a code-work def so the crew#393 deliver default
 *  engages (`deliver: 'pr'`), which `revisesPr` requires; the deliver phase is appended by that
 *  default, not spelled here. */
const WORK_WORKFLOW = {
  id: 'deliver-revision-e2e-work',
  phases: [
    {
      id: 'work',
      kind: 'build',
      executor: { type: 'tool', cmd: ['bash', '-lc', 'printf "the revision\\n" > revised.txt'] },
      gate_type: null,
      gate: 'auto',
      executes_code: true,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: [],
      role: 'neutral',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
} as const;

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let origin: string;
let clone: string;
let seed: string;
let baseUrl: string;
let prHead: string;
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}
function originBranches(): string[] {
  return git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}
async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function postJson(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
function sessionOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body['run'] as { session: Record<string, unknown> }).session;
}
function unitsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return ((body['run'] as { units?: Array<Record<string, unknown>> }).units ?? []);
}

// Same rationale as deliver-conflict-strand-e2e.test.ts: not the system temp dir on Linux CI (the
// engine's bwrap validator sandbox masks it), so scratch (bare origin, clone, engine db) lives under
// RUNNER_TEMP on Linux CI, else the OS temp dir.
function scratchBase(): string {
  const runnerTemp = process.env['RUNNER_TEMP'];
  return process.platform === 'linux' && runnerTemp !== undefined && runnerTemp !== '' ? runnerTemp : tmpdir();
}

async function waitForRun(
  runId: string,
  pred: (s: Record<string, unknown>) => boolean,
  label: string,
  ms = 90_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    last = sessionOf(body);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  const { body } = await getJson(`/api/v1/runs/${runId}`);
  const rejected = unitsOf(body)
    .filter((u) => u['status'] === 'rejected')
    .map((u) => `${String(u['id'])}: ${String(u['denial_reason'] ?? '(no denial_reason)').slice(0, 600)}`);
  throw new Error(
    `timed out (${ms}ms) waiting for: ${label} — last status=${String(last['status'])} delivery=${String(last['delivery'])}` +
      (rejected.length > 0 ? `; rejected units: ${rejected.join(' | ')}` : ''),
  );
}

/** The deliver unit's record on the run wire. */
async function deliverUnit(runId: string): Promise<Record<string, unknown>> {
  const { body } = await getJson(`/api/v1/runs/${runId}`);
  return unitsOf(body).find((u) => String(u['id']).endsWith(':deliver'))!;
}

beforeAll(async () => {
  dir = mkdtempSync(join(scratchBase(), 'crew-l9-rev-e2e-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
  // The six credential dirs the engine's Linux bwrap sandbox masks with `--tmpfs` (see the strand
  // e2e): give the scratch HOME them empty so the pinned evidence floor can run at the deliver gate.
  for (const rel of ['.aws', '.ssh', '.gnupg', '.claude', join('.config', 'wicked-council'), join('.config', 'gh')]) {
    mkdirSync(join(home, rel), { recursive: true });
  }
  // A stub `gh`: `api user` → the login; `pr view N --json …` → the PR JSON the resolver parses;
  // `pr comment` → ok; nothing else expected in revision mode (no `pr create`).
  writeFileSync(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  api) echo "${GH_STUB_LOGIN:-release-bot}";;',
      '  pr)',
      '    case "$2" in',
      `      view) printf '{"headRefName":"${PR_BRANCH}","state":"OPEN","isCrossRepository":false,"url":"${PR_URL}"}\\n';;`,
      '      comment) echo "https://github.com/o/r/pull/273#issuecomment-1";;',
      '      *) echo "gh: unexpected pr $*" >&2; exit 2;;',
      '    esac;;',
      '  *) echo "gh: unexpected $*" >&2; exit 2;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  // The in-process `revisesPr` resolver runs `execFile('gh', …)` off the DAEMON's PATH (not a login
  // shell), so the stub must be on process.env.PATH too — the deliver SCRIPT gets it via .bash_profile.
  for (const [k, v] of Object.entries({
    HOME: home,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    // ≠ the stub login, so the first deliver refuses on identity (D-18). Fixed to STUB_LOGIN mid-test.
    GH_ACCOUNT: 'someone-else',
    GH_STUB_LOGIN: STUB_LOGIN,
    WICKED_CREW_AUDIT_LOG: join(dir, 'audit.log'),
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  origin = join(dir, 'origin.git');
  seed = join(dir, 'seed');
  clone = join(dir, 'workspace');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), '# l9 revision e2e\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  // The open PR's head: one commit on top of main, pushed to origin as `wicked/prior-run`.
  git(seed, 'checkout', '-q', '-b', PR_BRANCH);
  writeFileSync(join(seed, 'pr.txt'), 'the prior run\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'fix: the prior run');
  git(seed, 'push', '-q', 'origin', PR_BRANCH);
  prHead = git(seed, 'rev-parse', PR_BRANCH).trim();

  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  baseSkillOff();
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  await adapter.registerRepo('deliver-l9-rev-ws', clone);
  const wf = await postJson('/api/v1/workflows', WORK_WORKFLOW);
  expect(wf.status).toBe(201);
}, 60_000);

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

describe('DES-L9 §7 — revise an open PR: base on its head, refuse on identity → escalation gate, fix → deliver onto the PR branch', () => {
  it('revisesPr bases the run on the PR head; a deliver refusal parks at escalation; the fix lands one commit on the PR branch', async () => {
    const repos = await adapter.listRepos();
    const repoId = repos.find((r) => r.name === 'deliver-l9-rev-ws')!.id;

    // (1) Launch a revision: `revisesPr` resolved via the stub `gh pr view`; humanConfirm OMITTED so
    // the deliver gate fires (engine default) and we can approve it; deliver defaults to 'pr' (code-work).
    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: revise pull request #273',
      clisJson: SEATS,
      workflow: WORK_WORKFLOW.id,
      repoRef: repoId,
      revisesPr: PR_NUM,
    });
    expect(launch.status, JSON.stringify(launch.body)).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    // (1a) The engine based the run worktree on the PR head (`base_ref` → `origin/wicked/prior-run`).
    const based = await waitForRun(
      runId,
      (s) => typeof s['base_commit'] === 'string' && s['base_commit'] !== '',
      'runBaseResolved.base_commit on the wire',
    );
    expect(based['base_commit']).toBe(prHead);

    // (2) The deliver gate (humanConfirm omitted → engine default gates deliver). It reviews the
    // deliver unit BEFORE it runs — not yet rejected, and the prompt is the deliver-gate card, not
    // the refusal prompt. (`GET /runs/:id/gate` serves {ord, prompt, lifecycle} — no `gateKind`.)
    await waitForRun(runId, (s) => s['status'] === 'awaiting_human', 'the deliver gate');
    const gate1 = await getJson(`/api/v1/runs/${runId}/gate`);
    expect(String(gate1.body['prompt'] ?? '')).not.toMatch(/^The deliver phase refused:/);
    expect((await deliverUnit(runId))['status']).not.toBe('rejected');
    const approve1 = await postJson(`/api/v1/runs/${runId}/gate`, { approve: true });
    expect(approve1.status).toBe(200);

    // (2a) The deliver script refuses on identity (GH_ACCOUNT ≠ the stub login) and the engine arm
    // PARKS the run at an escalation gate — never `sessionFailed`, the worktree kept.
    const parked = await waitForRun(
      runId,
      (s) => s['status'] === 'awaiting_human' || s['status'] === 'failed',
      'the escalation gate after the deliver refusal',
    );
    expect(parked['status'], 'a deliver refusal parks, never fails the run').toBe('awaiting_human');
    // The escalation gate the arm opened: its prompt is the deliver-refusal prompt the engine emits
    // (`pause_for_human(.., "escalation", ..)`); the deliver unit is rejected as a deliver_refusal.
    const gate2 = await getJson(`/api/v1/runs/${runId}/gate`);
    expect(String(gate2.body['prompt'] ?? '')).toMatch(/^The deliver phase refused:/);
    const deliver = await deliverUnit(runId);
    expect(deliver['status']).toBe('rejected');
    expect((deliver['denial'] as { source?: string } | null)?.source).toBe('deliver_refusal');
    // On a host with no OS-sandbox tool the deliver unit's own pre-run re-verify refuses fail-closed
    // BEFORE the script runs (an engine-authored deliver refusal that the SAME arm parks); the
    // identity path is asserted only where the floor could arm (Linux CI with bwrap, macOS). Never a
    // silent pass: the parking above is proven either way.
    const reason = String(deliver['denial_reason'] ?? '');
    if (reason.includes('no OS write boundary could be armed')) {
      console.error(
        'deliver-revision-e2e: no OS-sandbox tool on this host — the engine floor refusal parked the ' +
          'run at escalation (proven above); the identity → fix → complete leg needs an armable floor and is skipped',
      );
      return;
    }
    expect(reason).toContain('deliver: identity mismatch');

    // (3) Fix the daemon's gh login (match the stub) and approve the escalation gate: the phase
    // re-runs, pushes the run's commit onto the PR branch, comments, and the run completes.
    process.env['GH_ACCOUNT'] = STUB_LOGIN;
    const approve2 = await postJson(`/api/v1/runs/${runId}/gate`, { approve: true });
    expect(approve2.status).toBe(200);
    const done = await waitForRun(runId, (s) => s['status'] === 'completed' || s['status'] === 'failed', 'the run to complete');
    expect(done['status']).toBe('completed');

    // The PR branch gained EXACTLY the run's one commit; no new PR branch on origin.
    expect(git(origin, 'rev-list', '--count', `${prHead}..${PR_BRANCH}`).trim()).toBe('1');
    expect(originBranches().sort()).toEqual(['main', PR_BRANCH].sort());
    expect(originBranches()).not.toContain(`wicked/${runId}`);
    const deliver2 = await deliverUnit(runId);
    expect(deliver2['status']).not.toBe('rejected');
  }, 120_000);
});
