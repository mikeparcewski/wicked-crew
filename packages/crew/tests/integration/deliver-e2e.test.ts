// crew#393 END TO END — the delivery contract through the daemon's own surfaces, nothing stubbed
// but the LLM (stub engine) and GitHub (a LOCAL bare origin + a stub `gh`):
//
//   1. DEFAULT-ON: a repo-scoped run launched over POST /runs with a workflow and NO deliver
//      field gets the deliver phase appended automatically; the run COMPLETES; the phase pushes
//      the run branch to the LOCAL origin and "opens" the PR through the stub gh; the run wire
//      then reads delivery:'delivered' with deliverUrl — the whole crew#293 pipeline, engaged by
//      default instead of by an opt-in nothing set.
//   2. STRANDED + POST-HOC: the same launch with deliver:'none' completes with its work sitting
//      uncommitted in the engine-created worktree — the run 83052f0b shape — and the wire says
//      so: delivery:'stranded'. POST /runs/:id/deliver lifts it: 200 {prUrl}, the branch lands
//      on the LOCAL origin, and the wire flips to 'delivered'.
//
// NEVER touches GitHub or the operator's HOME: process HOME is redirected to a scratch dir
// (whose .bash_profile puts the stub `gh` first on PATH — the deliver spawns are `bash -lc`,
// and the engine's tool spawn inherits this process's env), the audit trail is redirected via
// WICKED_CREW_AUDIT_LOG, the workflow overlay dir is redirected by the suite-wide setup file,
// and every push targets a file-backed bare repo.

// Deterministic + offline: force the lexical memory embedder so nothing downloads.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** One-phase workflow whose Tool phase WRITES a file — the deterministic stand-in for a coding
 *  agent leaving uncommitted work in the run worktree (core#291's premise). The deliver phase is
 *  NOT part of this def: run 1 gets it appended by the crew#393 default, run 2 declines it.
 *  `executes_code: true` is what makes this a CODE-WORK def in the default's eyes (the crew#393
 *  guard: read-only defs like chat never default on); `role: 'neutral'` keeps the engine's
 *  creator-floor machinery out of a deterministic tool phase. */
const WORK_WORKFLOW = {
  id: 'deliver-e2e-work',
  phases: [
    {
      id: 'work',
      kind: 'build',
      executor: { type: 'tool', cmd: ['bash', '-lc', 'echo delivered-by-e2e > crew-e2e-work.txt'] },
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

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let origin: string;
let clone: string;
let baseUrl: string;
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

/** Poll the run detail until `pred` holds (or time runs out) — returns the last session seen. */
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
  throw new Error(
    `timed out (${ms}ms) waiting for: ${label} — last status=${String(last['status'])} delivery=${String(last['delivery'])}`,
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-deliver-e2e-'));

  // ── The scratch HOME every deliver spawn inherits: stub `gh` first on PATH ──
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, '.bash_profile'), `export PATH="${bin}:$PATH"\n`);
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
  for (const [k, v] of Object.entries({
    HOME: home,
    GH_ACCOUNT: '',
    WICKED_CREW_AUDIT_LOG: join(dir, 'audit.log'),
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  // ── A real repo: a clone of a LOCAL bare origin (the deliver script pushes here) ──
  origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  clone = join(dir, 'workspace');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), '# deliver e2e workspace\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, clone]);
  // The scratch HOME has no global gitconfig; the deliver script's commit uses the repo's own
  // (worktrees share it), and fails loudly without one — so set it like an operator's clone has.
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');

  // ── Boot the daemon in-process against the STUB engine, real HTTP surface ──
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // Register the repo (same registration POST /repos performs, minus the onboarding launch this
  // test does not need) and the workflow through the API.
  await adapter.registerRepo('deliver-e2e-ws', clone);
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

describe('crew#393 end to end — default-on delivery, stranded surfacing, post-hoc lift', () => {
  it('a repo-scoped run with NO deliver field delivers by default: the phase runs, the wire says delivered', async () => {
    process.env['GH_STUB_OUT'] = 'https://github.com/o/r/pull/101';
    const repos = await adapter.listRepos();
    const repoId = repos.find((r) => r.name === 'deliver-e2e-ws')!.id;

    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: write the work file and deliver it',
      clisJson: SEATS,
      workflow: WORK_WORKFLOW.id,
      repoRef: repoId,
      humanConfirm: 'none',
      // deliver DELIBERATELY OMITTED — the crew#393 default must engage it.
    });
    expect(launch.status).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    // The run completes AND the wire reports the delivery (the post-terminal resolution is
    // async, so wait for the delivery field itself — status alone is not the finish line).
    const session = await waitForRun(
      runId,
      (s) => s['delivery'] === 'delivered',
      'delivery:delivered on the run wire',
    );
    expect(session['status']).toBe('completed');
    expect(session['deliverUrl']).toBe('https://github.com/o/r/pull/101');

    // The delivery is REAL on the local remote: the run branch exists and is ahead of main.
    expect(originBranches()).toContain(`wicked/${runId}`);
    expect(Number(git(origin, 'rev-list', '--count', `main..wicked/${runId}`).trim())).toBeGreaterThanOrEqual(1);
    // And it carries the work the Tool phase wrote.
    const files = git(origin, 'show', '--name-only', '--format=', `wicked/${runId}`).trim();
    expect(files).toContain('crew-e2e-work.txt');
  }, 120_000);

  it("deliver:'none' completes stranded (the 83052f0b shape); POST /runs/:id/deliver lifts it", async () => {
    process.env['GH_STUB_OUT'] = 'https://github.com/o/r/pull/202';
    const repos = await adapter.listRepos();
    const repoId = repos.find((r) => r.name === 'deliver-e2e-ws')!.id;

    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: write the work file but do not deliver',
      clisJson: SEATS,
      workflow: WORK_WORKFLOW.id,
      repoRef: repoId,
      humanConfirm: 'none',
      deliver: 'none',
    });
    expect(launch.status).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    // Completed, work in the worktree, no PR anywhere — and the wire SAYS so now.
    const stranded = await waitForRun(
      runId,
      (s) => TERMINAL.has(String(s['status'])),
      'terminal status',
    );
    expect(stranded['status']).toBe('completed');
    expect(stranded['delivery']).toBe('stranded');
    expect('deliverUrl' in stranded).toBe(false);
    const workdir = String(stranded['workdir']);
    expect(existsSync(join(workdir, 'crew-e2e-work.txt'))).toBe(true);
    expect(originBranches()).not.toContain(`wicked/${runId}`);

    // The post-hoc lift — the recovery the user had to do by hand for 83052f0b.
    const deliver = await postJson(`/api/v1/runs/${runId}/deliver`);
    expect(deliver.status).toBe(200);
    expect(deliver.body).toEqual({ prUrl: 'https://github.com/o/r/pull/202' });
    expect(originBranches()).toContain(`wicked/${runId}`);
    expect(Number(git(origin, 'rev-list', '--count', `main..wicked/${runId}`).trim())).toBeGreaterThanOrEqual(1);

    // Idempotent: the same URL again, and still exactly one PR-equivalent branch state.
    const again = await postJson(`/api/v1/runs/${runId}/deliver`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ prUrl: 'https://github.com/o/r/pull/202' });

    // The wire flipped for good.
    const after = await waitForRun(
      runId,
      (s) => s['delivery'] === 'delivered',
      'delivery:delivered after the post-hoc lift',
      15_000,
    );
    expect(after['deliverUrl']).toBe('https://github.com/o/r/pull/202');
  }, 120_000);
});
