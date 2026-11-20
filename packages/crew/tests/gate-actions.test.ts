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
  let raceReads = 0;
  let ghostReads = 0;
  const readActions = vi.fn<(id: string) => Promise<EngineGateActions | null>>();

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-retry', 4, 'review'),
        view('run-adj', 4, 'review'),
        view('run-deliver', 5, 'deliver'),
        view('run-steering', 4, 'review', 'steering-author'),
        view('run-cached', 4, 'review'),
        view('run-rowless', 4, 'review'),
        view('run-race', 4, 'review'),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async (id: string) => {
        if (id === 'run-rowless') return []; // parked before the gate-row table (crew#1634)
        // A gate that opens at ord 5 after the first read found no row (the race, crew#1634 review).
        if (id === 'run-race') return raceReads++ === 0 ? [] : [{ kind: 'gate', ord: 5, prompt: 'the gate', gate_kind: 'escalation', created_at: 1_785_614_004_730 }];
        // A cached gate with an open row, for a run the engine's view does not know.
        if (id === 'run-ghost') return [{ kind: 'gate', ord: ghostReads++ === 0 ? 4 : 5, prompt: 'the gate', gate_kind: 'escalation', created_at: 1_785_614_004_730 }];
        // The engine's open row: the deliver run's at ord 5, every other at ord 4 (whatever its list says).
        const deliver = id === 'run-deliver';
        return [{ kind: 'gate', ord: deliver ? 5 : 4, prompt: 'the gate', gate_kind: deliver ? 'deliver' : (lists.get(id)?.gateKind ?? 'escalation'), created_at: 1_785_614_004_730 }];
      }),
      runEvents: vi.fn(async () => []),
      gateActions: readActions,
      ping: vi.fn(async () => 'pong'),
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
    readActions.mockReset().mockImplementation(async (id) => withBinding ? (lists.get(id) ?? null) : null);
    lists.clear();
    lists.set('run-retry', RETRY);
    lists.set('run-adj', ADJUDICATION);
    lists.set('run-deliver', DELIVER);
    lists.set('run-steering', RETRY);
    lists.set('run-cached', RETRY);
    lists.set('run-rowless', { ...RETRY, ord: 0 });
    lists.set('run-race', { ...RETRY, ord: 5 });
    lists.set('run-ghost', { ...RETRY, ord: 5 });
    raceReads = 0;
    ghostReads = 0;
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

  it('says so on GET /health (capabilities.gateActions), so a skin reads the list only from a daemon that serves it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect((res.json() as { capabilities?: { gateActions?: boolean } }).capabilities?.gateActions).toBe(true);
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

  it('absent on an addon without the read, but 503 when the engine\'s open gate is another one', async () => {
    withBinding = false;
    expect(await gate('run-retry')).not.toHaveProperty('actions');
    withBinding = true;
    lists.set('run-retry', { ...RETRY, ord: 5 });
    readActions.mockClear();
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-retry/gate' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: expect.any(String), code: 'gate_actions_unavailable' });
    expect(res.headers['retry-after']).toBe('1');
    expect(readActions).toHaveBeenCalledTimes(2);
  });

  describe('a gate with no open row (crew#1634)', () => {
    beforeEach(() => {
      gateCache.forget('run-rowless');
      gateCache.adopt('run-rowless', { ord: 4, prompt: 'the gate', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
    });
    it('is served without actions when the engine names another ord, instead of a permanent 503', async () => {
      const body = await gate('run-rowless');
      expect(body).toMatchObject({ runId: 'run-rowless', ord: 4 });
      expect(body).not.toHaveProperty('actions');
    });
    it('answers 503 when a gate opened during the read (the row shows on the re-read)', async () => {
      gateCache.forget('run-race');
      gateCache.adopt('run-race', { ord: 4, prompt: 'the gate', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-race/gate' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'gate_actions_unavailable' });
    });
    it('answers 503 when the row advanced during the read and the run snapshot is undefined', async () => {
      gateCache.forget('run-ghost');
      gateCache.adopt('run-ghost', { ord: 4, prompt: 'the gate', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-ghost/gate' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'gate_actions_unavailable' });
    });
    it('answers 503 for a thrown read of a cached open-row gate whose run view is unknown', async () => {
      gateCache.forget('run-ghost');
      gateCache.adopt('run-ghost', { ord: 4, prompt: 'the gate', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
      readActions.mockRejectedValue(new Error('engine read failed'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-ghost/gate' });
      expect(res.statusCode).toBe(503);
    });
    it('still answers 503 when the read throws', async () => {
      readActions.mockRejectedValue(new Error('engine read failed'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-rowless/gate' });
      expect(res.statusCode).toBe(503);
    });
  });

  describe.each(['record', 'cache'])('action read failures on the %s path (crew#1579)', (path) => {
    beforeEach(() => {
      gateCache.forget('run-retry');
      if (path === 'cache') {
        gateCache.adopt('run-retry', { ord: 4, prompt: 'the gate', lifecycle: 'open', receivedAt: '2026-10-10T10:00:00Z' });
      }
    });

    it('retries a thrown read once, then answers 503 instead of omitting actions', async () => {
      readActions.mockRejectedValue(new Error('engine read failed'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-retry/gate' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: expect.any(String), code: 'gate_actions_unavailable' });
      expect(readActions).toHaveBeenCalledTimes(2);
    });

    it.each(['throw', 'moved gate'])('serves the actions after one %s and one successful re-read', async (failure) => {
      if (failure === 'throw') readActions.mockRejectedValueOnce(new Error('engine read failed'));
      else readActions.mockResolvedValueOnce({ ...RETRY, ord: 5 });
      expect(tokens(await gate('run-retry'))).toEqual(['approve', 'skip_rules', 'request_changes', 'reassign', 'reject']);
      expect(readActions).toHaveBeenCalledTimes(2);
    });
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
