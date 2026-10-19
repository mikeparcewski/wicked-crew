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
import { type CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

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
  /** run-race's open gate: ord 3 until the first confirm, ord 4 (deliver) after it. */
  let raceOrd = 3;
  /** run-race's row reads, parked until the test releases them — each answers the ord open at release. */
  const raceReads: Array<() => void> = [];
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
        view('run-stale-cache', 'awaiting_human', 4),
        view('run-cache-only', 'awaiting_human', 2),
        view('run-two-rows', 'awaiting_human', 6),
        view('run-split', 'awaiting_human', 3),
        view('run-moved-on', 'executing', 4),
        view('run-race', 'awaiting_human', 3),
      ]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      // The engine's durable open-gate row — what authorizes a decision that names its gate
      // (crew#1083 round 3). run-cached: the record agrees with the cached gate. run-durable: only
      // the row (a restart emptied the cache). run-stale-cache: the cache lags the record (ord 3
      // cached, ord 4 open). run-cache-only: a cached gate the record does not show.
      interactionRequests: vi.fn(async (id: string) => {
        const row = (ord: number) => [{ kind: 'gate', ord, prompt: `Approve unit ${ord}?`, created_at: '2026-09-26T10:00:00Z' }];
        if (id === 'run-cached') return row(2);
        if (id === 'run-durable') return row(5);
        if (id === 'run-stale-cache') return row(4);
        // Current wicked-core can hold TWO open gate rows for one ord: a keyed plan_approval gate whose
        // publisher was lost, plus the unkeyed team_transport row boot recovery writes (round 4, P1-A).
        if (id === 'run-two-rows') {
          return [
            { kind: 'gate', ord: 6, gate_kind: 'plan_approval', prompt: 'Approve the plan before unit 6?', created_at: '2026-09-26T10:00:00Z' },
            { kind: 'gate', ord: 6, gate_kind: 'team_transport', prompt: 'Approve the plan before unit 6? (recovered)', created_at: '2026-09-26T10:00:05Z' },
          ];
        }
        // Open rows that DISAGREE on the ord: the record cannot say which gate is open (round 5, P2).
        if (id === 'run-split') {
          return [
            { kind: 'gate', ord: 4, prompt: 'Approve unit 4?', created_at: '2026-09-26T10:00:05Z' },
            { kind: 'gate', ord: 3, prompt: 'Approve unit 3?', created_at: '2026-09-26T10:00:00Z' },
          ];
        }
        if (id === 'run-race') return new Promise<ReturnType<typeof row>>((resolve) => raceReads.push(() => resolve(row(raceOrd))));
        return [];
      }),
      // run-unknown: no event-log binding at all. run-empty: a log that records no open gate.
      runEvents: vi.fn(async (id: string) => (id === 'run-empty' ? [] : null)),
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        // run-race: the engine's operator-judgment path advances synchronously — the confirm returns
        // with the ord-4 deliver gate already open (round 4, P1-B).
        if (args[0] === 'run-race') raceOrd = 4;
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
    gateCache.adopt('run-stale-cache', { ord: 3, prompt: 'Approve unit 3?', lifecycle: 'open', receivedAt: '2026-09-26T10:00:00Z' });
    gateCache.adopt('run-cache-only', { ord: 2, prompt: 'Approve unit 2?', lifecycle: 'open', receivedAt: '2026-09-26T10:00:00Z' });
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

  it('decision integrity (crew#1083 round 3): the RECORD authorizes — cache ord 3, row ord 4: ord 3 is refused, ord 4 confirmed', async () => {
    // A stale or late-folded cache entry once let a decision naming ord 3 pass while confirmGate
    // (which takes no ord) answered the real ord-4 gate. The row is re-read right before the confirm.
    const stale = await gate('run-stale-cache', { approve: true, ord: 3 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
    expect(confirmCalls).toEqual([]);
    const real = await gate('run-stale-cache', { approve: true, ord: 4 });
    expect(real.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
  });

  it('P1-A (round 4): two open rows for ONE ord — a keyed plan_approval gate plus the team_transport row recovery writes — accept a decision for that ord, a reject included', async () => {
    const res = await gate('run-two-rows', { approve: false, ord: 6 });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    // Rows that disagree with the named ord still refuse, naming the newest row's ord.
    const other = await gate('run-two-rows', { approve: true, ord: 5 });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: 'gate_changed', openOrd: 6 });
    expect(confirmCalls).toHaveLength(1);
  });

  it('P1-B (round 4): two concurrent decisions for ord 3 — the first confirm opens the ord-4 deliver gate; the second re-reads inside the lock and is 409; confirmGate runs once', async () => {
    raceOrd = 3;
    raceReads.length = 0;
    const a = gate('run-race', { approve: true, ord: 3 });
    const b = gate('run-race', { approve: true, ord: 3 });
    await vi.waitFor(() => expect(raceReads.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 30));
    // Without the lock both decisions would have read the row by now (both seeing ord 3); under it
    // the second waits for the first decision — confirm included — before it reads anything.
    expect(raceReads.length).toBe(1);
    raceReads.shift()!(); // A reads ord 3 and confirms; the engine opens the ord-4 deliver gate
    await vi.waitFor(() => expect(raceReads.length).toBe(1));
    raceReads.shift()!(); // B reads inside the lock: ord 4
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(409);
    expect(rb.json()).toMatchObject({ code: 'gate_changed', openOrd: 4 });
    expect(confirmCalls).toHaveLength(1);
  });

  it('P2 (round 5): GET serves the row a decision is judged by — the newest of the agreeing rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-two-rows/gate' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ord: 6, prompt: 'Approve the plan before unit 6? (recovered)', gateKind: 'team_transport' });
  });

  it('P2 (round 5): rows that disagree on the ord are ambiguous — GET and every decision say gate_unknown, never a self-contradicting gate_changed', async () => {
    for (const ord of [3, 4]) {
      const res = await gate('run-split', { approve: true, ord });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'gate_unknown' });
      expect(res.json().error).toMatch(/units 3 and 4/);
    }
    const bare = await gate('run-split', { approve: true });
    expect(bare.statusCode).toBe(409);
    expect(bare.json()).toMatchObject({ code: 'gate_unknown' });
    expect(confirmCalls).toEqual([]);
    const read = await app.inject({ method: 'GET', url: '/api/v1/runs/run-split/gate' });
    expect(read.statusCode).toBe(409);
    expect(read.json()).toMatchObject({ code: 'gate_unknown' });
  });

  it('round 7: a GET cache hit is judged by the record — a late ord-3 entry cached while the record shows ord 4 is not served', async () => {
    // beforeEach caches ord 3 for run-stale-cache; its record shows ord 4 open.
    expect(gateCache.get('run-stale-cache')?.ord).toBe(3);
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-stale-cache/gate' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ord: 4, prompt: 'Approve unit 4?' });
    expect(gateCache.get('run-stale-cache')?.ord).toBe(4);
  });

  it('round 7: with no open row, a cached entry is not served once the run has moved on (a late frame for an answered gate)', async () => {
    gateCache.adopt('run-moved-on', { ord: 3, prompt: 'Approve unit 3?', lifecycle: 'open', receivedAt: '2026-09-26T10:00:00Z' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-moved-on/gate' });
    expect(res.statusCode).toBe(404);
    expect(gateCache.get('run-moved-on')).toBeUndefined();
  });

  it('round 7: rows that disagree are 409 gate_unknown on GET even with an entry cached', async () => {
    gateCache.adopt('run-split', { ord: 3, prompt: 'Approve unit 3?', lifecycle: 'open', receivedAt: '2026-09-26T10:00:00Z' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-split/gate' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_unknown' });
  });

  it('a cached gate the record does not show authorizes nothing: 409 gate_unknown', async () => {
    const res = await gate('run-cache-only', { approve: true, ord: 2 });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_unknown' });
    expect(confirmCalls).toEqual([]);
  });

  it('without ord, an unresolvable open gate keeps today\'s behaviour (200)', async () => {
    const res = await gate('run-unknown', { approve: true });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
  });
});

// crew#1083 round 7: `POST /runs/:id/plan` (team routes) answers a plan gate with the edit, so it
// takes the per-run decision lock before its first read of the run and is judged by the record
// before it confirms or proposes anything.
describe('POST /runs/:id/plan takes the decision lock and is judged by the record (crew#1083 round 7)', () => {
  let app: FastifyInstance;
  const gateCache = new GateCache();
  const confirmCalls: unknown[][] = [];
  const proposals: string[] = [];
  const status = new Map<string, string>([['plan-split', 'awaiting_human'], ['plan-race', 'awaiting_human']]);
  const rows = new Map<string, Array<Record<string, unknown>>>([
    ['plan-split', [
      { kind: 'gate', ord: 3, gate_kind: 'plan_approval', prompt: 'Approve the plan?', created_at: 1 },
      { kind: 'gate', ord: 4, prompt: 'Approve unit 4?', created_at: 2 },
    ]],
    ['plan-race', [{ kind: 'gate', ord: 3, gate_kind: 'plan_approval', prompt: 'Approve the plan?', created_at: 1 }]],
  ]);
  let parkedConfirm: (() => void) | null = null;

  beforeAll(async () => {
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => [...status].map(([id, st]) => view(id, st, 3))),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async (id: string) => rows.get(id) ?? []),
      runEvents: vi.fn(async () => null),
      confirmGate: vi.fn(async (...args: unknown[]) => {
        confirmCalls.push(args);
        const id = args[0] as string;
        if (id === 'plan-race') {
          await new Promise<void>((r) => { parkedConfirm = r; });
          // The plan gate was approved: the run executes, its gate row is answered.
          status.set(id, 'executing');
          rows.set(id, []);
        }
        return 'executing';
      }),
      proposePlan: vi.fn(async (id: string) => {
        proposals.push(id);
        return { proposal_id: 'p1', duplicate: false, band: 'low', high_risk: false, floor_added: [] };
      }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  const edit = (id: string) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/plan`, payload: { plan: { steps: [{ catalog: 'build' }] } } });

  it('rows that disagree on the ord: the edit is refused 409 gate_unknown; nothing is confirmed or proposed', async () => {
    const res = await edit('plan-split');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'gate_unknown' });
    expect(confirmCalls).toEqual([]);
    expect(proposals).toEqual([]);
  });

  it('a /gate confirm racing the edit: the edit waits, re-reads the run the confirm left, and confirms nothing — confirmGate runs once', async () => {
    const decision = app.inject({ method: 'POST', url: '/api/v1/runs/plan-race/gate', payload: { approve: true, ord: 3 } });
    await vi.waitFor(() => expect(parkedConfirm).not.toBeNull());
    const res = edit('plan-race');
    await new Promise((r) => setTimeout(r, 30));
    expect(confirmCalls).toHaveLength(1); // unlocked, the edit would have read awaiting_human and confirmed too
    parkedConfirm!();
    expect((await decision).statusCode).toBe(200);
    const done = await res;
    // The plan gate is gone: the edit is not a gate answer any more. It lands as the route's
    // mid-run edit (T8 (c)), which the engine holds for the next step boundary.
    expect(done.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(proposals).toEqual(['plan-race']);
  });
});
