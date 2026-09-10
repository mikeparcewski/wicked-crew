/**
 * wicked-crew-api-types — the wire contract of the wicked-crew daemon.
 *
 * One definition of every shape that crosses the daemon's HTTP/WS boundary:
 * the `/api/v1` JSON responses and request bodies, and the CoreEvent frames
 * delivered verbatim over `/ws`. BOTH sides compile against this package —
 * the daemon's route layer (via `packages/crew/src/core/types.ts`, which
 * re-exports it) and the studio SPA (via `packages/studio/src/api/types.ts`,
 * likewise a re-export) — replacing the hand-copied mirror the studio used to
 * carry, which could drift from the daemon silently (task #84).
 *
 * Rules of this package:
 * - WIRE SHAPES ONLY. Engine-internal types (`LaunchRunInput`,
 *   `RepoOnboardRef`, runtime constants) stay in `packages/crew/src/core/types.ts`.
 * - ZERO RUNTIME. This is a `.d.ts`-only package with no JavaScript; import it
 *   with `import type` exclusively. The `exports` map deliberately offers only
 *   a `types` condition, so a value import fails loudly at resolution time.
 * - FORWARD-ADDITIVE. Optional/index-signature fields keep the shapes additive:
 *   a newer daemon that adds fields still parses in an older studio, and new
 *   CoreEvent variants pass through event switches untouched (DES-STUDIO-001
 *   §5.1). No `any` at the boundary — unknown-typed fields are narrowed at use.
 *
 * The shapes mirror wicked-core's serde representation (wicked-core/src/domain.rs,
 * repo.rs, scope.rs) — the daemon passes most of them through verbatim.
 * Drift guard: `packages/crew/tests/wire-contract.test.ts` fails to compile if
 * the daemon's produced types stop satisfying this contract.
 */

// ── Identity / actor contract (task #88, locked decision #6) ───────────────────

/** What kind of principal an actor is: a person (OAuth/OIDC or local operator), a workload, or an internal process. */
export type ActorKind = 'human' | 'agent' | 'system';

/**
 * The minimal trust ladder: `admin` > `operator` > `observer`.
 *
 * - `observer` — read-only: every GET, and the `/ws` event stream.
 * - `operator` — does the work: launch/steer/cancel runs, answer gates and
 *   elicitations, open chats and terminals, register repos and workflows.
 * - `admin` — governs the system: governance writes (policies/rules),
 *   settings writes, and project archive/restore.
 *
 * Deliberately minimal and enumerated here rather than per-route: unknown
 * mutating routes default to `operator`, reads to `observer` (docs/auth.md).
 */
export type TrustLevel = 'observer' | 'operator' | 'admin';

/**
 * The ONE actor shape every authenticated (or implicitly local) request carries
 * — replacing free-text actor strings, which any caller could spoof. In local
 * no-auth mode every request acts as `{id:"local", kind:"human", trust:"admin"}`
 * (full trust), so downstream consumers never branch on "was there auth".
 */
export interface Actor {
  /** Stable principal id (token-file `actor.id`, or an OIDC subject once that seam lands). */
  id: string;
  kind: ActorKind;
  trust: TrustLevel;
}

/** `GET /whoami` — the actor this request authenticated as, and the daemon's auth mode. */
export interface WhoAmI {
  actor: Actor;
  /** `required` (team/hosted: bearer token mandatory) | `off` (local loopback default). */
  authMode: 'required' | 'off';
}

/**
 * One line of the daemon's append-only audit trail (`GET /audit`): who did what,
 * to which run, when. Written crew-side because the engine's `LaunchOptions`
 * carries no actor field — this is the system of record for "who approved that
 * gate" / "who launched that run".
 */
export interface AuditEntry {
  /** Unix millis. */
  ts: number;
  /** Dotted verb, e.g. `run.launched`, `gate.decided`, `governance.policy.upserted`. */
  action: string;
  actor: Actor;
  /** The run the action addressed, when it addressed one. */
  runId?: string;
  /** Action-specific fields (`approve`, `amend`, ids, …). */
  detail?: Record<string, unknown>;
  [k: string]: unknown;
}

/** `GET /audit` — newest first, filterable by `?runId=` / `?action=` / `?limit=`. */
export interface AuditPage {
  entries: AuditEntry[];
}

/** Run-level lifecycle status (`SessionStatus`, snake_case serde token). */
export type SessionStatus =
  | 'planning'
  | 'distributing'
  | 'executing'
  | 'awaiting_human'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Per-unit lifecycle status (`UnitStatus`). */
export type UnitStatus = 'pending' | 'distributed' | 'done' | 'rejected';

/** The methodology stage badge on a unit (`StageKind`). */
export type StageKind = 'recon' | 'build' | 'review' | 'test';

/** Collection-scope mode (`EntityMode`). */
export type EntityMode = 'shared' | 'isolated';

/** Human-confirm gate policy. serde: `None`→"none", `All`→"all", `Before(n)`→{ before: n }. */
export type HumanConfirm = 'none' | 'all' | { before: number };

/** Why a CLI was assigned to a unit (`RoutingInfo`, internally tagged on `method`). */
export type RoutingInfo =
  /**
   * `seated` is the seats CONVENED — the denominator `returned` must be read against.
   * Unknown on a run recorded by an engine older than the quorum fix; unknown means exactly that,
   * never "equal to `returned`" (FINDING-026 D).
   *
   * `number | null` AND optional because unknown arrives in both shapes and neither is under this
   * file's control: the engine serializes the artifact's `Option<u32>` as an explicit `null` (no
   * `skip_serializing_if`, so the routing artifact and the event stream agree on one spelling of
   * unknown), while a payload from before the field existed at all simply has no key. Read it with
   * `== null`, which covers both — `=== undefined` silently misses the null case, which is the one
   * the live API actually sends.
   */
  | {
      method: 'council';
      winner: string;
      agreement_pct: number;
      returned: number;
      seated?: number | null;
      dissent: number;
    }
  | { method: 'degraded'; reason: string }
  | { method: 'evaluator_distinct'; winner: string; was: string }
  | { method: 'tool' };

/** A run (`AgentSession`). */
export interface AgentSession {
  id: string;
  workflow_id: string;
  problem: string;
  entity_mode: EntityMode;
  collection_scope: string | null;
  clis: string[];
  status: SessionStatus;
  human_confirm: HumanConfirm;
  unit_ix: number;
  attempt: number;
  workdir: string | null;
  repo_ref: string | null;
  /** Launcher-declared extra write roots for the run's deliverables (wicked-core#259). */
  extra_write_roots: string[];
  /**
   * When the operator ARCHIVED this run (crew#265) — a write-off, not a delete: the run stays
   * fully readable but default run listings exclude it. Unix millis; `null` = live. Guard with
   * `== null` (the live API sends `null`, never omits the key).
   */
  archived_at: number | null;
  /** Optional operator note recorded at archival. */
  archive_note: string | null;
  /**
   * The project this run is filed into (DES-UX-001 §8.2, CREW-UX-2; api-types 0.8.0) —
   * populated by the crew server from the membership record at DTO assembly on BOTH
   * `GET /runs` and `GET /runs/:id`, so clients no longer re-derive the run→project join.
   *
   * `null` = genuinely unfiled (the synthesized `default` project); ABSENT = a pre-0.8.0
   * server that never joins. Read with `== null` only if "unfiled" and "old server" may
   * collapse for your surface; a project chip should render only on `typeof === 'string'`.
   */
  project_id?: string | null;
  /**
   * Retry lineage (DES-UX-001 §8.3, CREW-UX-3; api-types 0.8.0): the id of the run this run
   * was launched as a retry of (`LaunchRunBody.retryOf`, validated at launch to name an
   * existing run). ABSENT — never `null` — when the run is not a retry: absence is the one
   * spelling of "no lineage", so `'retry_of' in session` and `!== undefined` agree.
   */
  retry_of?: string;
  /**
   * Durable operator guidance (DES-UX-002 §7.2 — spec'd there as CREW-UX-4, shipped as
   * CREW-UX-7; api-types 0.9.0): the ONE pre-gate note upserted via `PUT /runs/:id/guidance`,
   * populated at DTO assembly on both `GET /runs` and `GET /runs/:id`. ABSENT — never `null`
   * or `''` — when no note is set (never set, cleared, or a pre-0.9.0 server), so old clients
   * are unaffected and `'guidance' in session` and `!== undefined` agree.
   *
   * Operator-visible context ONLY: the governance gate never reads this field; the amend text
   * at gate decision (`GateDecision.amend`) remains the one injection point. Skins use it to
   * pre-populate the steer textarea when a gate arrives.
   */
  guidance?: string;
  /**
   * The run's delivery state (crew#393; api-types 0.18.0) — derived at DTO assembly on BOTH
   * `GET /runs` and `GET /runs/:id`, so a run whose reviewable work is sitting uncommitted in
   * its worktree can no longer look identical to one that delivered or had nothing to deliver:
   *
   *   - `'delivered'` — a PR was opened for this run (by the deliver phase, or post-hoc via
   *     `POST /runs/:id/deliver`); `deliverUrl` carries the PR URL.
   *   - `'stranded'`  — reviewable work nobody lifted, reached two ways: a COMPLETED repo-scoped
   *     run with no recorded PR whose worktree still exists on disk AND carries work (derived
   *     honestly for OLD runs too — records written before this field existed strand the same
   *     way); OR (crew#418) a run whose deliver phase hit a LIFT collision — a rebase conflict or
   *     non-fast-forward push — which the daemon reinterprets from the engine's `failed` to
   *     `completed`+`stranded`: its work is committed on the `wicked/<id>` branch (the engine
   *     reaps the now-clean worktree, but never the branch), recoverable via `POST /runs/:id/
   *     deliver`, which stands a throwaway worktree back up from that branch to lift it.
   *   - `'vacuous'`   — a COMPLETED repo-scoped run whose surviving worktree carries NO
   *     contribution at all (crew#311: nothing uncommitted, no run-branch commit — units all
   *     reached "done" while producing nothing). There is nothing to deliver; the recovery is a
   *     retry launch (`POST /runs {"retryOf":"<id>"}`). Never silently green: this is the loud
   *     spelling of the vacuous-completion class. Derived with the same two read-only git
   *     instruments the engine's own evidence floor uses; any probe failure keeps `'stranded'`
   *     (vacuity is only ever asserted on positive reads).
   *   - `'none'`     — everything else: repo-less runs, non-terminal runs, failed/cancelled
   *     runs, and completed runs whose worktree is gone.
   *
   * Always present on runs served by a 0.18.0+ daemon; absent only from an older server.
   *
   * ⚠ WIRE RESHAPE (0.17.0 → 0.18.0, NOT additive): 0.11.0–0.17.0 spelled this field as
   * `delivery?: { kind: 'pull_request'; url: string }`. The object form is GONE — the state
   * moved into this string and the URL into `deliverUrl`. A client reading `delivery?.url`
   * must move to `deliverUrl`.
   *
   * FAILURE of a deliver phase is not spelled here; it is `units[].status === 'rejected'`
   * plus `denial_reason` (crew#318's message), both already on the list wire.
   */
  delivery?: 'delivered' | 'stranded' | 'vacuous' | 'none';
  /**
   * The delivered PR's URL (crew#393; api-types 0.18.0) — present exactly when
   * `delivery === 'delivered'`; absent otherwise (absence is the one spelling, never `null`).
   *
   * KNOWN LIMIT (inherited from 0.11.0): runs that delivered before a 0.11.0 daemon first saw
   * their terminal frame have no durable `run.delivered` audit entry — they read as
   * `'stranded'` while their worktree survives (post-hoc `POST /runs/:id/deliver` is
   * idempotent against the existing branch) and `'none'` after it is cleaned up.
   */
  deliverUrl?: string;
  /**
   * The campaign this AD-HOC run was attached to at launch (`LaunchRunBody.campaignId`;
   * wicked-studio#27, api-types 0.19.0) — daemon-joined at DTO assembly on `GET /runs` and
   * `GET /runs/:id` from the launch record (audit trail), so it survives a daemon restart.
   * ABSENT — never `null` — when the run was not attached (absence is the one spelling).
   *
   * NOT set on a campaign's own DAG-node runs: those are correlated through
   * {@link Campaign.node_run_id} (their run ids are `{campaign}:{node}:a{attempt}`), and a
   * caller-chosen `sessionId` may legally contain `:`, so id-shape parsing is unsound — read
   * membership from the campaign, not from this field or the id.
   */
  campaign_id?: string;
  /**
   * The ad-hoc group label this run was launched under (`LaunchRunBody.groupLabel`;
   * wicked-studio#27, api-types 0.19.0) — daemon-joined like {@link AgentSession.campaign_id}.
   * ABSENT when the run is ungrouped. Runs sharing a label form one `RunGroup` on
   * `GET /campaigns`.
   */
  group_label?: string;
  /**
   * When this run was LAUNCHED — unix SECONDS (home command-center run metrics; api-types 0.24.0).
   * Daemon-derived at DTO assembly on BOTH `GET /runs` and `GET /runs/:id` from the `run.launched`
   * audit entry's timestamp (the daemon's durable system-of-record for run provenance — task #88),
   * joined exactly like {@link retry_of} / {@link guidance} and hydrated from the SAME trail scan
   * at boot, so it survives a daemon restart.
   *
   * This is the ONE launch instant the daemon records: "created" and "started" are the SAME event
   * here — the engine's `AgentSession` (wicked-core `domain.rs`) carries no launch time, so there
   * is no separate queued-vs-started split to expose. Unlocks time-bucketed KPI deltas and a real
   * 7/30/90-day range on the home dashboard.
   *
   * ABSENT — never `null`, never fabricated — when the daemon has no `run.launched` entry for the
   * run: a run launched OFF the `POST /runs` path (a repo's onboarding run, a campaign's own
   * DAG-node runs), a run predating this field, or a `--db`-isolated daemon reading a trail that
   * never saw the launch. Read with `typeof === 'number'`; a bucketed KPI or a 7/30/90-day range
   * must EXCLUDE an undated run, never date it with a fabricated now.
   *
   * COST (deferred, not faked): a per-run cost/spend figure is deliberately NOT joined onto this
   * DTO. Cost exists only on the per-unit {@link CliUsageEvent} (`costUsd`), streamed over `/ws`
   * and never accumulated per run daemon-side — a reliable per-run total would require replaying
   * the durable event log per run on this hot path (the unbounded cost the GET /runs delivery-cache
   * architecture forbids) or a new live cliUsage accumulator plus a durable per-run store. A burn
   * chart should sum `cliUsage.costUsd` from the live `/ws` stream (or `GET /runs/:id/events`) for
   * now; a joined `AgentSession.cost` is a follow-up once that store exists.
   */
  created_at?: number;
}

/** An ordered unit of work within a run (`WorkUnit`). */
export interface WorkUnit {
  id: string;
  session_id: string;
  ord: number;
  description: string;
  stage: StageKind;
  assigned_cli: string | null;
  assigned_invocation: string | null;
  council_task_ref: string | null;
  routing: RoutingInfo | null;
  denial_reason: string | null;
  phase_ref: string | null;
  conformance_ref: string | null;
  phase_status: string | null;
  collection_scope: string | null;
  status: UnitStatus;
  skill_ref?: string | null;
  /** The command this unit runs directly (Tool-executor phases). `null`/absent for Agent units. */
  tool_cmd?: string[] | null;
  /** Evaluator≠creator role. Present on def-driven units; absent on legacy/free-text. */
  role?: PhaseRole;
  /** Gate policy for this phase. Present on def-driven units; absent on legacy/free-text. */
  gate?: GateSpec | string;
  /** True when a pinned deterministic validator is attached to this unit. */
  has_validator_pin?: boolean;
  /**
   * True when this unit's backing phase declared `executes_code` (crew#311 / core#297 §2) —
   * carried from the def at plan time. The engine's code-evidence floor holds such a unit to a
   * worktree diff: a governed Creator unit with this flag cannot fold "done" over an untouched
   * worktree. Additive and skip-if-false on the wire: absent on non-code units, on units planned
   * before the field existed, and on an older engine.
   */
  executes_code?: boolean;
}

/** A run plus its ordered units (`SessionView`) — the shape `GET /runs` returns. */
export interface SessionView {
  session: AgentSession;
  units: WorkUnit[];
}

/** A registered git repository (`RepoEntry`). */
export interface RepoEntry {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  registered_at: number;
  /** Remote git URL the repo was cloned from (undefined for locally-registered repos). */
  git_url?: string;
  /**
   * ABSOLUTE path of this repo's code graph, resolved by the engine (wicked-core#170).
   *
   * Optional in the TYPE, mandatory in practice: an addon predating the field omits it, and
   * `codeGraphDb()` in the daemon's `repoPaths.ts` is where that turns into a loud error. Never
   * join this path yourself — six independent spellings is what FINDING-069 was.
   */
  code_graph_db?: string;
}

/** The run id of the onboarding run launched when a repo was registered (`GET /repos/:id/onboard`). */
export interface OnboardRef {
  runId: string | null;
}

/**
 * Runtime health of one council seat (crew#274).
 *
 * Derived by the daemon from the live CoreEvent stream — NEVER from config. The roster is
 * declarative: every configured CLI stays listed and enabled in `clis.toml`; quota/auth/runtime
 * errors are runtime state the platform detects and displays as `inactive` + the error excerpt.
 * Recovery is automatic: a captured-ok unit output for the seat, or an exit-0 `version_probe`
 * from the daemon's low-frequency recovery probe, flips the seat back to `active` and clears
 * the message — no operator hand-edit involved.
 */
export interface SeatHealth {
  status: 'active' | 'inactive';
  /** Bounded excerpt of the last seat-level error; present while `inactive`. */
  message?: string;
  /** When the seat entered its current status (ISO-8601). */
  since: string;
  /** When the last seat-level error was observed (ISO-8601), if any was. */
  lastErrorAt?: string;
}

/**
 * A council seat (`AgenticCli`) as returned by `GET /roster`. Only the fields
 * the launch form uses are named; the index signature keeps the (large) rest of
 * the seat intact so it round-trips verbatim into `clisJson` on launch.
 */
export interface RosterSeat {
  key: string;
  display_name: string;
  binary: string;
  enabled_for_council: boolean;
  category?: string;
  /**
   * Runtime health (crew#274). Additive: absent on a daemon predating the field, and safe to
   * round-trip into `clisJson` (the engine's `AgenticCli` deserializer ignores unknown fields).
   * Absent-or-default reads as `active` with no message.
   */
  health?: SeatHealth;
  /**
   * The shell invocation that runs this seat's own interactive login flow (seat sign-in;
   * wicked-core PR#278 `AgenticCli.login_invocation`). Passed through from the engine roster
   * VERBATIM — the daemon never synthesizes one. The studio hosts it in a PTY terminal
   * (`POST /terminals`) so every CLI's native sign-in gets one uniform surface. Absent on an
   * engine predating the field (serde omits `None`) and on seats with no known login flow.
   */
  login_invocation?: string;
  /**
   * Whether the seat LOOKS signed in — a cheap file/env-presence HEURISTIC computed by the
   * daemon (`seat-signin.ts`), never a spawned probe and never proof the credential still
   * works. Three-valued on purpose: `true`/`false` when the seat's auth state is observable
   * from files or env, `null`/absent when it is unknowable cheaply (keychain-backed seats,
   * unknown seat keys, or a daemon predating the field).
   */
  signed_in?: boolean | null;
  [k: string]: unknown;
}

/** Body for `POST /open` — open a file/folder with the OS default application (crew#273). */
export interface OpenPathBody {
  /**
   * ABSOLUTE path to open. Validated daemon-side: it must resolve inside the run's workdir /
   * extra write roots (when `runId` is given) or a registered repo root — never an arbitrary path.
   */
  path: string;
  /** Widen validation to this run's workdir + extra write roots. Unknown id ⇒ 404. */
  runId?: string;
}

/**
 * Response of `GET /runs/:id/files?path=<abs>` (DES-FEEDBACK-002 CREW-1) — a capped, read-only
 * file read contained against the SAME root set `POST /open` validates (run workdir + extra
 * write roots + registered repo roots). 404 unknown run / missing file; 400 non-absolute path;
 * 403 outside every allowed root (fail-closed, symlink-safe).
 */
export interface RunFileContent {
  /** The resolved absolute path that was served. */
  path: string;
  /** UTF-8 file text — the first 512 KB when `truncated`, `""` when `binary`. */
  content: string;
  /** The file's FULL size in bytes (not the served slice's). */
  size: number;
  /** The file exceeds the 512 KB cap and `content` holds only the first 512 KB. */
  truncated: boolean;
  /** NUL byte in the first 8 KB — render "binary file · open externally", never the content. */
  binary: boolean;
}

/**
 * Response of `GET /runs/:id/diff` / `GET /runs/:id/diff?path=<abs>` (DES-FEEDBACK-002 CREW-1) —
 * the run worktree's unified diff against HEAD (staged + unstaged), with untracked files appended
 * as all-addition `--no-index` hunks. `diff: ""` = clean tree (a real answer, not an error).
 * 404 unknown run; 409 when the run has no workdir or it no longer exists; with `path`, the same
 * 400/403 containment as `RunFileContent`.
 */
export interface RunDiff {
  /** Unified diff text (`git diff --no-color --no-ext-diff HEAD`), cut at 1 MB when `truncated`. */
  diff: string;
  /** The diff exceeded the 1 MB output cap and was cut. */
  truncated: boolean;
}

/** The daemon's cached open-gate record (`GET /runs/:id/gate`, DES-STUDIO-001 §3.3). */
export interface GateInfo {
  runId: string;
  ord: number;
  prompt: string;
  lifecycle: string;
  receivedAt: string;
  /**
   * Refusal-detection warning (issue #419, api-types 0.20.0). Present ONLY when the gate prompt
   * reads as a pure sandbox/tool refusal — the worker reported it could not act, with no sign of
   * productive work — so an operator does not approve a refusal as if it were work. Additive and
   * advisory: it never gates a decision, and is omitted entirely on a normal gate.
   */
  refusal?: { matched: boolean; reason: string };
}

/** Approve / reject payload for the steering gate (`POST /runs/:id/gate`). On a
 *  `steering-author` propose gate, an approve — amend note or not — also LANDS the proposal
 *  into the rules store and the 200 body carries a {@link SteeringLandingResult}; the amend
 *  steers the RUN's continuation, never the landed rule text (crew#388). */
export interface GateDecision {
  approve: boolean;
  amend?: string;
}

/**
 * Body of `POST /runs/:id/reassign` — the manual operator lever that reassigns a wedged run's
 * cursor unit through the same engine path the stall-watchdog's automatic escalation uses
 * (crew#442). `cli` omitted lets the engine's council re-pick the seat; when present it must be
 * a seat in the run's own pool (`SessionView.clis`) or the route answers 400.
 */
export interface ReassignRequest {
  cli?: string;
}

/**
 * A CoreEvent frame as delivered verbatim over `/ws` — a tagged-JSON object
 * discriminated on `type` (wicked-core-ts `event_to_json`). The named optional
 * fields cover the frames the daemon and the studio inspect; the index
 * signature keeps the shape additive-safe so new variants pass through
 * untouched (DES-STUDIO-001 §2.1, §5.1).
 */
export interface CoreEvent {
  type: string;
  session?: string;
  ord?: number;
  prompt?: string;
  chunk?: string;
  allow?: boolean;
  cli?: string;
  description?: string;
  problem?: string;
  message?: string;
  /** `elicitationCreated` (DES-002): the id minted by the actor for this elicitation round. */
  elicitationId?: string;
  /** `elicitationCreated`: an ordered set of valid responses; `null` / absent = free-text. */
  options?: string[] | null;
  /** PTY terminal frames (`terminalOpened`/`terminalOutput`/`terminalExited`): the terminal id. */
  id?: string;
  /**
   * A monotonic counter — but of WHAT depends on where the event came from, and the two never
   * appear together, so there is exactly one right reading per event:
   *
   * - **live `/ws` frame** — `terminalOutput` only, and it counts within that one terminal
   *   (`actor.rs` `TerminalState::next_seq`). Two terminals both start at 0; comparing their `seq`
   *   values means nothing.
   * - **entry from `runEvents`** — the durable log's own envelope counter, process-wide and stamped
   *   at emit (`event_log.rs` `SEQ`), which is what `read_run` sorts on. It totals-orders a run,
   *   which `ts` alone cannot: a burst from one actor turn shares a millisecond.
   *
   * They cannot collide, because `terminalOutput` is classed high-volume and is **never written to
   * the log** — so no payload ever carries both meanings. What that does forbid is merging the two
   * sources and sorting the result on this field: a live per-terminal 3 is not comparable to a
   * replayed envelope 4700. Sort a replay by `seq`; order live frames by arrival, per terminal id.
   */
  seq?: number;
  /** Capture time, epoch millis. Present ONLY on entries replayed from the durable event log
   *  (`runEvents` / `GET /runs/:id/events`); live `/ws` frames are not stamped, because for those
   *  the arrival IS the time. */
  ts?: number;
  /** `terminalOutput`: raw PTY bytes, base64-encoded (decode → send to the owning socket). */
  bytesB64?: string;
  /** `terminalOpened`: the working directory the PTY was opened in. */
  cwd?: string;
  // ── DES-STUDIO-COCKPIT-001 §3 B-events (Phase B insight wires) ──
  /** `unitDispatched`/`cliUsage`: 0-based dispatch attempt (`>0` = a re-dispatch / rework). */
  attempt?: number;
  /** `cliUsage`: prompt/input tokens for the unit run. */
  inputTokens?: number;
  /** `cliUsage`: completion/output tokens for the unit run. */
  outputTokens?: number;
  /** `cliUsage`: dollar cost when the CLI reports it (claude) or a price table resolves it; else `null`. */
  costUsd?: number | null;
  /** `dataUsed`: the data files the unit's CLI touched (`tool_use` file paths). */
  files?: string[];
  /** `gateEvaluated`: the gated criterion — `null` when the phase was UNGATED (no deterministic floor). */
  criterion?: string | null;
  /** `gateEvaluated`: `true` iff a pinned validator gated this unit (else the phase is ungated). */
  hasDeterministicFloor?: boolean;
  /** `gateEvaluated`: whether the deterministic (layer-1) floor passed (vacuous when no floor). */
  deterministicPass?: boolean;
  /** `gateEvaluated`: the agent (layer-2) judge's verdict when one ran, else `null`. */
  agentVerdict?: string | null;
  /** `gateEvaluated`: the agent judge's reasoning when one ran, else `null`. */
  agentReasoning?: string | null;
  /** `gateEvaluated`: the evaluator≠creator second-pass result — `null` when that layer did not run. */
  evaluatorPass?: boolean | null;
  /**
   * `gateEvaluated`: policy ids the second pass applied. EMPTY alongside `evaluatorPass: true`
   * means nothing applied, so the pass is a vacuous default-allow rather than an enforced
   * approval (FINDING-025). The layer-3 analogue of `hasDeterministicFloor`.
   */
  evaluatorPolicies?: string[];
  /** `gateEvaluated`: the WINNING denial's reason when `combined === false`, else `null`. */
  denialReason?: string | null;
  /** `gateEvaluated`: the final deny-dominant decision over all layers (mirrors `gateDecided.allow`). */
  combined?: boolean;
  // sessionStarted enrichment fields (snake_case — serde wire names)
  workflow_id?: string | null;
  cli_count?: number;
  governed?: boolean;
  entity_mode?: string;
  // workflowSelected (EVT-001) — camelCase per event_to_json
  workflowId?: string;
  unitCount?: number;
  // unitReworkAmended (EVT-012)
  amendment?: string;
  updatedDescription?: string;
  // unitOutputCaptured (EVT-013)
  outputBytes?: number;
  /**
   * How the worker step finished. `'elicitation_failed'` (DES-002) and `'timed_out'` (perf#4 —
   * the ENGINE's own turn ceiling, `WICKED_UNIT_TIMEOUT_SECS`) widen the original trio.
   * `'timed_out'` vs `'cancelled'` is THE wire distinction between the platform's deadline and
   * an operator cancel: automation may key recovery on `'timed_out'`, and must treat
   * `'cancelled'` as final. Older engines never send the newer values — consumers keying on
   * them degrade to doing nothing, which is the safe direction.
   */
  stepStatus?: 'ok' | 'failed' | 'cancelled' | 'elicitation_failed' | 'timed_out';
  /** `unitOutputDelta` (api-types 0.5.1): one streamed chunk of a worker's live output text. */
  text?: string;
  // unitPlanned enrichment fields — the wire spelling is camelCase (event_to_json);
  // the snake_case variants are kept for older daemons.
  stage?: string;
  skill_ref?: string | null;
  skillRef?: string | null;
  has_validator_pin?: boolean;
  hasValidatorPin?: boolean;
  executor_type?: string;
  executorType?: string;
  // unitDistributed enrichment fields
  routing_method?: string;
  agreement_pct?: number | null;
  returned?: number | null;
  dissent?: number | null;
  degraded_reason?: string | null;
  // councilConvened / councilDeliberated / councilVoted (live deliberation) — camelCase
  // per event_to_json
  clis?: string[];
  consensus?: boolean;
  agreementPct?: number;
  votes?: number;
  /** councilDeliberated: the completed ballot number (1-based). */
  round?: number;
  /** councilDeliberated: the approval bar the council must reach, as a percent. */
  neededPct?: number;
  /**
   * councilSeatFailed: the seat's exit code, when it ran far enough to have one.
   *
   * The branch itself arrives on the shared `kind` field — `spawn_failed`, `non_zero_exit`,
   * `timed_out`, `pty_unsupported`, `invocation_empty`, `workdir_unavailable`,
   * `prompt_write_failed`, `wait_failed`, `unreported`. Every seat that does not vote reports
   * one; without it the council's quorum shrinks silently.
   */
  exitCode?: number | null;
  /** councilSeatFailed: bounded capture of what the seat wrote to stderr (≤4 KiB). */
  stderr?: string;
  /** councilSeatFailed: how long the seat burned before failing — separates a spawn error from a timeout. */
  latencyMs?: number;
  /** workerStalled: silent seconds before the stall event fired. */
  stalledSecs?: number;
  /**
   * `workerStalled` / `workerStallEscalated` (DAEMON-SYNTHETIC, crew#287/crew#341): how long the
   * run had been silent on the daemon's CoreEvent relay when the frame fired, ms. Distinguishes
   * the daemon's synthetic `workerStalled` frame (this field) from the engine's PTY-path
   * `workerStalled` event (`stalledSecs` above) — same `type` tag, different producers.
   */
  quietForMs?: number;
  /** `workerStallEscalated` (crew#341): what the watchdog did — `'reassign'` | `'notify'`. */
  action?: string;
  /** `workerStallEscalated`: how the action ended — `'ok'` | `'failed'` | `'exhausted'`. */
  outcome?: string;
  /**
   * `workerStallEscalated`: `true` when a human should look — the action failed, the automatic
   * recovery budget is exhausted, or the configured action is `'notify'` (surface, don't touch).
   * `false` means the platform recovered on its own; the narrator shows it, nobody is paged.
   */
  needsYou?: boolean;
  /** `workerStallEscalated` (action `'reassign'`): automatic reassigns consumed for this run, this one included. */
  escalations?: number;
  /** `workerStallEscalated` (outcome `'failed'`): bounded excerpt of what the recovery call threw. */
  error?: string;
  /** failureTriaged: the triage judge's decision. */
  decision?: string;
  /** failureTriaged: the judge's bounded reasoning. */
  analysis?: string;
  // campaign* frames (DES-CAMPAIGN-001 / TH-9) — camelCase per event_to_json; the exact
  // per-variant shapes are the CampaignEvent union below.
  /** campaign* frames: the campaign id. */
  campaign?: string;
  /** campaignNode* frames: the node id within the campaign. */
  node?: string;
  /** campaignNodeStarted / campaignNodeAwaitingHuman: the node's attempt-keyed Run id. */
  runId?: string;
  // assumptionRecorded (external-transform convention) — camelCase per event_to_json
  kind?: string;
  library?: string;
  transform?: string;
  known?: boolean;
  detail?: string;
  [k: string]: unknown;
}

/**
 * A frame read back from core's DURABLE per-run event log (`GET /runs/:id/events`):
 * the same tagged object the live stream carries, plus the two fields the log
 * adds when it records one.
 *
 * Same shape as the live frame on purpose — one mapping in core
 * (`CoreEvent::to_json`) serializes both, so an event named here is the event
 * named live, and a bundle assembled after a run cannot describe it in different
 * words than the operator watched it happen in. (FINDING-014)
 */
/**
 * The stall watchdog's DETECTION frame (crew#287; api-types 0.18.0 — previously daemon-local).
 * DAEMON-SYNTHETIC: broadcast straight to `/ws` when a run in `executing` has been silent on the
 * daemon's CoreEvent relay past `SystemSettings.workerStallMinutes` — never re-relayed through
 * the engine, one frame per quiet period, re-armed by any new event for the run. Detection only:
 * the run is not touched. (The engine's PTY-path event shares the `workerStalled` tag but
 * carries `stalledSecs`; this frame carries `quietForMs`.)
 *
 * `type` aliases on purpose, not `interface`s: only anonymous object types satisfy `CoreEvent`'s
 * index signature, which is what lets these frames flow through CoreEvent-typed broadcast seams.
 */
export type WorkerStalledFrame = {
  type: 'workerStalled';
  /** The stalled run's id. */
  session: string;
  /** The current unit ord, when any observed event or the run header named one. */
  ord?: number;
  /** How long the run has been silent when the frame fired, ms. */
  quietForMs: number;
};

/**
 * The stall watchdog's ESCALATION frame (crew#341; api-types 0.18.0). DAEMON-SYNTHETIC, emitted
 * only when escalation is armed (`SystemSettings.workerStallEscalateMinutes` > 0 — ON by default
 * as of perf#4, default 30 minutes; an explicit `0` disarms) and a detected stall stays silent
 * past that threshold. Reports what the watchdog DID and how it ended, one escalation per quiet
 * period:
 *
 * - `action: 'reassign'` — the wedged cursor unit was recycled (engine `reassignUnit`: the stale
 *   turn is superseded, the session closed, the unit re-dispatched; queued operator injects
 *   survive into the fresh turn), routed to a DIFFERENT seat from the run's pool when one is
 *   available (perf#4) and in place otherwise. `outcome: 'ok' | 'failed' | 'exhausted'`.
 * - `action: 'notify'` — surface loudly without touching the run (the fail-loud rung).
 *
 * `needsYou: true` marks the frames a human should act on (failed / exhausted / notify).
 */
export type WorkerStallEscalatedFrame = {
  type: 'workerStallEscalated';
  /** The stalled run's id. */
  session: string;
  /** The cursor unit's ord, when known. */
  ord?: number;
  /** How long the run had been silent when the watchdog escalated, ms. */
  quietForMs: number;
  /** What the watchdog did. */
  action: 'reassign' | 'notify';
  /** How it ended: `ok` (acted / surfaced), `failed` (the recovery call threw), `exhausted`
   *  (the per-run automatic budget was already spent — nothing was attempted). */
  outcome: 'ok' | 'failed' | 'exhausted';
  /** True when a human should look; false = the platform recovered on its own. */
  needsYou: boolean;
  /** action `reassign`: the seat the unit was re-dispatched to, when known. As of perf#4 this
   *  is the failover TARGET — a different seat from the run's pool when one exists, else the
   *  stalled seat recycled in place. */
  cli?: string;
  /** action `reassign` (perf#4, additive): the seat that was stalled and reassigned AWAY from,
   *  when the watchdog knew it. Equal to `cli` on a single-seat in-place recycle. Absent on
   *  frames from daemons predating the field. */
  previousCli?: string;
  /** action `reassign`: automatic reassigns consumed for this run, this one included. */
  escalations?: number;
  /** outcome `failed`: bounded excerpt of what the recovery call threw. */
  error?: string;
};

export interface RecordedEvent extends CoreEvent {
  /** Capture time, epoch millis — when core emitted the frame, not when it was read. */
  ts: number;
  /**
   * Monotonic ordering across THIS RUN's whole event trail, so frames sharing a `ts` are still
   * ordered.
   *
   * Not the same `seq` as `CoreEvent`'s, which counts chunks within one terminal's output. This one
   * is required and spans every frame of the run; that one is optional and scoped to a stream. The
   * name is inherited from the wire and narrowed here rather than renamed, because the wire is what
   * `runEvents` returns.
   */
  seq: number;
}

/**
 * DES-STUDIO-COCKPIT-001 §3 B-events — the 4 tagged-JSON insight frames, as a discriminated
 * union for consumers that narrow on `type`. Each mirrors a wicked-core `CoreEvent` variant
 * (`event_to_json`, camelCase). They also flow through the permissive {@link CoreEvent} above; the
 * union just gives Phase-B panels exact field types.
 */
export type InsightEvent =
  | UnitDispatchedEvent
  | CliUsageEvent
  | DataUsedEvent
  | GateEvaluatedEvent;

/** §3 B2 — a unit was dispatched (initial + each re-dispatch); `attempt>0` = rework. */
export interface UnitDispatchedEvent {
  type: 'unitDispatched';
  session: string;
  ord: number;
  attempt: number;
}

/** §3 B3 — token/cost burn for one unit run. `costUsd` is `null` when no cost is known. */
export interface CliUsageEvent {
  type: 'cliUsage';
  session: string;
  ord: number;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** §3 B4 — the data files a unit's CLI touched. */
export interface DataUsedEvent {
  type: 'dataUsed';
  session: string;
  ord: number;
  files: string[];
}

/** §3 B1 — the gate's decision depth, emitted alongside `gateDecided`. */
export interface GateEvaluatedEvent {
  type: 'gateEvaluated';
  session: string;
  ord: number;
  criterion: string | null;
  hasDeterministicFloor: boolean;
  deterministicPass: boolean;
  agentVerdict: string | null;
  agentReasoning: string | null;
  evaluatorPass: boolean | null;
  denialReason: string | null;
  combined: boolean;
}

/** Foundation wave: session started with enriched context. */
export interface SessionStartedEvent {
  type: 'sessionStarted';
  session: string;
  problem: string;
  workflow_id: string | null;
  cli_count: number;
  governed: boolean;
  entity_mode: 'shared' | 'isolated';
}

// ── P1 observability events ─────────────────────────────────────────────────

/** P1 — a worker failure halted this unit; `detail` is a bounded excerpt of raw output. */
export interface StepFailedEvent {
  type: 'stepFailed';
  session: string;
  ord: number;
  attempt: number;
  detail: string;
  failureKind: string;
}

/** P1 — the engine restarted and is re-dispatching this unit; `attempt` is the NEW attempt number. */
export interface CrashRecoveryRedriveEvent {
  type: 'crashRecoveryRedrive';
  session: string;
  ord: number;
  attempt: number;
}

/** P1 — a PTY worker session opened for the run; `terminalId` matches the terminal event stream. */
export interface WorkerSessionStartedEvent {
  type: 'workerSessionStarted';
  session: string;
  terminalId: string;
  cliKey: string;
}

/** P1 — an ACP persistent session opened for a CLI; `acpSessionId` is the protocol session handle. */
export interface AcpSessionStartedEvent {
  type: 'acpSessionStarted';
  session: string;
  cliKey: string;
  acpSessionId: string;
}

/** P1 — ACP unavailable or failed for a CLI; the run continues with single-shot fallback. */
export interface AcpFallbackEvent {
  type: 'acpFallback';
  session: string;
  cliKey: string;
  reason: string;
  fallbackKind: string;
}

// ── P2 observability events ─────────────────────────────────────────────────

/**
 * P2 — one prior unit's context contributed to a cross-CLI injection.
 * Mirrors `wicked_core::InjectedContext`: identity + size only, no raw content.
 */
export interface InjectedContextRecord {
  ord: number;
  label: string;
  outputBytes: number;
}

/** P2 — an existing PTY session was reused for a subsequent unit in the same run (EVT-003). */
export interface WorkerSessionReusedEvent {
  type: 'workerSessionReused';
  session: string;
  terminalId: string;
  ord: number;
}

/**
 * P2 — a PTY worker session closed (EVT-004).
 * `reason`: `"run_complete"` (normal end-of-run) | `"error"` (PTY write failure).
 */
export interface WorkerSessionClosedEvent {
  type: 'workerSessionClosed';
  session: string;
  terminalId: string;
  reason: 'run_complete' | 'error';
}

/**
 * P2 — prior cross-CLI unit outputs were injected into a unit's context before dispatch (EVT-007).
 * Carries identity + byte-size only — raw output content is not included.
 */
export interface UnitContextInjectedEvent {
  type: 'unitContextInjected';
  session: string;
  ord: number;
  recipientCli: string;
  priorUnits: InjectedContextRecord[];
}

// ── P2 governance-deep observability events (wicked-core#89) ────────────────

/** P2 — governance hook fired for a tool call; records the per-call allow/deny decision. */
export interface GovernanceHookFiredEvent {
  type: 'governanceHookFired';
  session: string;
  ord: number;
  attempt: number;
  toolName: string;
  decision: 'allow' | 'deny';
  denyingPolicy: string | null;
}

/** P2 — a pinned deterministic validator was attached; confirms the governance floor is armed. */
export interface ValidationPinAttachedEvent {
  type: 'validationPinAttached';
  session: string;
  ord: number;
  pin: string;
  criterion: string;
}

/** P2 — a HumanConfirmIf gate escalated to human review. */
export interface GateEscalatedEvent {
  type: 'gateEscalated';
  session: string;
  ord: number;
  condition: string;
  verdictSummary: string;
}

/** P2 — a tool-executor command was dispatched (non-agent unit). */
export interface ToolExecutorDispatchedEvent {
  type: 'toolExecutorDispatched';
  session: string;
  ord: number;
  cmd: string[];
  workdir: string | null;
}

/** P2 — governance context was confirmed armed for a unit. */
export interface GovernanceContextArmedEvent {
  type: 'governanceContextArmed';
  session: string;
  ord: number;
  attempt: number;
  path: 'wrapped_cli' | 'acp';
  dbPath: string;
}

/** P2 — a unit the workflow declared GOVERNED ran with its tool calls unchecked, because the CLI it
 *  was routed to has no gate-hook adapter (injection is claude-only). Distinct from a unit that was
 *  never governed at all: both report `governed: false` on unitOutputCaptured, and only this event
 *  separates "not asked for" from "asked for and not applied" (FINDING-063). */
export interface GovernanceUnenforcedEvent {
  type: 'governanceUnenforced';
  session: string;
  ord: number;
  attempt: number;
  cli: string;
  reason: string;
}

// ── P2 decisions-full observability events (wicked-core EVT-001/012/013) ────

/** P2 — a structured workflow def was selected; fires once per session, after SessionStarted and before
 *  the first UnitPlanned. Not emitted for free-text runs. `unitCount` is the number of phases. */
export interface WorkflowSelectedEvent {
  type: 'workflowSelected';
  session: string;
  workflowId: string;
  unitCount: number;
}

/** P2 — a human approved a gate with an amendment text that was injected into the unit's description
 *  before re-dispatch. Fires after the amendment is persisted, before Resumed. Only emitted when
 *  the amendment text is non-empty. The canonical record for the HITL paper trail. */
export interface UnitReworkAmendedEvent {
  type: 'unitReworkAmended';
  session: string;
  ord: number;
  /** The raw amendment text supplied by the operator. */
  amendment: string;
  /** The unit's description after the amendment was injected. */
  updatedDescription: string;
}

/** P2 — a worker's ApplyStepResult arrived and output is ready to be gated. Fires before GateDecided.
 *  `outputBytes` is the byte length of the worker's output; `stepStatus` is "ok" / "failed" /
 *  "cancelled" / "elicitation_failed" (DES-002) / "timed_out" (perf#4 — the engine's own turn
 *  ceiling, kept apart from "cancelled" so an operator cancel is never mistaken for a platform
 *  timeout); `governed` reflects whether the runner armed input governance for this unit. */
export interface UnitOutputCapturedEvent {
  type: 'unitOutputCaptured';
  session: string;
  ord: number;
  attempt: number;
  /** Byte length of the worker's raw output — distinguishes 0-byte from 8 MB truncated. */
  outputBytes: number;
  stepStatus: 'ok' | 'failed' | 'cancelled' | 'elicitation_failed' | 'timed_out';
  governed: boolean;
}

/**
 * A live streamed chunk of a worker's output for one dispatch of a unit, relayed verbatim over
 * `/ws` (api-types 0.5.1). High-volume live-stream frame: chunks arrive in emission order within
 * one `(session, ord, attempt)` scope; `attempt` separates a re-dispatch's stream from the
 * original's. The daemon's relay is allowlist-free, so this frame reaches `/ws` clients
 * unmodified even before a consumer names it (`tests/ws-relay-passthrough.test.ts`).
 */
export interface UnitOutputDeltaEvent {
  type: 'unitOutputDelta';
  session: string;
  ord: number;
  attempt: number;
  /** The streamed output text chunk. */
  text: string;
}

/** Foundation wave: a unit was planned with full phase metadata. */
export interface UnitPlannedEvent {
  type: 'unitPlanned';
  session: string;
  ord: number;
  description: string;
  stage: StageKind;
  role: PhaseRole;
  gate: 'auto' | 'human_confirm' | 'human_confirm_if';
  skill_ref: string | null;
  has_validator_pin: boolean;
  executor_type: 'agent' | 'tool';
}

/** Foundation wave: a unit was distributed with full routing detail. */
export interface UnitDistributedEvent {
  type: 'unitDistributed';
  session: string;
  ord: number;
  cli: string;
  routing_method: 'council' | 'degraded' | 'evaluator_distinct' | 'tool';
  agreement_pct: number | null;
  returned: number | null;
  dissent: number | null;
  degraded_reason: string | null;
}

// ── Worker injection + reassignment events (core#93) ──────────────────────────

/** An operator message was injected into active worker sessions mid-run. */
export interface WorkerMessageInjectedEvent {
  type: 'workerMessageInjected';
  session: string;
  message: string;
  /** `"all"` or the cli_key that was targeted. */
  target: string;
}

/** A unit was stopped and re-dispatched to a different CLI (or re-routed via council). */
export interface UnitReassignedEvent {
  type: 'unitReassigned';
  session: string;
  ord: number;
  attempt: number;
  previousCli: string;
  /** `null` means the council was re-convened and its choice is the new assignment. */
  newCli: string | null;
}

// ── Governance types (crew#40/42/43) ───────────────────────────────────────────

/**
 * A registered governance policy (`wicked-governance::Policy`).
 * `effect`: `deny` | `allow_with_conditions` | `allow`.
 * `severity`: `high` | `medium` | `low`.
 */
export interface GovernancePolicy {
  id: string;
  kind: string;
  applies_to: string[];
  effect: 'deny' | 'allow_with_conditions' | 'allow';
  trigger: { contains?: string };
  obligations: string[];
  criteria: string;
  severity: 'high' | 'medium' | 'low';
  rule: string;
  /**
   * Withdrawn from enforcement (FINDING-038). Still listed — the record survives so past decisions
   * citing it stay explicable — but it can no longer decide a gate. Absent on policies written
   * before the field existed, which read as active.
   */
  retired?: boolean;
}

/**
 * The steering-type vocabulary (STEERING program) — one sub-page per type in the studio's
 * Steering surface. Enum-as-string on the wire; the engine's serde default is `architecture`,
 * so a rule row written before the field existed reads back as an architecture rule.
 */
export type SteeringType =
  | 'architecture'
  | 'development'
  | 'security'
  | 'testing'
  | 'operations'
  | 'compliance'
  | 'design-ux';

/**
 * A prescriptive conformance rule (`wicked-governance::ConformanceRule`).
 * `rule_type`: `pattern` | `policy`. `severity`: `info` | `warn` | `error` | `critical`.
 *
 * STEERING (unified model): the wiki/rules model and the old policy model merged into ONE
 * steering-rule model. The steering fields below are all optional on the wire — additive for
 * older consumers, and ABSENT on rows served by a pre-steering engine (wicked-core-ts < 0.7.5),
 * where absence reads as the serde defaults (`steering_type` architecture, `weight` 1.0, no
 * enforcement half). A rule WITHOUT `effect` is recall-only, exactly as before the merge; a rule
 * WITH one participates in decide()/select() the way a `GovernancePolicy` used to.
 */
export interface ConformanceRule {
  id: string;
  rule_type: 'pattern' | 'policy';
  statement: string;
  severity: 'info' | 'warn' | 'error' | 'critical';
  confidence: number;
  targets: { language?: string; layer?: string; framework?: string };
  symbol_ref?: string;
  compliance?: { framework: string; control_id: string };
  /** Where the rule came from. Doc-ingested rules keep `path@sha#id` in `ref`; UI/chat-authored
   *  rules carry `source: "ui"` / `source: "chat"` — first-class provenance, not second-class. */
  provenance: { source: string; ref?: string; source_kinds: string[] };
  /** Withdrawn from recall. Same contract as {@link GovernancePolicy.retired}. */
  retired?: boolean;
  /** Which Steering sub-page this rule belongs to. Engine default: `architecture`. */
  steering_type?: SteeringType;
  /** Phases / tools this rule is selected for (inclusion — {@link GovernancePolicy.applies_to} semantics). */
  applies_to?: string[];
  /** Exclusion twin of `applies_to`: phases / tools this rule is NEVER selected for. */
  excludes?: string[];
  /** Ordering within a severity band + gate priority. Engine default: 1.0. */
  weight?: number;
  /**
   * Enforcement half (from the retired policy model). Absent ⇒ the rule is RECALL-ONLY: it is
   * surfaced to workers but never enters decide()/select(), so it can neither block a gate nor
   * `catch` an eval sample — which is why a store of effect-less rules evals to "every bad
   * sample is a gap" (api-types 0.27.0, the #394/#395 companion). `deny` blocks (the only effect
   * the evals credit as a catch); `warn` surfaces without blocking (the operator-authorable
   * middle band); `allow_with_conditions` permits with obligations; `allow` permits outright.
   */
  effect?: 'deny' | 'warn' | 'allow_with_conditions' | 'allow';
  trigger?: { contains?: string };
  obligations?: string[];
  /** The frozen acceptance-criteria text (becomes a claim's `criteria` when the rule decides a gate). */
  criteria?: string;
  /**
   * Unix-SECONDS timestamp of when this rule FIRST entered the store — the "added" time the Steering
   * surface sorts + date-filters on (NOT the latest-edit time), stamped once by the engine on first
   * create and preserved across updates (api-types 0.23.0).
   *
   * WIRED-BUT-PENDING A CORE-TS BUMP: the field exists on the engine's `ConformanceRule`
   * (wicked-core `conformance.rs`, serialized with `skip_serializing_if = Option::is_none`), but it
   * landed AFTER the published `core-ts-v0.7.16` this daemon builds against — so a rule served by
   * the current binding carries NO `created_at`. The daemon passes the field through verbatim
   * (`listConformanceRules` returns the parsed rows unchanged), so it begins flowing the moment
   * crew re-pins to a core-ts that includes it — no daemon change needed. ABSENT — never
   * fabricated — on any rule the engine did not stamp (pre-field rows, and every row from a
   * pre-bump binding), so a `since`/`until` filter cannot assert an undated rule in range.
   */
  created_at?: number;
}

/** Facet query for `GET /governance/rules/preview`. All fields are optional. */
export interface RulePreviewQuery {
  language?: string;
  layer?: string;
  framework?: string;
  severity?: string;
  rule_type?: string;
}

/**
 * Facet query for `GET /governance/rules` (the wiki BROWSE surface). Unlike
 * {@link RulePreviewQuery} — whose recall semantics treat an absent rule facet as a wildcard
 * match, enforcement's question — browse filters are EXACT matches over the listed rows
 * ("show me the rules tagged `layer=api`"), and `status` keeps retired rules reachable so the
 * kill switch stays visible (`all` is the default).
 */
export interface RuleBrowseQuery {
  severity?: 'info' | 'warn' | 'error' | 'critical';
  layer?: string;
  rule_type?: 'pattern' | 'policy';
  status?: 'active' | 'retired' | 'all';
  /**
   * Steering-type facet (the Steering sub-page's filter). Answers 501 on a pre-steering engine
   * (wicked-core-ts < 0.7.5): rows there carry no `steering_type`, so an empty answer would
   * impersonate "no rules of that type".
   */
  type?: SteeringType;
  /**
   * Boolean spelling of the retire filter: `true` ⇒ `status=all`, `false` ⇒ `status=active`.
   * Mutually exclusive with `status` — sending both is a 400 (two spellings of one filter can
   * contradict, and picking a winner silently would answer a question the caller didn't ask).
   */
  include_retired?: 'true' | 'false';
  /**
   * Inclusive LOWER date bound (api-types 0.23.0): keep only rules with `created_at >= since`.
   * Unix SECONDS, a non-negative integer (a present-but-non-integer value is a 400). Applied
   * server-side over the listed rows, alongside the facet filters. A rule with NO `created_at`
   * is EXCLUDED whenever `since` (or `until`) is set — see {@link ConformanceRule.created_at}: on
   * a pre-bump core-ts binding NO rule carries the field, so this filter narrows to empty until the
   * engine surfaces it. Omitted ⇒ no lower bound.
   */
  since?: string;
  /**
   * Inclusive UPPER date bound (api-types 0.23.0): keep only rules with `created_at <= until`.
   * Same units/validation/undated-exclusion as {@link RuleBrowseQuery.since}. Omitted ⇒ no upper
   * bound.
   */
  until?: string;
}

// ── Steering management (STEERING program) ──────────────────────────────────────

/**
 * One entry of a `POST /governance/steering/import` batch: either a frontmattered markdown
 * document (`kind: 'doc'` — the same format `rules ingest --dir` consumes) or a ready rule
 * object (`kind: 'rule'`). Every entry runs through the engine's ingest normalize/validate
 * path, fail-closed PER ENTRY: one bad entry rejects alone, the rest still land.
 */
export type SteeringImportEntry =
  | { kind: 'doc'; name?: string; content: string }
  | { kind: 'rule'; rule: ConformanceRule };

/** The `POST /governance/steering/import` request body (JSON — this daemon speaks no multipart). */
export interface SteeringImportBody {
  /** The page's inferred steering type, applied as the DEFAULT `steering_type` for entries that omit one. */
  type?: SteeringType;
  entries: SteeringImportEntry[];
}

/** Per-entry outcome of a steering import (same order as the submitted batch). */
export interface SteeringImportResult {
  /** Index into the submitted `entries` array. */
  index: number;
  /** The doc entry's `name`, when one was given. */
  name?: string;
  status: 'imported' | 'rejected';
  /** Rule ids the entry minted (a doc can mint several; a rejected entry mints none). */
  ids?: string[];
  /** Why the entry was rejected (present only on `rejected`). */
  error?: string;
}

/** The `POST /governance/steering/import` 200 body — 200 even with rejections: per-entry results ARE the answer. */
export interface SteeringImportResponse {
  results: SteeringImportResult[];
  imported: number;
  rejected: number;
}

/**
 * The `POST /governance/steering/author` request body — "add with chat". Launches a governed
 * authoring run (the `steering-author` workflow) that analyzes the named files/directories plus
 * the operator's intent and emits PROPOSED steering rules at a human gate (the TH-12
 * propose-as-gate pattern): the run PAUSES `awaiting_human` after the propose phase, and the
 * operator approves/amends/rejects through the standard `POST /runs/:id/gate`. On APPROVE the
 * daemon lands the proposal into the rules store with `provenance.source: "chat"` and the gate
 * response carries a {@link SteeringLandingResult} — the run itself writes nothing to any store.
 */
export interface SteeringAuthorBody {
  /** The operator's conversational intent — what steering to author, and why. */
  instructions: string;
  /** Default `steering_type` for the proposed rules (the page's inferred type). */
  type?: SteeringType;
  /** ABSOLUTE paths on the daemon host (files or directories) the run should analyze. */
  paths?: string[];
  /** Inline documents — written into the run's steering inbox on the daemon host and analyzed like `paths`. */
  documents?: { name: string; content: string }[];
  /** Registered repo to run within (the run analyzes that worktree's context too). */
  repoRef?: string;
  /** Stable run id; minted when omitted. */
  sessionId?: string;
}

/** Where a landed steering proposal was read from, most-preferred first: the propose phase's
 *  machine-readable artifact file, the propose unit's stored transcript, the cached gate prompt. */
export type SteeringProposalSource = 'deliverable' | 'transcript' | 'gate-prompt';

/**
 * The `landing` field on the `POST /runs/:id/gate` (and gated `POST /runs/:id/resume`) 200 body
 * — present ONLY when the approved gate was a `steering-author` propose gate (crew#388). It is
 * how the skin learns the approved chat proposal actually reached the rules store — or, loudly,
 * that it did not: on `failed` the run still advanced (the approve stands) but `error` carries
 * the operator-readable reason, mirrored on the audit trail as
 * `governance.steering.landing_failed`. Landed rules are audited per rule as
 * `governance.rule.upserted` with the chat provenance. Idempotent: a replayed approve reports
 * `alreadyLanded: true` and re-lands nothing. An approve WITH an amend note lands the proposal
 * UNCHANGED — the amend steers the RUN, not the rule text. A reject lands nothing.
 */
export interface SteeringLandingResult {
  outcome: 'landed' | 'failed';
  /** Rule ids actually upserted (all of them on `landed`; the partial set on a partial `failed`). */
  ruleIds: string[];
  /** Where the proposal was read from. Absent when no source yielded one. */
  source?: SteeringProposalSource;
  /** `true` when a replayed approve found the durable landing marker — nothing was re-landed. */
  alreadyLanded?: boolean;
  /** Present iff `outcome: "failed"` — the loud, operator-readable reason. */
  error?: string;
}

// ── Skills — the daemon-owned garden plugin root, published as immutable snapshots (api-types 0.28.0) ──
//
// api-types 0.29.0 (design amendment v3.6, crew #490): the installer-managed copy
// `<config dir>/plugins/wicked-garden` is a LAST-resort seed source — `SkillSourceKind` gains
// `installer-copy`, and `DiagnosticsSkillsFinding.kind` gains the persistent `skills.source` warning
// and the fail-closed `skills.manifest` error.
//
// Skills are files (skills keystone, design v3 + amendments v3.1/v3.2). The daemon owns ONE
// effective `wicked-garden`-shaped plugin root — `<state home>/skills/effective/`, the dependency
// closure of the installed plugin: `.claude-plugin/{plugin.json,archetypes.json,components.json}`,
// `skills/**` (nested layout verbatim), `scripts/**` minus CI + dev tools, `schemas/`,
// `docs/examples/`, `pyproject.toml`, `uv.lock` — seeded from the LIVE installed plugin into a
// content-addressed `baseline/<contentHash>/`. The operator edits files in place, replaces a
// skill, adds one, disables one (manifest state — the files stay), resets one (content from the
// baseline; never enablement). Nothing a worker runs is read from `effective/`: PUBLISHING
// validates the whole tree and writes an IMMUTABLE, read-only `snapshots/<gen>/` (enabled skills
// only, closure included, `snapshot.json`, and the generated delivery views —
// `views/copilot/.github/skills/<name>/` holding the enabled PORTABLE skills, part of the content
// hash), then flips `current -> snapshots/<gen>`; the engine receives the resolved snapshot path
// as `WICKED_SKILLS_SNAPSHOT`. The daemon NEVER writes into the user's own CLI directories
// (`~/.codex`, `~/.pi`, `~/.copilot`, `~/.config/opencode`, `~/.claude`): skills reach non-Claude
// workers only through per-launch, wicked-owned delivery core performs from the snapshot (v3.2) —
// a CLI without a lever (codex today) runs without wicked skills, and a unit on such a seat that
// requires one is REFUSED at launch (no proceed-with-disclosure setting exists).
// `/skills` is a file manager whose EVERY mutation is CAS-guarded (`expectedRevision`) and
// answers 2xx `{verdict, findings[], revision}` — a `blocked` verdict is a normal response,
// including a publish refused because one is in flight (`publish-in-flight`) or aborted because the
// root changed under it (`root-changed`), neither of which wrote anything. 409 (`{error, revision}`)
// is EXCLUSIVELY a stale `expectedRevision` (a CAS conflict).

/** What a skill IS, from its frontmatter — fork-first: `context: fork` → fork worker (a subagent
 *  body); else `user-invocable: true` → router (an operator-facing entry point); else module (a
 *  nested reference skill routers/workers pull in). */
export type SkillKind = 'router' | 'fork-worker' | 'module';

/** `shipped` = every own file byte-identical to the baseline; `override` = a shipped skill with
 *  edited/replaced files; `user-added` = no baseline (added through the API, or upstream dropped
 *  it while the operator's edits were kept). */
export type SkillProvenance = 'shipped' | 'override' | 'user-added';

/** Where a baseline was captured from. `claude-plugin-cache` is the marketplace cache
 *  (`<config dir>/plugins/cache/wicked-garden/wicked-garden/<version>` — the plugin Claude Code
 *  runs); `installer-copy` is the installer-managed `<config dir>/plugins/wicked-garden` copy
 *  (`npx wicked-installer install wicked-garden`), accepted only as the LAST resort when no cache
 *  exists (design v3.6, api-types 0.29.0) and flagged by the `skills.source` diagnostics finding
 *  while it is the current baseline; `checkout` is a git working tree; `directory` any other
 *  explicit plugin-shaped directory. */
export type SkillSourceKind = 'claude-plugin-cache' | 'installer-copy' | 'checkout' | 'directory';

/** The per-baseline `uv sync` state (`<baseline>/.venv`, provisioned once per content hash — the
 *  publish that needs it AWAITS it — and shared read-only by every snapshot that links it):
 *  `pending` until a successful publish records it, `synced` on success (the snapshot carries a
 *  `.venv` link), `skipped` when the bundle carries no `pyproject.toml` (nothing to provision; no
 *  link). `failed` (uv missing or a sync error) is BLOCKING for the publish (`venv-failed`) and is
 *  therefore never the recorded state of a published baseline — the record keeps its previous
 *  value; a later publish retries. */
export type SkillVenvState = 'pending' | 'synced' | 'failed' | 'skipped';

/** One captured baseline — keyed in `SkillManifest.baselines` by the content hash of its bundle
 *  (sorted relative paths + sha256 digests), never by the version string alone: two installs of
 *  "12.32.0" with different bytes are two baselines. */
export interface SkillBaselineRecord {
  /** `version` from the source's `.claude-plugin/plugin.json`. */
  plugin_version: string;
  source: { kind: SkillSourceKind; path: string };
  /** HEAD sha for a `checkout` source; `null` otherwise (or when git could not answer). */
  git_sha: string | null;
  /** ISO-8601 instant the baseline was captured. */
  captured_at: string;
  venv: SkillVenvState;
}

export interface SkillEntry {
  /** Plugin-relative directory, nested layout preserved (`skills/engineering/frontend`). Never
   *  renamed — sibling `../` links depend on it. */
  dir: string;
  kind: SkillKind;
  /** Core-by-reference: in the registered-reference closure — a `skill_ref` of a workflow the
   *  daemon knows (core drop-ins, crew-generated, user-registered) or a skill one of those names in
   *  its SKILL.md (repo-learn → search, mem). Disabling or renaming it is blocking. */
  core: boolean;
  /** `false` when the skill's files resolve `${CLAUDE_PLUGIN_ROOT}`, invoke a script relative to
   *  the cwd (`python3 -u scripts/x.py`, `./scripts/x`, …), or link `../` — Claude-only by nature:
   *  excluded from the snapshot's `views/copilot/` and from the per-launch skill lists core builds
   *  for the other CLIs. `portable` is the admission key for every non-Claude view (design v3.2). */
  portable: boolean;
  /** Manifest state, orthogonal to content: a disabled skill's files stay in `effective/` and are
   *  excluded from the next published snapshot. Reset never flips it. */
  enabled: boolean;
  provenance: SkillProvenance;
  /** ISO-8601 instant of the last edit/replace/add through the API; `null` when untouched. */
  editedAt: string | null;
  /** A refreshed baseline changed a file this skill overrides — the new side is readable as
   *  `?side=baseline` for diffing; the operator's content is kept. */
  upgradeAvailable: boolean;
  /** `upgradeAvailable`, or the last refresh found a name collision (upstream now ships a skill
   *  under this user-added name at another dir). Cleared by reset / a later refresh. */
  conflict: boolean;
  /** The held-back UPSTREAM skill's directory in the current baseline when the last refresh found a
   *  name collision (upstream ships this name at another dir than the operator's skill); `null`
   *  otherwise. `GET /skills/:name/files/*path?side=baseline` reads THIS directory for such a skill,
   *  so the two sides of the collision are comparable — the answer's `path` names the file actually
   *  read (api-types 0.28.0). Re-derived by every refresh. */
  upstreamDir: string | null;
}

/** One managed file (plugin-relative path → hashes). `baselineHash` `null` = user-added file;
 *  `effectiveHash` `null` = a baseline file absent from `effective/` (removed by a direct
 *  filesystem edit — reset restores it; the skill reads `override` until then). */
export interface SkillFileRecord {
  baselineHash: string | null;
  effectiveHash: string | null;
  /** The hash this file had in the most recent published snapshot; `null` = never published. */
  lastPublishedHash: string | null;
  /** The last refresh saw BOTH sides change (kept the effective side). */
  conflict: boolean;
}

/** The most recent publish. */
export interface SkillPublishedRecord {
  gen: number;
  /** Hash over the snapshot's files (sorted relative paths + sha256 digests), `snapshot.json` excluded. */
  contentHash: string;
  /** ISO-8601 instant. */
  at: string;
  /** sha256 of the exact `snapshot.json` bytes publish wrote. `snapshot.json` is excluded from the
   *  content hash, so the crew-owned manifest AUTHENTICATES it: `current` verifies only the
   *  generation this record names, with metadata hashing to this value (api-types 0.28.0). */
  snapshotHash: string;
}

/** `<skills root>/manifest.json` — the state of the daemon-owned root. (The v3 mirror ledger is
 *  withdrawn with the mirror — design v3.2 §1: the daemon never writes into the user's CLI dirs.) */
export interface SkillManifest {
  version: 2;
  /** Monotonic; bumped by EVERY mutation. Every mutating request carries it as `expectedRevision`. */
  revision: number;
  /** Content hash of the current baseline (`baseline/<hash>/`). */
  baseline: string;
  baselines: Record<string, SkillBaselineRecord>;
  /** Keyed by frontmatter `name` (`wicked-garden-<dir segments joined by '-'>`). */
  skills: Record<string, SkillEntry>;
  /** Every managed file under `effective/`, plugin-relative. */
  files: Record<string, SkillFileRecord>;
  published: SkillPublishedRecord | null;
}

/** `GET /skills` 200 body. 503 when the root is not seeded (no installed plugin was found) or when
 *  `current` exists but fails verification (realpath outside `snapshots/`, malformed
 *  `snapshot.json`, content hash mismatch) — a corrupt root is a loud error, never an empty catalog. */
export interface SkillsManifestResponse {
  manifest: SkillManifest;
  revision: number;
  /** The resolved skills root on the daemon host (`<state home>/skills` by default). */
  root: string;
  /** The VERIFIED published snapshot `current` resolves to, or `null` before the first publish.
   *  `path` is the absolute REAL path of `snapshots/<gen>` — byte-identical to the one input the
   *  engine is handed (`WICKED_SKILLS_SNAPSHOT`; design v3.1 §2). */
  current: { gen: number; path: string } | null;
}

export interface SkillFileEntry {
  /** POSIX path relative to the skill dir. */
  path: string;
  size: number;
  sha256: string;
  /** This file's manifest record (`null` for a file present on disk but not yet recorded). */
  record: SkillFileRecord | null;
}

/** `GET /skills/:name/files` 200 body — the skill's OWN files (a nested skill's files are its own). */
export interface SkillFileTree {
  name: string;
  dir: string;
  enabled: boolean;
  files: SkillFileEntry[];
}

/** `GET /skills/:name/files/*path` and `GET /skills/support/*path` 200 body — a typed, capped read.
 *  Save is disabled on `truncated` or `binary`. `?side=baseline` reads the baseline copy instead
 *  (the "new side" of a refresh conflict). */
export interface SkillReadResult {
  /** Plugin-relative path served. */
  path: string;
  /** UTF-8 text — the first 512 KB when `truncated`; `null` when `binary` (there is no text to show). */
  content: string | null;
  /** The file's FULL size in bytes. */
  size: number;
  truncated: boolean;
  binary: boolean;
}

export type SkillFindingKind =
  | 'name-invalid'
  | 'name-collision'
  | 'name-mismatch'
  | 'frontmatter-invalid'
  | 'missing-skill-md'
  | 'unregistered-skill'
  | 'nested-skill-create'
  | 'core-disable'
  | 'core-rename'
  | 'core-missing'
  | 'support-file-edit'
  | 'non-portable'
  /** A `${CLAUDE_PLUGIN_ROOT}/<p>` or `../<p>` reference in an enabled skill's files that does not
   *  resolve inside the would-be snapshot. Severity follows the TARGET (design v3.4 §1): a reference
   *  that ESCAPES the plugin root (`..` climbing out — it reaches whatever lies beside the snapshot on
   *  the worker host) is `blocking`; one whose target is MISSING (it normalizes inside the root but
   *  the snapshot does not carry it — a file the bundle omits, or a skill that is disabled) is a
   *  `warning`: a content bug the skill's author owns, published as found — a publish with only
   *  warnings answers `verdict: 'warnings'` with the findings AND a written snapshot (api-types
   *  0.28.0). */
  | 'unresolved-ref'
  /** A path the store refuses BY NAME rather than reads through: a shape that could leave its root
   *  (`..`, an absolute piece), a component that crosses a symlink, or — under `effective/`, where
   *  every entry is classified — a symlink or a special node (socket, fifo, device) anywhere,
   *  the contents of a pruned directory (`.venv`, `node_modules`, `__pycache__`) INCLUDED: such a
   *  directory is never copied or hashed, but what it holds is still judged, and a link inside one
   *  blocks with the reason (a provisioned environment lives under `baseline/`, not the editable
   *  root). Blocking; `file` names the entry, `skill` its owning skill when it has one. */
  | 'path-invalid'
  | 'unknown-skill'
  | 'no-baseline'
  | 'fs-drift'
  | 'refresh-conflict'
  | 'empty-snapshot'
  /** `.claude-plugin/plugin.json`, `archetypes.json` or `components.json` is absent from `effective/`
   *  — the plugin manifest + the runtime catalogs are REQUIRED snapshot members (blocking at
   *  publish; api-types 0.28.0). */
  | 'missing-plugin-manifest'
  /** The plugin manifest or a runtime catalog is present but not what its reader expects — does
   *  not parse as JSON, is not a JSON object, or `archetypes.json` lacks its `archetypes`
   *  collection (blocking at publish; api-types 0.28.0). A manifest without `name` is
   *  `name-mismatch`. */
  | 'catalog-invalid'
  /** The baseline's shared read-only Python env could not be provisioned (uv missing, `uv sync`
   *  failed, or the env could not be locked) while the bundle carries a `pyproject.toml` — the env
   *  is REQUIRED, so the publish is blocked and nothing (the provisioning state included) is
   *  persisted (api-types 0.28.0). */
  | 'venv-failed'
  /** A publish was refused because one is already running (one at a time) — nothing was written, so
   *  it is a 2xx `blocked` envelope, not a 409 (409 is only a stale `expectedRevision`; api-types
   *  0.28.0). Re-read `GET /skills` and retry against the revision it answers. */
  | 'publish-in-flight'
  /** A publish was aborted because the skills root changed under it — nothing was written to either
   *  root; a 2xx `blocked` envelope (api-types 0.28.0). Re-read `GET /skills` and retry. */
  | 'root-changed'
  /** A path outside the bundle closure — the ONE allowlist of what the seed copies, what the support
   *  API may address, and what a snapshot may carry: the five runtime catalogs under `.claude-plugin`
   *  BY NAME (`plugin.json`, `archetypes.json`, `components.json`, `specialist.json`,
   *  `stack-registry.json` — `marketplace.json`, a publish-time listing, is outside), everything under
   *  `skills`, `schemas` and `docs/examples`, everything under `scripts` except the `ci` and `wg`
   *  directories and any `wg-`-prefixed dev tooling, plus `pyproject.toml` and `uv.lock`. A support
   *  add/PUT there is a 2xx `blocked` envelope (nothing written); a file found there under
   *  `effective/` at publish/analyze (a direct filesystem edit) is a BLOCKING finding naming the path
   *  — a snapshot never ships it (api-types 0.28.0). */
  | 'outside-closure'
  /** A content-addressed `baseline/<hash>` whose tree does not hash to its name (a bundle file
   *  modified, planted or removed, or a symlink inside), or a baseline file whose bytes do not match
   *  the hash the manifest recorded for it. Baselines are re-verified before EVERY reuse: a refresh
   *  refuses to reuse it (2xx `blocked`, nothing copied), reset refuses to restore from it (nothing
   *  written), publish/analyze report it blocking (before AND after the env was provisioned in it).
   *  Read-only mode bits on the baseline are a guard, never the integrity boundary — the hash is
   *  (api-types 0.28.0). */
  | 'baseline-corrupt';

export type SkillFindingSeverity = 'warning' | 'blocking';

/** `blocked` = at least one blocking finding (nothing was written / published); `warnings` =
 *  proceeded with warnings; `clear` = nothing to say. */
export type SkillVerdict = 'clear' | 'warnings' | 'blocked';

export interface SkillConflictFinding {
  kind: SkillFindingKind;
  severity: SkillFindingSeverity;
  /** The skill this finding is about, or `null` for a catalog / support-file finding. */
  skill: string | null;
  /** Plugin-relative file the finding names, or `null`. */
  file: string | null;
  /** 1-based line in `file`, when the finding is anchored to one. */
  line: number | null;
  /** The OTHER catalog skill this finding is against (a collision, a core guard), or `null`. */
  againstSkill: string | null;
  againstIsCore: boolean;
  /** The concrete fact (names, paths, the parse error). */
  evidence: string;
  /** Why it matters. */
  explanation: string;
}

/** `POST /skills/analyze` 200 body (a PURE dry run of the publish validation: nothing persisted,
 *  `revision` unchanged — drift it observes is reported, and recorded only by the publish that
 *  ships it) — and the base of every mutation result. */
export interface SkillAnalyzeResult {
  verdict: SkillVerdict;
  findings: SkillConflictFinding[];
  revision: number;
}

/** Every `/skills` mutation's 200 body. `blocked` ⇒ nothing was written and `revision` is unchanged. */
export interface SkillMutationResult extends SkillAnalyzeResult {
  skill?: SkillEntry & { name: string };
}

/** `POST /skills/publish` 200 body. `snapshot` is `null` when the verdict is `blocked` — and then
 *  `revision` is unchanged (a blocked publish persists nothing — not the drift it observed, not the
 *  baseline's provisioning state). `path` is the absolute REAL path of the locked, read-only
 *  generation; its `snapshot.json` carries the skill rows and the `views` block (`views.copilot`:
 *  the `views/copilot` dir + the portable skills laid out in it). One publish runs at a time — a
 *  concurrent one wrote nothing and answers a 2xx `blocked` `publish-in-flight` envelope
 *  (`snapshot: null`), not a 409. */
export interface SkillPublishResult extends SkillAnalyzeResult {
  snapshot: { gen: number; path: string; contentHash: string; skills: number } | null;
}

/** `POST /skills/refresh-baseline` 200 body — the three-way merge per FILE (baseline_old /
 *  baseline_new / effective): unchanged → take new; user-modified & upstream-unchanged → keep;
 *  both changed → keep + `conflict` (new side readable as `?side=baseline`); user-DELETED &
 *  upstream-changed → the deletion is kept + `conflict` (a deletion is a modification; reset
 *  restores upstream); upstream-deleted & user-unmodified → remove; upstream-deleted &
 *  user-modified → keep as user-added; a new upstream skill whose path-derived name is a
 *  user-added skill's → conflict. 502 when no plugin is installed. */
export interface SkillRefreshResult extends SkillAnalyzeResult {
  previous_baseline: string;
  baseline: string;
  plugin_version: string;
  /** Skills whose files were replaced from the new baseline. */
  taken: string[];
  /** Skills that kept operator content (upstream unchanged, or a flagged conflict). */
  kept: string[];
  added: string[];
  removed: string[];
  /** Skills flagged `conflict` by this refresh. */
  conflicts: string[];
}

/** The 409 body of a `/skills` mutation whose `expectedRevision` is stale — a CAS conflict, the
 *  ONLY thing that answers 409. A publish refused because another is in flight, or aborted because
 *  the skills root changed under it, wrote nothing and instead answers a 2xx `blocked` findings
 *  envelope (`publish-in-flight` / `root-changed`; api-types 0.28.0), never a 409. */
export interface SkillRevisionConflict {
  error: string;
  /** The current revision — re-read `GET /skills` (or use this) and retry. */
  revision: number;
}

/** The body of `POST /skills/:name/{enable,disable,reset}`, `POST /skills/publish` and
 *  `POST /skills/refresh-baseline`. */
export interface SkillRevisionBody {
  expectedRevision: number;
}

/** `PUT /skills/:name/files/*path` and `PUT /skills/support/*path` body. `content` is UTF-8 text,
 *  at most 512 KB. */
export interface PutSkillFileBody {
  content: string;
  expectedRevision: number;
}

/** `POST /skills` body — add a user skill. `files` maps skill-relative POSIX paths to UTF-8 text
 *  and must include `SKILL.md`; the skill lands at `skills/<name minus "wicked-garden-">`. */
export interface AddSkillBody {
  name: string;
  files: Record<string, string>;
  expectedRevision: number;
}

/** `POST /skills/:name/replace` body — replace the skill's OWN files wholesale (nested skills untouched). */
export interface ReplaceSkillBody {
  files: Record<string, string>;
  expectedRevision: number;
}

// ── Governance wiki management (scoreboard + meta) ─────────────────────────────

/**
 * Typing-coverage half of the wiki scoreboard — % of doctrine statements typed into
 * enforcement classes. Doc-side by construction (the class lives in doc frontmatter, never on
 * the rule node), so it is measurable only when the daemon was pointed at the same docs root
 * `rules ingest --dir` used; otherwise `available` is `false` and `reason` says why.
 */
export interface WikiTypingCoverage {
  available: boolean;
  /** Why typing could not be measured (present only when `available` is `false`). */
  reason?: string;
  docs_scanned: number;
  statements_total: number;
  statements_typed: number;
  /** `statements_typed / statements_total` in [0,100]; absent when the corpus mints no statements. */
  percent?: number;
  /** Typed statements per class (`policy` / `validator` / `guidance`). */
  by_class: Record<string, number>;
  /** Docs that mint statements but declare no class — the actionable backlog. */
  docs_untyped: string[];
}

/** Connection-coverage half — do the active rules' `symbol_ref`s resolve, and are the links live? */
export interface WikiConnectionCoverage {
  rules_with_ref: number;
  refs_resolving: number;
  refs_unresolvable: number;
  /** `refs_resolving / rules_with_ref` in [0,100]; absent when no rule carries a ref. */
  percent?: number;
  /** Active rules with at least one live `Governs` edge. */
  rules_linked: number;
}

/** One rule's enforcement evidence (only rules with any evidence appear). */
export interface WikiRuleEvidenceRow {
  rule_id: string;
  /** Distinct deny claims citing this rule (`evidenced_by` edges in). */
  denial_claims: number;
  /** Accumulated `evidence_count` across the rule's `Governs` edges. */
  governs_evidence: number;
}

/** Enforcement evidence — gate denials citing wiki rules (retired rules included: a past denial
 *  stays explicable after its rule retires, so its evidence stays countable). */
export interface WikiEnforcementEvidence {
  denial_claims: number;
  rules_evidenced: number;
  evidenced_by_edges: number;
  governs_evidence_total: number;
  /** Per-rule breakdown, most-evidenced first — the "which rules actually fire" list. */
  per_rule: WikiRuleEvidenceRow[];
}

/** Recall volume — documented UNAVAILABLE in-band (an honest "cannot measure" beats a
 *  fabricated zero); `reason` says why. */
export interface WikiRecallVolume {
  available: boolean;
  reason: string;
}

/**
 * The wiki population/connection scoreboard (`wicked-governance::Scoreboard`, AW-23/arch-R23) —
 * the report that tells a populated wiki from an ingested-once-and-decaying one.
 * Served by `GET /governance/wiki/scoreboard`; 501 when the installed engine addon predates the
 * `governanceScoreboard` binding (wicked-core-ts ≥ 0.7.4).
 */
export interface GovernanceScoreboard {
  rules_total: number;
  rules_active: number;
  rules_retired: number;
  typing: WikiTypingCoverage;
  connection: WikiConnectionCoverage;
  evidence: WikiEnforcementEvidence;
  recall_volume: WikiRecallVolume;
}

/**
 * `GET /governance/wiki/meta` — the wiki's honest empty-state signal, cheap enough for the UI
 * to call on mount. `ruleset_count` is `null` (not 0) when the installed engine build cannot
 * count `RuleSet` rows: "no rulesets" is a real answer about a seeded store, and "cannot count"
 * must never impersonate it.
 */
export interface GovernanceWikiMeta {
  /** Any doctrine on the store at all (rules listable, or RuleSet rows counted). */
  seeded: boolean;
  ruleset_count: number | null;
  /** Rules the engine lists (pre-0.7.4 addons list active rules only — the recall funnel). */
  rule_count: number;
  /** Whether `GET /governance/wiki/scoreboard` will answer 200 on this deployment. */
  scoreboard_available: boolean;
  /** The authoring guide / seed runbook the empty state points at. */
  doc: string;
}

// ── Testing surface (crew-testing) — governance evals + eval corpora ───────────

/**
 * The behavior signals of one eval sample — the facts the governance decide path is asked to
 * judge (mirrors the engine's decision inputs: run phase, tool invoked, files touched, content).
 * All optional: a sample carries only the signals its behavior is about.
 */
export interface GovernanceEvalSignals {
  phase?: string;
  tool?: string;
  files?: string[];
  content?: string;
}

/**
 * One eval sample: a described behavior (`kind: 'bad'` ⇒ the steering corpus SHOULD deny it,
 * `'good'` ⇒ it should pass) tagged with the steering type it exercises. Field names are the
 * engine's serde spelling (snake_case) — the report echoes them back verbatim.
 */
export interface GovernanceEvalSample {
  id: string;
  description: string;
  kind: 'good' | 'bad';
  steering_type: string;
  signals: GovernanceEvalSignals;
}

/**
 * The `POST /testing/evals/run` request body. `type` narrows the run to one steering type;
 * `corpus` names an estate scope (`evals:<name>`, as minted by `POST /testing/corpora/import`);
 * omitted, the engine runs its built-in default corpus.
 */
export interface RunGovernanceEvalsBody {
  type?: SteeringType;
  corpus?: string;
}

/** A near-miss rule on a `gap` verdict — the rule that ALMOST fired, with its similarity score. */
export interface GovernanceEvalNearestRule {
  rule_id: string;
  similarity: number;
}

/**
 * One sample's outcome. `expected` is derived from the sample's `kind` (`bad` ⇒ `deny`);
 * `fired` lists the rule ids that actually fired; `verdict` is the comparison: `caught` (a bad
 * behavior denied), `gap` (a bad behavior that sailed through), `false_positive` (a good
 * behavior denied). `nearest_rules` is present on gaps (an empty array is allowed) — the
 * remediation pointer for "which rule needs sharpening".
 */
export interface GovernanceEvalResult {
  sample: Pick<GovernanceEvalSample, 'id' | 'description' | 'kind' | 'steering_type'> & {
    /**
     * The sample's PAYLOAD identity — `sha256:` over the canonical JSON of its full payload (id,
     * description, kind, steering_type, signals). The engine echoes only the four fields above
     * (input `signals` never ride a result row), so this is stamped by a PRODUCER that held the
     * samples it staged (the internal-corpus `run`); a row without it cannot be proven to be the
     * same action as a row with the same id in another run, and the offline comparison reports
     * such a pair as unverified rather than comparable.
     */
    payload_hash?: string;
  };
  expected: 'deny' | 'allow';
  fired: string[];
  verdict: 'caught' | 'gap' | 'false_positive';
  nearest_rules?: GovernanceEvalNearestRule[];
}

/** The report's roll-up counts (snake_case — the engine's serde output, passed through verbatim). */
export interface GovernanceEvalSummary {
  total: number;
  caught: number;
  gaps: number;
  false_positives: number;
}

/**
 * One steering rule in the judged store that NO sample of the run exercised — the inverse blind
 * spot of `summary.gaps` (core #394): a gap is a sample nothing caught, but a rule with zero
 * exercising samples produces no result row at all and so is invisible to the summary. Each
 * entry names the rule and the Steering sub-page it belongs to, so the corpus can grow a sample
 * for it (or the rule can be retired as untestable).
 */
export interface GovernanceEvalUnexercisedRule {
  rule_id: string;
  steering_type: SteeringType;
}

/**
 * One steering type's row of {@link GovernanceEvalRuleCoverage.per_type} (evals.rs `TypeCoverage`):
 * how many of the run's eligible decide-lane rules OF THAT TYPE fired for at least one sample, and
 * how many fired for none. `unexercised` here is a COUNT — the ids are the parent's `unexercised`
 * list, whose rows each carry their `steering_type`, so the two reconcile per type.
 */
export interface GovernanceEvalTypeCoverage {
  exercised: number;
  unexercised: number;
}

/**
 * Rule-side coverage of an eval run (core #394/#395 — evals.rs `RuleCoverage`): the decide-lane
 * rules ELIGIBLE for the run (every active effect-bearing rule, narrowed to the run's `--type`
 * slice when one was given) partitioned into `exercised` (fired — blocking or not — for at least
 * one sample; a COUNT) and `unexercised` (fired for none; the ids, each with its steering type).
 * Together with `summary` it separates "the corpus lacks a behavior" from "the store lacks a rule"
 * — the two readings a bare gap count conflates. `recall_only` counts the active rules in the slice
 * carrying NO effect — outside the partition because the gate never fires them (core #395).
 * `per_type` is the same partition per steering type — all seven keys, zeros included (the engine
 * pins the shape).
 *
 * Every engine that emits `rule_coverage` at all (core #394 onward) serializes all four fields on
 * every report (serde, no skip). `recall_only` and `per_type` are declared optional on the CONTRACT
 * only because the daemon persists a run's coverage VERBATIM and validates none of its fields, so a
 * stored record is exactly as complete as its producer made it and the contract never promises what
 * was never checked: a consumer reads an absent `per_type` as "the engine reports no per-type
 * coverage" (the offline comparison says exactly that), never as zeros. `exercised` and
 * `unexercised` are required — no engine ever emitted one without the other.
 *
 * A run's `results[].fired` is NOT this partition's evidence: `fired` is the BLOCKING subset of the
 * firings, and under a type filter it may name rules of OTHER types — the filter slices the samples
 * and this denominator, never the gate (evals.rs `run_evals` / `evaluate_sample`).
 */
export interface GovernanceEvalRuleCoverage {
  exercised: number;
  unexercised: GovernanceEvalUnexercisedRule[];
  recall_only?: number;
  per_type?: Record<SteeringType, GovernanceEvalTypeCoverage>;
}

/**
 * The `POST /testing/evals/run` 200 body — the engine's serde report passed through VERBATIM
 * (snake_case field names, `degraded` spelled `null` when the run was full-fidelity;
 * `'facet-only'` when the gap-hint embedder was unavailable and hints fell back to lexical
 * matching — the verdicts are the same either way, only `nearest_rules` degrades).
 *
 * `rule_coverage` is OPTIONAL on purpose: an engine that predates core #394 emits a report
 * without it, and that report still validates — the daemon never fabricates the field.
 */
export interface GovernanceEvalReport {
  results: GovernanceEvalResult[];
  summary: GovernanceEvalSummary;
  degraded: 'facet-only' | null;
  rule_coverage?: GovernanceEvalRuleCoverage;
}

/** The `POST /testing/corpora/import` request body — a named eval corpus for later runs. */
export interface ImportEvalCorpusBody {
  name: string;
  samples: GovernanceEvalSample[];
}

/**
 * The `POST /testing/corpora/import` 200 body. `scope` is the estate scope the samples landed
 * under (`evals:<name>` — the string `RunGovernanceEvalsBody.corpus` names); `embedded` reports
 * whether the samples were embedded for similarity matching (false ⇒ later runs degrade to
 * facet-only).
 */
export interface ImportEvalCorpusResponse {
  imported: number;
  scope: string;
  embedded: boolean;
}

// ── Eval run history (crew-side EvalRunStore) — the Evals section's real list ───

/**
 * One steering type's slice of an eval run's rollup — the same four counts as
 * {@link GovernanceEvalSummary}, derived from the run's results grouped by `sample.steering_type`.
 * This is what makes "which steering type carries the gaps" a stored field, not a per-request
 * recompute over the full results.
 */
export interface EvalRunPerTypeCount {
  total: number;
  caught: number;
  gaps: number;
  false_positives: number;
}

/**
 * One PERSISTED eval run — the listable rollup row (`GET /testing/evals`). A run is one
 * `POST /testing/evals/run` and its report, stamped with WHO ran it, WHAT it ran against, and
 * WHEN, so the Evals section is a real history instead of a single session-local report that a
 * reload loses. The per-sample `results` are NOT here — they live on {@link EvalRunDetail} (the
 * drilldown), so listing the history stays cheap no matter how large a custom corpus is.
 *
 * Evals take no repo/project (they judge a STORE, not a workspace), so this is a single GLOBAL
 * feed per daemon — unlike recon campaign runs, which file into projects.
 */
export interface EvalRunSummary {
  /** Server-minted run id. */
  id: string;
  /** Unix SECONDS the run was recorded (the crew `created_at` convention — see AgentSession). */
  created_at: number;
  /** The authenticated actor who ran it. */
  actor: string;
  /** The corpus scope (`evals:<name>`), or null for the engine's built-in dev-behaviors corpus. */
  corpus: string | null;
  /** The single steering type the run was narrowed to, or null when it ran all seven. */
  type_filter: SteeringType | null;
  /** The steering rule store the run was judged against (the daemon's `--db` steering store). */
  rule_store: string;
  /** The report's rollup, verbatim ({@link GovernanceEvalSummary}). */
  summary: GovernanceEvalSummary;
  /** Per-steering-type rollup, derived from the results — present only for the types the run covered. */
  per_type: Partial<Record<SteeringType, EvalRunPerTypeCount>>;
  /** `'facet-only'` when the run degraded to facet matching; null when it ran full-fidelity. */
  degraded: 'facet-only' | null;
  /**
   * The report's {@link GovernanceEvalReport.rule_coverage}, persisted VERBATIM (like `degraded`,
   * never recomputed daemon-side). ABSENT — not null — when the engine that ran the eval predates
   * core #394 and emitted no coverage, so a history row honestly shows which runs measured it.
   */
  rule_coverage?: GovernanceEvalRuleCoverage;
}

/**
 * One eval run WITH its full per-sample results (`GET /testing/evals/:id`) — the drilldown behind a
 * history row. `results` is the same verbatim {@link GovernanceEvalResult} array the run's original
 * `POST /testing/evals/run` returned, so the existing report view renders it unchanged.
 */
export interface EvalRunDetail extends EvalRunSummary {
  results: GovernanceEvalResult[];
}

/** The `GET /testing/evals` 200 body — the eval run history, newest first. */
export interface ListEvalRunsResponse {
  runs: EvalRunSummary[];
}

/**
 * The `POST /testing/recon` request body (api-types 0.15.0) — the Testing page's campaign-recon
 * trigger. `problem` is the recon brief, passed to every launched run VERBATIM (the client owns
 * the framing). The two optional fields are the multiscope wire, shared with
 * {@link LaunchCampaignBody}:
 *
 *  - `repoRefs` — explicit codebase attachments: registered repo refs (ids; a unique repo NAME
 *    also resolves), deduped; a ref that does not resolve fails the whole request with a 400
 *    naming it.
 *  - `projectId` — crew resolves the project's `crew.repo` members server-side (404 unknown
 *    project; 400 when the project has zero repo members and no `repoRefs` cover for it) AND
 *    files every launched run into the project (the `POST /runs` §2.2 semantics: atomic
 *    membership + project-graph binding).
 *
 * BOTH ⇒ the union (`repoRefs` order first). NEITHER ⇒ one unscoped recon run — the launch the
 * Testing page sent before this wire existed, unchanged.
 *
 * One engine run carries ONE repo, so a multi-repo recon FANS: one governed run per resolved
 * repo, all under one shared campaign label (`TestingReconResponse.campaign`) — and a real fan
 * (>= 2 repos) registers an ENGINE campaign under that same id, so `GET /campaigns` serves it
 * (api-types 0.17.0, crew#390).
 *
 * Every launched sibling pauses at its INTAKE GATE (`human_confirm: before:1` — the launch
 * banner's promise) by default; `ungated: true` is the EXPLICIT opt-out for an unattended fan
 * (api-types 0.17.0, crew#391). It is never the silent default, and it is audited.
 */
export interface TestingReconBody {
  problem: string;
  projectId?: string;
  repoRefs?: string[];
  /** EXPLICITLY launch the siblings unattended (no intake gate). Default `false`: each sibling
   *  pauses at its intake gate before any unit runs. */
  ungated?: boolean;
}

/**
 * The `POST /testing/recon` 201 body. `runIds` is the source of truth (`length >= 1` always —
 * one run per resolved repo in the caller's order; exactly one for an unscoped recon); `runId`
 * is its first entry, kept as the single-run spelling existing launch readers expect;
 * `campaign` is the shared label every fanned run's `run.launched` audit entry carries — and,
 * when `campaignRegistered` is `true`, the id of the ENGINE campaign the fan was filed under
 * (`GET /campaigns/:id` serves it; the `runIds` are its nodes' attempt-0 run ids,
 * `{campaign}:{node}:a0`). `campaignRegistered: false` = a single/unscoped recon, or an engine
 * addon without the campaign bindings — the launch will NOT appear on `GET /campaigns`.
 */
export interface TestingReconResponse {
  runId: string;
  runIds: string[];
  campaign: string;
  /** Whether an engine campaign was registered for this launch (api-types 0.17.0). */
  campaignRegistered: boolean;
  /** Present only when the fan was campaign-registered with a `projectId` and filing a sibling
   *  into the project failed — the runs are LIVE; re-attach via POST /projects/:id/members. */
  projectAttachError?: string;
}

// ── Governance claims (crew#40/43) ─────────────────────────────────────────────

/**
 * A recorded governance decision from the conformance store (`wicked-apps-core::ConformanceClaim`).
 * `decision` values: `allow` | `deny` | `allow_with_conditions`.
 */
export interface GovernanceClaim {
  claim_id: string;
  scope: string;
  phase: string;
  policy_ids: string[];
  decision: 'allow' | 'deny' | 'allow_with_conditions';
  obligations: string[];
  evaluated_context_ref: string;
  criteria: string;
  evaluator_identity: string;
  /** Unix-seconds timestamp. */
  evaluated_at: number;
}

/** The launch-run request body (`POST /runs`). */
export interface LaunchRunBody {
  problem: string;
  sessionId?: string;
  clisJson?: string;
  entityMode?: EntityMode;
  humanConfirm?: string;
  repoRef?: string;
  /** Built-in workflow id (`feature` | `bug` | `migration`); omit for free-text single-unit mode. */
  workflow?: string;
  /**
   * The project to file this run into (DES-PROJECT-001 §2.2). The `crew.run` membership is
   * attached atomically with the launch record; an unknown or archived project fails the launch
   * (4xx) — never a silent unfiled run. Omit for an unfiled run (the synthesized `default`).
   */
  projectId?: string;
  /**
   * Delivery mode (crew#293, defaulting reworked by crew#393 / api-types 0.18.0).
   *
   * `"pr"` ⇒ the daemon appends a hardened deliver Tool phase (push the run's branch, rebase
   * onto origin's default branch, `gh pr create`; the PR URL is the phase output's last line)
   * to a PER-RUN copy of the selected workflow def — the shared def is never mutated, and
   * merge stays human. Requires `workflow`; sending `deliver: "pr"` without one is a 400.
   *
   * `"none"` ⇒ explicitly no delivery phase (the run's work stays in its worktree and the run
   * will read `delivery: 'stranded'` on the wire once completed — recoverable any time via
   * `POST /runs/:id/deliver`).
   *
   * OMITTED ⇒ the daemon decides (crew#393): a repo-scoped launch (`repoRef` set) that names a
   * CODE-WORK `workflow` — a def carrying at least one `executes_code` phase (feature, bug,
   * migration; not chat/onboarding/recon defs, whose clean worktree the deliver script would
   * fail loudly) — DEFAULTS to `"pr"`: a completed code run must end with a reviewable
   * deliverable or an explicit decision not to. The daemon setting `deliverDefault: 'none'`
   * flips that default off. Repo-less launches, free-text launches (no `workflow`, so there is
   * no def to append the phase to), and read-only-workflow launches default to `"none"`.
   *
   * `"none"` is additive (0.18.0): an older daemon's launch schema rejects it with a 400 —
   * omit the field entirely against pre-0.18 servers.
   */
  deliver?: 'pr' | 'none';
  /**
   * Retry lineage (DES-UX-001 §8.3, CREW-UX-3; api-types 0.8.0): the id of the run this
   * launch retries. Must name an EXISTING run id — an unknown id fails the launch (400 with
   * a named error), never a silently unrecorded lineage. The daemon persists it, echoes it
   * as `AgentSession.retry_of`, and carries it in the `run.launched` audit entry's detail,
   * so provenance renders "retry of {id}" from the system of record, not prompt equality.
   * Omit when the launch is not a retry.
   */
  retryOf?: string;
  /**
   * Ad-hoc campaign attach (wicked-studio#27; api-types 0.19.0): file this run onto an EXISTING
   * campaign's surface. Validated at launch, loudly: an unknown campaign id fails the launch
   * with a 404 naming it (nothing is launched); a deployment whose engine addon lacks the
   * campaign bindings answers 501 ("upgrade the engine", never "fix your request").
   *
   * The attach is daemon-side provenance ONLY (recorded in the `run.launched` audit entry,
   * restart-durable, echoed as `AgentSession.campaign_id`): the run executes byte-identically
   * to an unattached launch — it does NOT become a DAG node, is never scheduled, gated, or
   * cancelled by the campaign, and the campaign's own lifecycle ignores it. It appears on the
   * campaigns surface as a `Campaign.attached_runs` entry. Mutually exclusive with
   * `groupLabel` (both ⇒ 400). Omit both for pre-0.19 behavior, byte for byte.
   */
  campaignId?: string;
  /**
   * Ad-hoc label grouping, created on first use (wicked-studio#27; api-types 0.19.0): runs
   * launched with the same label form one group — no pre-registration, no scheduler, no DAG,
   * no shared gates; pure provenance for "these sibling launches are one effort". 1–200
   * chars. Served as a `RunGroup` row beside the campaigns on `GET /campaigns` and echoed as
   * `AgentSession.group_label`. Mutually exclusive with `campaignId` (both ⇒ 400).
   */
  groupLabel?: string;
}

/**
 * Body for `PUT /runs/:id/guidance` (DES-UX-002 §7.2, CREW-UX-7; api-types 0.9.0) — upsert the
 * run's ONE durable operator guidance note. `text: ''` CLEARS the note (the DTO field returns
 * to absent). Capped at 8192 UTF-8 bytes — beyond it the daemon answers 400 with a named
 * error. An unknown run is a 404. The write is audit-trailed (`action: 'guidance.set'` with
 * the authenticated actor) and survives daemon restart.
 */
export interface SetGuidanceBody {
  text: string;
}

/** Response of `PUT /runs/:id/guidance` — echoes what was stored (`''` after a clear). */
export interface SetGuidanceResult {
  runId: string;
  guidance: string;
}

/**
 * Response of `POST /runs/:id/deliver` (crew#393; api-types 0.18.0) — post-hoc delivery: lift a
 * COMPLETED repo-scoped run's stranded worktree into a PR with the SAME hardened script the
 * deliver phase runs (crew#293/#317: commit the run's work, refuse the default branch, rebase
 * onto origin's default branch — a conflict fails LOUDLY with nothing pushed — push, `gh pr
 * create`, and re-derive success from a real PR URL). Takes no body.
 *
 * Idempotent: a run that already delivered answers 200 with the SAME recorded `prUrl` — a second
 * call never opens a second PR. Failure is loud, never silent: 404 (unknown run), 409 (run not
 * completed / repo-less / worktree gone / a delivery already in flight / the script itself failed
 * — the body's `error` carries the script's own words, e.g. the rebase-conflict message), 500
 * (the script produced no verifiable PR URL, or could not be spawned).
 */
export interface DeliverRunResult {
  prUrl: string;
}

/**
 * The 409 body of `POST /runs/:id/resume` on a TERMINAL run (crew#311; api-types 0.18.0).
 *
 * The engine's `resume_run` no-ops on a completed/cancelled run and answers the status token, so
 * the route used to reply `200 {"status":"cancelled"}` — on the exact runs an operator was trying
 * to rescue, the recovery affordance read as "resume destroyed my run". A terminal run is now
 * refused with 409 and the ACTUAL recovery named machine-readably:
 *
 *   - `'retry'`   — relaunch as a new run with `POST /runs {"retryOf":"<id>"}` (cancelled runs,
 *     and completed runs with nothing liftable — including a `delivery: 'vacuous'` run, whose
 *     units produced no work at all);
 *   - `'deliver'` — the run completed with unlifted work in its worktree (`delivery:
 *     'stranded'`): lift it with `POST /runs/:id/deliver`.
 *
 * A FAILED run is not terminal for resume: it re-enters at the cursor as before (200 + status).
 */
export interface ResumeRefusal {
  /** Human-readable refusal naming the run's terminal status and the recovery, verbatim. */
  error: string;
  recovery: 'retry' | 'deliver';
}

// ── Governance types (crew#40/41) ──────────────────────────────────────────────

/** Per-app breakdown within a `CoverageReport`. */
export interface CoveragePerApp {
  app: string;
  behavior_bearing: number;
  resolved: number;
  risk_flagged: number;
  unaccounted: number;
  coverage: number;
}

/** A behavior-bearing node without a coverage annotation (a coverage hole). */
export interface UnaccountedNode {
  symbol_id: string;
  name?: string;
  kind?: string;
  file?: string;
  app?: string;
}

/**
 * Front-half coverage gate report (`wicked-governance::CoverageReport`).
 * `null` when the graph store has no nodes.
 */
export interface CoverageReport {
  total: number;
  behavior_bearing: number;
  resolved: number;
  risk_flagged: number;
  unaccounted: number;
  coverage: number;
  resolved_rate: number;
  mean_confidence: number;
  resolve_threshold: number;
  per_app: CoveragePerApp[];
  unaccounted_nodes: UnaccountedNode[];
}

/** One entry of a repo's code-graph summary — a node kind and how many the graph holds (#122). */
export interface GraphKind {
  kind: string;
  count: number;
}

// ── Workflow viewer + domain-model browser types (crew#44) ──────────────────

/** Gate position in the value→strategy→execution ladder. */
export type GateType = 'value' | 'strategy' | 'execution';

/** Human-confirm spec for a phase gate (serde flattened from Rust enum). */
export type GateSpec =
  | 'auto'
  | { human_confirm: { unconditional: boolean } }
  | { human_confirm_if: 'verdict_not_pass' };

/** Evaluator≠creator role for a phase. */
export type PhaseRole = 'neutral' | 'creator' | 'evaluator';

/** Methodology stage for a phase (same tokens as {@link StageKind}). */
export type StageKindPhase = 'recon' | 'build' | 'review' | 'test';

/** How a phase executes — agent (council-routed CLI) or tool (direct command). */
export type PhaseExecutor =
  | { type: 'agent' }
  | { type: 'tool'; cmd: string[] };

/** One ordered phase of a workflow — pure data. */
export interface PhaseDef {
  id: string;
  kind: StageKindPhase;
  /** How the phase executes. Omitted = Agent (engine default). Tool phases bypass the council and
   *  run `cmd` directly. */
  executor?: PhaseExecutor;
  /** Per-phase agent instructions folded into the unit prompt by the engine (core PhaseDef.instructions,
   * Option<String>). Absent = no extra instruction. Mirrors of core drop-ins that carry it (e.g.
   * survey-repo) MUST reproduce it verbatim or the runtime def diverges from core's — FINDING-011. */
  instructions?: string | null;
  gate_type: GateType | null;
  gate: GateSpec;
  executes_code: boolean;
  verified_evidence: boolean;
  required_deliverables: string[];
  depends_on: string[];
  role: PhaseRole;
  skill_ref: string | null;
  allowed_skills: string[];
  validator_pin: string | null;
}

/** A workflow — id + ordered phases. */
export interface WorkflowDef {
  id: string;
  phases: PhaseDef[];
  /** True for built-in workflows that have dedicated entry points and must not appear in the work-mode selector. */
  is_system?: boolean;
}

/** Top-level requirements_graph.json artifact (schema 1.0.0). */
export interface DomainGraph {
  metadata: { schema_version: string; migration_mode: string; source?: string };
  domains: Record<string, DomainGraphDomain>;
}

/** A capability domain in the requirements graph. */
export interface DomainGraphDomain {
  description?: string;
  cluster_id?: number;
  requirements: Record<string, DomainGraphRequirement>;
  entities: Record<string, { description?: string }>;
}

/** A requirement in a domain. */
export interface DomainGraphRequirement {
  title: string;
  description: string;
  status?: string;
  disposition?: string;
  business_rules: Array<{ id: string; statement: string; confidence: number; provenance: { source: string } }>;
  validations: Array<{ id: string; statement: string; confidence?: number }>;
  error_paths: Array<{ id: string; statement: string }>;
}

/** Coverage stats from `wicked-core coverage --json` — present when code is indexed but domain not yet annotated. */
export interface DomainCoverage {
  coverage: number;
  total: number;
  behavior_bearing: number;
  resolved: number;
}

/** The open-terminal request body (`POST /terminals`, DES-TERMINAL-001 §6). */
export interface OpenTerminalBody {
  /** Working directory the PTY opens in. */
  cwd: string;
  /** Command to run; omit for the user's login shell. */
  cmd?: string[];
  cols: number;
  rows: number;
  /**
   * Omit for the safe governed default; `false` is the loud, opt-in UNGOVERNED
   * operator shell (surfaced as ungoverned in the UI, DES-TERMINAL-001 §7).
   */
  governed?: boolean;
}

/** Symbol-level code graph from estate (GET /repos/:id/graph). */
export interface CodeGraphNode {
  id: string;      // estate symbol ID (primary key)
  name: string;    // short display name (function/class/type name)
  kind: string;    // function | class | struct | interface | type_alias | method | enum
  file: string;    // source file path
  inDeg: number;   // incoming call/import count (hotspot indicator)
  outDeg: number;  // outgoing call/import count
  lang: string;    // language (typescript, rust, python, etc.)
}
export interface CodeGraphEdge { src: string; tgt: string; }
export interface CodeGraphData {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  stats: { nodeCount: number; edgeCount: number; fileCount: number };
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

export interface GitContributor {
  commits: number;
  name: string;
  email: string;
}

/** Daemon-persisted system settings (~/.config/wicked-core/settings.json). */
export interface SystemSettings {
  /** Max nodes returned by wicked-estate graph-view (default 150). */
  graphNodeLimit: number;
  /**
   * Base directory for the ENGINE-OWNED worker CLI config homes (the claude worker home is
   * `<root>/claude`). The daemon applies it as env `WICKED_WORKER_HOME` at boot and on every
   * settings change; the engine reads that env per worker spawn (acp_runner.rs), so a change
   * takes effect on the next spawn with no restart. Absolute path when set; `""` or absent =
   * the engine default `~/.wicked-worker`.
   */
  worker_config_root?: string;
  /*
   * There is NO skills setting (skills keystone, api-types 0.28.0). The daemon-owned skills root is
   * `<state home>/skills` — the directory holding `manifest.json`, `baseline/<hash>/`, `effective/`,
   * `snapshots/<gen>/` and the `current` symlink — full stop: not configurable (a `skills_root` a
   * client sends is dropped and named in the audit entry's `ignored`; design v3.1 §1 one storage
   * root, v3.2 §1 never a user CLI directory), and there is no mirror knob either (the daemon never
   * writes into the user's own CLI directories). `GET /skills` → `root` and `GET /diagnostics` →
   * `skills.root` report where it is.
   */
  /**
   * The repo-scoped launch delivery DEFAULT (crew#393; api-types 0.18.0, additive). What a
   * `POST /runs` with `repoRef` + a CODE-WORK `workflow` (a def with at least one
   * `executes_code` phase) and NO explicit `deliver` resolves to: `'pr'` (the shipped default —
   * completed code runs open their PR) or `'none'` (work stays in the worktree, surfaced as
   * `delivery: 'stranded'`). Absent reads as `'pr'`. Never consulted when the launch body sets
   * `deliver` explicitly, and never applied to repo-less, free-text, or read-only-workflow
   * launches (those are always `'none'`).
   */
  deliverDefault?: 'pr' | 'none';
  /**
   * The stall watchdog's DETECTION threshold (crew#287; api-types 0.18.0 — previously a
   * daemon-local extension): minutes a run in `executing` may go without ANY engine event on the
   * daemon's relay before one synthetic `workerStalled` frame per quiet period is broadcast on
   * `/ws`. Integer 1..1440; absent = the daemon default (15). Detection never touches the run.
   */
  workerStallMinutes?: number;
  /**
   * The stall watchdog's ESCALATION threshold (crew#341; api-types 0.18.0): quiet minutes before
   * the watchdog ACTS on a detected stall (see {@link WorkerStallEscalatedFrame}). Integer
   * 0..1440; `0` = escalation OFF. **Absent = the daemon default (30 — armed)**: as of perf#4 the
   * ladder is ON by default (run 616c8661 burned a full 2h turn ceiling with the watchdog
   * detection-only; the engine's `reassignUnit` supersedes the wedged turn safely, so acting is
   * strictly better than watching). 30 leaves ~55% headroom over the slowest legitimate
   * time-to-first-output observed in the field (~19.4 min) while still recovering ~4x faster
   * than the 2h ceiling. Opt out with an explicit `0`. Values below
   * `workerStallMinutes` escalate at the detection threshold — the ladder never acts before it
   * has notified.
   */
  workerStallEscalateMinutes?: number;
  /**
   * What an armed escalation DOES (crew#341): `'reassign'` (default) recycles the wedged cursor
   * unit — the engine supersedes the stale turn, closes the worker session, bumps the
   * attempt, and re-dispatches (queued operator injects survive into the fresh turn). As of
   * perf#4 the watchdog routes the re-dispatch to a DIFFERENT seat from the run's own pool when
   * one is available (a seat that just sat silent past the escalation threshold is the last
   * seat to hand the retry to), falling back to an in-place recycle on a single-seat pool.
   * `'notify'` is the fail-loud rung — a `needsYou` `workerStallEscalated` frame + an audit
   * entry, the run untouched.
   */
  workerStallEscalateAction?: 'reassign' | 'notify';
  /**
   * Per-run budget of AUTOMATIC reassigns (crew#341): integer 1..10, default 2. Once spent, a
   * still-silent run gets `outcome: 'exhausted'` `needsYou` frames instead of further recovery —
   * a worker that wedges deterministically must reach a human, not loop through seats forever.
   * Ignored when `workerStallEscalateAction` is `'notify'`.
   */
  workerStallMaxEscalations?: number;
  /**
   * SKIN-OWNED preference blobs (crew#323). The settings store is shared: alongside the
   * engine's keys it carries the studio's own state — `studio.appearance` (accent/logo/theme),
   * `studio.notifications` (desktop-notification opt-in) — which the daemon persists and
   * returns VERBATIM without ever interpreting them.
   *
   * `PUT /settings` accepts a key matching `^studio\.[a-z][a-z0-9-]*$` whose value is
   * JSON-serializable and at most 512KB of JSON; it answers 400 naming the key otherwise.
   * Any other unrecognized key is still dropped from the patch (request bodies are
   * forward-additive, §5.1), so a skin's own state MUST ride this namespace to persist.
   */
  [key: `studio.${string}`]: unknown;
}

// ── Requirements management (server-side search + overrides; crew api/requirements.ts) ──
export interface RequirementSummary {
  key: string;
  domain: string;
  reqId: string;
  title: string;
  category: 'functional' | 'config-data';
  statement: string;
  status: string;
  risk: boolean;
  riskSource: 'operator' | 'data' | null;
  edited: boolean;
}

export interface RequirementDetail extends RequirementSummary {
  description: string;
  notes: string;
  sourceTitle: string;
  ruleCount: number;
  componentCount: number;
  validationCount: number;
  errorPathCount: number;
  businessRules: unknown[];
  legacyComponents: unknown[];
}

export interface RequirementsPage {
  total: number;
  corpus: number;
  offset: number;
  limit: number;
  items: RequirementSummary[];
  /** Which source served the corpus: the live estate store, or the evidence-gated
   *  `requirements_graph.json` snapshot, which can lag it by hours (FINDING-065). */
  source: 'store' | 'artifact';
  /**
   * Keys in `requirements_overrides.json` that matched NO requirement in the corpus. Operator
   * edits are keyed by SymbolId (store) or `domain::reqId` (artifact); an estate id-scheme
   * migration re-mints method/field SymbolIds, so overrides keyed by the old ids stop matching and
   * would otherwise vanish silently. Non-zero means edits exist that no row is showing — re-run
   * the annotation workflow, then re-apply or delete the stale keys.
   */
  orphanedOverrides?: number;
}

export interface RequirementPatch {
  title?: string;
  notes?: string;
  status?: 'active' | 'deprecated' | 'review';
  risk?: boolean;
}

// ── Blast radius (wicked-estate blast-radius --json via crew) ──
export interface BlastRadius {
  target: string;
  dependents: Array<{ id: string; name: string; kind: string; file: string; line: number }>;
  /**
   * References to the target that no resolver bound (ENGINE-CONTRACT §2.1). Repeat call-sites of
   * an already-bound relationship are NOT counted, so 0 is a legitimate value for a fully-resolved
   * hot symbol. When non-zero, an empty `dependents` still never means "safe".
   */
  unresolved: number;
}

/** An open elicitation as `GET /runs/:id/elicitation` returns it (DES-002). */
export interface ElicitationInfo {
  runId: string;
  elicitationId: string;
  message: string;
  /** Ordered set of valid responses; `null` means free-text. */
  options: string[] | null;
  receivedAt: string;
}

/** `POST /runs/:id/elicitation` body. `content` is required for accept, absent otherwise. */
export interface ElicitationResponse {
  elicitationId: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: { response: string };
}

// ── Projects (DES-PROJECT-001) — the experience-plane keystone ─────────────────

/** Project lifecycle: `active ⇄ archived`, no hard delete (ADR §1.3). */
export type ProjectLifecycle = 'active' | 'archived';

/**
 * A named, control-plane-owned container whose members are work units from any
 * plane (`GET /projects`, `GET /projects/:id`). Mirrors wicked-core's serde
 * shape (`project.rs`) — Rust `Option` fields arrive as `null`, never absent.
 * The synthesized `default` project ("Unfiled") appears in lists with
 * `id: "default"`, `scope: ""`, and zero timestamps; it rejects PATCH/attach.
 */
export interface Project {
  /** `proj_<sortable>` — minted by control at create; or the reserved `default`. */
  id: string;
  name: string;
  description: string | null;
  status: ProjectLifecycle;
  /** The estate scope path of this project's record (`project:<id>`; `""` for `default`). */
  scope: string;
  /** Unix millis. */
  created_at: number;
  /** Unix millis. */
  updated_at: number;
  /**
   * DES-MERGE-001 §7.1 — the wicked-interactive docs root this project speaks to; `null` ⇒
   * the shared default root (ADR-0025). Held crew-side and merged onto the engine's row at the
   * route boundary, so the wire carries ONE project shape. Always present on a read.
   */
  interactiveRoot?: string | null;
  [k: string]: unknown;
}

/**
 * A typed, opaque membership reference (ADR §1.2). `member_kind` is the open
 * `<product>.<noun>` grammar (`crew.run`, `crew.chat`, `crew.repo`,
 * `crew.workflow`, `interactive.doc`, reserved `studio.session`).
 */
export interface ProjectMember {
  /** Derived from `(project_id, member_kind, member_ref)` — the UNIQUE constraint. */
  id: string;
  project_id: string;
  member_kind: string;
  /** Opaque to the engine; `crew.*` refs are checked at the API layer at attach time. */
  member_ref: string;
  /** Skin hints (doc root, display title, …) as JSON text; `null` when none. */
  meta: string | null;
  /** Unix millis. */
  attached_at: number;
  /** The attaching surface: `studio` | `interactive` | `cli` | `api`. */
  attached_by: string;
  [k: string]: unknown;
}

/** `GET /projects/:id` — detail + members (ADR §5.2). */
export interface ProjectDetail {
  project: Project;
  members: ProjectMember[];
}

/** `POST /projects` body. */
export interface CreateProjectBody {
  /** 1–120 chars; unique among ACTIVE projects (409 on collision). */
  name: string;
  description?: string;
}

/** `PATCH /projects/:id` body — rename / describe / archive / restore. */
export interface UpdateProjectBody {
  name?: string;
  /** `""` clears the description. */
  description?: string;
  status?: ProjectLifecycle;
  /** DES-MERGE-001 §7.1 — bind this project to a wicked-interactive docs root.
   *  `null` clears the binding back to the shared default root. */
  interactiveRoot?: string | null;
}

/** `POST /projects/:id/members` body. */
export interface AttachMemberBody {
  /** `<product>.<noun>` (open grammar). */
  kind: string;
  ref: string;
  /** Skin hints, carried opaquely. */
  meta?: Record<string, unknown>;
  /** The attaching surface; defaults to `api`. */
  attachedBy?: 'studio' | 'interactive' | 'cli' | 'api';
}

/**
 * The crew half of a governed doc delete (crew#338) — what
 * `DELETE /projects/:projectId/interactive/docs/:doc` did to crew's four handoff ledgers
 * (`interactive-{draft,edit,chat,demo}-ledger.json`). Present on every answer of that route so
 * a partial result can never hide.
 */
export interface InteractiveDocDeleteLedgerReport {
  /** True iff every ledger was swept without error. On the 502 refusal paths this is false with
   *  `skipped: true` — the sweep deliberately did not run because interactive's half did not
   *  happen (nothing diverged). */
  ok: boolean;
  /** Every replay-dedup row key actually dropped (`<doc>`, `<doc>:v<n>`, `<doc>:m:<id>`, …).
   *  Empty ⇒ nothing was there — deleting a never-drafted doc is a clean no-op on this side. */
  removed_keys: string[];
  /** The ledgers that could NOT be swept, by seam name (`draft`|`edit`|`chat`|`demo`) and cause.
   *  Present only when `ok` is false and the sweep actually ran. */
  errors?: { ledger: string; error: string }[];
  /** True ⇒ the sweep was deliberately skipped (interactive refused/failed the retire, so
   *  crew's rows are still doing their job and nothing diverged). */
  skipped?: boolean;
}

/**
 * `DELETE /projects/:projectId/interactive/docs/:doc` (crew#338) — 200: the bridge's own retire
 * answer (interactive#189's wire, relayed verbatim) plus crew's ledger report. The route's
 * non-200 answers carry `error` plus the same `ledger` report (404 unknown doc — the ledger is
 * STILL swept, cleaning ghosts of hand-deleted workspaces, but ONLY on the retire wire's own
 * 404 body `{"error":"unknown doc"}`; 500 partial — interactive retired but the sweep failed,
 * the body names both halves; 502 — interactive did not retire (5xx, unreachable, or a 404
 * without the wire's body from a bridge predating the retire route), nothing swept; 409 — the
 * bridge's build-in-flight refusal relayed verbatim, no `ledger` field).
 */
export interface InteractiveDocDeleteResponse {
  /** The doc name (slug). */
  name: string;
  kind: 'doc' | 'html' | 'source' | 'demo';
  retired: true;
  /** True on a repeat delete — idempotent, with the ORIGINAL `retired_at` and no `event_id`. */
  already_retired: boolean;
  /** ISO-8601 retirement timestamp. */
  retired_at: string;
  /** Head version at retirement. */
  head: number;
  /** Lineage size at retirement. */
  versions: number;
  /** The `wicked.interactive.doc.retired` bus event id — first retire only (no re-emit). */
  event_id?: number;
  /** What crew dropped from its handoff ledgers. */
  ledger: InteractiveDocDeleteLedgerReport;
}

/** One hand-pinned demo step on a `kind: "demo"` create (api-types 0.30.0): the wizard's ordered
 *  steps the governed run authors the spec from (ADR-0018: the agent authors, the service records). */
export interface InteractiveDemoStepDraft {
  index: number;
  subject: string;
  action: string;
}

/**
 * The body of `POST /projects/:projectId/interactive/api/docs` as crew's proxy understands it
 * (acceptance finding F-046; api-types 0.30.0 — the studio types its create from THIS declaration,
 * no local mirror). The bridge's own fields (`name`, `kind`, `html`, `brief`, `source_paths`,
 * `url`, `demo_steps`, `style`, `project`, `source_message_id`) are relayed as-is — this type
 * documents the two things CREW adds at the proxy before forwarding:
 *
 *  - `repo_ref` / `repo_refs` — the repository (or repositories) this document is ABOUT, each a
 *    registered repo id, its registry name, or its root directory's basename. Crew validates them
 *    against the project's `crew.repo` members BEFORE the bridge sees the request (a miss is the
 *    400 {@link InteractiveDocCreateRefusal}, nothing created), strips them from the forwarded
 *    body, and remembers the binding so the governed draft/demo run is grounded on THOSE repos
 *    (offline snapshot + the project graph) — never on the project's first member. Unfiled
 *    (`default` mount) documents cannot name a repository.
 *  - `style` — passed through when given; when ABSENT crew infers it from the brief's format
 *    words (print-ready / A4 / brochure → `brochure`; slides / deck → `ppt`; memo / whitepaper →
 *    `doc`) so the bridge's own print instructions apply to a print brief. No format words → the
 *    bridge's `web` default.
 */
export interface InteractiveDocCreateRequest {
  /** The doc name; the bridge slugifies it (409 when taken or retired). */
  name?: string;
  /** Omitted = a plain html doc (`html` required); `source` = generated from brief/sources; `demo` = a recording. */
  kind?: 'source' | 'demo';
  /** A plain html doc's content (or a `source` doc's seed). */
  html?: string;
  brief?: string;
  source_paths?: string[];
  /** `kind: "demo"` — the live app URL to record against. */
  url?: string;
  /** `kind: "demo"` — hand-pinned steps; omitted = the run authors them from the brief. */
  demo_steps?: InteractiveDemoStepDraft[];
  style?: 'web' | 'ppt' | 'brochure' | 'doc';
  /** Crew project binding (DES-PROJECT-001 §2.3): registration is the authority. */
  project?: string;
  /** The thread message this generation came from (§7.6). */
  source_message_id?: string;
  /** ONE subject repository: a repo id, its name, or its root basename. */
  repo_ref?: string;
  /** SEVERAL subject repositories (at most 8); the union with `repo_ref`, de-duplicated. */
  repo_refs?: string[];
}

/**
 * Crew's 400 on `POST /projects/:projectId/interactive/api/docs` when the request names a
 * repository the document cannot be grounded on (F-046; api-types 0.30.0). Nothing was created
 * on the bridge.
 */
export interface InteractiveDocCreateRefusal {
  /** Human-readable, names the fix (attach the repo, pick one of `available`, name it by id, …). */
  error: string;
  /**
   * `repo_not_in_project` — a ref matched no member repo; `unfiled_doc_repo` — a repo named on the
   * Unfiled mount; `invalid_repo_ref` — junk spelling / shape / over the cap; `ambiguous_repo_ref`
   * — a name or basename shared by several member repos (name it by id); `project_mismatch` — the
   * body's `project` is not the route's project (or is present on the Unfiled mount). The proxy
   * canonicalizes an OMITTED `project` from the route.
   */
  code: 'repo_not_in_project' | 'unfiled_doc_repo' | 'invalid_repo_ref' | 'ambiguous_repo_ref' | 'project_mismatch';
  /** The refs the request named, as spelled (best-effort stringified when malformed). */
  requested: string[];
  /** The subset of `requested` that matched no member repo (`repo_not_in_project` only). */
  missing?: string[];
  /** `ambiguous_repo_ref`: each ambiguous ref with the member repos it names. */
  ambiguous?: Array<{ ref: string; candidates: Array<{ id: string; name: string }> }>;
  /** The project's `crew.repo` members the request could have named. */
  available?: Array<{ id: string; name: string }>;
}

/**
 * The 502 the create earns when the bridge dropped the connection AFTER the request had reached it
 * (api-types 0.30.0): the document may already exist, so the proxy never replays the POST — list the
 * project's documents before creating again.
 */
export interface InteractiveDocCreateUndetermined {
  code: 'create_undetermined';
  error: string;
}

/**
 * The payload of `wicked.interactive.status.posted` as crew's own seams emit it (`producer_id:
 * "wi-crew"`, relayed on `/ws` inside an `interactiveEvent` frame; api-types 0.30.0). Acceptance finding F-045: every
 * seam emit — status narration, the terminal error/complete lines, and the closing
 * `draft.completed` / `edit.completed` / `demo.requested` — now carries `project_id` for a
 * project-bound document (omitted for an Unfiled one), exactly like the bridge's own emits, so a
 * skin can file the frame under the right thread. A skin should ALSO match frames by
 * `document_id` alone when the doc is open under exactly one mount (belt and braces).
 */
export interface InteractiveStatusPosted {
  ts: string;
  document_id: string;
  /** Present for a project-bound document. */
  project_id?: string;
  state: 'processing' | 'working' | 'asking' | 'complete' | 'error';
  message?: string;
  /** The edit seam stamps the handoff version it is answering. */
  version?: number;
}

/**
 * One row of `GET /projects/:projectId/interactive/api/docs` (crew#472) — the bridge's own
 * `GET /api/docs` row (interactive's `listDocs` shape, relayed field-for-field) stamped with the
 * project whose mount it was listed under. Docs roots are partitioned per project (the `default`
 * project keeps the legacy shared root), so `projectId` is the attribution a client rendering
 * docs from several projects at once cannot otherwise recover.
 */
export interface InteractiveDocSummary {
  /** The doc name (slug). */
  name: string;
  /** Manifest `kind`; a manifest without one lists as `doc`. */
  kind: 'doc' | 'html' | 'source' | 'demo';
  /** Head version. */
  head: number;
  /** Lineage size. */
  versions: number;
  /** ISO-8601 timestamp of the head version, or null when the lineage is empty. */
  updated_at: string | null;
  /** Present only on a retired (tombstoned) row, which lists only with `?includeRetired=1`. */
  retired?: true;
  /** ISO-8601 retirement timestamp; present with `retired`. */
  retired_at?: string;
  /** The crew project this row was listed under — the mount's `:projectId`. */
  projectId: string;
}

/**
 * One normalized entry of the merged project activity feed
 * (`GET /projects/:id/activity`, ADR §5.2): core events of member runs/chats
 * ∪ bus `wicked.interactive.*` events carrying this `project_id`.
 */
export interface ActivityEntry {
  /** Stable entry id (`crew:<run>:<seq>` | `bus:<event_id>`) — the cursor tiebreaker. */
  id: string;
  /** Unix millis. */
  ts: number;
  source: 'crew' | 'interactive';
  /** The event type (`awaitingHuman`, `wicked.interactive.version.created`, …). */
  kind: string;
  /** The member the entry belongs to (run id, doc name). */
  ref: string;
  summary: string;
  /** The original frame/payload, verbatim. */
  raw: unknown;
}

/** `GET /projects/:id/activity` — newest-first, cursor-paginated on `(ts, id)`. */
export interface ActivityPage {
  projectId: string;
  entries: ActivityEntry[];
  /** Opaque; pass back as `?cursor=`. `null` ⇒ no older entries. */
  nextCursor: string | null;
}

/**
 * A durable interaction request (DES-PROJECT-001 §5.3) as the engine persists
 * it — written in the same transaction as the run's `awaiting_human`
 * transition, resolved in the same transaction as the gate decision. The
 * prompt inbox (`GET /projects/:id/prompts`) returns the OPEN ones across the
 * project's member runs.
 */
export interface InteractionRequest {
  /** `ir_<derived>` — stable across re-pauses of the same `(run, kind, ord)`. */
  id: string;
  /** The owning run. */
  session_id: string;
  kind: 'gate' | 'elicitation';
  /** The unit ordinal the gate pauses before; `null` when not unit-bound. */
  ord: number | null;
  /** The already-run unit the gate reviews, when attributable. */
  reviewing_ord: number | null;
  prompt: string;
  status: 'open' | 'answered' | 'expired' | 'cancelled';
  /** The decision payload (JSON text, e.g. `{"approve":true,"amend":null}`) once resolved. */
  answer: string | null;
  /** Unix millis. */
  created_at: number;
  /** Unix millis; `null` while open. */
  resolved_at: number | null;
  [k: string]: unknown;
}

/** `GET /projects/:id/prompts` — the open prompt inbox across member runs. */
export interface ProjectPrompts {
  projectId: string;
  prompts: InteractionRequest[];
}

/** `POST /chats` body (gains `projectId` with DES-PROJECT-001). */
export interface ChatOpenBody {
  chatId?: string;
  clis?: string[];
  repoRef?: string;
  /** File the chat into a project (`crew.chat` membership, attached on open). */
  projectId?: string;
}

// ── Project code graph (DES-PROJECT-001; the co-located multi-repo graph) ──────
//
// A project's `crew.repo` members indexed into ONE wicked-estate database, each under a stable
// label, so one query answers over every repo the project contains.
//
// THE LIMIT, stated on the wire because it is not obvious from the results: this is CO-LOCATION,
// NOT LINKAGE. estate resolves edges within a labelled repo's own nodes only, exactly as if each
// repo sat in its own database. `studio → wicked-crew-api-types → crew` does NOT traverse; what
// these shapes carry is per-repo results gathered in one place, with the repo named on every hit.
// Every response repeats it in `linkage` + `note` so a consumer cannot read a cross-repo answer as
// a cross-repo TRACE.

/** Co-location, never linkage — a single-valued field so a future linked mode is additive. */
export type ProjectGraphLinkage = 'co-located';

/**
 * Why a project graph cannot answer, or the terms on which it can.
 *
 * - `ready` — indexed, two or more repos.
 * - `ready-single-repo` — indexed, exactly one repo: answers are correct but can never be
 *   cross-repo, which a caller asking a project-scoped question needs told.
 * - `no-repo-members` — the project has no `crew.repo` member. Not an error and not an empty
 *   graph: there is nothing to build one from.
 * - `not-indexed` — it has repo members and no database yet. `POST /projects/:id/graph/refresh`
 *   is the fix, and the `detail` says so.
 * - `engine-too-old` — the running wicked-core addon does not publish `code_graph_db` on the repo
 *   record (wicked-core#170), so its repo-record contract predates this surface.
 */
export type ProjectGraphState =
  | 'ready'
  | 'ready-single-repo'
  | 'no-repo-members'
  | 'not-indexed'
  | 'engine-too-old';

/** One member repo's standing in the project graph. */
export interface ProjectGraphRepo {
  /** Registry id (`RepoEntry.id`) — the member ref this came from. */
  repoId: string;
  /** The estate label its rows carry, and the prefix on every `file` path it contributes. */
  label: string;
  rootPath: string;
  /** `false` ⇒ its symbols are NOT in the graph; `reason` says why and results stay partial. */
  indexed: boolean;
  /** Commit indexed, when git could answer. */
  head?: string;
  /** Unix millis of the index that put these rows in. */
  indexedAt?: number;
  /**
   * Present when `indexed` is false: registry miss, index failure, never refreshed, or the rows
   * under this label were indexed from a DIFFERENT root than the registry now names (a repo that
   * moved — wicked-estate binds a label to the root it first saw and refuses to rebind it, so the
   * graph keeps the old checkout's symbols until the project graph is rebuilt).
   */
  reason?: string;
  /**
   * The action that actually resolves THIS cause, when one action does. Carried per-row because
   * the causes do not share a remedy: "never refreshed" and "attached since the last refresh" are
   * fixed by a refresh, a DANGLING member ref is not (the registry no longer knows the ref, so a
   * refresh indexes nothing new), and a MOVED root needs a rebuild when estate refuses to rebind
   * the label. Absent ⇒ no single action fixes it, or `reason` already spells the remedy out.
   * Never assume a refresh: telling an operator mid-incident to run one that cannot work costs
   * them the time it takes to run it and the trust to believe the next message.
   */
  remedy?: string;
}

/** `GET /projects/:id/graph` — what the project graph holds and what it cannot answer. */
export interface ProjectGraphStatus {
  projectId: string;
  state: ProjectGraphState;
  /** One sentence naming the state's cause and its remedy. Always present, never empty. */
  detail: string;
  /** Absolute path of the co-located database; `null` when there is none to point at. */
  dbPath: string | null;
  repos: ProjectGraphRepo[];
  /** Member repos absent from the graph — any answer is PARTIAL while this is non-empty. */
  missingRepos: string[];
  /** Labels still in the database whose repo is no longer a member; excluded from results. */
  staleRepos: string[];
  linkage: ProjectGraphLinkage;
  note: string;
  /** Unix millis of the last refresh; `null` when never refreshed. */
  updatedAt: number | null;
}

/**
 * `POST /projects/:id/graph/refresh` body. Optional — an empty body is the plain incremental
 * refresh.
 *
 * `force: true` exists for MIGRATION, not for routine use: the plain refresh skips any member repo
 * whose clean checkout is still at the HEAD the manifest recorded, so after a wicked-estate upgrade
 * an UNCHANGED repo never re-indexes and its rows keep the old binary's id scheme and unresolved
 * accounting (ENGINE-CONTRACT §2.1) indefinitely. Force bypasses that skip for every member repo
 * AND passes `--force` to `wicked-estate index`, so estate performs a full re-extract even when its
 * own incremental digest would skip. Expect it to take as long as the project's first build.
 */
export interface RefreshProjectGraphBody {
  /** Re-index every member repo, bypassing the clean-HEAD skip and estate's digest skip. */
  force?: boolean;
}

/**
 * One member repo's outcome in a refresh — why it did or did not index. `skipped-head-unchanged`
 * is the row an operator reads when asking why a repo did not migrate after an estate upgrade:
 * the plain refresh trusts a clean checkout at the manifest's HEAD, so only `force` (or a new
 * commit) makes that repo re-index.
 */
export interface ProjectGraphRefreshRepo {
  repoId: string;
  /** The estate label its rows carry. */
  label: string;
  /** What this refresh did with the repo. */
  action: 'indexed' | 'skipped-head-unchanged' | 'failed';
  /**
   * Bounded tail (last 2 KiB) of `wicked-estate index` stderr, present when the binary said
   * anything — notably estate's id_scheme migration notice explaining why a refresh that used to
   * skip in a second ran a full re-extract for minutes.
   */
  stderrTail?: string;
  /** Present when `action` is `failed` — the same message the `failed` array carries. */
  error?: string;
}

/** `POST /projects/:id/graph/refresh` — an incremental (re)build, repo by repo. */
export interface ProjectGraphRefreshResult {
  status: ProjectGraphStatus;
  /** Labels re-indexed this run. */
  indexed: string[];
  /** Labels skipped because the checkout is clean and its HEAD is already in the graph. */
  skipped: string[];
  /** Repos that failed to index, with the reason; the graph keeps whatever it already had. */
  failed: Array<{ repoId: string; label: string; error: string }>;
  /** Per-repo outcomes with the WHY (and any index stderr) attached — one row per member repo. */
  repos?: ProjectGraphRefreshRepo[];
}

/** One hit, always attributed: a cross-repo answer that does not say WHERE is not an answer. */
export interface ProjectGraphHit {
  /** The repo's registry id. */
  repoId: string;
  /** The repo's estate label. */
  repo: string;
  /** estate SymbolId — carries the label, so it is unique across the project. */
  id: string;
  /**
   * The graph node's name, VERBATIM from estate. For a `kind: 'file'` node that name IS the
   * label-prefixed path (`wicked-vault/src/vault/vault.mjs`) — left as estate minted it, because
   * rewriting it would produce a name that resolves to nothing. Use `repo` + `file` to display it.
   */
  name: string;
  kind: string;
  /** REPO-RELATIVE path, label stripped — the same spelling `/repos/:id/graph` returns. */
  file: string;
  line: number;
}

/** Per-repo hit counts, so "which repo does this touch" is answerable without scanning hits. */
export interface ProjectGraphRepoCount {
  repoId: string;
  repo: string;
  count: number;
}

/** `GET /projects/:id/graph/blast-radius?name=` — dependents across every member repo. */
export interface ProjectBlastRadius {
  projectId: string;
  target: string;
  dependents: ProjectGraphHit[];
  byRepo: ProjectGraphRepoCount[];
  /**
   * References to the target that no resolver bound (ENGINE-CONTRACT §2.1). Repeat call-sites of
   * an already-bound relationship are NOT counted, so 0 is a legitimate value for a fully-resolved
   * hot symbol. When non-zero, an empty `dependents` still never means "safe".
   */
  unresolved: number;
  /** Labels actually covered by this answer. */
  reposSearched: string[];
  /** Member repos NOT covered — the answer is partial while this is non-empty. */
  missingRepos: string[];
  linkage: ProjectGraphLinkage;
  note: string;
}

/** `GET /projects/:id/graph/search?name=` — exact-name symbol resolution across member repos. */
export interface ProjectGraphSearch {
  projectId: string;
  query: string;
  matches: ProjectGraphHit[];
  byRepo: ProjectGraphRepoCount[];
  reposSearched: string[];
  missingRepos: string[];
  linkage: ProjectGraphLinkage;
  /**
   * Carries the co-location limit AND the matching rule: this is EXACT-NAME resolution, so an
   * empty `matches` means "no symbol by that exact name" and never "not in this project". A
   * partial or fuzzy name returns nothing even when the symbol exists.
   */
  note: string;
}

// ── Campaigns (DES-CAMPAIGN-001 / crew#342 slice 1 + TH-9) ───────────────────
// The engine's Campaign scheduler — a durable, crash-resumable, dependency-aware parallel DAG of
// governed Runs — exposed over `/api/v1/campaigns`. The GET routes return the ENGINE's persisted
// shapes verbatim (wicked-core `src/campaign.rs` serde: snake_case fields, snake_case enum
// tokens), same doctrine as `SessionView`: one producer of the wire shape, zero re-spelling in
// the daemon. The POST body (`LaunchCampaignBody`) is the daemon's own camelCase request contract
// — crew maps it onto the engine def, composing one Tool-executor workflow per deterministic
// scenario (spec FILE PATHS on the argv, never scenario bodies — the 1022-byte PTY prompt trap).

/** Per-node lifecycle status. Terminal = `completed` | `failed` | `blocked` | `cancelled`. */
export type CampaignNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'awaiting_human'
  | 'ready_to_resume'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

/** Campaign lifecycle status — also the token `POST /campaigns/:id/resume` / `/cancel` resolve to. */
export type CampaignStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

/** When a dependency edge is satisfied: dep `completed` only, or any terminal outcome. */
export type CampaignEdgeCondition = 'on_success' | 'on_terminal';

/** How a node failure propagates (DES-CAMPAIGN-001 §5.2). */
export type CampaignFailurePolicy = 'fail_fast' | 'continue_independent' | 'human_gate_on_failure';

/**
 * What one campaign node runs — the engine's reusable Run specification (mirrors a launch minus
 * the session id, which the scheduler derives as `{campaign}:{node}:a{attempt}`). A node inherits
 * governance, worktree isolation, HITL gates, live output, and per-Run resume from the Run it is.
 */
export interface CampaignRunSpec {
  /** The free-text problem this node's Run decomposes — for a scenario node, a short human label
   *  (the scenario body lives in its spec FILE; it is never inlined here). */
  problem: string;
  /** The council roster (`AgenticCli` seats) convened for this node's Run. */
  clis: unknown[];
  entity_mode: EntityMode;
  /** The node's internal human-confirm gate policy (engine serde shape); absent = none. */
  human_confirm?: unknown;
  /** The registered repo the node's Run targets, if any (creates an isolated worktree). */
  repo_ref?: string | null;
  /** The registered `WorkflowDef` id this node's Run follows — for a deterministic scenario node,
   *  the per-node composed Tool workflow (`campaign-<campaign>-<node>`). */
  workflow_id?: string | null;
}

/** A schedulable unit of the DAG — one node = one governed core Run. */
export interface CampaignNode {
  /** Stable node id, unique within the campaign (never contains `:` — it keys the run id). */
  node_id: string;
  run_spec: CampaignRunSpec;
}

/** A dependency edge `from -> to`: `to` becomes eligible once `from` satisfies `condition`. */
export interface CampaignEdge {
  from: string;
  to: string;
  condition: CampaignEdgeCondition;
}

/** The static campaign definition — validated at launch (cycle / empty / duplicate-edge /
 *  unknown-endpoint rejects) and persisted verbatim inside the live {@link Campaign}. */
export interface CampaignDef {
  id: string;
  name: string;
  nodes: CampaignNode[];
  edges: CampaignEdge[];
  policy: CampaignFailurePolicy;
  /** Global concurrency cap (>= 1) — a resource guard on parallel worktrees + CLI subprocesses. */
  max_concurrency: number;
}

/**
 * The live campaign instance (`GET /campaigns`, `GET /campaigns/:id`) — durable and
 * crash-resumable; the scheduler re-derives the ready set from these persisted statuses on
 * resume, never re-running a completed node.
 */
export interface Campaign {
  id: string;
  def_id: string;
  status: CampaignStatus;
  /** The full definition, embedded so a resume needs no second store. */
  def: CampaignDef;
  node_status: Record<string, CampaignNodeStatus>;
  /**
   * node_id -> live Run id, always `{campaign}:{node}:a{attempt}` (attempt-keyed, idempotent).
   *
   * These values ARE the engine session ids: a node's run is an ordinary governed run, so it is
   * served by `GET /runs` / `GET /runs/:id` under exactly this id, and every session-scoped
   * CoreEvent frame on `/ws` carries it as `session` (the `campaignNodeStarted` /
   * `campaignNodeAwaitingHuman` frames additionally spell it as `runId`). Live narration for a
   * campaign card is therefore a pure client-side correlation:
   * `frame.session === campaign.node_run_id[node]` — no extra wire, no per-node fetch
   * (wicked-studio#27).
   */
  node_run_id: Record<string, string>;
  /** node_id -> 0-based attempt counter (a `human_gate_on_failure` Retry bumps it). */
  node_attempt: Record<string, number>;
  /** Persisted amend text of an approved-but-unslotted per-node gate decision (crash-safe). */
  pending_decision_amend: Record<string, string | null>;
  /** `human_gate_on_failure` queue — failed nodes awaiting a Retry/Skip/Abort decision. */
  pending_failure_gates: string[];
  /** Whether a fail-fast (or Abort) tripped — finalization lands on `failed`. */
  fail_fast_tripped: boolean;
  /**
   * Per-node delivery (wicked-studio#27; api-types 0.19.0) — DAEMON-JOINED at DTO assembly on
   * `GET /campaigns` and `GET /campaigns/:id`, never engine-persisted: the exact same
   * `delivery`/`deliverUrl` derivation every run already carries on the runs wire
   * (`AgentSession.delivery`, crew#393/#311), keyed by node_id like {@link Campaign.node_status}.
   * A node appears here once its current-attempt run (`node_run_id[node]`) exists on the store —
   * a still-pending node has no entry. With `node_run_id` + `node_status`, this is everything a
   * "N of M delivered" rollup needs from ONE campaigns fetch — no per-node run fetch, and no
   * dependence on the runs list's archived-run filtering. ABSENT only from a pre-0.19 daemon.
   */
  node_delivery?: Record<string, CampaignNodeDelivery>;
  /**
   * Ad-hoc runs attached to this campaign at launch (`LaunchRunBody.campaignId`;
   * wicked-studio#27, api-types 0.19.0) — DAEMON-JOINED like {@link Campaign.node_delivery},
   * launch order. These are NOT DAG nodes: the campaign's scheduler and lifecycle ignore them;
   * each entry is an independent governed run that an operator filed onto this campaign's
   * surface. Absent from a pre-0.19 daemon; `[]` when none. Narration correlation is the same
   * as for nodes: each `runId` is the engine session id on `/ws` frames (`frame.session`).
   */
  attached_runs?: AttachedRunView[];
}

/**
 * One member's delivery snapshot on the campaigns surface (wicked-studio#27; api-types 0.19.0)
 * — the same tri-state + URL contract as `AgentSession.delivery`/`deliverUrl` (crew#393/#311),
 * derived by the same code at DTO assembly. `deliverUrl` present exactly when
 * `delivery === 'delivered'`.
 */
export interface CampaignNodeDelivery {
  delivery: 'delivered' | 'stranded' | 'vacuous' | 'none';
  deliverUrl?: string;
}

/**
 * An ad-hoc run on the campaigns surface (wicked-studio#27; api-types 0.19.0) — a member of
 * `Campaign.attached_runs` or `RunGroup.runs`. `runId` is the engine session id: the run is
 * served in full by `GET /runs/:id`, and live `/ws` CoreEvent frames for it carry it as
 * `session`. `status`/`delivery`/`deliverUrl` are snapshots of the same fields the run wire
 * serves, so a rollup needs no second fetch.
 */
export interface AttachedRunView {
  runId: string;
  status: SessionStatus;
  delivery: 'delivered' | 'stranded' | 'vacuous' | 'none';
  deliverUrl?: string;
}

/**
 * An ad-hoc label group (wicked-studio#27; api-types 0.19.0): the runs launched with the same
 * `LaunchRunBody.groupLabel`, in launch order. NOT an engine campaign — no DAG, no scheduler,
 * no status of its own (derive a rollup from the members); it exists the moment the first run
 * is launched under the label. Served beside the campaigns in `CampaignsListResponse.groups`.
 */
export interface RunGroup {
  label: string;
  runs: AttachedRunView[];
}

/**
 * `GET /campaigns` 200 body (api-types 0.19.0 — `groups` is ADDITIVE: a pre-0.19 daemon sends
 * only `campaigns`). One fetch answers the whole grouping surface: engine campaigns (each
 * carrying its own per-node rollup fields) plus the ad-hoc label groups.
 */
export interface CampaignsListResponse {
  campaigns: Campaign[];
  groups: RunGroup[];
}

/**
 * One scenario of `POST /campaigns` — the daemon maps each onto a {@link CampaignNode}.
 *
 * Exactly one of `tool` / `agent` per scenario:
 *  - `tool` (deterministic): the daemon composes a single-phase Tool-executor workflow running
 *    `cmd` verbatim (no council, no LLM). Every argv token must be a single line of ≤ 1022
 *    bytes — pass the scenario/spec as a FILE PATH argument, never inline its body. A body
 *    smuggled into the argv is rejected with a 400 naming the offending token.
 *  - `agent` (exploratory/authoring): a governed agent run over `problem` — same byte
 *    discipline, because the problem text reaches PTY workers as prompt material.
 */
export interface CampaignScenario {
  /** Node id, unique within the campaign (letters/digits/dots/hyphens/underscores; no `:`). */
  id: string;
  /** Short human label for the scoreboard; defaults to the id. NOT the scenario body. */
  title?: string;
  /** Ids of scenarios that must reach `depsCondition` before this one dispatches. */
  deps?: string[];
  /** Edge condition applied to every dep edge of this scenario (default `on_success`). */
  depsCondition?: CampaignEdgeCondition;
  /** Deterministic execution: argv run by the engine's Tool executor, file paths not bodies. */
  tool?: { cmd: string[] };
  /** Governed agent execution: the problem statement (short — reaches workers as a prompt). */
  agent?: { problem: string; workflow?: string };
  /** Registered repo this node runs within (isolated worktree). Omit for a repo-less node. */
  repoRef?: string;
}

/** `POST /campaigns` request body → 201 {@link LaunchCampaignResponse}. */
export interface LaunchCampaignBody {
  /** Campaign id (also the def id). Defaults to a generated `campaign-<uuid>`. */
  id?: string;
  name?: string;
  scenarios: CampaignScenario[];
  /** Failure propagation policy (default `continue_independent`). */
  policy?: CampaignFailurePolicy;
  /** Global concurrency cap, >= 1 (default 2). */
  maxConcurrency?: number;
  /** JSON array of `AgenticCli` seats for agent scenarios; defaults to the daemon roster. */
  clisJson?: string;
  /**
   * The multiscope wire (api-types 0.15.0), shared with `POST /testing/recon`: scope the launch
   * to a PROJECT — crew resolves the project's `crew.repo` members server-side. Unknown project
   * ⇒ 404; a project with zero repo members (and no `repoRefs` to fall back on) ⇒ 400 naming
   * the fix. Combined with `repoRefs` ⇒ the union. Because one campaign node runs against ONE
   * repo, every scenario that does not pin its own `repoRef` is FANNED — one node per resolved
   * repo, same campaign — and the 201 body carries the fanned nodes' run ids (`runIds`).
   * Omit both fields ⇒ the launch behaves exactly as before (backward compatible).
   */
  projectId?: string;
  /**
   * The multiscope wire (api-types 0.15.0): explicit codebase attachments — registered repo
   * refs (ids; a unique repo NAME also resolves), deduped, min 1 when present. A ref that does
   * not resolve fails the WHOLE launch with a 400 naming it — never a silently narrowed scope.
   */
  repoRefs?: string[];
}

/**
 * `POST /campaigns` 201 body. `runIds` is ADDITIVE (api-types 0.15.0): present exactly when
 * the launch used the multiscope fields (`projectId`/`repoRefs`), carrying the attempt-0 run
 * ids (`{campaign}:{node}:a0`) of the launch's nodes — repo-major over the fanned scenarios
 * (repos in resolved input order), then the scenarios that pinned their own `repoRef`.
 * Consumers treat `runIds.length >= 1` as the source of truth for what launched; a legacy
 * body keeps the legacy `{ campaignId }` answer.
 */
export interface LaunchCampaignResponse {
  campaignId: string;
  runIds?: string[];
}

/**
 * The 11 campaign frames of the `/ws` stream (wicked-core `event_to_json`, camelCase tags), as a
 * discriminated union for consumers that narrow on `type` — the TH-14 scoreboard renders node
 * status from exactly these. They also flow through the permissive {@link CoreEvent}; the daemon
 * relay is allowlist-free, so every frame below reaches `/ws` clients byte-for-byte.
 */
export type CampaignEvent =
  | { type: 'campaignLaunched'; campaign: string }
  | { type: 'campaignNodeReady'; campaign: string; node: string }
  | { type: 'campaignNodeStarted'; campaign: string; node: string; runId: string }
  | { type: 'campaignNodeAwaitingHuman'; campaign: string; node: string; runId: string; prompt: string }
  | { type: 'campaignNodeCompleted'; campaign: string; node: string }
  | { type: 'campaignNodeFailed'; campaign: string; node: string }
  | { type: 'campaignNodeBlocked'; campaign: string; node: string }
  | { type: 'campaignPaused'; campaign: string }
  | { type: 'campaignCompleted'; campaign: string }
  | { type: 'campaignFailed'; campaign: string }
  | { type: 'campaignCancelled'; campaign: string };

// ── Diagnostics (api-types 0.16.0) ──────────────────────────────────────────────

/**
 * Component versions of the running deployment (`GET /diagnostics`). The honesty rule of the
 * whole diagnostics surface: a version the daemon cannot determine is `null` — never guessed.
 */
export interface DiagnosticsComponents {
  /** The wicked-crew daemon's own package version (always known). */
  crew: string;
  /** The bundled studio SPA's version, read from the manifest the bundle ships
   *  (`testid-inventory.json` → `studioVersion`); `null` on a headless daemon or a bundle
   *  that predates the manifest. */
  studioBundle: string | null;
  /** The installed `wicked-core-ts` engine binding's version; `null` when unresolvable. */
  coreTs: string | null;
  /** Engine binary versions via `--version`, keyed by binary name (`wicked-core`,
   *  `wicked-estate`) — probed ONLY through paths crew already resolves (`WICKED_CORE_EXE`,
   *  bare PATH name); `null` per binary when unresolved or the probe fails. */
  engineBinaries: Record<string, string | null>;
}

/** Daemon process runtime facts (`GET /diagnostics`). */
export interface DiagnosticsDaemon {
  /** Milliseconds since this daemon process started. */
  uptimeMs: number;
  /** Epoch ms the process started (now − uptime). */
  startedAt: number;
  /** The actually-bound HTTP port (honours --port / CREW_PORT / port 0). */
  port: number;
}

/** One store file (or dir, sized as a content total) under the daemon's state home. Paths and
 *  sizes only — file contents never ride this wire. */
export interface DiagnosticsStoreFile {
  /** Filename relative to the state home (`core.db`, `core.db-wal`, `core.db.events`, …). */
  name: string;
  /** Absolute path. */
  path: string;
  /** File size, or the total of a directory's contents (the events dir). */
  bytes: number;
}

/** One captured error-level line from the daemon's own log ring (`GET /diagnostics`). */
export interface DiagnosticsRecentError {
  /** Epoch ms the line was logged. */
  ts: number;
  /** Which record produced it (`daemon` = the in-process pino error ring). */
  source: string;
  /** The logged message, length-bounded. */
  line: string;
}

/**
 * Per-CLI ACP health, folded from the durable run event logs
 * (`<state-home>/core.db.events/*.ndjson`, `acpSessionStarted` / `acpFallback` frames).
 * A CLI that never appears in the logs has no key — absence spells "no ACP traffic recorded",
 * and zero counts are never invented for it.
 */
export interface AcpCliDiagnostics {
  /** Count of `acpSessionStarted` events for this cliKey. */
  sessionsStarted: number;
  /** Count of `acpFallback` events (ACP unavailable/failed; run continued single-shot). */
  fallbacks: number;
  /** Fallback counts by `fallbackKind` (`session_died`, `auth_required`, `binary_unavailable`, …). */
  fallbackKinds: Record<string, number>;
  /** Epoch ms of the newest `acpSessionStarted`, or `null` when none recorded. */
  lastStartedTs: number | null;
  /** Epoch ms of the newest `acpFallback`, or `null` when none recorded. */
  lastFallbackTs: number | null;
}

/** The ACP fold of `GET /diagnostics` — keyed by `cliKey` (`claude`, `pi`, `codex`, …). */
export interface AcpDiagnostics {
  byCli: Record<string, AcpCliDiagnostics>;
}

/**
 * `GET /diagnostics` (api-types 0.16.0) — the daemon's read-only self-knowledge surface:
 * what is deployed, what it stores, what has gone wrong recently, and whether ACP is really
 * working across the CLIs. Every field is derived from records the daemon already owns;
 * anything it cannot answer is `null` / empty, never fabricated.
 */
export interface DiagnosticsResponse {
  components: DiagnosticsComponents;
  daemon: DiagnosticsDaemon;
  /** `core.db` + sidecars + the events dir (as a total), sorted by name. */
  stores: DiagnosticsStoreFile[];
  /** Bounded tail of the daemon's own error-level log lines, newest first. */
  recentErrors: DiagnosticsRecentError[];
  acp: AcpDiagnostics;
  /** The skills seam's last outcome (api-types 0.28.0) — see `DiagnosticsSkills`. */
  skills: DiagnosticsSkills;
}

/** The skills seam's state as `GET /diagnostics` reports it (skills keystone, api-types 0.28.0). */
export type DiagnosticsSkillsState = 'published' | 'fallback' | 'blocked' | 'config-error' | 'disabled';

/** One finding the skills degradation ladder produced (design v3 §3). */
export interface DiagnosticsSkillsFinding {
  /** `skills.fallback` = no wicked-garden installed (engine input left unset / restored to the boot
   *  value — the engine resolves the live cache itself); `skills.blocked` = the first publish is
   *  blocked (engine input points at a non-existent refusal path — launches fail loudly until the
   *  catalog is fixed); `skills.config` = the configured root is corrupt/unusable (same refusal;
   *  `error`), or — as a `warning` on the `published` state — the root lies OUTSIDE the daemon
   *  state home, so core's fence cross-check (`WICKED_CREW_STATE_HOME`) refuses every launch;
   *  `skills.source` (`warning`, api-types 0.29.0, design v3.6) = the CURRENT baseline was seeded
   *  from the installer-managed copy (`SkillSourceKind` `installer-copy`) — the daemon works, but
   *  that copy receives no marketplace updates until the plugin is registered with Claude Code; it
   *  persists (alongside the ladder's own finding, if any) until a refresh from the marketplace
   *  cache re-records the baseline's provenance (byte-identical or not); `skills.manifest`
   *  (`error`, api-types 0.29.0) = `manifest.json` could not be read when diagnostics were taken
   *  (corrupt, unreadable, or the root no longer the one the store bound) — reported as
   *  `config-error` with the cause instead of the stale boot outcome; the exported engine input is
   *  unchanged until the daemon restarts. */
  kind: 'skills.fallback' | 'skills.blocked' | 'skills.config' | 'skills.source' | 'skills.manifest';
  severity: 'warning' | 'error';
  message: string;
}

/**
 * `GET /diagnostics` → `skills`: whether the engine is being handed a verified snapshot, and if not,
 * why — the one read-only answer to "why do launches refuse the skills snapshot". `disabled` is a
 * daemon booted without the seam (the manifest collector, some tests).
 */
export interface DiagnosticsSkills {
  state: DiagnosticsSkillsState;
  /** The resolved skills root on the daemon host; `null` when `disabled`. */
  root: string | null;
  /** The VERIFIED published snapshot (`current` realpath-contained, `snapshot.json` + content hash
   *  checked), or `null`. `path` is the absolute REAL path of `snapshots/<gen>`. */
  current: { gen: number; path: string } | null;
  /** What `WICKED_SKILLS_SNAPSHOT` — the engine's ONE skills input (v3.1 §2, v3.4 §2;
   *  `WICKED_SKILLS_CURRENT` is never set, `WICKED_CREW_STATE_HOME` is not exported) — is exported as
   *  right now: the real snapshot path, a `<root>/refused/…` refusal path, `""` when the process
   *  booted with an explicitly EMPTY value (preserved — a configuration error core refuses, state
   *  `config-error`; design v3.5 §4), or `null` = unset. */
  engineInput: string | null;
  /** DIAGNOSTICS-ONLY: the canonical realpath of the daemon state home, reported for humans. It is
   *  NOT an engine input — `WICKED_CREW_STATE_HOME` is retired (v3.4 §2): core reads only
   *  `WICKED_SKILLS_SNAPSHOT` and derives the state home from its `<state home>/skills/snapshots/<gen>`
   *  layout. `null` only when `disabled`. */
  stateHome: string | null;
  findings: DiagnosticsSkillsFinding[];
}

// ── Memory proposal queue (DES-MEM-FACETED-001 §5.0, api-types 0.21.0) ─────────

/**
 * A proposal's lifecycle state. A proposal is INERT while `pending` (never recalled/applied);
 * `approve` promotes its payload to the active store and marks it `approved`, `reject` marks it
 * `rejected`.
 */
export type ProposalState = 'pending' | 'approved' | 'rejected';

/**
 * One entry in the estate proposal queue — a type-generic, inert write agents submit and operators
 * decide (estate #162). The shape is the estate MCP `proposal.list` wire form verbatim.
 */
export interface Proposal {
  /** Stable proposal-node id. */
  id: string;
  /** `"memory"` | `"policy:<steering_type>"` | future — the router key `approve` promotes by. */
  kind_type: string;
  /** The proposed content (a memory body, a policy rule, …). Opaque here; narrowed by `kind_type`. */
  payload: unknown;
  /** Agent-declared orthogonal facets (axis → value). */
  facets: Record<string, string>;
  /** Run/unit/agent attribution — AUTHORITY-STAMPED by the estate MCP from its launch env, never
   *  taken from the submitter. Empty when the server had no `WICKED_RUN_*` env. */
  provenance: Record<string, string>;
  state: ProposalState;
  /** Unix seconds. */
  created_at: number;
}

/** `GET /proposals` query filters — both optional; omitting a filter lists across that dimension. */
export interface ListProposalsQuery {
  kind_type?: string;
  state?: ProposalState;
}

/** `GET /proposals` → 200. */
export interface ListProposalsResponse {
  proposals: Proposal[];
}

/**
 * The result of landing an approved POLICY proposal as a steering rule (DES-MEM-FACETED-001 §5.2).
 * estate performs no rules-write for a policy proposal (the AW-11 invariant) — it hands the payload
 * to crew, the one governed rules-write path, which shapes a `ConformanceRule` and upserts it. Like
 * the steering-author landing (crew#388) the estate decision (approve) stands regardless, so a
 * landing that could not complete reports `outcome:"failed"` with a loud, operator-readable `error`
 * (recoverable by hand via `POST /governance/rules`) rather than turning the approve into a 500.
 */
export interface PolicyLandingResult {
  /** `landed` = the steering rule is in the store; `failed` = the proposal is approved but no rule
   *  was written — `error` says why. */
  outcome: 'landed' | 'failed';
  /** The upserted rule's id (deterministic `proposal:<proposalId>`, idempotent on replay). Present on `landed`. */
  ruleId?: string;
  /** The steering type derived from the proposal's `kind_type` (`policy:<type>`). Present on `landed`. */
  steering_type?: SteeringType;
  /** Present iff `outcome:"failed"` — the loud reason the rule did not land. */
  error?: string;
}

/**
 * `POST /proposals/:id/approve` → 200. A MEMORY proposal is `promoted` (its payload is now an
 * active memory, `active_id`) and is complete. A POLICY proposal is `handed_off` — its `payload`
 * (`{ rule, severity }`) is still returned verbatim, and `landing` now reports the steering rule
 * crew created from it (`landing.outcome:"landed"` with the `ruleId`), or the loud reason it could
 * not (`landing.outcome:"failed"`). `landing` is absent only from responses served by a daemon
 * predating the policy→steering landing (forward-additive, DES-MEM-FACETED-001 §5.2).
 */
export type ApproveProposalResponse =
  | { outcome: 'promoted'; active_id: string }
  | { outcome: 'handed_off'; payload: unknown; landing?: PolicyLandingResult };

/** `POST /proposals/:id/reject` → 200. */
export interface RejectProposalResponse {
  ok: true;
}

// ── Memory management (governed-knowledge surface, DES-MEM-FACETED-001, api-types 0.22.0) ──────
//
// The studio's surface for managing the memories that ALREADY exist in the operator store — the
// counterpart to the proposal queue (which decides learnings not yet stored). Backed by the estate
// MCP memory tools (memory.recall / memory.coverage / memory.erase) exposed over crew's /api/v1.
// The granularity is estate's, surfaced honestly: browse is query-based (no "list all"), and
// retire is SUBTREE-scoped (no per-id delete).

/**
 * One memory as browsed from the store (`GET /memory`, from estate `memory.recall`).
 *
 * estate `memory.recall` is query-based and token-budgeted — there is NO "list all" — and returns
 * `{ memory_id, scope, content, tier, score }` per item. It does NOT surface per-item `facets`, so
 * `facets` is presently always `{}` (kept in the shape for forward-compatibility and to mirror
 * `Proposal.facets`); `score` is the recall relevance score, absent when estate omits it.
 */
export interface MemoryItem {
  /** Stable memory-node id (estate `memory_id`). */
  id: string;
  /** The memory body. */
  content: string;
  /** Tier: `working` | `episodic` | `semantic` | `procedural` | `archival`. */
  tier: string;
  /** The memory's own hierarchical scope path (slash-separated `kind:id` segments; `""` = root). */
  scope: string;
  /** Orthogonal facets (axis → value) the memory is tagged with. Populated by estate `memory.list`
   *  (the management browse) — this is what powers the surface's facet filter. `{}` for an
   *  unfaceted memory (and for a `memory.recall`-sourced item, which carries no facets). */
  facets: Record<string, string>;
  /** Relevance score — only present on a `memory.recall` item; `memory.list` (the browse) is not
   *  relevance-ranked, so it is absent there. */
  score?: number;
  /**
   * Unix-SECONDS timestamp of when this memory FIRST entered the store — the "added" time the
   * governance surface sorts + date-filters on (api-types 0.23.0). Populated from estate
   * `memory.list`, which returns `created_at` per item; ABSENT — never fabricated — on a memory
   * whose creation time the store did not report (and on a `memory.recall`-sourced item, which
   * carries none). Additive: absence is the one spelling of "unknown", so a `since`/`until` filter
   * cannot assert an undated memory in range.
   */
  created_at?: number;
}

/**
 * `GET /memory` query filters. All optional. The browse itself lists the COMPLETE in-scope set via
 * estate `memory.list`; `query`, `facets`, and `limit` are applied server-side as post-filters over
 * that set (they are NOT a relevance query). `scope_prefix` is the only estate-side argument — a
 * subtree filter where `""`/omitted matches EVERY memory (the same predicate as retire). `query` is
 * a case-insensitive CONTENT substring match. `facets` is a JSON-encoded object of axis→value
 * strings; an item is kept only if it carries every pair. `limit` caps the returned ROW count.
 */
export interface ListMemoriesQuery {
  /** Case-insensitive content substring filter over the complete set. */
  query?: string;
  scope_prefix?: string;
  /** JSON-encoded `Record<string, string>` (axis→value); a malformed value is a 400. */
  facets?: string;
  /** Positive integer; caps the returned row count. */
  limit?: string;
  /**
   * Inclusive LOWER date bound (api-types 0.23.0): keep only memories with `created_at >= since`.
   * Unix SECONDS, a non-negative integer (a present-but-non-integer value is a 400). Applied
   * server-side over the loaded set, alongside `query`/`facets`. A memory with NO `created_at`
   * is EXCLUDED whenever `since` (or `until`) is set — an unknown creation time is not asserted
   * in range. Omitted ⇒ no lower bound.
   */
  since?: string;
  /**
   * Inclusive UPPER date bound (api-types 0.23.0): keep only memories with `created_at <= until`.
   * Same units/validation/undated-exclusion as {@link ListMemoriesQuery.since}. Omitted ⇒ no
   * upper bound.
   */
  until?: string;
}

/** `GET /memory` → 200. */
export interface ListMemoriesResponse {
  memories: MemoryItem[];
}

/** `GET /memory/coverage` query — an optional subtree filter (`""`/omitted = global totals). */
export interface MemoryCoverageQuery {
  scope_prefix?: string;
}

/**
 * `GET /memory/coverage` → 200 (estate `memory.coverage`). Memory-node counts, optionally scoped to
 * a subtree: `total`, plus per-tier and per-kind breakdowns.
 */
export interface MemoryCoverageResponse {
  total: number;
  by_tier: Record<string, number>;
  by_kind: Record<string, number>;
}

/**
 * `POST /memory/retire` body. Retire is SUBTREE-scoped, never per-id: estate `memory.erase`
 * hard-deletes EVERY memory whose scope equals or descends from `scope_prefix`. `scope_prefix` is
 * required and must be non-empty (estate refuses a total wipe) — the surface must show the operator
 * the whole subtree it will remove, not a single row.
 */
export interface RetireMemoryBody {
  scope_prefix: string;
}

/** `POST /memory/retire` → 200. The number of memories the subtree wipe deleted. */
export interface RetireMemoryResponse {
  erased: number;
}
