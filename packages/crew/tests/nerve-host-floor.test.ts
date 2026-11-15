// crew#1564: Nerve Center counts a seat able to work by the predicate the chat refuses on — signed in AND the
// engine gives it work on this floor (a host-floor bench is not work).

import { describe, expect, it } from 'vitest';

import { buildNeeds } from '../src/api/needs.js';
import { HOST_FLOOR_BENCH_COPY } from '../src/api/seat-standing.js';
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
