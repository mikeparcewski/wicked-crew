// crew#481 / crew#496 — the REAL-ENGINE launch test for the def-aware wire derivation + `ended_at`
// (DES-L8 r2 §7; the seam: engine terminal frame → daemon classification/timing → the three surfaces).
//
// A tool-only def (no `executes_code` phase, no deliver unit — the capture-learnings / onboarding
// shape) runs on the real engine (stub dispatcher: Tool phases execute for real, no CLI seat) inside a
// registered repo, DIRTIES its worktree (so the engine's terminal reap keeps the tree — the exact shape
// that used to read `'stranded'` forever) and completes. Then:
//
//   - `GET /runs`, `GET /runs/:id` AND `GET /campaigns` (the run attached to a label group) ALL read
//     `delivery: "none"` — the ONE check (DES-L8 §8) — while the worktree still exists on disk;
//   - the run carries `created_at` and `ended_at` (unix seconds, `created_at <= ended_at`), the
//     `run.ended` audit entry is on the trail exactly once, and a second read stays identical.
//
// Same rig as deliver-conflict-strand-e2e.test.ts (createServer over a stub-engine CoreAdapter, a temp
// state home, a temp repo); ~seconds. The bare origin is not needed: nothing is lifted or pushed.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** A two-phase TOOL-ONLY def: recon, no code work, no deliver — the crew#481 shape. The tool writes
 *  a file so the worktree is dirty at terminal (the engine reaps only CLEAN trees). */
const NOTES_WORKFLOW = {
  id: 'l8-notes-only',
  // crew 0.7.35's base-skill intake gate (wicked-core#468): a def with no published skills snapshot
  // opts out EXPLICITLY (`""`) — this rig has no snapshot, and two Tool phases follow no discipline.
  base_skill_ref: '',
  phases: [
    {
      id: 'survey',
      kind: 'recon',
      executor: { type: 'tool', cmd: ['bash', '-lc', 'printf "survey\\n" > NOTES.md'] },
      gate_type: null,
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: [],
      role: 'neutral',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
    {
      id: 'summarize',
      kind: 'recon',
      executor: { type: 'tool', cmd: ['bash', '-lc', 'printf "summary\\n" >> NOTES.md'] },
      gate_type: null,
      gate: 'auto',
      executes_code: false,
      verified_evidence: false,
      required_deliverables: [],
      depends_on: ['survey'],
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
let repo: string;
let baseUrl: string;
const savedEnv: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
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
function sessionOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body['run'] as { session: Record<string, unknown> }).session;
}
function scratchBase(): string {
  const runnerTemp = process.env['RUNNER_TEMP'];
  return process.platform === 'linux' && runnerTemp !== undefined && runnerTemp !== '' ? runnerTemp : tmpdir();
}
async function waitForRun(
  runId: string,
  pred: (s: Record<string, unknown>) => boolean,
  label: string,
  ms = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    last = sessionOf(body);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  const { body } = await getJson(`/api/v1/runs/${runId}`);
  const units = ((body['run'] as { units?: Array<Record<string, unknown>> }).units ?? [])
    .filter((u) => u['status'] === 'rejected')
    .map((u) => `${String(u['id'])}: ${String(u['denial_reason'] ?? '(no denial_reason)').slice(0, 400)}`);
  throw new Error(
    `timed out (${ms}ms) waiting for: ${label} — last status=${String(last['status'])} delivery=${String(last['delivery'])}` +
      (units.length > 0 ? `; rejected units: ${units.join(' | ')}` : ''),
  );
}

beforeAll(async () => {
  dir = mkdtempSync(join(scratchBase(), 'crew-l8-none-e2e-'));
  for (const k of ['WICKED_WORKFLOWS_DIR', 'WICKED_CREW_AUDIT_LOG']) savedEnv[k] = process.env[k];
  const overlay = join(dir, 'workflows');
  mkdirSync(overlay, { recursive: true });
  process.env['WICKED_WORKFLOWS_DIR'] = overlay;
  process.env['WICKED_CREW_AUDIT_LOG'] = join(dir, 'audit.log');

  repo = join(dir, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'runner@test');
  git(repo, 'config', 'user.name', 'runner');
  writeFileSync(join(repo, 'README.md'), '# l8 notes-only e2e\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  await adapter.registerRepo('l8-notes-ws', repo);
  const wf = await postJson('/api/v1/workflows', NOTES_WORKFLOW);
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

describe('crew#481 / crew#496 — a completed tool-only run reads delivery:none on every surface and carries ended_at', () => {
  it('GET /runs, GET /runs/:id and GET /campaigns agree on "none" while the dirty worktree still exists; created_at <= ended_at', async () => {
    const repos = (await getJson('/api/v1/repos')).body['repos'] as Array<{ id: string; name: string }>;
    const repoId = repos.find((r) => r.name === 'l8-notes-ws')!.id;
    const launchedAt = Math.floor(Date.now() / 1000);

    const launch = await postJson('/api/v1/runs', {
      problem: 'e2e: survey the repo and write notes (no code work, no deliver)',
      clisJson: SEATS,
      workflow: NOTES_WORKFLOW.id,
      repoRef: repoId,
      humanConfirm: 'none',
      groupLabel: 'l8-onboarding-batch',
    });
    expect(launch.status, `launch refused: ${JSON.stringify(launch.body)}`).toBe(201);
    const runId = (launch.body as { runId: string }).runId;

    const done = await waitForRun(runId, (s) => s['status'] === 'completed', 'status:completed');
    // The tree is DIRTY (NOTES.md untracked) so the engine's terminal reap kept it: the exact shape that
    // read 'stranded' before crew#481. Assert the precondition, or the 'none' below proves nothing.
    expect(typeof done['workdir']).toBe('string');
    expect(existsSync(done['workdir'] as string)).toBe(true);
    expect(existsSync(join(done['workdir'] as string, 'NOTES.md'))).toBe(true);

    // THE ONE CHECK — three surfaces, one predicate.
    expect(done['delivery']).toBe('none');
    const list = (await getJson('/api/v1/runs')).body['runs'] as Array<{ session: Record<string, unknown> }>;
    expect(list.find((r) => r.session['id'] === runId)!.session['delivery']).toBe('none');
    const campaigns = (await getJson('/api/v1/campaigns')).body;
    const groups = campaigns['groups'] as Array<{ label: string; runs: Array<Record<string, unknown>> }>;
    const group = groups.find((g) => g.label === 'l8-onboarding-batch');
    expect(group, 'the run is attached to its label group').toBeDefined();
    expect(group!.runs.find((r) => r['runId'] === runId)).toEqual({ runId, status: 'completed', delivery: 'none' });

    // Times: the run's own clock, from the trail.
    expect(typeof done['created_at']).toBe('number');
    expect(typeof done['ended_at']).toBe('number');
    expect(done['created_at'] as number).toBeGreaterThanOrEqual(launchedAt - 1);
    expect(done['ended_at'] as number).toBeGreaterThanOrEqual(done['created_at'] as number);
    expect(done['ended_at'] as number).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);

    // Exactly one `run.ended` entry for this run on the trail, and a re-read is identical (idempotent).
    const trail = readFileSync(join(dir, 'audit.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { action: string; runId?: string; detail?: Record<string, unknown> });
    const ended = trail.filter((e) => e.action === 'run.ended' && e.runId === runId);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.detail).toEqual({ status: 'sessionCompleted' });
    const again = sessionOf((await getJson(`/api/v1/runs/${runId}`)).body);
    expect(again['ended_at']).toBe(done['ended_at']);
    expect(again['delivery']).toBe('none');
  }, 90_000);
});
