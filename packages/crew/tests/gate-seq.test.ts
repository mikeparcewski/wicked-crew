// (crew#1698, core#1808) A PER-OPENING GATE ID: `GET /runs/:id/gate` and the `awaitingHuman` frame carry `gateSeq`;
// `POST /runs/:id/gate`, `/resume` and `/reassign` accept it and answer 409 `gate_changed` when the gate closed and
// re-opened since (the same ord too), and every confirm binds the engine to the opening the record shows.
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import type { AuditLog } from '../src/api/audit.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

/** The engine's durable gate row as wicked-core writes it (`src/interaction.rs` `InteractionRequest`: serde snake_case,
 *  `gate_seq` the opening, `0` on a row written before the field). */
const row = (gateSeq: number | null) => ({ kind: 'gate', ord: 4, gate_kind: 'escalation', prompt: 'Retry the review?', created_at: 1, ...(gateSeq !== null ? { gate_seq: gateSeq } : {}) });

/** `null`: a row with no `gate_seq` at all (an engine before core#1808). */
function harness(gateSeq: number | null = 2, status = 'awaiting_human') {
  const run = { session: { id: 'r', status, unit_ix: 0, clis: ['claude', 'codex'], workflow_id: 'bug' },
    units: [{ id: 'u', ord: 4, phase_ref: 'review', status: 'rejected', assigned_cli: 'claude' }] };
  const adapter = {
    runView: vi.fn(async () => run), sessionsDetail: vi.fn(async () => [run]),
    listRepos: vi.fn(async () => []), listWorkflows: () => BUILTIN_WORKFLOWS,
    interactionRequests: vi.fn(async () => [row(gateSeq)]),
    runEvents: vi.fn(async () => [] as CoreEvent[]),
    supportsPlanSendBack: () => true,
    confirmGate: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'executing'),
    reassignUnit: vi.fn(async () => undefined),
    resumeRun: vi.fn(async () => 'executing'),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  const cache = new GateCache();
  registerRoutes(app, adapter as unknown as CoreAdapter, cache, new ElicitationCache(), undefined,
    { audit: { record: vi.fn() } as unknown as AuditLog, authMode: 'off' });
  return { app, adapter, cache };
}

const answers = [
  { path: 'gate', body: { approve: true } },
  { path: 'resume', body: {} },
  { path: 'reassign', body: {} },
];

describe('the per-opening gate id (crew#1698)', () => {
  it('GET /runs/:id/gate serves the opening from the durable row', async () => {
    const { app } = harness(2);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r/gate' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ord: 4, gateSeq: 2 });
  });

  it('a row written before the field (gate_seq 0) serves no opening', async () => {
    const { app } = harness(0);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r/gate' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).not.toHaveProperty('gateSeq');
  });

  it('the live frame\'s gateSeq rides the cached gate', () => {
    const cache = new GateCache();
    cache.ingest({ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'p', gateKind: 'escalation', gateSeq: 5 } as CoreEvent);
    expect(cache.get('r')).toMatchObject({ ord: 4, gateSeq: 5 });
    cache.ingest({ type: 'awaitingHuman', session: 'q', ord: 1, prompt: 'p', gateSeq: 0 } as CoreEvent);
    expect(cache.get('q')).not.toHaveProperty('gateSeq');
  });

  for (const { path, body } of answers) {
    it(`/${path}: an answer naming an earlier opening of the same ord is 409 gate_changed, nothing confirmed`, async () => {
      const { app, adapter } = harness(2);
      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: { ...body, ord: 4, gateSeq: 1 } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 4, openGateSeq: 2 });
      expect(adapter.confirmGate).not.toHaveBeenCalled();
      expect(adapter.reassignUnit).not.toHaveBeenCalled();
    });

    it(`/${path}: the open opening, or none named, confirms bound to the opening the record shows`, async () => {
      for (const named of [{ gateSeq: 2 }, {}]) {
        const { app, adapter } = harness(2);
        const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: { ...body, ...named } });
        expect(res.statusCode, res.body).toBe(200);
        expect(adapter.confirmGate.mock.calls[0]?.[6]).toEqual({ ord: 4, gateSeq: 2 });
      }
    });

    it(`/${path}: naming an opening the record does not number is 409 gate_unknown`, async () => {
      const { app, adapter } = harness(null);
      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: { ...body, gateSeq: 2 } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('gate_unknown');
      expect(adapter.confirmGate).not.toHaveBeenCalled();
    });
  }

  it('a non-positive or non-integer gateSeq is a 400', async () => {
    const { app } = harness(2);
    for (const gateSeq of [0, -1, 1.5, '2']) {
      expect((await app.inject({ method: 'POST', url: '/api/v1/runs/r/gate', payload: { approve: true, gateSeq } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/runs/r/resume', payload: { gateSeq } })).statusCode).toBe(400);
    }
  });

  it('the engine\'s own refusal of a stale opening is 409 gate_changed', async () => {
    const { app, adapter } = harness(2);
    adapter.confirmGate.mockRejectedValueOnce(new Error('gate_changed: the gate opened again (opening 3, not 2)'));
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/gate', payload: { approve: true, gateSeq: 2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 4, openGateSeq: 2 });
  });

  // codex r1 on b7-standin: an answer naming an opening, queued behind another decision that released the gate, changes
  // no running work.
  for (const path of ['reassign', 'resume']) {
    it(`/${path}: naming an opening once the gate has closed is 409 gate_changed, nothing changed`, async () => {
      const { app, adapter } = harness(2, path === 'reassign' ? 'executing' : 'paused');
      const res = await app.inject({ method: 'POST', url: `/api/v1/runs/r/${path}`, payload: { gateSeq: 2 } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe('gate_changed');
      expect(adapter.reassignUnit).not.toHaveBeenCalled();
      expect(adapter.resumeRun).not.toHaveBeenCalled();
      expect(adapter.confirmGate).not.toHaveBeenCalled();
    });
  }

  it('a cached gate of an earlier opening at the same ord is not served; the record\'s opening is', async () => {
    const { app, cache } = harness(3);
    cache.ingest({ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'Retry the review?', gateKind: 'escalation', gateSeq: 2 } as CoreEvent);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r/gate' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ord: 4, gateSeq: 3 });
  });

  it('a durable row with no opening serves none, even beside a numbered frame', async () => {
    const { app, adapter } = harness(0);
    adapter.runEvents.mockResolvedValue([{ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'Retry the review?', gateSeq: 7 } as CoreEvent]);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r/gate' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).not.toHaveProperty('gateSeq');
  });

  // codex delta on b7-standin: both GET paths and the decision serve or bind the ROW's opening only.
  it('a warm cache beside an unnumbered row serves no opening', async () => {
    const { app, cache } = harness(0);
    cache.ingest({ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'Retry the review?', gateKind: 'escalation', gateSeq: 2 } as CoreEvent);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r/gate' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ord: 4 });
    expect(res.json()).not.toHaveProperty('gateSeq');
  });

  it('a stale frame of an earlier opening landing during the status read is not served', async () => {
    const { app, adapter, cache } = harness(3);
    let landed = false;
    const late = () => {
      if (!landed) {
        landed = true;
        cache.ingest({ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'Retry the review?', gateKind: 'escalation', gateSeq: 2 } as CoreEvent);
      }
    };
    const view = adapter.runView.getMockImplementation()!;
    const detail = adapter.sessionsDetail.getMockImplementation()!;
    adapter.runView.mockImplementation(async () => { late(); return view(); });
    adapter.sessionsDetail.mockImplementation(async () => { late(); return detail(); });
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r/gate' });
    expect(landed).toBe(true);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ord: 4, gateSeq: 3 });
  });

  it('with no open durable row a logged frame\'s opening binds nothing', async () => {
    const { app, adapter } = harness(2);
    adapter.interactionRequests.mockResolvedValue([]);
    adapter.runEvents.mockResolvedValue([{ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'Retry the review?', gateKind: 'escalation', gateSeq: 7 } as CoreEvent]);
    const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r/gate', payload: { approve: true } });
    expect(res.statusCode, res.body).toBe(200);
    expect(adapter.confirmGate.mock.calls[0]?.[6]).toEqual({ ord: 4 });
  });

  it('a gate read from the record is dropped by a live frame of another opening at the same ord and prompt', async () => {
    const cache = new GateCache();
    const read = { ord: 4, prompt: 'p', lifecycle: 'open' as const, receivedAt: new Date(1).toISOString(), gateSeq: 2 };
    await cache.resolve('r', async () => read);
    cache.ingest({ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'p', gateSeq: 2 } as CoreEvent);
    expect(cache.get('r')).toMatchObject({ gateSeq: 2 });
    cache.ingest({ type: 'awaitingHuman', session: 'r', ord: 4, prompt: 'p', gateSeq: 3 } as CoreEvent);
    expect(cache.get('r')).toBeUndefined();
  });
});
