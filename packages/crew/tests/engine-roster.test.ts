// Wave 6 — the roster crew hands the ENGINE vs the roster crew serves the STUDIO (the crew half of
// F-7R2-006). `GET /roster` decorates seats with crew's own readings (`health {status}`, `auth`,
// `council_eligible`, …) and the studio round-trips them into `clisJson`; the wave-6 engine grew
// `AgenticCli.health {usable, reason}` under the SAME key. The boundary strips crew's readings and
// turns `council_eligible` into the engine's bench verdict.
import { describe, expect, it } from 'vitest';

import { seatStanding } from '../src/api/seat-standing.js';
import type { SeatRecentBench } from '../src/api/seat-health.js';
import { CREW_ONLY_SEAT_FIELDS, eligibleSeatKeys, engineRosterJson, toEngineRoster, toEngineSeat } from '../src/core/engine-roster.js';

const registrySeat = {
  key: 'codex',
  display_name: 'Codex',
  binary: 'codex',
  enabled_for_council: true,
  headless_invocation: 'codex {PROMPT}',
  login_invocation: 'codex login',
};

describe('toEngineSeat', () => {
  it('strips every crew-only reading and keeps the registry fields verbatim (login_invocation included)', () => {
    const decorated = {
      ...registrySeat,
      health: { status: 'inactive', message: 'boom', since: '2026-09-11T00:00:00Z' },
      signed_in: false,
      auth: 'signed_out',
      free_tier: undefined,
      council_bench: { failures: 2 },
    };
    const out = toEngineSeat(decorated) as Record<string, unknown>;
    for (const k of CREW_ONLY_SEAT_FIELDS) if (k !== 'health') expect(k in out, `${k} must not reach the engine`).toBe(false);
    expect(out['login_invocation']).toBe('codex login');
    expect(out['headless_invocation']).toBe('codex {PROMPT}');
    // crew's {status} health is NOT the engine's {usable} health — dropped, not passed through.
    expect(out['health']).toBeUndefined();
  });

  it('council_eligible:false becomes the engine bench verdict WITH a SHORT reason (the engine renders it inline); true becomes usable', () => {
    // The engine renders `"codex (<reason> — launcher)"` in degradedReason, so the reason is the cause
    // in a few words, derived from the standing readings, not the operator-facing sentence.
    const signedOut = toEngineSeat({ ...registrySeat, auth: 'signed_out', council_eligible: false, council_ineligible_reason: 'signed out — a council would bench this seat on its first ballot; sign it in from the Agents page' }) as Record<string, unknown>;
    expect(signedOut['health']).toEqual({ usable: false, reason: 'signed out' });
    const inactive = toEngineSeat({ ...registrySeat, health: { status: 'inactive', since: 't' }, council_eligible: false, council_ineligible_reason: 'inactive after a seat-level error: boom' }) as Record<string, unknown>;
    // (R5) No `inactive` arm any more — a stale client's sentence falls back to its first clause.
    expect(inactive['health']).toEqual({ usable: false, reason: 'inactive after a seat-level error: boom' });
    const benchedByCouncils = toEngineSeat({ ...registrySeat, council_eligible: false, council_bench: { failures: 2, last_kind: 'timed_out', last_at: 't', window_ms: 60_000 }, council_ineligible_reason: 'benched by this daemon’s recent councils: …' }) as Record<string, unknown>;
    // (R5b) No `council_bench` arm any more — the sentence's first clause, the field itself stripped.
    expect(benchedByCouncils['health']).toEqual({ usable: false, reason: 'benched by this daemon’s recent councils: …' });
    expect('council_bench' in benchedByCouncils).toBe(false);
    // crew#916: only a seat with NEITHER role is benched for not being enabled.
    const disabled = toEngineSeat({ ...registrySeat, enabled_for_council: false, seat_eligible_for_work: false, council_eligible: false, council_ineligible_reason: 'not enabled for council', work_eligible: false, work_ineligible_reason: 'not eligible for work (a reviewer-only seat)' }) as Record<string, unknown>;
    expect(disabled['health']).toEqual({ usable: false, reason: 'not enabled for council or work' });
    // An unknown cause falls back to the first clause of the operator sentence.
    const other = toEngineSeat({ ...registrySeat, council_eligible: false, council_ineligible_reason: 'dispatch budget exhausted — retry later' }) as Record<string, unknown>;
    expect(other['health']).toEqual({ usable: false, reason: 'dispatch budget exhausted' });
    const benched = toEngineSeat({ ...registrySeat, council_eligible: false }) as Record<string, unknown>;
    expect(benched['health']).toEqual({ usable: false });
    const usable = toEngineSeat({ ...registrySeat, council_eligible: true }) as Record<string, unknown>;
    expect(usable['health']).toEqual({ usable: true });
    // Unknown standing (a plain registry seat) stamps nothing — the engine treats it as eligible
    // until it fails authentication in the run.
    expect((toEngineSeat(registrySeat) as Record<string, unknown>)['health']).toBeUndefined();
  });

  it('an ENGINE-shaped health a caller already stamped is kept as sent', () => {
    const out = toEngineSeat({ ...registrySeat, health: { usable: false, reason: 'from the caller' } }) as Record<string, unknown>;
    expect(out['health']).toEqual({ usable: false, reason: 'from the caller' });
  });

  it('non-object entries pass through so the engine reports its own parse error', () => {
    expect(toEngineSeat('garbage')).toBe('garbage');
    expect(toEngineSeat(null)).toBeNull();
  });
});

describe('engineRosterJson', () => {
  it('translates a whole roster and returns unparseable / non-array input unchanged', () => {
    const json = JSON.stringify([{ ...registrySeat, council_eligible: false, council_ineligible_reason: 'signed out' }, { ...registrySeat, key: 'claude', council_eligible: true }]);
    const out = JSON.parse(engineRosterJson(json)) as Array<Record<string, unknown>>;
    expect(out[0]!['health']).toEqual({ usable: false, reason: 'signed out' });
    expect(out[1]!['health']).toEqual({ usable: true });
    expect('council_eligible' in out[0]!).toBe(false);
    expect(engineRosterJson('{not json')).toBe('{not json');
    expect(engineRosterJson('{"a":1}')).toBe('{"a":1}');
  });
});

describe('eligibleSeatKeys', () => {
  it('names the seats the engine would convene: not benched, with at least one role', () => {
    const roster = [
      { ...registrySeat, key: 'claude', council_eligible: true },
      { ...registrySeat, key: 'codex', council_eligible: false, council_ineligible_reason: 'signed out' },
      { ...registrySeat, key: 'pi' },
      { ...registrySeat, key: 'ollama', enabled_for_council: false, seat_eligible_for_work: false },
    ];
    expect(eligibleSeatKeys(roster)).toEqual(['claude', 'pi']);
    expect(toEngineRoster(roster)).toHaveLength(4);
  });
});

describe('council vs work eligibility (crew#916, wicked-core#572)', () => {
  it('a work-only seat (enabled_for_council=false, seat_eligible_for_work=true) is convened and NOT benched', () => {
    const workOnly = {
      ...registrySeat,
      key: 'worker',
      enabled_for_council: false,
      seat_eligible_for_work: true,
      auth: 'signed_in',
      council_eligible: false,
      council_ineligible_reason: 'not enabled for council',
      work_eligible: true,
    };
    expect(eligibleSeatKeys([workOnly])).toEqual(['worker']);
    const [out] = toEngineRoster([workOnly]) as Array<Record<string, unknown>>;
    expect((out!['health'] as { usable: boolean }).usable).not.toBe(false);
    expect(out!['enabled_for_council']).toBe(false);
    expect(out!['seat_eligible_for_work']).toBe(true);
    expect('work_eligible' in out!).toBe(false);
    // A plain registry seat with only the ballot flag off is a work seat too.
    expect(eligibleSeatKeys([{ ...registrySeat, key: 'raw', enabled_for_council: false }])).toEqual(['raw']);
  });

  it('a seat with both roles off is benched (health.usable:false) and dropped — the built-in agy', () => {
    const agy = {
      ...registrySeat,
      key: 'agy',
      enabled_for_council: false,
      seat_eligible_for_work: false,
      auth: 'signed_in',
      council_eligible: false,
      council_ineligible_reason: 'not enabled for council',
      work_eligible: false,
      work_ineligible_reason: 'not enabled for council or work',
    };
    expect(eligibleSeatKeys([agy])).toEqual([]);
    expect((toEngineSeat(agy) as Record<string, unknown>)['health']).toEqual({ usable: false, reason: 'not enabled for council or work' });
    expect(eligibleSeatKeys([{ ...registrySeat, key: 'agy', enabled_for_council: false, seat_eligible_for_work: false }])).toEqual([]);
  });

  it('a reviewer-only seat (enabled_for_council=true, seat_eligible_for_work=false) stays usable for its ballot', () => {
    const judge = { ...registrySeat, key: 'judge', seat_eligible_for_work: false, council_eligible: true, work_eligible: false, work_ineligible_reason: 'not eligible for work (a reviewer-only seat)' };
    expect(eligibleSeatKeys([judge])).toEqual(['judge']);
    const out = toEngineSeat(judge) as Record<string, unknown>;
    expect(out['health']).toEqual({ usable: true });
    expect(out['seat_eligible_for_work']).toBe(false);
  });

  it('a benched work-only seat is benched with the gate reason, not the ballot flag', () => {
    const out = toEngineSeat({
      ...registrySeat,
      enabled_for_council: false,
      council_eligible: false,
      council_ineligible_reason: 'recent quota_exhausted — the engine benched it',
      work_eligible: false,
      work_ineligible_reason: 'recent quota_exhausted — the engine benched it',
    }) as Record<string, unknown>;
    expect(out['health']).toEqual({ usable: false, reason: 'recent quota_exhausted' });
  });
});

describe('gate precedence over role flags (crew#1087)', () => {
  const BENCH: SeatRecentBench = {
    at: '2026-10-28T00:00:00.000Z',
    until: '2026-10-28T01:00:00.000Z',
    untilSource: 'window',
    strikes: 1,
    reason: 'quota_exhausted (no success in the run)',
    source: 'worker',
    runs: 1,
  };

  const ROLES = {
    'no role': { enabled_for_council: false, seat_eligible_for_work: false },
    'reviewer-only': { enabled_for_council: true, seat_eligible_for_work: false },
  };
  const standingSeat = (roles: Record<string, boolean>, gate: 'signed_out' | 'recent_bench' | 'login_pending' | 'none') => {
    const base = { ...registrySeat, ...roles };
    const st = seatStanding(
      base,
      gate !== 'signed_out',
      null,
      gate === 'login_pending' ? 'pending' : undefined,
      gate === 'recent_bench' ? BENCH : null,
    );
    return { ...base, auth: st.auth, council_eligible: st.council_eligible, council_ineligible_reason: st.council_ineligible_reason, work_eligible: st.work_eligible, work_ineligible_reason: st.work_ineligible_reason };
  };
  const health = (s: Record<string, unknown>) => (toEngineSeat(s) as Record<string, unknown>)['health'];
  const firstClause = (s: Record<string, unknown>) => (s['council_ineligible_reason'] as string).split(/\s+—\s+|;\s+/, 1)[0]!.trim().slice(0, 80);

  for (const [name, roles] of Object.entries(ROLES)) {
    it(`${name}: signed out names the gate`, () => {
      expect(health(standingSeat(roles, 'signed_out'))).toEqual({ usable: false, reason: 'signed out' });
    });
    it(`${name}: a recent engine bench names the bench`, () => {
      const s = standingSeat(roles, 'recent_bench');
      expect(firstClause(s)).toContain('quota_exhausted');
      expect(health(s)).toEqual({ usable: false, reason: firstClause(s) });
    });
    it(`${name}: a login check still pending names the gate`, () => {
      const s = standingSeat(roles, 'login_pending');
      expect(health(s)).toEqual({ usable: false, reason: firstClause(s) });
      expect(firstClause(s)).not.toMatch(/^not (enabled|eligible)/);
    });
  }
  it('no gate: a no-role seat keeps the combined role reason, a reviewer-only seat stays usable', () => {
    expect(health(standingSeat(ROLES['no role'], 'none'))).toEqual({ usable: false, reason: 'not enabled for council or work' });
    expect(health(standingSeat(ROLES['reviewer-only'], 'none'))).toEqual({ usable: true });
  });
});
