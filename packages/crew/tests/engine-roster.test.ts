// Wave 6 — the roster crew hands the ENGINE vs the roster crew serves the STUDIO (the crew half of
// F-7R2-006). `GET /roster` decorates seats with crew's own readings (`health {status}`, `auth`,
// `council_eligible`, …) and the studio round-trips them into `clisJson`; the wave-6 engine grew
// `AgenticCli.health {usable, reason}` under the SAME key. The boundary strips crew's readings and
// turns `council_eligible` into the engine's bench verdict.
import { describe, expect, it } from 'vitest';

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
    const signedOut = toEngineSeat({ ...registrySeat, auth: 'signed_out', council_eligible: false, council_ineligible_reason: 'signed out — a council would bench this seat on its first ballot; sign it in from the System page' }) as Record<string, unknown>;
    expect(signedOut['health']).toEqual({ usable: false, reason: 'signed out' });
    const inactive = toEngineSeat({ ...registrySeat, health: { status: 'inactive', since: 't' }, council_eligible: false, council_ineligible_reason: 'inactive after a seat-level error: boom' }) as Record<string, unknown>;
    expect(inactive['health']).toEqual({ usable: false, reason: 'inactive after a seat-level error' });
    const benchedByCouncils = toEngineSeat({ ...registrySeat, council_eligible: false, council_bench: { failures: 2, last_kind: 'timed_out', last_at: 't', window_ms: 60_000 }, council_ineligible_reason: 'benched by this daemon’s recent councils: …' }) as Record<string, unknown>;
    expect(benchedByCouncils['health']).toEqual({ usable: false, reason: 'benched by recent councils (2 timed out)' });
    const disabled = toEngineSeat({ ...registrySeat, enabled_for_council: false, council_eligible: false, council_ineligible_reason: 'not enabled for council' }) as Record<string, unknown>;
    expect(disabled['health']).toEqual({ usable: false, reason: 'not enabled for council' });
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
  it('names the seats the engine would convene: not benched, enabled for council', () => {
    const roster = [
      { ...registrySeat, key: 'claude', council_eligible: true },
      { ...registrySeat, key: 'codex', council_eligible: false, council_ineligible_reason: 'signed out' },
      { ...registrySeat, key: 'pi' },
      { ...registrySeat, key: 'ollama', enabled_for_council: false },
    ];
    expect(eligibleSeatKeys(roster)).toEqual(['claude', 'pi']);
    expect(toEngineRoster(roster)).toHaveLength(4);
  });
});
