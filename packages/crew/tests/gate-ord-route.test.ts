// POST /runs/:id/gate — the decision names the gate it answers (api-types 0.44.0 `GateDecision.ord`).
//
// A skin that queues a decision (studio's undo window) can outlive the gate it was made on: the gate
// is answered elsewhere, or the run moves on and opens a NEW gate. Without a gate identity on the
// body, the late decision silently answers a gate the person never saw. With `ord`, the daemon
// compares it to the run's OPEN gate — cache first, then the engine's durable interaction row, then
// the event-log replay (the same resolution `GET /runs/:id/gate` serves) — and answers 409
// "gate changed" when they differ, touching nothing. No `ord` = today's behaviour.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateDecision } from 'wicked-crew-api-types';

import { GateSchema, registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { BUILTIN_WORKFLOWS, type CoreAdapter } from '../src/core/adapter.js';

function view(id: string, status: string, unitIx: number) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['claude'], status, human_confirm: 'all', unit_ix: unitIx, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  };
}

describe('GateSchema — the optional gate identity', () => {
  it('accepts a non-negative integer ord, refuses anything else', () => {
    const body: GateDecision = { approve: true, ord: 3 };
    expect(GateSchema.safeParse(body).success).toBe(true);
    expect(GateSchema.safeParse({ approve: false, amend: 'no', ord: 0 }).success).toBe(true);
    expect(GateSchema.safeParse({ approve: true, ord: -1 }).success).toBe(false);
    expect(GateSchema.safeParse({ approve: true, ord: 1.5 }).success).toBe(false);
    expect(GateSchema.safeParse({ approve: true, ord: '3' }).success).toBe(false);
  });
});

describe('POST /runs/:id/gate with ord', () => {
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
      sessionsDetail: vi.fn().mockResolvedValue([
        view('run-cached', 'awaiting_human', 2),
        view('run-durable', 'awaiting_human', 5),
        view('run-unknown', 'awaiting_human', 1),
        view('run-empty', 'awaiting_human', 1),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      // The engine's durable open-prompt row: only run-durable has one (a restart emptied the cache).
      interactionRequests: vi.fn(async (id: string) =>
        id === 'run-durable'
          ? [{ kind: 'gate', ord: 5, prompt: 'Approve unit 5?', created_at: '2026-09-26T10:00:00Z' }]
          : []),
      // run-unknown: no event-log binding at all. run-empty: a log that records no open gate.
      runEvents: vi.fn(async (id: string) => (id === 'run-empty' ? [] : null)),
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
    gateCache.adopt('run-cached', { ord: 2, prompt: 'Approve unit 2?', lifecycle: 'open', receivedAt: '2026-09-26T10:00:00Z' });
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = (id: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/v1/runs/${id}/gate`, payload: body });

  it('the ord of the open gate → 200, confirmed, and the audit names the ord', async () => {
    const res = await gate('run-cached', { approve: true, ord: 2 });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(recorded[0]!.detail).toMatchObject({ approve: true, ord: 2 });
  });

  it('a different ord → 409 "gate changed", nothing confirmed, nothing audited', async () => {
    const res = await gate('run-cached', { approve: true, ord: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 2 });
    expect(res.json().error).toMatch(/gate changed/i);
    expect(confirmCalls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('no ord → unchanged behaviour (200)', async () => {
    const res = await gate('run-cached', { approve: false });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
  });

  it('an empty cache reads the engine\'s durable row: a mismatch is still a 409', async () => {
    const res = await gate('run-durable', { approve: true, ord: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_changed', openOrd: 5 });
    expect(confirmCalls).toEqual([]);
    const ok = await gate('run-durable', { approve: true, ord: 5 });
    expect(ok.statusCode).toBe(200);
  });

  it('a decision that names its gate is REFUSED when the daemon cannot tell which gate is open (409 gate_unknown)', async () => {
    for (const id of ['run-unknown', 'run-empty']) {
      const res = await gate(id, { approve: true, ord: 1 });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'gate_unknown' });
      expect(res.json().error).toMatch(/refresh and decide again/i);
    }
    expect(confirmCalls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('without ord, an unresolvable open gate keeps today\'s behaviour (200)', async () => {
    const res = await gate('run-unknown', { approve: true });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
  });
});
