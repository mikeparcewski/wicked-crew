// crew#1564: Nerve Center counts a seat able to work by the predicate the chat refuses on — signed in AND the
// engine gives it work on this floor (a host-floor bench is not work).

import { describe, expect, it } from 'vitest';
import type { SessionView, SystemRun } from 'wicked-crew-api-types';

import { buildNeeds } from '../src/api/needs.js';
import { HOST_FLOOR_BENCH_COPY, HOST_FLOOR_POLICY_COPY, HOST_FLOOR_SYSTEM_POLICY_COPY, HOST_FLOOR_UNKNOWN_COPY } from '../src/api/seat-standing.js';
import { buildClis, judgeGaps, type RosterSeatLike } from '../src/api/system-snapshot.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const BENCH = { host_floor_bench: HOST_FLOOR_BENCH_COPY };

const out = (key: string, extra: Partial<RosterSeatLike> = {}): RosterSeatLike =>
  ({ key, auth: 'signed_out', signed_in: false, work_eligible: false, council_eligible: false, sign_in: 'container', ...extra }) as RosterSeatLike;
const signedIn = (key: string, extra: Partial<RosterSeatLike> = {}): RosterSeatLike =>
  ({ key, auth: 'signed_in', signed_in: true, work_eligible: true, council_eligible: true, sign_in: 'container', ...extra }) as RosterSeatLike;
// The real roster for a seat whose sign-in check has not answered: `auth: unknown`, work_eligible not false.
const unanswered = (key: string, extra: Partial<RosterSeatLike> = {}): RosterSeatLike =>
  ({ key, auth: 'unknown', signed_in: null, work_eligible: true, council_eligible: true, ...extra }) as RosterSeatLike;

const attention = (roster: RosterSeatLike[]) => {
  const clis = buildClis({ roster, acp: {}, seatGovernance: [], containerFloor: false, hostBoundary: null, week: null });
  return buildNeeds({ now: NOW, views: [], runs: [], infra: [], clis, gaps: judgeGaps([], clis), infraHoldsLive: () => false }).attention;
};

describe('crew#1564: which seats can take work, on the host floor', () => {
  it('only opencode signed in (host-benched), the rest signed out or unanswered: cli:none, no second-agent item', () => {
    const a = attention([
      signedIn('opencode', BENCH),
      out('claude'),
      out('codex'),
      unanswered('pi', BENCH),
    ]);
    expect(a.map((i) => i.id)).toEqual(['cli:none']);
    expect(a[0]!.title).toBe('No helper can take work');
    expect(a[0]!.reason).toContain('on this computer only Claude Code and Codex get work');
  });

  it('claude signed in alone on the host floor keeps the second-agent item', () => {
    const a = attention([signedIn('claude'), out('codex'), out('opencode', BENCH), out('pi', BENCH)]);
    expect(a.map((i) => i.id)).toEqual(['cli:one-reviewer']);
  });

  it('claude and codex signed in: neither item', () => {
    const a = attention([signedIn('claude'), signedIn('codex'), signedIn('opencode', BENCH)]);
    expect(a.map((i) => i.id)).toEqual([]);
  });
});

describe('crew#1564 review: the real reason, the target and the second-agent count', () => {
  const UNKNOWN = { host_floor_unknown: HOST_FLOOR_UNKNOWN_COPY };
  const clisOf = (roster: RosterSeatLike[]) => buildClis({ roster, acp: {}, seatGovernance: [], containerFloor: false, hostBoundary: null, week: null });

  it('carries the bench reason for a bench and its own sentence for an unread bench; both stay out of work', () => {
    const [bench, unread] = clisOf([signedIn('opencode', BENCH), signedIn('pi', UNKNOWN)]);
    expect(bench).toMatchObject({ state: 'signed_in', stateReason: HOST_FLOOR_BENCH_COPY, workEligible: false });
    expect(unread).toMatchObject({ state: 'signed_in', stateReason: HOST_FLOOR_UNKNOWN_COPY, workEligible: false });
    expect(HOST_FLOOR_UNKNOWN_COPY).not.toBe(HOST_FLOOR_BENCH_COPY);
  });

  it('a benched seat with unknown or signed-out auth reads the bench reason, not "sign-in not confirmed"', () => {
    const [unk, outSeat] = clisOf([unanswered('pi', BENCH), out('opencode', BENCH)]);
    expect(unk).toMatchObject({ state: 'unknown', stateReason: HOST_FLOOR_BENCH_COPY });
    expect(outSeat).toMatchObject({ state: 'signed_out', stateReason: HOST_FLOOR_BENCH_COPY });
  });

  it.each([false, true])('a signed-out seat with an active recent bench stays signed_out without benchedUntil (host-floor bench: %s)', (hostFloorBench) => {
    const [cli] = clisOf([out('copilot', {
      ...(hostFloorBench ? BENCH : {}),
      council_ineligible_reason: 'signed out: no credential',
      recent_bench: { kind: 'not_logged_in', reason: 'not signed in', lifts_at: '2099-11-15T14:00:00Z', last_at: '2026-11-15T11:00:00Z', runs: 1, source: 'engine' },
    })]);
    expect(cli).toMatchObject({ state: 'signed_out', stateReason: hostFloorBench ? HOST_FLOOR_BENCH_COPY : 'signed out: no credential' });
    expect(cli).not.toHaveProperty('benchedUntil');
  });

  it('noneReason names the bench only for a host-benched seat, and an unread bench as unknown', () => {
    const benched = attention([signedIn('opencode', BENCH), out('codex')]);
    expect(benched[0]!.reason).toContain('on this computer only Claude Code and Codex get work');
    const unread = attention([signedIn('opencode', UNKNOWN), signedIn('pi', UNKNOWN)]);
    expect(unread[0]!.id).toBe('cli:none');
    expect(unread[0]!.reason).toContain('opencode work eligibility unknown');
    expect(unread[0]!.reason).toContain('could not read which agents get work');
    expect(unread[0]!.reason).not.toContain('only Claude Code and Codex');
    const plain = attention([out('claude'), out('codex')]);
    expect(plain[0]!.reason).not.toContain('only Claude Code and Codex');
  });

  it('cli:none targets a signed-out seat that could work after sign-in, never the signed-in benched one', () => {
    const a = attention([signedIn('opencode', BENCH), out('claude'), out('codex')]);
    expect(a[0]).toMatchObject({ id: 'cli:none', target: { kind: 'cli', cli: 'claude' }, action: { kind: 'sign_in', label: 'Sign in' } });
  });

  it('cli:none offers no sign-in when the only signed-out seats are host-benched', () => {
    const a = attention([signedIn('opencode', BENCH), out('pi', BENCH)]);
    expect(a[0]).toMatchObject({ id: 'cli:none', action: null });
  });

  it('claude + opencode (host-benched) signed in, codex signed out: the second-agent item stays', () => {
    const a = attention([signedIn('claude'), signedIn('opencode', { ...BENCH, council_eligible: false }), out('codex')]);
    expect(a.map((i) => i.id)).toEqual(['cli:one-reviewer']);
    expect(a[0]!.target).toMatchObject({ cli: 'codex' });
  });
});

describe('crew#1564 review r1: the second-agent sign-in never points at a host-benched seat', () => {
  it('claude signed in, opencode signed in (benched), pi signed out (benched), codex signed out: Sign in targets codex', () => {
    const a = attention([
      signedIn('claude'),
      signedIn('opencode', { ...BENCH, council_eligible: false }),
      out('pi', BENCH),
      out('codex'),
    ]);
    expect(a.map((i) => i.id)).toEqual(['cli:one-reviewer']);
    expect(a[0]).toMatchObject({ target: { kind: 'cli', cli: 'codex' }, action: { kind: 'sign_in', label: 'Sign in' } });
  });

  it('when the only signed-out seats are host-benched, the second-agent item offers no sign-in', () => {
    const a = attention([signedIn('claude'), out('pi', BENCH), out('opencode', BENCH)]);
    expect(a.map((i) => i.id)).toEqual(['cli:one-reviewer']);
    expect(a[0]!.action).toBeNull();
  });
});

const UNKNOWN_BENCH = { host_floor_unknown: HOST_FLOOR_UNKNOWN_COPY };

describe('crew#1564 review r2: the words of the none and one-reviewer items', () => {
  it('a host-benched seat whose sign-in is unknown reads "not taking work", never "sign-in not confirmed"', () => {
    const a = attention([signedIn('opencode', BENCH), unanswered('pi', BENCH), out('claude')]);
    expect(a[0]!.id).toBe('cli:none');
    expect(a[0]!.reason).toContain('pi not taking work');
    expect(a[0]!.reason).not.toContain('pi sign-in not confirmed');
  });

  it('an unread bench on a signed-in seat names the unknown case in the none item, with no host-bench sentence', () => {
    const a = attention([signedIn('opencode', UNKNOWN_BENCH), out('claude')]);
    expect(a[0]!.reason).toContain('opencode work eligibility unknown');
    expect(a[0]!.reason).not.toContain('only Claude Code and Codex');
  });

  it('with no seat to sign in, the second-agent remedy does not say "Sign in"', () => {
    const a = attention([signedIn('claude'), out('pi', BENCH)]);
    expect(a[0]).toMatchObject({ id: 'cli:one-reviewer', action: null });
    expect(a[0]!.remedy).toBe('Set up another helper on the Helpers page.');
    const b = attention([signedIn('claude'), out('codex')]);
    expect(b[0]!.remedy).toBe('Sign in another helper on the Helpers page.');
  });
});

describe('crew#1564 review r3: host-floor reasons survive the shortcuts; a benched seat counts only if it can work', () => {
  it('a roster whose only seats are host_floor_unknown gives the unknown sentence', () => {
    const a = attention([unanswered('opencode', UNKNOWN_BENCH), unanswered('pi', UNKNOWN_BENCH)].map((s) => ({ ...s, work_eligible: false })));
    expect(a[0]!.id).toBe('cli:none');
    expect(a[0]!.reason).toContain('opencode work eligibility unknown');
    expect(a[0]!.reason).toContain('could not read which agents get work');
    expect(a[0]!.reason).not.toContain('sign-in can be confirmed');
  });

  it('signed-out seats with a host-benched one name the host-floor reason, not "every helper"', () => {
    const a = attention([out('claude'), out('opencode', BENCH)]);
    expect(a[0]!.id).toBe('cli:none');
    expect(a[0]!.reason).toContain('opencode not taking work');
    expect(a[0]!.reason).toContain('on this computer only Claude Code and Codex get work');
    expect(a[0]!.reason).not.toMatch(/^Every helper/);
  });

  it('claude signed in, opencode host-benched AND quota-benched, codex signed out: the second-agent item', () => {
    const quota = { kind: 'quota_exhausted', reason: 'usage limit', lifts_at: '2026-11-15T14:00:00Z', last_at: '2026-11-15T11:00:00Z', runs: 1, source: 'engine' };
    const a = attention([
      signedIn('claude'),
      signedIn('opencode', { ...BENCH, work_eligible: false, council_eligible: false, recent_bench: quota }),
      out('codex'),
    ]);
    expect(a.map((i) => i.id)).toEqual(['cli:one-reviewer']);
  });
});

describe('crew#1564 review r7: a quota-benched seat still counts toward a second agent', () => {
  const quota = { kind: 'quota_exhausted', reason: 'usage limit', lifts_at: '2026-11-15T14:00:00Z', last_at: '2026-11-15T11:00:00Z', runs: 1, source: 'engine' };

  // The roster marks a temporarily benched seat work-ineligible; a host-floor bench is the durable kind. council_eligible
  // is off so the distinct-judge shortcut cannot hide the count.
  it.each([false, true])('claude signed in, codex quota-benched (work_eligible %s), nothing else: no second-agent item', (workEligible) => {
    const a = attention([
      signedIn('claude'),
      signedIn('codex', { recent_bench: quota, work_eligible: workEligible, council_eligible: false }),
    ]);
    expect(a.map((i) => i.id)).not.toContain('cli:one-reviewer');
  });

  it('the same roster with codex host-benched instead does give the second-agent item', () => {
    const a = attention([signedIn('claude'), signedIn('codex', { ...BENCH, council_eligible: false })]);
    expect(a.map((i) => i.id)).toEqual(['cli:one-reviewer']);
  });
});

// crew#1818: wicked-core `managed_hooks_only_refusal_reason` (src/execute_wrapped.rs), both remedies as the engine words them.
const POLICY = (remedy: string) =>
  `claude can't be governed on the wrapped path on this machine: settings in /etc/claude-code/managed-settings.json silence the engine's gate hook (\`allowManagedHooksOnly: true\` or \`disableAllHooks: true\`); refusing the governed unit rather than running it ungoverned. ${remedy} (core#653, C5)`;
const SIGN_IN = POLICY("It is organization policy that came with the seat's sign-in: run governed work on the container floor (WICKED_SEAT_FLOOR=container), whose claude seat does not carry it, or route it to another seat");
const SYSTEM = POLICY("It is this machine's system policy for Claude Code: route governed work to another seat, or ask whoever manages this machine to change it");

describe('crew#1818: a policy-silenced claude on the host floor', () => {
  const clisOf = (roster: RosterSeatLike[]) => buildClis({ roster, acp: {}, seatGovernance: [], containerFloor: false, hostBoundary: null, week: null });

  it('reads its own reason, by where the policy lives, never the generic host-floor sentence', () => {
    const [signIn, system] = clisOf([signedIn('claude', { host_floor_bench: SIGN_IN }), signedIn('claude', { host_floor_bench: SYSTEM })]);
    expect(signIn).toMatchObject({ state: 'signed_in', stateReason: HOST_FLOOR_POLICY_COPY, workEligible: false });
    expect(system).toMatchObject({ state: 'signed_in', stateReason: HOST_FLOOR_SYSTEM_POLICY_COPY, workEligible: false });
    expect(HOST_FLOOR_POLICY_COPY).toContain('WICKED_SEAT_FLOOR=container');
    // A system policy binds claude in a container too: no container remedy.
    expect(HOST_FLOOR_SYSTEM_POLICY_COPY).not.toContain('WICKED_SEAT_FLOOR=container');
  });

  it('the needs list counts it as not taking work and says why, not "only Claude Code and Codex get work"', () => {
    const a = attention([signedIn('claude', { host_floor_bench: SIGN_IN }), out('codex')]);
    expect(a[0]).toMatchObject({ id: 'cli:none', target: { kind: 'cli', cli: 'codex' } });
    expect(a[0]!.reason).toContain('claude not taking work');
    expect(a[0]!.reason).toContain(HOST_FLOOR_POLICY_COPY);
    expect(a[0]!.reason).not.toContain('only Claude Code and Codex');
    // A signed-out policy-silenced claude is no sign-in target: signing in does not lift the policy.
    const b = attention([out('claude', { host_floor_bench: SIGN_IN }), signedIn('opencode', BENCH)]);
    expect(b[0]).toMatchObject({ id: 'cli:none', action: null });
  });

  it('a mixed roster never says claude gets work beside its policy, and offers no remedy that cannot lift it (xreview r1)', () => {
    for (const reason of [SIGN_IN, SYSTEM]) {
      const a = attention([signedIn('claude', { host_floor_bench: reason }), out('codex'), signedIn('opencode', BENCH)]);
      expect(a[0]!.id).toBe('cli:none');
      expect(a[0]!.reason).not.toContain('only Claude Code and Codex');
      expect(a[0]!.reason).toContain('on this computer only Codex gets work');
      // codex can be signed in: the sign-in remedy stands.
      expect(a[0]!.remedy).toBe('Sign a CLI in, or wait for a bench to lift.');
    }
    const alone = attention([signedIn('claude', { host_floor_bench: SYSTEM })]);
    expect(alone[0]).toMatchObject({ id: 'cli:none', action: null });
    expect(alone[0]!.remedy).not.toMatch(/Sign a CLI in|wait for a bench/);
  });

  it('a job whose next step is on a signed-out, policy-benched claude says the policy and offers reassignment, not sign-in (xreview r1)', () => {
    const clis = clisOf([out('claude', { host_floor_bench: SYSTEM }), signedIn('codex'), signedIn('pi')]);
    const view = {
      session: { id: 'j', title: 'job j', problem: 'job j', status: 'executing', workflow_id: 'feature', repo_ref: 'repo-a', clis: ['claude', 'codex'], archived_at: null, created_at: Math.floor((NOW - 3_600_000) / 1000), delivery: 'none' },
      units: [
        { id: 'j:u1', session_id: 'j', ord: 1, status: 'done', assigned_cli: 'codex', phase_ref: null, stage: 'build' },
        { id: 'j:u2', session_id: 'j', ord: 2, status: 'pending', assigned_cli: 'claude', phase_ref: null, stage: 'review' },
      ],
    } as unknown as SessionView;
    const run = { runId: 'j', title: 'job j', status: 'executing', liveness: 'working', reason: '', phase: null, unitOrd: 2, seat: 'claude', lastEventAt: null, evidence: 'relay', quietForMs: 0, quietAfterMs: 300_000, stallAfterMs: 900_000 } as SystemRun;
    const items = buildNeeds({ now: NOW, views: [view], runs: [run], infra: [], clis, gaps: judgeGaps([{ view, run }], clis), infraHoldsLive: () => false }).attention;
    const item = items.find((i) => i.id === 'cli:out:claude')!;
    expect(item).toMatchObject({ title: 'claude gets no work here', remedy: 'Reassign the step to another agent.', action: null });
    expect(item.reason).toContain(HOST_FLOOR_SYSTEM_POLICY_COPY);
  });
});
