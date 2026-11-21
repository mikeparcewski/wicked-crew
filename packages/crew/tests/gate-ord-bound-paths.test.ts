import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { AuditLog } from '../src/api/audit.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import * as teamRoutes from '../src/team/routes.js';

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function harness(status = 'awaiting_human') {
  const run = { session: { id: 'r', status, unit_ix: 0, clis: ['claude', 'codex'], workflow_id: 'bug' },
    units: [{ id: 'u', ord: 4, phase_ref: 'build', status: 'pending', assigned_cli: 'claude' }] };
  const adapter = {
    runView: vi.fn(async () => run), sessionsDetail: vi.fn(async () => [run]),
    listRepos: vi.fn(async () => []), listWorkflows: () => BUILTIN_WORKFLOWS,
    interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 4, gate_kind: 'plan_approval', prompt: 'Plan?', created_at: 1 }]),
    supportsPlanSendBack: () => true,
    confirmGate: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'executing'),
    reassignUnit: vi.fn(async () => undefined), proposePlan: vi.fn(async () => ({})),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  const registered = registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined,
    { audit: { record: vi.fn() } as unknown as AuditLog, authMode: 'off' });
  return { app, adapter, registered, run };
}
const paths = [
  { path: 'resume', body: {} },
  { path: 'reassign', body: {} },
  { path: 'reassign', body: { cli: 'codex' } },
  { path: 'plan', body: { plan: { steps: [{ catalog: 'build', id: 'build' }] } } },
];

describe('gate ord bound paths', () => {
  for (const { path, body } of paths) {
    const label = `${path}${'cli' in body ? ' with cli' : ''}`;
    it(`${label} refuses a different ord before any write`, async () => {
      const { app, adapter } = harness();
      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: { ...body, ord: 3 } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
      expect(adapter.confirmGate).not.toHaveBeenCalled();
      expect(adapter.reassignUnit).not.toHaveBeenCalled();
      expect(adapter.proposePlan).not.toHaveBeenCalled();
    });
    for (const ord of [4, undefined]) {
      it(`${label} sends the record ord with ${ord === undefined ? 'no' : 'matching'} body ord`, async () => {
        const { app, adapter } = harness();
        const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: { ...body, ...(ord === undefined ? {} : { ord }) } });
        expect(res.statusCode).toBe(200);
        expect(adapter.confirmGate.mock.calls[0]?.[6]).toEqual({ ord: 4 });
        if (path === 'resume' && ord === undefined) {
          const bodiless = await app.inject({ method: 'POST', url: '/api/v1/runs/r/resume' });
          expect(bodiless.statusCode).toBe(200);
          expect(adapter.confirmGate.mock.calls[1]?.[6]).toEqual({ ord: 4 });
          for (const payload of [{ unknown: true }, { ord: -1 }, { ord: 1.5 }, { ord: '4' }]) {
            expect((await app.inject({ method: 'POST', url: '/api/v1/runs/r/resume', payload })).statusCode).toBe(400);
          }
        }
      });
    }
    it(`${label} maps the engine gate_changed refusal`, async () => {
      const { app, adapter } = harness();
      adapter.confirmGate.mockRejectedValueOnce(new Error('gate_changed: now before unit 5'));
      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: body });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
      if ('cli' in body) {
        expect(adapter.reassignUnit).toHaveBeenCalledWith('r', 4, 'codex');
        expect(res.json().error).toContain('unit 4 was re-seated on codex, but approving the gate failed: gate_changed: now before unit 5');
      }
    });
  }
  it('/resume sends no engine expectation when only the cursor suggests a gate', async () => {
    const { app, adapter } = harness();
    adapter.interactionRequests.mockResolvedValue([]);
    Object.assign(adapter, { runEvents: vi.fn(async () => []) });
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/resume' });
    expect(res.statusCode).toBe(200);
    expect(adapter.confirmGate).toHaveBeenCalledOnce();
    expect(adapter.confirmGate.mock.calls[0]?.[6]).toBeUndefined();
  });
  it('a named reassign preserves the completed re-seat and current gate metadata after approve refuses', async () => {
    const { app, adapter } = harness();
    const revision = vi.spyOn(teamRoutes, 'openPlanGateRev').mockReturnValue(7);
    try {
      adapter.confirmGate.mockRejectedValueOnce(new Error('gate_changed: plan replaced'));
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/reassign', payload: { cli: 'codex' } });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        code: 'gate_changed', openOrd: 4, planRev: 7,
        error: "unit 4 was re-seated on codex, but approving the gate failed: gate_changed: plan replaced — read the run's gate before answering again",
      });
      expect(adapter.reassignUnit).toHaveBeenCalledExactlyOnceWith('r', 4, 'codex');
    } finally { revision.mockRestore(); }
  });
  it('/gate binds an ord-only answer to the engine', async () => {
    const { app, adapter, run } = harness();
    run.units.length = 0;
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/gate', payload: { approve: true, ord: 4 } });
    expect(res.statusCode).toBe(200);
    expect(adapter.confirmGate.mock.calls[0]?.[6]).toEqual({ ord: 4 });
  });
  it('executing reassign refuses a changed cursor', async () => {
    const { app, adapter } = harness('executing');
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/reassign', payload: { ord: 3 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed', error: expect.stringMatching(/3.*4/) });
    expect(res.json()).not.toHaveProperty('openOrd');
    expect(adapter.reassignUnit).not.toHaveBeenCalled();
  });
  it('executing plan edits ignore ord', async () => {
    const { app, adapter } = harness('executing');
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/plan', payload: { ...paths[3]!.body, ord: 3 } });
    expect(res.statusCode).toBe(200);
    expect(adapter.confirmGate).not.toHaveBeenCalled();
    expect(adapter.proposePlan).toHaveBeenCalledOnce();
  });
});
