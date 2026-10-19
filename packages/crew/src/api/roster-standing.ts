/**
 * The ONE roster accessor every launch path shares: the registry roster decorated with crew's
 * STANDING (F-2R2-009) — runtime `health`, `signed_in`, `auth`, `council_eligible` + its reason —
 * so `engineRosterJson` (core/engine-roster.ts) can bench a seat the daemon already knows is
 * unusable before the engine convenes it. (R5b: crew keeps no council bench of its own.)
 *
 * F-RECON-002 / F-RECON-003: this used to be a closure inside `registerRoutes`, so ONLY the routes
 * (`POST /runs`, `/testing/*`, campaigns, steering) launched with standing. The interactive seams
 * (draft/edit/chat/demo subscribers), the adapter's onboarding launch (`seatsForWorkflow`) and
 * `wicked-crew start` handed the engine `CoreAdapter.roster()` RAW — every interactive council
 * convened codex/pi/copilot although the roster reported them `signed_out` (9–19 councilSeatFailed,
 * 57–112 s of dead ballots per run), and one council ELECTED signed-out pi, which then failed its
 * unit and fell over to claude. The factory below is what all of those now call; `createServer`
 * builds exactly one over its `SeatHealthTracker` and hands the same function everywhere.
 *
 * Standing is read at CALL time (the tracker's live state, the LIVE `WICKED_WORKER_HOME`), never
 * captured — a seat signed in from the Agents page is eligible on the very next launch.
 */

import { createRequire } from 'node:module';

import { CoreAdapter } from '../core/adapter.js';
import { defaultLaunchRoster, isOptInSeat } from '../core/opt-in-seats.js';
import type { RosterSeat } from '../core/types.js';
import { hostSandboxLauncher, seatVersionPins, type SeatVersionPinCache } from './diagnostics.js';
import {
  liveCheckLiftsBench,
  qeReviewer,
  recentBenchWire,
  seatAccount,
  seatIssues,
  workAdmission,
  type QeReviewer,
  type WorkAdmission,
} from './seat-agents.js';
import type { SeatHealthTracker } from './seat-health.js';
import { signedInHeuristic } from './seat-signin.js';
import { SeatProbe } from './seat-probe.js';
import { SeatContainerStatus, isContainerLoginCli, isContainerSeatFloor, isHostSeatFloor } from './seat-container-login.js';
import { seatGovernanceModes, type GovernanceScopeKind, type SeatGovernanceMode } from './seat-governance.js';
import { HOST_FLOOR_UNKNOWN_COPY, seatStanding, chatSeatAdmission, type StandingSeat, type SeatStanding } from './seat-standing.js';
import { seatVersion, seatVersions, type SeatVersionCache } from './seat-version.js';

// The adapter loads this same addon module. Keep the optional 0.11.1 static local until the
// adapter's surface catches up; detect it at read time, not when the daemon factory is built.
const require = createRequire(import.meta.url);
const { Core } = require('wicked-core-ts') as {
  Core: { qeReviewersAdmitted?: (seatsJson: string) => Promise<string> };
};
/** `identity` (the registry record's binary / ACP adapter / invocation) keys the memo only: the engine's predicate reads the
 *  live registry record, so a changed binary under the same key is a different seat (codex on #1027). */
/** The addon surface the async QE batch is read from (injectable: the real napi static is not configurable). */
type QeAddon = { qeReviewersAdmitted?: (seatsJson: string) => Promise<string> };
type QeAdmissionSeat = { key: string; invocation?: string; identity?: string };

function nativeQeAdmissionBatch(core: QeAddon = Core): RosterStandingDeps['qeAdmittedBatch'] {
  const batch = core.qeReviewersAdmitted;
  if (typeof batch !== 'function') return null;
  return async (seats) => {
    const rows = JSON.parse(await batch.call(core, JSON.stringify(seats.map(({ key, invocation }) => ({ key, invocation: invocation ?? null }))))) as Array<{ key: string; admitted: boolean }>;
    return new Map(rows.map(({ key, admitted }) => [key, admitted]));
  };
}

/** The accessor: the registry roster WITH crew's standing, freshly read on every call. `ready`
 *  (crew#645), awaited by a launch before it reads the roster, waits — bounded — for every seat's
 *  missing or stale login check, so an expired login reads `signed_out` before work is routed. */
export type RosterWithStanding = (() => RosterSeat[]) & {
  containerStatus?: SeatContainerStatus;
  ready?: () => Promise<void>;
  /** crew#615: re-run one seat's credential probe now (after a sign-in / sign-out terminal). */
  reprobe?: (seatKey: string) => void;
  /** A3b (`GET /roster?refresh=<key>`): re-run one seat's sign-in check now and wait for it, at most
   *  `waitMs`. `probed` — the fresh answer is in; `timed_out` — no fresh answer: still running, or
   *  finished without being able to tell (the read serves the last answer); `not_probed` — the seat
   *  has no sign-in check (pi, copilot, opencode). */
  recheck?: (seatKey: string, waitMs: number) => Promise<RecheckOutcome>;
};

export type RecheckOutcome = 'probed' | 'timed_out' | 'not_probed';

/** A3b: how long `GET /roster?refresh=<key>` waits for the seat's sign-in check — the status
 *  command (about a second) plus its one live request (a CLI start and a one-word reply). Past it
 *  the read answers with the last reading and `timed_out`; the check keeps running. */
export const ROSTER_REFRESH_WAIT_MS = 20 * 1000;

export interface RosterStandingDeps {
  containerStatus?: SeatContainerStatus;
  /** The daemon's per-seat runtime health + council evidence (councilSeatFailed, auth refusals). */
  seatHealth: SeatHealthTracker;
  /** Seat sign-in presence probe — injectable so tests never read the developer's dotfiles.
   *  Defaults to the file/env heuristic in seat-signin.ts. */
  signedIn?: (seatKey: string, workerConfigRoot?: string) => boolean | null;
  /** The registry roster (default: the engine's production roster via `CoreAdapter.roster()`).
   *  Injectable so a test decorates its own seats without the native addon. */
  registry?: () => unknown[];
  /** Where `WICKED_WORKER_HOME` is read from at call time (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** The live seat credential probe (crew#630, `seat-probe.ts`). Default: a real one when neither
   *  `signedIn` nor `registry` is injected (the daemon), none otherwise — a test that fixes the
   *  sign-in reading gets exactly that reading. `null` turns it off. */
  probe?: SeatProbe | null;
  /** The seats' ACP version-pin readings (core#581, `diagnostics.ts`). Default: the daemon's
   *  shared cache under the same rule as `probe`; `null` turns it off. */
  versionPins?: SeatVersionPinCache | null;
  /** (A1) Every seat's `--version` reading (`seat-version.ts`). Default: the daemon's cache under
   *  the same rule as `probe`; `null` turns it off. */
  versions?: SeatVersionCache | null;
  /** (A5, core#920) The engine's worktree bench for a bound run: seat key → reason, or `null` when
   *  the engine cannot answer (an addon before the predicate). Default: `CoreAdapter.worktreeBenched`
   *  under the same rule as `probe`; `null` (or a test that injects a registry) turns it off, and
   *  then `work_admission` and `qe_reviewer` are absent. */
  worktreeBench?: ((engineSeats: readonly unknown[]) => Map<string, string> | null) | null;
  /** (wicked-core#976) The engine's host-floor bench: seat key → reason for every seat the engine
   *  refuses governed work on this host's floor, or `null` when the engine cannot answer. Default:
   *  `CoreAdapter.hostFloorBenched` under the same rule as `worktreeBench`; `null` turns it off. It
   *  is stamped as `host_floor_bench` and read by the chat and work admissions — never by
   *  `council_eligible`, which becomes the engine's `health` and would also bench the seat from
   *  judging and voting, calls the host floor does not refuse. */
  hostFloorBench?: ((engineSeats: readonly unknown[]) => Map<string, string> | null) | null;
  /** (A4) The engine's QE reviewer admission for one seat (`Core.qeReviewerAdmitted`), `null` when
   *  the engine cannot answer. Default under the same rule as `worktreeBench`; without it (or with
   *  `worktreeBench` absent) `qe_reviewer` is absent. */
  qeAdmitted?: ((key: string, invocation: string | undefined) => boolean | null) | null;
  /** crew#1021: whole-roster admission off the daemon thread. The daemon feature-detects the
   *  addon's async static on each read. A null entry/result uses the memoized sync fallback
   *  (older addons block only on a miss); a batch miss serves the seat's last answer or null. */
  qeAdmittedBatch?: ((seats: Array<{ key: string; invocation?: string }>) => Promise<Map<string, boolean>> | null) | null;
  /** crew#1021: the addon the daemon default reads `Core.qeReviewersAdmitted` from at each read (default: wicked-core-ts's `Core`). */
  qeAddon?: QeAddon;
  /** crew#1021: clock for the mutable skills fallback admission memo (30 s). */
  nowMs?: () => number;
  /** (A6) The OS launcher the repository boundary arms with (`hostSandboxLauncher`). */
  hostBoundary?: () => string | null;
  /** (A6) The home directory a command's display writes as `$HOME` (default `os.homedir()`). */
  home?: string;
}

/**
 * Build the accessor. Each seat's registry fields ride through verbatim — the spread is
 * deliberately NOT a field whitelist, which is what lets the engine's `login_invocation` pass
 * untouched — and gains `health`, `signed_in`, and the standing readings (`auth`, `free_tier*`,
 * `council_eligible`, `council_ineligible_reason`, `auth_source/evidence`).
 */
export function rosterWithStandingFactory(deps: RosterStandingDeps): RosterWithStanding {
  const { seatHealth } = deps;
  const signedIn = deps.signedIn ?? signedInHeuristic;
  const registry = deps.registry ?? (() => CoreAdapter.roster());
  const env = deps.env ?? process.env;
  const containerMode = (): boolean => isContainerSeatFloor(env);
  const containerStatus = deps.containerStatus ?? new SeatContainerStatus();
  const probe =
    deps.probe !== undefined ? deps.probe : deps.signedIn === undefined && deps.registry === undefined ? new SeatProbe() : null;
  const versionPins =
    deps.versionPins !== undefined
      ? deps.versionPins
      : deps.signedIn === undefined && deps.registry === undefined
        ? seatVersionPins
        : null;
  const daemon = deps.signedIn === undefined && deps.registry === undefined;
  const versions = deps.versions !== undefined ? deps.versions : daemon ? seatVersions : null;
  const worktreeBench =
    deps.worktreeBench !== undefined ? deps.worktreeBench : daemon ? (seats: readonly unknown[]) => CoreAdapter.worktreeBenched(seats) : null;
  const hostFloorBench =
    deps.hostFloorBench !== undefined ? deps.hostFloorBench : daemon ? (seats: readonly unknown[]) => CoreAdapter.hostFloorBenched(seats) : null;
  // The last host-floor bench the engine answered, with the floor and roster it was read for: a read
  // that fails later keeps it only for that same floor and roster (a seat added or re-pointed since
  // is unknown until the engine answers again).
  let lastHostFloor: { identity: string; bench: Map<string, string> } | null = null;
  const qeAdmitted =
    deps.qeAdmitted !== undefined ? deps.qeAdmitted : daemon ? (key: string, inv: string | undefined) => CoreAdapter.qeReviewerAdmitted(key, inv) : null;
  // Published generations are immutable; the mutable HOME-derived fallback expires after 30 s.
  const nowMs = deps.nowMs ?? Date.now;
  const generationToken = (): string => JSON.stringify([
    env['WICKED_SKILLS_SNAPSHOT'] || undefined, env['CLAUDE_CONFIG_DIR'], env['HOME'], env['USERPROFILE'],
  ]);
  let generation = '';
  const qeMemo = new Map<string, { admitted: boolean | null; at: number }>();
  const qeAdmission = (key: string, invocation: string | undefined, identity = ''): boolean | null => {
    // crew#1021: core filters empty snapshot values and home_dir falls back to USERPROFILE.
    const snapshot = env['WICKED_SKILLS_SNAPSHOT'] || undefined;
    const token = generationToken();
    if (token !== generation) {
      generation = token;
      qeMemo.clear();
    }
    const memoKey = JSON.stringify([key, invocation, identity]);
    const now = nowMs();
    const cached = qeMemo.get(memoKey);
    if (cached !== undefined && (snapshot !== undefined || now - cached.at < 30_000)) return cached.admitted;
    let admitted: boolean | null = null;
    try {
      admitted = qeAdmitted === null ? null : qeAdmitted(key, invocation);
    } catch {
      admitted = null;
    }
    qeMemo.set(memoKey, { admitted, at: now });
    return admitted;
  };
  let batchToken = '';
  let batchEpoch = 0;
  const batchesInFlight = new Set<string>();
  const batchMemo = new Map<string, { admitted: boolean; at: number }>();
  // Served while a refresh is in flight (the token, which carries each seat's identity, triggers it).
  const lastAdmission = new Map<string, boolean>();
  const qeAdmissions = (seats: QeAdmissionSeat[]): Map<string, boolean | null> => {
    const batch = deps.qeAdmittedBatch !== undefined ? deps.qeAdmittedBatch : daemon ? nativeQeAdmissionBatch(deps.qeAddon) : null;
    if (batch != null) {
      const generation = generationToken();
      const token = JSON.stringify([generation, seats]);
      if (token !== batchToken) {
        batchToken = token;
        batchEpoch++;
        batchMemo.clear();
      }
      const now = nowMs();
      const fresh = (key: string): boolean => {
        const cached = batchMemo.get(key);
        return cached !== undefined && (!!env['WICKED_SKILLS_SNAPSHOT'] || now - cached.at < 30_000);
      };
      if (seats.some(({ key }) => !fresh(key)) && !batchesInFlight.has(token)) {
        const epoch = batchEpoch;
        let pending: Promise<Map<string, boolean>> | null;
        try {
          pending = batch(seats.map(({ key, invocation }) => (invocation !== undefined ? { key, invocation } : { key })));
        } catch {
          // A batch failure says nothing; it must never fall back to blocking native work.
          pending = Promise.resolve(new Map());
        }
        if (pending === null) return new Map(seats.map(({ key, invocation, identity }) => [key, qeAdmission(key, invocation, identity)]));
        batchesInFlight.add(token);
        void pending.then((admissions) => {
          // A publish can move the env even without another roster read. Also reject A→B→A
          // completions from an earlier epoch, and results for an obsolete invocation roster.
          if (epoch !== batchEpoch || generation !== generationToken()) return;
          const at = nowMs();
          for (const { key } of seats) {
            const admitted = admissions.get(key);
            if (admitted === undefined) continue;
            batchMemo.set(key, { admitted, at });
            lastAdmission.set(key, admitted);
          }
        }, () => { /* retain the last admission; a later read can retry */ }).finally(() => {
          batchesInFlight.delete(token);
        });
      }
      return new Map(seats.map(({ key }) => [key, batchMemo.get(key)?.admitted ?? lastAdmission.get(key) ?? null]));
    }
    return new Map(seats.map(({ key, invocation, identity }) => [key, qeAdmission(key, invocation, identity)]));
  };
  const hostBoundary = deps.hostBoundary ?? (() => hostSandboxLauncher());
  const liveRoot = (): string | undefined => {
    const workerRoot = env['WICKED_WORKER_HOME'];
    return workerRoot === '' ? undefined : workerRoot;
  };
  const accessor: RosterWithStanding = (): RosterSeat[] => {
    const root = liveRoot();
    const container = containerMode();
    const seats = registry() as RosterSeat[];
    const admissions = qeAdmissions(seats.map((seat) => ({
      key: String(seat.key),
      ...(typeof seat.headless_invocation === 'string' ? { invocation: seat.headless_invocation } : {}),
      identity: JSON.stringify([(seat as { binary?: unknown }).binary ?? null, (seat as { acp?: unknown }).acp ?? null, seat.headless_invocation ?? null]),
    })));
    // A5: one engine call per read — the predicate takes the whole (engine-shaped) registry roster.
    let benchedOnBound: Map<string, string> | null = null;
    try {
      benchedOnBound = worktreeBench === null ? null : worktreeBench(seats);
    } catch {
      benchedOnBound = null; // an engine that cannot answer says nothing, never a guessed bench
    }
    // wicked-core#976: `null` = an addon without the predicate (nothing benched, as before it).
    // A read that FAILS is not "no bench": off the host floor the engine benches nothing, so
    // nothing is missed; on it the last reading stands, and with none every seat's admission is
    // unavailable, said so (fail closed) — never a guessed "admitted".
    let benchedOnHost: Map<string, string> | null = null;
    let hostFloorUnknown: string | null = null;
    if (hostFloorBench !== null) {
      const identity = JSON.stringify([env['WICKED_SEAT_FLOOR'] ?? null, seats]);
      try {
        benchedOnHost = hostFloorBench(seats);
        if (benchedOnHost !== null) lastHostFloor = { identity, bench: benchedOnHost };
      } catch {
        if (!isHostSeatFloor(env)) benchedOnHost = new Map();
        else if (lastHostFloor !== null && lastHostFloor.identity === identity) benchedOnHost = lastHostFloor.bench;
        else hostFloorUnknown = HOST_FLOOR_UNKNOWN_COPY;
      }
    }
    const boundary = hostBoundary();
    const decorated = seats.map((seat) => {
      const key = String(seat.key);
      const health = seatHealth.healthFor(key);
      // crew#630: the seat's own auth-status answer (cached; never awaited here). A probed seat
      // whose probe has not answered yet does not read `signed_in` off its file — a credential
      // file is not a working login (a moved worker home keeps `.claude.json` and loses the
      // keychain token) — it reads `unknown` until the probe answers.
      // Only a seat with a container login reads the broker (agy crew-r1: any other seat keeps its
      // own check rather than waiting forever on a broker reading it can never get).
      const containerSeat = container && isContainerLoginCli(key);
      const broker = containerSeat ? containerStatus.read(key) : undefined;
      const probed = containerSeat
        ? broker === undefined
          ? undefined
          : {
              signedIn: broker.signed_in,
              check: 'status' as const,
              probedAt: broker.probedAt,
              detail: broker.reason ?? `broker credential ${broker.state}`,
            }
        : probe?.read(key, root);
      // A seat's own "no credential" report that its LIVE sign-in check answered AFTER is stale: the
      // operator signed in since (codex r1 on #996 — it otherwise outranked the fresh probe for 30 min).
      if (probed !== undefined && probed.signedIn === true && probed.check === 'live') {
        seatHealth.clearAuthFailureBefore(key, Date.parse(probed.probedAt));
      }
      const authFailure = seatHealth.authFailureFor(key);
      // A3: an account bench (signed out, out of quota) the seat's own LIVE sign-in check disproved
      // after it landed is lifted here, as an ok turn would lift it.
      let recentBench = seatHealth.recentBenchFor(key);
      if (recentBench !== null && liveCheckLiftsBench(recentBench, probed)) {
        seatHealth.clearRecentBench(key);
        recentBench = null;
      }
      const heuristic = containerSeat ? null : signedIn(key, root);
      const signed =
        containerSeat
          ? broker?.signed_in ?? null
          : probed !== undefined && probed.signedIn !== null
            ? probed.signedIn
            : probe?.probes(key) === true && heuristic === true
              ? null
              : heuristic;
      // (R5b, DES-L3 PR-3D) No crew-side council bench any more: the engine's per-run ballot ledger
      // (`session.benched_seats`) is the one bench, so there is no bench reading to pass and no
      // health reading to weigh — the roster's standing is the auth picture alone.
      const standing = seatStanding(
        seat as { key: string; enabled_for_council?: boolean; seat_eligible_for_work?: boolean; credential?: string; free_tier?: string },
        signed,
        // F-A45-006: the seat's OWN "no credential" report (a ballot's "No API key found", a
        // worker's 401, an auth ACP fallback) overrides the file probe — `auth` flips, not only
        // `council_eligible`, and the evidence rides on the wire.
        authFailure,
        probed ?? (containerSeat || probe?.probes(key) === true ? 'pending' : undefined),
        // The engine's own in-run bench of the seat, carried to this launch for a bounded window
        // (`seatBenched`, SEAT_BENCH_WINDOW_MS): a seat that reads signed in but refused its work
        // in a recent run is benched up front instead of being handed a unit again.
        recentBench,
      );
      // F-W1-005 (wave-1 P6): the chat admission verdict the daemon itself applies when `POST /chats`
      // picks its default seats — the SAME `chatSeatAdmission` call, for both scope modes — so the
      // studio's picker offers exactly the seats an open would seat, from one source of truth (no
      // client-side copy of the rule). Additive on the wire (`RosterSeat` index signature until
      // api-types 0.39.0 types it).
      const hostFloor = benchedOnHost?.get(key) ?? null;
      const standingSeat = {
        ...(seat as unknown as StandingSeat),
        ...(hostFloor !== null ? { host_floor_bench: hostFloor } : {}),
        ...(hostFloorUnknown !== null ? { host_floor_unknown: hostFloorUnknown } : {}),
        // crew#1071: an ask does not seat a seat under the engine's active bench.
        ...(recentBench !== null ? { recent_bench: recentBenchWire(recentBench) } : {}),
      };
      // core#581: a pinned seat whose binary no longer matches the build its ACP admission was
      // proven against says so here (read from the cache; a stale cache refreshes in the
      // background). Absent for an unpinned seat and until the first probe answers.
      const versionPin = versionPins?.read(key);
      // IG1-crew-1: the mode each scope kind runs this seat under, read from the engine's
      // `governance_class` plus the pin reading above (seat-governance.ts).
      const governanceMode = seatGovernanceModes({
        ...(seat as { key: string }),
        key,
        ...(versionPin !== undefined ? { version_pin: versionPin } : {}),
      });
      const govSeat = { ...standingSeat, ...(versionPin !== undefined ? { version_pin: versionPin } : {}) };
      const chatAdmission = {
        unscoped: chatSeatAdmission(govSeat, standing.auth, false, 'path'),
        scoped: chatSeatAdmission(govSeat, standing.auth, true, 'path'),
        scoped_bound: chatSeatAdmission(govSeat, standing.auth, true, 'path-bound'),
      };
      // A1: every seat's installed version, beside the pin reading.
      const version = seatVersion(seat as { acp?: { verified_version?: unknown } | null }, versions?.read(key), versionPin);
      const account = seatAccount(standing.auth, probed?.account);
      // A4: the engine's QE skill admission for this seat (`null` when it cannot answer).
      const skillAdmitted = admissions.get(key) ?? null;
      // A4 / A5: only when the engine can say whether it benches the seat on a bound run.
      // …and whether it benches it on the host floor: unread there, the admissions are absent.
      const inputs =
        benchedOnBound === null || hostFloorUnknown !== null
          ? null
          : {
              enabled_for_council: (seat as { enabled_for_council?: boolean }).enabled_for_council,
              seat_eligible_for_work: (seat as { seat_eligible_for_work?: boolean }).seat_eligible_for_work,
              standing,
              recentBench,
              loginPending: probed === undefined && (containerSeat || probe?.probes(key) === true) && authFailure === null,
              chatAdmission,
              worktreeBench: benchedOnBound.get(key) ?? null,
              hostFloorBench: hostFloor,
            };
      return {
        ...seat,
        health,
        signed_in: signed,
        ...(containerSeat ? { sign_in: 'container' as const } : {}),
        ...(hostFloor !== null ? { host_floor_bench: hostFloor } : {}),
        ...(hostFloorUnknown !== null ? { host_floor_unknown: hostFloorUnknown } : {}),
        ...(versionPin !== undefined ? { version_pin: versionPin } : {}),
        ...standing,
        // ASK-C2: the admission an ASK applies (every chat is a path after ASK-C1): `unscoped` =
        // standing only; `scoped` = the wider-scope rule (several repos / a project); `scoped_bound` =
        // a single-repo ask (bound run — standing only). The picker offers from these.
        governance_mode: governanceMode,
        chat_admission: chatAdmission,
        ...(version !== undefined ? { version } : {}),
        ...(account !== undefined ? { account } : {}),
        ...(recentBench !== null ? { recent_bench: recentBenchWire(recentBench) } : {}),
        ...(inputs !== null ? { work_admission: workAdmission(inputs) } : {}),
        ...(inputs !== null && skillAdmitted !== null ? { qe_reviewer: qeReviewer(inputs, skillAdmitted) } : {}),
      };
    });
    // A6: the issues read the whole roster once — can any seat a DEFAULT launch holds run QE now?
    // The default launch roster leaves opt-in seats out unless they are all it could convene
    // (`defaultLaunchRoster`), so this follows the same rule (codex r1 on #996).
    const qeKnown = decorated.some((s) => s.qe_reviewer !== undefined);
    const rosterQe = !qeKnown ? undefined : defaultLaunchRoster(decorated).some((s) => (s.qe_reviewer as QeReviewer | undefined)?.ok === true);
    return decorated.map((s) => ({
      ...s,
      issues: seatIssues({
        key: String(s.key),
        display_name: typeof s.display_name === 'string' ? s.display_name : String(s.key),
        binary: typeof s.binary === 'string' ? s.binary : String(s.key),
        ...(typeof s.login_invocation === 'string' ? { login_invocation: s.login_invocation } : {}),
        ...(typeof s.logout_invocation === 'string' ? { logout_invocation: s.logout_invocation } : {}),
        optIn: isOptInSeat(s.key),
        standing: s as unknown as SeatStanding,
        ...(s.version !== undefined ? { version: s.version } : {}),
        governance: s.governance_mode as Record<GovernanceScopeKind, SeatGovernanceMode>,
        hostBoundary: boundary,
        recentBench: s.recent_bench,
        hostFloorBench: typeof s.host_floor_bench === 'string' ? s.host_floor_bench : null,
        hostFloorUnknown: typeof s.host_floor_unknown === 'string' ? s.host_floor_unknown : null,
        ...(s.work_admission !== undefined ? { workAdmission: s.work_admission as Record<GovernanceScopeKind, WorkAdmission> } : {}),
        ...(s.qe_reviewer !== undefined ? { qeReviewer: s.qe_reviewer as QeReviewer } : {}),
        rosterQe,
        ...(deps.home !== undefined ? { home: deps.home } : {}),
      }),
    }));
  };
  accessor.containerStatus = containerStatus;
  if (probe !== null || containerMode()) {
    accessor.ready = async () => {
      let keys: string[];
      try {
        keys = (registry() as RosterSeat[]).map((s) => String(s.key));
      } catch {
        return; // no roster: the launch reads (and reports) the same failure itself
      }
      if (containerMode()) {
        await Promise.all(keys.filter(isContainerLoginCli).map((key) => containerStatus.refresh(key)));
      } else {
        await probe?.ensureFresh(keys, liveRoot());
      }
    };
    accessor.reprobe = (seatKey: string) => {
      if (containerMode()) {
        containerStatus.invalidate(seatKey);
        void containerStatus.refresh(seatKey);
      } else {
        void probe?.refresh(seatKey, liveRoot());
      }
    };
    accessor.recheck = async (seatKey: string, waitMs: number): Promise<RecheckOutcome> => {
      if (containerMode()) {
        if (!isContainerLoginCli(seatKey)) return 'not_probed';
        containerStatus.invalidate(seatKey);
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<'timed_out'>((resolve) => {
          timer = setTimeout(() => resolve('timed_out'), waitMs);
          timer.unref();
        });
        const outcome = await Promise.race([containerStatus.refreshFresh(seatKey).then(() => 'probed' as const), deadline]);
        clearTimeout(timer);
        return outcome;
      }
      if (probe === null) return 'not_probed';
      if (!probe.probes(seatKey)) return 'not_probed';
      const deadlineAt = Date.now() + waitMs;
      // `probed` must describe the worker home the answer is READ under: if `worker_config_root`
      // changed while the check ran, check the new home too, inside the same bound (codex r1 #996).
      for (let root = liveRoot(); ; ) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return 'timed_out';
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<'timed_out'>((resolve) => {
          timer = setTimeout(() => resolve('timed_out'), remaining);
          timer.unref();
        });
        // A check that could not tell (its status command timed out) is not a fresh answer: the roster
        // keeps showing the last one, which is what `timed_out` says.
        const done = probe.refreshFresh(seatKey, root).then((r) => (r === undefined || r.signedIn === null ? ('timed_out' as const) : ('probed' as const)));
        const outcome = await Promise.race([done, deadline]);
        clearTimeout(timer);
        if (outcome === 'timed_out') return outcome;
        const now = liveRoot();
        if (now === root) return 'probed';
        root = now;
      }
    };
  }
  // Warm the probe at boot, so the first launch after a restart already routes on the seat's own
  // answer (a probe runs in the background; the roster read itself never waits on one).
  if (probe !== null) {
    setImmediate(() => {
      try {
        accessor();
      } catch {
        /* no roster yet: the first real read probes */
      }
    }).unref();
  }
  return accessor;
}
