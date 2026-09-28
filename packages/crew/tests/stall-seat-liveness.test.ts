// W1-C1: the stall watchdog misjudging a unit.
//
// - crew#638 / crew#583: a failover never breaks evaluator ≠ creator. A CREATOR cursor never lands
//   on the run's evaluator seat, an `evaluator_distinct`-routed unit never lands on the seat it was
//   routed away from, and when no seat qualifies the watchdog asks a human (`needsYou: true`).
// - crew#638: after the budget is spent on reassigns that produced only a banner, the exhausted
//   frame says `no_output`.
// - crew#629: a unit whose own processes are working (a test runner) is not silent.
// - crew#581: nothing is reassigned once the worker returned and its gate evaluation is in flight.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkerStallWatchdog,
  type ExecutingRun,
  type WorkerStallEscalatedFrame,
  type WorkerStalledFrame,
} from '../src/api/stall-watchdog.js';
import { RunLivenessSampler, parseCpuTime, type ProcRow } from '../src/api/run-liveness.js';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, SessionView, SystemSettings } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const MIN = 60_000;
const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;
type AnyFrame = WorkerStalledFrame | WorkerStallEscalatedFrame;
const escalated = (frames: AnyFrame[]): WorkerStallEscalatedFrame[] =>
  frames.filter((f): f is WorkerStallEscalatedFrame => f.type === 'workerStallEscalated');

function build(runs: ExecutingRun[], busy?: (ids: string[]) => Promise<ReadonlyMap<string, string>>) {
  let nowMs = Date.parse('2026-09-28T10:00:00Z');
  const frames: AnyFrame[] = [];
  const reassigns: { runId: string; ord: number; cli?: string }[] = [];
  const wd = new WorkerStallWatchdog({
    listExecuting: async () => runs,
    broadcast: (f) => frames.push(f),
    escalation: {
      config: () => ({ minutes: 30, maxPerRun: 2 }),
      reassign: async (runId, ord, cli) => {
        reassigns.push({ runId, ord, ...(cli !== undefined ? { cli } : {}) });
      },
    },
    ...(busy !== undefined ? { busy } : {}),
    now: () => nowMs,
  });
  return { wd, frames, reassigns, tick: (ms: number) => (nowMs += ms) };
}

/** Walk one full quiet period past the 30-minute escalation, one sweep a minute. */
async function quietFor(wd: WorkerStallWatchdog, tick: (ms: number) => void, minutes: number): Promise<void> {
  for (let i = 0; i < minutes; i++) {
    tick(MIN);
    await wd.sweep();
  }
}

describe('evaluator ≠ creator across a stall failover (crew#638, crew#583)', () => {
  it('a CREATOR cursor never fails over onto the run evaluator seat; with no other seat it asks a human', async () => {
    // run 12b7ddc3: fix = claude (creator, stalled), verify = pi (evaluator).
    const { wd, frames, reassigns, tick } = build([
      { id: 'r-638', ord: 3, cli: 'claude', seats: ['claude', 'pi'], avoid: ['pi'], executor: 'agent' },
    ]);
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-638', ord: 3 }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toEqual([]);
    const esc = escalated(frames);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({
      action: 'notify',
      outcome: 'ok',
      needsYou: true,
      reason: 'evaluator_distinct',
      avoided: ['pi'],
      previousCli: 'claude',
    });
  });

  it('with a free seat it fails over there and the frame names the seat it avoided', async () => {
    const { wd, frames, reassigns, tick } = build([
      { id: 'r-638b', ord: 3, cli: 'claude', seats: ['claude', 'pi', 'codex'], avoid: ['pi'], executor: 'agent' },
    ]);
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-638b', ord: 3 }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toEqual([{ runId: 'r-638b', ord: 3, cli: 'codex' }]);
    expect(escalated(frames)[0]).toMatchObject({ action: 'reassign', outcome: 'ok', cli: 'codex', avoided: ['pi'] });
  });

  it('a single-seat pool still recycles in place (no seat was avoided)', async () => {
    const { wd, reassigns, tick } = build([{ id: 'r-one', ord: 1, cli: 'claude', seats: ['claude'] }]);
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-one', ord: 1 }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toEqual([{ runId: 'r-one', ord: 1, cli: 'claude' }]);
  });

  it('two banner-only reassigns end in an exhausted frame typed no_output', async () => {
    const { wd, frames, reassigns, tick } = build([
      { id: 'r-ban', ord: 3, cli: 'claude', seats: ['claude', 'codex', 'pi'] },
    ]);
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-ban', ord: 3 }));
    for (let i = 0; i < 2; i++) {
      await quietFor(wd, tick, 31);
      // the engine re-dispatches; the new seat prints its banner, then nothing
      wd.ingest(ev({ type: 'unitDispatched', session: 'r-ban', ord: 3 }));
      wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-ban', ord: 3, text: 'pi v0.9 ready' }));
    }
    await quietFor(wd, tick, 31);
    expect(reassigns).toHaveLength(2);
    const last = escalated(frames).at(-1);
    expect(last).toMatchObject({ action: 'reassign', outcome: 'exhausted', needsYou: true, reason: 'no_output' });
  });
});

describe('a working unit is not a stalled unit (crew#629, crew#581)', () => {
  it('a unit whose test runner burns CPU at 30 min quiet is neither flagged nor reassigned', async () => {
    const { wd, frames, reassigns, tick } = build(
      [{ id: 'r-629', ord: 4, cli: 'pi', seats: ['pi', 'claude'] }],
      async (ids) => new Map(ids.filter((id) => id === 'r-629').map((id) => [id, 'vitest pid 812'])),
    );
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-629', ord: 4 }));
    await quietFor(wd, tick, 45);
    expect(frames).toEqual([]);
    expect(reassigns).toEqual([]);
  });

  it('the same unit with no busy process still walks the ladder', async () => {
    const { wd, reassigns, tick } = build(
      [{ id: 'r-dead', ord: 4, cli: 'pi', seats: ['pi', 'claude'] }],
      async () => new Map(),
    );
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-dead', ord: 4 }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toEqual([{ runId: 'r-dead', ord: 4, cli: 'claude' }]);
  });

  it('a throwing liveness probe falls back to the frame-only clock', async () => {
    const { wd, reassigns, tick } = build([{ id: 'r-x', ord: 1, cli: 'pi', seats: ['pi', 'claude'] }], async () => {
      throw new Error('ps missing');
    });
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-x', ord: 1 }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toHaveLength(1);
  });

  it('after the worker returned (unitOutputCaptured) the cursor is never reassigned: the human is told', async () => {
    const { wd, frames, reassigns, tick } = build([{ id: 'r-581', ord: 3, cli: 'claude', seats: ['claude', 'codex'] }]);
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-581', ord: 3 }));
    wd.ingest(ev({ type: 'unitOutputCaptured', session: 'r-581', ord: 3, attempt: 0, stepStatus: 'ok' }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toEqual([]);
    expect(escalated(frames)[0]).toMatchObject({ action: 'notify', needsYou: true, reason: 'evaluating' });
    // the next dispatch (a rework, the next unit) ends the evaluation: the ladder is back
    wd.ingest(ev({ type: 'unitDispatched', session: 'r-581', ord: 3, attempt: 1 }));
    await quietFor(wd, tick, 31);
    expect(reassigns).toEqual([{ runId: 'r-581', ord: 3, cli: 'codex' }]);
  });
});

describe('RunLivenessSampler: the daemon process tree, attributed by worktree cwd', () => {
  it('parses ps CPU times from macOS and procps', () => {
    expect(parseCpuTime('0:01.50')).toBeCloseTo(1.5);
    expect(parseCpuTime('00:02:03')).toBe(123);
    expect(parseCpuTime('1-02:00:00')).toBe(26 * 3600);
    expect(Number.isNaN(parseCpuTime('TIME'))).toBe(true);
  });

  it('reads busy only for a descendant in the run worktree that burned CPU since the last sample', async () => {
    if (process.platform === 'win32') return; // no reading on Windows by design
    let t = 0;
    let rows: ProcRow[] = [];
    const cwd = new Map<number, string>([
      [10, '/repo/wicked-worktrees/run-a'],
      [11, '/repo/wicked-worktrees/run-a/tmp/wicked-checks/base'],
      [12, '/repo/wicked-worktrees/run-b'],
      [99, '/repo/wicked-worktrees/run-a'], // not a descendant of the daemon
    ]);
    const sampler = new RunLivenessSampler(
      { table: async () => rows, cwds: async (pids) => new Map(pids.flatMap((p) => (cwd.has(p) ? [[p, cwd.get(p) as string] as const] : []))) },
      1,
      () => t,
    );
    const at = (a: number, b: number, c: number, stray: number): ProcRow[] => [
      { pid: 10, ppid: 1, cpuSec: a, comm: '/usr/local/bin/pi' },
      { pid: 11, ppid: 10, cpuSec: b, comm: 'node vitest' },
      { pid: 12, ppid: 1, cpuSec: c, comm: 'claude' },
      { pid: 99, ppid: 7, cpuSec: stray, comm: 'cargo' },
    ];
    rows = at(1, 0, 1, 0);
    expect(await sampler.busy(['run-a', 'run-b'])).toEqual(new Map()); // baseline
    t = 30_000;
    rows = at(1.1, 25, 1.05, 500);
    const busy = await sampler.busy(['run-a', 'run-b']);
    expect([...busy.keys()]).toEqual(['run-a']);
    expect(busy.get('run-a')).toMatch(/node vitest pid 11/);
  });
});

// The mapper seam: `avoid` for a CREATOR cursor and for an `evaluator_distinct` unit only exists if
// server.ts derives it from the engine's unit DTO — driven through createServer, as the engine
// reports the units.
describe('the listExecuting mapper derives avoid for creator and evaluator_distinct cursors', () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  type Listener = (e: CoreEvent) => void;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stall-c1-'));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    removeScratch(dir);
  });

  const view = (unitIx: number, units: Record<string, unknown>[], clis: string[]): SessionView =>
    ({
      session: { id: 'r-map', status: 'executing', unit_ix: unitIx, clis },
      units: units.map((u) => ({ assigned_cli: null, routing: null, tool_cmd: null, ...u })),
    }) as unknown as SessionView;

  async function escalationOf(v: SessionView): Promise<{ detail: Record<string, unknown>; reassigns: unknown[] }> {
    const listeners = new Set<Listener>();
    const reassigns: unknown[] = [];
    const adapter = {
      getSettings: async (): Promise<SystemSettings> => ({ graphNodeLimit: 150 }),
      projectsSupported: (): boolean => false,
      sessionsDetail: async (): Promise<SessionView[]> => [v],
      reassignUnit: async (runId: string, ord: number, cli?: string | null): Promise<void> => {
        reassigns.push({ runId, ord, cli: cli ?? null });
      },
      onLaunch: (): (() => void) => () => undefined,
      onEvent: (l: Listener): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as CoreAdapter;
    const auditPath = join(dir, 'audit.log');
    app = await createServer(adapter, {
      auditPath,
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: true, sweepIntervalMs: 40, stallMinutes: 0.004, escalateMinutes: 0.008, maxEscalations: 1, busy: null },
    });
    for (const l of listeners) l({ type: 'unitOutputDelta', session: 'r-map', ord: 1, text: 'x' } as unknown as CoreEvent);
    const t0 = Date.now();
    for (;;) {
      let raw = '';
      try {
        raw = readFileSync(auditPath, 'utf8');
      } catch {
        // not yet written
      }
      const line = raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { action: string; detail?: Record<string, unknown> })
        .find((e) => e.action === 'run.stall.escalated');
      if (line !== undefined) return { detail: line.detail ?? {}, reassigns };
      if (Date.now() - t0 > 5_000) throw new Error('no escalation on the trail');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('a creator cursor avoids the evaluator seat (run 12b7ddc3)', async () => {
    const { detail, reassigns } = await escalationOf(
      view(
        0,
        [
          { ord: 1, assigned_cli: 'claude', role: 'creator' },
          { ord: 2, assigned_cli: 'pi', role: 'evaluator' },
        ],
        ['claude', 'pi'],
      ),
    );
    expect(reassigns).toEqual([]);
    expect(detail).toMatchObject({ action: 'notify', needsYou: true, reason: 'evaluator_distinct', avoided: ['pi'] });
  }, 20_000);

  it('an evaluator_distinct neutral unit avoids the seat it was routed away from (run 753b4d66)', async () => {
    const { detail, reassigns } = await escalationOf(
      view(
        0,
        [
          { ord: 1, assigned_cli: 'pi', role: 'neutral', routing: { method: 'evaluator_distinct', winner: 'pi', was: 'claude' } },
          { ord: 2, assigned_cli: 'claude', role: 'creator' },
        ],
        ['claude', 'pi'],
      ),
    );
    expect(reassigns).toEqual([]);
    expect(detail).toMatchObject({ reason: 'evaluator_distinct', avoided: ['claude'], needsYou: true });
  }, 20_000);
});
