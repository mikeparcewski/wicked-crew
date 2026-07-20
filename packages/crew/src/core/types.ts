/**
 * Boundary types for the wicked-core-ts JSON surface.
 *
 * core-ts returns every complex result as a JSON string, which the adapter
 * `JSON.parse`s. These interfaces mirror the serde representation of
 * wicked-core's domain types (wicked-core/src/domain.rs, repo.rs, scope.rs) so
 * the daemon never falls back to `any` at the core boundary. They are permissive
 * about forward-additive fields — a newer core that adds fields still parses.
 *
 * ONLY `core/adapter.ts` imports from the native addon itself; the rest of the
 * daemon speaks these daemon-owned shapes, which is what quarantines the
 * FINALIZING core-ts `subscribe` seam to a single file (DES-STUDIO-001 §5.2).
 */

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
  | { method: 'council'; winner: string; agreement_pct: number; returned: number; dissent: number }
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
}

/** A run plus its ordered units — the read a UI builds its project list from (`SessionView`). */
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
}

/** The run id of the onboarding run started when a repo was registered. */
export interface RepoOnboardRef {
  repoId: string;
  runId: string;
}

/** The daemon's launch-run input (mapped by the adapter onto the addon's `LaunchOptions`). */
export interface LaunchRunInput {
  /** Free-text problem, decomposed into ordered work units. */
  problem: string;
  /** Stable run id. */
  sessionId: string;
  /** JSON array of `AgenticCli` seats — the council roster. */
  clisJson: string;
  /** `shared` (default) | `isolated`. */
  entityMode?: string;
  /** Human-confirm gate policy: `none` (default) | `all` | `before:<ord>`. */
  humanConfirm?: string;
  /** Id of a registered repo to run within. Omit for a repo-less run. */
  repoRef?: string;
  /** Workflow def id to drive (e.g. `domain-extraction`). Omit ⇒ free-text planning. */
  workflow?: string;
}

/**
 * A CoreEvent frame as delivered by the live stream — a tagged-JSON object
 * discriminated on `type` (wicked-core-ts `event_to_json`). Known optional
 * fields are declared for the frames the daemon inspects; the index signature
 * keeps the shape additive-safe so new variants pass through untouched.
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
  /** PTY terminal frames (`terminalOpened`/`terminalOutput`/`terminalExited`): the terminal id. */
  id?: string;
  /** `terminalOutput`: monotonic per-terminal sequence number. */
  seq?: number;
  /** `terminalOutput`: raw PTY bytes, base64-encoded (decode → send to the owning socket). */
  bytesB64?: string;
  /** `terminalOpened`: the working directory the PTY was opened in. */
  cwd?: string;
  // ── DES-STUDIO-COCKPIT-001 §3 B-events (Phase B insight wires; fanned out verbatim) ──
  /** `unitDispatched`/`cliUsage`: 0-based dispatch attempt (`>0` = a re-dispatch / rework). */
  attempt?: number;
  /** `cliUsage`: prompt/input tokens for the unit run. */
  inputTokens?: number;
  /** `cliUsage`: completion/output tokens for the unit run. */
  outputTokens?: number;
  /** `cliUsage`: dollar cost when the CLI reports it (claude) or a price table resolves it; else `null`. */
  costUsd?: number | null;
  /** `dataUsed`: the data files the unit's CLI touched. */
  files?: string[];
  /** `gateEvaluated`: the gated criterion — `null` when the phase was UNGATED. */
  criterion?: string | null;
  /** `gateEvaluated`: `true` iff a pinned validator gated this unit. */
  hasDeterministicFloor?: boolean;
  /** `gateEvaluated`: whether the deterministic (layer-1) floor passed. */
  deterministicPass?: boolean;
  /** `gateEvaluated`: the agent (layer-2) judge's verdict when one ran, else `null`. */
  agentVerdict?: string | null;
  /** `gateEvaluated`: the agent judge's reasoning when one ran, else `null`. */
  agentReasoning?: string | null;
  /** `gateEvaluated`: the evaluator≠creator second-pass result — `null` when it did not run. */
  evaluatorPass?: boolean | null;
  /** `gateEvaluated`: the WINNING denial's reason when `combined === false`, else `null`. */
  denialReason?: string | null;
  /** `gateEvaluated`: the final deny-dominant decision over all layers. */
  combined?: boolean;
  [k: string]: unknown;
}

// ── Governance types (crew#40) ──────────────────────────────────────────────

/**
 * A registered governance policy (`wicked-governance::Policy`).
 * Serialized via serde snake_case — `effect` values are `deny` | `allow_with_conditions` | `allow`;
 * `severity` values are `high` | `medium` | `low`.
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
}

/**
 * A prescriptive conformance rule (`wicked-governance::ConformanceRule`).
 * `rule_type` is `pattern` | `policy`; `severity` is `info` | `warn` | `error` | `critical`.
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
}

/**
 * A recorded conformance claim / evaluation result (`wicked-apps-core::ConformanceClaim`).
 * `decision` values are `allow` | `deny` | `allow_with_conditions` (serde snake_case).
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

/** Per-app breakdown within a `CoverageReport`. */
export interface CoveragePerApp {
  app: string;
  behavior_bearing: number;
  resolved: number;
  risk_flagged: number;
  unaccounted: number;
  coverage: number;
}

/** A behavior-bearing graph node without a coverage annotation (a coverage hole). */
export interface UnaccountedNode {
  symbol_id: string;
  name?: string;
  kind?: string;
  file?: string;
  app?: string;
}

/** Front-half coverage gate report (`wicked-governance::CoverageReport`). Null on empty store. */
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

// ── Workflow viewer types (crew#44) ────────────────────────────────────────────

/** Gate position in the value→strategy→execution ladder. */
export type GateType = 'value' | 'strategy' | 'execution';

/** Human-confirm spec for a phase gate. */
export type GateSpec =
  | 'auto'
  | { human_confirm: { unconditional: boolean } }
  | { human_confirm_if: 'verdict_not_pass' };

/** Evaluator≠creator role. */
export type PhaseRole = 'neutral' | 'creator' | 'evaluator';

/** Methodology stage for a phase. */
export type StageKindPhase = 'recon' | 'build' | 'review' | 'test';

/** One ordered phase of a workflow — pure data. */
export interface PhaseDef {
  id: string;
  kind: StageKindPhase;
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
}

// ── System settings ────────────────────────────────────────────────────────────

export interface SystemSettings {
  /** Max nodes returned by wicked-estate graph-view (default 150). */
  graphNodeLimit: number;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  graphNodeLimit: 150,
};
