import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { ARGV_TIMEOUT_MS, SeatContainerStatus, parseBrokerStatus, runSeatLogin, type ExecLike } from '../src/api/seat-container-login.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
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
