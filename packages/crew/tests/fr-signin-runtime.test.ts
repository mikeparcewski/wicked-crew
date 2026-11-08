import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeState, type ContainerRuntimeState, type RuntimeStateReader } from '../src/api/runtime-state.js';
import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { gatewayDirOf, registerLoginCleanup, SeatContainerStatus, sweepLoginContainers, type ExecLike } from '../src/api/seat-container-login.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import * as snapshot from '../src/api/system-snapshot.js';

let home: string;
const close: Array<() => void> = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'fr-signin-')); vi.stubEnv('HOME', home); vi.stubEnv('WICKED_CORE_EXE', '/fixture/core'); });
afterEach(() => { for (const fn of close.splice(0)) fn(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
class FakeRuntime implements RuntimeStateReader {
  value: ContainerRuntimeState = 'up';
  listeners = new Set<(next: ContainerRuntimeState, previous: ContainerRuntimeState) => void>();
  state() { return this.value; }
  onChange(cb: (next: ContainerRuntimeState, previous: ContainerRuntimeState) => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  set(next: ContainerRuntimeState) {
    const previous = this.value; if (previous === next) return;
    this.value = next; for (const cb of this.listeners) cb(next, previous);
  }
}
function rosterFixture(floor = 'container') {
  const runtime = new FakeRuntime();
  const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"status":"signed_in","detail":{"expires_at":null}}', stderr: '' }));
  const containerStatus = new SeatContainerStatus({ exec, gatewayDir: join(home, 'gateway') });
  const refresh = vi.spyOn(containerStatus, 'refresh');
  const tracker = new SeatHealthTracker();
  tracker.ingest({ type: 'unitDistributed', session: 'fixture', ord: 1, cli: 'codex', ts: Date.now() } as never);
  tracker.ingest({ type: 'unitOutputCaptured', session: 'fixture', ord: 1, stepStatus: 'ok', ts: Date.now() } as never);
  const roster = rosterWithStandingFactory({
    registry: () => [{ key: 'codex' }, { key: 'claude' }, { key: 'agy' }], signedIn: () => true, seatHealth: tracker,
    env: { HOME: home, WICKED_SEAT_FLOOR: floor }, home, hostBoundary: () => null, containerStatus, runtimeState: runtime,
    worktreeBench: () => new Map(), qeAdmitted: () => true,
  });
  close.push(() => roster.close?.());
  return { roster, runtime, containerStatus, refresh };
}
describe('runtime-aware roster', () => {
  it('hides stale active/live standing and answer times during an outage', async () => {
    const { roster, runtime, containerStatus } = rosterFixture();
    await containerStatus.refresh('codex');
    expect(roster()[0]).toMatchObject({ auth: 'signed_in', login_check: 'live', health: { status: 'active' } });
    runtime.set('down');
    const seat = roster()[0]!;
    expect(seat).toMatchObject({
      health: { status: 'inactive', message: "Docker isn't running" },
      council_eligible: false, council_ineligible_reason: "Docker isn't running",
      work_eligible: false, work_ineligible_reason: "Docker isn't running",
      signed_in: null, auth: 'unknown', auth_evidence: "Docker isn't running", login_check: 'unverified', login_note: "Docker isn't running",
      chat_admission: { unscoped: { ok: false, reason: "Docker isn't running" } },
    });
    expect(roster().every((row) => row.health?.status === 'inactive' && row.auth === 'unknown' && row.signed_in === null)).toBe(true);
    for (const row of roster()) {
      expect(row.work_admission).toMatchObject({ unscoped: { ok: false, reason: "Docker isn't running" }, scoped: { ok: false }, scoped_bound: { ok: false } });
      expect(row.qe_reviewer).toMatchObject({ ok: false, reason: "Docker isn't running" });
    }
    expect(seat.probed_at).toBeUndefined(); expect(JSON.stringify(seat)).not.toContain('last step answered');
  });
  it('refreshes each container seat once per transition without a roster read', () => {
    const { runtime, refresh } = rosterFixture();
    runtime.set('down'); expect(refresh.mock.calls.map(([key]) => key)).toEqual(['codex', 'claude']);
    refresh.mockClear(); runtime.set('up'); expect(refresh.mock.calls.map(([key]) => key)).toEqual(['codex', 'claude']);
    runtime.set('up'); expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('leaves host-floor standing and probes unaffected', () => {
    const { roster, runtime, refresh } = rosterFixture('host'); runtime.set('down');
    expect(roster()[0]).toMatchObject({ signed_in: true, auth: 'signed_in', council_eligible: true, health: { status: 'active' } });
    expect(refresh).not.toHaveBeenCalled();
  });
});
describe('background runtime reader', () => {
  it('caches immediate reads, bounds the check and probes again in the background', async () => {
    vi.useFakeTimers(); let up = false;
    const exec = vi.fn<ExecLike>(async () => { if (!up) throw new Error('runtime down'); return { stdout: '28.0.0\n', stderr: '' }; });
    const reader = new RuntimeState({ exec, env: { HOME: home }, runtime: () => '/fixture/runtime' }); close.push(() => reader.close());
    const change = vi.fn(); reader.onChange(change); expect(reader.state()).toBe('unknown');
    // A cold daemon reads down only after three misses in a row (e2e-1105 09:02Z), never on the first.
    await vi.advanceTimersByTimeAsync(1); expect(reader.state()).toBe('unknown');
    expect(exec).toHaveBeenCalledWith('/fixture/runtime', ['version', '--format', '{{.Server.Version}}'], { timeout: 15_000, env: { HOME: home } });
    for (let i = 0; i < 100; i++) reader.state(); expect(exec).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('unknown');
    await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('down');
    up = true; await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('up');
    expect(change.mock.calls).toEqual([['down', 'unknown'], ['up', 'down']]);
    await vi.advanceTimersByTimeAsync(10_000); expect(change).toHaveBeenCalledTimes(2);
    reader.close(); await vi.advanceTimersByTimeAsync(10_000); expect(exec).toHaveBeenCalledTimes(5);
  });
  it('an up runtime reads down only after three misses in a row (slow checks on a busy host are not an outage)', async () => {
    vi.useFakeTimers(); let up = true;
    const exec = vi.fn<ExecLike>(async () => { if (!up) throw new Error('timed out'); return { stdout: '28.0.0\n', stderr: '' }; });
    const reader = new RuntimeState({ exec, runtime: () => '/fixture/runtime' }); close.push(() => reader.close());
    await vi.advanceTimersByTimeAsync(1); expect(reader.state()).toBe('up');
    up = false; await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('up');
    up = true; await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('up');
    up = false; await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('up');
    await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('up');
    await vi.advanceTimersByTimeAsync(10_000); expect(reader.state()).toBe('down');
  });
  it('a SLOW runtime (each check answers after 12 s) stays up: the bound is patient (e2e-1105 09:02Z)', async () => {
    vi.useFakeTimers();
    const exec = vi.fn<ExecLike>(async (_f, _a, opts) => {
      // A fake that honours its bound like execCapped: answers after 12 s, or fails at the bound.
      const answerMs = 12_000;
      await new Promise((r) => setTimeout(r, Math.min(answerMs, opts.timeout)));
      if (answerMs > opts.timeout) throw new Error('timed out');
      return { stdout: '28.0.0\n', stderr: '' };
    });
    const reader = new RuntimeState({ exec, runtime: () => '/fixture/runtime' }); close.push(() => reader.close());
    await vi.advanceTimersByTimeAsync(12_001); expect(reader.state()).toBe('up');
    await vi.advanceTimersByTimeAsync(60_000); expect(reader.state()).toBe('up');
    // One check at a time: a 12 s check on a 10 s interval never overlaps the next.
    expect(exec.mock.calls.length).toBeLessThanOrEqual(Math.ceil(72_001 / 12_000));
  });
  it('a HUNG runtime (no answer within the bound) reads down after three misses, never before', async () => {
    vi.useFakeTimers();
    const exec = vi.fn<ExecLike>(async (_f, _a, opts) => {
      await new Promise((r) => setTimeout(r, opts.timeout));
      throw new Error('timed out');
    });
    const reader = new RuntimeState({ exec, runtime: () => '/fixture/runtime' }); close.push(() => reader.close());
    await vi.advanceTimersByTimeAsync(15_001); expect(reader.state()).toBe('unknown');
    await vi.advanceTimersByTimeAsync(25_000); expect(reader.state()).toBe('unknown');
    await vi.advanceTimersByTimeAsync(30_000); expect(reader.state()).toBe('down');
    expect(exec.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it('coalesces pending probes and publishes nothing after close', async () => {
    let finish!: (out: { stdout: string; stderr: string }) => void;
    const exec = vi.fn<ExecLike>(() => new Promise((r) => { finish = r; }));
    const reader = new RuntimeState({ exec, runtime: () => '/fixture/runtime' }); close.push(() => reader.close());
    const change = vi.fn(); reader.onChange(change); const pending = reader.refresh(); expect(reader.refresh()).toBe(pending);
    await Promise.resolve(); reader.close(); finish({ stdout: '28.0', stderr: '' }); await pending;
    expect(exec).toHaveBeenCalledTimes(1); expect(change).not.toHaveBeenCalled(); expect(reader.state()).toBe('unknown');
  });
});
describe('daemon login-container sweep', () => {
  it('removes only exact session names of the canonical gateway', async () => {
    const gatewayDir = join(home, 'gateway'); const gateway = snapshot.gatewayName(gatewayDirOf(gatewayDir));
    const own = `${gateway}-login-claude-deadbeef`; const agy = `${gateway}-login-agy-01234567`;
    const exec = vi.fn<ExecLike>(async () => ({ stdout: [own, agy, own, 'wicked-agw-foreign-login-claude-deadbeef', `${own}-extra`, `${gateway}-login-codex-DEADBEEF`, `${gateway}-login-nope-deadbeef`, gateway].join('\n'), stderr: '' }));
    await sweepLoginContainers({ gatewayDir, runtime: () => '/fixture/runtime', exec, log: vi.fn() });
    expect(exec.mock.calls.map(([, args]) => args)).toEqual([
      ['ps', '-a', '--filter', `name=${gateway}-login-`, '--format', '{{.Names}}'], ['rm', '-f', own, agy],
    ]);
    expect(exec.mock.calls.every(([, , opts]) => opts.timeout === 3_000)).toBe(true);
  });
  it('logs one plain line when the runtime is down', async () => {
    const log = vi.fn(); const exec = vi.fn<ExecLike>().mockRejectedValue(new Error('/Users/fixture/private'));
    await sweepLoginContainers({ gatewayDir: join(home, 'gateway'), runtime: () => '/fixture/runtime', exec, log });
    expect(log.mock.calls).toEqual([['Sign-in cleanup skipped: container runtime unavailable.']]);
  });
  it('wires startup and close sweeps on the container floor only', async () => {
    vi.spyOn(snapshot, 'resolveContainerRuntime').mockReturnValue('/fixture/runtime'); vi.stubEnv('WICKED_SEAT_FLOOR', 'container');
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '', stderr: '' })); const app = Fastify();
    registerLoginCleanup(app, { gatewayDir: join(home, 'gateway'), exec });
    await app.ready(); expect(exec).toHaveBeenCalledTimes(1); await app.close(); expect(exec).toHaveBeenCalledTimes(2);
    vi.stubEnv('WICKED_SEAT_FLOOR', 'host'); const host = Fastify(); registerLoginCleanup(host, { gatewayDir: join(home, 'gateway'), exec });
    await host.ready(); await host.close(); expect(exec).toHaveBeenCalledTimes(2);
  });
});
