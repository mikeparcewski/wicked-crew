// FUNCTIONAL proof of the Phase 6a acceptance gate — nothing stubbed but the LLM.
//
// End to end through the daemon's own surfaces: a real (stub-engine) CoreAdapter, the real HTTP
// server, a real registered git repo whose worktree carries the REAL ledger garden's 6b run left
// behind, a real governed run launched over POST /runs against a user-registered workflow that
// declares the acceptance requirement (`verified_evidence: true`) — and the gate resolution read
// back over GET /runs/:id/acceptance follows what the ledger records ABOUT THIS RUN (F-E2E-013):
//
//   pre-existing PASS (months old)           → gate { required: true, satisfied: false, verdict: null }
//                                              — the repo has evidence; this run produced none
//   FAIL by a QE run started inside the run  → gate { required: true, satisfied: false, verdict: FAIL }
//   PASS stamped with the crew run id        → gate { required: true, satisfied: true,  verdict: PASS }
//   ?qeRun=<the old PASS>                    → still addressable — history is not rewritten
//
// The FAIL and PASS are created through the wicked-ledger API itself — the same store the QE
// pipeline writes — not by hand-editing files, so the flips exercise the real data contract, and
// the read side never writes: the run's `.wicked-testing/` gains no `wicked-qe.db` from a GET.
//
// Two engine behaviors this test deliberately RIDES rather than works around:
//  - wicked-core auto-pins its built-in evidence floor onto any `verified_evidence` phase with no
//    validator (FINDING-055), and the stub CLI produces no evidence, so the RUN itself ends
//    `failed` — the engine's own gate deny-dominating at its layer. The acceptance route reads
//    regardless of run status: what the QE ledger says about THIS RUN is a different question from
//    how the run went, and 6a's gate answers the former.
//  - registerRepo requires a real git repository, so the workspace is `git init`ed.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreateInput } from 'wicked-ledger';
import { CoreAdapter } from '../../src/core/adapter.js';
import { EVIDENCE_FLOOR_PIN } from '../../src/core/deliver.js';
import { createServer } from '../../src/api/server.js';
import { CREW_RUN_ID_FIELD } from '../../src/qe/ledger.js';
import type { RecordedEvent } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/qe-ledger-pass', import.meta.url));
/** The 6b QE run the fixture records (its PASS verdict landed 2026-08-12T02:31:41Z). */
const QE_RUN_ID = '7ec47687-fb15-4592-bf69-5121359f8bab';

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
]);

/** One-phase governed workflow: `accept` declares the acceptance requirement — and PINS the
 *  built-in evidence floor explicitly: since wicked-core#414 the engine judges a def as authored
 *  and REFUSES a `verified_evidence` phase with no `validator_pin` at registration (400 from
 *  `POST /workflows`), where it used to arm the floor itself. */
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
      validator_pin: EVIDENCE_FLOOR_PIN,
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
  // Deliberately the LEGACY dirname: the gate must dual-read a pre-6c ledger.
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

  // Wait for the run to reach a terminal state (the stub unit is denied by the explicitly
  // pinned evidence floor, so `failed` is the expected terminus).
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
  removeScratch(dir);
});

/** The crew run's recorded lifetime, from its durable log — what a QE run must have started inside. */
async function runWindow(): Promise<{ startedAt: number; finishedAt: number }> {
  const { body } = await getJson(`/api/v1/runs/${runId}/events`);
  const events = body['events'] as RecordedEvent[];
  const started = events.find((e) => e.type === 'sessionStarted');
  expect(started, 'the run must have recorded sessionStarted').toBeDefined();
  const last = events[events.length - 1]!;
  expect(['sessionCompleted', 'sessionFailed', 'sessionCancelled']).toContain(last.type);
  return { startedAt: started!.ts, finishedAt: last.ts };
}

describe('functional: the 6a acceptance gate over a real daemon + real ledger', () => {
  it("does NOT attribute the ledger's pre-existing PASS to the run — the run recorded no evidence (F-E2E-013)", async () => {
    const { status, body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    expect(status).toBe(200);

    // The requirement came from the user-registered workflow, resolved through
    // the phase sequence (the engine reports an instance workflow id).
    expect(body['requirement']).toEqual({ declared: true, phases: ['accept'] });
    expect(body['repo']).toMatchObject({ name: 'qe-accept-ws', rootPath: workspace });
    // The ledger IS found and reported — as what the repo holds, not as this run's evidence.
    expect(body['acceptance']).toMatchObject({
      ledgerDir: '.wicked-testing',
      found: true,
      verdict: null,
      qeRun: null,
      manifest: null,
      ledgerVerdicts: 1,
      attribution: { kind: 'none' },
    });
    expect(body['gate']).toMatchObject({ required: true, satisfied: false, verdict: null, runStatus: null });
    const reason = (body['gate'] as { reason: string }).reason;
    expect(reason).toMatch(/no verdict attributed to this run/);
    expect(reason).toContain('newest PASS');
    expect(reason).toContain('before this run started');

    // And the GET wrote nothing into the checkout: no derived index materialised on a read.
    for (const stray of ['wicked-qe.db', 'wicked-qe.db-wal', 'wicked-qe.db-shm']) {
      expect(existsSync(join(workspace, '.wicked-testing', stray)), `${stray} created by a GET`).toBe(false);
    }
  });

  it('attributes a FAIL recorded by a QE run that started INSIDE the run — and denies (deny-dominates)', async () => {
    // The same write path the QE pipeline uses: run row + FAIL verdict row. The QE run's start is
    // placed inside the crew run's lifetime, as a pipeline running in one of its units would be.
    const { startedAt } = await runWindow();
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: join(workspace, '.wicked-testing') });
    // The WRITER owns the derived index: the fixture ships JSON-only, so the pipeline side builds
    // it before writing — the read side never does this on its behalf any more (F-E2E-013).
    store.rebuildIndex();
    const passRun = store.get('runs', QE_RUN_ID)!;
    const failRun = store.create('runs', {
      project_id: passRun.project_id,
      scenario_id: passRun.scenario_id,
      started_at: new Date(startedAt + 1).toISOString(),
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
      attribution: { kind: 'run-window', qeRunId: failRun.id },
      ledgerVerdicts: 2,
    });
  });

  it('a later PASS STAMPED with the crew run id satisfies — the writer named the run, timing aside', async () => {
    // A QE writer inside a governed run sees the run id as WICKED_RUN_ID; recording it on the ledger
    // run is the explicit linkage. This one starts AFTER the crew run finished (a post-hoc review),
    // which the lifetime rule alone would not attribute — the stamp does.
    const { finishedAt } = await runWindow();
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: join(workspace, '.wicked-testing') });
    const passRun = store.get('runs', QE_RUN_ID)!;
    const stampedRun = store.create('runs', {
      project_id: passRun.project_id,
      scenario_id: passRun.scenario_id,
      started_at: new Date(Math.max(Date.now(), finishedAt + 1)).toISOString(),
      finished_at: new Date(Math.max(Date.now(), finishedAt + 2)).toISOString(),
      status: 'passed',
      [CREW_RUN_ID_FIELD]: runId,
    } as unknown as CreateInput<'runs'>);
    store.create('verdicts', {
      run_id: stampedRun.id,
      verdict: 'PASS',
      reviewer: 'functional-6a-review',
      reason: 'all assertions pass on re-review',
    });

    const { body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    // Newest attributed verdict governs: the stamped PASS is newer than the in-window FAIL.
    expect(body['gate']).toMatchObject({ required: true, satisfied: true, verdict: 'PASS', runStatus: 'passed' });
    expect(body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', reviewer: 'functional-6a-review' },
      attribution: { kind: 'stamped', qeRunId: stampedRun.id },
      ledgerVerdicts: 3,
    });
  });

  it('the historical PASS stays addressable by explicit pin — history is not rewritten', async () => {
    const pinned = await getJson(`/api/v1/runs/${runId}/acceptance?qeRun=${QE_RUN_ID}`);
    expect(pinned.body['gate']).toMatchObject({ satisfied: true, verdict: 'PASS' });
    expect(pinned.body['acceptance']).toMatchObject({
      verdict: { qeRunId: QE_RUN_ID, reviewer: 'wicked-garden-qe-acceptance-test-reviewer' },
      attribution: { kind: 'pinned', qeRunId: QE_RUN_ID },
    });
  });
});
