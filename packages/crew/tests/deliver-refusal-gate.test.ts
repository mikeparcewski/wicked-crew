// DES-L9 (FIX-IT-ALL row 0.11, PR-L9-crew-0 — tests FIRST, mirror-first for the engine arm).
//
// The F1 arm (PR-L9-core, core-ts 0.7.27 — `actor.rs` `apply_step_result`, Failed branch): a failed
// deliver unit whose output is NOT a `LIFT-CONFLICT` strand is `Rejected` and the run PARKS at
// `awaitingHuman{gateKind: "escalation", ord: <deliver>, reviewingOrd: <deliver>}` — regardless of
// `humanConfirm` (omitted on an API launch) and of `deliverGate: "auto"`; no LLM triage reads a
// deterministic script's refusal; 0 `failureTriaged`, 0 `sessionFailed`; the worktree stays (dirty by
// construction — every refusal precedes staging). Approve re-dispatches the deliver unit (the engine
// re-lifts and re-verifies first); reject cancels. A `LIFT-CONFLICT` output keeps today's path
// exactly: `failed` → crew `completed` + `delivery: "stranded"` → post-hoc `POST /runs/:id/deliver`.
//
// This file is the CREW half, written before the engine emits the shape: given the frames and the
// run view the arm produces, every crew derivation must already read them right —
//   - the gate cache folds the `awaitingHuman` (live and replayed) and `GET /runs/:id/gate` serves it;
//   - the run DTO keeps `status: awaiting_human` and derives `delivery: "none"` — NEVER `stranded`
//     (`delivery-index.ts` `isDeliverConflictStranded` is untouched: it still keys `failed` + marker);
//   - the refusal classifies `script_refusal`, non-recoverable — no post-hoc lift is offered;
//   - the strand path stays what it is (the exemption, pinned as a regression control);
//   - the launch the DES exercises omits `humanConfirm` (the arm must not depend on it).
// The engine half is observable only through a real-engine launch — owed by PR-L9-crew (`it.todo`).

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaunchSchema, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { DeliveryIndex, deliveryStateOf, isDeliverConflictStranded } from '../src/api/delivery-index.js';
import { AuditLog } from '../src/api/audit.js';
import { triageDeliverFailure } from '../src/core/deliver-triage.js';
import { DELIVER_LIFT_CONFLICT_MARKER } from '../src/core/deliver.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { RuntimeDeps } from '../src/api/routes.js';
import type { CoreEvent, SessionView, WorkUnit } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';

const RUN_ID = 'b7d2c3e4-1111-4222-8333-444455556666';
const DELIVER_ORD = 5;
const PR_BRANCH = 'wicked/cd3ea61d-9f4f-406d-972b-13ace3a87595';

/** DES-L9 §4 — the identity refusal (D-18), the script's own text; it is the deliver unit's WHOLE
 *  output (the block runs before `git fetch`), so `stepFailed.detail` carries it verbatim. */
const REFUSAL =
  "deliver: identity mismatch — GH_ACCOUNT is release-bot but gh's active login is someone-else; nothing was " +
  "staged, committed or pushed. Fix the daemon's gh login (gh auth switch, or GH_TOKEN in the daemon environment) " +
  'and approve to retry the deliver phase';

/** DES-L9 §4 — the gate prompt the arm parks with. */
const PROMPT =
  `The deliver phase refused: ${REFUSAL}. Approve to re-run the deliver phase now (the engine re-lifts and ` +
  're-verifies first; no second deliver gate), reject to cancel the run and keep the worktree.';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

/** The frames the arm emits, oldest first (`ts` = the engine's capture time, as the log records it). */
const FRAMES: CoreEvent[] = [
  ev({ type: 'unitDistributed', session: RUN_ID, ord: DELIVER_ORD, cli: 'claude', routing_method: 'tool', ts: 1_757_000_000_000 }),
  ev({ type: 'stepFailed', session: RUN_ID, ord: DELIVER_ORD, attempt: 0, detail: REFUSAL, failureKind: 'workerError', ts: 1_757_000_001_000 }),
  ev({
    type: 'awaitingHuman',
    session: RUN_ID,
    ord: DELIVER_ORD,
    reviewingOrd: DELIVER_ORD,
    gateKind: 'escalation',
    prompt: PROMPT,
    ts: 1_757_000_002_000,
  }),
];

function unit(over: Partial<WorkUnit> & { id: string }): WorkUnit {
  return {
    session_id: RUN_ID,
    ord: 0,
    description: '',
    stage: 'build',
    assigned_cli: null,
    assigned_invocation: null,
    council_task_ref: null,
    routing: null,
    denial_reason: null,
    denial: null,
    phase_ref: null,
    conformance_ref: null,
    phase_status: null,
    collection_scope: null,
    status: 'done',
    ...over,
  } as unknown as WorkUnit;
}

/** The run view after the arm: parked on the deliver unit, which is `rejected` with the framed refusal
 *  (`deliver refused on unit N: <excerpt>`) and the machine-readable twin (`UnitDenialSource` is
 *  open-ended on the wire, so the new token parses on today's api-types). */
function view(over: { status?: string; humanConfirm?: string; units?: WorkUnit[] } = {}): SessionView {
  return {
    session: {
      id: RUN_ID,
      workflow_id: `bug-deliver-${RUN_ID}`,
      problem: `Revise PR #273 (${PR_BRANCH}) — the review said REQUEST CHANGES`,
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude'],
      status: over.status ?? 'awaiting_human',
      human_confirm: over.humanConfirm ?? 'none',
      unit_ix: DELIVER_ORD - 1,
      attempt: 0,
      workdir: `/tmp/wicked-worktrees/${RUN_ID}`,
      repo_ref: 'wicked-studio',
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: over.units ?? REFUSED_UNITS,
  } as unknown as SessionView;
}

const REFUSED_UNITS: WorkUnit[] = [
  unit({ id: `${RUN_ID}:fix`, ord: 3, status: 'done', assigned_cli: 'claude' }),
  unit({ id: `${RUN_ID}:verify`, ord: 4, status: 'done', assigned_cli: 'opencode' }),
  unit({
    id: `${RUN_ID}:deliver`,
    ord: DELIVER_ORD,
    status: 'rejected',
    denial_reason: `deliver refused on unit ${DELIVER_ORD}: ${REFUSAL}`,
    denial: { source: 'deliver_refusal', reason: REFUSAL, claimId: null, ruleIds: [], deniedTool: null, phase: 'deliver' },
    tool_cmd: ['bash', '-lc', 'set -euo pipefail …'],
  } as Partial<WorkUnit> & { id: string }),
];

/** Today's strand shape, for the regression control: `failed` + the marker on the deliver unit. */
const STRANDED_UNITS: WorkUnit[] = [
  unit({ id: `${RUN_ID}:fix`, ord: 3, status: 'done' }),
  unit({
    id: `${RUN_ID}:deliver`,
    ord: DELIVER_ORD,
    status: 'rejected',
    denial_reason:
      `Worker FAILED on unit ${DELIVER_ORD} (triage: the deliver step exited non-zero): ` +
      `${DELIVER_LIFT_CONFLICT_MARKER} — lifting the run's work onto origin/main (f57069d) would conflict in: ` +
      'CHANGELOG.md. The worktree was left exactly as verified (base 1432c96); nothing was rebased and nothing was pushed.',
    tool_cmd: ['bash', '-lc', 'set -euo pipefail …'],
  }),
];

function buildApp(views: SessionView[], gateCache: GateCache, runEvents: CoreEvent[] | null = null): FastifyInstance {
  const adapter = {
    sessionsDetail: vi.fn(async () => views),
    sessions: vi.fn(async () => views.map((v) => v.session.id)),
    runEvents: vi.fn(async () => runEvents),
    listRepos: vi.fn(async () => []),
  } as unknown as CoreAdapter;
  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  const runtime: Partial<RuntimeDeps> = {
    deliveryIndex: new DeliveryIndex(),
    worktreeExists: () => true,
    worktreeIsClean: async () => false,
    runBranchIsEmpty: async () => false,
  };
  registerRoutes(
    app,
    adapter,
    gateCache,
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    runtime,
  );
  return app;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe('DES-L9 deliver refusal → escalation gate: the crew half (PR-L9-crew-0)', () => {
  it('the gate cache folds the arm’s awaitingHuman live and from a replayed log, with the deliver ord and the refusal prompt', () => {
    const live = new GateCache();
    for (const f of FRAMES) live.ingest(f);
    const entry = live.get(RUN_ID);
    expect(entry).toMatchObject({ ord: DELIVER_ORD, prompt: PROMPT, lifecycle: 'open' });
    // The prompt quotes the script's refusal, which is not a worker's sandbox refusal — the #419
    // warning must NOT fire on it (an operator approving here re-runs a deterministic phase).
    expect(entry).not.toHaveProperty('refusal');
    expect(entry?.receivedAt).toBe(new Date(1_757_000_002_000).toISOString());
    const replayed = new GateCache().rebuild(RUN_ID, FRAMES);
    expect(replayed).toEqual(entry);
  });

  it('GET /runs/:id/gate serves the escalation gate — from the cache, and by replaying the log after a restart', async () => {
    const primed = new GateCache();
    for (const f of FRAMES) primed.ingest(f);
    const app = buildApp([view()], primed);
    apps.push(app);
    await app.ready();
    const cached = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/gate` });
    expect(cached.statusCode).toBe(200);
    expect(cached.json()).toMatchObject({ runId: RUN_ID, ord: DELIVER_ORD, prompt: PROMPT, lifecycle: 'open' });

    // A cold cache (daemon restarted): the route asks the run (awaiting_human), finds no durable row
    // (no `interactionRequests` binding on this stub) and replays the event log (FINDING-051).
    const cold = buildApp([view()], new GateCache(), FRAMES);
    apps.push(cold);
    await cold.ready();
    const replayed = await cold.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/gate` });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ runId: RUN_ID, ord: DELIVER_ORD, prompt: PROMPT });
  });

  it('the run DTO keeps status awaiting_human and derives delivery none — a parked refusal is NOT a strand', async () => {
    const app = buildApp([view()], new GateCache());
    apps.push(app);
    await app.ready();
    const one = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown>; units: WorkUnit[] };
    };
    expect(one.run.session['status']).toBe('awaiting_human');
    expect(one.run.session['delivery']).toBe('none');
    expect(one.run.session).not.toHaveProperty('deliverUrl');
    // WHY the run is parked stays on the wire: the deliver unit is rejected with the refusal.
    const deliver = one.run.units.find((u) => u.id.endsWith(':deliver'))!;
    expect(deliver.status).toBe('rejected');
    expect(deliver.denial_reason).toContain('deliver: identity mismatch');
    expect((deliver as unknown as { denial: { source: string } }).denial.source).toBe('deliver_refusal');
    const list = (await app.inject({ method: 'GET', url: '/api/v1/runs' })).json() as {
      runs: { session: Record<string, unknown> }[];
    };
    const run = list.runs.find((r) => r.session['id'] === RUN_ID)!;
    expect(run.session['status']).toBe('awaiting_human');
    expect(run.session['delivery']).toBe('none');
  });

  it('the derivations behind the DTO agree: deliveryStateOf → none, isDeliverConflictStranded → false, at every humanConfirm', () => {
    const v = view();
    expect(deliveryStateOf(v.session, undefined, () => true)).toEqual({ delivery: 'none' });
    expect(isDeliverConflictStranded(v)).toBe(false);
    // Same reading with `humanConfirm` at any value — the arm is posture-independent by design.
    for (const humanConfirm of ['none', 'all', 'before:1']) {
      expect(isDeliverConflictStranded(view({ humanConfirm })), humanConfirm).toBe(false);
    }
  });

  // FOUND BY THIS PIN (mirror-first; also pinned in deliver-triage.test.ts): DES-L9 §5's framing
  // `deliver refused on unit N: <snippet>` is not matched by `deliver-triage.ts`'s line rule (`deliver: `
  // at the start / after a newline / after `): `), so `triageDeliverFailure(unit.denial_reason)` — the
  // reading PR-L9-crew's post-hoc route and `deliver-text.ts` apply to the parked UNIT (DES-L9 §5; seat
  // health reads `stepFailed.detail`, the bare snippet, and is unaffected) — answers null: the refusal
  // is neither classified `script_refusal` nor marked non-recoverable. One side flips it: the engine
  // frames with `(deliver): ` (PR-L9-core) or the rule accepts `: deliver: ` (PR-L9-crew).
  it.fails('NOT_FIXED_YET (DES-L9 §5 framing ↔ deliver-triage line rule): the parked unit’s denial_reason classifies script_refusal, non-recoverable — no post-hoc lift is offered', () => {
    const deliver = view().units.find((u) => u.id.endsWith(':deliver'))!;
    expect(deliver.denial_reason).toMatch(/^deliver refused on unit 5: deliver: identity mismatch/);
    expect(triageDeliverFailure(deliver.denial_reason)).toEqual({
      kind: 'script_refusal',
      author: 'script',
      disposition: 'escalate',
      recoverable: false,
    });
  });

  it('REGRESSION CONTROL — a LIFT-CONFLICT strand keeps today’s path: failed → completed + delivery stranded (the arm exempts it)', async () => {
    const strandedView = view({ status: 'failed', units: STRANDED_UNITS });
    expect(isDeliverConflictStranded(strandedView)).toBe(true);
    const app = buildApp([strandedView], new GateCache());
    apps.push(app);
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}` })).json() as {
      run: { session: Record<string, unknown> };
    };
    expect(body.run.session['status']).toBe('completed');
    expect(body.run.session['delivery']).toBe('stranded');
    // …and the same refusal text on a `failed` run (an engine WITHOUT the arm) is not a strand either:
    // today's `sessionFailed` reading stays `failed` + `none` — the arm changes the engine, not this.
    expect(isDeliverConflictStranded(view({ status: 'failed' }))).toBe(false);
    expect(deliveryStateOf(view({ status: 'failed' }).session, undefined, () => true)).toEqual({ delivery: 'none' });
  });

  it('the launch the DES exercises omits humanConfirm (and deliverGate): the arm must park without either', () => {
    const parsed = LaunchSchema.safeParse({
      problem: 'Revise PR #273 — the review said REQUEST CHANGES',
      repoRef: 'wicked-studio',
      workflow: 'bug',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.humanConfirm).toBeUndefined();
      expect(parsed.data.deliverGate).toBeUndefined();
      expect(parsed.data.deliver).toBeUndefined();
    }
  });

  // The ENGINE half — only a real-engine launch can observe it. PR-L9-crew lands it beside
  // `tests/integration/deliver-conflict-strand-e2e.test.ts` (core-ts → crew, temp state home, a temp
  // bare origin with a PR-shaped branch, the stub gh): `POST /runs {revisesPr}` with `humanConfirm`
  // OMITTED and `GH_ACCOUNT` ≠ the stub login → `runBaseResolved.baseRef == "origin/<branch>"` →
  // deliver gate → approve → `stepFailed` → `awaitingHuman{gateKind: "escalation"}` (0 `sessionFailed`)
  // → fix the stub login → approve → `sessionCompleted`; the remote branch gained exactly one commit
  // (DES-L9 §7). Needs core-ts 0.7.27 (PR-L9-core) under crew — until then the run ends `sessionFailed`.
  it.todo('NOT_FIXED_YET (DES-L9 §7, PR-L9-core 0.7.27 + PR-L9-crew): real-engine launch — a deliver refusal parks at awaitingHuman{gateKind: escalation}, approve after the fix completes the run');
});
