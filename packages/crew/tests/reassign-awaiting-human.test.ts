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
import { BUILTIN_WORKFLOWS, type CoreAdapter } from '../src/core/adapter.js';

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
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, {
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

  it('approves the gate THEN reassigns the cursor unit, in that order, in one call — and says it approved', async () => {
    const res = await reassign('run-gated', { cli: 'codex' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ord: 2, cli: 'codex', approved: true });
    expect(calls).toEqual(['confirmGate:run-gated:true', 'reassignUnit:run-gated:2:codex']);
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
