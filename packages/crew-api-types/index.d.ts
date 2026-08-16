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

/** The daemon's cached open-gate record (`GET /runs/:id/gate`, DES-STUDIO-001 §3.3). */
export interface GateInfo {
  runId: string;
  ord: number;
  prompt: string;
  lifecycle: string;
  receivedAt: string;
}

/** Approve / reject payload for the steering gate (`POST /runs/:id/gate`). */
export interface GateDecision {
  approve: boolean;
  amend?: string;
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
  stepStatus?: 'ok' | 'failed' | 'cancelled';
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
  /** failureTriaged: the triage judge's decision. */
  decision?: string;
  /** failureTriaged: the judge's bounded reasoning. */
  analysis?: string;
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
 *  `outputBytes` is the byte length of the worker's output; `stepStatus` is "ok"/"failed"/"cancelled";
 *  `governed` reflects whether the runner armed input governance for this unit. */
export interface UnitOutputCapturedEvent {
  type: 'unitOutputCaptured';
  session: string;
  ord: number;
  attempt: number;
  /** Byte length of the worker's raw output — distinguishes 0-byte from 8 MB truncated. */
  outputBytes: number;
  stepStatus: 'ok' | 'failed' | 'cancelled';
  governed: boolean;
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
 * A prescriptive conformance rule (`wicked-governance::ConformanceRule`).
 * `rule_type`: `pattern` | `policy`. `severity`: `info` | `warn` | `error` | `critical`.
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
  provenance: { source: string; ref?: string; source_kinds: string[] };
  /** Withdrawn from recall. Same contract as {@link GovernancePolicy.retired}. */
  retired?: boolean;
}

/** Facet query for `GET /governance/rules/preview`. All fields are optional. */
export interface RulePreviewQuery {
  language?: string;
  layer?: string;
  framework?: string;
  severity?: string;
  rule_type?: string;
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
  /** Unresolved call-sites referencing the target — absence of dependents never means "safe". */
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
