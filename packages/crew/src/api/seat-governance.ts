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

import { isContainerSeatFloor } from './seat-container-login.js';

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
  /** The headless invocation the engine launches (its first token is the executable). */
  headless_invocation?: unknown;
  binary?: unknown;
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

/** The CLI that actually runs for `seat` (C5, codex c5-crew-r3): the executable of its headless
 *  invocation (quote-aware first token), else its binary, else its key — basename, lower-case, no
 *  extension — as the engine resolves it, so a `claude` seat running `pi` is judged as pi. */
export function runRoot(seat: GovernanceSeatInput): string {
  const inv = typeof seat.headless_invocation === 'string' ? seat.headless_invocation.trim() : '';
  let exe = '';
  if (inv !== '') {
    const m = /^"([^"]*)"|^'([^']*)'|^(\S+)/.exec(inv);
    exe = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
  }
  if (exe === '' && typeof seat.binary === 'string') exe = seat.binary;
  if (exe === '') exe = seat.key.split('#')[0] ?? seat.key;
  const base = exe.split(/[\\/]/).pop() ?? exe;
  return base.replace(/\.(exe|cmd|bat|mjs|js)$/i, '').toLowerCase();
}

function fenceFor(scope: GovernanceScopeKind, roots: GovernanceFenceRoots): SeatGovernanceFence {
  if (scope === 'scoped_bound') {
    const worktree = roots.worktree ?? WORKTREE_LABEL;
    return { write_roots: [worktree, ...(roots.extraWriteRoots ?? [])], read_roots: [worktree], network: 'open' };
  }
  return { write_roots: [], read_roots: scope === 'scoped' ? [SCOPE_LABEL] : [], network: 'open' };
}

/**
 * The mode a seat runs under for a scope kind (C5, matching wicked-core#950).
 *
 *  - Container floor (the default): claude reads `admitted` (its gate hook inside the seat
 *    container); every other seat reads `os_sandbox` / `repo_boundary` (the seat container).
 *  - Interim host floor: claude reads `admitted` (its gate hook); codex reads `os_sandbox` /
 *    `self` only with its own bounded `--sandbox`; every other seat reads `none` (the engine
 *    refuses its governed work: `needs_container_floor`). Class `none` or no class reads `none`.
 */
export function seatGovernanceMode(
  seat: GovernanceSeatInput,
  scope: GovernanceScopeKind,
  roots: GovernanceFenceRoots = {},
): SeatGovernanceMode {
  const cls = asClass(seat.governance_class);
  const fence = fenceFor(scope, roots);
  const none = (reason: string): SeatGovernanceMode => ({ mode: 'none', class: cls, source: 'none', reason, fence });
  // C5: under the container floor (the default) no seat runs over ACP; what holds a governed unit
  // is its seat container, plus claude's gate hook — never an ACP adapter's permission channel.
  if (isContainerSeatFloor()) {
    if (runRoot(seat) === 'claude') {
      return {
        mode: 'admitted',
        class: cls,
        source: 'acp_input_governance',
        reason:
          "its gate hook judges every tool call (a blocking HTTP hook through the model gateway), inside a hardened seat container that mounts only the run's worktree",
        fence,
      };
    }
    return {
      mode: 'os_sandbox',
      class: cls,
      source: 'repo_boundary',
      reason:
        "the container floor holds it: a hardened seat container that mounts only the run's worktree, with the model gateway as its only egress — not a per-call gate",
      fence,
    };
  }
  if (cls === null) {
    return none('the engine reported no governance class for this seat, so nothing is claimed to fence its tool calls');
  }
  const rootKey = runRoot(seat);
  if (cls === 'none') {
    return none(
      rootKey === 'codex'
        ? `the engine names its governance class none: codex runs with its own sandbox off (no bounded \`--sandbox\` in its trust flags, or the bypass flag), and ${CODEX_NO_ADAPTER} — only the command-text fences apply`
        : 'the engine names its governance class none (its record sets `governance_floor = false`) — only the command-text fences apply',
    );
  }
  // C5, the interim host floor — exactly wicked-core#950's rule (agy c5-crew-r1): ACP is gone from
  // the seats, so a governed unit runs only on claude (its gate hook) or on codex in its own bounded
  // sandbox; the engine refuses every other seat's governed work (needs_container_floor).
  if (rootKey === 'claude') {
    return {
      mode: 'admitted',
      class: cls,
      source: 'acp_input_governance',
      reason: 'its gate hook judges every tool call on the headless carrier (interim host floor)',
      fence,
    };
  }
  if (rootKey === 'codex') {
    const own = ownSandboxMode(seat.trust_flags);
    if (own !== null) {
      return {
        mode: 'os_sandbox',
        class: cls,
        source: 'self',
        reason: `codex runs under its own \`--sandbox ${own}\`, and ${CODEX_NO_ADAPTER}, so it stays on the OS-sandbox floor — not a per-call gate`,
        fence,
      };
    }
    return none(
      `codex runs without its own bounded \`--sandbox\`, and ${CODEX_NO_ADAPTER}; on the interim host floor the engine refuses its governed work (needs_container_floor)`,
    );
  }
  return none(
    'its tool calls were checked over ACP, which is removed from the seats; on the interim host floor the engine refuses its governed work (needs_container_floor) — run the container floor',
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
      // C5: every seat runs its CLI's headless mode (the wrapped carrier); `acp` is legacy metadata.
      transport: 'wrapped',
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
  // Under the container floor the seat container is the boundary, not the host's sandbox-exec /
  // bwrap (codex c5-crew-r1).
  if (hostBoundary === null && boundaryOnly.length > 0 && !isContainerSeatFloor()) {
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
