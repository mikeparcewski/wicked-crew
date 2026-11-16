// (crew#1512, studio#1170) GATES AS A CONTRACT: `GET /runs/:id/gate` serves `actions`, the engine's list of every answer
// the open gate takes now (wicked-core `gate_actions`), less what crew refuses on the same gate by the same checks its
// POST routes run; and `POST /runs/:id/reassign` on a parked run re-seats only where, and on the seats, the list says.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateAction } from 'wicked-crew-api-types';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter, type EngineGateActions } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { withRunViews } from './support/run-views.js';

const a = (action: string, intent: string, note: GateAction['note'], extra: Partial<GateAction> = {}): GateAction =>
  ({ action, intent, note, ...extra });

/** The distinct_evaluator retry gate: approve re-runs the review; Reassign on the distinct seat only. */
const RETRY: EngineGateActions = {
  ord: 4,
  gateKind: 'escalation',
  actions: [
    a('approve', 'retry', 'optional'),
    a('skip_rules', 'skip_rules', 'required', { rules: ['R1'] }),
    a('request_changes', 'send_back', 'optional'),
    a('reassign', 'reseat_and_retry', 'optional', { seats: ['codex'] }),
    a('reject', 'stop', 'optional'),
  ],
};
/** The capped review: approve LANDS; no reassign. */
const ADJUDICATION: EngineGateActions = {
  ord: 4,
  gateKind: 'review_adjudication',
  actions: [a('approve', 'land_with_carried_items', 'optional'), a('request_changes', 'send_back', 'optional'), a('reject', 'stop', 'optional')],
};
/** A deliver gate: approve delivers; the in-place QE skip; reject. */
const DELIVER: EngineGateActions = {
  ord: 5,
  gateKind: 'deliver',
  actions: [a('approve', 'deliver', 'optional'), a('skip_qe', 'skip_qe', 'required'), a('reject', 'stop', 'optional')],
};

function view(id: string, ord: number, phase: string, workflowId = 'bug') {
  return {
    session: {
      id, workflow_id: workflowId, problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude', 'codex'], status: 'awaiting_human', human_confirm: 'none', unit_ix: 0, attempt: 0,
      workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [
      { id: `${id}:${phase}`, session_id: id, ord, description: phase, phase_ref: phase, status: phase === 'deliver' ? 'pending' : 'rejected', assigned_cli: 'claude' },
    ],
  };
}

describe('GET /runs/:id/gate — the engine\'s legal actions (crew#1512)', () => {
  let app: FastifyInstance;
  const lists = new Map<string, EngineGateActions | null>();
  const gateCache = new GateCache();
  let withBinding = true;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-retry', 4, 'review'),
        view('run-adj', 4, 'review'),
        view('run-deliver', 5, 'deliver'),
        view('run-steering', 4, 'review', 'steering-author'),
        view('run-cached', 4, 'review'),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async (id: string) => {
        // The engine's open row: the deliver run's at ord 5, every other at ord 4 (whatever its list says).
        const deliver = id === 'run-deliver';
        return [{ kind: 'gate', ord: deliver ? 5 : 4, prompt: 'the gate', gate_kind: deliver ? 'deliver' : (lists.get(id)?.gateKind ?? 'escalation'), created_at: 1_785_614_004_730 }];
      }),
      runEvents: vi.fn(async () => []),
      gateActions: vi.fn(async (id: string) => (withBinding ? (lists.get(id) ?? null) : null)),
    };
    app = Fastify({ logger: false });
    gateCache.ingest({ type: 'awaitingHuman', session: 'run-cached', ord: 4, prompt: 'the gate', gateKind: 'escalation' } as unknown as CoreEvent);
    registerRoutes(app, withRunViews(mockAdapter as unknown as CoreAdapter), gateCache, new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    withBinding = true;
    lists.clear();
    lists.set('run-retry', RETRY);
    lists.set('run-adj', ADJUDICATION);
    lists.set('run-deliver', DELIVER);
    lists.set('run-steering', RETRY);
    lists.set('run-cached', RETRY);
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = async (id: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    expect(res.statusCode).toBe(200);
    return res.json() as { actions?: GateAction[] };
  };
  const tokens = (b: { actions?: GateAction[] }) => b.actions?.map((x) => x.action);

  it('serves the engine\'s list on the record path, with crew\'s humanOnly on a rule skip', async () => {
    const body = await gate('run-retry');
    expect(tokens(body)).toEqual(['approve', 'skip_rules', 'request_changes', 'reassign', 'reject']);
    expect(body.actions?.find((x) => x.action === 'skip_rules')).toMatchObject({ humanOnly: true, rules: ['R1'] });
    expect(body.actions?.find((x) => x.action === 'reassign')).toMatchObject({ seats: ['codex'], intent: 'reseat_and_retry' });
    expect(body.actions?.find((x) => x.action === 'approve')).not.toHaveProperty('humanOnly');
  });

  it('serves it on the cached path too', async () => {
    expect(tokens(await gate('run-cached'))).toEqual(['approve', 'skip_rules', 'request_changes', 'reassign', 'reject']);
  });

  it('the capped review lists land (its intent) and no reassign', async () => {
    const body = await gate('run-adj');
    expect(body.actions?.[0]).toMatchObject({ action: 'approve', intent: 'land_with_carried_items' });
    expect(tokens(body)).not.toContain('reassign');
  });

  it('a steering-author run drops reassign (its approve lands the proposal)', async () => {
    expect(tokens(await gate('run-steering'))).toEqual(['approve', 'skip_rules', 'request_changes', 'reject']);
  });

  it('a deliver gate the freeze refuses keeps only the answers that decline it', async () => {
    const freeze = (frozen: boolean) => app.inject({ method: 'PUT', url: '/api/v1/deliveries/freeze', payload: frozen ? { frozen, reason: 'incident 9' } : { frozen } });
    const open = await gate('run-deliver');
    expect(tokens(open)).toEqual(['approve', 'skip_qe', 'reject']);
    expect(open.actions?.find((x) => x.action === 'skip_qe'), 'crew answers a non-human skip 403').toMatchObject({ humanOnly: true });
    expect((await freeze(true)).statusCode).toBe(200);
    try {
      expect(tokens(await gate('run-deliver'))).toEqual(['reject']);
    } finally {
      await freeze(false);
    }
  });

  it('absent on an addon without the read, and when the engine\'s open gate is another one', async () => {
    withBinding = false;
    expect(await gate('run-retry')).not.toHaveProperty('actions');
    withBinding = true;
    lists.set('run-retry', { ...RETRY, ord: 5 });
    expect(await gate('run-retry')).not.toHaveProperty('actions');
  });
});

describe('POST /runs/:id/reassign over an addon without the read keeps the older rule (crew#1512 review r2)', () => {
  let app: FastifyInstance;
  const calls: string[] = [];
  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-old', 4, 'review')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async () => [{ kind: 'gate', ord: 4, prompt: 'the gate', gate_kind: 'escalation', created_at: 1 }]),
      runEvents: vi.fn(async () => []),
      // The real adapter always has the method; an addon without the binding answers null and says it has none.
      gateActions: vi.fn(async () => null),
      supportsGateActions: () => false,
      confirmGate: vi.fn(async (id: string, approve: boolean) => { calls.push(`confirmGate:${id}:${approve}`); return 'executing'; }),
      reassignUnit: vi.fn(async (id: string, ord: number, cli: string | null) => { calls.push(`reassignUnit:${id}:${ord}:${cli}`); }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, withRunViews(mockAdapter as unknown as CoreAdapter), new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('re-seats then approves, as before the list existed', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/run-old/reassign', payload: { cli: 'codex' } });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['reassignUnit:run-old:4:codex', 'confirmGate:run-old:true']);
  });
});

describe('POST /runs/:id/reassign on a parked run follows the engine\'s list (crew#1512)', () => {
  let app: FastifyInstance;
  const calls: string[] = [];
  const lists = new Map<string, EngineGateActions>();

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-retry', 4, 'review'), view('run-adj', 4, 'review')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async (id: string) => [{ kind: 'gate', ord: 4, prompt: 'the gate', gate_kind: lists.get(id)?.gateKind ?? 'escalation', created_at: 1 }]),
      runEvents: vi.fn(async () => []),
      gateActions: vi.fn(async (id: string) => lists.get(id) ?? null),
      confirmGate: vi.fn(async (id: string, approve: boolean) => {
        calls.push(`confirmGate:${id}:${approve}`);
        return 'executing';
      }),
      reassignUnit: vi.fn(async (id: string, ord: number, cli: string | null) => {
        calls.push(`reassignUnit:${id}:${ord}:${cli}`);
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, withRunViews(mockAdapter as unknown as CoreAdapter), new GateCache(), new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  beforeEach(() => {
    calls.length = 0;
    lists.set('run-retry', RETRY);
    lists.set('run-adj', ADJUDICATION);
  });
  afterAll(async () => {
    await app.close();
  });

  const reassign = (id: string, cli: string) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/reassign`, payload: { cli } });

  it('a listed seat re-seats, then approves', async () => {
    const res = await reassign('run-retry', 'codex');
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['reassignUnit:run-retry:4:codex', 'confirmGate:run-retry:true']);
  });

  it('a seat the list does not name is refused, nothing changed', async () => {
    const res = await reassign('run-retry', 'claude');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'seat_not_offered' });
    expect(calls).toEqual([]);
  });

  it('a reassign that names no seat is refused before anything changes (the list names the seats)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/run-retry/reassign', payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'seat_not_offered' });
    expect(calls).toEqual([]);
  });

  it('a list that cannot be read, or is another gate\'s, changes nothing', async () => {
    lists.set('run-retry', { ...RETRY, ord: 5 });
    const res = await reassign('run-retry', 'codex');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_unknown' });
    lists.delete('run-retry');
    expect((await reassign('run-retry', 'codex')).json()).toMatchObject({ code: 'gate_unknown' });
    expect(calls).toEqual([]);
  });

  it('a gate whose list has no reassign is refused, naming what its approve does', async () => {
    const res = await reassign('run-adj', 'codex');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'action_not_offered' });
    expect(res.json().error).toMatch(/land with carried items/);
    expect(calls).toEqual([]);
  });
});
