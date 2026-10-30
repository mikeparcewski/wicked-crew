// DES-SYSTEM-VIEW — the pure parts of `GET /system`: every infra state, every liveness verdict, the
// 7-day CLI fold and the governance cards over fixture stores, and the attention ordering.

import { beforeAll, describe, expect, it } from 'vitest';
import type { RecordedEvent, SessionView, SystemCli } from 'wicked-crew-api-types';

import {
  WeekFoldCache,
  buildNeeds,
  buildClis,
  buildGovernance,
  diskRow,
  macAvailableBytes,
  foldWeek,
  gatewayName,
  judgeGaps,
  levelOf,
  livenessThresholds,
  loadRow,
  probeBroker,
  probeBus,
  probeEstate,
  estateMcpResolvable,
  probeGateway,
  probeInteractive,
  probeVault,
  readWeek,
  runLiveness,
  settleWithin,
  skillsRow,
  sortRuns,
  stateHomeRow,
  type ExecLike,
  type RosterSeatLike,
} from '../src/api/system-snapshot.js';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 86_400_000;
const MIN = 60_000;

const never = (): Promise<never> => new Promise(() => undefined);

function view(id: string, status: string, units: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): SessionView {
  return {
    session: { id, problem: `problem ${id}`, status, clis: [], created_at: Math.floor((NOW - 2 * DAY) / 1000), ...extra },
    units,
  } as unknown as SessionView;
}

describe('settleWithin', () => {
  it('reads a hang as timeout, a throw as error, a value as ok', async () => {
    expect((await settleWithin(never, 20)).kind).toBe('timeout');
    const err = await settleWithin(() => Promise.reject(new Error('boom\nstack')), 50);
    expect(err).toMatchObject({ kind: 'error', error: 'boom' });
    expect(await settleWithin(async () => 7, 50)).toMatchObject({ kind: 'ok', value: 7 });
  });
});

describe('gateway probe', () => {
  const base = { containerFloor: true, gatewayDir: '/state/gateway', runtime: '/usr/bin/docker', timeoutMs: 50 };
  it('names the gateway exactly as the engine does (sha256 prefix of the gateway dir)', () => {
    expect(gatewayName('')).toBe('wicked-agw-e3b0c44298fc');
  });
  it('running → ok, stopped → down with a remedy', async () => {
    const calls: string[][] = [];
    const ok: ExecLike = async (_f, args) => {
      calls.push(args);
      return { stdout: 'true\n', stderr: '' };
    };
    const row = await probeGateway({ ...base, exec: ok });
    expect(row.state).toBe('ok');
    expect(calls[0]).toEqual(['container', 'inspect', '--format', '{{.State.Running}}', gatewayName('/state/gateway')]);
    const stopped = await probeGateway({ ...base, exec: async () => ({ stdout: 'false\n', stderr: '' }) });
    expect(stopped.state).toBe('down');
    expect(stopped.remedy).toMatch(/docker start/);
  });
  it('a runtime that refuses connections → down; a hang → unknown after its timeout', async () => {
    const refused = await probeGateway({ ...base, exec: async () => { throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'); } });
    expect(refused.state).toBe('down');
    expect(refused.reason).toMatch(/refused/);
    const t0 = Date.now();
    const hung = await probeGateway({ ...base, exec: never });
    expect(hung.state).toBe('unknown');
    expect(hung.timeoutMs).toBe(50);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('no container → degraded (the engine starts it); host floor → off; no runtime → down', async () => {
    expect((await probeGateway({ ...base, exec: async () => { throw new Error('Error: No such object: wicked-agw-x'); } })).state).toBe('degraded');
    // A stopped runtime whose socket is gone is the runtime down, not "no container yet".
    expect((await probeGateway({ ...base, exec: async () => { throw new Error('dial unix /var/run/docker.sock: connect: no such file or directory'); } })).state).toBe('down');
    expect((await probeGateway({ ...base, containerFloor: false, exec: never })).state).toBe('off');
    expect((await probeGateway({ ...base, runtime: null, exec: never })).state).toBe('down');
  });
});

describe('broker probe', () => {
  it('signed in → ok; refresh failing → degraded; all hung → unknown; host floor → off', async () => {
    expect((await probeBroker({ containerFloor: true, clis: ['claude', 'codex'], status: async (c) => ({ state: c === 'claude' ? 'signed_in' : 'signed_out' }) })).state).toBe('ok');
    const failing = await probeBroker({ containerFloor: true, clis: ['codex'], status: async () => ({ state: 'refresh_failing', reason: 'token revoked' }) });
    expect(failing.state).toBe('degraded');
    expect(failing.reason).toMatch(/token revoked/);
    expect((await probeBroker({ containerFloor: true, clis: ['codex'], status: never, timeoutMs: 30 })).state).toBe('unknown');
    expect((await probeBroker({ containerFloor: true, clis: ['codex'], status: async () => ({ state: 'signed_out' }) })).state).toBe('degraded');
    expect((await probeBroker({ containerFloor: false, clis: ['codex'], status: never })).state).toBe('off');
  });
});

describe('interactive probe', () => {
  const lock = { host: '127.0.0.1', port: 4242, pid: 1 };
  it('no lockfile → off; 200 → ok; refused → down; hang → unknown', async () => {
    expect((await probeInteractive({ roots: ['/r'], readLock: async () => null, health: never })).state).toBe('off');
    expect((await probeInteractive({ roots: ['/r'], readLock: async () => lock, health: async () => 200 })).state).toBe('ok');
    const refused = await probeInteractive({ roots: ['/r'], readLock: async () => lock, health: async () => { throw new Error('fetch failed: ECONNREFUSED'); } });
    expect(refused.state).toBe('down');
    expect(refused.reason).toMatch(/4242/);
    expect((await probeInteractive({ roots: ['/r'], readLock: async () => lock, health: never, timeoutMs: 30 })).state).toBe('unknown');
    // A lockfile read that hangs is inside the bound too (never a blocked event loop).
    expect((await probeInteractive({ roots: ['/r'], readLock: never, health: never, timeoutMs: 30 })).state).toBe('unknown');
  });
});

describe('estate, bus, vault probes', () => {
  const store = { path: '/s/memory.db', source: 'explicit', notice: null };
  it('estate: one read-only call answered → ok; missing binary → down; rpc error → down; hang → unknown; no store yet → degraded (no call)', async () => {
    const answer = { result: { content: [{ text: JSON.stringify({ total: 12 }) }] } };
    const ok = await probeEstate({ memoryStore: store, resolvable: () => true, exists: async () => true, call: async () => answer });
    expect(ok.state).toBe('ok');
    expect(ok.reason).toMatch(/12 memories/);
    expect((await probeEstate({ memoryStore: store, resolvable: () => true, exists: async () => true, call: async () => { throw new Error('spawn wicked-estate-mcp ENOENT'); } })).state).toBe('down');
    expect((await probeEstate({ memoryStore: store, resolvable: () => true, exists: async () => true, call: async () => ({ error: { code: -32603, message: 'db locked' } }) })).state).toBe('down');
    expect((await probeEstate({ memoryStore: store, resolvable: () => true, exists: async () => true, call: never, timeoutMs: 30 })).state).toBe('unknown');
    let called = false;
    const none = await probeEstate({ memoryStore: store, resolvable: () => true, exists: async () => false, call: async () => { called = true; return answer; } });
    expect(none.state).toBe('degraded');
    expect(called).toBe(false);
  });
  it('estate: no binary → the not-installed row, with or without a store, before any call; binary + no store keeps "not created yet"', async () => {
    let called = false;
    const call = async (): Promise<Record<string, unknown>> => { called = true; return {}; };
    for (const present of [false, true]) {
      const row = await probeEstate({ memoryStore: store, resolvable: () => false, exists: async () => present, call });
      expect(row.state).toBe('down');
      expect(row.reason).toMatch(/not installed or not on PATH/);
      expect(JSON.stringify(row)).toMatch(/npx wicked-installer/);
      expect(JSON.stringify(row)).toMatch(/WICKED_ESTATE_MCP_EXE/);
      expect(JSON.stringify(row)).not.toMatch(/Nothing to fix/);
    }
    expect(called).toBe(false);
    const none = await probeEstate({ memoryStore: store, resolvable: () => true, exists: async () => false, call });
    expect(none.state).toBe('degraded');
    expect(none.reason).toMatch(/not been created yet/);
  });
  it('estateMcpResolvable: a path must be an executable file; a bare name is looked up on PATH', () => {
    expect(estateMcpResolvable({ WICKED_ESTATE_MCP_EXE: '/definitely/not/here/wicked-estate-mcp', PATH: '/usr/bin:/bin' })).toBe(false);
    expect(estateMcpResolvable({ PATH: '/definitely/not/here' })).toBe(false);
    expect(estateMcpResolvable({ WICKED_ESTATE_MCP_EXE: process.execPath, PATH: '' })).toBe(true);
  });
  it('estateMcpResolvable on Windows: .exe/.com resolve, a .cmd shim does not, PATHEXT is ignored', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'estate-resolve-'));
    try {
      const put = (n: string): void => { writeFileSync(join(dir, n), ''); chmodSync(join(dir, n), 0o755); };
      const env = { PATH: dir, PATHEXT: '.CMD' };
      put('wicked-estate-mcp.cmd');
      expect(estateMcpResolvable(env, 'win32')).toBe(false);
      put('wicked-estate-mcp.exe');
      expect(estateMcpResolvable(env, 'win32')).toBe(true);
      expect(estateMcpResolvable(env, 'linux')).toBe(false);
      // An extensionless override path resolves to its .exe on Windows, as spawn does.
      expect(estateMcpResolvable({ WICKED_ESTATE_MCP_EXE: join(dir, 'wicked-estate-mcp'), PATH: '' }, 'win32')).toBe(true);
      expect(estateMcpResolvable({ WICKED_ESTATE_MCP_EXE: join(dir, 'wicked-estate-mcp'), PATH: '' }, 'linux')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('estateMcpResolvable: an empty PATH entry is the current directory, as spawn reads it', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'estate-resolve-cwd-'));
    try {
      writeFileSync(join(dir, 'wicked-estate-mcp'), ''); chmodSync(join(dir, 'wicked-estate-mcp'), 0o755);
      expect(estateMcpResolvable({ PATH: ':/definitely/not/here' }, 'linux', dir)).toBe(true);
      expect(estateMcpResolvable({ PATH: '' }, 'linux', dir)).toBe(true);
      expect(estateMcpResolvable({ PATH: '/definitely/not/here' }, 'linux', dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('bus: unavailable → down; no file → down; seams off → degraded; watch down → degraded; none → off', async () => {
    const none = { unavailable: null, seamsOff: null, dbPath: null, watchBus: null, tailLagMs: null };
    expect((await probeBus({ ...none, unavailable: { reason: 'locked' } })).state).toBe('down');
    expect((await probeBus({ ...none, dbPath: '/definitely/not/here/bus.db' })).state).toBe('down');
    expect((await probeBus(none)).state).toBe('off');
    const file = new URL(import.meta.url).pathname;
    expect((await probeBus({ ...none, dbPath: file, seamsOff: { reason: 'old engine' } })).state).toBe('degraded');
    expect((await probeBus({ ...none, dbPath: file, watchBus: 'down' })).state).toBe('degraded');
    expect((await probeBus({ ...none, dbPath: file, watchBus: 'up', tailLagMs: 20 })).state).toBe('ok');
  });
  it('vault: answers → ok; cannot run → down; off → off; unresolvable → degraded', async () => {
    const v = { bin: '/x/wicked-vault', source: 'shipped', finding: null };
    expect((await probeVault({ vault: v, exec: async () => ({ stdout: '0.8.0\n', stderr: '' }) })).state).toBe('ok');
    expect((await probeVault({ vault: v, exec: async () => { throw new Error('EACCES'); } })).state).toBe('down');
    expect((await probeVault({ vault: v, exec: never, timeoutMs: 30 })).state).toBe('unknown');
    expect((await probeVault({ vault: { bin: null, source: 'off', finding: { message: 'off', remedy: 'r' } }, exec: never })).state).toBe('off');
    expect((await probeVault({ vault: { bin: null, source: 'unresolvable', finding: { message: 'gone', remedy: 'reinstall' } }, exec: never })).state).toBe('degraded');
  });
});

describe('derived rows', () => {
  it('skills, state home, disk and load map to their states', async () => {
    expect(skillsRow({ state: 'published', findings: [] }).state).toBe('ok');
    expect(skillsRow({ state: 'fallback', findings: [] }).state).toBe('degraded');
    expect(skillsRow({ state: 'blocked', findings: [{ severity: 'error', message: 'x' }] }).state).toBe('down');
    expect(skillsRow({ state: 'disabled', findings: [] }).state).toBe('off');
    expect(stateHomeRow(null).state).toBe('unknown');
    expect(stateHomeRow({ refusesLaunches: true, findings: [{ message: 'stray' }] }).state).toBe('down');
    expect(stateHomeRow({ refusesLaunches: false, findings: [] , error: null }).state).toBe('ok');
    const GiB = 2 ** 30;
    expect((await diskRow('/s', async () => ({ bavail: 1, bsize: GiB, blocks: 100 }))).state).toBe('down');
    expect((await diskRow('/s', async () => ({ bavail: 6, bsize: GiB, blocks: 100 }))).state).toBe('degraded');
    expect((await diskRow('/s', async () => ({ bavail: 60, bsize: GiB, blocks: 100 }))).state).toBe('ok');
    expect((await diskRow('/s', never, 30)).state).toBe('unknown');
  });

  it('crew#1145: the skills row says "skills: publishing" while the boot ladder runs in the background', () => {
    const row = skillsRow({ state: 'publishing', findings: [] });
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/^skills: publishing/);
  });

  it('crew#1145: the disk row is red BEFORE a write can fail — under 5 GiB free or over 95% used; degraded under 10 GiB or over 90% used', async () => {
    const GiB = 2 ** 30;
    const disk = async (freeGiB: number, totalGiB: number): Promise<string> =>
      (await diskRow('/s', async () => ({ bavail: freeGiB, bsize: GiB, blocks: totalGiB }))).state;
    expect(await disk(4, 1000)).toBe('down'); // under 5 GiB, whatever the size
    expect(await disk(17, 460)).toBe('down'); // the rig at the silent exit: 96% used
    expect(await disk(45, 460)).toBe('degraded'); // 90.2% used
    expect(await disk(8, 70)).toBe('degraded'); // under 10 GiB (88.6% used)
    expect(await disk(120, 1000)).toBe('ok');
    const down = await diskRow('/s', async () => ({ bavail: 3, bsize: GiB, blocks: 100 }));
    expect(down.reason).toMatch(/3 GiB free on the state-home volume \(97% used\)/);
  });

  it('operator 2026-10-29: the disk row says free now AND what macOS can make available, and the thresholds read the second', async () => {
    const GiB = 2 ** 30;
    const fs = (freeGiB: number, totalGiB: number) => async () => ({ bavail: freeGiB, bsize: GiB, blocks: totalGiB });
    // 6 GiB free, 70 GiB available once purgeable space is cleared: not "down", and both numbers are said.
    const row = await diskRow('/s', fs(6, 460), 1000, async () => 70 * GiB);
    expect(row.state).toBe('ok');
    expect(row.reason).toBe('6 GiB free now · 70 GiB available once macOS clears purgeable space (of 460 GiB)');
    expect(row.details).toMatchObject({ freeBytes: 6 * GiB, availableBytes: 70 * GiB });
    // Little purgeable space: the thresholds still hold on what is really available.
    const low = await diskRow('/s', fs(3, 460), 1000, async () => 4 * GiB);
    expect(low.state).toBe('down');
    expect(low.reason).toMatch(/^3 GiB free now · 4 GiB available once macOS clears purgeable space on the state-home volume/);
    // Off macOS (or a failed read): free space alone, as before.
    const off = await diskRow('/s', fs(6, 100), 1000, async () => null);
    expect(off.state).toBe('degraded');
    expect(off.reason).toBe('6 GiB free on the state-home volume');
    expect(off.details).toMatchObject({ availableBytes: null });
    // A small gap that still changes the state is said: the row is degraded, not down, because of the second number.
    const edge = await diskRow('/s', async () => ({ bavail: 4.5, bsize: GiB, blocks: 40 }), 1000, async () => 5.1 * GiB);
    expect(edge.state).toBe('degraded');
    expect(edge.reason).toMatch(/^4\.5 GiB free now · 5\.1 GiB available once macOS clears purgeable space/);
    // A reading below free space is not the important-usage capacity: ignored.
    expect((await diskRow('/s', fs(60, 100), 1000, async () => 1 * GiB)).state).toBe('ok');
    // The available read that throws or hangs never sinks the row.
    expect((await diskRow('/s', fs(60, 100), 30, () => new Promise(() => {}))).state).toBe('ok');
    expect((await diskRow('/s', fs(60, 100), 1000, async () => { throw new Error('no osascript'); })).state).toBe('ok');
  });

  it('macAvailableBytes reads nothing off macOS', async () => {
    expect(await macAvailableBytes('/s', 1000, 'linux')).toBeNull();
    expect(await macAvailableBytes('/s', 1000, 'win32')).toBeNull();
  });

  it('load rows', () => {
    expect(loadRow(() => ({ load1: 2, cores: 8 }), 'darwin').state).toBe('ok');
    expect(loadRow(() => ({ load1: 16, cores: 8 }), 'darwin').state).toBe('degraded');
    expect(loadRow(() => ({ load1: 90, cores: 14 }), 'darwin').state).toBe('down');
    expect(loadRow(() => ({ load1: 0, cores: 8 }), 'win32').state).toBe('unknown');
  });
});

describe('liveness (each verdict)', () => {
  const { quietAfterMs, stallAfterMs } = livenessThresholds(15);
  const exec = view('r-exec', 'executing', [{ ord: 2, status: 'distributed', phase_ref: 'build', assigned_cli: 'claude' }]);
  it('thresholds: stalled at the setting, quiet at a third (≤ 5 min)', () => {
    expect({ quietAfterMs, stallAfterMs }).toEqual({ quietAfterMs: 5 * MIN, stallAfterMs: 15 * MIN });
  });
  it('working with a recent event; quiet past quietAfter; stalled past stallAfter, with the last event time', () => {
    const at = (ago: number) => runLiveness({ view: exec, now: NOW, evidence: { at: NOW - ago, source: 'event_log' }, gate: null, quietAfterMs, stallAfterMs });
    const working = at(30_000);
    expect(working).toMatchObject({ liveness: 'working', phase: 'build', unitOrd: 2, seat: 'claude', evidence: 'event_log' });
    expect(at(7 * MIN).liveness).toBe('quiet');
    const stalled = at(42 * MIN);
    expect(stalled.liveness).toBe('stalled');
    expect(stalled.lastEventAt).toBe(new Date(NOW - 42 * MIN).toISOString());
    expect(stalled.reason).toMatch(/42 min/);
  });
  it('no evidence at all is never working: stalled when old, quiet when just launched', () => {
    expect(runLiveness({ view: exec, now: NOW, evidence: null, gate: null, quietAfterMs, stallAfterMs }).liveness).toBe('stalled');
    const fresh = view('r-new', 'executing', [], { created_at: Math.floor((NOW - MIN) / 1000) });
    expect(runLiveness({ view: fresh, now: NOW, evidence: null, gate: null, quietAfterMs, stallAfterMs }).liveness).toBe('quiet');
  });
  it('a busy child process counts as evidence', () => {
    expect(runLiveness({ view: exec, now: NOW, evidence: { at: NOW - 1000, source: 'process' }, gate: null, quietAfterMs, stallAfterMs }).reason).toMatch(/processes are busy/);
  });
  it('at a gate: waiting_on_you with the gate id; an escalation or no gate on record: held', () => {
    const paused = view('r-gate', 'awaiting_human', [{ ord: 4, status: 'pending', phase_ref: 'review', assigned_cli: 'codex' }]);
    const gate = { interactionId: 'ir_abc', ord: 4, kind: 'plan_approval', prompt: 'Approve?' };
    const waiting = runLiveness({ view: paused, now: NOW, evidence: null, gate, quietAfterMs, stallAfterMs });
    expect(waiting).toMatchObject({ liveness: 'waiting_on_you', gate: { interactionId: 'ir_abc', ord: 4 } });
    expect(runLiveness({ view: paused, now: NOW, evidence: null, gate: { ...gate, kind: 'escalation' }, quietAfterMs, stallAfterMs }).liveness).toBe('held');
    expect(runLiveness({ view: paused, now: NOW, evidence: null, gate: null, quietAfterMs, stallAfterMs }).liveness).toBe('held');
  });
  it('sorts worst first: waiting_on_you › held › stalled › quiet › working', () => {
    const mk = (liveness: string, id: string) => ({ runId: id, liveness, quietForMs: 0 }) as never;
    expect(sortRuns([mk('working', 'a'), mk('stalled', 'b'), mk('waiting_on_you', 'c'), mk('quiet', 'd'), mk('held', 'e')]).map((r) => r.liveness)).toEqual([
      'waiting_on_you', 'held', 'stalled', 'quiet', 'working',
    ]);
  });
});

// ── The fixture run store: two runs inside the window, one outside ──

function ev(type: string, ts: number, fields: Record<string, unknown> = {}, seq = 0): RecordedEvent {
  return { type, ts, seq, ...fields } as RecordedEvent;
}

const D = (days: number, extraMs = 0) => NOW - days * DAY + extraMs;
const runA = view('run-a', 'completed', [
  { ord: 0, status: 'done', phase_ref: 'build', assigned_cli: 'claude' },
  { ord: 1, status: 'done', phase_ref: 'qe', assigned_cli: 'codex', qe_acceptance: { status: 'required' } },
], { created_at: Math.floor(D(3) / 1000), ended_at: Math.floor(D(1) / 1000) });
const eventsA = [
  ev('unitDistributed', D(3), { ord: 0, cli: 'claude' }, 1),
  ev('unitDispatched', D(3, 1000), { ord: 0, attempt: 0 }, 2),
  ev('unitOutputCaptured', D(3, 61_000), { ord: 0, attempt: 0 }, 3), // 60 s
  ev('gateEvaluated', D(3, 62_000), { ord: 0, combined: false, denial: { source: 'floor' }, agentVerdict: 'deny' }, 4),
  ev('repoChecksEvaluated', D(3, 62_500), { ord: 0, passed: false, outcome: 'failed' }, 5),
  ev('unitDispatched', D(3, 70_000), { ord: 0, attempt: 1 }, 6),
  ev('unitOutputCaptured', D(3, 190_000), { ord: 0, attempt: 1 }, 7), // 120 s
  ev('repoChecksEvaluated', D(3, 191_000), { ord: 0, passed: true, outcome: 'passed' }, 8),
  ev('gateEvaluated', D(3, 192_000), { ord: 0, combined: true, denial: null, agentVerdict: 'approve' }, 9),
  ev('cliUsage', D(3, 192_500), { ord: 0, inputTokens: 100, outputTokens: 40, costUsd: 0.25 }, 10),
  ev('unitDistributed', D(1), { ord: 1, cli: 'codex' }, 11),
  ev('seatBenched', D(1, 500), { cli: 'codex', reason: 'quota_exhausted (429 Too Many Requests)', source: 'worker' }, 12),
  ev('unitReassigned', D(1, 600), { ord: 1, newCli: 'claude' }, 13),
  ev('unitDispatched', D(1, 1000), { ord: 1, attempt: 0 }, 14),
  ev('acpFallback', D(1, 1500), { cliKey: 'claude', fallbackKind: 'session_died' }, 15),
  ev('unitOutputCaptured', D(1, 31_000), { ord: 1, attempt: 0 }, 16), // 30 s
  ev('gateEvaluated', D(1, 32_000), { ord: 1, combined: true, denial: null, agentVerdict: null }, 17),
];
const runB = view('run-b', 'executing', [{ ord: 0, status: 'distributed', phase_ref: 'fix', assigned_cli: 'codex' }], { created_at: Math.floor(D(0, -3600_000) / 1000) });
const eventsB = [
  ev('unitDistributed', D(0, -3600_000), { ord: 0, cli: 'codex' }, 1),
  ev('unitDispatched', D(0, -3500_000), { ord: 0, attempt: 0 }, 2),
  ev('seatBenched', D(0, -3400_000), { cli: 'codex', reason: 'not_logged_in', source: 'judge' }, 3),
];
const runOld = view('run-old', 'completed', [{ ord: 0, status: 'done', assigned_cli: 'claude' }], { created_at: Math.floor(D(30) / 1000), ended_at: Math.floor(D(29) / 1000) });

describe('7-day fold over a fixture run store', () => {
  it('matches the store exactly: units, pass %, median time, 429s, fallbacks, per-day, tokens', async () => {
    const reads: string[] = [];
    const fold = await readWeek([runA, runB, runOld], async (id) => {
      reads.push(id);
      return id === 'run-a' ? eventsA : id === 'run-b' ? eventsB : [ev('unitDispatched', D(30), { ord: 0, attempt: 0 })];
    }, { days: 7, now: NOW });
    expect(fold).not.toBeNull();
    expect(reads.sort()).toEqual(['run-a', 'run-b']); // the run that ended before the window is never read
    const claude = fold!.clis.get('claude')!;
    expect(claude).toMatchObject({
      units: 2, // run-a ord 0, run-a ord 1 (reassigned to claude)
      gated: 2,
      firstPass: 1, // ord 0's FIRST gate denied; ord 1 passed
      passPct: 50,
      medianUnitMs: 60_000, // [60 s, 120 s, 30 s] → 60 s
      rateLimited: 0,
      benches: 0,
      fallbacks: 1,
      tokens: { input: 100, output: 40 },
      costUsd: 0.25,
      runsRead: 2,
      truncated: false,
    });
    // ord 0 dispatched 3 days ago (bucket 4 of 0..6); ord 1 one day ago (bucket 6).
    expect(claude.perDay).toEqual([0, 0, 0, 0, 1, 0, 1]);
    const codex = fold!.clis.get('codex')!;
    expect(codex).toMatchObject({ units: 1, gated: 0, passPct: null, medianUnitMs: null, rateLimited: 1, benches: 2, fallbacks: 0 });
    expect(codex.tokens).toBeUndefined(); // absent, never 0
    expect(codex.costUsd).toBeUndefined();
    expect(codex.perDay).toEqual([0, 0, 0, 0, 0, 0, 1]);
    // The governance week.
    expect(fold!.floors).toEqual({ failed: 1, passed: 1 });
    expect(fold!.qe).toEqual({ passed: 1, failed: 0 });
    expect(fold!.judgedGates).toBe(2);
  });
  it('a store with no event-log binding is null, not an empty week', async () => {
    expect(await readWeek([runA], async () => null, { days: 7, now: NOW })).toBeNull();
  });
  it('the fold cache serves within its TTL and recomputes after it', async () => {
    let t = 0;
    let n = 0;
    const cache = new WeekFoldCache(1000, () => t);
    const compute = async () => { n += 1; return foldWeek([], { days: 7, now: NOW, truncated: false }); };
    await cache.get(compute);
    t = 999;
    await cache.get(compute);
    expect(n).toBe(1);
    t = 1000;
    await cache.get(compute);
    expect(n).toBe(2);
  });
});

const seat = (key: string, extra: Partial<RosterSeatLike> = {}): RosterSeatLike => ({ key, display_name: key, auth: 'signed_in', signed_in: true, council_eligible: true, work_eligible: true, ...extra });

describe('clis[], judges and attention', () => {
  let fold: Awaited<ReturnType<typeof foldWeek>>;
  let clis: SystemCli[];
  beforeAll(async () => {
    fold = await foldWeek([{ view: runA, events: eventsA }], { days: 7, now: NOW, truncated: false });
    clis = buildClis({ roster, acp: {}, seatGovernance: [], containerFloor: true, hostBoundary: null, week: fold });
  });
  const roster = [
    seat('claude', { sign_in: 'container', health: { status: 'active', since: 'x', lastErrorAt: '2026-10-25T10:00:00Z', message: 'rate limited' } }),
    seat('codex', {
      council_eligible: false,
      recent_bench: { kind: 'quota_exhausted', reason: 'quota_exhausted (no success in the run)', lifts_at: '2026-10-25T18:00:00.000Z', last_at: '2026-10-25T11:30:00Z', runs: 1, source: 'worker' },
      sign_in: 'container',
    }),
    seat('pi', { auth: 'signed_out', signed_in: false, council_eligible: false, council_ineligible_reason: 'signed out: no credential', login_invocation: 'pi login' }),
  ];
  it('carries state, why, sign-in and the 7-day record per CLI', () => {
    const byKey = Object.fromEntries(clis.map((c) => [c.cli, c]));
    expect(byKey['claude']).toMatchObject({ state: 'signed_in', stateReason: null, sandbox: 'container', canSignIn: true, lastError: { message: 'rate limited' } });
    expect(byKey['claude']!.stats!.units).toBe(2);
    expect(byKey['codex']).toMatchObject({ state: 'benched', benchedUntil: '2026-10-25T18:00:00.000Z' });
    expect(byKey['codex']!.stateReason).toMatch(/quota \(429\)/);
    expect(byKey['pi']).toMatchObject({ state: 'signed_out', stateReason: 'signed out: no credential', canSignIn: true });
    // A CLI with no unit in the window still has a (zero) record, never a missing one.
    expect(byKey['pi']!.stats).toMatchObject({ units: 0, passPct: null, perDay: [0, 0, 0, 0, 0, 0, 0] });
  });

  it('a benched CLI that leaves a gate without a distinct judge folds into the run it blocks (red); with a judge left it is no item', () => {
    const gated = view('run-g', 'awaiting_human', [{ ord: 3, status: 'pending', assigned_cli: 'claude' }], { clis: ['claude', 'codex'] });
    const run = runLiveness({ view: gated, now: NOW, evidence: null, gate: { interactionId: 'ir_1', ord: 3, kind: 'review', prompt: 'p' }, quietAfterMs: 5 * MIN, stallAfterMs: 15 * MIN });
    const gaps = judgeGaps([{ view: gated, run }], clis);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.blockedBy.map((c) => c.cli)).toEqual(['codex']);
    const { attention } = buildNeeds({ now: NOW, views: [gated], runs: [run], infra: [], clis, gaps, infraHoldsLive: () => false });
    // One cause, one item: the seat problem is part of the run it blocks, never an item of its own.
    expect(attention.map((a) => a.id)).toEqual(['run:run-g']);
    expect(attention[0]).toMatchObject({ severity: 'red', kind: 'prevents', blockedRunIds: ['run-g'], target: { kind: 'run', runId: 'run-g', gateOrd: 3, interactionId: 'ir_1' }, action: { kind: 'open_gate' } });
    expect(attention[0]!.reason).toBe('Waiting for your decision; no independent reviewer for claude’s work (codex benched)');
    expect(levelOf(attention)).toBe('red');

    // A third signed-in judge in the pool: the gate has a distinct judge; codex's bench is INFO (CLIs tab).
    const clis2 = buildClis({ roster: [...roster, seat('copilot')], acp: {}, seatGovernance: [], containerFloor: true, hostBoundary: null, week: fold });
    const gated2 = view('run-g', 'awaiting_human', [{ ord: 3, status: 'pending', assigned_cli: 'claude' }], { clis: ['claude', 'codex', 'copilot'] });
    const gaps2 = judgeGaps([{ view: gated2, run }], clis2);
    expect(gaps2).toHaveLength(0);
    const a2 = buildNeeds({ now: NOW, views: [gated2], runs: [run], infra: [], clis: clis2, gaps: gaps2, infraHoldsLive: () => false }).attention;
    expect(a2.map((a) => a.id)).toEqual(['run:run-g']);
    expect(a2[0]!.severity).toBe('yellow');
    expect(levelOf(a2)).toBe('yellow');
    expect(levelOf([])).toBe('green');
  });

  it('a down component on the live path is one item holding the live runs; a stalled run behind it is its, not its own cause', async () => {
    const gw = await probeGateway({ containerFloor: true, gatewayDir: '/g', runtime: '/d', exec: async () => ({ stdout: 'false', stderr: '' }) });
    const views = [view('q', 'executing', []), view('s', 'executing', [])];
    const quiet = { runId: 'q', liveness: 'quiet', reason: 'quiet', quietForMs: 6 * MIN } as never;
    const stalled = { runId: 's', liveness: 'stalled', reason: 'no event for 40 min', quietForMs: 40 * MIN } as never;
    const { attention } = buildNeeds({ now: NOW, views, runs: [quiet, stalled], infra: [gw], clis: [] as SystemCli[], gaps: [], infraHoldsLive: (k) => k === 'gateway' });
    expect(attention.map((a) => a.id)).toEqual(['infra:gateway']);
    expect(attention[0]).toMatchObject({ severity: 'red', kind: 'prevents', blocks: 2, action: { kind: 'recheck' } });
    expect([...attention[0]!.blockedRunIds!].sort()).toEqual(['q', 's']);
    expect(attention[0]!.remedy).toMatch(/docker start/);
    // Off the live path (the host floor), the gateway holds nothing; the stalled run is its own item.
    const host = buildNeeds({ now: NOW, views, runs: [quiet, stalled], infra: [gw], clis: [] as SystemCli[], gaps: [], infraHoldsLive: () => false }).attention;
    expect(host.map((a) => a.id)).toEqual(['run:s', 'infra:gateway']);
  });
});

describe('governance cards over a fixture store', () => {
  it('judge availability, floors, QE pass rate, gates by you vs judges, dead letters, rules, findings, store', async () => {
    const fold = await foldWeek([{ view: runA, events: eventsA }], { days: 7, now: NOW, truncated: false });
    const clis = buildClis({ roster: [seat('claude'), seat('codex')], acp: {}, seatGovernance: [], containerFloor: false, hostBoundary: 'sandbox-exec', week: fold });
    const cards = buildGovernance({
      governance: {
        store: { path: '/g/governance.db', source: 'core-db-sidecar' },
        records: { total: 120, sinceBoot: 7 },
        deadletters: { count: 2, path: '/g/outbox.ndjson' },
        findings: [{ kind: 'governance.deadletter', severity: 'warning', message: '2 dead letters' }],
      },
      skillsFindings: [{ kind: 'skills.source', severity: 'warning', message: 'installer copy' }],
      decisions: { claude: { ok: 1 } },
      clis,
      judgeGapCount: 0,
      week: fold,
      gatesByYou: 3,
      steeringRules: 0,
    });
    const by = Object.fromEntries(cards.map((c) => [c.key, c]));
    expect(by['judges']).toMatchObject({ state: 'ok', value: 2 });
    expect(by['floor_outcomes']).toMatchObject({ value: 2, breakdown: { failed: 1, passed: 1 } });
    expect(by['qe_acceptance']).toMatchObject({ value: 100, breakdown: { passed: 1, failed: 0 } });
    expect(by['gates_answered']).toMatchObject({ value: 5, breakdown: { byYou: 3, byJudges: 2 } });
    expect(by['dead_letters']).toMatchObject({ state: 'degraded', value: 2 });
    expect(by['steering_rules']).toMatchObject({ state: 'degraded', value: 0 });
    expect(by['findings']).toMatchObject({ state: 'degraded', value: 2, breakdown: { error: 0, warning: 2, info: 0 } });
    expect(by['store']).toMatchObject({ state: 'ok', value: 120 });
    // One judge left: a distinct judge cannot be seated.
    const solo = buildGovernance({
      governance: { store: null, records: { total: null, sinceBoot: null }, deadletters: { count: 0 }, findings: [] },
      skillsFindings: [], decisions: null, clis: clis.slice(0, 1), judgeGapCount: 0, week: null, gatesByYou: null, steeringRules: null,
    });
    const s = Object.fromEntries(solo.map((c) => [c.key, c]));
    expect(s['judges']!.state).toBe('down');
    expect(s['floor_outcomes']).toMatchObject({ state: 'unknown', value: null });
    expect(s['gates_answered']).toMatchObject({ state: 'unknown', value: null });
    expect(s['store']!.state).toBe('down');
    expect(s['steering_rules']!.state).toBe('unknown');
  });
});

describe('review fixes (xreview r1 on #1137)', () => {
  const cli = (key: string, extra: Partial<SystemCli> = {}): SystemCli =>
    ({ cli: key, label: key, state: 'signed_in', stateReason: null, canSignIn: false, councilEligible: true, workEligible: true, ...extra }) as SystemCli;

  it('a second seat of another CLI (`codex#2`) is a distinct judge; a second seat of the creator\'s CLI is not', () => {
    const v = view('r', 'executing', [{ ord: 0, status: 'distributed', assigned_cli: 'claude' }], { clis: ['claude', 'codex#2'] });
    const run = runLiveness({ view: v, now: NOW, evidence: { at: NOW, source: 'relay' }, gate: null, quietAfterMs: 5 * MIN, stallAfterMs: 15 * MIN });
    expect(judgeGaps([{ view: v, run }], [cli('claude'), cli('codex#2')])).toHaveLength(0);
    const same = view('r', 'executing', [{ ord: 0, status: 'distributed', assigned_cli: 'claude' }], { clis: ['claude', 'claude#2'] });
    expect(judgeGaps([{ view: same, run }], [cli('claude'), cli('claude#2')])).toHaveLength(1);
  });

  it('a work-only creator with a reviewer-only judge has a distinct judge: the card is ok', () => {
    const clis = [cli('claude', { councilEligible: false }), cli('codex', { workEligible: false })];
    const cards = buildGovernance({ governance: null, skillsFindings: [], decisions: null, clis, judgeGapCount: 0, week: null, gatesByYou: 0, steeringRules: 1 });
    expect(cards.find((c) => c.key === 'judges')).toMatchObject({ state: 'ok', value: 1 });
    expect(levelOf(buildNeeds({ now: NOW, views: [], runs: [], infra: [], clis, gaps: [], infraHoldsLive: () => false }).attention)).toBe('green');
  });

  it('diagnostics that did not answer never read as ok or 0: the dependent cards are unknown', () => {
    const cards = buildGovernance({ governance: null, governanceNote: 'diagnostics did not answer (no answer within 4 s)', skillsFindings: [], decisions: null, clis: [], judgeGapCount: 0, week: null, gatesByYou: null, steeringRules: null });
    for (const key of ['dead_letters', 'findings', 'store'] as const) {
      expect(cards.find((c) => c.key === key)).toMatchObject({ state: 'unknown', value: null, reason: 'diagnostics did not answer (no answer within 4 s)' });
    }
  });

  it('gated counts only units the seat ran in the window; zero tokens and cost stay absent', async () => {
    const v = view('w', 'executing', [{ ord: 0, status: 'distributed', assigned_cli: 'claude' }]);
    const fold = await foldWeek([{ view: v, events: [
      ev('unitDistributed', D(9), { ord: 0, cli: 'claude' }, 1),
      ev('unitDispatched', D(9), { ord: 0, attempt: 0 }, 2), // before the window
      ev('gateEvaluated', D(1), { ord: 0, combined: true, denial: null }, 3),
      ev('cliUsage', D(1), { ord: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, 4),
    ] }], { days: 7, now: NOW, truncated: false });
    const claude = fold.clis.get('claude');
    expect(claude?.gated ?? 0).toBe(0);
    expect(claude?.tokens).toBeUndefined();
    expect(claude?.costUsd).toBeUndefined();
  });

  it('a run whose log read hangs is skipped (truncated), and a fold that never settles is dropped, never cached', async () => {
    const fold = await readWeek([runA, runB], async (id) => (id === 'run-a' ? eventsA : never()), { days: 7, now: NOW, runReadTimeoutMs: 30 });
    expect(fold).toMatchObject({ runsRead: 1, truncated: true });
    let t = 0;
    const cache = new WeekFoldCache(1000, () => t, 30);
    await expect(cache.get(never)).rejects.toThrow(/did not finish/);
    // The wedged fold is gone: the next read computes afresh.
    let n = 0;
    await cache.get(async () => { n += 1; return foldWeek([], { days: 7, now: NOW, truncated: false }); });
    expect(n).toBe(1);
    t = 1;
  });

  it('a large history yields while it folds, so a deadline can still fire', async () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ev('cliUsage', D(1, i), { ord: 0, inputTokens: 1 }, i));
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 0);
    await foldWeek([{ view: view('b', 'executing', [{ ord: 0, status: 'distributed', assigned_cli: 'claude' }]), events: big }], { days: 7, now: NOW, truncated: false });
    clearTimeout(timer);
    expect(ticked).toBe(true);
  });
});
