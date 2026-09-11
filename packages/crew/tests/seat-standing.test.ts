// Seat standing (F-2R2-009 / F-2R2-007): the ONE predicate the roster and the chat admission share.
// Pure functions over the probe's answer and the health record — no IO, no engine.

import { describe, expect, it } from 'vitest';

import { authUsable, chatSeatAdmission, FREE_TIER_SEATS, seatAuth, seatStanding } from '../src/api/seat-standing.js';
import type { CouncilBench, SeatHealth } from '../src/api/seat-health.js';

const ACTIVE: SeatHealth = { status: 'active', since: '2026-09-11T00:00:00.000Z' };
const INACTIVE: SeatHealth = { status: 'inactive', since: '2026-09-11T00:00:00.000Z', message: 'exit 1: Not logged in' };

describe('seatAuth — what signed_in MEANS for the seat', () => {
  it('true is signed_in for every seat; null is unknown (keychain-backed, unknown key) for every seat', () => {
    for (const key of ['claude', 'codex', 'pi', 'copilot', 'opencode', 'agy', 'mystery']) {
      expect(seatAuth({ key }, true)).toEqual({ auth: 'signed_in' });
      expect(seatAuth({ key }, null)).toEqual({ auth: 'unknown' });
    }
  });

  it('false is signed_out for a seat that needs a credential, and not_required — SOURCED to crew\'s table — for a free-tier seat (opencode)', () => {
    for (const key of ['codex', 'pi', 'copilot', 'claude']) expect(seatAuth({ key }, false)).toEqual({ auth: 'signed_out' });
    // The fresh rig's opencode answered a scoped chat with `signed_in: false` (OpenCode Zen, no account).
    expect(seatAuth({ key: 'opencode' }, false)).toEqual({
      auth: 'not_required',
      free_tier: FREE_TIER_SEATS['opencode'],
      free_tier_source: 'crew-heuristic',
    });
    expect(Object.keys(FREE_TIER_SEATS)).toEqual(['opencode']);
  });

  it('a registry record that declares the credential requirement WINS over the table (the wicked-core follow-up shape)', () => {
    // A record declaring `credential: "optional"` is read as the source of truth — for any seat.
    expect(seatAuth({ key: 'codex', credential: 'optional', free_tier: 'Codex free preview' }, false)).toEqual({
      auth: 'not_required',
      free_tier: 'Codex free preview',
      free_tier_source: 'registry',
    });
    expect(seatAuth({ key: 'codex', credential: 'optional' }, false).free_tier).toMatch(/declared by the CLI registry/);
    // A record declaring `required` silences the table even for opencode.
    expect(seatAuth({ key: 'opencode', credential: 'required' }, false)).toEqual({ auth: 'signed_out' });
  });

  it('only signed_out is unusable — unknown and not_required take a turn', () => {
    expect(authUsable('signed_in')).toBe(true);
    expect(authUsable('unknown')).toBe(true);
    expect(authUsable('not_required')).toBe(true);
    expect(authUsable('signed_out')).toBe(false);
  });
});

describe('seatStanding — what a council would do with the seat, as far as the daemon can tell', () => {
  it('a signed-in, active, council-enabled seat is eligible with no reason', () => {
    expect(seatStanding({ key: 'claude', enabled_for_council: true }, true, ACTIVE)).toEqual({
      auth: 'signed_in',
      council_eligible: true,
    });
  });

  it('a signed-out seat is NOT eligible — the reason says a council benches it and where to sign in', () => {
    const s = seatStanding({ key: 'codex', enabled_for_council: true }, false, ACTIVE);
    expect(s.auth).toBe('signed_out');
    expect(s.council_eligible).toBe(false);
    expect(s.council_ineligible_reason).toMatch(/signed out/);
    expect(s.council_ineligible_reason).toMatch(/bench/);
    expect(s.council_ineligible_reason).toMatch(/System page/);
  });

  it('a free-tier seat with no credential IS eligible, and names its tier and its source', () => {
    expect(seatStanding({ key: 'opencode', enabled_for_council: true }, false, ACTIVE)).toEqual({
      auth: 'not_required',
      free_tier: FREE_TIER_SEATS['opencode'],
      free_tier_source: 'crew-heuristic',
      council_eligible: true,
    });
  });

  it('a seat BENCHED by this daemon\'s recent councils is NOT eligible — whatever its auth says — with the last failure named (#533 review, F-1)', () => {
    const bench: CouncilBench = {
      failures: 2,
      last_kind: 'timed_out',
      last_at: '2026-09-11T09:55:11.000Z',
      last_run: 'bb28ad5a-febb-411f-b8db-aed1dee8e515',
      last_detail: 'exceeded 40s dispatch budget',
      window_ms: 30 * 60 * 1000,
    };
    // The phase-4 rig: opencode's free tier answers a chat AND times out every ballot.
    const s = seatStanding({ key: 'opencode', enabled_for_council: true }, false, ACTIVE, bench);
    expect(s.auth).toBe('not_required');
    expect(s.council_eligible).toBe(false);
    expect(s.council_ineligible_reason).toBe(
      'benched by this daemon\'s recent councils: 2 ballot failures in the last 30 min — last timed_out on run bb28ad5a (exceeded 40s dispatch budget); an ok unit output clears it',
    );
    expect(s.council_bench).toEqual(bench);
    // No bench (null) leaves a healthy seat eligible.
    expect(seatStanding({ key: 'opencode', enabled_for_council: true }, false, ACTIVE, null).council_eligible).toBe(true);
    // Auth still comes first in the reason order: a signed-out AND benched seat says signed out.
    expect(seatStanding({ key: 'codex', enabled_for_council: true }, false, ACTIVE, bench).council_ineligible_reason).toMatch(/^signed out/);
  });

  it('unknown auth is eligible: refusing a seat the daemon cannot read would bench working keychain seats', () => {
    expect(seatStanding({ key: 'agy' }, null, ACTIVE)).toEqual({ auth: 'unknown', council_eligible: true });
  });

  it('an inactive seat (runtime health) is not eligible, with the health excerpt; a disabled seat is not eligible either', () => {
    const inactive = seatStanding({ key: 'claude', enabled_for_council: true }, true, INACTIVE);
    expect(inactive.council_eligible).toBe(false);
    expect(inactive.council_ineligible_reason).toBe('inactive after a seat-level error: exit 1: Not logged in');
    const disabled = seatStanding({ key: 'claude', enabled_for_council: false }, true, ACTIVE);
    expect(disabled).toEqual({ auth: 'signed_in', council_eligible: false, council_ineligible_reason: 'not enabled for council' });
  });
});

describe('chatSeatAdmission — the default seats of a chat, and WHY a seat is not one', () => {
  const governed = { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } };
  const ungoverned = { key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } };
  const sandboxed = { key: 'codex', acp: { acp_input_governance: false, os_sandbox: true } };
  const noAcp = { key: 'copilot' };
  it('an UNSCOPED chat admits every seat that can take a turn, ACP or not — auth is the ONLY input (a chat is not a council; #533 review, F-4)', () => {
    for (const seat of [governed, ungoverned, sandboxed, noAcp]) {
      expect(chatSeatAdmission(seat, 'signed_in', false)).toEqual({ ok: true });
      expect(chatSeatAdmission(seat, 'unknown', false)).toEqual({ ok: true });
      expect(chatSeatAdmission(seat, 'not_required', false)).toEqual({ ok: true });
    }
  });

  it('a signed-out seat is refused up front — the same auth predicate the roster reports', () => {
    const refused = chatSeatAdmission(governed, 'signed_out', false);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/signed out/);
    expect(refused.reason).toMatch(/System page/);
  });

  it('a SCOPED chat restates the engine rule: governed or sandboxed seats pass; an ungoverned adapter or no adapter is refused by name (F-2R2-007)', () => {
    expect(chatSeatAdmission(governed, 'signed_in', true)).toEqual({ ok: true });
    expect(chatSeatAdmission(sandboxed, 'signed_in', true)).toEqual({ ok: true });
    const pi = chatSeatAdmission(ungoverned, 'signed_in', true);
    expect(pi.ok).toBe(false);
    if (!pi.ok) {
      expect(pi.reason).toMatch(/asks no permissions/);
      expect(pi.reason).toMatch(/open the chat unscoped/);
    }
    const copilot = chatSeatAdmission(noAcp, 'signed_in', true);
    expect(copilot.ok).toBe(false);
    if (!copilot.ok) expect(copilot.reason).toMatch(/no ACP adapter registered/);
  });

  it('every applicable reason is carried — a signed-out, ungoverned seat in a scoped chat says both', () => {
    const both = chatSeatAdmission(ungoverned, 'signed_out', true);
    expect(both.ok).toBe(false);
    if (both.ok) return;
    expect(both.reason).toMatch(/signed out/);
    expect(both.reason).toMatch(/asks no permissions/);
    expect(both.reason.split('; ')).toHaveLength(2);
  });
});
