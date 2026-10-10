// wicked-core#850, codex audit EX-03 / EX-04 — crew's delivery paths against a run whose assurance
// contract (the engine's `AgentSession.assurance`) requires `qe_acceptance`, over a REAL QE ledger on
// disk (wicked-ledger's own store, as the QE pipeline writes it).
//
//   EX-03: the deliver gate's APPROVE, a gated RESUME and a post-hoc LIFT are each refused 409
//   `qe_acceptance_required` unless the newest verdict attributed to the run is a PASS — missing,
//   FAIL and unattributed all block, nothing is pushed, and the gate stays open. With a stamped PASS
//   each one goes through. A run whose contract does not require it is untouched.
//   EX-04: a post-hoc lift is recorded UNVERIFIED with the trees its script named, on the response
//   and on the run record; every gate answer carries the gated unit's receipt.
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
import { BUILTIN_WORKFLOWS, type CoreAdapter } from '../src/core/adapter.js';
import { DELIVER_PUSHED_NO_PR_MARKER, DELIVER_UNVERIFIED_MARKER, composeDeliverWorkflow } from '../src/core/deliver.js';
import { qeAcceptanceFromView } from '../src/api/delivery-assurance.js';
import type { AcceptanceView } from '../src/qe/acceptance.js';
import { composeDeliverableFloor } from '../src/core/deliverable-floor.js';
import { CREW_RUN_ID_FIELD } from '../src/qe/ledger.js';
import { removeScratch } from './setup/scratch.js';

const DELIVER_ORD = 3;
const RECEIPT = {
  mode: 'full', required: ['distinct_evaluator', 'judge', 'qe_acceptance'], ran: ['repo_checks', 'judge'], skipped: [],
  creator: 'claude', evaluator: 'codex', judge: 'codex', tree: 'aaaaaaaa', attempt: 0,
};

let dir: string;
let repoRoot: string;
let app: FastifyInstance;
const gateCache = new GateCache();
const confirmCalls: unknown[][] = [];
const deliverCalls: string[] = [];
const recorded: Array<{ action: string; runId?: string; detail?: Record<string, unknown> }> = [];

function unit(run: string, ord: number, phase: string, status: string, assurance?: unknown) {
  return {
    id: `${run}:${phase}`, session_id: run, ord, description: '', stage: 'build', phase_ref: phase,
    assigned_cli: 'claude', assigned_invocation: null, council_task_ref: null, routing: null, status,
    ...(assurance !== undefined ? { assurance } : {}),
  };
}

function view(id: string, status: string, required: string[] | null, workdir: string | null = null, qe?: Record<string, unknown>) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'codex'], status, human_confirm: 'all', unit_ix: DELIVER_ORD - 1, attempt: 0, workdir,
      repo_ref: 'repo-1', extra_write_roots: [], archived_at: null, archive_note: null,
      ...(required !== null ? { assurance: { mode: 'full', required, ...(qe !== undefined ? { qe } : {}) } } : {}),
    },
    units: [
      unit(id, 1, 'fix', 'done', RECEIPT),
      unit(id, 2, 'verify', 'done', { ...RECEIPT, ran: ['repo_checks', 'evaluator_pass'], skipped: [{ instrument: 'pinned_validator', reason: 'not_applicable', detail: null }] }),
      unit(id, DELIVER_ORD, 'deliver', status === 'completed' ? 'done' : 'pending'),
    ],
  };
}

async function ledger() {
  const { createDomainStore } = await import('wicked-ledger');
  const store = createDomainStore({ root: join(repoRoot, '.wicked-qe') });
  store.rebuildIndex();
  return store;
}

/** A QE run STAMPED with the crew run id (the explicit linkage) carrying one verdict. */
async function stampVerdict(runId: string, verdict: 'PASS' | 'FAIL'): Promise<void> {
  const store = await ledger();
  const project = store.create('projects', { name: `p-${runId}-${verdict}` });
  const scenario = store.create('scenarios', { project_id: project.id, name: `s-${runId}-${verdict}`, format_version: '1' });
  const qe = store.create('runs', {
    project_id: project.id, scenario_id: scenario.id, started_at: new Date().toISOString(), status: 'running',
    [CREW_RUN_ID_FIELD]: runId,
  } as unknown as CreateInput<'runs'>);
  store.update('runs', qe.id, { status: verdict === 'PASS' ? 'passed' : 'failed', finished_at: new Date().toISOString() });
  store.create('verdicts', { run_id: qe.id, verdict, reviewer: 'qe-test', reason: verdict === 'FAIL' ? 'step 2 failed' : null });
}

const RUNS = {
  gated: 'run-qe-gated',
  gatedFail: 'run-qe-gated-fail',
  gatedPass: 'run-qe-gated-pass',
  gatedNoReq: 'run-noqe-gated',
  done: 'run-qe-done',
  donePass: 'run-qe-done-pass',
  donePushOnly: 'run-qe-done-push-only',
  gatedWaived: 'run-qe-gated-waived',
  gatedSkipped: 'run-qe-gated-skipped',
  gatedDiffRequired: 'run-qe-gated-diff-required',
  doneWaived: 'run-qe-done-waived',
  gatedEmptyQe: 'run-qe-gated-empty',
  gatedSkipNoOperator: 'run-qe-gated-skip-plan',
  gatedUnknown: 'run-qe-gated-unknown',
  doneMalformed: 'run-qe-done-malformed',
};

/** QE-IN-APP-WORKFLOWS: the engine's decisions as `assurance.qe` carries them. */
const WAIVED = {
  status: 'waived', basis: 'diff', score: 20, threshold: 20, ord: 2, tree: 'aaaaaaaa',
  reason: 'waived: impact score 20 at or below the waiver line 20, every dimension in its lowest band (reach 20: 1 changed symbol(s))',
  reasons: ['reach 20: 1 changed symbol(s), 0 dependent(s) within 3 hops'],
};
const SKIPPED = {
  status: 'skipped', basis: 'operator', score: null, threshold: 20, ord: null, tree: null,
  reason: 'QE acceptance skipped by operator: docs-only hotfix', reasons: [],
};
const DIFF_REQUIRED = {
  status: 'required', basis: 'diff', score: 60, threshold: 20, ord: 2, tree: 'aaaaaaaa',
  reason: 'required: impact score 60 above the waiver line 20 (novelty +20: 1 new dependency(ies))', reasons: [],
};
let pushOnlyNext = false;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-delivery-assurance-'));
  repoRoot = join(dir, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  const workdir = join(dir, 'wt');
  mkdirSync(workdir, { recursive: true });
  const views = [
    view(RUNS.gated, 'awaiting_human', ['distinct_evaluator', 'judge', 'qe_acceptance']),
    view(RUNS.gatedFail, 'awaiting_human', ['qe_acceptance']),
    view(RUNS.gatedPass, 'awaiting_human', ['qe_acceptance']),
    view(RUNS.gatedNoReq, 'awaiting_human', ['distinct_evaluator', 'judge']),
    view(RUNS.done, 'completed', ['qe_acceptance'], workdir),
    view(RUNS.donePass, 'completed', ['qe_acceptance'], workdir),
    view(RUNS.donePushOnly, 'completed', ['qe_acceptance'], workdir),
    view(RUNS.gatedWaived, 'awaiting_human', ['qe_acceptance'], null, WAIVED),
    view(RUNS.gatedSkipped, 'awaiting_human', ['qe_acceptance'], null, SKIPPED),
    view(RUNS.gatedDiffRequired, 'awaiting_human', ['qe_acceptance'], null, DIFF_REQUIRED),
    view(RUNS.doneWaived, 'completed', ['qe_acceptance'], workdir, WAIVED),
    view(RUNS.gatedEmptyQe, 'awaiting_human', ['qe_acceptance'], null, {}),
    view(RUNS.gatedSkipNoOperator, 'awaiting_human', ['qe_acceptance'], null, { ...SKIPPED, basis: 'plan' }),
    view(RUNS.gatedUnknown, 'awaiting_human', ['qe_acceptance'], null, { ...WAIVED, status: 'exempt' }),
    view(RUNS.doneMalformed, 'completed', ['qe_acceptance'], workdir, { ...WAIVED, basis: 'operator' }),
  ];
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
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { runId?: string; detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.runId !== undefined ? { runId: fields.runId } : {}), ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
    readAll: vi.fn(async () => []),
  } as unknown as AuditLog;
  app = Fastify({ logger: false });
  registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' }, {
    worktreeExists: () => true,
    deliverExec: async (workdir: string) => {
      deliverCalls.push(workdir);
      if (pushOnlyNext) {
        return {
          status: 0,
          output: `${DELIVER_UNVERIFIED_MARKER} tree-before=3333333333 tree-after=4444444444\n${DELIVER_PUSHED_NO_PR_MARKER} wicked/x /srv/origin.git\n`,
        };
      }
      return {
        status: 0,
        output: `deliver: pushed wicked/x to origin\n${DELIVER_UNVERIFIED_MARKER} tree-before=1111111111 tree-after=2222222222\nhttps://github.com/o/r/pull/77\n`,
      };
    },
  });
  await app.ready();
  await stampVerdict(RUNS.gatedFail, 'FAIL');
  await stampVerdict(RUNS.gatedPass, 'PASS');
  await stampVerdict(RUNS.donePass, 'PASS');
  await stampVerdict(RUNS.donePushOnly, 'PASS');
});

beforeEach(() => {
  confirmCalls.length = 0;
  deliverCalls.length = 0;
  recorded.length = 0;
  for (const id of [RUNS.gated, RUNS.gatedFail, RUNS.gatedPass, RUNS.gatedNoReq, RUNS.gatedWaived, RUNS.gatedSkipped, RUNS.gatedDiffRequired, RUNS.gatedEmptyQe, RUNS.gatedSkipNoOperator, RUNS.gatedUnknown]) {
    gateCache.adopt(id, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
  }
});

afterAll(async () => {
  await app.close();
  removeScratch(dir);
});

const gate = (id: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: body });

describe('EX-03 — a run that requires QE acceptance delivers only on an attributed PASS', () => {
  it('the deliver gate approve is refused with NO verdict — 409 qe_acceptance_required, nothing confirmed, the gate open', async () => {
    const res = await gate(RUNS.gated, { approve: true, ord: DELIVER_ORD });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'qe_acceptance_required', acceptance: { satisfied: false, verdictId: null } });
    expect(res.json().error).toMatch(/requires QE acceptance/);
    expect(res.json().error).toMatch(/deliver gate stays open/);
    expect(confirmCalls).toEqual([]);
    expect(recorded.filter((r) => r.action === 'gate.decided')).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.gated}/gate` })).statusCode).toBe(200);
  });

  it('a gated resume is the same approve — refused the same way (no side door)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.gated}/resume` });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'qe_acceptance_required' });
    expect(confirmCalls).toEqual([]);
  });

  it('a FAIL attributed to the run refuses, naming it', async () => {
    const res = await gate(RUNS.gatedFail, { approve: true });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().acceptance.reason).toMatch(/^FAIL/);
    expect(res.json().acceptance.reason).toContain('step 2 failed');
    expect(res.json().acceptance.reviewer).toBe('qe-test');
    expect(confirmCalls).toEqual([]);
  });

  it('a PASS stamped with the run id lets the approve through, and the answer says what it checked', async () => {
    const res = await gate(RUNS.gatedPass, { approve: true, ord: DELIVER_ORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance).toMatchObject({ satisfied: true, reviewer: 'qe-test' });
    expect(res.json().delivery.qeAcceptance.reason).toMatch(/^PASS/);
    expect(confirmCalls).toHaveLength(1);
  });

  it('a reject is never held, and a run whose contract does not require QE acceptance is untouched', async () => {
    expect((await gate(RUNS.gated, { approve: false })).statusCode).toBe(200);
    const res = await gate(RUNS.gatedNoReq, { approve: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery).toEqual({ qeAcceptance: null });
  });

  it('a gated REASSIGN approves the gate too — refused the same way before anything is confirmed', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.gated}/reassign`, payload: {} });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'qe_acceptance_required' });
    expect(confirmCalls).toEqual([]);
  });

  it('walkthrough evidence alone never satisfies qe_acceptance — the LEDGER must hold an attributed PASS', () => {
    const check = qeAcceptanceFromView({ gate: { required: true, satisfied: true, verdict: null, runStatus: null, reason: 'every walkthrough sealed' }, acceptance: null } as unknown as AcceptanceView);
    expect(check.satisfied).toBe(false);
    expect(check.reason).toMatch(/no PASS attributed/);
  });

  it('the post-hoc lift of a completed run with no PASS is refused BEFORE the script runs', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.done}/deliver` });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'qe_acceptance_required' });
    expect(res.json().error).toMatch(/deliver again/);
    expect(deliverCalls).toEqual([]);
  });
});

describe('EX-04 — a post-hoc lift is recorded UNVERIFIED, with both trees', () => {
  it('the response and the run record carry verified: false, the trees the script named and the QE check', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.donePass}/deliver` });
    expect(res.statusCode, res.body).toBe(200);
    expect(deliverCalls).toHaveLength(1);
    const body = res.json();
    expect(body.prUrl).toBe('https://github.com/o/r/pull/77');
    expect(body.assurance).toMatchObject({
      verified: false, via: 'post_hoc', treeBefore: '1111111111', treeAfter: '2222222222',
      qeAcceptance: { satisfied: true },
      receipt: { mode: 'full', required: ['qe_acceptance'], ran: ['repo_checks', 'judge', 'evaluator_pass'], tree: '2222222222' },
    });
    expect(body.assurance.receipt.skipped).toEqual([{ instrument: 'pinned_validator', reason: 'not_applicable', detail: null }]);
    const delivered = recorded.find((r) => r.action === 'run.delivered');
    expect(delivered?.detail).toMatchObject({ url: body.prUrl, via: 'post-hoc', assurance: { verified: false, treeAfter: '2222222222' } });
    const run = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.donePass}` })).json();
    expect(run.run.session.delivery_assurance).toMatchObject({ verified: false, treeBefore: '1111111111', treeAfter: '2222222222' });
    // Idempotent replay answers the SAME record.
    const again = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.donePass}/deliver` });
    expect(again.json()).toEqual(body);
    expect(deliverCalls).toHaveLength(1);
  });
});

describe('EX-04 — a push-only post-hoc delivery (a non-GitHub origin) is recorded unverified too', () => {
  it('the run record carries delivery_assurance for the pushed branch', async () => {
    pushOnlyNext = true;
    try {
      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.donePushOnly}/deliver` });
      expect(res.statusCode, res.body).toBe(409); // push-only: no PR URL to answer with (N1)
    } finally {
      pushOnlyNext = false;
    }
    const delivered = recorded.find((r) => r.action === 'run.delivered');
    expect(delivered?.detail).toMatchObject({ via: 'post-hoc', assurance: { verified: false, treeAfter: '4444444444' } });
    const run = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.donePushOnly}` })).json();
    expect(run.run.session.delivery).toBe('pushed');
    expect(run.run.session.delivery_assurance).toMatchObject({ verified: false, treeBefore: '3333333333', treeAfter: '4444444444' });
  });
});

describe('every gate answer carries the gated unit receipt', () => {
  it('GET /runs/:id/gate serves the receipt of the unit the gate holds (null when the unit has none)', async () => {
    gateCache.adopt(RUNS.gatedNoReq, { ord: 2, prompt: 'Approve verify?', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
    const g = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.gatedNoReq}/gate` })).json();
    expect(g.assurance).toMatchObject({ ran: ['repo_checks', 'evaluator_pass'], evaluator: 'codex' });
    const d = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUNS.gated}/gate` })).json();
    expect(d.assurance).toBeNull();
  });
});

describe('EX-03 at launch — a workflow that requires QE acceptance never delivers unattended', () => {
  it('deliverGate: "auto" on such a workflow is a 400 naming why; nothing launches', async () => {
    const launched: unknown[] = [];
    const a = Fastify({ logger: false });
    registerRoutes(a, {
      getWorkflow: (id: string) => (id === 'qe-gated' ? { id, phases: [], required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] } : null),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      getSettings: async () => ({}),
      launchRun: vi.fn(async (input: unknown) => { launched.push(input); return 'x'; }),
    } as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
    await a.ready();
    const res = await a.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'p', workflow: 'qe-gated', deliverGate: 'auto', clisJson: '[]' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatch(/requires QE acceptance/);
    expect(launched).toEqual([]);
    await a.close();
  });
});

describe('the per-run def copies keep the assurance contract', () => {
  it('composeDeliverWorkflow and composeDeliverableFloor carry required_instruments (dropping it would launch the default contract)', () => {
    const feature = BUILTIN_WORKFLOWS.find((w) => w.id === 'feature')!;
    const base = { ...feature, required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] };
    expect(composeDeliverWorkflow(base, 'run-1').required_instruments).toEqual(base.required_instruments);
    expect(composeDeliverableFloor(base, 'run-1', ['/tmp/out.html']).required_instruments).toEqual(base.required_instruments);
    const bare = { ...feature };
    delete bare.required_instruments;
    expect('required_instruments' in composeDeliverWorkflow(bare, 'run-1')).toBe(false);
  });
});

describe('QE-IN-APP-WORKFLOWS — the delivery reads the run\'s QE decision', () => {
  it('a score-WAIVED run delivers without a verdict, and the answer says waived and why', async () => {
    const res = await gate(RUNS.gatedWaived, { approve: true, ord: DELIVER_ORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance).toEqual({
      status: 'waived', satisfied: true, reason: WAIVED.reason, verdictId: null, reviewer: null,
    });
    expect(confirmCalls).toHaveLength(1);
  });

  it('an operator-SKIPPED run delivers with the label naming the reason', async () => {
    const res = await gate(RUNS.gatedSkipped, { approve: true, ord: DELIVER_ORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().delivery.qeAcceptance).toMatchObject({
      status: 'skipped', satisfied: true, reason: 'QE acceptance skipped by operator: docs-only hotfix',
    });
  });

  it('a diff decision of REQUIRED (high score) with no PASS is refused 409, the check saying required', async () => {
    const res = await gate(RUNS.gatedDiffRequired, { approve: true, ord: DELIVER_ORD });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'qe_acceptance_required', acceptance: { status: 'required', satisfied: false } });
    expect(confirmCalls).toEqual([]);
  });

  it('codex r1: a malformed or mismatched decision never bypasses the ledger — empty, a skip not by the operator, an unknown status', async () => {
    for (const id of [RUNS.gatedEmptyQe, RUNS.gatedSkipNoOperator, RUNS.gatedUnknown]) {
      const res = await gate(id, { approve: true, ord: DELIVER_ORD });
      expect(res.statusCode, `${id}: ${res.body}`).toBe(409);
      expect(res.json()).toMatchObject({ code: 'qe_acceptance_required', acceptance: { status: 'required', satisfied: false } });
    }
    const resume = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.gatedUnknown}/resume` });
    expect(resume.statusCode, resume.body).toBe(409);
    const lift = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.doneMalformed}/deliver` });
    expect(lift.statusCode, lift.body).toBe(409);
    expect(confirmCalls).toEqual([]);
  });

  it('a waived post-hoc delivery runs the script; its receipt names the waiver and carries the decision', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUNS.doneWaived}/deliver` });
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json().assurance;
    expect(a.qeAcceptance).toMatchObject({ status: 'waived', satisfied: true });
    expect(a.receipt.qe).toEqual(WAIVED);
    expect(a.receipt.skipped).toContainEqual({ instrument: 'qe_acceptance', reason: 'qe_waived_by_score', detail: WAIVED.reason });
  });
});

describe('QE-IN-APP-WORKFLOWS at launch — the operator\'s explicit skip or force is forwarded, never inferred', () => {
  async function launchWith(payload: Record<string, unknown>) {
    const launched: Array<Record<string, unknown>> = [];
    const a = Fastify({ logger: false });
    registerRoutes(a, {
      getWorkflow: (id: string) => (id === 'qe-gated' ? { id, phases: [], required_instruments: ['distinct_evaluator', 'judge', 'qe_acceptance'] } : null),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      getSettings: async () => ({}),
      launchRun: vi.fn(async (input: Record<string, unknown>) => { launched.push(input); return 'x'; }),
    } as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
    await a.ready();
    const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', workflow: 'qe-gated', clisJson: '[]', ...payload } });
    await a.close();
    return { res, launched };
  }

  it('skipQeAcceptance forwards its reason; forceQeAcceptance forwards true; neither sent forwards nothing', async () => {
    const skip = await launchWith({ skipQeAcceptance: { reason: 'docs-only hotfix' } });
    expect(skip.res.statusCode, skip.res.body).toBe(201);
    expect(skip.launched[0]!['skipQeAcceptanceReason']).toBe('docs-only hotfix');
    expect('forceQeAcceptance' in skip.launched[0]!).toBe(false);
    const force = await launchWith({ forceQeAcceptance: true });
    expect(force.launched[0]!['forceQeAcceptance']).toBe(true);
    expect('skipQeAcceptanceReason' in force.launched[0]!).toBe(false);
    const none = await launchWith({ forceQeAcceptance: false });
    expect('forceQeAcceptance' in none.launched[0]! || 'skipQeAcceptanceReason' in none.launched[0]!).toBe(false);
  });

  it('a skip with an empty reason, or a skip beside a force, is a 400; nothing launches', async () => {
    for (const payload of [{ skipQeAcceptance: { reason: '  ' } }, { skipQeAcceptance: {} }, { skipQeAcceptance: { reason: 'x' }, forceQeAcceptance: true }]) {
      const { res, launched } = await launchWith(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(launched).toEqual([]);
    }
  });

  it('codex r1: a def that shadows a QE built-in preset\'s name never speaks for the preset the engine runs', async () => {
    const launched: unknown[] = [];
    const a = Fastify({ logger: false });
    registerRoutes(a, {
      getWorkflow: (id: string) => ({ id, phases: [] }),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      getSettings: async () => ({}),
      launchRun: vi.fn(async (input: unknown) => { launched.push(input); return 'x'; }),
    } as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
    await a.ready();
    for (const workflow of ['feature', 'migration']) {
      const res = await a.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'p', workflow, deliverGate: 'auto', clisJson: '[]' } });
      expect(res.statusCode, `${workflow}: ${res.body}`).toBe(400);
      expect(res.json().error).toMatch(/requires QE acceptance/);
    }
    expect(launched).toEqual([]);
    await a.close();
  });

  it('an explicit skip lets a QE-requiring workflow deliver unattended (no verdict is left to check)', async () => {
    const { res, launched } = await launchWith({ deliverGate: 'auto', skipQeAcceptance: { reason: 'release train, QE ran upstream' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(launched[0]!['autoDeliver']).toBe(true);
  });
});
