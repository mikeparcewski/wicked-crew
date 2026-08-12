// FUNCTIONAL proof of the Phase 6a acceptance gate — nothing stubbed but the LLM.
//
// End to end through the daemon's own surfaces: a real (stub-engine) CoreAdapter, the real HTTP
// server, a real registered git repo whose worktree carries the REAL ledger garden's 6b run left
// behind, a real governed run launched over POST /runs against a user-registered workflow that
// declares the acceptance requirement (`verified_evidence: true`) — and the gate resolution read
// back over GET /runs/:id/acceptance FLIPS when the ledger's newest verdict flips:
//
//   PASS fixture  → gate { required: true, satisfied: true,  verdict: PASS }
//   FAIL recorded → gate { required: true, satisfied: false, verdict: FAIL } (deny-dominates)
//
// The FAIL is created through the wicked-ledger API itself — the same store the QE pipeline
// writes — not by hand-editing files, so the flip exercises the real data contract both ways.
//
// Two engine behaviors this test deliberately RIDES rather than works around:
//  - wicked-core auto-pins its built-in evidence floor onto any `verified_evidence` phase with no
//    validator (FINDING-055), and the stub CLI produces no evidence, so the RUN itself ends
//    `failed` — the engine's own gate deny-dominating at its layer. The acceptance route reads
//    regardless of run status: what the QE ledger says about the REPO is a different question from
//    how the run went, and 6a's gate answers the former.
//  - registerRepo requires a real git repository, so the workspace is `git init`ed.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/qe-ledger-pass', import.meta.url));

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** One-phase governed workflow: `accept` declares the acceptance requirement. */
const ACCEPT_WORKFLOW = {
  id: 'qe-accept-functional',
  phases: [
    {
      id: 'accept',
      kind: 'test',
      gate_type: 'execution',
      gate: 'auto',
      executes_code: false,
      verified_evidence: true,
      required_deliverables: [],
      depends_on: [],
      role: 'evaluator',
      skill_ref: null,
      allowed_skills: [],
      validator_pin: null,
    },
  ],
} as const;

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let workspace: string;
let baseUrl: string;
let runId: string;

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qe-accept-func-'));

  // A real git repo whose worktree carries the fixture ledger.
  workspace = join(dir, 'workspace');
  mkdirSync(workspace);
  cpSync(join(FIXTURE, '.wicked-testing'), join(workspace, '.wicked-testing'), { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# qe acceptance functional workspace\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=crew@test', '-c', 'user.name=crew-test', 'commit', '-qm', 'fixture');

  // Boot the daemon in-process against the STUB engine (no real LLM), real HTTP surface.
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // Register the repo through the engine (adapter call: same registration POST /repos performs,
  // minus the onboarding launch this test does not need) and the workflow through the API.
  const repo = await adapter.registerRepo('qe-accept-ws', workspace);

  const wfRes = await fetch(`${baseUrl}/api/v1/workflows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ACCEPT_WORKFLOW),
  });
  expect(wfRes.status).toBe(201);

  // Launch the governed run over the daemon's own surface.
  const launchRes = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem: 'Functional 6a: resolve the acceptance gate from the QE ledger',
      clisJson: SEATS,
      workflow: ACCEPT_WORKFLOW.id,
      repoRef: repo.id,
      humanConfirm: 'none',
    }),
  });
  expect(launchRes.status).toBe(201);
  runId = ((await launchRes.json()) as { runId: string }).runId;

  // Wait for the run to reach a terminal state (the stub unit is denied by the
  // engine's auto-pinned evidence floor, so `failed` is the expected terminus).
  let status = '';
  for (let i = 0; i < 300 && !TERMINAL.has(status); i++) {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    status = String((body['run'] as { session?: { status?: string } } | undefined)?.session?.status ?? '');
    if (!TERMINAL.has(status)) await new Promise((r) => setTimeout(r, 100));
  }
  expect(TERMINAL.has(status), `run must reach a terminal state (got '${status}')`).toBe(true);
}, 60000);

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('functional: the 6a acceptance gate over a real daemon + real ledger', () => {
  it('resolves the governed run as SATISFIED while the ledger holds the PASS', async () => {
    const { status, body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    expect(status).toBe(200);

    // The requirement came from the user-registered workflow, resolved through
    // the phase sequence (the engine reports an instance workflow id).
    expect(body['requirement']).toEqual({ declared: true, phases: ['accept'] });
    expect(body['repo']).toMatchObject({ name: 'qe-accept-ws', rootPath: workspace });
    expect(body['acceptance']).toMatchObject({
      ledgerDir: '.wicked-testing',
      found: true,
      verdict: { verdict: 'PASS', reviewer: 'wicked-garden-qe-acceptance-test-reviewer' },
      manifest: { manifestVersion: '1.1.0', artifactCount: 9 },
    });
    expect(body['gate']).toMatchObject({
      required: true,
      satisfied: true,
      verdict: 'PASS',
      runStatus: 'passed',
    });
  });

  it('FLIPS to denied when a FAIL verdict is recorded through the ledger API', async () => {
    // The same write path the QE pipeline uses: run row + FAIL verdict row.
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: join(workspace, '.wicked-testing') });
    const passRun = store.list('runs')[0]!;
    const failRun = store.create('runs', {
      project_id: passRun.project_id,
      scenario_id: passRun.scenario_id,
      started_at: new Date().toISOString(),
      status: 'running',
    });
    store.update('runs', failRun.id, { status: 'failed', finished_at: new Date().toISOString() });
    store.create('verdicts', {
      run_id: failRun.id,
      verdict: 'FAIL',
      reviewer: 'functional-6a',
      reason: 'induced failure: step 2 asserted exit 0, observed exit 1',
    });

    const { body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    expect(body['gate']).toMatchObject({
      required: true,
      satisfied: false,
      verdict: 'FAIL',
      runStatus: 'failed',
    });
    expect((body['gate'] as { reason: string }).reason).toContain('induced failure');
    expect(body['acceptance']).toMatchObject({
      verdict: { verdict: 'FAIL', reviewer: 'functional-6a' },
    });

    // …and the original PASS run is still addressable — history is not rewritten.
    const pinned = await getJson(`/api/v1/runs/${runId}/acceptance?qeRun=${passRun.id}`);
    expect(pinned.body['gate']).toMatchObject({ satisfied: true, verdict: 'PASS' });
  });
});
