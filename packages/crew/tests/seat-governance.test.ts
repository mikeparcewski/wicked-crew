/**
 * IG1-crew-1: the governance mode table (seat-governance.ts) — five built-in seats × three scope
 * kinds, the pin rule, codex's trust flags — and the crew#742 diagnostics/warnings built on it.
 */
import { describe, expect, it } from 'vitest';

import {
  seatGovernanceDiagnostics,
  seatGovernanceMode,
  seatGovernanceModes,
  seatGovernanceWarnings,
  type GovernanceScopeKind,
} from '../src/api/seat-governance.js';
import { CREW_ONLY_SEAT_FIELDS, toEngineSeat } from '../src/core/engine-roster.js';

// The five built-in seats as the engine's roster serialises them (IG1-core-3 `governance_class`).
const BUILTIN = {
  claude: { key: 'claude', governance_class: 'acp_input_governance', acp: { binary: 'claude-agent-acp', acp_input_governance: true, os_sandbox: false } },
  opencode: {
    key: 'opencode',
    governance_class: 'acp_input_governance',
    acp: { binary: 'opencode', acp_input_governance: true, os_sandbox: false, verified_version: '1.2.3' },
    version_pin: { matched: true, pinned: '1.2.3', observed: '1.2.3' },
  },
  codex: { key: 'codex', governance_class: 'os_sandbox', trust_flags: ['--sandbox', 'workspace-write'] },
  pi: { key: 'pi', governance_class: 'os_sandbox', acp: { binary: 'pi-acp', acp_input_governance: false, os_sandbox: false } },
  copilot: { key: 'copilot', governance_class: 'os_sandbox' },
} as const;

const SCOPES: GovernanceScopeKind[] = ['unscoped', 'scoped', 'scoped_bound'];

describe('seatGovernanceMode — five built-in seats × three scope kinds', () => {
  const table: Record<keyof typeof BUILTIN, Record<GovernanceScopeKind, string>> = {
    claude: { unscoped: 'admitted/acp_input_governance', scoped: 'admitted/acp_input_governance', scoped_bound: 'admitted/acp_input_governance' },
    opencode: { unscoped: 'admitted/acp_input_governance', scoped: 'admitted/acp_input_governance', scoped_bound: 'admitted/acp_input_governance' },
    codex: { unscoped: 'os_sandbox/self', scoped: 'os_sandbox/self', scoped_bound: 'os_sandbox/self' },
    pi: { unscoped: 'none/none', scoped: 'none/none', scoped_bound: 'os_sandbox/repo_boundary' },
    copilot: { unscoped: 'none/none', scoped: 'none/none', scoped_bound: 'os_sandbox/repo_boundary' },
  };
  for (const [key, row] of Object.entries(table)) {
    for (const scope of SCOPES) {
      it(`${key} · ${scope} → ${row[scope]}`, () => {
        const m = seatGovernanceMode(BUILTIN[key as keyof typeof BUILTIN], scope);
        expect(`${m.mode}/${m.source}`).toBe(row[scope]);
        expect(m.fence.network).toBe('open');
        expect(Array.isArray(m.fence.write_roots) && Array.isArray(m.fence.read_roots)).toBe(true);
      });
    }
  }

  it("codex's reason says why it stays on the floor: no per-call adapter to admit", () => {
    expect(seatGovernanceMode(BUILTIN.codex, 'scoped').reason).toMatch(/--sandbox workspace-write.*no per-call adapter to admit.*auto_review/);
  });

  it('a bound fence names the worktree and the granted write roots; an unbound one writes nowhere', () => {
    const bound = seatGovernanceMode(BUILTIN.pi, 'scoped_bound', { worktree: '/w/run-1', extraWriteRoots: ['/w/evidence'] });
    expect(bound.fence).toEqual({ write_roots: ['/w/run-1', '/w/evidence'], read_roots: ['/w/run-1'], network: 'open' });
    expect(seatGovernanceMode(BUILTIN.pi, 'scoped_bound').fence.write_roots).toEqual(['<run worktree>']);
    expect(seatGovernanceMode(BUILTIN.claude, 'scoped').fence).toEqual({ write_roots: [], read_roots: ['<repositories in scope>'], network: 'open' });
  });
});

describe('seatGovernanceMode — the pin rule, the seat record, codex flags', () => {
  it('admitted whose pinned build does not match is none (the engine fails it closed)', () => {
    const drifted = { ...BUILTIN.opencode, version_pin: { matched: false, pinned: '1.2.3', observed: '1.3.0' } };
    const m = seatGovernanceMode(drifted, 'scoped_bound');
    expect(m).toMatchObject({ mode: 'none', class: 'acp_input_governance', source: 'none' });
    expect(m.reason).toMatch(/proven against the build `1\.2\.3`.*reports `1\.3\.0`/);
  });
  it('a pinned seat not yet probed stays admitted and says the pin is unprobed', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped to model a seat with no pin reading
    const { version_pin: _drop, ...unprobed } = BUILTIN.opencode;
    expect(seatGovernanceMode(unprobed, 'scoped')).toMatchObject({ mode: 'admitted', reason: expect.stringMatching(/not yet probed/) });
  });
  it('acp.os_sandbox on the record is the floor in every scope (seat_record)', () => {
    const armed = { ...BUILTIN.pi, acp: { ...BUILTIN.pi.acp, os_sandbox: true } };
    for (const scope of SCOPES) expect(seatGovernanceMode(armed, scope)).toMatchObject({ mode: 'os_sandbox', source: 'seat_record' });
  });
  it("codex with trust_flags [] or the bypass flag is class none → none, the reason naming the missing adapter", () => {
    for (const flags of [[], ['--dangerously-bypass-approvals-and-sandbox']]) {
      const m = seatGovernanceMode({ key: 'codex', governance_class: 'none', trust_flags: flags }, 'scoped_bound');
      expect(m).toMatchObject({ mode: 'none', class: 'none', source: 'none' });
      expect(m.reason).toMatch(/own sandbox off.*no per-call adapter to admit/);
    }
  });
  it('no class from the engine is never claimed governed', () => {
    expect(seatGovernanceMode({ key: 'x' }, 'scoped_bound')).toMatchObject({ mode: 'none', class: null });
  });
});

describe('governance_mode never reaches the engine', () => {
  it('CREW_ONLY_SEAT_FIELDS strips governance_mode; the engine class rides through', () => {
    expect(CREW_ONLY_SEAT_FIELDS.has('governance_mode')).toBe(true);
    const seat = { ...BUILTIN.pi, governance_mode: seatGovernanceModes(BUILTIN.pi) };
    const out = toEngineSeat(seat) as Record<string, unknown>;
    expect(out['governance_mode']).toBeUndefined();
    expect(out['governance_class']).toBe('os_sandbox');
  });
});

describe('crew#742 — /diagnostics seat governance + /health warnings', () => {
  const seats = seatGovernanceDiagnostics([
    { ...BUILTIN.claude, enabled_for_council: true },
    { ...BUILTIN.opencode, enabled_for_council: true, version_pin: null },
    { ...BUILTIN.pi, enabled_for_council: true },
    { key: 'codex', enabled_for_council: true, governance_class: 'none', trust_flags: [] },
    { ...BUILTIN.copilot, enabled_for_council: false },
  ]);
  it('per seat: transport, os_sandbox, class, input governance enforced / claimed / unenforced', () => {
    expect(seats.map((s) => [s.cli, s.transport, s.os_sandbox, s.class, s.input_governance])).toEqual([
      ['claude', 'acp', false, 'acp_input_governance', 'enforced'],
      ['opencode', 'acp', false, 'acp_input_governance', 'claimed'],
      ['pi', 'acp', false, 'os_sandbox', 'unenforced'],
      ['codex', 'wrapped', false, 'none', 'unenforced'],
      ['copilot', 'wrapped', false, 'os_sandbox', 'unenforced'],
    ]);
    expect(seats[2]!.governance_mode.scoped_bound).toMatchObject({ mode: 'os_sandbox', source: 'repo_boundary' });
  });
  it('names an ungoverned seat, and floor seats on a host with no launcher; skips disabled seats', () => {
    const withLauncher = seatGovernanceWarnings(seats, 'sandbox-exec');
    expect(withLauncher.map((w) => w.kind)).toEqual(['seats.ungoverned']);
    expect(withLauncher[0]!.message).toMatch(/^seat codex runs ungoverned: /);
    const noLauncher = seatGovernanceWarnings(seats, null);
    expect(noLauncher.map((w) => w.kind)).toEqual(['seats.ungoverned', 'seats.os-floor-unarmable']);
    expect(noLauncher[1]!.message).toMatch(/no OS write boundary can arm on this host.*so pi /);
    expect(noLauncher[1]!.message).not.toMatch(/copilot/);
  });
});
