// crew#418 END TO END — a deliver-phase LIFT collision strands the run through the REAL daemon
// and REAL engine (stub LLM), with a LOCAL bare origin standing in for GitHub and a stub `gh`.
//
// The flow, nothing stubbed but the model and GitHub:
//   1. origin/main is diverged FIRST — a second clone lands a `collision.txt` the run will also
//      write, with different content — while the run's clone's local `main` stays at base. The
//      engine cuts the run worktree from that local `main` (`git worktree add -b`, from HEAD, no
//      fetch), so the worktree base does NOT carry origin's version: the collision is guaranteed
//      and deterministic, with no gate/race and no LLM in the loop (humanConfirm: 'none', so a
//      tool failure fails cleanly instead of escalating to an agent-triage judge seat the stub
//      engine has no real CLI to run).
//   2. The run's work phase writes `collision.txt`; the appended deliver phase commits it and
//      rebases onto the diverged origin/main, hits an add/add conflict OUTSIDE the changelog, and
//      the hardened script aborts LOUDLY with its LIFT-CONFLICT marker — nothing pushed.
//   3. The ENGINE records the run `failed` (a Tool phase exited non-zero). The DAEMON reinterprets
//      that shape on the wire: `status: completed`, `delivery: 'stranded'` — the work is safe on
//      its branch, only the lift collided.
//   4. Clear the collision on origin, then POST /runs/:id/deliver: the same script now rebases
//      cleanly, pushes the run branch to the LOCAL origin, and the wire flips to 'delivered'.
//
// NEVER touches GitHub or the operator's HOME (scratch HOME with a stub `gh`, redirected audit
// log, file-backed bare origin) — the same discipline as deliver-e2e.test.ts.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { DELIVER_LIFT_CONFLICT_MARKER } from '../../src/core/deliver.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** A one-phase code-work def whose Tool phase writes the collision file. `executes_code: true`
 *  makes it a code-work def (the crew#393 deliver default engages); the deliver phase is appended
 *  by that default, not spelled here. */
const WORK_WORKFLOW = {
  id: 'deliver-conflict-e2e-work',
  phases: [
    {
      id: 'work',
      kind: 'build',
      executor: { type: 'tool', cmd: ['bash', '-lc', 'printf "run version\\n" > collision.txt'] },
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
let baseMain: string;
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
  dir = mkdtempSync(join(tmpdir(), 'crew-418-e2e-'));
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
      '  pr) echo "${GH_STUB_OUT:-https://github.com/o/r/pull/418}";;',
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

  origin = join(dir, 'origin.git');
  seed = join(dir, 'seed');
  clone = join(dir, 'workspace');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), '# 418 e2e workspace\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  baseMain = git(seed, 'rev-parse', 'HEAD').trim();
  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');
  git(clone, 'config', 'commit.gpgsign', 'false');

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  await adapter.registerRepo('deliver-418-ws', clone);
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('crew#418 A — a deliver lift collision strands the run, end-to-end through the daemon', () => {
  it('collides on the deliver rebase → completed+stranded; clearing it lets POST /deliver lift', async () => {
    process.env['GH_STUB_OUT'] = 'https://github.com/o/r/pull/418';
    const repos = await adapter.listRepos();
    const repoId = repos.find((r) => r.name === 'deliver-418-ws')!.id;

    // Diverge origin/main FIRST (from the seed clone), leaving the run's clone local `main` at
    // base. The engine cuts the run worktree from that local `main`, so the run's deliver commit
    // ADDS collision.txt while origin/main ALSO has it — an add/add collision on the rebase.
    writeFileSync(join(seed, 'collision.txt'), 'main version\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'main adds collision.txt');
    git(seed, 'push', '-q', 'origin', 'main');

    // humanConfirm: 'none' — a tool failure fails CLEANLY (no agent-triage escalation, which would
    // need a real judge seat the stub engine cannot run). No gate, no race.
    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: write collision.txt and deliver it',
      clisJson: SEATS,
      workflow: WORK_WORKFLOW.id,
      repoRef: repoId,
      humanConfirm: 'none',
    });
    expect(launch.status).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    // The wire reinterprets the engine's `failed` (the deliver Tool phase exited non-zero on the
    // conflict) as completed + stranded (recoverable).
    const stranded = await waitForRun(
      runId,
      (s) => s['delivery'] === 'stranded',
      'delivery:stranded on the run wire',
    );
    expect(stranded['status']).toBe('completed');
    // The deliver phase pushed NOTHING — only main exists on origin, the work is on its branch.
    expect(originBranches()).toEqual(['main']);

    // WHY it stranded is on the wire: the deliver unit is rejected with the LIFT-CONFLICT marker.
    const detail = (await getJson(`/api/v1/runs/${runId}`)).body;
    const units = (detail['run'] as { units: { id: string; status: string; denial_reason: string | null }[] })
      .units;
    const deliver = units.find((u) => u.id.endsWith(':deliver'))!;
    expect(deliver.status).toBe('rejected');
    expect(deliver.denial_reason ?? '').toContain(DELIVER_LIFT_CONFLICT_MARKER);

    // resume refuses with the DELIVER recovery, not a re-entry.
    const resume = await postJson(`/api/v1/runs/${runId}/resume`);
    expect(resume.status).toBe(409);
    expect((resume.body as { recovery: string }).recovery).toBe('deliver');

    // Clear the collision on origin (reset main back to base), then lift the stranded work.
    git(clone, 'push', '-q', '-f', 'origin', `${baseMain}:refs/heads/main`);
    const lift = await postJson(`/api/v1/runs/${runId}/deliver`);
    expect(lift.status).toBe(200);
    expect((lift.body as { prUrl: string }).prUrl).toBe('https://github.com/o/r/pull/418');
    expect(originBranches()).toContain(`wicked/${runId}`);

    // The wire now reads delivered.
    const after = await waitForRun(runId, (s) => s['delivery'] === 'delivered', 'delivery:delivered');
    expect(after['deliverUrl']).toBe('https://github.com/o/r/pull/418');
  }, 120_000);
});
