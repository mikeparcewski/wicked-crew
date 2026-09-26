// crew#481 / F-BM-006 (list half) — DEF-AWARE delivery classification (DES-L8 r2 §5 PR-8A; D-14).
//
// A completed `capture-learnings` / `onboarding` / `domain-graph-slice` run read `delivery:
// 'stranded'` (live worktree) or `'vacuous'` (clean tree / reaped) although its DEFINITION could
// never have delivered: no deliver unit, no code-work phase. Nine onboarding runs on the board read
// "NEEDS ME — stranded". The fix is ONE predicate — `runCanDeliver(view, def)` — evaluated INSIDE
// `deliveryStateOf` / `deliveryStateWithVacuity` (fourth argument), so the run DTOs (via the cache),
// the campaigns rollup and the resume 409 classify from the same fn. Pins:
//
//   EQUIVALENCE (adjudicated §4.8) — pinned against the LIVE `POST /runs` closure, not a copy: see
//     tests/delivery-classification-launch-rule.test.ts (drives the route per shipped def and reads
//     the `run.launched` audit `detail.deliver` the inline rule produced);
//   TABLE — `runCanDeliver` per shipped def: the system/recon defs answer false; feature / bug /
//     migration / qe-author-tests answer true; a `<uuid>:deliver` unit answers true whatever the
//     def; `def === null` (free-text `wf-…`, unknown def) answers true — today's candidacy;
//   DERIVATION — `canDeliver = false` ⇒ `'none'` with a live DIRTY worktree, AFTER the url check
//     (a recorded PR always wins) and with ZERO probe calls (the git pair is never spent);
//   WIRE — through `registerRoutes` with a registry-bearing adapter: a completed capture-learnings
//     view reads `'none'` on GET /runs AND GET /runs/:id, cold cache and after a sweep, 0 probes; a
//     completed `bug` view with a deliver unit + dirty tree reads `'stranded'` exactly as today; a
//     free-text `wf-…` run is untouched; the campaigns rollup answers the same `'none'`.
//
// Fastify inject() with a mock adapter (no NAPI), mirroring delivery-cache.test.ts.

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import {
  DeliveryIndex,
  deliveryStateOf,
  deliveryStateWithVacuity,
  canDeliverResolver,
  isCodeWorkDef,
  phaseIdOf,
  runCanDeliver,
  type VacuityProbes,
} from '../src/api/delivery-index.js';
import { DeliveryDerivationCache } from '../src/api/delivery-cache.js';
import { AuditLog } from '../src/api/audit.js';
import { GroupIndex } from '../src/api/group-index.js';
import { buildGroups, sessionsById } from '../src/campaigns/rollup.js';
import { runWorkflowDef } from '../src/core/run-identity.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import { QE_AUTHOR_TESTS_WORKFLOW_DEF } from '../src/qe/author-workflow.js';
import { DELIVER_PHASE_ID } from '../src/core/deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView, WorkUnit, WorkflowDef } from '../src/core/types.js';

/** Every def crew ships: the built-ins plus the qe author def (`author-workflow.ts:291` executes_code). */
const SHIPPED: WorkflowDef[] = [...BUILTIN_WORKFLOWS, QE_AUTHOR_TESTS_WORKFLOW_DEF];

function unit(id: string, over: Partial<WorkUnit> = {}): WorkUnit {
  return { id, ord: 1, status: 'done', ...over } as unknown as WorkUnit;
}

function view(
  id: string,
  over: {
    workflow_id?: string;
    status?: string;
    repo_ref?: string | null;
    workdir?: string | null;
    units?: WorkUnit[];
  } = {},
): SessionView {
  return {
    session: {
      id,
      workflow_id: over.workflow_id ?? `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: over.status ?? 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: over.workdir ?? null,
      repo_ref: over.repo_ref ?? null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: over.units ?? [],
  } as unknown as SessionView;
}

/** Units shaped like a planned def-driven run: `<runId>:<phase>` per phase. */
function unitsOf(runId: string, def: WorkflowDef, extra: string[] = []): WorkUnit[] {
  return [...def.phases.map((p) => p.id), ...extra].map((phase, i) =>
    unit(`${runId}:${phase}`, { ord: i + 1 }),
  );
}

const NEVER_DELIVERS = [
  'chat',
  'onboarding',
  'survey-repo',
  'capture-learnings',
  'domain-graph-slice',
  'memories',
  'steering-author',
  'collab',
];
const CANDIDATES = ['feature', 'bug', 'migration', 'qe-author-tests'];

describe('isCodeWorkDef — the role clause (the LIVE-rule equivalence pin is tests/delivery-classification-launch-rule.test.ts, adjudicated §4.8)', () => {
  it('an evaluator-only executes_code phase is NOT code work (the role clause), a creator/neutral one is', () => {
    const base = BUILTIN_WORKFLOWS.find((w) => w.id === 'chat')!;
    const evaluatorOnly: WorkflowDef = {
      ...base,
      phases: base.phases.map((p) => ({ ...p, executes_code: true, role: 'evaluator' })),
    };
    const neutral: WorkflowDef = {
      ...base,
      phases: base.phases.map((p) => ({ ...p, executes_code: true, role: 'neutral' })),
    };
    expect(isCodeWorkDef(evaluatorOnly)).toBe(false);
    expect(isCodeWorkDef(neutral)).toBe(true);
  });
});

describe('runCanDeliver — the answer per shipped def (D-14; the des-review-L8 table)', () => {
  it.each(NEVER_DELIVERS)('%s: no deliver unit, no code-work phase ⇒ false', (id) => {
    const def = SHIPPED.find((w) => w.id === id);
    expect(def, `shipped def ${id} exists`).toBeDefined();
    const v = view('r', { workflow_id: id, repo_ref: 'repo', workdir: '/wt', units: unitsOf('r', def!) });
    expect(runCanDeliver(v, def!)).toBe(false);
  });

  it.each(CANDIDATES)('%s: a code-work def ⇒ true (candidate — stranded/vacuous/none by stat + probes as today)', (id) => {
    const def = SHIPPED.find((w) => w.id === id);
    expect(def, `shipped def ${id} exists`).toBeDefined();
    const v = view('r', { workflow_id: id, repo_ref: 'repo', workdir: '/wt', units: unitsOf('r', def!) });
    expect(runCanDeliver(v, def!)).toBe(true);
  });

  it('a `<uuid>:deliver` unit ⇒ true whatever the def (an operator overlay carrying deliver)', () => {
    const def = SHIPPED.find((w) => w.id === 'capture-learnings')!;
    const v = view('r', {
      workflow_id: 'capture-learnings',
      repo_ref: 'repo',
      workdir: '/wt',
      units: unitsOf('r', def, [DELIVER_PHASE_ID]),
    });
    expect(runCanDeliver(v, def)).toBe(true);
  });

  it('def === null (free-text wf-…, or a def the registry no longer holds) ⇒ true — never narrowed on a guess', () => {
    const v = view('r', { repo_ref: 'repo', workdir: '/wt', units: [unit('r:u1'), unit('r:u2')] });
    expect(runCanDeliver(v, null)).toBe(true);
    expect(runWorkflowDef(v, SHIPPED)).toBeNull(); // and that IS what the registry answers for it
  });

  it('phaseIdOf reads the `<base>:<phase>` suffix and answers "" for a colon-less id', () => {
    expect(phaseIdOf('abc:deliver')).toBe('deliver');
    expect(phaseIdOf('a:b:c')).toBe('b:c');
    expect(phaseIdOf('u1')).toBe('');
  });
});

describe('canDeliverResolver — the read-path closure never throws: no def ⇒ today\'s candidacy', () => {
  it('a minimal session (no workflow_id, no units — the auth-required suite\'s shape) is a candidate, not a 500', () => {
    const minimal = { session: { id: 'r', status: 'completed', repo_ref: 'repo', workdir: '/wt' }, units: undefined } as unknown as SessionView;
    expect(canDeliverResolver(() => SHIPPED)(minimal)).toBe(true);
    expect(canDeliverResolver(() => SHIPPED)({ session: { id: 'r', status: 'completed' } } as unknown as SessionView)).toBe(true);
  });
  it('a registry that throws or answers nothing resolves no def ⇒ candidate — and the throw is SAID on the log, never swallowed', () => {
    const capture = SHIPPED.find((w) => w.id === 'capture-learnings')!;
    const v = view('r', { workflow_id: 'capture-learnings', repo_ref: 'repo', workdir: '/wt', units: unitsOf('r', capture) });
    const log = vi.fn();
    expect(canDeliverResolver(() => { throw new Error('registry down'); }, log)(v)).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toMatch(/delivery classification: the workflow registry could not answer for r .*registry down/);
    expect(canDeliverResolver(() => { throw new Error('registry down'); })(v)).toBe(true); // no log wired = still no throw
    expect(canDeliverResolver(() => undefined as unknown as WorkflowDef[])(v)).toBe(true);
    expect(canDeliverResolver(() => SHIPPED)(v)).toBe(false);
  });
});

describe('deliveryStateOf / deliveryStateWithVacuity — canDeliver = false answers none, after the url check, probe-free', () => {
  const live = { status: 'completed', repo_ref: 'repo', workdir: '/wt', id: 'r' } as const;

  it("canDeliver=false + a live worktree ⇒ 'none' (was 'stranded')", () => {
    expect(deliveryStateOf(live, undefined, () => true, false)).toEqual({ delivery: 'none' });
    // The default (omitted) is today's behaviour:
    expect(deliveryStateOf(live, undefined, () => true)).toEqual({ delivery: 'stranded' });
    expect(deliveryStateOf(live, undefined, () => true, true)).toEqual({ delivery: 'stranded' });
  });

  it('a recorded PR url still wins — whatever the def', () => {
    expect(deliveryStateOf(live, 'https://x/pull/7', () => true, false)).toEqual({
      delivery: 'delivered',
      deliverUrl: 'https://x/pull/7',
    });
  });

  it('the vacuity split spends NO probe on a run that could never have delivered', async () => {
    const worktreeIsClean = vi.fn(async () => true);
    const runBranchIsEmpty = vi.fn(async () => true);
    const probes: VacuityProbes = { worktreeExists: () => true, worktreeIsClean, runBranchIsEmpty };
    expect(await deliveryStateWithVacuity(live, undefined, probes, false)).toEqual({ delivery: 'none' });
    // reaped shape too — the branch probe is not consulted either
    expect(
      await deliveryStateWithVacuity({ ...live, workdir: '/gone' }, undefined, { ...probes, worktreeExists: () => false }, false),
    ).toEqual({ delivery: 'none' });
    expect(worktreeIsClean).not.toHaveBeenCalled();
    expect(runBranchIsEmpty).not.toHaveBeenCalled();
    // and with canDeliver = true the same shapes still refine to 'vacuous' exactly as before
    expect(await deliveryStateWithVacuity(live, undefined, probes, true)).toEqual({ delivery: 'vacuous' });
    expect(worktreeIsClean).toHaveBeenCalledTimes(1);
  });
});

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  sessions: ReturnType<typeof vi.fn>;
  listWorkflows: () => WorkflowDef[];
};

/** App + cache over a registry-bearing adapter (the daemon's shape), spy-able probes, nothing started. */
function build(
  views: SessionView[],
  probes: Partial<VacuityProbes> = {},
): { app: FastifyInstance; cache: DeliveryDerivationCache; probes: VacuityProbes; groupIndex: GroupIndex } {
  const adapter: MockAdapter = {
    sessionsDetail: vi.fn().mockResolvedValue(views),
    sessions: vi.fn().mockResolvedValue(views.map((v) => v.session.id)),
    listWorkflows: () => SHIPPED,
  };
  const full: VacuityProbes = {
    worktreeExists: probes.worktreeExists ?? (() => true),
    worktreeIsClean: probes.worktreeIsClean ?? (async () => false),
    runBranchIsEmpty: probes.runBranchIsEmpty ?? (async () => false),
  };
  const deliveryIndex = new DeliveryIndex();
  const canDeliver = (v: SessionView) => runCanDeliver(v, runWorkflowDef(v, adapter.listWorkflows()));
  const cache = new DeliveryDerivationCache({
    listViews: () => adapter.sessionsDetail() as Promise<SessionView[]>,
    probes: full,
    isDelivered: (runId) => deliveryIndex.urlFor(runId) !== undefined,
    canDeliver,
  });
  const groupIndex = new GroupIndex();
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    {
      deliveryIndex,
      deliveryCache: cache,
      groupIndex,
      worktreeExists: full.worktreeExists,
      worktreeIsClean: full.worktreeIsClean,
      runBranchIsEmpty: full.runBranchIsEmpty,
      canDeliver,
    },
  );
  return { app, cache, probes: full, groupIndex };
}

async function deliveryOn(app: FastifyInstance, runId: string): Promise<{ list: unknown; detail: unknown }> {
  const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
    runs: { session: Record<string, unknown> }[];
  };
  const detail = (await app.inject({ method: 'GET', url: `/api/v1/runs/${runId}` })).json() as {
    run: { session: Record<string, unknown> };
  };
  return {
    list: list.runs.find((r) => r.session['id'] === runId)?.session['delivery'],
    detail: detail.run.session['delivery'],
  };
}

describe('GET /runs, GET /runs/:id and the campaigns rollup — one predicate, every surface (the ONE check)', () => {
  const capture = SHIPPED.find((w) => w.id === 'capture-learnings')!;
  const bug = SHIPPED.find((w) => w.id === 'bug')!;

  it("a completed capture-learnings run with a live DIRTY worktree reads 'none' — cold, after a sweep, and 0 probes", async () => {
    const worktreeIsClean = vi.fn(async () => false); // dirty: pre-fix this was 'stranded' forever
    const runBranchIsEmpty = vi.fn(async () => false);
    const v = view('run-capture', {
      workflow_id: 'capture-learnings',
      repo_ref: 'repo',
      workdir: '/wt/capture',
      units: unitsOf('run-capture', capture),
    });
    const { app, cache } = build([v], { worktreeIsClean, runBranchIsEmpty });
    try {
      await app.ready();
      expect(await deliveryOn(app, 'run-capture')).toEqual({ list: 'none', detail: 'none' });
      await cache.sweep();
      expect(await deliveryOn(app, 'run-capture')).toEqual({ list: 'none', detail: 'none' });
      expect(worktreeIsClean).not.toHaveBeenCalled();
      expect(runBranchIsEmpty).not.toHaveBeenCalled();
    } finally {
      cache.stop();
      await app.close();
    }
  });

  it("a completed bug run with a deliver unit + dirty tree reads 'stranded' (as today); clean ⇒ 'vacuous' after the sweep", async () => {
    let clean = false;
    const worktreeIsClean = vi.fn(async () => clean);
    const v = view('run-bug', {
      workflow_id: 'bug',
      repo_ref: 'repo',
      workdir: '/wt/bug',
      units: unitsOf('run-bug', bug, [DELIVER_PHASE_ID]),
    });
    const { app, cache } = build([v], { worktreeIsClean });
    try {
      await app.ready();
      expect(await deliveryOn(app, 'run-bug')).toEqual({ list: 'stranded', detail: 'stranded' });
      clean = true;
      await cache.sweep();
      expect(await deliveryOn(app, 'run-bug')).toEqual({ list: 'vacuous', detail: 'vacuous' });
      expect(worktreeIsClean).toHaveBeenCalled();
    } finally {
      cache.stop();
      await app.close();
    }
  });

  it("a free-text wf-… run (u1, u2 units) is untouched: live tree ⇒ 'stranded', exactly today's read", async () => {
    const v = view('run-free', { repo_ref: 'repo', workdir: '/wt/free', units: [unit('run-free:u1'), unit('run-free:u2')] });
    const { app, cache } = build([v]);
    try {
      await app.ready();
      expect(await deliveryOn(app, 'run-free')).toEqual({ list: 'stranded', detail: 'stranded' });
    } finally {
      cache.stop();
      await app.close();
    }
  });

  it("the campaigns rollup answers the SAME 'none' for the same capture-learnings view (no split-brain)", async () => {
    const worktreeIsClean = vi.fn(async () => false);
    const v = view('run-capture', {
      workflow_id: 'capture-learnings',
      repo_ref: 'repo',
      workdir: '/wt/capture',
      units: unitsOf('run-capture', capture),
    });
    const groupIndex = new GroupIndex();
    groupIndex.set('run-capture', { label: 'onboarding-batch' });
    const groups = await buildGroups(sessionsById([v]), {
      groupIndex,
      deliveryUrlFor: () => undefined,
      vacuity: { worktreeExists: () => true, worktreeIsClean, runBranchIsEmpty: async () => false },
      canDeliver: (view) => runCanDeliver(view, runWorkflowDef(view, SHIPPED)),
    });
    expect(groups).toEqual([
      { label: 'onboarding-batch', runs: [{ runId: 'run-capture', status: 'completed', delivery: 'none' }] },
    ]);
    expect(worktreeIsClean).not.toHaveBeenCalled();
    // Without the dep the rollup keeps today's read — the daemon always wires it (server.ts).
    const legacy = await buildGroups(sessionsById([v]), {
      groupIndex,
      deliveryUrlFor: () => undefined,
      vacuity: { worktreeExists: () => true, worktreeIsClean, runBranchIsEmpty: async () => false },
    });
    expect(legacy[0]!.runs[0]!.delivery).toBe('stranded');
  });
});
