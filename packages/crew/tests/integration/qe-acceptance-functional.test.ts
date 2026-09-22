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
//    validator (FINDING-055; since wicked-core#414 the def pins it explicitly), and the stub CLI
//    produces no evidence, so the accept unit is DENIED by that floor — the engine's own gate
//    deny-dominating at its layer. Since wicked-core #477 (core#464) a floor denial no longer ends
//    the run `failed`: it PARKS `awaiting_human` at the engine's `escalation` gate
//    (`gateEscalated.condition: 'floor_failed'`, source `pinned_validator`), so this test asserts
//    that pause and its class, then REJECTS the gate over POST /runs/:id/gate — the run's terminal
//    state is `cancelled` (`runCancelled`; the tree is clean, so the worktree is reaped, not
//    retained — core#456). The acceptance route reads regardless of run status: what the QE ledger
//    says about THIS RUN is a different question from how the run went, and 6a's gate answers the
//    former.
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
import { baseSkillOff } from '../setup/base-skill-off.js';

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

/** Poll `GET /runs/:id` (≤ ~30 s) until the run's status satisfies `settled`; returns the last status seen. */
async function pollStatus(settled: (status: string) => boolean): Promise<string> {
  let status = '';
  for (let i = 0; i < 300 && !settled(status); i++) {
    const { body } = await getJson(`/api/v1/runs/${runId}`);
    status = String((body['run'] as { session?: { status?: string } } | undefined)?.session?.status ?? '');
    if (!settled(status)) await new Promise((r) => setTimeout(r, 100));
  }
  return status;
}

/** The run's durable event trail, oldest first — UNTYPED on purpose: the seven additive
 *  `gateEscalated` fields (`denialSource`, `defGate`, `restored`, …) reach crew's wire types with
 *  #559; this test pins the ENGINE's contract, not the mirror. */
async function runEvents(): Promise<Array<Record<string, unknown>>> {
  const { body } = await getJson(`/api/v1/runs/${runId}/events`);
  return body['events'] as Array<Record<string, unknown>>;
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
  baseSkillOff(); // run mechanics, not grounding — no published generation here (see tests/setup/base-skill-off.ts)
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

  // The stub unit is denied by the explicitly pinned evidence floor. wicked-core #477 (core#464):
  // the denial PARKS the run at the escalation gate instead of ending it `failed` — assert the
  // pause AND its class, then reject the gate so the run reaches the terminal state the suite
  // below reads against.
  let status = await pollStatus((s) => TERMINAL.has(s) || s === 'awaiting_human');
  expect(status, `run must park at the evidence-floor escalation gate (got '${status}')`).toBe('awaiting_human');
  const parked = await getJson(`/api/v1/runs/${runId}`);
  const units = (parked.body['run'] as { units: Array<{ id: string; ord: number; status: string; denial_reason: string | null }> }).units;
  const accept = units.find((u) => u.id.endsWith(':accept'));
  expect(accept, 'the def\'s accept phase is planned').toBeDefined();
  expect(accept!.status, 'the denied unit is rejected while the run waits').toBe('rejected');
  expect(String(accept!.denial_reason ?? '')).not.toBe('');
  // The gate names its class — `floor_failed` from the `pinned_validator` layer, engine-authored
  // (`defGate: false`); no guard restore is involved (`restored: false`, nothing discarded).
  const events = await runEvents();
  const escalated = events.filter((e) => e['type'] === 'gateEscalated');
  expect(escalated, 'one escalation for the one denied unit').toHaveLength(1);
  expect(escalated[0]).toMatchObject({
    ord: accept!.ord,
    condition: 'floor_failed',
    denialSource: 'pinned_validator',
    defGate: false,
    restored: false,
    discarded: [],
  });
  // `unitDenied` is still emitted and precedes the gate; no `sessionFailed` is ever booked for a
  // denial (#477's exit criterion: no failure without a decided gate).
  const deniedIx = events.findIndex((e) => e['type'] === 'unitDenied' && e['ord'] === accept!.ord);
  expect(deniedIx).toBeGreaterThanOrEqual(0);
  expect(deniedIx).toBeLessThan(events.findIndex((e) => e['type'] === 'gateEscalated'));
  expect(events.some((e) => e['type'] === 'sessionFailed')).toBe(false);

  // REJECT (approve:false) → the engine cancels the run. The stub wrote nothing, so the tree is
  // clean and the worktree is reaped rather than retained (core#456: only a DIRTY tree is kept).
  const decided = await fetch(`${baseUrl}/api/v1/runs/${runId}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approve: false }),
  });
  const decidedBody = (await decided.json()) as Record<string, unknown>;
  expect(decided.status, `POST /runs/${runId}/gate → ${JSON.stringify(decidedBody)}`).toBe(200);
  expect(decidedBody['status']).toBe('cancelled');
  status = await pollStatus((s) => TERMINAL.has(s));
  expect(status, `run must reach a terminal state after the gate reject (got '${status}')`).toBe('cancelled');
  const trail = await runEvents();
  expect(trail[trail.length - 1]?.['type'], 'the cancel is the terminal frame').toBe('runCancelled');
  expect(trail.some((e) => e['type'] === 'worktreeRetained'), 'clean tree → reaped, not retained').toBe(false);
  // The denied unit stays denied after the cancel — a reject decides the run, not the denial.
  const cancelled = await getJson(`/api/v1/runs/${runId}`);
  expect((cancelled.body['run'] as { units: Array<{ id: string; status: string }> }).units.find((u) => u.id.endsWith(':accept'))?.status).toBe('rejected');
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
  // The engine's terminal frames, as it spells them (wicked-core event.rs): NOT `sessionCancelled`.
  const last = events[events.length - 1]!;
  expect(['sessionCompleted', 'sessionFailed', 'runCancelled']).toContain(last.type);
  return { startedAt: started!.ts, finishedAt: last.ts };
}

/** The QE runs the tests below record, in order — later cases reason about earlier ones. */
let failRunId: string;
let stampedRunId: string;

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
    failRunId = failRun.id;

    const { body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    expect(body['gate']).toMatchObject({
      required: true,
      satisfied: false,
      verdict: 'FAIL',
      runStatus: 'failed',
    });
    const reason = (body['gate'] as { reason: string }).reason;
    expect(reason).toContain('induced failure');
    // The linkage is INFERRED from the run's lifetime, and the reason says so (F6).
    expect(reason).toContain('INFERRED from this run\'s lifetime');
    expect(body['acceptance']).toMatchObject({
      verdict: { verdict: 'FAIL', reviewer: 'functional-6a' },
      attribution: { kind: 'run-window', qeRunId: failRun.id },
      ledgerVerdicts: 2,
      attributedVerdicts: 1,
    });
  });

  it('a later PASS STAMPED with the crew run id on ANOTHER QE run is attributed — but does not lift the FAIL (deny-dominates across QE runs, F2)', async () => {
    // A QE writer inside a governed run sees the run id as WICKED_RUN_ID; recording it on the ledger
    // run is the explicit linkage. This one starts AFTER the crew run finished (a post-hoc review),
    // which the lifetime rule alone would not attribute — the stamp does. It is a DIFFERENT QE run
    // (another scenario) than the one that failed, so its PASS must not mask that FAIL: both QE
    // runs are this crew run's, and one of them still says FAIL.
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
      reason: 'all assertions pass (scenario Y)',
    });
    stampedRunId = stampedRun.id;

    const { body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    // Two attributed QE runs; the newest non-PASS among their newest verdicts governs.
    expect(body['gate']).toMatchObject({ required: true, satisfied: false, verdict: 'FAIL', runStatus: 'failed' });
    const reason = (body['gate'] as { reason: string }).reason;
    expect(reason).toContain('2 QE runs are attributed to this run');
    expect(reason).toContain('deny-dominates across their newest verdicts');
    expect(body['acceptance']).toMatchObject({
      verdict: { verdict: 'FAIL', reviewer: 'functional-6a' },
      attribution: { kind: 'run-window', qeRunId: failRunId },
      ledgerVerdicts: 3,
      attributedVerdicts: 2,
    });
  });

  it('once the failing QE run is re-reviewed PASS, every attributed QE run passes and the gate satisfies', async () => {
    // Supersession stays PER QE RUN: the re-review is the failing run's newest verdict, so the
    // deny-dominates set is now {PASS, PASS} and the newest PASS governs.
    const { createDomainStore } = await import('wicked-ledger');
    const store = createDomainStore({ root: join(workspace, '.wicked-testing') });
    store.create('verdicts', {
      run_id: failRunId,
      verdict: 'PASS',
      reviewer: 'functional-6a-rereview',
      reason: 're-review: the failing step was environmental; all assertions pass',
    });

    const { body } = await getJson(`/api/v1/runs/${runId}/acceptance`);
    expect(body['gate']).toMatchObject({ required: true, satisfied: true, verdict: 'PASS', runStatus: 'passed' });
    expect((body['gate'] as { reason: string }).reason).toContain('2 QE runs are attributed to this run');
    expect(body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', reviewer: 'functional-6a-rereview' },
      attribution: { kind: 'run-window', qeRunId: failRunId },
      ledgerVerdicts: 4,
      attributedVerdicts: 2,
    });
    // The stamped QE run is still addressable on its own.
    const pinned = await getJson(`/api/v1/runs/${runId}/acceptance?qeRun=${stampedRunId}`);
    expect(pinned.body['acceptance']).toMatchObject({
      verdict: { verdict: 'PASS', reviewer: 'functional-6a-review' },
      attribution: { kind: 'pinned', qeRunId: stampedRunId },
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
