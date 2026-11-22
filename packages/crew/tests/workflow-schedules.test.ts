/**
 * DES-RUNS-REVIEW-001 §2: the generic workflow scheduler. It fires on cadence, survives a restart, never runs a
 * schedule twice at once, skips while the last run is going, waits while another run works, backs off a refusal,
 * and "Run it now" obeys the same guards. The tick is driven directly with a fake clock and adapter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/api/audit.js';
import type { Actor } from '../src/core/types.js';
import { registerScheduleRoutes } from '../src/schedules/routes.js';
import { WorkflowScheduler, cancelOnItsRecord, type ScheduledLaunch } from '../src/schedules/scheduler.js';
import { DEFAULT_EVALS_SCHEDULE_ID, DEFAULT_REVIEW_EVERY_HOURS, DEFAULT_REVIEW_SCHEDULE_ID, ScheduleStore } from '../src/schedules/store.js';
import { ReviewPreparationRefused } from '../src/insights/review-service.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'workflow-schedules-'));
  dirs.push(d);
  return d;
}

const T0 = new Date('2026-10-27T00:00:00Z');
const H = 3_600_000;

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

function rig(opts: { path?: string; refuse?: boolean; refusalHookThrows?: boolean; cancelFails?: boolean; cancelHangs?: boolean; onSessions?: (calls: number) => void; beforeFresh?: () => void; duringCancel?: () => void } = {}) {
  const path = opts.path ?? join(scratch(), 'daemon-schedules.json');
  const runs: Record<string, string> = {};
  const clis: Record<string, string[]> = {};
  const cancels: { runId: string; reason: string }[] = [];
  let sessionReads = 0;
  const launches: { id: string; runId: string; trigger: string }[] = [];
  const clock = { now: T0 };
  const store = new ScheduleStore(path);
  const launch: ScheduledLaunch = async (row, runId, trigger) => {
    if (opts.refuse === true) throw new Error('engine said no');
    launches.push({ id: row.id, runId, trigger });
    runs[runId] = 'executing';
    return runId;
  };
  const ticks: number[] = [];
  const refusals: { id: string; reason: string }[] = [];
  const scheduler = new WorkflowScheduler({
    store,
    sessionsDetail: async () => {
      opts.onSessions?.(++sessionReads);
      return Object.entries(runs).map(([id, status]) => ({ session: { id, status, clis: clis[id] ?? ['claude'] }, units: [] }) as never);
    },
    launch,
    runViewFresh: async (runId) => {
      opts.beforeFresh?.();
      return runs[runId] === undefined ? undefined : ({ session: { id: runId, status: runs[runId], clis: clis[runId] ?? ['claude'] }, units: [] } as never);
    },
    cancel: async (runId, reason) => {
      if (opts.cancelFails === true) throw new Error('engine refused the cancel');
      if (opts.cancelHangs === true) return new Promise<string>(() => undefined);
      opts.duringCancel?.();
      cancels.push({ runId, reason });
      // The engine answers an already-ended run's end; otherwise it cancels.
      if (TERMINAL_STATES.has(runs[runId] ?? '')) return runs[runId]!;
      runs[runId] = 'cancelled';
      return 'cancelled';
    },
    onTick: [async () => { ticks.push(1); }],
    onScheduledRefusal: (row, reason) => {
      refusals.push({ id: row.id, reason });
      if (opts.refusalHookThrows === true) throw new Error('the trail is down');
    },
    log: () => undefined,
    now: () => clock.now,
  });
  const at = (h: number): void => { clock.now = new Date(T0.getTime() + h * H); };
  return { path, store, scheduler, runs, clis, cancels, launches, at, ticks, clock, refusals };
}

describe('the schedule store', () => {
  it('seeds "review recent work every 2 days" once, on a fresh store only', () => {
    const r = rig();
    r.store.seedDefault(T0);
    const row = r.store.get(DEFAULT_REVIEW_SCHEDULE_ID);
    expect(row?.workflow).toBe('review-recent-work');
    expect(row?.everyHours).toBe(DEFAULT_REVIEW_EVERY_HOURS);
    expect(row?.enabled).toBe(true);
    expect(row?.nextDueAt).toBe(new Date(T0.getTime() + 48 * H).toISOString());
    // The default evals (DES-DEFAULT-EVALS-001) are seeded beside it on the same cadence, listed (and so launched) after it.
    expect(r.store.get(DEFAULT_EVALS_SCHEDULE_ID)).toMatchObject({ workflow: 'run-evals', everyHours: DEFAULT_REVIEW_EVERY_HOURS, enabled: true });
    expect(r.store.list().map((x) => x.id)).toEqual([DEFAULT_REVIEW_SCHEDULE_ID, DEFAULT_EVALS_SCHEDULE_ID]);
    // A person deletes them: a restart does not bring either back.
    r.store.delete(DEFAULT_REVIEW_SCHEDULE_ID);
    r.store.delete(DEFAULT_EVALS_SCHEDULE_ID);
    const again = new ScheduleStore(r.path);
    again.seedDefault(T0);
    expect(again.list()).toEqual([]);
  });

  it('drops a malformed row, never the file', () => {
    const path = join(scratch(), 'daemon-schedules.json');
    writeFileSync(path, JSON.stringify({ schedules: { good: { workflow: 'bug', everyHours: 24, enabled: true, nextDueAt: T0.toISOString() }, bad: { workflow: 'bug', everyHours: 2 } } }));
    expect(new ScheduleStore(path).list().map((r) => r.id)).toEqual(['good']);
  });
});

describe('the scheduler', () => {
  it('fires on cadence: not before it is due, once when due, then one interval later', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.at(23);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(0);
    r.at(24);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
    r.runs[r.launches[0]?.runId as string] = 'completed';
    r.at(30);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
    expect(r.store.get('nightly')?.lastOutcome).toBe('completed');
    r.at(48);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(2);
    expect(r.ticks.length).toBe(4);
  });

  it('survives a restart: the next due time and the open slot are on disk', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.at(24);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
    const runId = r.launches[0]?.runId as string;
    // The daemon restarts: a new store and scheduler over the same file and the same (still running) run.
    const restarted = rig({ path: r.path });
    restarted.runs[runId] = 'executing';
    restarted.at(25);
    await restarted.scheduler.sweep();
    expect(restarted.launches).toHaveLength(0);
    const row = restarted.store.get('nightly');
    expect(row?.lastRunId).toBe(runId);
    expect(row?.nextDueAt).toBe(new Date(T0.getTime() + 48 * H).toISOString());
    // A missed interval (the daemon was down for days) coalesces into ONE run.
    restarted.runs[runId] = 'completed';
    restarted.at(24 * 5);
    await restarted.scheduler.sweep();
    await restarted.scheduler.sweep();
    expect(restarted.launches).toHaveLength(1);
  });

  it('never doubles up: two sweeps at once launch once, and a still-running last run is skipped', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.at(24);
    await Promise.all([r.scheduler.sweep(), r.scheduler.sweep(), r.scheduler.sweep()]);
    expect(r.launches).toHaveLength(1);
    // The run parks on a person for two more intervals: still skipped, never a second run, and the note names it.
    const first = r.launches[0]?.runId as string;
    r.runs[first] = 'awaiting_human';
    r.at(72);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
    // Byte-identical to main's note (every shipped studio renders a `skipped` note); the new detail is structured.
    expect(r.store.get('nightly')?.lastNote).toBe(`skipped: its last run ${first} is waiting on you (awaiting_human)`);
    const since = new Date(T0.getTime() + 72 * H).toISOString();
    expect(r.store.get('nightly')?.blocked).toMatchObject({ since, missedDue: 1, target: { kind: 'run', runId: first } });
    // Any other open status keeps the plain note.
    r.runs[first] = 'executing';
    await r.scheduler.sweep();
    expect(r.store.get('nightly')?.lastNote).toBe('skipped: its last run is still going');
    r.runs[first] = 'awaiting_human';
    // Its run ends: the next sweep fires it (the due time never moved).
    r.runs[r.launches[0]?.runId as string] = 'cancelled';
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(2);
  });

  describe('crew#1578: a stuck last run never blocks its schedule forever', () => {
    async function launched(r: ReturnType<typeof rig>): Promise<string> {
      r.store.put('nightly', { workflow: 'run-evals', everyHours: 24 }, T0);
      r.at(24);
      await r.scheduler.sweep();
      expect(r.launches).toHaveLength(1);
      return r.launches[0]!.runId;
    }

    it('a run still planning with no seats 6 h after its launch is cancelled by its schedule, which launches the next due time', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.at(29); // 5 h after the launch: not yet
      await r.scheduler.sweep();
      expect(r.cancels).toEqual([]);
      r.at(30); // 6 h after the launch, long before the next due time: cancelled now (codex r1 #10), not launched yet
      await r.scheduler.sweep();
      expect(r.cancels).toEqual([{ runId: first, reason: 'cancelled by its schedule: no seats for 6 h' }]);
      expect(r.store.get('nightly')).toMatchObject({ lastOutcome: 'cancelled', lastNote: `its last run ${first} was cancelled by its schedule: no seats for 6 h` });
      expect(r.launches).toHaveLength(1);
      r.at(48); // the next due time launches
      await r.scheduler.sweep();
      expect(r.launches).toHaveLength(2);
      expect(r.store.get('nightly')?.lastRunId).toBe(r.launches[1]!.runId);
    });

    it('never cancels a run with seats, an executing one, one waiting on a person, or one under 6 h (KEY)', async () => {
      for (const [status, seats, hours] of [['planning', ['claude'], 48], ['distributing', ['codex'], 48], ['executing', [], 48], ['awaiting_human', [], 48], ['distributing', [], 29]] as const) {
        const r = rig();
        const first = await launched(r);
        r.runs[first] = status;
        r.clis[first] = [...seats];
        r.at(hours);
        await r.scheduler.sweep();
        expect(r.cancels, `${status} ${seats.join(',')} ${hours}`).toEqual([]);
        expect(r.launches).toHaveLength(1);
      }
    });

    it('a cancel that fails launches nothing and says why', async () => {
      const r = rig({ cancelFails: true });
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.at(48);
      await r.scheduler.sweep();
      expect(r.launches).toHaveLength(1);
      expect(r.store.get('nightly')?.lastNote).toBe(`skipped: its last run ${first} has had no seats for 6 h and cancelling it failed (engine refused the cancel)`);
    });

    it('a run waiting on you blocks plainly: since when, which gate, how many due times; cleared when it ends', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'awaiting_human';
      r.at(30); // seen waiting before any due time (codex r1 #4/#5): blocked since now, nothing skipped yet
      await r.scheduler.sweep();
      const since = new Date(T0.getTime() + 30 * H).toISOString();
      expect(r.store.get('nightly')?.blocked).toEqual({
        reason: 'awaiting_human',
        runId: first,
        since,
        missedDue: 0,
        target: { kind: 'run', runId: first },
        detail: `blocked: the last run ${first} is waiting for you since ${since}; 0 due times skipped`,
      });
      r.at(48); // the first due time while it waits: skipped, and the row's note (what studio shows) says so
      await r.scheduler.sweep();
      const one = `blocked: the last run ${first} is waiting for you since ${since}; 1 due time skipped`;
      // lastNote keeps main's words (what a shipped studio shows); the sentence and the gate are in `blocked`.
      expect(r.store.get('nightly')).toMatchObject({ blocked: { since, missedDue: 1, detail: one, target: { kind: 'run', runId: first } }, lastNote: `skipped: its last run ${first} is waiting on you (awaiting_human)` });
      r.at(96); // two more due times: the count moves, the time it started waiting does not
      await r.scheduler.sweep();
      expect(r.store.get('nightly')?.blocked).toMatchObject({ since, missedDue: 3, detail: `blocked: the last run ${first} is waiting for you since ${since}; 3 due times skipped` });
      expect(r.cancels).toEqual([]);
      // It survives a restart (the store reads it back).
      expect(new ScheduleStore(r.path).get('nightly')?.blocked).toMatchObject({ runId: first, missedDue: 3 });
      r.runs[first] = 'completed';
      await r.scheduler.sweep();
      expect(r.store.get('nightly')?.blocked).toBeNull();
      expect(r.launches).toHaveLength(2);
    });

    it('a blocked record clears when the run moves on, though the row is disabled (codex r1 #6)', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'awaiting_human';
      r.at(48);
      await r.scheduler.sweep();
      r.store.put('nightly', { workflow: 'run-evals', everyHours: 24, enabled: false }, r.clock.now);
      r.runs[first] = 'executing';
      await r.scheduler.sweep();
      expect(r.store.get('nightly')?.blocked).toBeNull();
    });

    it('a run that got seats between the sweep read and the cancel is left alone (codex r1 #1)', async () => {
      // The sweep's own read saw no seats; the fresh read right before the cancel sees one.
      const r = rig({ beforeFresh: () => { r.clis[first] = ['claude']; } });
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.at(31);
      await r.scheduler.sweep();
      expect(r.cancels).toEqual([]);
    });

    it('a cancel that never answers is reported failed and the sweep goes on (codex r1 #7)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const r = rig({ cancelHangs: true });
        const first = await launched(r);
        r.runs[first] = 'planning';
        r.clis[first] = [];
        r.at(31);
        const swept = r.scheduler.sweep();
        await vi.advanceTimersByTimeAsync(60_000);
        await swept;
        expect(r.store.get('nightly')?.lastNote).toBe(`skipped: its last run ${first} has had no seats for 6 h and cancelling it failed (no answer within 60 s)`);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a schedule replaced while its cancel was in flight gets none of the old run\'s bookkeeping (codex r2 #2)', async () => {
      const r = rig({
        duringCancel: () => {
          r.store.delete('nightly');
          r.store.put('nightly', { workflow: 'run-evals', everyHours: 24, enabled: false }, new Date(r.clock.now.getTime() + 1));
        },
      });
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.at(31);
      await r.scheduler.sweep();
      expect(r.store.get('nightly')).toMatchObject({ lastRunId: null, lastOutcome: null, lastNote: null, enabled: false });
    });

    it('a blocked run that ends while its row is disabled clears its blocked record (codex r2 #6)', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'awaiting_human';
      r.at(48);
      await r.scheduler.sweep();
      r.store.put('nightly', { workflow: 'run-evals', everyHours: 24, enabled: false }, r.clock.now);
      r.runs[first] = 'completed';
      await r.scheduler.sweep();
      expect(r.store.get('nightly')).toMatchObject({ lastOutcome: 'completed', blocked: null });
    });

    it('a persisted blocked sentence is derived from its fields, never trusted (codex r2 #9)', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'awaiting_human';
      r.at(48);
      await r.scheduler.sweep();
      const raw = JSON.parse(readFileSync(r.path, 'utf8')) as unknown;
      const doc = JSON.stringify(raw).replace(/blocked: the last run [^"]*skipped/gu, 'WRONG DETAIL');
      writeFileSync(r.path, doc);
      expect(new ScheduleStore(r.path).get('nightly')?.blocked?.detail).toMatch(/^blocked: the last run .* 1 due time skipped$/u);
    });

    it('a run that ended before the cancel landed keeps its own end and records no cancel (codex r1 #8)', async () => {
      const audit = new AuditLog(join(scratch(), 'audit.log'), () => undefined);
      const actor = { id: 'workflow-schedule', kind: 'system', trust: 'operator' } as const;
      const cancel = cancelOnItsRecord(async () => 'completed', (runId, detail) => audit.record('run.cancelled', actor, { runId, detail }));
      expect(await cancel('r-done', 'x')).toBe('completed');
      expect(await audit.read({ runId: 'r-done' })).toEqual([]);
    });

    it('an unreadable launch time or seat list never makes a run stuck (codex r1 #3)', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.store.update('nightly', { lastRunAt: 'not-a-time' }, r.clock.now);
      r.at(48);
      await r.scheduler.sweep();
      expect(r.cancels).toEqual([]);
    });

    it('Run it now writes what it found on the row before refusing (codex r1 #13)', async () => {
      const r = rig({ cancelFails: true });
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.store.put('nightly', { workflow: 'run-evals', everyHours: 24, enabled: false }, r.clock.now);
      r.at(31);
      await expect(r.scheduler.runNow('nightly')).rejects.toThrow(/cancelling it failed/);
      expect(r.store.get('nightly')?.lastNote).toMatch(/cancelling it failed \(engine refused the cancel\)/);
    });

    it("the cancel is on the run's own record: run.cancelled by the schedule, with the reason (SAYS-VS-DOES)", async () => {
      const audit = new AuditLog(join(scratch(), 'audit.log'), () => undefined);
      const actor = { id: 'workflow-schedule', kind: 'system', trust: 'operator' } as const;
      const cancel = cancelOnItsRecord(async () => 'cancelled', (runId, detail) => audit.record('run.cancelled', actor, { runId, detail }));
      await cancel('r-stuck', 'cancelled by its schedule: no seats for 6 h');
      const entries = await audit.read({ runId: 'r-stuck' });
      expect(entries).toMatchObject([{ action: 'run.cancelled', actor: { id: 'workflow-schedule' }, detail: { status: 'cancelled', reason: 'cancelled by its schedule: no seats for 6 h' } }]);
      // An engine that refuses the cancel records nothing, and the scheduler hears the failure.
      const refused = cancelOnItsRecord(async () => { throw new Error('no'); }, (runId, detail) => audit.record('run.cancelled', actor, { runId, detail }));
      await expect(refused('r-other', 'x')).rejects.toThrow('no');
      expect(await audit.read({ runId: 'r-other' })).toEqual([]);
    });

    it('Run it now cancels a stuck last run the same way, and starts', async () => {
      const r = rig();
      const first = await launched(r);
      r.runs[first] = 'planning';
      r.clis[first] = [];
      r.at(31);
      await expect(r.scheduler.runNow('nightly')).resolves.toBeTypeOf('string');
      expect(r.cancels.map((c) => c.runId)).toEqual([first]);
      expect(r.launches).toHaveLength(2);
    });
  });

  it('a daemon that dies between the engine accepting a run and recording it never launches that interval again', async () => {
    const path = join(scratch(), 'daemon-schedules.json');
    let restartedLaunches = -1;
    const r = rig({ path });
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    // The "engine" accepts the run, and before crew records it the daemon restarts: a new store and scheduler
    // over the same file see the reserved run id, and the run (parked on a person) holds the slot.
    (r.scheduler as unknown as { deps: { launch: ScheduledLaunch } }).deps.launch = async (_row, runId) => {
      const restarted = rig({ path });
      restarted.runs[runId] = 'awaiting_human';
      // Even once the next interval is due, the reserved run (parked on a person) holds the slot.
      restarted.at(49);
      await restarted.scheduler.sweep();
      restartedLaunches = restarted.launches.length;
      expect(restarted.store.get('nightly')?.lastOutcome).toBe('launched');
      return runId;
    };
    r.at(24);
    await r.scheduler.sweep();
    expect(restartedLaunches).toBe(0);
  });

  it('a reservation the engine never saw lets go after a short grace', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.store.update('nightly', { lastRunId: 'ghost', lastRunAt: T0.toISOString(), lastOutcome: 'launching', nextDueAt: T0.toISOString() }, T0);
    r.at(0.1);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(0);
    r.at(0.5);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
  });

  it('launches on the next sweep while another unrelated run is executing (crew#1544)', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.runs['someone-else'] = 'executing';
    r.at(24);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
  });

  it('Run it now launches while another unrelated run is executing', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.runs['someone-else'] = 'executing';
    r.at(1);
    await r.scheduler.runNow('nightly');
    expect(r.launches).toHaveLength(1);
  });

  it('a last run parked on a person is named in the 409 text', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.at(1);
    const runId = await r.scheduler.runNow('nightly');
    r.runs[runId] = 'awaiting_human';
    await expect(r.scheduler.runNow('nightly')).rejects.toThrow(`not started: its last run ${runId} is waiting on you (awaiting_human)`);
  });

  it('a refused launch backs off and says why; a disabled schedule never fires', async () => {
    const r = rig({ refuse: true });
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.store.put('off', { workflow: 'bug', everyHours: 24, enabled: false }, T0);
    r.at(24);
    await r.scheduler.sweep();
    const row = r.store.get('nightly');
    expect(row?.lastOutcome).toBe('refused');
    expect(row?.lastNote).toBe('engine said no');
    expect(row?.nextDueAt).toBe(new Date(T0.getTime() + 26 * H).toISOString());
    expect(r.store.get('off')?.lastOutcome).toBeNull();
  });

  it('a refused scheduled launch is told once, off the schedule row; Run it now answers its own refusal (crew#1656)', async () => {
    const r = rig({ refuse: true });
    r.store.put('evals', { workflow: 'run-evals', everyHours: 48 }, T0);
    r.at(48);
    await r.scheduler.sweep();
    expect(r.refusals).toEqual([{ id: 'evals', reason: 'engine said no' }]);
    // Backed off: the next sweeps do not attempt (or tell) it again.
    await r.scheduler.sweep();
    expect(r.refusals).toHaveLength(1);
    // A person's Run it now gets the refusal as its answer, and is not told a second time.
    await expect(r.scheduler.runNow('evals')).rejects.toThrow('engine said no');
    expect(r.refusals).toHaveLength(1);
    // Once due again after the back-off, the next refused attempt is told again.
    r.at(48 + 24);
    await r.scheduler.sweep();
    expect(r.refusals).toHaveLength(2);
  });

  it('a failing refusal hook never changes the refusal the row records (crew#1656)', async () => {
    const r = rig({ refuse: true, refusalHookThrows: true });
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.at(24);
    await r.scheduler.sweep();
    expect(r.refusals).toHaveLength(1);
    const row = r.store.get('nightly');
    expect(row?.lastOutcome).toBe('refused');
    expect(row?.lastNote).toBe('engine said no');
    expect(row?.failures).toBe(1);
    expect(row?.nextDueAt).toBe(new Date(T0.getTime() + 26 * H).toISOString());
  });

  it('Run it now obeys the same guards and keeps the cadence from the run', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 48 }, T0);
    r.at(1);
    const runId = await r.scheduler.runNow('nightly');
    expect(r.launches).toEqual([{ id: 'nightly', runId, trigger: 'manual' }]);
    expect(r.store.get('nightly')?.nextDueAt).toBe(new Date(T0.getTime() + 49 * H).toISOString());
    await expect(r.scheduler.runNow('nightly')).rejects.toThrow(/last run is still going/u);
    expect(r.launches).toHaveLength(1);
    // Its run ends: Run it now folds it first (the tick hooks run, the outcome is recorded), then launches.
    r.runs[runId] = 'completed';
    const ticksBefore = r.ticks.length;
    await r.scheduler.runNow('nightly');
    expect(r.ticks.length).toBe(ticksBefore + 1);
    expect(r.launches).toHaveLength(2);
  });
});

describe('the schedule routes', () => {
  it("(crew#1592) Run it now: a review that can't be prepared (its seat, newWorkSeats) answers 409 with the hand launch's words, not 502", async () => {
    const path = join(scratch(), 'schedules.json');
    const store = new ScheduleStore(path);
    store.seedDefault(T0);
    const scheduler = new WorkflowScheduler({
      store,
      sessionsDetail: async () => [],
      launch: async () => { throw new ReviewPreparationRefused('the newWorkSeats setting (which seats new work may use) is not a list of seat keys'); },
      log: () => undefined,
      now: () => T0,
    });
    const app = Fastify();
    registerScheduleRoutes(app, { store, scheduler, knowsWorkflow: () => true, lastReview: () => null, audit: AuditLog.noop(), now: () => T0 });
    const run = await app.inject({ method: 'POST', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}/run` });
    expect(run.statusCode).toBe(409);
    expect(run.json().error).toMatch(/^the review could not be prepared: .*newWorkSeats/);
  });

  it('lists, saves, runs now and deletes; only a person may write', async () => {
    const r = rig();
    r.store.seedDefault(T0);
    const app = Fastify();
    let actor: Actor | undefined;
    app.addHook('preHandler', async (req) => { if (actor !== undefined) (req as { actor?: Actor }).actor = actor; });
    registerScheduleRoutes(app, {
      store: r.store,
      scheduler: r.scheduler,
      knowsWorkflow: (id) => id === 'review-recent-work' || id === 'bug',
      lastReview: () => ({ runId: 'prev', launchedAt: T0.toISOString(), endedAt: T0.toISOString(), status: 'completed' }),
      audit: AuditLog.noop(),
      now: () => T0,
    });
    const list = (await app.inject({ method: 'GET', url: '/api/v1/schedules' })).json();
    expect(list.schedules[0].id).toBe(DEFAULT_REVIEW_SCHEDULE_ID);
    expect(list.schedules[0].lastReview.status).toBe('completed');
    const put = await app.inject({ method: 'PUT', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}`, payload: { workflow: 'review-recent-work', everyHours: 72, enabled: false, projectIds: ['p1'] } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ everyHours: 72, enabled: false, projectIds: ['p1'] });
    expect((await app.inject({ method: 'PUT', url: '/api/v1/schedules/x', payload: { workflow: 'nope', everyHours: 24 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/schedules/x', payload: { workflow: 'bug', everyHours: 2 } })).statusCode).toBe(400);
    const run = await app.inject({ method: 'POST', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}/run` });
    expect(run.statusCode).toBe(200);
    expect(run.json().runId).toBe(r.launches[0]?.runId);
    expect((await app.inject({ method: 'POST', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}/run` })).statusCode).toBe(409);
    actor = { id: 'w', kind: 'system', trust: 'operator' } as Actor;
    expect((await app.inject({ method: 'PUT', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}`, payload: { workflow: 'review-recent-work', everyHours: 24 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}/run` })).statusCode).toBe(403);
    actor = undefined;
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/schedules/${DEFAULT_REVIEW_SCHEDULE_ID}` })).json()).toEqual({ deleted: true, id: DEFAULT_REVIEW_SCHEDULE_ID });
    // The review row is gone; the default evals' row (seeded beside it) is untouched.
    expect(Object.keys(JSON.parse(readFileSync(r.path, 'utf8')).schedules)).toEqual([DEFAULT_EVALS_SCHEDULE_ID]);
    await app.close();
  });
});
