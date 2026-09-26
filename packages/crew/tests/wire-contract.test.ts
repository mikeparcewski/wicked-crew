// Drift guard for the published wire contract (task #84).
//
// `wicked-crew-api-types` is the ONE definition of every shape that crosses the daemon's
// HTTP/WS boundary; the studio compiles against it and so must the daemon. This file makes
// that a checked fact rather than a convention: each `respondsWith` / `accepts` call below
// is a COMPILE-TIME assertion, enforced by `tsc --noEmit -p tsconfig.test.json` (part of
// `npm run typecheck`, which CI runs on every PR). If the daemon's produced types stop
// satisfying the contract — or the contract narrows past what the route schemas accept —
// this file stops compiling, and the break is caught where it happened instead of at
// runtime in a browser.
//
// Why assignability and not equality: the daemon is allowed to KNOW MORE than the contract
// (extra fields are forward-additive by design, DES-STUDIO-001 §5.1). What it must never do
// is produce something the contract's consumers cannot read, or reject something the
// contract told them they may send.
//
// The runtime `it` blocks are deliberately thin — vitest (esbuild) does not typecheck, so
// the teeth of this suite are in the typecheck step; the tests exist so the guard is
// visible in the test run and so a human deleting the typecheck wiring still sees this
// file named somewhere.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type * as Wire from 'wicked-crew-api-types';
import type { UnitDistributedEventJson } from 'wicked-core-ts';
import type { ChatSummary, CoreAdapter } from '../src/core/adapter.js';
import type { QeAuthorPlan } from '../src/qe/author-workflow.js';
import type { TestSet } from '../src/qe/test-sets.js';
import type { TestingAuthorSchema } from '../src/api/testing.js';
import { councilOutcomeSuffix } from '../src/interactive/council-outcome.js';
import { NO_ELIGIBLE_SEAT_CODE, noEligibleSeatBody } from '../src/core/engine-roster.js';
import { BUILTIN_WORKFLOWS } from '../src/core/adapter.js';
import type { GateCacheEntry } from '../src/api/gate-cache.js';
import type { ElicitationEntry } from '../src/api/elicitation-cache.js';
import type { RequirementDetail, RequirementsPage } from '../src/api/requirements.js';
import type { ChatOpenSchema, GateSchema, GuidanceSchema, LaunchSchema, OpenPathSchema, OpenTerminalSchema, RepoGraphReply, RetireMemorySchema } from '../src/api/routes.js';
import type { SteeringAuthorSchema, SteeringImportSchema } from '../src/api/governance-steering.js';
import type {
  ImportEvalCorpusSchema,
  RunGovernanceEvalsSchema,
  TestingReconSchema,
} from '../src/api/testing.js';
import type { LaunchCampaignSchema } from '../src/campaigns/routes.js';
import type {
  AddSkillSchema,
  PutSkillFileSchema,
  ReplaceSkillSchema,
  SkillRevisionSchema,
} from '../src/api/skills.js';
import type { SkillsStore, SnapshotManifest } from '../src/skills/store.js';
import type { SkillsHealth, SkillsHealthFindingKind } from '../src/skills/runtime.js';
import type { PluginSource } from '../src/skills/plugin-source.js';
import type { CappedFileRead, WorktreeDiff } from '../src/api/run-files.js';
import type { DeliveryState } from '../src/api/delivery-index.js';
import type { AcpCliFold, RecentError, StoreFileEntry } from '../src/api/diagnostics.js';
import type {
  GovernanceDeadletters,
  GovernanceFindingKind,
  GovernanceHealth,
  GovernanceRecords,
} from '../src/api/governance-health.js';
import type { GovernanceStoreSource } from '../src/core/governance-store.js';
import type { CREATE_UNDETERMINED, DocCreateBody, DocCreateRefusal, PreparedCreate } from '../src/interactive/proxy-routes.js';
import type { SeamStatusPayload } from '../src/interactive/draft-events.js';
import type { LOCAL_ACTOR } from '../src/api/auth.js';
import type { AuditLog } from '../src/api/audit.js';
import type {
  AttachMemberSchema,
  CreateProjectSchema,
  RefreshProjectGraphSchema,
  UpdateProjectSchema,
} from '../src/projects/routes.js';
import type { PutPresetSchema } from '../src/presets/routes.js';
import type { EditPlanSchema, PlanPreviewSchema, joinTeam } from '../src/team/routes.js';
import type { DEFAULT_SETTINGS } from '../src/core/types.js';

/** Compile-time: what the daemon PRODUCES must satisfy what the contract PUBLISHES. */
function respondsWith<Contract, Produced extends Contract>(): Produced | void {
  /* the assertion is the `extends` constraint; nothing to do at runtime */
}

/** Compile-time: every body the contract lets a client SEND must be accepted by the route schema. */
function accepts<SchemaInput, ContractBody extends SchemaInput>(): ContractBody | void {
  /* the assertion is the `extends` constraint; nothing to do at runtime */
}

// ── Gate-evidence frames (wicked-core F-036/F-039; api-types 0.31.0) ─────────────────────────
// The two new variants are `type` aliases so they satisfy CoreEvent's index signature and relay
// through the CoreEvent-typed broadcast seams unchanged (codex on #507) …
respondsWith<Wire.CoreEvent, Wire.EvaluatorMutatedWorktreeEvent>();
respondsWith<Wire.CoreEvent, Wire.RepoChecksEvaluatedEvent>();
respondsWith<Wire.CoreEvent, Wire.GateEvidenceEvent>();
// … and `gateEvaluated.denial` names both new layers alongside the established ones. The literals
// are SHAPED like wicked-core's `denial_json` output (camelCase, every key present, `null` never
// absent); the `reason` wording and `phase` values are illustrative, not core's exact strings.
const WORKTREE_GUARD_DENIAL = {
  source: 'worktree_guard' as const,
  reason: 'evaluator≠creator: phase `verify` declares `executes_code: false` but changed the worktree',
  claimId: null,
  ruleIds: [] as string[],
  deniedTool: null,
  phase: 'unit-4',
};
const REPO_CHECKS_DENIAL = {
  source: 'repo_checks' as const,
  reason: 'repo checks floor failed: cargo-test: exit 101',
  claimId: null,
  ruleIds: [] as string[],
  deniedTool: null,
  phase: null,
};
respondsWith<Wire.UnitDenial, typeof WORKTREE_GUARD_DENIAL>();
respondsWith<Wire.UnitDenial, typeof REPO_CHECKS_DENIAL>();
respondsWith<Wire.UnitDenialSource, 'worktree_guard' | 'repo_checks' | 'pinned_validator'>();
const GATE_DENIED_BY_GUARD = {
  type: 'gateEvaluated' as const,
  session: 'run-1',
  ord: 4,
  criterion: null,
  hasDeterministicFloor: true,
  deterministicPass: true,
  agentVerdict: null,
  agentReasoning: null,
  evaluatorPass: true,
  evaluatorPolicies: [] as string[],
  denialReason: WORKTREE_GUARD_DENIAL.reason,
  denial: WORKTREE_GUARD_DENIAL,
  combined: false,
  // wicked-core#431 (api-types 0.33.0): the judge keys are ALWAYS present — `null` here because no
  // layer-2 judge ran on these denials (`agentVerdict: null`).
  judgeCli: null,
  judgeDistinct: null,
};
const GATE_DENIED_BY_CHECKS = { ...GATE_DENIED_BY_GUARD, denialReason: REPO_CHECKS_DENIAL.reason, denial: REPO_CHECKS_DENIAL };
respondsWith<Wire.GateEvaluatedEvent, typeof GATE_DENIED_BY_GUARD>();
respondsWith<Wire.GateEvaluatedEvent, typeof GATE_DENIED_BY_CHECKS>();

describe('gate-evidence wire shapes (wicked-core F-036/F-039)', () => {
  it('names both new denial layers exactly as the engine spells them', () => {
    // The teeth are the compile-time assertions above; this keeps the literals live and the guard
    // visible in the test run.
    expect(GATE_DENIED_BY_GUARD.denial.source).toBe('worktree_guard');
    expect(GATE_DENIED_BY_CHECKS.denial.source).toBe('repo_checks');
    expect(GATE_DENIED_BY_CHECKS.denialReason).toBe(REPO_CHECKS_DENIAL.reason);
  });
});

// ── wicked-core#431 follow-through (wicked-core#433; api-types 0.33.0) ────────────────────────
// The deliver lift, the creator-tree restore, the named judge and the ACP write refusal, spelled as
// the engine's `event_to_json` emits them (camelCase, every key present, `null` never absent). Each
// new frame is a `type` alias — CoreEvent's index signature, as the F-036/F-039 pair — so it relays
// through the CoreEvent-typed seams unchanged; the literals mirror wicked-core's own `to_json` tests.
respondsWith<Wire.CoreEvent, Wire.WorktreeRestoredEvent>();
respondsWith<Wire.CoreEvent, Wire.DeliverLiftEvaluatedEvent>();
respondsWith<Wire.CoreEvent, Wire.EvaluatorToolCallDeniedEvent>();
respondsWith<Wire.CoreEvent, Wire.RunBaseResolvedEvent>();
respondsWith<Wire.CoreEvent, Wire.GateEvidenceEvent>();
// gateEvaluated names the judge — both keys ALWAYS present, `null` when no judge ran (F-3R2-007).
const GATE_WITH_JUDGE = {
  type: 'gateEvaluated' as const,
  session: 'run-1',
  ord: 4,
  criterion: 'c',
  hasDeterministicFloor: true,
  deterministicPass: true,
  agentVerdict: 'pass',
  agentReasoning: null,
  evaluatorPass: null,
  evaluatorPolicies: [] as string[],
  denialReason: null,
  denial: null,
  combined: true,
  judgeCli: 'codex',
  judgeDistinct: true,
};
const GATE_NO_JUDGE = { ...GATE_WITH_JUDGE, agentVerdict: null, judgeCli: null, judgeDistinct: null };
respondsWith<Wire.GateEvaluatedEvent, typeof GATE_WITH_JUDGE>();
respondsWith<Wire.GateEvaluatedEvent, typeof GATE_NO_JUDGE>();
// The mutation event says whether the creator's tree was put back; worktreeRestored carries what
// was discarded (F-3R2-010).
const MUTATION_RESTORED = {
  type: 'evaluatorMutatedWorktree' as const,
  session: 'run-1',
  ord: 4,
  attempt: 0,
  cli: 'pi',
  phase: 'verify',
  beforeTree: '598bbb99',
  afterTree: '4bffa800',
  headMoved: false,
  changed: [{ status: 'M', path: 'src/App.tsx' }],
  restored: true,
  restoreError: null,
};
respondsWith<Wire.EvaluatorMutatedWorktreeEvent, typeof MUTATION_RESTORED>();
const WORKTREE_RESTORED = {
  type: 'worktreeRestored' as const,
  session: 'run-1',
  ord: 4,
  attempt: 0,
  cli: 'pi',
  phase: 'verify',
  tree: '598bbb99',
  head: null,
  discarded: [{ status: 'M', path: 'src/App.tsx' }],
  suggestionRef: 'refs/wicked/suggestions/run-1/4/0',
};
const WORKTREE_RESTORED_UNPINNED = { ...WORKTREE_RESTORED, suggestionRef: null };
respondsWith<Wire.WorktreeRestoredEvent, typeof WORKTREE_RESTORED>();
respondsWith<Wire.WorktreeRestoredEvent, typeof WORKTREE_RESTORED_UNPINNED>();
// The deliver lift's record (F-3R2-013) — a conflict names its files; every outcome the engine emits
// is admitted, `'failed'` included (the fail-closed apply outcome, wicked-core#433 review F-433-006).
const LIFT_CONFLICT = {
  type: 'deliverLiftEvaluated' as const,
  session: 'run-1',
  ord: 5,
  attempt: 0,
  outcome: 'conflict' as const,
  baseRef: 'origin/main',
  baseBefore: '1432c96',
  baseAfter: 'f57069d',
  treeBefore: '598bbb99',
  treeAfter: null,
  conflicts: ['testid-inventory.json'],
  note: null,
};
respondsWith<Wire.DeliverLiftEvaluatedEvent, typeof LIFT_CONFLICT>();
respondsWith<Wire.DeliverLiftOutcome, 'unchanged' | 'lifted' | 'conflict' | 'skipped' | 'failed'>();
// A write-class ACP tool call refused at the permission boundary (F-3R2-009); `kind`/`path` nullable.
const TOOL_DENIED = {
  type: 'evaluatorToolCallDenied' as const,
  session: 'run-1',
  ord: 4,
  attempt: 0,
  cli: 'pi',
  carrier: 'acp' as const,
  tool: 'edit',
  kind: 'edit',
  path: 'src/App.tsx',
  reason: 'write-class tool call from an executes_code:false phase',
};
const TOOL_DENIED_KINDLESS = { ...TOOL_DENIED, kind: null, path: null };
respondsWith<Wire.EvaluatorToolCallDeniedEvent, typeof TOOL_DENIED>();
respondsWith<Wire.EvaluatorToolCallDeniedEvent, typeof TOOL_DENIED_KINDLESS>();
// How the run's base was chosen at worktree mint (F-3R2-013) — session-level, before worktreeReady.
const BASE_RESOLVED = {
  type: 'runBaseResolved' as const,
  session: 'run-1',
  baseRef: 'origin/main',
  baseCommit: 'f57069d',
  localHead: '1432c96',
  behind: 5,
  fetched: true,
  lifted: true,
  note: null,
};
respondsWith<Wire.RunBaseResolvedEvent, typeof BASE_RESOLVED>();
// acpFallback.fallbackKind: every kind the engine emits — the two deliberate reroutes included —
// and open-ended for a newer engine.
respondsWith<
  Wire.AcpFallbackKind,
  'binary_unavailable' | 'session_died' | 'auth_required' | 'governance_requires_wrapped' | 'read_only_requires_wrapped'
>();
const READ_ONLY_REROUTE = {
  type: 'acpFallback' as const,
  session: 'run-1',
  cliKey: 'pi',
  reason: 'executes_code:false unit on an ACP seat not admitted to input governance',
  fallbackKind: 'read_only_requires_wrapped' as const,
};
respondsWith<Wire.AcpFallbackEvent, typeof READ_ONLY_REROUTE>();

// ── Wave 6 wire shapes (api-types 0.36.0) ────────────────────────────────────────────────────────
// `UnitDistributedEvent` is pinned against the ENGINE's own napi declaration of the frame
// (`wicked-core-ts` `UnitDistributedEventJson`, itself pinned against `event_to_json` by the binding's
// cargo tests): the contract must accept exactly what the engine emits — camelCase. Pre-0.36 the
// contract declared snake_case names the engine never sent, so a consumer reading `degraded_reason`
// got `undefined` (crew#533 follow-through).
respondsWith<Wire.UnitDistributedEvent, UnitDistributedEventJson>();
// (`UnitDistributedEvent` is an interface — no implicit index signature — so its CoreEvent relay is
// asserted through the napi type, which `extends CoreEventJson`: the frame the daemon relays IS the
// engine's, and the contract accepts it.)
respondsWith<Wire.CoreEvent, UnitDistributedEventJson>();
// A RECORDED frame (run b86c14c1's shape, wave-6 fields filled): every Option is `null`, never absent.
const RECORDED_UNIT_DISTRIBUTED = {
  type: 'unitDistributed' as const,
  session: 'b86c14c1-e295-4659-8a30-51b4ec1ac589',
  ord: 2,
  cli: 'claude',
  routingMethod: 'council' as const,
  agreementPct: 100,
  returned: 1,
  seated: 1,
  dissent: 0,
  degradedReason: '4 of 5 seats benched: codex (signed out — launcher), pi (unauthenticated — ballot), copilot (signed out — launcher), opencode (dispatch budget — ballot)',
  seatConstraint: null,
  distinctnessFallback: null,
};
respondsWith<Wire.UnitDistributedEvent, typeof RECORDED_UNIT_DISTRIBUTED>();
respondsWith<UnitDistributedEventJson, typeof RECORDED_UNIT_DISTRIBUTED>();

// ── Hardening S5 (wicked-core#461 / crew#556): `unitDistributed.distinctnessFallback` ──────────────
// The engine adds the evaluator ≠ creator fallback as a REQUIRED key of `UnitDistributedEventJson`
// (`'creator_seat' | 'same_cli_instance' | null` since core#595, emitted unconditionally). Crew CI builds `wicked-core-ts` from core MAIN
// while the npm pin lags, so the contract must hold against BOTH shapes at once — which is why the
// contract declares the field OPTIONAL (`?: 'creator_seat' | 'same_cli_instance' | null`): an engine frame WITH the key
// (core main) and one WITHOUT it (the current pin) both satisfy it. `UnitDistributedEventJsonWithFallback`
// is the post-#461 napi shape spelled out here, so this file proves the core-main direction on the
// pinned addon too (and keeps proving it once the pin catches up, when the two types coincide).
// wicked-core#591/#595 widened the engine's union with `'same_cli_instance'` (two seat instances of
// one cli); the contract carries the same closed set.
type UnitDistributedEventJsonWithFallback = UnitDistributedEventJson & {
  distinctnessFallback: 'creator_seat' | 'same_cli_instance' | null;
};
// The engine's post-#461 frame satisfies the contract (the field REQUIRED there, optional here) …
respondsWith<Wire.UnitDistributedEvent, UnitDistributedEventJsonWithFallback>();
respondsWith<Wire.CoreEvent, UnitDistributedEventJsonWithFallback>();
// … the recorded null-spelled frame satisfies the post-#461 napi shape (the CI-on-core-main case) …
respondsWith<UnitDistributedEventJsonWithFallback, typeof RECORDED_UNIT_DISTRIBUTED>();
// … and a frame with the fallback POPULATED (a review unit kept on the single eligible seat — the
// bench-free single-seat roster, where `degradedReason` stays null and this key is the only
// disclosure) satisfies both the contract and the napi shape, with the closed token set.
const RECORDED_UNIT_DISTRIBUTED_FALLBACK = {
  type: 'unitDistributed' as const,
  session: 'b86c14c1-e295-4659-8a30-51b4ec1ac589',
  ord: 3,
  cli: 'claude',
  routingMethod: 'evaluator_distinct' as const,
  agreementPct: null,
  returned: null,
  seated: null,
  dissent: null,
  degradedReason: null,
  seatConstraint: null,
  distinctnessFallback: 'creator_seat' as const,
};
respondsWith<Wire.UnitDistributedEvent, typeof RECORDED_UNIT_DISTRIBUTED_FALLBACK>();
respondsWith<UnitDistributedEventJsonWithFallback, typeof RECORDED_UNIT_DISTRIBUTED_FALLBACK>();
// wicked-core#591/#595: a review unit on a DISTINCT seat instance of the builder's own cli.
type RecordedUnitDistributedSameCli = Omit<typeof RECORDED_UNIT_DISTRIBUTED_FALLBACK, 'distinctnessFallback'> & {
  distinctnessFallback: 'same_cli_instance';
};
respondsWith<Wire.UnitDistributedEvent, RecordedUnitDistributedSameCli>();
// (Not pinned against `UnitDistributedEventJsonWithFallback`: on the npm-pinned addon that type
// intersects to `'creator_seat' | null`. The core-main direction is proven above, where
// `UnitDistributedEventJson` itself carries `'same_cli_instance'` and must satisfy the contract.)
respondsWith<Wire.UnitDistributedEvent['distinctnessFallback'], 'creator_seat' | 'same_cli_instance' | null | undefined>();
// … and the contract's set is no WIDER than the engine's (the pin is two-way).
respondsWith<'creator_seat' | 'same_cli_instance' | null | undefined, Wire.UnitDistributedEvent['distinctnessFallback']>();
// ── wicked-core#590 S5: `routingMethod: 'teamed'` / `RoutingInfo { method: 'teamed' }` ──────────────
// The engine stopped convening a council to route units: every seated unit is routed `teamed` (the
// first eligible seat), and the council-only fields are `null`. Crew CI builds `wicked-core-ts` from
// core MAIN while the npm pin lags, so the contract must hold against BOTH addon shapes: the engine's
// set is a SUBSET of the contract's on each (4 members on the pin, 5 once core carries S5), which is
// what `respondsWith<Wire.UnitDistributedEvent, UnitDistributedEventJson>()` above already proves in
// the engine→contract direction. The contract-side set is pinned two-way against the literal below,
// never against the engine's (a two-way pin against the addon would break on whichever shape lags).
const RECORDED_UNIT_DISTRIBUTED_TEAMED = {
  ...RECORDED_UNIT_DISTRIBUTED,
  routingMethod: 'teamed' as const,
  agreementPct: null,
  returned: null,
  seated: null,
  dissent: null,
  degradedReason: null,
};
respondsWith<Wire.UnitDistributedEvent, typeof RECORDED_UNIT_DISTRIBUTED_TEAMED>();
type RoutingMethods = 'council' | 'degraded' | 'evaluator_distinct' | 'tool' | 'teamed';
respondsWith<RoutingMethods, Wire.UnitDistributedEvent['routingMethod']>();
respondsWith<Wire.UnitDistributedEvent['routingMethod'], RoutingMethods>();
// The engine's own set — whichever addon shape this build links — fits the contract's.
respondsWith<RoutingMethods, UnitDistributedEventJson['routingMethod']>();
// The routing ARTIFACT on a unit (`WorkUnit.routing`, serde `{"method":"teamed","winner":…}`).
const TEAMED_ROUTING = { method: 'teamed' as const, winner: 'codex' };
respondsWith<Wire.RoutingInfo, typeof TEAMED_ROUTING>();
// A recorded run's council routing still reads (the variant is kept for history).
const RECORDED_COUNCIL_ROUTING = {
  method: 'council' as const,
  winner: 'claude',
  agreement_pct: 100,
  returned: 1,
  seated: null,
  dissent: 0,
};
respondsWith<Wire.RoutingInfo, typeof RECORDED_COUNCIL_ROUTING>();
// The typed `POST /runs` 409 for the engine's `NoEligibleSeat` intake refusal (same PR).
respondsWith<Wire.NoEligibleSeatBody, ReturnType<typeof noEligibleSeatBody>>();
respondsWith<Wire.NoEligibleSeatBody['code'], typeof NO_ELIGIBLE_SEAT_CODE>();
// The new frames relay through the CoreEvent-typed seams and narrow on `type`.
respondsWith<Wire.CoreEvent, Wire.WorkerToolCallDeniedEvent>();
respondsWith<Wire.GateEvidenceEvent, Wire.WorkerToolCallDeniedEvent>();
const WORKER_DENIED = {
  type: 'workerToolCallDenied' as const,
  session: 'run-1',
  ord: 7,
  attempt: 0,
  cli: 'claude',
  carrier: 'acp' as const,
  role: 'creator' as const,
  tool: 'Bash',
  command: 'gh pr create --title x --body-file b',
  reason: 'remote-write fence: gh pr create',
  remedy: "delivery is performed by the run's deliver phase",
};
respondsWith<Wire.WorkerToolCallDeniedEvent, typeof WORKER_DENIED>();
// wicked-core#602 (DES-TEAMING-001 S3, api-types 0.40.0): the team-advice frames, recorded byte for
// byte from wicked-core's `CoreEvent::to_json` (`event::tests::advice_events_wire_shape_is_exact`).
const RECORDED_ADVICE_DELIVERED = {
  type: 'adviceDelivered' as const,
  session: 'run-1',
  ord: 3,
  attempt: 1,
  findingIds: ['f-3fa9c2e1d0b4a7e6'],
  carrier: 'acp_steering' as const,
  outcome: 'injected' as const,
  detail: null,
};
const RECORDED_ADVICE_NOT_DELIVERED = {
  ...RECORDED_ADVICE_DELIVERED,
  carrier: 'none' as const,
  outcome: 'not_delivered' as const,
  detail:
    "this unit's carrier has no mid-turn channel (only an ACP adapter advertising _meta.steering.supported takes a steer); the finding goes to the gate",
};
const RECORDED_WORKER_ADVICE_RESPONSE = {
  type: 'workerAdviceResponse' as const,
  session: 'run-1',
  ord: 3,
  attempt: 1,
  findingId: 'f-3fa9c2e1d0b4a7e6',
  disposition: 'declined' as const,
  reason: 'campaign.rs:325 documents the exclusion',
};
respondsWith<Wire.AdviceDeliveredEvent, typeof RECORDED_ADVICE_DELIVERED>();
respondsWith<Wire.AdviceDeliveredEvent, typeof RECORDED_ADVICE_NOT_DELIVERED>();
respondsWith<Wire.WorkerAdviceResponseEvent, typeof RECORDED_WORKER_ADVICE_RESPONSE>();
respondsWith<Wire.CoreEvent, Wire.AdviceDeliveredEvent>();
respondsWith<Wire.CoreEvent, Wire.WorkerAdviceResponseEvent>();
respondsWith<Wire.TeamAdviceEvent, Wire.AdviceDeliveredEvent | Wire.WorkerAdviceResponseEvent>();
// The closed token sets the engine emits, both directions (the `(string & {})` tail stays open).
respondsWith<Wire.AdviceDeliveredEvent['outcome'], 'injected' | 'turn_ended' | 'refused' | 'not_delivered'>();
respondsWith<Wire.AdviceDeliveredEvent['carrier'], 'acp_steering' | 'none'>();
respondsWith<Wire.WorkerAdviceResponseEvent['disposition'], 'accepted' | 'declined'>();
const GATE_UNGATED = {
  ...GATE_NO_JUDGE,
  hasDeterministicFloor: false,
  evaluatorPolicies: [] as string[],
  ungated: true,
  ungatedReason: 'no floor: the repo-checks floor did not apply; no judge: no eligible judge seat distinct from creator `claude`',
  // #449 @ 9e11685: the two per-layer reasons ride beside the summary, `null` when the layer ran.
  floorNote: 'no pinned validator; the repo-checks floor did not apply: the tree was not changed',
  judgeSkippedReason: 'no eligible judge seat distinct from creator `claude` (roster: claude; benched: codex (signed out — launcher))',
};
respondsWith<Wire.GateEvaluatedEvent, typeof GATE_UNGATED>();
// A repo-checks frame with NOTHING detected says WHY (#449 @ 9e11685) — a consumer renders
// "0 checks detected", never "checks ran".
const REPO_CHECKS_NONE_DETECTED = {
  type: 'repoChecksEvaluated' as const,
  session: 'run-1',
  ord: 3,
  attempt: 0,
  passed: true,
  criterion: 'the repository checks pass on the verified tree',
  checks: [] as Wire.RepoCheckRun[],
  skipped: [] as string[],
  sandboxLevel: 'none',
  sandboxError: null,
  detectError: 'no package.json scripts among typecheck/lint/test, no Cargo.toml',
};
respondsWith<Wire.RepoChecksEvaluatedEvent, typeof REPO_CHECKS_NONE_DETECTED>();
respondsWith<Wire.BenchedSeat['source'], 'launcher' | 'ballot' | 'worker' | 'judge'>();
respondsWith<Wire.AcpFallbackKind, 'auth_failed' | 'unauthenticated'>();
const BASE_RESOLVED_WITH_BRANCH = { ...BASE_RESOLVED, runBranch: 'wicked/run-1' };
respondsWith<Wire.RunBaseResolvedEvent, typeof BASE_RESOLVED_WITH_BRANCH>();
// The author launch, both directions; the plan / test set / diff / status stamps the daemon produces.
accepts<z.input<typeof TestingAuthorSchema>, Wire.TestingAuthorBody>();
respondsWith<Wire.WorkflowPlan, QeAuthorPlan>();
respondsWith<Wire.TestSet, TestSet>();
respondsWith<Wire.RunDiff, WorktreeDiff>();
respondsWith<Wire.RunDiff, { diff: string; truncated: boolean; source: 'branch'; branch: string; base: string }>();
respondsWith<Wire.InteractiveStatusPosted, SeamStatusPayload & { ts: string }>();
respondsWith<Wire.CampaignsListResponse['test_sets'], TestSet[] | undefined>();

describe('wave 6 wire shapes (api-types 0.36.0)', () => {
  it('spells unitDistributed exactly as the engine emits it — camelCase — and the narrator reads it', () => {
    // The teeth are the compile-time assertions above; these keep the literal live and prove the
    // narrator reads the EMITTED spelling (a consumer of `degraded_reason` saw undefined pre-0.36).
    expect(Object.keys(RECORDED_UNIT_DISTRIBUTED).sort()).toEqual(
      ['agreementPct', 'cli', 'degradedReason', 'dissent', 'distinctnessFallback', 'ord', 'returned', 'routingMethod', 'seatConstraint', 'seated', 'session', 'type'].sort(),
    );
    // (core#461) The fallback key is spelled `null`, never absent, on the engine that emits it …
    expect(RECORDED_UNIT_DISTRIBUTED.distinctnessFallback).toBeNull();
    expect('distinctnessFallback' in RECORDED_UNIT_DISTRIBUTED).toBe(true);
    // … and reads `'creator_seat'` when a review unit stays on its creator's seat.
    expect(RECORDED_UNIT_DISTRIBUTED_FALLBACK.distinctnessFallback).toBe('creator_seat');
    expect(RECORDED_UNIT_DISTRIBUTED.degradedReason).toContain('4 of 5 seats benched');
    expect(councilOutcomeSuffix(RECORDED_UNIT_DISTRIBUTED as unknown as Wire.CoreEvent)).toContain('4 of 5 seats benched: codex (signed out — launcher)');
    // The deprecated aliases are OPTIONAL: a frame without them satisfies the contract (asserted
    // at compile time above); a consumer must not require them.
    expect('degraded_reason' in RECORDED_UNIT_DISTRIBUTED).toBe(false);
  });
  it('spells the wave-6 gate, fence, checks and base frames as the engine does', () => {
    expect(GATE_UNGATED.ungated).toBe(true);
    expect(GATE_UNGATED.floorNote).toMatch(/no pinned validator/);
    expect(GATE_UNGATED.judgeSkippedReason).toMatch(/no eligible judge seat/);
    expect(WORKER_DENIED.carrier).toBe('acp');
    expect(WORKER_DENIED.remedy).toMatch(/deliver phase/);
    // An empty report says WHY — "0 checks detected", never "checks ran".
    expect(REPO_CHECKS_NONE_DETECTED.checks).toEqual([]);
    expect(REPO_CHECKS_NONE_DETECTED.detectError).toContain('no package.json');
    expect(BASE_RESOLVED_WITH_BRANCH.runBranch).toBe('wicked/run-1');
  });
});

describe('wicked-core#431 wire shapes (api-types 0.33.0)', () => {
  it('spells the new frames exactly as the engine emits them', () => {
    // The teeth are the compile-time assertions above; this keeps the literals live.
    expect(GATE_NO_JUDGE.judgeCli).toBeNull();
    expect(GATE_WITH_JUDGE.judgeDistinct).toBe(true);
    expect(MUTATION_RESTORED.restored).toBe(true);
    expect(WORKTREE_RESTORED.discarded).toEqual(MUTATION_RESTORED.changed);
    expect(WORKTREE_RESTORED.suggestionRef).toBe('refs/wicked/suggestions/run-1/4/0');
    expect(WORKTREE_RESTORED_UNPINNED.suggestionRef).toBeNull();
    expect(LIFT_CONFLICT.outcome).toBe('conflict');
    expect(TOOL_DENIED.carrier).toBe('acp');
    expect(TOOL_DENIED_KINDLESS.kind).toBeNull();
    expect(TOOL_DENIED_KINDLESS.path).toBeNull();
    expect(BASE_RESOLVED.behind).toBe(5);
    expect(READ_ONLY_REROUTE.fallbackKind).toBe('read_only_requires_wrapped');
  });
});

// ── Response direction: daemon → client ────────────────────────────────────────

// F-046 (api-types 0.30.0) — the interactive create proxy's refusals satisfy the published shapes,
// both directions on the code union so a code added or dropped on either side breaks this file;
// `requested` is REQUIRED (the refs as spelled — codex on #506), and the post-dispatch 502 is its
// own published shape.
respondsWith<Wire.InteractiveDocCreateRefusal, DocCreateRefusal>();
respondsWith<DocCreateRefusal['code'], Wire.InteractiveDocCreateRefusal['code']>();
respondsWith<Wire.InteractiveDocCreateRefusal['code'], DocCreateRefusal['code']>();
respondsWith<string[], DocCreateRefusal['requested']>();
respondsWith<Wire.InteractiveDocCreateUndetermined, typeof CREATE_UNDETERMINED>();

// crew#502 (api-types 0.32.0) — chat scope, both directions: every body the contract lets a client
// send (`repoRefs`, the legacy `repoRef`, `projectId`) is accepted by the route schema, and what the
// route produces on open / detail / list satisfies the published shapes. The `scope` on the open
// response is the SAME `ChatScope` the resolver builds (`chat-scope.ts` types it off the contract),
// so a field renamed on one side breaks this file.
accepts<z.input<typeof ChatOpenSchema>, Wire.ChatOpenBody>();
respondsWith<
  Wire.ChatOpenResponse,
  {
    chatId: string;
    seats: { cliKey: string; ok: boolean; error?: string }[];
    scope: Wire.ChatScope;
    projectAttachError?: string;
  }
>();
respondsWith<Wire.ChatDetailResponse, { chatId: string; seats: string[]; scope: Wire.ChatScope | null }>();
respondsWith<Wire.ChatListResponse, { chats: ChatSummary[] }>();
// The REQUEST the proxy reads IS the published create body (both directions), and every frame the
// four seams emit on `status.posted` satisfies the published `InteractiveStatusPosted` once
// `emitInteractive` stamps `ts` (codex on #506: request/frame mappings, not just refusals).
respondsWith<Wire.InteractiveDocCreateRequest, DocCreateBody>();
respondsWith<DocCreateBody, Wire.InteractiveDocCreateRequest>();
// …and the proxy's ACTUAL normalization output (what the bridge receives) is that published body —
// not a detached alias (codex r3 on #506).
respondsWith<Wire.InteractiveDocCreateRequest, NonNullable<PreparedCreate['normalized']>>();
respondsWith<Wire.InteractiveStatusPosted, SeamStatusPayload & { ts: string }>();
respondsWith<Wire.InteractiveStatusPosted['state'], SeamStatusPayload['state']>();
respondsWith<SeamStatusPayload['state'], Wire.InteractiveStatusPosted['state']>();

// GET /runs and GET /runs/:id — the run list / run detail payloads.
respondsWith<Wire.SessionView[], Awaited<ReturnType<CoreAdapter['sessionsDetail']>>>();

// CREW-UX-2/3 (api-types 0.8.0) — the run-DTO joins the routes decorate at assembly. Both
// directions of each pin so the contract's spelling of the field cannot drift: `project_id`
// is `string | null` when a 0.8.0 server answers (null = genuinely unfiled) and absent only
// on older servers; `retry_of` / `retryOf` are `string` or ABSENT — `null` is not a legal
// spelling of "not a retry" and adding it to the contract must break this file.
respondsWith<Wire.AgentSession['project_id'], string | null | undefined>();
respondsWith<string | null | undefined, Wire.AgentSession['project_id']>();
respondsWith<Wire.AgentSession['retry_of'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['retry_of']>();
respondsWith<Wire.LaunchRunBody['retryOf'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['retryOf']>();

// CREW-UX-7 (api-types 0.9.0) — durable operator guidance on the run DTO: `string` or ABSENT,
// never `null` (absence spells "no note", covering never-set, cleared, and pre-0.9.0 servers).
respondsWith<Wire.AgentSession['guidance'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['guidance']>();

// crew#393 + crew#311 (api-types 0.18.0) — the delivery derivation the routes stamp on every
// served run must produce exactly the contract's union (both directions, so adding or dropping
// a state on either side breaks this file), and the terminal-resume 409 body must satisfy the
// published `ResumeRefusal`.
respondsWith<Wire.AgentSession['delivery'], DeliveryState['delivery']>();
respondsWith<DeliveryState['delivery'] | undefined, Wire.AgentSession['delivery']>();
respondsWith<Wire.ResumeRefusal, { error: string; recovery: 'retry' | 'deliver' }>();

// wicked-studio#27 (api-types 0.19.0) — the ad-hoc grouping surface. Request: `campaignId` /
// `groupLabel` are `string` or ABSENT; response: the run DTO echoes them as `campaign_id` /
// `group_label` (`string` or ABSENT — `null` is not a legal spelling of "ungrouped"), and the
// campaigns rollup fields reuse the run wire's own delivery union (both directions, so a state
// added or dropped on either side breaks this file).
respondsWith<Wire.LaunchRunBody['campaignId'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['campaignId']>();
respondsWith<Wire.LaunchRunBody['groupLabel'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['groupLabel']>();
// crew#632: launch channel and actor — body → DTO round-trip check.
respondsWith<Wire.LaunchRunBody['channel'], 'studio' | 'cli' | 'api' | undefined>();
respondsWith<'studio' | 'cli' | 'api' | undefined, Wire.LaunchRunBody['channel']>();
respondsWith<Wire.LaunchRunBody['actor'], string | undefined>();
respondsWith<string | undefined, Wire.LaunchRunBody['actor']>();
respondsWith<Wire.AgentSession['channel'], 'studio' | 'cli' | 'api' | undefined>();
respondsWith<'studio' | 'cli' | 'api' | undefined, Wire.AgentSession['channel']>();
respondsWith<Wire.AgentSession['launch_actor'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['launch_actor']>();
respondsWith<Wire.AgentSession['campaign_id'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['campaign_id']>();
respondsWith<Wire.AgentSession['group_label'], string | undefined>();
respondsWith<string | undefined, Wire.AgentSession['group_label']>();
respondsWith<Wire.CampaignNodeDelivery['delivery'], DeliveryState['delivery']>();
respondsWith<DeliveryState['delivery'], Wire.CampaignNodeDelivery['delivery']>();
respondsWith<
  Wire.AttachedRunView,
  { runId: string; status: Wire.SessionStatus; delivery: DeliveryState['delivery']; deliverUrl?: string }
>();
respondsWith<Wire.CampaignsListResponse, { campaigns: Wire.Campaign[]; groups: Wire.RunGroup[] }>();
// PUT /runs/:id/guidance — the route echoes what it stored.
respondsWith<Wire.SetGuidanceResult, { runId: string; guidance: string }>();

// GET /runs/:id/events — durable event-log replay (RecordedEvent narrows CoreEvent).
respondsWith<Wire.CoreEvent[] | null, Awaited<ReturnType<CoreAdapter['runEvents']>>>();
respondsWith<Wire.RecordedEvent[] | null, Awaited<ReturnType<CoreAdapter['runEvents']>>>();

// /ws unitOutputDelta (api-types 0.5.1) — the live streamed-output delta frame. The daemon fans
// CoreEvent frames out verbatim, so every field of the discriminated interface must satisfy the
// permissive CoreEvent the relay and the studio's event switches are typed against (its `text`
// chunk rides the named optional field, not just the index signature). The mapped-type spelling
// is LOAD-BEARING, not style: `CoreEvent` carries an explicit `[k: string]: unknown` index
// signature, and TypeScript rejects assigning an interface to an index-signature type
// (`respondsWith<Wire.CoreEvent, Wire.UnitOutputDeltaEvent>()` fails with TS2344 "Type
// 'UnitOutputDeltaEvent' does not satisfy the constraint 'CoreEvent'") because only anonymous
// object types — the mapped copy is one — are treated as having an inferable index signature.
// The mapped copy keeps the exact field set, so the check stays field-by-field. Runtime half:
// tests/ws-relay-passthrough.test.ts proves the frame reaches a WS client unmodified.
respondsWith<Wire.CoreEvent, { [K in keyof Wire.UnitOutputDeltaEvent]: Wire.UnitOutputDeltaEvent[K] }>();

// GET /runs/:id/gate — the route spreads the cache entry over `{ runId }`.
respondsWith<Wire.GateInfo, { runId: string } & GateCacheEntry>();

// GET /runs/:id/elicitation — the cache entry IS the response body.
respondsWith<Wire.ElicitationInfo, ElicitationEntry>();

// GET /repos — registered repositories.
respondsWith<Wire.RepoEntry[], Awaited<ReturnType<CoreAdapter['listRepos']>>>();

// GET /roster — every seat carries its runtime health (crew#274) and its sign-in presence
// (seat sign-in, api-types 0.5.0); the produced entry is the seat verbatim — which is what
// lets the engine's `login_invocation` ride through — plus REQUIRED health and signed_in
// fields, which must satisfy the contract's optional ones.
respondsWith<
  { roster: Wire.RosterSeat[] },
  {
    roster: (Wire.RosterSeat & {
      health: Wire.SeatHealth;
      signed_in: boolean | null;
      login_invocation?: string;
    })[];
  }
>();

// GET /workflows — built-ins (drop-ins are parsed into the same type).
respondsWith<Wire.WorkflowDef[], typeof BUILTIN_WORKFLOWS>();

// Governance reads (crew#40/41/43).
respondsWith<Wire.GovernancePolicy[], Awaited<ReturnType<CoreAdapter['listPolicies']>>>();
respondsWith<Wire.ConformanceRule[], Awaited<ReturnType<CoreAdapter['listConformanceRules']>>>();
respondsWith<Wire.GovernanceClaim[], Awaited<ReturnType<CoreAdapter['listConformanceClaims']>>>();
respondsWith<Wire.CoverageReport | null, Awaited<ReturnType<CoreAdapter['getCoverageReport']>>>();
respondsWith<Wire.GraphKind[], Awaited<ReturnType<CoreAdapter['getGraphKindsForRepo']>>>();

// Steering (STEERING program): the unified steering-rule fields ride the ConformanceRule pin
// above; these pin the import surface's produced results and the boolean presence gate.
respondsWith<Wire.SteeringImportResult[], Awaited<ReturnType<CoreAdapter['importSteeringRules']>>>();
respondsWith<
  Wire.SteeringImportResponse,
  { results: Wire.SteeringImportResult[]; imported: number; rejected: number }
>();
respondsWith<boolean, ReturnType<CoreAdapter['steeringSupported']>>();

// The steering-author landing (crew#388): the `landing` field POST /runs/:id/gate (and a gated
// /resume) produces on approve of a propose gate must satisfy the published shape.
respondsWith<Wire.SteeringLandingResult, Awaited<ReturnType<typeof import('../src/api/steering-landing.js').landSteeringProposal>>>();

// Testing (crew-testing): POST /testing/evals/run + /testing/corpora/import — the report and
// the import receipt are the ENGINE's serde output passed through verbatim (snake_case), so
// what the adapter parses out of the addon must satisfy the published shapes; the boolean is
// the presence gate the 501 posture hangs off (core-ts ≥ 0.7.5).
respondsWith<Wire.GovernanceEvalReport, Awaited<ReturnType<CoreAdapter['runGovernanceEvals']>>>();
respondsWith<
  Wire.ImportEvalCorpusResponse,
  Awaited<ReturnType<CoreAdapter['importGovernanceCorpus']>>
>();
respondsWith<boolean, ReturnType<CoreAdapter['governanceEvalsSupported']>>();

// Eval-run history (api-types 0.27.0, the #394/#395 companion): what the EvalRunStore records and
// GET /testing/evals[/:id] serves must satisfy the published rows — INCLUDING `rule_coverage`
// riding the summary row optionally (an engine predating core #394 emits none, and the row must
// still validate without it), and the report's own optional `rule_coverage`. The `accepts` pins
// below say the OPPOSITE direction holds too: a report WITH coverage and a report WITHOUT it are
// both legal engine outputs the store's record input must take verbatim.
respondsWith<Wire.EvalRunSummary, Awaited<ReturnType<import('../src/api/eval-store.js').EvalRunStore['record']>>>();
respondsWith<Wire.EvalRunDetail, NonNullable<Awaited<ReturnType<import('../src/api/eval-store.js').EvalRunStore['get']>>>>();
respondsWith<Wire.ListEvalRunsResponse, { runs: Wire.EvalRunSummary[] }>();
// An OLDER engine's report — predating core #394, no `rule_coverage` at all — validates.
accepts<
  Wire.GovernanceEvalReport,
  { results: Wire.GovernanceEvalResult[]; summary: Wire.GovernanceEvalSummary; degraded: 'facet-only' | null }
>();
// The engine's COMPLETE report (api-types 0.27.0 — codex round 7 on #475): the fixture is the JSON
// wicked-core's own pinned-shape test asserts `rules eval --json` serializes (evals.rs
// `report_wire_shape_is_the_pinned_snake_case_contract`, branch `feat/evals-effect-and-coverage` @
// a87e461 lines 1520-1585: `sample()` at 1142-1163 spells the description) — every report field,
// all four `rule_coverage` fields, all seven `per_type` keys. `as const` is avoided so the arrays
// stay mutable like the parsed JSON; the literal unions are pinned where the contract narrows them.
const ENGINE_REPORT_WITH_COVERAGE = {
  results: [
    {
      sample: { id: 'dev-force-push', description: 'description of dev-force-push', kind: 'bad' as const, steering_type: 'development' },
      expected: 'deny' as const,
      fired: ['GOV-FORCE-PUSH'],
      verdict: 'caught' as const,
    },
    {
      sample: { id: 'sec-hardcoded', description: 'description of sec-hardcoded', kind: 'bad' as const, steering_type: 'security' },
      expected: 'deny' as const,
      fired: [] as string[],
      verdict: 'gap' as const,
      nearest_rules: [] as Wire.GovernanceEvalNearestRule[],
    },
  ],
  summary: { total: 2, caught: 1, gaps: 1, false_positives: 0 },
  degraded: 'facet-only' as const,
  rule_coverage: {
    exercised: 1,
    unexercised: [] as Wire.GovernanceEvalUnexercisedRule[],
    recall_only: 0,
    per_type: {
      architecture: { exercised: 0, unexercised: 0 },
      compliance: { exercised: 0, unexercised: 0 },
      'design-ux': { exercised: 0, unexercised: 0 },
      development: { exercised: 0, unexercised: 0 },
      operations: { exercised: 0, unexercised: 0 },
      security: { exercised: 1, unexercised: 0 },
      testing: { exercised: 0, unexercised: 0 },
    },
  },
};
accepts<Wire.GovernanceEvalReport, typeof ENGINE_REPORT_WITH_COVERAGE>();
// … and the declaration covers EXACTLY the producer's coverage fields — a field the engine
// serializes that the contract does not declare, or a declared field the engine never emits, stops
// this file compiling (both directions of every key set; `keyof` includes optional keys).
accepts<keyof Wire.GovernanceEvalRuleCoverage, keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage>();
accepts<keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage, keyof Wire.GovernanceEvalRuleCoverage>();
accepts<keyof Wire.GovernanceEvalTypeCoverage, keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type.security>();
accepts<keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type.security, keyof Wire.GovernanceEvalTypeCoverage>();
accepts<Wire.SteeringType, keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type>();
accepts<keyof typeof ENGINE_REPORT_WITH_COVERAGE.rule_coverage.per_type, Wire.SteeringType>();
accepts<Wire.GovernanceEvalRuleCoverage['per_type'], Record<Wire.SteeringType, Wire.GovernanceEvalTypeCoverage> | undefined>();
// A stored record whose coverage carries only the two REQUIRED fields still validates: the daemon
// persists `rule_coverage` verbatim and validates none of it, so `recall_only` / `per_type` are
// optional on the contract — a consumer reads their absence as "no per-type coverage", never zeros.
accepts<
  Wire.GovernanceEvalReport,
  {
    results: Wire.GovernanceEvalResult[];
    summary: Wire.GovernanceEvalSummary;
    degraded: null;
    rule_coverage: { exercised: number; unexercised: { rule_id: string; steering_type: Wire.SteeringType }[] };
  }
>();
// Steering `effect` (api-types 0.27.0): the operator-authorable `warn` band is a legal effect on
// the wire alongside the policy-era three; a rule WITHOUT one stays recall-only (still legal).
accepts<Wire.ConformanceRule['effect'], 'deny' | 'warn' | 'allow_with_conditions' | 'allow' | undefined>();

// Multiscope responses (api-types 0.15.0; 0.17.0 grew `campaignRegistered` + the optional
// `projectAttachError`) — the recon trigger's fan receipt and the campaign launch's additive
// `runIds`: what the routes construct must satisfy the published shapes.
respondsWith<
  Wire.TestingReconResponse,
  { runId: string; runIds: string[]; campaign: string; campaignRegistered: boolean }
>();
respondsWith<
  Wire.TestingReconResponse,
  {
    runId: string;
    runIds: string[];
    campaign: string;
    campaignRegistered: boolean;
    projectAttachError: string;
  }
>();
respondsWith<Wire.LaunchCampaignResponse, { campaignId: string; runIds: string[] }>();
respondsWith<Wire.LaunchCampaignResponse, { campaignId: string }>();

// Governance wiki management (wiki-mgmt): GET /governance/wiki/scoreboard + /governance/wiki/meta.
respondsWith<
  Wire.GovernanceScoreboard,
  Awaited<ReturnType<CoreAdapter['governanceScoreboard']>>
>();
respondsWith<Wire.GovernanceWikiMeta['ruleset_count'], Awaited<ReturnType<CoreAdapter['countRuleSets']>>>();
respondsWith<Wire.GovernanceWikiMeta['scoreboard_available'], ReturnType<CoreAdapter['wikiScoreboardSupported']>>();

// GET/PATCH /repos/:id/requirements — server-side search + overrides.
respondsWith<Wire.RequirementsPage, RequirementsPage>();
respondsWith<Wire.RequirementDetail, RequirementDetail>();

// GET/PUT /settings — persisted system settings (defaults applied server-side). Checked twice:
// the compiled-in defaults, and the adapter's read shape (defaults + persisted patch), which
// carries the additive `worker_config_root` (seat sign-in, api-types 0.5.0).
respondsWith<Wire.SystemSettings, typeof DEFAULT_SETTINGS>();
respondsWith<Wire.SystemSettings, Awaited<ReturnType<CoreAdapter['getSettings']>>>();

// Projects (DES-PROJECT-001 §5.2) — the 9-route surface's reads.
respondsWith<Wire.Project, Awaited<ReturnType<CoreAdapter['projectCreate']>>>();
respondsWith<Wire.Project[], Awaited<ReturnType<CoreAdapter['projectList']>>>();
respondsWith<Wire.Project | null, Awaited<ReturnType<CoreAdapter['projectGet']>>>();
respondsWith<Wire.ProjectMember[], Awaited<ReturnType<CoreAdapter['projectMembers']>>>();
respondsWith<
  { member: Wire.ProjectMember; created: boolean },
  Awaited<ReturnType<CoreAdapter['projectMemberAttach']>>
>();
// GET /projects/:id/prompts — the durable prompt inbox rows, verbatim engine shape.
respondsWith<
  Wire.InteractionRequest[] | null,
  Awaited<ReturnType<CoreAdapter['interactionRequests']>>
>();

// GET /runs/:id/files + GET /runs/:id/diff (DES-FEEDBACK-002 CREW-1, api-types 0.7.0) — the
// in-studio viewer's capped file read and worktree diff. The routes produce `{path} + read` /
// the diff shape verbatim, so the machinery types must satisfy the published contract.
respondsWith<Wire.RunFileContent, { path: string } & CappedFileRead>();
respondsWith<Wire.RunDiff, WorktreeDiff>();

// F-083 (crew#535): `skills.stale-rules` and `SkillsManifestResponse.current.rules` / `.drift` are
// DECLARED since api-types 0.36.0 — the carve-out that held the pending kind out of the both-ways
// pins is gone, and `SkillsHealth` is pinned directly again (below).

// GET /diagnostics (api-types 0.16.0) — the daemon's self-knowledge surface. The route
// assembles exactly this shape from the diagnostics module's machinery types; pinning it here
// (and each machinery type below, BOTH directions) means a null-vs-absent or camelCase drift
// in either the module or the contract stops compiling instead of shipping.
respondsWith<
  Wire.DiagnosticsResponse,
  {
    components: {
      crew: string;
      studioBundle: string | null;
      coreTs: string | null;
      engineBinaries: Record<string, string | null>;
    };
    daemon: { uptimeMs: number; startedAt: number; port: number };
    stores: StoreFileEntry[];
    recentErrors: RecentError[];
    acp: { byCli: Record<string, AcpCliFold> };
    skills: SkillsHealth;
    governance: GovernanceHealth;
  }
>();
// The governance block (api-types 0.31.0, crew#495): the store the engine's emit seam writes to,
// the records on it, the dead-letter fold and its findings — pinned both directions so a
// null-vs-absent drift, a renamed source token or a finding kind one side does not know stops
// compiling instead of shipping.
respondsWith<Wire.DiagnosticsGovernance, GovernanceHealth>();
respondsWith<GovernanceHealth, Wire.DiagnosticsGovernance>();
respondsWith<Wire.DiagnosticsGovernanceStoreSource, GovernanceStoreSource>();
respondsWith<GovernanceStoreSource, Wire.DiagnosticsGovernanceStoreSource>();
respondsWith<Wire.DiagnosticsGovernanceFinding['kind'], GovernanceFindingKind>();
respondsWith<GovernanceFindingKind, Wire.DiagnosticsGovernanceFinding['kind']>();
respondsWith<Wire.DiagnosticsGovernanceDeadletters, GovernanceDeadletters>();
respondsWith<GovernanceDeadletters, Wire.DiagnosticsGovernanceDeadletters>();
respondsWith<Wire.DiagnosticsGovernanceRecords, GovernanceRecords>();
respondsWith<GovernanceRecords, Wire.DiagnosticsGovernanceRecords>();
// `GET /repos/:id/graph` (api-types 0.35.0, F-2R2-005): the daemon's typed reply and the published
// shape pinned both ways, so a `reason`/`finding` rename or a graph-shape drift stops compiling
// (independent review of #533, F-5).
respondsWith<Wire.RepoGraphResponse, RepoGraphReply>();
respondsWith<RepoGraphReply, Wire.RepoGraphResponse>();
// The skills seam's health block (api-types 0.28.0), both directions.
respondsWith<Wire.DiagnosticsSkills, SkillsHealth>();
respondsWith<SkillsHealth, Wire.DiagnosticsSkills>();
// Design v3.6 (api-types 0.29.0, crew #490): the LAST-resort installer copy is a source kind the
// contract admits, and the persistent warning it raises is a finding kind the contract admits —
// pinned both directions so neither side can grow a kind the other does not know.
respondsWith<Wire.SkillSourceKind, PluginSource['kind']>();
respondsWith<PluginSource['kind'], Wire.SkillSourceKind>();
respondsWith<Wire.SkillSourceKind, 'installer-copy'>();
respondsWith<Wire.DiagnosticsSkillsFinding['kind'], SkillsHealthFindingKind>();
respondsWith<SkillsHealthFindingKind, Wire.DiagnosticsSkillsFinding['kind']>();
// F-083 (api-types 0.36.0): the stale-rules kind is declared, both ways.
respondsWith<Wire.DiagnosticsSkillsFinding['kind'], 'skills.stale-rules'>();
respondsWith<Wire.DiagnosticsSkillsFinding['kind'], 'skills.source'>();
respondsWith<Wire.DiagnosticsSkillsFinding['kind'], 'skills.manifest'>();
respondsWith<Wire.AcpCliDiagnostics, AcpCliFold>();
respondsWith<AcpCliFold, Wire.AcpCliDiagnostics>();
respondsWith<Wire.DiagnosticsRecentError, RecentError>();
respondsWith<RecentError, Wire.DiagnosticsRecentError>();
respondsWith<Wire.DiagnosticsStoreFile, StoreFileEntry>();
respondsWith<StoreFileEntry, Wire.DiagnosticsStoreFile>();

// Identity/actor contract (task #88): the implicit local actor and the audit
// trail's read shape must satisfy what the contract publishes.
respondsWith<Wire.Actor, typeof LOCAL_ACTOR>();
respondsWith<Wire.AuditEntry[], Awaited<ReturnType<AuditLog['read']>>>();

// ── Request direction: client → daemon ─────────────────────────────────────────
//
// The contract tells a client what it may send; the zod schemas decide what the daemon
// accepts. Contract ⊆ schema-input, or a legal client request 400s.

accepts<z.input<typeof LaunchSchema>, Wire.LaunchRunBody>();
accepts<z.input<typeof GateSchema>, Wire.GateDecision>();
accepts<z.input<typeof GuidanceSchema>, Wire.SetGuidanceBody>();
accepts<z.input<typeof OpenTerminalSchema>, Wire.OpenTerminalBody>();
// POST /open (crew#273) — every body the contract lets the studio Files tab send must parse.
accepts<z.input<typeof OpenPathSchema>, Wire.OpenPathBody>();
// Projects (DES-PROJECT-001): every body the contract lets a client send must parse.
accepts<z.input<typeof CreateProjectSchema>, Wire.CreateProjectBody>();
accepts<z.input<typeof UpdateProjectSchema>, Wire.UpdateProjectBody>();
accepts<z.input<typeof AttachMemberSchema>, Wire.AttachMemberBody>();
// Presets (DES-TEAMING-002 C2): every body the contract lets a client send must parse, and the
// adapter's preset rows satisfy the published shape.
accepts<z.input<typeof PutPresetSchema>, Wire.PutPresetBody>();
respondsWith<Wire.Preset, Awaited<ReturnType<CoreAdapter['putPreset']>>>();
respondsWith<Wire.Preset[], Awaited<ReturnType<CoreAdapter['listPresets']>>>();
// Team surface (DES-TEAMING-002 T8): the command bodies parse, and the read route and the adapter's
// team reads produce the published shapes.
accepts<z.input<typeof EditPlanSchema>, Wire.EditPlanBody>();
accepts<z.input<typeof PlanPreviewSchema>, Wire.PlanPreviewBody>();
respondsWith<Wire.RunTeamResponse, ReturnType<typeof joinTeam>>();
respondsWith<Wire.TeamOutboxReplayReport, Awaited<ReturnType<CoreAdapter['replayTeamOutbox']>>>();
respondsWith<Wire.CatalogEntry[], Awaited<ReturnType<CoreAdapter['catalog']>>>();
respondsWith<Wire.PlanPreviewResponse, Awaited<ReturnType<CoreAdapter['previewPlan']>>>();
// Steering (STEERING program) — the import batch and the "add with chat" authoring launch.
accepts<z.input<typeof SteeringImportSchema>, Wire.SteeringImportBody>();
accepts<z.input<typeof SteeringAuthorSchema>, Wire.SteeringAuthorBody>();
// Testing (crew-testing) — the evals-run selector and the corpus-import batch.
accepts<z.input<typeof RunGovernanceEvalsSchema>, Wire.RunGovernanceEvalsBody>();
accepts<z.input<typeof ImportEvalCorpusSchema>, Wire.ImportEvalCorpusBody>();
// Multiscope (api-types 0.15.0) — the recon trigger and the campaign launch: every body the
// contract lets a client send (projectId/repoRefs included) must parse.
accepts<z.input<typeof TestingReconSchema>, Wire.TestingReconBody>();
accepts<z.input<typeof LaunchCampaignSchema>, Wire.LaunchCampaignBody>();
// POST /projects/:id/graph/refresh — the additive `force` body (estate-migration path).
accepts<z.input<typeof RefreshProjectGraphSchema>, Wire.RefreshProjectGraphBody>();

// Memory management (DES-MEM-FACETED-001, api-types 0.22.0) — the shapes the /memory routes build
// from estate must satisfy the contract, and the retire body the contract lets a client send must
// parse against the route schema.
respondsWith<Wire.ListMemoriesResponse, { memories: Wire.MemoryItem[] }>();
respondsWith<
  Wire.MemoryCoverageResponse,
  { total: number; by_tier: Record<string, number>; by_kind: Record<string, number> }
>();
respondsWith<Wire.RetireMemoryResponse, { erased: number }>();
accepts<z.input<typeof RetireMemorySchema>, Wire.RetireMemoryBody>();

// Skills keystone (api-types 0.28.0 — re-minted from this branch's 0.27.0 after #475 landed 0.27.0
// first; Copilot on #480 had caught the earlier stale 0.26.0 label) — the daemon-owned garden plugin
// root's file manager.
// Response direction: every store answer the routes hand through must satisfy the contract.
respondsWith<Wire.SkillManifest, ReturnType<SkillsStore['manifest']>>();
respondsWith<Wire.SkillFileTree, ReturnType<SkillsStore['listFiles']>>();
respondsWith<Wire.SkillReadResult, Awaited<ReturnType<SkillsStore['readFile']>>>();
respondsWith<Wire.SkillMutationResult, ReturnType<SkillsStore['enable']>>();
respondsWith<Wire.SkillMutationResult, ReturnType<SkillsStore['writeFile']>>();
respondsWith<Wire.SkillMutationResult, ReturnType<SkillsStore['add']>>();
// publish is async (it awaits the baseline env provisioner) — pin what it RESOLVES to.
respondsWith<Wire.SkillPublishResult, Awaited<ReturnType<SkillsStore['publish']>>>();
respondsWith<Wire.SkillRefreshResult, ReturnType<SkillsStore['refreshBaseline']>>();
respondsWith<Wire.SkillAnalyzeResult, ReturnType<SkillsStore['analyze']>>();
// `current` (F-083, api-types 0.36.0): `{gen, path}` plus the declared `rules` / `drift` members — the produced shape satisfies the contract, both spelled.
respondsWith<Wire.SkillsManifestResponse['current'], ReturnType<SkillsStore['currentSnapshot']>>();
// snapshot.json is what the ENGINE reads — its skill rows reuse the contract's kind vocabulary.
respondsWith<Wire.SkillKind, SnapshotManifest['skills'][number]['kind']>();
// The finding kinds this branch adds (a blocked publish's reasons, and the 2xx-blocked refusals a
// publish-in-flight / root-changed now answer instead of a 409 — codex round 3) are in the union.
respondsWith<Wire.SkillFindingKind, 'catalog-invalid' | 'venv-failed' | 'missing-plugin-manifest' | 'publish-in-flight' | 'root-changed'>();
// Request direction: every body the contract lets a client send parses.
accepts<z.input<typeof SkillRevisionSchema>, Wire.SkillRevisionBody>();
accepts<z.input<typeof PutSkillFileSchema>, Wire.PutSkillFileBody>();
accepts<z.input<typeof AddSkillSchema>, Wire.AddSkillBody>();
accepts<z.input<typeof ReplaceSkillSchema>, Wire.ReplaceSkillBody>();
// NO skills setting is on the wire (codex round 5 / coordinator decision): the root is
// `<state home>/skills`, full stop — `skills_root` is retired with its env override (a configurable
// root let a PUT aim seeding at `~/.codex/skills`), and `skills_mirror` was withdrawn before it
// (design v3.2 §1: the daemon never writes into the user's CLI directories, so a knob for either
// would be a lie). Both must stay OFF the contract.
respondsWith<'skills_root' extends keyof Wire.SystemSettings ? never : true, true>();
respondsWith<'skills_mirror' extends keyof Wire.SystemSettings ? never : true, true>();

// ── api-types 0.38.0 — the frames the engine already emits, RECORDED (FIX-IT-ALL L8-0b) ─────────
// `tests/fixtures/engine-frames-0.38.0.json` is the record (key set + spellings from wicked-core
// 425de81 `event.rs::to_json`; the guard-class and hook-veto gate frames, `sandboxPosture` and
// `worktreeRetained` mirror the engine's own `to_json` tests — the creator-mkdir and dead_seat gate
// frames are DES-SHAPED: same key set and conventions, prose from DES-L4 R8 / DES-L3 §4). The
// literals below are the recorded frames as TypeScript so `satisfies` pins them against the 0.38.0
// declarations at compile time. The runtime block asserts the record and the pins agree
// byte-for-byte and that every gate frame is exactly 11 fields + `type` = 12 JSON keys — a key the
// engine renames, drops or adds shows up here before any skin reads it.
const RECORDED_GATE_ESCALATED = {
  type: 'gateEscalated',
  session: 'run-1',
  ord: 2,
  condition: 'evaluator_mutated_worktree',
  verdictSummary: 'the reproduce phase changed the tree',
  attempt: 0,
  denialSource: 'worktree_guard',
  defGate: false,
  outputCaptured: true,
  restored: true,
  discarded: [{ status: 'A', path: 'evidence/repro.md' }],
  suggestionRef: 'refs/wicked/suggestions/run-1/2/0',
} satisfies Wire.GateEscalatedEvent;
/** The hook-veto arm: `boundary_deny` with the source identity folded away — `denialSource: ""`. */
const RECORDED_GATE_ESCALATED_HOOK_VETO = {
  type: 'gateEscalated',
  session: 'run-1',
  ord: 2,
  condition: 'boundary_deny',
  verdictSummary: 'input governance denied a tool-call in unit-2',
  attempt: 1,
  denialSource: '',
  defGate: false,
  outputCaptured: true,
  restored: false,
  discarded: [],
  suggestionRef: null,
} satisfies Wire.GateEscalatedEvent;
/**
 * RECORDED from wicked-core b190f63 (PR #513, DES-L1 PR-1A): the fold read the Evaluator unit's OWN
 * `VERDICT: FAIL` line — `condition: verdict_not_pass` × `denialSource: evaluator_verdict`, the
 * findings in `verdictSummary`, engine-authored (`defGate: false`), output captured, nothing to
 * restore. The (condition, denialSource) pair the studio copy table keys on for the review-failed
 * gate; distinct from the judge's deny (`agent_validator`) and the second pass's (`evaluator`).
 */
const RECORDED_GATE_ESCALATED_EVALUATOR_VERDICT = {
  type: 'gateEscalated',
  session: 'run-1',
  ord: 4,
  condition: 'verdict_not_pass',
  verdictSummary: "the evaluator's verdict is FAIL\nReviewed the fix.\n- the regression test is missing\n- src/app.ts still reads `buggy`\nVERDICT: FAIL",
  attempt: 0,
  denialSource: 'evaluator_verdict',
  defGate: false,
  outputCaptured: true,
  restored: false,
  discarded: [],
  suggestionRef: null,
} satisfies Wire.GateEscalatedEvent;
/**
 * RECORDED from the same fold: the `gateEvaluated` frame that precedes it — 0.38.0's 20th key
 * `evaluatorVerdict: 'FAIL'` (the evaluator's own token; `null` on every unit the layer does not
 * read and when the evaluator wrote no line — then `denial.source === 'evaluator_verdict'` with the
 * contract text), `combined: false`, `denial` the machine-readable twin of `denialReason`.
 */
const RECORDED_GATE_EVALUATED_EVALUATOR_VERDICT = {
  type: 'gateEvaluated',
  session: 'run-1',
  ord: 4,
  criterion: null,
  hasDeterministicFloor: false,
  deterministicPass: true,
  agentVerdict: null,
  agentReasoning: null,
  evaluatorPass: true,
  evaluatorPolicies: [],
  denialReason: "the evaluator's verdict is FAIL\nReviewed the fix.\n- the regression test is missing\n- src/app.ts still reads `buggy`\nVERDICT: FAIL",
  denial: {
    source: 'evaluator_verdict',
    reason: "the evaluator's verdict is FAIL\nReviewed the fix.\n- the regression test is missing\n- src/app.ts still reads `buggy`\nVERDICT: FAIL",
    claimId: null,
    ruleIds: [],
    deniedTool: null,
    phase: 'unit-4',
  },
  combined: false,
  judgeCli: null,
  judgeDistinct: null,
  ungated: true,
  ungatedReason: "no deterministic floor: no pinned validator; repo checks do not apply to an unbound run (no worktree); no judge: no pinned validator convened one and the unit did not change the tree; evaluator policies: none applied (default-allow)",
  floorNote: "no pinned validator; repo checks do not apply to an unbound run (no worktree)",
  judgeSkippedReason: null,
  evaluatorVerdict: 'FAIL',
} satisfies Wire.GateEvaluatedEvent;
const RECORDED_SANDBOX_POSTURE = {
  type: 'sandboxPosture',
  session: 'run-1',
  ord: 2,
  cli: 'codex',
  posture: 'advisory',
  reason: 'the registry record for `codex` declares no OS sandbox (`acp.os_sandbox` unset): containment is the worktree guard plus the command-text fences',
} satisfies Wire.SandboxPostureEvent;
const RECORDED_WORKTREE_RETAINED = {
  type: 'worktreeRetained',
  session: 'run-1',
  path: '/srv/wicked/runs/wicked-run-1',
  reason: 'the worktree holds uncommitted work the run branch does not carry (2 modified, 1 untracked)',
} satisfies Wire.WorktreeRetainedEvent;
// The two NEW frames are `type` aliases (the 0.31.0 rule) and relay through the CoreEvent-typed
// broadcast seams unchanged; GateEscalatedEvent stays the interface it has been since 0.1.
respondsWith<Wire.CoreEvent, Wire.SandboxPostureEvent>();
respondsWith<Wire.CoreEvent, Wire.WorktreeRetainedEvent>();
// A pre-#464 engine's five-key frame is still a valid GateEscalatedEvent (the six are optional).
respondsWith<Wire.GateEscalatedEvent, { type: 'gateEscalated'; session: string; ord: number; condition: string; verdictSummary: string }>();
// 0.38.0's other named shapes the daemon produces or will: the health capabilities object the route
// builds today satisfies the named interface; `GET /settings` today is `{ settings }` — a valid
// SettingsResponse without `path` (PR-L10-6 adds it).
respondsWith<Wire.HealthCapabilities, { deliverGate: boolean }>();
respondsWith<Wire.SettingsResponse, { settings: typeof DEFAULT_SETTINGS }>();
respondsWith<Wire.SettingsResponse, { settings: Awaited<ReturnType<CoreAdapter['getSettings']>>; path: string }>();
// `RepoCheckRun`'s seven 0.38.0 keys, spelled as core's `check_run_json` emits them (camelCase);
// a five-key frame from an older engine is still a RepoCheckRun.
respondsWith<
  Wire.RepoCheckRun,
  {
    name: string; argv: string[]; source: string; exitCode: number | null; timedOut: boolean; spawnError: string | null;
    durationMs: number; stdoutTail: string; stderrTail: string;
    boundS: number; boundNote: string | null; failureIds: string[]; classification: 'regression' | 'pre_existing_in_sandbox';
    preExisting: string[]; regressions: string[]; base: { head: string; cached: boolean; error: string | null } | null;
  }
>();

describe('api-types 0.38.0 — recorded + DES-shaped engine frames (FIX-IT-ALL L8-0b)', () => {
  const fixturePath = fileURLToPath(new URL('./fixtures/engine-frames-0.38.0.json', import.meta.url));
  const recorded = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

  it('the fixture IS the compile-time pins, byte for byte', () => {
    expect(recorded['gateEscalated']).toEqual(RECORDED_GATE_ESCALATED);
    expect(recorded['gateEscalatedHookVeto']).toEqual(RECORDED_GATE_ESCALATED_HOOK_VETO);
    expect(recorded['gateEscalatedEvaluatorVerdict']).toEqual(RECORDED_GATE_ESCALATED_EVALUATOR_VERDICT);
    expect(recorded['gateEvaluatedEvaluatorVerdict']).toEqual(RECORDED_GATE_EVALUATED_EVALUATOR_VERDICT);
    expect(recorded['sandboxPosture']).toEqual(RECORDED_SANDBOX_POSTURE);
    expect(recorded['worktreeRetained']).toEqual(RECORDED_WORKTREE_RETAINED);
  });

  // FIX-IT-ALL L1 mirror-first for core #513 (DES-L1 PR-1A, D-9). Fixed at core-ts 0.7.27: the
  // recorded frames are what the fold emits when an Evaluator agent unit's own output ends
  // `VERDICT: FAIL` — denied INTO THE ESCALATION GATE (never sessionFailed), the reviewer's words in
  // `verdictSummary`, and `gateEvaluated.evaluatorVerdict` the 20th key. A 0.7.26 engine emits the
  // 19-key gateEvaluated frame and never this (condition, denialSource) pair; both are recorded
  // here so the skins can build against the shape before the engine that emits it is pinned.
  it('the evaluator-verdict gate: gateEscalated{verdict_not_pass × evaluator_verdict}, engine-authored, output captured, nothing to restore; the findings ride verdictSummary', () => {
    const frame = recorded['gateEscalatedEvaluatorVerdict'] as Record<string, unknown>;
    expect(frame).toMatchObject({ condition: 'verdict_not_pass', denialSource: 'evaluator_verdict', defGate: false, outputCaptured: true, restored: false, discarded: [], suggestionRef: null });
    expect(frame['verdictSummary']).toMatch(/^the evaluator's verdict is FAIL\n/);
    expect(frame['verdictSummary']).toMatch(/\nVERDICT: FAIL$/);
    // The pair is distinct from every other recorded gate class the copy table keys on.
    const pairs = ['gateEscalated', 'gateEscalatedHookVeto', 'gateEscalatedCreatorMkdirOutside', 'gateEscalatedDeadSeat'].map((n) => {
      const f = recorded[n] as Record<string, unknown>;
      return `${String(f['condition'])}×${String(f['denialSource'])}`;
    });
    expect(pairs).not.toContain('verdict_not_pass×evaluator_verdict');
  });

  it('gateEvaluated carries `evaluatorVerdict` as its 20th key (0.38.0): the token the evaluator wrote, `null` never absent; `denial` is the twin with `source: evaluator_verdict`', () => {
    const frame = recorded['gateEvaluatedEvaluatorVerdict'] as Record<string, unknown>;
    const KEYS = ['agentReasoning', 'agentVerdict', 'combined', 'criterion', 'denial', 'denialReason', 'deterministicPass', 'evaluatorPass', 'evaluatorPolicies', 'evaluatorVerdict', 'floorNote', 'hasDeterministicFloor', 'judgeCli', 'judgeDistinct', 'judgeSkippedReason', 'ord', 'session', 'type', 'ungated', 'ungatedReason'];
    expect(Object.keys(frame).sort()).toEqual(KEYS);
    expect(frame).toMatchObject({ evaluatorVerdict: 'FAIL', combined: false });
    expect((frame['denial'] as Record<string, unknown>)['source']).toBe('evaluator_verdict');
    expect(frame['denialReason']).toBe((frame['denial'] as Record<string, unknown>)['reason']);
    // A 0.7.26 engine's 19-key frame is still a valid GateEvaluatedEvent (`evaluatorVerdict?` is optional) —
    // the tolerant read `evaluatorVerdict ?? null` is what a consumer keys on across both engines.
    const nineteen: Wire.GateEvaluatedEvent = { ...RECORDED_GATE_EVALUATED_EVALUATOR_VERDICT };
    delete nineteen.evaluatorVerdict;
    expect(Object.keys(nineteen)).toHaveLength(KEYS.length - 1);
    expect(nineteen.evaluatorVerdict ?? null).toBeNull();
  });

  it('gateEscalated carries exactly the 11 fields + `type` the engine emits (the two recorded and the two DES-shaped frames alike), in the camelCase the contract spells; `null` / `[]` / `""` are present, never absent', () => {
    const KEYS = ['attempt', 'condition', 'defGate', 'denialSource', 'discarded', 'ord', 'outputCaptured', 'restored', 'session', 'suggestionRef', 'type', 'verdictSummary'];
    for (const name of ['gateEscalated', 'gateEscalatedHookVeto', 'gateEscalatedCreatorMkdirOutside', 'gateEscalatedDeadSeat']) {
      const frame = recorded[name] as Record<string, unknown>;
      expect(Object.keys(frame).sort(), name).toEqual(KEYS);
      expect(Object.values(frame).some((v) => v === undefined), name).toBe(false);
      expect(Array.isArray(frame['discarded']), name).toBe(true);
    }
    expect((recorded['gateEscalatedHookVeto'] as Record<string, unknown>)['denialSource']).toBe('');
    expect((recorded['gateEscalatedHookVeto'] as Record<string, unknown>)['suggestionRef']).toBeNull();
    // The two DES-shaped classes the step-0 expectations name (L3 dead_seat · L4 boundary_deny × input_governance).
    expect(recorded['gateEscalatedDeadSeat']).toMatchObject({ condition: 'dead_seat', denialSource: 'dead_seat', attempt: 0, defGate: false });
    expect(recorded['gateEscalatedCreatorMkdirOutside']).toMatchObject({ condition: 'boundary_deny', denialSource: 'input_governance' });
  });

  it("sandboxPosture / worktreeRetained key sets are the engine's: unit-level with `cli` + `posture`, session-level with `path`", () => {
    expect(Object.keys(recorded['sandboxPosture'] as object).sort()).toEqual(['cli', 'ord', 'posture', 'reason', 'session', 'type']);
    expect(['os', 'advisory']).toContain((recorded['sandboxPosture'] as Record<string, unknown>)['posture']);
    expect(Object.keys(recorded['worktreeRetained'] as object).sort()).toEqual(['path', 'reason', 'session', 'type']);
  });
});

describe('wire contract (wicked-crew-api-types) drift guard', () => {
  it('compiles: daemon responses satisfy the contract, contract bodies parse (see typecheck)', () => {
    // The assertions above are compile-time; reaching this line means the module loaded,
    // which in turn means esbuild resolved every import. The real gate is
    // `tsc --noEmit -p tsconfig.test.json` (npm run typecheck), which CI runs per-PR.
    expect(true).toBe(true);
  });

  it("the engine's complete eval report fixture is internally consistent (per_type partitions the totals over the seven steering types)", () => {
    // The compile-time pins above establish the SHAPE; this keeps the copied numbers honest, so a
    // future edit to the fixture cannot silently make it a report no engine would emit.
    const rc = ENGINE_REPORT_WITH_COVERAGE.rule_coverage;
    const rows = Object.values(rc.per_type);
    expect(rows).toHaveLength(7);
    expect(rows.reduce((n, r) => n + r.exercised, 0)).toBe(rc.exercised);
    expect(rows.reduce((n, r) => n + r.unexercised, 0)).toBe(rc.unexercised.length);
    expect(ENGINE_REPORT_WITH_COVERAGE.summary.total).toBe(ENGINE_REPORT_WITH_COVERAGE.results.length);
  });

  it('the shipped built-in workflows are contract-shaped at runtime too', () => {
    // A cheap runtime cross-check on real data (not just types): every built-in workflow
    // the daemon serves from GET /workflows carries the contract's required keys.
    for (const wf of BUILTIN_WORKFLOWS) {
      expect(typeof wf.id).toBe('string');
      expect(Array.isArray(wf.phases)).toBe(true);
      for (const p of wf.phases) {
        expect(typeof p.id).toBe('string');
        expect(['recon', 'build', 'review', 'test']).toContain(p.kind);
        expect(p).toHaveProperty('gate');
        expect(['neutral', 'creator', 'evaluator']).toContain(p.role);
      }
    }
  });
});

describe('team-advice wire shapes (wicked-core#602, api-types 0.40.0)', () => {
  it('spells adviceDelivered and workerAdviceResponse exactly as the engine emits them', () => {
    // Every key always present — `detail` is `null`, never absent (the engine's to_json contract).
    expect(Object.keys(RECORDED_ADVICE_DELIVERED).sort()).toEqual(
      ['attempt', 'carrier', 'detail', 'findingIds', 'ord', 'outcome', 'session', 'type'].sort(),
    );
    expect('detail' in RECORDED_ADVICE_DELIVERED).toBe(true);
    expect(RECORDED_ADVICE_DELIVERED.detail).toBeNull();
    expect(Object.keys(RECORDED_ADVICE_NOT_DELIVERED).sort()).toEqual(
      Object.keys(RECORDED_ADVICE_DELIVERED).sort(),
    );
    expect(Object.keys(RECORDED_WORKER_ADVICE_RESPONSE).sort()).toEqual(
      ['attempt', 'disposition', 'findingId', 'ord', 'reason', 'session', 'type'].sort(),
    );
  });
});

describe('teamed routing wire shapes (wicked-core#590 S5)', () => {
  it('reads a teamed unitDistributed frame and routing artifact exactly as the engine serializes them', () => {
    // The engine's bytes (wicked-core `event_to_json` / serde on `RoutingInfo::Teamed`), verbatim,
    // parse to the compile-time pins above — so the pins describe what actually crosses the wire.
    const frame = JSON.parse(
      '{"type":"unitDistributed","session":"b86c14c1-e295-4659-8a30-51b4ec1ac589","ord":2,' +
        '"cli":"claude","routingMethod":"teamed","agreementPct":null,"returned":null,"seated":null,' +
        '"dissent":null,"degradedReason":null,"seatConstraint":null,"distinctnessFallback":null}',
    ) as Wire.UnitDistributedEvent;
    expect(frame).toEqual(RECORDED_UNIT_DISTRIBUTED_TEAMED);
    const routing = JSON.parse('{"method":"teamed","winner":"codex"}') as Wire.RoutingInfo;
    expect(routing).toEqual(TEAMED_ROUTING);
    expect(routing.method === 'teamed' ? routing.winner : undefined).toBe('codex');
    // A recorded run's council routing still narrows on the same tag.
    const recorded = JSON.parse(
      '{"method":"council","winner":"claude","agreement_pct":100,"returned":1,"seated":null,"dissent":0}',
    ) as Wire.RoutingInfo;
    expect(recorded).toEqual(RECORDED_COUNCIL_ROUTING);
    expect(recorded.method === 'council' ? recorded.agreement_pct : undefined).toBe(100);
  });
});
