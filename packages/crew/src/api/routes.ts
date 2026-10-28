import { REVIEW_WORKFLOW } from '../insights/workflow.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { busSeamsOffWarning, busUnavailableWarning } from '../core/bus-notice.js';
import { vaultBinWarning, vaultDiagnostics } from '../core/vault-bin.js';
import { PlanSchema, toLaunchPlan } from './plan-schema.js';
import type { RecordedStallFrame } from './stall-frame-index.js';
import { z } from 'zod';
import { listRequirements, getRequirement, patchRequirement } from './requirements.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { videoPalette } from '../appearance/video-palette.js';
import { CampaignsUnsupportedError, ChatUnsupportedError, CoreAdapter, ElicitationUnsupportedError, GovernanceReplayUnsupportedError, PlanLaunchUnsupportedError, SteeringUnsupportedError, addonSupportsQeOverride, addonSupportsReducedAssurance, humanGatePhaseIds, settingsFilePath } from '../core/adapter.js';
import { codeGraphDb, codeGraphErrorStatus, requirementsGraph } from '../core/repoPaths.js';
import type {
  ConformanceRule,
  CodeGraphData,
  AcpCliDiagnostics,
  ChatAttachment,
  CoreEvent,
  DiagnosticsSeatGovernanceEntry,
  RecordedEvent,
  RepoEntry,
  RepoFinding,
  SystemInfraRow,
} from '../core/types.js';
import { resolveCursorUnit } from '../core/cursor.js';
import type { InteractionRequest } from '../core/types.js';

/** Create `dir` (private) when missing and answer it — a read root must exist when a run launches. */
function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** {@link registerRoutes}'s one reading of a run's open gate rows (see `recordedOpenGate`). */
type RecordedOpenGate =
  | { state: 'none' }
  | { state: 'ambiguous'; ords: number[] }
  | { state: 'open'; ord: number; row: InteractionRequest };
import { detectRefusal, isOpenGate, offeredChoices, replayOpenGate, type GateCache, type GateRead, type GateResolution } from './gate-cache.js';
import type { ElicitationCache } from './elicitation-cache.js';
import { acceptanceRequirementOf, buildAcceptanceView } from '../qe/acceptance.js';
import { runIdentityOf, wireIdentity } from '../core/run-identity.js';
import { buildEvidenceBundle, coreUnitId, evidenceFilename } from './evidence.js';
import { attemptUnavailableReason, capturedAttempts, outputUnavailableReason, resolveUnit, storedAttempt, unitKeysFor } from './unit-output.js';
import type {
  ApproveProposalResponse,
  EditMemoryResponse,
  LaunchRunInput,
  ListMemoriesResponse,
  ListProposalsResponse,
  ResolveRunResponse,
  MemoryCoverageResponse,
  MemoryItem,
  PolicyLandingResult,
  PolicyReach,
  RejectProposalResponse,
  RetireMemoryResponse,
  QeAcceptanceCheck,
  SessionStatus,
  SessionView,
  WorkUnit,
} from '../core/types.js';
import { execCapped, ExecOutputTooLarge } from '../core/exec.js';
import { callEstateTool, EstateMcpError, memoryStoreInfo } from '../core/estate-mcp-client.js';
import { SeatHealthTracker } from './seat-health.js';
import { applyWorkerConfigRoot, signedInHeuristic } from './seat-signin.js';
import { applyCouncilSettings, isCouncilSize, isCouncilStaggerMs } from '../core/council-settings.js';
import { defaultLaunchRoster, markOptIn } from '../core/opt-in-seats.js';
import { chatSeatAdmission, type StandingSeat } from './seat-standing.js';
import {
  seatGovernanceDiagnostics,
  seatGovernanceWarnings,
  type DiagnosticSeatInput,
  type GovernanceSeatInput,
  type SeatGovernanceDiagnostic,
} from './seat-governance.js';
import { seatWorkDefaultNow } from './seat-work-default.js';
import { ROSTER_REFRESH_WAIT_MS, rosterWithStandingFactory, type RosterWithStanding } from './roster-standing.js';
import {
  SeatContainerStatus, gatewayDirOf, isContainerLoginCli, isContainerSeatFloor, isHostSeatFloor, loginDetail, runSeatLogin, seatLoginDepsFor, type ExecLike, type SeatLoginDeps,
} from './seat-container-login.js';
import type { SeatContainerLoginOutcome } from '../core/types.js';
import { ChatTurnIndex } from './chat-turns.js';
import type { ChatRepoRoot, ChatTranscriptStore } from './chat-transcripts.js';
import {
  ChatScopeIndex,
  chatScopeDeps,
  chatScopeStatement,
  prepareChatScratch,
  removeChatScratch,
  namedKindRefusal,
  resolveChatScope,
  type ChatSeatRefusal,
  type ChatScopeRequest,
} from './chat-scope.js';
import { ASK_TURN_BUDGET_SECS, AskPathIndex, isAskTurn } from './ask-paths.js';
import { chatTurnStep, resolveChatWorkflow, servedChatWorkflows, writeCapableStep, type ChatWorkflow } from './chat-workflow.js';
import { reassignRefusedSeats } from '../core/reassign-refusal.js';
import { allowedRootsFor, isInsideRoot, openWithSystemDefault } from './open-path.js';
import {
  InvalidDiffBaseError,
  MERGE_BASE_LITERAL,
  NotARegularFileError,
  UnresolvableDiffBaseError,
  branchDiff,
  isGitStopped,
  isPlainRef,
  readFileCapped,
  worktreeDiff,
} from './run-files.js';
import { DocRunIndex } from '../interactive/doc-run-index.js';
import { listInteractiveDocs } from '../interactive/docs-index.js';
import { SearchService, registerSearchRoutes } from './search-routes.js';
import type { FreshenCheckout } from './chat-freshness.js';
import { TestSetIndex } from '../qe/test-sets.js';
import { estateExe, parseEstateTotals, readBlastRadiusPages, resolveProjectGraphBinding } from '../projects/graph.js';
import { registerProjectRoutes, type ProjectRoutesDeps } from '../projects/routes.js';
import { registerProjectAggregateRoutes } from './project-aggregates.js';
import { registerProductRoutes } from './product.js';
import { registerPresetRoutes } from '../presets/routes.js';
import { registerTeamRoutes } from '../team/routes.js';
import { registerCampaignRoutes } from '../campaigns/routes.js';
import { registerGovernanceWikiRoutes } from './governance-wiki.js';
import {
  DEFAULT_STEERING_TYPE,
  STEERING_TYPE_VALUES,
  STEERING_TYPES,
  registerGovernanceSteeringRoutes,
} from './governance-steering.js';
import { isSteeringAuthorRun, landSteeringProposal } from './steering-landing.js';
import { inventoryComplete, parseInventoryClaims, type InventoryClaim } from '../core/inventory-claim.js';
import type { RejudgeOffer, RunInventoryResponse, SkipQeOffer } from 'wicked-crew-api-types';
import { ApproveEditSchema, approveEdited, captureLaunchRoots, editInFlight, FileProposalSchema, registerCaptureRoutes } from './capture.js';
import { registerTestingRoutes } from './testing.js';
import { registerDefaultEvalRoutes, runAndRecord, type DefaultEvalDeps } from '../evals/routes.js';
import { prepareRunEvalsLaunch, RUN_EVALS_WORKFLOW } from '../evals/workflow.js';
import { defaultReplaySet } from '../evals/replay.js';
import type { DefaultEvalStore } from '../evals/store.js';
import type { DecisionLike, EventLike, RunLike } from '../evals/capture.js';
import { gardenRootFor } from '../learn/scheduler.js';
import { DEMO_PRESET, demoLaunchRoots, registerDemoDocumentRoute, registerDemoRoutes, registerWalkthroughRoutes, walkthroughAcceptance, type BridgeCall } from './recording.js';
import { projectDocsRoot } from '../interactive/project-root.js';
import { registerSkillsRoutes } from './skills.js';
import { registerMcpRoutes } from './mcp.js';
import { chatMcpToolsFor } from './chat-mcp.js';
import type { AskServer } from '../mcp/ask-server.js';
import type { McpBroker } from '../mcp/broker.js';
import type { McpCallRecordSource } from '../mcp/call-records.js';
import { McpPolicies } from '../mcp/policies.js';
import type { McpRegistry } from '../mcp/registry.js';
import { disabledSkillsHealth, type SkillsRuntime } from '../skills/runtime.js';
import { withPhaseSkillGaps, type RunSkillGapIndex } from '../skills/phase-skill-gaps.js';
import {
  STATE_HOME_BLOCKER_CODE,
  STATE_HOME_REMEDY,
  isEngineStateHomeRefusal,
  stateHomeBlockerBody,
  type StateHomeWatch,
} from '../projects/state-home-preflight.js';
import { BASE_SKILL_POLICIES, BASE_SKILL_REF_SHAPE, baseSkillRemedy } from '../skills/base-skill.js';
import { REQUIRED_GARDEN_VERSION } from '../skills/plugin-source.js';
import type { EvalRunStore } from './eval-store.js';
import { engineRosterJson, noEligibleSeatBody, parseNoEligibleSeat, toEngineSeat } from '../core/engine-roster.js';
import { launchAssuranceNotice } from '../core/assurance.js';
import { launchRequiresQe, mayRequireQe, qeAcceptanceMode, qeSettingSkipReason } from '../core/qe-acceptance-setting.js';
import {
  aggregateReceipt,
  postHocDeliveryAssurance,
  qeAcceptanceFromView,
  qeAcceptanceRefusal,
  QE_ACCEPTANCE_REQUIRED_CODE,
  receiptOf,
  qeAcceptanceNotRequired,
  qeDecisionBypasses,
  qeDecisionOf,
  qeAcceptanceSkippedAtGate,
  unreadableQeAcceptance,
} from './delivery-assurance.js';
import { ProjectSettingsStore } from '../projects/settings.js';
import type { WatchRegistry } from '../watch/registry.js';
import { isHumanOperator } from './watch-routes.js';
import type { DeliverReportFact } from '../core/deliver-text.js';
import { boundOrigin, InteractiveBridgePool } from '../interactive/bridge-pool.js';
import { defaultInteractiveRoot } from '../interactive/bridge-root.js';
import {
  composeDeliverText,
  configuredPublicOrigin,
  extractFollowUps,
  factsFromRun,
  reportsFromOutputs,
  FOLLOW_UPS_MAX,
  framedDeliverText,
  runUrlFor,
} from '../core/deliver-text.js';
import {
  deliverIdentityFor,
  deliverRepoFor,
  deliverTargetView,
  isGitHubLogin,
  pushIdentityOf,
  readDeliverOriginUrl,
  resolvePullRequest as resolvePullRequestViaGh,
  unverifiedTreesFrom,
  type PullRequestResolution,
} from '../core/deliver.js';
import { credentialsMissingIn, deliverCredentialsProbe, missingCredentials } from '../core/deliver-credentials.js';
import { codebaseArchiveUrl, type CodebaseArchive, type CodebaseArchiveStore } from './codebase-archive.js';
import type { DocGroundingStore } from '../interactive/doc-grounding.js';
import { registerInteractiveProxy } from '../interactive/proxy-routes.js';
import { registerInteractiveDocDelete } from '../interactive/doc-delete-routes.js';
import { registerInteractiveDocChecks } from '../interactive/doc-checks-routes.js';
import { crewStateHome, stateHomeOfDb } from '../projects/state-home.js';
import { registerInteractiveDocList } from '../interactive/doc-list-routes.js';
import { REVIEWS_DIRNAME } from '../interactive/review-ledger.js';
import type { DocLedgerSweep } from '../interactive/doc-ledger-sweep.js';
import { MembershipIndex } from '../projects/membership-index.js';
import { MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import { resolveLinkedIssues, type LinkedIssue, type LinkedIssuesResult } from '../core/linked-issues.js';
import { AuditLog } from './audit.js';
import {
  AcpFoldCache,
  EngineVersionCache,
  eventsDirOf,
  installedPackageVersion,
  hostSandboxLauncher,
  seatRosterFile,
  listStoreFiles,
  readStudioBundleVersion,
  type ErrorRing,
} from './diagnostics.js';
import { GovernanceDiagnostics } from './governance-health.js';
import { ATTACHMENT_LIMITS, ATTACHMENT_MAX_MESSAGE_BYTES, AttachmentError, ChatAttachmentStore, attachmentWire, attachmentsBlock, boundaryOf, parseMultipart, stageForSeat } from './chat-attachments.js';
import { CHAT_HISTORY_MAX_LIMIT, ChatHistoryStore, decodeCursor } from './chat-history.js';
import {
  PROBE_TIMEOUT_MS,
  SYSTEM_BUDGET_MS,
  SYSTEM_STATS_DAYS,
  SYSTEM_STATS_TTL_MS,
  WeekFoldCache,
  assembleSnapshot,
  buildNeeds,
  buildClis,
  buildGovernance,
  diskRow,
  estateReadonlyCall,
  infraRow,
  judgeGaps,
  livenessThresholds,
  loadRow,
  probeBroker,
  probeBus,
  probeEstate,
  probeGateway,
  probeInteractive,
  probeVault,
  readBridgeLockAsync,
  readWeek,
  resolveContainerRuntime,
  runLiveness,
  settleWithin,
  skillsRow,
  sortRuns,
  stateHomeRow,
  unfinished,
  type ExecLike as SystemExecLike,
  type GovernanceInput,
  type OpenGateLike,
  type RosterSeatLike,
  type RunEvidence,
} from './system-snapshot.js';
import { RunCostCache } from './needs.js';
import { governanceStoreFix, legacyHomeOutboxPath } from '../core/governance-store.js';
import { UsageError, replayOutboxInto } from '../cli/governance.js';
import { foldDeadletters } from './governance-health.js';
import { RetryIndex } from './retry-index.js';
import { SEAT_RECORD_DEFAULT_DAYS, SEAT_RECORD_MAX_DAYS, seatRecord } from './seat-record.js';
import { jobTitle } from './job-title.js';
import { DeliveryFreeze, frozenRefusal, isDeliverUnit, registerDeliveryFreezeRoutes } from './delivery-freeze.js';
import { GroupIndex } from './group-index.js';
import { RunTimingIndex, recordRunLaunched } from './run-timing-index.js';
import { GuidanceIndex } from './guidance-index.js';
import {
  DELIVER_REQUESTED_ACTION,
  DeliveryIndex,
  gitRunBranchIsEmpty,
  gitWorktreeIsClean,
  isDeliverConflictStranded,
  deliveryRecordFrom,
  deliverUnitOf,
  pushedState,
  canDeliverResolver,
  FREE_TEXT_NOTICE,
  freeTextOutcome,
  type DeliveryState,
  type VacuityProbes,
  type DeliveryResolver,
} from './delivery-index.js';
import { DeliveryDerivationCache } from './delivery-cache.js';
import {
  gitReprovisionWorktree,
  runDeliverScript,
  type DeliverExec,
  type DeliverScriptResult,
  type WorktreeReprovisioner,
} from './post-hoc-deliver.js';
import { LOCAL_ACTOR, type AuthMode, trustAtLeast } from './auth.js';
// Re-exported so existing `import { API_PREFIX } from './routes.js'` callers keep working; the
// value lives in the leaf module api-prefix.ts to keep unit-output.ts out of this file's cycle.
export { API_PREFIX } from './api-prefix.js';

import { API_PREFIX } from './api-prefix.js';
import { landPolicyRule, policyProposalToRule, withdrawLandedRule } from './policy-landing.js';
import { DecisionLedger } from '../decisions/ledger.js';
import { DecisionError, DecisionService } from '../decisions/land.js';
import { ingestDecision } from '../decisions/ingest.js';
import { registerDecisionRoutes } from '../decisions/routes.js';
import { ChatDecisionRecorder } from '../decisions/chat-recorder.js';
import { ConsiderationService } from '../decisions/consider.js';
import { gardenConformance, gardenPackCheck, type ConformanceRunner, type PackCheckRunner } from '../editors/pack-install.js';
import { conformanceProvisioner, conformanceRuntimeRoot } from '../editors/conformance-runtime.js';
import { EditorRegistry } from '../editors/registry.js';
import { registerEditorRoutes } from '../editors/routes.js';
import { registerMcpInspectRoutes } from '../mcp-inspect/routes.js';
import { discoverLivePlugin } from '../skills/plugin-source.js';
import type { DecisionBusEmit } from '../decisions/events.js';
import { resolveDecisionsMode, type DecisionsMode } from '../decisions/types.js';

const V = API_PREFIX;

/** How long `GET /health` waits on the engine's actor before answering `ping: "busy"` (crew#471). */
export const HEALTH_PING_WAIT_MS = 1_000;
/** `HealthResponse.ping` while the engine's actor is occupied: the daemon serves, the engine is busy. */
export const ENGINE_BUSY_PING = 'busy';

// Daemon version reported by /health — read from package.json so it never drifts
// from the shipped version across releases. Resolves the package root from the
// compiled module location (dist/api/routes.js → ../../package.json) and works the
// same under the src layout (src/api/routes.ts → ../../package.json).
const PKG_VERSION = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }
).version;

// Actionable-first ordering for the run list (DES-STUDIO-001 §11.6): a run
// awaiting a human sorts to the top; terminal runs sink.
const STATUS_ORDER: Record<SessionStatus, number> = {
  awaiting_human: 0,
  executing: 1,
  distributing: 2,
  planning: 3,
  failed: 4,
  completed: 5,
  cancelled: 6,
};

function sortActionableFirst(views: SessionView[]): SessionView[] {
  return [...views].sort(
    (a, b) => (STATUS_ORDER[a.session.status] ?? 9) - (STATUS_ORDER[b.session.status] ?? 9),
  );
}

/**
 * `codeGraphDb(repo)` for a repo surface, or `null` after answering **503** — a CURRENT engine that
 * resolved no repo-graph root (`code_graph_root_unresolvable`, wicked-core#406) is a daemon-
 * environment fault, not a bad request and not Fastify's generic 500. The mapping is the shared
 * `codeGraphErrorStatus`; anything it does not classify rethrows unchanged (the stale-addon error
 * keeps its pre-existing shape here).
 */
/**
 * What `GET /repos/:id/graph` answers with 200 (F-2R2-005) — the daemon-side shape the drift guard
 * pins both ways against `wicked-crew-api-types` `RepoGraphResponse` (#533 review, F-5). `graph`
 * present = the estate slice; `graph: null` = not built, with `reason` (and the engine's `finding`
 * when it has one) saying why.
 */
export interface RepoGraphReply {
  graph: CodeGraphData | null;
  reason?: string;
  finding?: RepoFinding;
}

// parseEstateTotals lives in projects/graph.ts — shared with chat-scope.ts (crew#642) to avoid
// a circular import (routes.ts → chat-scope.ts). Re-exported here for backward compat
// (tests import it from routes.js; see top-of-file import for local use).
export { parseEstateTotals };

function codeGraphDbOr503(repo: RepoEntry, reply: FastifyReply): string | null {
  try {
    return codeGraphDb(repo);
  } catch (err) {
    const status = codeGraphErrorStatus(err);
    if (status === null) throw err;
    void reply.code(status).send({ error: message(err) });
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turns a failed parse into a 400 body, naming any field the schema does not know.
 *
 * Every schema here is `.strict()`, because zod's default is to STRIP unknown keys — which made a
 * misspelled optional field a silent behaviour change (FINDING-031). `POST /runs {"clis":[...],
 * "workflowId":"feature"}` — core's field names, not the HTTP layer's — answered `201` and ran the
 * full roster with no workflow. Rejecting is only half the fix: a bare "Invalid request body" leaves
 * the caller comparing their JSON against the source, so the unknown keys are named in `error`
 * itself, where a human and a `curl | jq .error` both see it without reading `details`.
 */
export function invalidBody(err: z.ZodError, what: string): { error: string; details: z.ZodIssue[] } {
  const unknown = err.issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
  const error =
    unknown.length > 0
      ? `${what}: unknown field${unknown.length > 1 ? 's' : ''} ${unknown
          .map((k) => `\`${k}\``)
          .join(', ')} — this endpoint does not accept ${
          unknown.length > 1 ? 'them' : 'it'
        }, and ignoring ${unknown.length > 1 ? 'them' : 'it'} would run a different request than you sent`
      : namedIssues(what, err.issues);
  return { error, details: err.issues };
}

/**
 * crew#662: a schema rejection that is NOT an unknown key names the field and what was expected —
 * `Invalid request body: \`revisesPr\` — Expected number, received boolean`. The bare
 * "Invalid request body" sent a caller off to misdiagnose the contract. Up to three issues are
 * spelled out; the rest are counted (all of them stay in `details`).
 */
function namedIssues(what: string, issues: readonly z.ZodIssue[]): string {
  if (issues.length === 0) return what;
  const shown = issues.slice(0, 3).map((i) => (i.path.length > 0 ? `\`${i.path.join('.')}\` — ${i.message}` : i.message));
  const more = issues.length > 3 ? `; and ${issues.length - 3} more (see details)` : '';
  return `${what}: ${shown.join('; ')}${more}`;
}

/** First value of a possibly-repeated query param, WITHOUT trimming — `''` is PRESERVED because a
 *  blank `scope`/`scope_prefix` is meaningful to estate (root / whole-subtree), unlike an omitted
 *  one. Returns undefined only when the param is absent. */
function firstQueryValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse an optional `since`/`until` date-bound query param (unix SECONDS). Returns the parsed
 * non-negative integer, `undefined` when the param is absent or blank, or the sentinel `'invalid'`
 * when it is present but not a non-negative integer — the caller turns `'invalid'` into a 400 that
 * names the offending param (a silently-dropped bad bound would answer a different date question
 * than the one asked).
 */
function parseUnixSecondsParam(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 'invalid';
  return n;
}

/**
 * Inclusive `[since, until]` date-range predicate (unix seconds) shared by the memory + rules
 * browse filters. An item with NO `created_at` is EXCLUDED whenever either bound is set — an
 * unknown creation time is never asserted in range, and never fabricated (crew never invents a
 * timestamp for a row the store did not stamp). With NEITHER bound set every item passes, so the
 * un-filtered browse is unchanged.
 */
function withinDateRange(
  createdAt: number | undefined,
  since: number | undefined,
  until: number | undefined,
): boolean {
  if (since === undefined && until === undefined) return true;
  if (typeof createdAt !== 'number') return false;
  if (since !== undefined && createdAt < since) return false;
  if (until !== undefined && createdAt > until) return false;
  return true;
}

/** One `proposal.list` row as the approve route reads it (the wire is untyped JSON from estate). */
type ProposalRow = {
  id: string;
  kind_type?: unknown;
  payload?: unknown;
  facets?: unknown;
  provenance?: Record<string, unknown>;
};

/** A JSON object whose every value is a string (a facet/intent tuple, axis→value). */
function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
  );
}

// `policyProposalToRule` lives beside THE landing (policy-landing.ts); re-exported for its callers.
export { policyProposalToRule } from './policy-landing.js';

/** A JSON object whose every value is a number (a coverage breakdown map). */
function isNumberRecord(v: unknown): v is Record<string, number> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'number')
  );
}

/**
 * Shape one estate `memory.list` item (`{ memory_id, scope, content, tier, facets, created_at }`)
 * into the wire {@link MemoryItem}. `memory.list` (the management browse) surfaces per-item
 * `facets` — the reason the surface can filter by facet at all; `score` is absent (list is not
 * relevance-ranked) and simply omitted. String fields missing on the wire degrade to `''` rather
 * than throwing on one item. (The same shape parses a `memory.recall` item unchanged — recall
 * carries no facets, so `facets` degrades to `{}`.)
 */
function shapeMemoryItem(raw: unknown): MemoryItem {
  const r: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const item: MemoryItem = {
    id: str(r['memory_id']),
    content: str(r['content']),
    tier: str(r['tier']),
    scope: str(r['scope']),
    facets: isStringRecord(r['facets']) ? r['facets'] : {},
  };
  if (typeof r['score'] === 'number') item.score = r['score'];
  // `created_at` (unix seconds) rides through from estate `memory.list` verbatim — the "added" time
  // the surface date-filters on. Absent on an item the store did not stamp; never fabricated.
  if (typeof r['created_at'] === 'number') item.created_at = r['created_at'];
  return item;
}

/** Shape the estate `memory.coverage` result (`{ total, by_tier, by_kind }`) into the wire
 *  {@link MemoryCoverageResponse}. A shape estate never produces is an UPSTREAM fault — thrown as an
 *  {@link EstateMcpError} (→ 502), never silently coerced to zeroes. */
function shapeMemoryCoverage(raw: unknown): MemoryCoverageResponse {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  if (r === undefined || typeof r['total'] !== 'number' || !isNumberRecord(r['by_tier']) || !isNumberRecord(r['by_kind'])) {
    throw new EstateMcpError('memory.coverage returned an unexpected shape');
  }
  return { total: r['total'], by_tier: r['by_tier'], by_kind: r['by_kind'] };
}

// Closed facet vocabularies for the `GET /governance/rules` browse filters (wiki-mgmt) — the
// wire contract's `RuleBrowseQuery`. Sets, not zod: the query is otherwise free-form and only
// these three facets have a vocabulary to enforce.
const RULE_SEVERITIES: ReadonlySet<string> = new Set(['info', 'warn', 'error', 'critical']);
const RULE_TYPES: ReadonlySet<string> = new Set(['pattern', 'policy']);
const RULE_STATUSES: ReadonlySet<string> = new Set(['active', 'retired', 'all']);

// Repo names become directory components under ~/.wicked/repos/ — reject anything
// that would allow path traversal (slashes, dots-only segments, control chars).
const SAFE_REPO_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const RegisterRepoSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(SAFE_REPO_NAME, 'Repository name must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores'),
    // For local registration: path to an existing git repo on disk.
    // For remote clone: optional clone destination (absolute path); if omitted,
    // defaults to ~/.wicked/repos/<name>.
    rootPath: z.string().optional(),
    gitUrl: z.string().optional(),
    /** crew#496: the project the register form had selected — the onboarding run is filed there
     *  (membership `crew.run`), not left unfiled while the repo joins the project. */
    projectId: z.string().min(1).max(128).optional(),
    /** crew#496 / crew#632: the launch surface and caller, recorded on the run's launch entry. */
    channel: z.enum(['studio', 'cli', 'api']).optional(),
    actor: z.string().min(1).max(256).optional(),
    /** crew#552: `false` = this onboarding chains no capture-learnings run (a one-off). */
    autoCapture: z.boolean().optional(),
  })
  .strict()
  .refine(
    (d) => {
      const hasRemote = typeof d.gitUrl === 'string' && d.gitUrl.length > 0;
      const hasLocal = typeof d.rootPath === 'string' && d.rootPath.length > 0;
      // gitUrl alone (clone to default path), gitUrl + rootPath (clone to custom path),
      // or rootPath alone (register existing local repo) — all valid.
      return hasRemote || hasLocal;
    },
    { message: 'Provide gitUrl (remote clone) or rootPath (local registration), or both.' },
  );

/** `POST /repos/:id/onboard`'s optional body (crew#496): where to file the run, and who asked. */
const OnboardBodySchema = z
  .object({
    projectId: z.string().min(1).max(128).optional(),
    channel: z.enum(['studio', 'cli', 'api']).optional(),
    actor: z.string().min(1).max(256).optional(),
    /** crew#552: `false` = this onboarding chains no capture-learnings run (a one-off). */
    autoCapture: z.boolean().optional(),
  })
  .strict();

/**
 * The launch body. Every field but `problem` is optional, which is what made stripping dangerous:
 * omitting one is a legitimate request that gets an engine default, so a MISSPELLED one was
 * indistinguishable from an omitted one and the run went ahead on a configuration the caller never
 * asked for (FINDING-031).
 *
 * The names differ from core's on purpose and this is the trap worth knowing about: core's
 * `LaunchSpec` takes `clis` (an array) and `workflow`, this takes `clisJson` (a JSON *string*) and
 * `workflow`, and the `/ws` `sessionStarted` frame reports the chosen workflow as `workflowId`. A
 * caller who reads the event stream to learn the field names arrives at `workflowId`, which this
 * schema does not accept — so `.strict()` is what turns that trip into a 400 instead of an
 * unworkflowed run reported as `201`.
 */
// The request-body schemas below are exported so `tests/wire-contract.test.ts` can prove, at
// compile time, that every body the published contract (`wicked-crew-api-types`) lets a client
// send is a body these schemas accept — the request-direction half of the drift guard (task #84).
export { PlanSchema };

/** crew#825: the issue refs a launch leaves out of the linked-issue expansion. */
const ExcludeLinkedIssuesSchema = z
  .array(z.string().regex(/^\s*(?:\d+|(?:(?:[\w.-]+\/)?[\w.-]+)?#\d+)\s*$/, 'an issue ref: 541, #541, repo#541 or owner/repo#541'))
  .max(50)
  .optional();

/**
 * The default launch roster ({@link defaultLaunchRoster}: no opt-in seats) — plus the opt-in seat a
 * launch NAMES as its lead (`primary`): naming it is the opt-in.
 */
export function launchRosterNaming<T extends { key?: unknown }>(roster: readonly T[], primary: string | undefined): T[] {
  const base = defaultLaunchRoster(roster);
  if (primary === undefined || base.some((s) => s.key === primary)) return base;
  const named = roster.find((s) => s.key === primary);
  return named === undefined ? base : [...base, named];
}

/**
 * Why `primary` cannot lead a launch on `clisJson`'s roster, or `null` when it can (DES-TEAMING-002
 * §8.1). The roster is a JSON array of seats keyed by `key`. Leading is WORK (wicked-core#572: the
 * lead pick follows `seat_eligible_for_work`, not the ballot flag — crew#916), so a seat crew's
 * standing marks `work_eligible: false` (signed out, benched, or reviewer-only) cannot lead, nor can a
 * seat the launch would bench (its translated engine `health`). A roster that does not parse is
 * left to the engine's own parse error (the `engineRosterJson` rule).
 */
export function primaryRefusal(primary: string, clisJson: string): string | null {
  let roster: unknown;
  try {
    roster = JSON.parse(clisJson);
  } catch {
    return null;
  }
  if (!Array.isArray(roster)) return null;
  const seats = roster.filter((s): s is { key: string; work_eligible?: unknown; work_ineligible_reason?: unknown } =>
    typeof s === 'object' && s !== null && typeof (s as { key?: unknown }).key === 'string');
  const keys = seats.map((s) => s.key);
  const seat = seats.find((s) => s.key === primary);
  if (seat === undefined) {
    return `primary names a seat that is not in this launch's roster: ${primary} (roster: ${keys.join(', ') || 'none'})`;
  }
  if (seat.work_eligible === false) {
    const why = typeof seat.work_ineligible_reason === 'string' && seat.work_ineligible_reason !== '' ? ` (${seat.work_ineligible_reason})` : '';
    return `primary names a seat that cannot take work: ${primary}${why} — pick another seat`;
  }
  // The engine takes an explicit lead without a health check, so a seat the launch benches (the
  // translated `health.usable: false` — a reading from a client before `work_eligible` included)
  // cannot lead either.
  const health = (toEngineSeat(seat) as { health?: { usable?: unknown; reason?: unknown } }).health;
  if (health?.usable === false) {
    const why = typeof health.reason === 'string' && health.reason !== '' ? ` (${health.reason})` : '';
    return `primary names a seat that cannot take work: ${primary}${why} — pick another seat`;
  }
  return null;
}

export const LaunchSchema = z.object({
  problem: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  clisJson: z.string().min(1).optional(),
  /** (api-types 0.128.0; DES-TEAMING-002 §8.1) The seat that leads the run (the PA): a key in the
   *  launch roster. Omitted ⇒ the engine picks at random (`path.started.selection`). */
  primary: z.string().min(1).optional(),
  entityMode: z.enum(['shared', 'isolated']).optional(),
  humanConfirm: z.string().min(1).optional(),
  repoRef: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  /** DES-TEAMING-002 T3 — a user-composed plan (`LaunchRunBody.plan`), forwarded to the engine,
   *  which publishes `plan.proposed{by:"human"}` and holds it at a `plan_approval` gate when the
   *  approval matrix says so. Mutually exclusive with `workflow` (refine below). */
  plan: PlanSchema.optional(),
  /** DES-PROJECT-001 §2.2 — file the run into a project; membership attaches atomically with
   *  the launch record. Unknown/archived ⇒ the launch fails (never a silent unfiled run). */
  projectId: z.string().min(1).optional(),
  /** crew#293 — `"pr"` appends the hardened deliver Tool phase (push run branch + `gh pr create`)
   *  to a PER-RUN copy of the selected workflow; requires `workflow` (enforced by the refine
   *  below, so the 400 happens at parse time, not after the adapter is consulted). crew#393 —
   *  `"none"` explicitly declines delivery (legal with or without a workflow); OMITTED means the
   *  daemon decides: repo-scoped + a CODE-WORK workflow (a def with an `executes_code` phase)
   *  defaults to `"pr"` (flippable via the `deliverDefault` setting), everything else to
   *  `"none"` — see the resolution below. */
  deliver: z.enum(['pr', 'none']).optional(),
  /** F-E2E-030 — who confirms the deliver phase. `'human'` (the default when omitted): the engine
   *  pauses before the composed `deliver` Tool unit pushes and opens the PR, whatever
   *  `humanConfirm` says. `'auto'`: the caller's EXPLICIT opt-out — the push and PR follow verify
   *  unattended, under the daemon's active gh account; a UI sending it must name the posture
   *  "auto-deliver" to its operator. Additive; an older daemon's schema rejects it with a 400. */
  deliverGate: z.enum(['human', 'auto']).optional(),
  /** DES-UX-001 §8.3 (CREW-UX-3) — the run this launch retries. Must name an EXISTING run id
   *  (the route checks the store and 400s with a named error otherwise); persisted via the
   *  `run.launched` audit entry + retry index and echoed as `AgentSession.retry_of`. */
  retryOf: z.string().min(1).optional(),
  /** wicked-studio#27 (api-types 0.19.0) — attach this AD-HOC run to an EXISTING campaign's
   *  surface. Validated against the campaign store before anything launches (unknown ⇒ 404,
   *  engine without campaign bindings ⇒ 501 — never a silently dropped attach); persisted via
   *  the `run.launched` audit entry + group index, echoed as `AgentSession.campaign_id`, and
   *  served under `Campaign.attached_runs`. Provenance only: the run is NOT a DAG node. */
  campaignId: z.string().min(1).optional(),
  /** wicked-studio#27 (api-types 0.19.0) — ad-hoc label group, created on first use: runs
   *  sharing a label form one `RunGroup` on `GET /campaigns`. Persisted/echoed like
   *  `campaignId` (as `AgentSession.group_label`). */
  groupLabel: z.string().min(1).max(200).optional(),
  /** DES-L9 / crew#550 (api-types 0.38.0) — REVISE an OPEN same-repository pull request: its head
   *  branch becomes the run's base and the deliver phase pushes the run's commits onto it (no
   *  second PR), commenting the run record. Needs `repoRef` + `workflow` and `deliver: "pr"`
   *  (explicit `"none"` is a 400; a daemon that resolves the omitted field to `none` is a 409).
   *  Resolved via `gh pr view` at launch — not OPEN / a fork / gh failure ⇒ 409, nothing launched.
   *  Send it only when `GET /health.capabilities.revisesPr === true` (engine ≥ 0.7.27). */
  revisesPr: z.number().int().positive().optional(),
  /** crew#619 — the chat this run was promoted from; the daemon retains that chat's transcript
   *  on disk until this run reaches a terminal state so the Continue-in-Build prefill is
   *  always reproducible. Optional; omit when the launch is not promoted from a chat. */
  chatId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  /** crew#632 — the surface that triggered this launch: `studio` (the web UI), `cli` (the
   *  wicked-crew CLI), or `api` (a programmatic caller). Persisted on the `run.launched` audit
   *  entry (`detail.channel`) and served on the run DTO; absent = origin unknown. */
  channel: z.enum(['studio', 'cli', 'api']).optional(),
  /** crew#632 — an opaque caller-supplied identifier for the user or system that triggered the
   *  launch (e.g. a CI job name or a studio tab id). Persisted on the `run.launched` audit entry
   *  (`detail.actor`) and served on the run DTO; absent = caller omitted it. */
  actor: z.string().min(1).max(256).optional(),
  /** crew#825 (api-types additive) — issue refs the intent names that the daemon must NOT read and
   *  append (`541`, `#541`, `repo#541`, `owner/repo#541`): a reference in passing is not a request to inline
   *  the issue. They are answered as `linkedIssues[].excluded`. Send only when
   *  `GET /health.capabilities.linkedIssuesExclude === true`. */
  excludeLinkedIssues: ExcludeLinkedIssuesSchema,
  /** wicked-core#850 (api-types 0.102.0) — the EXPLICIT reduced-assurance opt-in: the creator's seat
   *  may evaluate and a judge-less gate may pass, disclosed on every receipt. `false` is an explicit
   *  "full assurance", the same as omitting it: the launcher never chooses for the caller, and a
   *  full-assurance launch on a one-CLI roster is answered with `assuranceNotice` (`core/assurance.ts`). */
  reducedAssurance: z.boolean().optional(),
  /** QE-IN-APP-WORKFLOWS (api-types 0.106.0) — the operator's EXPLICIT skip of a required QE
   *  acceptance, with a reason (labelled on the run, every gate and the delivery), or its explicit
   *  force (no score waiver). Forwarded only when sent; crew never decides either for the caller,
   *  and the engine refuses either on a run whose workflow does not require QE acceptance. */
  skipQeAcceptance: z.object({ reason: z.string().trim().min(1).max(2000) }).strict().optional(),
  forceQeAcceptance: z.boolean().optional(),
}).strict().refine((b) => b.skipQeAcceptance === undefined || b.forceQeAcceptance !== true, {
  message: 'skipQeAcceptance and forceQeAcceptance are mutually exclusive — skip it with a reason, or force it',
  path: ['forceQeAcceptance'],
}).refine((b) => b.plan === undefined || b.workflow === undefined, {
  message: 'plan and workflow are mutually exclusive — a launch carries a plan or names a preset, not both',
  path: ['plan'],
}).refine((b) => b.plan !== undefined || b.deliver !== 'pr' || b.workflow !== undefined, {
  message: 'deliver: "pr" requires a workflow — a free-text run has no def to append the deliver phase to',
  path: ['deliver'],
}).refine((b) => b.deliverGate === undefined || b.deliver !== 'none', {
  // F-E2E-030: a deliver-gate posture on a launch that declines delivery is a contradiction the
  // caller should hear about, not a silent no-op. (A launch that OMITS `deliver` may still
  // resolve to no deliver unit — repo-less, free-text, read-only def; the field is then inert.)
  message: 'deliverGate has no meaning with deliver: "none" — there is no deliver phase to gate',
  path: ['deliverGate'],
}).refine((b) => b.campaignId === undefined || b.groupLabel === undefined, {
  message:
    'campaignId and groupLabel are mutually exclusive — a run files onto ONE grouping surface (an existing campaign, or a label group)',
  path: ['groupLabel'],
}).refine((b) => b.revisesPr === undefined || (b.repoRef !== undefined && b.workflow !== undefined), {
  message: 'revisesPr needs repoRef and workflow — a revision bases a repo-scoped, def-driven run on the pull request\'s branch',
  path: ['revisesPr'],
}).refine((b) => b.revisesPr === undefined || b.deliver !== 'none', {
  message: 'revisesPr needs deliver: "pr" — a launch that declines delivery has no phase to push the revision with',
  path: ['revisesPr'],
});

/** The escalation arms (wicked-core#469 / #467): approve-shaped, no `amend` / `amendScope`.
 *  `extend` | `targeted` | `accept_partial` answer the gate of a repo-checks floor that did not
 *  finish (`repo_checks_timeout`) — the engine re-runs the floor on the tree as it stands with 2×
 *  bounds, the targeted test set, or the unfinished checks waived; `accept_suggestion` adopts the
 *  evaluator's discarded, pinned edit as the creator's amendment; `rejudge` (api-types 0.134.0)
 *  re-runs the judge of a `judge_unavailable` gate on the same work, the step's seat not run again.
 *  The ENGINE refuses each at any other gate (a 409 naming the gate it answers) — and `rejudge`
 *  while no judge seat is eligible ({@link GateInfo.rejudge} says beforehand). */
export const ESCALATION_ACTIONS = ['extend', 'targeted', 'accept_partial', 'accept_suggestion', 'rejudge'] as const;
/** (core#820) A consent gate's answer token: `consent:<choice id>` approves that row of the dry-run
 *  plan (the engine refuses an id its plan does not offer); `reject` stays the decline. */
export const CONSENT_CHOICE_ACTION = /^consent:[A-Za-z0-9_-]{1,32}$/u; // core `parse_plan` caps a choice id at 32
const isEscalationAction = (a: string | undefined): boolean =>
  a !== undefined && ((ESCALATION_ACTIONS as readonly string[]).includes(a) || CONSENT_CHOICE_ACTION.test(a));

/** `POST /runs/:id/gate` (api-types 0.38.0 `GateDecision`; DES-L1 PR-2). Additive arms: `action`
 *  names the arm (`approve` | `request_changes` | `reject`; absent = today's two-arm mapping of
 *  `approve`), `amendScope` says where an approve's `amend` lands (`cursor` = the gated unit, today's
 *  behaviour | `creator` = the first creator phase at/after the cursor — an intake steer reaches the
 *  phase that implements). `request_changes` sends a NOT-PASS review back to the creator with the
 *  findings in context (`amend` = the operator's note). A disagreement between `action` and
 *  `approve` is a 400 that names both. The escalation arms ({@link ESCALATION_ACTIONS}) require
 *  `approve: true` and take no `amend` / `amendScope` / `plan`.
 *
 *  `amend_intent` (wicked-core#555) approves the gate AND AMENDS THE RUN'S INTENT: `amend` is
 *  what the acceptance list now says (required, non-empty), `approve: true`, and no `amendScope`
 *  — an intent amendment reaches every unit at or after the cursor, which is what makes it reach
 *  the LATER EVALUATOR. It is the only arm that can descope a run mid-flight.
 *
 *  `operator_judgment` (api-types 0.135.0, operator ruling 2026-10-21) is "approve as your own
 *  judgment" at a FAILED REPO-CHECKS FLOOR's escalation gate: `approve: true`, the written rationale
 *  in `amend` (required, non-empty), no `amendScope` or `plan`. The engine records it on the gate
 *  receipt as an operator judgment overriding the floor ("floor overridden by operator", on the
 *  run and the delivery too) and refuses it (409, gate left open) at any other gate and while any
 *  other layer of the gate also denied. QE acceptance is never waived by it. */
export const OPERATOR_JUDGMENT_ACTION = 'operator_judgment' as const;
/** (j4-gates, api-types 0.139.0) SKIP QE ACCEPTANCE at a gate — the launch's `skipQeAcceptance`,
 *  given later: `approve: true`, the written reason in `amend` (required, non-empty), no
 *  `amendScope` or `plan`. The engine (wicked-core `HumanDecision::SkipQe`) records the run's QE
 *  decision as `skipped` by the operator ("QE acceptance skipped by operator: <reason>"), labelled on
 *  the run, every later gate and the delivery, and answers: the gate before the deliver step (this
 *  route lets the delivery go without a QE PASS, saying so), the escalation gate of a unit only QE
 *  denied (it counts), or a failed floor's gate with QE behind it (it re-opens on the floor alone).
 *  Refused (409, gate left open) everywhere else and on a run that does not require QE. */
export const SKIP_QE_ACTION = 'skip_qe' as const;
/** (studio#923) The label an operator's QE skip carries on the run, every later gate and the
 *  delivery — the engine's words ("QE acceptance skipped by operator: <reason>"). */
export const QE_SKIPPED_BY_OPERATOR_LABEL = 'QE acceptance skipped by operator' as const;

export const GateSchema = z.object({
  approve: z.boolean(),
  amend: z.string().optional(),
  action: z
    .union([
      z.enum(['approve', 'request_changes', 'reject', 'edit_plan', 'amend_intent', OPERATOR_JUDGMENT_ACTION, SKIP_QE_ACTION, ...ESCALATION_ACTIONS]),
      z.string().regex(CONSENT_CHOICE_ACTION, 'a consent choice is `consent:<choice id>`'),
    ])
    .optional(),
  amendScope: z.enum(['cursor', 'creator']).optional(),
  /** DES-TEAMING-002 T3 — approve a `plan_approval` gate WITH AN EDIT (`GateDecision.plan`). */
  plan: PlanSchema.optional(),
  /** api-types 0.44.0 — the gate this decision answers (its unit `ord`). A mismatch with the run's
   *  open gate is a 409 `gate_changed`: the decision was made on a gate that is no longer open. */
  ord: z.number().int().nonnegative().optional(),
}).strict().refine(
  (b) => b.action === undefined
    || (b.action === 'approve' || b.action === 'edit_plan' || b.action === 'amend_intent' || b.action === OPERATOR_JUDGMENT_ACTION || b.action === SKIP_QE_ACTION || isEscalationAction(b.action)) === b.approve,
  { message: '`action` disagrees with `approve`: request_changes and reject require approve: false; approve, edit_plan, amend_intent, operator_judgment, skip_qe, extend, targeted, accept_partial, accept_suggestion, rejudge and consent:<id> require approve: true', path: ['action'] },
).refine(
  // (operator ruling 2026-10-21) The override's rationale IS its record: a blank one is a 400 here,
  // before the engine is asked.
  (b) => b.action !== OPERATOR_JUDGMENT_ACTION || (b.amend !== undefined && b.amend.trim() !== ''),
  { message: 'operator_judgment needs `amend`: your written rationale — why the failed floor is not the work\'s (an empty one is refused)', path: ['amend'] },
).refine(
  (b) => b.action !== OPERATOR_JUDGMENT_ACTION || (b.amendScope === undefined && b.plan === undefined),
  { message: 'operator_judgment takes no amendScope or plan — it answers the failed floor of the gated unit', path: ['amendScope'] },
).refine(
  // (j4-gates) A QE skip's reason IS its record, as at launch: a blank one is a 400 here.
  (b) => b.action !== SKIP_QE_ACTION || (b.amend !== undefined && b.amend.trim() !== ''),
  { message: 'skip_qe needs `amend`: your written reason for skipping QE acceptance (an empty one is refused)', path: ['amend'] },
).refine(
  (b) => b.action !== SKIP_QE_ACTION || (b.amendScope === undefined && b.plan === undefined),
  { message: 'skip_qe takes no amendScope or plan — it answers the run\'s QE acceptance', path: ['amendScope'] },
).refine(
  // (wicked-core#555) An intent amendment IS its text: an empty one amends nothing, and the arm's
  // scope is every unit at or after the cursor — which is what makes it reach the evaluator — so
  // `amendScope` cannot narrow it. Both are 400s here rather than a 409 from the engine.
  (b) => b.action !== 'amend_intent' || (b.amend !== undefined && b.amend.trim() !== ''),
  { message: 'amend_intent needs `amend`: what the run\'s acceptance list now says (approve without an action to proceed unamended)', path: ['amend'] },
).refine(
  (b) => b.action !== 'amend_intent' || (b.amendScope === undefined && b.plan === undefined),
  { message: 'amend_intent takes no amendScope or plan — an intent amendment reaches every unit at or after the cursor, which is what makes it reach the evaluator', path: ['amendScope'] },
).refine(
  (b) => !isEscalationAction(b.action) || (b.amend === undefined && b.amendScope === undefined && b.plan === undefined),
  { message: 'extend, targeted, accept_partial, accept_suggestion, rejudge and consent:<id> take no amend, amendScope or plan — the engine re-runs the floor, adopts the pinned edit, re-runs the judge, or runs the chosen install as it stands', path: ['action'] },
).refine(
  (b) => (b.action === 'edit_plan') === (b.plan !== undefined) || (b.action === undefined && b.plan !== undefined),
  { message: 'an edited plan answers a plan_approval gate: `plan` needs approve: true with `action` omitted or edit_plan, and edit_plan needs `plan`', path: ['plan'] },
).refine(
  (b) => b.plan === undefined || (b.approve && b.amend === undefined && b.amendScope === undefined),
  { message: '`plan` is an approve WITH an edited plan: approve: true, and no amend / amendScope (the plan is the edit)', path: ['plan'] },
).refine(
  (b) => b.amendScope === undefined || b.approve,
  { message: '`amendScope` applies to an approve only (approve: true)', path: ['amendScope'] },
);

/** `PUT /runs/:id/guidance` (DES-UX-002 §7.2, CREW-UX-7) — the durable pre-gate note body.
 *  The empty string is a legal body: it CLEARS the note. The byte cap is checked in the route
 *  (not zod's char-counting `max`) so the 400 names the actual limit. */
export const GuidanceSchema = z.object({
  text: z.string(),
}).strict();
/** ~8KB — a guidance note is operator prose, not a document store. */
const GUIDANCE_MAX_BYTES = 8192;

const InjectSchema = z.object({
  message: z.string().min(1),
  /** `"all"` broadcasts to every active worker; any other value is a CLI key. */
  target: z.string().min(1).default('all'),
}).strict();

// The manual reassign lever (crew#442): `cli` omitted lets the engine's council re-pick, the
// same shape the automatic stall-watchdog escalation uses for an unknown failover target.
const ReassignSchema = z.object({
  cli: z.string().min(1).optional(),
}).strict();

export const OpenTerminalSchema = z.object({
  cwd: z.string().min(1),
  cmd: z.array(z.string().min(1)).min(1).optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  // Optional so omission is the SAFE governed default (§7 — `false` is never a
  // default; the ungoverned operator shell must opt in explicitly).
  governed: z.boolean().optional(),
}).strict();

/** `POST /seats/:cli/login|logout` body (crew#615): the PTY size, both optional. */
export const SeatSessionSchema = z.object({
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
}).strict();

const ResizeTerminalSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
}).strict();

/** `POST /open` (crew#273) — the studio Files tab's "open with the OS default app" body. */
export const OpenPathSchema = z.object({
  path: z.string().min(1),
  runId: z.string().min(1).optional(),
}).strict();

/** `POST /memory/retire` body (DES-MEM-FACETED-001). `scope_prefix` is REQUIRED and, after trim,
 *  non-empty (enforced in the route so the 400 names the total-wipe guard): estate `memory.erase`
 *  is subtree-scoped and refuses an empty prefix. `.strict()` for the FINDING-031 posture — an
 *  unknown field is a 400, never silently ignored into a broader erase than the caller sent. */
export const RetireMemorySchema = z.object({
  scope_prefix: z.string(),
}).strict();

/** `POST /memory/retire-item` body (studio#206): ONE memory, by its `memory_id` from `GET /memory`.
 *  `.strict()`: a stray `scope_prefix` is a 400, never read as a wider erase than one row. */
export const RetireMemoryItemSchema = z.object({
  memory_id: z.string().min(1).max(512),
}).strict();

/** `POST /memory/edit` body (wicked-studio's Memory page): ONE memory's new words. `.strict()`: an
 *  unknown field is a 400, never read as something wider than one memory. */
export const EditMemorySchema = z.object({
  memory_id: z.string().min(1).max(512),
  content: z.string().min(1).max(4000),
}).strict();

/** estate `memory.capture`'s `kind` for a tier — the kind natural to it, as estate's own proposal
 *  approve picks (`kind_for_tier`), so an edited memory keeps the kind its tier implies. */
const KIND_FOR_TIER: Record<string, string> = {
  working: 'working', episodic: 'episode', semantic: 'fact', procedural: 'skill', archival: 'archive',
};

/** The id `POST /memory/edit` probes erase-by-id with: no memory carries it, so the erase deletes nothing. */
const MEMORY_EDIT_PROBE_ID = 'crew:erase-by-id-probe';

/** The memory ids with an edit in flight: estate has no compare-and-swap, and two edits of one memory
 *  racing would each write a copy. One daemon, so one edit per memory at a time is enough. */
const memoryEditsInFlight = new Set<string>();

/** The error an estate from before wicked-estate#188 answers to `memory.erase {id}`: it knows only the
 *  subtree erase, so it refuses the call (deleting nothing) for want of a `scope_prefix`. */
const ESTATE_NO_ERASE_BY_ID = /scope_prefix \(non-empty\) required/i;

/**
 * A SKIN-OWNED settings key (crew#323): one lowercase segment under the `studio.` namespace,
 * e.g. `studio.appearance`, `studio.notifications`. The daemon never interprets these values —
 * the settings store is shared with the skin, and the namespace is what makes that legible.
 */
const STUDIO_SETTINGS_KEY = /^studio\.[a-z][a-z0-9-]*$/;

/**
 * Per-key ceiling on a `studio.*` value, as the UTF-8 byte length of its JSON form.
 *
 * 512KB, not "a few KB": `studio.appearance` carries the operator's logo as a data URI, and
 * base64 costs ~33%, so this admits a ~380KB image — a real logo, not a favicon — while a
 * preferences blob like `studio.notifications` spends a few dozen bytes of it. One generous
 * cap covers both because the daemon cannot tell them apart; what it stops is settings.json
 * quietly becoming an asset store. It sits at half of Fastify's 1MiB default body limit, so a
 * realistic multi-key patch (one blob near the cap plus small preference blobs) is still parsed
 * before it is judged — but note the two limits COMPOSE: a body whose keys total more than 1MiB
 * is refused by Fastify with a 413 that this route never sees, so the per-key 400 below is the
 * ceiling on ONE key, not on the patch.
 */
const STUDIO_SETTINGS_MAX_BYTES = 512 * 1024;

/** The actor/audit deps (task #88) — threaded from `createServer`. */
export interface SecurityDeps {
  audit: AuditLog;
  authMode: AuthMode;
}

/**
 * Daemon-runtime deps the routes read but `createServer` owns: the seat-health fold (crew#274,
 * fed by the daemon's single CoreEvent subscription) and the OS opener for `/open` (crew#273,
 * injectable so tests never actually open anything).
 */
/** A remembered watchdog frame as `GET /runs/:id/events` SERVES it — with the `seq` the published
 *  `RecordedEvent` contract requires (api-types 0.38.0). `daemon: true` rides additively until
 *  api-types 0.39.0 declares it; every consumer today reads unknown keys through. */
type ServedStallFrame = RecordedStallFrame & { seq: number };

/**
 * Stamp the required `seq` onto the daemon-authored frames of a ts-sorted merge. A watchdog frame
 * has no engine `seq` — the engine's log never saw it — so each one rides the seq of the engine
 * record it FOLLOWS (0 before the first). The served array is therefore monotonic non-decreasing in
 * `seq`, and a consumer that re-sorts by seq (studio's narrator) keeps every frame beside the event
 * it was captured after, instead of dropping it to the front on a missing key.
 */
function withServedSeq(
  merged: Array<RecordedEvent | RecordedStallFrame>,
): Array<RecordedEvent | ServedStallFrame> {
  let seq = 0;
  return merged.map((e) => {
    if (!('daemon' in e)) {
      if (typeof e.seq === 'number') seq = e.seq;
      return e;
    }
    return { ...e, seq };
  });
}

/** What `registerRoutes` hands back to the server assembly: the ONE gate decision path, for the
 *  daemon-side actors that answer gates (standing orders, behaviour 10). */
export interface RegisteredRoutes {
  decideGate: (
    id: string,
    decision: unknown,
    actor: import('../core/types.js').Actor,
    extraDetail?: Record<string, unknown>,
  ) => Promise<{ code: number; body: unknown }>;
  /** DC-S4a: the decision service (null when capture is not wired) — the boot re-drive uses it. */
  decisions: DecisionService | null;
  /** DC-S4b: the studio chat recorder (null when capture, the transcript store or the fan-out is not wired). */
  chatRecorder: ChatDecisionRecorder | null;
  /** DC-S7: considered · set aside · cited, and the rules the seats were told about. */
  considerations: ConsiderationService;
  /** `GET /search`'s index: the daemon's frame fan-in feeds it (`ingest`). */
  search: SearchService;
  /** A run as `GET /runs` serves it: launch time, delivery and project joined from the daemon's own records
   *  (DES-RUNS-REVIEW-001: the run review folds these, never the engine's bare record). */
  decorateRun: (view: SessionView) => SessionView;
  /** DES-DEFAULT-EVALS-001 §7: prepare a `run-evals` launch (run the evals in-process, write the report copy). */
  runEvalsPrepare: (input: LaunchRunInput) => Promise<void>;
}

export interface RuntimeDeps {
  /** DES-RUNS-REVIEW-001: prepare a `review-recent-work` launch (snapshot, write root, one seat); absent = launched as-is.
   *  Its coverage is the review schedule's projects, wherever it was launched from (the run is still filed under the
   *  caller's project). */
  reviewLaunch?: (input: LaunchRunInput) => Promise<void>;
  /** The engine refused a prepared review launch: the review is recorded as never run. */
  reviewLaunchRefused?: (runId: string, reason: string) => void;
  /** DC-S4a decision capture: the ledger (`<state home>/decisions`), absent = capture off. */
  decisionLedger?: DecisionLedger;
  /** `WICKED_DECISIONS` (off | ledger | on); defaults to `resolveDecisionsMode()`. */
  decisionsMode?: DecisionsMode;
  /** The bus emit for `wicked.crew.decision.*` facts (ids only, never words); absent = no bus. */
  decisionsEmit?: DecisionBusEmit | null;
  /** The watch registry (TR-W5a), for the `watch.*` settings guard; absent or `null` = no registry. */
  watchRegistry?: () => WatchRegistry | null;
  /** Freeze deliveries (studio idea 15) — `createServer` hydrates one from the audit trail so a
   *  restart keeps the freeze; a directly-driven route set gets a fresh (thawed) switch. */
  deliveryFreeze?: DeliveryFreeze;
  /** DES-L9: how `revisesPr` is resolved to a PR head branch (`gh pr view`, 5 s). Injectable so
   *  route tests answer without gh; production uses `core/deliver.ts::resolvePullRequest`. */
  resolvePullRequest?: (repoRoot: string, number: number) => Promise<PullRequestResolution>;
  /** crew#627: how the issues a launch's intent links are read (`gh issue view`, 5 s each).
   *  Injectable so route tests answer without gh; production uses `core/linked-issues.ts`. */
  resolveLinkedIssues?: (
    problem: string,
    repoRoot: string | undefined,
    repoRef: string | undefined,
    exclude?: readonly string[],
  ) => Promise<LinkedIssuesResult>;
  seatHealth?: SeatHealthTracker;
  /** wicked-studio#284: the stall watchdog's remembered frames for a run — merged into
   *  `GET /runs/:id/events` at serve time so a reloaded page sees the `workerStalled` /
   *  `workerStallEscalated` facts the live socket carried. Absent ⇒ engine events only. */
  stallFrames?: (runId: string) => readonly RecordedStallFrame[];
  /** DES-SYSTEM-VIEW: the stall watchdog's newest evidence of life for a run (a relay frame or a
   *  busy child process), read by `GET /system`. Absent ⇒ the durable event log alone. */
  runEvidence?: (runId: string) => { at: number; source: 'relay' | 'process' } | undefined;
  /** DES-SYSTEM-VIEW: the system snapshot's command runner (the gateway inspect, estate stats, the
   *  vault version). Injectable for tests; production uses `execCapped`. */
  systemExec?: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
  /** Run→retry-lineage index (CREW-UX-3) — `createServer` hydrates one from the audit trail so
   *  a restarted daemon still echoes `retry_of`; a directly-driven route set gets a fresh one. */
  retryIndex?: RetryIndex;
  /** Run→ad-hoc-group index (wicked-studio#27) — `createServer` hydrates one from the audit
   *  trail (the SAME `run.launched` scan as `retryIndex`) so attaches survive a restart; a
   *  directly-driven route set gets a fresh one. */
  groupIndex?: GroupIndex;
  /** Run→launch-time index (home command-center run metrics) — `createServer` hydrates one from
   *  the audit trail (the SAME `run.launched` scan as `retryIndex`) so a restarted daemon still
   *  echoes `AgentSession.created_at`; a directly-driven route set gets a fresh one. */
  runTimingIndex?: RunTimingIndex;
  /** Run→operator-guidance index (CREW-UX-7) — `createServer` hydrates one from the audit trail
   *  so a restarted daemon still echoes `guidance`; a directly-driven route set gets a fresh one. */
  guidanceIndex?: GuidanceIndex;
  /** Chat→scope index (crew#502) — `createServer` supplies the one it also reaps on the engine's
   *  `chatClosed` frames (so a reclaimed chat's scratch root goes with it); a directly-driven
   *  route set gets a fresh one. */
  chatScopes?: ChatScopeIndex;
  /** Per-chat turn index (F-RECON-017) — `createServer` feeds one from the CoreEvent fold so
   *  `POST /chats/:id/messages` refuses a send to a seat still mid-turn; a directly-driven route
   *  set gets a fresh one (tests fold frames into it themselves). */
  chatTurns?: ChatTurnIndex;
  /** (ASK-C1) The daemon's record of each chat's ask path; tests inject one to read it back. */
  askPaths?: AskPathIndex;
  /** (ASK-C1) Close a chat the engine holds no row for: the server feeds the synthetic
   *  `chatClosed` frame through its own event fold (and /ws), so DELETE closes exactly the way an
   *  engine close did. `runId` is the path's run, cancelled by this close: its retention hold on
   *  the transcript (crew#619) is released first, so a chat that reuses the id does not inherit
   *  the ended conversation (codex on #808 r3, 1). Absent (tests): the route closes the scope
   *  slot and broadcasts. */
  closeChat?: (frame: CoreEvent, runId: string | undefined, ticket: number) => void | Promise<void>;
  /** DES-L5 (D-13): the chat transcript at rest — `GET /chats/:id.messages`. Absent ⇒ nothing is
   *  persisted and the field is omitted (a directly-driven route in tests). */
  chatTranscripts?: ChatTranscriptStore;
  /** DES-SYSTEM-CHAT: the chat history (kept after a chat ends) and the chat attachments.
   *  Absent ⇒ built here over the transcripts (a directly-driven route set). */
  chatHistory?: ChatHistoryStore;
  chatAttachments?: ChatAttachmentStore;
  /** Run→delivered-PR index (CREW-UX-8, crew#321) — `createServer` hydrates one from the audit
   *  trail so a restarted daemon still echoes `delivery`; a directly-driven route set gets a
   *  fresh one. */
  deliveryIndex?: DeliveryIndex;
  /** The worktree-presence probe behind the `'stranded'` derivation (crew#393) — one stat per
   *  served repo-scoped completed run. Injectable so route tests pin the derivation without
   *  staging directories; defaults to `fs.existsSync`. */
  worktreeExists?: (path: string) => boolean;
  /** The worktree-cleanliness probe behind the `'vacuous'` split of `'stranded'` (crew#311) —
   *  runs only on runs that would otherwise read stranded. Injectable so route tests pin the
   *  derivation without staging real repos; defaults to the TTL-memoized `gitWorktreeIsClean`. */
  worktreeIsClean?: (path: string) => Promise<boolean>;
  /** The run-branch-emptiness probe behind the reaped-worktree half of `'vacuous'` (crew#311) —
   *  runs only on completed repo-scoped runs that would otherwise read `'none'`. Injectable for
   *  the same reason; defaults to the TTL-memoized `gitRunBranchIsEmpty` over the adapter's
   *  repo registry. */
  runBranchIsEmpty?: (repoRef: string, runId: string) => Promise<boolean>;
  /** The background delivery-derivation cache (GET /runs p99): the run DTOs READ this instead
   *  of running the two git probes above at assembly — `createServer` builds one over the
   *  production probes, arms its sweep, and warms it at each run's terminal frame. A
   *  directly-driven route set gets a COLD, unstarted one over the same injectable probes:
   *  reads then answer the stat-only tri-state until a test sweeps or warms it explicitly. */
  deliveryCache?: DeliveryDerivationCache;
  /** The shared one-read-per-run delivery resolution (crew#851). For a served view inside the
   *  completion window — terminal, deliver unit `done`, nothing on record yet — the run routes
   *  AWAIT it before deriving `delivery`, so `status` and `delivery` come from one consistent
   *  read and a run that pushed and opened its PR is never served `'stranded'`. Optional: a
   *  directly-driven route set without one derives as before. */
  deliveryResolver?: DeliveryResolver;
  /** (crew#720) The final-codebase zips (`AgentSession.codebase_archive`, `GET /runs/:id/artifacts/
   *  codebase.zip`, taken again by a post-hoc deliver). Optional: a directly-driven route set without
   *  one serves no archive. */
  codebaseArchives?: CodebaseArchiveStore;
  /** The read-path bound for that await (default `READ_PATH_SETTLE_MS`); tests shorten it. */
  deliverySettleMs?: number;
  /** Def-awareness for the delivery derivation (crew#481 / D-14) — `createServer` injects the
   *  `runCanDeliver(view, runWorkflowDef(view, adapter.listWorkflows()))` closure it also hands
   *  its cache, so the campaigns rollup and the run DTOs classify from ONE predicate. A
   *  directly-driven route set derives the same closure over the adapter's registry when it has
   *  one, else every completed repo-scoped run stays a candidate (today's read). */
  canDeliver?: (view: SessionView) => boolean;
  /** The post-hoc deliver exec (crew#393, `POST /runs/:id/deliver`) — spawns the hardened
   *  deliver script in a run's worktree. Injectable so route tests aim the spawn's HOME/PATH at
   *  a fixture (stub `gh`, local bare origin); defaults to the real `bash -lc` spawn. */
  deliverExec?: DeliverExec;
  /** Stand a lift-conflict-stranded run's worktree back up from its `wicked/<id>` branch when the
   *  engine has reaped it (crew#418) — the post-hoc deliver path uses it before the exec above.
   *  Injectable so route tests never shell out to git; defaults to {@link gitReprovisionWorktree}. */
  reprovisionWorktree?: WorktreeReprovisioner;
  openWithOs?: (target: string) => Promise<void>;
  /** The estate-MCP client behind `/proposals*` AND `/memory*` (DES-MEM-FACETED-001) — one seam for
   *  every operator-facing estate tool (`proposal.*` + `memory.recall`/`memory.coverage`/
   *  `memory.erase`). Injectable so route tests never spawn `wicked-estate-mcp`; defaults to the
   *  real spawn-per-call client (NON-`--readonly`, `WICKED_MEMORY_DB` pinned to the operator global
   *  store — memory.erase is a WRITE). */
  callEstateTool?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Seat sign-in presence probe (seat sign-in) — injectable so route tests never read the
   *  developer's real dotfiles. Defaults to the file/env heuristic in seat-signin.ts. */
  signedIn?: (seatKey: string, workerConfigRoot?: string) => boolean | null;
  /** The roster WITH crew's standing (`api/roster-standing.ts`) — `createServer` injects its single
   *  instance so the routes, the interactive seams and the adapter's own launches all bench the
   *  same seats (F-RECON-002/003); a directly-driven route set builds one over `seatHealth` +
   *  `signedIn` above. */
  rosterWithStanding?: RosterWithStanding;
  /** Injectable so container-login route tests never spawn the engine or a login container. */
  seatLoginExec?: ExecLike;
  /** The `/ws` fan-out, for the few routes that say something to a thread themselves (a refused
   *  chat seat, F-2R2-007). Absent (unit tests, library use) = nothing is broadcast. */
  broadcast?: (frame: CoreEvent) => void;
  /** The wicked-interactive bridge pool behind `/projects/:id/interactive/*` (DES-MERGE-001
   *  slice 1). Injectable so the integration suite proxies to a FAKE bridge instead of
   *  spawning a real `npx wicked-interactive serve`. */
  interactiveBridges?: InteractiveBridgePool;
  /** F-043 — the directory of the bus db this daemon's interactive seams read, exported to a
   *  bridge the pool spawns as `WICKED_BUS_DATA_DIR`. `null`/absent = not exported. Ignored when
   *  `interactiveBridges` is injected (the injected pool carries its own io). */
  interactiveBridgeBusDataDir?: string | null;
  /** F-046 — the create-time doc → subject-repo binding store the proxy records into and the
   *  draft/demo seams read. Absent = the create stays pure transport (a directly-driven route set). */
  docGrounding?: DocGroundingStore;
  /** crew#899: refresh (or report the staleness of) each checkout a chat opens on. `createServer`
   *  wires {@link freshenCheckout}; absent = checkouts are read as they are (route tests). */
  freshenCheckout?: FreshenCheckout;
  /** The governed doc-delete's handoff-ledger sweep (crew#338) — `createServer` wires the real
   *  four-ledger sweep (live seam instances first, ledger files as fallback); a directly-driven
   *  route set gets an INERT one so unit tests never touch ~/.wicked-crew. */
  dropDocLedgerRows?: (documentId: string, projectId?: string) => DocLedgerSweep;
  /** EP-C2 — where the interactive-review seam records documents' reviews (`<handoff root>/_reviews`).
   *  Absent = the default handoff root under the daemon's state home (read-only here). */
  docReviewsDir?: () => string;
  /** The daemon's in-process error-level log ring (diagnostics) — `createServer` tees the pino
   *  stream into one; a directly-driven route set (tests) gets an honestly-empty tail. */
  errorRing?: ErrorRing;
  /** The pre-fix HOME dead-letter outbox `/diagnostics.governance` points at when it exists
   *  (crew#495): `undefined` = the engine's own default under HOME; `null` = report none — a
   *  directly-driven route set (tests) never has to `stat` the developer's real home. */
  governanceLegacyOutboxPath?: string | null;
  /** The studio asset root `createServer` resolved (bundled or overridden) — diagnostics reads
   *  the bundle's shipped version manifest from it. Absent = headless = `studioBundle: null`. */
  studioRoot?: string;
  /** EP-C1 (tests): the `pack check` runner `POST /editors` uses; default = garden's script as a child. */
  packCheck?: PackCheckRunner;
  /** (tests) the install-time conformance run `POST /editors` uses; default = garden's runner as a child. */
  editorConformance?: ConformanceRunner;
  /** EP-C1 (tests): where `daemon-editors.json` lives; default = the crew state home. */
  editorsStateHome?: string;
  /** The eval RUN history store behind `/testing/evals[/:id]` — `createServer` builds one over the
   *  daemon state home so every `POST /testing/evals/run` is recorded; a directly-driven route set
   *  (tests) gets one only when it injects it, so a test that never touches the eval routes writes
   *  nothing under `~/.wicked-crew`. */
  evalStore?: EvalRunStore;
  /** The default-evals history (DES-DEFAULT-EVALS-001) — `createServer` builds one beside the eval store; a
   *  directly-driven route set computes and answers runs but stores none unless a test injects one. */
  defaultEvalStore?: DefaultEvalStore;
  /** (tests) where `run-evals` launches write their report copy; default `~/.wicked/evals` (`defaultEvalRunsDir`). */
  evalRunsDir?: string;
  /** The skills seam (skills keystone) — `createServer` builds one over the daemon state home
   *  (seeded from the installed plugin, published); a directly-driven route set gets none and
   *  `/skills*` answers 503 unless a test injects one over a fixture root. */
  skills?: SkillsRuntime;
  /** The MCP tools registry (DES-MCP-TOOLS-001 S2) — `createServer` builds one over
   *  `<state home>/mcp`; a directly-driven route set gets none and `/mcp/*` answers 503 unless a
   *  test injects one over a scratch dir. */
  mcp?: McpRegistry;
  /** The MCP broker's call path (DES-MCP-TOOLS-001 S3) over that registry; absent → `POST /mcp/call` 503. */
  mcpBroker?: McpBroker;
  askServer?: AskServer;
  /** The broker's call records (DES-MCP-TOOLS-001 S7), the ones `GET /mcp/usage` folds; absent → 503. */
  mcpCalls?: McpCallRecordSource;
  /** crew#661 — the runs that launched with a skill gap before crew#935 (`AgentSession.skill_gaps`),
   *  hydrated from the trail. Absent = no run carries the field. */
  runSkillGaps?: RunSkillGapIndex;
  /** The live state-home classification (wicked-core#411 / crew#497) — `createServer` surveys the
   *  daemon state home at boot and hands the watch here; the routes re-survey on demand, report it
   *  on `/diagnostics.stateHome` + `/health.warnings`, and answer `POST /runs` 409 while a handed
   *  snapshot derives a state home with an entry the fence cannot classify. A directly-driven route
   *  set (tests) gets none: no survey, no warning, no gate — never a fabricated clean answer. */
  stateHome?: StateHomeWatch;
  /** The document ↔ run binding (wave 6, F-4R2-006) read off the interactive seams' handoff ledgers —
   *  `createServer` builds one over the four ledger sources; a directly-driven route set gets an
   *  EMPTY one (`document_id: null` on every run). */
  docRuns?: DocRunIndex;
  /** The registered test sets (wave 6, F-7R2-014) — `createServer` hydrates one from the trail and
   *  registers into it at each `qe-author-tests` run's terminal frame; a directly-driven route set
   *  gets a fresh, empty one. */
  testSets?: TestSetIndex;
  /** crew#619 — called when a run is launched with a `chatId`, to retain that chat's transcript
   *  until the run terminates. Absent in directly-driven route sets (tests). */
  linkChatRun?: (chatId: string, runId: string) => void;
  /** crew#642 — entity-count probe for the chat scope's `ownGraph` liveness check. Injectable so
   *  route tests never shell `wicked-estate` against mkdtemp fixtures. Absent = the dep carries
   *  its own default (shells `estate stats --db`). */
  entityCount?: (dbPath: string) => Promise<number>;
}

/**
 * The daemon REST surface. Every endpoint is a thin wrapper over one adapter /
 * core-ts call (DES-STUDIO-001 §2). `session`/`phase` nouns are now `run`/`unit`.
 */
/**
 * `POST /chats` body (crew#165; `projectId` DES-PROJECT-001 §2.2; `repoRefs` + scope semantics
 * crew#502). Exported for the wire-contract drift guard (`tests/wire-contract.test.ts`).
 */
export const ChatOpenSchema = z.object({
  chatId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).optional(),
  clis: z.array(z.string().min(1)).min(1).max(8).optional(),
  /** One repo in scope — the legacy spelling, merged into `repoRefs` (crew#502). */
  repoRef: z.string().min(1).optional(),
  /** The repos in scope, by registry id or name (crew#502). */
  repoRefs: z.array(z.string().min(1)).min(1).max(32).optional(),
  /** File the chat into a project (`crew.chat` membership) — and, with no `repoRefs`, scope it to
   *  every registered `crew.repo` member of that project (crew#502). */
  projectId: z.string().min(1).optional(),
  /** The scope the caller NAMES (studio#323 R4) — omitted ⇒ the legacy inference. Shape rules
   *  (which kinds need / refuse `projectId` / `repoRefs`) are the resolver's (`chat-scope.ts`). */
  scopeKind: z.enum(['system', 'everything', 'project', 'repo', 'repos', 'none']).optional(),
  /** (ASK-C1) The seat the operator chose as the primary agent; omitted ⇒ the engine picks at random. */
  primary: z.string().min(1).optional(),
  /** (api-types 0.137.0, DES-SYSTEM-CHAT) The page the chat was started on, for the history list. */
  startedOn: z.object({ route: z.string().min(1).max(512), label: z.string().min(1).max(200) }).strict().optional(),
  /** (api-types 0.141.0, crew#1157) The read-only workflow every turn runs (`analyze`); see
   *  `chat-workflow.ts`. Omitted ⇒ a plain chat. */
  workflow: z.string().min(1).max(64).optional(),
}).strict();

/**
 * The `singleSeat` disclosure (crew#641, hole closed in crew#650) — built in ONE place so the 201
 * and the 202 cannot drift.
 *
 * The property this field states is **"this chat has one seat; it cannot disagree with itself"**,
 * and that is true of every one-warm-seat chat. The first cut also required `refused.length > 0`,
 * so the case an operator is most likely to create — a chat deliberately opened with a single seat
 * — returned `ok: true` with no signal at all, which is the exact failure mode #641 was filed
 * about. It also made the 202 go quiet after a restart, when `refusedOf` no longer knows the
 * refusals, even though the chat is just as single-seated as it was a minute earlier.
 *
 * `refused` therefore rides along as EVIDENCE when there is any — it never decides whether the
 * caller is told.
 *
 * THREE states, not two (review of #658). The refusal list has a third possibility that `[]` cannot
 * express: this daemon does not KNOW. `chatScopes.refusedOf` answers `undefined` for a chat this
 * daemon did not open — the engine keeps the warm session across a restart, the in-memory index does
 * not — and the first cut collapsed that to `[]` with `?? []`, which made the 202 tell an operator
 * *"It was opened with a single seat — no other seat was refused"* about a chat that was opened with
 * two seats, one of which was refused. Both halves false, stated confidently. It is the same
 * distinction #651 got right for chat-promotion provenance (`.catch(() => null)`, never `[]`):
 * unreadable and empty are different answers, and only one of them may be asserted.
 *
 * TWO MOMENTS, and only one route witnessed each (third review of #658). `refused` describes the
 * daemon's record — what the OPEN (or the last re-seat) observed; `warmRoster` describes NOW. Any
 * sentence built from both fabricates the instant they diverge, and they diverge routinely: a seat
 * that blows its turn budget is RELEASED by the engine (`chat-turns.ts`), a re-seat clears an entry
 * from the record, a restart drops the record entirely. A chat opened with `['claude','opencode']`
 * — both warm, nothing refused, nothing unknown — whose `opencode` is later released would have been
 * told *"It was opened with a single seat — no other seat was refused"*: false in both halves, with
 * no `undefined` anywhere near it. So `at` names the moment the caller is asking about:
 *
 *   • `'open'` — the 201. This route just performed the open, so it is the ONLY one with standing to
 *     describe it: refusals known and empty ⇒ it may say the chat was opened with a single seat.
 *   • `'turn'` — the 202. It knows the roster NOW and the refusal record; it knows nothing about how
 *     the chat came to look like this. Refusals known and empty ⇒ it says NOTHING about opening.
 *     It still names refusals that are on record, and still says so when the record is unavailable —
 *     both are statements about the record it holds, not about a moment it did not see.
 *
 * `refusalsKnown` carries the known/unknown distinction for a machine reader, because `refused: []`
 * is exactly as ambiguous on the wire as the sentence was in prose.
 */
function singleSeatDisclosure(
  warmed: string,
  /** `undefined` = this daemon has no refusal record for the chat (it did not open it). */
  refused: ChatSeatRefusal[] | undefined,
  /** Which moment the caller is asking about — see the note above; only `'open'` may describe one. */
  at: 'open' | 'turn',
): {
  degraded: true;
  warmed: string;
  refused: ChatSeatRefusal[];
  refusalsKnown: boolean;
  message: string;
} {
  const known = refused !== undefined;
  const list = refused ?? [];
  const refusalClause =
    list.length > 0
      ? `Refused: ${list.map((r) => `${r.cliKey} (${r.reason})`).join('; ')}. `
      : known
        ? at === 'open'
          ? 'It was opened with a single seat — no other seat was refused. '
          : // A turn has no standing to say how the chat was opened: this seat may be the survivor of
            // a two-seat chat whose other seat was released mid-session. Say nothing.
            ''
        : 'This daemon holds no refusal record for this chat — it was opened before a restart — so ' +
          'whether another seat was refused is UNKNOWN: the empty refused[] means the record is gone, ' +
          'not that nothing was refused. ';
  return {
    degraded: true,
    warmed,
    refused: list,
    refusalsKnown: known,
    message:
      // "warm" on a turn: the claim is about the roster as it stands, not about how it got there.
      `This chat has one eligible seat (${warmed}); it cannot disagree with itself. ` +
      refusalClause +
      'The single-seat root cause is tracked as wicked-core#563; this chat makes it visible.',
  };
}

/** N1: why a post-hoc deliver answers 409 for a branch already on a non-GitHub origin. */
function pushedOnlyRefusal(runId: string, pushed: { branch: string; remote: string }): string {
  return (
    `run ${runId} is delivered as a pushed branch: ${pushed.branch} is on ${pushed.remote}, and no ` +
    'pull request can be opened there because that origin is not a GitHub host gh can resolve — ' +
    'open the pull/merge request on your forge; merge stays human'
  );
}

/** B8: the editor-conformance browser runtime crew provisions when a host has none (one per process). */
const editorConformanceRuntime = conformanceProvisioner(() => conformanceRuntimeRoot());

export function registerRoutes(
  app: FastifyInstance,
  adapter: CoreAdapter,
  gateCache: GateCache,
  elicitationCache: ElicitationCache,
  // Defaulted for the same reason: tests that drive this function directly get
  // the projects surface with no bus (events skipped) and a fresh index.
  projects: ProjectRoutesDeps = { bus: null, index: new MembershipIndex(), log: () => undefined },
  // Defaulted likewise — to a NOOP trail, deliberately: a directly-driven
  // route set (unit tests) must never write the operator's real
  // ~/.wicked-crew/audit.log or leave appends pending after close. The real
  // trail always arrives from `createServer`.
  security: SecurityDeps = { audit: AuditLog.noop(), authMode: 'off' },
  // Defaulted likewise: a directly-driven route set gets a fresh (all-active) health map and the
  // real OS opener — tests inject both through this seam.
  runtime: RuntimeDeps = {},
): RegisteredRoutes {
  const { audit } = security;
  const seatHealth = runtime.seatHealth ?? new SeatHealthTracker();
  const deliveryFreeze = runtime.deliveryFreeze ?? new DeliveryFreeze();
  registerDeliveryFreezeRoutes(app, { freeze: deliveryFreeze, audit });
  const openWithOs = runtime.openWithOs ?? openWithSystemDefault;
  const signedIn = runtime.signedIn ?? signedInHeuristic;
  const retryIndex = runtime.retryIndex ?? new RetryIndex();
  const groupIndex = runtime.groupIndex ?? new GroupIndex();
  const runTimingIndex = runtime.runTimingIndex ?? new RunTimingIndex();
  const guidanceIndex = runtime.guidanceIndex ?? new GuidanceIndex();
  const chatScopes = runtime.chatScopes ?? new ChatScopeIndex();
  const chatTurns = runtime.chatTurns ?? new ChatTurnIndex();
  const askPaths = runtime.askPaths ?? new AskPathIndex();
  const chatTranscripts = runtime.chatTranscripts;
  const chatAttachments = runtime.chatAttachments ?? new ChatAttachmentStore();
  const chatHistory = runtime.chatHistory ?? (chatTranscripts !== undefined ? new ChatHistoryStore(chatTranscripts, chatAttachments) : null);
  const deliveryIndex = runtime.deliveryIndex ?? new DeliveryIndex();
  // Wave 6: the doc↔run binding and the registered test sets — `createServer` injects the real
  // ones; a directly-driven route set gets an empty index (every run `document_id: null`, no sets).
  const docRuns = runtime.docRuns ?? new DocRunIndex(() => []);
  const testSets = runtime.testSets ?? new TestSetIndex();
  const worktreeExists = runtime.worktreeExists ?? ((p: string) => existsSync(p));
  const vacuityProbes: VacuityProbes = {
    worktreeExists,
    worktreeIsClean: runtime.worktreeIsClean ?? gitWorktreeIsClean(),
    runBranchIsEmpty:
      runtime.runBranchIsEmpty ??
      gitRunBranchIsEmpty(async (repoRef) => {
        const repos = await adapter.listRepos();
        return repos.find((r) => r.id === repoRef)?.root_path;
      }),
  };
  // The background layer that owns the git probes above (GET /runs p99): the run DTOs read it,
  // the daemon's sweep/warm feed it. The default (a directly-driven route set) is COLD and
  // unstarted — no background timer under a unit test, reads degrade to the stat-only
  // tri-state — while `createServer` injects a started one over the production probes.
  // Def-awareness (crew#481 / D-14): the ONE predicate the run DTOs' cache, the campaigns rollup and
  // the resume 409 classify from. A fake adapter with no registry (`listWorkflows` absent) resolves
  // no def ⇒ `runCanDeliver(view, null)` ⇒ candidate — byte-for-byte today's read.
  const canDeliver =
    runtime.canDeliver ??
    canDeliverResolver(
      () => (typeof (adapter as Partial<CoreAdapter>).listWorkflows === 'function' ? adapter.listWorkflows() : []),
      (m) => app.log.warn(m),
    );
  const deliveryResolver = runtime.deliveryResolver;
  /** crew#851: await the shared resolution for every served view still inside the completion
   *  window — BOUNDED (`READ_PATH_SETTLE_MS`): a hung engine read costs this poll the bound, not
   *  the request; the run falls through to its stat-derived label until the read lands. */
  const settleDeliveries = async (views: SessionView[]): Promise<void> => {
    if (deliveryResolver === undefined) return;
    await deliveryResolver.settle(views, runtime.deliverySettleMs);
  };
  // crew#985: terminal runs with no `run.ended` entry are dated from the engine's event log before
  // the DTO is assembled (read-only, once per run per process; see `backfillEndedFromEvents`).
  const backfillEndedAt = async (views: readonly SessionView[]): Promise<void> => {
    if (typeof adapter.runEvents !== 'function') return;
    await runTimingIndex.backfillEndedFromEvents(views, (id) => adapter.runEvents(id));
  };
  const deliveryCache =
    runtime.deliveryCache ??
    new DeliveryDerivationCache({
      listViews: () => adapter.sessionsDetail(),
      probes: vacuityProbes,
      isDelivered: (runId) => deliveryIndex.isDelivered(runId),
      canDeliver,
    });
  const deliverExec = runtime.deliverExec ?? runDeliverScript;
  // crew#524: the deliver phase's script asks THIS daemon for the run-derived PR text, and the PR
  // body links the run here — so the adapter learns the bound origin lazily (the server has not
  // listened yet when routes register). Guarded: directly-driven route sets hand in fakes.
  if (typeof (adapter as Partial<CoreAdapter>).setDeliverApiOrigin === 'function') {
    adapter.setDeliverApiOrigin(() => boundOrigin(app.server.address()));
  }
  const reprovisionWorktree = runtime.reprovisionWorktree ?? gitReprovisionWorktree;
  // The estate MCP client behind `/proposals*` AND `/memory*` (DES-MEM-FACETED-001) — one seam. The
  // default is the real spawn-per-call `wicked-estate-mcp` client; route tests inject a stub so no
  // process is ever spawned.
  const estateTool = runtime.callEstateTool ?? callEstateTool;
  // DC-S4a: decision capture over the structured hosts (gate note, elicitation, inject). Words are
  // recorded post-commit, off the request path, and only from a human actor (decisions/ingest.ts).
  const decisions: DecisionService | null =
    runtime.decisionLedger !== undefined
      ? new DecisionService({
          ledger: runtime.decisionLedger,
          mode: runtime.decisionsMode ?? resolveDecisionsMode(),
          authMode: security.authMode,
          estateTool,
          adapter,
          audit,
          emit: runtime.decisionsEmit ?? null,
          ...(runtime.broadcast !== undefined
            ? { broadcast: (frame) => runtime.broadcast?.(frame as unknown as CoreEvent) }
            : {}),
          log: (m) => app.log.warn(m),
        })
      : null;
  if (decisions !== null) registerDecisionRoutes(app, decisions);
  // DC-S4b: the studio chat host. The recorder writes the transcript's `decisions` record and the
  // `chatDecisions` frame, so without the store or the /ws fan-out there is no chat host at all.
  // DC-S7: considered · set aside · cited (unchecked) for chat turns and run units, and how the
  // seats learn the rules (the statement at open, a disclosed preface on the next send after a rule
  // lands). Fail-soft on an engine or a stub without the rule reads.
  const considerations = new ConsiderationService({
    adapter,
    ...(runtime.decisionLedger !== undefined ? { ledger: runtime.decisionLedger } : {}),
    ...(chatTranscripts !== undefined ? { transcripts: chatTranscripts } : {}),
    projectOf: (id) => projects.index.projectOf(id),
    emit: runtime.decisionsEmit ?? null,
    log: (m) => app.log.warn(m),
  });
  // EP-C1 (DES-artifact-editor-plugins §9.1): the editor registry — first-party editors discovered
  // in studio's bundle, installed pack editors and the flags in `daemon-editors.json` — and its
  // routes. A pack installs after garden's gate AND crew's own conformance run (garden's runner
  // against this daemon's conformance host page, at the URL the daemon exported at boot).
  const editorRegistry = new EditorRegistry({
    ...(runtime.editorsStateHome !== undefined ? { stateHome: runtime.editorsStateHome } : {}),
    ...(runtime.studioRoot !== undefined ? { studioRoot: runtime.studioRoot } : {}),
    log: (m) => app.log.warn(m),
  });
  registerEditorRoutes(app, {
    registry: editorRegistry,
    adapter,
    packCheck: runtime.packCheck ?? gardenPackCheck(discoverLivePlugin()?.path ?? null),
    conformance: runtime.editorConformance ?? gardenConformance(discoverLivePlugin()?.path ?? null, () => process.env['WICKED_CREW_URL'] ?? null, { provision: editorConformanceRuntime }),
    log: (m) => app.log.warn(m),
  });
  const chatRecorder: ChatDecisionRecorder | null =
    decisions !== null && chatTranscripts !== undefined && runtime.broadcast !== undefined
      ? new ChatDecisionRecorder({
          service: decisions,
          transcripts: chatTranscripts,
          broadcast: runtime.broadcast,
          projectOf: (chat) => projects.index.projectOf(chat),
          onTurnRecorded: (chat, turnId) => considerations.onChatTurn(chat, turnId),
          log: (m) => app.log.warn(m),
        })
      : null;
  /** Repo root for a repo ref, from the registry — shared by the reprovision path below. */
  const repoRootOf = async (repoRef: string): Promise<string | undefined> =>
    (await adapter.listRepos()).find((r) => r.id === repoRef)?.root_path;
  /** DES-L9: PR number → head branch, through `gh pr view` unless the runtime injected an answerer. */
  const resolvePullRequest = runtime.resolvePullRequest ?? resolvePullRequestViaGh;
  /** crew#627: the intent's linked issues, read under the daemon's identity at launch. */
  const readLinkedIssues =
    runtime.resolveLinkedIssues ??
    ((p: string, root: string | undefined, ref: string | undefined, exclude?: readonly string[]) =>
      resolveLinkedIssues(p, root, ref, undefined, exclude));
  /** crew#550 P-7: the follow-ups the run's evaluator units flagged, read from their captured output.
   *  A unit whose output cannot be read contributes nothing (the section then says what WAS read);
   *  an adapter without transcripts (a directly-driven route set) reads as "not read" — absent. */
  const evaluatorFollowUps = async (view: SessionView): Promise<string[] | undefined> => {
    if (typeof adapter.workOutput !== 'function') return undefined;
    const evaluators = view.units.filter((u) => u.role === 'evaluator').sort((a, b) => a.ord - b.ord);
    const out: string[] = [];
    for (const u of evaluators) {
      let text: string | null = null;
      try {
        text = await adapter.workOutput(coreUnitId(view.session.id, u));
      } catch {
        text = null;
      }
      if (text === null) continue;
      for (const x of extractFollowUps(text)) if (!out.includes(x)) out.push(x);
    }
    return out.slice(0, FOLLOW_UPS_MAX);
  };
  /** crew#860: the creator and evaluator seats' final reports (and the recipe exit codes they
   *  pasted), read from their captured output for the PR body's done-when evidence. Absent when
   *  the adapter keeps no transcripts — the body then says the output could not be read. */
  const seatReports = async (view: SessionView): Promise<DeliverReportFact[] | undefined> => {
    if (typeof adapter.workOutput !== 'function') return undefined;
    const read = adapter.workOutput.bind(adapter);
    return reportsFromOutputs(view, (u) => read(coreUnitId(view.session.id, u)));
  };
  // The run-DTO joins (DES-UX-001 §8.2/§8.3, DES-UX-002 §7.2): `project_id` from the membership
  // record — `null` = genuinely unfiled, so the field is ALWAYS present on served runs —
  // `retry_of` from the lineage index and `guidance` from the guidance index, each set only
  // when known (absent, never null, spells "not a retry" / "no note"). `delivery` (crew#393,
  // api-types 0.18.0) is DERIVED on every served run — delivered from the index (CREW-UX-8's
  // durable record), stranded from the run record + a worktree stat, none otherwise — so a
  // completed code run whose work is sitting unlifted in its worktree is VISIBLE on the wire,
  // legacy records included. The would-be-stranded runs are further split (crew#311): a
  // completed run whose worktree carries NO contribution at all reads `'vacuous'` — units all
  // "done" with nothing produced must be LOUD on the wire, never silently green. The vacuity
  // split's git probes run in the BACKGROUND (delivery-cache.ts — GET /runs p99): DTO assembly
  // reads the cache and degrades to the stat-only stranded/none label for at most one sweep
  // tick on a miss, so the list fan-out never spawns git.
  // Applied at DTO assembly on exactly the two endpoints that serve the run DTO
  // (GET /runs + GET /runs/:id); the internal sessionsDetail() consumers are untouched.
  // crew#418/#432: a `failed` run whose ONLY failure was a recoverable deliver LIFT failure (a
  // rebase conflict, non-fast-forward, or auth/transport/remote push rejection) is
  // reinterpreted on the wire as `completed` + `delivery: 'stranded'` — recoverable, not a hard
  // failure. The engine's durable record stays `failed` (audit trail); this is a wire derivation,
  // exactly like `delivery` itself, applied at the SAME three terminal-status decision points so
  // the run reads consistently across GET /runs(/:id), resume, and POST /runs/:id/deliver. The
  // deliver unit stays `rejected` with its marker-bearing `denial_reason`, so WHY it stranded is
  // still on the wire.
  //
  // Returns whether this run IS such a strand — the caller uses it for a BRANCH-based `'stranded'`
  // read: the engine reaps a failed-deliver run's worktree once the deliver phase has committed
  // the work (a clean tree), so the work lives on the `wicked/<id>` branch, not the worktree — the
  // worktree-stat derivation would read `'none'` (and flicker as the async reap lands). The
  // lift-conflict marker is proof the branch carries the work (the deliver script verified it was
  // ahead of the default branch before it ever attempted the rebase), so the read is a STABLE
  // `'stranded'` regardless of whether the worktree survived. Idempotent: a second call sees the
  // already-flipped `completed` and returns false, so the flip never re-fires.
  const normalizeStranded = (view: SessionView): boolean => {
    const conflictStrand = isDeliverConflictStranded(view); // true only while status === 'failed'
    if (conflictStrand) view.session.status = 'completed';
    return conflictStrand;
  };
  /** The run's delivery state, honest by construction (crew#393/#311/#418): a recorded PR wins
   *  (`'delivered'`); else a lift-conflict strand reads `'stranded'` from the branch; else the
   *  delivery-derivation CACHE (a background-derived stranded / vacuous / none — GET /runs p99).
   *  A cache miss answers the stat-only tri-state (one existsSync, the pre-crew#311 label) for
   *  at most one sweep tick; the request path never spawns git and never awaits a derivation. */
  const resolveDelivery = (view: SessionView, conflictStrand: boolean): DeliveryState => {
    const url = deliveryIndex.urlFor(view.session.id);
    if (url !== undefined) return { delivery: 'delivered', deliverUrl: url };
    // N1: a branch pushed to a non-GitHub origin IS the delivery — never 'stranded'.
    const pushed = deliveryIndex.pushedFor(view.session.id);
    if (pushed !== undefined) return pushedState(pushed);
    if (conflictStrand) return { delivery: 'stranded' };
    return deliveryCache.read(view);
  };
  const decorateRun = (view: SessionView): SessionView => {
    const conflictStrand = normalizeStranded(view);
    // Seam X2: what the run IS — the adapter attaches it from the engine's record; a view from a
    // directly-driven adapter gets it resolved from its record here, so it is always served.
    view.session.run_identity = wireIdentity(runIdentityOf(view));
    view.session.project_id = projects.index.projectOf(view.session.id) ?? null;
    // Wave 6 (F-4R2-006): the interactive document this run answered, from the seams' handoff
    // ledgers — `null` = genuinely not a document run, so the field is ALWAYS present on served runs.
    view.session.document_id = docRuns.documentOf(view.session.id) ?? null;
    // api-types 0.113.0 (operator ruling 2026-10-12): the run's short job title, derived here from its
    // own problem (pure, `job-title.ts`) so every skin shows the same one; the full text stays `problem`.
    view.session.title = jobTitle(view.session.problem);
    const retryOf = retryIndex.retryOfFor(view.session.id);
    if (retryOf !== undefined) view.session.retry_of = retryOf;
    // wicked-studio#27 (api-types 0.19.0): the launch-time group attach, from the same durable
    // trail record as lineage. ABSENT when ungrouped — never null.
    const attach = groupIndex.attachOf(view.session.id);
    if (attach !== undefined) {
      if ('campaignId' in attach) view.session.campaign_id = attach.campaignId;
      else view.session.group_label = attach.label;
    }
    const guidance = guidanceIndex.guidanceFor(view.session.id);
    if (guidance !== undefined) view.session.guidance = guidance;
    // crew#661: the declared skills this run's phases ran WITHOUT (degrade-and-disclose) — ABSENT when none.
    const skillGaps = runtime.runSkillGaps?.gapsFor(view.session.id);
    if (skillGaps !== undefined) view.session.skill_gaps = skillGaps;
    // Run launch time (home command-center run metrics): unix SECONDS from the `run.launched`
    // audit entry, ABSENT when the daemon has no launch record for this run (onboarding/campaign
    // runs launched off POST /runs, pre-field runs) — never fabricated, so a bucketed KPI can
    // exclude an undated run rather than dating it with a false now.
    const createdAt = runTimingIndex.createdAtFor(view.session.id);
    if (createdAt !== undefined) view.session.created_at = createdAt;
    // `ended_at` (crew#496 / studio#230; api-types 0.38.0): the same posture from the `run.ended`
    // entry the daemon records at the run's terminal frame — ABSENT when it has none.
    const endedAt = runTimingIndex.endedAtFor(view.session.id);
    if (endedAt !== undefined) view.session.ended_at = endedAt;
    // crew#632: launch surface and caller identity — served ABSENT when absent, never null.
    const channel = runTimingIndex.channelFor(view.session.id);
    if (channel !== undefined) view.session.channel = channel;
    const launchActor = runTimingIndex.launchActorFor(view.session.id);
    if (launchActor !== undefined) view.session.launch_actor = launchActor;
    const state = resolveDelivery(view, conflictStrand);
    view.session.delivery = state.delivery;
    // wicked-core#850 EX-04: a post-hoc delivery reads unverified, with its trees. ABSENT otherwise.
    const deliveryAssurance = deliveryIndex.assuranceFor(view.session.id);
    if (deliveryAssurance !== undefined) view.session.delivery_assurance = deliveryAssurance;
    // crew#762: was delivery asked for? The launch's decision (`deliver: 'pr'`), a post-hoc attempt
    // or a delivery on record says yes; a launch that said `deliver: 'none'` with neither says no.
    // ABSENT when the daemon holds no launch record and no attempt (never fabricated).
    const launchDeliver = runTimingIndex.launchDeliverFor(view.session.id);
    if (launchDeliver === 'pr' || deliveryIndex.wasRequested(view.session.id) || deliveryIndex.isDelivered(view.session.id)) {
      view.session.deliver_requested = true;
    } else if (launchDeliver === 'none') {
      view.session.deliver_requested = false;
    }
    // crew#755: a completed repo-less free-text run answered in text and changed nothing — say so.
    const outcome = freeTextOutcome(view);
    if (outcome !== undefined) view.session.outcome = outcome;
    if (state.deliverUrl !== undefined) view.session.deliverUrl = state.deliverUrl;
    if (state.deliverBranch !== undefined) view.session.deliverBranch = state.deliverBranch;
    if (state.deliverRemote !== undefined) view.session.deliverRemote = state.deliverRemote;
    // crew#720: the final-codebase zip (every outcome), and a deliver phase that refused for want of
    // the provider credential — read from the deliver unit's own refusal line.
    const archive = runtime.codebaseArchives?.get(view.session.id);
    if (archive !== undefined) view.session.codebase_archive = archive;
    const deliverUnit = deliverUnitOf(view);
    const credMissing = deliverUnit !== null && deliverUnit.status !== 'done' ? credentialsMissingIn(deliverUnit.denial_reason ?? '') : null;
    if (credMissing !== null) view.session.deliver_credentials = missingCredentials(credMissing);
    // crew#641/#642 (item 5): chat promotion provenance — ABSENT when not a chat-promoted run.
    const chatSeatCount = runTimingIndex.chatSeatCountFor(view.session.id);
    if (chatSeatCount !== undefined) view.session.chat_seat_count = chatSeatCount;
    const chatGrounded = runTimingIndex.chatGroundedFor(view.session.id);
    if (chatGrounded !== undefined) view.session.chat_grounded = chatGrounded;
    // C1: the chat the run was launched from, on every run (terminal ones too) — ABSENT otherwise.
    const chatId = runTimingIndex.chatIdFor(view.session.id);
    if (chatId !== undefined) view.session.chat_id = chatId;
    // crew#552: the onboarding run a chained capture was launched from — ABSENT otherwise.
    const chainedFrom = runTimingIndex.chainedFromOf(view.session.id);
    if (chainedFrom !== undefined) view.session.chained_from = chainedFrom;
    // crew#854: an ask's run, and whether it waits at its TURN gate (answered by the next message,
    // never a gate for the Needs-you count).
    if (runTimingIndex.isAskPath(view.session.id)) {
      view.session.ask_path = true;
      if (isAskTurn(view)) view.session.ask_turn = true;
    }
    // crew#1058: the seats a reassign of each unit is refused for (the work's authors under a
    // distinct-evaluator contract) — the same rule the reassign route applies. ABSENT when none.
    for (const unit of view.units) {
      const refused = reassignRefusedSeats(view, unit.ord);
      if (refused.length > 0) unit.reassign_refused = refused;
    }
    return view;
  };
  // Resolved ONCE and shared by the project routes (which read/write `interactiveRoot`) and the
  // interactive proxy (which resolves a root from it) — two stores would let a PATCH land in one
  // and the proxy keep reading the other.
  const projectSettings = projects.settings ?? new ProjectSettingsStore();
  // `req.actor` is pinned by the auth hooks `createServer` installs; a caller
  // driving this function directly (tests) has no hooks, so downstream code
  // still gets the ONE actor shape via this accessor.
  const actorOf = (req: { actor?: import('../core/types.js').Actor }) => req.actor ?? LOCAL_ACTOR;
  // crew#753: the blocking `skills.garden` finding (an installed garden older than the minimum), or
  // `null`. Read from the skills runtime's cached health; no seam ⇒ nothing to judge.
  const gardenBlocker = (): { kind: string; severity: string; message: string } | null => {
    const f = runtime.skills?.health().findings.find((x) => x.kind === 'skills.garden' && x.severity === 'error');
    return f === undefined ? null : { kind: f.kind, severity: f.severity, message: f.message };
  };
  /**
   * crew#1145: a launch or onboard admitted while the daemon's background skills ladder runs would be
   * judged against the `publishing` placeholder (no garden finding, no base skill yet) — so the
   * admission waits for the ladder first. Settled at once on an inline boot or without the seam.
   */
  const skillsLanded = async (): Promise<void> => {
    const skills = runtime.skills as Partial<SkillsRuntime> | undefined;
    if (typeof skills?.bootSettled === 'function') await skills.bootSettled();
  };
  /** The typed 422 a launch or onboard answers while {@link gardenBlocker} holds. */
  const gardenRefusalBody = (): import('wicked-crew-api-types').GardenRequiredBody | null => {
    const f = gardenBlocker();
    return f === null ? null : { code: 'garden_required', error: f.message, required: REQUIRED_GARDEN_VERSION };
  };
  // Liveness — also proves the actor + event pump are up.
  //
  // crew#471: the engine's ping is a round trip through its single-writer actor, and a launch that
  // plans many units holds that actor for minutes. Awaiting it made `/health` go dark exactly when
  // an operator needed to know the daemon was up, and each waiting probe pinned a libuv worker
  // thread the rest of the read path needs. So at most ONE ping is in flight (later probes join it)
  // and `/health` waits for it at most HEALTH_PING_WAIT_MS: past that it answers `ping: "busy"` —
  // the daemon serves, the engine is occupied.
  let pingInFlight: Promise<string> | null = null;
  const enginePing = (): Promise<string> => {
    pingInFlight ??= adapter.ping().finally(() => {
      pingInFlight = null;
    });
    let timer: NodeJS.Timeout | undefined;
    const busy = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(ENGINE_BUSY_PING), HEALTH_PING_WAIT_MS);
    });
    return Promise.race([pingInFlight, busy]).finally(() => clearTimeout(timer));
  };
  // `config.manifest` on the routes below (TH-11): the declaration channel the endpoint manifest
  // reads — type names bind to `wicked-crew-api-types` exports where one exists, structural
  // spellings where the contract has no name, statusCodes list every code the route answers on
  // purpose. Declared on the highest-traffic run-lifecycle routes first; the manifest records
  // null / [] for the rest ("where declared", never invented). See src/api/endpoint-manifest.ts.
  // The daemon's QE acceptance setting as read now ('required' when the settings cannot be read:
  // fail closed, never off by accident).
  const qeAcceptanceNow = async (): Promise<'required' | 'off'> =>
    qeAcceptanceMode(await Promise.resolve().then(() => adapter.getSettings()).catch(() => null));
  // The `/health.warnings` list, shared with `GET /system`'s daemon row (DES-SYSTEM-VIEW).
  const healthWarningsOf = (
    stateHome: Awaited<ReturnType<NonNullable<typeof runtime.stateHome>['refresh']>> | null,
    baseSkill: ReturnType<NonNullable<typeof runtime.skills>['baseSkill']> | null,
  ) => [
      ...(stateHome === null ? [] : stateHome.findings.map((f) => ({ kind: f.kind, severity: f.severity, message: f.message }))),
      ...(baseSkill?.finding ? [{ kind: baseSkill.finding.kind, severity: baseSkill.finding.severity, message: baseSkill.finding.message }] : []),
      // crew#1149: while the boot ladder publishes, one info line instead of a base-skill error.
      ...[runtime.skills?.publishingFinding() ?? null].filter((f) => f !== null).map((f) => ({ kind: f.kind, severity: f.severity, message: f.message })),
      // crew#753: a garden older than the minimum is a blocking finding on the first screen too.
      ...[gardenBlocker()].filter((f): f is NonNullable<typeof f> => f !== null),
      // DES-TEAMING-002 T0: the daemon's bus did not open at boot, so the engine was handed none
      // and runs un-teamed. A daemon-level notice (status stays ok: it serves); the per-run
      // `transport:"none"` record lands with P1.
      ...(adapter.busUnavailable != null ? [busUnavailableWarning(adapter.busUnavailable)] : []),
      // wicked-core#631: the engine has the bus but not the calls crew reaches it through.
      ...(adapter.busSeamsOff != null ? [busSeamsOffWarning(adapter.busSeamsOff)] : []),
      // crew#742: a seat that runs ungoverned, or floor seats on a host that cannot arm their
      // boundary, are named before any run starts.
      ...seatGovernanceWarnings(seatGovernanceNow(), hostSandboxLauncher()),
      // crew 0.15.2 (#916): a custom seat written council-off with no work flag is now work-eligible
      // by the engine default; each is named once, so the operator can keep it off work.
      ...seatWorkDefaultNow(),
      // crew#1068: the engine has no wicked-vault CLI to record held boundary findings with.
      ...[adapter.vaultBin != null ? vaultBinWarning(adapter.vaultBin) : null].filter((w) => w !== null),
    ];
  // crew#1157: the engine's built-in presets are compiled in, so the chat workflows it carries are
  // read once (on the first probe that can read them) and held until restart.
  let chatWorkflowsHeld: string[] | null = null;
  const chatWorkflowsNow = async (): Promise<string[]> => {
    if (chatWorkflowsHeld !== null) return chatWorkflowsHeld;
    if (typeof adapter.listPresets !== 'function') return [];
    try {
      chatWorkflowsHeld = servedChatWorkflows(await adapter.listPresets());
      return chatWorkflowsHeld;
    } catch {
      return [];
    }
  };
  app.get(`${V}/health`, { config: { manifest: { statusCodes: [200] } } }, async () => {
    const ping = await enginePing();
    // F-E2E-030: what this deployment can keep. A composer reads `capabilities.deliverGate`
    // before it promises "pauses at the deliver gate"; a stub-driven route set without the
    // probe honestly reports no gate.
    const capabilities = {
      ...(typeof adapter.engineCapabilities === 'function'
        ? adapter.engineCapabilities()
        : { deliverGate: false, revisesPr: false, chatIdOnLaunch: false, seatChipOnCreate: false }),
      // C1: `AgentSession.chat_id` is served from the daemon's own launch index, whatever the engine.
      runChatId: true,
      // crew#825: `LaunchRunBody.excludeLinkedIssues` + `POST /linked-issues/preview` are served.
      linkedIssuesExclude: true,
      // ASK-C1 (DES-ASK-TEAM-CHAT-001 §5.1): an ask starts a path — the whole contract is the
      // pinned core-ts floor the adapter reports; an older studio reads ABSENT as "every helper
      // answers", a newer one renders the one PA voice.
      askPath: typeof adapter.engineCapabilities === 'function' ? adapter.engineCapabilities().askPath : false,
      // WT-W1: repo-bound launches mint an evidence root only on an addon that takes the field.
      walkthroughRoots: typeof adapter.evidenceRootsSupported === 'function' ? adapter.evidenceRootsSupported() : false,
      // wicked-core#850: `LaunchRunBody.reducedAssurance` is accepted (the installed addon carries the
      // assurance contract); a one-CLI full-assurance launch answers `assuranceNotice`. A route set
      // that cannot probe the addon reports no capability — never an invented one.
      reducedAssurance: typeof adapter.engineCapabilities === 'function' && addonSupportsReducedAssurance(),
      // QE-IN-APP-WORKFLOWS: `LaunchRunBody.skipQeAcceptance` / `forceQeAcceptance` reach an addon
      // that carries the QE decision; never an invented capability.
      qeAcceptanceOverride: typeof adapter.engineCapabilities === 'function' && addonSupportsQeOverride(),
      // api-types 0.120.0: the daemon's QE acceptance setting, read per probe ('off' = every launch
      // that requires QE acceptance skips it, labelled with the setting).
      qeAcceptance: await qeAcceptanceNow(),
      // api-types 0.128.0: `LaunchRunBody.primary` (the lead agent) is accepted.
      launchPrimary: true,
      // api-types 0.136.0 (DES-SYSTEM-VIEW): `GET /system`, the Nerve Center snapshot, is served.
      system: true,
      // api-types 0.140.0: attention[] is the one needs-you list; unresolved[] + toReview; POST /runs/:id/resolve.
      attentionRanked: true,
      // api-types 0.137.0 (DES-SYSTEM-CHAT): the chat history (list, reopen, close) and attachments.
      chatList: chatHistory !== null,
      chatAttachments: true,
      // api-types 0.141.0 (crew#1157): the read-only workflows `POST /chats {workflow}` runs on THIS
      // engine (`analyze` on a core-ts that carries it); `[]` = plain chats only.
      chatWorkflows: await chatWorkflowsNow(),
      // api-types 0.145.0: the evals, insights and schedules surfaces, read off the route table this
      // daemon serves, so a route set booted without one says false rather than an invented true.
      defaultEvals: app.hasRoute({ method: 'GET', url: `${V}/testing/default-evals/suites` }),
      insights: app.hasRoute({ method: 'GET', url: `${V}/insights` }),
      schedules: app.hasRoute({ method: 'GET', url: `${V}/schedules` }),
    };
    // wicked-core#411 / crew#497: the state-home blocker rides the health probe as a WARNING. The
    // daemon still SERVES (status stays ok — studio must load and show the blocker) but refuses to
    // launch while the state home holds an entry the worker Read fence cannot classify. Re-surveyed
    // per probe (two readdirs) so an entry that appears after boot is reported without a restart;
    // the field is ABSENT when there is nothing to say, and on a route set booted without the watch.
    const stateHome = runtime.stateHome !== undefined ? await runtime.stateHome.refresh() : null;
    // crew#554: the BASE skill posture for the next launch — the composer's confirm line
    // ("discipline skill: <name> gen N" / "MISSING — …"). Cached by the skills runtime: no I/O.
    const baseSkill = runtime.skills?.reportedBaseSkill() ?? null;
    // F-W1-102: the base skill's ERROR rides `warnings` too. A daemon under `require` with no published
    // generation holding the skill (the crew-only install: no wicked-garden) REFUSES every launch at
    // intake — it must never read "status ok, no warnings". The SAME finding object as
    // `baseSkill.finding` and `/diagnostics.skills.findings[]` (one surface, no new field;
    // `HealthWarning.kind` is open); status stays ok because the daemon serves and studio must load
    // and show it — exactly the state-home blocker's precedent above.
    const warnings = healthWarningsOf(stateHome, baseSkill);
    return {
      status: 'ok',
      version: PKG_VERSION,
      ping,
      capabilities,
      baseSkill,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });

  // The daemon's self-knowledge surface (diagnostics): what is deployed, what it stores, what
  // has gone wrong recently, and whether ACP is really working across the CLIs — the answer
  // that previously lived only in raw NDJSON under the state home. READ-ONLY throughout, and
  // honest throughout: a field the daemon cannot answer is null/empty, never fabricated.
  // The ACP fold and the binary probes are cached (briefly / per-process) so a polling skin
  // can never turn this GET into an event-log re-reader or a `--version` spawner per request.
  const acpFoldCache = new AcpFoldCache();
  const engineVersionCache = new EngineVersionCache();
  // The governance block (crew#495): the store the engine's emit seam writes to (as the adapter
  // exported it — `null` on a boot that resolved none), its record count through the engine
  // binding when the addon has one, and the dead-letter outbox folded on change. Built at boot so
  // the record baseline is the boot baseline.
  const governanceDiagnostics = new GovernanceDiagnostics(
    adapter.governanceStore ?? null,
    CoreAdapter.eventStoreCounter(),
    runtime.governanceLegacyOutboxPath === undefined ? legacyHomeOutboxPath() : runtime.governanceLegacyOutboxPath,
  );
  // The diagnostics body, shared by `GET /diagnostics` (the raw dump) and `GET /system` (the
  // Nerve Center snapshot, which carries every block of it on its rows — DES-SYSTEM-VIEW).
  const diagnosticsNow = async () => {
      // `dbPath` is a readonly field of the real adapter; a stub-driven route set may lack it,
      // and diagnostics over an unknown store honestly reports no stores and no ACP record.
      const dbPath = typeof adapter.dbPath === 'string' && adapter.dbPath !== '' ? adapter.dbPath : null;
      const [stores, byCli, engineBinaries, governance] = await Promise.all([
        dbPath !== null ? listStoreFiles(dbPath) : Promise.resolve([]),
        dbPath !== null
          ? acpFoldCache.get(eventsDirOf(dbPath))
          : Promise.resolve<Awaited<ReturnType<AcpFoldCache['get']>>>({}),
        engineVersionCache.get(),
        governanceDiagnostics.health(),
      ]);
      const uptimeMs = Math.round(process.uptime() * 1000);
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 7701;
      return {
        components: {
          crew: PKG_VERSION,
          studioBundle:
            runtime.studioRoot !== undefined ? readStudioBundleVersion(runtime.studioRoot) : null,
          coreTs: installedPackageVersion('wicked-core-ts'),
          engineBinaries,
        },
        daemon: { uptimeMs, startedAt: Date.now() - uptimeMs, port },
        stores,
        recentErrors: runtime.errorRing?.list() ?? [],
        acp: { byCli },
        // The skills seam's last outcome (skills keystone): published / fallback / blocked /
        // config-error, with the `skills.*` findings the ladder produced — the operator's one
        // read-only answer to "why do launches refuse the snapshot".
        // crew#661's `phaseSkillGaps` stays on the wire, always `[]` since crew#935: no seam arms
        // without its declared skill (the interactive presets fail such a run instead).
        skills: withPhaseSkillGaps(runtime.skills?.health() ?? disabledSkillsHealth()),
        // Is the governance evidence LANDING (crew#495): the store, the records on it, the dead
        // letters — with a `governance.deadletter` finding the moment the outbox holds one.
        governance,
        // DC-S4b: the chat recorder's per-CLI `wicked-decisions` compliance (null without the chat host).
        decisions: chatRecorder?.diagnostics() ?? null,
        // The state-home classification (wicked-core#411 / crew#497): which state home the worker
        // Read fence classifies, every entry it cannot classify there (top level and skills root),
        // who classified (the engine, or crew's registry copy on an older addon) and whether that
        // refuses launches — re-surveyed per read. `null` on a route set booted without the watch.
        stateHome: runtime.stateHome !== undefined ? await runtime.stateHome.refresh() : null,
        // crew#742: per seat — transport, the record's OS sandbox, the engine's governance class,
        // input governance enforced / claimed / unenforced, the mode per scope kind; plus the
        // registry overlay file and this host's OS launcher.
        seatGovernance: {
          rosterFile: seatRosterFile(),
          hostBoundary: hostSandboxLauncher(),
          seats: seatGovernanceNow(),
          // The same `seat.work_default` findings `/health.warnings` carries (api-types 0.133.0).
          roleFindings: seatWorkDefaultNow(),
        },
        // crew#740: which memory store this daemon reads and writes, and the isolation notice.
        memoryStore: memoryStoreInfo(),
        // crew#1068: the wicked-vault CLI handed to the engine, with a remedy when it has none.
        // `null` on a route set driven without the real adapter.
        vault: adapter.vaultBin != null ? vaultDiagnostics(adapter.vaultBin) : null,
      };
  };
  app.get(
    `${V}/diagnostics`,
    { config: { manifest: { responseType: 'DiagnosticsResponse', statusCodes: [200] } } },
    async () => diagnosticsNow(),
  );

  // Who am I talking to the daemon as? (task #88). In local mode this is
  // always the implicit full-trust local actor; in required mode it names the
  // token's actor — the cheap probe a skin uses to decide what to render.
  app.get(`${V}/whoami`, async (req) => ({
    actor: actorOf(req),
    authMode: security.authMode,
  }));

  // The actor audit trail (task #88): who launched/steered/governed what.
  // Read-only (observer trust); newest first; `?runId=` / `?action=` / `?limit=` / `?since=`.
  // `since` (unix millis, inclusive) is the lower time bound a skin's "while you were away"
  // handover reads — the trail since the operator's last visit (studio wave 2b).
  app.get(
    `${V}/audit`,
    { config: { manifest: { responseType: 'AuditPage', statusCodes: [200, 400, 500] } } },
    async (req, reply) => {
      const q = req.query as {
        runId?: string | string[];
        action?: string | string[];
        limit?: string | string[];
        since?: string | string[];
      };
      const first = (v: string | string[] | undefined): string | undefined =>
        (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
      const runId = first(q.runId);
      const action = first(q.action);
      const limitRaw = first(q.limit);
      // Reject partial-numeric strings like "10abc" — parseInt accepts those,
      // Number() is strict and returns NaN for them (Copilot, #250).
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
      if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit as number) < 1 || !Number.isInteger(limit))) {
        return reply.code(400).send({ error: '`limit` must be a positive integer' });
      }
      // Same strict parse as `limit`, but zero is a valid clock (the epoch).
      const sinceRaw = first(q.since);
      const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
      if (sinceRaw !== undefined && (!Number.isInteger(since) || (since as number) < 0)) {
        return reply.code(400).send({ error: '`since` must be a non-negative integer (unix millis)' });
      }
      try {
        const entries = await audit.read({
          ...(runId !== undefined ? { runId } : {}),
          ...(action !== undefined ? { action } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(since !== undefined ? { since } : {}),
        });
        return { entries };
      } catch (err) {
        return reply.code(500).send({ error: message(err) });
      }
    },
  );

  // Report the actually-bound port/host (honours --port / CREW_PORT / port 0).
  app.get(`${V}/config`, async () => {
    const addr = app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 7701;
    const host = typeof addr === 'object' && addr ? addr.address : '127.0.0.1';
    return { port, host };
  });

  // The council seats for the launch form (static production roster), each carrying its RUNTIME
  // health (crew#274) and its STANDING (F-2R2-009) — `api/roster-standing.ts` is the ONE accessor
  // every launch path shares (F-RECON-002/003: the interactive seams, the adapter's onboarding
  // launch and `wicked-crew start` used to hand the engine the RAW registry roster, so signed-out
  // seats were convened and even elected). `createServer` injects the daemon's single instance
  // (built over the same `seatHealth`); a directly-driven route set builds an equivalent one here.
  // `POST /chats` seats its defaults through the SAME standing, so the roster and the chat never
  // disagree about a seat.
  const seatLoginDeps: SeatLoginDeps = seatLoginDepsFor(adapter.dbPath, runtime.seatLoginExec);
  const containerStatus = runtime.rosterWithStanding?.containerStatus ?? new SeatContainerStatus(seatLoginDeps);
  const rosterWithStanding: RosterWithStanding =
    runtime.rosterWithStanding ?? rosterWithStandingFactory({ seatHealth, signedIn, containerStatus });
  // A3b (DES-seats-page): `?refresh=<key>` re-runs that seat's sign-in check now and waits for it,
  // bounded, so the Agents page's "I've signed in: check again" reads the seat's fresh answer, not
  // the probe cache's 30-second-old one. A read with no parameter never waits.
  app.get(
    `${V}/roster`,
    { config: { manifest: { responseType: 'RosterResponse', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const raw = (req.query as { refresh?: string | string[] }).refresh;
      if (raw === undefined) return { roster: markOptIn(rosterWithStanding()) };
      const key = Array.isArray(raw) ? undefined : raw.trim();
      if (key === undefined || key === '' || !rosterWithStanding().some((s) => s.key === key)) {
        return reply.code(400).send({ error: `Invalid ?refresh — expected one roster seat key, got ${JSON.stringify(raw)}` });
      }
      const outcome = rosterWithStanding.recheck !== undefined ? await rosterWithStanding.recheck(key, ROSTER_REFRESH_WAIT_MS) : 'not_probed';
      return { roster: markOptIn(rosterWithStanding()), refresh: { key, outcome } };
    },
  );
  /** crew#742: the seats' governance standing, read from the standing roster (empty when the
   *  roster cannot be read — the roster route reports that failure itself). */
  const seatGovernanceNow = (): SeatGovernanceDiagnostic[] => {
    try {
      return seatGovernanceDiagnostics(rosterWithStanding() as unknown as DiagnosticSeatInput[]);
    } catch {
      return [];
    }
  };

  // Each seat's week (studio's weekly 1:1 per agent; api-types 0.52.0): units, first pass, rework,
  // stalls, bench and cost, folded from the runs' durable event logs by `seatRecord` — nothing new
  // is stored. The daemon's remembered stall frames join the engine's, as on `/runs/:id/events`.
  app.get(
    `${V}/roster/record`,
    { config: { manifest: { responseType: 'SeatRecordResponse', statusCodes: [200, 400, 503] } } },
    async (req, reply) => {
      const raw = (req.query as { days?: string | string[] }).days;
      let days = SEAT_RECORD_DEFAULT_DAYS;
      if (raw !== undefined) {
        const one = Array.isArray(raw) ? undefined : raw;
        const n = one !== undefined && /^[1-9][0-9]?$/.test(one) ? Number(one) : NaN;
        if (!(n >= 1 && n <= SEAT_RECORD_MAX_DAYS)) {
          return reply.code(400).send({ error: `Invalid ?days — expected one whole number from 1 to ${SEAT_RECORD_MAX_DAYS}, got ${JSON.stringify(raw)}` });
        }
        days = n;
      }
      // api-types 0.113.0: `?project=<id>` folds only that project's runs (the dashboards' spend);
      // the answer echoes it, so a skin can tell a scoped answer from an older daemon's global one.
      const rawProject = (req.query as { project?: string | string[] }).project;
      if (rawProject !== undefined && (Array.isArray(rawProject) || rawProject.trim() === '')) {
        return reply.code(400).send({ error: 'Invalid ?project — expected one project id' });
      }
      const project = rawProject?.trim();
      const detail = await adapter.sessionsDetail();
      await backfillEndedAt(detail);
      const all = detail.map(decorateRun);
      const views = project === undefined ? all : all.filter((v) => v.session.project_id === project);
      const out = await seatRecord(
        views,
        async (id) => {
          const engine = await adapter.runEvents(id);
          if (engine === null) return null;
          const daemon = runtime.stallFrames?.(id) ?? [];
          return daemon.length === 0 ? engine : [...engine, ...(daemon as unknown as RecordedEvent[])];
        },
        { days, now: Date.now() },
      );
      if (out === null) {
        return reply.code(503).send({ error: 'Seat records are unavailable: this wicked-core build has no event-log read binding' });
      }
      return project === undefined ? out : { ...out, project };
    },
  );

  // Open a file/folder with the OS default application (crew#273) — the studio Files tab's
  // click-to-open. The open MUST happen daemon-side (the SPA cannot spawn a process), which is
  // why the path is validated first: absolute, and inside one of the caller-visible roots — the
  // run's workdir + extra write roots (when `runId` is given) or a registered repo root. The
  // run's QE evidence/decisions dirs (`.wicked-qe`/`.wicked-testing`) live under the repo root,
  // so the repo-root rule covers them. Never an arbitrary path.
  app.post(`${V}/open`, async (req, reply) => {
    const parsed = OpenPathSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid open request'));
    }
    const { path: rawPath, runId } = parsed.data;
    if (!isAbsolute(rawPath)) {
      return reply.code(400).send({ error: '`path` must be an absolute path' });
    }
    const target = resolve(rawPath);
    let roots: string[];
    try {
      let session: SessionView['session'] | undefined;
      if (runId !== undefined) {
        const views = await adapter.sessionsDetail();
        const view = views.find((v) => v.session.id === runId);
        if (view === undefined) {
          return reply.code(404).send({ error: `unknown run: ${runId}` });
        }
        session = view.session;
      }
      roots = allowedRootsFor(session, await adapter.listRepos());
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
    if (!roots.some((root) => isInsideRoot(root, target))) {
      return reply.code(403).send({
        error:
          "path is outside every allowed root (the run's workdir/write roots and the registered repos)",
      });
    }
    try {
      await openWithOs(target);
    } catch (err) {
      return reply.code(502).send({ error: `could not open ${target}: ${message(err)}` });
    }
    return { status: 'opened' };
  });

  // ── Run file & diff reads (DES-FEEDBACK-002 CREW-1) ────────────────────────
  // The studio's in-app viewer (P0-3). Both routes are GET-only assembly of reviewed machinery:
  // the SAME containment `POST /open` runs (`allowedRootsFor` + fail-closed `isInsideRoot`) over
  // the SAME root set (run workdir + extra write roots + registered repo roots), capped payloads,
  // and `execCapped` git with argv arrays. Threat delta over /open is strictly smaller: these only
  // return bytes the daemon can already read inside the same containment — no OS opener, no write.

  /** Resolve `:id` → the run's session, and the contained target from `?path=` when present.
   *  Shared by both routes so their validation ladders (404 unknown run → 400 non-absolute →
   *  403 outside every root) cannot drift. Returns `null` after replying. */
  const resolveRunPath = async (
    reply: FastifyReply,
    id: string,
    rawPath: string | undefined,
  ): Promise<{ session: SessionView['session']; target?: string } | null> => {
    let session: SessionView['session'];
    let roots: string[];
    try {
      const views = await adapter.sessionsDetail();
      const view = views.find((v) => v.session.id === id);
      if (view === undefined) {
        await reply.code(404).send({ error: `unknown run: ${id}` });
        return null;
      }
      session = view.session;
      if (rawPath === undefined) return { session };
      roots = allowedRootsFor(session, await adapter.listRepos());
    } catch (err) {
      await reply.code(500).send({ error: message(err) });
      return null;
    }
    if (!isAbsolute(rawPath)) {
      await reply.code(400).send({ error: '`path` must be an absolute path' });
      return null;
    }
    const target = resolve(rawPath);
    if (!roots.some((root) => isInsideRoot(root, target))) {
      await reply.code(403).send({
        error:
          "path is outside every allowed root (the run's workdir/write roots and the registered repos)",
      });
      return null;
    }
    return { session, target };
  };

  // Fastify parses a repeated param as string[] (Copilot, #250/#266). These are FILE-READ
  // routes: `?path=a&path=b` is rejected outright (400) rather than silently reading as
  // either (Copilot, #305).
  const REPEATED_PATH = Symbol('repeated path param');
  const singlePathQ = (
    v: string | string[] | undefined,
  ): string | undefined | typeof REPEATED_PATH =>
    Array.isArray(v) ? REPEATED_PATH : v?.trim() || undefined;

  // File content from the run's contained roots: 512 KB cap (`truncated: true` past it, first
  // 512 KB served), NUL-in-first-8KB binary sniff (`binary: true`, `content: ""`). Read-only by
  // construction (`fs` read); no directory listing — the studio already has the file list.
  app.get(`${V}/runs/:id/files`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const rawPath = singlePathQ((req.query as { path?: string | string[] }).path);
    if (rawPath === REPEATED_PATH) {
      return reply.code(400).send({ error: '`path` may be given at most once' });
    }
    if (rawPath === undefined) {
      return reply.code(400).send({ error: '`path` query parameter is required' });
    }
    const resolved = await resolveRunPath(reply, id, rawPath);
    if (resolved === null) return reply;
    const target = resolved.target as string;
    try {
      const read = await readFileCapped(target);
      return { path: target, ...read };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(404).send({ error: `no such file: ${target}` });
      }
      if (err instanceof NotARegularFileError) {
        return reply.code(400).send({ error: `\`path\` is not a regular file: ${target}` });
      }
      return reply.code(500).send({ error: message(err) });
    }
  });

  // The run's worktree diff against HEAD — or, with `?base=` (CREW-UX-1, DES-UX-001 §8.1),
  // against the run branch's fork point (`base=merge-base`) or a plain in-repo ref, so committed
  // run work is visible. Staged + unstaged; untracked appended as all-addition `--no-index`
  // hunks; whole-tree or `?path=` narrowed. 1 MB output cap. `diff: ""` is a real answer (clean
  // tree), not an error. 409 — not 404 — when the run has no workdir or the workdir has been
  // reaped: the RUN exists; what is gone is the thing to diff against. `base` is a baseline,
  // NEVER a command surface: anything that is not the merge-base literal or a plain resolvable
  // ref (flags, paths, ranges, separators) is a named 400 before any git process sees it.
  app.get(`${V}/runs/:id/diff`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { path?: string | string[]; base?: string | string[] };
    const rawPath = singlePathQ(q.path);
    if (rawPath === REPEATED_PATH) {
      return reply.code(400).send({ error: '`path` may be given at most once' });
    }
    const rawBase = singlePathQ(q.base);
    if (rawBase === REPEATED_PATH) {
      return reply.code(400).send({ error: '`base` may be given at most once' });
    }
    const resolved = await resolveRunPath(reply, id, rawPath);
    if (resolved === null) return reply;
    const workdir = resolved.session.workdir;
    /** The route's one error mapping, shared by the worktree and the branch reads. */
    const diffError = (err: unknown) => {
      // Named 400s (§8.1): malformed base (not a plain ref) and well-formed-but-unresolvable
      // base are both client errors, each with its error name in the body — never a git 500.
      if (err instanceof InvalidDiffBaseError || err instanceof UnresolvableDiffBaseError) {
        return reply.code(400).send({ error: `${err.name}: ${message(err)}` });
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      // execCapped throws (no partial output attached) past its 64 MiB daemon-wide buffer —
      // beyond graceful truncation, so the answer is an explicit, actionable refusal
      // rather than a generic 500 (Copilot, #305).
      if (err instanceof ExecOutputTooLarge) {
        return reply.code(507).send({
          error: "diff output exceeds the server's execution buffer — narrow the request with ?path=",
        });
      }
      // crew#790: git stopped before it answered (the daemon's 10 s timeout on a busy host) is not a
      // server fault to report as a bare 500 — say it is busy and when to ask again.
      if (isGitStopped(err)) {
        return reply
          .code(503)
          .header('retry-after', '5')
          .send({ error: 'git did not answer in time — the host is busy; try again shortly', code: 'diff_busy' });
      }
      return reply.code(500).send({ error: message(err) });
    };
    const worktreeLive = typeof workdir === 'string' && workdir.length > 0 && existsSync(workdir);
    /** The run branch's diff, when the worktree is gone (or went while this request ran). */
    const fromBranchOr409 = async () => {
      // Wave 6 (F-7R2-013): the engine reaps a completed run's worktree, and the run page went dark
      // (`409 workdir no longer exists`). The run's WORK is not gone — it lives on the `wicked/<id>`
      // branch of the registered repo, and the wave-6 engine records `run_branch` + `base_commit`
      // on the session. Serve the diff from the BRANCH (`source: 'branch'`): the recorded branch
      // (else `wicked/<id>`) against the recorded base (else its merge-base with the default
      // branch), `?base=<ref>` overriding the base with a plain in-repo ref. Only when there is
      // neither a worktree nor a branch does the 409 stand — and then it says so.
      const repoRef = resolved.session.repo_ref;
      const root = repoRef !== null ? await repoRootOf(repoRef) : undefined;
      if (root !== undefined) {
        const session = resolved.session as typeof resolved.session & {
          run_branch?: string;
          base_commit?: string;
        };
        const branch =
          typeof session.run_branch === 'string' && session.run_branch !== '' ? session.run_branch : `wicked/${id}`;
        let base: string | null =
          typeof session.base_commit === 'string' && session.base_commit !== '' ? session.base_commit : null;
        if (rawBase !== undefined && rawBase !== '' && rawBase !== MERGE_BASE_LITERAL) {
          if (!isPlainRef(rawBase)) {
            return reply.code(400).send({
              error: `InvalidDiffBaseError: \`base\` must be the literal '${MERGE_BASE_LITERAL}' or a plain git ref`,
            });
          }
          base = rawBase;
        }
        // Narrowing: a path under the (gone) worktree or under the repo root, made repo-relative.
        let rel: string | undefined;
        if (resolved.target !== undefined) {
          // The worktree first: engine worktrees live UNDER the repo root (`wicked-worktrees/<id>`),
          // and a path inside one is worktree-relative on the branch (codex r1).
          if (typeof workdir === 'string' && workdir.length > 0 && isInsideRoot(workdir, resolved.target)) {
            rel = relative(workdir, resolved.target);
          } else if (isInsideRoot(root, resolved.target)) {
            rel = relative(root, resolved.target);
          } else {
            return reply.code(400).send({
              error: `\`path\` must be inside the run's worktree or its repository to diff: ${root}`,
            });
          }
        }
        try {
          const fromBranch = await branchDiff(root, branch, base, rel);
          if (fromBranch !== null) return fromBranch;
        } catch (err) {
          return diffError(err);
        }
      }
      if (typeof workdir !== 'string' || workdir.length === 0) {
        return reply.code(409).send({ error: `run ${id} has no workdir and no run branch — nothing to diff` });
      }
      return reply.code(409).send({
        error: `run ${id}'s workdir no longer exists (${workdir}) and its run branch holds no commits — nothing to diff`,
      });
    };
    if (!worktreeLive) return fromBranchOr409();
    // crew#1057: the delivered-worktree sweep (`git worktree remove`) deletes the worktree's files,
    // its `.git` link among them, BEFORE the directory itself. A bound run's worktree with no `.git`
    // link is being swept: git run in it finds the registered repo above it instead, and answers
    // about that checkout (an empty diff) or fails with no named error ("no merge base between
    // origin/main and HEAD"). Such a worktree is gone, checked before the read and again after it.
    const bound = resolved.session.repo_ref !== null;
    const worktreeIntact = () => existsSync(workdir) && (!bound || existsSync(join(workdir, '.git')));
    if (!worktreeIntact()) return fromBranchOr409();
    // Narrowing is WORKTREE-scoped: a contained-but-outside-the-worktree path (extra write
    // root / repo root) is a valid FILE read but has no meaning as a diff pathspec — rejected
    // explicitly here rather than handing git a `../`-prefixed pathspec and surfacing its
    // "outside repository" error as a 500 (Copilot, #305).
    if (resolved.target !== undefined && !isInsideRoot(workdir, resolved.target)) {
      return reply.code(400).send({
        error: `\`path\` must be inside the run's worktree to diff: ${workdir}`,
      });
    }
    const rel = resolved.target === undefined ? undefined : relative(workdir, resolved.target);
    // crew#790: with no `?base=`, the baseline is the engine-recorded `base_commit` (the commit the
    // run's worktree forked from), not HEAD — a delivered run has committed its work, so a HEAD diff
    // read empty. Committed and uncommitted run work both show; `base` names it. A recorded base
    // that does not resolve in the worktree falls back to HEAD (the pre-#790 answer), never a 400 for
    // a parameter the caller did not send.
    const recordedBase = (resolved.session as { base_commit?: unknown }).base_commit;
    const defaultBase =
      (rawBase === undefined || rawBase === '') && typeof recordedBase === 'string' && isPlainRef(recordedBase) ? recordedBase : undefined;
    try {
      if (defaultBase !== undefined) {
        try {
          const read = await worktreeDiff(workdir, rel, defaultBase);
          if (!worktreeIntact()) return fromBranchOr409();
          return { ...read, source: 'worktree' as const, base: defaultBase };
        } catch (err) {
          if (!(err instanceof UnresolvableDiffBaseError)) throw err;
        }
      }
      const read = await worktreeDiff(workdir, rel, rawBase);
      if (!worktreeIntact()) return fromBranchOr409();
      return { ...read, source: 'worktree' as const };
    } catch (err) {
      // The worktree was removed WHILE this request ran (the delivered-worktree sweep, an engine
      // reap). Whatever git said — a spawn into the vanished cwd fails ENOENT (the 0.9.1 release
      // smoke), a git already running exits 128 "Unable to read current working directory" (the
      // 0.9.3 one) — a diff that failed over a worktree that is gone now serves the run branch, as
      // for a worktree that was already gone. A ref the CALLER named that does not resolve stays the
      // caller's 400 (codex r1). The `merge-base` literal names no ref: when the worktree is being
      // swept, its failure is the sweep's, not the caller's (crew#1057).
      const callersRef = err instanceof UnresolvableDiffBaseError && err.base !== MERGE_BASE_LITERAL;
      if (!callersRef && !worktreeIntact()) return fromBranchOr409();
      return diffError(err);
    }
  });

  // Registered repos → target-repo picker.
  app.get(`${V}/repos`, async () => ({ repos: await adapter.listRepos() }));

  /** Filing for an onboarding run: what `POST /runs` does for a launch, for the runs `POST /repos`
   *  and `POST /repos/:id/onboard` start (crew#496). The launch entry (`run.launched`, which dates
   *  the run and names who started it) is always written; with a `projectId` the run joins that
   *  project. The run is LIVE by then, so a filing failure is named in the answer, never a 4xx. */
  const recordOnboardingLaunch = async (
    req: FastifyRequest,
    runId: string,
    repoId: string,
    opts: { projectId?: string | undefined; channel?: string | undefined; actor?: string | undefined; autoCapture?: boolean | undefined },
  ): Promise<string | undefined> => {
    recordRunLaunched(audit, runTimingIndex, actorOf(req), runId, {
      workflow: 'onboarding',
      repoRef: repoId,
      ...(opts.autoCapture === false ? { autoCapture: false } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    });
    if (opts.projectId === undefined) return undefined;
    try {
      const { member } = await adapter.projectMemberAttach(opts.projectId, 'crew.run', runId, { onboarding: true }, actorOf(req).id);
      projects.index.set(runId, opts.projectId);
      projects.bus?.emit(
        MEMBERSHIP_ATTACHED,
        { project_id: opts.projectId, member: { kind: 'crew.run', ref: runId }, actor: actorOf(req).id },
        membershipAttachedKey(opts.projectId, 'crew.run', runId, member.attached_at),
      );
      return undefined;
    } catch (err) {
      req.log.warn({ runId, projectId: opts.projectId }, `onboarding run filing failed: ${message(err)}`);
      return message(err);
    }
  };

  /**
   * crew#753: what refuses an onboarding launch, judged BEFORE anything is registered — so a
   * refused onboard leaves no repo row (core has no unregister). The same three intake refusals a
   * launch meets: a garden older than the minimum (422 `garden_required`), the state-home blocker
   * (409) and a base skill the handed generation lacks, e.g. no garden at all (422
   * `base_skill_refused`). `null` when the launch would be admitted.
   */
  const onboardRefusal = async (): Promise<{ status: number; body: unknown } | null> => {
    await skillsLanded();
    const garden = gardenRefusalBody();
    if (garden !== null) return { status: 422, body: garden };
    if (runtime.stateHome !== undefined) {
      const stateHome = await runtime.stateHome.refresh();
      if (stateHome.refusesLaunches) return { status: 409, body: stateHomeBlockerBody(stateHome) };
    }
    const posture = runtime.skills?.baseSkill() ?? null;
    if (posture !== null && !posture.present && posture.finding !== null) {
      return {
        status: 422,
        body: { code: 'base_skill_refused', error: posture.finding.message, baseSkill: posture, remedy: baseSkillRemedy(posture.inCatalog) },
      };
    }
    return null;
  };

  /**
   * crew#1019/#1030: local and remote registration is durable even when onboarding cannot launch
   * (core has no unregister). A registered repo returns 201 with `onboardRunId: null` and
   * `onboardError` on launch failure, so callers can attach it to their project and retry onboarding.
   */
  app.post(`${V}/repos`, async (req, reply) => {
    const parsed = RegisterRepoSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const refused = await onboardRefusal();
    if (refused !== null) return reply.code(refused.status).send(refused.body);
    const { name, rootPath, gitUrl, projectId, channel, actor, autoCapture } = parsed.data;
    let repo: RepoEntry | undefined;
    let runId: string;
    try {
      if (gitUrl) {
        // Remote: clone to rootPath (if provided) or default ~/.wicked/repos/<name>,
        // register, and launch onboarding run.
        repo = await adapter.cloneAndRegister(name, gitUrl, rootPath);
        runId = await adapter.launchOnboardingRun(repo.id, name);
      } else {
        // Local: register then launch onboarding run.
        repo = await adapter.registerRepo(name, rootPath!);
        runId = await adapter.launchOnboardingRun(repo.id, name);
      }
    } catch (err) {
      if (repo === undefined) return reply.code(400).send({ error: message(err) });
      req.log.warn({ repoId: repo.id }, `repo registered but onboarding launch failed: ${message(err)}`);
      // No run exists to record or file, even when projectId was supplied (crew#1019).
      return reply.code(201).send({ repo, onboardRunId: null, onboardError: message(err) });
    }
    const projectAttachError = await recordOnboardingLaunch(req, runId, repo.id, { projectId, channel, actor, autoCapture });
    return reply.code(201).send({ repo, onboardRunId: runId, ...(projectAttachError !== undefined ? { projectAttachError } : {}) });
  });

  // Return the onboarding run id for a repo (so the UI can navigate to it).
  app.get(`${V}/repos/:id/onboard`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const runId = adapter.getOnboardRunId(id) ?? null;
    return reply.code(200).send({ runId });
  });

  // Re-run (or run for the first time) the onboarding workflow for a registered repo.
  app.post(`${V}/repos/:id/onboard`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const body = OnboardBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send(invalidBody(body.error, 'Invalid request body'));
    const refused = await onboardRefusal();
    if (refused !== null) return reply.code(refused.status).send(refused.body);
    let runId: string;
    try {
      runId = await adapter.launchOnboardingRun(repo.id, repo.name);
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
    const projectAttachError = await recordOnboardingLaunch(req, runId, repo.id, body.data);
    return reply.code(201).send({ runId, ...(projectAttachError !== undefined ? { projectAttachError } : {}) });
  });

  // crew#825: what a workflow launch WOULD append — the same reading `POST /runs` does, before Send,
  // so the composer shows "N linked issues will be appended (≈K chars)" with a way to leave one out
  // (`excludeLinkedIssues`). Read-only: nothing launches, nothing is stored.
  const LinkedIssuesPreviewSchema = z
    .object({
      problem: z.string().min(1),
      repoRef: z.string().min(1).optional(),
      excludeLinkedIssues: ExcludeLinkedIssuesSchema,
    })
    .strict();
  app.post(
    `${V}/linked-issues/preview`,
    { config: { manifest: { requestType: 'LinkedIssuesPreviewBody', responseType: 'LinkedIssuesPreviewResponse', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const parsed = LinkedIssuesPreviewSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
      const b = parsed.data;
      // The launch's own best-effort contract (codex on this PR): a resolver fault launches on the
      // intent alone, so the preview answers "nothing appended" and says why — never a 500.
      try {
        const root = b.repoRef !== undefined ? await repoRootOf(b.repoRef) : undefined;
        const linked = await readLinkedIssues(b.problem, root, b.repoRef, b.excludeLinkedIssues ?? []);
        return { issues: linked.issues, appendedChars: linked.block === null ? 0 : linked.block.length + 2 };
      } catch (err) {
        req.log.warn(`linked-issue preview failed; a launch would run on the intent alone: ${message(err)}`);
        return { issues: [], appendedChars: 0, error: `linked issues could not be read: ${message(err)} — a launch now runs on the intent alone` };
      }
    },
  );

  // Launch a run (replaces POST /sessions). `clisJson` defaults to the roster;
  // `sessionId` is minted if the client omits it.
  app.post(
    `${V}/runs`,
    {
      config: {
        manifest: {
          requestType: 'LaunchRunBody',
          responseType: 'LaunchRunResponse',
          // 404/409: unknown project / unknown campaignId (wicked-studio#27) /
          // archived-or-synthesized project + busy engine + the state-home blocker
          // (`state_home_unregistered`) + a roster with no eligible seat (`no_eligible_seat`,
          // wicked-core#461 — see the catch below); 400: zod reject or a retryOf naming no
          // existing run; 422: the base-skill intake refusal (`base_skill_refused`, crew#554);
          // 501: campaignId attach on an engine addon without the campaign bindings ("upgrade
          // the engine").
          statusCodes: [201, 400, 404, 409, 422, 501],
        },
      },
    },
    async (req, reply) => {
    const parsed = LaunchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const b = parsed.data;
    // The demo preset launches only from POST /projects/:id/demo (api/recording.ts), which mints the run's
    // demo root and brief first: launched here directly it would have neither.
    if (b.workflow === DEMO_PRESET && (b.sessionId === undefined || !demoLaunchRoots.has(b.sessionId))) {
      return reply.code(400).send({
        error: 'the demo preset launches from POST /projects/:id/demo, which makes its demo root and brief; POST /runs does not take it directly',
      });
    }
    // wicked-core#411 / crew#497: the state-home blocker, judged BEFORE anything is resolved or
    // committed. While the handed skills snapshot derives a state home with an entry the worker
    // Read fence cannot classify, the engine refuses this launch at intake (and an engine before
    // that fix refused it at the run's first worker, after councils and the intake gate) — so the
    // daemon answers the typed 409 itself, naming every entry and the remedy, until they are gone.
    // Re-surveyed per launch: the entries named are the ones there NOW — after the skills ladder
    // decided the snapshot (crew#1145), which the survey and the garden check below both read.
    await skillsLanded();
    if (runtime.stateHome !== undefined) {
      const stateHome = await runtime.stateHome.refresh();
      if (stateHome.refusesLaunches) {
        return reply.code(409).send(stateHomeBlockerBody(stateHome));
      }
    }
    // crew#753: a garden older than the minimum refuses the launch by name (found vs required).
    const garden = gardenRefusalBody();
    if (garden !== null) return reply.code(422).send(garden);
    // crew#645: an expired login reads signed out BEFORE routing — wait (bounded) for every seat's
    // missing or stale login check, so the standing below is the seats' own answer.
    if (b.clisJson === undefined) await rosterWithStanding.ready?.();
    const input: LaunchRunInput = {
      problem: b.problem,
      sessionId: b.sessionId ?? randomUUID(),
      // The default roster carries crew's STANDING (wave 6, the crew half of F-7R2-006): the adapter
      // translates `council_eligible: false` into the engine's per-seat bench verdict at launch
      // (`core/engine-roster.ts`), so a signed-out seat is never convened, never a judge.
      // (operator ruling 2026-10-11) …minus the opt-in seats (opencode): a launch gets one only
      // when it names it.
      clisJson: b.clisJson ?? JSON.stringify(launchRosterNaming(rosterWithStanding(), b.primary)),
    };
    // A capture launch (api/capture.ts) reads its materials from a per-run inbox outside every
    // sandbox: the capture route registered it under the run id it minted.
    // (DES-TEAMING-002 §8.1) The operator's lead-agent choice: crew owns eligibility, the engine
    // owns the pick. A key that is not in the launch roster, or names a seat the roster marks
    // signed out, is refused here by name — never handed to the engine to fall back silently.
    if (b.primary !== undefined) {
      const refusal = primaryRefusal(b.primary, input.clisJson);
      if (refusal !== null) return reply.code(400).send({ error: refusal });
      input.primary = b.primary;
    }
    const captureRoot = captureLaunchRoots.get(input.sessionId);
    if (captureRoot !== undefined) input.extraWriteRoots = [captureRoot];
    // A demo launch (api/recording.ts) writes every file into the demo root the demo route minted for it.
    const demoRoot = demoLaunchRoots.get(input.sessionId);
    if (demoRoot !== undefined) input.extraWriteRoots = [demoRoot];
    if (b.entityMode !== undefined) input.entityMode = b.entityMode;
    if (b.humanConfirm !== undefined) input.humanConfirm = b.humanConfirm;
    // F-E2E-030: only the explicit `'auto'` opts out of the engine's deliver gate. `'human'` and
    // an omitted field both leave `autoDeliver` off the input — the gate is the engine's default,
    // so the wire never has to say "gate me" to be gated.
    // The daemon's QE acceptance setting, read ONCE for this launch: the deliverGate check below and
    // the skip handed to the engine come from the same reading (core/qe-acceptance-setting.ts).
    // An addon without the QE decision enforces none, so the setting has nothing to skip on it.
    const qeMode = addonSupportsQeOverride() ? await qeAcceptanceNow() : 'required';
    const qeRequired = b.deliverGate === 'auto' || qeMode === 'off' ? await launchRequiresQe(adapter, b.workflow, b.projectId) : false;
    const settingSkip = qeSettingSkipReason(qeMode, { skipQeAcceptanceReason: b.skipQeAcceptance?.reason, forceQeAcceptance: b.forceQeAcceptance }, qeRequired);
    if (b.deliverGate === 'auto') {
      // wicked-core#850 EX-03: a workflow that requires QE acceptance delivers only through the deliver
      // gate, where crew checks the verdict. Unattended delivery would push before anyone could.
      // QE-IN-APP-WORKFLOWS: an explicit operator skip leaves no verdict to check, so it may. A name
      // the engine resolves to a built-in preset that requires QE acceptance is judged by that preset
      // (the engine resolves a preset before any def, so a def of the same name never speaks for it).
      // The daemon's `qeAcceptance: 'off'` setting skips it the same way (resolved once, above, and
      // handed to the engine with this launch), unless this launch forces QE acceptance.
      // Refused on the CONSERVATIVE reading (a built-in QE name or a QE def counts even when a project
      // preset shadows it now): only an explicit or setting skip lets QE work deliver unattended.
      if (mayRequireQe(adapter, b.workflow, qeRequired) && b.skipQeAcceptance === undefined && settingSkip === undefined) {
        // `code` is the same stable token a refused delivery carries (QeAcceptanceRefusal.code), so a
        // client can say "this failed because QE acceptance is required" without parsing the sentence.
        return reply.code(400).send({
          code: QE_ACCEPTANCE_REQUIRED_CODE,
          error:
            `workflow ${b.workflow} requires QE acceptance (required_instruments: qe_acceptance), so it delivers only ` +
            'through the deliver gate, where the verdict is checked — deliverGate: "auto" cannot apply to it ' +
            '(unless the launch explicitly skips QE acceptance with a reason: skipQeAcceptance)',
        });
      }
      input.autoDeliver = true;
    }
    if (b.repoRef !== undefined) input.repoRef = b.repoRef;
    if (b.workflow !== undefined) input.workflow = b.workflow;
    // DES-TEAMING-002 T3: the plan is the ENGINE's to propose, score, floor and gate — crew
    // forwards the command and publishes nothing (§4.0).
    if (b.plan !== undefined) input.plan = toLaunchPlan(b.plan);
    if (b.projectId !== undefined) {
      input.projectId = b.projectId;
      // A project is a CONTEXT (crew#326): a run filed into one should see the project's whole
      // co-located graph, not just its own repo's. Resolved — never REFRESHED — at launch: a
      // launch that silently indexed N repos would block this response for as long as the slowest
      // of them takes, so a missing or stale graph degrades to the repo graph and says why.
      //
      // The decision is recorded either way. "This run sees the project" and "this run sees one
      // repo, because X" are both facts about what the run could observe, and the second is the one
      // an operator needs when a worker reports that a sibling repo does not exist.
      const decision = await resolveProjectGraphBinding(adapter, b.projectId, b.repoRef);
      if (decision.binding !== null) input.projectGraph = decision.binding;
      req.log.info(
        { runId: input.sessionId, projectId: b.projectId, repoRef: b.repoRef ?? null },
        `run ${input.sessionId}: ${decision.reason}`,
      );
    }
    // The delivery contract (crew#393): a completed code run must end with a reviewable
    // deliverable, or an explicit, recorded decision not to. So the deliver option is resolved
    // HERE, at the boundary, for every launch:
    //   - explicit 'pr' / 'none' wins (the operator decided);
    //   - omitted + repo-scoped + a CODE-WORK workflow (the def carries at least one
    //     `executes_code` phase that is NOT an evaluator — feature/bug/migration and a Tool
    //     phase that writes, not chat/onboarding/recon, and not domain-extraction, whose only
    //     code phase is the `coverage` EVALUATOR, which executes code solely to write its own
    //     report into the tree for its validator — nothing to deliver) ⇒ the
    //     daemon's `deliverDefault` setting ('pr' unless the operator flipped it) — the default
    //     that keeps run 83052f0b's work from stranding invisibly again. The code-work guard is
    //     the issue's own scope ("default deliver:'pr' for CODE-WORK launches"): a read-only
    //     workflow leaves a clean worktree, and the deliver script FAILS a clean worktree loudly
    //     ("nothing to deliver", crew#317) — defaulting it on would flip every repo-scoped chat
    //     from completed to failed;
    //   - omitted otherwise ⇒ 'none': a repo-less run has no worktree to lift, and a free-text
    //     run has no def to append the deliver phase to (the adapter REFUSES deliver:'pr'
    //     without a workflow rather than silently dropping it, so defaulting it on would turn
    //     a legal launch into a 400).
    // The adapter input spells 'none' as an omitted field; the audit entry below records the
    // RESOLVED value either way, plus whether it was defaulted.
    let deliver: 'pr' | 'none';
    let deliverDefaulted = false;
    if (b.deliver !== undefined) {
      deliver = b.deliver;
    } else if (b.repoRef !== undefined && b.workflow !== undefined) {
      // Unknown def ⇒ no default (the launch fails at workflow resolution with its own error —
      // defaulting 'pr' onto it would swap that for a misleading deliver-flavored one).
      const def = adapter.getWorkflow(b.workflow);
      const codeWork =
        def !== null &&
        def.phases.some((p) => p.executes_code === true && p.role !== 'evaluator');
      deliver =
        codeWork && (await adapter.getSettings()).deliverDefault !== 'none' ? 'pr' : 'none';
      deliverDefaulted = true;
    } else {
      deliver = 'none';
      deliverDefaulted = true;
    }
    if (deliver === 'pr') input.deliver = 'pr';
    // wicked-core#850 EX-01/EX-02: forwarded only when the caller sent it — crew never waives
    // assurance on anyone's behalf (a one-CLI launch that did not is TOLD so in its answer, below).
    if (b.reducedAssurance === true) input.reducedAssurance = true;
    // QE-IN-APP-WORKFLOWS: the operator's explicit skip (with its reason) or force — forwarded only
    // when sent, never inferred.
    if (b.skipQeAcceptance !== undefined) input.skipQeAcceptanceReason = b.skipQeAcceptance.reason;
    else if (settingSkip !== undefined) input.skipQeAcceptanceReason = settingSkip;
    if (b.forceQeAcceptance === true) input.forceQeAcceptance = true;
    // DES-L9 / crew#550 — REVISION: `revisesPr` names an OPEN same-repository pull request whose
    // head branch becomes the run's base (`baseRef`, crew-internal → the engine's
    // `LaunchSpec.base_ref`) and the push target of the composed deliver phase — the PR gains
    // exactly the run's commits, no second PR. Resolved HERE via `gh pr view` (5 s; the engine has
    // no GitHub client) and refused by name on anything but OPEN + same repo. Judged AFTER the
    // deliver resolution (F5): a launch this daemon resolved to `none` (deliverDefault) has no
    // phase to push with — a revision that pushes nothing would be a silent no-op.
    let revisesPr: { number: number; headRef: string; url: string } | undefined;
    if (b.revisesPr !== undefined) {
      if (deliver !== 'pr') {
        return reply.code(409).send({
          error: `revisesPr needs deliver: pr — this daemon resolved the launch to none (deliverDefault); send deliver: "pr"`,
        });
      }
      const revisedRepo = b.repoRef;
      if (revisedRepo === undefined) {
        // Unreachable past the schema refine; kept so the type narrows honestly.
        return reply.code(400).send({ error: 'revisesPr needs repoRef' });
      }
      const root = await repoRootOf(revisedRepo);
      if (root === undefined) {
        return reply.code(404).send({ error: `repoRef names an unknown repo: ${revisedRepo}` });
      }
      const resolved = await resolvePullRequest(root, b.revisesPr);
      if (!resolved.ok) return reply.code(409).send({ error: resolved.error });
      revisesPr = { number: b.revisesPr, headRef: resolved.pr.headRef, url: resolved.pr.url };
      input.baseRef = revisesPr.headRef;
      input.revisesPr = revisesPr;
    }
    // Retry lineage (DES-UX-001 §8.3): `retryOf` must name an EXISTING run — recording lineage
    // to a run that never existed would be provenance pointing at nothing, so the launch fails
    // loudly (400, before anything is committed) rather than filing a dangling edge.
    if (b.retryOf !== undefined) {
      const known = await adapter.sessions();
      if (!known.includes(b.retryOf)) {
        return reply.code(400).send({
          error: `retryOf names an unknown run: ${b.retryOf} — lineage must point at an existing run id`,
        });
      }
    }
    // Ad-hoc campaign attach (wicked-studio#27): `campaignId` must name an EXISTING campaign,
    // checked BEFORE anything launches — an unknown id is a 404 with nothing committed, never a
    // run silently filed onto a surface that does not exist. An engine addon without the
    // campaign bindings is a 501 ("upgrade the engine"), the campaigns-surface doctrine. A
    // `groupLabel` needs no check: a label group is created by its first use.
    if (b.campaignId !== undefined) {
      try {
        if ((await adapter.campaignDetail(b.campaignId)) === null) {
          return reply.code(404).send({
            error: `campaignId names an unknown campaign: ${b.campaignId} — an ad-hoc run can only attach to an existing campaign (launch one via POST /campaigns, or use groupLabel for a create-on-first-use group)`,
          });
        }
      } catch (err) {
        if (err instanceof CampaignsUnsupportedError) {
          return reply.code(501).send({ error: message(err) });
        }
        throw err;
      }
    }
    // crew#627: a workflow run's intent may name its work only by issue ("fix #541"), and the
    // worker cannot read GitHub. The daemon reads each linked issue now and appends its text to the
    // problem, inside a marked block the deliver text takes back out. Workflow launches only: the
    // free-text planner turns sentences into units, so issue text there would become work units.
    let linkedIssues: LinkedIssue[] | undefined;
    if (b.workflow !== undefined) {
      // Best-effort by contract: reading issues never fails the launch it decorates. A resolver
      // fault (the repo list unreadable, say) launches the run on its intent alone and is logged.
      try {
        const root = b.repoRef !== undefined ? await repoRootOf(b.repoRef) : undefined;
        const linked = await readLinkedIssues(b.problem, root, b.repoRef, b.excludeLinkedIssues ?? []);
        if (linked.block !== null) input.problem = `${b.problem.trimEnd()}\n\n${linked.block}`;
        // crew#825: an all-excluded intent appends nothing but still answers what it left out.
        if (linked.issues.length > 0) linkedIssues = linked.issues;
      } catch (err) {
        req.log.warn(`linked-issue resolution failed; launching on the intent alone: ${message(err)}`);
      }
    }
    // DES-RUNS-REVIEW-001 §3: a hand launch of the run review (`/workflow-review-recent-work`) is prepared like a
    // scheduled one: its snapshot written, repo-less, one seat, its review directory as the only write root.
    // DES-DEFAULT-EVALS-001 §7: a launch of `run-evals` (`/workflow-run-evals`) is prepared by the daemon, which runs
    // the evals in-process and writes the report copy its Tool step reads; it delivers nothing.
    if (b.workflow === RUN_EVALS_WORKFLOW) {
      try {
        await runEvalsPrepare(input);
      } catch (err) {
        return reply.code(409).send({ error: `the default evals could not be prepared: ${message(err)}` });
      }
      deliver = 'none';
    }
    const isReview = b.workflow === REVIEW_WORKFLOW && runtime.reviewLaunch !== undefined;
    if (isReview) {
      try {
        await (runtime.reviewLaunch as NonNullable<RuntimeDeps['reviewLaunch']>)(input);
      } catch (err) {
        return reply.code(409).send({ error: `the review could not be prepared: ${message(err)}` });
      }
      deliver = 'none';
    }
    try {
      const runId = await adapter.launchRun(input);
      // crew#641/#642 (item 5): when a run is promoted from a chat, record how many seats
      // participated and whether the chat was grounded — so an intent authored by a single
      // ungrounded model is distinguishable from one that survived a disagreement.
      let chatSeatCount: number | undefined;
      let chatGrounded: boolean | undefined;
      // Both stay ABSENT unless the chat actually resolves: a closed or unknown chatId must read as
      // "provenance unavailable", not as "promoted from an ungrounded zero-seat chat". A valid chat
      // always has at least one warm seat (`crew-api-types` ChatOpenResponse), so 0 is not a value
      // `chat_seat_count` can honestly hold.
      if (b.chatId !== undefined) {
        // ASK-C1: a chat's seats are its eligible roster (no warm pool to ask the engine about).
        const promotedFrom: string[] | null = askPaths.get(b.chatId)?.eligible ?? null;
        const scope = chatScopes.engineOf(b.chatId);
        if (promotedFrom !== null && promotedFrom.length > 0 && scope !== undefined) {
          chatSeatCount = promotedFrom.length;
          chatGrounded = scope.codeGraphDb != null;
        }
      }
      // Who launched it — the engine's LaunchOptions carries no actor field
      // (checked, wicked-core-ts 0.6.0), so the crew-side trail is the system
      // of record for run provenance (task #88).
      // `run.launched` is the system of record for run provenance (the engine's LaunchOptions
      // carries no actor field — task #88). `recordRunLaunched` writes the trail entry AND stamps
      // the run-timing index with the SAME durable `ts` (home command-center run metrics): the live
      // `created_at` equals what a restart rehydrates from the trail — no 1s drift, and no fabricated
      // value (audit disabled → nothing stamped → `created_at` ABSENT, the honest answer for a run
      // with no durable launch record). `createServer` always builds a REAL trail, so this fires on
      // every production launch. The SHARED helper (Copilot #466) is why the recon/steering-author
      // launchers stamp identically instead of leaving their runs undated until a restart.
      recordRunLaunched(audit, runTimingIndex, actorOf(req), runId, {
        ...(b.workflow !== undefined ? { workflow: b.workflow } : {}),
        ...(b.repoRef !== undefined ? { repoRef: b.repoRef } : {}),
        ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
        // crew#393: the RESOLVED delivery decision, not just the caller's field — so the
        // trail says what the run will actually do, and whether the daemon decided it.
        deliver,
        ...(deliverDefaulted ? { deliverDefaulted: true } : {}),
        // wicked-core#850: the caller's explicit assurance choice (the engine persists the contract
        // on the session; this records WHO waived it).
        ...(b.reducedAssurance !== undefined ? { reducedAssurance: b.reducedAssurance } : {}),
        // QE-IN-APP-WORKFLOWS: WHO skipped or forced QE acceptance, and why.
        ...(b.skipQeAcceptance !== undefined ? { skipQeAcceptance: b.skipQeAcceptance } : {}),
        ...(b.forceQeAcceptance === true ? { forceQeAcceptance: true } : {}),
        // CREW-UX-3: the trail is the durable record of lineage — the retry index (and a
        // restarted daemon's hydrate) reads it back from exactly this entry.
        ...(b.retryOf !== undefined ? { retryOf: b.retryOf } : {}),
        // DES-L9: the revised PR (number, head branch, URL) — the retry index (and a restarted
        // daemon's hydrate) reads it back from here so a stranded revision re-pushes to THAT PR.
        ...(revisesPr !== undefined ? { revisesPr, baseRef: revisesPr.headRef } : {}),
        // wicked-studio#27: the trail is likewise the durable record of the group attach —
        // the group index (and a restarted daemon's hydrate) reads it back from here.
        ...(b.campaignId !== undefined ? { campaignId: b.campaignId } : {}),
        ...(b.groupLabel !== undefined ? { groupLabel: b.groupLabel } : {}),
        // crew#619: the chat↔run link is durable so the retention maps can be rehydrated after a
        // daemon restart (rehydration reads `run.launched` entries and keeps non-terminal entries).
        ...(b.chatId !== undefined ? { chatId: b.chatId } : {}),
        // crew#641/#642 (item 5): chat promotion provenance — seat count and grounding at launch.
        ...(chatSeatCount !== undefined ? { chatSeatCount } : {}),
        ...(chatGrounded !== undefined ? { chatGrounded } : {}),
        // crew#632: launch surface and caller identity — human-readable provenance on the audit trail.
        ...(b.channel !== undefined ? { channel: b.channel } : {}),
        ...(b.actor !== undefined ? { actor: b.actor } : {}),
        // crew#627: which linked issues the daemon read into the problem, and which it could not.
        ...(linkedIssues !== undefined ? { linkedIssues } : {}),
      });
      // Stamp the index live so the field is served without waiting for a daemon restart.
      if (chatSeatCount !== undefined && chatGrounded !== undefined) {
        runTimingIndex.setChatPromotion(runId, chatSeatCount, chatGrounded);
      }
      if (b.retryOf !== undefined) retryIndex.set(runId, b.retryOf);
      if (revisesPr !== undefined) retryIndex.setRevisesPr(runId, revisesPr);
      if (b.campaignId !== undefined) groupIndex.set(runId, { campaignId: b.campaignId });
      else if (b.groupLabel !== undefined) groupIndex.set(runId, { label: b.groupLabel });
      if (b.projectId !== undefined) {
        // The engine attached the crew.run membership ATOMICALLY with the launch record
        // (DES-PROJECT-001 §2.2) — this is the post-commit half: tag future /ws frames and
        // emit the membership event (auto-attach at launch is an attach, §4).
        projects.index.set(runId, b.projectId);
        projects.bus?.emit(
          MEMBERSHIP_ATTACHED,
          // The AUTHENTICATED actor id, not a caller-supplied string — locked
          // decision #6 replaces spoofable actor strings on the event surface.
          { project_id: b.projectId, member: { kind: 'crew.run', ref: runId }, actor: actorOf(req).id },
          membershipAttachedKey(b.projectId, 'crew.run', runId, Date.now()),
        );
      }
      // crew#619: retain the chat transcript for the run's lifetime so Continue-in-Build prefill
      // is always reproducible even if the chat is idle-reclaimed before the run finishes.
      if (b.chatId !== undefined) runtime.linkChatRun?.(b.chatId, runId);
      // crew#755: a launch that named neither a workflow nor a plan runs the engine's free-text
      // planner (one unit, the brief verbatim). Say so in the answer, with how to get work done,
      // instead of letting it pass for a launch of real work.
      const freeText = input.workflow === undefined && input.plan === undefined ? { freeText: { notice: FREE_TEXT_NOTICE } } : {};
      // crew#874: the run uses the PUBLISHED generation; when the installed garden is not the one it
      // was built from, the launch answer says so (a recorded proof can disclose which garden ran).
      const skillsAhead = await runtime.skills?.installedAheadFinding({ fresh: true }) ?? null; // fresh: an upgrade just before Send counts (codex r1)
      const skillsWarning = skillsAhead === null ? {} : { skillsWarning: { kind: skillsAhead.kind, severity: skillsAhead.severity, message: skillsAhead.message } };
      // wicked-core#850: a full-assurance run on a one-CLI roster will wait at a gate for a seat that
      // can evaluate or judge it; the answer names the explicit opt-in to relaunch with.
      const notice = launchAssuranceNotice({ runId, reducedAssurance: b.reducedAssurance, engineClisJson: engineRosterJson(input.clisJson) });
      const assuranceNotice = notice === null ? {} : { assuranceNotice: notice };
      return reply.code(201).send({ runId, ...(linkedIssues !== undefined ? { linkedIssues } : {}), ...freeText, ...skillsWarning, ...assuranceNotice });
    } catch (err) {
      const msg = message(err);
      if (isReview) runtime.reviewLaunchRefused?.(input.sessionId, msg);
      // DES-TEAMING-002 T3: a plan on an engine without the plan approval gate is an "upgrade the
      // engine" 501 — never a free-text run launched in its place.
      if (err instanceof PlanLaunchUnsupportedError) {
        return reply.code(501).send({ error: msg });
      }
      // The engine's own intake refusal (wicked-core#411 `StateHomeConfigError`) is a configuration
      // error, not a malformed request: the same typed 409 the pre-check above answers, over a fresh
      // survey — the pre-check saw a clean state home (or an addon that could not classify), the
      // engine did not.
      if (isEngineStateHomeRefusal(msg)) {
        const stateHome = runtime.stateHome !== undefined ? await runtime.stateHome.refresh() : null;
        return reply
          .code(409)
          .send(
            stateHome !== null && stateHome.unregistered.length > 0
              ? stateHomeBlockerBody(stateHome)
              : {
                  error: msg,
                  code: STATE_HOME_BLOCKER_CODE,
                  stateHome: stateHome?.stateHome ?? null,
                  unregistered: [],
                  remedy: STATE_HOME_REMEDY,
                },
          );
      }
      // wicked-core#461 / crew#556: the engine's typed `NoEligibleSeat` intake refusal — the plan
      // needs a seat and every seat of the roster was benched by the launcher (signed out / quota /
      // not installed). A 409 with a typed body, not the 400 the generic arm below answered: the
      // request is well-formed and succeeds unchanged once a seat is signed in — the conflict is
      // with the roster's standing (the `state_home_unregistered` rule) — and not a 5xx: the engine
      // is healthy and said no, naming every seat and its cause.
      const noSeat = parseNoEligibleSeat(msg);
      if (noSeat !== null) {
        return reply.code(409).send(noEligibleSeatBody(msg, noSeat));
      }
      // An unknown/archived project is a state conflict on a real resource, not a malformed
      // request: 404/409 per the projects error mapping; anything else keeps the launch 400/409.
      if (b.projectId !== undefined && /project.*not registered/i.test(msg)) {
        return reply.code(404).send({ error: msg });
      }
      if (b.projectId !== undefined && /archived|'default'|synthesized/i.test(msg)) {
        return reply.code(409).send({ error: msg });
      }
      // crew#554 / wicked-core#468: the engine refused the launch AT INTAKE because the handed
      // skills snapshot lacks the run's BASE skill (`SkillsError::BaseSkillRefused` — the message
      // names the skill and "refused at intake"). Nothing was planned or persisted. A typed 422 so a
      // composer renders a clear card (skill, policy, remedy) instead of a generic launch 400.
      if (/\bbase skill\b.*\brefused at intake\b/is.test(msg)) {
        const posture = runtime.skills?.baseSkill() ?? null;
        // F-W1-102: the SAME remedy sentence the /health finding and `wicked-crew status` carry.
        const remedy = baseSkillRemedy(posture?.inCatalog ?? false);
        return reply.code(422).send({ code: 'base_skill_refused', error: msg, baseSkill: posture, remedy });
      }
      const busy = /busy|in flight|already/i.test(msg);
      return reply.code(busy ? 409 : 400).send({ error: msg });
    }
  });

  // Run list (replaces GET /sessions). Actionable-first; reconciles the gate and elicitation caches
  // so that terminal-run entries are pruned even when their terminal CoreEvent was missed.
  app.get(
    `${V}/runs`,
    { config: { manifest: { responseType: '{ runs: SessionView[] }', statusCodes: [200, 400] } } },
    async (req, reply) => {
    const views = await adapter.sessionsDetail();
    gateCache.reconcile(views);
    elicitationCache.reconcile(views);
    // Archived runs are WRITTEN OFF (crew#265): excluded from the default view so finished
    // history doesn't drown live signal, returned in full with `?include=archived`. The caches
    // above reconcile over the COMPLETE set either way — a gate on an archived run must still
    // resolve, not leak.
    // Fastify parses a REPEATED query param as string[] — normalize so `?include=archived`
    // and `?include=archived&include=archived` behave identically (Copilot).
    const { include, limit, doc } = req.query as {
      include?: string | string[];
      limit?: string | string[];
      doc?: string | string[];
    };
    const includeArchived = (Array.isArray(include) ? include : [include]).includes('archived');
    // `?doc=<document id>` (wave 6, F-4R2-006): only the runs the interactive seams launched for
    // that document — the doc↔run binding as a direct read (the run DTO carries `document_id`).
    // A repeated `?doc` is an ambiguity, not a repetition — refused like a repeated `?limit`.
    if (Array.isArray(doc)) {
      return reply.code(400).send({ error: '`doc` may be given at most once' });
    }
    if (doc !== undefined && doc.trim() === '') {
      return reply.code(400).send({ error: '`doc` must name a document id' });
    }
    // `?limit=N` — the top N AFTER the actionable-first sort below, so a capped poll still sees
    // the runs that need a human before the terminal sediment. The default stays UNBOUNDED: the
    // param used to be read by nobody (silently ignored — the full payload regardless), so an
    // implicit cap would silently change results for un-migrated callers. A malformed value is
    // refused loudly instead of ignored (the FINDING-031 posture: ignoring a field runs a
    // different request than the caller sent) — and a repeated `?limit` is malformed too, since
    // two caps are an ambiguity, not an idempotent repetition like `include`.
    let cap: number | undefined;
    if (limit !== undefined) {
      // STRICT canonical decimal only (Copilot on #435): `Number(...)` also admits hex
      // (`0x10`), exponent (`2e3`), signed (`+1`), and whitespace-padded spellings — surprising
      // aliases a 400-on-malformed contract must refuse, not quietly honor. `0` is deliberately
      // VALID and answers the empty list — a real non-negative integer, not a malformation —
      // while non-canonical zeros (`00`, `01`) are refused with the rest.
      const canonical = !Array.isArray(limit) && /^(0|[1-9][0-9]*)$/.test(limit);
      if (!canonical) {
        return reply.code(400).send({
          error: `Invalid ?limit — expected one non-negative decimal integer, got ${JSON.stringify(limit)}`,
        });
      }
      cap = Number(limit);
    }
    const unarchived = includeArchived
      ? views
      : views.filter((v) => v.session.archived_at == null);
    const visible =
      doc === undefined ? unarchived : unarchived.filter((v) => docRuns.documentOf(v.session.id) === doc.trim());
    const ordered = sortActionableFirst(visible);
    const served = cap !== undefined ? ordered.slice(0, cap) : ordered;
    await settleDeliveries(served);
    await backfillEndedAt(served);
    return { runs: served.map(decorateRun) };
  });

  // ── Run archival (crew#265) — write-off, not delete ────────────────────────
  const ArchiveSchema = z.object({
    archived: z.boolean(),
    note: z.string().max(500).optional(),
  }).strict();
  app.post(`${V}/runs/:id/archive`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ArchiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    try {
      const found = await adapter.archiveRun(id, parsed.data.archived, parsed.data.note);
      if (!found) return reply.code(404).send({ error: 'Run not found' });
      return { runId: id, archived: parsed.data.archived };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // The engine names a NON-terminal status ("run X is Executing — only a terminal run…"):
      // a state conflict on a real resource, not a bad request (write-off must never hide
      // live work). Anything else — including the old-addon guard — is a real 500.
      if (/only a terminal run/i.test(msg)) return reply.code(409).send({ error: msg });
      return reply.code(500).send({ error: msg });
    }
  });
  // ── Resolve an unresolved run (api-types 0.140.0) ─────────────────────────────
  // Unresolved work (`GET /system.unresolved[]`) is resolved, never hidden: archived WITH a reason,
  // or closed as superseded naming the run that replaced it (retry is `POST /runs {retryOf}`). A run
  // parked at a gate is stopped first (no worker is running), then archived; a run that is
  // executing is refused, so a resolve never ends live work. The note keeps the reason.
  const ResolveSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('archive'), reason: z.string().trim().min(1, 'a reason is required to archive').max(480) }).strict(),
    z.object({ action: z.literal('superseded'), by: z.string().min(1), reason: z.string().trim().max(400).optional() }).strict(),
  ]);
  app.post(
    `${V}/runs/:id/resolve`,
    { config: { manifest: { requestType: 'ResolveRunRequest', responseType: 'ResolveRunResponse', statusCodes: [200, 400, 404, 409, 500] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ResolveSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
      const b = parsed.data;
      const note = b.action === 'archive' ? `resolved: ${b.reason}` : `superseded by ${b.by}${b.reason !== undefined && b.reason !== '' ? `: ${b.reason}` : ''}`;
      // Inside the run's decision lock (the gate path's): the status read, the stop and the archive
      // are one step, so a gate answered at the same moment can never be stopped by a resolve. The
      // status is read again inside the lock, right before the stop.
      const outcome = await decideExclusively(id, async (): Promise<{ code: number; body: unknown }> => {
        const views = await adapter.sessionsDetail();
        const run = views.find((v) => v.session.id === id);
        if (run === undefined) return { code: 404, body: { error: 'Run not found' } };
        if (b.action === 'superseded') {
          if (b.by === id) return { code: 400, body: { error: '`by` must name another run' } };
          if (!views.some((v) => v.session.id === b.by)) return { code: 400, body: { error: `\`by\` names an unknown run: ${b.by}` } };
        }
        const status = run.session.status;
        if (status !== 'awaiting_human' && status !== 'failed' && status !== 'completed' && status !== 'cancelled') {
          return { code: 409, body: { error: `run ${id} is ${status}: a running job cannot be resolved; stop it first` } };
        }
        let cancelled = false;
        try {
          if (status === 'awaiting_human') {
            await adapter.cancelRun(id);
            cancelled = true;
          }
          const found = await adapter.archiveRun(id, true, note);
          if (!found) return { code: 404, body: { error: 'Run not found' } };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return { code: /only a terminal run/i.test(msg) ? 409 : 500, body: { error: msg } };
        }
        audit.record('run.resolved', actorOf(req), { runId: id, detail: { action: b.action, note, cancelled, ...(b.action === 'superseded' ? { by: b.by } : {}) } });
        const out: ResolveRunResponse = { runId: id, action: b.action, archived: true, cancelled, note };
        return { code: 200, body: out };
      });
      return reply.code(outcome.code).send(outcome.body);
    },
  );

  // Bulk write-off for campaign backlogs — explicit ids only, never implicit age selection.
  const BulkArchiveSchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(200),
    note: z.string().max(500).optional(),
  }).strict();
  app.post(`${V}/runs/archive`, async (req, reply) => {
    const parsed = BulkArchiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    // Per-id outcomes rather than all-or-nothing: a batch of 45 with one live run in it
    // should archive 44 and NAME the refusal, not roll back the write-off.
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of parsed.data.ids) {
      try {
        const found = await adapter.archiveRun(id, true, parsed.data.note);
        results.push(found ? { id, ok: true } : { id, ok: false, error: 'not found' });
      } catch (e: unknown) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results, archived: results.filter((r) => r.ok).length };
  });

  // One run's detail.
  app.get(
    `${V}/runs/:id`,
    { config: { manifest: { responseType: '{ run: SessionView }', statusCodes: [200, 404] } } },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    await settleDeliveries([run]);
    await backfillEndedAt([run]);
    return { run: decorateRun(run) };
  });

  // ── Inventory claims (crew#721) — whether each enumerating step's list is complete ──
  // A step that lists things a later step acts on ends its reply with a `wicked-inventory` block
  // (wicked-garden core/refs/inventory-report.md). This reads them off every unit's captured
  // output, so a reviewer sees "partial: 9 of 10, issue #936 unread" without opening transcripts
  // (crew#648). `complete` is true only when at least one unit claimed an inventory, every claim is
  // `full` and every unit's output was readable; `readable: false` when the adapter keeps none.
  app.get(
    `${V}/runs/:id/inventory`,
    {
      config: {
        manifest: {
          responseType: 'RunInventoryResponse',
          statusCodes: [200, 404],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const views = await adapter.sessionsDetail();
      const run = views.find((v) => v.session.id === id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      if (typeof adapter.workOutput !== 'function') {
        return { runId: id, readable: false, complete: false, units: [], unreadUnits: [] } satisfies RunInventoryResponse;
      }
      const units: { ord: number; unitId: string; claims: InventoryClaim[] }[] = [];
      // A unit whose output could not be READ is not a unit that claimed nothing: it may hold the
      // partial claim, so it is listed and the run is never `complete` while any remain (codex r1).
      const unreadUnits: string[] = [];
      for (const u of [...run.units].sort((a, b) => a.ord - b.ord)) {
        let text: string | null;
        try {
          text = await adapter.workOutput(coreUnitId(id, u));
        } catch {
          unreadUnits.push(u.id);
          continue;
        }
        if (text === null) {
          // No output from a unit that has not run is expected; from one that finished, the
          // transcript is missing and may have held the claim (codex r3).
          if (u.status === 'done' || u.status === 'rejected') unreadUnits.push(u.id);
          continue;
        }
        const claims = parseInventoryClaims(text);
        if (claims.length > 0) units.push({ ord: u.ord, unitId: u.id, claims });
      }
      const all = units.flatMap((u) => u.claims);
      return {
        runId: id,
        readable: true,
        complete: inventoryComplete(all) && unreadUnits.length === 0,
        units,
        unreadUnits,
      } satisfies RunInventoryResponse;
    },
  );

  // ── Deliver text (crew#524 / F-3R2-014) — the PR title + body a run's delivery carries ──
  // `gh pr create --fill` gave wicked-studio#249 a mid-word title and an EMPTY body. The deliver
  // script now asks this route for the text composed from the PERSISTED RUN RECORD: the intent,
  // `Fixes #N`, the run link, every phase with its seat and gate outcome, the repo checks with
  // their exit codes, the evaluator verdict (`core/deliver-text.ts`). text/plain, FRAMED as line 1
  // title, line 2 blank, then the body — the same shape the script's embedded fallback has, so the
  // script parses exactly one thing. Read-only; the run's `deliver` unit is still running when it
  // asks, and is listed as `this PR`.
  app.get(
    `${V}/runs/:id/deliver-text`,
    { config: { manifest: { statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const views = await adapter.sessionsDetail();
      const run = views.find((v) => v.session.id === id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      const followUps = await evaluatorFollowUps(run);
      const reports = await seatReports(run);
      // The run's preset or workflow NAME, as the engine recorded it (seam X2).
      const text = composeDeliverText(
        factsFromRun(decorateRun(run), runUrlFor(configuredPublicOrigin(), id), {
          workflowId: runIdentityOf(run).name,
          revisesPr: retryIndex.revisesPrFor(id) ?? null,
          ...(followUps !== undefined ? { followUps } : {}),
          ...(reports !== undefined ? { reports } : {}),
        }),
      );
      return reply.type('text/plain; charset=utf-8').send(framedDeliverText(text));
    },
  );

  // ── Post-hoc delivery (crew#393) — lift a stranded run's worktree into a PR ──
  // The recovery path for the run 83052f0b class: a COMPLETED repo-scoped run whose reviewable
  // work was never lifted (`delivery: 'stranded'` on the wire — including runs recorded long
  // before this route existed). Runs the SAME hardened script as the deliver phase (#293/#317:
  // commit, refuse the default branch, rebase — a conflict aborts LOUDLY with nothing pushed —
  // never force, push, `gh pr create`, success re-derived from a real PR URL) against the run's
  // existing worktree. Idempotent: a delivered run answers its recorded URL, never a second PR.
  // Failure is a loud 4xx/5xx carrying the script's own words — never a silent 200.
  const deliverInFlight = new Set<string>();
  // Per-REPO serialization for the worktree-admin-sensitive region (reprovision → deliver →
  // cleanup). deliverInFlight is per-RUN and stops the same run double-delivering, but two
  // DIFFERENT stranded runs in the same repo would both run `git worktree prune/add/remove`
  // against one `.git/worktrees` admin state and race. Chaining a promise per repo ref serializes
  // them; different repos still run in parallel. The tail entry is pruned so the map cannot grow.
  const repoDeliverChain = new Map<string, Promise<void>>();
  const withRepoDeliverLock = async <T>(repoRef: string, fn: () => Promise<T>): Promise<T> => {
    const prior = repoDeliverChain.get(repoRef) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    repoDeliverChain.set(repoRef, mine); // WE are now the tail
    await prior.catch(() => undefined); // wait our turn; a prior failure never blocks ours
    try {
      return await fn();
    } finally {
      release(); // unblock whoever chained after us
      // If nothing chained after us, drop the entry so idle repos leave no trace.
      if (repoDeliverChain.get(repoRef) === mine) repoDeliverChain.delete(repoRef);
    }
  };
  /** The last words of a failed deliver script — enough to name the refusal, bounded so a full
   *  git transcript never becomes an error body. */
  const deliverErrorTail = (output: string): string => {
    const trimmed = output.trim();
    return trimmed.length <= 2000 ? trimmed : `…${trimmed.slice(-2000)}`;
  };
  app.post(
    `${V}/runs/:id/deliver`,
    {
      config: {
        manifest: {
          responseType: 'DeliverRunResult',
          // 404: unknown run. 409: not completed / repo-less / worktree gone / already in
          // flight / the script's own loud refusal (conflict, nothing to deliver, gh failure).
          // 500: exit 0 with no verifiable PR URL, or the spawn itself failed.
          statusCodes: [200, 404, 409, 500],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // Idempotency first: a recorded delivery answers the SAME URL — `gh pr create` is never
      // re-run on a delivered run, so a double-click (or a retry after a slow response) cannot
      // double-open. The index only ever holds real runs, so this needs no store round-trip.
      const existing = deliveryIndex.urlFor(id);
      if (existing !== undefined) {
        const recorded = deliveryIndex.assuranceFor(id);
        // crew#720: the run's final-codebase zip rides the replay too.
        const zip = runtime.codebaseArchives?.get(id);
        return { prUrl: existing, ...(recorded !== undefined ? { assurance: recorded } : {}), ...(zip !== undefined ? { codebase: zip } : {}) };
      }
      // N1: a run whose branch is already on a non-GitHub origin has nothing left to lift, and no
      // pull request can be opened from here — say so instead of pushing the branch again.
      const pushedAlready = deliveryIndex.pushedFor(id);
      if (pushedAlready !== undefined) {
        return reply.code(409).send({ error: pushedOnlyRefusal(id, pushedAlready) });
      }
      const views = await adapter.sessionsDetail();
      const run = views.find((v) => v.session.id === id);
      if (!run) return reply.code(404).send({ error: 'Run not found' });
      // Freeze deliveries (idea 15): nothing pushes while the switch is on.
      if (deliveryFreeze.state().frozen) return reply.code(409).send(frozenRefusal(deliveryFreeze.state()));
      // crew#418/#432: a run stranded by a recoverable deliver lift failure reads `failed` from the
      // engine but IS liftable post-hoc — normalize its status to `completed` so this route
      // accepts it, exactly as the run wire and the resume route see it.
      const conflictStrand = normalizeStranded(run);
      const s = run.session;
      if (s.status !== 'completed') {
        return reply.code(409).send({
          error: `run ${id} is ${s.status} — only a completed run can be delivered post-hoc`,
        });
      }
      if (s.repo_ref == null || typeof s.workdir !== 'string' || s.workdir === '') {
        return reply.code(409).send({
          error: `run ${id} is not repo-scoped — there is no worktree to lift into a PR`,
        });
      }
      // Capture the ref + workdir while the null-check narrowing is fresh — an intervening await
      // below invalidates property narrowing, so re-reading `s.repo_ref`/`s.workdir` later widens
      // back to `| null`.
      const repoRef: string = s.repo_ref;
      const initialWorkdir: string = s.workdir;
      // wicked-core#850 EX-03: a run whose contract requires QE acceptance is lifted only on a PASS
      // attributed to it — checked BEFORE anything is spawned, so a refusal pushes nothing.
      const qeAcceptance = await qeAcceptanceCheckFor(run, 'post_hoc');
      if (qeAcceptance !== null && !qeAcceptance.satisfied) {
        return reply.code(409).send(qeAcceptanceRefusal(id, qeAcceptance, aggregateReceipt(run, null), 'post_hoc'));
      }
      // One delivery per run at a time: the script pushes and opens a PR, so two concurrent
      // spawns could race gh into two PRs — the exact double-open idempotency forbids. The guard
      // wraps the reprovision too, so a reaped run's `wicked/<id>` branch is only ever checked out
      // by one throwaway worktree at a time.
      if (deliverInFlight.has(id)) {
        return reply.code(409).send({
          error: `a delivery for run ${id} is already in progress — wait for it to finish`,
        });
      }
      deliverInFlight.add(id);
      // crew#762: the attempt is the durable fact "delivery was requested" — recorded BEFORE the
      // script runs, so a lift that then fails still reads requested after a reload or restart.
      audit.record(DELIVER_REQUESTED_ACTION, actorOf(req), { runId: id, detail: { via: 'post-hoc' } });
      deliveryIndex.markRequested(id);
      // The worktree the script runs in. Usually the run's own; but the engine REAPS a
      // failed-deliver run's worktree once its work is committed (crew#418/#432) — the work then lives
      // on the `wicked/<id>` branch. For such a strand, stand a throwaway worktree back up from
      // that branch and lift THAT; the branch (the record) is untouched. `cleanupWorktree` tears
      // the throwaway down after the lift.
      let result: DeliverScriptResult | undefined;
      let codebase: CodebaseArchive | undefined;
      let worktreeGone = false;
      // DES-L9: a stranded REVISION re-pushes onto its PR's branch (re-checked OPEN via the same
      // resolver), never a new PR; a PR that closed meanwhile is a named 409.
      let revisionRefused: string | undefined;
      try {
        // The worktree admin (reprovision), the deliver spawn, AND the throwaway teardown all run
        // under the per-repo lock, so a second stranded run in this repo cannot touch
        // `.git/worktrees` until this one has stood its worktree up, lifted, and torn it back
        // down. `cw` is a LOCAL torn down in the lock body's own finally — nothing captured-mutated
        // crosses the closure boundary.
        await withRepoDeliverLock(repoRef, async () => {
          let workdir = initialWorkdir;
          let cw: (() => Promise<void>) | null = null;
          try {
            if (!worktreeExists(workdir)) {
              const root = conflictStrand ? await repoRootOf(repoRef) : undefined;
              const reprov = root !== undefined ? await reprovisionWorktree(root, id) : null;
              if (reprov === null) {
                worktreeGone = true;
                return;
              }
              workdir = reprov.workdir;
              cw = reprov.cleanup;
            }
            // crew#524: the post-hoc lift composes its PR text from the run record it already
            // holds (the fallback), and names this daemon so the script can re-ask at delivery.
            const origin = boundOrigin(app.server.address());
            const workflowName = runIdentityOf(run).name;
            const revising = retryIndex.revisesPrFor(id);
            let revisesPr: { number: number; headRef: string; url: string } | null = null;
            if (revising !== undefined) {
              const revisedRoot = await repoRootOf(repoRef);
              const again =
                revisedRoot === undefined
                  ? ({ ok: false, error: `repo ${repoRef} is no longer registered — cannot re-check pull request #${revising.number}` } as const)
                  : await resolvePullRequest(revisedRoot, revising.number);
              if (!again.ok) {
                revisionRefused = again.error;
                return;
              }
              revisesPr = { number: revising.number, headRef: again.pr.headRef, url: again.pr.url };
            }
            const followUps = await evaluatorFollowUps(run);
            const reports = await seatReports(run);
            result = await deliverExec(workdir, s.problem ?? undefined, {
              runId: id,
              apiOrigin: origin,
              facts: factsFromRun(run, runUrlFor(configuredPublicOrigin(), id), {
                workflowId: workflowName,
                revisesPr: revisesPr === null ? null : { number: revisesPr.number, url: revisesPr.url },
                ...(followUps !== undefined ? { followUps } : {}),
                ...(reports !== undefined ? { reports } : {}),
              }),
              revisesPr,
              // R1 (Copilot on crew#736): the post-hoc delivery binds `gh pr create --repo` to the
              // origin's GitHub repository too, read now from the worktree (it shares its repo's
              // remotes), so the PR opens where origin points rather than where gh's default does.
              originUrl: await readDeliverOriginUrl(workdir),
            });
            // crew#720: the final-codebase zip, taken while this checkout (perhaps a throwaway)
            // still exists — whatever the script's verdict.
            const archives = runtime.codebaseArchives;
            if (archives !== undefined) {
              try {
                codebase = (await archives.archive(id, { workdir, repoRoot: (await repoRootOf(repoRef)) ?? null }, 'deliver')) ?? undefined;
              } catch {
                // Best-effort: the archive store logs its own failures; a lookup that threw leaves none.
              }
            }
          } finally {
            if (cw !== null) await cw(); // tear the throwaway down whether the lift succeeded or threw
          }
        });
      } catch (err) {
        return reply.code(500).send({ error: `deliver script could not run: ${message(err)}` });
      } finally {
        deliverInFlight.delete(id);
      }
      if (worktreeGone) {
        return reply.code(409).send({
          error: `run ${id}'s worktree is gone (${s.workdir}) — nothing left to deliver`,
        });
      }
      if (revisionRefused !== undefined) {
        return reply.code(409).send({ error: revisionRefused });
      }
      if (result === undefined) {
        // Unreachable: the lock body assigns `result` on every path that is not `worktreeGone`.
        return reply.code(500).send({ error: `deliver for run ${id} produced no result` });
      }
      if (result.spawnFailure === true) {
        // The script never reached its own verdict (spawn failure, timeout kill) — an infra
        // fault, not a refusal: 500 so the caller knows a retry is reasonable.
        return reply.code(500).send({
          error: `deliver script could not run to completion: ${deliverErrorTail(result.output)}`,
        });
      }
      if (result.status !== 0) {
        // The script's own words (crew#317's rule: never silent, never masked) — it names
        // exactly what it refused (rebase conflict, nothing to deliver, gh's error) and
        // guarantees nothing was pushed on the refusing paths.
        return reply.code(409).send({
          error: `deliver failed (exit ${result.status}): ${deliverErrorTail(result.output)}`,
          // crew#720: the final-codebase zip is there whatever the verdict.
          ...(codebase !== undefined ? { codebase } : {}),
        });
      }
      // The SAME parser the in-run record uses: the script's push-only verdict outranks a URL a
      // remote hook echoed earlier in the transcript (Copilot on crew#734).
      const record = deliveryRecordFrom(result.output);
      const url = record !== null && 'url' in record ? record.url : null;
      const pushedOnly = record !== null && 'pushed' in record ? record.pushed : null;
      // wicked-core#850 EX-04: no engine lift re-verified what this pushed — the run record says so,
      // with the trees the script named (the PR body carries the same label). Built before the
      // outcome branches, so a push-only delivery records it too (codex r1).
      const assurance = postHocDeliveryAssurance(run, unverifiedTreesFrom(result.output), qeAcceptance);
      if (pushedOnly !== null) {
        // N1: the script pushed the branch and gh could resolve no GitHub repository for the
        // origin. That IS a delivery — record it, so the run reads `delivery: 'pushed'` — but there
        // is no PR URL to answer with, so the reply says what happened instead of a 200 `prUrl`.
        audit.record('run.delivered', actorOf(req), { runId: id, detail: { pushed: pushedOnly, via: 'post-hoc', assurance } });
        deliveryIndex.setPushed(id, pushedOnly, assurance);
        return reply.code(409).send({ error: pushedOnlyRefusal(id, pushedOnly) });
      }
      if (url === null) {
        // Exit 0 with no URL should be unreachable (the script re-derives its own success),
        // but a delivery nothing can be pointed at is never recorded (crew#317).
        return reply.code(500).send({
          error: 'deliver script exited 0 but produced no PR URL — refusing to record a delivery nothing can be pointed at',
        });
      }
      // The durable record first, then the read-side index — the same write order as the
      // deliver-phase resolution in server.ts, so the index can only LAG a crash, never lead it.
      audit.record('run.delivered', actorOf(req), { runId: id, detail: { url, via: 'post-hoc', assurance, ...(codebase !== undefined ? { codebase } : {}) } });
      deliveryIndex.set(id, url, assurance);
      return { prUrl: url, assurance, ...(codebase !== undefined ? { codebase } : {}) };
    },
  );

  // Durable pre-gate guidance (DES-UX-002 §7.2 — spec'd there as CREW-UX-4, implemented as
  // CREW-UX-7 because crew#308 already spent that id; see guidance-index.ts). Upserts the ONE
  // operator note on the run; the empty string clears it. The durable record is the
  // `guidance.set` audit entry (actor + full text); the index is the read-side layer the run
  // DTOs echo it from.
  //
  // GOVERNANCE ISOLATION (deliberate): the governance gate does NOT read this field — the
  // engine's `LaunchOptions` never sees it, and no gate evaluation consults it. It is
  // operator-visible context only; the amend text at gate decision (`POST /runs/:id/gate`)
  // stays the ONE injection point. The studio pre-populates its steer textarea from this note,
  // and injection still happens only through the governed amend.
  app.put(
    `${V}/runs/:id/guidance`,
    {
      config: {
        manifest: {
          requestType: 'SetGuidanceBody',
          responseType: 'SetGuidanceResult',
          statusCodes: [200, 400, 404],
        },
      },
    },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = GuidanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const { text } = parsed.data;
    if (Buffer.byteLength(text, 'utf8') > GUIDANCE_MAX_BYTES) {
      return reply.code(400).send({
        error: `guidance exceeds the ${GUIDANCE_MAX_BYTES}-byte cap — a note this size belongs in the problem statement or a linked doc`,
      });
    }
    const known = await adapter.sessions();
    if (!known.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    // The trail is the durable record (CREW-UX-3 posture): a restarted daemon's
    // GuidanceIndex.hydrate reads the note back from exactly this entry.
    audit.record('guidance.set', actorOf(req), { runId: id, detail: { text } });
    guidanceIndex.set(id, text);
    return { runId: id, guidance: text };
  });

  // ── Chat sessions (crew#165): warm ACP seat pool + group fan-out (core#134) ──
  // A chat is NOT a run: no council, no gates, no units. Seats warm on open;
  // messages fan out to warm seats; replies stream on /ws as chatDelta/chatReply.
  //
  // A chat is SCOPED (crew#502, F-067): its seats run in a private scratch root — never a repo,
  // never the daemon's cwd — with the scoped repos as read roots and, where a graph binds, the
  // READ-ONLY estate MCP over it (the grounding governed runs get). The scope is resolved and
  // validated BEFORE any seat warms, stated to the seats in the scratch root's AGENTS.md /
  // CLAUDE.md, and returned as `scope` (see `chat-scope.ts`).
  // crew#1020: open and refresh use the same registry, graph, liveness and checkout dependencies.
  const resolveScope = (request: ChatScopeRequest, req: FastifyRequest) => resolveChatScope(request, {
    ...chatScopeDeps(adapter),
    scratchBase: chatScopes.base,
    log: (m) => req.log.warn(m),
    ...(runtime.entityCount !== undefined ? { entityCount: runtime.entityCount } : {}),
    ...(runtime.freshenCheckout !== undefined ? { freshen: runtime.freshenCheckout } : {}),
  });

  app.post(
    `${V}/chats`,
    {
      config: {
        manifest: {
          requestType: 'ChatOpenBody',
          responseType: 'ChatOpenResponse',
          statusCodes: [201, 400, 404, 409, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = ChatOpenSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
      }
      const b = parsed.data;
      const chatId = b.chatId ?? randomUUID();
      const requestedRefs = [...(b.repoRef !== undefined ? [b.repoRef] : []), ...(b.repoRefs ?? [])];
      // A named scope's SHAPE first (studio#323 R4, codex on #664): a body whose kind refuses its own
      // projectId/repoRefs is a 400 — never masked by the project lookup's 404/409 below.
      const shape = namedKindRefusal(b.scopeKind, b.projectId, [...new Set(requestedRefs)]);
      if (shape !== null) return reply.code(400).send({ error: shape.error });
      // Validate the project BEFORE opening seats: a chat has no launch record for the engine to
      // attach against atomically (chats are an in-memory seat pool), so the route validates
      // up-front and attaches right after open — the one non-atomic attach, documented in the ADR
      // changelog. Fail here and no seats were warmed for a filing that could never happen.
      if (b.projectId !== undefined) {
        try {
          const project = await adapter.projectGet(b.projectId);
          if (project === null) {
            return reply.code(404).send({ error: `Project ${b.projectId} not found` });
          }
          if (project.status === 'archived') {
            return reply
              .code(409)
              .send({ error: `project ${b.projectId} is archived and blocks new attachments` });
          }
        } catch (err) {
          return reply.code(501).send({ error: message(err) });
        }
      }
      // crew#1157: a chat that runs a workflow runs a BUILT-IN read-only one, resolved before anything
      // is reserved or warmed (a 400 for a name chats do not run, a 409 for an engine without it).
      let workflow: ChatWorkflow | undefined;
      if (b.workflow !== undefined) {
        let presets: Awaited<ReturnType<typeof adapter.listPresets>> = [];
        try {
          presets = typeof adapter.listPresets === 'function' ? await adapter.listPresets() : [];
        } catch {
          presets = [];
        }
        const resolved = resolveChatWorkflow(b.workflow, presets);
        if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error });
        workflow = resolved.workflow;
      }
      const statementOpts = { analysis: workflow !== undefined };
      // A chat id this daemon already holds a scope for is LIVE: re-preparing its scratch root and
      // re-opening it would overwrite the statement its seats are reading and (on a changed scope)
      // evict them mid-conversation (Copilot, #518). Close it first, or let the daemon mint the id.
      const token = chatScopes.reserve(chatId);
      if (token === null) {
        const state = chatScopes.stateOf(chatId);
        return reply.code(409).send({
          error:
            state === 'held'
              ? `chat ${chatId} is closing (its DELETE is still settling); retry in a moment, or omit chatId to mint a fresh one`
              : state === 'closing'
                ? `chat ${chatId} is closing; wait for its chatClosed (a few seconds at most) before reusing the id, or omit chatId to mint a fresh one`
                : `chat ${chatId} is already open on this daemon; DELETE /chats/${chatId} first, or omit chatId to mint a fresh one`,
        });
      }
      // DC-S7: the in-force rules the statement lists; recorded as "told" only once the open succeeds.
      let inForceAtOpen: ConformanceRule[] = [];
      // Everything below either ends in `chatScopes.set(chatId, …, token)` or releases the reservation.
      try {
      // The scope (crew#502): explicit repos (`repoRefs`, the legacy `repoRef` merged in) or the
      // project's members — each ref checked against the registry, EVERY missing one named — else
      // none. Resolved before any seat warms: a 404 here warmed nothing.
      const scopeRequest: ChatScopeRequest = {
        chatId,
        ...(b.projectId !== undefined ? { projectId: b.projectId } : {}),
        repoRefs: requestedRefs,
        ...(b.scopeKind !== undefined ? { kind: b.scopeKind } : {}),
      };
      const resolution = await resolveScope(scopeRequest, req);
      if (!resolution.ok) {
        chatScopes.release(chatId, token);
        return reply.code(resolution.status).send({
          error: resolution.error,
          ...(resolution.missing !== undefined ? { missing: resolution.missing } : {}),
        });
      }
      const { scope, engine } = resolution;
      try {
        // Cleans up only what it created itself on failure (Copilot, #518).
        // DC-S7: the seats learn the project's in-force rules from the statement (cap 20, severity
        // order); the service remembers what they were told so a later landing can be prefaced.
        inForceAtOpen = (await considerations.inForceFor(scope.projectId ?? null)).rules;
        // The scratch root is shared by id: an open whose reservation a DELETE cancelled while it
        // was resolving must not write (or later remove) the root a newer open now holds
        // (codex on #808 r3, 3).
        if (!chatScopes.owns(chatId, token)) {
          return reply.code(409).send({ error: `chat ${chatId} was closed while it was being opened; open it again` });
        }
        prepareChatScratch(chatId, scope, inForceAtOpen, statementOpts);
      } catch (err) {
        // The helper removes only what it created itself (a pre-existing root is preserved) —
        // nothing more is removed here (codex on #808 r4, 3).
        chatScopes.release(chatId, token);
        return reply
          .code(500)
          .send({ error: `cannot prepare the chat's scratch root ${scope.cwd}: ${message(err)}` });
      }
      // The DEFAULT seats are the roster seats the daemon's own admission admits (F-2R2-007,
      // F-2R2-009): the seat's auth standing (a signed-out seat is refused up front, with the
      // reason, instead of failing its first turn — the same predicate `GET /roster` reports as
      // `council_eligible`) and, for a SCOPED chat, the engine's rule restated (only a seat whose
      // ACP adapter asks permissions or whose record arms the kernel write floor can be held to
      // read-only roots — with the default roster that is claude and opencode). Every seat dropped
      // here is NAMED on the response (`refused`) and in the thread (`chatSeatRefused`), so a
      // person can see why pi is missing. Explicit `clis` are passed through as asked; the engine
      // refuses per seat with its reason, which is copied into `refused` too.
      // A chat is SCOPED — held to read-only roots — when it reads repositories by its kind. `none`
      // and `system` (studio#323 R4: the platform itself, no repository) read none, so they take the
      // unscoped admission and open on an engine that predates chat scope.
      const scoped = scope.kind !== 'none' && scope.kind !== 'system';
      // ASK-C2: a single-repo ask launches BOUND (the run holds the repository read-only), so every
      // seat in standing is eligible; a wider repository scope keeps the structural rule.
      const admissionKind = scope.kind === 'repos' && scope.repos.length === 1 ? 'path-bound' : 'path';
      const refused: ChatSeatRefusal[] = [];
      // The standing roster, read ONCE: the default admission below and the engine-drop
      // attribution after the engine's open both consult it (F-A45-011).
      const standing = rosterWithStanding();
      // ASK-C1: admission applies to the DEFAULT roster and to seats NAMED in `clis` alike — the
      // engine no longer refuses a seat at open (nothing is warmed), so this is the only gate
      // between a request and the eligible roster the path launches with. The sign-in standing
      // is part of it for a named seat too: the launch hands the engine the same standing roster,
      // which benches a signed-out seat (codex on #808 r2, 5) — admitting it here would only move
      // the refusal to a launch that cannot start. An unknown key is refused by name.
      const candidates: Array<(typeof standing)[number] | { key: string }> =
        b.clis !== undefined
          ? b.clis.map((key) => standing.find((s) => String(s.key) === key) ?? { key })
          : standing;
      const clis: string[] = [];
      for (const seat of candidates) {
        const key = String(seat.key);
        if (!('auth' in seat)) {
          refused.push({ cliKey: key, reason: `seat '${key}' is not in the roster`, source: 'scope' });
          continue;
        }
        const admission = chatSeatAdmission(
          // IG1-crew-2: the standing seat carries the engine's `governance_class` and the pin
          // reading, so a scoped ask admits by the seat's governance mode (reason names it).
          seat as StandingSeat,
          seat.auth ?? 'unknown',
          scoped,
          admissionKind,
        );
        if (admission.ok) clis.push(key);
        else refused.push({ cliKey: key, reason: admission.reason, source: admission.source });
      }
      if (clis.length === 0) {
        if (chatScopes.release(chatId, token)) removeChatScratch(scope.cwd, chatScopes.base);
        return reply.code(409).send({
          error:
            (scoped && admissionKind === 'path'
              ? 'no seat in standing can be held to an ask that reads several repositories (or a project) ' +
                'the run cannot bind; scope the ask to one repository, sign a seat in, or open it unscoped'
              : refused.some((r) => r.source === 'engine')
                ? 'no seat picked for this ask can take a turn: every one is signed out, disabled, or benched by the ' +
                  'engine in a recent run (out of quota, say); sign another seat in from the Agents page, turn one ' +
                  'back on, or wait for the bench to lift'
                : 'no seat in the roster can take a turn (every seat is signed out or disabled); sign a seat ' +
                  'in from the Agents page, or name seats with `clis`') + ' — see refused',
          refused,
        });
      }
      // crew#1157: a workflow chat is ONE seat — the operator's pick (`primary`), else the first
      // admitted seat in roster order. The others are not refused; they simply do not sit this chat.
      if (workflow !== undefined) {
        const one = b.primary !== undefined && clis.includes(b.primary) ? b.primary : clis[0]!;
        clis.splice(0, clis.length, one);
      }
      try {
        // DES-ASK-TEAM-CHAT-001 §5.1 (ASK-C1): an open resolves the scope and ELIGIBILITY and warms
        // nothing — the chat is a path its first message launches, and the engine picks the PA
        // then (`path.started.selection`). Crew owns eligibility; the engine owns the pick.
        if (b.primary !== undefined && !clis.includes(b.primary)) {
          if (chatScopes.release(chatId, token)) removeChatScratch(scope.cwd, chatScopes.base);
          return reply.code(400).send({
            error:
              `primary names a seat that is not eligible for this chat: ${b.primary}` +
              ` (eligible: ${clis.join(', ')})`,
            refused,
          });
        }
        const seats: Array<{ cliKey: string; ok: boolean; error?: string }> = clis.map((cliKey) => ({
          cliKey,
          ok: true,
        }));
        let projectAttachError: string | undefined;
        let attachedMemberId: string | undefined;
        // Whether THIS open wrote the chat → project index entry (so its cleanup removes only its
        // own — a newer open of the id may hold one; codex on #808 r4, 2).
        let indexedHere = false;
        if (b.projectId !== undefined) {
          try {
            const { member, created } = await adapter.projectMemberAttach(
              b.projectId,
              'crew.chat',
              chatId,
            );
            if (created) attachedMemberId = member.id;
            // The attach awaited: publish the membership only while this open still holds the id —
            // a cancelled open's filing would overwrite the replacement's (the failed `set` below
            // detaches what was created).
            if (created && chatScopes.owns(chatId, token)) {
              projects.index.set(chatId, b.projectId);
              indexedHere = true;
              projects.bus?.emit(
                MEMBERSHIP_ATTACHED,
                { project_id: b.projectId, member: { kind: 'crew.chat', ref: chatId }, actor: actorOf(req).id },
                membershipAttachedKey(b.projectId, 'crew.chat', chatId, member.attached_at),
              );
            }
          } catch (err) {
            // The chat is open and usable; the filing failed. Said on the 201 rather than failing
            // the open — the caller can re-attach via POST /projects/:id/members.
            projectAttachError = message(err);
          }
        }
        if (!chatScopes.set(chatId, scope, token, refused, engine, scopeRequest)) {
          // The reservation was cancelled while the open was in flight — an engine `chatClosed` or a
          // `DELETE` for this id (Copilot, #518). Nothing was recorded; tear the chat down (scratch
          // root and the filing just made) instead of returning a stale 201. No path record exists
          // yet (it is published below, after the scope is committed), and the scratch root is this
          // open's only while no newer open holds the id — a replacement opened meanwhile shares the
          // directory (codex on #808 r2, 3).
          if (!chatScopes.has(chatId)) removeChatScratch(scope.cwd, chatScopes.base);
          if (b.projectId !== undefined && attachedMemberId !== undefined) {
            await adapter.projectMemberDetach(b.projectId, attachedMemberId).catch(() => false);
            if (indexedHere) projects.index.delete(chatId);
          }
          return reply.code(409).send({
            error: `chat ${chatId} was closed while it was being opened; open it again`,
          });
        }
        // ASK-C1: the path record — published only now, with the scope committed, so a message
        // cannot launch against a scope that is still being filed (codex on #808 r2, 4).
        // IG1-crew-1: with the admitted seats' records and the scope kind, so the path's view
        // names the PA's governance mode.
        askPaths.open(chatId, clis, b.primary, {
          seats: standing.filter((s) => clis.includes(String(s.key))) as unknown as GovernanceSeatInput[],
          scopeKind: !scoped ? 'unscoped' : admissionKind === 'path-bound' ? 'scoped_bound' : 'scoped',
        }, workflow);
        // Register roots for path rewriting (crew#618): absolute host paths in seat replies are
        // rewritten to repo-relative form before being stored in the transcript.
        if (chatTranscripts !== undefined && scope.repos.length > 0) {
          const roots: ChatRepoRoot[] = scope.repos.map((r) => ({ absRoot: resolve(r.rootPath), name: r.name }));
          chatTranscripts.registerRoots(chatId, roots);
        }
        // DC-S7: only a chat that actually OPENED is preface-eligible — recorded here, after the scope
        // is published, so a refused open leaves no per-chat state behind (codex r1).
        considerations.noteChatOpen(chatId, inForceAtOpen);
        // DES-SYSTEM-CHAT: the history entry (kept after the chat ends; only DELETE removes it).
        try {
          chatHistory?.opened(chatId, {
            startedOn: b.startedOn,
            cli: b.primary ?? clis[0] ?? null,
            actorId: security.authMode === 'required' ? actorOf(req).id : null,
          });
        } catch (err) {
          req.log.warn({ chatId }, `chat history entry not written: ${message(err)}`);
        }
        // The thread learns of every refused seat the way it learns of everything else — a frame
        // on /ws — AFTER the scope is published, so a reader never sees a refusal for a chat it
        // cannot yet look up.
        for (const r of refused) {
          runtime.broadcast?.({
            type: 'chatSeatRefused',
            chat: chatId,
            cliKey: r.cliKey,
            reason: r.reason,
            source: r.source,
            ...(b.projectId !== undefined ? { project_id: b.projectId } : {}),
          } as CoreEvent);
        }
        // crew#641: a chat with exactly ONE warm seat cannot disagree with itself — disclosed
        // prominently so the caller does not have to reason about the refused[] array.
        const warm = seats.filter((s) => s.ok);
        const singleSeat = warm.length === 1 ? singleSeatDisclosure(warm[0]!.cliKey, refused, 'open') : undefined;
        return reply.code(201).send({
          chatId,
          seats,
          scope,
          refused,
          ...(workflow !== undefined ? { workflow: workflow.name } : {}),
          ...(projectAttachError !== undefined ? { projectAttachError } : {}),
          ...(singleSeat !== undefined ? { singleSeat } : {}),
        });
      } catch (err) {
        // Nothing warmed: the scratch root prepared above must not linger — removed under the SAME
        // base the resolver created it in (Copilot, #518), fail-closed like every removal; only
        // while the root is still this open's (codex on #808 r3, 3).
        if (chatScopes.release(chatId, token)) removeChatScratch(scope.cwd, chatScopes.base);
        return reply.code(400).send({ error: message(err) });
      }
      } finally {
        // A reservation that never became a scope (any early return above) must not pin the id —
        // token-guarded, so a reservation that is no longer ours is left alone.
        chatScopes.release(chatId, token);
      }
    },
  );

  /**
   * The ONE 409 `turn_in_flight` body (review NIT): the send route and the re-seat route refuse for
   * the same reason and promise the same shape, so they build it in one place and cannot drift.
   * `nothingHappened` names what did NOT happen on this route — their only difference.
   */
  const turnInFlightBody = (
    chatId: string,
    inFlight: NonNullable<ReturnType<ChatTurnIndex['inFlight']>>,
    nothingHappened: string,
  ) => ({
    code: 'turn_in_flight' as const,
    error:
      `${inFlight.busy.join(', ')} ${inFlight.busy.length === 1 ? 'is' : 'are'} still answering the previous ` +
      `message in this chat (turn ${inFlight.turnId}, ${Math.round(inFlight.ageMs / 1000)}s ago: ` +
      `“${inFlight.excerpt}”) — wait for the reply, or target only idle seats. ${nothingHappened}`,
    chatId,
    turn: inFlight,
  });

  const ChatMessageSchema = z.object({
    text: z.string().min(1).max(65536),
    targets: z.array(z.string().min(1)).min(1).max(8).optional(),
    /** (api-types 0.137.0) Attachment ids from `POST /chats/:id/attachments`. */
    attachments: z.array(z.string().min(1).max(64)).optional(),
  }).strict();
  // F-RECON-017: a message sent while a targeted seat is still answering the previous one is
  // REFUSED, not queued. The engine queues silently (the worker gets the text the instant the
  // previous turn's final block lands) and its reply frames carry no message correlation, so the
  // recon saw Q2's reply render under Q3's bubble. The daemon's own turn index (`chat-turns.ts`)
  // is the record: 409 `turn_in_flight` names the turn and the busy seats — a send that targets
  // only IDLE seats passes (a stalled seat never blocks a follow-up to the one that answered) —
  // and the 202 returns the `turnId` the reply frames are stamped with (`turn_id`) on `/ws`.
  app.post(`${V}/chats/:id/messages`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ChatMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    // DES-ASK-TEAM-CHAT-001 §3, §5.1 (ASK-C1): the first message of a chat LAUNCHES one team path
    // — a user-composed plan of one `understand` step with its gate raised to the turn gate, one
    // reviewer asked for, the eligible roster as `clis`, the operator's choice as `primary`; every
    // later message CONTINUES the same path: `propose_plan(answer-N)` then `confirm_gate(Approve)`
    // at the turn gate the previous answer paused on. Nothing is fanned out: the PA is the one
    // voice, helpers talk to the PA, the reviewer raises quiet findings — all on the bus.
    const openedPath = askPaths.get(id);
    if (openedPath === undefined) {
      return reply.code(409).send({ error: `chat '${id}' is not open on this daemon — open it first (POST /chats)` });
    }
    const path = openedPath;
    if (path.eligible.length === 0) {
      return reply.code(409).send({ error: `chat '${id}' has no eligible seat — sign a seat in and re-seat it (POST /chats/:id/seats)` });
    }
    const text = parsed.data.text;
    // DES-SYSTEM-CHAT: the attachments this message carries — every id this chat's, within the caps,
    // refused before anything is reserved or sent.
    let attached: Array<ChatAttachment & { path: string }> = [];
    if (parsed.data.attachments !== undefined && parsed.data.attachments.length > 0) {
      try {
        attached = chatAttachments.resolve(id, parsed.data.attachments);
      } catch (err) {
        if (err instanceof AttachmentError) return reply.code(err.status).send(err.body());
        throw err;
      }
    }
    // What the seats receive: the operator's words, then the attachments block (paths + text).
    let seatText = text;
    let scope = chatScopes.get(id);
    const storedScope = scope;
    let engine = chatScopes.engineOf(id);
    let voice: string[] = [];
    let audience: string[] = [];
    // crew#641/#650 re-stated for a path: ONE eligible seat means no distinct reviewer and no
    // helper — said on every turn (the engine's `member.joined{seat:null}` says it on the bus).
    const singleSeat202 =
      path.eligible.length === 1
        ? { singleSeat: singleSeatDisclosure(path.eligible[0]!, chatScopes.refusedOf(id), 'turn') }
        : {};
    // F6: a message while the PA is still answering — the previous turn has no reply yet (the
    // run may already wait at its gate while the relay's reply is a bus poll away; codex on #810
    // r1, 3) — is refused: nothing is sent, the composer keeps the draft.
    const pendingTurn = chatTurns.inFlight(id);
    if (pendingTurn !== null) {
      return reply.code(409).send(turnInFlightBody(id, pendingTurn, 'Nothing was sent.'));
    }
    // One message at a time per chat, on this daemon: the reservation covers the launch, and a
    // continuation's status read → proposal → approval (two continuations racing would both
    // read `awaiting_human` and both hold an edit; the second's approval then fails).
    const lease = askPaths.reserve(id);
    if (lease === null) {
      return reply.code(409).send({
        code: 'turn_in_flight' as const,
        error: `${path.pa ?? 'the primary agent'} is still answering the previous message in this chat — wait for the reply. Nothing was sent.`,
        chatId: id,
        ...(path.runId !== undefined ? { runId: path.runId } : {}),
      });
    }
    // crew#826: the turn lives as long as its answer step may (`budget_secs`), not 3× the pool knob.
    let turn: ReturnType<ChatTurnIndex['begin']> = null;
    let turnId: string = randomUUID();
    // What an ACCEPTED message records — the engine has it, so a persistence failure here is
    // logged, never a retraction of a turn that is already being answered (codex on #808 r2, 9).
    const persistAccepted = (preface: string | null, after: () => void): void => {
      try {
        after();
        if (preface !== null) chatTranscripts?.appendSystem(id, turnId, preface);
        chatTranscripts?.appendUser(id, turnId, text, voice, attached.map(attachmentWire));
        // The recorder's audience is the turn's AS THE TURN INDEX HOLDS IT NOW: the eligible roster
        // for a random pick, or the PA the relay narrowed it to during the engine awaits above
        // (`path.started` / `path.repicked` may land before this record exists — ASK-C2, codex on
        // #810 r2, 3).
        const settled = chatTurns.turnsOf(id).find((t) => t.turnId === turnId)?.seats;
        const pa = askPaths.get(id)?.pa ?? null;
        chatRecorder?.noteSend(
          id,
          turnId,
          actorOf(req),
          text,
          // The turn index's voice; a turn already ended by an early reply names none, so the
          // path's PA stands in; the reserved audience last.
          settled !== undefined && settled.length > 0 ? settled : pa !== null ? [pa] : audience,
        );
      } catch (err) {
        app.log.warn(`chat ${id}: turn ${turnId} was accepted by the engine but not fully recorded: ${message(err)}`);
      }
    };
    // DC-S7: the rules the chat's seats were told about ride the step's instructions, as the
    // preface rode a pool send; told only once the send is accepted (`commit`).
    // crew#1155: the installed MCP tools and the one command that reaches them (the broker), read
    // per turn so a server installed or disabled since the last turn is reflected.
    let mcpTools: string | null = null;
    const withPreface = (preface: string | null): string => {
      const body = mcpTools !== null ? `${mcpTools}\n\n${seatText}` : seatText;
      return preface !== null ? `${preface}\n\n${body}` : body;
    };
    try {
      const rules = (await considerations.inForceFor(scope?.projectId ?? null)).rules;
      mcpTools = await chatMcpToolsFor(runtime.mcp);
      // crew#1020: a project/everything chat must see repos attached since open. Admission was
      // under this scope KIND and the kind stays the same, so do not re-run seat admission.
      const scopeRequest = chatScopes.requestOf(id);
      if (scope !== undefined && (scope.kind === 'project' || scope.kind === 'everything') && scopeRequest !== undefined) {
        try {
          if (scopeRequest.projectId !== undefined && await adapter.projectGet(scopeRequest.projectId) === null) {
            throw new Error(`Project ${scopeRequest.projectId} not found`);
          }
          const resolution = await resolveScope(scopeRequest, req);
          if (!resolution.ok) throw new Error(resolution.error);
          // Retain this chat's scratch root even if the resolver's defaults change (crew#1020).
          // Resolve only: a refused message must leave the stored scope, executing seats' files
          // and transcript roots untouched. Publish after every refusal check, just before send.
          engine = { ...resolution.engine, cwd: scope.cwd };
          scope = { ...resolution.scope, cwd: scope.cwd };
        } catch (err) {
          req.log.warn({ chatId: id }, `chat scope refresh failed; keeping stored scope: ${message(err)}`);
        }
      }
      if (askPaths.get(id)?.generation !== lease) {
        return reply.code(409).send({ error: `chat '${id}' was closed while the message was in flight; nothing was sent` });
      }
      if (path.runId !== undefined) {
        const view = (await adapter.sessionsDetail()).find((v) => v.session.id === path.runId);
        if (view === undefined) {
          askPaths.release(id, lease);
          return reply.code(409).send({ error: `chat '${id}': its path ${path.runId} is gone — open a new chat` });
        }
        const status = String(view.session.status);
        if (status !== 'awaiting_human') {
          askPaths.release(id, lease);
          const who = path.pa ?? 'the primary agent';
          return reply.code(409).send({
            code: 'turn_in_flight' as const,
            error:
              status === 'executing' || status === 'running'
                ? `${who} is still answering the previous message in this chat — wait for the reply. Nothing was sent.`
                : `chat '${id}': its path ${path.runId} is ${status}, not waiting for your turn — nothing was sent`,
            chatId: id,
            runId: path.runId,
            status,
          });
        }
        // The status read awaited: the chat may have been closed (and its id reopened) meanwhile —
        // nothing of this message may land on the newcomer (codex on #808 r3, 2).
        if (askPaths.get(id)?.generation !== lease) {
          return reply.code(409).send({ error: `chat '${id}' was closed while the message was in flight; nothing was sent` });
        }
      }
      const codeGraphDb = engine?.codeGraphDb ?? null;
      // A set: two registrations of one checkout are one root (codex r1).
      const readRoots = [...new Set(engine?.readRoots ?? [])].sort();
      // Only project scopes refresh a project graph; fixed repo scopes may use the engine's
      // own repo graph instead of input.projectGraph, and everything scopes have no graph.
      // crew#1034: nor can a run acquire a READ ROOT after launch (the engine fixes its read
      // boundary then), so a repository attached or registered since is refused here, at once, with
      // the sentence — never accepted into a run whose boundary refuses every read of it.
      const graphChanged = scope?.kind === 'project' && codeGraphDb !== path.launchGraphBinding;
      const rootsChanged = (scope?.kind === 'project' || scope?.kind === 'everything') &&
        path.launchReadRoots !== undefined && JSON.stringify(readRoots) !== JSON.stringify(path.launchReadRoots);
      if (path.runId !== undefined && (graphChanged || rootsChanged)) {
        askPaths.release(id, lease);
        return reply.code(409).send({
          code: 'chat_scope_changed',
          error: `This chat's repositories or their code graph changed since it started (${scope?.repos.length ?? 0} now in scope). Start a new chat to read them — this one keeps its original scope.`,
        });
      }
      const pending = await considerations.pendingPreface(id, { inForce: rules });
      // The last await before delivery may also have closed/reopened the chat. From this check
      // through publication and the send there is no await, so no executing turn's files change.
      if (askPaths.get(id)?.generation !== lease || chatScopes.get(id) !== storedScope) {
        return reply.code(409).send({ error: `chat '${id}' was closed while the message was in flight; nothing was sent` });
      }
      if (storedScope !== undefined && scope !== undefined && engine !== undefined &&
        (JSON.stringify(scope) !== JSON.stringify(storedScope) || JSON.stringify(engine) !== JSON.stringify(chatScopes.engineOf(id)))) {
        prepareChatScratch(id, scope, rules, { analysis: path.workflow !== undefined });
        if (chatScopes.refresh(id, storedScope, scope, engine)) {
          chatTranscripts?.registerRoots(id, scope.repos.map((r) => ({ absRoot: resolve(r.rootPath), name: r.name })));
        }
      }
      // DES-SYSTEM-CHAT: stage the attachments read-only in the chat's scratch root (a read root of
      // its run since launch) and list them in the turn's instructions.
      const attachRoot = scope !== undefined ? join(scope.cwd, 'attachments') : null;
      if (attached.length > 0) {
        if (attachRoot === null) {
          askPaths.release(id, lease);
          return reply.code(409).send({ error: `chat '${id}' has no scratch root to hand its attachments to the seat; nothing was sent` });
        }
        try {
          seatText = `${text}\n${attachmentsBlock(stageForSeat(attached, attachRoot))}`;
        } catch (err) {
          askPaths.release(id, lease);
          return reply.code(500).send({ error: `could not stage the attachments for the seat: ${message(err)}` });
        }
      }
      voice = path.pa !== null ? [path.pa] : [];
      // A random pick reserves every eligible seat until the relay names the PA.
      audience = voice.length > 0 ? voice : path.eligible;
      turn = chatTurns.begin(id, audience, text, ASK_TURN_BUDGET_SECS);
      turnId = turn?.turnId ?? turnId;
      // A repo-bound path can deliver; project and multi-repo scopes remain read-only asks. A workflow
      // chat (crew#1157) never delivers: it is bound to its repository read-only, with no deliver.
      const repoRef = scope?.kind === 'repos' && scope.repos.length === 1 ? scope.repos[0]!.id : undefined;
      const delivers = repoRef !== undefined && path.workflow === undefined;
      const statementOpts = { analysis: path.workflow !== undefined };
      const projectId = scope?.projectId;
      if (path.runId === undefined) {
        const stepId = 'answer-1';
        const generation = path.generation;
        const roster = rosterWithStanding().filter((seat) => path.eligible.includes(String(seat.key)));
        // crew#823: the run is titled by the operator's question (every reader titles a run from
        // `problem`); the scope statement grounds the seats from the first answer step's
        // instructions instead of standing in as the run's title.
        const instructions =
          scope !== undefined ? `${chatScopeStatement(id, scope, rules, statementOpts)}\n\n${withPreface(pending.preface)}` : withPreface(pending.preface);
        const input: LaunchRunInput = {
          problem: text,
          sessionId: randomUUID(),
          clisJson: JSON.stringify(roster),
          // A workflow chat is one seat and asks for no reviewer (crew#1157).
          plan: {
            steps: [chatTurnStep(stepId, instructions, path.workflow)],
            ...(path.workflow === undefined ? { monitors: { asked: 1 } } : {}),
          },
          ...(path.primary !== undefined ? { primary: path.primary } : {}),
          ...(repoRef !== undefined ? (delivers ? { repoRef, deliver: 'pr' as const } : { repoRef }) : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(scope?.kind === 'project' && codeGraphDb !== null ? { projectGraph: { dbPath: codeGraphDb } } : {}),
          // crew#1034: the scope's repositories are the run's read roots, graph or no graph — the
          // statement tells the seats to read them at their paths, so the boundary must let them.
          // DES-SYSTEM-CHAT: plus the chat's attachments directory, from launch (a run cannot gain a
          // read root later), so a file attached on any later turn is readable too.
          ...(readRoots.length > 0 || attachRoot !== null
            ? { extraReadRoots: [...readRoots, ...(attachRoot !== null ? [ensureDir(attachRoot)] : [])] }
            : {}),
        };
        const runId = await adapter.launchRun(input);
        // The scope's roots (not the attachments directory) are what a later turn compares against.
        if (!askPaths.started(id, generation, runId, stepId, input.projectGraph?.dbPath ?? null, readRoots)) {
          // The chat was closed (End) while the launch was in flight: the run must not outlive it.
          await adapter.cancelRun(runId).catch(() => undefined);
          if (turn !== null) chatTurns.abort(id, turn.turnId);
          return reply.code(409).send({ error: `chat '${id}' was closed while its path was launching; the run was cancelled` });
        }
        pending.commit();
        persistAccepted(pending.preface, () => {
          runtime.linkChatRun?.(id, runId);
          if (projectId !== undefined) {
            // crew#823: the engine attached the crew.run membership with the launch record (as for
            // POST /runs); this is the post-commit half — the run DTO's `project_id` and the /ws
            // frames read the index, and the membership event says the run joined the chat's project.
            projects.index.set(runId, projectId);
            projects.bus?.emit(
              MEMBERSHIP_ATTACHED,
              { project_id: projectId, member: { kind: 'crew.run', ref: runId }, actor: actorOf(req).id },
              membershipAttachedKey(projectId, 'crew.run', runId, Date.now()),
            );
          }
          recordRunLaunched(audit, runTimingIndex, actorOf(req), runId, {
            chatId: id,
            askPath: true,
            ...(repoRef !== undefined ? { repoRef } : {}),
            ...(projectId !== undefined ? { projectId } : {}),
            ...(path.workflow !== undefined ? { chatWorkflow: path.workflow.name } : {}),
            deliver: delivers ? 'pr' : 'none',
          });
        });
        return reply.code(202).send({
          seats: voice, turnId, runId, stepId, ...singleSeat202,
        });
      }
      const stepId = askPaths.nextStep(id);
      // crew#1033: EVERY answer step carries the scope statement, as the first one does. A seat on a
      // single-shot carrier (codex on the wrapped carrier) remembers nothing of the first turn, so a
      // follow-up told only the question answered "the supplied repository contains only tmp".
      const instructions =
        scope !== undefined ? `${chatScopeStatement(id, scope, rules, statementOpts)}\n\n${withPreface(pending.preface)}` : withPreface(pending.preface);
      // The continuation answers the path run's gate: under the per-run decision lock it re-reads the
      // run and is judged by the record before it proposes or confirms anything (crew#1083 round 7).
      // The status read above is a pre-check that changes nothing; this read is the one that counts.
      const pathRunId = path.runId;
      const refused = await decideExclusively(pathRunId, async (): Promise<{ code: number; body: unknown } | null> => {
        const view = (await adapter.sessionsDetail()).find((v) => v.session.id === pathRunId);
        if (view === undefined || view.session.status !== 'awaiting_human') {
          return { code: 409, body: {
            code: 'turn_in_flight',
            error: `chat '${id}': its path ${pathRunId} is ${view?.session.status ?? 'gone'}, not waiting for your turn — nothing was sent`,
            chatId: id,
            runId: pathRunId,
          } };
        }
        const decided = await gateForDecision(view, undefined);
        if ('refusal' in decided) return decided.refusal;
        await adapter.proposePlan(pathRunId, { steps: [chatTurnStep(stepId, instructions, path.workflow)] }, turnId);
        await adapter.confirmGate(pathRunId, true);
        return null;
      });
      if (refused !== null) {
        askPaths.release(id, lease);
        if (turn !== null) chatTurns.abort(id, turn.turnId);
        return reply.code(refused.code).send(refused.body);
      }
      askPaths.release(id, lease);
      if (!askPaths.continued(id, lease, stepId)) {
        // Closed between the proposal and here: the DELETE cancelled the run this was accepted on.
        return reply.code(409).send({ error: `chat '${id}' was closed while the message was in flight; its path was cancelled` });
      }
      pending.commit();
      persistAccepted(pending.preface, () => undefined);
      return reply.code(202).send({ seats: voice, turnId, runId: path.runId, stepId, ...singleSeat202 });
    } catch (err) {
      askPaths.release(id, lease);
      if (turn !== null) chatTurns.abort(id, turn.turnId);
      return reply.code(400).send({ error: message(err) });
    }
  });
  const ChatSeatsSchema = z.object({
    clis: z.array(z.string().min(1)).min(1).max(8),
  }).strict();
  app.post(
    `${V}/chats/:id/seats`,
    // Typed like every neighbouring chat route (review HIGH-1): the names bind the 0.39.0 api-types
    // mirror to this row — `ChatSeatsBody { clis }` in, `ChatSeatsResponse { chatId, seats, refused }`
    // out (the 201's own `ChatSeatOutcome` / `ChatSeatRefusal` shapes, which 0.38.0 already ships).
    {
      config: {
        manifest: {
          requestType: 'ChatSeatsBody',
          responseType: 'ChatSeatsResponse',
          statusCodes: [200, 400, 404, 409],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = ChatSeatsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
      }
      const engine = chatScopes.engineOf(id);
      // ASK-C1: a chat is open here when it has a path record (every open leaves one, scoped or
      // not) — the engine scope alone is the pool-era test.
      const launched = askPaths.get(id);
      if (engine === undefined && launched === undefined) {
        return reply.code(404).send({
          error: `chat ${id} is not open on this daemon — open a chat first, then re-seat into it`,
        });
      }
      const clis = [...new Set(parsed.data.clis)];
      // A seat mid-turn is not re-warmed under its own reply (the same rule as a send).
      const inFlight = chatTurns.inFlight(id, clis);
      if (inFlight !== null) {
        return reply.code(409).send(turnInFlightBody(id, inFlight, 'No seat was re-warmed.'));
      }
      // ASK-C1: the path's roster is handed to the engine at launch and never updated after —
      // a seat admitted later would be reported eligible and never reach the run (codex on #808
      // r2, 6). Re-seat before the first message; after it, a new chat.
      if (launched?.runId !== undefined) {
        return reply.code(409).send({
          error: `chat '${id}' has launched its path (${launched.runId}); its seats are fixed for this ask — open a new chat to seat ${clis.join(', ')}`,
          chatId: id,
          runId: launched.runId,
        });
      }
      // crew#1157 (xreview on #1160): an analysis chat seats ONE helper; a re-seat may re-warm that
      // seat, never add another.
      if (launched?.workflow !== undefined && !(clis.length === 1 && launched.eligible.includes(clis[0]!))) {
        return reply.code(409).send({
          code: 'analysis_one_seat',
          error: `chat '${id}' is an analysis (${launched.workflow}) and seats one helper (${launched.eligible.join(', ')}); open a new chat to ask another`,
          chatId: id,
        });
      }
      if (launched?.busy === true) {
        // The first message is launching with the roster as it stands (codex on #808 r3, 4).
        return reply.code(409).send({
          code: 'turn_in_flight' as const,
          error: `chat '${id}' is launching its path with the seats as they stand — a seat added now would never reach the run. Nothing was re-seated.`,
          chatId: id,
        });
      }
      try {
        // ASK-C1: a re-seat re-admits the named seats that pass admission NOW (a sign-in fixed)
        // into the path's eligible roster; nothing is warmed and the engine is not called.
        const scopeNow = chatScopes.get(id);
        const scopedChat = (scopeNow?.kind ?? 'none') !== 'none' && scopeNow?.kind !== 'system';
        const reseatKind = scopeNow?.kind === 'repos' && scopeNow.repos.length === 1 ? 'path-bound' : 'path';
        const standingNow = rosterWithStanding();
        const seats = clis.map((cliKey) => {
          const seat = standingNow.find((s) => String(s.key) === cliKey);
          if (seat === undefined) return { cliKey, ok: false, error: `seat '${cliKey}' is not in the roster` };
          const admission = chatSeatAdmission(
            // IG1-crew-2: the standing seat carries the engine's `governance_class` and the pin
            // reading, so a scoped ask admits by the seat's governance mode (reason names it).
            seat as StandingSeat,
            seat.auth ?? 'unknown',
            scopedChat,
            reseatKind,
          );
          return admission.ok ? { cliKey, ok: true } : { cliKey, ok: false, error: admission.reason };
        });
        askPaths.admit(id, seats.filter((s) => s.ok).map((s) => s.cliKey));
        const refused = chatScopes.foldSeats(id, seats);
        return { chatId: id, seats, refused };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  // Enumerate live chats (FINDING-027 gap 4). Chat sessions deliberately outlive the page, and
  // their ids are minted client-side — so before this route the only record of an orphaned seat
  // lived in the tab that abandoned it, and an operator could not reclaim one without restarting
  // the daemon. Registered BEFORE `/chats/:id` is irrelevant to fastify (it routes on the literal
  // segment first), but the order reads the way the routes nest.
  app.get(
    `${V}/chats`,
    { config: { manifest: { responseType: 'ChatListResponse', statusCodes: [200, 400, 501] } } },
    async (req, reply) => {
    // DES-SYSTEM-CHAT (api-types 0.137.0): the paged history rides beside the live rows.
    const q = req.query as { limit?: string | string[]; cursor?: string | string[]; status?: string | string[] };
    const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
    const limitRaw = one(q.limit);
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > CHAT_HISTORY_MAX_LIMIT)) {
      return reply.code(400).send({ error: `\`limit\` must be a whole number from 1 to ${CHAT_HISTORY_MAX_LIMIT}` });
    }
    const cursor = one(q.cursor);
    if (cursor !== undefined && decodeCursor(cursor) === null) return reply.code(400).send({ error: '`cursor` is not a cursor this daemon issued' });
    const status = one(q.status) ?? 'all';
    if (status !== 'all' && status !== 'open' && status !== 'closed') {
      return reply.code(400).send({ error: '`status` must be open, closed or all' });
    }
    const history =
      chatHistory === null
        ? {}
        : chatHistory.list({
            ...(limit !== undefined ? { limit } : {}),
            cursor: cursor ?? null,
            status,
            actorId: security.authMode === 'required' ? actorOf(req).id : null,
            liveCli: (cid) => askPaths.get(cid)?.pa ?? null,
            isLive: (cid) => askPaths.get(cid) !== undefined || chatScopes.get(cid) !== undefined,
          });
    try {
      const pool = await adapter.chatList().catch((err: unknown) => {
        if (err instanceof ChatUnsupportedError) return [];
        throw err;
      });
      // ASK-C1: an ask path is a chat of this daemon with no engine pool row — listed from the
      // ask-path index (the pool entries stay until ASK-K4 deletes the pool).
      const paths = askPaths.list().map((p) => {
        const engine = chatScopes.engineOf(p.chatId);
        return {
          chatId: p.chatId,
          seats: [...p.eligible],
          idleSecs: null,
          ...(engine !== undefined ? { cwd: engine.cwd, codeGraphDb: engine.codeGraphDb ?? null, readRoots: [...engine.readRoots] } : {}),
        };
      });
      const seen = new Set(paths.map((p) => p.chatId));
      // Under `auth: required` a live chat another actor opened is not listed (its history entry
      // names its opener); local mode lists every live chat, as before.
      const viewer = security.authMode === 'required' ? actorOf(req).id : null;
      const mine = (cid: string): boolean => viewer === null || chatHistory === null || chatHistory.entry(cid) === null || chatHistory.visibleTo(cid, viewer);
      return { chats: [...paths, ...pool.filter((c) => !seen.has(c.chatId))].filter((c) => mine(c.chatId)), ...history };
    } catch (err) {
      // A build that cannot do chat is a capability gap, not a bad request: 501 tells an operator to
      // upgrade rather than to fix a call that was already correct. Branching on the type, not on
      // the message — regexing the text here caught the missing-binding phrasing and missed the
      // engine's own ("chat unsupported: engine spawned without the ACP runner"), so half of one
      // condition answered 400.
      return reply
        .code(err instanceof ChatUnsupportedError ? 501 : 400)
        .send({ error: message(err) });
    }
    },
  );

  // ── Interactive documents, daemon-wide, WITHOUT spawning a bridge (wave 6, studio #263) ──────
  // The per-project listing (`GET /projects/:id/interactive/api/docs`) asks the project's bridge —
  // one `wicked-interactive serve` per project root, ≈60 s cold start — so a skin must never fan
  // it out on mount. This reads what the bridge reads (every project's docs root, each slug child
  // carrying a `versions.json`) plus what only the daemon knows (the seams that answered each doc
  // and the runs they launched, from the handoff ledgers). `?includeRetired=1` lists tombstones.
  app.get(
    `${V}/interactive/docs`,
    { config: { manifest: { responseType: 'InteractiveDocsListing', statusCodes: [200] } } },
    async (req) => {
      const q = req.query as { includeRetired?: string | string[] };
      const flag = Array.isArray(q.includeRetired) ? q.includeRetired[0] : q.includeRetired;
      return listInteractiveDocs({
        adapter,
        settings: projectSettings,
        docRuns,
        // crew#896: the index carries the grounding the per-project list carries.
        ...(runtime.docGrounding !== undefined ? { groundingStore: runtime.docGrounding } : {}),
        includeRetired: flag === '1' || flag === 'true',
      });
    },
  );

  app.get(
    `${V}/chats/:id`,
    { config: { manifest: { responseType: 'ChatDetailResponse', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        // The scope recorded at open (crew#502) — `null` for a chat this daemon did not open — and
        // the seats refused at open (F-A45-011), so the studio's admission copy survives a reload.
        return {
          chatId: id,
          // ASK-C1: the eligible roster is the chat's seats (no warm pool); a chat this daemon
          // did not open answers `[]`.
          seats: askPaths.get(id)?.eligible ?? [],
          scope: chatScopes.get(id) ?? null,
          refused: chatScopes.refusedOf(id) ?? null,
          ...(askPaths.view(id) !== undefined ? { path: askPaths.view(id) } : {}),
          // DES-L5 (D-13): the transcript so far, append order — `[]` before the first persisted
          // turn. The file goes with the chat on `chatClosed` UNLESS a run promoted from it is still
          // live (crew#619 retention — dropped when that run terminals), so a reclaimed id answers
          // `[]` only once no promoted run holds the old file.
          ...(chatTranscripts !== undefined ? { messages: chatTranscripts.read(id) } : {}),
        };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  // Ending a chat — shared by DELETE (end + delete its history) and POST /close (end, keep it).
  const endChat = async (
    id: string,
    /** Runs right after the close fold, with NO await before it: the id cannot have been reopened
     *  yet, so a history operation here can never land on a replacement chat (xreview r1 on #1140). */
    afterFold?: () => void,
  ): Promise<{ ok: true; cancelError?: { runId: string; error: string } } | { ok: false; error: string }> => {
    // DES-SYSTEM-CHAT: the answering CLI the history names is the path's PA, while it is known.
    const pa = askPaths.get(id)?.pa;
    if (pa !== undefined && pa !== null) chatHistory?.setCli(id, pa);
    // The scratch root goes with the chat at once, whether or not the engine still knew it
    // (crew#502). ASK-C1: the daemon owns the close, so the id is HELD — no grace timer — until
    // this close settles below; a reopen meanwhile is refused and a second DELETE joins this one
    // (nothing of the closed chat can land on a reuse — codex on #808 r5).
    const ticket = chatScopes.holdClose(id);
    if (ticket === null) return { ok: true as const };
    chatTurns.closed(id);
    // ASK-C1: End cancels the path (`path.ended{status:"cancelled"}`); the engine holds no chat
    // row for an ask, so the daemon closes the id itself and the transcript follows the chat
    // through the same `chatClosed` fold a pool chat used (dropped unless a promoted run retains it).
    const path = askPaths.close(id);
    try {
      const projectId = projects.index.projectOf(id) ?? undefined;
      const frame = {
        type: 'chatClosed',
        chat: id,
        reason: 'closed',
        ...(projectId !== undefined ? { project_id: projectId } : {}),
      } as CoreEvent;
      // The server's fold (scope slot, decisions, considerations, retention-aware transcript
      // drop) and the /ws fan-out — the same path an engine `chatClosed` took. Folded BEFORE the
      // awaited cancel: a close that lands after an await can land on a chat that reused the id
      // meanwhile (codex on #808 r2, 2). AWAITED: the decision recorder settles the chat's open
      // turns under the chat's own project before the id is free (the slot is parked `closing`
      // meanwhile, so a reopen waits), and only then is nothing of the closed chat pending
      // (codex on #808 r4, 1).
      if (runtime.closeChat !== undefined) await runtime.closeChat(frame, path?.runId, ticket);
      else {
        chatScopes.closeHeld(id, ticket);
        runtime.broadcast?.(frame);
      }
      afterFold?.();
      if (path?.runId !== undefined) {
        const runId = path.runId;
        const cancelled = await adapter.cancelRun(runId).then(() => null, (err: unknown) => message(err));
        if (cancelled !== null) return { ok: true as const, cancelError: { runId, error: cancelled } };
      }
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: message(err) };
    } finally {
      // Never left held: a fold that threw frees the id here (its own close settles it otherwise).
      chatScopes.closeHeld(id, ticket);
    }
  };

  app.delete(`${V}/chats/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    // DES-SYSTEM-CHAT: DELETE also deletes the chat's history and attachments (POST /close keeps them)
    // — under `auth: required` only its opener's (another actor's chat is not this caller's to end).
    const viewer = security.authMode === 'required' ? actorOf(req).id : null;
    if (chatHistory !== null && chatHistory.entry(id) !== null && !chatHistory.visibleTo(id, viewer)) {
      return reply.code(404).send({ error: `no chat ${id} on this daemon` });
    }
    const removeHistory = (): void => {
      chatHistory?.remove(id);
      chatAttachments.removeChat(id);
    };
    const ended = await endChat(id, removeHistory);
    if (!ended.ok) return reply.code(400).send({ error: ended.error });
    // A chat the daemon no longer held (no fold ran): its kept history goes too.
    if (chatHistory?.entry(id) !== null && chatScopes.get(id) === undefined && askPaths.get(id) === undefined) removeHistory();
    return { ok: true };
  });

  // DES-SYSTEM-CHAT (api-types 0.137.0): end the chat and KEEP its history and attachments.
  app.post(
    `${V}/chats/:id/close`,
    { config: { manifest: { responseType: 'ChatCloseResponse', statusCodes: [200, 400, 404, 501, 502] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (chatHistory === null) return reply.code(501).send({ error: 'this daemon keeps no chat history' });
      const viewer = security.authMode === 'required' ? actorOf(req).id : null;
      const known = chatHistory.entry(id) !== null;
      if ((!known && askPaths.get(id) === undefined) || (known && !chatHistory.visibleTo(id, viewer))) {
        return reply.code(404).send({ error: `no chat ${id} on this daemon` });
      }
      // The close fold archives it; closing here too (before the id is free) covers a route set
      // without the fold, and is a no-op after it.
      const ended = await endChat(id, () => chatHistory.closed(id));
      if (!ended.ok) return reply.code(400).send({ error: ended.error });
      const chat = chatHistory.entry(id);
      if (chat === null) return reply.code(404).send({ error: `chat ${id} has no history on this daemon` });
      if (ended.cancelError !== undefined) {
        // The chat is ended and its history kept, but its run was NOT cancelled: said, never "ok".
        return reply.code(502).send({
          error: `chat ${id} is closed and its history kept, but its run ${ended.cancelError.runId} could not be cancelled (${ended.cancelError.error}) — cancel it from the run`,
          runId: ended.cancelError.runId,
          chat,
        });
      }
      return { ok: true, chat };
    },
  );

  // DES-SYSTEM-CHAT (api-types 0.137.0): reopen a chat — its records, live or kept.
  app.get(
    `${V}/chats/:id/messages`,
    { config: { manifest: { responseType: 'ChatMessagesResponse', statusCodes: [200, 404, 501] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (chatHistory === null) return reply.code(501).send({ error: 'this daemon keeps no chat history' });
      const viewer = security.authMode === 'required' ? actorOf(req).id : null;
      const chat = chatHistory.visibleTo(id, viewer)
        ? chatHistory.entry(id, askPaths.get(id)?.pa ?? null, (cid) => askPaths.get(cid) !== undefined || chatScopes.get(cid) !== undefined)
        : null;
      const messages = chat === null ? null : chatHistory.messages(id);
      if (chat === null || messages === null) return reply.code(404).send({ error: `no chat ${id} in this daemon's history` });
      return { chat, messages, attachments: chatAttachments.list(id) };
    },
  );

  // DES-SYSTEM-CHAT (api-types 0.137.0): upload files to a chat (multipart/form-data). The body is
  // buffered by a parser scoped to this route alone, capped a little over the per-message total;
  // the per-file and per-message caps, and the types (decided from the bytes), are checked before
  // anything is stored.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_MESSAGE_BYTES + 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.setErrorHandler((err, _req, reply) => {
      if ((err as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.code(413).send(new AttachmentError(413, 'attachments_too_large', `the upload is over the ${Math.round(ATTACHMENT_MAX_MESSAGE_BYTES / 1048576)} MiB limit per message`).body());
      }
      if ((err as { code?: unknown }).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        return reply.code(400).send(new AttachmentError(400, 'attachment_malformed', 'upload files as multipart/form-data').body());
      }
      return reply.send(err);
    });
    scope.post(
      `${V}/chats/:id/attachments`,
      { config: { manifest: { requestType: 'multipart/form-data', responseType: 'ChatAttachmentUploadResponse', statusCodes: [201, 400, 404, 413, 415] } } },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        // Only a chat open on this daemon takes files (a message can only be sent on one), and
        // under `auth: required` only its opener's.
        const viewer = security.authMode === 'required' ? actorOf(req).id : null;
        if (askPaths.get(id) === undefined || (chatHistory !== null && chatHistory.entry(id) !== null && !chatHistory.visibleTo(id, viewer))) {
          return reply.code(404).send({ error: `no open chat ${id} on this daemon` });
        }
        const boundary = boundaryOf(req.headers['content-type']);
        if (boundary === null || !Buffer.isBuffer(req.body)) {
          return reply.code(400).send(new AttachmentError(400, 'attachment_malformed', 'upload files as multipart/form-data with a boundary').body());
        }
        try {
          const attachments = chatAttachments.add(id, parseMultipart(req.body, boundary));
          return reply.code(201).send({ attachments, limits: ATTACHMENT_LIMITS });
        } catch (err) {
          if (err instanceof AttachmentError) return reply.code(err.status).send(err.body());
          throw err;
        }
      },
    );
  });

  // A unit's captured transcript. `unitKey` accepts the fully-qualified id (`run-1:survey`),
  // the id suffix (`survey`, `u3`), or the ordinal (`u3`, `3`) — see `resolveUnit`.
  //
  // A `null` body is never bare here. An unknown run or an unknown key is a 404 that names the
  // keys this run does have; a unit that exists but has no stored transcript answers 200 with
  // `outputUnavailable` saying WHICH cause applies — denied, not finished, or a store that
  // disagrees with itself. It previously answered `200 {"output": null}` to all four, so the
  // failed unit an operator opens during triage was the one that told them nothing (FINDING-006).
  // crew#720: the run's final-codebase zip (every delivery, every outcome). 404 for an unknown run
  // or one with no archive yet; the record (`AgentSession.codebase_archive`) names the same sha256,
  // which the answer also carries as `X-Content-SHA256`.
  app.get(
    `${V}/runs/:id/artifacts/codebase.zip`,
    { config: { manifest: { responseType: 'binary (application/zip)', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const opened = runtime.codebaseArchives?.open(id) ?? null;
      if (opened === null || opened.rec.url !== codebaseArchiveUrl(id)) {
        opened?.stream.destroy();
        return reply.code(404).send({ error: `run ${id} has no codebase archive` });
      }
      const rec = opened.rec;
      const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${safe}-codebase.zip"`)
        .header('x-content-sha256', rec.sha256)
        .header('content-length', String(rec.bytes))
        .send(opened.stream);
    },
  );

  app.get(`${V}/runs/:id/units/:unitKey/output`, async (req, reply) => {
    const { id, unitKey } = req.params as { id: string; unitKey: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const unit = resolveUnit(run, unitKey);
    if (!unit) {
      return reply.code(404).send({
        error: `Unit '${unitKey}' not found in run ${id}`,
        units: unitKeysFor(run),
      });
    }
    const rawAttempt = (req.query as { attempt?: string | string[] }).attempt;
    const attemptArg = Array.isArray(rawAttempt) ? rawAttempt[0] : rawAttempt;
    const wanted = attemptArg === undefined || attemptArg === '' ? undefined : /^\d{1,9}$/.test(attemptArg) ? Number(attemptArg) : NaN;
    if (wanted !== undefined && !Number.isSafeInteger(wanted)) {
      return reply.code(400).send({ error: '`attempt` must be a non-negative integer' });
    }
    // Keyed off the unit RECORD (the same derivation the evidence bundle uses), not off the
    // caller's path segment — the two disagreeing is what made a resolvable unit unreadable.
    const output = await adapter.workOutput(coreUnitId(id, unit));
    // crew#848: which attempt those bytes are. The engine keeps one transcript per unit (the last
    // attempt that folded ok); the durable log has one `unitOutputCaptured` per attempt.
    const events = typeof adapter.runEvents === 'function' ? await adapter.runEvents(id).catch(() => null) : null;
    const attempts = capturedAttempts((events ?? []) as unknown as Record<string, unknown>[], unit.ord);
    const served = output !== null ? storedAttempt(attempts, output) : null;
    const latest = attempts[attempts.length - 1];
    const meta = {
      ...(served !== null ? { attempt: served } : {}),
      ...(latest !== undefined ? { latestAttempt: latest.attempt } : {}),
      ...(events !== null ? { attempts } : {}),
    };
    if (served !== null) void reply.header('x-wicked-unit-attempt', String(served));
    if (wanted !== undefined) {
      const rec = attempts.find((a) => a.attempt === wanted);
      if (rec === undefined) {
        return reply.code(404).send({
          error: `Unit ${unit.ord} of run ${id} has no attempt ${wanted} on record`,
          attempts: attempts.map((a) => a.attempt),
        });
      }
      if (output !== null && served === wanted) return reply.send({ output, ...meta });
      return reply.send({ output: null, ...meta, attempt: wanted, outputUnavailable: attemptUnavailableReason(unit, rec, served) });
    }
    if (output !== null) {
      // A later attempt that left no transcript: the stored bytes are SUPERSEDED — say so, and why.
      if (served !== null && latest !== undefined && latest.attempt > served) {
        return reply.send({ output, ...meta, superseded: true, latestUnavailable: attemptUnavailableReason(unit, latest, served) });
      }
      return reply.send({ output, ...meta });
    }
    return reply.send({ output: null, ...meta, outputUnavailable: outputUnavailableReason(unit) });
  });

  // DC-S7 (§4.6): what the seats considered, set aside and cited for one chat turn or one unit
  // attempt. Operator+ (the rules are the project's doctrine). A cited rule is "unchecked", never
  // "followed" (B4). 404 when the transcript holds no such turn, or the run has no such unit.
  const operatorOnlyRead = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const actor = actorOf(req);
    if (trustAtLeast(actor, 'operator')) return true;
    void reply.code(403).send({ error: `Insufficient trust: considered needs 'operator' (you are '${actor.trust}')` });
    return false;
  };
  app.get(
    `${V}/chats/:id/turns/:turnId/considered`,
    { config: { manifest: { responseType: 'Consideration', statusCodes: [200, 403, 404] } } },
    async (req, reply) => {
      if (!operatorOnlyRead(req, reply)) return reply;
      const { id, turnId } = req.params as { id: string; turnId: string };
      const c = await considerations.forChatTurn(id, turnId);
      if (c === null) return reply.code(404).send({ error: `chat ${id} holds no turn ${turnId}` });
      return c;
    },
  );
  app.get(
    `${V}/runs/:id/units/:unitKey/considered`,
    { config: { manifest: { responseType: 'Consideration', statusCodes: [200, 400, 403, 404] } } },
    async (req, reply) => {
      if (!operatorOnlyRead(req, reply)) return reply;
      const { id, unitKey } = req.params as { id: string; unitKey: string };
      const raw = (req.query as { attempt?: string | string[] }).attempt;
      const attemptRaw = Array.isArray(raw) ? raw[0] : raw;
      const attempt = attemptRaw === undefined || attemptRaw === '' ? 0 : Number(attemptRaw);
      if (!Number.isInteger(attempt) || attempt < 0) {
        return reply.code(400).send({ error: '`attempt` must be a non-negative integer' });
      }
      const c = await considerations.forUnit(id, unitKey, attempt);
      if (c === null) return reply.code(404).send({ error: `run ${id} has no unit '${unitKey}'` });
      return c;
    },
  );

  // The whole run as one auditable JSON attachment: the run, its units (each with
  // the captured transcript), and the decision trail read back from core's durable
  // per-run event log — what actually happened, not a re-derivation of it.
  app.get(`${V}/runs/:id/evidence`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const bundle = await buildEvidenceBundle(
      run,
      (unitId) => adapter.workOutput(unitId),
      (runId) => adapter.runEvents(runId),
    );
    return reply
      .header('Content-Disposition', `attachment; filename="${evidenceFilename(id)}"`)
      .send(bundle);
  });

  // ── Acceptance gate read (Phase 6a) ─────────────────────────────────────────
  // The QE evidence ledger's verdict + manifest for THIS run's repo, plus the
  // gate's deny-dominates resolution of the workflow's acceptance requirement.
  // Sits beside `/runs/:id/evidence` deliberately: evidence is what the RUN
  // recorded about itself; acceptance is what the QE pipeline recorded about
  // the repo the run worked on — two different systems of record, two routes.
  //
  // Always a 200 for a known run: "no ledger", "no verdict" and "FAIL" are
  // real answers about the gate (each a deny with its own reason), not errors
  // in the request. Only an unknown run 404s. `?qeRun=<id>` pins the read to
  // one QE run's newest verdict instead of the repo's newest overall.
  app.get(`${V}/runs/:id/acceptance`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { qeRun?: string | string[] };
    const qeRunRaw = Array.isArray(q.qeRun) ? q.qeRun[0] : q.qeRun;
    const qeRunId = qeRunRaw?.trim();
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return acceptanceViewOf(run, { ...(qeRunId !== undefined && qeRunId !== '' ? { qeRunId } : {}) });
  });

  /**
   * One run's acceptance answer — the body `GET /runs/:id/acceptance` serves, and what a delivery
   * reads (wicked-core#850 EX-03). `forceDeclared`: the run's assurance CONTRACT requires QE
   * acceptance, so a verdict is owed even when no phase raises `verified_evidence` — missing denies.
   */
  async function acceptanceViewOf(run: SessionView, opts: { qeRunId?: string; forceDeclared?: boolean; treeScoped?: boolean }) {
    const id = run.session.id;
    // What the run must prove, from what it CONTAINS (seam X2): a plan or preset run's steps whose
    // catalog entry re-verifies evidence, a registered workflow's def, nothing for free text — and
    // an unknown run (or one the daemon cannot read) is declared and denied with the reason.
    const verifiedCatalog =
      typeof adapter.verifiedEvidenceCatalog === 'function' ? await adapter.verifiedEvidenceCatalog() : null;
    const knownCatalog = typeof adapter.catalogIds === 'function' ? await adapter.catalogIds() : null;
    // A def run is read against the defs actually registered (X-MIG M11): a run a retired built-in
    // def produced is no longer describable, so it fails closed rather than borrowing the preset's
    // shape; preset and plan runs are read from their own units.
    const read = acceptanceRequirementOf(
      run,
      typeof adapter.listRuntimeWorkflows === 'function' ? adapter.listRuntimeWorkflows() : adapter.listWorkflows(),
      verifiedCatalog,
      knownCatalog,
    );
    const requirement = opts.forceDeclared === true ? { ...read, declared: true } : read;
    // WT-W2: every walkthrough step the requirement names is resolved from its proof root and seal.
    const walkthroughs = await walkthroughAcceptance(adapter, run, requirement.phases);

    let repo = null;
    if (run.session.repo_ref !== null) {
      const repos = await adapter.listRepos();
      repo = repos.find((r) => r.id === run.session.repo_ref) ?? null;
    }

    const evidenceRoot = (run.session as { evidence_root?: unknown }).evidence_root;
    return buildAcceptanceView({
      runId: id,
      repo,
      // crew#951: a run with an evidence root keeps its QE ledger there (where its QE unit records).
      evidenceRoot: typeof evidenceRoot === 'string' ? evidenceRoot : null,
      // crew#971: QE verdicts count only for the tree they judged — this run's deliverable tree.
      // A post-hoc lift's checkout is not the engine-verified tree (codex r1 on #973): it is not
      // scoped, so every verdict of the run counts there, as before.
      deliverableTree: (() => {
        if (opts.treeScoped === false) return null;
        const t = (run.session as { verified_tree?: unknown }).verified_tree;
        return typeof t === 'string' && t !== '' ? t : null;
      })(),
      qeUnitOrds: (run.units ?? [])
        .filter((u) => (u as { qe_acceptance?: unknown }).qe_acceptance != null)
        .map((u) => u.ord),
      requirement,
      ...(opts.qeRunId !== undefined ? { qeRunId: opts.qeRunId } : {}),
      // AW-14 (arch-R13a + R16): the conformance section reads the same wires the standalone
      // `/governance/claims` and `/runs/:id/events` routes serve, but run-scoped and resolved
      // deny-dominates BESIDE the QE gate — so a wiki-rule violation and an unenforced governed
      // unit both appear on the page humans actually look at.
      claims: () => adapter.listConformanceClaims(),
      events: (rid) => adapter.runEvents(rid),
      ...(walkthroughs.gates.length > 0 || walkthroughs.ownedByYou ? { walkthroughs } : {}),
      // IG1-crew-2: what fenced each unit — the run's binding and the roster's seat records.
      enforcementContext: {
        bound: run.session.repo_ref !== null,
        worktree: run.session.workdir,
        extraWriteRoots: run.session.extra_write_roots ?? [],
        seatOf: (() => {
          let seats: GovernanceSeatInput[] | null = null;
          return (cli: string) => {
            if (seats === null) {
              try {
                seats = rosterWithStanding() as unknown as GovernanceSeatInput[];
              } catch {
                seats = [];
              }
            }
            return seats.find((seat) => seat.key === cli);
          };
        })(),
      },
    });
  }

  /** EX-03: the run's QE acceptance check when its contract requires `qe_acceptance`; `null` when it
   *  does not. A read that fails is a refusal naming why, never a pass. QE-IN-APP-WORKFLOWS: a
   *  decision the score WAIVED or the operator SKIPPED is satisfied without a ledger read and says
   *  which, in the decision's words; only `required` reads the ledger. */
  async function qeAcceptanceCheckFor(run: SessionView, where: 'gate' | 'post_hoc' = 'gate'): Promise<QeAcceptanceCheck | null> {
    const decision = qeDecisionOf(run);
    if (decision === null) return null;
    if (qeDecisionBypasses(decision)) return qeAcceptanceNotRequired(decision);
    let check: QeAcceptanceCheck;
    try {
      check = qeAcceptanceFromView(await acceptanceViewOf(run, { forceDeclared: true, treeScoped: where === 'gate' }));
    } catch (err) {
      return unreadableQeAcceptance(err);
    }
    // (wicked-core#1153, xreview) The ledger's PASS counts only beside the ENGINE's bound review: a
    // PASS some other writer put in the ledger (the QE executor's own, say) while the isolated
    // reviewer's verdict could not be bound is no acceptance. The latest QE unit's record speaks;
    // an engine that keeps none leaves the ledger's word.
    const review = engineQeReviewOf(run);
    if (check.satisfied && review !== null && review.outcome !== 'pass') {
      return {
        ...check,
        satisfied: false,
        reason: `the isolated QE review did not bind a PASS (${review.outcome}${review.reason ? `: ${review.reason}` : ''}); a PASS in the ledger without it does not count`,
      };
    }
    return check;
  }

  /** The engine's isolated QE review record on the run's latest QE unit (`units[].qe_review`, the
   *  unit's last attempt), or `null` when the engine kept none. */
  function engineQeReviewOf(run: SessionView): { outcome: string; reason: string } | null {
    let latest: { ord: number; review: { outcome: string; reason: string } } | null = null;
    for (const u of run.units ?? []) {
      const r = (u as { qe_review?: { outcome?: unknown; reason?: unknown } | null }).qe_review;
      if (r === undefined || r === null || typeof r.outcome !== 'string') continue;
      if (latest === null || u.ord > latest.ord) {
        latest = { ord: u.ord, review: { outcome: r.outcome, reason: typeof r.reason === 'string' ? r.reason : '' } };
      }
    }
    return latest?.review ?? null;
  }

  /**
   * The run's OPEN gate, resolved the way `GET /runs/:id/gate` serves it: the cache, else a read of
   * the record (`readOpenGate`) adopted into the cache only once it completes with no live gate
   * event of the run's having landed meanwhile — `GateCache.resolve` re-runs a read one did
   * overlap, because neither side of such an overlap is known to be the newer (crew#1083 review).
   * The caller has already checked `awaiting_human`. `null` = the record holds no open gate;
   * `'no-log'` = this build cannot read the log, so nothing can be said; `'unstable'` = live gate
   * events kept landing while the record was read, so nothing was verified (retry).
   */
  async function resolveOpenGate(id: string): Promise<GateResolution> {
    return gateCache.resolve(id, () => readOpenGate(id));
  }

  /**
   * One read of the run's open gate from the record: the engine's durable `interaction_requests`
   * row (DES-PROJECT-001 §5.3), enriched from the event log, else the event-log replay for engines
   * predating the table. Never consults the cache — `GateCache.resolve` owns that, and runs this
   * again when a live gate event overlaps it.
   */
  async function readOpenGate(id: string): Promise<GateRead> {
    const recorded = await recordedOpenGate(id);
    if (recorded?.state === 'ambiguous') return 'ambiguous';
    if (recorded?.state === 'open') {
      const durableGate = recorded.row;
      // This path builds the entry inline (not through `fold`), so it must run the SAME refusal
      // detection (issue #419) — otherwise a gate served from the durable row after a restart would
      // silently drop the warning that the live/replay paths carry.
      const refusal = detectRefusal(durableGate.prompt);
      const gateKind = typeof durableGate['gate_kind'] === 'string' && durableGate['gate_kind'] !== '' ? durableGate['gate_kind'] : undefined;
      const ord = recorded.ord;
      // Issue #969: the row has no `choices`/`recommended`, so they come from the newest
      // `awaitingHuman` for this ord in the event log. A log this build cannot read (null, or a read
      // that throws) leaves both out — the gate is still served, just without the offered answers.
      const events = await adapter.runEvents(id).catch(() => null);
      const frame = events?.filter((e) => e.type === 'awaitingHuman' && e.session === id && e.ord === ord).at(-1);
      return {
        ord,
        prompt: durableGate.prompt,
        lifecycle: 'open' as const,
        receivedAt: new Date(durableGate.created_at).toISOString(),
        ...(refusal !== undefined ? { refusal } : {}),
        ...(gateKind !== undefined ? { gateKind } : {}),
        ...(frame !== undefined ? offeredChoices(frame) : {}),
      };
    }
    const events = await adapter.runEvents(id);
    if (events === null) return 'no-log';
    return replayOpenGate(id, events) ?? null;
  }

  /**
   * The engine's durable record of the run's open gate: ONE reading of its open `interaction_requests`
   * gate rows, which `GET /runs/:id/gate` serves and every decision path is judged by (crew#1083
   * round 5 — GET once took the first row while POST took the newest). `null` = this engine keeps
   * no rows. Rows that disagree on the ord are `ambiguous`: the record cannot say which gate is
   * open, and says so. Agreeing rows — one, or several: the engine can hold a keyed plan_approval
   * gate whose publisher was lost plus the unkeyed team_transport row boot recovery writes for the
   * same ord (wicked-core team_gate.rs) — are `open` at that ord, and the row read is the newest
   * by `created_at`.
   */
  async function recordedOpenGate(id: string): Promise<RecordedOpenGate | null> {
    if (typeof adapter.interactionRequests !== 'function') return null;
    const rows = await adapter.interactionRequests(id, 'open');
    if (rows === null) return null;
    const gates = rows.filter((r) => r.kind === 'gate');
    if (gates.length === 0) return { state: 'none' };
    const ords = [...new Set(gates.map((r) => r.ord ?? 0))].sort((a, b) => a - b);
    if (ords.length > 1) return { state: 'ambiguous', ords };
    const at = (r: InteractionRequest): number => new Date(r.created_at as string | number).getTime() || 0;
    const row = gates.reduce((a, b) => (at(b) >= at(a) ? b : a));
    return { state: 'open', ord: ords[0]!, row };
  }

  /**
   * The gate a decision answers, judged by the record (crew#1083 rounds 3–5) — the one check every
   * gate-confirming path makes, inside {@link decideExclusively}, before its delivery checks and its
   * confirm: `POST /runs/:id/gate` and standing orders (through `decideGate`), a gated
   * `POST /runs/:id/resume`, a gated `POST /runs/:id/reassign`. The record's open gate, never the
   * cache's: after a confirm the cache can still hold the answered gate until its `resumed` frame is
   * pumped, and a decision judged by it would answer the next gate with the last one's checks.
   *
   * - The record is ambiguous (open rows disagree on the ord) → 409 `gate_unknown`.
   * - It shows a gate open: a decision naming another ord → 409 `gate_changed` with `openOrd`;
   *   otherwise the gated unit is that gate's, and the prompt and kind are its row's.
   * - It shows none (or the engine keeps no rows): a decision naming its ord → 409 `gate_unknown`.
   *   A decision without one keeps the pre-table resolution (the cache, then the log, then the
   *   cursor unit) — an engine, or a run, older than the table.
   */
  async function gateForDecision(
    run: SessionView,
    namedOrd: number | undefined,
    opts: { declining?: boolean } = {},
  ): Promise<{ refusal: { code: number; body: unknown } } | { gated: WorkUnit | undefined; prompt: string | undefined; gateKind: string | undefined }> {
    const decided = await gateOfRecord(run, namedOrd);
    // crew#1157: every APPROVING path (the gate route, standing orders, a gated resume or reassign, a
    // plan edit at the gate, the next message of a chat) is judged here, so no path approves a held
    // plan change on an analysis run. Declining stays open.
    if (!('refusal' in decided) && opts.declining !== true) {
      const analysis = analysisPlanRefusal(run.session.id, { gateKind: decided.gateKind });
      if (analysis !== null) return { refusal: analysis };
    }
    return decided;
  }

  async function gateOfRecord(
    run: SessionView,
    namedOrd: number | undefined,
  ): Promise<{ refusal: { code: number; body: unknown } } | { gated: WorkUnit | undefined; prompt: string | undefined; gateKind: string | undefined }> {
    const id = run.session.id;
    const unitAt = (ord: number): WorkUnit | undefined => (run.units ?? []).find((u) => u.ord === ord);
    const unknown = (why: string) => ({ refusal: { code: 409, body: { error: `Gate unknown: ${why} — refresh and decide again.`, code: 'gate_unknown' } } });
    const recorded = await recordedOpenGate(id);
    if (recorded?.state === 'ambiguous') {
      return unknown(`the engine's record shows gates open before units ${recorded.ords.join(' and ')} on this run, so the daemon cannot tell which one a decision answers`);
    }
    if (recorded?.state === 'open') {
      if (namedOrd !== undefined && namedOrd !== recorded.ord) {
        return { refusal: { code: 409, body: {
          error:
            `Gate changed: this decision was made on the gate before unit ${namedOrd}, but the open gate `
            + `is before unit ${recorded.ord} — it was answered or replaced. Read the open gate before deciding.`,
          code: 'gate_changed',
          openOrd: recorded.ord,
        } } };
      }
      const kind = recorded.row['gate_kind'];
      return { gated: unitAt(recorded.ord), prompt: recorded.row.prompt, gateKind: typeof kind === 'string' && kind !== '' ? kind : undefined };
    }
    if (namedOrd !== undefined) {
      return unknown(
        `this decision names the gate before unit ${namedOrd}, but the engine's record `
        + `${recorded === null ? 'keeps no durable gate row' : 'shows no open gate'} for this run, so the daemon cannot confirm the named one`,
      );
    }
    const open = await resolveOpenGate(id).catch(() => null);
    if (isOpenGate(open)) return { gated: unitAt(open.ord), prompt: open.prompt, gateKind: open.gateKind };
    return { gated: [...(run.units ?? [])].sort((a, b) => a.ord - b.ord)[run.session.unit_ix], prompt: undefined, gateKind: undefined };
  }

  /**
   * The checks an APPROVE that runs the deliver unit must pass — the ONE place for both gate paths
   * (`POST /runs/:id/gate`, standing orders, and a gated `POST /runs/:id/resume`): the delivery
   * freeze (idea 15), and wicked-core#850 EX-03 — a run whose contract requires QE acceptance
   * delivers only on an attributed PASS. A refusal leaves the gate open.
   */
  async function deliverApprovalRefusal(
    run: SessionView,
    deliverUnit: WorkUnit,
    /** (j4-gates) The operator's QE skip this approve carries (`action: 'skip_qe'`, its reason). */
    skipQeReason?: string,
  ): Promise<{ refusal: { code: number; body: unknown } } | { qeAcceptance: QeAcceptanceCheck | null }> {
    if (deliveryFreeze.state().frozen) return { refusal: { code: 409, body: frozenRefusal(deliveryFreeze.state()) } };
    // (j4-gates) An explicit operator skip at THIS gate, on a run whose QE acceptance is still
    // required: the delivery goes without a ledger PASS, and its check says so in the skip's own
    // words — the engine records the same decision with the confirm (or refuses it, 409, gate open).
    const decision = qeDecisionOf(run);
    if (skipQeReason !== undefined && decision !== null && !qeDecisionBypasses(decision)) {
      return { qeAcceptance: qeAcceptanceSkippedAtGate(skipQeReason) };
    }
    const qeAcceptance = await qeAcceptanceCheckFor(run);
    if (qeAcceptance !== null && !qeAcceptance.satisfied) {
      return { refusal: { code: 409, body: qeAcceptanceRefusal(run.session.id, qeAcceptance, receiptOf(deliverUnit), 'gate') } };
    }
    return { qeAcceptance };
  }

  /** Per run: the tail of the decisions queued by {@link decideExclusively}. Never rejects. */
  const gateDecisionTails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` alone for the run (crew#1083 round 4; the `McpPolicies.exclusive` pattern of #1082):
   * after every earlier decision for the same run has settled, and before any later one starts.
   * The row read and the confirm are separate engine commands and the confirm carries no ord, so
   * two concurrent decisions could both read the sole open ord-3 row, the first confirm advance
   * the run to its ord-4 (deliver) gate, and the second confirm answer THAT gate with the delivery
   * checks evaluated for ord 3 — a studio double-click on Approve is enough. Serialized, the second
   * re-reads inside the lock and meets ord 4: 409 `gate_changed`. Other runs are not blocked.
   *
   * Every crew API path that confirms a gate takes it and is judged by the record
   * ({@link gateForDecision}) under it: `decideGate` (`POST /runs/:id/gate`, standing orders),
   * `POST /runs/:id/resume`, `POST /runs/:id/reassign` (the re-seat included), `POST /runs/:id/plan`
   * (team routes) and the chat ask path's continuation (which re-reads its run inside the lock).
   * It serializes these paths; it does not bind a confirm to the gate the operator saw. A
   * decision without an `ord` (`/resume`, `/reassign`, `/plan`) queued behind one that advanced the
   * run answers the gate the record shows then, and the stall watchdog's `reassignUnit` runs
   * outside this lock. Both need every confirm bound to the gate it answers: an ord on the engine's
   * confirm (wicked-core#1038) and the skin sending it.
   */
  function decideExclusively<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const result = (gateDecisionTails.get(runId) ?? Promise.resolve()).then(fn);
    const tail = result.catch(() => undefined);
    gateDecisionTails.set(runId, tail);
    void tail.then(() => {
      if (gateDecisionTails.get(runId) === tail) gateDecisionTails.delete(runId);
    });
    return result;
  }

  /**
   * crew#1157 (xreview on #1160): an ANALYSIS chat's run never takes on work. Its seat is told not to
   * propose any, but a `PLAN+` line in an answer would still hold a creator addition at a
   * `plan_approval` gate; approving it (or approving with an edited plan) would let the run write.
   * Refused here, for every decision path, by the durable launch record: declining stays allowed.
   */
  function analysisPlanRefusal(
    runId: string,
    held: { gateKind?: string | undefined; plan?: { steps: ReadonlyArray<{ catalog: string; id?: string | undefined; [k: string]: unknown }> } | undefined },
  ): { code: number; body: unknown } | null {
    const workflow = runTimingIndex.chatWorkflowOf(runId);
    if (workflow === undefined) return null;
    // A held plan change (the gate the engine opens on a `PLAN+` line), or a plan edit with any step
    // that could write (the same read-only predicate the chat open applies to the workflow).
    const writes = held.plan?.steps.some((s) => writeCapableStep(s) !== null) === true;
    if (held.gateKind !== 'plan_approval' && !writes) return null;
    return {
      code: 409,
      body: {
        code: 'analysis_read_only',
        error:
          `run ${runId} is an analysis (${workflow}): it answers questions and changes nothing, so it cannot take on ` +
          'the work its answer proposed. Decline it here, and start a job for the change.',
      },
    };
  }

  /**
   * THE gate decision path. `POST /runs/:id/gate` answers with it, and so does a standing order
   * (behaviour 10) — the same awaiting check, the same ord check and 409 `gate_changed` /
   * `gate_unknown`, the same `confirmGate`, the same `gate.decided` audit. There is no side path:
   * an order is just another actor, named on the audit line (`extraDetail.standingOrder`). One
   * decision at a time per run ({@link decideExclusively}).
   */
  async function decideGate(
    id: string,
    decision: unknown,
    actor: import('../core/types.js').Actor,
    extraDetail: Record<string, unknown> = {},
  ): Promise<{ code: number; body: unknown }> {
    const parsed = GateSchema.safeParse(decision);
    if (!parsed.success) {
      return { code: 400, body: invalidBody(parsed.error, 'Invalid request body') };
    }
    // (studio#923) Skipping QE acceptance is the human operator's call alone: a seat's token, a
    // standing order or any other non-human actor is refused before anything is read, and the
    // attempt is audited. The engine records WHO skipped it from the same actor (recordGateActor).
    if (parsed.data.action === SKIP_QE_ACTION && !isHumanOperator(actor)) {
      audit.record('gate.skip_qe_refused', actor, {
        runId: id,
        detail: { reason: 'human_operator_only', ...(parsed.data.ord !== undefined ? { ord: parsed.data.ord } : {}) },
      });
      return {
        code: 403,
        body: {
          error: `only a human operator can skip QE acceptance (you are ${actor.kind}/${actor.trust})`,
          code: 'human_operator_only',
        },
      };
    }
    return decideExclusively(id, async () => {
      const views = await adapter.sessionsDetail();
      const run = views.find((v) => v.session.id === id);
      if (!run) return { code: 404, body: { error: 'Run not found' } };
      if (run.session.status !== 'awaiting_human') {
        return { code: 409, body: { error: `Run is not awaiting a human gate (status: ${run.session.status})` } };
      }
      // Decision integrity (api-types 0.44.0; crew#1083 rounds 3–5): the gate this decision answers
      // is the RECORD's — read first thing inside the lock, so the gated unit and its delivery
      // checks below are the ones the record confirms ({@link gateForDecision}).
      const decided = await gateForDecision(run, parsed.data.ord, { declining: !parsed.data.approve });
      if ('refusal' in decided) return decided.refusal;
      const analysis = parsed.data.approve ? analysisPlanRefusal(id, { plan: parsed.data.plan }) : null;
      if (analysis !== null) return analysis;
      // The gated unit and its receipt as it stands when the person decides (wicked-core#850: every
      // gate answer carries it). An APPROVE that would run the deliver unit passes the delivery
      // checks first.
      const gated = decided.gated;
      const assurance = receiptOf(gated);
      let deliveryCheck: { qeAcceptance: QeAcceptanceCheck | null } | undefined;
      if (parsed.data.approve && gated !== undefined && isDeliverUnit(gated)) {
        const refused = await deliverApprovalRefusal(
          run,
          gated,
          parsed.data.action === SKIP_QE_ACTION ? parsed.data.amend : undefined,
        );
        if ('refusal' in refused) return refused.refusal;
        deliveryCheck = { qeAcceptance: refused.qeAcceptance };
      }
      // The steering-author landing (crew#388): decided — and the gate prompt captured — BEFORE
      // the confirm, because a terminal-phase approve prunes the gate cache and moves the run out
      // of `awaiting_human`. The landing itself runs AFTER a successful approve only. The run is
      // classified by its recorded name (seam X2), so a partial-stub adapter with no registry cannot
      // 500 the legacy gate path here. The prompt is the record's row (agy, round 4): the cache
      // holds nothing after a restart and another gate's words after a late frame.
      const steeringPropose =
        parsed.data.approve && isSteeringAuthorRun(run);
      const gatePrompt = steeringPropose ? decided.prompt : undefined;
    try {
        // All five positionals, explicit `undefined` for the absent ones (DES-L1 PR-2; the
        // gate-arms tripwire pins the arity). An engine refusal (no creator to send back to,
        // an engine older than the arm) surfaces as the existing 409 below.
        // (operator ruling 2026-10-11) WHO answered: the adapter hands it to the engine with this
        // confirm, which records it as the judge when this approve answers a `judge_unavailable`
        // gate ("judged by operator").
        adapter.recordGateActor?.(id, `${actor.id} (${actor.kind})`);
        const status = await adapter.confirmGate(
          id,
          parsed.data.approve,
          parsed.data.amend,
          parsed.data.action,
          parsed.data.amendScope,
          parsed.data.plan !== undefined ? toLaunchPlan(parsed.data.plan) : undefined,
        );
        // WHO approved/rejected — the gate-decision audit (task #88). The engine
        // records THAT the gate resolved (interaction_requests / gateDecided);
        // only this HTTP layer knows the authenticated principal behind it.
        // (studio#923) The QE skip's own audit line, beside `gate.decided`: who skipped QE on which
        // run and gate, and why.
        if (parsed.data.action === SKIP_QE_ACTION) {
          audit.record('gate.qe_skipped', actor, {
            runId: id,
            detail: { reason: parsed.data.amend ?? '', ...(gated !== undefined ? { ord: gated.ord } : {}), status },
          });
        }
        audit.record('gate.decided', actor, {
          runId: id,
          detail: {
            approve: parsed.data.approve,
            ...(parsed.data.amend !== undefined ? { amend: parsed.data.amend } : {}),
            ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
            ...(parsed.data.amendScope !== undefined ? { amendScope: parsed.data.amendScope } : {}),
            ...(parsed.data.plan !== undefined ? { planSteps: parsed.data.plan.steps.length } : {}),
            ...(parsed.data.ord !== undefined ? { ord: parsed.data.ord } : {}),
            ...extraDetail,
            status,
          },
        });
        // DC-S4a host: the gate note (amend / request_changes text) — a bare approve or reject is a
        // `choice`. Post-commit, off the request path; a non-human actor (a standing order) records nothing.
        if (decisions !== null) {
          decisions.track(ingestDecision(decisions, {
            host: 'gate',
            actor,
            words: parsed.data.amend ?? '',
            choice: parsed.data.action ?? (parsed.data.approve ? 'approve' : 'reject'),
            projectId: projects.index.projectOf(id) ?? null,
            runId: id,
            ...(parsed.data.ord !== undefined ? { ord: parsed.data.ord } : {}),
          }));
        }
        // APPROVE of the steering-author propose gate = the doctrine's landing moment: the
        // approved proposal is written to the governance store with `provenance.source: "chat"`,
        // audited per rule, idempotent on replay, and LOUD on failure — the response carries the
        // outcome either way, so the studio can show "landed PAT-101" or the explicit error
        // instead of the silent no-op crew#388 recorded. An approve WITH an amend note still
        // lands the proposal UNCHANGED: the amend steers the RUN's continuation, not the rule
        // text (an operator who wants different rules rejects and re-authors). A reject lands
        // nothing — the run cancels and the proposal stays an artifact.
        const landing = steeringPropose
          ? await landSteeringProposal({ adapter, audit, actor }, run, gatePrompt)
          : undefined;
        return {
          code: 200,
          body: {
            status,
            ...(landing !== undefined ? { landing } : {}),
            assurance,
            ...(deliveryCheck !== undefined ? { delivery: deliveryCheck } : {}),
          },
        };
      } catch (err) {
        if (err instanceof PlanLaunchUnsupportedError) {
          return { code: 501, body: { error: message(err) } };
        }
        return { code: 409, body: { error: message(err) } };
      }
    });
  }

  // The steering gate (§11.1). approve+amend = approve-with-steer; approve:false = reject (cancels).
  app.post(
    `${V}/runs/:id/gate`,
    {
      config: {
        manifest: {
          requestType: 'GateDecision',
          responseType: 'GateDecisionResult',
          // 409 twice over: a run not awaiting a human gate, and an engine refusal at confirm.
          // 501: an edited plan on an addon without the plan approval gate (DES-TEAMING-002 T3).
          statusCodes: [200, 400, 404, 409, 501],
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await decideGate(id, req.body, actorOf(req));
      return reply.code(out.code).send(out.body);
    },
  );

  // Cancel a running or paused run (distinct third action, §11.1).
  app.post(`${V}/runs/:id/cancel`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    try {
      const status = await adapter.cancelRun(id);
      audit.record('run.cancelled', actorOf(req), { runId: id, detail: { status } });
      return reply.send({ status });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  // Advance semantics (§11.8): a gated run advances via confirmGate; otherwise
  // resumeRun re-enters the cursor. Never resumeRun a gated run (it would re-pause).
  app.post(`${V}/runs/:id/resume`, async (req, reply) => {
    const { id } = req.params as { id: string };
    // A gated resume confirms the gate: one decision at a time per run (crew#1083 round 5).
    return decideExclusively(id, async () => {
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    // crew#418 A: a run stranded by a deliver-phase lift collision reads `failed` from the engine
    // but its work is complete and liftable — normalize to `completed` so the terminal branch
    // below refuses resume with the DELIVER recovery (POST /runs/:id/deliver), not a re-entry.
    const conflictStrand = normalizeStranded(run);
    // A TERMINAL run is refused LOUDLY, with the actual recovery named (crew#311 defect 2).
    // The engine's `resume_run` no-ops on completed/cancelled and answers the status token, so
    // this route used to reply 200 {"status":"cancelled"} — on the exact runs an operator was
    // trying to rescue, the recovery affordance read as "resume destroyed my run". A cancelled
    // run has NO in-run recovery (the path is a retry launch, `POST /runs {retryOf}`); a
    // completed run has nothing to resume — but a stranded one's work IS liftable post-hoc.
    // The 409 body carries the machine-readable pointer (`ResumeRefusal` in api-types).
    const terminal = run.session.status;
    if (terminal === 'completed' || terminal === 'cancelled') {
      const state = resolveDelivery(run, conflictStrand);
      const recovery = terminal === 'completed' && state.delivery === 'stranded'
        ? ('deliver' as const)
        : ('retry' as const);
      const why =
        terminal === 'cancelled'
          ? `run ${id} is cancelled — a terminal run cannot be resumed; relaunch the work as a new run with POST /runs {"retryOf":"${id}"}`
          : state.delivery === 'stranded'
            ? `run ${id} is already completed — nothing to resume; its unlifted work is on the wicked/${id} branch: deliver it with POST /runs/${id}/deliver`
            : state.delivery === 'pushed'
              ? `run ${id} is already completed and delivered — its branch ${state.deliverBranch ?? `wicked/${id}`} is on ${state.deliverRemote ?? 'origin'} (no pull request: that origin is not a GitHub host gh can resolve); nothing to resume`
            : state.delivery === 'vacuous'
              ? `run ${id} is already completed, but VACUOUSLY — its units produced no work to resume or deliver; relaunch with POST /runs {"retryOf":"${id}"}`
              : `run ${id} is already completed — nothing to resume; relaunch the work as a new run with POST /runs {"retryOf":"${id}"}`;
      return reply.code(409).send({ error: why, recovery });
    }
    try {
      const gated = run.session.status === 'awaiting_human';
      // A gated resume IS a gate approval, so it lands a steering-author proposal exactly like
      // POST /runs/:id/gate would — the "no side door" rule (task #88) holds for the landing
      // write too (crew#388). Prompt captured pre-confirm; see the gate route.
      // A gated resume IS an approve, so it is judged by the record like every decision, passes the
      // same delivery checks (freeze, EX-03) — no side door around the deliver gate — and answers
      // with the gated unit's receipt.
      const decided = gated ? await gateForDecision(run, undefined) : undefined;
      if (decided !== undefined && 'refusal' in decided) return reply.code(decided.refusal.code).send(decided.refusal.body);
      const steeringPropose =
        gated && isSteeringAuthorRun(run);
      const gatePrompt = steeringPropose ? decided?.prompt : undefined;
      const gatedUnit = decided?.gated;
      let deliveryCheck: { qeAcceptance: QeAcceptanceCheck | null } | undefined;
      if (gatedUnit !== undefined && isDeliverUnit(gatedUnit)) {
        const refused = await deliverApprovalRefusal(run, gatedUnit);
        if ('refusal' in refused) return reply.code(refused.refusal.code).send(refused.refusal.body);
        deliveryCheck = { qeAcceptance: refused.qeAcceptance };
      }
      if (gated) {
        const who = actorOf(req);
        adapter.recordGateActor?.(id, `${who.id} (${who.kind})`);
      }
      const status = gated ? await adapter.confirmGate(id, true) : await adapter.resumeRun(id);
      // A resume of a gated run IS a gate approval — audit it as one, so the
      // "who approved" trail has no side door (task #88).
      audit.record(gated ? 'gate.decided' : 'run.resumed', actorOf(req), {
        runId: id,
        detail: gated ? { approve: true, via: 'resume', status } : { status },
      });
      const landing = steeringPropose
        ? await landSteeringProposal({ adapter, audit, actor: actorOf(req) }, run, gatePrompt)
        : undefined;
      return reply.send({
        status,
        ...(landing !== undefined ? { landing } : {}),
        ...(gated ? { assurance: receiptOf(gatedUnit) } : {}),
        ...(deliveryCheck !== undefined ? { delivery: deliveryCheck } : {}),
      });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
    });
  });

  // Inject an operator message into a run's active worker(s) (§11.7).
  // target="all" broadcasts; any other value targets a specific CLI key.
  // Use sessions() (IDs only) for existence check — cheaper than sessionsDetail() on a hot path.
  app.post(`${V}/runs/:id/inject`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = InjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    try {
      await adapter.injectWorkerMessage(id, parsed.data.message, parsed.data.target);
      audit.record('run.injected', actorOf(req), { runId: id, detail: { target: parsed.data.target } });
      // DC-S4a host: the operator's mid-run steering text (review S9).
      if (decisions !== null) {
        decisions.track(ingestDecision(decisions, {
          host: 'inject',
          actor: actorOf(req),
          words: parsed.data.message,
          projectId: projects.index.projectOf(id) ?? null,
          runId: id,
        }));
      }
      return reply.send({ status: 'ok' });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
  });

  /**
   * crew#1058 / #1083 round 7: the runs with a reassign in flight. A second reassign of the same run
   * is refused before it queues on the decision lock — queued, it would act on the state the first
   * left (re-seat a worker the first just started, or approve twice).
   */
  const reassignsInFlight = new Set<string>();
  /**
   * codex r1 on #1060: whether approving the run's open gate ACCEPTS the parked unit's work rather
   * than re-running it (wicked-core `confirm_gate`: a `judge_unavailable` / `qe_reviewer_unavailable`
   * denial on the cursor unit is judged by the operator; an open `review_adjudication` gate lands
   * with carried items). Says what the approve does, or `null` when it re-runs the unit.
   */
  async function approveAcceptsWork(run: SessionView, ord: number, gateKind: string | undefined): Promise<string | null> {
    const unit = run.units.find((u) => u.ord === ord);
    const denial = (unit as { denial?: { source?: unknown } | null } | undefined)?.denial;
    if (unit?.status === 'rejected' && (denial?.source === 'judge_unavailable' || denial?.source === 'qe_reviewer_unavailable' || denial?.source === 'qe_inconclusive')) {
      return 'is the operator\'s judgment of the work as it stands (no judge could rule)';
    }
    if (gateKind === 'review_adjudication') {
      return 'lands the reviewed work with its carried items';
    }
    return null;
  }

  // The manual operator lever (crew#442): recycles a run's CURSOR unit via the same
  // `adapter.reassignUnit` path the stall-watchdog's automatic escalation uses, for when a
  // wedged unit needs recovering and auto-escalation is off, exhausted, or itself failed. Scoped
  // to `executing` runs only — the same scope the automatic ladder acts within, since only an
  // executing run has a cursor unit to reassign.
  app.post(
    `${V}/runs/:id/reassign`,
    { config: { manifest: { requestType: 'ReassignRequest', statusCodes: [200, 400, 404, 409] } } },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ReassignSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    // One reassign per run at a time, refused rather than queued (crew#1083 round 7), then the gate
    // decision lock every confirming path shares, held from this read of the run through the re-seat
    // and the confirm (crew#1083 round 5).
    if (reassignsInFlight.has(id)) {
      return reply.code(409).send({ error: `a reassign of run ${id} is already in flight. Nothing was changed.` });
    }
    reassignsInFlight.add(id);
    try {
    return await decideExclusively(id, async () => {
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    // Wave 6 (F-7R2-007 root fix): a run PARKED at a gate on a dead seat — the stall watchdog's
    // escalation gate, or a verdict escalation — is reassigned and approved in ONE call. crew#1058:
    // with a named seat it is REASSIGN-THEN-APPROVE. The engine re-seats a parked run's cursor unit
    // without dispatching it (wicked-core#773, `reseat_parked_unit`, core-ts >= 0.13.0) and refuses
    // a seat it cannot honour (an author's seat for a review under a distinct-evaluator contract,
    // a ballot-only seat, a held plan) with the run untouched, so a refusal is a 409 with the gate
    // still open; the approve then dispatches the unit once, on the new seat. The old order
    // (approve, then reassign) approved first, so a refused reassign left the failed seat running
    // again. Without a named seat (the council's pick) the engine needs a running unit to re-route,
    // so that path stays approve-then-reassign. Audited as BOTH a gate decision
    // (`via: 'reassign'`) and a reassign, so the "who approved" trail has no side door.
    // A steering-author propose gate is NOT approvable this way: its approve LANDS the proposal
    // through `POST /runs/:id/gate` (crew#388), and a reassign is not a review of the rules.
    const gated = run.session.status === 'awaiting_human';
    if (run.session.status !== 'executing' && !gated) {
      return reply.code(409).send({
        error: `run ${id} is ${run.session.status}, not executing — only an executing run has a cursor unit to reassign`,
      });
    }
    if (gated && typeof adapter.confirmGate !== 'function') {
      // A partial adapter (a directly-driven route set) cannot approve the gate on the caller's
      // behalf — say so by name, never a TypeError dressed as a refusal.
      return reply.code(409).send({
        error:
          `run ${id} is awaiting_human, not executing — the engine reassigns only an executing run, and ` +
          `this build cannot approve the gate on your behalf (no confirmGate); approve via POST /runs/${id}/gate, then reassign`,
      });
    }
    if (gated && isSteeringAuthorRun(run)) {
      return reply.code(409).send({
        error: `run ${id} is awaiting a steering-author propose gate — approve or reject it via POST /runs/${id}/gate (the approve lands the proposal); reassign is not a review of the rules`,
      });
    }
    const requestedCli = parsed.data.cli;
    if (requestedCli !== undefined) {
      const pool = Array.isArray(run.session.clis) ? run.session.clis : [];
      if (!pool.includes(requestedCli)) {
        return reply.code(400).send({
          error: `cli "${requestedCli}" is not in this run's seat pool (${pool.join(', ') || 'none known'})`,
        });
      }
    }
    // A gated reassign APPROVES the gate, so it is judged by the record like every decision and passes
    // the same delivery checks (freeze, wicked-core#850 EX-03) when the gate holds the deliver unit
    // (codex r1 on the EX-03 PR).
    const decided = gated ? await gateForDecision(run, undefined) : undefined;
    if (decided !== undefined && 'refusal' in decided) return reply.code(decided.refusal.code).send(decided.refusal.body);
    if (decided !== undefined) {
      const gatedUnit = decided.gated;
      if (gatedUnit !== undefined && isDeliverUnit(gatedUnit)) {
        const refused = await deliverApprovalRefusal(run, gatedUnit);
        if ('refusal' in refused) return reply.code(refused.refusal.code).send(refused.refusal.body);
      }
    }
    const cursor = resolveCursorUnit(run);
    const ord = cursor?.ord ?? run.session.unit_ix;
    const approve = async (): Promise<void> => {
      if (typeof adapter.confirmGate !== 'function') return; // refused above for a gated run
      const who = actorOf(req);
      adapter.recordGateActor?.(id, `${who.id} (${who.kind})`);
      const status = await adapter.confirmGate(id, true);
      audit.record('gate.decided', actorOf(req), {
        runId: id,
        detail: { approve: true, via: 'reassign', status },
      });
    };
    const reassigned = (approved: boolean): void => {
      audit.record('run.reassigned', actorOf(req), {
        runId: id,
        detail: { ord, ...(requestedCli !== undefined ? { cli: requestedCli } : {}), ...(gated ? { approved } : {}) },
      });
    };
    if (gated && requestedCli !== undefined) {
      // codex r1 on #1060: an approve that ACCEPTS the parked work instead of re-running the unit —
      // a `judge_unavailable` / `qe_reviewer_unavailable` denial (the operator judges, the unit
      // counts) or a `review_adjudication` gate (lands with carried items) — must not follow a
      // re-seat: the new seat would be recorded on work it never did, and never run.
      const accepts = await approveAcceptsWork(run, ord, decided?.gateKind);
      if (accepts !== null) {
        return reply.code(409).send({
          error: `run ${id} is parked at a gate whose approve ${accepts}, so a reassign would not run unit ${ord} on '${requestedCli}' — approve, send back or stop it via POST /runs/${id}/gate. Nothing was changed.`,
        });
      }
      // The re-seat and the approve are two engine commands; the in-flight refusal and the lock this
      // runs under keep a second reassign (or any decision) of the run from landing between them.
      try {
        await adapter.reassignUnit(id, ord, requestedCli);
      } catch (err) {
        // The engine refused the seat with the run untouched: nothing was approved.
        return reply.code(409).send({ error: `${message(err)}. Nothing was approved; the gate is still open.` });
      }
      try {
        await approve();
      } catch (err) {
        reassigned(false);
        return reply.code(409).send({
          error: `unit ${ord} was re-seated on ${requestedCli}, but approving the gate failed: ${message(err)} — read the run's gate before answering again`,
        });
      }
      reassigned(true);
      return reply.send({ status: 'ok', ord, cli: requestedCli, approved: true });
    }
    try {
      if (gated) await approve();
      await adapter.reassignUnit(id, ord, requestedCli ?? null);
      reassigned(true);
      return reply.send({
        status: 'ok',
        ord,
        ...(requestedCli !== undefined ? { cli: requestedCli } : {}),
        ...(gated ? { approved: true } : {}),
      });
    } catch (err) {
      return reply.code(409).send({ error: message(err) });
    }
    });
    } finally {
      reassignsInFlight.delete(id);
    }
  });

  // The gate prompt for a paused run, so a fresh browser can render the gate after a late join.
  //
  // Cache first, durable event log second (FINDING-051). The cache is process-lifetime, so before
  // the fallback existed a daemon restart left every parked run unable to say what it was asking —
  // not because the prompt was gone (core records `awaitingHuman` to the log) but because nothing
  // read it. A restart is routine: deploy, crash, laptop sleep.
  app.get(`${V}/runs/:id/gate`, async (req, reply) => {
    const { id } = req.params as { id: string };
    // wicked-core#850: the gate answer carries the gated unit's receipt — what assured the work it asks about.
    const unitAt = async (ord: number): Promise<WorkUnit | undefined> =>
      (await adapter.sessionsDetail()).find((v) => v.session.id === id)?.units?.find((u) => u.ord === ord);
    // (rejudge, api-types 0.134.0) A gate whose unit no judge could rule on says whether its judge
    // can be re-run now, and from which seats — the engine's own selection, read each time (a seat
    // signed in since the pause counts). Absent on every other gate and on an addon without the read.
    const rejudgeAt = async (ord: number, gated: WorkUnit | undefined): Promise<{ rejudge?: RejudgeOffer }> => {
      const denial = (gated as { denial?: { source?: unknown } | null } | undefined)?.denial;
      if (gated?.status !== 'rejected' || denial?.source !== 'judge_unavailable') return {};
      if (typeof adapter.rejudgeReadiness !== 'function') return {};
      try {
        const r = await adapter.rejudgeReadiness(id);
        if (r === null || !r.applies || r.ord !== ord) return {};
        return { rejudge: { available: r.available, eligible: r.eligible, missing: r.missing } };
      } catch {
        // A failed read offers nothing; the engine still judges a `rejudge` sent anyway.
        return {};
      }
    };
    // (studio#923) A deliver gate whose delivery QE acceptance refuses offers the operator's skip IN
    // PLACE: `{approve: true, action: 'skip_qe', amend: <reason>, ord}` on this gate, labelled on
    // the run, every later gate and the delivery — never a relaunch. Read each time (a PASS
    // recorded since the pause withdraws it). Absent on every other gate.
    const skipQeAt = async (gated: WorkUnit | undefined): Promise<{ skipQe?: SkipQeOffer }> => {
      if (gated === undefined || !isDeliverUnit(gated)) return {};
      const run = (await adapter.sessionsDetail()).find((v) => v.session.id === id);
      if (run === undefined) return {};
      const decision = qeDecisionOf(run);
      if (decision === null || qeDecisionBypasses(decision)) return {};
      const check = await qeAcceptanceCheckFor(run);
      if (check === null || check.satisfied) return {};
      return {
        skipQe: {
          action: SKIP_QE_ACTION,
          reasonRequired: true,
          actor: 'human_operator',
          label: QE_SKIPPED_BY_OPERATOR_LABEL,
          qeAcceptance: check,
        },
      };
    };
    // The record judges the cache (crew#1083 round 7): rows that disagree on the ord are 409
    // `gate_unknown` whether or not something is cached, and a cached entry is served — for its
    // presentation fields (prompt, choices, recommended) — only when its ord is the record's open
    // row's. With no open row the gate predates the engine's table and its record is the log
    // (FINDING-051): the entry is served while the run is still parked, so a restarted daemon does
    // not replay the log on every poll, and dropped once it is not (a late frame for an answered
    // gate). Any entry not served is dropped and the gate read from the record. Only an engine that
    // keeps no rows serves the cache unjudged.
    const recorded = await recordedOpenGate(id);
    if (recorded?.state === 'ambiguous') {
      return reply.code(409).send({
        error: `Gate unknown: the engine's record shows gates open before units ${recorded.ords.join(' and ')} on this run, so the daemon cannot tell which one is open.`,
        code: 'gate_unknown',
      });
    }
    const cached = gateCache.get(id);
    if (cached) {
      const servable =
        recorded === null
        || (recorded.state === 'open' && cached.ord === recorded.ord)
        || (recorded.state === 'none'
          && (await adapter.sessionsDetail()).find((v) => v.session.id === id)?.session.status === 'awaiting_human');
      if (servable) {
        // One read of the gated unit serves both its receipt and its re-judge offer.
        const gated = await unitAt(cached.ord);
        return { runId: id, ...cached, assurance: receiptOf(gated), ...(await rejudgeAt(cached.ord, gated)), ...(await skipQeAt(gated)) };
      }
      gateCache.forget(id);
    }

    // A miss is not evidence of anything on its own, so ask the run what it is doing before paying
    // to replay it. Only `awaiting_human` can have an open gate, and that answer is definitive:
    // every other status is a 404 that needs no log at all — which is also the overwhelmingly
    // common case here, since studio polls this route for runs that are merely finished.
    //
    // Reading status first is therefore CHEAPER than not reading it, the opposite of what the first
    // cut of this assumed: it trades one `sessionsDetail()` for replaying an entire event history,
    // and it was that skipped check which made a completed run answer 503 on any build without the
    // binding (CI caught it) — an error where the honest, knowable answer was "no gate".
    const views = await adapter.sessionsDetail();
    const run = views.find((v) => v.session.id === id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (run.session.status !== 'awaiting_human') {
      return reply.code(404).send({ error: 'No open gate for this run' });
    }

    // DURABLE TRUTH FIRST (DES-PROJECT-001 §5.3): the engine persists the open prompt in
    // `interaction_requests`, written in the same transaction as the `awaiting_human` pause — so a
    // daemon restart reads it back instead of replaying the log; the replay stays the FALLBACK for
    // runs parked before the engine grew the table. `resolveOpenGate` is that one resolution, shared
    // with the POST route's `ord` check.
    let open = await resolveOpenGate(id);
    // The record judges what the resolver returns too (crew#1083 final review): a stale frame folded
    // into the cache after GET's record read — during the status read, before any hydration began,
    // so no revision guard ran — is a cache hit for the resolver. When the answer disagrees with
    // that read, the record is read once more (it may have moved on, legitimately, meanwhile): an
    // answer that matches it is served; otherwise the entry is dropped and the gate resolved once
    // more from the record, and if that still disagrees nothing verified is served.
    if (recorded?.state === 'open' && isOpenGate(open) && open.ord !== recorded.ord) {
      const now = await recordedOpenGate(id);
      const matchesNow = (o: GateResolution): boolean => isOpenGate(o) && now?.state === 'open' && o.ord === now.ord;
      if (!matchesNow(open)) {
        gateCache.forget(id);
        open = await resolveOpenGate(id);
        if (isOpenGate(open) && !matchesNow(open)) open = 'unstable';
      }
    }
    if (open === 'ambiguous') {
      // The engine's open gate rows disagree on the ord (crew#1083 round 5): say so, as a decision
      // naming either gate is told — never pick one.
      return reply.code(409).send({
        error: 'Gate unknown: the engine\'s record shows gates open before more than one unit on this run, so the daemon cannot tell which one is open.',
        code: 'gate_unknown',
      });
    }
    if (open === 'unstable') {
      // Live gate events kept landing while the record was read, so nothing was verified
      // (crew#1083 round 3). Retryable: the next read sees a quieter run.
      return reply.code(503).send({
        error: 'Gate unstable: live gate events kept landing while the daemon read this run\'s open gate — retry.',
        code: 'gate_unstable',
      });
    }
    if (open === 'no-log') {
      // Now — and only now — 503 is the honest answer: this run really is holding for a human, and
      // this build cannot say what it is asking. Distinct cause, distinct message; answering "no
      // gate" here would report a capability gap as a fact about the run (the FINDING-050 shape).
      return reply.code(503).send({
        error: 'Gate history is unavailable: this wicked-core build has no event-log read binding',
      });
    }
    if (open === null) {
      // Parked, with a history that records no open gate. Pre-log runs land here (their prompt is
      // genuinely lost), as does a gate whose `awaitingHuman` predates the log's retention.
      return reply.code(404).send({ error: 'No open gate for this run' });
    }
    const gatedUnit = run.units?.find((u) => u.ord === open.ord);
    return { runId: id, ...open, assurance: receiptOf(gatedUnit), ...(await rejudgeAt(open.ord, gatedUnit)), ...(await skipQeAt(gatedUnit)) };
  });

  // ── Elicitation (DES-002) ────────────────────────────────────────────────────
  //
  // GET returns the current pending elicitation prompt for a run (display-store read).
  // POST resolves it: the body carries the elicitationId to guard against stale tabs,
  // the action (accept|decline|cancel), and — for accept — the operator's response.

  app.get(`${V}/runs/:id/elicitation`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = elicitationCache.get(id);
    // `entry` already carries `runId`; return it directly to avoid TS2783
    // ("runId is specified more than once") from a redundant spread.
    if (entry) return entry;
    // Cache miss: check existence before returning 404.
    // Use sessions() (IDs only) — cheaper than sessionsDetail() on this read path.
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });
    // Durable probe (DES-PROJECT-001 §5.3): `interaction_requests` reserves kind `elicitation`.
    // The engine writes no elicitation rows yet — the LIVE elicitation wire is complete
    // (create → cache → resolve, crew#357/#358), but the durable half of the PROMPT is still
    // engine-side future work (wicked-core interaction.rs: "gate today; elicitation reserved") —
    // so this read is empty today; it exists so the cache is STRUCTURALLY a latency layer, and
    // the day the engine writes the rows, restart survival holds here exactly as it does for
    // gates, with no route change. Guarded like `runEvents`: a partial-stub adapter (tests) or
    // a pre-0.6.0 addon simply has no durable half.
    const durable =
      typeof adapter.interactionRequests === 'function'
        ? await adapter.interactionRequests(id, 'open')
        : null;
    const pending = durable?.find((r) => r.kind === 'elicitation');
    if (pending !== undefined) {
      return {
        runId: id,
        elicitationId: pending.id,
        message: pending.prompt,
        options: null,
        receivedAt: new Date(pending.created_at).toISOString(),
      };
    }
    return reply.code(404).send({ error: 'No pending elicitation for this run' });
  });

  const ElicitationRespondSchema = z
    .object({
      /** Guards against stale-tab submissions: must match the current elicitation's id. */
      elicitationId: z.string().min(1),
      action: z.enum(['accept', 'decline', 'cancel']),
      /** Required when action is "accept" (response must be non-empty); must be absent for decline/cancel. */
      content: z.object({ response: z.string().min(1) }).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      if (val.action !== 'accept' && val.content !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['content'],
          message: 'content must only be provided when action is "accept"',
        });
      }
    });

  app.post(`${V}/runs/:id/elicitation`, async (req, reply) => {
    const { id } = req.params as { id: string };

    // 1. Validate body.
    const parsed = ElicitationRespondSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const body = parsed.data;

    // 1b. Accept requires content.response — validated here, before any state query, so
    //     the 400 is deterministic regardless of run-existence / cache state (P2).
    if (body.action === 'accept' && !body.content?.response) {
      return reply.code(400).send({ error: 'action:accept requires content.response' });
    }

    // 2. Existence check (IDs only — cheaper than sessionsDetail).
    const ids = await adapter.sessions();
    if (!ids.includes(id)) return reply.code(404).send({ error: 'Run not found' });

    // 3. Atomically take the pending elicitation.
    const taken = elicitationCache.take(id);
    if (!taken) return reply.code(409).send({ error: 'No pending elicitation for this run' });

    // 4. Stale-tab check: submitted elicitationId must match the one we just took.
    if (body.elicitationId !== taken.entry.elicitationId) {
      elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
      return reply
        .code(409)
        .send({ error: 'Elicitation superseded; fetch the current prompt and resubmit' });
    }

    // 5. Accept-specific validation.
    if (body.action === 'accept') {
      // 5a. content.response must be present.
      if (typeof body.content?.response !== 'string') {
        elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
        return reply.code(400).send({ error: 'action:accept requires content.response' });
      }
      // 5b. Enum check: if the schema constrained the response, honour it.
      if (
        taken.entry.options !== null &&
        !taken.entry.options.includes(body.content.response)
      ) {
        elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
        return reply.code(400).send({ error: 'response must be one of the allowed options' });
      }
    }

    const response = body.action === 'accept' ? body.content!.response : null;

    // 6. Forward to the actor.
    try {
      await adapter.resolveElicitation(id, taken.entry.elicitationId, body.action, response);
    } catch (err) {
      elicitationCache.restoreIfUnchanged(id, taken.entry, taken.gen);
      const code = err instanceof ElicitationUnsupportedError ? 501 : 500;
      return reply.code(code).send({ error: message(err) });
    }

    // 7. Done.
    audit.record('elicitation.resolved', actorOf(req), {
      runId: id,
      detail: { elicitationId: taken.entry.elicitationId, action: body.action },
    });
    // DC-S4a host: a free-text answer is words; a picked option (or a decline) is a `choice`.
    if (decisions !== null) {
      const picked = taken.entry.options !== null;
      decisions.track(ingestDecision(decisions, {
        host: 'elicitation',
        actor: actorOf(req),
        words: response !== null && !picked ? response : '',
        ...(response !== null && picked ? { choice: response } : body.action !== 'accept' ? { choice: body.action } : {}),
        projectId: projects.index.projectOf(id) ?? null,
        runId: id,
        elicitationId: taken.entry.elicitationId,
      }));
    }
    return { status: 'resolved' };
  });

  // The durable history of one run (FINDING-057).
  //
  // `/ws` is a live tap and explicitly replays nothing on late join, so until this route existed
  // the event log had exactly one reader — the gate route above, which reads it for a single
  // `awaitingHuman` frame and discards the rest. Everything else a run recorded (routing councils,
  // gate verdicts, per-unit cost) was write-only: observable if you happened to be attached while
  // it streamed, and unrecoverable afterwards. That makes an incident un-investigable and a run's
  // audit trail unciteable, which is the opposite of what a durable log is for.
  //
  // `type` filters server-side because the alternative is shipping an entire run's history to
  // answer "what did the gates decide" — the log already excludes high-volume frames
  // (`is_high_volume` drops CLI/chat deltas and terminal output), so what remains is the
  // lifecycle, but a long run is still thousands of frames.
  app.get(`${V}/runs/:id/events`, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Fastify's default querystring parser yields a string for `?type=a` and an ARRAY for a
    // repeated `?type=a&type=b`. Typing it as `string` and calling `.split` would have thrown a
    // 500 on the repeated form — a caller asking for two types the obvious way.
    const { type } = req.query as { type?: string | string[] };

    // IDs only: this is an existence check, and `sessionsDetail()` would load and parse every
    // run's full unit detail to answer it — the same reason `/runs/:id/inject` uses `sessions()`.
    const ids = await adapter.sessions();
    if (!ids.includes(id)) {
      return reply.code(404).send({ error: 'Run not found' });
    }

    const engineEvents = await adapter.runEvents(id);
    if (engineEvents === null) {
      // Same shape as the gate route's 503, and for the same reason: "no events" would report a
      // missing binding as a fact about the run. The run may well have a rich history.
      return reply.code(503).send({
        error: 'Run history is unavailable: this wicked-core build has no event-log read binding',
      });
    }
    // wicked-studio#284: the stall watchdog's frames are daemon-authored — the engine's log never
    // saw them — so a reloaded page used to lose the "needs you" facts the live socket carried.
    // Merge the remembered frames in capture order beside the engine's; they carry `daemon: true`
    // and no engine `seq`.
    const daemonFrames = runtime.stallFrames?.(id) ?? [];
    const events: Array<RecordedEvent | ServedStallFrame> =
      daemonFrames.length === 0
        ? engineEvents
        : withServedSeq([...engineEvents, ...daemonFrames].sort((a, b) => a.ts - b.ts));

    // An empty array here is a real answer, not a failure: runs that predate the log have no
    // history, and saying so is the honest response.
    // Both spellings of "several types" mean the same thing: `?type=a,b` and `?type=a&type=b`.
    // An empty filter (`?type=`, or only separators) is treated as NO filter rather than as a
    // filter matching nothing — "show me events of no type" is not a question anyone asks, and
    // answering it with an empty list looks identical to a run that recorded nothing.
    const names = (Array.isArray(type) ? type : type === undefined ? [] : [type])
      .flatMap((t) => t.split(','))
      .map((t) => t.trim())
      .filter(Boolean);
    const wanted = names.length > 0 ? new Set(names) : null;
    const filtered = wanted ? events.filter((e) => wanted.has(e.type)) : events;
    return { runId: id, total: events.length, returned: filtered.length, events: filtered };
  });

  // ── Governance reads (crew#40) ──────────────────────────────────────────────

  // STEERING fold: the READ half of the old policy surface stays — retired-not-deleted means a
  // past gate decision citing a policy id must stay resolvable, and the engine keeps serving the
  // listing (as a thin shim over the unified store once the model merges). The WRITE half
  // (POST/DELETE below) answers 410 on a steering engine — see the fold comment there.
  app.get(
    `${V}/governance/policies`,
    { config: { manifest: { responseType: '{ policies: GovernancePolicy[] }', statusCodes: [200] } } },
    async () => {
      const policies = await adapter.listPolicies();
      return { policies };
    },
  );

  // The wiki BROWSE surface (wiki-mgmt): facet filters over the listed rows. EXACT matches by
  // design — unlike `/governance/rules/preview`, whose recall semantics treat an absent rule
  // facet as a wildcard (enforcement's question: "which rules apply HERE"), browse answers
  // "show me the rules TAGGED `layer=api`", and a wildcard rule flooding every layer filter
  // would bury the tagged ones. `?status=` keeps the AW-24 kill switch visible: every row keeps
  // its `retired` flag, and `retired`/`active` narrow to one side. Default is `all` — the
  // route's historical behavior, though pre-0.7.4 addons funnel the listing through recall and
  // return active rows only (the engine's fact to fix, not this filter's to mask).
  app.get(
    `${V}/governance/rules`,
    {
      config: {
        manifest: {
          responseType: '{ rules: ConformanceRule[] }',
          // 501: `?type=` on a pre-steering engine (wicked-core-ts < 0.7.5) — see the facet below.
          statusCodes: [200, 400, 501],
        },
      },
    },
    async (req, reply) => {
      const q = req.query as Record<string, string | string[] | undefined>;
      // Same normalization as `repoParam` below: first value of a repeated param, trimmed, and
      // an empty/whitespace value means "facet not given" rather than a filter matching nothing.
      const facet = (k: string): string | undefined => {
        const raw = q[k];
        const first = Array.isArray(raw) ? raw[0] : raw;
        const trimmed = first?.trim();
        return trimmed ? trimmed : undefined;
      };
      // Closed vocabularies reject loudly (400 names the valid set): `?severity=hihg` silently
      // matching nothing would read as "no critical rules" — an empty answer to a question the
      // caller didn't ask.
      const invalid = (name: string, got: string, valid: string) =>
        reply.code(400).send({ error: `${name} must be one of ${valid} (got \`${got}\`)` });
      const severity = facet('severity');
      if (severity !== undefined && !RULE_SEVERITIES.has(severity)) {
        return invalid('severity', severity, 'info|warn|error|critical');
      }
      const ruleType = facet('rule_type');
      if (ruleType !== undefined && !RULE_TYPES.has(ruleType)) {
        return invalid('rule_type', ruleType, 'pattern|policy');
      }
      // `?type=` — the STEERING facet (one Steering sub-page per type). Closed vocabulary, and
      // presence-gated on the steering engine: rows served by a pre-0.7.5 addon carry no
      // `steering_type`, so filtering them would answer "no <type> rules" to a question this
      // engine cannot answer — 501 ("upgrade the engine"), never an empty non-answer.
      const steeringType = facet('type');
      if (steeringType !== undefined && !STEERING_TYPES.has(steeringType)) {
        return invalid('type', steeringType, STEERING_TYPE_VALUES.join('|'));
      }
      if (steeringType !== undefined && !adapter.steeringSupported()) {
        return reply
          .code(501)
          .send({ error: new SteeringUnsupportedError('Filtering rules by steering type').message });
      }
      // `?include_retired=` — the boolean spelling of the retire filter (`true` ⇒ `all`,
      // `false` ⇒ `active`). Mutually exclusive with `?status=`: the two are one filter in two
      // spellings, and silently picking a winner when they contradict would answer a question
      // the caller didn't ask.
      const includeRetired = facet('include_retired');
      if (includeRetired !== undefined && includeRetired !== 'true' && includeRetired !== 'false') {
        return invalid('include_retired', includeRetired, 'true|false');
      }
      const statusGiven = facet('status');
      if (includeRetired !== undefined && statusGiven !== undefined) {
        return reply.code(400).send({
          error:
            'send `status` or `include_retired`, not both — they are two spellings of the same retire filter and can contradict',
        });
      }
      const status =
        statusGiven ?? (includeRetired === undefined ? 'all' : includeRetired === 'true' ? 'all' : 'active');
      if (!RULE_STATUSES.has(status)) {
        return invalid('status', status, 'active|retired|all');
      }
      const layer = facet('layer');
      // `since`/`until` (unix SECONDS, inclusive) date-bound the listed rows by each rule's
      // `created_at`. A present-but-non-integer bound is a 400. NOTE: `created_at` is wired-but-
      // pending a core-ts bump — it landed on the engine's `ConformanceRule` after the published
      // core-ts this daemon builds against, so on the current binding NO rule carries it and this
      // filter narrows to empty. The pass-through is verbatim (`listConformanceRules` returns the
      // parsed rows unchanged), so the bound starts working the moment crew re-pins to a core-ts
      // that surfaces it — a rule with no `created_at` is excluded, never dated with a fabricated now.
      const since = facet('since');
      const sinceSecs = parseUnixSecondsParam(since);
      if (sinceSecs === 'invalid') {
        return reply
          .code(400)
          .send({ error: `since must be a non-negative integer in unix seconds (got \`${since ?? ''}\`)` });
      }
      const until = facet('until');
      const untilSecs = parseUnixSecondsParam(until);
      if (untilSecs === 'invalid') {
        return reply
          .code(400)
          .send({ error: `until must be a non-negative integer in unix seconds (got \`${until ?? ''}\`)` });
      }
      const rules = (await adapter.listConformanceRules()).filter(
        (r) =>
          (severity === undefined || r.severity === severity) &&
          (ruleType === undefined || r.rule_type === ruleType) &&
          (layer === undefined || r.targets.layer === layer) &&
          // Absent `steering_type` reads as the engine's serde default (architecture) — a
          // steering engine always stamps it, but filter defensively over mixed-era rows.
          (steeringType === undefined || (r.steering_type ?? DEFAULT_STEERING_TYPE) === steeringType) &&
          // `retired` is absent on rows written before the field existed, which read as active.
          (status === 'all' || (status === 'retired') === (r.retired === true)) &&
          // Undated rules (every rule on a pre-bump core-ts) are excluded once a bound is set.
          withinDateRange(r.created_at, sinceSecs, untilSecs),
      );
      return { rules };
    },
  );

  app.get(`${V}/governance/claims`, async () => {
    const claims = await adapter.listConformanceClaims();
    return { claims };
  });

  // Replay THIS daemon's governance dead-letter outbox into its own store — the
  // `wicked-crew governance replay` CLI (crew#495) as a route, so a skin can offer the repair
  // beside the count it shows (`/diagnostics.governance.deadletters`). `dryRun: true` folds the
  // outbox and moves nothing, and says up front whether a real replay could run at all
  // (`blocker`); a real replay drains exactly as the CLI does (archive first, entries that fail
  // go back onto the live outbox and stay dead letters). One replay at a time per daemon.
  let deadletterReplayInFlight = false;
  app.post(
    `${V}/governance/deadletters/replay`,
    {
      config: {
        manifest: {
          requestType: 'GovernanceReplayBody',
          responseType: 'GovernanceReplayOutcome',
          statusCodes: [200, 400, 409, 500, 501],
        },
      },
    },
    async (req, reply) => {
      const parsed = z.object({ dryRun: z.boolean().optional() }).strict().safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      const dryRun = parsed.data.dryRun === true;
      const store = adapter.governanceStore ?? null;
      if (store === null) {
        // crew#829: the refusal names the one-line fix; a replay is offered once the store exists.
        return reply.code(409).send({ error: `this daemon resolved no governance store — there is nothing to replay into; ${governanceStoreFix()}` });
      }
      const blocker = store.dbPath === ':memory:'
        ? 'the governance store is in-memory — name a durable store before replaying'
        : !CoreAdapter.replayEmitOutboxSupported()
          ? 'the installed engine cannot replay a dead-letter outbox — upgrade wicked-core-ts'
          : null;
      // Checked FIRST, for both modes: a running replay has renamed the live outbox to its archive,
      // so any read now would report a false zero while those dead letters are still in flight.
      if (deadletterReplayInFlight) return reply.code(409).send({ error: 'a dead-letter replay is already running' });
      const outbox = store.outboxPath;
      if (!existsSync(outbox)) {
        // No outbox = no dead letters: a zero outcome, never an error.
        const fold = await foldDeadletters(outbox);
        return {
          outbox, store: { path: store.displayPath, source: store.source }, archive: null,
          read: 0, replayed: 0, alreadyPresent: null, failed: 0, dryRun, note: null,
          ...(dryRun ? { fold } : {}), blocker,
        };
      }
      if (!dryRun && blocker !== null) return reply.code(blocker.startsWith('the installed engine') ? 501 : 409).send({ error: blocker });
      if (!dryRun) deadletterReplayInFlight = true;
      try {
        const { outcome } = await replayOutboxInto(outbox, store, { dryRun });
        if (!dryRun) {
          audit.record('governance.deadletters.replayed', actorOf(req), {
            detail: { read: outcome.read, replayed: outcome.replayed, failed: outcome.failed },
          });
        }
        return { ...outcome, blocker: dryRun ? blocker : null };
      } catch (err) {
        if (err instanceof GovernanceReplayUnsupportedError) return reply.code(501).send({ error: message(err) });
        if (err instanceof UsageError) return reply.code(409).send({ error: message(err) });
        return reply.code(500).send({ error: message(err) });
      } finally {
        if (!dryRun) deadletterReplayInFlight = false;
      }
    },
  );

  // Normalize a `?repo=` query: Fastify parses a repeated `?repo=a&repo=b` into a `string[]` (take
  // the first), and the value is TRIMMED so it's both validated and PASSED trimmed — a `?repo=%20x%20`
  // must not pass the guard then miss the registry lookup on whitespace (Copilot #227).
  const repoParam = (req: { query?: unknown }): string | undefined => {
    const raw = (req.query as { repo?: string | string[] } | undefined)?.repo;
    const first = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = first?.trim();
    return trimmed ? trimmed : undefined;
  };
  // An unknown repo is the CALLER's error (404); a binding/parse failure is OURS (500). Don't collapse
  // them (Copilot #227). Core spells the not-found case `no registered repo '<ref>'`.
  const repoReadStatus = (msg: string): number => (/no registered repo/i.test(msg) ? 404 : 500);

  app.get(`${V}/governance/coverage`, async (req, reply) => {
    // FINDING-009: with `?repo=<ref>`, report coverage over THAT repo's own code graph. The bare
    // endpoint reads the daemon store and reports a vacuous `coverage: 1.0` that names no repo — the
    // real gate lives per-repo. An unknown repo is an ERROR in core (never a silent vacuous report).
    const repo = repoParam(req);
    if (repo) {
      try {
        const report = await adapter.getCoverageReportForRepo(repo);
        return { report };
      } catch (err) {
        const msg = message(err);
        return reply.code(repoReadStatus(msg)).send({ error: msg });
      }
    }
    const report = await adapter.getCoverageReport();
    return { report };
  });

  app.get(`${V}/governance/graph`, async (req, reply) => {
    // #122: node-count-by-kind summary of a repo's OWN code graph. Repo-scoped ONLY — there is no
    // meaningful daemon-wide graph view (the daemon store holds run/governance nodes, not a repo's
    // code graph), so a missing `?repo=` is a 400, an unknown repo a 404, and an engine/binding
    // failure a 500 (not masked as 404).
    const repo = repoParam(req);
    if (!repo) {
      return reply.code(400).send({ error: 'governance/graph requires a ?repo=<ref>' });
    }
    try {
      const kinds = await adapter.getGraphKindsForRepo(repo);
      return { kinds };
    } catch (err) {
      const msg = message(err);
      return reply.code(repoReadStatus(msg)).send({ error: msg });
    }
  });

  // ── Governance writes (crew#42; STEERING fold) ─────────────────────────────

  // The OLD policy WRITE surface, folded into the unified rules routes (STEERING program): on a
  // steering engine (wicked-core-ts ≥ 0.7.5, where policy rows have MIGRATED into steering
  // rules) these answer 410 Gone with a pointer at the rules CRUD — the wire contract's honest
  // spelling of "this resource model no longer exists" (a silent alias would accept a write into
  // a store decide()/select() no longer read). On a PRE-steering engine the legacy behavior
  // stands untouched: folding before the model merges would strand policy writes with no unified
  // store to land in.
  //
  // The READ (`GET /governance/policies` above) deliberately stays: retired-not-deleted means
  // past decisions citing a policy id must stay resolvable, the engine keeps a read shim for
  // exactly that, and the released studio 0.4.2 still renders the listing.
  const policyWriteGone = (reply: FastifyReply, pointer: string) =>
    reply.code(410).send({
      error:
        'the policy model merged into steering rules (STEERING program): policies are now ' +
        `steering rules with effect/trigger/obligations/criteria as first-class fields — use ${pointer}`,
      see: pointer,
    });

  app.post(
    `${V}/governance/policies`,
    { config: { manifest: { statusCodes: [200, 400, 410] } } },
    async (req, reply) => {
      if (adapter.steeringSupported()) {
        return policyWriteGone(reply, `POST ${V}/governance/rules`);
      }
      try {
        const policy = req.body as import('../core/types.js').GovernancePolicy;
        await adapter.upsertPolicy(policy);
        audit.record('governance.policy.upserted', actorOf(req), { detail: { id: policy?.id } });
        return { status: 'ok' };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  // The steering fields a rule write may carry — the merged model's additions (STEERING). On an
  // engine that predates the model, `upsertConformanceRule` would ACCEPT the write and silently
  // drop every one of them (ConformanceRule has no `deny_unknown_fields`), persisting a rule
  // that recalls and enforces differently than the caller wrote — so their presence is gated
  // loudly (the extraWriteRoots doctrine): 501, upgrade the engine. A write WITHOUT them is the
  // legacy request and passes through on any engine.
  const STEERING_RULE_FIELDS = [
    'steering_type',
    'applies_to',
    'excludes',
    'weight',
    'effect',
    'trigger',
    'obligations',
    'criteria',
  ] as const;

  app.post(
    `${V}/governance/rules`,
    {
      config: {
        manifest: {
          requestType: 'ConformanceRule',
          // 501: the body carries steering fields but the installed engine predates the
          // steering model (wicked-core-ts < 0.7.5) and would silently drop them.
          statusCodes: [200, 400, 501],
        },
      },
    },
    async (req, reply) => {
      try {
        const rule = req.body as import('../core/types.js').ConformanceRule;
        if (!adapter.steeringSupported() && rule !== null && typeof rule === 'object') {
          const carried = STEERING_RULE_FIELDS.filter(
            (f) => (rule as unknown as Record<string, unknown>)[f] !== undefined,
          );
          if (carried.length > 0) {
            return reply.code(501).send({
              error:
                `${new SteeringUnsupportedError('Writing steering rule fields').message} — ` +
                `the installed engine would silently drop ${carried.map((f) => `\`${f}\``).join(', ')} ` +
                'and persist a rule that enforces differently than you wrote',
            });
          }
        }
        // DC-S3: `targets.project` and `supersedes` shipped with `considerRules` (wicked-core-ts
        // 0.7.35). An older engine would accept and drop them, so a project rule would land
        // everywhere: refuse, naming the fields (codex on DC-S3).
        if (!adapter.projectRulesSupported() && rule !== null && typeof rule === 'object') {
          const carried = [
            ...(rule.targets?.project !== undefined ? ['targets.project'] : []),
            ...(rule.supersedes !== undefined ? ['supersedes'] : []),
          ];
          if (carried.length > 0) {
            return reply.code(501).send({
              error:
                `the installed engine would silently drop ${carried.map((f) => `\`${f}\``).join(', ')} ` +
                'and land the rule everywhere; upgrade wicked-core-ts (>= 0.7.35)',
            });
          }
        }
        await adapter.upsertConformanceRule(rule);
        audit.record('governance.rule.upserted', actorOf(req), { detail: { id: rule?.id } });
        return { status: 'ok' };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  // Retire, not delete. The record survives so past decisions citing it stay explicable; it just
  // stops being enforced (FINDING-038 — a mis-authored policy otherwise denied forever).
  app.delete(
    `${V}/governance/policies/:id`,
    { config: { manifest: { statusCodes: [200, 400, 404, 410] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // Folded like the POST above: on a steering engine the migrated row retires through the
      // rules kill switch (same id — migration keeps ids stable so decision audits resolve).
      if (adapter.steeringSupported()) {
        return policyWriteGone(reply, `DELETE ${V}/governance/rules/${id}`);
      }
      try {
        const existed = await adapter.retirePolicy(id);
        if (!existed) return reply.code(404).send({ error: `policy '${id}' not found` });
        audit.record('governance.policy.retired', actorOf(req), { detail: { id } });
        return { status: 'retired', id };
      } catch (err) {
        return reply.code(400).send({ error: message(err) });
      }
    },
  );

  app.delete(`${V}/governance/rules/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const existed = await adapter.retireConformanceRule(id);
      if (!existed) return reply.code(404).send({ error: `conformance rule '${id}' not found` });
      audit.record('governance.rule.retired', actorOf(req), { detail: { id } });
      return { status: 'retired', id };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.get(`${V}/governance/rules/preview`, async (req, reply) => {
    const q = req.query as Record<string, string | string[] | undefined>;
    try {
      const rules = await adapter.recallRulesPreview(q);
      return { rules };
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  // ── Workflow viewer + builder (crew#44) ───────────────────────────────────

  // (crew#718) Start the engine's verdict pass at registration, so every SYNC reader of
  // `listWorkflows()` / `getWorkflow()` (the deliver resolver, the acceptance fold, the launch
  // lookup) sees the judged catalog from the first request rather than after the first catalog GET.
  // The pass is memoized: the handlers below await the same promise.
  // Guarded like `listWorkflows` at :1110 — the endpoint-manifest collector registers these routes
  // against a partial adapter that carries neither.
  if (typeof (adapter as Partial<CoreAdapter>).workflowCatalog === 'function') {
    void adapter.workflowCatalog().catch((err: unknown) => {
      app.log.warn(`wicked-crew: the workflow overlay could not be judged (${message(err)}); the catalog lists what parsed`);
    });
  }

  // (crew#718) The catalog is what the ENGINE will honour, not what parses as `{id, phases[]}`.
  // A drop-in core refused at boot ("gate evaluates nothing: …") used to be listed here and
  // offered in studio's selector, and the launch then 400'd `unknown workflow` — the operator
  // learnt about it only from the failed launch. `workflowCatalog()` asks core's own validator:
  // the refused def leaves `workflows` (so it cannot be launched) and appears in `unavailable`
  // with core's verbatim reason (so its author is told why, and what to fix).
  app.get(`${V}/workflows`, async () => {
    const { workflows, unavailable } = await adapter.workflowCatalog();
    return { workflows, unavailable };
  });

  app.get(`${V}/workflows/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const workflow = adapter.getWorkflow(id);
    if (!workflow) {
      return reply.code(404).send({ error: `workflow '${id}' not found` });
    }
    // humanGates: the phases that will PAUSE for a person even under humanConfirm:none (core#208).
    // Surfaced so an operator can see a workflow's gates BEFORE launching it (FINDING-023).
    return { workflow, humanGates: humanGatePhaseIds(workflow) };
  });

  // (X-MIG M11) User-authored workflow defs are retired: a user saves a PRESET — catalog steps the
  // engine composes and governs — with `PUT /presets/:name`. A def posted here would be a free-form
  // def the engine no longer keeps, so the route answers 410 with the replacement.
  app.post(`${V}/workflows`, async (_req, reply) => {
    return reply.code(410).send({
      error: 'POST /workflows is retired: save a preset instead (PUT /api/v1/presets/:name with {steps})',
      replacement: 'PUT /api/v1/presets/:name',
    });
  });

  // Save an inline script to ~/.wicked/scripts/ and return its path.
  // Tool-executor phases use the returned path as their command.
  app.post(`${V}/scripts`, async (req, reply) => {
    const body = req.body as { name?: unknown; content?: unknown; lang?: unknown };
    if (typeof body.name !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: '`name` and `content` are required strings' });
    }
    if (!SAFE_REPO_NAME.test(body.name) || body.name.length > 128) {
      return reply.code(400).send({ error: 'Script name must start with a letter/digit and contain only letters, digits, dots, hyphens, and underscores' });
    }
    const lang = (body.lang as string | undefined) ?? 'bash';
    if (!['bash', 'python', 'sh'].includes(lang)) {
      return reply.code(400).send({ error: '`lang` must be bash | python | sh' });
    }
    try {
      const path = await adapter.saveScript(body.name, body.content, lang as 'bash' | 'python' | 'sh');
      return reply.code(201).send({ path });
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Domain-model browser (crew#44) ────────────────────────────────────────
  // Reads the `requirements_graph.json` artifact produced by `wicked-core domain-graph`.
  // Path: `.wicked-estate/requirements/requirements_graph.json` relative to cwd.

  app.get(`${V}/domain-graph`, async (_req, reply) => {
    const path = join(process.cwd(), '.wicked-estate', 'requirements', 'requirements_graph.json');
    try {
      const content = await fsp.readFile(path, 'utf8');
      return { graph: JSON.parse(content) as unknown };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { graph: null };
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Per-repo domain graph ─────────────────────────────────────────────────
  // Reads requirements_graph.json from the repo root. Coverage stats come from
  // the live estate store via `wicked-core coverage --json` (not a cached file).

  app.get(`${V}/repos/:id/domain-graph`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    const graphPath = requirementsGraph(repo);
    const dbPath = codeGraphDbOr503(repo, reply);
    if (dbPath === null) return reply;

    // Coverage from the live estate store — computed by wicked-core governance layer.
    let coverage: unknown = null;
    if (existsSync(dbPath)) {
      try {
        const { stdout } = await execCapped(
          process.env['WICKED_CORE_EXE'] ?? 'wicked-core',
          ['coverage', '--db', dbPath, '--json'],
          { timeout: 20_000, cwd: repo.root_path },
        );
        coverage = JSON.parse(stdout) as unknown;
      } catch (err) {
        // The bare `catch {}` here claimed "store not yet indexed" for EVERY failure — a comment
        // asserting a diagnosis the code never checked. An output overflow, a timeout and a missing
        // binary all became a silent null, so the panel showed "no coverage" for reasons that are
        // not the same problem and do not have the same fix (FINDING-016, and FINDING-050's shape:
        // distinct causes collapsed into one outcome).
        //
        // Coverage stays optional — this endpoint must not 500 because the store is not indexed yet,
        // which is a legitimate and common state. But a cause that is NOT that gets said out loud.
        if (err instanceof ExecOutputTooLarge) {
          req.log.warn({ err: err.message }, 'coverage output exceeded the buffer cap');
        } else if (!(err instanceof SyntaxError)) {
          req.log.debug({ err: message(err) }, 'coverage unavailable');
        }
      }
    }

    try {
      const content = await fsp.readFile(graphPath, 'utf8');
      return { graph: JSON.parse(content) as unknown, coverage };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { graph: null, coverage };
      return reply.code(500).send({ error: message(err) });
    }
  });

  // ── Repo code graph (via wicked-estate graph-view) ──────────────────────────
  // Delegates to the estate CLI so the query goes through the proper service
  // layer (store-seam aware, overlay edges included). Postgres-safe.

  // ── Requirements management (server-side search over requirements_graph.json +
  //    operator overrides sidecar; see api/requirements.ts) ─────────────────────
  const ReqQuerySchema = z.object({
    q: z.string().optional(),
    risk: z.enum(['risk', 'no-risk']).optional(),
    category: z.enum(['functional', 'config-data']).optional(),
    domain: z.string().optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).strict();
  app.get(`${V}/repos/:id/requirements`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const parsed = ReqQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid query'));
    }
    let page: Awaited<ReturnType<typeof listRequirements>>;
    try {
      page = await listRequirements(repo, parsed.data);
    } catch (err) {
      // wicked-core#406: a CURRENT engine with no repo-graph root is a 503, not a 500.
      const status = codeGraphErrorStatus(err);
      if (status === null) throw err;
      return reply.code(status).send({ error: message(err) });
    }
    if (page === null) {
      return reply.code(404).send({ error: 'requirements_graph.json not generated for this repo yet' });
    }
    // Overrides keyed by ids the corpus no longer mints (an estate id-scheme migration re-keys
    // method/field SymbolIds) would otherwise vanish without a trace — the count is on the page
    // AND in the log, because the operator who edited them is not the one reading the response.
    if ((page.orphanedOverrides ?? 0) > 0) {
      req.log.warn(
        { repo: id, orphanedOverrides: page.orphanedOverrides },
        'requirements_overrides.json holds keys matching no requirement — stale after a re-index/migration; re-run the annotation workflow, then re-apply or delete them',
      );
    }
    return page;
  });

  app.get(`${V}/repos/:id/requirements/:key`, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    let decoded: string;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      return reply.code(400).send({ error: 'Malformed requirement key encoding' });
    }
    let detail: Awaited<ReturnType<typeof getRequirement>>;
    try {
      detail = await getRequirement(repo, decoded);
    } catch (err) {
      // wicked-core#406: a CURRENT engine with no repo-graph root is a 503, not a 500.
      const status = codeGraphErrorStatus(err);
      if (status === null) throw err;
      return reply.code(status).send({ error: message(err) });
    }
    if (detail === null) return reply.code(404).send({ error: 'Requirement not found' });
    return { requirement: detail };
  });

  const ReqPatchSchema = z
    .object({
      title: z.string().min(1).max(500).optional(),
      notes: z.string().max(5000).optional(),
      status: z.enum(['active', 'deprecated', 'review']).optional(),
      risk: z.boolean().optional(),
    })
    .strict()
    // `.strict()` BEFORE `.refine()`: the refine runs on the parsed object, so with stripping still
    // in effect `{"title":"x","note":"y"}` would pass the non-empty check having silently discarded
    // the edit the caller cared about. Every field here is optional, which is exactly the shape
    // FINDING-031 makes dangerous.
    .refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });
  app.patch(`${V}/repos/:id/requirements/:key`, async (req, reply) => {
    const { id, key } = req.params as { id: string; key: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const parsed = ReqPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid patch'));
    }
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(key);
    } catch {
      return reply.code(400).send({ error: 'Malformed requirement key encoding' });
    }
    let detail: Awaited<ReturnType<typeof patchRequirement>>;
    try {
      detail = await patchRequirement(repo, decodedKey, parsed.data);
    } catch (err) {
      // wicked-core#406: a CURRENT engine with no repo-graph root is a 503, not a 500.
      const status = codeGraphErrorStatus(err);
      if (status === null) throw err;
      return reply.code(status).send({ error: message(err) });
    }
    if (detail === null) return reply.code(404).send({ error: 'Requirement not found' });
    return { requirement: detail };
  });

  app.get(
    `${V}/repos/:id/graph`,
    { config: { manifest: { responseType: 'RepoGraphResponse', statusCodes: [200, 404, 500, 503] } } },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    const dbPath = codeGraphDbOr503(repo, reply);
    if (dbPath === null) return reply;
    if (!existsSync(dbPath)) {
      // `graph: null` alone cannot tell "not indexed" from "empty" (F-2R2-005): say WHY, with the
      // same finding text the repos wire carries when the engine has one.
      const finding = (repo.findings ?? []).find(
        (f) => f.code === 'in_tree_code_graph_ignored' || f.code === 'code_graph_root_unresolvable',
      );
      const unbuilt: RepoGraphReply = {
        graph: null,
        reason:
          finding?.message ??
          `no code graph has been built for '${repo.name}' yet (nothing at ${dbPath}) — run onboarding ` +
            `(POST /api/v1/repos/${repo.id}/onboard) to index it`,
        ...(finding !== undefined ? { finding } : {}),
      };
      return reply.send(unbuilt);
    }

    try {
      const settings = await adapter.getSettings();
      const q = req.query as { focus?: string; limit?: string };
      const parsedLimit = q.limit !== undefined ? Number.parseInt(q.limit, 10) : NaN;
      const nodeLimit = String(
        Number.isFinite(parsedLimit) && parsedLimit > 0 && parsedLimit <= 1000
          ? parsedLimit
          : settings.graphNodeLimit,
      );
      const args = ['graph-view', '--limit', nodeLimit, '--db', dbPath];
      // FOCUS (ego-graph) mode: seed the slice from one symbol and expand its
      // neighbourhood — the navigation primitive (estate graph-view --focus).
      if (q.focus !== undefined && q.focus.trim() !== '') {
        args.push('--focus', q.focus.trim());
      }
      // Whole-graph `totals` beside the served slice (crew#505 / F-RC1-100; api-types 0.38.0):
      // `graph-view --limit` emits only the slice, so `stats` alone read "my repo has 150 symbols".
      // `wicked-estate stats --db` prints `nodes=N edges=M files=F …`; both spawns run under
      // `Promise.all` (one round trip, not two), the SAME daemon-side CLI posture as `graph-view`.
      // A stats spawn that fails or prints something else leaves `totals` ABSENT and the slice
      // still 200 — the tile then knows only the slice, never a substituted count.
      const exe = estateExe();
      const [{ stdout }, statsOut] = await Promise.all([
        execCapped(exe, args, { timeout: 30_000, cwd: repo.root_path }),
        execCapped(exe, ['stats', '--db', dbPath], { timeout: 30_000, cwd: repo.root_path })
          .then((r) => r.stdout)
          .catch(() => null),
      ]);
      const raw = JSON.parse(stdout) as {
        nodes: Array<{ id: string; name: string; kind: string; file: string; lang: string; score: number; inDeg: number; outDeg: number }>;
        edges: Array<{ src: string; tgt: string }>;
      };
      const fileCount = new Set(raw.nodes.map((n) => n.file)).size;
      const totals = statsOut === null ? undefined : parseEstateTotals(statsOut);
      const built: RepoGraphReply = {
        graph: {
          nodes: raw.nodes,
          edges: raw.edges,
          stats: { nodeCount: raw.nodes.length, edgeCount: raw.edges.length, fileCount },
          ...(totals !== undefined ? { totals } : {}),
        },
      };
      return reply.send(built);
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
    },
  );

  // ── Git history (last 20 commits via git log) ─────────────────────────────

  // ── Blast radius for a symbol (via wicked-estate blast-radius --json).
  //    Carries the honesty contract through: dependents PLUS the count of references
  //    no resolver bound (ENGINE-CONTRACT §2.1 — repeat sites of an already-bound
  //    relationship are not counted, so 0 is legitimate for a fully-resolved symbol).
  //    When non-zero, an empty dependents list must never read as "safe to change".
  app.get(`${V}/repos/:id/graph/blast-radius`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { name?: string };
    if (q.name === undefined || q.name.trim() === '') {
      return reply.code(400).send({ error: 'name query parameter required' });
    }
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });
    const dbPath = codeGraphDbOr503(repo, reply);
    if (dbPath === null) return reply;
    if (!existsSync(dbPath)) {
      return reply.code(404).send({ error: 'Code graph not built for this repo yet' });
    }
    try {
      // Every page of the answer (estate#279): the dependents are joined, the rest is the last page's.
      return reply.send(
        await readBlastRadiusPages('wicked-estate', q.name.trim(), dbPath, { timeout: 30_000, cwd: repo.root_path }),
      );
    } catch (err) {
      return reply.code(500).send({ error: message(err) });
    }
  });

  // R3 (ship-prove-3): what a delivering launch on this repo would push and where — read by the
  // SAME origin preflight the deliver gate card uses (crew#730), so the launch composer cannot
  // promise "opens a PR" on an origin that can never carry one. Read-only: one
  // `git remote get-url --push origin` in the registered checkout; nothing is pushed or probed.
  app.get(
    `${V}/repos/:id/deliver-target`,
    { config: { manifest: { responseType: 'DeliverTargetResponse', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const repo = deliverRepoFor(await adapter.listRepos(), id);
      if (repo === undefined) return reply.code(404).send({ error: `Repo ${id} not found` });
      const originUrl = repo.root_path === '' ? null : await readDeliverOriginUrl(repo.root_path);
      // crew#720: the provider credential preflight, so a launch can say "not configured" up front.
      // crew#940: with a push identity configured, only that account's own gh login counts. Settings
      // that cannot be read leave it unconfigured (GH_ACCOUNT decides), as at launch.
      let configured = '';
      try {
        configured = deliverIdentityFor(await adapter.getSettings(), id).login;
      } catch {
        configured = '';
      }
      const identity = pushIdentityOf(configured);
      const credentials = await deliverCredentialsProbe(originUrl, process.env, undefined, identity);
      return reply.send({ repo: repo.id, ...deliverTargetView(originUrl), credentials });
    },
  );

  app.get(`${V}/repos/:id/git-history`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    try {
      const { stdout } = await execCapped(
        'git',
        ['log', '--pretty=format:%H\x1f%h\x1f%s\x1f%an\x1f%ar', '-n', '20'],
        { timeout: 10_000, cwd: repo.root_path },
      );
      const commits = stdout.trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.split('\x1f');
        return {
          sha:      parts[0] ?? '',
          shortSha: parts[1] ?? '',
          message:  parts[2] ?? '',
          author:   parts[3] ?? '',
          date:     parts[4] ?? '',
        };
      });
      return reply.send({ commits });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      const msg = message(err);
      if (msg.includes('not a git repository') || msg.includes('does not have any commits')) {
        return reply.send({ commits: [] });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // ── Git contributors (top 10 by commit count via git shortlog) ─────────────

  app.get(`${V}/repos/:id/contributors`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const repos = await adapter.listRepos();
    const repo = repos.find((r) => r.id === id);
    if (!repo) return reply.code(404).send({ error: `Repo ${id} not found` });

    try {
      const { stdout } = await execCapped(
        'git',
        ['shortlog', '-sne', '-n', '--no-merges', 'HEAD'],
        { timeout: 10_000, cwd: repo.root_path },
      );
      // Output: "  42\tFull Name <email@example.com>"
      const contributors = stdout.trim().split('\n').filter(Boolean).slice(0, 10).map((line) => {
        const m = line.match(/^\s*(\d+)\s+(.+?)\s+<([^>]+)>/);
        if (!m) return null;
        return { commits: parseInt(m[1] ?? '0', 10), name: m[2] ?? '', email: m[3] ?? '' };
      }).filter((c): c is { commits: number; name: string; email: string } => c !== null);
      return reply.send({ contributors });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.code(500).send({ error: 'git executable not found on server' });
      }
      const msg = message(err);
      // "ambiguous argument 'HEAD'" means no commits yet; treat as empty list
      if (
        msg.includes('not a git repository') ||
        msg.includes('does not have any commits') ||
        msg.includes("ambiguous argument 'HEAD'") ||
        msg.includes('unknown revision')
      ) {
        return reply.send({ contributors: [] });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // ── PTY terminal sessions (DES-TERMINAL-001 §6) ────────────────────────────
  // Open a PTY → its id. Drive it over the per-terminal WS `/ws/terminals/:id`;
  // raw output arrives there. `governed` defaults to `true` (the gate-hook-routed
  // default, §7) — an ungoverned operator shell must pass `governed:false` EXPLICITLY.
  app.post(`${V}/terminals`, async (req, reply) => {
    const parsed = OpenTerminalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    const b = parsed.data;
    try {
      const id = await adapter.openTerminal(b.cwd, b.cmd, b.cols, b.rows, b.governed ?? true);
      return reply.code(201).send({ id });
    } catch (err) {
      // Core rejects a bad cwd / spawn failure — a client error, not a 500.
      return reply.code(400).send({ error: message(err) });
    }
  });

  // crew#615: sign a seat out without the client composing the command. The daemon runs the
  // ENGINE's own `logout_invocation` for that seat (already prefixed with the seat's configuration
  // root; the daemon never synthesizes one) in a governed PTY, and answers the terminal id — the
  // CLI's output streams over `/ws/terminals/:id`. The seat's credential probe is re-run when the
  // terminal exits, so the roster's `signed_in` follows the outcome instead of waiting out the
  // probe's TTL.
  // DES-seats-page Q3 (operator, 2026-10-12): studio never handles credentials — a sign-in is a
  // command the operator runs in their own terminal (`RosterSeat.login_invocation`), so the
  // `POST /seats/:cli/login` PTY route is deleted. This logout route stays only while studio's
  // Configuration page still calls it; it goes with that page's Log out terminal (studio S2).
  for (const action of ['logout'] as const) {
    app.post(
      `${V}/seats/:cli/${action}`,
      { config: { manifest: { requestType: 'SeatSessionBody', responseType: 'SeatSessionResponse', statusCodes: [201, 400, 404] } } },
      async (req, reply) => {
        const { cli } = req.params as { cli: string };
        const parsed = SeatSessionSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
        }
        const seat = rosterWithStanding().find((s) => s.key === cli);
        if (seat === undefined) return reply.code(404).send({ error: `unknown seat: ${cli}` });
        const field = seat.logout_invocation;
        const invocation = typeof field === 'string' ? field.trim() : '';
        if (invocation === '') {
          return reply.code(404).send({
            error: `seat ${cli} has no ${action} command: the engine roster carries no ${action}_invocation for it (its CLI documents none)`,
          });
        }
        // Subscribe BEFORE the spawn: a short command can exit before `openTerminal` resolves, and
        // its exit must still re-probe and release the listener (codex review).
        let termId: string | null = null;
        const exitedEarly = new Set<string>();
        const done = (): void => {
          stop();
          rosterWithStanding.reprobe?.(cli);
        };
        const stop = adapter.onEvent((event) => {
          if (event.type !== 'terminalExited' || typeof event.id !== 'string') return;
          if (termId === null) exitedEarly.add(event.id);
          else if (event.id === termId) done();
        });
        try {
          termId = await adapter.openTerminal(homedir(), ['sh', '-lc', invocation], parsed.data.cols ?? 100, parsed.data.rows ?? 30, true);
        } catch (err) {
          stop();
          return reply.code(400).send({ error: message(err) });
        }
        if (exitedEarly.has(termId)) done();
        return reply.code(201).send({ terminalId: termId, cli, action });
      },
    );
  }

  const containerLoginOutcomes = new Map<string, SeatContainerLoginOutcome>();
  const containerSeat = (cli: string): boolean =>
    isContainerSeatFloor() && isContainerLoginCli(cli) && rosterWithStanding().some((seat) => seat.key === cli);
  const loginError = (stderr: string): string => loginDetail(stderr) || 'seat-login failed';
  // One sign-in/sign-out at a time per seat, and a generation every new sign-in and every sign-out
  // bumps (agy crew-r1): an abandoned login terminal that exits later never ingests over a newer
  // sign-in or a sign-out, and an ingest in flight finishes before a sign-out runs.
  const loginGeneration = new Map<string, number>();
  const seatOps = new Map<string, Promise<unknown>>();
  const serial = <T>(cli: string, op: () => Promise<T>): Promise<T> => {
    const next = (seatOps.get(cli) ?? Promise.resolve()).then(op, op);
    seatOps.set(cli, next.catch(() => undefined));
    return next;
  };
  const bump = (cli: string): number => {
    const g = (loginGeneration.get(cli) ?? 0) + 1;
    loginGeneration.set(cli, g);
    return g;
  };
  // The one sign-in per seat, reserved synchronously from the request's first await until its
  // ingest settles (codex crew-r1/r2: two sessions would share the engine's login session), and
  // released only by its owner (the generation that reserved it).
  const openLogins = new Map<string, number>();
  const release = (cli: string, generation: number): void => {
    if (openLogins.get(cli) === generation) openLogins.delete(cli);
  };

  app.post(
    `${V}/seats/:cli/container-login`,
    { config: { manifest: { requestType: 'SeatSessionBody', responseType: 'SeatContainerLoginResponse', statusCodes: [201, 400, 404, 502] } } },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      if (!containerSeat(cli)) return reply.code(404).send({ error: `container login unavailable for seat: ${cli}` });
      const parsed = SeatSessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
      if (openLogins.has(cli)) {
        return reply.code(409).send({ error: `a sign-in is already open for ${cli}; finish or close it first` });
      }
      // Reserved BEFORE the first await (codex crew-r1): a sign-out that lands meanwhile wins.
      const generation = bump(cli);
      openLogins.set(cli, generation);
      containerLoginOutcomes.delete(cli);
      const out = await serial(cli, () => runSeatLogin('argv', cli, seatLoginDeps));
      if (out.rc !== 0) {
        release(cli, generation);
        return reply.code(502).send({ error: loginError(out.stderr) });
      }
      if (loginGeneration.get(cli) !== generation) {
        release(cli, generation);
        return reply.code(409).send({ error: `the ${cli} sign-in was superseded (a sign-out or another sign-in)` });
      }
      let argv: string[];
      try {
        const value: unknown = JSON.parse(out.stdout);
        if (!Array.isArray(value) || value.length === 0 || !value.every((arg: unknown) => typeof arg === 'string' && arg.length > 0)) {
          throw new Error('seat-login argv must be a non-empty array of non-empty strings');
        }
        argv = value as string[];
      } catch (err) {
        release(cli, generation);
        return reply.code(502).send({ error: message(err) });
      }
      let termId: string | null = null;
      let completed = false;
      const exitedEarly = new Set<string>();
      const ingest = (): Promise<void> => serial(cli, async () => {
        // A newer sign-in or a sign-out superseded this terminal: nothing to ingest or record.
        if (loginGeneration.get(cli) !== generation) return;
        // Refusals the OLD credential earned up to now are superseded by this sign-in (codex
        // crew-r2: a 401 during the interactive login must not outlive it).
        const cutoff = Date.now();
        const result = await runSeatLogin('ingest', cli, seatLoginDeps);
        // The broker may have changed whatever happens next: the next reading is its own.
        containerStatus.invalidate(cli);
        rosterWithStanding.reprobe?.(cli);
        const outcome: SeatContainerLoginOutcome = { cli, ok: result.rc === 0, at: new Date().toISOString() };
        if (result.rc !== 0) outcome.error = loginError(result.stderr);
        else {
          try {
            const value = JSON.parse(result.stdout) as { files?: unknown; expires_at?: unknown } | null;
            if (value === null || !Array.isArray(value.files) || !value.files.every((file: unknown) => typeof file === 'string') ||
                !(value.expires_at === null || (typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)))) {
              throw new Error('invalid seat-login ingest response');
            }
            // Only the public ingest fields cross the wire; raw stdout may contain credentials.
            outcome.files = value.files as string[];
            outcome.expires_at = value.expires_at;
          } catch {
            outcome.ok = false;
            outcome.error = 'invalid seat-login ingest response';
          }
        }
        if (outcome.ok) {
          seatHealth.clearAuthFailureBefore(cli, cutoff);
          seatHealth.clearRecentBench(cli);
        }
        // A sign-out (or a newer sign-in) while this ingest ran owns the outcome now.
        if (loginGeneration.get(cli) === generation) containerLoginOutcomes.set(cli, outcome);
      }).finally(() => release(cli, generation));
      const done = (): void => {
        if (completed) return;
        completed = true;
        stop();
        void ingest();
      };
      // Subscribe before spawn: an immediate exit still needs exactly one ingest.
      const stop = adapter.onEvent((event) => {
        if (event.type !== 'terminalExited' || typeof event.id !== 'string') return;
        if (termId === null) exitedEarly.add(event.id);
        else if (event.id === termId) done();
      });
      try {
        termId = await adapter.openTerminal(homedir(), argv, parsed.data.cols ?? 100, parsed.data.rows ?? 30, true);
      } catch (err) {
        stop();
        release(cli, generation);
        return reply.code(400).send({ error: message(err) });
      }
      if (exitedEarly.has(termId)) done();
      return reply.code(201).send({ terminalId: termId, cli, action: 'sign_in' });
    },
  );

  app.get(
    `${V}/seats/:cli/container-login`,
    { config: { manifest: { responseType: 'SeatContainerLoginOutcome', statusCodes: [200, 404] } } },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      const outcome = containerSeat(cli) ? containerLoginOutcomes.get(cli) : undefined;
      if (outcome === undefined) return reply.code(404).send({ error: `no container login outcome for seat: ${cli}` });
      return reply.send(outcome);
    },
  );

  app.post(
    `${V}/seats/:cli/container-logout`,
    { config: { manifest: { responseType: 'SeatContainerLogoutResponse', statusCodes: [200, 404, 502] } } },
    async (req, reply) => {
      const { cli } = req.params as { cli: string };
      if (!containerSeat(cli)) return reply.code(404).send({ error: `container logout unavailable for seat: ${cli}` });
      bump(cli);
      const out = await serial(cli, async () => {
        containerLoginOutcomes.delete(cli);
        return runSeatLogin('sign-out', cli, seatLoginDeps);
      });
      // Whatever the engine managed before failing, the next reading is the broker's (codex crew-r1).
      containerStatus.invalidate(cli);
      rosterWithStanding.reprobe?.(cli);
      if (out.rc !== 0) return reply.code(502).send({ error: loginError(out.stderr) });
      return reply.send({ cli, action: 'sign_out' });
    },
  );

  // Resize a live terminal's PTY.
  app.post(`${V}/terminals/:id/resize`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ResizeTerminalSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidBody(parsed.error, 'Invalid request body'));
    }
    try {
      const status = await adapter.resizeTerminal(id, parsed.data.cols, parsed.data.rows);
      return reply.send({ status });
    } catch (err) {
      // Unknown / already-closed terminal id → 404, not 500.
      return reply.code(404).send({ error: message(err) });
    }
  });

  // Close a live terminal (kill child, join reader). A second close of an
  // already-gone terminal 404s rather than 500s.
  app.post(`${V}/terminals/:id/close`, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const status = await adapter.closeTerminal(id);
      return reply.send({ status });
    } catch (err) {
      return reply.code(404).send({ error: message(err) });
    }
  });

  // ── System settings ──────────────────────────────────────────────────────────
  // The store is SHARED with the skin (crew#323): beside the engine's own keys it round-trips
  // the studio's `studio.*` preference blobs verbatim — see `CrewSystemSettings`'s index
  // signature in core/types.ts, which states that rather than leaving it to a client comment.
  // crew#494 (F-007 — FIX-IT-ALL L10-6): the System page showed a LITERAL settings path; the daemon
  // now says where its settings file actually is (`WICKED_CREW_SYSTEM_SETTINGS` honoured) as the
  // additive `path` (api-types 0.38.0 `SettingsResponse.path?`; adjudicated §4.6 — `path`, not
  // `settings_path`).
  app.get(`${V}/settings`, async () => ({ settings: await adapter.getSettings(), path: settingsFilePath() }));

  // The demo video's palette from the studio skin (operator 2026-10-14): read-only, derived from `studio.appearance`;
  // garden's demo stage and interactive's re-cuts read it as their default colours.
  app.get(`${V}/appearance/video-palette`, { config: { manifest: { responseType: 'VideoPaletteResponse', statusCodes: [200] } } },
    async () => videoPalette((await adapter.getSettings())['studio.appearance']));

  app.put(`${V}/settings`, async (req, reply) => {
    const patch = req.body as Partial<import('../core/types.js').CrewSystemSettings>;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      return reply.code(400).send({ error: 'body must be a JSON object' });
    }
    if (Object.hasOwn(patch, 'graphNodeLimit')) {
      const limit = patch.graphNodeLimit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 20 || limit > 500) {
        return reply.code(400).send({ error: 'graphNodeLimit must be an integer between 20 and 500' });
      }
    }
    // Council size + spawn stagger (operator ruling 2026-10-11, wicked-core#888).
    if (Object.hasOwn(patch, 'councilSize') && !isCouncilSize(patch.councilSize)) {
      return reply.code(400).send({ error: 'councilSize must be an integer between 1 and 9' });
    }
    if (Object.hasOwn(patch, 'councilSpawnStaggerMs') && !isCouncilStaggerMs(patch.councilSpawnStaggerMs)) {
      return reply
        .code(400)
        .send({ error: 'councilSpawnStaggerMs must be an integer between 0 and 30000' });
    }
    if (Object.hasOwn(patch, 'worker_config_root')) {
      const root = patch.worker_config_root;
      if (typeof root !== 'string' || (root !== '' && !isAbsolute(root))) {
        return reply.code(400).send({
          error: 'worker_config_root must be an absolute path, or "" for the default (~/.wicked-worker)',
        });
      }
    }
    // There is NO skills setting (skills keystone, codex round 5): the skills root is
    // `<state home>/skills`, full stop — `skills_root` is retired (a configurable root let a PUT
    // aim seeding at `~/.codex/skills`), and the v3 `skills_mirror` knob was withdrawn before it
    // (design v3.2 §1: wicked never writes into the user's CLI directories). A client still sending
    // either is an unknown key, dropped and NAMED in the audit entry like any other.
    // workerStallMinutes (crew#287): the stall watchdog's silence threshold. Bounded to a day —
    // a huge value is "off in practice", which should be a deliberate choice, not a typo.
    if (Object.hasOwn(patch, 'workerStallMinutes')) {
      const mins = patch.workerStallMinutes;
      if (typeof mins !== 'number' || !Number.isInteger(mins) || mins < 1 || mins > 1440) {
        return reply
          .code(400)
          .send({ error: 'workerStallMinutes must be an integer between 1 and 1440' });
      }
    }
    // The escalation ladder's knobs (crew#341). This trio lets the PLATFORM touch runs, so a
    // typo must be a 400, never a silently-dropped key that leaves the operator believing they
    // armed (or disarmed) automatic recovery. `workerStallEscalateMinutes: 0` is the explicit
    // OFF spelling — the shipped default is ON at 30 (perf#4), so 0 is how an operator disarms.
    if (Object.hasOwn(patch, 'workerStallEscalateMinutes')) {
      const mins = patch.workerStallEscalateMinutes;
      if (typeof mins !== 'number' || !Number.isInteger(mins) || mins < 0 || mins > 1440) {
        return reply.code(400).send({
          error: 'workerStallEscalateMinutes must be an integer between 0 (escalation off) and 1440',
        });
      }
    }
    if (Object.hasOwn(patch, 'workerStallEscalateAction')) {
      const a = patch.workerStallEscalateAction;
      if (a !== 'reassign' && a !== 'notify') {
        return reply
          .code(400)
          .send({ error: "workerStallEscalateAction must be 'reassign' or 'notify'" });
      }
    }
    if (Object.hasOwn(patch, 'workerStallMaxEscalations')) {
      const n = patch.workerStallMaxEscalations;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10) {
        return reply
          .code(400)
          .send({ error: 'workerStallMaxEscalations must be an integer between 1 and 10' });
      }
    }
    // deliverIdentityLogin (crew#549): the login the deliver phase must push as. A typo here
    // would be an identity the script can never match — every delivery would refuse — so an
    // invalid value is a 400, never a silently-dropped key. `''` clears it (back to GH_ACCOUNT).
    // A LOGIN, never a token: the same validator the deliver script's splice uses.
    if (Object.hasOwn(patch, 'deliverIdentityLogin')) {
      const login = patch.deliverIdentityLogin;
      if (typeof login !== 'string' || (login !== '' && !isGitHubLogin(login.trim()))) {
        return reply.code(400).send({
          error:
            'deliverIdentityLogin must be a GitHub login (letters, digits and single hyphens, '
            + 'up to 39 characters), or "" to fall back to the GH_ACCOUNT environment variable. '
            + 'It is a login, never a token — the credential stays in gh\'s keyring or GH_TOKEN.',
        });
      }
      if (typeof login === 'string') patch.deliverIdentityLogin = login.trim();
    }
    // deliverIdentityByRepo (crew#737): repo id → a GitHub login, each checked like
    // deliverIdentityLogin; an entry of '' removes that repo's pin. A typo is a 400 naming the repo.
    if (Object.hasOwn(patch, 'deliverIdentityByRepo')) {
      const m = patch.deliverIdentityByRepo as unknown;
      if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        return reply.code(400).send({ error: 'deliverIdentityByRepo must be an object of repo id → GitHub login' });
      }
      const kept: Record<string, string> = {};
      for (const [repo, login] of Object.entries(m as Record<string, unknown>)) {
        if (typeof login !== 'string' || (login.trim() !== '' && !isGitHubLogin(login.trim()))) {
          return reply.code(400).send({ error: `deliverIdentityByRepo.${repo} must be a GitHub login (letters, digits and single hyphens, up to 39 characters), or "" to use the daemon-wide identity` });
        }
        if (login.trim() !== '') kept[repo] = login.trim();
      }
      patch.deliverIdentityByRepo = kept;
    }
    // deliverDefault (crew#393): the repo-scoped launch delivery default. Two values only —
    // this knob decides whether completed code runs open PRs, so a typo must be a 400, never
    // a silently-dropped key that leaves the operator believing they flipped it.
    if (Object.hasOwn(patch, 'deliverDefault')) {
      const d = patch.deliverDefault;
      if (d !== 'pr' && d !== 'none') {
        return reply
          .code(400)
          .send({ error: "deliverDefault must be 'pr' or 'none'" });
      }
    }
    // qeAcceptance (api-types 0.120.0): 'required' | 'off' only. 'off' skips QE acceptance on every
    // launch that requires it (labelled with the setting), so a typo must be a 400, never a dropped key.
    // Turning it off waives an assurance instrument on every launch after it, so only a PERSON may
    // change it (the predicate the watch switches use); a worker's bearer gets 403.
    if (Object.hasOwn(patch, 'qeAcceptance')) {
      const q = patch.qeAcceptance;
      if (q !== 'required' && q !== 'off') {
        return reply.code(400).send({ error: "qeAcceptance must be 'required' or 'off'" });
      }
      if (!isHumanOperator(actorOf(req))) {
        return reply.code(403).send({ error: 'Only a person can change QE acceptance (qeAcceptance); a worker or system actor cannot' });
      }
    }
    // onboardingAutoCapture (crew#552): whether a completed onboarding chains capture-learnings.
    if (Object.hasOwn(patch, 'onboardingAutoCapture') && typeof patch.onboardingAutoCapture !== 'boolean') {
      return reply.code(400).send({ error: 'onboardingAutoCapture must be true or false' });
    }
    // baseSkillRef / baseSkillPolicy (crew#554 / wicked-core#468): the discipline skill EVERY
    // governed unit is told to follow, and what a snapshot without it means. Both decide whether
    // launches carry the directive or are refused at intake, so a typo is a 400, never a silently
    // dropped key. The name is exported to the engine verbatim: a skill-name shape only.
    if (Object.hasOwn(patch, 'baseSkillRef')) {
      const r = patch.baseSkillRef;
      if (typeof r !== 'string' || !BASE_SKILL_REF_SHAPE.test(r.trim())) {
        return reply.code(400).send({
          error: 'baseSkillRef must be a skill name (lowercase letters, digits, "-", "_", ":", ".", up to 128 chars — e.g. "wicked-garden-governed-worker"), or "" to turn the base skill off',
        });
      }
    }
    if (Object.hasOwn(patch, 'baseSkillPolicy')) {
      const p = patch.baseSkillPolicy;
      if (typeof p !== 'string' || !BASE_SKILL_POLICIES.has(p)) {
        return reply.code(400).send({
          error: "baseSkillPolicy must be 'require' — the only policy (the engine refuses launches at intake until the published snapshot holds the base skill); 'warn' was deleted in crew 0.7.35: it ran seats UNGROUNDED. Set baseSkillRef \"\" to turn the base skill off explicitly",
        });
      }
    }
    // Skin-owned keys (crew#323): allowed through, but VALIDATED rather than trusted. The
    // daemon does not read these values, so the only two things it can check are the two that
    // can hurt it — a value it cannot persist, and a value big enough to bloat settings.json.
    // Both answer 400 naming the key: silence is exactly what made #323 invisible for a whole
    // campaign of appearance work.
    const studioKeys = Object.keys(patch).filter((k) => STUDIO_SETTINGS_KEY.test(k));
    for (const key of studioKeys) {
      const value = (patch as Record<string, unknown>)[key];
      // `undefined` from a throwing/circular value AND from a value JSON.stringify simply
      // drops (a function, a symbol) — both are unpersistable, both are refused.
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(value);
      } catch {
        encoded = undefined;
      }
      if (encoded === undefined) {
        return reply.code(400).send({ error: `${key} must be a JSON-serializable value` });
      }
      const bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > STUDIO_SETTINGS_MAX_BYTES) {
        return reply.code(400).send({
          error: `${key} is ${bytes} bytes of JSON, over the ${STUDIO_SETTINGS_MAX_BYTES}-byte per-key cap on studio.* settings`,
        });
      }
    }
    // The watch registry's switches (DES-TRIGGER-REGISTRY-001 §4.2, TR-W5a): only `enabled` and
    // `threshold` of a shipped entry, and `llm`. Turning a watcher off is the one way to make the
    // platform stop telling the operator something, so only a PERSON may do it — the "human"
    // predicate decision capture uses; a worker's bearer gets 403. A bad patch is a 400 naming the
    // key (never a silent drop), and the daemon stamps who changed what and when.
    let watchNext: import('wicked-crew-api-types').WatchSettings | undefined;
    if (Object.hasOwn(patch, 'watch')) {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: 'Only a person can change what is watched (watch.* settings); a worker or system actor cannot' });
      }
      const registry = runtime.watchRegistry?.() ?? null;
      if (registry === null) {
        return reply.code(400).send({ error: 'watch: watching is not configured on this daemon' });
      }
      const problem = registry.validateSettingsPatch((patch as { watch?: unknown }).watch);
      if (problem !== null) return reply.code(400).send({ error: problem });
      watchNext = registry.mergeSettings(
        (await adapter.getSettings()).watch,
        (patch as { watch: import('wicked-crew-api-types').WatchSettings }).watch,
        actor.id,
        Date.now(),
      );
    }
    // Only known engine keys and validated `studio.*` keys are persisted. A key that is
    // NEITHER is dropped, not refused: request bodies are forward-additive too (DES-STUDIO-001
    // §5.1), so an older daemon meeting a newer client's engine key must not fail the whole
    // patch and take the caller's other keys down with it. The cost is that a typo goes
    // unnoticed on the wire — so the dropped keys are NAMED in the audit entry below.
    const allowed: (keyof import('../core/types.js').CrewSystemSettings)[] = [
      'graphNodeLimit',
      'worker_config_root',
      'workerStallMinutes',
      'workerStallEscalateMinutes',
      'workerStallEscalateAction',
      'workerStallMaxEscalations',
      'deliverDefault',
      'qeAcceptance',
      'onboardingAutoCapture',
      'deliverIdentityLogin',
      'deliverIdentityByRepo',
      'baseSkillRef',
      'baseSkillPolicy',
      'councilSize',
      'councilSpawnStaggerMs',
    ];
    const safe: Partial<import('../core/types.js').CrewSystemSettings> = {};
    for (const key of allowed) {
      // `Object.hasOwn`, NOT `key in patch` (Copilot on #324): `in` walks the prototype chain, so
      // a body whose prototype carries an engine key would be persisted from a value the caller
      // never sent. Not reachable through the default JSON parser — `JSON.parse` yields a plain
      // object and Fastify refuses `__proto__` — but this route already accepts custom
      // content-type parsers, which can produce non-plain objects. Own properties only, and the
      // same spelling the `ignored` filter below uses, so the two can never disagree about what
      // "present" means.
      if (Object.hasOwn(patch, key)) (safe as Record<string, unknown>)[key] = patch[key];
    }
    for (const key of studioKeys) {
      (safe as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
    }
    if (watchNext !== undefined) safe.watch = watchNext;
    // `Object.hasOwn`, NOT `k in safe`: `in` walks the prototype chain, so a dropped key named
    // `toString` / `valueOf` / `constructor` would test as "kept" and vanish from `ignored` —
    // the exact silent drop this route exists to end.
    const ignored = Object.keys(patch).filter((k) => !Object.hasOwn(safe, k));
    const settings = await adapter.updateSettings(safe);
    if (watchNext !== undefined) runtime.watchRegistry?.()?.applySettings(settings.watch);
    // Re-apply the worker-config root to this process's env (seat sign-in). The engine reads
    // WICKED_WORKER_HOME per worker spawn — never cached — so this alone makes the change live
    // at the next spawn: no daemon restart, no engine restart.
    applyWorkerConfigRoot(settings.worker_config_root);
    // …and the council size + stagger, read by the engine per council (wicked-core#888).
    applyCouncilSettings(settings);
    // Re-judge and re-export the BASE skill (crew#554) — the engine reads WICKED_BASE_SKILL_REF at
    // intake, per launch, so this alone makes a changed name or policy live at the next launch.
    // Only when the patch named either key: an unrelated settings write must not re-log the seam.
    if (Object.hasOwn(safe, 'baseSkillRef') || Object.hasOwn(safe, 'baseSkillPolicy')) {
      runtime.skills?.configureBaseSkill(settings);
    }
    // (No skills re-apply: the skills root is not a setting — skills/runtime.ts, codex round 5.)
    // `changed` names every persisted key, engine and `studio.*` alike; `ignored` (present only
    // when there is one) is where a dropped unknown key stops being invisible.
    audit.record('settings.updated', actorOf(req), {
      detail: {
        changed: Object.keys(safe),
        ...(ignored.length > 0 ? { ignored } : {}),
        // Which watchers were switched or re-thresholded (health reads the stamps; this is the trail).
        ...(watchNext !== undefined ? { watch: (patch as { watch: unknown }).watch } : {}),
      },
    });
    return { settings };
  });

  // ── Memory proposal queue (DES-MEM-FACETED-001 §5.0) ─────────────────────────
  // The estate proposal queue over HTTP, so a studio operator can review the learnings workers
  // propose and approve/reject them. The queue tools live ONLY on the estate MCP (JSON-RPC over
  // stdio, estate #162), reached through `proposalTool` — a spawn-per-call `wicked-estate-mcp`
  // client, NON-`--readonly` (this is the OPERATOR surface: it lists AND mutates), with
  // WICKED_MEMORY_DB pinned to the operator global store. A queue/estate failure is an UPSTREAM
  // fault (502), kept distinct from a client mistake (400: a bad `state`/`id`, or estate's own
  // -32602 invalid-params) — the FINDING-031 posture that a malformed filter is refused, never
  // silently honored as a different request.
  const estateUpstreamError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof EstateMcpError && err.code === -32602) {
      return reply.code(400).send({ error: err.message });
    }
    return reply.code(502).send({ error: message(err) });
  };

  // GET /proposals?kind_type=&state= → proposal.list → { proposals: Proposal[] }.
  app.get(
    `${V}/proposals`,
    { config: { manifest: { responseType: 'ListProposalsResponse', statusCodes: [200, 400, 502] } } },
    async (req, reply) => {
    const q = req.query as { kind_type?: string | string[]; state?: string | string[] };
    const rawOf = (v: string | string[] | undefined): string | undefined =>
      Array.isArray(v) ? v[0] : v;
    const rawKind = rawOf(q.kind_type);
    const rawState = rawOf(q.state);
    // Fail-loud: a PRESENT-but-blank param (`?state=` / `?state=%20`) is a client error, NOT a
    // silent "no filter" — else a client accidentally issues a broader query than intended.
    if (rawKind !== undefined && rawKind.trim() === '') {
      return reply.code(400).send({ error: '`kind_type` must not be empty' });
    }
    if (rawState !== undefined && !['pending', 'approved', 'rejected'].includes(rawState.trim())) {
      return reply.code(400).send({ error: '`state` must be one of pending|approved|rejected' });
    }
    const kindType = rawKind?.trim() || undefined;
    const state = rawState?.trim() || undefined;
    const args: Record<string, unknown> = {};
    if (kindType !== undefined) args.kind_type = kindType;
    if (state !== undefined) args.state = state;
    try {
      return (await estateTool('proposal.list', args)) as ListProposalsResponse;
    } catch (err) {
      return estateUpstreamError(reply, err);
    }
  });

  // POST /proposals {content, project?, source?} → proposal.submit → 201 { id } (api-types 0.54.0).
  // A skin files ONE preference into the same review queue — studio's "takes": the person picks one
  // of two candidate outputs, and the pick becomes "prefers takes like X", learned only once they
  // accept it here. The kind (`memory`), tier and `capture: "preference"` marker are the daemon's; a
  // caller cannot file a policy through this door (the schema is strict). `project` becomes the
  // `project` facet, so the preference is recalled on that project only.
  app.post(
    `${V}/proposals`,
    {
      config: {
        manifest: { requestType: 'FileProposalBody', responseType: 'FileProposalResponse', statusCodes: [201, 400, 502] },
      },
    },
    async (req, reply) => {
      const parsed = FileProposalSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid proposal body'));
      }
      const { content, project, source } = parsed.data;
      const payload: Record<string, unknown> = { content, tier: 'semantic', capture: 'preference' };
      if (source !== undefined) payload.source = source;
      let submitted: { id?: unknown };
      try {
        submitted = (await estateTool('proposal.submit', {
          kind_type: 'memory',
          payload,
          facets: project !== undefined ? { project } : {},
        })) as { id?: unknown };
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
      if (typeof submitted?.id !== 'string' || submitted.id === '') {
        return reply.code(502).send({ error: 'proposal.submit returned no id' });
      }
      return reply.code(201).send({ id: submitted.id });
    },
  );

  // POST /proposals/:id/approve → proposal.approve →
  //   { outcome:'promoted', active_id }              — a MEMORY proposal, now an active memory (complete);
  //   { outcome:'handed_off', payload, landing }     — a POLICY proposal, LANDED here as a steering rule.
  //
  // The policy→steering landing (DES-MEM-FACETED-001 §5.2): estate performs NO rules-write (the
  // AW-11 invariant) — CREW is the one governed rules-write path. The route reads the pending row
  // (its `kind_type` carries the `policy:<steering_type>`), shapes a `ConformanceRule` from it,
  // upserts it via the single-writer actor, and only THEN asks estate to mark the proposal
  // approved. A landing failure is reported LOUD in-band as `landing.outcome:"failed"` (never a
  // 500, never the silent no-op crew#388 exists to end) and leaves the proposal PENDING, so it can
  // be approved again; an approve estate refuses after the rule landed retires the rule. A MEMORY
  // proposal is passed straight to estate's approve.
  app.post(
    `${V}/proposals/:id/approve`,
    {
      config: {
        manifest: {
          requestType: 'ApproveProposalBody',
          responseType: 'ApproveProposalResponse',
          // 404: an accept-with-edit naming no pending proposal; 409: one already in flight for it.
          statusCodes: [200, 400, 404, 409, 502],
        },
      },
    },
    async (req, reply) => {
    // Normalize ONCE and use the trimmed value throughout — an id like `%20pol1%20`
    // decodes to a padded, non-empty string that would otherwise ride upstream as-is
    // and into `proposal:<id>` derivations.
    const id = (req.params as { id: string }).id.trim();
    if (id === '') {
      return reply.code(400).send({ error: '`id` is required' });
    }
    // An accept WITH an edit (capture review, api-types 0.49.0): the edited copy replaces the
    // original in the same queue — see `approveEdited`. No body / `{}` is the plain approve below.
    const edit = ApproveEditSchema.safeParse(req.body ?? {});
    if (!edit.success) {
      return reply.code(400).send(invalidBody(edit.error, 'Invalid approve body'));
    }
    // A POLICY proposal accepted with a `reach` (no content) is not a copy: crew lands the rule
    // itself, so the person's reach rides into the landing below (the policy landing reads it).
    let policyReach: PolicyReach | undefined;
    // The pending read the accept-with-edit makes anyway, done once and shared with it.
    let editTool = estateTool;
    if (edit.data.content === undefined && edit.data.reach !== undefined) {
      let listed: ListProposalsResponse;
      try {
        listed = (await estateTool('proposal.list', { state: 'pending' })) as ListProposalsResponse;
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
      let reused = false;
      editTool = async (tool, args) => {
        if (!reused && tool === 'proposal.list' && args['state'] === 'pending') {
          reused = true;
          return listed;
        }
        return estateTool(tool, args);
      };
      const kind = listed.proposals.find((p) => p.id === id)?.kind_type;
      if (typeof kind === 'string' && kind.startsWith('policy:')) {
        if (edit.data.reach === 'pattern') {
          return reply.code(400).send({ error: 'a rule\'s reach is "project" (its project) or "operator" (every project)' });
        }
        policyReach = edit.data.reach;
      }
    }
    if (policyReach === undefined && (edit.data.content !== undefined || edit.data.reach !== undefined)) {
      try {
        const done = await approveEdited(editTool, id, edit.data, (runId) => projects.index.projectOf(runId));
        return reply.code(done.status).send(done.body);
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
    }
    if (editInFlight(id)) {
      return reply.code(409).send({ error: `proposal ${id} is already being accepted` });
    }
    // Read the pending row FIRST: a POLICY proposal is landed before estate marks it approved, so
    // a landing that fails leaves it pending and re-approvable (one decision from the operator's
    // view: approved WITH its rule, or still pending). The row also carries the `kind_type`
    // (`policy:<steering_type>`), facets and provenance the approve response does not echo.
    let row: ProposalRow | undefined;
    try {
      const pending = (await estateTool('proposal.list', { state: 'pending' })) as ListProposalsResponse;
      row = pending.proposals.find((p) => p.id === id) as ProposalRow | undefined;
    } catch (err) {
      return estateUpstreamError(reply, err);
    }
    // DC-S4a: a proposal THIS ledger filed for a decision lands through `remember()` — the one
    // landing path, with the human check inside it (§4.5). A payload naming an id the ledger does
    // not know is an ordinary policy proposal (no ORIGIN claim) and takes the path below.
    let decisionId = decisions?.deps.ledger.decisionForProposal(id) ?? null;
    if (decisions !== null && decisionId === null) {
      // The ledger links a proposal to its decision only once the `offered` outcome is written; a
      // proposal crew filed but has not linked yet (the publish window, or a crash in it) names a
      // decision this ledger HOLDS — it must still land through `remember()` (codex on DC-S4a).
      const named = (row?.payload as { decision?: { id?: unknown } } | undefined)?.decision?.id;
      if (typeof named === 'string' && decisions.deps.ledger.record(named) !== null) decisionId = named;
    }
    if (decisions !== null && decisionId !== null) {
      try {
        const landed = await decisions.remember(decisionId, actorOf(req), {
          how: 'needs-you',
          ...(policyReach !== undefined ? { edits: { scope: policyReach === 'operator' ? 'everywhere' : 'project' } } : {}),
        });
        const view = decisions.deps.ledger.view(decisionId);
        const landing: PolicyLandingResult = {
          outcome: 'landed',
          ruleId: landed.rule_id,
          ...(view !== null ? { steering_type: view.edits?.steering_type ?? view.derived.steering_type } : {}),
          reach: landed.project !== undefined ? 'project' : 'operator',
          ...(landed.project !== undefined ? { project: landed.project } : {}),
        };
        return {
          outcome: 'handed_off',
          payload: { rule: view?.edits?.statement ?? view?.derived.statement ?? '', severity: 'warn', capture: 'decision', decision: { id: decisionId } },
          landing,
        } satisfies ApproveProposalResponse;
      } catch (err) {
        if (err instanceof DecisionError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    }
    // Not a pending POLICY proposal (a memory, a knowledge row, or an id that is not pending, which
    // estate refuses in its own words): estate decides it — pass through verbatim.
    if (row === undefined || typeof row.kind_type !== 'string' || !row.kind_type.startsWith('policy:')) {
      let approved: ApproveProposalResponse;
      try {
        approved = (await estateTool('proposal.approve', { id })) as ApproveProposalResponse;
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
      if (approved.outcome === 'handed_off') {
        // Estate handed off a policy this route did not see pending (a row filed between the list
        // and the approve): it is approved with no rule. Say so; never a silent drop.
        const error =
          `estate approved policy proposal ${id} before crew could land its rule; land it by hand via ` +
          `POST ${V}/governance/rules`;
        audit.record('governance.steering.landing_failed', actorOf(req), { detail: { proposalId: id, error } });
        return { outcome: 'handed_off', payload: approved.payload, landing: { outcome: 'failed', error } };
      }
      return approved;
    }
    // POLICY proposal — land the rule, THEN approve it in estate.
    const policyRow = { ...row, kind_type: row.kind_type };
    const landFailed = (error: string): ApproveProposalResponse => {
      audit.record('governance.steering.landing_failed', actorOf(req), {
        detail: { proposalId: id, error },
      });
      // Nothing was approved: the proposal is still pending, so the operator can approve it again.
      return {
        outcome: 'handed_off',
        payload: policyRow.payload,
        landing: { outcome: 'failed', error: `${error} (the proposal is still pending)` },
      };
    };
    // A pre-steering engine would SILENTLY DROP `steering_type` and the other steering fields
    // (ConformanceRule has no deny_unknown_fields), persisting a rule that enforces differently than
    // authored — the same guard POST /governance/rules applies. Fail loud, persist nothing.
    if (!adapter.steeringSupported()) {
      return landFailed(
        `${new SteeringUnsupportedError('Landing an approved policy proposal').message} — the ` +
          `installed engine would silently drop the rule's steering fields; upgrade wicked-core-ts (>= 0.7.5)`,
      );
    }
    // A proposal with no `project` facet keeps the project of the run that filed it.
    const runId = policyRow.provenance?.['run_id'];
    const runProject = typeof runId === 'string' && runId !== '' ? projects.index.projectOf(runId) : undefined;
    const built = policyProposalToRule(
      id,
      policyRow.kind_type,
      policyRow.payload,
      isStringRecord(policyRow.facets) ? policyRow.facets : undefined,
      { ...(runProject !== undefined ? { runProject } : {}), ...(policyReach !== undefined ? { reach: policyReach } : {}) },
    );
    if ('error' in built) {
      return landFailed(built.error);
    }
    // THE landing (probe, upsert, read-back, audit) — shared with the decision landing (DC-S4a).
    const landing = await landPolicyRule({ adapter, audit }, built, actorOf(req), {
      via: 'proposal-approve',
      proposalId: id,
    });
    if (landing.outcome === 'failed') return landFailed(landing.error ?? 'the landing failed');
    // The rule is in the store: now mark the proposal approved. An approve estate does not confirm
    // is an upstream error and nothing is undone — estate may have committed it, and a concurrent
    // approve may share the rule. The proposal is then pending with its rule live (the same state a
    // crash here leaves): approving again re-lands the same rule id and finishes; rejecting it
    // retires the rule (see the reject route).
    let approved: ApproveProposalResponse;
    try {
      approved = (await estateTool('proposal.approve', { id })) as ApproveProposalResponse;
    } catch (err) {
      audit.record('governance.steering.landing_failed', actorOf(req), {
        detail: { proposalId: id, ruleId: built.rule.id, error: `rule landed; estate did not confirm the approval: ${message(err)}` },
      });
      return estateUpstreamError(reply, err);
    }
    return { outcome: 'handed_off', payload: approved.outcome === 'handed_off' ? approved.payload : policyRow.payload, landing };
  });

  // POST /proposals/:id/reject → proposal.reject → { ok: true }.
  app.post(
    `${V}/proposals/:id/reject`,
    // 409: an accept-with-edit of this proposal is in flight (api/capture.ts).
    { config: { manifest: { responseType: 'RejectProposalResponse', statusCodes: [200, 400, 409, 502] } } },
    async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id.trim() === '') {
      return reply.code(400).send({ error: '`id` is required' });
    }
    if (editInFlight(id.trim())) {
      return reply.code(409).send({ error: `proposal ${id.trim()} is being accepted` });
    }
    // DC-S4a B12: rejecting a decision's proposal dismisses the decision too (one object, two places).
    const rejectedDecision = decisions?.deps.ledger.decisionForProposal(id.trim()) ?? null;
    if (decisions !== null && rejectedDecision !== null) {
      try {
        await decisions.dismiss(rejectedDecision, actorOf(req), 'not-a-rule');
        return { ok: true } satisfies RejectProposalResponse;
      } catch (err) {
        if (err instanceof DecisionError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    }
    let rejected: RejectProposalResponse;
    try {
      rejected = (await estateTool('proposal.reject', { id })) as RejectProposalResponse;
    } catch (err) {
      return estateUpstreamError(reply, err);
    }
    // A policy proposal's rule lands before its approval, so a still-pending proposal may already
    // have a live rule (a crash or an unconfirmed approve in between): rejecting it withdraws it.
    const withdrawn = await withdrawLandedRule(adapter, id.trim());
    if (withdrawn !== null) return reply.code(502).send({ error: withdrawn });
    return rejected;
  });

  // ── Memory management (governed-knowledge surface, DES-MEM-FACETED-001) ───────
  // Browse + retire the EXISTING operator memory store — the studio counterpart to /proposals:
  // proposals DECIDE learnings not yet stored; these MANAGE what already is. The estate memory
  // tools live ONLY on the estate MCP (memory.list / memory.coverage / memory.erase), reached
  // through the SAME `estateTool` seam and `estateUpstreamError` ladder as /proposals — a client
  // mistake (non-integer limit, malformed facets JSON, empty retire scope_prefix, or estate's own
  // -32602 invalid-params) is a 400; an upstream estate/transport fault, or a malformed estate
  // response, is a 502.
  //
  // GRANULARITY, stated honestly (the estate contract, not a convenience wrapper):
  //   • BROWSE lists the COMPLETE in-scope set. `memory.list` (DES-MEM-FACETED-001) returns every
  //     memory under `scope_prefix` ("" / omitted = all), each carrying its facets — NOT
  //     relevance-ranked or facet-intent-filtered. This is why an operator can see faceted memories
  //     at all: `memory.recall` retrieves nothing for an empty query and EXCLUDES faceted memories
  //     under empty intent, so it can never inventory the store. `query`/`facets`/`limit` are then
  //     applied HERE as post-filters over that complete set (see below) — filtering, not retrieval.
  //   • list returns { memory_id, scope, content, tier, facets, created_at }; facets ride through to
  //     MemoryItem.facets, powering the surface's facet filter.
  //   • RETIRE comes in two widths. `POST /memory/retire { scope_prefix }` is SUBTREE-scoped:
  //     `memory.erase {scope_prefix}` hard-deletes EVERY memory whose scope equals or descends from
  //     the prefix, and refuses an empty prefix (a total-wipe guard) — the UI must show the operator
  //     the subtree. `POST /memory/retire-item { memory_id }` (studio#206) removes exactly ONE memory
  //     through `memory.erase {id}` (wicked-estate#188); an older estate refuses that call without
  //     deleting anything, and the route answers 501 naming the upgrade — never a subtree fallback.

  // GET /memory?query=&scope_prefix=&facets=<json>&limit= → memory.list + post-filter → { memories }.
  app.get(
    `${V}/memory`,
    { config: { manifest: { responseType: 'ListMemoriesResponse', statusCodes: [200, 400, 502] } } },
    async (req, reply) => {
      const q = req.query as {
        query?: string | string[];
        scope_prefix?: string | string[];
        facets?: string | string[];
        limit?: string | string[];
        since?: string | string[];
        until?: string | string[];
      };
      // `scope_prefix` is the ONLY estate-side argument to memory.list (a subtree filter; blank /
      // omitted = every memory). Forward verbatim WHEN PRESENT — a blank value is meaningful
      // (whole-subtree), so it is not dropped.
      const args: Record<string, unknown> = {};
      const scopePrefix = firstQueryValue(q.scope_prefix);
      if (scopePrefix !== undefined) args.scope_prefix = scopePrefix;
      // `facets` narrows the COMPLETE list crew-side (after the estate fetch) to memories carrying
      // every given axis:value (a management filter, NOT a recall intent). Present-but-blank is a
      // client error
      // (fail-loud, never a silent no-filter — FINDING-031); a present value must parse to a JSON
      // object of string values.
      let facetFilter: Record<string, string> | undefined;
      const rawFacets = firstQueryValue(q.facets);
      if (rawFacets !== undefined) {
        if (rawFacets.trim() === '') {
          return reply.code(400).send({ error: '`facets` must not be empty' });
        }
        let parsedFacets: unknown;
        try {
          parsedFacets = JSON.parse(rawFacets);
        } catch {
          return reply.code(400).send({ error: '`facets` must be a JSON object of axis:value strings' });
        }
        if (!isStringRecord(parsedFacets)) {
          return reply.code(400).send({ error: '`facets` must be a JSON object of axis:value strings' });
        }
        facetFilter = parsedFacets;
      }
      // `limit` caps the returned ROW count over the complete set (memory.list has no cap of its
      // own). Omitted/blank ⇒ every matching memory; a present value must be a positive integer.
      // NOTE: a management browse deliberately fetches the COMPLETE in-scope set before filtering —
      // the operator memory store is operator-scale, and the studio surface filters that set
      // client-side, so a server-side cap would hide memories from the filter. Server-side paging
      // for a store large enough to need it is a future enhancement, not this surface's contract.
      const rawLimit = firstQueryValue(q.limit);
      let limit: number | undefined;
      if (rawLimit !== undefined && rawLimit.trim() !== '') {
        const n = Number(rawLimit);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
          return reply.code(400).send({ error: '`limit` must be a positive integer' });
        }
        limit = n;
      }
      // `since`/`until` (unix SECONDS, inclusive) date-bound the complete set crew-side by each
      // memory's `created_at`. A present-but-non-integer bound is a 400 (fail-loud, never a silent
      // no-filter); a memory with no `created_at` is excluded once either bound is set (see
      // withinDateRange). Applied BEFORE the row cap, so `limit` cuts the dated set.
      const since = parseUnixSecondsParam(firstQueryValue(q.since));
      if (since === 'invalid') {
        return reply.code(400).send({ error: '`since` must be a non-negative integer (unix seconds)' });
      }
      const until = parseUnixSecondsParam(firstQueryValue(q.until));
      if (until === 'invalid') {
        return reply.code(400).send({ error: '`until` must be a non-negative integer (unix seconds)' });
      }
      // `query`, when present, is a case-insensitive CONTENT substring filter over the complete set
      // — a management search that finds faceted memories too (unlike relevance recall).
      const query = (firstQueryValue(q.query) ?? '').trim().toLowerCase();
      try {
        const raw = await estateTool('memory.list', args);
        const items =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['items'] : undefined;
        if (!Array.isArray(items)) {
          throw new EstateMcpError('memory.list returned an unexpected shape');
        }
        let memories = items.map(shapeMemoryItem);
        if (query !== '') memories = memories.filter((m) => m.content.toLowerCase().includes(query));
        if (facetFilter !== undefined) {
          const pairs = Object.entries(facetFilter);
          memories = memories.filter((m) => pairs.every(([k, v]) => m.facets[k] === v));
        }
        if (since !== undefined || until !== undefined) {
          memories = memories.filter((m) => withinDateRange(m.created_at, since, until));
        }
        if (limit !== undefined) memories = memories.slice(0, limit);
        // crew#740: the store the list came from (path, source, the isolation notice when it applies).
        const body: ListMemoriesResponse = { memories, store: memoryStoreInfo() };
        return body;
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
    },
  );

  // GET /memory/coverage?scope_prefix= → memory.coverage → { total, by_tier, by_kind }.
  app.get(
    `${V}/memory/coverage`,
    { config: { manifest: { responseType: 'MemoryCoverageResponse', statusCodes: [200, 400, 502] } } },
    async (req, reply) => {
      const q = req.query as { scope_prefix?: string | string[] };
      const scopePrefix = firstQueryValue(q.scope_prefix);
      const args: Record<string, unknown> = {};
      if (scopePrefix !== undefined) args.scope_prefix = scopePrefix;
      try {
        return shapeMemoryCoverage(await estateTool('memory.coverage', args));
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
    },
  );

  // POST /memory/retire { scope_prefix } → memory.erase → { erased }. SUBTREE-scoped (the per-item
  // delete is /memory/retire-item below); an empty scope_prefix is refused at the route (a 400
  // BEFORE any spawn) — the same total-wipe guard estate enforces with -32602.
  app.post(
    `${V}/memory/retire`,
    {
      config: {
        manifest: {
          requestType: 'RetireMemoryBody',
          responseType: 'RetireMemoryResponse',
          statusCodes: [200, 400, 502],
        },
      },
    },
    async (req, reply) => {
      const parsed = RetireMemorySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid retire request'));
      }
      const scopePrefix = parsed.data.scope_prefix.trim();
      if (scopePrefix === '') {
        return reply.code(400).send({
          error:
            '`scope_prefix` must not be empty — this retire is subtree-scoped and refuses a total wipe (one memory: POST /memory/retire-item)',
        });
      }
      try {
        const raw = await estateTool('memory.erase', { scope_prefix: scopePrefix });
        const deleted =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['deleted_count'] : undefined;
        if (typeof deleted !== 'number') {
          throw new EstateMcpError('memory.erase returned an unexpected shape');
        }
        const body: RetireMemoryResponse = { erased: deleted };
        return body;
      } catch (err) {
        return estateUpstreamError(reply, err);
      }
    },
  );

  // POST /memory/retire-item { memory_id } → memory.erase { id } → { erased: 1 } (studio#206). Removes
  // exactly ONE memory: the id is the only target sent, so no reading of it can widen to a subtree.
  // 404 when estate holds no memory with that id (it erased 0). 501 when the estate predates
  // wicked-estate#188: it refuses an id-only erase for want of `scope_prefix`, deleting nothing.
  app.post(
    `${V}/memory/retire-item`,
    {
      config: {
        manifest: {
          requestType: 'RetireMemoryItemBody',
          responseType: 'RetireMemoryResponse',
          statusCodes: [200, 400, 404, 501, 502],
        },
      },
    },
    async (req, reply) => {
      const parsed = RetireMemoryItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid retire request'));
      }
      const memoryId = parsed.data.memory_id.trim();
      if (memoryId === '') return reply.code(400).send({ error: '`memory_id` must not be empty' });
      try {
        const raw = await estateTool('memory.erase', { id: memoryId });
        const deleted =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['deleted_count'] : undefined;
        if (typeof deleted !== 'number') {
          throw new EstateMcpError('memory.erase returned an unexpected shape');
        }
        if (deleted === 0) return reply.code(404).send({ error: `no memory ${memoryId}` });
        if (deleted !== 1) {
          // An id names one memory; any other count is estate misbehaving, and it is reported as such.
          return reply.code(502).send({ error: `memory.erase {id} removed ${deleted} memories, expected 1` });
        }
        const body: RetireMemoryResponse = { erased: 1 };
        return body;
      } catch (err) {
        if (err instanceof EstateMcpError && err.code === -32602 && ESTATE_NO_ERASE_BY_ID.test(err.message)) {
          return reply.code(501).send({
            error:
              'this wicked-estate cannot erase one memory by id (it needs wicked-estate#188); upgrade wicked-estate-mcp — nothing was deleted',
            code: 'estate_upgrade_required',
          });
        }
        return estateUpstreamError(reply, err);
      }
    },
  );

  // POST /memory/edit { memory_id, content } → memory.list (find it) → memory.capture (the new words,
  // the old tier/scope/facets) → memory.erase { id: old } → { memory_id: new, retired: old }.
  // estate has no in-place update and no transaction across tools, so an edit is a replacement made in
  // steps. Erase-by-id is probed BEFORE anything is written (an id no memory has, so nothing is deleted):
  // an estate without it answers 501 with nothing changed. After a write, any step that does not answer
  // as expected is reconciled by re-reading the store, never assumed: a replacement that landed is a
  // 200; a new copy beside a surviving old memory is taken back out (and checked); whatever remains is
  // named in the 502.
  app.post(
    `${V}/memory/edit`,
    {
      config: {
        manifest: {
          requestType: 'EditMemoryBody',
          responseType: 'EditMemoryResponse',
          statusCodes: [200, 400, 404, 409, 501, 502],
        },
      },
    },
    async (req, reply) => {
      const parsed = EditMemorySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidBody(parsed.error, 'Invalid edit request'));
      }
      const memoryId = parsed.data.memory_id.trim();
      const content = parsed.data.content.trim();
      if (memoryId === '') return reply.code(400).send({ error: '`memory_id` must not be empty' });
      if (content === '') return reply.code(400).send({ error: '`content` must not be empty' });
      if (memoryEditsInFlight.has(memoryId)) {
        return reply.code(409).send({ error: `memory ${memoryId} is already being edited` });
      }
      memoryEditsInFlight.add(memoryId);
      // Every estate call here is crew's own (no client argument reaches estate unchecked), so an
      // estate refusal is an upstream fault: 502, never the 400 `estateUpstreamError` gives -32602.
      const upstream = (what: string, err: unknown): FastifyReply => reply.code(502).send({ error: `${what}: ${message(err)}` });
      const listAll = async (): Promise<MemoryItem[]> => {
        const raw = await estateTool('memory.list', {});
        const items = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['items'] : undefined;
        if (!Array.isArray(items)) throw new EstateMcpError('memory.list returned an unexpected shape');
        return items.map(shapeMemoryItem);
      };
      const deletedCount = (raw: unknown): unknown =>
        (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['deleted_count'] : undefined);
      try {
        // 1. The memory as it is: its tier, scope and facets ride onto the replacement.
        let before: MemoryItem[];
        try {
          before = await listAll();
        } catch (err) {
          return upstream('reading the memory store failed; nothing changed', err);
        }
        const old = before.find((m) => m.id === memoryId);
        if (old === undefined) return reply.code(404).send({ error: `no memory ${memoryId}` });
        if (old.content.trim() === content) {
          return reply.code(400).send({ error: 'the new words are the same as the memory\'s; nothing to change' });
        }
        // 2. Erase-by-id must exist before anything is written (wicked-estate#188). The probe names an
        //    id no memory carries, so it deletes nothing.
        try {
          await estateTool('memory.erase', { id: MEMORY_EDIT_PROBE_ID });
        } catch (err) {
          if (err instanceof EstateMcpError && err.code === -32602 && ESTATE_NO_ERASE_BY_ID.test(err.message)) {
            return reply.code(501).send({
              error: 'this wicked-estate cannot erase one memory by id (it needs wicked-estate#188), so it cannot replace one; nothing changed',
              code: 'estate_upgrade_required',
            });
          }
          return upstream('checking that the store can erase one memory failed; nothing changed', err);
        }
        // 3. The new words, as a new memory in the old one's place.
        const captureArgs: Record<string, unknown> = { content, scope: old.scope, facets: old.facets };
        if (old.tier !== '') {
          captureArgs['tier'] = old.tier;
          const kind = KIND_FOR_TIER[old.tier];
          if (kind !== undefined) captureArgs['kind'] = kind;
        }
        const beforeIds = new Set(before.map((m) => m.id));
        let newId: string | null = null;
        let captureErr: unknown = null;
        try {
          const captured = await estateTool('memory.capture', captureArgs);
          const id = typeof captured === 'object' && captured !== null ? (captured as Record<string, unknown>)['memory_id'] : undefined;
          if (typeof id === 'string' && id !== '') newId = id;
          else captureErr = new EstateMcpError('memory.capture returned no memory_id');
        } catch (err) {
          captureErr = err;
        }
        if (newId === null) {
          // The capture may still have written (a lost answer): look before saying nothing changed.
          let now: MemoryItem[];
          try {
            now = await listAll();
          } catch (err) {
            return reply.code(502).send({
              error: `writing the new words did not answer as expected (${message(captureErr)}) and the store could not be re-read (${message(err)}); a copy of the new words may exist beside ${memoryId}`,
            });
          }
          const copies = now.filter((m) => !beforeIds.has(m.id) && m.content.trim() === content && m.scope === old.scope);
          if (copies.length !== 1) {
            return reply.code(502).send({
              error: copies.length === 0
                ? `writing the new words failed (${message(captureErr)}); nothing changed`
                : `writing the new words did not answer as expected (${message(captureErr)}); ${copies.length} copies of them now exist beside ${memoryId}: ${copies.map((m) => m.id).join(', ')}`,
            });
          }
          newId = copies[0]!.id;
        }
        // 4. The old memory out.
        let eraseErr: unknown = null;
        let deleted: unknown;
        try {
          deleted = deletedCount(await estateTool('memory.erase', { id: memoryId }));
        } catch (err) {
          eraseErr = err;
        }
        if (eraseErr === null && deleted === 1) {
          const body: EditMemoryResponse = { memory_id: newId, retired: memoryId };
          return body;
        }
        const why = eraseErr !== null ? `retiring ${memoryId} failed (${message(eraseErr)})` : `retiring ${memoryId} removed ${String(deleted)} memories, expected 1`;
        // 5. Reconcile: what is in the store now decides the answer, never the failed call.
        const present = async (): Promise<Set<string>> => new Set((await listAll()).map((m) => m.id));
        let ids: Set<string>;
        try {
          ids = await present();
        } catch (err) {
          return reply.code(502).send({ error: `${why}, and the store could not be re-read (${message(err)}); ${newId} was written and ${memoryId} may remain` });
        }
        if (!ids.has(memoryId) && ids.has(newId)) {
          // The retire landed even though its answer did not: the edit is complete.
          const body: EditMemoryResponse = { memory_id: newId, retired: memoryId };
          return body;
        }
        if (!ids.has(newId)) {
          return reply.code(502).send({ error: ids.has(memoryId) ? `${why}; nothing changed` : `${why}; neither ${memoryId} nor ${newId} is in the store now` });
        }
        // Both are there: take the new copy back out, then check that it is gone.
        try {
          await estateTool('memory.erase', { id: newId });
        } catch {
          // Checked below: the store, not the call, says whether it is gone.
        }
        try {
          ids = await present();
        } catch (err) {
          return reply.code(502).send({ error: `${why}; taking ${newId} back out could not be checked (${message(err)}), so both ${memoryId} and ${newId} may remain` });
        }
        return reply.code(502).send({
          error: ids.has(newId) ? `${why}; taking ${newId} back out failed, so both ${memoryId} and ${newId} remain` : `${why}; the new copy was taken back out, so nothing changed`,
        });
      } catch (err) {
        return upstream('editing the memory failed', err);
      } finally {
        memoryEditsInFlight.delete(memoryId);
      }
    },
  );

  // ── Projects (DES-PROJECT-001) — the 9-route experience-plane surface ────────
  registerProjectRoutes(app, adapter, { ...projects, settings: projectSettings }, security);
  // crew#371: a project's requirements / domain / coverage, folded over its repos' own reads.
  registerProjectAggregateRoutes(app, adapter);
  // crew#372: draft a product plan from selected requirements, as a governed run via POST /runs.
  registerProductRoutes(app, adapter);

  // ── Capture (Studio OS behaviour 8) — notes and photos → a project-filed run whose output is
  // proposals in the queue above; the launch is POST /runs itself (api/capture.ts).
  registerCaptureRoutes(app);
  // The Demo experience (studio#373): the demo preset's launch, view, files and script edit.
  registerDemoRoutes(app, adapter);
  // WT-W3: the storyline PUT checks the open gate through the same resolution the gate routes use.
  registerWalkthroughRoutes(app, adapter, { resolveOpenGate, audit });

  // ── Presets (DES-TEAMING-002 §8.4, seam C2) — saved phase selections in the engine's store;
  // a launch names one via `workflow`, and the ENGINE resolves it.
  registerPresetRoutes(app, adapter, security);

  // ── Team (DES-TEAMING-002 T8) — reads and commands over the engine; the live stream is the
  // teamEvent relay (team/ws-relay.ts). Crew publishes no team fact (§4.0).
  registerTeamRoutes(app, adapter, security, {
    exclusive: decideExclusively,
    judge: gateForDecision,
    // crew#1157: a plan edit on an analysis run may not add a step that could write.
    readOnlyRefusal: (runId, plan) => analysisPlanRefusal(runId, { plan }),
  });

  // ── Campaigns (crew#342 + TH-9) — the engine's durable Run-DAG scheduler over REST ──────────
  // Progress streams as campaign* CoreEvents on the existing allowlist-free /ws relay; these
  // routes are launch/resume/cancel + the reads a scoreboard builds from. The GET routes join
  // per-member delivery (wicked-studio#27) with the SAME machinery the run DTOs use — one
  // sessionsDetail() per request, the shared TTL-memoized vacuity probes, never a per-node fetch.
  registerCampaignRoutes(app, adapter, {
    audit,
    actorOf,
    // The roster WITH crew's standing (F-086 — parity with POST /runs and POST /testing/*): the
    // adapter turns `council_eligible` into the engine's per-seat bench at launch, per campaign
    // node (`core/engine-roster.ts` `engineCampaignDef`), so a signed-out seat is never convened
    // by a campaign node either.
    roster: () => rosterWithStanding(),
    groupIndex,
    // Wave 6 (F-7R2-014): the registered test sets ride beside the campaigns + groups.
    testSets,
    deliveryUrlFor: (runId) => deliveryIndex.urlFor(runId),
    deliveryPushedFor: (runId) => deliveryIndex.pushedFor(runId),
    vacuity: vacuityProbes,
    // A non-probe derivation throw in the rollup is a defect — error level, loud in diagnostics.
    logDefect: (m) => app.log.error(m),
    // crew#481: the SAME def-awareness the run DTOs apply — one predicate, every surface.
    canDeliver,
  });

  // ── Governance wiki management (wiki-mgmt) — scoreboard + honest empty-state meta ──────────
  // Browse (`GET /governance/rules` + facets) and retire (`DELETE /governance/rules/:id`) stay
  // ABOVE with the other governance routes; this registers only the wiki-specific reads.
  // Both wiki reads feed the Steering page header too — they stay, unchanged (STEERING).
  registerGovernanceWikiRoutes(app, adapter);

  // ── Steering management (STEERING program) — batch import + "add with chat" authoring ──────
  // Per-rule CRUD stays ABOVE with the other governance routes (a steering rule IS a
  // conformance rule); this registers only the import batch and the governed authoring launch.
  registerGovernanceSteeringRoutes(app, adapter, {
    audit,
    actorOf,
    // Standing too (F-086 parity): the steering-author run launches through `launchRun`, whose
    // roster translation (`engineRosterJson`) already benches `council_eligible: false` seats.
    roster: () => rosterWithStanding(),
    // So the steering-author run's `run.launched` entry stamps `created_at` live too (Copilot #466).
    runTimingIndex,
  });

  // ── Testing (crew-testing) — governance evals + eval corpora + the recon trigger ────────────
  // Run the evals (does the steering corpus catch what it claims to?) and import a named eval
  // corpus — both presence-gated on the engine's evals bindings (501 on wicked-core-ts < 0.7.5).
  // POST /testing/recon launches governed recon runs (the multiscope fan-out), so it gets the
  // roster and the SAME membership plumbing POST /runs files projectId launches through.
  registerTestingRoutes(app, adapter, {
    audit,
    actorOf,
    // The roster WITH crew's standing (wave 6): the adapter turns `council_eligible` into the
    // engine's per-seat bench at launch, and the author response's `plan.seats` reads it.
    roster: () => rosterWithStanding(),
    projects: { bus: projects.bus, index: projects.index },
    // The author launch files each run under its repo's `qe-tests-<repo>` label (F-7R2-014).
    groupIndex,
    // So the recon fan's `run.launched` entries stamp `created_at` live too (Copilot #466), not
    // just after a restart re-hydrates the trail.
    runTimingIndex,
    // The eval history store: `createServer` supplies a real one (state-home-rooted); a
    // directly-driven route set records nothing unless it injects one (no `~/.wicked-crew` writes).
    ...(runtime.evalStore !== undefined ? { evalStore: runtime.evalStore } : {}),
  });

  // ── Default evals (DES-DEFAULT-EVALS-001) — the system's own judgments, scored against what happened ─────
  // Read-only over the run store (sessions, events, the operator's decisions, QE ledgers, the latest steering
  // eval); the only write is the report, under the eval store's root.
  const defaultEvalDeps: DefaultEvalDeps = {
    ...(runtime.defaultEvalStore !== undefined ? { store: runtime.defaultEvalStore } : {}),
    // Served runs, as GET /runs serves them: the derived title and the project membership join (codex r1).
    runs: async () => (await adapter.sessionsDetail()).map(decorateRun) as unknown as RunLike[],
    events: async (id) => (typeof adapter.runEvents === 'function' ? ((await adapter.runEvents(id)) as unknown as EventLike[] | null) : null),
    decisions: () => (runtime.decisionLedger?.list({}) ?? []) as unknown as DecisionLike[],
    ...(runtime.evalStore !== undefined ? { steeringEvals: runtime.evalStore } : {}),
    replay: defaultReplaySet({ gardenRoot: gardenRootFor(process.env) }),
  };
  registerDefaultEvalRoutes(app, defaultEvalDeps);

  // ── Skills (skills keystone) — the file manager over the daemon-owned garden plugin root ─────
  // Manifest + typed reads, guarded CAS writes, refresh/publish/analyze. `createServer` injects the
  // runtime it booted (store seeded from the installed plugin, snapshot published); a
  // directly-driven route set answers 503 unless a test injects one over a fixture root.
  registerSkillsRoutes(app, {
    ...(runtime.skills !== undefined ? { runtime: runtime.skills } : {}),
    audit,
    actorOf,
  });

  // ── MCP tools registry (DES-MCP-TOOLS-001 S2) — upstream servers, their tools, their secrets ─
  // Preview-bound saves, the tool diff on test, and a secret route that never answers the value.
  // S6: the policy preview and the approvals, over the same registry and the engine's rule store.
  const mcpPolicies =
    runtime.mcp !== undefined
      ? new McpPolicies(runtime.mcp, {
          listRules: () => adapter.listConformanceRules(),
          upsertRule: (rule) => adapter.upsertConformanceRule(rule),
          previewCalls: (json) => adapter.previewMcpCalls(json),
        })
      : undefined;
  // The MCP inspector bridge (DES-MCP-INSPECTOR-001): live sessions to MCP servers for studio's
  // `mcp-server` editor host; registry servers resolve through the same registry and secrets.
  registerMcpInspectRoutes(app, {
    ...(runtime.mcp !== undefined ? { registry: runtime.mcp } : {}),
    log: (m) => app.log.info(m),
  });
  registerMcpRoutes(app, {
    ...(runtime.askServer !== undefined ? { askServer: runtime.askServer } : {}),
    ...(runtime.mcp !== undefined ? { registry: runtime.mcp, toolLister: () => CoreAdapter.mcpToolLister() } : {}),
    ...(runtime.mcpBroker !== undefined ? { broker: runtime.mcpBroker } : {}),
    ...(mcpPolicies !== undefined ? { policies: mcpPolicies } : {}),
    ...(runtime.mcpCalls !== undefined ? { usage: runtime.mcpCalls } : {}),
    audit,
    actorOf,
  });

  // ── The wicked-interactive bridge, reverse-proxied (DES-MERGE-001 §5.3/§7.2) ──
  // Mounted BESIDE the routes above and under the same `${V}` prefix, so it inherits one
  // origin, one auth hook, and one CORS posture — the whole point of slice 1.
  // ONE pool, shared with the governed doc-delete route below: two pools over one root would
  // race each other into starting duplicate bridges.
  const interactiveBridges =
    runtime.interactiveBridges ??
    new InteractiveBridgePool({
      log: (m) => app.log.warn(m),
      debug: (m) => app.log.debug(m),
      // #298: the daemon's own origin, read LAZILY off the bound server — the pool is built
      // before `listen`, but only consulted while serving a request, i.e. once bound. The
      // pool POSTs it to the bridge's /api/studio-origin on start/adopt so the bridge's
      // `GET /` redirects into studio.
      studioOrigin: () => boundOrigin(app.server.address()),
      // F-043: the bridge emits where this daemon's interactive seams read — one bus per daemon.
      busDataDir: runtime.interactiveBridgeBusDataDir ?? null,
    });
  // ── GET /system — the Nerve Center snapshot (DES-SYSTEM-VIEW, api-types 0.136.0) ──
  // One derived, READ-ONLY answer: the CLIs with their 7-day record, every unfinished run with a
  // COMPUTED liveness, the infrastructure as real bounded probes, the governance instruments and
  // `attention[]`. Every probe runs per request (no cached "ok"); only the 7-day fold over the run
  // store is kept for SYSTEM_STATS_TTL_MS, with its `asOf`. The whole answer is held to
  // SYSTEM_BUDGET_MS: a part that does not settle in time reads `unknown` (or `null`) with why.
  const weekFoldCache = new WeekFoldCache();
  const runCosts = new RunCostCache();
  let toReviewCache: { at: number; value: number | null } | null = null;
  /** One stat of a run's durable event log: read before the 7-day fold, so the fold can never eat
   *  the time a liveness verdict needs. */
  const EVIDENCE_TIMEOUT_MS = 1_000;
  const systemExec: SystemExecLike =
    runtime.systemExec ?? ((file, args, opts) => execCapped(file, args, { timeout: opts.timeout }));
  app.get(
    `${V}/system`,
    { config: { manifest: { responseType: 'SystemSnapshot', statusCodes: [200] } } },
    async () => {
      const startedAt = Date.now();
      const deadline = startedAt + SYSTEM_BUDGET_MS - 500;
      const left = (): number => Math.max(0, deadline - Date.now());
      const dbPath = typeof adapter.dbPath === 'string' && adapter.dbPath !== '' && adapter.dbPath !== ':memory:' ? adapter.dbPath : null;
      const stateHome = dbPath !== null ? stateHomeOfDb(dbPath) : null;
      const containerFloor = isContainerSeatFloor();
      const roster = (() => {
        try {
          return markOptIn(rosterWithStanding()) as unknown as RosterSeatLike[];
        } catch {
          return [] as RosterSeatLike[];
        }
      })();

      // Reads the folds and the run list depend on, each bounded.
      const viewsP = settleWithin(async () => {
        const detail = await adapter.sessionsDetail();
        await backfillEndedAt(detail);
        return detail.map(decorateRun);
      }, PROBE_TIMEOUT_MS);
      const settingsP = settleWithin(() => Promise.resolve(adapter.getSettings()), PROBE_TIMEOUT_MS);
      const gatesP = settleWithin(
        async () => (typeof adapter.interactionRequests === 'function' ? await adapter.interactionRequests(undefined, 'open') : null),
        PROBE_TIMEOUT_MS,
      );
      const diagP = settleWithin(() => diagnosticsNow(), PROBE_TIMEOUT_MS);
      const pingP = settleWithin(() => enginePing(), PROBE_TIMEOUT_MS);
      const rulesP = settleWithin(async () => {
        if (typeof adapter.listConformanceRules !== 'function') return null;
        const rules = await adapter.listConformanceRules();
        return rules.filter((r) => (r as { retired?: unknown }).retired !== true).length;
      }, PROBE_TIMEOUT_MS);
      // Pending proposals: "N to review", never in the needs-you number (no run waits on them).
      // Kept for SYSTEM_STATS_TTL_MS: a skin polls /system, and each read would spawn the estate client.
      const toReviewP = settleWithin(async () => {
        if (toReviewCache !== null && Date.now() - toReviewCache.at < SYSTEM_STATS_TTL_MS) return toReviewCache.value;
        const got = (await estateTool('proposal.list', { state: 'pending' })) as { proposals?: unknown[] } | null;
        const value = Array.isArray(got?.proposals) ? got.proposals.length : null;
        if (value !== null) toReviewCache = { at: Date.now(), value }; // a failed read is never kept
        return value;
      }, PROBE_TIMEOUT_MS);
      const gatesByYouP = settleWithin(async () => {
        const since = Date.now() - SYSTEM_STATS_DAYS * 86_400_000;
        const entries = await audit.readAll({ action: 'gate.decided', since });
        return entries.filter((e) => e.actor?.kind === 'human').length;
      }, PROBE_TIMEOUT_MS);

      // The infra probes, all at once.
      const gatewayDir = stateHome !== null ? gatewayDirOf(join(stateHome, 'gateway')) : null;
      const interactiveRoots = [...new Set([defaultInteractiveRoot(stateHome ?? undefined), ...interactiveBridges.keys()])];
      const watch = runtime.watchRegistry?.() ?? null;
      const watchHealth = watch !== null ? (() => { try { return watch.health(); } catch { return null; } })() : null;
      const infraP = Promise.all([
        probeGateway({ containerFloor, gatewayDir, runtime: containerFloor ? resolveContainerRuntime() : null, exec: systemExec }),
        probeBroker({
          containerFloor,
          clis: roster.map((r) => r.key).filter((k) => isContainerLoginCli(k)),
          status: (cli) => containerStatus.refreshFresh(cli),
        }),
        probeInteractive({
          roots: interactiveRoots,
          readLock: (root) => readBridgeLockAsync(root),
          health: async (url, timeoutMs) => (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).status,
        }),
        probeEstate({ memoryStore: memoryStoreInfo(), call: estateReadonlyCall(memoryStoreInfo().path) }),
        probeBus({
          unavailable: (adapter.busUnavailable as { reason?: unknown } | undefined) ?? null,
          seamsOff: adapter.busSeamsOff ?? null,
          dbPath: typeof adapter.busDbPath === 'string' && adapter.busDbPath !== '' ? adapter.busDbPath : null,
          watchBus: (watchHealth?.sources.bus as 'up' | 'down' | 'degraded' | undefined) ?? null,
          tailLagMs: watchHealth?.tail_lag_ms ?? null,
        }),
        probeVault({ vault: adapter.vaultBin != null ? vaultDiagnostics(adapter.vaultBin) : null, exec: systemExec }),
        diskRow(stateHome),
      ]);

      const [views, settings, openGates, diag, ping, rules, gatesByYou, infraProbed] = await Promise.all([
        viewsP, settingsP, gatesP, diagP, pingP, rulesP, gatesByYouP, infraP,
      ]);
      // The broker probe refreshed each container seat's sign-in reading: the CLI cards read the
      // roster AFTER it, so one snapshot never says "broker: signed in" beside "claude: signed out".
      const rosterNow = (() => {
        try {
          return markOptIn(rosterWithStanding()) as unknown as RosterSeatLike[];
        } catch {
          return roster;
        }
      })();
      const allViews = views.kind === 'ok' ? views.value : [];

      // runs[] with computed liveness.
      const { quietAfterMs, stallAfterMs } = livenessThresholds(
        settings.kind === 'ok' ? (settings.value as { workerStallMinutes?: number } | null)?.workerStallMinutes : undefined,
      );
      const openByRun = new Map<string, OpenGateLike>();
      if (openGates.kind === 'ok' && openGates.value !== null) {
        const at = (r: { created_at?: unknown }): number => new Date(r.created_at as string | number).getTime() || 0;
        for (const r of [...openGates.value].sort((a, b) => at(a) - at(b))) {
          const arrived = at(r);
          openByRun.set(r.session_id, {
            interactionId: r.id,
            ord: r.ord,
            kind: r.gate_kind ?? (r.kind === 'elicitation' ? 'question' : null),
            prompt: r.prompt.slice(0, 280),
            receivedAt: arrived > 0 ? new Date(arrived).toISOString() : (gateCache.get(r.session_id)?.receivedAt ?? null),
          });
        }
      }
      const now = Date.now();
      const live = unfinished(allViews);
      const evidenceOf = async (id: string): Promise<RunEvidence | null> => {
        let best: RunEvidence | null = null;
        const relay = runtime.runEvidence?.(id);
        if (relay !== undefined) best = { at: relay.at, source: relay.source };
        if (dbPath !== null) {
          const st = await settleWithin(() => fsp.stat(join(eventsDirOf(dbPath), `${id}.ndjson`)), EVIDENCE_TIMEOUT_MS);
          if (st.kind === 'ok' && (best === null || st.value.mtimeMs > best.at)) best = { at: Math.floor(st.value.mtimeMs), source: 'event_log' };
        }
        return best;
      };
      const runPairs = await Promise.all(
        live.map(async (view) => {
          const cached = gateCache.get(view.session.id);
          const gate =
            openByRun.get(view.session.id) ??
            (view.session.status === 'awaiting_human' && cached !== undefined
              ? { interactionId: null, ord: cached.ord, kind: (cached as { gateKind?: string }).gateKind ?? null, prompt: cached.prompt.slice(0, 280), receivedAt: cached.receivedAt }
              : null);
          const run = runLiveness({ view, now, evidence: await evidenceOf(view.session.id), gate: view.session.status === 'awaiting_human' ? gate : null, quietAfterMs, stallAfterMs });
          return { view, run };
        }),
      );
      // The 7-day fold: cached briefly, never waited on past the budget.
      const readEvents = async (id: string): Promise<readonly RecordedEvent[] | null> => {
        const engine = await adapter.runEvents(id);
        if (engine === null) return null;
        const daemon = runtime.stallFrames?.(id) ?? [];
        return daemon.length === 0 ? engine : [...engine, ...(daemon as unknown as RecordedEvent[])];
      };
      const week =
        views.kind === 'ok' && typeof adapter.runEvents === 'function'
          ? await settleWithin(() => weekFoldCache.get(() => readWeek(allViews, readEvents, { days: SYSTEM_STATS_DAYS, now: Date.now() })), left())
          : null;
      const weekFold = week?.kind === 'ok' ? week.value : null;
      const weekNote =
        views.kind !== 'ok'
          ? `the engine did not list its runs within ${PROBE_TIMEOUT_MS / 1000} s`
          : week === null
            ? 'the run store has no event-log read binding on this engine'
            : week.kind === 'timeout'
              ? 'the 7-day fold did not finish inside this snapshot’s bound; it keeps going and the next read has it'
              : week.kind === 'error'
                ? `the 7-day fold failed: ${week.error}`
                : weekFold === null
                  ? 'the run store has no event-log read binding on this engine'
                  : undefined;

      // Diagnostics blocks, for the rows that carry them.
      const d = diag.kind === 'ok' ? diag.value : null;
      const seatGov = d?.seatGovernance.seats ?? [];
      const clis = buildClis({
        roster: rosterNow,
        acp: (d?.acp.byCli ?? {}) as Record<string, AcpCliDiagnostics>,
        seatGovernance: seatGov as unknown as DiagnosticsSeatGovernanceEntry[],
        containerFloor,
        hostBoundary: d?.seatGovernance.hostBoundary ?? hostSandboxLauncher(),
        week: weekFold,
        ...(weekNote !== undefined ? { weekNote } : {}),
      });

      const runs = sortRuns(runPairs.map((p) => p.run));
      const gaps = judgeGaps(runPairs, clis);

      // infra[]: the daemon row first (it answers this request; the engine's ping says if it is free).
      const daemonStarted = Date.now() - Math.max(views.ms, ping.ms);
      const pingWord = ping.kind === 'ok' ? ping.value : ping.kind === 'timeout' ? 'no answer' : `error: ${ping.error}`;
      const daemonDetails: Record<string, unknown> = {
        version: PKG_VERSION,
        ping: pingWord,
        warnings: healthWarningsOf(runtime.stateHome !== undefined ? (d?.stateHome ?? null) : null, runtime.skills?.reportedBaseSkill() ?? null),
        ...(d !== null ? { components: d.components, daemon: d.daemon, recentErrors: d.recentErrors } : {}),
      };
      const daemonRow =
        views.kind !== 'ok'
          ? infraRow('daemon', 'degraded', `serving, but the engine did not list its runs (${views.kind === 'timeout' ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : views.error}): runs[] and the CLI stats are incomplete`, 'Re-check; if the engine stays busy, a large launch may be planning.', daemonStarted, daemonDetails, PROBE_TIMEOUT_MS)
          : ping.kind === 'ok' && ping.value === ENGINE_BUSY_PING
            ? infraRow('daemon', 'degraded', 'serving; the engine is busy (its ping did not answer within 1 s)', 'Re-check in a minute; a large launch may be planning.', daemonStarted, daemonDetails)
            : ping.kind !== 'ok'
              ? infraRow('daemon', 'unknown', `serving; the engine ping gave ${pingWord}`, 'Re-check.', daemonStarted, daemonDetails, PROBE_TIMEOUT_MS)
              : infraRow('daemon', 'ok', `serving crew ${PKG_VERSION}; engine ping ${ping.value}`, null, daemonStarted, daemonDetails);
      const storesRow =
        d === null
          ? infraRow('stores', 'unknown', `diagnostics did not answer within ${PROBE_TIMEOUT_MS / 1000} s`, 'Re-check.', startedAt, {}, PROBE_TIMEOUT_MS)
          : dbPath === null
            ? infraRow('stores', 'unknown', 'this route set has no core store', null, startedAt, { stores: d.stores })
            : infraRow('stores', 'ok', `${d.stores.length} store file(s), ${Math.round(d.stores.reduce((a, s) => a + s.bytes, 0) / 2 ** 20)} MiB`, null, startedAt, { stores: d.stores });
      const floorWord = containerFloor ? 'container' : isHostSeatFloor() ? 'host' : 'unset';
      const roleFindings = d?.seatGovernance.roleFindings ?? [];
      const seatFloorRow = d === null
        ? infraRow('seat_floor', 'unknown', `diagnostics did not answer (${diag.kind === 'timeout' ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : diag.kind === 'error' ? diag.error : ''})`, 'Re-check.', startedAt, { floor: floorWord }, PROBE_TIMEOUT_MS)
        : infraRow(
        'seat_floor',
        floorWord === 'host' && (d?.seatGovernance.hostBoundary ?? null) === null ? 'degraded' : roleFindings.length > 0 ? 'degraded' : 'ok',
        floorWord === 'container'
          ? 'container floor: governed seats run in hardened containers'
          : floorWord === 'host'
            ? (d?.seatGovernance.hostBoundary ?? null) === null
              ? 'interim host floor, and no OS launcher (sandbox-exec / bwrap) on PATH: floor seats run advisory'
              : `interim host floor, bounded by ${d?.seatGovernance.hostBoundary}`
            : 'no seat floor chosen',
        roleFindings.length > 0 ? (roleFindings[0]?.message ?? 'see the role findings') : 'Install the OS launcher, or run the container floor.',
        startedAt,
        { floor: floorWord, rosterFile: d?.seatGovernance.rosterFile ?? null, hostBoundary: d?.seatGovernance.hostBoundary ?? null, roleFindings },
      );
      const infra: SystemInfraRow[] = [
        daemonRow,
        ...infraProbed.slice(0, 6),
        d !== null ? skillsRow(d.skills as unknown as Parameters<typeof skillsRow>[0]) : infraRow('skills', 'unknown', 'diagnostics did not answer in time', 'Re-check.', startedAt),
        stateHomeRow(d === null ? null : (d.stateHome ?? null) as Parameters<typeof stateHomeRow>[0]),
        storesRow,
        seatFloorRow,
        infraProbed[6] as SystemInfraRow,
        loadRow(),
      ];

      const governance = buildGovernance({
        governance: (d?.governance ?? null) as GovernanceInput['governance'],
        ...(d === null ? { governanceNote: `diagnostics did not answer (${diag.kind === 'timeout' ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : diag.kind === 'error' ? diag.error : ''})` } : {}),
        skillsFindings: (d?.skills.findings ?? []) as GovernanceInput['skillsFindings'],
        decisions: d?.decisions ?? null,
        clis,
        judgeGapCount: gaps.length,
        week: weekFold,
        ...(weekNote !== undefined ? { weekNote } : {}),
        gatesByYou: gatesByYou.kind === 'ok' ? gatesByYou.value : null,
        steeringRules: rules.kind === 'ok' ? rules.value : null,
        ...(rules.kind === 'ok' && rules.value === null ? { steeringNote: 'this engine cannot list steering rules' } : rules.kind === 'timeout' ? { steeringNote: `the rule store did not answer within ${PROBE_TIMEOUT_MS / 1000} s` } : rules.kind === 'error' ? { steeringNote: `the rule store could not be read: ${rules.error}` } : {}),
      });
      // The one "needs you" rule (needs.ts): root causes ranked by impact, plus the unresolved work
      // and what it cost. Per-run cost is read from the run's own log, cached, never waited on past
      // the budget (an unread run's cost reads unknown and the next read has it).
      const first = buildNeeds({
        now,
        views: allViews,
        runs,
        infra,
        clis,
        gaps,
        infraHoldsLive: (key) => (key === 'gateway' || key === 'broker' ? containerFloor : key === 'skills' || key === 'state_home' || key === 'disk' || key === 'daemon'),
        costOf: (id) => runCosts.get(id),
      });
      if (typeof adapter.runEvents === 'function' && first.unresolved.length > 0) {
        const byId = new Map(allViews.map((v) => [v.session.id, v]));
        await settleWithin(
          () =>
            runCosts.fill(
              first.unresolved.map((u) => {
                const s = byId.get(u.runId)?.session;
                return { id: u.runId, final: ['failed', 'completed', 'cancelled'].includes(s?.status ?? ''), stamp: `${s?.status ?? ''}:${s?.ended_at ?? ''}` };
              }),
              (id) => adapter.runEvents!(id) as Promise<ReadonlyArray<{ type?: unknown; [k: string]: unknown }> | null>,
            ),
          Math.min(left(), 2_000),
        );
      }
      const needs = buildNeeds({
        now,
        views: allViews,
        runs,
        infra,
        clis,
        gaps,
        infraHoldsLive: (key) => (key === 'gateway' || key === 'broker' ? containerFloor : key === 'skills' || key === 'state_home' || key === 'disk' || key === 'daemon'),
        costOf: (id) => runCosts.get(id),
      });
      const toReview = await toReviewP;
      // A run list that could not be read never reads green: the daemon row (degraded, "did not list
      // its runs") is in attention as a slowdown, and the level stays at least yellow.
      return assembleSnapshot({
        startedAt,
        clis,
        runs,
        infra,
        governance,
        attention: needs.attention,
        unresolved: needs.unresolved,
        unresolvedSpend: needs.unresolvedSpend,
        toReview: toReview.kind === 'ok' ? toReview.value : null,
      });
    },
  );

  registerInteractiveProxy(app, adapter, {
    settings: projectSettings,
    pool: interactiveBridges,
    ...(runtime.docGrounding !== undefined ? { grounding: runtime.docGrounding } : {}),
    // crew#631: supply the standing roster so doc/demo creates can refuse an unavailable seat.
    roster: () => rosterWithStanding(),
    log: (m) => app.log.warn(m),
  });

  // ── Governed doc delete (crew#338) — the one door that changes BOTH stores ──
  // `DELETE /projects/:id/interactive/docs/:doc` retires the doc on the bridge AND drops crew's
  // handoff-ledger rows for it (the draft leg keys by document id, so a stale row claims the
  // name forever — studio#119's ghost). One static segment more specific than the proxy's
  // wildcard, so the proxy stays pure transport for everything else.
  registerInteractiveDocDelete(app, adapter, {
    settings: projectSettings,
    pool: interactiveBridges,
    audit,
    actorOf,
    // The inert default mirrors AuditLog.noop(): a directly-driven route set must never sweep
    // the operator's real ~/.wicked-crew ledgers. The real sweep always arrives from
    // `createServer`.
    dropDocLedgerRows: runtime.dropDocLedgerRows ?? (() => ({ ok: true, removed_keys: [] })),
    log: (m) => app.log.warn(m),
  });

  // ── A demo run's video as an editable document (the video editor re-cuts it through E1's per-doc API) ──
  registerDemoDocumentRoute(app, adapter, {
    bridgeFor: async (projectId): Promise<BridgeCall | null> => {
      const root = await projectDocsRoot(adapter, projectSettings, projectId);
      if (root === null) return null;
      const bridge = await interactiveBridges.ensure(root);
      return async (method, path, body) => {
        const raw = Buffer.isBuffer(body);
        const res = await fetch(`http://${bridge.host}:${bridge.port}${path}`, {
          method,
          headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
          body: raw ? new Uint8Array(body) : JSON.stringify(body),
          // A segment upload or the import's render (ffmpeg) can take minutes on a loaded host.
          signal: AbortSignal.timeout(600_000),
        });
        let parsed: Record<string, unknown> = {};
        try {
          const j: unknown = await res.json();
          if (j !== null && typeof j === 'object' && !Array.isArray(j)) parsed = j as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        return { status: res.status, body: parsed };
      };
    },
  });

  // ── Project-attributed docs list (crew#472) ──
  // `GET /projects/:id/interactive/api/docs` relays the bridge's list and stamps each row with
  // the mount's `projectId` — the attribution the bridge cannot know. Same static-over-wildcard
  // discipline as the delete: only this GET leaves the proxy, `POST /api/docs` still streams.
  registerInteractiveDocList(app, adapter, {
    settings: projectSettings,
    pool: interactiveBridges,
    // crew#512: the rows carry the grounding the draft seam recorded beside each doc.
    ...(runtime.docGrounding !== undefined ? { groundingStore: runtime.docGrounding } : {}),
    log: (m) => app.log.warn(m),
  });

  // EP-C2: the ONE checks read of a document — the reviewers' recorded verdicts, read-only.
  registerInteractiveDocChecks(app, adapter, {
    reviewsDir: runtime.docReviewsDir ?? (() => join(crewStateHome(), 'interactive-edits', REVIEWS_DIRNAME)),
    log: (m) => app.log.warn(m),
  });

  // `GET /search` (api-types 0.127.0): one query over every major entity. The index is read lazily,
  // on the first search, and kept current from the frames (`search.ingest`, wired in createServer)
  // and from this daemon's own writes (search-routes.ts).
  const search = new SearchService({
    sessionsDetail: () => adapter.sessionsDetail(),
    workOutput: (unitId) => adapter.workOutput(unitId),
    projectList: () => adapter.projectList(),
    listRepos: () => adapter.listRepos(),
    listRules: () => adapter.listConformanceRules(),
    projectOf: (id) => projects.index.projectOf(id),
    runFacts: runTimingIndex,
    ...(chatTranscripts !== undefined ? { chatsDir: () => chatTranscripts.directory } : {}),
    memories: async () => {
      const raw = await estateTool('memory.list', {});
      const items = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)['items'] : undefined;
      if (!Array.isArray(items)) throw new EstateMcpError('memory.list returned an unexpected shape');
      return items.map(shapeMemoryItem);
    },
    docs: async () => (await listInteractiveDocs({
      adapter,
      settings: projectSettings,
      docRuns,
      ...(runtime.docGrounding !== undefined ? { groundingStore: runtime.docGrounding } : {}),
    })).docs,
    log: (m) => app.log.warn(m),
  });
  registerSearchRoutes(app, search);

  const runEvalsPrepare = async (input: LaunchRunInput): Promise<void> => {
    await prepareRunEvalsLaunch(input, () => runAndRecord(defaultEvalDeps, { project: null, baseline: false, id: randomUUID(), now: new Date() }), runtime.evalRunsDir);
  };
  return { decideGate, decisions, chatRecorder, considerations, search, decorateRun, runEvalsPrepare };
}
