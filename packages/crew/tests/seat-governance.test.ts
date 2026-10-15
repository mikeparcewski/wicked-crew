/**
 * IG1-crew-1: the governance mode table (seat-governance.ts) — five built-in seats × three scope
 * kinds, the pin rule, codex's trust flags — and the crew#742 diagnostics/warnings built on it.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  seatGovernanceDiagnostics,
  seatGovernanceMode,
  seatGovernanceModes,
  seatGovernanceWarnings,
  runRoot,
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
    // C5: its tool calls were checked over ACP, which is gone: on the interim host floor the engine refuses its governed work.
    opencode: { unscoped: 'none/none', scoped: 'none/none', scoped_bound: 'none/none' },
    codex: { unscoped: 'os_sandbox/self', scoped: 'os_sandbox/self', scoped_bound: 'os_sandbox/self' },
    // C5: on the interim host floor only claude and codex keep a per-call check; the engine refuses the rest.
    pi: { unscoped: 'none/none', scoped: 'none/none', scoped_bound: 'none/none' },
    copilot: { unscoped: 'none/none', scoped: 'none/none', scoped_bound: 'none/none' },
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
  it('an ACP-only seat reads none on the host floor, pinned or not: the engine refuses its governed work (C5)', () => {
    const drifted = { ...BUILTIN.opencode, version_pin: { matched: false, pinned: '1.2.3', observed: '1.3.0' } };
    for (const seat of [drifted, BUILTIN.opencode]) {
      const m = seatGovernanceMode(seat, 'scoped_bound');
      expect(m).toMatchObject({ mode: 'none', class: 'acp_input_governance', source: 'none' });
      expect(m.reason).toMatch(/needs_container_floor/);
    }
  });
  it('acp.os_sandbox on the record no longer holds a host-floor seat: the engine refuses it (C5)', () => {
    const armed = { ...BUILTIN.pi, acp: { ...BUILTIN.pi.acp, os_sandbox: true } };
    for (const scope of SCOPES) {
      const m = seatGovernanceMode(armed, scope);
      expect(m).toMatchObject({ mode: 'none', source: 'none' });
      expect(m.reason).toMatch(/needs_container_floor/);
    }
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
      ['claude', 'wrapped', false, 'acp_input_governance', 'enforced'],
      ['opencode', 'wrapped', false, 'acp_input_governance', 'unenforced'],
      ['pi', 'wrapped', false, 'os_sandbox', 'unenforced'],
      ['codex', 'wrapped', false, 'none', 'unenforced'],
      ['copilot', 'wrapped', false, 'os_sandbox', 'unenforced'],
    ]);
    expect(seats[2]!.governance_mode.scoped_bound).toMatchObject({ mode: 'none', source: 'none' });
  });
  it('names an ungoverned seat, and floor seats on a host with no launcher; skips disabled seats', () => {
    const withLauncher = seatGovernanceWarnings(seats, 'sandbox-exec');
    // C5: on the interim host floor opencode and pi are named ungoverned (the engine refuses their
    // governed work); no seat relies on the host's sandbox launcher any more.
    expect(withLauncher.map((w) => w.kind)).toEqual(['seats.ungoverned', 'seats.ungoverned', 'seats.ungoverned']);
    const text = withLauncher.map((w) => w.message).join('\n');
    for (const cli of ['opencode', 'pi', 'codex']) expect(text).toMatch(new RegExp(`^seat ${cli} runs ungoverned: `, 'm'));
    expect(text).not.toMatch(/copilot/);
    const noLauncher = seatGovernanceWarnings(seats, null);
    expect(noLauncher.map((w) => w.kind)).not.toContain('seats.os-floor-unarmable');
  });
});

describe('under the container floor (C5)', () => {
  const prev = process.env['WICKED_SEAT_FLOOR'];
  afterEach(() => {
    if (prev === undefined) delete process.env['WICKED_SEAT_FLOOR'];
    else process.env['WICKED_SEAT_FLOOR'] = prev;
  });
  it('reads the seat container, never an ACP permission channel; no host-launcher warning', () => {
    process.env['WICKED_SEAT_FLOOR'] = 'container';
    const pi = seatGovernanceMode({ key: 'pi', governance_class: 'acp_input_governance' }, 'unscoped');
    expect(pi).toMatchObject({ mode: 'os_sandbox', source: 'repo_boundary' });
    expect(pi.reason).toMatch(/container floor/);
    expect(pi.reason).not.toMatch(/request_permission/);
    const claude = seatGovernanceMode({ key: 'claude#2', governance_class: 'acp_input_governance' }, 'scoped');
    expect(claude).toMatchObject({ mode: 'admitted' });
    expect(claude.reason).toMatch(/gate hook/);
    const diag = seatGovernanceDiagnostics([{ ...BUILTIN.pi, enabled_for_council: true }]);
    expect(seatGovernanceWarnings(diag, null).map((w) => w.kind)).not.toContain('seats.os-floor-unarmable');
  });
});

describe('runRoot: the executable decides, not the seat name (C5, codex c5-crew-r3)', () => {
  it('reads the headless invocation, then the binary, then the key', () => {
    expect(runRoot({ key: 'claude', headless_invocation: 'pi -p {PROMPT}' })).toBe('pi');
    expect(runRoot({ key: 'my-claude', headless_invocation: '"/opt/tools/claude" -p {PROMPT}' })).toBe('claude');
    expect(runRoot({ key: 'x', binary: 'C:\\tools\\codex.cmd' })).toBe('codex');
    expect(runRoot({ key: 'claude#2' })).toBe('claude');
  });
  it('a claude-named seat running pi reads none on the host floor; a claude binary under another name is admitted', () => {
    expect(seatGovernanceMode({ key: 'claude', governance_class: 'acp_input_governance', headless_invocation: 'pi -p {PROMPT}' }, 'scoped')).toMatchObject({ mode: 'none' });
    expect(seatGovernanceMode({ key: 'my-claude', governance_class: 'acp_input_governance', headless_invocation: 'claude -p {PROMPT}' }, 'scoped')).toMatchObject({ mode: 'admitted' });
  });
  it('a seat running codex with a bounded --sandbox AND a bypass flag reads none, as the engine refuses it (codex c5-crew-r5)', () => {
    const seat = (trust_flags: string[]) => ({ key: 'runner', governance_class: 'os_sandbox', headless_invocation: 'codex exec {PROMPT}', trust_flags });
    expect(seatGovernanceMode(seat(['--sandbox', 'workspace-write']), 'scoped')).toMatchObject({ mode: 'os_sandbox', source: 'self' });
    expect(seatGovernanceMode(seat(['--sandbox', 'workspace-write', '--yolo']), 'scoped')).toMatchObject({ mode: 'none' });
    expect(seatGovernanceMode(seat(['--sandbox=read-only', '--dangerously-bypass-approvals-and-sandbox']), 'scoped')).toMatchObject({ mode: 'none' });
  });
});
