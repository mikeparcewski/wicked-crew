// crew#1950: GET /runs/:id/gate took 36-52 s on a loaded host while the run's view took 0.08 s, and nothing said which
// part was slow. Each answer names its parts (Server-Timing), and a slow read logs one line naming each part.
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Response as LightMyRequestResponse } from 'light-my-request';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GATE_READ_SLOW_MS, GateReadTimer } from '../src/api/gate-timing.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const id = 'run-escalated';
const ord = 2;
/** A publish run parked at its QE escalation (apps-publish ord 2, the critique step), as in the issue. */
const parked = {
  session: { id, workflow_id: 'apps-publish', status: 'awaiting_human', repo_ref: null, workdir: null },
  units: [{ id: `${id}:qe`, session_id: id, ord, phase_ref: 'qe', status: 'rejected' }],
};
const actions = [
  { action: 'approve', intent: 'retry', note: 'optional' },
  { action: 'reassign', intent: 'reseat_and_retry', note: 'optional', seats: ['pi', 'copilot'] },
  { action: 'reject', intent: 'stop', note: 'optional' },
];
/** The same gate as the engine's event log records it (the replay path, no durable row). */
const frame = { type: 'awaitingHuman', session: id, ord, reviewingOrd: ord, gateKind: 'escalation', prompt: 'the QE reviewer could not run', ts: 1_785_614_004_730 };
const row = { kind: 'gate', ord, prompt: 'the QE reviewer could not run', gate_kind: 'escalation', created_at: 1_785_614_004_730 };
/** Every part name the route may serve: anything else in the header is a leak. */
const PARTS = new Set(['record', 'view', 'resolve', 'events', 'actions', 'crew-actions', 'rejudge', 'deliver-qe', 'total']);

interface Setup {
  run?: unknown;
  eventsDelayMs?: number;
  /** Requests sent together; the first one's answer is returned as `res`. */
  requests?: Array<{ method: 'GET' | 'POST'; payload?: Record<string, unknown> }>;
  gateActions?: () => Promise<unknown>;
  cached?: boolean;
  throwingLog?: boolean;
  /** The engine keeps no durable gate row: the gate comes from the event log's replay. */
  noRow?: boolean;
  /** The event log per read (1-based call number); else `[]` after `eventsDelayMs`. */
  events?: (call: number) => Promise<unknown[]>;
  cache?: GateCache;
  /** Sends the requests itself (in a controlled order); its answers are `all`. */
  drive?: (app: FastifyInstance, adapter: { runEvents: ReturnType<typeof vi.fn> }) => Promise<LightMyRequestResponse[]>;
}

async function gateRead(o: Setup = {}) {
  const lines: Array<{ level: number; msg: string }> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line) as { level: number; msg: string });
      cb();
    },
  });
  const adapter = {
    runView: vi.fn(async () => o.run ?? parked),
    gateActions: vi.fn(o.gateActions ?? (async () => ({ ord, gateKind: 'escalation', actions }))),
    interactionRequests: vi.fn(async () => (o.noRow === true ? [] : [row])),
    runEvents: vi.fn(async () => {
      if (o.events !== undefined) return o.events(adapter.runEvents.mock.calls.length);
      if (o.eventsDelayMs !== undefined) await new Promise((r) => setTimeout(r, o.eventsDelayMs));
      return [];
    }),
    confirmGate: vi.fn(async () => 'executing'),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    listConformanceClaims: vi.fn(async () => []),
  };
  const cache = o.cache ?? new GateCache();
  if (o.cached === true) {
    cache.adopt(id, { ord, prompt: row.prompt, lifecycle: 'open', receivedAt: new Date(row.created_at).toISOString(), gateKind: 'escalation' });
  }
  const app = Fastify({ logger: { level: 'warn', stream } });
  if (o.throwingLog === true) {
    app.addHook('onRequest', async (req) => {
      req.log.warn = () => {
        throw new Error('log destination failed');
      };
    });
  }
  registerRoutes(app, adapter as unknown as CoreAdapter, cache, new ElicitationCache());
  await app.ready();
  try {
    const url = `/api/v1/runs/${id}/gate`;
    const all = o.drive !== undefined
      ? await o.drive(app, adapter)
      : await Promise.all((o.requests ?? [{ method: 'GET' }]).map((r) => app.inject({ method: r.method, url, ...(r.payload !== undefined ? { payload: r.payload } : {}) })));
    return { res: all[0]!, all, lines, adapter };
  } finally {
    await app.close();
  }
}

/** The Server-Timing header as `name -> ms`; fails on anything that is not a known part with a number. */
const partsOf = (header: unknown): Map<string, number> => {
  expect(typeof header).toBe('string');
  const out = new Map<string, number>();
  for (const item of String(header).split(', ')) {
    const m = /^([a-z-]+);dur=(\d+\.\d)$/u.exec(item);
    expect(m, item).not.toBeNull();
    expect(PARTS.has(m![1]!), m![1]).toBe(true);
    out.set(m![1]!, Number(m![2]));
  }
  return out;
};

describe('GET /runs/:id/gate names the time of each part (crew#1950)', () => {
  it('the record path: Server-Timing names the engine actions read, the record, the event log, the view and the total', async () => {
    const { res, lines } = await gateRead({
      gateActions: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { ord, gateKind: 'escalation', actions };
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ runId: id, ord, prompt: row.prompt, gateKind: 'escalation', actions });
    const parts = partsOf(res.headers['server-timing']);
    expect(parts.get('actions')).toBeGreaterThanOrEqual(55);
    for (const name of ['record', 'view', 'resolve', 'events', 'crew-actions', 'total']) expect(parts.has(name), name).toBe(true);
    expect(parts.get('total')).toBeGreaterThanOrEqual(parts.get('actions')!);
    // The slow line's threshold is tested with an injected clock below, not against this host's wall clock (codex r3).
    void lines;
  });

  it('a GET that joins a gate read another request started names that read\'s parts too (codex r2)', async () => {
    // Two GETs together: one hydration (one event-log read), and both answers name it.
    const both = await gateRead({ eventsDelayMs: 80, requests: [{ method: 'GET' }, { method: 'GET' }] });
    expect(both.adapter.runEvents).toHaveBeenCalledTimes(1);
    for (const r of both.all) {
      expect(r.statusCode, r.body).toBe(200);
      expect(partsOf(r.headers['server-timing']).get('events')).toBeGreaterThanOrEqual(70);
    }
  });

  it('a GET that joins the gate read a decision (POST) started names that read\'s parts (codex r3)', async () => {
    // No durable row and no ord named: the POST resolves the gate from the event log, and the GET joins that read.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const { all, adapter } = await gateRead({
      noRow: true,
      events: async () => {
        await held;
        await new Promise((r) => setTimeout(r, 80));
        return [frame];
      },
      drive: async (app, a) => {
        const url = `/api/v1/runs/${id}/gate`;
        const post = app.inject({ method: 'POST', url, payload: { approve: true } });
        await vi.waitFor(() => expect(a.runEvents).toHaveBeenCalledTimes(1));
        const get = app.inject({ method: 'GET', url });
        await new Promise((r) => setTimeout(r, 20));
        release();
        return Promise.all([post, get]);
      },
    });
    expect(adapter.runEvents).toHaveBeenCalledTimes(1);
    expect(all[0]!.statusCode, all[0]!.body).toBe(200);
    expect(adapter.confirmGate).toHaveBeenCalledTimes(1);
    expect(all[1]!.statusCode, all[1]!.body).toBe(200);
    expect(all[1]!.json()).toMatchObject({ runId: id, ord });
    expect(partsOf(all[1]!.headers['server-timing']).get('events')).toBeGreaterThanOrEqual(70);
  });

  it('a hydration started after another settled gets its own parts, never the last one\'s (codex + agy r3)', async () => {
    // Hydration 1 (slow, no open gate) settles; before its GET finishes, a second GET starts hydration 2 (fast).
    const second: { res?: Promise<LightMyRequestResponse> } = {};
    let app!: FastifyInstance;
    let calls!: { runEvents: ReturnType<typeof vi.fn> };
    class Interleaved extends GateCache {
      private first = true;
      override resolve(runId: string, read: Parameters<GateCache['resolve']>[1]): ReturnType<GateCache['resolve']> {
        const r = super.resolve(runId, read);
        if (!this.first) return r;
        this.first = false;
        return r.then(async (v) => {
          second.res = app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
          await vi.waitFor(() => expect(calls.runEvents).toHaveBeenCalledTimes(2));
          return v;
        });
      }
    }
    const { all } = await gateRead({
      noRow: true,
      cache: new Interleaved(),
      events: async (call) => {
        if (call === 1) {
          await new Promise((r) => setTimeout(r, 300));
          return [];
        }
        return [frame];
      },
      drive: async (a, adapter) => {
        app = a;
        calls = adapter;
        const firstRes = await a.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
        return [firstRes, await second.res!];
      },
    });
    expect(all[0]!.statusCode).toBe(404);
    expect(partsOf(all[0]!.headers['server-timing']).get('events')).toBeGreaterThanOrEqual(290);
    expect(all[1]!.statusCode, all[1]!.body).toBe(200);
    expect(partsOf(all[1]!.headers['server-timing']).get('events')).toBeLessThan(290);
  });

  it('the cache path is timed too, and serves the same answer', async () => {
    const { res } = await gateRead({ cached: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ runId: id, ord, actions });
    const parts = partsOf(res.headers['server-timing']);
    expect(parts.has('actions')).toBe(true);
    expect(parts.has('resolve')).toBe(false);
  });

  it('a refusal keeps its status, body and headers, and is timed: 404 for a run with no open gate', async () => {
    const { res } = await gateRead({ run: { ...parked, session: { ...parked.session, status: 'executing' } } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'No open gate for this run' });
    expect(partsOf(res.headers['server-timing']).has('view')).toBe(true);
  });

  it('a refusal keeps its status, body and headers, and is timed: 503 when the engine actions read keeps failing', async () => {
    const { res } = await gateRead({ gateActions: async () => { throw new Error('engine busy'); } });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect((res.json() as { code: string }).code).toBe('gate_actions_unavailable');
    expect(partsOf(res.headers['server-timing']).has('actions')).toBe(true);
  });

  it('a log line that cannot be written never replaces the answer (codex r1)', async () => {
    let now = 0;
    const clock = vi.spyOn(GateReadTimer.prototype, 'total').mockImplementation(() => (now += GATE_READ_SLOW_MS + 1));
    try {
      const { res } = await gateRead({ throwingLog: true });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ runId: id, actions });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('GateReadTimer (crew#1950)', () => {
  it('a slow read is one line naming each part, from a clock it is given', async () => {
    let now = 1_000;
    const timer = new GateReadTimer(() => now);
    await timer.time('record', async () => { now += 5; });
    await timer.time('actions', async () => { now += GATE_READ_SLOW_MS; });
    await timer.time('actions', async () => { now += 10; });
    expect(timer.header()).toBe(`record;dur=5.0, actions;dur=${(GATE_READ_SLOW_MS + 10).toFixed(1)}, total;dur=${(GATE_READ_SLOW_MS + 15).toFixed(1)}`);
    expect(timer.slowLine(id, 200)).toBe(`GET /runs/${id}/gate took ${GATE_READ_SLOW_MS + 15} ms (status 200): record 5 ms, actions ${GATE_READ_SLOW_MS + 10} ms`);
  });

  it('a fast read has no slow line; a part that throws is still timed and its error passes through', async () => {
    let now = 0;
    const timer = new GateReadTimer(() => now);
    await expect(timer.time('view', async () => {
      now += 3;
      throw new Error('engine read failed');
    })).rejects.toThrow('engine read failed');
    expect(timer.header()).toBe('view;dur=3.0, total;dur=3.0');
    expect(timer.slowLine(id, 404)).toBeNull();
  });
});
