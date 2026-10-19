// crew#971 — a QE verdict counts only for the tree it judged.
//
// Live case (rig run 7d8c9c98): the QE unit's attempt 1 recorded FAIL, a send-back fixed the work,
// attempt 3 recorded PASS on the new tree — and the deliver gate was still refused, because
// deny-dominates held across EVERY verdict of the run, so a FAIL on a superseded tree blocked the
// delivery forever. Each verdict is now tied to the QE attempt it was recorded in (dispatch → that
// attempt's gate, whose `assurance.tree` is the tree judged); only verdicts that judged the run's
// CURRENT deliverable tree (`session.verified_tree`) count, deny-dominates holding within them.
//
//   FAIL on A, send-back, PASS on B (current B) → the deliver approve goes through;
//   FAIL on A, FAIL on B                          → refused (the current tree failed);
//   PASS on A only (current B)                    → refused (no verdict judged the current tree).
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
import { qeAttemptsFromEvents } from '../src/qe/acceptance.js';
import { removeScratch } from './setup/scratch.js';

const DELIVER_ORD = 3;
const QE_ORD = 2;
const T0 = Date.parse('2026-10-11T08:00:00.000Z');
const TREE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TREE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REQUIRED = {
  status: 'required', basis: 'diff', score: 50, threshold: 20, ord: QE_ORD, tree: TREE_A,
  reason: 'required: impact score 50 above the waiver line 20', reasons: [],
};

const RUNS = { passAfterSendBack: 'run-971-pass-b', failOnCurrent: 'run-971-fail-b', passOnSuperseded: 'run-971-pass-a', failOutsideWindows: 'run-971-fail-late' };

let dir: string;
let app: FastifyInstance;
const gateCache = new GateCache();
const confirmCalls: unknown[][] = [];
const evidenceOf = (id: string) => join(dir, 'walkthroughs', id);

/** The 7d8c9c98 event shape: QE attempt 0 judged tree A, the send-back's attempt 1 judged tree B. */
const events = (id: string) => [
  { type: 'sessionStarted', session: id, ts: T0, seq: 1 },
  { type: 'qeAcceptanceDecided', session: id, ord: QE_ORD, ts: T0 + 10, seq: 2 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 0, ts: T0 + 100, seq: 3 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 0, tree: TREE_A }, ts: T0 + 200, seq: 4 },
  { type: 'unitDispatched', session: id, ord: QE_ORD, attempt: 1, ts: T0 + 300, seq: 5 },
  { type: 'gateEvaluated', session: id, ord: QE_ORD, assurance: { attempt: 1, tree: TREE_B }, ts: T0 + 400, seq: 6 },
];

function view(id: string) {
  const unit = (ord: number, phase: string, status: string) => ({
    id: `${id}:${phase}`, session_id: id, ord, description: '', stage: 'build', phase_ref: phase,
    assigned_cli: 'claude', assigned_invocation: null, council_task_ref: null, routing: null, status,
  });
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'pi'], status: 'awaiting_human', human_confirm: 'all', unit_ix: DELIVER_ORD - 1, attempt: 0,
      workdir: join(dir, 'wt', id), repo_ref: 'repo-1', extra_write_roots: [], evidence_root: evidenceOf(id),
      verified_tree: TREE_B, archived_at: null, archive_note: null,
      assurance: { mode: 'full', required: ['distinct_evaluator', 'judge', 'qe_acceptance'], qe: REQUIRED },
    },
    units: [unit(1, 'fix', 'done'), { ...unit(QE_ORD, 'verify', 'done'), qe_acceptance: REQUIRED }, unit(DELIVER_ORD, 'deliver', 'pending')],
  };
}

/** One QE run + its verdict, as canonical JSON (what wicked-ledger writes), stamped with the crew run. */
function verdictAt(runId: string, n: number, verdict: 'PASS' | 'FAIL', at: number) {
  const root = join(evidenceOf(runId), '.wicked-qe');
  mkdirSync(join(root, 'runs'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  const iso = new Date(at).toISOString();
  const qeRun = `qe-${runId}-${n}`;
  writeFileSync(join(root, 'runs', `${qeRun}.json`), JSON.stringify({ id: qeRun, created_at: iso, started_at: iso, status: verdict === 'PASS' ? 'passed' : 'failed', crew_run_id: runId }));
  writeFileSync(join(root, 'verdicts', `v-${runId}-${n}.json`), JSON.stringify({ id: `v-${runId}-${n}`, created_at: iso, run_id: qeRun, verdict, reviewer: 'qe-reviewer', reason: verdict === 'FAIL' ? `FAIL #${n}` : null, crew_run_id: runId }));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-qe-per-tree-'));
  mkdirSync(join(dir, 'repo'), { recursive: true });
  const views = Object.values(RUNS).map(view);
  const mockAdapter = {
    sessionsDetail: vi.fn(async () => structuredClone(views)),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    listRepos: vi.fn(async () => [{ id: 'repo-1', name: 'repo', root_path: join(dir, 'repo') }]),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    getWorkflow: () => null,
    // The engine's durable open-gate row for the gate a test parks its run at, written with the
    // pause: here the record and the cache agree. A decision is authorized by the record, never the
    // cache (crew#1083 round 3); the disagreeing case is pinned in gate-ord-route.test.ts.
    interactionRequests: vi.fn(async (id: string) => {
      const open = gateCache.get(id);
      return open === undefined ? [] : [{ kind: 'gate', ord: open.ord, prompt: open.prompt, created_at: open.receivedAt }];
    }),
    runEvents: vi.fn(async (id: string) => events(id)),
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
  // FAIL inside attempt 0 (tree A), PASS inside attempt 1 (tree B).
  verdictAt(RUNS.passAfterSendBack, 1, 'FAIL', T0 + 150);
  verdictAt(RUNS.passAfterSendBack, 2, 'PASS', T0 + 350);
  verdictAt(RUNS.failOnCurrent, 1, 'FAIL', T0 + 150);
  verdictAt(RUNS.failOnCurrent, 2, 'FAIL', T0 + 350);
  verdictAt(RUNS.passOnSuperseded, 1, 'PASS', T0 + 150);
  // PASS on B, then a FAIL recorded after every gate (a late re-review): not shown to be about another tree.
  verdictAt(RUNS.failOutsideWindows, 1, 'PASS', T0 + 350);
  verdictAt(RUNS.failOutsideWindows, 2, 'FAIL', T0 + 500);
});

beforeEach(() => {
  confirmCalls.length = 0;
  for (const id of Object.values(RUNS)) {
    gateCache.adopt(id, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-10-11T09:00:00Z' });
  }
});

afterAll(async () => {
  await app.close();
  removeScratch(dir);
});

const approve = (id: string) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: { approve: true, ord: DELIVER_ORD } });

describe('crew#971 — a QE verdict counts only for the tree it judged', () => {
  it('reads each QE attempt window and the tree its gate judged from the event log', () => {
    expect(qeAttemptsFromEvents(events('x') as never)).toEqual([
      { start: T0 + 100, end: T0 + 200, tree: TREE_A },
      { start: T0 + 300, end: T0 + 400, tree: TREE_B },
    ]);
  });

  it('FAIL on tree A, send-back, PASS on tree B: the deliver approve goes through on the PASS', async () => {
    const res = await approve(RUNS.passAfterSendBack);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance).toMatchObject({ status: 'required', satisfied: true });
    expect(res.json().delivery.qeAcceptance.reason).toMatch(/^PASS/);
    expect(confirmCalls).toHaveLength(1);
  });

  it('a FAIL on the current tree still refuses (deny-dominates within the tree)', async () => {
    const res = await approve(RUNS.failOnCurrent);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });

  it('a FAIL recorded outside every QE attempt still counts — only a provably superseded verdict drops (codex r1)', async () => {
    const res = await approve(RUNS.failOutsideWindows);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(confirmCalls).toEqual([]);
  });

  it('a PASS that judged only a superseded tree is no verdict for the current one: refused', async () => {
    const res = await approve(RUNS.passOnSuperseded);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toContain(`no QE verdict judged the run's current tree ${TREE_B}`);
    expect(res.json().acceptance.reason).toContain('1 verdict judged a superseded tree');
    expect(confirmCalls).toEqual([]);
  });
});
