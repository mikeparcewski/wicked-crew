import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { containerLoginReading, rosterWithStandingFactory } from '../src/api/roster-standing.js';
import {
  ARGV_TIMEOUT_MS, SeatContainerStatus, defaultSeatFloor, isContainerSeatFloor, parseBrokerStatus, runSeatLogin, type ExecLike,
} from '../src/api/seat-container-login.js';
import { SEAT_ANSWER_WINDOW_MS, SeatHealthTracker } from '../src/api/seat-health.js';
import { SeatProbe } from '../src/api/seat-probe.js';
import { toEngineSeat } from '../src/core/engine-roster.js';

beforeEach(() => { vi.stubEnv('WICKED_CORE_EXE', '/fixture/wicked-core'); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('parseBrokerStatus', () => {
  it.each([
    ['{"status":"signed_in","detail":{"expires_at":1234}}', { signed_in: true, state: 'signed_in', expires_at: 1234 }],
    ['{"status":"signed_in","detail":{"expires_at":null}}', { signed_in: true, state: 'signed_in' }],
    ['{"status":"signed_out"}', { signed_in: false, state: 'signed_out' }],
    ['{"status":"expired"}', { signed_in: false, state: 'expired' }],
    ['{"status":"refresh_failing","detail":{"expires_at":7,"reason":"the token endpoint refused the refresh (curl exit 22)"}}',
      { signed_in: true, state: 'refresh_failing', expires_at: 7, reason: 'the token endpoint refused the refresh (curl exit 22)' }],
    ['{"status":"unknown","detail":"broker unavailable"}', { signed_in: null, state: 'unknown', reason: 'broker unavailable' }],
    // A diagnostic crosses the wire as its first line, the home spelled ~ (agy crew-r1).
    [`{"status":"unknown","detail":"cannot read ${process.env['HOME'] ?? '/home/x'}/x\\nsecond line"}`, { signed_in: null, state: 'unknown', reason: 'cannot read ~/x' }],
    ['garbage', { signed_in: null, state: 'unknown', reason: 'invalid broker status' }],
    ['null', { signed_in: null, state: 'unknown', reason: 'invalid broker status' }],
    ['[]', { signed_in: null, state: 'unknown', reason: 'invalid broker status' }],
    ['{"status":"other"}', { signed_in: null, state: 'unknown', reason: 'invalid broker status' }],
    ['{"status":"signed_in","detail":"garbage"}', { signed_in: null, state: 'unknown', reason: 'invalid broker status' }],
    ['{"status":"signed_in","detail":{"expires_at":"garbage"}}', { signed_in: null, state: 'unknown', reason: 'invalid broker status' }],
  ])('reads %s', (stdout, expected) => expect(parseBrokerStatus(stdout as string)).toEqual(expected));
});

describe('runSeatLogin', () => {
  it.each(['argv', 'status', 'sign-out', 'ingest'] as const)('passes the engine, gateway and timeout for %s', async (verb) => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: 'fixture output', stderr: '' }));
    vi.stubEnv('SEAT_LOGIN_FIXTURE', 'inherited');
    expect(await runSeatLogin(verb, 'claude', { exec, gatewayDir: '/fixture/state/gateway' })).toEqual({ rc: 0, stdout: 'fixture output', stderr: '' });
    expect(exec).toHaveBeenCalledWith('/fixture/wicked-core', ['seat-login', verb, 'claude'], {
      timeout: verb === 'argv' ? ARGV_TIMEOUT_MS : verb === 'ingest' ? 30_000 : 20_000,
      env: expect.objectContaining({ SEAT_LOGIN_FIXTURE: 'inherited', WICKED_SEAT_GATEWAY_DIR: '/fixture/state/gateway' }),
    });
  });

  it('validates the five seat names before spawning', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '', stderr: '' }));
    expect((await runSeatLogin('status', 'nope', { exec })).rc).toBe(2);
    expect(exec).not.toHaveBeenCalled();
    for (const cli of ['claude', 'codex', 'pi', 'opencode', 'copilot']) {
      expect((await runSeatLogin('status', cli, { exec, gatewayDir: '/fixture/gateway' })).rc).toBe(0);
    }
    expect(exec).toHaveBeenCalledTimes(5);
  });

  it('returns numeric exit codes and output without logging; missing executable/timeout return failure', async () => {
    const exec = vi.fn<ExecLike>().mockRejectedValueOnce(Object.assign(new Error('failed'), { code: 3, stdout: 'fixture stdout', stderr: 'fixture reason' }));
    expect(await runSeatLogin('ingest', 'codex', { exec, gatewayDir: '/fixture/gateway' })).toEqual({ rc: 3, stdout: 'fixture stdout', stderr: 'fixture reason' });
    exec.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
    expect(await runSeatLogin('status', 'codex', { exec, gatewayDir: '/fixture/gateway' })).toEqual({ rc: 1, stdout: '', stderr: 'timed out' });
    vi.stubEnv('WICKED_CORE_EXE', undefined);
    expect((await runSeatLogin('status', 'codex', { exec })).rc).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('broker status cache', () => {
  it('defers spawning, deduplicates refreshes and uses 30s / 5min TTLs', async () => {
    let now = 1000;
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"status":"signed_out"}', stderr: '' }));
    const cache = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' }, () => now);
    expect(cache.read('codex')).toBeUndefined();
    expect(cache.read('codex')).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    await cache.refresh('codex');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(cache.read('codex')?.signed_in).toBe(false);
    now += 29_999;
    cache.read('codex');
    expect(exec).toHaveBeenCalledTimes(1);
    exec.mockResolvedValueOnce({ stdout: '{"status":"signed_in","detail":{"expires_at":null}}', stderr: '' });
    now += 1;
    expect(cache.read('codex')?.signed_in).toBe(false);
    await cache.refresh('codex');
    expect(cache.read('codex')?.signed_in).toBe(true);
    now += 299_999;
    cache.read('codex');
    expect(exec).toHaveBeenCalledTimes(2);
    now += 1;
    cache.read('codex');
    await cache.refresh('codex');
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('does not let a pre-invalidation status restore the old credential reading', async () => {
    let finish!: (out: { stdout: string; stderr: string }) => void;
    const exec = vi.fn<ExecLike>()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ stdout: '{"status":"signed_out"}', stderr: '' });
    const cache = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' });
    const before = cache.refresh('codex');
    await Promise.resolve();
    cache.invalidate('codex');
    expect(cache.read('codex')).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    finish({ stdout: '{"status":"signed_in","detail":{"expires_at":null}}', stderr: '' });
    await before;
    await vi.waitFor(() => expect(cache.read('codex')?.signed_in).toBe(false));
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('retains an unknown broker reason even when core exits 1', async () => {
    const exec = vi.fn<ExecLike>().mockRejectedValue(Object.assign(new Error('unknown'), {
      code: 1, stdout: '{"status":"unknown","detail":"broker unavailable"}', stderr: '',
    }));
    const cache = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' });
    expect(await cache.refresh('codex')).toMatchObject({ signed_in: null, state: 'unknown', reason: 'broker unavailable' });
  });
});

describe('defaultSeatFloor (C5)', () => {
  it('turns the container floor on for a daemon whose operator chose no floor', () => {
    for (const unset of [{}, { WICKED_SEAT_FLOOR: '' }, { WICKED_SEAT_FLOOR: '  ' }] as NodeJS.ProcessEnv[]) {
      const env: NodeJS.ProcessEnv = { ...unset };
      expect(defaultSeatFloor(env)).toBe('container');
      expect(env['WICKED_SEAT_FLOOR']).toBe('container');
      expect(isContainerSeatFloor(env)).toBe(true);
    }
  });

  it("keeps the operator's choice, including the interim host floor", () => {
    for (const chosen of ['host', 'container', 'Container']) {
      const env: NodeJS.ProcessEnv = { WICKED_SEAT_FLOOR: chosen };
      expect(defaultSeatFloor(env)).toBe(chosen);
      expect(env['WICKED_SEAT_FLOOR']).toBe(chosen);
    }
    expect(isContainerSeatFloor({ WICKED_SEAT_FLOOR: 'host' })).toBe(false);
  });
});

describe('isContainerSeatFloor', () => {
  // codex train r4: the engine trims and compares case-insensitively (container_floor.rs).
  it.each([
    ['container', true], [' Container ', true], ['CONTAINER', true], ['host', false], ['', false], [undefined, false], ['containers', false],
  ] as const)('reads %j as %s', (value, on) => {
    expect(isContainerSeatFloor(value === undefined ? {} : { WICKED_SEAT_FLOOR: value })).toBe(on);
  });

  it('marks a seat for container sign-in under a spelling the engine accepts', () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"status":"signed_in","detail":{"expires_at":null}}', stderr: '' }));
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(), registry: () => [{ key: 'codex', display_name: 'Codex', enabled_for_council: true }],
      env: { WICKED_SEAT_FLOOR: ' Container ' }, signedIn: () => true, probe: null,
      containerStatus: new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' }),
    });
    expect(roster()[0]).toMatchObject({ sign_in: 'container' });
  });
});

describe('container roster standing', () => {
  // agy crew-r1: a seat with no container login keeps its own check in container mode.
  it('leaves a seat without a container login on its own check', async () => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"status":"signed_in","detail":{"expires_at":null}}', stderr: '' }));
    const containerStatus = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' });
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(), registry: () => [{ key: 'agy', display_name: 'Antigravity', enabled_for_council: true }],
      env: { WICKED_SEAT_FLOOR: 'container' }, signedIn: () => true, probe: null, containerStatus,
    });
    const seat = roster()[0] as Record<string, unknown>;
    expect(seat['sign_in']).toBeUndefined();
    expect(seat['signed_in']).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });


  it.each([
    ['signed_in', true, 'signed_in'], ['signed_out', false, 'signed_out'], ['expired', false, 'signed_out'], ['unknown', null, 'unknown'],
  ] as const)('uses broker %s instead of host credential probes', async (state, signed, auth) => {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: JSON.stringify({ status: state, detail: { expires_at: null } }), stderr: '' }));
    const containerStatus = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' });
    const signedIn = vi.fn(() => !signed);
    const probe = new SeatProbe({ run: vi.fn(async () => { throw new Error('host probe must not run'); }) });
    const hostRead = vi.spyOn(probe, 'read');
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(), registry: () => [{ key: 'codex', display_name: 'Codex', enabled_for_council: true }],
      env: { WICKED_SEAT_FLOOR: 'container' }, signedIn, probe, containerStatus,
    });
    expect(roster()[0]).toMatchObject({ signed_in: null, auth: 'unknown', sign_in: 'container' });
    expect(exec).not.toHaveBeenCalled();
    await containerStatus.refresh('codex');
    expect(roster()[0]).toMatchObject({ signed_in: signed, auth, sign_in: 'container' });
    expect(toEngineSeat(roster()[0])).not.toHaveProperty('sign_in');
    expect(signedIn).not.toHaveBeenCalled();
    expect(hostRead).not.toHaveBeenCalled();
  });

  it('leaves host roster readings unchanged when container mode is off', () => {
    const exec = vi.fn<ExecLike>();
    const signedIn = vi.fn(() => true);
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(), registry: () => [{ key: 'codex', display_name: 'Codex', login_invocation: 'fixture login' }],
      env: {}, signedIn, containerStatus: new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' }),
    });
    expect(roster()[0]).toMatchObject({ signed_in: true, login_invocation: 'fixture login' });
    expect(roster()[0]).not.toHaveProperty('sign_in');
    expect(signedIn).toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});

// The container floor sends no live request of its own: the seat's own last step is the live check.
// Before, every signed-in container seat carried `live_check_failed` ("its one live request did not
// answer") although nothing was ever sent, including seats finishing units in the same minute.
describe('container floor live check: the seat\'s own last step', () => {
  const SIGNED_IN = '{"status":"signed_in","detail":{"expires_at":null}}';

  function rig() {
    const exec = vi.fn<ExecLike>(async () => ({ stdout: SIGNED_IN, stderr: '' }));
    const containerStatus = new SeatContainerStatus({ exec, gatewayDir: '/fixture/gateway' });
    const seatHealth = new SeatHealthTracker();
    const probe = new SeatProbe({ run: vi.fn(async () => { throw new Error('host probe must not run'); }) });
    const hostRead = vi.spyOn(probe, 'read');
    const roster = rosterWithStandingFactory({
      seatHealth, registry: () => [{ key: 'codex', display_name: 'Codex', enabled_for_council: true }],
      env: { WICKED_SEAT_FLOOR: 'container' }, signedIn: () => true, probe, containerStatus,
    });
    const seat = () => roster()[0] as Record<string, unknown> & { issues: Array<{ code: string; severity: string; message: string; params: Record<string, unknown> }> };
    const unit = (ord: number, ts: number) => seatHealth.ingest({ type: 'unitDistributed', session: 'r1', ord, cli: 'codex', ts } as never);
    const ok = (ord: number, ts: number) => seatHealth.ingest({ type: 'unitOutputCaptured', session: 'r1', ord, stepStatus: 'ok', ts } as never);
    const failed = (ord: number, ts: number, failureKind: string, detail = 'the step failed') =>
      seatHealth.ingest({ type: 'stepFailed', session: 'r1', ord, failureKind, detail, ts } as never);
    return { exec, containerStatus, seatHealth, hostRead, seat, unit, ok, failed };
  }
  const codes = (s: { issues: Array<{ code: string }> }) => s.issues.map((i) => i.code);

  it('reads the broker through the seat-login status path and does not warn before any step ran', async () => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    expect(r.exec).toHaveBeenCalledWith('/fixture/wicked-core', ['seat-login', 'status', 'codex'], expect.anything());
    const s = r.seat();
    expect(s).toMatchObject({ auth: 'signed_in', sign_in: 'container', login_check: 'status' });
    expect(s['login_note']).toMatch(/^login unverified — only the credential broker answered \(broker credential signed_in; no step has run on it in the last 30 minutes\)$/);
    expect(codes(s)).not.toContain('live_check_failed');
    expect(r.hostRead).not.toHaveBeenCalled();
  });

  it('reads a seat with a recent successful unit as verified live, at the time it answered', async () => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    const at = Date.now() - 5 * 60_000;
    r.unit(1, at - 1000);
    r.ok(1, at);
    const s = r.seat();
    expect(s).toMatchObject({ auth: 'signed_in', login_check: 'live', probed_at: new Date(at).toISOString() });
    expect(s).not.toHaveProperty('login_note');
    expect(codes(s)).not.toContain('live_check_failed');
  });

  // codex xreview on #1095: a chat's `chatReply` is a unit's output read back later and stamped when
  // the relay folds it; it must not stand in for the unit (a newer timeout would be erased).
  it('reads a chat answer from its unit, never from the later chatReply', async () => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    const now = Date.now();
    r.unit(1, now - 60_000);
    r.ok(1, now - 50_000);
    r.unit(2, now - 40_000);
    r.failed(2, now - 30_000, 'timedOut');
    r.seatHealth.ingest({ type: 'chatReply', cliKey: 'codex', ok: true, run_id: 'r1', ord: 1 } as never);
    expect(r.seat()).toMatchObject({ login_check: 'status' });
    expect(codes(r.seat())).toContain('live_check_failed');
  });

  it.each([
    ['timedOut', true],
    ['workerError', true],
    // The seat answered and the engine vetoed the substance.
    ['substanceRejected', false],
    // Before any request: says nothing, so the ok before it stands.
    ['environmentRefused', false],
  ] as const)('classifies a later %s step: warns=%s', async (kind, warns) => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    const now = Date.now();
    r.unit(1, now - 60_000);
    r.ok(1, now - 50_000);
    r.unit(2, now - 40_000);
    r.failed(2, now - 30_000, kind);
    const s = r.seat();
    if (warns) {
      expect(s).toMatchObject({ auth: 'signed_in', login_check: 'status', probed_at: new Date(now - 30_000).toISOString() });
      expect(s['login_note']).toContain(kind === 'timedOut' ? 'its last step did not answer (it timed out)' : 'its last step did not answer (its CLI failed)');
      const issue = s.issues.find((i) => i.code === 'live_check_failed');
      expect(issue).toMatchObject({
        severity: 'warning',
        message: "Codex's credential broker says signed in, but its last step on the container floor did not answer",
        params: { checked_at: new Date(now - 30_000).toISOString() },
      });
    } else {
      expect(s).toMatchObject({ login_check: 'live' });
      expect(codes(s)).not.toContain('live_check_failed');
    }
  });

  // codex xreview on #1095: a later answered-but-vetoed step clears an earlier no-answer; an
  // environment refusal (before any request) leaves it standing.
  it.each([
    ['substanceRejected', false],
    ['environmentRefused', true],
  ] as const)('after a timeout, a later %s step: still warns=%s', async (kind, warns) => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    const now = Date.now();
    r.unit(1, now - 40_000);
    r.failed(1, now - 30_000, 'timedOut');
    r.unit(2, now - 20_000);
    r.failed(2, now - 10_000, kind);
    expect(codes(r.seat()).includes('live_check_failed')).toBe(warns);
    expect(r.seat()['probed_at']).toBe(new Date(warns ? now - 30_000 : now - 10_000).toISOString());
  });

  it('clears the warning when the seat answers again', async () => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    const now = Date.now();
    r.unit(1, now - 40_000);
    r.failed(1, now - 30_000, 'timedOut');
    expect(codes(r.seat())).toContain('live_check_failed');
    r.unit(2, now - 20_000);
    r.ok(2, now - 10_000);
    expect(r.seat()).toMatchObject({ login_check: 'live' });
    expect(codes(r.seat())).not.toContain('live_check_failed');
  });

  it('signs the seat out, not a live-check warning, when its step refused for want of a credential', async () => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    r.unit(1, Date.now() - 20_000);
    r.failed(1, Date.now() - 10_000, 'workerError', 'Not logged in · Please run /login');
    const s = r.seat();
    expect(s).toMatchObject({ auth: 'signed_out' });
    expect(codes(s)).toContain('signed_out');
    expect(codes(s)).not.toContain('live_check_failed');
  });

  it('forgets a step older than the window: the broker alone answers again, no warning', async () => {
    const r = rig();
    await r.containerStatus.refresh('codex');
    const old = Date.now() - SEAT_ANSWER_WINDOW_MS - 1000;
    r.unit(1, old - 1000);
    r.failed(1, old, 'timedOut');
    const s = r.seat();
    expect(s).toMatchObject({ login_check: 'status' });
    expect(s['login_note']).toContain('no step has run on it in the last 30 minutes');
    expect(codes(s)).not.toContain('live_check_failed');
  });

  // codex xreview r2 on #1095: the engine's worker failover re-dispatches the unit on another seat
  // with no `unitReassigned`; the replacement's answer is its own, and the failed seat keeps its failure.
  it('credits a failover attempt to the seat it failed over to', () => {
    const t = new SeatHealthTracker();
    t.ingest({ type: 'unitDistributed', session: 'r1', ord: 1, cli: 'claude', ts: 1000 } as never);
    t.ingest({
      type: 'stepFailed', session: 'r1', ord: 1, attempt: 1, failureKind: 'workerError', ts: 2000,
      detail: "seat 'claude' failed (worker error); failing over to 'codex' (seats worker-failed on this unit: 1/2)",
    } as never);
    t.ingest({ type: 'unitOutputCaptured', session: 'r1', ord: 1, attempt: 2, stepStatus: 'ok', ts: 3000 } as never);
    expect(t.lastAnswerFor('claude', 4000)).toEqual({ at: new Date(2000).toISOString(), answered: false, why: 'worker_error' });
    expect(t.lastAnswerFor('codex', 4000)).toEqual({ at: new Date(3000).toISOString(), answered: true });
  });

  // codex xreview r3 on #1095: a refusal the engine benches first drops the unit's assignment; the
  // failover detail still names both seats.
  it('credits a failover attempt to the replacement when the failed seat was benched first', () => {
    const t = new SeatHealthTracker();
    t.ingest({ type: 'unitDistributed', session: 'r0', ord: 1, cli: 'codex', ts: 500 } as never);
    t.ingest({ type: 'stepFailed', session: 'r0', ord: 1, failureKind: 'timedOut', detail: '', ts: 600 } as never);
    t.ingest({ type: 'unitDistributed', session: 'r1', ord: 1, cli: 'claude', ts: 1000 } as never);
    t.ingest({ type: 'seatBenched', session: 'r1', cli: 'claude', reason: 'quota_exhausted', source: 'worker', ts: 1500 } as never);
    t.ingest({
      type: 'stepFailed', session: 'r1', ord: 1, attempt: 1, failureKind: 'workerError', ts: 2000,
      detail: "seat 'claude' failed (worker error); failing over to 'codex' (seats worker-failed on this unit: 1/2)",
    } as never);
    t.ingest({ type: 'unitOutputCaptured', session: 'r1', ord: 1, attempt: 2, stepStatus: 'ok', ts: 3000 } as never);
    expect(t.lastAnswerFor('codex', 4000)).toEqual({ at: new Date(3000).toISOString(), answered: true });
    expect(t.lastAnswerFor('claude', 4000)).toEqual({ at: new Date(2000).toISOString(), answered: false, why: 'worker_error' });
  });

  it('keeps the newest outcome when an older frame is folded late', () => {
    const t = new SeatHealthTracker();
    t.ingest({ type: 'unitDistributed', session: 'r1', ord: 1, cli: 'codex' } as never);
    t.ingest({ type: 'unitOutputCaptured', session: 'r1', ord: 1, stepStatus: 'ok', ts: 2000 } as never);
    t.ingest({ type: 'stepFailed', session: 'r1', ord: 1, failureKind: 'timedOut', detail: '', ts: 1000 } as never);
    expect(t.lastAnswerFor('codex', 3000)).toEqual({ at: new Date(2000).toISOString(), answered: true });
  });

  it('never lets a step outrank a broker that says signed out', () => {
    expect(containerLoginReading({ signed_in: false, state: 'signed_out', probedAt: 'x' }, { at: 'y', answered: true }))
      .toEqual({ signedIn: false, check: 'status', probedAt: 'x', detail: 'broker credential signed_out' });
  });
});
