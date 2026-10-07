// crew#830 — a run the previous daemon left `executing` with no worker is resumed at boot.
//
// The engine marks such a run with a `runOrphaned` frame at actor bootstrap (core#124) and names
// `POST /runs/:id/resume` as the remedy, but never calls it — the run sat `executing` forever on the
// rig until an operator resumed it by hand. Pins, on `resumeOrphanedRuns` with a fake adapter:
//
//   - an executing run whose trail ENDS on `runOrphaned` ⇒ `resumeRun` exactly once, and the audit
//     trail carries `run.resumed {via: 'boot', status, ord}` by the daemon actor;
//   - a live executing run (its trail continues past the orphan frame) is untouched; so is a run
//     that is no longer `executing` (cancelled between the crash and the boot) even with an orphan
//     tail — the status filter runs first;
//   - a refused resume is logged and reported in `failed`, never thrown — boot must finish;
//   - a partial adapter (no trail surface) and an engine with no event log (`runEvents` → null)
//     resume nothing — a zombie cannot be told from a live run, so nothing is guessed;
//   - tail = highest `seq`, not array position.
//
// Plus one wiring pin through `createServer` (stub engine, no NAPI worker): the sweep runs at boot
// and the `run.resumed` line lands in the real audit file.

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { resumeOrphanedRuns, RUN_ORPHANED_EVENT, type RunResumeAudit } from '../src/core/run-boot-resume.js';
import type { Actor, AuditEntry, RecordedEvent, SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const DAEMON: Actor = { id: 'daemon', kind: 'system', trust: 'admin' };

function view(id: string, status = 'executing'): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['claude'],
      status,
      human_confirm: 'none',
      unit_ix: 6,
      attempt: 1,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

function frame(seq: number, type: string, extra: Record<string, unknown> = {}): RecordedEvent {
  return { seq, ts: 1_000 + seq, type, ...extra } as RecordedEvent;
}

/** The rig's shape: a creator mid-turn, then the crash, then the engine's orphan report. */
const ORPHAN_TAIL = [
  frame(1, 'sessionStarted'),
  frame(2, 'unitDispatched', { ord: 7 }),
  frame(3, 'unitExecuting', { ord: 7 }),
  frame(4, RUN_ORPHANED_EVENT, { ord: 7, detail: 'POST /api/v1/runs/orphan/resume' }),
];

/** The armed exec path redrove this one: the orphan frame is NOT the tail. */
const LIVE_TRAIL = [
  frame(1, 'sessionStarted'),
  frame(2, RUN_ORPHANED_EVENT, { ord: 3 }),
  frame(3, 'unitDispatched', { ord: 3 }),
];

function fakeAudit(): RunResumeAudit & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    record(action, actor, fields) {
      entries.push({ ts: 1, action, actor, ...fields } as AuditEntry);
      return 1;
    },
  };
}

describe('crew#830 — resumeOrphanedRuns', () => {
  it('resumes, once, the executing run whose trail ends on runOrphaned and audits run.resumed {via: boot}', async () => {
    const trails: Record<string, RecordedEvent[]> = { orphan: ORPHAN_TAIL, live: LIVE_TRAIL, done: ORPHAN_TAIL };
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('orphan'), view('live'), view('done', 'cancelled')]),
      runEvents: vi.fn(async (id: string) => trails[id] ?? []),
      resumeRun: vi.fn().mockResolvedValue('executing'),
    };
    const audit = fakeAudit();
    const logs: string[] = [];
    const result = await resumeOrphanedRuns(adapter, audit, DAEMON, (m) => logs.push(m));

    expect(adapter.resumeRun).toHaveBeenCalledTimes(1);
    expect(adapter.resumeRun).toHaveBeenCalledWith('orphan');
    expect(result).toEqual({ resumed: [{ id: 'orphan', ord: 7, status: 'executing' }], failed: [] });
    expect(audit.entries).toEqual([
      { ts: 1, action: 'run.resumed', actor: DAEMON, runId: 'orphan', detail: { via: 'boot', status: 'executing', ord: 7 } },
    ]);
    // The cancelled run's trail was never even read: status filters first.
    expect(adapter.runEvents.mock.calls.map((c) => c[0]).sort()).toEqual(['live', 'orphan']);
    expect(logs).toEqual(['[runs] boot resume: 1 orphaned run(s) resumed (orphan@7 → executing)']);
  });

  it('a refused resume is logged and reported, never thrown; the sweep continues to the next run', async () => {
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('refused'), view('ok')]),
      runEvents: vi.fn(async () => ORPHAN_TAIL),
      resumeRun: vi.fn(async (id: string) => {
        if (id === 'refused') throw new Error('run refused: plan held');
        return 'executing';
      }),
    };
    const audit = fakeAudit();
    const logs: string[] = [];
    const result = await resumeOrphanedRuns(adapter, audit, DAEMON, (m) => logs.push(m));
    expect(result.failed).toEqual([{ id: 'refused', error: 'run refused: plan held' }]);
    expect(result.resumed).toEqual([{ id: 'ok', ord: 7, status: 'executing' }]);
    expect(audit.entries.map((e) => e.runId)).toEqual(['ok']);
    expect(logs.join('\n')).toMatch(/1 orphaned run\(s\) resumed \(ok@7 → executing\); 1 refused \(refused: run refused: plan held\)/);
  });

  it('a list failure or a trail read failure is logged, not thrown', async () => {
    const logs: string[] = [];
    const listFails = {
      sessionsDetail: vi.fn().mockRejectedValue(new Error('store busy')),
      runEvents: vi.fn(),
      resumeRun: vi.fn(),
    };
    expect(await resumeOrphanedRuns(listFails, fakeAudit(), DAEMON, (m) => logs.push(m))).toEqual({ resumed: [], failed: [] });
    const trailFails = {
      sessionsDetail: vi.fn().mockResolvedValue([view('r1')]),
      runEvents: vi.fn().mockRejectedValue(new Error('log torn')),
      resumeRun: vi.fn(),
    };
    expect(await resumeOrphanedRuns(trailFails, fakeAudit(), DAEMON, (m) => logs.push(m))).toEqual({ resumed: [], failed: [] });
    expect(trailFails.resumeRun).not.toHaveBeenCalled();
    expect(logs).toEqual([
      '[runs] boot resume: could not list runs: store busy',
      '[runs] boot resume: could not read the trail of r1: log torn',
    ]);
  });

  it('no trail surface, or an engine with no event log, resumes nothing — a zombie is never guessed', async () => {
    const logs: string[] = [];
    // A partial adapter (directly-driven route sets) is a silent no-op.
    expect(await resumeOrphanedRuns({} as never, fakeAudit(), DAEMON, (m) => logs.push(m))).toEqual({ resumed: [], failed: [] });
    expect(logs).toEqual([]);
    // The binding lacks `runEvents` (null, the runEvents doctrine): said once, nothing resumed.
    const noLog = {
      sessionsDetail: vi.fn().mockResolvedValue([view('a'), view('b')]),
      runEvents: vi.fn().mockResolvedValue(null),
      resumeRun: vi.fn(),
    };
    expect(await resumeOrphanedRuns(noLog, fakeAudit(), DAEMON, (m) => logs.push(m))).toEqual({ resumed: [], failed: [] });
    expect(noLog.resumeRun).not.toHaveBeenCalled();
    expect(noLog.runEvents).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['[runs] boot resume: the engine exposes no run event log — 2 executing run(s) left as they are']);
  });

  it('the tail is the highest seq, not the last array element; an empty trail is not an orphan', async () => {
    const shuffled = [ORPHAN_TAIL[3]!, ORPHAN_TAIL[0]!, ORPHAN_TAIL[2]!, ORPHAN_TAIL[1]!];
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('shuffled'), view('empty')]),
      runEvents: vi.fn(async (id: string) => (id === 'shuffled' ? shuffled : [])),
      resumeRun: vi.fn().mockResolvedValue('executing'),
    };
    const result = await resumeOrphanedRuns(adapter, fakeAudit(), DAEMON, () => undefined);
    expect(adapter.resumeRun).toHaveBeenCalledTimes(1);
    expect(result.resumed.map((r) => r.id)).toEqual(['shuffled']);
  });
});

describe('crew#830 — createServer runs the sweep at boot', () => {
  const dirs: string[] = [];
  const servers: FastifyInstance[] = [];
  const adapters: CoreAdapter[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
    for (const a of adapters.splice(0)) a.close();
  });
  afterAll(() => dirs.forEach(removeScratch));

  function trail(auditPath: string): AuditEntry[] {
    if (!existsSync(auditPath)) return [];
    return readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as AuditEntry);
  }

  it('an orphaned run is resumed through the adapter and audited run.resumed {via: boot} by the daemon actor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-830-'));
    dirs.push(dir);
    const auditPath = join(dir, 'audit.log');
    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    adapters.push(adapter);
    const resumed: string[] = [];
    adapter.sessionsDetail = async () => [view('orphan'), view('live')];
    adapter.runEvents = async (id: string) => (id === 'orphan' ? ORPHAN_TAIL : LIVE_TRAIL);
    adapter.resumeRun = async (id: string) => {
      resumed.push(id);
      return 'executing';
    };
    const app = await createServer(adapter, { auditPath });
    servers.push(app);
    await vi.waitFor(() => {
      const line = trail(auditPath).find((e) => e.action === 'run.resumed');
      expect(line).toMatchObject({ runId: 'orphan', actor: { id: 'daemon' }, detail: { via: 'boot', status: 'executing', ord: 7 } });
    });
    expect(resumed).toEqual(['orphan']);
  });
});
