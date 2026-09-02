// crew#311 END TO END — vacuous completion is LOUD on the wire, and resume points at the real
// recovery instead of destroying it. Nothing stubbed but the LLM (stub engine): the daemon is a
// real HTTP server on a scratch 79xx port, the repo is a clone of a LOCAL bare origin, the runs
// get REAL engine-provisioned worktrees, and the vacuity read is the PRODUCTION git probe
// (`gitWorktreeIsClean`), not an injected stub.
//
//   1. VACUOUS: a repo-scoped run whose only phase produces words and no files COMPLETES with a
//      pristine worktree — the wire says delivery:'vacuous' (never silently green), and
//      POST /runs/:id/resume refuses 409 {recovery:'retry'} naming retryOf. The pointed-at
//      recovery WORKS: a retryOf relaunch is accepted and carries the lineage on the wire.
//   2. STRANDED: the same shape with real uncommitted work reads delivery:'stranded', and
//      resume refuses 409 {recovery:'deliver'} naming POST /runs/:id/deliver.
//   3. CANCELLED: an executing run that is cancelled (the crew#311 "killed wedged workers"
//      shape) is refused 409 {recovery:'retry'} — resume never again answers
//      200 {"status":"cancelled"} on the runs an operator is trying to rescue.
//
// NEVER touches the operator's HOME or the live daemon: process HOME is redirected to a scratch
// dir, the audit trail via WICKED_CREW_AUDIT_LOG, and the daemon binds 127.0.0.1 on a scratch
// port (79xx, with an ephemeral-port fallback if it is taken).

// Deterministic + offline: force the lexical memory embedder so nothing downloads.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** A Tool phase that SAYS plenty and WRITES nothing — the deterministic stand-in for the
 *  crew#311 vacuous build (280–509 bytes of read-narration, worktree clean at main's HEAD). */
const NOOP_WORKFLOW = {
  id: 'vacuous-e2e-noop',
  phases: [
    {
      id: 'work',
      kind: 'build',
      executor: {
        type: 'tool',
        cmd: [
          'bash',
          '-lc',
          'echo "I will read the design spec first, then check the API types before writing anything at all."',
        ],
      },
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

/** The same shape leaving REAL uncommitted work — the stranded control. */
const WORK_WORKFLOW = {
  ...NOOP_WORKFLOW,
  id: 'vacuous-e2e-work',
  phases: [
    {
      ...NOOP_WORKFLOW.phases[0],
      executor: {
        type: 'tool',
        cmd: ['bash', '-lc', 'echo real-work > crew-e2e-vacuous-work.txt'],
      },
    },
  ],
} as const;

/** A phase that parks — long enough for a deterministic mid-flight cancel. */
const SLOW_WORKFLOW = {
  ...NOOP_WORKFLOW,
  id: 'vacuous-e2e-slow',
  phases: [
    {
      ...NOOP_WORKFLOW.phases[0],
      executor: { type: 'tool', cmd: ['bash', '-lc', 'sleep 120'] },
    },
  ],
} as const;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let repoId: string;
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
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

async function launch(workflow: string, problem: string): Promise<string> {
  const res = await postJson('/api/v1/runs', {
    problem,
    clisJson: SEATS,
    workflow,
    repoRef: repoId,
    humanConfirm: 'none',
    deliver: 'none', // the delivery default is not under test here
  });
  expect(res.status).toBe(201);
  return (res.body as { runId: string }).runId;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-vacuous-e2e-'));

  // Scratch HOME so nothing the spawns read or write touches the operator's.
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  for (const [k, v] of Object.entries({
    HOME: home,
    WICKED_CREW_AUDIT_LOG: join(dir, 'audit.log'),
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  // A real repo: a clone of a LOCAL bare origin (the engine worktrees hang off this clone).
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  const clone = join(dir, 'workspace');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'seed@test');
  git(seed, 'config', 'user.name', 'seed');
  writeFileSync(join(seed, 'README.md'), '# vacuous e2e workspace\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, clone]);
  git(clone, 'config', 'user.email', 'runner@test');
  git(clone, 'config', 'user.name', 'runner');

  // Boot the daemon against the STUB engine, real HTTP surface, scratch 79xx port
  // (ephemeral fallback keeps the suite hermetic if the port is taken on this host).
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  try {
    await app.listen({ port: 7943, host: '127.0.0.1' });
  } catch {
    await app.listen({ port: 0, host: '127.0.0.1' });
  }
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  await adapter.registerRepo('vacuous-e2e-ws', clone);
  const repos = await adapter.listRepos();
  repoId = repos.find((r) => r.name === 'vacuous-e2e-ws')!.id;
  for (const wf of [NOOP_WORKFLOW, WORK_WORKFLOW, SLOW_WORKFLOW]) {
    const res = await postJson('/api/v1/workflows', wf);
    expect(res.status).toBe(201);
  }
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

describe('crew#311 end to end — vacuous is loud, resume points at the real recovery', () => {
  it('a run that produced NOTHING completes delivery:vacuous; resume refuses with retry; the retry launch works', async () => {
    const runId = await launch(NOOP_WORKFLOW.id, 'e2e: say plenty, write nothing');

    // The run completes and the PRODUCTION git probe reads the pristine engine worktree:
    // loud on the wire, never silently green.
    const session = await waitForRun(
      runId,
      (s) => TERMINAL.has(String(s['status'])),
      'terminal status',
    );
    expect(session['status']).toBe('completed');
    const detail = await waitForRun(
      runId,
      (s) => s['delivery'] === 'vacuous',
      "delivery:'vacuous' on the run wire",
      15_000,
    );
    expect('deliverUrl' in detail).toBe(false);

    // The recovery affordance refuses LOUDLY and machine-readably…
    const resume = await postJson(`/api/v1/runs/${runId}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body['recovery']).toBe('retry');
    expect(String(resume.body['error']).toLowerCase()).toContain('vacuous');
    expect(String(resume.body['error'])).toContain(`"retryOf":"${runId}"`);

    // …and the recovery it points at actually works: a retryOf relaunch is accepted and the
    // lineage is on the wire.
    const retry = await postJson('/api/v1/runs', {
      problem: 'e2e: the retry lineage of the vacuous run',
      clisJson: SEATS,
      workflow: NOOP_WORKFLOW.id,
      repoRef: repoId,
      humanConfirm: 'none',
      deliver: 'none',
      retryOf: runId,
    });
    expect(retry.status).toBe(201);
    const retryId = (retry.body as { runId: string }).runId;
    const retried = await waitForRun(
      retryId,
      (s) => TERMINAL.has(String(s['status'])),
      'retry run terminal',
    );
    expect(retried['retry_of']).toBe(runId);
  }, 120_000);

  it("a run with real uncommitted work reads delivery:'stranded'; resume refuses with deliver", async () => {
    const runId = await launch(WORK_WORKFLOW.id, 'e2e: leave real work stranded');

    const session = await waitForRun(
      runId,
      (s) => TERMINAL.has(String(s['status'])),
      'terminal status',
    );
    expect(session['status']).toBe('completed');
    const detail = await waitForRun(
      runId,
      (s) => s['delivery'] === 'stranded',
      "delivery:'stranded' on the run wire",
      15_000,
    );
    expect('deliverUrl' in detail).toBe(false);

    const resume = await postJson(`/api/v1/runs/${runId}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body['recovery']).toBe('deliver');
    expect(String(resume.body['error'])).toContain(`/runs/${runId}/deliver`);
  }, 120_000);

  it('a cancelled run is refused 409 {recovery: retry} — never 200 {"status":"cancelled"}', async () => {
    const runId = await launch(SLOW_WORKFLOW.id, 'e2e: park, get cancelled, refuse resume');

    await waitForRun(runId, (s) => s['status'] === 'executing', 'run executing');
    const cancel = await postJson(`/api/v1/runs/${runId}/cancel`);
    expect(cancel.status).toBe(200);
    await waitForRun(runId, (s) => s['status'] === 'cancelled', 'run cancelled');

    const resume = await postJson(`/api/v1/runs/${runId}/resume`);
    expect(resume.status).toBe(409);
    expect(resume.body['recovery']).toBe('retry');
    expect(String(resume.body['error'])).toContain('cancelled');
    expect(String(resume.body['error'])).toContain(`"retryOf":"${runId}"`);
  }, 120_000);
});
