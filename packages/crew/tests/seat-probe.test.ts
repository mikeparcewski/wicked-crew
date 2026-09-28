// crew#630 / crew#645 — seat truth at launch.
//
// The roster read claude `signed_in` off `<worker home>/claude/.claude.json` (an `oauthAccount`
// block) while the keychain token for that config dir was gone (a moved worker home, crew#630) or
// expired (crew#645): every ballot and unit on the seat then failed after the run was planned. This
// pins the three halves of the fix:
//
//  1. the seat's own auth-status command (`seat-probe.ts`) decides `auth` over the file, on the wire
//     as `auth_source: 'probe'` + `probed_at`, and a signed-out answer benches the seat for the
//     engine BEFORE routing (`council_eligible: false` → engine `health.usable: false`);
//  2. the engine's real refusal frame (`kind: non_zero_exit`, `reason: not_logged_in`, the words
//     on STDOUT) and claude's expired-login words flip the roster within the same run;
//  3. the probe never runs on the request path and never spawns in a test.
import { describe, expect, it } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import {
  PROBE_TTL_OTHER_MS,
  PROBE_TTL_SIGNED_IN_MS,
  SeatProbe,
  classifyProbe,
  classifyVerify,
  execProbe,
  probeCommand,
  verifyCommand,
  type ProbeOutput,
  type ProbeRunner,
} from '../src/api/seat-probe.js';
import { toEngineSeat } from '../src/core/engine-roster.js';
import type { CoreEvent, RosterSeat } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const NOT_LOGGED_IN_CLAUDE: ProbeOutput = {
  code: 1,
  stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
  stderr: '',
};
const LOGGED_IN_CLAUDE: ProbeOutput = { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '' };

/** A runner that answers from a table and records every call. */
function fakeRunner(answer: (cmd: string) => ProbeOutput): { run: ProbeRunner; calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    run: async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return answer(cmd);
    },
  };
}

describe('probeCommand / classifyProbe (crew#630)', () => {
  it('claude is asked under the SEAT config dir — the keychain entry is keyed by it', () => {
    const c = probeCommand('claude', '/w', {}, '/op-home');
    expect(c).toMatchObject({ cmd: 'claude', args: ['auth', 'status', '--json'] });
    expect(c!.env['CLAUDE_CONFIG_DIR']).toBe('/w/claude');
    expect(probeCommand('claude', undefined, {}, '/op-home')!.env['CLAUDE_CONFIG_DIR']).toBe('/op-home/.wicked-worker/claude');
    expect(probeCommand('codex', '/w', {}, '/h')!.env['CODEX_HOME']).toBe('/w/codex');
    // The operator's inherit hatch: the seat runs on the operator's own homes, so no override.
    expect(probeCommand('claude', '/w', { WICKED_WORKER_INHERIT_OPERATOR_CONFIG: '1' }, '/h')!.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    // No status command → no probe (the file heuristic + the seat's own refusal stand).
    for (const k of ['pi', 'copilot', 'opencode', 'agy', 'custom']) expect(probeCommand(k, '/w', {}, '/h')).toBeNull();
  });

  it('reads loggedIn, the exit code, and "could not tell"', () => {
    expect(classifyProbe('claude', NOT_LOGGED_IN_CLAUDE)).toBe(false);
    expect(classifyProbe('claude', LOGGED_IN_CLAUDE)).toBe(true);
    expect(classifyProbe('codex', { code: 1, stdout: 'Not logged in\n', stderr: '' })).toBe(false);
    expect(classifyProbe('codex', { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' })).toBe(true);
    // Missing CLI, timeout, an unexplained failure: unknown, never signed out.
    expect(classifyProbe('claude', { code: null, stdout: '', stderr: '', error: 'spawn claude ENOENT' })).toBeNull();
    expect(classifyProbe('codex', { code: 2, stdout: '', stderr: 'config parse error' })).toBeNull();
  });
});

describe('execProbe (the production runner)', () => {
  it('reports an exit code, a missing CLI and a timeout apart', async () => {
    const node = process.execPath;
    expect(await execProbe(node, ['-e', 'process.stdout.write("Not logged in"); process.exit(1)'], process.env, 10_000)).toMatchObject({ code: 1, stdout: 'Not logged in' });
    expect(await execProbe(node, ['-e', ''], process.env, 10_000)).toMatchObject({ code: 0 });
    const missing = await execProbe('wicked-no-such-cli-630', [], process.env, 10_000);
    expect(missing.code).toBeNull();
    expect(missing.error).toBeDefined();
    const slow = await execProbe(node, ['-e', 'setTimeout(() => {}, 5000)'], process.env, 200);
    expect(slow.code).toBeNull();
  });
});

describe('SeatProbe cache', () => {
  it('never waits: the first read is empty and starts one probe; the answer is served after', async () => {
    const { run, calls } = fakeRunner(() => NOT_LOGGED_IN_CLAUDE);
    const probe = new SeatProbe({ run, env: {}, home: '/h' });
    expect(probe.read('claude', '/w')).toBeUndefined();
    expect(probe.read('claude', '/w')).toBeUndefined(); // deduplicated: still one in flight
    await probe.refresh('claude', '/w');
    expect(calls).toHaveLength(1);
    expect(probe.read('claude', '/w')).toMatchObject({ signedIn: false });
    expect(probe.read('pi', '/w')).toBeUndefined();
    expect(calls).toHaveLength(1); // pi has no probe; nothing spawned for it
  });

  it('re-checks a signed-out answer after 30 s and a signed-in one after 5 min; a new worker home starts over', async () => {
    let now = 1_000_000;
    let answer = NOT_LOGGED_IN_CLAUDE;
    const { run, calls } = fakeRunner(() => answer);
    const probe = new SeatProbe({ run, env: {}, home: '/h', now: () => now });
    await probe.refresh('claude', '/w');
    now += PROBE_TTL_OTHER_MS - 1;
    probe.read('claude', '/w');
    expect(calls).toHaveLength(1);
    answer = LOGGED_IN_CLAUDE; // the operator signed in from the System page
    now += 1;
    expect(probe.read('claude', '/w')).toMatchObject({ signedIn: false }); // stale answer served…
    await probe.refresh('claude', '/w'); // …while the background refresh lands
    expect(probe.read('claude', '/w')).toMatchObject({ signedIn: true });
    const n = calls.length;
    now += PROBE_TTL_SIGNED_IN_MS - 1;
    probe.read('claude', '/w');
    expect(calls).toHaveLength(n);
    expect(probe.read('claude', '/moved')).toBeUndefined(); // a moved home is a different login
  });
});

const CLAUDE: RosterSeat = { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true };
const PI: RosterSeat = { key: 'pi', display_name: 'pi', binary: 'pi', enabled_for_council: true };

describe('GET /roster standing with the probe (crew#630 acceptance)', () => {
  it('a valid .claude.json with no keychain credential reads unknown, then signed_out from the probe — and the engine benches it', async () => {
    const { run } = fakeRunner(() => NOT_LOGGED_IN_CLAUDE);
    const probe = new SeatProbe({ run, env: {}, home: '/h' });
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [{ ...CLAUDE }, { ...PI }],
      signedIn: () => true, // the file heuristic: `oauthAccount` present for both
      env: { WICKED_WORKER_HOME: '/w' },
      probe,
    });
    // Before the probe answers: the file is not a working login.
    const before = roster().find((s) => s.key === 'claude')!;
    expect(before).toMatchObject({ auth: 'unknown', signed_in: null });
    await probe.refresh('claude', '/w');
    const seats = roster();
    const claude = seats.find((s) => s.key === 'claude')!;
    expect(claude).toMatchObject({ auth: 'signed_out', signed_in: false, auth_source: 'probe', council_eligible: false });
    expect(typeof claude['probed_at']).toBe('string');
    expect(String(claude['council_ineligible_reason'])).toContain("the seat's own auth check");
    // pi has no status command: the file reading stands, no probe fields.
    expect(seats.find((s) => s.key === 'pi')).toMatchObject({ auth: 'signed_in', council_eligible: true });
    expect(seats.find((s) => s.key === 'pi')!['auth_source']).toBeUndefined();
    // What the engine is handed at launch: the seat is benched BEFORE routing.
    expect(toEngineSeat(claude)).toMatchObject({ health: { usable: false } });
  });

  it('a signed-in probe reads signed_in with its time', async () => {
    const { run } = fakeRunner(() => LOGGED_IN_CLAUDE);
    const probe = new SeatProbe({ run, env: {}, home: '/h' });
    const roster = rosterWithStandingFactory({ seatHealth: new SeatHealthTracker(), registry: () => [{ ...CLAUDE }], signedIn: () => false, env: {}, probe });
    await probe.refresh('claude', undefined);
    expect(roster()[0]).toMatchObject({ auth: 'signed_in', signed_in: true, auth_source: 'probe', council_eligible: true });
  });
});

describe("the engine's real refusal frames flip the roster within the run (crew#630 §3, crew#645)", () => {
  const roster = (t: SeatHealthTracker) =>
    rosterWithStandingFactory({ seatHealth: t, registry: () => [{ ...CLAUDE }], signedIn: () => true, env: {}, probe: null });

  it('{kind: non_zero_exit, reason: not_logged_in, words on stdout} — as the engine emits it', () => {
    const t = new SeatHealthTracker();
    t.ingest(
      ev({
        type: 'councilSeatFailed',
        session: 'r-630',
        ord: 1,
        round: 1,
        cli: 'claude',
        kind: 'non_zero_exit',
        exitCode: 1,
        stderr: '',
        stdout: 'Not logged in · Please run /login',
        detail: '',
        reason: 'not_logged_in',
        latencyMs: 2700,
      }),
    );
    expect(roster(t)()[0]).toMatchObject({ auth: 'signed_out', auth_source: 'seat-stderr', council_eligible: false, auth_evidence: 'Not logged in · Please run /login' });
  });

  it('reason: not_logged_in alone is enough, and claude\'s expired-login words count', () => {
    const t = new SeatHealthTracker();
    t.ingest(ev({ type: 'councilSeatFailed', session: 'r', cli: 'claude', kind: 'non_zero_exit', stderr: '', stdout: '', detail: '', reason: 'not_logged_in' }));
    expect(roster(t)()[0]).toMatchObject({ auth: 'signed_out' });

    const t2 = new SeatHealthTracker();
    t2.ingest(ev({ type: 'councilSeatFailed', session: 'r', cli: 'claude', kind: 'non_zero_exit', stderr: 'Failed to authenticate: OAuth session expired and could not be refreshed', stdout: '', detail: '', reason: null }));
    expect(roster(t2)()[0]).toMatchObject({ auth: 'signed_out', council_eligible: false });

    // A unit that fails on it (the engine's run path — no ballot) flips it too.
    const t3 = new SeatHealthTracker();
    t3.ingest(ev({ type: 'unitDistributed', session: 'r', ord: 1, cli: 'claude' }));
    t3.ingest(ev({ type: 'stepFailed', session: 'r', ord: 1, failureKind: 'workerError', detail: 'Failed to authenticate: OAuth session expired and could not be refreshed' }));
    expect(roster(t3)()[0]).toMatchObject({ auth: 'signed_out' });

    // …but a unit's own push failing to authenticate to a remote is not the seat's login.
    const t5 = new SeatHealthTracker();
    t5.ingest(ev({ type: 'unitDistributed', session: 'r', ord: 1, cli: 'claude' }));
    t5.ingest(ev({ type: 'stepFailed', session: 'r', ord: 1, failureKind: 'workerError', detail: '(cli `claude` exited 1) fatal: Failed to authenticate to github.com' }));
    expect(roster(t5)()[0]).toMatchObject({ auth: 'signed_in' });

    // crew#645: a free tier the installed CLI is too old for is a seat that cannot answer.
    const t4 = new SeatHealthTracker();
    t4.ingest(ev({ type: 'councilSeatFailed', session: 'r', cli: 'claude', kind: 'non_zero_exit', stderr: 'Error from provider (Console): OpenCode 1.18.0 or newer is required to use the free tier', stdout: '', detail: '', reason: null }));
    expect(roster(t4)()[0]).toMatchObject({ auth: 'signed_out' });
  });

  it("the seat's own refusal beats a signed-in probe", async () => {
    const { run } = fakeRunner(() => LOGGED_IN_CLAUDE);
    const probe = new SeatProbe({ run, env: {}, home: '/h' });
    const t = new SeatHealthTracker();
    const r = rosterWithStandingFactory({ seatHealth: t, registry: () => [{ ...CLAUDE }], signedIn: () => true, env: {}, probe });
    await probe.refresh('claude', undefined);
    t.ingest(ev({ type: 'councilSeatFailed', session: 'r', cli: 'claude', kind: 'non_zero_exit', stdout: 'Not logged in · Please run /login', stderr: '', detail: '', reason: 'not_logged_in' }));
    expect(r()[0]).toMatchObject({ auth: 'signed_out', auth_source: 'seat-stderr' });
  });
});

// crew#645 (reopened): a status command reads the STORED login, so an OAuth session that expired
// and cannot be refreshed still says `loggedIn: true`. The probe makes one live request when the
// status command says signed in; the seat's refusal of it signs the seat out BEFORE routing. Seats
// with nothing to ask say their login is unverified.
describe('an expired login reads signed_out before routing (crew#645)', () => {
  const EXPIRED: ProbeOutput = {
    code: 1,
    stdout: '',
    stderr: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  };
  /** The status command answers `status`; the live check answers `live`. */
  const twoStep = (status: ProbeOutput, live: ProbeOutput) => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run: ProbeRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return args[0] === 'auth' || args[0] === 'login' ? status : live;
    };
    return { run, calls };
  };

  it('the live check runs under the seat config dir, with no tools, MCP or session file', () => {
    const c = verifyCommand('claude', '/w', {}, '/h')!;
    expect(c.cmd).toBe('claude');
    expect(c.args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--strict-mcp-config', '--tools', '']));
    expect(c.env['CLAUDE_CONFIG_DIR']).toBe('/w/claude');
    expect(verifyCommand('codex', '/w', {}, '/h')).toMatchObject({ cmd: 'codex', args: expect.arrayContaining(['exec', '--ephemeral', '--sandbox', 'read-only']) });
    expect(verifyCommand('codex', '/w', {}, '/h')!.env['CODEX_HOME']).toBe('/w/codex');
    for (const k of ['pi', 'copilot', 'opencode', 'agy']) expect(verifyCommand(k, '/w', {}, '/h')).toBeNull();
    expect(classifyVerify({ code: 0, stdout: 'OK', stderr: '' })).toBe(true);
    expect(classifyVerify(EXPIRED)).toBe(false);
    expect(classifyVerify({ code: 1, stdout: '', stderr: 'unexpected status 401 Unauthorized: Missing bearer' })).toBe(false);
    // A timeout, a quota, a network error: the live check cannot tell.
    expect(classifyVerify({ code: null, stdout: '', stderr: '', error: 'killed' })).toBeNull();
    expect(classifyVerify({ code: 1, stdout: '', stderr: 'You have exceeded your rate limit' })).toBeNull();
  });

  it('status says loggedIn but the session is expired → signed_out, verified live, benched for the engine', async () => {
    const { run, calls } = twoStep(LOGGED_IN_CLAUDE, EXPIRED);
    const probe = new SeatProbe({ run, env: {}, home: '/h' });
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [{ ...CLAUDE }],
      signedIn: () => true,
      env: { WICKED_WORKER_HOME: '/w' },
      probe,
    });
    // The launch path: wait for the login check, then read the roster it routes on.
    await roster.ready!();
    const claude = roster()[0]!;
    expect(calls.map((c) => c.args[0])).toEqual(['auth', '-p']);
    expect(claude).toMatchObject({ auth: 'signed_out', signed_in: false, auth_source: 'probe', login_check: 'live', council_eligible: false });
    expect(String(claude['auth_evidence'])).toContain('OAuth session expired');
    expect(toEngineSeat(claude)).toMatchObject({ health: { usable: false } });
  });

  it('a live answer reads verified; a live check that cannot tell keeps the status answer and says so', async () => {
    const ok = twoStep(LOGGED_IN_CLAUDE, { code: 0, stdout: 'OK', stderr: '' });
    const p1 = new SeatProbe({ run: ok.run, env: {}, home: '/h' });
    const r1 = rosterWithStandingFactory({ seatHealth: new SeatHealthTracker(), registry: () => [{ ...CLAUDE }], signedIn: () => true, env: {}, probe: p1 });
    await r1.ready!();
    expect(r1()[0]).toMatchObject({ auth: 'signed_in', login_check: 'live', council_eligible: true });
    expect(r1()[0]!['login_note']).toBeUndefined();

    const slow = twoStep(LOGGED_IN_CLAUDE, { code: null, stdout: '', stderr: '', error: 'timed out' });
    const p2 = new SeatProbe({ run: slow.run, env: {}, home: '/h' });
    const r2 = rosterWithStandingFactory({ seatHealth: new SeatHealthTracker(), registry: () => [{ ...CLAUDE }], signedIn: () => true, env: {}, probe: p2 });
    await r2.ready!();
    expect(r2()[0]).toMatchObject({ auth: 'signed_in', login_check: 'status', council_eligible: true });
    expect(String(r2()[0]!['login_note'])).toMatch(/^login unverified/);
  });

  it('a seat with a login check that has not answered is not routed to; a seat with none says "login unverified"', async () => {
    let release: (o: ProbeOutput) => void = () => undefined;
    const run: ProbeRunner = () => new Promise((r) => (release = r));
    const probe = new SeatProbe({ run, env: {}, home: '/h' });
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [{ ...CLAUDE }, { ...PI }, { key: 'opencode', display_name: 'opencode', binary: 'opencode', enabled_for_council: true }],
      signedIn: (k) => (k === 'opencode' ? false : true),
      env: {},
      probe,
    });
    const seats = roster();
    expect(seats[0]).toMatchObject({ auth: 'unknown', login_check: 'unverified', council_eligible: false });
    expect(String(seats[0]!['council_ineligible_reason'])).toContain('login not verified yet');
    // No status command: the file decides, and the roster says it was not verified.
    for (const s of seats.slice(1)) {
      expect(s).toMatchObject({ login_check: 'unverified', council_eligible: true });
      expect(String(s['login_note'])).toMatch(/^login unverified — nothing asked \w+ whether its login works/);
    }
    // The launch wait is bounded: a check that never answers does not hold a launch forever.
    const t0 = Date.now();
    await probe.ensureFresh(['claude'], undefined, 50);
    expect(Date.now() - t0).toBeLessThan(5_000);
    release(NOT_LOGGED_IN_CLAUDE);
  });
});
