// crew#341 — the stall watchdog's escalation ladder: detection now drives action, opt-in.
//
// Unit half: a fake run list, a stubbed clock, and an instrumented reassign arm drive
// `WorkerStallWatchdog` directly through every rung — OFF by default (the issue's design),
// notify-before-act ordering, reassign-in-place with per-run budget, exhausted / failed /
// notify fail-loud outcomes, re-arming, pruning, live config changes, and the fail-safe
// posture on a broken config read or audit sink. Integration half: the real server
// (createServer → /ws broadcast + audit trail) proves a wedged run's escalation reaches a
// /ws client as `workerStallEscalated`, calls `adapter.reassignUnit` with the engine-true
// cursor (ord + seat), and lands a `run.stall.escalated` line in the audit log. Settings
// half: PUT /settings admits exactly the documented values for the three crew#341 knobs and
// answers 400 (never a silent drop) on anything else.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  WorkerStallWatchdog,
  type ExecutingRun,
  type StallEscalationConfig,
  type WorkerStallEscalatedFrame,
  type WorkerStalledFrame,
} from '../src/api/stall-watchdog.js';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKER_STALL_ESCALATE_ACTION,
  DEFAULT_WORKER_STALL_ESCALATE_MINUTES,
  DEFAULT_WORKER_STALL_MAX_ESCALATIONS,
} from '../src/core/types.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { createServer } from '../src/api/server.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, SessionView, SystemSettings } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

const MIN = 60_000;

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

type AnyFrame = WorkerStalledFrame | WorkerStallEscalatedFrame;
const stalled = (frames: AnyFrame[]): WorkerStalledFrame[] =>
  frames.filter((f): f is WorkerStalledFrame => f.type === 'workerStalled');
const escalatedOf = (frames: AnyFrame[]): WorkerStallEscalatedFrame[] =>
  frames.filter((f): f is WorkerStallEscalatedFrame => f.type === 'workerStallEscalated');

/** A watchdog with the escalation arm wired to an instrumented fake engine. */
function build(opts?: {
  runs?: ExecutingRun[];
  listExecuting?: () => Promise<ExecutingRun[]>;
  config?: () => StallEscalationConfig | undefined | Promise<StallEscalationConfig | undefined>;
  reassign?: (runId: string, ord: number, cli?: string) => Promise<void>;
  audit?: (frame: WorkerStallEscalatedFrame) => void;
  stallMinutes?: () => number | undefined;
}): {
  wd: WorkerStallWatchdog;
  frames: AnyFrame[];
  logs: string[];
  reassigns: { runId: string; ord: number; cli?: string }[];
  audited: WorkerStallEscalatedFrame[];
  tick: (ms: number) => void;
} {
  let nowMs = Date.parse('2026-08-31T10:00:00Z');
  const frames: AnyFrame[] = [];
  const logs: string[] = [];
  const reassigns: { runId: string; ord: number; cli?: string }[] = [];
  const audited: WorkerStallEscalatedFrame[] = [];
  const runs = opts?.runs ?? [{ id: 'r-wedge', ord: 3, cli: 'claude' }];
  const wd = new WorkerStallWatchdog({
    listExecuting: opts?.listExecuting ?? (async () => runs),
    broadcast: (f) => frames.push(f),
    ...(opts?.stallMinutes !== undefined ? { stallMinutes: opts.stallMinutes } : {}),
    escalation: {
      config: opts?.config ?? ((): StallEscalationConfig => ({ minutes: 30 })),
      reassign:
        opts?.reassign ??
        (async (runId, ord, cli) => {
          reassigns.push({ runId, ord, ...(cli !== undefined ? { cli } : {}) });
        }),
      audit: opts?.audit ?? ((f) => audited.push(f)),
    },
    now: () => nowMs,
    log: (m) => logs.push(m),
  });
  return { wd, frames, logs, reassigns, audited, tick: (ms) => (nowMs += ms) };
}

// At the WATCHDOG level a config resolving to no/zero/invalid minutes keeps escalation off —
// whether that came from the operator's explicit `workerStallEscalateMinutes: 0` opt-out or a
// caller that resolved no value at all. The armed DEFAULT (perf#4) lives a layer up, in
// DEFAULT_SETTINGS + the server's config fallback — covered by the perf#4 describes below.
describe('escalation stays off when the resolved config carries no usable minutes', () => {
  it('unset minutes: detection fires, nothing acts, however long the silence', async () => {
    const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes: undefined }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(16 * MIN);
    await wd.sweep();
    tick(600 * MIN); // ten hours of silence — a full crew#341 wedge
    await wd.sweep();
    expect(stalled(frames)).toHaveLength(1);
    expect(escalatedOf(frames)).toEqual([]);
    expect(reassigns).toEqual([]);
  });

  it('0 and invalid minutes read as OFF, never as escalate-on-every-sweep', async () => {
    for (const minutes of [0, -5, Number.NaN] as const) {
      const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes }) });
      wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
      tick(120 * MIN);
      await wd.sweep();
      expect(escalatedOf(frames)).toEqual([]);
      expect(reassigns).toEqual([]);
    }
  });

  it('an undefined config object is OFF too', async () => {
    const { wd, frames, reassigns, tick } = build({ config: () => undefined });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(120 * MIN);
    await wd.sweep();
    expect(escalatedOf(frames)).toEqual([]);
    expect(reassigns).toEqual([]);
  });

  it('a throwing config read stays detection-only THIS sweep and says so', async () => {
    const { wd, frames, logs, reassigns, tick } = build({
      config: () => {
        throw new Error('settings store unreachable');
      },
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(60 * MIN);
    await wd.sweep();
    expect(stalled(frames)).toHaveLength(1); // detection is not hostage to the config read
    expect(escalatedOf(frames)).toEqual([]);
    expect(reassigns).toEqual([]);
    expect(logs.some((m) => m.includes('escalation config read failed'))).toBe(true);
  });
});

// ── perf#4 — the ladder is ON by default, and reassign routes to a DIFFERENT seat ────────────

describe('perf#4: default-ON', () => {
  it('the shipped default arms the ladder at 30 minutes (an explicit 0 stays the opt-out)', () => {
    // 30, not lower: the trigger clock (silence since the last CoreEvent) is the same clock a
    // slow-but-legitimate first turn rides — the recon's max legitimate time-to-first-output was
    // ~19.4 min, so 30 keeps ~55% headroom while still beating the 2h ceiling ~4x.
    expect(DEFAULT_WORKER_STALL_ESCALATE_MINUTES).toBe(30);
    expect(DEFAULT_SETTINGS.workerStallEscalateMinutes).toBe(
      DEFAULT_WORKER_STALL_ESCALATE_MINUTES,
    );
  });

  it('at the default config the ladder acts (reassign) at ~30 min of silence', async () => {
    const { wd, frames, reassigns, tick } = build({
      config: () => ({ minutes: DEFAULT_WORKER_STALL_ESCALATE_MINUTES }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(20 * MIN); // past detect (15) AND past the recon's slowest legitimate first output
    await wd.sweep();
    expect(reassigns).toEqual([]); // a merely-slow first turn is not acted on at ~20 min
    tick(11 * MIN); // 31 min — past the default escalation threshold
    await wd.sweep();
    expect(reassigns).toHaveLength(1);
    expect(escalatedOf(frames)[0]).toMatchObject({ action: 'reassign', outcome: 'ok' });
  });
});

describe('perf#4: reassign routes to a DIFFERENT seat from the run pool', () => {
  it('fails over to the first other pool seat, reporting target and stalled seat apart', async () => {
    const { wd, frames, reassigns, tick } = build({
      runs: [{ id: 'r-pool', ord: 3, cli: 'claude', seats: ['claude', 'codex', 'pi'] }],
      config: () => ({ minutes: 30 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-pool', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    // The engine call carries the TARGET seat — a different one.
    expect(reassigns).toEqual([{ runId: 'r-pool', ord: 3, cli: 'codex' }]);
    expect(escalatedOf(frames)[0]).toMatchObject({
      action: 'reassign',
      outcome: 'ok',
      cli: 'codex', // failover target
      previousCli: 'claude', // the seat that stalled
    });
  });

  it('consecutive wedges rotate the pool: never back to a seat that already stalled here', async () => {
    // After the first failover the cursor seat is codex (the engine re-dispatched there).
    let cursorCli = 'claude';
    const { wd, reassigns, tick } = build({
      listExecuting: async () => [
        { id: 'r-rotate', ord: 3, cli: cursorCli, seats: ['claude', 'codex', 'pi'] },
      ],
      config: () => ({ minutes: 30, maxPerRun: 3 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-rotate', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns[0]).toEqual({ runId: 'r-rotate', ord: 3, cli: 'codex' });

    // The fresh turn wedges too: claude is remembered as stalled, codex is current → pi.
    cursorCli = 'codex';
    wd.ingest(ev({ type: 'unitReassigned', session: 'r-rotate', ord: 3, attempt: 1 }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns[1]).toEqual({ runId: 'r-rotate', ord: 3, cli: 'pi' });

    // Pool exhausted (claude and codex stalled, pi current): fall back to in-place — never
    // bounce back to a seat that already wedged this run.
    cursorCli = 'pi';
    wd.ingest(ev({ type: 'unitReassigned', session: 'r-rotate', ord: 3, attempt: 2 }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns[2]).toEqual({ runId: 'r-rotate', ord: 3, cli: 'pi' });
  });

  it('a single-seat pool falls back sanely: recycle the same seat in place', async () => {
    const { wd, frames, reassigns, tick } = build({
      runs: [{ id: 'r-solo', ord: 1, cli: 'claude', seats: ['claude'] }],
      config: () => ({ minutes: 30 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-solo', ord: 1, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toEqual([{ runId: 'r-solo', ord: 1, cli: 'claude' }]);
    expect(escalatedOf(frames)[0]).toMatchObject({
      outcome: 'ok',
      cli: 'claude',
      previousCli: 'claude',
    });
  });

  it('an unknown current seat keeps the council re-pick shape (no cli passed)', async () => {
    const { wd, reassigns, tick } = build({
      runs: [{ id: 'r-nocli', ord: 2, seats: ['claude', 'codex'] }],
      config: () => ({ minutes: 30 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-nocli', ord: 2, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toEqual([{ runId: 'r-nocli', ord: 2 }]);
  });

  it('the stalled-seat memory prunes with the run, like the budget', async () => {
    let executing: ExecutingRun[] = [
      { id: 'r-prune', ord: 1, cli: 'claude', seats: ['claude', 'codex'] },
    ];
    const { wd, reassigns, tick } = build({
      listExecuting: async () => executing,
      config: () => ({ minutes: 30 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-prune', ord: 1, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns[0]).toEqual({ runId: 'r-prune', ord: 1, cli: 'codex' });

    executing = []; // the run left executing
    await wd.sweep(); // prune
    executing = [{ id: 'r-prune', ord: 1, cli: 'codex', seats: ['claude', 'codex'] }];
    await wd.sweep(); // re-seed
    tick(31 * MIN);
    await wd.sweep();
    // Fresh memory: claude is eligible again — a NEW wedge is a new fact.
    expect(reassigns[1]).toEqual({ runId: 'r-prune', ord: 1, cli: 'claude' });
  });
});

describe('perf#4: a stalled seat is NOT an errored seat', () => {
  it('a stall escalation touches the engine ONLY via reassign, and seat health stays clean', async () => {
    const { wd, frames, reassigns, tick } = build({
      runs: [{ id: 'r-health', ord: 3, cli: 'claude', seats: ['claude', 'codex'] }],
      config: () => ({ minutes: 30 }),
    });
    const seatHealth = new SeatHealthTracker();
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-health', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toEqual([{ runId: 'r-health', ord: 3, cli: 'codex' }]);

    // Fold everything the stall produced — the synthetic frames plus the engine's follow-ups —
    // into the seat-health tracker: NOTHING may mark the stalled seat inactive/errored. (An
    // errored seat is a stepFailed workerError; a stall reassign deliberately produces none, so
    // resume-path exclusion — the engine's worker_failed_clis — is never fed either.)
    for (const f of frames) seatHealth.ingest(f as unknown as CoreEvent);
    seatHealth.ingest(ev({ type: 'unitReassigned', session: 'r-health', ord: 3, attempt: 1 }));
    expect(seatHealth.healthFor('claude').status).toBe('active');
    expect(seatHealth.healthFor('codex').status).toBe('active');
  });

  it("the engine's turn ceiling (stepStatus timed_out) does not mark the seat errored either", () => {
    const seatHealth = new SeatHealthTracker();
    seatHealth.ingest(ev({ type: 'unitDistributed', session: 'r-t', ord: 1, cli: 'codex' }));
    seatHealth.ingest(
      ev({
        type: 'unitOutputCaptured',
        session: 'r-t',
        ord: 1,
        attempt: 0,
        outputBytes: 64,
        stepStatus: 'timed_out',
        governed: false,
      }),
    );
    expect(seatHealth.healthFor('codex').status).toBe('active');
  });
});

describe("perf#4: the engine's distinguishing turn-timeout status (compat contract)", () => {
  it('stepStatus "timed_out" fires the turn-timeout sink and a loud log', () => {
    const timeouts: { session: string; ord?: number; attempt?: number }[] = [];
    const logs: string[] = [];
    const wd = new WorkerStallWatchdog({
      listExecuting: async () => [],
      broadcast: () => undefined,
      onTurnTimeout: (info) => timeouts.push(info),
      log: (m) => logs.push(m),
    });
    wd.ingest(
      ev({
        type: 'unitOutputCaptured',
        session: 'r-ceiling',
        ord: 6,
        attempt: 0,
        outputBytes: 12,
        stepStatus: 'timed_out',
        governed: true,
      }),
    );
    expect(timeouts).toEqual([{ session: 'r-ceiling', ord: 6, attempt: 0 }]);
    expect(logs.some((m) => m.includes('turn ceiling') && m.includes('NOT an operator cancel'))).toBe(
      true,
    );
  });

  it('the ambiguous "cancelled" spelling (old engines: operator OR timeout) triggers NOTHING', () => {
    // FAIL SAFE: against a current/older engine the new status never arrives, and a cancel must
    // never be acted on — an operator's Ctrl-C staying final is the whole point of the split.
    const timeouts: unknown[] = [];
    const wd = new WorkerStallWatchdog({
      listExecuting: async () => [],
      broadcast: () => undefined,
      onTurnTimeout: (info) => timeouts.push(info),
    });
    for (const stepStatus of ['cancelled', 'failed', 'ok', 'elicitation_failed', undefined]) {
      wd.ingest(
        ev({
          type: 'unitOutputCaptured',
          session: 'r-amb',
          ord: 1,
          attempt: 0,
          outputBytes: 0,
          ...(stepStatus !== undefined ? { stepStatus } : {}),
          governed: false,
        }),
      );
    }
    wd.ingest(ev({ type: 'runCancelled', session: 'r-amb' }));
    expect(timeouts).toEqual([]);
  });

  it('a throwing turn-timeout sink is contained and logged', () => {
    const logs: string[] = [];
    const wd = new WorkerStallWatchdog({
      listExecuting: async () => [],
      broadcast: () => undefined,
      onTurnTimeout: () => {
        throw new Error('audit disk full');
      },
      log: (m) => logs.push(m),
    });
    expect(() =>
      wd.ingest(
        ev({
          type: 'unitOutputCaptured',
          session: 'r-sink',
          ord: 1,
          attempt: 0,
          outputBytes: 0,
          stepStatus: 'timed_out',
          governed: false,
        }),
      ),
    ).not.toThrow();
    expect(logs.some((m) => m.includes('turn-timeout sink failed'))).toBe(true);
  });
});

describe('the reassign rung — recycle the wedged cursor unit in place', () => {
  it('notifies at the detection threshold, acts at the escalation threshold', async () => {
    const { wd, frames, reassigns, audited, tick } = build({ config: () => ({ minutes: 30 }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));

    tick(16 * MIN); // past detect (15), under escalate (30)
    await wd.sweep();
    expect(stalled(frames)).toHaveLength(1);
    expect(escalatedOf(frames)).toEqual([]);
    expect(reassigns).toEqual([]); // notified, not yet acted

    tick(15 * MIN); // 31 min quiet — past escalate
    await wd.sweep();
    const esc = escalatedOf(frames);
    expect(esc).toEqual([
      {
        type: 'workerStallEscalated',
        session: 'r-wedge',
        ord: 3,
        quietForMs: 31 * MIN,
        action: 'reassign',
        outcome: 'ok',
        needsYou: false, // the platform recovered on its own — narrator-visible, nobody paged
        escalations: 1,
        cli: 'claude',
        previousCli: 'claude', // no seat pool known → in-place recycle (perf#4 fallback)
      },
    ]);
    // No `seats` pool on the run → reassign IN PLACE: the engine-true cursor ord and the
    // unit's CURRENT seat (the pre-perf#4 behaviour, still the single-seat fallback).
    expect(reassigns).toEqual([{ runId: 'r-wedge', ord: 3, cli: 'claude' }]);
    // Audited: an automated actor touching a run is a privileged action.
    expect(audited).toEqual(esc);
  });

  it('escalates ONCE per quiet period; deeper silence in the SAME period adds nothing', async () => {
    const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes: 30 }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    tick(60 * MIN);
    await wd.sweep();
    await wd.sweep();
    expect(escalatedOf(frames)).toHaveLength(1);
    expect(reassigns).toHaveLength(1);
  });

  it('a new event re-arms; the second quiet period spends the second (last) budget slot', async () => {
    const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes: 30 }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toHaveLength(1);

    // The engine's own post-reassign events (unitReassigned, unitDispatched, …) are exactly
    // this: proof of life that restamps the clock and re-arms both stages.
    wd.ingest(ev({ type: 'unitReassigned', session: 'r-wedge', ord: 3, attempt: 1 }));
    tick(31 * MIN);
    await wd.sweep();
    const esc = escalatedOf(frames);
    expect(esc).toHaveLength(2);
    expect(esc[1]?.outcome).toBe('ok');
    expect(esc[1]?.escalations).toBe(2);
    expect(reassigns).toHaveLength(2);
  });

  it('a spent budget answers with outcome "exhausted", needsYou, and NO further engine calls', async () => {
    const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes: 30 }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    for (let period = 0; period < 2; period++) {
      tick(31 * MIN);
      await wd.sweep();
      wd.ingest(ev({ type: 'unitReassigned', session: 'r-wedge', ord: 3, attempt: period + 1 }));
    }
    expect(reassigns).toHaveLength(2); // DEFAULT_WORKER_STALL_MAX_ESCALATIONS
    expect(DEFAULT_WORKER_STALL_MAX_ESCALATIONS).toBe(2);

    tick(31 * MIN); // third quiet period — the budget is spent
    await wd.sweep();
    const esc = escalatedOf(frames);
    expect(esc).toHaveLength(3);
    expect(esc[2]).toMatchObject({
      action: 'reassign',
      outcome: 'exhausted',
      needsYou: true,
      escalations: 2,
    });
    expect(reassigns).toHaveLength(2); // nothing further was attempted
    // And once per quiet period holds for exhausted frames too.
    tick(60 * MIN);
    await wd.sweep();
    expect(escalatedOf(frames)).toHaveLength(3);
  });

  it('honors a custom budget and falls back to the default on an invalid one', async () => {
    const one = build({ config: () => ({ minutes: 30, maxPerRun: 1 }) });
    one.wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    one.tick(31 * MIN);
    await one.wd.sweep();
    one.wd.ingest(ev({ type: 'unitReassigned', session: 'r-wedge', ord: 3, attempt: 1 }));
    one.tick(31 * MIN);
    await one.wd.sweep();
    expect(one.reassigns).toHaveLength(1);
    expect(escalatedOf(one.frames)[1]?.outcome).toBe('exhausted');

    const invalid = build({ config: () => ({ minutes: 30, maxPerRun: 0 }) });
    invalid.wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    invalid.tick(31 * MIN);
    await invalid.wd.sweep();
    expect(invalid.reassigns).toHaveLength(1); // 0 is not "never act" — it is not a valid budget
  });

  it('a rejecting reassign is outcome "failed" with a bounded excerpt, and consumes budget', async () => {
    const { wd, frames, audited, tick } = build({
      config: () => ({ minutes: 30, maxPerRun: 1 }),
      reassign: async () => {
        throw new Error(`run r-wedge is not Executing (status: AwaitingHuman); ${'x'.repeat(400)}`);
      },
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    const esc = escalatedOf(frames);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ action: 'reassign', outcome: 'failed', needsYou: true, escalations: 1 });
    expect(esc[0]?.error).toContain('not Executing');
    expect(esc[0]?.error?.length).toBeLessThanOrEqual(300);
    expect(audited).toEqual(esc);

    // The failure consumed the (single-slot) budget: the next quiet period is exhausted, so a
    // rejecting engine is never hammered on the platform's own initiative.
    wd.ingest(ev({ type: 'gateRequested', session: 'r-wedge', ord: 3, prompt: 'ok?' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(escalatedOf(frames)[1]?.outcome).toBe('exhausted');
  });

  it('an unknown cursor (no ord anywhere) fails loud WITHOUT consuming budget', async () => {
    const { wd, frames, reassigns, tick } = build({
      runs: [{ id: 'r-noord' }], // no ord from the listing…
      config: () => ({ minutes: 30 }),
    });
    // …and the observed event names none either.
    wd.ingest(ev({ type: 'sessionStarted', session: 'r-noord', problem: 'p' }));
    tick(31 * MIN);
    await wd.sweep();
    const esc = escalatedOf(frames);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({
      action: 'reassign',
      outcome: 'failed',
      needsYou: true,
      escalations: 0, // nothing was attempted
    });
    expect(esc[0]?.error).toContain('cursor unit unknown');
    expect(reassigns).toEqual([]);
  });

  it('falls back to the last event ord when the run listing carries none', async () => {
    const { wd, reassigns, tick } = build({
      runs: [{ id: 'r-evord', cli: 'codex' }],
      config: () => ({ minutes: 30 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-evord', ord: 7, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toEqual([{ runId: 'r-evord', ord: 7, cli: 'codex' }]);
  });

  it('an escalation threshold below detection is clamped: the ladder never acts before it notifies', async () => {
    const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes: 1 }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(10 * MIN); // past the 1-min escalate ask, under the 15-min detection default
    await wd.sweep();
    expect(escalatedOf(frames)).toEqual([]);
    expect(reassigns).toEqual([]);

    tick(6 * MIN); // 16 min — both thresholds cross in ONE sweep: notify first, then act
    await wd.sweep();
    expect(frames.map((f) => f.type)).toEqual(['workerStalled', 'workerStallEscalated']);
    expect(reassigns).toHaveLength(1);
  });

  it('a config change applies live: arming mid-silence escalates on the next sweep', async () => {
    let minutes: number | undefined = undefined;
    const { wd, frames, reassigns, tick } = build({ config: () => ({ minutes }) });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(45 * MIN);
    await wd.sweep();
    expect(escalatedOf(frames)).toEqual([]); // disarmed

    minutes = 30; // PUT /settings landed
    await wd.sweep();
    expect(escalatedOf(frames)).toHaveLength(1);
    expect(reassigns).toHaveLength(1);
  });

  it('prunes with the run: leaving `executing` clears the budget; a NEW wedge is a new fact', async () => {
    let executing: ExecutingRun[] = [{ id: 'r-cycle', ord: 1, cli: 'claude' }];
    const { wd, frames, reassigns, tick } = build({
      listExecuting: async () => executing,
      config: () => ({ minutes: 30, maxPerRun: 1 }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-cycle', ord: 1, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toHaveLength(1); // budget spent

    executing = []; // the run left executing (gate, completion, cancel — not the sweep's business)
    await wd.sweep(); // prune
    executing = [{ id: 'r-cycle', ord: 1, cli: 'claude' }]; // …and it is back
    await wd.sweep(); // re-seed (fresh clock, fresh budget)
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toHaveLength(2); // acted again — the budget was reset with the run
    expect(escalatedOf(frames).every((f) => f.outcome === 'ok')).toBe(true);
  });

  it('a throwing audit sink cannot break the sweep or eat the frame', async () => {
    const { wd, frames, logs, tick } = build({
      config: () => ({ minutes: 30 }),
      audit: () => {
        throw new Error('audit disk full');
      },
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await expect(wd.sweep()).resolves.toBeUndefined();
    expect(escalatedOf(frames)).toHaveLength(1); // broadcast happened before the sink threw
    expect(logs.some((m) => m.includes('audit sink failed'))).toBe(true);
  });
});

describe('the notify rung — fail-loud without touching the run', () => {
  it('emits a needsYou frame per quiet period, never calls the engine, never exhausts', async () => {
    const { wd, frames, reassigns, audited, tick } = build({
      config: () => ({ minutes: 30, action: 'notify' }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    for (let period = 0; period < 4; period++) {
      tick(31 * MIN);
      await wd.sweep();
      wd.ingest(ev({ type: 'gateRequested', session: 'r-wedge', ord: 3, prompt: 'alive?' }));
    }
    const esc = escalatedOf(frames);
    expect(esc).toHaveLength(4); // notifying is free — no budget, no exhaustion
    expect(
      esc.every((f) => f.action === 'notify' && f.outcome === 'ok' && f.needsYou === true),
    ).toBe(true);
    expect(reassigns).toEqual([]); // the run was NOT touched
    expect(audited).toEqual(esc); // but every escalation is still on the audit trail
  });

  it('an unrecognized action falls back to the default (reassign)', async () => {
    expect(DEFAULT_WORKER_STALL_ESCALATE_ACTION).toBe('reassign');
    const { wd, reassigns, tick } = build({
      config: () => ({ minutes: 30, action: 'nudge' as unknown as 'notify' }),
    });
    wd.ingest(ev({ type: 'unitOutputDelta', session: 'r-wedge', ord: 3, text: 'x' }));
    tick(31 * MIN);
    await wd.sweep();
    expect(reassigns).toHaveLength(1);
  });
});

// ── Settings surface: PUT /settings admits the documented values, 400s the rest ──────────────

/** In-memory settings store with the adapter's merge semantics (defaults + patch). */
function memoryAdapter(initial?: Partial<SystemSettings>): CoreAdapter {
  let store: SystemSettings = { graphNodeLimit: 150, ...initial };
  return {
    getSettings: async () => ({ ...store }),
    updateSettings: async (patch: Partial<SystemSettings>) => {
      store = { ...store, ...patch };
      return { ...store };
    },
  } as unknown as CoreAdapter;
}

describe('PUT/GET /settings — the crew#341 escalation knobs', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function buildApp(): FastifyInstance {
    const a = Fastify({ logger: false });
    registerRoutes(a, memoryAdapter(), new GateCache(), new ElicitationCache());
    return a;
  }

  it('round-trips the armed trio, and 0 spells escalation OFF', async () => {
    app = buildApp();
    await app.ready();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: {
        workerStallEscalateMinutes: 30,
        workerStallEscalateAction: 'notify',
        workerStallMaxEscalations: 3,
      },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings' });
    const settings = (get.json() as { settings: SystemSettings }).settings;
    expect(settings.workerStallEscalateMinutes).toBe(30);
    expect(settings.workerStallEscalateAction).toBe('notify');
    expect(settings.workerStallMaxEscalations).toBe(3);

    const off = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      payload: { workerStallEscalateMinutes: 0 },
    });
    expect(off.statusCode).toBe(200);
    expect(
      (off.json() as { settings: SystemSettings }).settings.workerStallEscalateMinutes,
    ).toBe(0);
  });

  it('refuses out-of-contract values with a 400 naming the constraint — never a silent drop', async () => {
    app = buildApp();
    await app.ready();
    const bad: Record<string, unknown>[] = [
      { workerStallEscalateMinutes: -1 },
      { workerStallEscalateMinutes: 1441 },
      { workerStallEscalateMinutes: 1.5 },
      { workerStallEscalateMinutes: 'soon' },
      { workerStallEscalateAction: 'nudge' },
      { workerStallEscalateAction: true },
      { workerStallMaxEscalations: 0 },
      { workerStallMaxEscalations: 11 },
      { workerStallMaxEscalations: 2.5 },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'PUT', url: '/api/v1/settings', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect((res.json() as { error: string }).error).toContain(Object.keys(payload)[0] ?? '');
    }
  });
});

// ── Integration: the daemon seam end-to-end (relay → sweep → reassign + /ws + audit) ─────────

type Listener = (event: CoreEvent) => void;

const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

afterEach(() => {
  if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
  else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
});

/** One executing run whose view names the cursor unit the way the real engine does. */
function executingView(
  id: string,
  unitIx: number,
  ords: { ord: number; cli: string | null }[],
  clis?: string[],
): SessionView {
  return {
    session: { id, status: 'executing', unit_ix: unitIx, ...(clis !== undefined ? { clis } : {}) },
    units: ords.map((u, i) => ({ id: `${id}:u${i}`, ord: u.ord, assigned_cli: u.cli })),
  } as unknown as SessionView;
}

describe('stall escalation through the real server (/ws + audit + adapter.reassignUnit)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stall-esc-'));
  });

  afterEach(() => {
    removeScratch(dir);
  });

  it('recycles the wedged cursor unit, reports on /ws, audits, and re-arms on engine events', async () => {
    const listeners = new Set<Listener>();
    const reassigns: { runId: string; ord: number; cli: string | null }[] = [];
    // Units DELIBERATELY out of order with ords ≠ indexes: the mapping must resolve the cursor
    // the way the engine does (sort by ord, index unit_ix) — unit_ix 1 of ords [2,4,6] is ord 4.
    const mockAdapter = {
      getSettings: async (): Promise<SystemSettings> => ({ graphNodeLimit: 150 }),
      projectsSupported: (): boolean => false,
      sessionsDetail: async (): Promise<SessionView[]> => [
        executingView(
          'r-esc',
          1,
          [
            { ord: 6, cli: null },
            { ord: 2, cli: 'claude' },
            { ord: 4, cli: 'codex' },
          ],
          // The run's seat pool — the perf#4 failover candidates: codex (the cursor seat)
          // stalled, so the reassign must route to claude.
          ['claude', 'codex'],
        ),
      ],
      reassignUnit: async (runId: string, ord: number, cli?: string | null): Promise<void> => {
        reassigns.push({ runId, ord, cli: cli ?? null });
        // The real engine answers a reassign with events; they restamp the liveness clock.
        for (const l of listeners) {
          l({ type: 'unitReassigned', session: runId, ord, attempt: 1 } as unknown as CoreEvent);
        }
      },
      onEvent: (l: Listener): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as CoreAdapter;

    const auditPath = join(dir, 'audit.log');
    const app = await createServer(mockAdapter, {
      auditPath,
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      // Opt in with a compressed clock: detect at ~240 ms, act at ~480 ms, 40 ms sweeps,
      // one automatic recovery before fail-loud.
      stallWatchdog: {
        enabled: true,
        sweepIntervalMs: 40,
        stallMinutes: 0.004,
        escalateMinutes: 0.008,
        maxEscalations: 1,
      },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const received: CoreEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data: Buffer | string) => {
      received.push(JSON.parse(data.toString()) as CoreEvent);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const ofType = (t: string): CoreEvent[] => received.filter((f) => f.type === t);
    const waitFor = async (pred: () => boolean, label: string, ms = 5_000): Promise<void> => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };

    try {
      // Proof of life on the relay, then silence: detection, then the escalation.
      for (const l of listeners) l({ type: 'unitOutputDelta', session: 'r-esc', ord: 4, text: 'x' } as unknown as CoreEvent);
      await waitFor(() => ofType('workerStallEscalated').length >= 1, 'first escalation');

      // The ladder notified before it acted.
      expect(ofType('workerStalled').length).toBeGreaterThanOrEqual(1);

      const first = ofType('workerStallEscalated')[0] as unknown as WorkerStallEscalatedFrame;
      expect(first.session).toBe('r-esc');
      expect(first.ord).toBe(4); // sorted-by-ord cursor, NOT the raw unit index
      expect(first.action).toBe('reassign');
      expect(first.outcome).toBe('ok');
      expect(first.needsYou).toBe(false);
      // perf#4: the reassign routed AWAY from the stalled cursor seat (codex) to the other
      // pool seat — target and stalled seat both on the frame.
      expect(first.cli).toBe('claude');
      expect(first.previousCli).toBe('codex');
      expect(reassigns).toEqual([{ runId: 'r-esc', ord: 4, cli: 'claude' }]);

      // The engine's reassign events re-armed the watchdog; the budget (1) is now spent, so
      // the SECOND quiet period must fail loud instead of acting again.
      await waitFor(
        () => ofType('workerStallEscalated').some((f) => f.outcome === 'exhausted'),
        'exhausted escalation',
      );
      const exhausted = ofType('workerStallEscalated').find((f) => f.outcome === 'exhausted');
      expect(exhausted?.needsYou).toBe(true);
      expect(reassigns).toHaveLength(1); // nothing further was attempted

      // The audit trail carries one run.stall.escalated line per escalation, system actor.
      // Appends are serialized on the AuditLog's promise chain (loud-non-fatal posture), so
      // POLL the file rather than racing the flush.
      type AuditLine = { action: string; actor: { id: string; kind: string }; runId?: string; detail?: Record<string, unknown> };
      const readEscalations = (): AuditLine[] => {
        let raw = '';
        try {
          raw = readFileSync(auditPath, 'utf8');
        } catch {
          return [];
        }
        return raw
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as AuditLine)
          .filter((e) => e.action === 'run.stall.escalated');
      };
      await waitFor(() => readEscalations().length >= 2, 'audit lines flushed');
      const escalations = readEscalations();
      expect(escalations[0]?.actor).toMatchObject({ id: 'stall-watchdog', kind: 'system' });
      expect(escalations[0]?.runId).toBe('r-esc');
      expect(escalations[0]?.detail).toMatchObject({ action: 'reassign', outcome: 'ok', ord: 4 });
      expect(escalations.some((e) => e.detail?.['outcome'] === 'exhausted')).toBe(true);
    } finally {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      await app.close();
    }
  }, 15_000);

  it('stays detection-only through the real server on the explicit opt-out (workerStallEscalateMinutes: 0)', async () => {
    const listeners = new Set<Listener>();
    let reassignCalls = 0;
    const mockAdapter = {
      // perf#4 flipped the DEFAULT to armed (30 min): absent no longer spells OFF, an explicit
      // 0 does. This store carries the opt-out — exactly a production daemon that disarmed.
      getSettings: async (): Promise<SystemSettings> => ({
        graphNodeLimit: 150,
        workerStallEscalateMinutes: 0,
      }),
      projectsSupported: (): boolean => false,
      sessionsDetail: async (): Promise<SessionView[]> => [
        executingView('r-default', 0, [{ ord: 1, cli: 'claude' }]),
      ],
      reassignUnit: async (): Promise<void> => {
        reassignCalls++;
      },
      onEvent: (l: Listener): (() => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as unknown as CoreAdapter;

    const app = await createServer(mockAdapter, {
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      // NO escalate override — the settings store's explicit 0 must be honoured as-is (the
      // server-side default fallback applies only when the setting is ABSENT).
      stallWatchdog: { enabled: true, sweepIntervalMs: 40, stallMinutes: 0.004 },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    const received: CoreEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data: Buffer | string) => {
      received.push(JSON.parse(data.toString()) as CoreEvent);
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    try {
      for (const l of listeners) l({ type: 'unitOutputDelta', session: 'r-default', ord: 1, text: 'x' } as unknown as CoreEvent);
      const t0 = Date.now();
      while (Date.now() - t0 < 700) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Detection fired (many quiet periods deep by now)…
      expect(received.some((f) => f.type === 'workerStalled')).toBe(true);
      // …and NOTHING acted: no escalation frame, no engine call. Detection-only, bit-for-bit.
      expect(received.filter((f) => f.type === 'workerStallEscalated')).toEqual([]);
      expect(reassignCalls).toBe(0);
    } finally {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      await app.close();
    }
  }, 15_000);
});
