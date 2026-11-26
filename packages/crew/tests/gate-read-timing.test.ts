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
const run = {
  session: { id, workflow_id: 'apps-publish', status: 'awaiting_human', repo_ref: null, workdir: null },
  units: [{ id: `${id}:qe`, session_id: id, ord, phase_ref: 'qe', status: 'rejected' }],
};
const actions = [
  { action: 'approve', intent: 'retry', note: 'optional' },
  { action: 'reassign', intent: 'reseat_and_retry', note: 'optional', seats: ['pi', 'copilot'] },
  { action: 'reject', intent: 'stop', note: 'optional' },
];

async function gateRead(actionsDelayMs: number) {
  const lines: Array<{ level: number; msg: string }> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line) as { level: number; msg: string });
      cb();
    },
  });
  const adapter = {
    runView: vi.fn(async () => run),
    gateActions: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, actionsDelayMs));
      return { ord, gateKind: 'escalation', actions };
    }),
    interactionRequests: vi.fn(async () => [{ kind: 'gate', ord, prompt: 'the QE reviewer could not run', gate_kind: 'escalation', created_at: 1_785_614_004_730 }]),
    runEvents: vi.fn(async () => []),
    listWorkflows: () => BUILTIN_WORKFLOWS,
    listConformanceClaims: vi.fn(async () => []),
  };
  const app = Fastify({ logger: { level: 'warn', stream } });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache());
  await app.ready();
  try {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
    return { res, lines };
  } finally {
    await app.close();
  }
}

/** `name;dur=12.3` from a Server-Timing value. */
const durOf = (header: string, name: string): number | undefined => {
  const m = new RegExp(`(?:^|, )${name};dur=([0-9.]+)`, 'u').exec(header);
  return m === null ? undefined : Number(m[1]);
};

describe('GET /runs/:id/gate names the time of each part (crew#1950)', () => {
  it('serves Server-Timing with the engine actions read, the record, the view and the total', async () => {
    const { res, lines } = await gateRead(60);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { actions: unknown }).actions).toEqual(actions);
    const header = String(res.headers['server-timing'] ?? '');
    expect(durOf(header, 'actions')).toBeGreaterThanOrEqual(55);
    expect(durOf(header, 'record')).toBeDefined();
    expect(durOf(header, 'view')).toBeDefined();
    expect(durOf(header, 'total')).toBeGreaterThanOrEqual(durOf(header, 'actions')!);
    // A fast read logs nothing.
    expect(lines.filter((l) => l.msg.includes('/gate took'))).toEqual([]);
  });

  it('a slow read logs one warn line naming the slow part', async () => {
    const { res, lines } = await gateRead(GATE_READ_SLOW_MS + 100);
    expect(res.statusCode, res.body).toBe(200);
    const slow = lines.filter((l) => l.msg.includes(`GET /runs/${id}/gate took`));
    expect(slow).toHaveLength(1);
    expect(slow[0]!.level).toBe(40);
    expect(slow[0]!.msg).toMatch(/\(status 200\): .*actions \d{4} ms/u);
  }, 10_000);

  it('a part that throws is still timed, and a fast read has no slow line', async () => {
    const timer = new GateReadTimer();
    await expect(timer.time('view', async () => {
      throw new Error('engine read failed');
    })).rejects.toThrow('engine read failed');
    expect(durOf(timer.header(), 'view')).toBeDefined();
    expect(timer.slowLine(id, 404)).toBeNull();
  });
});
