// GET /api/v1/roster/record?days=N — each seat's week folded from the runs' durable event logs
// (studio's weekly 1:1 per agent). Over the REAL server assembly (createServer) with a stub adapter
// serving two runs and their logs; the fold itself is pinned directly below.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { foldRunIntoSeats, seatRecord, SEAT_RECORD_RUN_CAP } from '../src/api/seat-record.js';
import type { RecordedEvent, SeatRecord, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const unit = (ord: number, cli: string, phase: string): SessionView['units'][number] => ({
  id: `u${ord}`, session_id: 'x', ord, description: phase, stage: 'build', assigned_cli: cli, assigned_invocation: null,
  council_task_ref: null, routing: null, denial_reason: null, phase_ref: phase, conformance_ref: null, phase_status: null,
  collection_scope: null, status: 'done',
});

const view = (id: string, units: SessionView['units'], extra: Partial<SessionView['session']> = {}): SessionView => ({
  session: { id, status: 'completed', ...extra } as SessionView['session'],
  units: units.map((u) => ({ ...u, session_id: id })),
});

let seq = 0;
const ev = (type: string, ts: number, fields: Record<string, unknown>): RecordedEvent =>
  ({ type, session: 'x', ts, seq: seq++, ...fields }) as unknown as RecordedEvent;

// Run A (this week): codex builds (passes first time, $0.40), claude reviews and is sent back
// once, and codex stalls on the review rework it was reassigned. pi is benched (signed out).
const RUN_A = view('run-a', [unit(0, 'codex', 'build'), unit(1, 'claude', 'review')], {
  benched_seats: [{ cli: 'pi', reason: 'signed out', source: 'launcher' }],
});
const EVENTS_A: RecordedEvent[] = [
  ev('unitDistributed', NOW - 5 * HOUR, { ord: 0, cli: 'codex' }),
  ev('unitDispatched', NOW - 5 * HOUR, { ord: 0, attempt: 1 }),
  ev('cliUsage', NOW - 5 * HOUR, { ord: 0, attempt: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.4 }),
  ev('gateEvaluated', NOW - 5 * HOUR, { ord: 0, combined: true, denial: null }),
  ev('unitDistributed', NOW - 4 * HOUR, { ord: 1, cli: 'claude' }),
  ev('unitDispatched', NOW - 4 * HOUR, { ord: 1, attempt: 1 }),
  ev('cliUsage', NOW - 4 * HOUR, { ord: 1, attempt: 1, inputTokens: 1, outputTokens: 1, costUsd: null }),
  ev('gateEvaluated', NOW - 4 * HOUR, { ord: 1, combined: false, denial: { source: 'evaluator', reason: 'no tests' } }),
  ev('unitReworkAmended', NOW - 3 * HOUR, { ord: 1, amendment: 'add tests', updatedDescription: 'review', scope: 'request_changes' }),
  ev('unitReassigned', NOW - 3 * HOUR, { ord: 1, attempt: 2, previousCli: 'claude', newCli: 'codex' }),
  ev('unitDispatched', NOW - 3 * HOUR, { ord: 1, attempt: 2 }),
  ev('workerStalled', NOW - 2 * HOUR, { ord: 1, quietForMs: 600_000 }),
  ev('workerStalled', NOW - 1 * HOUR, { ord: 1, quietForMs: 1_200_000 }),
  ev('gateEvaluated', NOW - 1 * HOUR, { ord: 1, combined: true, denial: null }),
];

// Run B ended three weeks ago: never read, never counted.
const RUN_B = view('run-b', [unit(0, 'claude', 'build')], { ended_at: Math.floor((NOW - 21 * DAY) / 1000) });
const EVENTS_B: RecordedEvent[] = [
  ev('unitDistributed', NOW - 22 * DAY, { ord: 0, cli: 'claude' }),
  ev('unitDispatched', NOW - 22 * DAY, { ord: 0, attempt: 1 }),
  ev('gateEvaluated', NOW - 22 * DAY, { ord: 0, combined: false, denial: { source: 'evaluator', reason: 'x' } }),
];

const bySeat = (seats: SeatRecord[]): Record<string, SeatRecord> => Object.fromEntries(seats.map((s) => [s.cli, s]));

describe('the seat record fold', () => {
  it('credits units, first pass, rework, stalls, bench and cost to the seat that did them', () => {
    const seats = new Map<string, SeatRecord>();
    foldRunIntoSeats(seats, RUN_A, EVENTS_A, NOW - 7 * DAY);
    const s = bySeat([...seats.values()]);
    // codex: its build (first pass, $0.40) and the reassigned review it ran and stalled on (once per unit).
    expect(s['codex']).toMatchObject({ units: 2, gated: 1, firstPass: 1, rework: 0, stalls: 1, costUsd: 0.4, costedUsage: 1 });
    expect(s['codex']?.byPhase['review']).toMatchObject({ units: 1, stalls: 1 });
    // claude: ran the review first, failed its first gate, and owns the rework; no price → null cost.
    expect(s['claude']).toMatchObject({ units: 1, gated: 1, firstPass: 0, rework: 1, stalls: 0, costUsd: null });
    expect(s['claude']?.byPhase['review']).toMatchObject({ rework: 1, gated: 1, firstPass: 0 });
    // pi never ran: only the bench.
    expect(s['pi']).toMatchObject({ units: 0, benched: 1, benchReasons: { 'signed out': 1 } });
  });

  it('counts nothing outside the window and skips runs that ended before it', async () => {
    const reads: string[] = [];
    const out = await seatRecord([RUN_A, RUN_B], async (id) => {
      reads.push(id);
      return id === 'run-a' ? EVENTS_A : EVENTS_B;
    }, { days: 7, now: NOW });
    expect(reads).toEqual(['run-a']);
    expect(out?.runsRead).toBe(1);
    expect(out?.truncated).toBe(false);
    expect(bySeat(out!.seats)['claude']?.units).toBe(1);
  });

  it('answers null when the engine cannot read event logs', async () => {
    expect(await seatRecord([RUN_A], async () => null, { days: 7, now: NOW })).toBeNull();
  });

  it('caps the runs it reads and says so', async () => {
    const many = Array.from({ length: SEAT_RECORD_RUN_CAP + 3 }, (_, i) => view(`r${i}`, []));
    const out = await seatRecord(many, async () => [], { days: 7, now: NOW });
    expect(out?.runsRead).toBe(SEAT_RECORD_RUN_CAP);
    expect(out?.truncated).toBe(true);
  });
});

describe('GET /api/v1/roster/record', () => {
  let scratch: string;
  let app: FastifyInstance;
  let binding = true;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-seat-record-route-'));
    const adapter = {
      stub: true,
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: () => () => {},
      sessions: async () => ['run-a', 'run-b'],
      sessionsDetail: async () => [structuredClone(RUN_A), structuredClone(RUN_B)],
      runEvents: async (id: string) => (!binding ? null : id === 'run-a' ? EVENTS_A : EVENTS_B),
    } as unknown as CoreAdapter;
    app = await createServer(adapter, {
      auth: { mode: 'off' },
      auditPath: join(scratch, 'audit.log'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      studioRoot: join(scratch, 'no-studio'),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    removeScratch(scratch);
  });

  it('serves each seat’s week', async () => {
    binding = true;
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster/record?days=7' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { days: number; runsRead: number; seats: SeatRecord[] };
    expect(body.days).toBe(7);
    expect(body.runsRead).toBe(1);
    const s = bySeat(body.seats);
    expect(s['codex']).toMatchObject({ units: 2, firstPass: 1, stalls: 1, costUsd: 0.4 });
    expect(s['claude']).toMatchObject({ rework: 1, firstPass: 0 });
    expect(s['pi']).toMatchObject({ benched: 1 });
  });

  it('defaults to 7 days', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster/record' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { days: number }).days).toBe(7);
  });

  it.each(['0', '31', 'abc', '1.5'])('refuses days=%s', async (days) => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/roster/record?days=${days}` });
    expect(res.statusCode).toBe(400);
  });

  it('answers 503 when the engine has no event-log binding', async () => {
    binding = false;
    const res = await app.inject({ method: 'GET', url: '/api/v1/roster/record' });
    binding = true;
    expect(res.statusCode).toBe(503);
  });
});
