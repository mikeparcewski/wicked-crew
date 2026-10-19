/**
 * The Agents page's readings per seat (DES-seats-page §7, asks A2–A6): what crew can say about a
 * seat's readiness as FACTS and CODES, so studio owns every word (one copy table per code) and
 * never re-derives an engine or crew rule.
 *
 *  - `account` (A2): the account KIND only, never an identifier (`seat-scrub.ts`);
 *  - `recent_bench` (A3): the engine's bench of the seat that is ACTIVE now, not the week's history
 *    (`/roster/record` keeps that);
 *  - `work_admission` (A5): per scope kind, whether a job would give the seat work, with ONE reason
 *    code and where the refusal comes from (`auth`, `launcher`, `scope`). It reads the same standing
 *    the launch does, plus the engine's own worktree bench through `Core.worktreeBenched` (core#920).
 *    Without that predicate (an older addon) it is ABSENT: crew does not restate the engine's rule;
 *  - `qe_reviewer` (A4): whether the seat can run the isolated QE review. Since wicked-core#917 the
 *    engine starts the reviewer as a fresh session on ANY run seat it ADMITS, so the rule is: signed
 *    in, kept by a run bound to one repository (QE runs only there), and admitted by the host's skill
 *    routing to the QE skill (`Core.qeReviewerAdmitted`, wicked-core#923: a Claude-only skills root admits claude
 *    seats only). A reviewer-only seat counts: the engine's reviewer pool is the run's seats, not
 *    its workers. Absent unless the engine answers both predicates;
 *  - `issues` (A6): one entry per thing the page shows, most important first.
 *
 * Pure: no IO, no clock.
 */

import { isContainerSeatFloor } from './seat-container-login.js';
import type { SeatRecentBench } from './seat-health.js';
import type { GovernanceScopeKind, SeatGovernanceMode } from './seat-governance.js';
import type { SeatAccount } from './seat-scrub.js';
import { HOST_FLOOR_BENCH_COPY, homeless, type ChatAdmission, type SeatStanding } from './seat-standing.js';
import type { SeatVersion } from './seat-version.js';

// ── A3 ──────────────────────────────────────────────────────────────────────────────────────────

/** `RosterSeat.recent_bench` (api-types 0.115.0). */
export interface RecentBenchWire {
  /** The engine's cause token (`quota_exhausted`, `not_logged_in`, `not_installed`,
   *  `approval_unavailable`, `timed_out`, …). */
  kind: string;
  /** Runs that benched the seat while this bench was active. */
  runs: number;
  /** ISO-8601 of the latest bench. */
  last_at: string;
  /** ISO-8601 of when crew stops carrying the bench to new launches (sooner on an ok turn). This is
   *  crew's window, not a provider reset time: no provider states one on the wire today. */
  lifts_at: string;
  /** Who benched it in the run: `worker` or `judge`. */
  source: string;
  /** The engine's own reason, verbatim (Technical details). */
  reason: string;
}

/** The engine's cause token: the reason up to its first parenthesis. */
export function benchKind(reason: string): string {
  return reason.split(' (', 1)[0]!.trim();
}

export function recentBenchWire(bench: SeatRecentBench): RecentBenchWire {
  return {
    kind: benchKind(bench.reason),
    runs: bench.runs,
    last_at: bench.at,
    lifts_at: bench.until,
    source: bench.source,
    reason: bench.reason,
  };
}

/** Bench kinds a LIVE sign-in answer disproves: the seat answered an authenticated request, so it is
 *  signed in and has quota. Other kinds (`approval_unavailable`, `not_installed`, `timed_out`) are
 *  about doing work, which a one-word reply does not prove. */
const LIVE_CLEARS: ReadonlySet<string> = new Set(['not_logged_in', 'quota_exhausted', 'usage_limit']);

/** Whether the seat's live sign-in check, answered AFTER the bench, lifts it. */
export function liveCheckLiftsBench(
  bench: SeatRecentBench,
  probe: { signedIn: boolean | null; check: string; probedAt: string } | undefined,
): boolean {
  if (probe === undefined || probe.signedIn !== true || probe.check !== 'live') return false;
  if (!LIVE_CLEARS.has(benchKind(bench.reason))) return false;
  return Date.parse(probe.probedAt) > Date.parse(bench.at);
}

// ── A2 ──────────────────────────────────────────────────────────────────────────────────────────

/** `RosterSeat.account`: absent unless the seat can take a turn on its sign-in. */
export function seatAccount(auth: SeatStanding['auth'], stated: SeatAccount | undefined): SeatAccount | undefined {
  if (auth === 'not_required') return { kind: 'free' };
  if (auth !== 'signed_in') return undefined;
  return stated ?? { kind: 'unknown' };
}

// ── A5 / A4 ─────────────────────────────────────────────────────────────────────────────────────

export type WorkRefusalSource = 'auth' | 'launcher' | 'scope';

/** One reason code per refusal (studio's copy table keys on it). */
export type WorkReasonCode =
  | 'signed_out'
  | 'not_enabled'
  | 'reviewer_only'
  | 'recent_bench'
  | 'login_pending'
  | 'worktree_bench'
  | 'host_floor_bench'
  | 'scope_ungoverned';

export type WorkAdmission = { ok: true } | { ok: false; reason_code: WorkReasonCode; source: WorkRefusalSource; reason: string };

/** `RosterSeat.qe_reviewer` (api-types 0.115.0). */
export type QeReviewerReasonCode = Exclude<WorkReasonCode, 'reviewer_only' | 'scope_ungoverned'> | 'skill_not_admitted';

export type QeReviewer = { ok: true } | { ok: false; reason_code: QeReviewerReasonCode; reason: string };

export interface WorkInputs {
  enabled_for_council?: boolean | undefined;
  seat_eligible_for_work?: boolean | undefined;
  standing: SeatStanding;
  /** The engine's bench crew carries to new launches (`SeatHealthTracker.recentBenchFor`). */
  recentBench: SeatRecentBench | null;
  /** The seat's login check has not answered yet (a launch would wait, then leave it out). */
  loginPending: boolean;
  /** The chat admission per scope kind the roster already serves (ASK-C2). */
  chatAdmission: Record<GovernanceScopeKind, ChatAdmission>;
  /** The engine's worktree bench reason for THIS seat on a bound run, `null` for none. */
  worktreeBench: string | null;
  /** wicked-core#976: the engine's host-floor bench reason for THIS seat (any run), `null` or
   *  absent for none. */
  hostFloorBench?: string | null;
}

/** The host-floor refusal (wicked-core#976), when the engine benches the seat there. */
function hostFloorRefusal(i: WorkInputs): Refusal | null {
  if (typeof i.hostFloorBench !== 'string' || i.hostFloorBench === '') return null;
  return { ok: false, reason_code: 'host_floor_bench', source: 'launcher', reason: HOST_FLOOR_BENCH_COPY };
}

type Refusal = { ok: false; reason_code: WorkReasonCode; source: WorkRefusalSource; reason: string };

/** The refusals every scope shares, in order: the first one is the seat's reason. */
function standingRefusal(i: WorkInputs, opts: { reviewer: boolean }): Refusal | null {
  if (i.standing.auth === 'signed_out') {
    return { ok: false, reason_code: 'signed_out', source: 'auth', reason: i.standing.council_ineligible_reason ?? 'signed out' };
  }
  // crew#916 (wicked-core#572): `enabled_for_council` covers the ballot only. A seat is benched for
  // work only when it has neither role; a ballot-only seat is the `reviewer_only` case below.
  if (i.enabled_for_council === false && i.seat_eligible_for_work === false) {
    return { ok: false, reason_code: 'not_enabled', source: 'launcher', reason: 'not enabled for council or for work, so a launch benches it' };
  }
  if (!opts.reviewer && i.seat_eligible_for_work === false) {
    return { ok: false, reason_code: 'reviewer_only', source: 'launcher', reason: 'a reviewer-only seat: it reviews work and is never given a unit' };
  }
  if (i.recentBench !== null) {
    return { ok: false, reason_code: 'recent_bench', source: 'launcher', reason: i.standing.council_ineligible_reason ?? i.recentBench.reason };
  }
  if (i.loginPending) {
    return { ok: false, reason_code: 'login_pending', source: 'launcher', reason: i.standing.council_ineligible_reason ?? 'login not verified yet' };
  }
  return null;
}

/** `RosterSeat.work_admission` (see the module doc). */
export function workAdmission(i: WorkInputs): Record<GovernanceScopeKind, WorkAdmission> {
  const base = standingRefusal(i, { reviewer: false }) ?? hostFloorRefusal(i);
  const scope = (kind: GovernanceScopeKind): WorkAdmission => {
    if (base !== null) return base;
    if (kind === 'scoped_bound' && i.worktreeBench !== null) {
      return { ok: false, reason_code: 'worktree_bench', source: 'launcher', reason: i.worktreeBench };
    }
    const chat = i.chatAdmission[kind];
    if (!chat.ok && chat.source === 'scope') return { ok: false, reason_code: 'scope_ungoverned', source: 'scope', reason: chat.reason };
    return { ok: true };
  };
  return { unscoped: scope('unscoped'), scoped: scope('scoped'), scoped_bound: scope('scoped_bound') };
}

/** `RosterSeat.qe_reviewer` (see the module doc). `skillAdmitted` is the engine's answer. */
export function qeReviewer(i: WorkInputs, skillAdmitted: boolean): QeReviewer {
  // The QE reviewer turn is governed (it runs as the run's own work), so the host-floor bench holds.
  const r = standingRefusal(i, { reviewer: true }) ?? hostFloorRefusal(i);
  if (r !== null) return { ok: false, reason_code: r.reason_code as QeReviewerReasonCode, reason: r.reason };
  if (i.worktreeBench !== null) return { ok: false, reason_code: 'worktree_bench', reason: i.worktreeBench };
  if (!skillAdmitted) {
    return {
      ok: false,
      reason_code: 'skill_not_admitted',
      reason: "this host's skills root admits only a claude seat to the QE skill (no published portability verdict, or the skill is not portable)",
    };
  }
  return { ok: true };
}

// ── A6 ──────────────────────────────────────────────────────────────────────────────────────────

export type IssueSeverity = 'problem' | 'warning' | 'note';

export interface SeatIssueCommand {
  purpose: 'sign_in' | 'sign_out' | 'version';
  /** The safe rendering: the home directory written `$HOME` (it expands inside the double quotes
   *  the engine puts around the seat's root; `~` would not). The command to RUN stays the roster's
   *  `login_invocation` / `logout_invocation`. */
  display: string;
}

export interface SeatIssue {
  code: string;
  severity: IssueSeverity;
  /** Only names, versions, counts and ISO times — never free text from a CLI. */
  params: Record<string, string | number>;
  /** Crew's own one line, for a client that does not know the code (Technical details). */
  message: string;
  commands?: SeatIssueCommand[];
}

/** Everything the issue list reads, all already computed by the roster accessor. */
export interface IssueInputs {
  key: string;
  display_name: string;
  binary: string;
  login_invocation?: string;
  logout_invocation?: string;
  optIn: boolean;
  standing: SeatStanding;
  version?: SeatVersion;
  governance: Record<GovernanceScopeKind, SeatGovernanceMode>;
  /** `/diagnostics.seatGovernance.hostBoundary`: the OS launcher the repository boundary arms
   *  with, `null` when the host has none. */
  hostBoundary: string | null;
  recentBench: RecentBenchWire | undefined;
  /** wicked-core#976: the engine's host-floor bench reason for the seat (`null`/absent: none). */
  hostFloorBench?: string | null;
  /** wicked-core#976: the sentence when that bench could not be read (fail closed). */
  hostFloorUnknown?: string | null;
  workAdmission?: Record<GovernanceScopeKind, WorkAdmission>;
  qeReviewer?: QeReviewer;
  /** Whether ANY seat on the roster can run QE now (`undefined` when that is not known). */
  rosterQe: boolean | undefined;
  home?: string;
}

const SEVERITY_ORDER: Record<IssueSeverity, number> = { problem: 0, warning: 1, note: 2 };
/** Within a severity: safety before availability (DES-seats-page §4, codex HIER r7). */
const SAFETY_CODES: ReadonlySet<string> = new Set(['unchecked', 'version_unproven', 'fence_scoped']);

/** A command for display: the home directory as `$HOME`. */
export function displayCommand(cmd: string, home?: string): string {
  return homeless(cmd, home, '$HOME');
}

/** `RosterSeat.issues` (A6), most important first. */
export function seatIssues(i: IssueInputs): SeatIssue[] {
  const out: SeatIssue[] = [];
  const name = i.display_name;
  const signIn: SeatIssueCommand[] =
    typeof i.login_invocation === 'string' && i.login_invocation.trim() !== ''
      ? [{ purpose: 'sign_in', display: displayCommand(i.login_invocation.trim(), i.home) }]
      : [];
  const signOut: SeatIssueCommand[] =
    typeof i.logout_invocation === 'string' && i.logout_invocation.trim() !== ''
      ? [{ purpose: 'sign_out', display: displayCommand(i.logout_invocation.trim(), i.home) }]
      : [];
  const add = (code: string, severity: IssueSeverity, message: string, params: Record<string, string | number> = {}, commands: SeatIssueCommand[] = []) => {
    out.push({ code, severity, params, message, ...(commands.length > 0 ? { commands } : {}) });
  };

  const st = i.standing;
  if (st.auth === 'signed_out') {
    add('signed_out', 'problem', `${name} is signed out, so it takes no work until it is signed in`, st.probed_at !== undefined ? { checked_at: st.probed_at } : {}, signIn);
    if (i.rosterQe === false) {
      add('qe_blocked', 'problem', 'no agent can run quality checks now, so jobs that need one wait before delivery', {}, signIn);
    }
  }

  const bench = i.recentBench;
  if (bench !== undefined) {
    const code = bench.kind === 'quota_exhausted' ? 'quota' : bench.kind === 'usage_limit' ? 'usage_limit' : 'benched';
    add(code, 'warning', `the engine benched ${name} (${bench.kind}) in ${bench.runs} run(s); new jobs leave it out until ${bench.lifts_at} or its next good turn`, {
      kind: bench.kind,
      runs: bench.runs,
      last_at: bench.last_at,
      lifts_at: bench.lifts_at,
    });
  }

  // wicked-core#976: from the bench reading itself — whatever refusal leads the admissions.
  if (typeof i.hostFloorBench === 'string' && i.hostFloorBench !== '') {
    add('host_floor', 'warning', `${name} gets no work here: ${HOST_FLOOR_BENCH_COPY}`);
  } else if (typeof i.hostFloorUnknown === 'string' && i.hostFloorUnknown !== '') {
    add('host_floor_unknown', 'warning', `${name}: ${i.hostFloorUnknown}`);
  }

  const bound = i.workAdmission?.scoped_bound;
  if (bound !== undefined && !bound.ok && bound.reason_code === 'worktree_bench') {
    add('codex_worktree', 'warning', `${name} is benched on every job bound to a repository on this host`, {}, [...signOut, ...signIn]);
  }

  // Safety: the bound-run mode decides what holds the seat's writes in a job.
  const gov = i.governance.scoped_bound;
  if (i.version?.status === 'unproven') {
    // crew#1004: say which case it is — the pin's check got no answer, answered in a shape it
    // can't confirm, or answered naming another build. That build is the one the pin's check SAW
    // (`observed`), never `installed`: the two readings are cached apart, so for up to one TTL after
    // an upgrade `installed` still reads the pinned build while the check already saw the new one.
    const v = i.version;
    const message =
      v.why === 'different_build'
        ? `${name} ${v.observed} is not the build its safety checks were proven on (${v.proven}), so they switch off`
        : v.why === 'no_answer'
          ? `${name}'s version check didn't answer, so its safety checks switch off for now`
          : `${name}'s version check answered in a shape its safety checks can't confirm, so they switch off for now`;
    add('version_unproven', 'warning', message, {
      why: v.why,
      ...(v.installed !== null ? { installed: v.installed } : {}),
      proven: v.proven,
      ...(v.why === 'different_build' ? { observed: v.observed } : {}),
    }, [{ purpose: 'version', display: `${i.binary} --version` }]);
  } else if (gov.mode === 'none') {
    add('unchecked', 'warning', `nothing checks ${name}'s actions on this version`, { why: 'no_governance' });
  } else if (gov.source === 'repo_boundary' && i.hostBoundary === null && !isContainerSeatFloor()) {
    add('unchecked', 'warning', `there is no sandbox tool on this computer, so nothing limits what ${name} writes`, { why: 'no_host_boundary' });
  } else if (gov.source === 'repo_boundary' && i.governance.unscoped.mode === 'none') {
    add('fence_scoped', 'warning', `${name}'s writes are kept inside one repository only when the work is bound to it`);
  }

  if (st.auth === 'signed_in' && st.login_check === 'status') {
    add('live_check_failed', 'warning', `${name}'s status command says signed in, but its one live request did not answer`, st.probed_at !== undefined ? { checked_at: st.probed_at } : {}, signIn);
  }

  if (i.optIn) add('opt_in', 'note', `${name} is opt-in: it is left out of new work unless you pick it`);
  if (i.qeReviewer !== undefined && !i.qeReviewer.ok && i.qeReviewer.reason_code !== 'signed_out') {
    add('no_qe', 'note', `${name} can't run quality checks now (${i.qeReviewer.reason_code})`, { reason_code: i.qeReviewer.reason_code });
  }
  if (st.auth === 'signed_in' && st.login_check === 'unverified') {
    add('unverified', 'note', `${name}'s sign-in can't be confirmed: it has no status command`, {}, signIn);
  }

  return out
    .map((issue, idx) => ({ issue, idx }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.issue.severity] - SEVERITY_ORDER[b.issue.severity] ||
        Number(!SAFETY_CODES.has(a.issue.code)) - Number(!SAFETY_CODES.has(b.issue.code)) ||
        a.idx - b.idx,
    )
    .map(({ issue }) => issue);
}
