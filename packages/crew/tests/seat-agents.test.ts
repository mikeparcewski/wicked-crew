// DES-seats-page A1, A3–A6: the Agents page's readings on `GET /roster`, over an injected registry,
// sign-in reading, version source and engine worktree predicate (no native addon, no CLI spawned).

import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { liveCheckLiftsBench, seatIssues, displayCommand } from '../src/api/seat-agents.js';
import { SEAT_BENCH_WINDOW_MS, SeatHealthTracker } from '../src/api/seat-health.js';
import { SeatProbe } from '../src/api/seat-probe.js';
import { SEAT_VERSION_KEEP_MS, SEAT_VERSION_RETRY_MS, SEAT_VERSION_TTL_MS, SeatVersionCache, firstVersionLine, installSourceOf, probeSeatVersions, seatVersion } from '../src/api/seat-version.js';
import { toEngineSeat } from '../src/core/engine-roster.js';
import type { CoreEvent } from '../src/core/types.js';

const ev = (frame: Record<string, unknown>): CoreEvent => frame as unknown as CoreEvent;

const HOME = '/home/fabricated';
const REGISTRY = [
  {
    key: 'claude',
    display_name: 'Claude Code',
    binary: 'claude',
    enabled_for_council: true,
    governance_class: 'acp_input_governance',
    acp: { acp_input_governance: true },
    login_invocation: `CLAUDE_CONFIG_DIR="${HOME}/.wicked-worker/claude" claude`,
  },
  {
    key: 'claude-eval',
    display_name: 'Claude Code (reviewer)',
    binary: 'claude',
    enabled_for_council: true,
    seat_eligible_for_work: false,
    governance_class: 'acp_input_governance',
    acp: { acp_input_governance: true },
  },
  {
    key: 'codex',
    display_name: 'Codex',
    binary: 'codex',
    enabled_for_council: true,
    governance_class: 'os_sandbox',
    trust_flags: ['--sandbox', 'workspace-write'],
    login_invocation: `CODEX_HOME="${HOME}/.wicked-worker/codex" codex login`,
    logout_invocation: `CODEX_HOME="${HOME}/.wicked-worker/codex" codex logout`,
  },
  { key: 'copilot', display_name: 'GitHub Copilot CLI', binary: 'copilot', enabled_for_council: true, governance_class: 'os_sandbox' },
  {
    key: 'opencode',
    display_name: 'opencode',
    binary: 'opencode',
    enabled_for_council: true,
    governance_class: 'acp_input_governance',
    acp: { acp_input_governance: true, verified_version: '1.17.18', binary: 'opencode' },
  },
];

const ENGINE_BENCH = 'codex cannot work in this run\'s worktree on this host: its commands come back `approval request failed`';

function rosterOver(opts: {
  tracker?: SeatHealthTracker;
  signed?: Record<string, boolean | null>;
  worktree?: Map<string, string> | null;
  /** The engine's host-floor bench (`Core.worktreeBenched(seats, false)`'s governed-only entries). */
  hostFloor?: Map<string, string> | null | (() => Map<string, string> | null);
  /** The daemon env (default: no floor chosen). */
  env?: NodeJS.ProcessEnv;
  hostBoundary?: string | null;
  probe?: SeatProbe | null;
  versions?: SeatVersionCache | null;
  pins?: Record<string, { matched: boolean; observed: string | null; pinned: string }>;
  /** The engine's QE skill admission per seat (default: every seat admitted). `null` = no answer. */
  qeAdmitted?: ((key: string) => boolean | null) | null;
  registry?: Array<Record<string, unknown>>;
}) {
  return rosterWithStandingFactory({
    seatHealth: opts.tracker ?? new SeatHealthTracker(),
    registry: () => (opts.registry ?? REGISTRY).map((s) => ({ ...s })),
    signedIn: (k) => opts.signed?.[k] ?? true,
    env: { WICKED_WORKER_HOME: '', ...(opts.env ?? {}) },
    probe: opts.probe ?? null,
    versions: opts.versions ?? null,
    versionPins:
      opts.pins === undefined
        ? null
        : ({
            read: (cli: string) => {
              const p = opts.pins![cli];
              return p === undefined ? undefined : { cli, binary: cli, governanceClaimed: true, disclosure: null, ...p };
            },
          } as never),
    worktreeBench: opts.worktree === null ? null : () => opts.worktree ?? new Map([['codex', ENGINE_BENCH]]),
    hostFloorBench:
      opts.hostFloor === undefined || opts.hostFloor === null
        ? null
        : typeof opts.hostFloor === 'function'
          ? opts.hostFloor
          : () => opts.hostFloor as Map<string, string>,
    qeAdmitted: ((admit) => (admit === null ? null : (k: string) => (admit === undefined ? true : admit(k))))(opts.qeAdmitted),
    hostBoundary: () => (opts.hostBoundary === undefined ? 'sandbox-exec' : opts.hostBoundary),
    home: HOME,
  });
}

type Seat = Record<string, unknown> & { key: string };
const seat = (roster: unknown[], key: string): Seat => (roster as Seat[]).find((s) => s.key === key)!;
const codes = (s: Seat) => (s['issues'] as Array<{ code: string; severity: string }>).map((i) => `${i.severity}:${i.code}`);

const HOST_FLOOR_ENGINE =
  'runs only on the container floor: on the host floor only claude and a bounded codex keep a per-call check, so a governed unit on this seat is refused (needs_container_floor) — set WICKED_SEAT_FLOOR=container or remove the seat';

describe('wicked-core#976: the host-floor bench', () => {
  it('a host-floor-benched seat gets no work and no chat in any scope, with its own code and plain copy', () => {
    const roster = rosterOver({ hostFloor: new Map([['copilot', HOST_FLOOR_ENGINE], ['opencode', HOST_FLOOR_ENGINE]]) })();
    for (const k of ['copilot', 'opencode']) {
      const s = seat(roster, k);
      expect(s['host_floor_bench']).toBe(HOST_FLOOR_ENGINE);
      const work = s['work_admission'] as Record<string, { ok: boolean; reason_code?: string; source?: string; reason?: string }>;
      for (const scope of ['unscoped', 'scoped', 'scoped_bound']) {
        expect(work[scope]).toMatchObject({ ok: false, reason_code: 'host_floor_bench', source: 'launcher' });
        expect(work[scope]!.reason).toMatch(/WICKED_SEAT_FLOOR=container/);
        expect(work[scope]!.reason).not.toMatch(/needs_container_floor/);
      }
      const chat = s['chat_admission'] as Record<string, { ok: boolean; source?: string; reason?: string }>;
      for (const scope of ['unscoped', 'scoped', 'scoped_bound']) {
        expect(chat[scope]).toMatchObject({ ok: false, source: 'engine' });
        expect(chat[scope]!.reason).toMatch(/run agents in containers/);
      }
      expect(s['qe_reviewer']).toMatchObject({ ok: false, reason_code: 'host_floor_bench' });
      expect(codes(s)).toContain('warning:host_floor');
      // It still judges, triages and votes (ungoverned engine calls): `council_eligible` — which the
      // launch turns into the engine's health, a bench on EVERY call — does not read it.
      expect(s['council_eligible']).toBe(true);
      expect((toEngineSeat(s) as Record<string, unknown>)['health']).toEqual({ usable: true });
      expect('host_floor_bench' in (toEngineSeat(s) as Record<string, unknown>)).toBe(false);
    }
    // claude keeps a check on the host floor: untouched.
    const claude = seat(roster, 'claude');
    expect('host_floor_bench' in claude).toBe(false);
    expect((claude['work_admission'] as Record<string, unknown>)['unscoped']).toEqual({ ok: true });
  });

  it('off the host floor (an empty bench) or with an addon that cannot answer, nothing changes', () => {
    for (const hostFloor of [new Map<string, string>(), null]) {
      const copilot = seat(rosterOver({ hostFloor })(), 'copilot');
      expect('host_floor_bench' in copilot).toBe(false);
      expect((copilot['work_admission'] as Record<string, unknown>)['unscoped']).toEqual({ ok: true });
      expect(codes(copilot)).not.toContain('warning:host_floor');
    }
  });

  it('the host_floor warning is read off the bench itself, whatever refusal leads the admissions', () => {
    const roster = rosterOver({
      signed: { copilot: false },
      registry: REGISTRY.map((s) => (s.key === 'opencode' ? { ...s, enabled_for_council: false, seat_eligible_for_work: false } : s)),
      hostFloor: new Map([['copilot', HOST_FLOOR_ENGINE], ['opencode', HOST_FLOOR_ENGINE]]),
    })();
    expect((seat(roster, 'copilot')['work_admission'] as Record<string, unknown>)['unscoped']).toMatchObject({ reason_code: 'signed_out' });
    expect((seat(roster, 'opencode')['work_admission'] as Record<string, unknown>)['unscoped']).toMatchObject({ reason_code: 'not_enabled' });
    for (const k of ['copilot', 'opencode']) expect(codes(seat(roster, k))).toContain('warning:host_floor');
  });

  describe('council vs work eligibility (crew#916, wicked-core#572)', () => {
    const over = (patch: Record<string, unknown>) =>
      rosterOver({ worktree: new Map(), registry: REGISTRY.map((s) => (s.key === 'copilot' ? { ...s, ...patch } : s)) })();

    it('a work-only seat is admitted for work and as a QE reviewer — never refused not_enabled — and is convened by the launch', () => {
      const s = seat(over({ enabled_for_council: false, seat_eligible_for_work: true }), 'copilot');
      expect(s['council_eligible']).toBe(false);
      expect(s['work_eligible']).toBe(true);
      const work = s['work_admission'] as Record<string, { ok: boolean; reason_code?: string }>;
      for (const scope of ['unscoped', 'scoped_bound']) expect(work[scope]).toEqual({ ok: true });
      for (const scope of ['unscoped', 'scoped', 'scoped_bound']) expect(work[scope]!.reason_code).not.toBe('not_enabled');
      expect(s['qe_reviewer']).toEqual({ ok: true });
      expect((s['chat_admission'] as Record<string, unknown>)['unscoped']).toEqual({ ok: true });
      expect((toEngineSeat(s) as Record<string, unknown>)['health']).toEqual({ usable: true });
    });

    it('a seat with neither role is refused not_enabled and benched', () => {
      const s = seat(over({ enabled_for_council: false, seat_eligible_for_work: false }), 'copilot');
      expect(s).toMatchObject({ council_eligible: false, work_eligible: false });
      expect((s['work_admission'] as Record<string, unknown>)['unscoped']).toMatchObject({ ok: false, reason_code: 'not_enabled' });
      expect(s['qe_reviewer']).toMatchObject({ ok: false, reason_code: 'not_enabled' });
      expect((toEngineSeat(s) as Record<string, unknown>)['health']).toEqual({ usable: false, reason: 'not enabled for council or work' });
    });

    it('a reviewer-only seat stays council-eligible and is refused work as reviewer_only', () => {
      const s = seat(over({ enabled_for_council: true, seat_eligible_for_work: false }), 'copilot');
      expect(s).toMatchObject({ council_eligible: true, work_eligible: false });
      expect((s['work_admission'] as Record<string, unknown>)['unscoped']).toMatchObject({ ok: false, reason_code: 'reviewer_only' });
      expect(s['qe_reviewer']).toEqual({ ok: true });
      expect((toEngineSeat(s) as Record<string, unknown>)['health']).toEqual({ usable: true });
    });

    it('a signed-out work-only seat is refused signed_out with the sign-in sentence, not the ballot flag', () => {
      const roster = rosterOver({ worktree: new Map(), signed: { copilot: false }, registry: REGISTRY.map((s) => (s.key === 'copilot' ? { ...s, enabled_for_council: false } : s)) })();
      const work = (seat(roster, 'copilot')['work_admission'] as Record<string, { reason_code?: string; reason?: string }>)['unscoped']!;
      expect(work.reason_code).toBe('signed_out');
      expect(work.reason).toMatch(/signed out/);
    });
  });

  describe('a host-floor bench read that fails is never "no bench"', () => {
    const boom = () => {
      throw new Error('engine said something odd');
    };
    it('on the host floor with no earlier reading: every admission fails closed, disclosed', () => {
      const roster = rosterOver({ env: { WICKED_SEAT_FLOOR: 'host' }, hostFloor: boom })();
      for (const k of ['claude', 'copilot', 'opencode']) {
        const s = seat(roster, k);
        expect(s['host_floor_unknown']).toMatch(/could not read which agents the engine gives work to/);
        for (const scope of ['unscoped', 'scoped', 'scoped_bound']) {
          expect((s['chat_admission'] as Record<string, unknown>)[scope]).toMatchObject({ ok: false, source: 'engine' });
        }
        expect('work_admission' in s).toBe(false);
        expect('qe_reviewer' in s).toBe(false);
        expect(codes(s)).toContain('warning:host_floor_unknown');
      }
    });
    it('a later failed read keeps the last answer the engine gave', () => {
      let calls = 0;
      const flaky = () => {
        calls += 1;
        if (calls > 1) throw new Error('later failure');
        return new Map([['copilot', HOST_FLOOR_ENGINE]]);
      };
      const accessor = rosterOver({ env: { WICKED_SEAT_FLOOR: 'host' }, hostFloor: flaky });
      accessor();
      const again = accessor();
      expect(seat(again, 'copilot')['host_floor_bench']).toBe(HOST_FLOOR_ENGINE);
      expect('host_floor_unknown' in seat(again, 'claude')).toBe(false);
      expect((seat(again, 'claude')['work_admission'] as Record<string, unknown>)['unscoped']).toEqual({ ok: true });
    });
    it('…but only for the roster it was read for: a seat added (or re-pointed) since is unknown', () => {
      let calls = 0;
      let registry: Array<Record<string, unknown>> = REGISTRY;
      const flaky = () => {
        calls += 1;
        if (calls > 1) throw new Error('later failure');
        return new Map([['copilot', HOST_FLOOR_ENGINE]]);
      };
      const accessor = rosterWithStandingFactory({
        seatHealth: new SeatHealthTracker(),
        registry: () => registry.map((s) => ({ ...s })),
        signedIn: () => true,
        env: { WICKED_WORKER_HOME: '', WICKED_SEAT_FLOOR: 'host' },
        probe: null,
        versions: null,
        versionPins: null,
        worktreeBench: () => new Map(),
        hostFloorBench: flaky,
        qeAdmitted: () => true,
        hostBoundary: () => null,
      });
      accessor();
      registry = [...REGISTRY, { key: 'smoke-judge', display_name: 'smoke-judge', binary: 'smoke-judge', enabled_for_council: true }];
      const after = accessor();
      for (const k of ['smoke-judge', 'claude']) {
        expect(seat(after, k)['host_floor_unknown'], k).toBeDefined();
        expect('work_admission' in seat(after, k)).toBe(false);
      }
    });
    it('off the host floor a failed read benches nothing (the engine benches nothing there)', () => {
      // No floor chosen (the container floor is pinned against the real addon in host-floor-bench-addon.test.ts).
      const roster = rosterOver({ hostFloor: boom })();
      const copilot = seat(roster, 'copilot');
      expect('host_floor_unknown' in copilot).toBe(false);
      expect((copilot['work_admission'] as Record<string, unknown>)['unscoped']).toEqual({ ok: true });
    });
    it('a malformed engine answer is a failed read', async () => {
      const { readLaunchBench } = await import('../src/core/adapter.js');
      expect(() => readLaunchBench(() => '{"cli":"pi"}', [], false, true)).toThrow(/array/);
      expect(() => readLaunchBench(() => '[{"cli":"pi"}]', [], false, true)).toThrow(/seat and a reason/);
      expect(() => readLaunchBench(() => 'not json', [], false, true)).toThrow();
      expect(() => readLaunchBench(() => '[{"cli":"pi","reason":"r","governed_only":"true"}]', [], false, true)).toThrow(/boolean/);
      expect(() => readLaunchBench(() => '[{"cli":"pi","reason":""}]', [], false, true)).toThrow(/seat and a reason/);
      const roster = rosterOver({
        env: { WICKED_SEAT_FLOOR: 'host' },
        hostFloor: () => readLaunchBench(() => '[null]', [], false, true),
      })();
      expect(seat(roster, 'copilot')['host_floor_unknown']).toBeDefined();
    });
  });

  it('a signed-out seat leads with the auth refusal; the host floor rides beside it in the chat reason', () => {
    const roster = rosterOver({ signed: { copilot: false }, hostFloor: new Map([['copilot', HOST_FLOOR_ENGINE]]) })();
    const copilot = seat(roster, 'copilot');
    expect((copilot['work_admission'] as Record<string, unknown>)['unscoped']).toMatchObject({ reason_code: 'signed_out', source: 'auth' });
    const chat = (copilot['chat_admission'] as Record<string, { source?: string; reason?: string }>)['unscoped']!;
    expect(chat.source).toBe('auth');
    expect(chat.reason).toMatch(/signed out.*run agents in containers/);
  });
});

describe('A5 work_admission and A4 qe_reviewer', () => {
  it('codex is admitted to chats and unbound work, but the engine benches it on bound work (and so for QE)', () => {
    const roster = rosterOver({})();
    const codex = seat(roster, 'codex');
    expect(codex['chat_admission']).toMatchObject({ scoped_bound: { ok: true } });
    expect(codex['work_admission']).toEqual({
      unscoped: { ok: true },
      scoped: { ok: true },
      scoped_bound: { ok: false, reason_code: 'worktree_bench', source: 'launcher', reason: ENGINE_BENCH },
    });
    expect(codex['qe_reviewer']).toEqual({ ok: false, reason_code: 'worktree_bench', reason: ENGINE_BENCH });
  });

  it('QE is every seat now (core#917): any signed-in seat a bound run would keep is a QE reviewer, a reviewer-only one too', () => {
    const roster = rosterOver({})();
    for (const k of ['claude', 'copilot', 'opencode', 'claude-eval']) expect(seat(roster, k)['qe_reviewer']).toEqual({ ok: true });
    expect((seat(roster, 'claude-eval')['work_admission'] as Record<string, unknown>)['scoped_bound']).toMatchObject({ ok: false, reason_code: 'reviewer_only', source: 'launcher' });
  });

  it('signed out is an auth refusal everywhere, first', () => {
    const roster = rosterOver({ signed: { claude: false } })();
    const claude = seat(roster, 'claude');
    expect((claude['work_admission'] as Record<string, unknown>)['scoped_bound']).toMatchObject({ ok: false, reason_code: 'signed_out', source: 'auth' });
    expect(claude['qe_reviewer']).toMatchObject({ ok: false, reason_code: 'signed_out' });
  });

  it('a scope whose governance rule refuses the seat is a scope refusal (copilot rests on the repository boundary)', () => {
    const roster = rosterOver({})();
    const copilot = seat(roster, 'copilot');
    expect((copilot['work_admission'] as Record<string, unknown>)['scoped']).toMatchObject({ ok: false, reason_code: 'scope_ungoverned', source: 'scope' });
    expect((copilot['work_admission'] as Record<string, unknown>)['scoped_bound']).toEqual({ ok: true });
  });

  it("the host's skill routing decides QE too: a Claude-only skills root admits only claude seats", () => {
    const roster = rosterOver({ qeAdmitted: (k) => k.startsWith('claude') })();
    expect(seat(roster, 'claude')['qe_reviewer']).toEqual({ ok: true });
    expect(seat(roster, 'copilot')['qe_reviewer']).toMatchObject({ ok: false, reason_code: 'skill_not_admitted' });
    // work is unaffected: the routing constrains skill-bearing units, not the seat's admission
    expect((seat(roster, 'copilot')['work_admission'] as Record<string, unknown>)['scoped_bound']).toEqual({ ok: true });
    expect(codes(seat(roster, 'copilot'))).toContain('note:no_qe');
  });

  it('an engine without the QE admission predicate: qe_reviewer is absent, work_admission stays', () => {
    const copilot = seat(rosterOver({ qeAdmitted: null })(), 'copilot');
    expect(copilot['qe_reviewer']).toBeUndefined();
    expect(copilot['work_admission']).toBeDefined();
  });

  it('an engine without the predicate: work_admission and qe_reviewer are ABSENT, never guessed', () => {
    const roster = rosterOver({ worktree: null })();
    for (const s of roster as Seat[]) {
      expect(s['work_admission']).toBeUndefined();
      expect(s['qe_reviewer']).toBeUndefined();
      expect(codes(s)).not.toContain('warning:codex_worktree');
    }
  });

  it('every Agents reading is crew-only: none is handed to the engine', () => {
    const engine = toEngineSeat(seat(rosterOver({})(), 'codex')) as Record<string, unknown>;
    for (const f of ['version', 'account', 'recent_bench', 'work_admission', 'qe_reviewer', 'issues']) expect(engine[f]).toBeUndefined();
  });
});

describe("a seat's own refusal vs a later live sign-in (codex r1 on #996)", () => {
  it('the operator signed in after the refusal: the live check wins, the seat reads signed in', async () => {
    const tracker = new SeatHealthTracker();
    tracker.ingest(ev({ type: 'unitDistributed', session: 'r', ord: 1, cli: 'claude' }));
    tracker.ingest(ev({ type: 'stepFailed', session: 'r', ord: 1, detail: 'Not logged in · Please run /login', ts: Date.now() - 5000 }));
    tracker.ingest(ev({ type: 'seatBenched', session: 'r', ord: 1, cli: 'claude', reason: 'not_logged_in', source: 'worker', ts: Date.now() - 5000 }));
    const probe = new SeatProbe({ run: async (_c, args) => ({ code: 0, stdout: args[0] === 'auth' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'OK', stderr: '' }), env: {}, home: HOME });
    const roster = rosterOver({ tracker, probe });
    await roster.ready?.();
    const claude = seat(roster(), 'claude');
    expect(claude['auth']).toBe('signed_in');
    expect(claude['council_eligible']).toBe(true);
    expect(claude['recent_bench']).toBeUndefined();
  });

  it('a refusal AFTER the live check is kept: the seat refused again', async () => {
    const tracker = new SeatHealthTracker();
    const probe = new SeatProbe({ run: async (_c, args) => ({ code: 0, stdout: args[0] === 'auth' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'OK', stderr: '' }), env: {}, home: HOME });
    const roster = rosterOver({ tracker, probe });
    await roster.ready?.();
    tracker.ingest(ev({ type: 'unitDistributed', session: 'r', ord: 1, cli: 'claude' }));
    tracker.ingest(ev({ type: 'stepFailed', session: 'r', ord: 1, detail: 'Not logged in · Please run /login', ts: Date.now() + 1000 }));
    expect(seat(roster(), 'claude')['auth']).toBe('signed_out');
  });
});

describe('A3 recent_bench', () => {
  const benched = (run: string, ts: number, reason = 'quota_exhausted (no success in the run)') =>
    ev({ type: 'seatBenched', session: run, ord: 2, cli: 'copilot', reason, source: 'worker', ts });

  it('the active bench, with the runs it spans; the same run benching twice counts once', () => {
    const tracker = new SeatHealthTracker();
    const t0 = Date.now() - 60_000;
    tracker.ingest(benched('run-a', t0));
    tracker.ingest(benched('run-a', t0 + 1000));
    tracker.ingest(benched('run-b', t0 + 2000));
    const copilot = seat(rosterOver({ tracker })(), 'copilot');
    expect(copilot['recent_bench']).toEqual({
      kind: 'quota_exhausted',
      runs: 2,
      last_at: new Date(t0 + 2000).toISOString(),
      lifts_at: new Date(t0 + 2000 + SEAT_BENCH_WINDOW_MS).toISOString(),
      source: 'worker',
      reason: 'quota_exhausted (no success in the run)',
    });
    expect((copilot['work_admission'] as Record<string, unknown>)['scoped_bound']).toMatchObject({ ok: false, reason_code: 'recent_bench', source: 'launcher' });
    expect(codes(copilot)).toContain('warning:quota');
  });

  it('an ok turn lifts it; history is not "now"', () => {
    const tracker = new SeatHealthTracker();
    tracker.ingest(benched('run-a', Date.now() - 1000));
    tracker.ingest(ev({ type: 'chatReply', cliKey: 'copilot', ok: true }));
    expect(seat(rosterOver({ tracker })(), 'copilot')['recent_bench']).toBeUndefined();
  });

  it('a live sign-in check after an account bench lifts it; one before it, or a non-account bench, does not', () => {
    const at = '2026-10-12T20:00:00.000Z';
    const bench = { at, until: at, reason: 'quota_exhausted (3/3)', source: 'worker', runs: 1 };
    const live = (probedAt: string) => ({ signedIn: true, check: 'live', probedAt });
    expect(liveCheckLiftsBench(bench, live('2026-10-12T20:05:00.000Z'))).toBe(true);
    expect(liveCheckLiftsBench(bench, live('2026-10-12T19:55:00.000Z'))).toBe(false);
    expect(liveCheckLiftsBench(bench, { signedIn: true, check: 'status', probedAt: '2026-10-12T20:05:00.000Z' })).toBe(false);
    expect(liveCheckLiftsBench({ ...bench, reason: 'approval_unavailable' }, live('2026-10-12T20:05:00.000Z'))).toBe(false);
  });

  it('end to end: claude benched not_logged_in, then its live check answers → bench lifted on the next read', async () => {
    const tracker = new SeatHealthTracker();
    tracker.ingest(ev({ type: 'seatBenched', session: 'r', ord: 1, cli: 'claude', reason: 'not_logged_in', source: 'worker', ts: Date.now() - 5000 }));
    const probe = new SeatProbe({ run: async (_c, args) => ({ code: 0, stdout: args[0] === 'auth' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'OK', stderr: '' }), env: {}, home: HOME });
    const roster = rosterOver({ tracker, probe });
    await roster.ready?.();
    expect(seat(roster(), 'claude')['recent_bench']).toBeUndefined();
    expect(tracker.recentBenchFor('claude')).toBeNull();
  });
});

describe('A6 issues', () => {
  it("today's rig, in order: signed-out claude leads with its problem and a $HOME sign-in command", () => {
    const roster = rosterOver({ signed: { claude: false, 'claude-eval': false } })();
    const claude = seat(roster, 'claude');
    const issues = claude['issues'] as Array<{ code: string; commands?: Array<{ purpose: string; display: string }> }>;
    expect(issues[0]!.code).toBe('signed_out');
    expect(issues[0]!.commands).toEqual([{ purpose: 'sign_in', display: 'CLAUDE_CONFIG_DIR="$HOME/.wicked-worker/claude" claude' }]);
    expect(JSON.stringify(roster.map((s) => s['issues']))).not.toContain(HOME);
  });

  it('qe_blocked follows the default launch roster: opt-in seats count only when they are all a launch could convene', () => {
    const registry = [
      { ...REGISTRY[0]!, key: 'claude' },
      { key: 'opencode', display_name: 'opencode', binary: 'opencode', enabled_for_council: true, governance_class: 'acp_input_governance', acp: { acp_input_governance: true } },
      { key: 'opencode#2', display_name: 'opencode', binary: 'opencode', enabled_for_council: true, governance_class: 'acp_input_governance', acp: { acp_input_governance: true } },
    ];
    // claude signed out: the default launch keeps the opencode seats, and they can review.
    const onlyOptIn = rosterOver({ registry, signed: { claude: false } })();
    expect(codes(seat(onlyOptIn, 'claude'))).not.toContain('problem:qe_blocked');
  });

  it('qe_blocked only when NO seat a default launch holds can run QE (opt-in opencode does not count)', () => {
    const allOut = rosterOver({ signed: { claude: false, 'claude-eval': false, copilot: false, opencode: false } })();
    expect(codes(seat(allOut, 'claude'))).toContain('problem:qe_blocked');
    const some = rosterOver({ signed: { claude: false } })();
    expect(codes(seat(some, 'claude'))).not.toContain('problem:qe_blocked');
  });

  it('codex: the worktree bench with sign-out + sign-in commands, and a no_qe note', () => {
    const codex = seat(rosterOver({})(), 'codex');
    // (no probe in this test, so its sign-in reads unconfirmed too)
    expect(codes(codex)).toEqual(['warning:codex_worktree', 'note:no_qe', 'note:unverified']);
    const wt = (codex['issues'] as Array<{ code: string; commands?: Array<{ purpose: string }> }>)[0]!;
    expect(wt.commands!.map((c) => c.purpose)).toEqual(['sign_out', 'sign_in']);
  });

  it('opencode on a build its pin does not prove: version_unproven (a safety warning) before notes, with a version command', () => {
    const versions = new SeatVersionCache(async () => [{ cli: 'opencode', installed: 'opencode v2.0.25', checked_at: '2026-10-12T20:00:00.000Z', install_source: 'brew' }]);
    const roster = rosterOver({ versions, pins: { opencode: { matched: false, observed: 'opencode v2.0.25', pinned: '1.17.18' } } });
    return versions.refresh().then(() => {
      const opencode = seat(roster(), 'opencode');
      expect(opencode['version']).toEqual({ installed: 'opencode v2.0.25', proven: '1.17.18', status: 'unproven', checked_at: '2026-10-12T20:00:00.000Z', install_source: 'brew' });
      expect(codes(opencode)).toEqual(['warning:version_unproven', 'note:opt_in', 'note:unverified']);
    });
  });

  it('copilot on the interim host floor: nothing checks it (the engine refuses its governed work, C5)', () => {
    const s = seat(rosterOver({})(), 'copilot');
    expect(codes(s)).toContain('warning:unchecked');
    expect((s['issues'] as Array<{ code: string; params: Record<string, unknown> }>).find((i) => i.code === 'unchecked')!.params).toEqual({ why: 'no_governance' });
  });

  it('safety sorts before availability within a severity', () => {
    const issues = seatIssues({
      key: 'copilot',
      display_name: 'GitHub Copilot CLI',
      binary: 'copilot',
      optIn: false,
      standing: { auth: 'signed_in', login_check: 'unverified', council_eligible: true, work_eligible: true },
      governance: {
        unscoped: { mode: 'none', class: 'os_sandbox', source: 'none', reason: '', fence: { write_roots: [], read_roots: [], network: 'open' } },
        scoped: { mode: 'none', class: 'os_sandbox', source: 'none', reason: '', fence: { write_roots: [], read_roots: [], network: 'open' } },
        scoped_bound: { mode: 'os_sandbox', class: 'os_sandbox', source: 'repo_boundary', reason: '', fence: { write_roots: [], read_roots: [], network: 'open' } },
      },
      hostBoundary: 'sandbox-exec',
      recentBench: { kind: 'quota_exhausted', runs: 3, last_at: 'x', lifts_at: 'y', source: 'worker', reason: 'quota_exhausted' },
      rosterQe: true,
    });
    expect(issues.map((i) => i.code)).toEqual(['fence_scoped', 'quota', 'unverified']);
  });

  it('displayCommand writes the home as $HOME, whole segments only', () => {
    expect(displayCommand('X="/home/fabricated/.w/c" c', HOME)).toBe('X="$HOME/.w/c" c');
    expect(displayCommand('X="/home/fabricatedother/c" c', HOME)).toBe('X="/home/fabricatedother/c" c');
  });
});

describe('A1 version for every seat', () => {
  it('probes each seat with its version_probe, first non-empty line, home-free; install source from the resolved path', async () => {
    const readings = await probeSeatVersions(
      [
        { key: 'claude', binary: 'claude', version_probe: ['claude', '--version'] },
        { key: 'pi', binary: 'pi' },
        { key: 'gone', binary: 'gone' },
      ],
      async (cmd) => (cmd === 'claude' ? '\n2.1.287 (Claude Code)\n' : cmd === 'pi' ? `pi 0.9.1 at ${homedir()}/x\n` : null),
      (b) => (b === 'claude' ? '/opt/homebrew/Caskroom/claude-code/2.1.287/claude' : b === 'pi' ? '/usr/lib/node_modules/pi/bin/pi' : null),
      () => Date.parse('2026-10-12T20:00:00.000Z'),
    );
    expect(readings).toEqual([
      { cli: 'claude', installed: '2.1.287 (Claude Code)', checked_at: '2026-10-12T20:00:00.000Z', install_source: 'brew' },
      { cli: 'pi', installed: 'pi 0.9.1 at ~/x', checked_at: '2026-10-12T20:00:00.000Z', install_source: 'npm' },
      { cli: 'gone', installed: null, checked_at: '2026-10-12T20:00:00.000Z', install_source: null },
    ]);
  });

  it('install source and status rules', () => {
    expect(installSourceOf('/usr/local/bin/codex')).toBe('other');
    expect(installSourceOf('/home/linuxbrew/.linuxbrew/bin/x')).toBe('brew');
    expect(firstVersionLine('   \n')).toBeNull();
    const r = { cli: 'x', installed: '1', checked_at: 't', install_source: null };
    expect(seatVersion({}, r, undefined)).toMatchObject({ status: 'no_pin', proven: null });
    expect(seatVersion({ acp: { verified_version: '1' } }, r, undefined)).toBeUndefined();
    expect(seatVersion({ acp: { verified_version: '1' } }, r, { matched: true } as never)).toMatchObject({ status: 'proven', proven: '1' });
    expect(seatVersion({}, undefined, undefined)).toBeUndefined();
  });

  it('every unpinned seat carries a version once the reading is in', async () => {
    const versions = new SeatVersionCache(async () => REGISTRY.map((s) => ({ cli: s.key, installed: `${s.key} 1.0`, checked_at: 't', install_source: 'other' as const })));
    await versions.refresh();
    const roster = rosterOver({ versions })();
    expect(seat(roster, 'claude')['version']).toMatchObject({ installed: 'claude 1.0', status: 'no_pin' });
    // pinned, pin not yet probed: no guessed status
    expect(seat(roster, 'opencode')['version']).toBeUndefined();
  });
});

describe('SeatVersionCache — a version probe that did not answer (a slow start under load)', () => {
  const T0 = Date.parse('2026-10-14T16:00:00.000Z');
  function cache(answers: () => Array<{ cli: string; installed: string | null; install_source: 'brew' | null }>, clock: { now: number }) {
    let probes = 0;
    const versions = new SeatVersionCache(
      async () => {
        probes += 1;
        return answers().map((a) => ({ ...a, checked_at: new Date(clock.now).toISOString() }));
      },
      SEAT_VERSION_TTL_MS,
      () => clock.now,
    );
    return { versions, probes: () => probes };
  }

  it("keeps an installed seat's last answered version, retries in 2 minutes, and never serves it past the keep window", async () => {
    const clock = { now: T0 };
    let installed: string | null = '2.1.287 (Claude Code)';
    const { versions, probes } = cache(() => [{ cli: 'claude', installed, install_source: 'brew' }], clock);
    await versions.refresh();
    expect(versions.read('claude')?.installed).toBe('2.1.287 (Claude Code)');
    installed = null; // the next `claude --version` times out; the binary is still on PATH
    clock.now += SEAT_VERSION_TTL_MS;
    await versions.refresh();
    expect(versions.read('claude')?.installed).toBe('2.1.287 (Claude Code)');
    // Retried sooner than the full TTL while an installed seat did not answer.
    const n = probes();
    clock.now += SEAT_VERSION_RETRY_MS - 1;
    versions.read('claude');
    expect(probes()).toBe(n);
    clock.now += 1;
    versions.read('claude');
    await versions.refresh();
    expect(probes()).toBeGreaterThan(n);
    // Past the keep window the kept answer is not served, even before a refresh lands.
    clock.now = T0 + SEAT_VERSION_KEEP_MS;
    expect(versions.read('claude')?.installed).toBeNull();
  });

  it('a real answer replaces a kept one at once, and the normal TTL is back', async () => {
    const clock = { now: T0 };
    let installed: string | null = '2.1.287 (Claude Code)';
    const { versions, probes } = cache(() => [{ cli: 'claude', installed, install_source: 'brew' }], clock);
    await versions.refresh();
    installed = null;
    clock.now += SEAT_VERSION_TTL_MS;
    await versions.refresh();
    installed = '2.1.300 (Claude Code)';
    clock.now += SEAT_VERSION_RETRY_MS;
    await versions.refresh();
    expect(versions.read('claude')?.installed).toBe('2.1.300 (Claude Code)');
    const n = probes();
    clock.now += SEAT_VERSION_TTL_MS - 1;
    versions.read('claude');
    expect(probes()).toBe(n);
  });

  it('a binary no longer on PATH is news: no kept version, and no fast retry of the whole roster', async () => {
    const clock = { now: T0 };
    let gone = false;
    const { versions, probes } = cache(() => [
      { cli: 'claude', installed: '2.1.287 (Claude Code)', install_source: 'brew' },
      gone ? { cli: 'agy', installed: null, install_source: null } : { cli: 'agy', installed: 'agy 1.0', install_source: 'brew' },
    ], clock);
    await versions.refresh();
    gone = true;
    clock.now += SEAT_VERSION_TTL_MS;
    await versions.refresh();
    expect(versions.read('agy')).toMatchObject({ installed: null, install_source: null });
    const n = probes();
    clock.now += SEAT_VERSION_RETRY_MS;
    versions.read('claude');
    expect(probes()).toBe(n);
  });
});
