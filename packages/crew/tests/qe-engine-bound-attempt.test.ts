// crew#1560 — at deliver, the QE run the ENGINE bound on the latest QE attempt decides which of the
// run's verdicts still count, even when the run has no verified tree.
//
// Live case (run 4995811f, crew 0.18.16, 2026-11-16): the floor was overridden by the operator, so
// the session has no `verified_tree`, and every QE `gateEvaluated` carried `assurance.tree = null`.
// A re-plan moved the QE unit from ord 4 to ord 5. Its QE runs: cb8c59f1 (INCONCLUSIVE, 14:45),
// b95cd89c (PASS, 15:28) and 706d2fb2 (PASS, 16:17) — every verdict stamped with the crew run. The
// tree and attempt scoping were both off, so deny-dominates across the three QE runs let the oldest
// INCONCLUSIVE outvote both PASSes and Deliver stayed disabled; the operator had to skip QE.
//
//   stale INCONCLUSIVE, then the engine-bound PASS, no verified tree → delivers on the PASS;
//   a FAIL recorded after the bound run began (another QE run)       → still refused;
//   the bound run's own FAIL                                          → refused;
//   a QE unit whose record bound no run                               → no cut (as before: refused);
//   the bound record judged another tree than the verified tree      → no cut (as before: refused).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { removeScratch } from './setup/scratch.js';
import { withRunViews } from './support/run-views.js';

const DELIVER_ORD = 8;
const QE_ORD = 5;
const T0 = Date.parse('2026-11-16T14:00:00.000Z');
const TREE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUIRED = {
  status: 'required', basis: 'operator', score: null, threshold: 20, ord: null, tree: null,
  reason: 'QE acceptance forced by operator: no score waives it', reasons: [],
};
const min = (n: number) => T0 + n * 60_000;

const RUNS = {
  staleInconclusiveThenBoundPass: 'run-1560-stale',
  failAfterTheBoundRunBegan: 'run-1560-later-fail',
  boundRunFailed: 'run-1560-bound-fail',
  unboundRecord: 'run-1560-unbound',
  boundOnAnotherTree: 'run-1560-other-tree',
};

/** What each run's QE unit's engine record says (`units[].qe_review`). */
const REVIEW: Record<string, Record<string, unknown>> = {
  [RUNS.staleInconclusiveThenBoundPass]: { outcome: 'pass', reason: 'bound PASS', qe_run_id: 'qe-3', tree: TREE_B, verdict: 'PASS' },
  [RUNS.failAfterTheBoundRunBegan]: { outcome: 'pass', reason: 'bound PASS', qe_run_id: 'qe-3', tree: TREE_B, verdict: 'PASS' },
  [RUNS.boundRunFailed]: { outcome: 'fail', reason: 'bound FAIL', qe_run_id: 'qe-3', tree: TREE_B, verdict: 'FAIL' },
  [RUNS.unboundRecord]: { outcome: 'pass', reason: 'bound PASS', tree: TREE_B, verdict: 'PASS' },
  [RUNS.boundOnAnotherTree]: { outcome: 'pass', reason: 'bound PASS', qe_run_id: 'qe-3', tree: TREE_A, verdict: 'PASS' },
};

let dir: string;
let app: FastifyInstance;
const audit = { record: vi.fn(() => Date.now()), readAll: vi.fn(async () => []) } as unknown as AuditLog;
const gateCache = new GateCache();
const confirmCalls: unknown[][] = [];
const evidenceOf = (id: string) => join(dir, 'walkthroughs', id);

/** The 4995811f log shape: the QE unit dispatched at ord 4, then (after a re-plan) at ord 5; every
 *  QE gate judged no tree (`assurance.tree` null); no `qeAcceptanceDecided` before the deliver. */
const eventsOf = (id: string) => [
  { type: 'sessionStarted', session: id, ts: T0, seq: 1 },
  { type: 'unitDispatched', session: id, ord: 4, attempt: 0, ts: min(30), seq: 2 },
  { type: 'gateEvaluated', session: id, ord: 4, assurance: { attempt: 0, tree: null }, ts: min(46), seq: 3 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 2, ts: min(84), seq: 4 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 2, tree: null }, ts: min(90), seq: 5 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 3, ts: min(131), seq: 6 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 3, tree: null }, ts: min(138), seq: 7 },
];

function view(id: string) {
  const unit = (ord: number, phase: string, status: string) => ({
    id: `${id}:${phase}`, session_id: id, ord, description: '', stage: 'build', phase_ref: phase,
    assigned_cli: 'claude', assigned_invocation: null, council_task_ref: null, routing: null, status,
  });
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'codex'], status: 'awaiting_human', human_confirm: 'all', unit_ix: DELIVER_ORD - 1, attempt: 0,
      workdir: join(dir, 'wt', id), repo_ref: 'repo-1', extra_write_roots: [], evidence_root: evidenceOf(id),
      // The floor was overridden: no verified tree (the boundOnAnotherTree run has one).
      verified_tree: id === RUNS.boundOnAnotherTree ? TREE_B : null,
      archived_at: null, archive_note: null,
      assurance: { mode: 'full', required: ['distinct_evaluator', 'judge', 'qe_acceptance'], qe: REQUIRED },
    },
    units: [
      unit(2, 'build', 'done'),
      unit(4, 'review', 'done'),
      { ...unit(QE_ORD, 'test', 'done'), qe_acceptance: REQUIRED, qe_review: REVIEW[id] },
      unit(DELIVER_ORD, 'deliver', 'pending'),
    ],
  };
}

/** A QE run row and one verdict on it, as wicked-ledger writes them; everything stamped. */
function qeRun(crewRun: string, qeRunId: string, createdAt: number, verdicts: Array<[string, 'PASS' | 'FAIL', number, string?]>) {
  const root = join(evidenceOf(crewRun), '.wicked-qe');
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  const iso = (t: number) => new Date(t).toISOString();
  writeFileSync(join(root, 'runs', `${qeRunId}.json`), JSON.stringify({
    id: qeRunId, project_id: 'p', scenario_id: 's', created_at: iso(createdAt), started_at: iso(createdAt + 60_000),
    status: 'running', crew_run_id: crewRun, evidence_path: join(root, 'evidence', qeRunId),
  }));
  for (const [vid, verdict, at, reason] of verdicts) {
    writeFileSync(join(root, 'verdicts', `${vid}.json`), JSON.stringify({
      id: vid, run_id: qeRunId, verdict, created_at: iso(at), reviewer: 'acceptance-test-reviewer',
      reason: reason ?? (verdict === 'PASS' ? 'All assertions satisfied' : `FAIL ${vid}`), crew_run_id: crewRun,
      review_session: `nonce-${vid}`,
    }));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-1560-'));
  mkdirSync(join(dir, 'repo'), { recursive: true });
  const views = Object.values(RUNS).map(view);
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => structuredClone(views)),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'repo', root_path: join(dir, 'repo') }]),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    getWorkflow: () => null,
    interactionRequests: vi.fn(async (id: string) => {
      const open = gateCache.get(id);
      return open === undefined ? [] : [{ kind: 'gate', ord: open.ord, prompt: open.prompt, created_at: open.receivedAt }];
    }),
    runEvents: vi.fn(async (id: string) => eventsOf(id)),
    listConformanceClaims: vi.fn(async () => []),
    confirmGate: vi.fn(async (...args: unknown[]) => {
      confirmCalls.push(args);
      return 'executing';
    }),
  };
  app = Fastify({ logger: false });
  registerRoutes(app, withRunViews(mockAdapter as unknown as CoreAdapter), gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' }, {
    worktreeExists: () => true,
    deliverExec: async () => ({ status: 0, output: '' }),
  });
  await app.ready();
  for (const id of Object.values(RUNS)) {
    // The 4995811f ledger: an INCONCLUSIVE on QE run 1, PASSes on QE runs 2 and 3 (3 = the bound one).
    qeRun(id, 'qe-1', min(40), [['v-1', 'FAIL', min(45), '[scenario-defect] inconclusive — evidence manifest fails manifest-2.1 validation']]);
    qeRun(id, 'qe-2', min(84), [['v-2', 'PASS', min(88)]]);
  }
  qeRun(RUNS.staleInconclusiveThenBoundPass, 'qe-3', min(131), [['v-3', 'PASS', min(137)]]);
  qeRun(RUNS.failAfterTheBoundRunBegan, 'qe-3', min(131), [['v-3', 'PASS', min(137)]]);
  qeRun(RUNS.failAfterTheBoundRunBegan, 'qe-4', min(132), [['v-4', 'FAIL', min(136)]]);
  qeRun(RUNS.boundRunFailed, 'qe-3', min(131), [['v-3', 'FAIL', min(137)]]);
  qeRun(RUNS.unboundRecord, 'qe-3', min(131), [['v-3', 'PASS', min(137)]]);
  qeRun(RUNS.boundOnAnotherTree, 'qe-3', min(131), [['v-3', 'PASS', min(137)]]);
});

beforeEach(() => {
  confirmCalls.length = 0;
  for (const id of Object.values(RUNS)) {
    gateCache.adopt(id, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-11-16T16:31:00Z' });
  }
});

afterAll(async () => {
  await app.close();
  removeScratch(dir);
});

const decide = (id: string) =>
  app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: DELIVER_ORD } });

describe('crew#1560 — the engine-bound QE run of the latest attempt decides what counts', () => {
  it('a stale INCONCLUSIVE no longer outvotes the bound PASS when the run has no verified tree (4995811f)', async () => {
    const res = await decide(RUNS.staleInconclusiveThenBoundPass);
    expect(res.statusCode, res.body).toBe(200);
    const check = res.json().delivery.qeAcceptance;
    expect(check).toMatchObject({ status: 'required', satisfied: true, verdictId: 'v-3' });
    expect(check.reason).toMatch(/^PASS/);
    expect(check.reason).toContain('2 earlier verdicts, recorded before the QE run the engine bound on the latest QE attempt (qe-3), no longer count');
    expect(confirmCalls).toHaveLength(1);
    const acc = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.staleInconclusiveThenBoundPass}/acceptance` });
    expect(acc.json().acceptance.verdict.id, acc.body).toBe('v-3');
  });

  it('a FAIL recorded after the bound run began still refuses (deny-dominates since the cut)', async () => {
    const res = await decide(RUNS.failAfterTheBoundRunBegan);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });

  it("the bound run's own FAIL refuses", async () => {
    const res = await decide(RUNS.boundRunFailed);
    expect(res.statusCode, res.body).toBe(409);
    expect(confirmCalls).toEqual([]);
  });

  it('a record that bound no QE run makes no cut: the stale INCONCLUSIVE still refuses, as before', async () => {
    const res = await decide(RUNS.unboundRecord);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
  });

  it('a bound record on another tree than the verified tree makes no cut', async () => {
    const res = await decide(RUNS.boundOnAnotherTree);
    expect(res.statusCode, res.body).toBe(409);
  });
});
