// Seat standing (F-2R2-009 / F-2R2-007): the ONE predicate the roster and the chat admission share.
// Pure functions over the probe's answer and the health record — no IO, no engine.

import { describe, expect, it } from 'vitest';

import { authUsable, chatSeatAdmission, FREE_TIER_SEATS, seatAuth, seatStanding } from '../src/api/seat-standing.js';

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
    expect(seatStanding({ key: 'claude', enabled_for_council: true }, true)).toEqual({
      auth: 'signed_in',
      council_eligible: true,
      // crew#645: nothing asked the seat, and the standing says so.
      login_check: 'unverified', login_note: expect.stringMatching(/^login unverified/),
    });
  });

  it('a signed-out seat is NOT eligible — the reason says a council benches it and where to sign in', () => {
    const s = seatStanding({ key: 'codex', enabled_for_council: true }, false);
    expect(s.auth).toBe('signed_out');
    expect(s.council_eligible).toBe(false);
    expect(s.council_ineligible_reason).toMatch(/signed out/);
    expect(s.council_ineligible_reason).toMatch(/bench/);
    expect(s.council_ineligible_reason).toMatch(/System page/);
  });

  it('a free-tier seat with no credential IS eligible, and names its tier and its source', () => {
    expect(seatStanding({ key: 'opencode', enabled_for_council: true }, false)).toEqual({
      auth: 'not_required',
      free_tier: FREE_TIER_SEATS['opencode'],
      free_tier_source: 'crew-heuristic',
      council_eligible: true,
      login_check: 'unverified', login_note: expect.stringMatching(/^login unverified/),
    });
  });

  it('crew keeps NO council bench of its own (R5b): standing is auth + enablement only — the engine benches per run', () => {
    // Before: a 30-min daemon-wide ballot count made this seat ineligible for every run. Now the
    // run's own `benched_seats` / `degradedReason` say what the engine did with it.
    const s = seatStanding({ key: 'opencode', enabled_for_council: true }, false);
    expect(s.council_eligible).toBe(true);
    expect('council_bench' in s).toBe(false);
  });

  it('unknown auth is eligible: refusing a seat the daemon cannot read would bench working keychain seats', () => {
    expect(seatStanding({ key: 'agy' }, null)).toEqual({ auth: 'unknown', council_eligible: true, login_check: 'unverified', login_note: expect.stringMatching(/^login unverified/) });
  });

  it('the seat’s runtime health is not an INPUT any more — an observed error never makes a seat ineligible (R5); a disabled seat is not eligible', () => {
    // `seatStanding` no longer takes the health reading at all: `inactive` is never produced and the
    // one bench is the engine's per-run ballot ledger, so there is nothing left for health to decide.
    expect(seatStanding({ key: 'claude', enabled_for_council: true }, true).council_eligible).toBe(true);
    const disabled = seatStanding({ key: 'claude', enabled_for_council: false }, true);
    expect(disabled).toEqual({
      auth: 'signed_in',
      council_eligible: false,
      council_ineligible_reason: 'not enabled for council',
      login_check: 'unverified', login_note: expect.stringMatching(/^login unverified/),
    });
  });
});

describe('chatSeatAdmission — the default seats of a chat, and WHY a seat is not one', () => {
  const governed = { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } };
  const ungoverned = { key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } };
  const sandboxed = { key: 'codex', acp: { acp_input_governance: false, os_sandbox: true } };
  const noAcp = { key: 'copilot' };
  it('an UNSCOPED chat admits every ACP seat that can take a turn — governed or not (chat is not a council; #533 review, F-4)', () => {
    for (const seat of [governed, ungoverned, sandboxed]) {
      expect(chatSeatAdmission(seat, 'signed_in', false)).toEqual({ ok: true });
      expect(chatSeatAdmission(seat, 'unknown', false)).toEqual({ ok: true });
      expect(chatSeatAdmission(seat, 'not_required', false)).toEqual({ ok: true });
    }
  });

  it('F-W1-003 = A (2026-09-15): a NON-ACP (wrapped) seat is not a chat seat — refused in BOTH modes, source scope, with an actionable reason', () => {
    for (const scoped of [false, true]) {
      const v = chatSeatAdmission(noAcp, 'signed_in', scoped);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.source).toBe('scope');
      expect(v.reason).toMatch(/no ACP adapter/);
      expect(v.reason).toMatch(/governed work in runs/);
      expect(v.reason).not.toMatch(/open the chat unscoped/);
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
    if (!copilot.ok) expect(copilot.reason).toMatch(/no ACP adapter/);
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

describe('ASK-C2 path admission (codex on #810 r9) + IG1-crew-2: standing is the gate where the run is bound; the governance MODE decides where it is not', () => {
  const wrapped = { key: 'codex', enabled_for_council: true } as never;
  // IG1-core-3 classes, as the engine's roster serialises them.
  const codexSelf = { key: 'codex', enabled_for_council: true, governance_class: 'os_sandbox', trust_flags: ['--sandbox', 'workspace-write'] } as never;
  const codexBypass = { key: 'codex', enabled_for_council: true, governance_class: 'none', trust_flags: ['--dangerously-bypass-approvals-and-sandbox'] } as never;
  const pi = { key: 'pi', enabled_for_council: true, governance_class: 'os_sandbox', acp: { acp_input_governance: false, os_sandbox: false } } as never;
  const piArmed = { key: 'pi', enabled_for_council: true, governance_class: 'os_sandbox', acp: { acp_input_governance: false, os_sandbox: true } } as never;
  const governed = { key: 'claude', enabled_for_council: true, governance_class: 'acp_input_governance', acp: { acp_input_governance: true, os_sandbox: false } } as never;
  it('path-bound (one repository): every seat in standing — every seat has at least the repository boundary there', () => {
    expect(chatSeatAdmission(wrapped, 'signed_in', true, 'path-bound')).toEqual({ ok: true });
    expect(chatSeatAdmission(pi, 'signed_in', true, 'path-bound')).toEqual({ ok: true });
    expect(chatSeatAdmission(codexBypass, 'signed_in', true, 'path-bound')).toEqual({ ok: true });
    expect(chatSeatAdmission(wrapped, 'signed_out', true, 'path-bound')).toMatchObject({ ok: false, source: 'auth' });
    expect(chatSeatAdmission({ key: 'agy', enabled_for_council: false } as never, 'signed_in', true, 'path-bound')).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) });
  });
  it('path, unscoped: standing only; path, scoped but unbound: admitted and os_sandbox{seat_record | self} take a turn, none is refused by name with the mode', () => {
    expect(chatSeatAdmission(wrapped, 'signed_in', false, 'path')).toEqual({ ok: true });
    expect(chatSeatAdmission(governed, 'signed_in', true, 'path')).toEqual({ ok: true });
    expect(chatSeatAdmission(codexSelf, 'signed_in', true, 'path')).toEqual({ ok: true });
    expect(chatSeatAdmission(piArmed, 'signed_in', true, 'path')).toEqual({ ok: true });
    // pi's only floor is the repository boundary, which needs a bound run.
    expect(chatSeatAdmission(pi, 'signed_in', true, 'path')).toMatchObject({
      ok: false,
      source: 'scope',
      reason: expect.stringMatching(/governance mode for this scope is none — its only floor is the engine's repository boundary.*scope the ask to one repository/),
    });
    expect(chatSeatAdmission(codexBypass, 'signed_in', true, 'path')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/governance mode for this scope is none — .*no per-call adapter to admit/),
    });
    // A seat the engine reported no class for is not claimed governed.
    expect(chatSeatAdmission(wrapped, 'signed_in', true, 'path')).toMatchObject({ ok: false, reason: expect.stringMatching(/no governance class/) });
  });
  it('pool (default): unchanged — a wrapped seat is never a pool seat', () => {
    expect(chatSeatAdmission(wrapped, 'signed_in', false)).toMatchObject({ ok: false, reason: expect.stringMatching(/no ACP adapter/) });
  });
});
