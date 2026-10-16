// Wave 6 (F-7R2-007 root fix) — `POST /runs/:id/reassign` on a run PARKED at a gate: the engine's
// `reassign_unit` accepts only an Executing run, so the route performs approve-then-reassign in ONE
// call (the gate approve resumes the run, the reassign immediately supersedes the re-dispatched
// turn), audited as both a gate decision (`via: 'reassign'`) and a reassign. A steering-author
// propose gate is refused — its approve LANDS the proposal through POST /runs/:id/gate.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

function view(id: string, status: string, unitIx: number, workflowId = 'wf-x') {
  return {
    session: {
      id,
      workflow_id: workflowId,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude', 'codex'],
      status,
      human_confirm: 'all',
      unit_ix: unitIx,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  };
}

describe('POST /runs/:id/reassign on an awaiting_human run (F-7R2-007)', () => {
  let app: FastifyInstance;
  const calls: string[] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-gated', 'awaiting_human', 2),
        view('run-exec', 'executing', 3),
        view('run-done', 'completed', 4),
        view('run-steering', 'awaiting_human', 2, 'steering-author'),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      confirmGate: vi.fn(async (id: string, approve: boolean) => {
        calls.push(`confirmGate:${id}:${approve}`);
        return 'executing';
      }),
      reassignUnit: vi.fn(async (id: string, ord: number, cli: string | null) => {
        calls.push(`reassignUnit:${id}:${ord}:${cli}`);
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    calls.length = 0;
    recorded.length = 0;
  });
  afterAll(async () => {
    await app.close();
  });

  const reassign = (id: string, body?: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/runs/${id}/reassign`, ...(body === undefined ? {} : { payload: body }) });

  it('re-seats the parked unit THEN approves the gate (crew#1058), in one call — and says it approved', async () => {
    const res = await reassign('run-gated', { cli: 'codex' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ord: 2, cli: 'codex', approved: true });
    // The engine re-seats a parked run's cursor unit without dispatching (wicked-core#773); the
    // approve then dispatches it once, on the new seat.
    expect(calls).toEqual(['reassignUnit:run-gated:2:codex', 'confirmGate:run-gated:true']);
    // Both halves are on the trail: the approve has no side door (task #88).
    expect(recorded.map((r) => r.action)).toEqual(['gate.decided', 'run.reassigned']);
    expect(recorded[0]!.detail).toMatchObject({ approve: true, via: 'reassign' });
    expect(recorded[1]!.detail).toMatchObject({ ord: 2, cli: 'codex', approved: true });
  });

  it('an executing run reassigns WITHOUT touching any gate (the crew#442 path, unchanged)', async () => {
    const res = await reassign('run-exec');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ord: 3 });
    expect(calls).toEqual(['reassignUnit:run-exec:3:null']);
  });

  it('a terminal run is still a 409; a steering-author propose gate is refused (its approve lands the proposal)', async () => {
    const done = await reassign('run-done');
    expect(done.statusCode).toBe(409);
    expect((done.json() as { error: string }).error).toContain('not executing');
    const steering = await reassign('run-steering', { cli: 'codex' });
    expect(steering.statusCode).toBe(409);
    expect((steering.json() as { error: string }).error).toContain('steering-author');
    expect(calls).toEqual([]);
  });

  it('a cli outside the seat pool is a 400 before any engine call', async () => {
    const res = await reassign('run-gated', { cli: 'ghost' });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

// crew#1058 (E2E run 9c3f20fa): unit 3 (a Review unit, routed `evaluator_distinct`) failed on
// copilot; the gate offered "Reassign to Pi CLI", but pi authored the work it checks. The route
// approved the gate FIRST, the engine then refused the reassign (409), and the approve had already
// re-dispatched copilot. Now the parked unit is re-seated first: the engine's refusal leaves the
// gate open and nothing approved. The run DTO also says which seats are refused, so a skin never
// offers them.
describe('POST /runs/:id/reassign on a gate: the engine refuses before anything is approved (crew#1058)', () => {
  let app: FastifyInstance;
  const calls: string[] = [];
  const recorded: string[] = [];
  let approveFails = false;
  const unit = (ord: number, stage: string, cli: string, extra: Record<string, unknown> = {}) => ({
    id: `run-authors:u${ord}`, session_id: 'run-authors', ord, description: `u${ord}`, stage,
    assigned_cli: cli, assigned_invocation: null, council_task_ref: null, routing: null, denial_reason: null,
    phase_ref: null, conformance_ref: null, phase_status: null, collection_scope: null,
    status: ord < 3 ? 'done' : 'distributed', ...extra,
  });
  const authorsView = (id: string, assurance?: Record<string, unknown>) => {
    const v = view(id, 'awaiting_human', 2) as Omit<ReturnType<typeof view>, 'units'> & { units: unknown[] };
    v.session.clis = ['pi', 'copilot', 'codex'];
    if (assurance !== undefined) (v.session as Record<string, unknown>)['assurance'] = assurance;
    v.units = [
      unit(1, 'recon', 'pi'),
      unit(2, 'build', 'pi', { authored_by: ['codex'] }),
      unit(3, 'review', 'copilot', { routing: { method: 'evaluator_distinct', was: 'pi' } }),
    ];
    return v;
  };

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => [
        authorsView('run-authors'),
        authorsView('run-reduced', { mode: 'reduced', required: ['distinct_evaluator', 'judge'] }),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      confirmGate: vi.fn(async (id: string, approve: boolean) => {
        calls.push(`confirmGate:${id}:${approve}`);
        if (approveFails) throw new Error('gate changed');
        return 'executing';
      }),
      // The engine's parked-run re-seat (wicked-core#773) with its core#933 refusal, as core-ts
      // answers it: an author's seat for a review under a distinct-evaluator contract is refused
      // with the run untouched.
      reassignUnit: vi.fn(async (id: string, ord: number, cli: string | null) => {
        calls.push(`reassignUnit:${id}:${ord}:${cli}`);
        if (id === 'run-authors' && (cli === 'pi' || cli === 'codex')) {
          throw new Error(`cannot reassign unit 3 to '${cli}': that seat authored the work this review checks (authors: pi, codex), and this run requires a distinct evaluator — reassign it to one of: copilot`);
        }
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn((action: string) => { recorded.push(action); return Date.now(); }) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    calls.length = 0;
    recorded.length = 0;
    approveFails = false;
  });
  afterAll(async () => {
    await app.close();
  });

  it('a seat the engine refuses is a 409 and the gate is NOT approved (the failed seat does not run again)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/run-authors/reassign', payload: { cli: 'pi' } });
    expect(res.statusCode).toBe(409);
    const error = (res.json() as { error: string }).error;
    expect(error).toContain("cannot reassign unit 3 to 'pi'");
    expect(error).toContain('reassign it to one of: copilot');
    expect(error).toContain('Nothing was approved; the gate is still open.');
    expect(calls).toEqual(['reassignUnit:run-authors:3:pi']);
    expect(recorded).toEqual([]);
  });

  it('an accepted seat is re-seated, then the gate approved; a failed approve says the unit waits there', async () => {
    const ok = await app.inject({ method: 'POST', url: '/api/v1/runs/run-authors/reassign', payload: { cli: 'copilot' } });
    expect(ok.statusCode).toBe(200);
    expect(calls).toEqual(['reassignUnit:run-authors:3:copilot', 'confirmGate:run-authors:true']);
    calls.length = 0;
    approveFails = true;
    const failed = await app.inject({ method: 'POST', url: '/api/v1/runs/run-authors/reassign', payload: { cli: 'copilot' } });
    expect(failed.statusCode).toBe(409);
    expect((failed.json() as { error: string }).error).toContain('now waits on copilot, but approving the gate failed: gate changed');
  });

  it('without a named seat a gated reassign stays approve-then-reassign (a re-route needs a running unit)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/run-authors/reassign', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['confirmGate:run-authors:true', 'reassignUnit:run-authors:3:null']);
  });

  it('the run DTO serves the refused seats on the review unit only (WorkUnit.reassign_refused)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-authors' });
    expect(res.statusCode).toBe(200);
    const units = (res.json() as { run: { units: Array<{ ord: number; reassign_refused?: string[] }> } }).run.units;
    expect(units.find((u) => u.ord === 3)?.reassign_refused).toEqual(['pi', 'codex']);
    expect(units.find((u) => u.ord === 1)?.reassign_refused).toBeUndefined();
    expect(units.find((u) => u.ord === 2)?.reassign_refused).toBeUndefined();
    // A reduced-assurance run waives the distinct evaluator: nothing is refused.
    const reduced = await app.inject({ method: 'GET', url: '/api/v1/runs/run-reduced' });
    const rUnits = (reduced.json() as { run: { units: Array<{ ord: number; reassign_refused?: string[] }> } }).run.units;
    expect(rUnits.find((u) => u.ord === 3)?.reassign_refused).toBeUndefined();
  });
});
