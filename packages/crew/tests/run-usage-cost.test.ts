// #1486: GET /runs/:id derives `cost_usd` and `usage_seats_unmetered` from the run's event log (a codex cliUsage has
// tokens and costUsd null). Real Fastify injection over registerRoutes with a stub adapter; the run view, the run facts
// and the seat record are pinned to agree on one fixture.

import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CoreAdapter } from '../src/core/adapter.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { AuditLog } from '../src/api/audit.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { foldRunIntoSeats } from '../src/api/seat-record.js';
import { runFactOf, type LooseEvent } from '../src/insights/run-facts.js';
import type { RecordedEvent, SeatRecord, SessionView } from '../src/core/types.js';
import { withRunViews } from './support/run-views.js';

const T0 = Date.now() - 3_600_000;

const unit = (ord: number, cli: string): SessionView['units'][number] => ({
  id: `u${ord}`, session_id: 'x', ord, description: 'd', stage: 'build', assigned_cli: cli, assigned_invocation: null,
  council_task_ref: null, routing: null, denial_reason: null, phase_ref: 'build', conformance_ref: null, phase_status: null,
  collection_scope: null, status: 'done',
});
const view = (id: string, units: SessionView['units']): SessionView => ({
  session: { id, status: 'completed', created_at: Math.floor(T0 / 1000) } as SessionView['session'],
  units: units.map((u) => ({ ...u, session_id: id })),
});

let seq = 0;
const ev = (type: string, ts: number, f: Record<string, unknown>): RecordedEvent =>
  ({ type, session: 'x', ts, seq: seq++, ...f }) as unknown as RecordedEvent;
const usage = (ord: number, ts: number, costUsd: number | null): RecordedEvent =>
  ev('cliUsage', ts, { ord, attempt: 1, inputTokens: 10, outputTokens: 5, costUsd });

const reads = { runEvents: 0 };
let app: FastifyInstance | undefined;

async function serve(id: string, units: SessionView['units'], events: () => Promise<RecordedEvent[] | null>): Promise<FastifyInstance> {
  const adapter = {
    sessions: async () => [id],
    sessionsDetail: async () => [structuredClone(view(id, units))],
    runEvents: async () => { reads.runEvents += 1; return events(); },
  } as unknown as CoreAdapter;
  app = Fastify({ logger: false });
  registerRoutes(app, withRunViews(adapter), new GateCache(), new ElicitationCache(), { bus: null, index: new MembershipIndex(), log: () => undefined }, { audit: AuditLog.noop(), authMode: 'off' });
  await app.ready();
  return app;
}

const session = async (a: FastifyInstance, id: string): Promise<Record<string, unknown>> => {
  const res = await a.inject({ method: 'GET', url: `/api/v1/runs/${id}` });
  expect(res.statusCode).toBe(200);
  return (res.json() as { run: { session: Record<string, unknown> } }).run.session;
};

const UNITS = [unit(0, 'claude'), unit(1, 'codex')];
const dist = [ev('unitDistributed', T0, { ord: 0, cli: 'claude' }), ev('unitDistributed', T0, { ord: 1, cli: 'codex' })];

afterEach(async () => { await app?.close(); app = undefined; reads.runEvents = 0; });

describe('GET /runs/:id cost_usd / usage_seats_unmetered', () => {
  it('mixed: the claude sum, codex listed once however many frames', async () => {
    const a = await serve('r', UNITS, async () => [...dist, usage(0, T0 + 1, 1), usage(0, T0 + 2, 0.25), usage(1, T0 + 3, null), usage(1, T0 + 4, null)]);
    const s = await session(a, 'r');
    expect(s['cost_usd']).toBe(1.25);
    expect(s['usage_seats_unmetered']).toEqual(['codex']);
  });

  it('all unpriced: cost null, every seat listed (sorted)', async () => {
    const a = await serve('r', UNITS, async () => [...dist, usage(1, T0 + 1, null), usage(0, T0 + 2, null)]);
    const s = await session(a, 'r');
    expect(s['cost_usd']).toBeNull();
    expect(s['usage_seats_unmetered']).toEqual(['claude', 'codex']);
  });

  it('fully priced, including a reported zero: no unmetered seats', async () => {
    const a = await serve('r', UNITS, async () => [...dist, usage(0, T0 + 1, 1.25), usage(1, T0 + 2, 0)]);
    const s = await session(a, 'r');
    expect(s['cost_usd']).toBe(1.25);
    expect(s['usage_seats_unmetered']).toEqual([]);
  });

  it('no usage frames: neither field', async () => {
    const a = await serve('r', UNITS, async () => [...dist]);
    const s = await session(a, 'r');
    expect(s).not.toHaveProperty('cost_usd');
    expect(s).not.toHaveProperty('usage_seats_unmetered');
  });

  it.each([
    ['null', async () => null],
    ['a throw', async () => { throw new Error('log gone'); }],
  ])('an unreadable log (%s): neither field', async (_n, events) => {
    const a = await serve('r', UNITS, events as () => Promise<RecordedEvent[] | null>);
    const s = await session(a, 'r');
    expect(s).not.toHaveProperty('cost_usd');
    expect(s).not.toHaveProperty('usage_seats_unmetered');
  });

  it('GET /runs carries no cost field and adds no event read of its own', async () => {
    const a = await serve('r', UNITS, async () => [...dist, usage(0, T0 + 1, 1), usage(1, T0 + 2, null)]);
    const list = await a.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: { session: Record<string, unknown> }[] }).runs;
    expect(runs[0]?.session).not.toHaveProperty('cost_usd');
    expect(runs[0]?.session).not.toHaveProperty('usage_seats_unmetered');
    // The list's only reads are its terminal-time backfill (once per run); a second list reads none more than the first.
    const afterFirst = reads.runEvents;
    await a.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(reads.runEvents).toBe(afterFirst);
    await session(a, 'r');
    expect(reads.runEvents).toBe(afterFirst + 1);
  });
});

describe('the run view, the run facts and the seat record agree', () => {
  it('on one fixture with a reassignment and a cliUsageUnreported attempt', async () => {
    const v = view('r', UNITS);
    const events = [
      ...dist,
      usage(0, T0 + 1, 0.75),
      usage(1, T0 + 2, null),
      // Reassigned to codex at the same ts as its next usage: seq decides, so that usage is codex's.
      ev('unitReassigned', T0 + 5, { ord: 0, attempt: 2, previousCli: 'claude', newCli: 'codex' }),
      usage(0, T0 + 5, 0.5),
      ev('cliUsageUnreported', T0 + 6, { ord: 1, attempt: 2 }),
      usage(1, T0 + 7, 0),
    ];
    const a = await serve('r', UNITS, async () => events);
    const s = await session(a, 'r');

    const fact = runFactOf(v, events as unknown as LooseEvent[], Date.now());
    const seats = new Map<string, SeatRecord>();
    foldRunIntoSeats(seats, v, events, 0);
    const seatSum = [...seats.values()].reduce((n, x) => n + (x.costUsd ?? 0), 0);

    expect(s['cost_usd']).toBe(1.25);
    expect(fact.spendUsd).toBe(s['cost_usd']);
    expect(seatSum).toBe(s['cost_usd']);
    expect(fact.pricedFrames).toBe(3);
    expect(fact.unpricedFrames).toBe(2);
    expect(s['usage_seats_unmetered']).toEqual(['codex']);
    expect(seats.get('claude')?.costUsd).toBe(0.75);
    expect(seats.get('codex')?.costUsd).toBe(0.5 + 0);
  });
});
