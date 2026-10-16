// `api/roster-standing.ts` — the ONE roster accessor every launch path shares (F-RECON-002/003).
// Pinned here: the standing readings ride on each seat, and `engineRosterJson` (what `launchRun`
// applies) turns a signed-out seat into the engine's bench verdict. Over an injected registry and
// sign-in probe — never the native addon, never the developer's dotfiles.

import { describe, expect, it, vi } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { chatSeatAdmission } from '../src/api/seat-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { engineRosterJson } from '../src/core/engine-roster.js';
import { CoreAdapter } from '../src/core/adapter.js';

const REGISTRY = [
  { key: 'claude', display_name: 'Claude Code', binary: 'claude', enabled_for_council: true, headless_invocation: 'claude -p {PROMPT}', login_invocation: 'claude login' },
  { key: 'codex', display_name: 'Codex', binary: 'codex', enabled_for_council: true, headless_invocation: 'codex exec {PROMPT}', login_invocation: 'codex login' },
  { key: 'opencode', display_name: 'OpenCode', binary: 'opencode', enabled_for_council: true, headless_invocation: 'opencode run {PROMPT}' },
];

describe('rosterWithStandingFactory', () => {
  it('decorates every registry seat with health + signed_in + standing, read at CALL time', () => {
    const tracker = new SeatHealthTracker();
    let codexSignedIn: boolean | null = false;
    const roster = rosterWithStandingFactory({
      seatHealth: tracker,
      registry: () => REGISTRY.map((s) => ({ ...s })),
      signedIn: (key) => (key === 'codex' ? codexSignedIn : key === 'claude' ? true : null),
      env: { WICKED_WORKER_HOME: '/tmp/worker-home' },
    });
    const first = roster();
    const codex = first.find((s) => s.key === 'codex')!;
    expect(codex.auth).toBe('signed_out');
    expect(codex.council_eligible).toBe(false);
    expect(codex.signed_in).toBe(false);
    expect(codex.health).toEqual(expect.objectContaining({ status: 'active' }));
    // Registry fields ride through verbatim (the engine's login_invocation included).
    expect(codex.login_invocation).toBe('codex login');
    expect(first.find((s) => s.key === 'claude')!.council_eligible).toBe(true);
    // opencode answers on its free tier with an unknown probe.
    expect(first.find((s) => s.key === 'opencode')!.council_eligible).toBe(true);

    // The seat signs in from the Agents page: the very next call sees it — nothing was captured.
    codexSignedIn = true;
    expect(roster().find((s) => s.key === 'codex')!.council_eligible).toBe(true);
  });

  it('F-W1-005: every seat carries the daemon\'s chat admission verdict for BOTH scope modes — the same chatSeatAdmission the POST /chats pre-filter runs', () => {
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [
        ...REGISTRY.map((s) => ({ ...s })),
        { key: 'pi', display_name: 'Pi', binary: 'pi', enabled_for_council: true, headless_invocation: 'pi {PROMPT}', governance_class: 'os_sandbox', acp: { binary: 'pi-acp', acp_input_governance: false, os_sandbox: false } },
        { key: 'governed', display_name: 'Governed', binary: 'claude', enabled_for_council: true, headless_invocation: 'claude -p {PROMPT}', governance_class: 'acp_input_governance', acp: { binary: 'claude-acp', acp_input_governance: true } },
      ],
      signedIn: (key) => (key === 'codex' ? false : true),
      env: { WICKED_WORKER_HOME: '' },
    })();
    const of = (key: string) => roster.find((s) => s.key === key)!['chat_admission'] as { unscoped: { ok: boolean; reason?: string; source?: string }; scoped: { ok: boolean; reason?: string; source?: string }; scoped_bound: { ok: boolean; reason?: string; source?: string } };
    // ASK-C2 (codex on #810 r9): the verdicts are the ASK's. No ACP adapter (this fixture's `claude`
    // carries none): standing admits it unscoped and on a single-repo (bound) ask; a wider
    // repository scope the run cannot bind refuses it.
    expect(of('claude').unscoped).toEqual({ ok: true });
    expect(of('claude').scoped).toEqual({ ok: false, reason: expect.stringMatching(/no governance class.*cannot bind/), source: 'scope' });
    expect(of('claude').scoped_bound).toEqual({ ok: true });
    // Signed out: refused in EVERY mode, source auth (the reason names the remedy).
    expect(of('codex').unscoped).toEqual({ ok: false, reason: expect.stringMatching(/signed out/), source: 'auth' });
    expect(of('codex').scoped.ok).toBe(false);
    expect(of('codex').scoped.source).toBe('auth');
    expect(of('codex').scoped_bound.ok).toBe(false);
    // pi: on the floor, but its floor is the repository boundary — unscoped yes, bound yes, wider scope no.
    expect(of('pi').unscoped).toEqual({ ok: true });
    expect(of('pi').scoped).toEqual({ ok: false, reason: expect.stringMatching(/governance mode for this scope is none.*scope the ask to one repository/), source: 'scope' });
    expect(of('pi').scoped_bound).toEqual({ ok: true });
    // IG1-crew-1: the roster states the mode per scope kind, read from the engine's class.
    const mode = (key: string) => roster.find((s) => s.key === key)!['governance_mode'] as Record<string, { mode: string; source: string; class: string | null }>;
    // C5: on the interim host floor the engine refuses pi's governed work.
    expect(mode('pi')['scoped_bound']).toMatchObject({ mode: 'none', source: 'none', class: 'os_sandbox' });
    expect(mode('pi')['scoped']).toMatchObject({ mode: 'none', class: 'os_sandbox' });
    // C5: the executable decides — this seat runs `claude -p`, so its gate hook holds it.
    expect(mode('governed')['scoped']).toMatchObject({ mode: 'admitted', source: 'acp_input_governance' });
    expect(mode('claude')['scoped_bound']).toMatchObject({ mode: 'none', class: null });
    // A governed adapter sits in every mode.
    expect(of('governed')).toEqual({ unscoped: { ok: true }, scoped: { ok: true }, scoped_bound: { ok: true } });
    // The verdict IS the pre-filter's: the same function, the same inputs.
    for (const key of ['claude', 'codex', 'pi', 'governed']) {
      const seat = roster.find((s) => s.key === key)!;
      expect(of(key).scoped).toEqual(chatSeatAdmission(seat as unknown as Parameters<typeof chatSeatAdmission>[0], seat.auth!, true, 'path'));
      expect(of(key).scoped_bound).toEqual(chatSeatAdmission(seat as unknown as Parameters<typeof chatSeatAdmission>[0], seat.auth!, true, 'path-bound'));
      expect(of(key).unscoped).toEqual(chatSeatAdmission(seat as unknown as Parameters<typeof chatSeatAdmission>[0], seat.auth!, false, 'path'));
    }
  });

  it('a signed-out seat reaches the ENGINE benched: health {usable:false, reason:"signed out"} (engineRosterJson, what launchRun applies)', () => {
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => REGISTRY.map((s) => ({ ...s })),
      signedIn: (key) => key !== 'codex',
      env: {},
    });
    const engine = JSON.parse(engineRosterJson(JSON.stringify(roster()))) as Array<Record<string, unknown>>;
    const codex = engine.find((s) => s['key'] === 'codex')!;
    expect(codex['health']).toEqual({ usable: false, reason: 'signed out' });
    expect(engine.find((s) => s['key'] === 'claude')!['health']).toEqual({ usable: true });
    // Crew's own readings never reach the engine.
    for (const seat of engine) {
      for (const k of ['signed_in', 'auth', 'council_eligible', 'council_ineligible_reason', 'council_bench', 'chat_admission']) {
        expect(k in seat, `${String(seat['key'])}.${k} must not reach the engine`).toBe(false);
      }
    }
  });

  it('WICKED_WORKER_HOME is read per call from the given env ("" = unset)', () => {
    const seen: Array<string | undefined> = [];
    const env: NodeJS.ProcessEnv = { WICKED_WORKER_HOME: '' };
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(),
      registry: () => [REGISTRY[0]!],
      signedIn: (_key, root) => {
        seen.push(root);
        return true;
      },
      env,
    });
    roster();
    env['WICKED_WORKER_HOME'] = '/live/root';
    roster();
    expect(seen).toEqual([undefined, '/live/root']);
  });
});

// crew#1021: the native predicate walks the skills ladder; repeat reads must reuse its answer.
describe('QE reviewer generation memo (crew#1021)', () => {
  function fixture(snapshot: string | undefined = '/published/1', admitted: boolean | null = true) {
    let now = 0;
    let calls = 0;
    const env: NodeJS.ProcessEnv = { WICKED_SKILLS_SNAPSHOT: snapshot, CLAUDE_CONFIG_DIR: '/config', HOME: '/home' };
    const seats = [...REGISTRY.map((s) => ({ ...s })), { ...REGISTRY[0]!, key: 'pi' }, { ...REGISTRY[0]!, key: 'copilot' }];
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(), registry: () => seats, signedIn: () => true,
      env, worktreeBench: () => new Map(), hostBoundary: () => null,
      qeAdmitted: () => { calls++; return admitted; }, qeAdmittedBatch: null, nowMs: () => now,
    });
    return { roster, env, seats, calls: () => calls, advance: (ms: number) => { now += ms; } };
  }

  it('calls once per seat for ten reads, preserving the entire standing output', () => {
    const f = fixture();
    const first = f.roster();
    for (let i = 1; i < 10; i++) expect(f.roster()).toEqual(first);
    expect(f.calls()).toBe(5);
    f.advance(120_000);
    f.roster();
    expect(f.calls()).toBe(5); // immutable published directory needs no TTL
  });

  it('re-judges when any engine ladder input or a seat invocation changes', () => {
    const f = fixture();
    f.roster();
    f.env.WICKED_SKILLS_SNAPSHOT = '/published/2';
    f.roster();
    expect(f.calls()).toBe(10);
    f.env.CLAUDE_CONFIG_DIR = '/other-config';
    f.roster();
    expect(f.calls()).toBe(15);
    f.env.HOME = '/other-home';
    f.roster();
    expect(f.calls()).toBe(20);
    f.seats[0]!.headless_invocation = 'claude --changed {PROMPT}';
    f.roster();
    expect(f.calls()).toBe(21);    // The predicate reads the live registry record: a changed binary under the same key is re-judged (codex on #1027).
    (f.seats[0] as { binary?: string }).binary = 'codex';
    f.roster();
    expect(f.calls()).toBe(22);
  });

  it('expires the mutable fallback after 30 seconds using the injected clock', () => {
    const f = fixture();
    delete f.env.WICKED_SKILLS_SNAPSHOT;
    f.roster();
    f.advance(29_999);
    f.roster();
    expect(f.calls()).toBe(5);
    f.advance(1);
    f.roster();
    expect(f.calls()).toBe(10);
  });

  it('memoizes null from an addon without the predicate too', () => {
    const f = fixture('/published/1', null);
    const first = f.roster();
    expect(first.every((seat) => seat['qe_reviewer'] === undefined)).toBe(true);
    expect(f.roster()).toEqual(first);
    expect(f.calls()).toBe(5);
  });

  it('treats an empty snapshot as unset for the token and the mutable TTL', () => {
    const f = fixture('');
    f.roster();
    delete f.env.WICKED_SKILLS_SNAPSHOT;
    f.roster();
    expect(f.calls()).toBe(5);
    f.env.WICKED_SKILLS_SNAPSHOT = '';
    f.advance(30_000);
    f.roster();
    expect(f.calls()).toBe(10);
    f.advance(30_000);
    f.roster();
    expect(f.calls()).toBe(15);
  });

  it('re-judges when USERPROFILE changes with HOME unset', () => {
    const f = fixture();
    delete f.env.HOME;
    f.env.USERPROFILE = '/profile/1';
    f.roster();
    f.env.USERPROFILE = '/profile/2';
    f.roster();
    expect(f.calls()).toBe(10);
  });

  it('expires the mutable fallback when the snapshot stays empty', () => {
    const f = fixture('');
    f.roster();
    f.advance(30_000);
    f.roster();
    expect(f.calls()).toBe(10);
  });
});

describe('background QE reviewer batches (crew#1021)', () => {
  function fixture() {
    let now = 0;
    const env: NodeJS.ProcessEnv = { WICKED_SKILLS_SNAPSHOT: '/published/1', HOME: '/home' };
    const seats = REGISTRY.map((seat) => ({ ...seat }));
    const pending: Array<{
      resolve: (admissions: Map<string, boolean>) => void;
      reject: (error: Error) => void;
    }> = [];
    const batch = vi.fn<(seats: Array<{ key: string; invocation?: string }>) => Promise<Map<string, boolean>>>(() => new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    }));
    const sync = vi.fn(() => { throw new Error('sync QE predicate must never run with a batch'); });
    const roster = rosterWithStandingFactory({
      seatHealth: new SeatHealthTracker(), registry: () => seats, signedIn: () => true,
      env, worktreeBench: () => new Map(), hostBoundary: () => null,
      qeAdmitted: sync, qeAdmittedBatch: batch, nowMs: () => now,
    });
    const settle = async (index: number, admitted: boolean) => {
      pending[index]!.resolve(new Map(seats.map(({ key }) => [key, admitted])));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return { roster, env, seats, batch, sync, pending, settle, advance: (ms: number) => { now += ms; } };
  }

  it('feature-detects the addon static at read time and sends absent invocations as null', async () => {
    // A fake addon object: the real napi static is not configurable (and exists once core-ts carries it).
    const addon: { qeReviewersAdmitted?: (json: string) => Promise<string> } = {};
    const registry = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      REGISTRY[0]!, { key: 'codex', enabled_for_council: true },
    ]);
    const sync = vi.fn(() => true);
    try {
      const roster = rosterWithStandingFactory({
        seatHealth: new SeatHealthTracker(), env: { WICKED_SKILLS_SNAPSHOT: '/published/1' },
        probe: null, versions: null, versionPins: null, worktreeBench: () => new Map(),
        hostBoundary: () => null, qeAdmitted: sync, qeAddon: addon,
      });
      const batch = vi.fn(async () => JSON.stringify([{ key: 'claude', admitted: true }, { key: 'codex', admitted: false }]));
      addon.qeReviewersAdmitted = batch; // available after factory construction
      expect(roster().every((s) => s.qe_reviewer === undefined)).toBe(true);
      expect(batch).toHaveBeenCalledExactlyOnceWith(JSON.stringify([
        { key: 'claude', invocation: REGISTRY[0]!.headless_invocation },
        { key: 'codex', invocation: null },
      ]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(roster().every((s) => s.qe_reviewer !== undefined)).toBe(true);
      expect(sync).not.toHaveBeenCalled();
      expect(batch).toHaveBeenCalledTimes(1);
      delete addon.qeReviewersAdmitted;
      roster();
      roster();
      expect(sync).toHaveBeenCalledTimes(2); // missing batch: memoized synchronous fallback
    } finally {
      registry.mockRestore();
    }
  });

  it('serves unknown on a cold miss, coalesces the whole roster, then serves both true and false admissions', async () => {
    const f = fixture();
    for (let i = 0; i < 10; i++) expect(f.roster().every((s) => s.qe_reviewer === undefined)).toBe(true);
    expect(f.batch).toHaveBeenCalledExactlyOnceWith(REGISTRY.map((seat) => ({ key: seat.key, invocation: seat.headless_invocation })));
    f.pending[0]!.resolve(new Map([['claude', true], ['codex', false], ['opencode', true]]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const roster = f.roster();
    expect(roster[0]!.qe_reviewer).toMatchObject({ ok: true });
    expect(roster[1]!.qe_reviewer).toMatchObject({ ok: false });
    for (let i = 0; i < 10; i++) expect(f.roster()).toEqual(roster);
    f.advance(120_000);
    f.roster();
    expect(f.batch).toHaveBeenCalledTimes(1); // immutable generation
    expect(f.sync).not.toHaveBeenCalled();
  });

  it('serves the last admission during generation, invocation and fallback TTL misses, with one batch in flight', async () => {
    const f = fixture();
    f.roster();
    await f.settle(0, true);
    f.env.WICKED_SKILLS_SNAPSHOT = '/published/2';
    for (let i = 0; i < 10; i++) expect(f.roster().every((s) => (s.qe_reviewer as { ok: boolean }).ok)).toBe(true);
    expect(f.batch).toHaveBeenCalledTimes(2);
    await f.settle(1, false);
    f.seats[0]!.headless_invocation = 'claude --changed {PROMPT}';
    for (let i = 0; i < 10; i++) expect(f.roster()[0]!.qe_reviewer).toMatchObject({ ok: false });
    expect(f.batch).toHaveBeenCalledTimes(3);
    expect(f.batch.mock.calls[2]![0]).toHaveLength(REGISTRY.length); // refresh all seats on one miss
    await f.settle(2, true);
    f.env.WICKED_SKILLS_SNAPSHOT = '';
    f.roster();
    await f.settle(3, true);
    f.advance(29_999);
    f.roster();
    expect(f.batch).toHaveBeenCalledTimes(4);
    f.advance(1);
    for (let i = 0; i < 10; i++) expect(f.roster()[0]!.qe_reviewer).toMatchObject({ ok: true });
    expect(f.batch).toHaveBeenCalledTimes(5);
    await f.settle(4, false);
    expect(f.roster()[0]!.qe_reviewer).toMatchObject({ ok: false });
    expect(f.sync).not.toHaveBeenCalled();
  });

  it('drops stale completions, including when the env changes without a read and when a token is revisited', async () => {
    const f = fixture();
    f.roster();
    f.env.WICKED_SKILLS_SNAPSHOT = '/published/2';
    await f.settle(0, true); // no intervening read: must not even fill lastAdmission
    expect(f.roster()[0]!.qe_reviewer).toBeUndefined();
    f.env.WICKED_SKILLS_SNAPSHOT = '/published/1';
    f.roster();
    f.env.WICKED_SKILLS_SNAPSHOT = '/published/2';
    f.roster();
    expect(f.batch).toHaveBeenCalledTimes(3); // revisiting /published/2 cannot duplicate its pending batch
    await f.settle(1, true); // earlier epoch of /published/2 must not fill the memo
    expect(f.roster()[0]!.qe_reviewer).toBeUndefined(); // starts the new epoch's batch now
    expect(f.batch).toHaveBeenCalledTimes(4);
    await f.settle(3, false); // newest /published/2 wins
    await f.settle(2, true); // older /published/1 must not overwrite it
    expect(f.roster().every((s) => (s.qe_reviewer as { ok: boolean }).ok === false)).toBe(true);
    expect(f.batch).toHaveBeenCalledTimes(4);
    expect(f.sync).not.toHaveBeenCalled();
  });

  it('drops a batch for an obsolete invocation and retries a rejected batch without a sync fallback', async () => {
    const f = fixture();
    f.roster();
    f.seats[0]!.headless_invocation = 'claude --changed {PROMPT}';
    f.roster();
    await f.settle(0, true);
    expect(f.roster()[0]!.qe_reviewer).toBeUndefined();
    f.pending[1]!.reject(new Error('native batch failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.roster()[0]!.qe_reviewer).toBeUndefined();
    expect(f.batch).toHaveBeenCalledTimes(3);
    await f.settle(2, true);
    expect(f.roster()[0]!.qe_reviewer).toMatchObject({ ok: true });
    expect(f.sync).not.toHaveBeenCalled();
  });
});
