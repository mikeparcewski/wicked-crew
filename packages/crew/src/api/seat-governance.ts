/**
 * IG1-crew-1: the governance MODE a seat runs under — what fences its tool calls — read from the
 * class the ENGINE derives (`governance_class` on the registry roster, IG1-core-3:
 * `acp_input_governance | os_sandbox | none`). Crew re-derives none of the engine's rules; it adds
 * only what the engine cannot know from a seat record: the ACP version pin crew probes
 * (`version_pin`, core#581), the scope kind of the run/ask, and the fence crew applies itself (the
 * bound run's worktree plus `LaunchOptions.extraWriteRoots`).
 *
 * Pure: no I/O, no clock. The roster (`roster-standing.ts`), `/diagnostics`, the ask path's record
 * (`ask-paths.ts`) and the eligibility rule (`seat-standing.ts chatSeatAdmission`) all call this.
 *
 * `governance_mode` is a crew reading, never an engine field: it is in `CREW_ONLY_SEAT_FIELDS`
 * (`core/engine-roster.ts`), so a studio round-trip of the roster never hands it to the engine.
 */

/** The engine's governance class names (IG1-core-3 `GovernanceClass::as_wire`). */
export type EngineGovernanceClass = 'acp_input_governance' | 'os_sandbox' | 'none';

/** `admitted` — an ACP adapter sends every tool call through the engine's gate; `os_sandbox` — an
 *  OS write floor contains the seat (not a per-call gate, not a read or network jail); `none` —
 *  nothing but the command-text fences. */
export type GovernanceModeKind = 'admitted' | 'os_sandbox' | 'none';

/** What the mode rests on: the admitted adapter, the seat record's `acp.os_sandbox`, the seat's
 *  own sandbox (codex `--sandbox`), the engine's repository boundary around a bound run, or nothing. */
export type GovernanceModeSource = 'acp_input_governance' | 'seat_record' | 'self' | 'repo_boundary' | 'none';

/** The three scope kinds a seat can be convened for — the same keys as `chat_admission`:
 *  `unscoped` (no repository), `scoped` (several repositories or a project — the run binds none),
 *  `scoped_bound` (one repository — the run is bound to its worktree; every build run is this). */
export type GovernanceScopeKind = 'unscoped' | 'scoped' | 'scoped_bound';

export interface SeatGovernanceFence {
  write_roots: string[];
  read_roots: string[];
  /** No floor crew or the engine arms jails the network. */
  network: 'open';
}

export interface SeatGovernanceMode {
  mode: GovernanceModeKind;
  /** The engine's class as read (`null` when the engine reported none). */
  class: EngineGovernanceClass | null;
  source: GovernanceModeSource;
  /** Why, in the operator's words. */
  reason: string;
  fence: SeatGovernanceFence;
}

/** The registry fields the mode reads (a `RosterSeat` satisfies it). */
export interface GovernanceSeatInput {
  key: string;
  governance_class?: unknown;
  trust_flags?: unknown;
  acp?: { os_sandbox?: unknown; verified_version?: unknown } | null;
  version_pin?: { matched?: unknown; pinned?: unknown; observed?: unknown } | null;
}

/** The roots a fence names. Defaults are labels, not paths: the roster describes a seat before any
 *  run exists; a run's record passes its real worktree. */
export interface GovernanceFenceRoots {
  worktree?: string;
  extraWriteRoots?: readonly string[];
}

const WORKTREE_LABEL = '<run worktree>';
const SCOPE_LABEL = '<repositories in scope>';

const CODEX_NO_ADAPTER =
  'there is no per-call adapter to admit (codex-acp resolves every intent through its internal ' +
  '`approvalsReviewer: "auto_review"` before `session/request_permission`)';

function asClass(v: unknown): EngineGovernanceClass | null {
  return v === 'acp_input_governance' || v === 'os_sandbox' || v === 'none' ? v : null;
}

/** The seat's own bounded `--sandbox <mode>` among its trust flags (codex). */
function ownSandboxMode(trustFlags: unknown): string | null {
  if (!Array.isArray(trustFlags)) return null;
  const flags = trustFlags.filter((f): f is string => typeof f === 'string');
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    const mode = f === '--sandbox' || f === '-s' ? flags[i + 1] : f.startsWith('--sandbox=') ? f.slice('--sandbox='.length) : undefined;
    if (mode === 'workspace-write' || mode === 'read-only') return mode;
  }
  return null;
}

function isCodex(seat: GovernanceSeatInput): boolean {
  return seat.key === 'codex' || seat.key.startsWith('codex-');
}

function fenceFor(scope: GovernanceScopeKind, roots: GovernanceFenceRoots): SeatGovernanceFence {
  if (scope === 'scoped_bound') {
    const worktree = roots.worktree ?? WORKTREE_LABEL;
    return { write_roots: [worktree, ...(roots.extraWriteRoots ?? [])], read_roots: [worktree], network: 'open' };
  }
  return { write_roots: [], read_roots: scope === 'scoped' ? [SCOPE_LABEL] : [], network: 'open' };
}

/**
 * The mode a seat runs under for a scope kind.
 *
 *  - `admitted`: class `acp_input_governance` and — when the seat pins `acp.verified_version` —
 *    the probed `version_pin.matched` is not `false` (a drifted pin fails the engine's governance
 *    closed: `none`).
 *  - `os_sandbox`: class `os_sandbox` with a floor that holds for this scope — `seat_record`
 *    (`acp.os_sandbox`), `self` (codex's own bounded `--sandbox`), or `repo_boundary` (the
 *    engine's boundary around a run BOUND to one repository: worktree + `extraWriteRoots`).
 *    A floor seat whose only floor is the repository boundary, on a scope that binds no
 *    repository, is `none` for that scope.
 *  - `none`: class `none`, no class at all, or the cases above.
 */
export function seatGovernanceMode(
  seat: GovernanceSeatInput,
  scope: GovernanceScopeKind,
  roots: GovernanceFenceRoots = {},
): SeatGovernanceMode {
  const cls = asClass(seat.governance_class);
  const fence = fenceFor(scope, roots);
  const none = (reason: string): SeatGovernanceMode => ({ mode: 'none', class: cls, source: 'none', reason, fence });
  if (cls === null) {
    return none('the engine reported no governance class for this seat, so nothing is claimed to fence its tool calls');
  }
  if (cls === 'none') {
    return none(
      isCodex(seat)
        ? `the engine names its governance class none: codex runs with its own sandbox off (no bounded \`--sandbox\` in its trust flags, or the bypass flag), and ${CODEX_NO_ADAPTER} — only the command-text fences apply`
        : 'the engine names its governance class none (its record sets `governance_floor = false`) — only the command-text fences apply',
    );
  }
  if (cls === 'acp_input_governance') {
    const pinned = typeof seat.acp?.verified_version === 'string' ? seat.acp.verified_version : null;
    if (pinned !== null && seat.version_pin?.matched === false) {
      const observed = typeof seat.version_pin.observed === 'string' ? `reports \`${seat.version_pin.observed}\`` : 'did not answer `--version`';
      return none(
        `its ACP admission is proven against the build \`${pinned}\`, but its binary ${observed} — the engine fails its governance closed, so its tool calls run unchecked`,
      );
    }
    return {
      mode: 'admitted',
      class: cls,
      source: 'acp_input_governance',
      reason:
        'its admitted ACP adapter sends every tool call through `session/request_permission` to the engine\'s gate' +
        (pinned === null ? '' : seat.version_pin?.matched === true ? ` (pinned build \`${pinned}\` verified)` : ` (pinned build \`${pinned}\`; not yet probed)`),
      fence,
    };
  }
  // cls === 'os_sandbox'
  if (seat.acp?.os_sandbox === true) {
    return {
      mode: 'os_sandbox',
      class: cls,
      source: 'seat_record',
      reason: 'its record arms the OS sandbox (`acp.os_sandbox`): the kernel write floor holds its writes to the fenced roots — not a per-call gate, not a read or network jail',
      fence,
    };
  }
  const own = isCodex(seat) ? ownSandboxMode(seat.trust_flags) : null;
  if (own !== null) {
    return {
      mode: 'os_sandbox',
      class: cls,
      source: 'self',
      reason: `codex runs under its own \`--sandbox ${own}\`, and ${CODEX_NO_ADAPTER}, so it stays on the OS-sandbox floor — not a per-call gate`,
      fence,
    };
  }
  if (scope === 'scoped_bound') {
    return {
      mode: 'os_sandbox',
      class: cls,
      source: 'repo_boundary',
      reason:
        "the engine's repository boundary (sandbox-exec / bwrap) holds its writes to the run's worktree and the granted write roots — not a per-call gate, not a read or network jail",
      fence,
    };
  }
  return none(
    "its only floor is the engine's repository boundary, which arms on a run bound to one repository — " +
      (scope === 'scoped' ? 'this scope (several repositories or a project) binds none' : 'an unscoped ask binds none'),
  );
}

/** The mode per scope kind — `RosterSeat.governance_mode` (the same keys as `chat_admission`). */
export function seatGovernanceModes(seat: GovernanceSeatInput): Record<GovernanceScopeKind, SeatGovernanceMode> {
  return {
    unscoped: seatGovernanceMode(seat, 'unscoped'),
    scoped: seatGovernanceMode(seat, 'scoped'),
    scoped_bound: seatGovernanceMode(seat, 'scoped_bound'),
  };
}

// ── /diagnostics + /health (crew#742) ───────────────────────────────────────────────────────────

/** One seat's governance standing on `/diagnostics.seatGovernance.seats` (crew#742). */
export interface SeatGovernanceDiagnostic {
  cli: string;
  enabled_for_council: boolean;
  /** `acp` — an ACP adapter (`[cli.acp]`); `wrapped` — the CLI runs wrapped in a PTY. */
  transport: 'acp' | 'wrapped';
  /** The seat record arms the OS sandbox itself (`acp.os_sandbox`). */
  os_sandbox: boolean;
  class: EngineGovernanceClass | null;
  /** `enforced` — admitted and (when pinned) the pin verified; `claimed` — admitted, pin not yet
   *  probed; `unenforced` — no per-call gate holds this seat. */
  input_governance: 'enforced' | 'claimed' | 'unenforced';
  governance_mode: Record<GovernanceScopeKind, SeatGovernanceMode>;
}

export interface DiagnosticSeatInput extends GovernanceSeatInput {
  enabled_for_council?: unknown;
  acp?: { os_sandbox?: unknown; verified_version?: unknown; acp_input_governance?: unknown } | null;
}

export function seatGovernanceDiagnostics(seats: readonly DiagnosticSeatInput[]): SeatGovernanceDiagnostic[] {
  return seats.map((seat) => {
    const modes = seatGovernanceModes(seat);
    const bound = modes.scoped_bound;
    const pinned = typeof seat.acp?.verified_version === 'string';
    const input_governance =
      bound.mode !== 'admitted' ? 'unenforced' : pinned && seat.version_pin?.matched !== true ? 'claimed' : 'enforced';
    return {
      cli: seat.key,
      enabled_for_council: seat.enabled_for_council !== false,
      transport: seat.acp !== undefined && seat.acp !== null ? 'acp' : 'wrapped',
      os_sandbox: seat.acp?.os_sandbox === true,
      class: bound.class,
      input_governance,
      governance_mode: modes,
    };
  });
}

/** A `/health.warnings` entry (the wire's `HealthWarning`). */
export interface SeatGovernanceWarning {
  kind: 'seats.ungoverned' | 'seats.os-floor-unarmable';
  severity: 'warning';
  message: string;
}

/**
 * The pre-run warnings crew#742 asks for: a seat whose bound-run mode is `none` runs ungoverned;
 * floor seats that rest on the repository boundary on a host with no launcher to arm it
 * (`hostBoundary: null` — no `sandbox-exec` / `bwrap` on PATH) run advisory.
 */
export function seatGovernanceWarnings(seats: readonly SeatGovernanceDiagnostic[], hostBoundary: string | null): SeatGovernanceWarning[] {
  const out: SeatGovernanceWarning[] = [];
  const enabled = seats.filter((s) => s.enabled_for_council);
  for (const s of enabled) {
    if (s.governance_mode.scoped_bound.mode === 'none') {
      out.push({ kind: 'seats.ungoverned', severity: 'warning', message: `seat ${s.cli} runs ungoverned: ${s.governance_mode.scoped_bound.reason}` });
    }
  }
  const boundaryOnly = enabled.filter((s) => s.governance_mode.scoped_bound.source === 'repo_boundary').map((s) => s.cli);
  if (hostBoundary === null && boundaryOnly.length > 0) {
    out.push({
      kind: 'seats.os-floor-unarmable',
      severity: 'warning',
      message:
        `no OS write boundary can arm on this host (no sandbox-exec or bwrap on PATH), so ${boundaryOnly.join(', ')} ` +
        '— whose floor is the engine\'s repository boundary — run advisory: the worktree guard and the command-text fences only',
    });
  }
  return out;
}
