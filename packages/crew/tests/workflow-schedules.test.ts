/**
 * DES-RUNS-REVIEW-001 §2: the generic workflow scheduler. It fires on cadence, survives a restart, never runs a
 * schedule twice at once, skips while the last run is going, waits while another run works, backs off a refusal,
 * and "Run it now" obeys the same guards. The tick is driven directly with a fake clock and adapter.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/api/audit.js';
import type { Actor } from '../src/core/types.js';
import { registerScheduleRoutes } from '../src/schedules/routes.js';
import { WorkflowScheduler, type ScheduledLaunch } from '../src/schedules/scheduler.js';
import { DEFAULT_REVIEW_EVERY_HOURS, DEFAULT_REVIEW_SCHEDULE_ID, ScheduleStore } from '../src/schedules/store.js';
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

function rig(opts: { path?: string; refuse?: boolean } = {}) {
  const path = opts.path ?? join(scratch(), 'daemon-schedules.json');
  const runs: Record<string, string> = {};
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
  const scheduler = new WorkflowScheduler({
    store,
    sessionsDetail: async () => Object.entries(runs).map(([id, status]) => ({ session: { id, status }, units: [] }) as never),
    launch,
    onTick: [async () => { ticks.push(1); }],
    log: () => undefined,
    now: () => clock.now,
  });
  const at = (h: number): void => { clock.now = new Date(T0.getTime() + h * H); };
  return { path, store, scheduler, runs, launches, at, ticks };
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
    // A person deletes it: a restart does not bring it back.
    r.store.delete(DEFAULT_REVIEW_SCHEDULE_ID);
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
    // The run parks on a person (not busy) for two more intervals: still skipped, never a second run.
    r.runs[r.launches[0]?.runId as string] = 'awaiting_human';
    r.at(72);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
    expect(r.store.get('nightly')?.lastNote).toBe('skipped: its last run is still going');
    // Its run ends: the next sweep fires it (the due time never moved).
    r.runs[r.launches[0]?.runId as string] = 'cancelled';
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(2);
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

  it('waits while another run is working, then launches', async () => {
    const r = rig();
    r.store.put('nightly', { workflow: 'review-recent-work', everyHours: 24 }, T0);
    r.runs['someone-else'] = 'executing';
    r.at(24);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(0);
    r.runs['someone-else'] = 'completed';
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
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
    expect(JSON.parse(readFileSync(r.path, 'utf8')).schedules).toEqual({});
    await app.close();
  });
});
