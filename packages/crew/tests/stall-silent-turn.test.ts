// crew#972 — the stall watchdog's SILENT-TURN rung, and the seat-container half of the busy read.
//
// Rig run 115fabdb: a codex review streamed nothing for 30 minutes (its seat burned ~1 s of CPU,
// waiting on its model) before the 30-minute rung reassigned it; pi then did the review in 2
// minutes. The rung acts at `silentTurnMinutes` on a cursor seat that has streamed NO output since
// its dispatch, but never while the run's processes or its seat containers are busy, never on an
// unknown busy read, never on a tool unit, and never once the worker returned.

import { describe, expect, it } from 'vitest';
import {
  WorkerStallWatchdog,
  type ExecutingRun,
  type StallEscalationConfig,
  type WorkerStallEscalatedFrame,
  type WorkerStalledFrame,
} from '../src/api/stall-watchdog.js';
import {
  BUSY_UNKNOWN_PREFIX,
  RunLivenessSampler,
  containerRunTag,
  containerRuntime,
  containerRuntimeCandidates,
  resetContainerRuntimeCache,
  parseCpuPercent,
  runOfContainer,
  type ContainerCpu,
} from '../src/api/run-liveness.js';
import { DEFAULT_SETTINGS, DEFAULT_WORKER_SILENT_TURN_MINUTES } from '../src/core/types.js';
import type { CoreEvent } from '../src/core/types.js';

const MIN = 60_000;
const RUN = '115fabdb-6124-4bfc-aaf9-529bbf088140';
const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;
type AnyFrame = WorkerStalledFrame | WorkerStallEscalatedFrame;
const escalatedOf = (frames: AnyFrame[]): WorkerStallEscalatedFrame[] =>
  frames.filter((f): f is WorkerStallEscalatedFrame => f.type === 'workerStallEscalated');
const stalledOf = (frames: AnyFrame[]): WorkerStalledFrame[] =>
  frames.filter((f): f is WorkerStalledFrame => f.type === 'workerStalled');

function build(opts?: {
  run?: ExecutingRun;
  config?: StallEscalationConfig;
  busy?: (ids: string[]) => Promise<ReadonlyMap<string, string>>;
}): {
  wd: WorkerStallWatchdog;
  frames: AnyFrame[];
  reassigns: { runId: string; ord: number; cli?: string }[];
  tick: (ms: number) => void;
} {
  let nowMs = Date.parse('2026-10-28T01:40:37Z');
  const frames: AnyFrame[] = [];
  const reassigns: { runId: string; ord: number; cli?: string }[] = [];
  const run = opts?.run ?? { id: RUN, ord: 7, cli: 'codex', seats: ['claude', 'codex', 'pi'], avoid: ['claude'] };
  const wd = new WorkerStallWatchdog({
    listExecuting: async () => [run],
    broadcast: (f) => frames.push(f),
    escalation: {
      config: () => opts?.config ?? { minutes: 30, silentTurnMinutes: 8 },
      reassign: async (runId, ord, cli) => {
        reassigns.push({ runId, ord, ...(cli !== undefined ? { cli } : {}) });
      },
    },
    ...(opts?.busy !== undefined ? { busy: opts.busy } : {}),
    now: () => nowMs,
  });
  return { wd, frames, reassigns, tick: (ms) => (nowMs += ms) };
}

/** The review unit dispatched on codex, as on 115fabdb ord 7: no output after it. */
function dispatch(wd: WorkerStallWatchdog): void {
  wd.ingest(ev({ type: 'unitDispatched', session: RUN, ord: 7, attempt: 0 }));
  wd.ingest(ev({ type: 'skillsSnapshotHanded', session: RUN, ord: 7, attempt: 0, cli: 'codex' }));
}

describe('the silent-turn rung (crew#972)', () => {
  it('defaults to 8 minutes in the daemon settings', () => {
    expect(DEFAULT_WORKER_SILENT_TURN_MINUTES).toBe(8);
    expect(DEFAULT_SETTINGS.workerSilentTurnMinutes).toBe(8);
  });

  it('a seat that streamed nothing since its dispatch is reassigned at 8 min, not 30', async () => {
    const { wd, frames, reassigns, tick } = build();
    dispatch(wd);
    tick(7 * MIN);
    await wd.sweep();
    expect(frames).toEqual([]);
    tick(1 * MIN);
    await wd.sweep();
    // The ladder still notifies before it acts: the detection frame first, in the same sweep.
    expect(frames.map((f) => f.type)).toEqual(['workerStalled', 'workerStallEscalated']);
    const [esc] = escalatedOf(frames);
    expect(esc).toMatchObject({ action: 'reassign', outcome: 'ok', silentTurn: true, cli: 'pi', previousCli: 'codex' });
    expect(reassigns).toEqual([{ runId: RUN, ord: 7, cli: 'pi' }]);
  });

  it('a seat that has streamed output rides the 15/30 ladder', async () => {
    const { wd, frames, reassigns, tick } = build();
    dispatch(wd);
    wd.ingest(ev({ type: 'unitOutputDelta', session: RUN, ord: 7, text: 'reading the diff' }));
    tick(8 * MIN);
    await wd.sweep();
    tick(7 * MIN);
    await wd.sweep();
    expect(stalledOf(frames)).toHaveLength(1); // 15 min
    expect(reassigns).toEqual([]);
    tick(15 * MIN);
    await wd.sweep();
    const [esc] = escalatedOf(frames);
    expect(esc?.silentTurn).toBeUndefined();
    expect(reassigns).toHaveLength(1);
  });

  it('never while the run is busy (a test runner on the host or in the seat container)', async () => {
    let busy = true;
    const { wd, frames, reassigns, tick } = build({
      busy: async (ids) => new Map(busy ? ids.map((id) => [id, 'container wicked-seat-codex-115fabdb-7-ab12cd34 (93.0% CPU)']) : []),
    });
    dispatch(wd);
    for (let i = 0; i < 20; i++) {
      tick(1 * MIN);
      await wd.sweep();
    }
    expect(frames).toEqual([]);
    expect(reassigns).toEqual([]);
    // The child finishes; the seat then sits silent: the rung acts 8 min after the last busy read.
    busy = false;
    tick(7 * MIN);
    await wd.sweep();
    expect(reassigns).toEqual([]);
    tick(1 * MIN);
    await wd.sweep();
    expect(reassigns).toEqual([{ runId: RUN, ord: 7, cli: 'pi' }]);
  });

  it('an unknown container read or a failed busy read never lets it act early', async () => {
    for (const busy of [
      async (ids: string[]) => new Map(ids.map((id) => [id, `${BUSY_UNKNOWN_PREFIX}the seat containers could not be read`])),
      async (): Promise<ReadonlyMap<string, string>> => {
        throw new Error('runtime hung');
      },
    ]) {
      const { wd, frames, reassigns, tick } = build({ busy });
      dispatch(wd);
      tick(14 * MIN);
      await wd.sweep();
      expect(frames).toEqual([]);
      expect(reassigns).toEqual([]);
      // …while the 15/30 ladder reads the unknown as not busy, as before the container read.
      tick(16 * MIN);
      await wd.sweep();
      const [esc] = escalatedOf(frames);
      expect(esc?.silentTurn).toBeUndefined();
      expect(reassigns).toHaveLength(1);
    }
  });

  it('is off at 0, for a tool unit, once the worker returned, and after a restart lost the count', async () => {
    const off = build({ config: { minutes: 30, silentTurnMinutes: 0 } });
    dispatch(off.wd);
    off.tick(14 * MIN);
    await off.wd.sweep();
    expect(off.reassigns).toEqual([]);

    const tool = build({ run: { id: RUN, ord: 10, executor: 'tool' } });
    tool.wd.ingest(ev({ type: 'unitDispatched', session: RUN, ord: 10, attempt: 0 }));
    tool.tick(14 * MIN);
    await tool.wd.sweep();
    expect(tool.frames).toEqual([]);

    const returned = build();
    dispatch(returned.wd);
    returned.wd.ingest(ev({ type: 'unitOutputCaptured', session: RUN, ord: 7, attempt: 0 }));
    returned.tick(14 * MIN);
    await returned.wd.sweep();
    expect(returned.frames).toEqual([]);

    // A daemon that came up mid-turn saw no dispatch: it cannot know the seat streamed nothing.
    const restarted = build();
    restarted.wd.ingest(ev({ type: 'governanceContextArmed', session: RUN, ord: 7, attempt: 0 }));
    restarted.tick(14 * MIN);
    await restarted.wd.sweep();
    expect(restarted.frames).toEqual([]);
  });
});

describe('the seat-container busy read (crew#972)', () => {
  it('names a run by its seat containers, never by a prefix of another id', () => {
    expect(containerRunTag(RUN)).toBe('115fabdb');
    expect(runOfContainer('wicked-seat-codex-115fabdb-7-ab12cd34', [RUN])).toBe(RUN);
    expect(runOfContainer('wicked-seat-codex-115fabdc-7-ab12cd34', [RUN])).toBeUndefined();
    expect(runOfContainer('k8s_traefik_x', [RUN])).toBeUndefined();
    expect(parseCpuPercent('93.05%')).toBeCloseTo(0.9305);
    expect(parseCpuPercent(' 0.00% ')).toBe(0);
    expect(Number.isNaN(parseCpuPercent('--'))).toBe(true);
  });

  it('lists the runtimes the engine would try, in its order', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(containerRuntimeCandidates({ PATH: '/a:/b' }, has(['/b/docker', '/a/podman']), '/h')).toEqual(['/b/docker', '/a/podman']);
    expect(containerRuntimeCandidates({ PATH: '/a' }, has(['/h/.rd/bin/docker']), '/h')).toEqual(['/h/.rd/bin/docker']);
    // An explicit choice is the only candidate.
    expect(containerRuntimeCandidates({ PATH: '/a', WICKED_CONTAINER_RUNTIME: 'podman' }, has(['/a/docker']), '/h')).toEqual([]);
    expect(containerRuntimeCandidates({ PATH: '/a' }, has([]), '/h')).toEqual([]);
  });

  it('selects the first runtime that answers and keeps it, as the engine does (xreview)', async () => {
    resetContainerRuntimeCache();
    let dockerUp = false;
    const answers = async (rt: string) => (rt === '/b/docker' ? dockerUp : true);
    // Docker installed but stopped, podman working: the engine's seats run under podman.
    expect(await containerRuntime(['/b/docker', '/a/podman'], answers)).toEqual({ runtime: '/a/podman', installed: true });
    // Docker starting later does not move the read off podman (the engine's cached choice).
    dockerUp = true;
    expect(await containerRuntime(['/b/docker', '/a/podman'], answers)).toEqual({ runtime: '/a/podman', installed: true });
    resetContainerRuntimeCache();
    // Installed, none answering: an unknown; none installed: no containers.
    expect(await containerRuntime(['/b/docker'], async () => false)).toEqual({ runtime: null, installed: true });
    expect(await containerRuntime([], async () => true)).toEqual({ runtime: null, installed: false });
    resetContainerRuntimeCache();
  });

  const idleHost = {
    table: async () => [],
    cwds: async () => new Map<number, string>(),
  };

  it('a busy seat container makes its run busy; an idle one does not; an unreadable one is an unknown', async () => {
    const reading = (seats: ContainerCpu[] | null) =>
      new RunLivenessSampler(idleHost, 1, () => 0, { seats: async () => seats }).busy([RUN, 'c5320434-99ac-4edf-8fe5-37ad5a283ed6']);
    const busy = await reading([
      { name: 'wicked-seat-codex-115fabdb-7-ab12cd34', cpuShare: 0.93 },
      { name: 'wicked-seat-pi-c5320434-6-ab12cd34', cpuShare: 0.001 },
    ]);
    expect([...busy.keys()]).toEqual([RUN]);
    expect(busy.get(RUN)).toContain('wicked-seat-codex-115fabdb-7');
    expect((await reading([])).size).toBe(0);
    const unknown = await reading(null);
    expect(unknown.get(RUN)?.startsWith(BUSY_UNKNOWN_PREFIX)).toBe(true);
  });

  it('a failed ps fails the read instead of reading as idle (xreview)', async () => {
    const wt = `/repo/wicked-worktrees/${RUN}`;
    let cpu = 10;
    let at = 0;
    const host = {
      table: async () => [{ pid: 50, ppid: 1, cpuSec: cpu, comm: 'vitest' }],
      cwds: async () => new Map<number, string>([[50, wt]]),
    };
    const sampler = new RunLivenessSampler(host, 1, () => at, { seats: async () => [] });
    expect((await sampler.busy([RUN])).size).toBe(0); // the baseline
    cpu = 40; // 30 s of CPU in 30 s
    at = 30_000;
    expect((await sampler.busy([RUN])).get(RUN)).toContain('vitest pid 50');
    const broken = new RunLivenessSampler(
      { table: async () => { throw new Error('ps could not be read'); }, cwds: async () => new Map() },
      1,
      () => 0,
      { seats: async () => [] },
    );
    await expect(broken.busy([RUN])).rejects.toThrow('ps could not be read');
  });
});

describe('the silent-turn rung with the real sampler (xreview)', () => {
  it('at a 1-minute setting a busy host test runner is never reassigned', async () => {
    const wt = `/repo/wicked-worktrees/${RUN}`;
    let nowMs = Date.parse('2026-10-28T01:40:37Z');
    let cpu = 0;
    const sampler = new RunLivenessSampler(
      {
        table: async () => [{ pid: 50, ppid: 1, cpuSec: cpu, comm: 'vitest' }],
        cwds: async () => new Map<number, string>([[50, wt]]),
      },
      1,
      () => nowMs,
      { seats: async () => [] },
    );
    const frames: AnyFrame[] = [];
    const reassigns: number[] = [];
    const wd = new WorkerStallWatchdog({
      listExecuting: async () => [{ id: RUN, ord: 7, cli: 'codex', seats: ['codex', 'pi'] }],
      broadcast: (f) => frames.push(f),
      escalation: {
        config: () => ({ minutes: 30, silentTurnMinutes: 1 }),
        reassign: async (_r, ord) => {
          reassigns.push(ord);
        },
      },
      busy: (ids) => sampler.busy(ids),
      now: () => nowMs,
    });
    dispatch(wd);
    for (let i = 0; i < 10; i++) {
      nowMs += 30_000; // the daemon's sweep cadence
      cpu += 25; // the test runner burns most of a core
      await wd.sweep();
    }
    expect(frames).toEqual([]);
    expect(reassigns).toEqual([]);
  });

  it('flags silentTurn only when that rung acted, not the ladder (xreview)', async () => {
    const { wd, frames, tick } = build({ config: { minutes: 30, silentTurnMinutes: 30 } });
    dispatch(wd);
    tick(30 * MIN);
    await wd.sweep();
    const [esc] = escalatedOf(frames);
    expect(esc).toBeDefined();
    expect(esc?.silentTurn).toBeUndefined();
  });
});

