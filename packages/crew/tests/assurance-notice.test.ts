// wicked-core#850: the one-CLI assurance notice crew answers a full-assurance launch with
// (`core/assurance.ts`). The real-engine proof is tests/integration/reduced-assurance-launch.test.ts;
// this pins the roster reading the notice is decided on.
import { describe, expect, it } from 'vitest';
import { launchAssuranceNotice, seatIdentity, workSeats } from '../src/core/assurance.js';

const seat = (key: string, inv: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  key,
  headless_invocation: inv,
  ...extra,
});
const notice = (seats: unknown[], reducedAssurance?: boolean) =>
  launchAssuranceNotice({ runId: 'r1', reducedAssurance, engineClisJson: JSON.stringify(seats) });

describe('seatIdentity — the engine judge identity (wicked-core validator::seat_identity)', () => {
  it('is the basename of the invocation argv[0], case-folded; a seat with none has no judge identity', () => {
    expect(seatIdentity({ headless_invocation: '/usr/local/bin/Claude -p {PROMPT}' })).toBe('claude');
    expect(seatIdentity({ headless_invocation: 'codex exec {PROMPT}' })).toBe('codex');
    expect(seatIdentity({ headless_invocation: '   ' })).toBeNull();
    expect(seatIdentity({})).toBeNull();
  });
});

describe('workSeats — the seats that can do work, so evaluate or judge', () => {
  it('drops launcher-benched and ballot-only seats; null on a roster it cannot read', () => {
    const seats = workSeats(
      JSON.stringify([
        seat('claude', 'claude -p {PROMPT}'),
        seat('codex', 'codex exec {PROMPT}', { health: { usable: false, reason: 'signed out' } }),
        seat('pi', 'pi {PROMPT}', { seat_eligible_for_work: false }),
      ]),
    );
    expect(seats).toEqual([{ key: 'claude', identity: 'claude' }]);
    expect(workSeats('not json')).toBeNull();
    expect(workSeats('{"key":"x"}')).toBeNull();
    expect(workSeats(JSON.stringify([{ display_name: 'no key' }]))).toBeNull();
  });
});

describe('launchAssuranceNotice', () => {
  it('a full-assurance launch whose work seats are one CLI identity is TOLD, with the explicit opt-in to relaunch with', () => {
    const n = notice([seat('claude', 'claude -p {PROMPT}'), seat('claude#2', 'claude -p {PROMPT}')]);
    expect(n).toMatchObject({ code: 'single_cli_roster', seats: ['claude', 'claude#2'], retryWith: { retryOf: 'r1', reducedAssurance: true } });
    expect(n?.message).toContain('reducedAssurance');
    // `false` is the explicit full choice — told the same.
    expect(notice([seat('claude', 'claude -p {PROMPT}')], false)).not.toBeNull();
  });

  it('two keys invoking ONE binary are one identity (the judge cannot be distinct) — told', () => {
    expect(notice([seat('claude', 'claude -p {PROMPT}'), seat('claude-sonnet', 'claude --model sonnet -p {PROMPT}')])).not.toBeNull();
  });

  it('a second seat with no invocation cannot judge — told', () => {
    expect(notice([seat('claude', 'claude -p {PROMPT}'), seat('codex', '')])).not.toBeNull();
  });

  it('a second CLI that can only vote, or is benched, does not count — told', () => {
    expect(notice([seat('claude', 'claude -p {PROMPT}'), seat('codex', 'codex exec {PROMPT}', { seat_eligible_for_work: false })])).not.toBeNull();
    expect(notice([seat('claude', 'claude -p {PROMPT}'), seat('codex', 'codex exec {PROMPT}', { health: { usable: false } })])).not.toBeNull();
  });

  it('nothing when the caller opted in, the roster has two CLI identities, or nothing readable is usable', () => {
    expect(notice([seat('claude', 'claude -p {PROMPT}')], true)).toBeNull();
    expect(notice([seat('claude', 'claude -p {PROMPT}'), seat('codex', 'codex exec {PROMPT}')])).toBeNull();
    expect(notice([seat('claude', 'claude', { health: { usable: false } })])).toBeNull();
    expect(launchAssuranceNotice({ runId: 'r1', reducedAssurance: undefined, engineClisJson: 'garbage' })).toBeNull();
  });
});
