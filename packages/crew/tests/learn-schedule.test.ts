/**
 * DES-learn-workflow §5: the learn schedule store, its routes and the minute tick. The tick is
 * driven directly (`sweep()`), with a fake adapter, clock and exec.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/api/audit.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { registerLearnRoutes } from '../src/learn/routes.js';
import { LearnScheduleStore } from '../src/learn/schedule-store.js';
import { LearnScheduler, RUN_MARKER_ENV, type Exec } from '../src/learn/scheduler.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeScratch(d);
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'learn-schedule-'));
  dirs.push(d);
  return d;
}

const T0 = new Date('2026-10-11T00:00:00Z');
const H = 3_600_000;
const REPO = { id: 'r1', name: 'demo', root_path: '/repos/demo', default_branch: 'main', registered_at: 0 };

type Status = 'executing' | 'awaiting_human' | 'completed' | 'failed' | 'cancelled';

function rig(opts: { runs?: Record<string, Status>; launch?: () => Promise<string>; tree?: string; indexCode?: number } = {}) {
  const dir = scratch();
  const store = new LearnScheduleStore(join(dir, 'learn-schedules.json'));
  const runs = opts.runs ?? {};
  const launches: Record<string, unknown>[] = [];
  const frames: CoreEvent[] = [];
  const execs: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv | undefined }[] = [];
  let clock = T0;
  const adapter = {
    listRepos: async () => [REPO],
    sessionsDetail: async () => Object.entries(runs).map(([id, status]) => ({ session: { id, status }, units: [] })),
    seatsForWorkflow: async () => [{ key: 'claude' }],
    launchRun: async (input: Record<string, unknown>) => {
      launches.push(input);
      return opts.launch ? opts.launch() : `run-${launches.length}`;
    },
  } as unknown as Pick<CoreAdapter, 'listRepos' | 'sessionsDetail' | 'seatsForWorkflow' | 'launchRun'>;
  const exec: Exec = async (cmd, args, o) => {
    execs.push({ cmd, args, env: o.env });
    if (cmd === 'git') return opts.tree === undefined ? { code: 128, stdout: '', stderr: 'no path' } : { code: 0, stdout: `${opts.tree}\n`, stderr: '' };
    return { code: opts.indexCode ?? 0, stdout: '{"ok":true}', stderr: '' };
  };
  const scheduler = new LearnScheduler({
    store,
    adapter,
    audit: new AuditLog(join(dir, 'audit.log'), () => undefined),
    runTimingIndex: new RunTimingIndex(),
    fileRun: () => undefined,
    broadcast: (f) => frames.push(f),
    log: () => undefined,
    now: () => clock,
    exec,
    env: { WICKED_GARDEN_ROOT: '/garden', WICKED_RUN_ID: 'leak', WICKED_ESTATE_READONLY: '1', PATH: '/bin' },
  });
  return { dir, store, runs, launches, frames, execs, scheduler, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

const put = (store: LearnScheduleStore, slug = 'sqlite-wal', everyHours = 24) =>
  store.put({ repoRef: 'r1', slug, topic: `topic ${slug}`, everyHours }, T0);

describe('LearnScheduleStore', () => {
  it('round-trips, first due one interval out, and keeps history on an update', () => {
    const { store, dir } = rig();
    const row = put(store);
    expect(row.id).toBe('r1:sqlite-wal');
    expect(row.nextDueAt).toBe(new Date(T0.getTime() + 24 * H).toISOString());
    store.update(row.id, { lastRunId: 'x', failures: 2 }, T0);
    const again = store.put({ repoRef: 'r1', slug: 'sqlite-wal', topic: 'renamed', everyHours: 24 }, new Date(T0.getTime() + H));
    expect([again.lastRunId, again.failures, again.nextDueAt, again.topic]).toEqual(['x', 2, row.nextDueAt, 'renamed']);
    const reread = new LearnScheduleStore(join(dir, 'learn-schedules.json'));
    expect(reread.get(row.id)?.topic).toBe('renamed');
  });

  it('reads tolerantly: one malformed row is dropped, not the map', () => {
    const { store, dir } = rig();
    put(store);
    const path = join(dir, 'learn-schedules.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.schedules['r1:bad'] = { repoRef: 'r1', slug: 'bad', everyHours: 1 };
    writeFileSync(path, JSON.stringify(raw));
    expect(new LearnScheduleStore(path).list().map((r) => r.id)).toEqual(['r1:sqlite-wal']);
    writeFileSync(path, '{not json');
    expect(new LearnScheduleStore(path).list()).toEqual([]);
  });
});

describe('/learn/schedules', () => {
  async function app() {
    const r = rig();
    const a = Fastify();
    registerLearnRoutes(a, { store: r.store, adapter: { listRepos: async () => [REPO] } as never, audit: new AuditLog(join(r.dir, 'a.log'), () => undefined), now: () => T0 });
    await a.ready();
    return { a, r };
  }
  const body = { repoRef: 'r1', slug: 'sqlite-wal', topic: 'SQLite WAL mode', everyHours: 168 };

  it('saves, lists, runs now and deletes', async () => {
    const { a } = await app();
    const saved = await a.inject({ method: 'PUT', url: '/api/v1/learn/schedules/r1:sqlite-wal', payload: body });
    expect(saved.statusCode).toBe(200);
    const list = await a.inject({ method: 'GET', url: '/api/v1/learn/schedules' });
    expect(list.json().schedules).toHaveLength(1);
    const now = await a.inject({ method: 'POST', url: '/api/v1/learn/schedules/r1:sqlite-wal/run-now' });
    expect(now.json().nextDueAt).toBe(T0.toISOString());
    expect((await a.inject({ method: 'DELETE', url: '/api/v1/learn/schedules/r1:sqlite-wal' })).statusCode).toBe(204);
    expect((await a.inject({ method: 'DELETE', url: '/api/v1/learn/schedules/r1:sqlite-wal' })).statusCode).toBe(404);
  });

  it('refuses an id mismatch, an unknown repo, an interval out of bounds and an unknown field', async () => {
    const { a } = await app();
    const at = (id: string, payload: unknown) => a.inject({ method: 'PUT', url: `/api/v1/learn/schedules/${id}`, payload: payload as object });
    expect((await at('r1:other', body)).statusCode).toBe(400);
    expect((await at('r9:sqlite-wal', { ...body, repoRef: 'r9' })).statusCode).toBe(404);
    expect((await at('r1:sqlite-wal', { ...body, everyHours: 1 })).statusCode).toBe(400);
    expect((await at('r1:sqlite-wal', { ...body, everyHours: 99999 })).statusCode).toBe(400);
    expect((await at('r1:sqlite-wal', { ...body, cron: '* * *' })).statusCode).toBe(400);
  });
});

describe('LearnScheduler.sweep', () => {
  it('launches one due row as a delivering learn run and pushes nextDueAt one interval out', async () => {
    const r = rig();
    put(r.store, 'a');
    put(r.store, 'b');
    r.advance(25 * H);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
    expect(r.launches[0]).toMatchObject({ workflow: 'learn', repoRef: 'r1', deliver: 'pr' });
    expect(String(r.launches[0]!['problem'])).toContain('.wicked/knowledge/a/');
    const a = r.store.get('r1:a')!;
    expect([a.lastRunId, a.lastOutcome]).toEqual(['run-1', 'launched']);
    expect(a.nextDueAt).toBe(new Date(T0.getTime() + 49 * H).toISOString()); // coalesced from now
    expect(r.frames[0]).toMatchObject({ type: 'learnRefreshLaunched', session: 'run-1', schedule: 'r1:a' });
    // b waits while a's run is open
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
  });

  it('skips while any run on the daemon is executing', async () => {
    const r = rig({ runs: { other: 'executing' } });
    put(r.store);
    r.advance(25 * H);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(0);
    r.runs['other'] = 'completed';
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(1);
  });

  it('reconciles a finished run, then the next due row may launch', async () => {
    const r = rig();
    put(r.store, 'a');
    put(r.store, 'b');
    r.advance(25 * H);
    await r.scheduler.sweep();
    r.runs['run-1'] = 'completed';
    await r.scheduler.sweep();
    expect(r.store.get('r1:a')!.lastOutcome).toBe('completed');
    expect(r.launches).toHaveLength(2);
  });

  it('backs off a refused launch exponentially, capped at a day', async () => {
    const r = rig({ launch: async () => { throw new Error('preset_unknown'); } });
    put(r.store);
    r.advance(25 * H);
    await r.scheduler.sweep();
    let row = r.store.get('r1:sqlite-wal')!;
    expect([row.failures, row.lastOutcome, row.lastError]).toEqual([1, 'refused', 'preset_unknown']);
    expect(Date.parse(row.nextDueAt) - (T0.getTime() + 25 * H)).toBe(2 * H);
    r.store.update(row.id, { failures: 9, nextDueAt: new Date(T0.getTime() + 25 * H).toISOString() }, T0);
    await r.scheduler.sweep();
    row = r.store.get('r1:sqlite-wal')!;
    expect(Date.parse(row.nextDueAt) - (T0.getTime() + 25 * H)).toBe(24 * H);
  });

  it('indexes merged knowledge once per changed tree, without the run markers', async () => {
    const r = rig({ tree: 'abc123' });
    put(r.store);
    await r.scheduler.sweep();
    const spawns = r.execs.filter((e) => e.cmd !== 'git');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cmd).toBe('/garden/scripts/wicked-garden');
    expect(spawns[0]!.args).toEqual(['run', 'scripts/learn/index.py', '--repo', '/repos/demo', '--name', 'demo', '--slug', 'sqlite-wal']);
    for (const k of RUN_MARKER_ENV) expect(spawns[0]!.env?.[k]).toBeUndefined();
    expect(r.store.get('r1:sqlite-wal')!.indexedTree).toBe('abc123');
    await r.scheduler.sweep();
    expect(r.execs.filter((e) => e.cmd !== 'git')).toHaveLength(1); // unchanged tree: no spawn
  });

  it('keeps the old tree when the index fails, so the next sweep retries', async () => {
    const r = rig({ tree: 'abc123', indexCode: 1 });
    put(r.store);
    await r.scheduler.sweep();
    expect(r.store.get('r1:sqlite-wal')!.indexedTree).toBeNull();
  });

  it('does nothing for a disabled row', async () => {
    const r = rig({ tree: 'abc123' });
    const row = put(r.store);
    r.store.update(row.id, { enabled: false }, T0);
    r.advance(25 * H);
    await r.scheduler.sweep();
    expect(r.launches).toHaveLength(0);
    expect(r.execs).toHaveLength(0);
  });
});
