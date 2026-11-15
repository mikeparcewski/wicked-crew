// crew#1564: Nerve Center counts a seat able to work by the predicate the chat refuses on — signed in AND the
// engine gives it work on this floor (a host-floor bench is not work).

import { describe, expect, it } from 'vitest';

import { buildNeeds } from '../src/api/needs.js';
import { HOST_FLOOR_BENCH_COPY, HOST_FLOOR_UNKNOWN_COPY } from '../src/api/seat-standing.js';
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
