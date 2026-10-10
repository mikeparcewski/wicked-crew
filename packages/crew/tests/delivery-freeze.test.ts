// Freeze deliveries (studio brainstorm idea 15, the SRE stop-the-line): ONE switch holds every
// deliver gate. While it is on, an APPROVE of a gate that would run the deliver unit (the pre-run
// deliver gate, or an escalation parked on the deliver unit) is refused with a 409 that says why,
// and the post-hoc `POST /runs/:id/deliver` refuses too, so no run pushes. The gate stays open:
// unfreezing lets the same approve through. Rejects and every other gate are untouched.
//
// The record is the audit trail (`deliveries.frozen` / `deliveries.unfrozen`), folded at boot like
// the standing orders' away flag; there is no state-home file.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { DeliveryFreeze, isDeliverUnit } from '../src/api/delivery-freeze.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import type { AuditEntry } from '../src/core/types.js';

const RUN = 'run-deliver';
const DELIVER_ORD = 5;

function unit(ord: number, phase: string) {
  return {
    id: `${RUN}:${phase}`, session_id: RUN, ord, description: '', stage: 'build', phase_ref: phase,
    assigned_cli: null, assigned_invocation: null, council_task_ref: null, routing: null,
    status: ord < DELIVER_ORD ? 'done' : 'pending',
  };
}

function view(id: string, status: string) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude'], status, human_confirm: 'all', unit_ix: DELIVER_ORD, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [unit(4, 'review'), unit(DELIVER_ORD, 'deliver')],
  };
}

describe('isDeliverUnit', () => {
  it('matches by phase_ref, phase id or catalog id, and nothing else', () => {
    expect(isDeliverUnit({ id: 'r:deliver', phase_ref: null })).toBe(true);
    expect(isDeliverUnit({ id: 'r:u5', phase_ref: 'deliver' })).toBe(true);
    expect(isDeliverUnit({ id: 'r:u5', phase_ref: null, catalog: 'deliver' })).toBe(true);
    expect(isDeliverUnit({ id: 'r:review', phase_ref: 'review' })).toBe(false);
  });
});

describe('DeliveryFreeze — the fold of the audit trail', () => {
  it('starts thawed, and hydrates the newest state from the trail (newest-first input)', async () => {
    const f = new DeliveryFreeze();
    expect(f.state()).toEqual({ frozen: false, since: null, by: null, reason: null });
    const actor = { id: 'alice', kind: 'human', trust: 'operator' } as AuditEntry['actor'];
    const trail: AuditEntry[] = [
      { ts: 3_000, action: 'deliveries.frozen', actor, detail: { reason: 'incident 42' } },
      { ts: 2_000, action: 'deliveries.unfrozen', actor },
      { ts: 1_000, action: 'deliveries.frozen', actor, detail: {} },
      { ts: 500, action: 'gate.decided', actor },
    ];
    await f.hydrate({ readAll: async () => trail });
    expect(f.state()).toEqual({ frozen: true, since: new Date(3_000).toISOString(), by: 'alice', reason: 'incident 42' });
  });

  it('a trail that cannot be read stays thawed and says so', async () => {
    const f = new DeliveryFreeze();
    const log = vi.fn();
    await f.hydrate({ readAll: async () => { throw new Error('EACCES'); } }, log);
    expect(f.state().frozen).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/EACCES/));
  });
});

describe('/deliveries/freeze and the deliver gate', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const gateCache = new GateCache();
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view(RUN, 'awaiting_human'), view('run-review', 'awaiting_human'), view('run-done', 'completed')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async () => []),
      runEvents: vi.fn(async () => null),
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        return 'executing';
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, {
      audit,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    recorded.length = 0;
    gateCache.adopt(RUN, { ord: DELIVER_ORD, prompt: 'Approve deliver?', lifecycle: 'open', receivedAt: '2026-09-27T10:00:00Z' });
    gateCache.adopt('run-review', { ord: 4, prompt: 'Approve review?', lifecycle: 'open', receivedAt: '2026-09-27T10:00:00Z' });
  });
  afterAll(async () => {
    await app.close();
  });

  const freeze = (body: unknown) => app.inject({ method: 'PUT', url: '/api/v1/deliveries/freeze', payload: body as object });
  const gate = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: body });

  it('GET answers thawed by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/deliveries/freeze' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ frozen: false, since: null, by: null, reason: null });
  });

  it('PUT refuses a body that is not {frozen, reason?}', async () => {
    for (const body of [{}, { frozen: 'yes' }, { frozen: true, extra: 1 }, { frozen: true, reason: 'x'.repeat(501) }]) {
      expect((await freeze(body)).statusCode).toBe(400);
    }
    expect(recorded).toEqual([]);
  });

  it('while frozen, a deliver approve is refused with a clear message; after unfreezing it goes through', async () => {
    const on = await freeze({ frozen: true, reason: 'incident 42' });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ frozen: true, by: 'local', reason: 'incident 42' });
    expect(recorded).toEqual([{ action: 'deliveries.frozen', detail: { reason: 'incident 42' } }]);

    for (const body of [{ approve: true, ord: DELIVER_ORD }, { approve: true }, { approve: true, amend: 'ship it' }]) {
      const refused = await gate(RUN, body);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'deliveries_frozen' });
      expect(refused.json().error).toMatch(/deliveries are frozen/i);
      expect(refused.json().error).toMatch(/incident 42/);
      expect(refused.json().error).toMatch(/unfreeze/i);
    }
    expect(confirmCalls).toEqual([]);
    expect(recorded.filter((r) => r.action === 'gate.decided')).toEqual([]);

    // The switch holds only deliver: another run's review gate still approves while frozen.
    expect((await gate('run-review', { approve: true, ord: 4 })).statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);

    const off = await freeze({ frozen: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ frozen: false, since: null, by: null, reason: null });
    expect(recorded.at(-1)).toMatchObject({ action: 'deliveries.unfrozen' });

    const ok = await gate(RUN, { approve: true, ord: DELIVER_ORD });
    expect(ok.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(2);
  });

  it('a reject is never held: it cancels the run, it pushes nothing', async () => {
    await freeze({ frozen: true });
    const res = await gate(RUN, { approve: false, ord: DELIVER_ORD });
    expect(res.statusCode).toBe(200);
    await freeze({ frozen: false });
  });

  it('setting the state it already has records nothing', async () => {
    await freeze({ frozen: false });
    expect(recorded).toEqual([]);
  });

  it('the post-hoc deliver route refuses a known run while frozen', async () => {
    await freeze({ frozen: true });
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/run-done/deliver' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'deliveries_frozen' });
    // An unknown run is still the 404 it always was (codex on #694).
    expect((await app.inject({ method: 'POST', url: '/api/v1/runs/nope/deliver' })).statusCode).toBe(404);
    await freeze({ frozen: false });
  });
});
