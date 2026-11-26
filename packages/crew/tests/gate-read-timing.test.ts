// crew#1950: GET /runs/:id/gate took 36-52 s on a loaded host while the run's view took 0.08 s, and nothing said which
// part was slow. Each answer names its parts (Server-Timing), and a slow read logs one line naming each part.
import { Writable } from 'node:stream';
import Fastify from 'fastify';
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
    interactionRequests: vi.fn(async () => [row]),
    runEvents: vi.fn(async () => {
      if (o.eventsDelayMs !== undefined) await new Promise((r) => setTimeout(r, o.eventsDelayMs));
      return [];
    }),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    listConformanceClaims: vi.fn(async () => []),
  };
  const cache = new GateCache();
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
    const all = await Promise.all((o.requests ?? [{ method: 'GET' }]).map((r) => app.inject({ method: r.method, url, ...(r.payload !== undefined ? { payload: r.payload } : {}) })));
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
    expect(lines.filter((l) => l.msg.includes('/gate took'))).toEqual([]);
  });

  it('a GET that joins a gate read another request started names that read\'s parts too (codex r2)', async () => {
    // Two GETs together: one hydration (one event-log read), and both answers name it.
    const both = await gateRead({ eventsDelayMs: 80, requests: [{ method: 'GET' }, { method: 'GET' }] });
    expect(both.adapter.runEvents).toHaveBeenCalledTimes(1);
    for (const r of both.all) {
      expect(r.statusCode, r.body).toBe(200);
      expect(partsOf(r.headers['server-timing']).get('events')).toBeGreaterThanOrEqual(70);
    }
    // A decision (POST, untimed) that starts the read first: the GET waiting on it still names the event-log read.
    const joined = await gateRead({ eventsDelayMs: 80, requests: [{ method: 'POST', payload: { approve: true, ord } }, { method: 'GET' }] });
    expect(joined.adapter.runEvents).toHaveBeenCalledTimes(1);
    expect(joined.all[1]!.statusCode, joined.all[1]!.body).toBe(200);
    expect(partsOf(joined.all[1]!.headers['server-timing']).get('events')).toBeGreaterThanOrEqual(70);
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
