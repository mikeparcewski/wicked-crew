// crew#951 — a governed run's QE verdict lives in the RUN's QE ledger, `<evidence root>/.wicked-qe`,
// and that is the one ledger its delivery reads.
//
// The bug (rig run cdfa0a49): the run's QE unit recorded its PASS in `<worktree>/.wicked-qe`, the
// worktree guard discarded it, and the deliver gate read `<registered repo>/.wicked-qe`, which no
// seat writes — every app-change run requiring QE acceptance stranded at deliver. The engine now
// hands the QE unit `WICKED_QE_LEDGER_DIR=<evidence root>/.wicked-qe` (outside every worktree; the
// evidence root crew mints per repo-bound run), and crew reads exactly that ledger for such a run:
//
//   PASS stamped with the run id in the run ledger → the deliver approve goes through;
//   FAIL there, or no verdict → refused 409 qe_acceptance_required, the gate open;
//   a PASS in the REPO ledger (the old place) does not speak for a run with an evidence root, and
//   neither does crew's own WICKED_QE_LEDGER_DIR (the per-run path is exact).
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CreateInput } from 'wicked-ledger';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { CREW_RUN_ID_FIELD, runQeLedgerRoot } from '../src/qe/ledger.js';
import { removeScratch } from './setup/scratch.js';

const DELIVER_ORD = 3;
const REQUIRED = {
  status: 'required', basis: 'diff', score: 100, threshold: 20, ord: 2, tree: 'aaaaaaaa',
  reason: 'required: impact score 100 above the waiver line 20', reasons: [],
};

let dir: string;
let repoRoot: string;
let app: FastifyInstance;
const gateCache = new GateCache();
const confirmCalls: unknown[][] = [];

const RUNS = {
  pass: 'run-951-pass',
  fail: 'run-951-fail',
  none: 'run-951-none',
  repoPass: 'run-951-repo-pass',
};
const evidenceOf = (id: string) => join(dir, 'walkthroughs', id);

function unit(run: string, ord: number, phase: string, status: string) {
  return {
    id: `${run}:${phase}`, session_id: run, ord, description: '', stage: 'build', phase_ref: phase,
    assigned_cli: 'claude', assigned_invocation: null, council_task_ref: null, routing: null, status,
  };
}

function view(id: string) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'pi'], status: 'awaiting_human', human_confirm: 'all', unit_ix: DELIVER_ORD - 1, attempt: 0,
      workdir: join(dir, 'wt', id), repo_ref: 'repo-1', extra_write_roots: [join(evidenceOf(id), 'author')],
      evidence_root: evidenceOf(id), archived_at: null, archive_note: null,
      assurance: { mode: 'full', required: ['distinct_evaluator', 'judge', 'qe_acceptance'], qe: REQUIRED },
    },
    units: [
      unit(id, 1, 'fix', 'done'),
      unit(id, 2, 'verify', 'done'),
      unit(id, DELIVER_ORD, 'deliver', 'pending'),
    ],
  };
}

/** Record a QE run + verdict STAMPED with the crew run id into the ledger at `root` — what garden's
 *  `qe accept` writes through wicked-ledger when the engine hands it `WICKED_QE_LEDGER_DIR=root`. */
async function stampVerdict(root: string, runId: string, verdict: 'PASS' | 'FAIL'): Promise<void> {
  const { createDomainStore } = await import('wicked-ledger');
  const store = createDomainStore({ root });
  store.rebuildIndex();
  const project = store.create('projects', { name: `p-${runId}-${verdict}` });
  const scenario = store.create('scenarios', { project_id: project.id, name: `s-${runId}-${verdict}`, format_version: '1' });
  const qe = store.create('runs', {
    project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: 'running',
    [CREW_RUN_ID_FIELD]: runId,
  } as unknown as CreateInput<'runs'>);
  store.update('runs', qe.id, { status: verdict === 'PASS' ? 'passed' : 'failed', finished_at: new Date().toISOString() });
  store.create('verdicts', { run_id: qe.id, verdict, reviewer: 'qe-reviewer', reason: verdict === 'FAIL' ? 'step 3 failed' : null });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-run-ledger-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  const views = Object.values(RUNS).map(view);
  for (const v of views) mkdirSync(join(v.session.evidence_root, 'author'), { recursive: true });
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => structuredClone(views)),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'repo', root_path: repoRoot }]),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    getWorkflow: () => null,
    interactionRequests: vi.fn(async () => []),
    runEvents: vi.fn(async () => null),
    listConformanceClaims: vi.fn(async () => []),
    confirmGate: vi.fn(async (...args: unknown[]) => {
      confirmCalls.push(args);
      return 'executing';
    }),
  };
  const audit = { record: vi.fn(() => Date.now()), readAll: vi.fn(async () => []) } as unknown as AuditLog;
  app = Fastify({ logger: false });
  registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' }, {
    worktreeExists: () => true,
    deliverExec: async () => ({ status: 0, output: '' }),
  });
  await app.ready();
  await stampVerdict(join(evidenceOf(RUNS.pass), '.wicked-qe'), RUNS.pass, 'PASS');
  await stampVerdict(join(evidenceOf(RUNS.fail), '.wicked-qe'), RUNS.fail, 'FAIL');
  // The OLD place: the registered repo's own ledger. It must not speak for a run with an evidence root.
  await stampVerdict(join(repoRoot, '.wicked-qe'), RUNS.repoPass, 'PASS');
});

beforeEach(() => {
  confirmCalls.length = 0;
  for (const id of Object.values(RUNS)) {
    gateCache.adopt(id, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-10-11T00:00:00Z' });
  }
});

afterAll(async () => {
  await app.close();
  removeScratch(dir);
});

const approve = (id: string) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: DELIVER_ORD } });

describe('crew#951 — a run with an evidence root keeps its QE verdict in the run ledger, and delivery reads it', () => {
  it('the run ledger is <evidence root>/.wicked-qe; a run without one reads its repo ledger', () => {
    expect(runQeLedgerRoot({ evidence_root: '/e/run-1' }, '/repo')).toBe(join('/e/run-1', '.wicked-qe'));
    expect(runQeLedgerRoot({ evidence_root: '  ' }, '/repo')).toBe(join('/repo', '.wicked-qe'));
    expect(runQeLedgerRoot({}, null)).toBeNull();
  });

  it('a PASS the QE unit recorded in the run ledger lets the deliver approve through, attributed', async () => {
    const res = await approve(RUNS.pass);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance).toMatchObject({ status: 'required', satisfied: true, reviewer: 'qe-reviewer' });
    expect(res.json().delivery.qeAcceptance.reason).toMatch(/^PASS/);
    expect(res.json().delivery.qeAcceptance.reason).toContain('stamped crew_run_id');
    expect(confirmCalls).toHaveLength(1);
  });

  it('a FAIL in the run ledger refuses, naming it; nothing is confirmed', async () => {
    const res = await approve(RUNS.fail);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'qe_acceptance_required', acceptance: { satisfied: false } });
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(res.json().acceptance.reason).toContain('step 3 failed');
    expect(confirmCalls).toEqual([]);
  });

  it('no verdict in the run ledger refuses, naming the run ledger; the gate stays open', async () => {
    const res = await approve(RUNS.none);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toContain(join(evidenceOf(RUNS.none), '.wicked-qe'));
    expect(res.json().error).toMatch(/deliver gate stays open/);
    expect(confirmCalls).toEqual([]);
  });

  it('a PASS in the repo ledger does not speak for a run with an evidence root', async () => {
    const res = await approve(RUNS.repoPass);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toContain(join(evidenceOf(RUNS.repoPass), '.wicked-qe'));
    expect(confirmCalls).toEqual([]);
  });

  it("crew's own WICKED_QE_LEDGER_DIR does not redirect a run ledger", async () => {
    vi.stubEnv('WICKED_QE_LEDGER_DIR', join(repoRoot, '.wicked-qe'));
    try {
      const res = await approve(RUNS.repoPass);
      expect(res.statusCode, res.body).toBe(409);
      const pass = await approve(RUNS.pass);
      expect(pass.statusCode, pass.body).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('GET /runs/:id/acceptance answers from the run ledger', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.pass}/acceptance` });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.stringify(res.json())).toContain('PASS');
    const none = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.none}/acceptance` });
    expect(JSON.stringify(none.json())).toContain(join(evidenceOf(RUNS.none), '.wicked-qe').replace(/\\/g, '\\\\'));
  });
});
