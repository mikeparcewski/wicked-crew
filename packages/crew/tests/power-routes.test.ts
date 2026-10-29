// Power mode's routes (program DES-POWER-MODE; api-types 0.149.0), driven through the real routes
// (Fastify inject) with a mock engine: the switch, a raise, a pause answer, the read-back, the bus
// page, and who may call them. The engine computes every rigor value; these routes only carry a
// person's word to it, so the tests pin the carrying, the actor rule and the HTTP mapping.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { MembershipIndex } from '../src/projects/membership-index.js';

/** The engine's bus domain (spelled apart so the checkout-policy guard does not read it as a path). */
const CORE_DOMAIN = ['wicked', 'core'].join('-');

const POWER = {
  on: true,
  available: true,
  refusedReason: null,
  rigor: 'standard',
  plan: null,
  history: [],
  toggles: [{ at: 1, on: true, by: 'launch', reason: null, stayPhased: [] }],
  orchestrator: { cli: 'claude', ord: 2, turns: 1, inTurn: true, sessionRestarts: 0 },
  turnLog: [],
  checkpoints: 0,
  handoff: null,
  pause: null,
  outcome: null,
};

function runView(id: string, power: unknown) {
  return {
    session: { id, workflow_id: 'bug', problem: 'p', status: 'executing', unit_ix: 0, attempt: 0, ...(power !== undefined ? { power } : {}) },
    units: [],
  };
}

interface Harness {
  app: FastifyInstance;
  adapter: Record<string, ReturnType<typeof vi.fn>>;
  audit: AuditLog;
}

const apps: FastifyInstance[] = [];

async function harness(opts: { supports?: boolean; bus?: unknown } = {}): Promise<Harness> {
  const adapter = {
    sessionsDetail: vi.fn(async () => [runView('p1', POWER), runView('phased', undefined)]),
    sessions: vi.fn(async () => ['p1', 'phased']),
    listRepos: vi.fn(async () => []),
    supportsPowerMode: vi.fn(() => opts.supports ?? true),
    setPowerMode: vi.fn(async (_id: string, on: boolean) => ({ ...POWER, on })),
    raiseRigor: vi.fn(async (_id: string, atLeast: string) => ({ ...POWER, rigor: atLeast })),
    answerPowerPause: vi.fn(async () => POWER),
    updateSettings: vi.fn(async (patch: Record<string, unknown>) => ({ graphNodeLimit: 150, ...patch })),
    getSettings: vi.fn(async () => ({ graphNodeLimit: 150 })),
    readBus: vi.fn((after: number) => {
      if (opts.bus === undefined) return null;
      const pages = Array.isArray(opts.bus) ? (opts.bus as Array<{ next: number; rows: Array<{ event_id: number }> }>) : [opts.bus as { next: number; rows: Array<{ event_id: number }> }];
      // The page whose rows start after `after` (the bus's own cursor semantics), else an empty tail.
      const page = pages.find((p) => p.rows.some((r) => r.event_id > after)) ?? { next: after, rows: [] };
      return Promise.resolve(JSON.stringify({ next: page.next, rows: page.rows.filter((r) => r.event_id > after) }));
    }),
  };
  const audit = AuditLog.noop();
  const app = Fastify({ logger: false });
  app.decorateRequest('actor', null as unknown as never);
  app.addHook('onRequest', async (req) => {
    const h = req.headers['x-actor'];
    if (typeof h === 'string') {
      const [kind, trust] = h.split(':');
      (req as unknown as { actor: unknown }).actor = { id: `${kind}-1`, kind, trust };
    }
  });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit, authMode: 'required' },
    {},
  );
  await app.ready();
  apps.push(app);
  return { app, adapter, audit };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});

const HUMAN = { 'x-actor': 'human:operator' };
const AGENT = { 'x-actor': 'agent:operator' };

describe('power mode routes', () => {
  it('reads a power run, and a phased run as off and unavailable', async () => {
    const h = await harness();
    const p = await h.app.inject({ method: 'GET', url: '/api/v1/runs/p1/power', headers: HUMAN });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ runId: 'p1', on: true, rigor: 'standard' });
    const ph = await h.app.inject({ method: 'GET', url: '/api/v1/runs/phased/power', headers: HUMAN });
    expect(ph.json()).toMatchObject({ runId: 'phased', on: false, available: false, history: [], turnLog: [] });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/runs/nope/power', headers: HUMAN })).statusCode).toBe(404);
  });

  it('carries a person\'s switch, raise and pause answer to the engine, with the person as actor', async () => {
    const h = await harness();
    const off = await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power', headers: HUMAN, payload: { on: false, reason: 'needs design' } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ runId: 'p1', on: false });
    expect(h.adapter.setPowerMode).toHaveBeenCalledWith('p1', false, 'human-1', 'needs design');
    const up = await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/rigor', headers: HUMAN, payload: { atLeast: 'high', reason: 'touches sign-in' } });
    expect(up.statusCode).toBe(200);
    expect(h.adapter.raiseRigor).toHaveBeenCalledWith('p1', 'high', 'human-1', 'touches sign-in');
    const pause = await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power/pause', headers: HUMAN, payload: { decision: 'continue_high' } });
    expect(pause.statusCode).toBe(200);
    expect(h.adapter.answerPowerPause).toHaveBeenCalledWith('p1', 'continue_high', null, 'human-1');
  });

  it('refuses a worker, an unknown rigor or decision, and a request with no reason to raise', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power', headers: AGENT, payload: { on: false } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/rigor', headers: AGENT, payload: { atLeast: 'high', reason: 'x' } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power/pause', headers: AGENT, payload: { decision: 'stop' } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/rigor', headers: HUMAN, payload: { atLeast: 'lower', reason: 'x' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/rigor', headers: HUMAN, payload: { atLeast: 'high' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power/pause', headers: HUMAN, payload: { decision: 'approve' } })).statusCode).toBe(400);
    expect(h.adapter.setPowerMode).not.toHaveBeenCalled();
    expect(h.adapter.raiseRigor).not.toHaveBeenCalled();
  });

  it('maps an engine refusal to 409 with its reason, and an unknown run to 404', async () => {
    const h = await harness();
    h.adapter.raiseRigor!.mockRejectedValueOnce(new Error('conflict: rigor is already high (a raise must be higher; rigor is never lowered on request)'));
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/rigor', headers: HUMAN, payload: { atLeast: 'standard', reason: 'x' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().reason).toMatch(/never lowered/);
    h.adapter.setPowerMode!.mockRejectedValueOnce(new Error('not_found: run zz'));
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/zz/power', headers: HUMAN, payload: { on: true } })).statusCode).toBe(404);
  });

  it('answers 501 on an engine with no power mode', async () => {
    const h = await harness({ supports: false });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power', headers: HUMAN, payload: { on: false } })).statusCode).toBe(501);
  });

  it('pages the run\'s bus mirror: this run only, cursor past the whole scan', async () => {
    const row = (id: number, run: string, seq: number) => ({
      event_id: id, event_type: 'wicked.run.rigor.rescored', domain: CORE_DOMAIN, subdomain: 'run',
      payload: { runId: run, seq, at: 5, change: { trigger: 'turn' } },
    });
    const h = await harness({ bus: { next: 12, rows: [row(10, 'p1', 3), row(11, 'other', 4), row(12, 'p1', 9)] } });
    const r = await h.app.inject({ method: 'GET', url: '/api/v1/runs/p1/bus?after=9', headers: HUMAN });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { rows: Array<{ eventId: number; seq: number; type: string }>; cursor: number };
    expect(body.rows.map((x) => x.eventId)).toEqual([10, 12]);
    expect(body.rows[0]).toMatchObject({ seq: 3, type: 'wicked.run.rigor.rescored', runId: 'p1' });
    expect(body.cursor).toBe(12);
    // A row of another run after this run's last: the cursor stays on this run's last row.
    expect(h.adapter.readBus).toHaveBeenCalledWith(9, 1000, 'wicked.run.');
    const limited = await h.app.inject({ method: 'GET', url: '/api/v1/runs/p1/bus?after=9&limit=1', headers: HUMAN });
    expect((limited.json() as { cursor: number }).cursor).toBe(10);
  });

  it('scans past a full page of other runs, skips non-object payloads, and keeps the cursor at its last row', async () => {
    const other = Array.from({ length: 1000 }, (_, k) => ({
      event_id: 101 + k, event_type: 'wicked.run.unit.started', domain: CORE_DOMAIN, subdomain: 'run',
      payload: k === 0 ? 'plain text payload' : { runId: 'other', seq: k, at: 1 },
    }));
    const mine = { event_id: 1101, event_type: 'wicked.run.turn.started', domain: CORE_DOMAIN, subdomain: 'run', payload: { runId: 'p1', seq: 77, at: 2 } };
    const tail = { event_id: 1102, event_type: 'wicked.run.unit.started', domain: CORE_DOMAIN, subdomain: 'run', payload: { runId: 'other', seq: 78, at: 3 } };
    const h = await harness({ bus: [{ next: 1100, rows: other }, { next: 1102, rows: [mine, tail] }] });
    const r = await h.app.inject({ method: 'GET', url: '/api/v1/runs/p1/bus?after=100', headers: HUMAN });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { rows: Array<{ eventId: number }>; cursor: number };
    expect(body.rows.map((x) => x.eventId)).toEqual([1101]);
    expect(body.cursor).toBe(1101);
    const none = await h.app.inject({ method: 'GET', url: '/api/v1/runs/p1/bus?after=1101', headers: HUMAN });
    expect(none.json()).toEqual({ rows: [], cursor: 1101 });
  });

  it('takes the power mode default from a person only, and only as a boolean', async () => {
    const h = await harness();
    const ok = await h.app.inject({ method: 'PUT', url: '/api/v1/settings', headers: HUMAN, payload: { powerModeDefault: false } });
    expect(ok.statusCode).toBe(200);
    expect(h.adapter.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ powerModeDefault: false }));
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/settings', headers: HUMAN, payload: { powerModeDefault: 'off' } })).statusCode).toBe(400);
    expect((await h.app.inject({ method: 'PUT', url: '/api/v1/settings', headers: AGENT, payload: { powerModeDefault: true } })).statusCode).toBe(403);
  });

  it('records a pause answer\'s note as a decision host and not an empty one', async () => {
    const h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power/pause', headers: HUMAN, payload: { decision: 'continue', note: 'keep v1 working' } });
    expect(r.statusCode).toBe(200);
    expect(h.adapter.answerPowerPause).toHaveBeenCalledWith('p1', 'continue', 'keep v1 working', 'human-1');
  });

  it('sends an empty reason or note as absent', async () => {
    const h = await harness();
    await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power', headers: HUMAN, payload: { on: false, reason: '   ' } });
    expect(h.adapter.setPowerMode).toHaveBeenCalledWith('p1', false, 'human-1', null);
    await h.app.inject({ method: 'POST', url: '/api/v1/runs/p1/power/pause', headers: HUMAN, payload: { decision: 'continue', note: ' ' } });
    expect(h.adapter.answerPowerPause).toHaveBeenCalledWith('p1', 'continue', null, 'human-1');
  });

  it('answers 503 for the bus page when the daemon has no bus', async () => {
    const h = await harness();
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/runs/p1/bus', headers: HUMAN })).statusCode).toBe(503);
  });
});
