import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { DecisionLedger } from '../decisions/ledger.js';
import type { ChatDecisionRecorder } from '../decisions/chat-recorder.js';
import type { ConsiderationService } from '../decisions/consider.js';
import { requestOrigin, shellCsp } from '../editors/csp.js';
import { registerRoutes } from './routes.js';
import { freshenCheckout } from './chat-freshness.js';
import { ErrorRing, teeStreamWithErrorRing } from './diagnostics.js';
import { GateCache } from './gate-cache.js';
import { ElicitationCache } from './elicitation-cache.js';
import { registerAuthHooks, resolveAuth, type AuthOptions } from './auth.js';
import { AuditLog } from './audit.js';
import { EvalRunStore } from './eval-store.js';
import { RetryIndex } from './retry-index.js';
import { GroupIndex } from './group-index.js';
import { RunTimingIndex, recordRunLaunched } from './run-timing-index.js';
import { OnboardingCaptureChain } from './onboarding-capture.js';
import { GuidanceIndex } from './guidance-index.js';
import { ChatScopeIndex, reapStaleChatNamespaces } from './chat-scope.js';
import {
  chatCitationDeps,
  citationsFrame,
  verifyCitations,
  type ChatCitationDeps,
  type VerifyOptions,
} from './chat-citations.js';
import {
  DeliveryIndex,
  DeliveryResolver,
  gitRunBranchIsEmpty,
  gitWorktreeIsClean,
  canDeliverResolver,
  deliverUnitOf,
  type VacuityProbes,
} from './delivery-index.js';
import { CodebaseArchiveStore, archiveKey, deliverDispatchKey } from './codebase-archive.js';
import { DeliveryFreeze } from './delivery-freeze.js';
import { DeliveryDerivationCache } from './delivery-cache.js';
import { registerClient, broadcast } from '../events/bus.js';
import { TerminalHub, registerTerminalWs } from '../events/terminals.js';
import { startInteractiveDraftSubscriber, isAnotherProjectsDraftKey } from '../interactive/draft-events.js';
import { startInteractiveEditSubscriber } from '../interactive/edit-events.js';
import { putLearnedThemeViaBridge, startInteractiveThemeSubscriber } from '../interactive/theme-events.js';
import { authoringRunsFromLedgers, isAnotherProjectsReviewKey, readDocVersionViaBridge, startInteractiveReviewSubscriber } from '../interactive/review-events.js';
import { REVIEWS_DIRNAME, removeDocReviews } from '../interactive/review-ledger.js';
import { InteractiveBridgePool, boundOrigin } from '../interactive/bridge-pool.js';
import { startInteractiveChatSubscriber } from '../interactive/chat-events.js';
import { RunSkillGapIndex } from '../skills/phase-skill-gaps.js';
import { resolveProjectInteractiveRoot } from '../interactive/bridge-root.js';
import { sweepDocLedgers, type DocLedgerSource, type DocLedgerSweep } from '../interactive/doc-ledger-sweep.js';
import { DocRunIndex } from '../interactive/doc-run-index.js';
import { TestSetIndex, registerTestSetForRun } from '../qe/test-sets.js';
import { DocGroundingStore } from '../interactive/doc-grounding.js';
import { ProjectSettingsStore } from '../projects/settings.js';
import { crewStateHome } from '../projects/state-home.js';
import { homedir } from 'node:os';
import { discoverMcpServers } from '../mcp/discovery.js';
import { probeMcpServer } from '../mcp/probe.js';
import { budgetFromEnv, MCP_CALL_COMPLETED, McpBroker } from '../mcp/broker.js';
import { McpCallRecordFile } from '../mcp/call-records.js';
import { emitOnBus, type BusEvent } from '../core/bus.js';
import { McpRegistry } from '../mcp/registry.js';
import { McpRegistryStore } from '../mcp/registry-store.js';
import { platformSecretStore } from '../mcp/secrets.js';
import { startProjectBus, MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import { startInteractiveWsRelay, registerInteractiveEventRoutes } from '../interactive/ws-relay.js';
import { startTeamWsRelay } from '../team/ws-relay.js';
import { AskPathIndex } from './ask-paths.js';
import { AskRelay } from './ask-relay.js';
import { MembershipIndex } from '../projects/membership-index.js';
import { writeRunEvidencePointer } from '../projects/charter.js';
import {
  engineBenchesUnclassifiedSeats, CoreAdapter } from '../core/adapter.js';
import type { Actor, CoreEvent, SessionView } from '../core/types.js';
import { resolveCursorUnit } from '../core/cursor.js';
import {
  STALL_DETECTED_ACTION,
  STALL_ESCALATED_ACTION,
  StallFrameIndex,
  stallFrameAction,
} from './stall-frame-index.js';
import { SeatHealthTracker } from './seat-health.js';
import { rosterWithStandingFactory } from './roster-standing.js';
import { ChatTurnIndex } from './chat-turns.js';
import { ChatTranscriptStore } from './chat-transcripts.js';
import { sweepDeliveredWorktree } from './worktree-sweep.js';
import { installEndpointManifestHook } from './endpoint-manifest.js';
import { WorkerStallWatchdog } from './stall-watchdog.js';
import { RunLivenessSampler } from './run-liveness.js';
import { resumeRunningCampaigns } from '../campaign/boot-resume.js';
import { resumeOrphanedRuns } from '../core/run-boot-resume.js';
import { StandingOrderStore } from '../standing-orders/store.js';
import { StandingOrderEvaluator, type GateFact } from '../standing-orders/evaluator.js';
import { registerStandingOrderRoutes } from '../standing-orders/routes.js';
import { WatchRegistry } from '../watch/registry.js';
import { makeDiscoverySource } from './discovery-source.js';
import { registerWatchRoutes } from './watch-routes.js';
import { callEstateTool } from '../core/estate-mcp-client.js';
import { seatParser } from '../standing-orders/parse.js';
import { registerGateHistoryRoute, runBand, runPreset, runProject } from '../standing-orders/history.js';
import { busRows, openPlanGateRisk } from '../team/routes.js';
import { isSteeringAuthorRun } from './steering-landing.js';
import { applyWorkerConfigRoot } from './seat-signin.js';
import { builtinPresetSkillRefs, coreSkillRefs, registeredSkillRefs } from '../skills/core-closure.js';
import type { PluginSource } from '../skills/plugin-source.js';
import { assertSkillsRootFenced } from '../skills/root-fence.js';
import { SkillsRuntime } from '../skills/runtime.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../skills/engine-env.js';
import { assertWickedRootsOutsideStateHome, StateHomeWatch } from '../projects/state-home-preflight.js';
import { resolveSkillsRoot, SkillsStore } from '../skills/store.js';
import { uvSyncBaseline, type VenvProvisioner } from '../skills/venv.js';
import {
  DEFAULT_WORKER_STALL_ESCALATE_MINUTES,
  DEFAULT_WORKER_STALL_MINUTES,
} from '../core/types.js';
import { daemonSignalLog } from '../core/daemon-signal-log.js';
import { refreshProjectGraphsAfterOnboarding } from '../projects/auto-refresh.js';

/** The daemon's own actor on the audit trail (`run.delivered`, `run.ended`, the onboarding `run.launched`). */
const DAEMON_ACTOR: Actor = { id: 'daemon', kind: 'system', trust: 'admin' };
/** The stall watchdog acts on runs by itself, so its audit lines name IT, not the daemon. */
const STALL_WATCHDOG_ACTOR: Actor = { id: 'stall-watchdog', kind: 'system', trust: 'admin' };

// Allow the studio (a separate localhost origin, e.g. :4200) to call the
// daemon's REST API. Restricted to loopback origins — the daemon only binds
// 127.0.0.1, so this never widens exposure beyond the local machine.
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

/**
 * The bundled studio SPA lives at `dist/studio` next to the compiled server
 * (`dist/api/server.js` → `../studio`). See DES-STUDIO-SERVING-001 §2.3/§3.1
 * and `scripts/bundle-studio.mjs`, which copies the installed `wicked-studio`
 * package's `dist/` there (the SPA is its own product since the #98 carve —
 * github.com/mikeparcewski/wicked-studio — consumed as a dist artifact).
 */
export function defaultStudioRoot(): string {
  return fileURLToPath(new URL('../studio', import.meta.url));
}

export interface CreateServerOptions {
  /** Override the studio asset root (tests point this at a temp fixture dir). */
  studioRoot?: string;
  /**
   * Opt-in governed answering of wicked-interactive first-draft generation (task #86 spike,
   * Phase 7c). When enabled, a durable subscriber answers `wicked.interactive.doc.created`
   * (kind:source) with a governed `interactive-draft` run that ends in
   * `wicked.interactive.draft.completed`; when absent (the default), interactive's own assist
   * loop remains the answerer and crew never touches that bus traffic.
   */
  interactiveDraftEvents?: {
    enabled: boolean;
    /** The bus db; omit for the one the adapter handed its engine (`busDbPath`, core/bus.ts). */
    dbPath?: string;
    /** Poll cadence, ms (tests shorten it). */
    pollIntervalMs?: number;
    /** Heartbeat narration cadence, ms (default 15000). */
    heartbeatMs?: number;
    /** Durable replay-dedup ledger path (default ~/.wicked-crew/interactive-draft-ledger.json). */
    ledgerPath?: string;
    /** Where governed workers write finished drafts (default ~/.wicked-crew/interactive-drafts). */
    draftDir?: string;
    /** Seat roster override (JSON array); omit for the production council roster. */
    clisJson?: string;
    /** Docs-root resolver override (tests); default = per-project `interactiveRoot` setting. Used
     *  to READ the create-time grounding sidecar (F-046). */
    resolveDocsRoot?: (projectId: string | undefined) => string;
  };
  /**
   * Opt-in governed answering of wicked-interactive STRUCTURAL edits (task #86, Phase 7c final
   * leg). When enabled, a durable subscriber answers `wicked.interactive.feedback.processed`
   * (awaiting_structural > 0) with a governed `interactive-edit` run that ends in
   * `wicked.interactive.edit.completed` — after a deterministic INV-2 pre-emit self-check;
   * when absent (the default), interactive's own assist loop remains the answerer.
   * Deterministic (content/style/remove) edits never reach this seam at all: the model-free
   * service applies those instantly and hands off only the structural remainder.
   */
  interactiveEditEvents?: {
    enabled: boolean;
    /** The bus db; omit for the one the adapter handed its engine (`busDbPath`, core/bus.ts). */
    dbPath?: string;
    /** Poll cadence, ms (tests shorten it). */
    pollIntervalMs?: number;
    /** Heartbeat narration cadence, ms (default 15000). */
    heartbeatMs?: number;
    /** Durable replay-dedup ledger path (default ~/.wicked-crew/interactive-edit-ledger.json). */
    ledgerPath?: string;
    /** Where handoff files land and workers write edited fragments
     *  (default ~/.wicked-crew/interactive-edits). */
    editDir?: string;
    /** Seat roster override (JSON array); omit for the production council roster. */
    clisJson?: string;
    /** Docs-root resolver override (tests); default = per-project `interactiveRoot` setting.
     *  Used ONLY as the demo-kind gate — a demo doc's step feedback is declined honestly. */
    resolveDocsRoot?: (projectId: string | undefined) => string;
  };
  /**
   * Opt-in governed answering of wicked-interactive's conversational ITERATION asks
   * (CREW-UX-5, the doc thread's plain send). When enabled, a durable subscriber answers
   * `wicked.interactive.chat.posted` (role:user, existing kind:source doc, not an in-flight
   * doc, not a feedback-batch echo) with a governed `interactive-chat` run —
   * understand-the-ask → revise — that ends in `wicked.interactive.draft.completed` (the
   * service lands the revised full HTML as a generated version). Asks on a busy doc queue
   * FIFO per doc. When absent (the default), the topic goes unanswered — the pre-CREW-UX-5
   * state.
   */
  /**
   * Opt-in governed theme learning (DES-artifact-editor-plugins §7.6, EP-C4): a durable subscriber
   * answers `wicked.interactive.theme.learned` with one `interactive-theme` run that reads the
   * grabbed render in place and writes design tokens; crew validates shape, grammar and contrast
   * and writes them THROUGH interactive (`PUT /d/:doc/api/theme/learned {tokens, apply:true}`).
   * Shares the edit seam's ledger and handoff root. When absent, a grab learns nothing.
   */
  interactiveThemeEvents?: {
    enabled: boolean;
    dbPath?: string;
    pollIntervalMs?: number;
    heartbeatMs?: number;
    clisJson?: string;
    resolveDocsRoot?: (projectId: string | undefined) => string;
  };
  /**
   * Opt-in governed document reviews (DES-artifact-editor-plugins §7.6, EP-C2): a durable subscriber
   * answers `wicked.interactive.review.requested` with one read-only `interactive-review` run (the
   * four reviewers; the document's own authors are kept out of the roster and the judge choice),
   * records one wicked-ledger verdict row per reviewer and announces `review.completed` from the
   * record. Shares the edit seam's ledger and handoff root. When absent, a request goes unanswered.
   */
  interactiveReviewEvents?: {
    enabled: boolean;
    dbPath?: string;
    pollIntervalMs?: number;
    heartbeatMs?: number;
    clisJson?: string;
    resolveDocsRoot?: (projectId: string | undefined) => string;
  };
  interactiveChatEvents?: {
    enabled: boolean;
    /** The bus db; omit for the one the adapter handed its engine (`busDbPath`, core/bus.ts). */
    dbPath?: string;
    /** Poll cadence, ms (tests shorten it). */
    pollIntervalMs?: number;
    /** Heartbeat narration cadence, ms (default 15000). */
    heartbeatMs?: number;
    /** Durable replay-dedup ledger path (default ~/.wicked-crew/interactive-chat-ledger.json). */
    ledgerPath?: string;
    /** Where head snapshots land and workers write revisions (default ~/.wicked-crew/interactive-chats). */
    chatDir?: string;
    /** Seat roster override (JSON array); omit for the production council roster. */
    clisJson?: string;
    /** Queue-drain sweep cadence, ms (tests shorten it). */
    queueSweepMs?: number;
    /** Post-completion landing-gate timeout, ms (tests shorten it). */
    landingGateMs?: number;
    /** Docs-root resolver override (tests); default = per-project `interactiveRoot` setting. */
    resolveDocsRoot?: (projectId: string | undefined) => string;
  };
  /**
   * The project bus seam (DES-PROJECT-001 §4/§5.2). DEFAULT-ON, unlike the opt-in seams
   * above: the ADR's event vocabulary and the live activity bridge are part of the surface, not
   * an integration experiment — but the posture stays LOUD-non-fatal (no wicked-bus / broken db
   * ⇒ project CRUD works, events don't ride). `disabled: true` turns the whole seam off (tests).
   */
  projectEvents?: {
    disabled?: boolean;
    /** The bus db; omit for the one the adapter handed its engine (`busDbPath`, core/bus.ts). */
    dbPath?: string;
    /** Poll cadence for the /ws activity bridge, ms (tests shorten it). */
    pollIntervalMs?: number;
  };
  /**
   * F-042/F-043 — what the spawned wicked-interactive bridge is told about THIS daemon. The pool
   * always exports `WICKED_CREW_API` (the daemon's bound origin); `busDataDir` is the directory of
   * the bus db the interactive seams read, exported as `WICKED_BUS_DATA_DIR` so the bridge emits
   * where the seams read. `null`/omitted = not exported (the CLI passes null only when `--bus-db`
   * names a file wicked-bus cannot be pointed at through a data dir).
   */
  interactiveBridge?: {
    busDataDir?: string | null;
  };
  /**
   * DES-MERGE-001 §5.4/§6.1 (slice 3) — the interactive /ws relay. DEFAULT-ON: every
   * wicked.interactive.** bus event is bridged onto the /ws stream as an `interactiveEvent`
   * frame so the studio needs exactly ONE socket. `disabled: true` turns it off (tests).
   */
  /**
   * DES-TEAMING-002 §4.5 (T8) — the team-row → `/ws` relay (`teamEvent` frames). Armed
   * when the adapter hands the engine a bus (`busDbPath`); `disabled: true` turns it off.
   */
  teamWsRelay?: {
    disabled?: boolean;
    /** Poll cadence, ms (tests shorten it). */
    pollIntervalMs?: number;
  };
  /**
   * The watch registry (DES-TRIGGER-REGISTRY-001, TR-W5a): advisory key-point checks over the
   * daemon fan-in, relayed as `watchEvent` frames. Arms only where the engine holds a bus;
   * `disabled: true` turns it off (health then says watching is not configured).
   */
  watch?: {
    disabled?: boolean;
    entriesDir?: string;
    pollIntervalMs?: number;
    flushMs?: number;
    tickMs?: number;
  };
  interactiveWsRelay?: {
    disabled?: boolean;
    /** The bus db; omit for the one the adapter handed its engine (`busDbPath`, core/bus.ts). */
    dbPath?: string;
    /** Poll cadence, ms (tests shorten it). */
    pollIntervalMs?: number;
  };
  /**
   * The identity/actor seam (task #88). Omit for full env/file resolution:
   * OFF by default (the local loopback deployment — nothing changes), REQUIRED
   * under `WICKED_RUNTIME=team` or `WICKED_CREW_AUTH=required`. See
   * `src/api/auth.ts` + docs/auth.md.
   */
  auth?: AuthOptions;
  /** Audit-trail path override (tests). Default `~/.wicked-crew/audit.log` / `WICKED_CREW_AUDIT_LOG`. */
  auditPath?: string;
  /** Eval-run-history root override (tests). Default the state home's `evals/` /
   *  `WICKED_CREW_EVAL_STORE`. Symmetric with `auditPath` — a createServer-driven test isolates its
   *  eval history here instead of writing the operator's real `~/.wicked-crew/evals/`. */
  evalStoreRoot?: string;
  /** (crew#720) The final-codebase zip root override (tests). Default `<state home>/artifacts/runs`. */
  codebaseArchiveRoot?: string;
  // (The crew#274 §3 seat-health `--version` recovery probe is retired — perf recon fix #3.
  // Readiness lives engine-side as the wicked-core#355 dispatch bench; the tracker recovers a
  // seat on its next real `ok` output. The `seatHealthProbe` option is gone with it.)
  /**
   * The worker stall watchdog (crew#287 detection + crew#341 escalation). For every run whose
   * engine status is `executing`, the daemon tracks the last CoreEvent observed on its own
   * relay (any frame for that run, `unitOutputDelta` included); silence past
   * `workerStallMinutes` (setting, default 15) broadcasts ONE synthetic
   * `{ type: "workerStalled", session, ord?, quietForMs }` frame on /ws per quiet period and
   * logs at warn. Any new event re-arms. Detection never touches the run.
   *
   * ESCALATION (crew#341) is ON BY DEFAULT as of perf#4 (`workerStallEscalateMinutes`
   * defaults to 30; an explicit 0 — setting or `escalateMinutes` override — disarms): a run
   * still silent past the threshold gets one action per quiet period — `reassign` (default:
   * recycle the wedged cursor unit via the engine's `reassignUnit`, routed to a DIFFERENT
   * seat from the run's pool when one is available, budgeted per run by
   * `workerStallMaxEscalations`) or `notify` (fail-loud `needsYou` frame, run untouched) —
   * each reported on a `workerStallEscalated` /ws frame and audited as `run.stall.escalated`.
   *
   * `enabled` defaults to ON in the daemon and OFF under a test runner (VITEST /
   * NODE_ENV=test), the seat-health-probe posture.
   */
  /** The seats' standing (tests: a sign-in answer instead of the credential-file heuristic and
   *  the live auth-status probes, so admission is host-independent). */
  seats?: {
    signedIn?: (seatKey: string, workerRoot?: string) => boolean | null;
  };
  stallWatchdog?: {
    enabled?: boolean;
    /** Sweep cadence, ms (default 30 s; tests shorten it). */
    sweepIntervalMs?: number;
    /** Threshold override, minutes — bypasses the settings read (tests). */
    stallMinutes?: number;
    /** Escalation-threshold override, minutes — bypasses the settings read (tests). */
    escalateMinutes?: number;
    /** Escalation-action override — bypasses the settings read (tests). */
    escalateAction?: 'reassign' | 'notify';
    /** Per-run automatic-reassign budget override — bypasses the settings read (tests). */
    maxEscalations?: number;
    /** Process-liveness override (crew#629): default = the daemon's own process tree
     *  (`RunLivenessSampler`); tests pass a stub or `null` (frame-only clock). */
    busy?: ((runIds: string[]) => Promise<ReadonlyMap<string, string>>) | null;
  };
  /**
   * The background delivery-derivation cache's sweep (GET /runs p99): every `sweepIntervalMs`
   * (default 30 s = `WORKTREE_CLEAN_TTL_MS`) the daemon re-derives every candidate run's
   * stranded/vacuous/none label through a ≤3-wide git pool, so the run DTOs only ever READ a
   * cache and the list fan-out never spawns git. `enabled` defaults to ON in the daemon and OFF
   * under a test runner (VITEST / NODE_ENV=test), the seat-health-probe posture — the
   * terminal-frame warm is always on (event-driven, not a timer).
   */
  deliveryCache?: {
    enabled?: boolean;
    /** Sweep cadence, ms (tests shorten it). */
    sweepIntervalMs?: number;
  };
  /**
   * The skills seam (skills keystone): at boot the daemon seeds `<state home>/skills` — the ONE
   * root, not a setting (codex round 5) — from the LIVE installed wicked-garden plugin, publishes a
   * first immutable snapshot when none exists (its `views/copilot/` generated alongside), and
   * exports `WICKED_SKILLS_SNAPSHOT` for the engine. It never writes into the user's own CLI
   * directories (design v3.2 §1): the boot REFUSES (`SkillsRootUnfencedError`) a root whose
   * canonical path leaves the state home or lands inside one. `disabled: true` registers the
   * routes without a store (they answer 503) —
   * the manifest collector and tests that must not touch a plugin cache use it. `source` /
   * `provisionVenv` aim a test at a fixture plugin root and a provisioner that spawns nothing
   * (`noVenv`) — a boot test must never run the host's `uv` or download anything; production omits
   * both (live discovery, `uvSyncBaseline`).
   */
  skills?: {
    disabled?: boolean;
    source?: () => PluginSource | null;
    provisionVenv?: VenvProvisioner;
  };
  /**
   * Chat citation verification (crew#561). DEFAULT-ON: every terminal `chatReply` of a chat with
   * read roots has its cited paths, `path:line` / `path:symbol` refs and commit SHAs checked
   * against those roots, and the verdicts ride `/ws` as one `chatCitations` frame. The pass runs
   * AFTER the reply is broadcast, so it never delays an answer, and it is bounded (see
   * `chat-citations.ts`). `disabled: true` turns it off; `deps` / `limits` let a test drive it
   * without a repo, a git or the default budget.
   */
  chatCitations?: {
    disabled?: boolean;
    deps?: ChatCitationDeps;
    limits?: VerifyOptions;
  };
}

/**
 * Per-stage boot timings, ms (crew#741): where a slow boot's seconds went, instead of one
 * `startupMs`. EXCLUSIVE stages that sum to the boot: `setup`, `skills`, `venv`, `routes`,
 * `studio`, `listen` here; `wicked-crew serve` prepends `preflight` and `engine`. The key set is
 * open — a harness reads the stages it knows.
 */
export type BootStages = Readonly<Record<string, number>>;

/**
 * A lap clock for the boot: `lap(name)` closes the stage that ran since the previous lap (or since
 * construction) and rounds it to whole ms; `set` records (or corrects) a stage measured elsewhere —
 * a re-`set` key keeps its position. Stages are reported in the order they were first recorded.
 */
export class BootStageClock {
  private readonly stages: Record<string, number> = {};
  private mark = performance.now();

  lap(name: string): number {
    const now = performance.now();
    const ms = Math.max(0, Math.round(now - this.mark));
    this.stages[name] = ms;
    this.mark = now;
    return ms;
  }

  set(name: string, ms: number): void {
    this.stages[name] = Math.max(0, Math.round(ms));
  }

  snapshot(): BootStages {
    return { ...this.stages };
  }

  /** One human line: `setup 12ms · skills 1203ms · venv 0ms · …` */
  describe(): string {
    return Object.entries(this.stages)
      .map(([name, ms]) => `${name} ${ms}ms`)
      .join(' · ');
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** crew#741 — the boot's stage clock; `startServer` adds `listen` and hands the snapshot back. */
    bootStages?: BootStageClock;
  }
}

export async function createServer(
  adapter: CoreAdapter,
  options?: CreateServerOptions,
): Promise<ReturnType<typeof Fastify>> {
  const bootClock = new BootStageClock();
  // The diagnostics error ring: a tee on the pino stream that keeps the last ~20 error-level
  // lines in memory (crew has no log file of its own — stdout belongs to whoever launched the
  // daemon), surfaced read-only on GET /diagnostics. Built before Fastify so the logger's
  // destination IS the tee — no second logging channel to keep in step.
  const errorRing = new ErrorRing();
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      stream: teeStreamWithErrorRing(errorRing),
    },
  });
  // TH-11: accumulate the route table as it registers — the endpoint manifest's one source of
  // truth. Installed FIRST because fastify only fires onRoute for routes added after the hook
  // exists. Read via `app.endpointManifest` (scripts/generate-endpoint-manifest.ts + the drift
  // test); costs one array push per route at boot, nothing per request.
  app.decorate('endpointManifest', installEndpointManifestHook(app));
  const gateCache = new GateCache();
  // Standing orders (behaviour 10): armed once the routes (and so THE gate decision path) exist;
  // the event relays above it read it late-bound.
  let standingOrderEvaluator: StandingOrderEvaluator | null = null;
  // The watch registry (TR-W5a): built after the relays below; the fan-in and the watchdog tee
  // read it late-bound, exactly as they read the standing-orders evaluator.
  let watchRegistry: WatchRegistry | null = null;
  // DC-S4b: the studio chat recorder, handed back by `registerRoutes` below (it needs the service built there).
  let chatDecisionRecorder: ChatDecisionRecorder | null = null;
  // DC-S7: considered · set aside · cited — the rule reads behind the citation verifier, the unit hook
  // and the chat open/send paths (built by `registerRoutes`).
  let considerations: ConsiderationService | null = null;
  const elicitationCache = new ElicitationCache();
  const terminals = new TerminalHub();
  // Per-seat runtime health (crew#274): folded from the single CoreEvent subscription below,
  // surfaced on GET /roster, recovered by the low-frequency probe armed further down.
  const seatHealth = new SeatHealthTracker({
    signalLog: daemonSignalLog,
    log: (m) => app.log.warn(m),
  });
  // THE roster accessor (F-RECON-002/003, `api/roster-standing.ts`): the registry roster WITH this
  // tracker's standing, built ONCE and handed to every launch path — the routes (below, through
  // `runtime.rosterWithStanding`), the four interactive seams (`roster`), and the adapter's own
  // launches (`setRosterProvider` → `seatsForWorkflow` / `wicked-crew start`). Read at call time,
  // so a seat signed in from the System page is eligible on the very next launch.
  const rosterWithStanding = rosterWithStandingFactory({
    seatHealth,
    ...(options?.seats?.signedIn !== undefined ? { signedIn: options.seats.signedIn } : {}),
  });
  // Runtime-guarded, not typed away: the integration suites drive `createServer` over PARTIAL fake
  // adapters (cast to `CoreAdapter`) that never grew this method — the real adapter always has it.
  if (typeof (adapter as { setRosterProvider?: unknown }).setRosterProvider === 'function') {
    adapter.setRosterProvider(rosterWithStanding);
  }

  // The identity/actor seam (task #88). Resolved ONCE, before any hook exists:
  // a malformed token file or a configured-but-unimplemented OIDC block must
  // fail the boot here, never a request mid-flight. In the default local mode
  // this reads no file and installs a hook that only pins the local actor.
  const auth = resolveAuth(options?.auth, (m) => app.log.warn(m));
  if (auth.mode === 'required') {
    app.log.info('auth REQUIRED: bearer tokens enforced on /api/v1 and /ws');
  }
  const audit = new AuditLog(options?.auditPath, (m) => app.log.warn(m));
  app.addHook('onClose', async () => {
    await audit.flush(); // don't lose the trail's tail on shutdown
  });

  // The eval RUN history behind `/testing/evals[/:id]` — rooted under the daemon's resolved state
  // home (so a `--db`-isolated daemon keeps its eval history isolated too), synchronous writes, no
  // shutdown flush to await (each run persists inline before its POST answers). The `evalStoreRoot`
  // option lets a createServer-driven test isolate its history off the real home (symmetric with
  // `auditPath`); production omits it and resolves through the state-home seam.
  const evalStore = new EvalRunStore(options?.evalStoreRoot, (m) => app.log.warn(m));

  // Seat sign-in: export the persisted worker-config root as WICKED_WORKER_HOME at boot (the
  // PUT /settings route re-applies it on every change). The engine reads the env PER SPAWN
  // (acp_runner.rs claude_worker_home), so boot + on-change application is sufficient — no
  // engine restart is ever needed. settings.json is the source of truth when it names a root;
  // unset/empty restores the env this process booted with (an operator-exported
  // WICKED_WORKER_HOME — or the test harness's hermetic arming, crew#396 — survives), falling
  // back to the engine default ~/.wicked-worker when the process booted without one.
  const bootSettings = await adapter.getSettings();
  applyWorkerConfigRoot(bootSettings.worker_config_root);

  // The skills seam (skills keystone): boot-time only — there is NO skills setting to re-apply on
  // PUT /settings (codex round 5: `skills_root` and its env override are retired). The store hangs
  // off `<state home>/skills` (never a `~/.wicked-crew` literal, crew#353), and the boot ASSERTS the
  // root is fenced before the store exists: canonically inside the state home, outside every user
  // CLI directory, not a symlink — a violation is a daemon start error (`SkillsRootUnfencedError`,
  // skills/root-fence.ts). The worker Read fence is core's explicit denylist of state-home subtrees
  // (v3.1 §1; tests/fixtures/state-home-subtrees.json is the shared registry), with the resolved
  // snapshot the one non-denied path; the core-by-reference closure is seeded from the workflow
  // catalog the daemon serves (built-ins + user-registered), read at use time so a later
  // registration counts at the next publish. `apply` never throws and never fails open: no
  // installed plugin is the logged fallback (engine input unset); a blocked first publish or a
  // corrupt root points the engine at a refusal path so launches fail loudly (skills/runtime.ts).
  // Awaited: a first publish provisions the baseline env before it returns.
  //
  // wicked-core#411 / crew#497 (F-RC1-011): a `WICKED_*` root variable pointed INSIDE the state
  // home is a configuration error the boot REFUSES — the same posture as an unfenced skills root
  // below. The rig set `WICKED_WORKFLOWS_DIR=<state home>/workflows`: crew seeded the interactive-*
  // drop-in defs there, the fence's registry could not classify the entry, and every worker launch
  // was refused — discovered at each run's first worker. Judged here, before any seam creates
  // anything under those roots (`serve` asserts the same rule before the engine spawns).
  assertWickedRootsOutsideStateHome(process.env, crewStateHome());
  // crew#741: everything above (logger, settings, roots) is `setup`; the skills seam is its own
  // stage, with the provisioner's time (`venv`) read from the store and carved OUT of it — `0`
  // when the baseline env already carried its verified ready marker (`SkillsStore.ensureVenv`'s
  // fast path), which is the acceptance that a boot on an unchanged baseline re-runs no `uv sync`.
  bootClock.lap('setup');
  let skillsRuntime: SkillsRuntime | undefined;
  let skillsStore: SkillsStore | undefined;
  // X-MIG M11: the built-in workflows crew serves are the engine's presets, read once at boot (a
  // test double without the method serves none).
  if (typeof (adapter as Partial<CoreAdapter>).loadBuiltinCatalog === 'function') {
    await adapter.loadBuiltinCatalog((m) => app.log.warn(m));
  }
  if (options?.skills?.disabled !== true) {
    const source = options?.skills?.source;
    const skillsRoot = resolveSkillsRoot();
    assertSkillsRootFenced(skillsRoot, { stateHome: crewStateHome() });
    // crew#935: a built-in preset registers no def, so its skills join the core set here — but only
    // the ones the catalog HOLDS (they cannot be disabled out from under the preset). One the catalog
    // lacks is not made a publish blocker: an older garden still publishes for every other workflow,
    // and a run of that preset fails at admission naming the skill (codex r5 on #938).
    const presetRefs = await builtinPresetSkillRefs(adapter, (m) => app.log.warn(m));
    const store: { current?: SkillsStore } = {};
    skillsStore = new SkillsStore({
      root: skillsRoot,
      registeredSkillRefs: () => {
        // Runtime defs' refs are required; the built-in presets' (served in listWorkflows since
        // X-MIG M11) are core only when the catalog holds them — `coreSkillRefs` below.
        const refs = registeredSkillRefs(
          typeof adapter.listRuntimeWorkflows === 'function' ? adapter.listRuntimeWorkflows() : adapter.listWorkflows(),
        );
        let held: ReadonlySet<string> = new Set();
        try {
          held = new Set(Object.keys(store.current?.manifest().skills ?? {}));
        } catch {
          // an unreadable manifest holds nothing: the presets' refs are then simply not core
        }
        return coreSkillRefs(refs, presetRefs, held);
      },
      provisionVenv: options?.skills?.provisionVenv ?? uvSyncBaseline,
      ...(source !== undefined ? { source } : {}),
      warn: (m) => app.log.warn(m),
    });
    store.current = skillsStore;
    skillsRuntime = new SkillsRuntime({
      store: skillsStore,
      log: (m) => app.log.warn(m),
    });
    // The base skill setting (crew#554 / wicked-core#468) is applied BEFORE the ladder runs, so
    // `apply`'s outcome re-judges it against whatever generation it exports: `WICKED_BASE_SKILL_REF`
    // is ALWAYS exported while the setting is on (`'require'` is the only policy — the engine refuses
    // at intake when the generation it is handed lacks the skill) and deleted when `baseSkillRef` is
    // `''` — the engine reads it at intake, per launch. Re-applied by PUT /settings
    // and by every publish / refresh (skills/runtime.ts).
    skillsRuntime.configureBaseSkill(bootSettings);
    await skillsRuntime.apply();
    // crew#874: an installed garden that moved past the baseline, over a catalog with no operator
    // change, is refreshed and published here — otherwise every run executes the older garden and
    // `skills.installed-ahead` says so. `WICKED_CREW_SKILLS_AUTO_REFRESH=0` turns it off.
    await skillsRuntime.autoRefreshOnBoot();
  }
  // Exclusive peers (codex on #846): `venv` is the provisioner path's time, `skills` the rest of
  // the seam (seed, validate, hash, stage, flip) — the stages sum, never double-count.
  const skillsMs = bootClock.lap('skills');
  const venvMs = skillsStore?.venvStage().ms ?? 0;
  bootClock.set('skills', skillsMs - venvMs);
  bootClock.set('venv', venvMs);

  // The state-home PREFLIGHT (wicked-core#411 / crew#497; F-RC1-011, F-RC2-020): an entry under the
  // state home that core's fence registry cannot classify refuses EVERY worker launch — and until
  // now the daemon booted green over it, the refusal surfacing at each run's first worker as a
  // "triage judge errored" gate. Surveyed HERE, after the skills seam decided which snapshot the
  // engine is handed (the fence derives the state home from that path), through the engine's own
  // classification when the addon carries it and crew's registry copy otherwise; ONE error-level
  // line per entry (the pino tee lands it in `/diagnostics.recentErrors`, which showed nothing
  // before — F-RC2-027); reported live on `/diagnostics.stateHome` and `/health.warnings`; and
  // `POST /runs` answers 409 while it refuses launches. The daemon still SERVES — studio must load
  // and show the blocker — it refuses to launch.
  const stateHomeWatch = new StateHomeWatch({
    dbPath: typeof adapter.dbPath === 'string' && adapter.dbPath !== '' ? adapter.dbPath : null,
    snapshotPath: () => {
      const v = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
      return v === undefined || v === '' ? null : v;
    },
    engine: CoreAdapter.stateHomePreflighter(),
  });
  const stateHomeAtBoot = await stateHomeWatch.refresh();
  for (const finding of stateHomeAtBoot.findings) {
    app.log.error(`[state-home] ${finding.message}`);
  }
  if (stateHomeAtBoot.error !== null) {
    app.log.warn(`[state-home] the state-home preflight could not classify (${stateHomeAtBoot.source}): ${stateHomeAtBoot.error}`);
  }

  // The project seam (DES-PROJECT-001): the bus handle for post-commit event emission + the
  // /ws activity bridge, and the run→project index that tags outbound frames (§5.2). Hydrated
  // from the engine so a restarted daemon tags correctly from the first frame. Created BEFORE
  // the interactive seams below: their project-bound launches share the launch route's
  // post-commit half (index tag + membership.attached emit) via `fileRun`.
  const membershipIndex = new MembershipIndex();
  await membershipIndex.hydrate(adapter, (m) => app.log.warn(m));
  // Per-project crew-side settings (DES-MERGE-001 §7.1's `interactiveRoot`). ONE instance,
  // created here so the chat seam's docs-root resolution below and the routes (project PATCH +
  // interactive proxy) all read/write the same store — two instances over one file would let a
  // PATCH land in one while the other keeps serving the stale root. The default path follows the
  // bootstrap-configured state home (crew#353); the warn hook is the loud half of the migration
  // posture — an override root shadowing a default-root file must be SAID at boot, never silent.
  const projectSettings = new ProjectSettingsStore(undefined, (m) => app.log.warn(m));
  // crew#619: chats promoted to runs retain their transcripts until the run is terminal, even
  // across daemon restarts. The maps are populated from the audit trail below (non-terminal
  // `run.launched` entries that carry a `chatId`) and kept in sync by the event loop.
  const chatRetained = new Map<string, Set<string>>();
  const runToChat = new Map<string, string>();
  // ASK-C1/C2: the daemon's record of each chat's ask path (which run answers which chat, the PA,
  // the reviewer, the helpers) — written by the routes, read by the relay below. In-memory.
  const askPaths = new AskPathIndex();
  // Retry lineage (CREW-UX-3) + ad-hoc group attach (wicked-studio#27): both durable records
  // live in the trail's `run.launched` entries, so ONE exhaustive scan feeds both indexes —
  // boot stays at three full-file trail scans, not four (the crew#321 consolidation note).
  const retryIndex = new RetryIndex();
  const groupIndex = new GroupIndex();
  // Run launch time (home command-center run metrics): the third consumer of the `run.launched`
  // scan — the entry's `ts` is the durable launch instant `AgentSession.created_at` echoes.
  const runTimingIndex = new RunTimingIndex();
  try {
    const launchEntries = await audit.readAll({ action: 'run.launched' });
    retryIndex.hydrateFromLaunchEntries(launchEntries);
    groupIndex.hydrateFromLaunchEntries(launchEntries);
    runTimingIndex.hydrateFromLaunchEntries(launchEntries);
    // `ended_at` (crew#496 / studio#230): the `run.ended` entries this daemon wrote at terminal
    // frames — one more filtered scan, same try, same best-effort. Nothing is re-emitted at boot: a
    // run that terminalled with no entry (pre-field, or the crash window between the engine's
    // status write and the synchronous record below) stays undated.
    const endedEntries = await audit.readAll({ action: 'run.ended' });
    runTimingIndex.hydrateFromEndedEntries(endedEntries);
    // crew#619: rebuild the chat↔run retention maps for runs that were still live when the
    // daemon was last stopped. The `run.launched` entries that carry `chatId` and are NOT in
    // `run.ended` represent runs whose transcripts must still be on disk.
    const endedRunIds = new Set(
      endedEntries.filter((e) => typeof e.runId === 'string').map((e) => e.runId as string),
    );
    for (const entry of launchEntries) {
      const chatId = (entry.detail as Record<string, unknown> | undefined)?.['chatId'];
      if (typeof entry.runId === 'string' && typeof chatId === 'string' && !endedRunIds.has(entry.runId)) {
        linkChatRun(chatId, entry.runId);
      }
    }
  } catch (err) {
    app.log.warn(
      `[runs] launch-index hydrate failed (prior runs read as not-a-retry / ungrouped / undated, without their chat_id link, until restart): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // wicked-studio#284: the watchdog's own frames, rebuilt from the trail this daemon (or a previous
  // one) wrote — so a run page reloaded after the run ended, or after a restart, still shows the
  // stall/escalation facts the live socket carried. Same posture as the indexes above: two more
  // filtered scans, best-effort, and NOTHING is re-emitted — hydrating fills a map, it never
  // broadcasts or re-arms a clock.
  const stallFrameIndex = new StallFrameIndex();
  try {
    stallFrameIndex.hydrateFromEntries([
      ...(await audit.readAll({ action: STALL_DETECTED_ACTION })),
      ...(await audit.readAll({ action: STALL_ESCALATED_ACTION })),
    ]);
  } catch (err) {
    app.log.warn(
      `[runs] stall-frame hydrate failed (stalls recorded before this boot stay off GET /runs/:id/events): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // BC-15's compensating clause — "the engine benches it per run at the ballot threshold" — covers
  // an UNCLASSIFIED persistently-failing seat only from wicked-core-ts 0.7.27 (the 3D' arm, core
  // #523). The runtime pin still allows 0.7.26, where crew's deleted ledger has no engine
  // counterpart, so say it once at boot instead of letting such a seat look healthy forever.
  if (!engineBenchesUnclassifiedSeats()) {
    app.log.warn(
      '[roster] this engine (wicked-core-ts < 0.7.27) does not bench a seat whose ballots fail ' +
        'persistently WITHOUT a recognised reason, and crew keeps no bench of its own (BC-15): such ' +
        'a seat stays council-eligible until it authenticates or an operator disables it. ' +
        'Upgrade the engine to 0.7.27+ to get the per-run bench back.',
    );
  }
  // Onboarding runs launch inside the adapter (`_doOnboardingLaunch`), never through POST /runs — so
  // they had no `run.launched` entry and no `created_at` (crew#496). The adapter reports each one
  // here, after the engine accepted it, and the SAME recorder every launch route uses dates it.
  if (typeof (adapter as Partial<CoreAdapter>).setOnRunLaunched === 'function') {
    adapter.setOnRunLaunched((runId, detail) => {
      recordRunLaunched(audit, runTimingIndex, DAEMON_ACTOR, runId, detail);
    });
  }
  // Operator guidance (CREW-UX-7, DES-UX-002 §7.2): same durable pattern — hydrated from the
  // trail's `guidance.set` entries so notes survive a daemon restart.
  const guidanceIndex = new GuidanceIndex();
  await guidanceIndex.hydrate(audit, (m) => app.log.warn(m));
  // crew#661: the runs that launched while a seam was unarmed (`session.skill_gaps`), read back from
  // the trail. No seam arms unarmed since crew#935, so nothing new is recorded.
  const runSkillGaps = new RunSkillGapIndex();
  await runSkillGaps.hydrate(audit, (m) => app.log.warn(m));
  const skillHeld = (name: string): boolean => skillsRuntime?.holdsSkill(name) ?? false;
  // Delivered-PR record (CREW-UX-8, crew#321): same durable pattern — hydrated from the
  // trail's `run.delivered` entries so `session.delivery` survives a daemon restart.
  const deliveryIndex = new DeliveryIndex();
  await deliveryIndex.hydrate(audit, (m) => app.log.warn(m));
  // Freeze deliveries (idea 15): same durable pattern — the trail's `deliveries.frozen` /
  // `deliveries.unfrozen` entries, so a restart keeps the freeze on.
  const deliveryFreeze = new DeliveryFreeze();
  await deliveryFreeze.hydrate(audit, (m) => app.log.warn(m));
  // Wave 6 (F-7R2-014): the test sets `qe-author-tests` runs registered — same durable pattern,
  // hydrated from the trail's `testing.testset.registered` entries, fed at each terminal frame.
  const testSets = new TestSetIndex();
  await testSets.hydrate(audit, (m) => app.log.warn(m));
  // The background delivery-derivation cache (GET /runs p99): the ONLY place the git vacuity
  // probes run in the daemon — the run DTOs read this cache (degrading to the stat-only
  // stranded/none label on a miss) and never spawn git on the request path. ONE probes object,
  // passed to the routes below too, so the campaigns rollup rides the same TTL memo the sweeper
  // keeps warm. Swept every 30s (WORKTREE_CLEAN_TTL_MS) through a ≤3-wide pool; warmed once per
  // run at its terminal frame (the CoreEvent subscription below). The sweep is ON in the daemon
  // and OFF under a test runner — the seat-health-probe posture: a test-built server must never
  // background-spawn git unless it opts in.
  const vacuityProbes: VacuityProbes = {
    worktreeExists: (p) => existsSync(p),
    worktreeIsClean: gitWorktreeIsClean(),
    runBranchIsEmpty: gitRunBranchIsEmpty(
      async (repoRef) => (await adapter.listRepos()).find((r) => r.id === repoRef)?.root_path,
    ),
  };
  // Def-awareness (crew#481 / D-14): ONE predicate — `runCanDeliver` over the run's resolved def —
  // shared by this cache (GET /runs, GET /runs/:id, the resume 409) and the campaigns rollup below,
  // so a completed capture-learnings/onboarding run reads `delivery: 'none'` on every surface. A
  // read-time derivation over the run record + the registry: existing records flip at their next
  // read, nothing is written, the `run.delivered` trail is untouched.
  const canDeliver = canDeliverResolver(() => adapter.listWorkflows(), (m) => app.log.warn(m));
  const deliveryCache = new DeliveryDerivationCache({
    listViews: () => adapter.sessionsDetail(),
    probes: vacuityProbes,
    isDelivered: (runId) => deliveryIndex.isDelivered(runId),
    canDeliver,
    log: (m) => app.log.warn(m),
    // Non-probe derivation throws are defects — error level, so the diagnostics ring sees them.
    logError: (m) => app.log.error(m),
  });
  const deliveryCacheArmed =
    options?.deliveryCache?.enabled ??
    !(process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test');
  if (deliveryCacheArmed) {
    deliveryCache.start(options?.deliveryCache?.sweepIntervalMs);
  }
  // Stopped unconditionally: even with the sweep unarmed, the terminal-frame warm can leave a
  // failed derivation's retry timer pending, and a closed daemon must never re-derive into the
  // void (a torn-down test server's adapter included).
  app.addHook('onClose', async () => {
    deliveryCache.stop();
  });
  // The one post-terminal `workOutput` read that resolves a run's delivered PR URL into the
  // durable record (audit entry) + the index the run DTOs echo. Best-effort by construction:
  // a failure here must never fail the run. Triggered on `sessionCompleted` OR
  // `sessionFailed` — a def-carried deliver phase need not be the last phase, so a successful
  // deliver can precede a later failure; the failed-deliver case is a cheap no-op (a rejected
  // unit has no stored work_output — deny-dominates writes none past a deny — and the resolver's
  // status guard skips the read entirely). The resolver (crew#851) shares ONE read per run between
  // this frame and a `GET /runs(/:id)` that lands between the engine's `completed` flip and the
  // record — the routes await it for such a view, so the wire never serves `completed` +
  // `delivery: 'stranded'` for a run whose deliver unit already carries the PR URL.
  const deliveryResolver = new DeliveryResolver({
    listViews: () => adapter.sessionsDetail(),
    workOutput: (unitId) => adapter.workOutput(unitId),
    isDelivered: (runId) => deliveryIndex.isDelivered(runId),
    // The durable record first, then the read-side index — the same write order as
    // `guidance.set`, so the index can only LAG a crash (rehydrated at next boot), never
    // hold a record the trail does not.
    record: (runId, record) => {
      audit.record('run.delivered', DAEMON_ACTOR, { runId, detail: record });
      if ('url' in record) deliveryIndex.set(runId, record.url);
      else deliveryIndex.setPushed(runId, record.pushed);
    },
    log: (m) => app.log.warn(m),
  });
  const resolveRunDelivery = (runId: string): Promise<void> => deliveryResolver.resolve(runId);
  // crew#720 (operator ruling 2026-10-10): every delivery leaves a zip of the run's final codebase,
  // whatever the outcome. Taken when the deliver unit's output lands (delivered, push refused,
  // credentials missing, wrong account) and again at the run's terminal frame (a lift conflict, a
  // run that failed after building, a cancel) — BEFORE the delivered-worktree sweep. An unchanged
  // tree rewrites nothing. Best-effort: never awaited by the frame, never a run failure.
  const codebaseArchives = new CodebaseArchiveStore(options?.codebaseArchiveRoot, (m) => app.log.info(m));
  /** `<run>\0<ord>` of deliver-script units dispatched and not yet captured (crew#720). */
  const deliverDispatches = new Set<string>();
  /** Runs this daemon has seen a dispatch frame for (crew#720; the boot-redrive fallback). */
  const observedRuns = new Set<string>();
  const archiveRunCodebase = async (runId: string, trigger: 'deliver' | 'run_end', view?: SessionView): Promise<void> => {
    try {
      const v = view ?? (await adapter.sessionsDetail()).find((x) => x.session.id === runId);
      if (v === undefined || v.session.repo_ref == null) return;
      const repoRoot = (await adapter.listRepos()).find((r) => r.id === v.session.repo_ref)?.root_path ?? null;
      const before = codebaseArchives.get(runId);
      const rec = await codebaseArchives.archive(runId, { workdir: v.session.workdir, repoRoot }, trigger);
      if (rec !== null && rec !== before) audit.record('run.codebase_archived', DAEMON_ACTOR, { runId, detail: { ...rec } });
    } catch (err) {
      app.log.warn(`[runs] codebase archive for ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Crew reaches a bus only through the engine that holds it (wicked-core#631, core/bus.ts): a seam
  // with no bus db of its own reads and writes the one this adapter handed its engine.
  const engineBusDb = typeof adapter.busDbPath === 'string' ? adapter.busDbPath : undefined;
  const busOf = (dbPath: string | undefined): { dbPath?: string } => {
    const bus = dbPath ?? engineBusDb;
    return bus !== undefined ? { dbPath: bus } : {};
  };
  const projectBus =
    options?.projectEvents?.disabled === true
      ? null
      : await startProjectBus({
          ...busOf(options?.projectEvents?.dbPath),
          ...(options?.projectEvents?.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.projectEvents.pollIntervalMs }
            : {}),
          log: (m) => app.log.warn(m),
          logError: (m) => app.log.error(m),
        });
  if (projectBus !== null) {
    app.log.info('project bus seam armed (wicked.crew.project.* + /ws activity bridge)');
    app.addHook('onClose', async () => {
      await projectBus.stop();
    });
  }

  // The four interactive answering seams' handles, declared BEFORE the /ws relay below because
  // the relay's `doc.retired` hook — and the governed delete route — sweep the seams' handoff
  // ledgers through `dropDocLedgerRows`, which prefers each seam's LIVE ledger instance (a
  // file-level rewrite behind a live instance's back would be undone by that instance's next
  // whole-map persist). The sources are read AT SWEEP TIME, so a seam that arms after the relay
  // is still preferred over its file once armed; the seams themselves arm further down.
  let draftSub: Awaited<ReturnType<typeof startInteractiveDraftSubscriber>> = null;
  let editSub: Awaited<ReturnType<typeof startInteractiveEditSubscriber>> = null;
  let themeSub: Awaited<ReturnType<typeof startInteractiveThemeSubscriber>> = null;
  let reviewSub: Awaited<ReturnType<typeof startInteractiveReviewSubscriber>> = null;
  let chatSub: Awaited<ReturnType<typeof startInteractiveChatSubscriber>> = null;

  /** The crew-side half of deleting an interactive doc (crew#338): drop the doc's replay-dedup
   *  rows from all four handoff ledgers — the draft leg keys by DOCUMENT ID ("one first draft
   *  per document lifetime"), so a row that outlives its doc claims the name forever and a
   *  same-named successor never gets its first draft. Armed seams are swept through their live
   *  instances; un-armed seams through their ledger FILES (options override, else the same
   *  crewStateHome() default each seam resolves — under `--db` the sweep must follow the
   *  override, crew#353/#398). Never throws — the report says what happened. */
  const crewStateDir = crewStateHome();
  // F-046: the create-time doc → subject-repo bindings, shared by the proxy (records) and the
  // draft seam (read). The store keeps NO file of its own — each binding is a
  // `crew-grounding.json` sidecar beside the doc's `versions.json` under the project's docs root
  // (doc-grounding.ts says why not the state home: core's fence refuses unregistered entries).
  const docGrounding = new DocGroundingStore();
  /** The three seams' ledgers, read AT USE TIME (a seam that armed after this closure was built is
   *  still preferred over its file) — shared by the doc-delete sweep and the doc↔run index. */
  const docLedgerSources = (): DocLedgerSource[] => [
    {
      name: 'draft',
      ledger: draftSub?.ledger,
      path:
        options?.interactiveDraftEvents?.ledgerPath ??
        join(crewStateDir, 'interactive-draft-ledger.json'),
    },
    {
      name: 'edit',
      ledger: editSub?.ledger,
      path:
        options?.interactiveEditEvents?.ledgerPath ??
        join(crewStateDir, 'interactive-edit-ledger.json'),
    },
    {
      name: 'chat',
      ledger: chatSub?.ledger,
      path:
        options?.interactiveChatEvents?.ledgerPath ??
        join(crewStateDir, 'interactive-chat-ledger.json'),
    },
  ];
  /** Where the interactive-review seam records every document's reviews (EP-C2): under the edit
   *  seam's handoff root, so no new state-home entry exists. */
  const docReviewsDir = (): string =>
    reviewSub?.reviewsDir ?? join(options?.interactiveEditEvents?.editDir ?? join(crewStateDir, 'interactive-edits'), REVIEWS_DIRNAME);
  const dropDocLedgerRows = (documentId: string, projectId?: string): DocLedgerSweep => {
    // EP-C2: a review row names its project, so the same-named document of ANOTHER project keeps its rows.
    const sweep = sweepDocLedgers(
      documentId,
      docLedgerSources(),
      // crew#809: a draft row names its project too.
      (key) => isAnotherProjectsReviewKey(key, documentId, projectId) || isAnotherProjectsDraftKey(key, documentId, projectId),
    );
    // EP-C2: the document's recorded reviews go with it — a later document of the same name must
    // not inherit them (the same ghost the ledger rows would be). Its own project's only: the
    // review store is partitioned per project, like the docs roots.
    try {
      removeDocReviews(docReviewsDir(), documentId, projectId);
      return sweep;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ...sweep, ok: false, errors: [...(sweep.errors ?? []), { ledger: 'reviews', error }] };
    }
  };
  // Wave 6 (F-4R2-006 root fix): the document ↔ run binding as a direct read off the SAME four
  // ledgers — `AgentSession.document_id` on the run DTO and `GET /runs?doc=`.
  const docRuns = new DocRunIndex(docLedgerSources, { log: (m) => app.log.warn(m) });

  // The interactive relay seam (DES-MERGE-001 §5.4/§6.1, slice 3): every wicked.interactive.**
  // bus event becomes an `interactiveEvent` frame on the SAME /ws socket the studio already
  // holds, and POST /projects/:id/interactive-events puts a whitelisted UI event back on the bus.
  // Default ON — the merged skin needs it to render a generating doc — with the seam's usual
  // posture: a machine without wicked-bus gets a logged null and boots anyway.
  const interactiveRelay =
    options?.interactiveWsRelay?.disabled === true
      ? null
      : await startInteractiveWsRelay({
          ...busOf(options?.interactiveWsRelay?.dbPath),
          ...(options?.interactiveWsRelay?.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.interactiveWsRelay.pollIntervalMs }
            : {}),
          log: (m) => app.log.warn(m),
          logError: (m) => app.log.error(m),
          // crew#338 — a retirement that bypassed the governed DELETE route (direct bridge call,
          // another tool) still drops the doc's ledger rows. Idempotent, so overlapping with the
          // route's own synchronous sweep is harmless.
          onDocRetired: (documentId, projectId) => {
            const sweep = dropDocLedgerRows(documentId, projectId);
            if (sweep.removed_keys.length > 0) {
              app.log.info(
                `[interactive] doc.retired(${documentId}): dropped handoff-ledger row(s) ${sweep.removed_keys.join(', ')}`,
              );
            }
            if (!sweep.ok) {
              app.log.warn(
                `[interactive] doc.retired(${documentId}): ledger sweep failed for ${(sweep.errors ?? [])
                  .map((e) => `${e.ledger} (${e.error})`)
                  .join(', ')} — stale rows may shadow the name; DELETE the doc via the API to retry`,
              );
            }
          },
        });
  if (interactiveRelay !== null) {
    app.log.info('interactive /ws relay armed (filter wicked.interactive.** → interactiveEvent)');
    app.addHook('onClose', async () => {
      await interactiveRelay.stop();
    });
  }

  // The team relay (DES-TEAMING-002 §4.5): every team row the engine publishes becomes a
  // `teamEvent` frame on the same /ws socket, tagged with the run's project. Only where the engine
  // has a bus: no bus, no team rows.
  const teamBusDb = engineBusDb;
  const teamRelay =
    options?.teamWsRelay?.disabled === true || teamBusDb === undefined
      ? null
      : await startTeamWsRelay({
          dbPath: teamBusDb,
          projectOf: (runId) => membershipIndex.projectOf(runId),
          // Standing orders (behaviour 10) read the same team rows: a finding can wake the operator.
          // ASK-C2: the ask relay reads them too (path.started → the PA; step.completed → the
          // reply's text source).
          broadcast: (frame) => {
            broadcast(frame);
            void standingOrderEvaluator?.onTeamFrame(frame);
            askRelay.onTeamRow((frame as unknown as { event?: BusEvent }).event);
          },
          ...(options?.teamWsRelay?.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.teamWsRelay.pollIntervalMs }
            : {}),
          log: (m) => app.log.warn(m),
        });
  if (teamRelay !== null) {
    app.log.info('team /ws relay armed (team rows → teamEvent)');
    app.addHook('onClose', async () => {
      await teamRelay.stop();
    });
  }

  // The watch registry (DES-TRIGGER-REGISTRY-001, TR-W5a). Advisory by construction: it is handed
  // no gate, reassign or policy dependency (tests/watch-no-authority.test.ts). It arms in the
  // background (the boot replay re-reads each live run's events); until then, and without a bus,
  // `GET /watch/health` says why it is not watching.
  if (options?.watch?.disabled !== true) {
    const registry = new WatchRegistry({
      dbPath: engineBusDb,
      ...(options?.watch?.entriesDir !== undefined ? { entriesDir: options.watch.entriesDir } : {}),
      settings: async () => (await adapter.getSettings()).watch,
      projectOf: (runId) => membershipIndex.projectOf(runId),
      liveRuns: async () =>
        (await adapter.sessionsDetail())
          .filter((v) => !['completed', 'cancelled', 'failed'].includes(v.session.status))
          .map((v) => v.session.id),
      runEvents: (runId) => adapter.runEvents(runId),
      // TR-W6 `warned_rule`: the fired rule ids are classified against the daemon's own steering
      // store (effect: warn), read on a cadence by the registry — never per frame.
      rules: () => adapter.listConformanceRules(),
      // WT-W4 discovery: the project view the two discovery entries count over (the run's plan rows on
      // the bus, the recorder's seal, the ledger's attributed test verdict), read per project on a
      // cadence with a deadline — never per frame. Proposals go to the review queue below; nothing lands.
      discovery: makeDiscoverySource({
        dbPath: engineBusDb,
        runsOf: (projectId) => membershipIndex.runsOf(projectId),
        sessions: () => adapter.sessionsDetail(),
        runEvents: (runId) => adapter.runEvents(runId),
        workOutput: (unitId) => adapter.workOutput(unitId),
        repos: () => adapter.listRepos(),
      }),
      broadcast: (frame) => broadcast(frame),
      auditEmitFailed: (detail) => {
        audit.record('watch.emit.failed', { id: 'watch-registry', kind: 'system', trust: 'admin' }, { detail });
      },
      // A proposal row goes to the existing review queue, never self-applied (§4.11). The check
      // names the queue item in `facts.proposal` ({kind_type, payload, facets?}).
      submitProposal: async (finding) => {
        const proposal = finding.facts['proposal'] as
          | { kind_type?: unknown; payload?: unknown; facets?: unknown }
          | undefined;
        if (typeof proposal?.kind_type !== 'string' || typeof proposal.payload !== 'object' || proposal.payload === null) {
          throw new Error('a proposal row must carry facts.proposal {kind_type, payload}');
        }
        await callEstateTool('proposal.submit', {
          kind_type: proposal.kind_type,
          payload: { ...(proposal.payload as Record<string, unknown>), source: `watch:${finding.watch_id}` },
          facets: typeof proposal.facets === 'object' && proposal.facets !== null ? proposal.facets : {},
        });
      },
      log: (m) => app.log.warn(m),
      ...(options?.watch?.pollIntervalMs !== undefined ? { pollIntervalMs: options.watch.pollIntervalMs } : {}),
      ...(options?.watch?.flushMs !== undefined ? { flushMs: options.watch.flushMs } : {}),
      ...(options?.watch?.tickMs !== undefined ? { tickMs: options.watch.tickMs } : {}),
    });
    watchRegistry = registry;
    const arming = registry
      .arm()
      .then(() => {
        if (registry.armed) app.log.info('watch registry armed (watch rows → watchEvent)');
      })
      .catch((err) => app.log.warn(`[watch] arm failed: ${String(err)}`));
    app.addHook('onClose', async () => {
      await arming;
      await registry.stop();
    });
  }
  registerWatchRoutes(app, {
    registry: () => watchRegistry,
    audit,
    // crew#828: the run's own status (and, once it has ended, its recorded event count).
    runFacts: async (runId) => {
      const view = (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
      if (view === undefined) return null;
      const ended = ['completed', 'failed', 'cancelled'].includes(String(view.session.status));
      if (!ended) return { ended, events: null };
      const events = await adapter.runEvents(runId).catch(() => null);
      return { ended, events: events === null ? null : events.length };
    },
  });

  /** The post-commit half of a project-FILED launch, shared with the launch route (§2.2/§4):
   *  the engine already attached the crew.run membership atomically with the launch — here we
   *  tag future /ws frames and announce the attach on the project bus. */
  const fileRun = (runId: string, projectId: string): void => {
    membershipIndex.set(runId, projectId);
    projectBus?.emit(
      MEMBERSHIP_ATTACHED,
      // A daemon-internal launcher (the interactive-edit/draft subscribers),
      // not an HTTP caller — the id is set server-side, so it stays honest
      // under the task #88 rule that event actors are never caller-supplied.
      { project_id: projectId, member: { kind: 'crew.run', ref: runId }, actor: 'interactive' },
      membershipAttachedKey(projectId, 'crew.run', runId, Date.now()),
    );
  };

  // crew#552: a completed onboarding run chains capture-learnings for its repo (one at a time).
  const onboardingCapture = new OnboardingCaptureChain({
    adapter,
    runTimingIndex,
    audit,
    projectOf: (runId) => membershipIndex.projectOf(runId),
    projectAutoCapture: (projectId) => projectSettings.get(projectId).autoCapture ?? undefined,
    fileRun: (runId, projectId) => {
      membershipIndex.set(runId, projectId);
      projectBus?.emit(
        MEMBERSHIP_ATTACHED,
        { project_id: projectId, member: { kind: 'crew.run', ref: runId }, actor: 'onboarding' },
        membershipAttachedKey(projectId, 'crew.run', runId, Date.now()),
      );
    },
    broadcast: (frame) => broadcast(frame),
    log: (m) => app.log.info(m),
  });

  /** The docs root a project's interactive docs live under — the SAME per-project resolution
   *  the project routes and the interactive proxy use (DES-MERGE-001 §7.1/§7.2; partitioned
   *  per project since crew#472, with an event that carries no `project_id` belonging to
   *  Unfiled). Shared by the edit seam (demo-kind gate) and the chat seam. The partition is containment-checked on
   *  REAL paths here exactly as the routes check it (crew#474 — one walk, `bridge-root.ts`):
   *  a symlinked `projects/<id>` throws `InteractivePartitionRefusedError` into the seam's
   *  handler (logged by its `onError`, the event unanswered — fail closed) instead of being
   *  followed into another project's docs; the seams only READ under a root the routes
   *  materialized, so a missing partition is returned as spelled and nothing is created. */
  const interactiveDocsRoot = (projectId: string | undefined): string =>
    resolveProjectInteractiveRoot(projectId, projectId !== undefined ? projectSettings.get(projectId) : null);

  // ── A STUB ENGINE NEVER ANSWERS ANOTHER PRODUCT'S TRAFFIC (crew#309) ────────────────────────
  //
  // The four seams below are ANSWERERS: each taps the bus (core/bus.ts) and replies
  // to wicked-interactive's events by LAUNCHING A GOVERNED RUN. Under `serve --stub` the engine is
  // `Core.spawnStub` — a `StubDispatcher` (every seat votes for the first roster option, no
  // subprocess) plus a `StubStepRunner` (fixed text, no CLI) — so such a run resolves every phase
  // Ok in under a millisecond and narrates the entire governed lifecycle onto interactive's
  // vocabulary: "Convening a 6-seat council…", "Council picked claude for outline…", "Gate
  // approved outline — moving on…", "Gate approved the draft…". Nothing ran. Nothing was written.
  // Two gate approvals were announced anyway.
  //
  // Worse than fabricating locally (until crew#679 moved the seams to in-memory taps): the durable
  // cursor was keyed by PLUGIN NAME
  // (`wicked-crew-interactive-draft`), so on the shared bus a stub daemon and the production
  // daemon are ONE consumer group — a frame claimed by the stub is a frame the real daemon never
  // sees. That is what wicked-crew#309 recorded: bus rows 242632–242643 carry a complete draft
  // narration ending in a gate approval, 52ms wide, whose run id
  // (3c106511-6340-4465-b029-30cb5b004416) appears in NO store, NO event log and NO audit trail on
  // the daemon the operator was watching — `GET /runs/:id` 404s on a run the bus says was
  // gate-approved. Both units were assigned the same first-roster seat (`claude`) within 1ms of
  // convening, which is the StubDispatcher's signature; the real runs 5 minutes later took ~95s to
  // vote and split their seats (`pi` for outline, `claude` for draft).
  //
  // So: refuse to arm, loudly. The deny is scoped to the ANSWERERS on purpose — the project seam
  // only relays, neither launches work nor
  // narrates governance, so neither can fabricate a verdict. Offline/deterministic runs are NOT
  // lost by this: every harness in `e2e/` already does the correct thing, keeping the REAL engine
  // (`stub: false`) and registering a scripted stub SEAT in the roster — which exercises planning,
  // dispatch, gates and the durable event log for real and simply pins what the worker returns.
  const stubEngine = adapter.stub === true;
  const refuseStubSeam = (seam: string): boolean => {
    if (!stubEngine) return false;
    app.log.warn(
      `${seam} subscription REFUSED: this daemon runs the deterministic stub engine (--stub), ` +
        `whose runs complete every phase instantly with no CLI and no artifact. Answering ` +
        `wicked-interactive on the bus would narrate a full governed lifecycle — gate approvals ` +
        `included — for work that never happened, and would take the frame away from the ` +
        `production daemon sharing this bus (crew#309). Run without --stub to answer, or keep the ` +
        `real engine and register a scripted stub SEAT for a deterministic run.`,
    );
    return true;
  };

  // Arm the opt-in interactive-draft answering seam (task #86 spike). Same posture as the QE
  // seam: failure to arm is LOUD but non-fatal — interactive's assist loop is the fallback
  // answerer, and this daemon must boot on a machine whose bus is broken. The handle is kept
  // (declared above, beside the ledger sweep): the chat seam below consults its in-flight docs
  // (CREW-UX-5 per-doc serialization).
  if (options?.interactiveDraftEvents?.enabled === true && !refuseStubSeam('interactive-draft')) {
    const o = options.interactiveDraftEvents;
    draftSub = await startInteractiveDraftSubscriber(adapter, {
      ...busOf(o.dbPath),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.draftDir !== undefined ? { draftDir: o.draftDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      // The roster WITH standing when no override is set (F-RECON-002/003).
      roster: rosterWithStanding,
      // The draft skill the preset runs (draft-skill.ts): asked once, for the arm log line (crew#935).
      skillHeld,
      onRunFiled: fileRun,
      onRunLaunched: (runId, detail) => { recordRunLaunched(audit, runTimingIndex, DAEMON_ACTOR, runId, detail); },
      // F-046: the create-time grounding sidecar is read under the SAME per-project docs root the
      // proxy recorded it in.
      groundingStore: docGrounding,
      resolveDocsRoot: o.resolveDocsRoot ?? interactiveDocsRoot,
      log: (m) => app.log.warn(m),
      logError: (m) => app.log.error(m),
    });
    if (draftSub !== null) {
      const sub = draftSub;
      app.log.info('interactive-draft subscription armed (filter wicked.interactive.doc.created)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // Arm the opt-in interactive STRUCTURAL-edit answering seam (task #86 final leg). Same
  // posture as the draft seam: failure to arm is LOUD but non-fatal — interactive's assist
  // loop is the fallback answerer, and this daemon must boot on a machine whose bus is broken.
  if (options?.interactiveEditEvents?.enabled === true && !refuseStubSeam('interactive-edit')) {
    const o = options.interactiveEditEvents;
    editSub = await startInteractiveEditSubscriber(adapter, {
      ...busOf(o.dbPath),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.editDir !== undefined ? { editDir: o.editDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      // The roster WITH standing when no override is set (F-RECON-002/003).
      roster: rosterWithStanding,
      // The draft skill the preset runs (draft-skill.ts): asked once, for the arm log line (crew#935).
      skillHeld,
      // The demo-kind gate: a demo doc's step feedback is declined with an honest error status
      // (demos are made by the Demo experience's `demo` preset now, studio#373).
      resolveDocsRoot: o.resolveDocsRoot ?? interactiveDocsRoot,
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
      logError: (m) => app.log.error(m),
    });
    if (editSub !== null) {
      const sub = editSub;
      app.log.info('interactive-edit subscription armed (filter wicked.interactive.feedback.processed)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // ONE interactive bridge pool per daemon (two pools over one docs root would race each other
  // into starting duplicate bridges): built here so the theme seam below and the proxy routes
  // share it. The origin is read LAZILY off the bound server (#298); the bus dir is the daemon's.
  const interactiveBridges = new InteractiveBridgePool({
    log: (m) => app.log.warn(m),
    debug: (m) => app.log.debug(m),
    studioOrigin: () => boundOrigin(app.server.address()),
    busDataDir: options?.interactiveBridge?.busDataDir ?? null,
  });

  // EP-C4: theme learning. Shares the edit seam's ledger instance (one file, one writer) and its
  // handoff root; writes the validated tokens through the doc's bridge.
  if (options?.interactiveThemeEvents?.enabled === true && !refuseStubSeam('interactive-theme')) {
    const o = options.interactiveThemeEvents;
    const resolveDocsRoot = o.resolveDocsRoot ?? interactiveDocsRoot;
    themeSub = await startInteractiveThemeSubscriber(adapter, {
      ...busOf(o.dbPath),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      ...(editSub !== null ? { ledger: editSub.ledger } : {}),
      roster: rosterWithStanding,
      putLearnedTheme: putLearnedThemeViaBridge(interactiveBridges, resolveDocsRoot),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
      logError: (m) => app.log.error(m),
    });
    if (themeSub !== null) {
      const sub = themeSub;
      app.log.info('interactive-theme subscription armed (filter wicked.interactive.theme.learned)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // EP-C2: document reviews. Shares the edit seam's ledger instance and handoff root; reads the
  // version under review through the doc's bridge; keeps the document's authors (the creator seats
  // of its draft, edit and chat runs) out of the review.
  if (options?.interactiveReviewEvents?.enabled === true && !refuseStubSeam('interactive-review')) {
    const o = options.interactiveReviewEvents;
    const resolveDocsRoot = o.resolveDocsRoot ?? interactiveDocsRoot;
    reviewSub = await startInteractiveReviewSubscriber(adapter, {
      ...busOf(o.dbPath),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      ...(editSub !== null ? { ledger: editSub.ledger } : {}),
      ...(options?.interactiveEditEvents?.ledgerPath !== undefined ? { ledgerPath: options.interactiveEditEvents.ledgerPath } : {}),
      ...(options?.interactiveEditEvents?.editDir !== undefined ? { editDir: options.interactiveEditEvents.editDir } : {}),
      roster: rosterWithStanding,
      readDocVersion: readDocVersionViaBridge(interactiveBridges, resolveDocsRoot),
      authoringRuns: (documentId, version) => authoringRunsFromLedgers(docLedgerSources(), documentId, version),
      skillHeld,
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
      logError: (m) => app.log.error(m),
    });
    if (reviewSub !== null) {
      const sub = reviewSub;
      app.log.info('interactive-review subscription armed (filter wicked.interactive.review.requested)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // Arm the opt-in interactive CHAT answering seam (CREW-UX-5 — the iteration ask). Same
  // posture again: failure to arm is LOUD but non-fatal. Armed AFTER the sibling seams so the
  // per-doc serialization contract (no draft/edit/chat run races another on one doc) can
  // consult their in-flight sets; docs roots resolve through the SAME per-project settings
  // store the project routes and the interactive proxy share.
  if (options?.interactiveChatEvents?.enabled === true && !refuseStubSeam('interactive-chat')) {
    const o = options.interactiveChatEvents;
    chatSub = await startInteractiveChatSubscriber(adapter, {
      ...busOf(o.dbPath),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.chatDir !== undefined ? { chatDir: o.chatDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      // The roster WITH standing when no override is set (F-RECON-002/003).
      roster: rosterWithStanding,
      // The draft skill the preset runs (draft-skill.ts): asked once, for the arm log line (crew#935).
      skillHeld,
      ...(o.queueSweepMs !== undefined ? { queueSweepMs: o.queueSweepMs } : {}),
      ...(o.landingGateMs !== undefined ? { landingGateMs: o.landingGateMs } : {}),
      resolveDocsRoot: o.resolveDocsRoot ?? interactiveDocsRoot,
      isDocBusy: (documentId) =>
        (draftSub?.inFlightDocs().includes(documentId) ?? false) ||
        (editSub?.inFlightDocs().includes(documentId) ?? false),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
      logError: (m) => app.log.error(m),
    });
    if (chatSub !== null) {
      const sub = chatSub;
      app.log.info('interactive-chat subscription armed (filter wicked.interactive.chat.posted)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // The worker stall watchdog (crew#287 detection + crew#341 escalation, armed by default
  // since perf#4). Built BEFORE the single CoreEvent subscription below so every relayed frame
  // stamps its run's liveness clock; armed (sweep interval) further down beside the seat-health
  // probe, under the same test-runner gate. Detection's sole outputs are one synthetic
  // `workerStalled` /ws frame per quiet period and a warn log; the escalation stage (default
  // `workerStallEscalateMinutes` 30 — an explicit 0 disarms) recycles the wedged cursor unit
  // (`adapter.reassignUnit`, routed to a DIFFERENT seat from the run's pool when one exists) or
  // fail-louds, reports on a `workerStallEscalated` frame, and audits `run.stall.escalated`.
  const stallWatchdog = new WorkerStallWatchdog({
    listExecuting: async () =>
      (await adapter.sessionsDetail())
        .filter((v) => v.session.status === 'executing')
        .map((v) => {
          // The CURSOR unit (shared with the manual reassign route, `core/cursor.ts`): its
          // `ord` is what `reassignUnit` validates against, and its seat is what a reassign
          // moves away from. `seats` is the run's own pool (`session.clis`) — the failover
          // candidates. Views with no units (older engines, stub adapters) keep the historical
          // `unit_ix` fallback.
          const cursor = resolveCursorUnit(v);
          // Evaluator ≠ creator across a failover: an EVALUATOR cursor avoids the seats that
          // built the work it reviews (DES-L3 PR-3E), a CREATOR cursor avoids the run's
          // evaluator seats (crew#638), and a unit the engine routed `evaluator_distinct`
          // avoids the seat it was routed away from (crew#583). A free-text unit carries no role
          // and no such routing → no constraint.
          const seatsOfRole = (role: string): string[] =>
            v.units
              .filter((u) => (u as { role?: unknown }).role === role && u.assigned_cli != null)
              .map((u) => u.assigned_cli as string);
          const cursorUnit = cursor === undefined ? undefined : v.units.find((u) => u.ord === cursor.ord);
          const routing = cursorUnit?.routing;
          const avoid = [
            ...new Set([
              ...(cursor?.role === 'evaluator' ? seatsOfRole('creator') : []),
              ...(cursor?.role === 'creator' ? seatsOfRole('evaluator') : []),
              ...(routing?.method === 'evaluator_distinct' ? [routing.was] : []),
            ]),
          ].filter((s) => s !== cursor?.cli);
          return {
            id: v.session.id,
            ord: cursor?.ord ?? v.session.unit_ix,
            ...(cursor?.cli !== undefined ? { cli: cursor.cli } : {}),
            ...(Array.isArray(v.session.clis) ? { seats: v.session.clis } : {}),
            ...(avoid.length > 0 ? { avoid } : {}),
            // crew#833: the seats THIS RUN benched (`benched_seats`, engine ≥ wave 6) are never a
            // failover target — the run already failed over away from them on the same error.
            ...(Array.isArray(v.session.benched_seats) && v.session.benched_seats.length > 0
              ? { benched: v.session.benched_seats.map((b) => ({ cli: b.cli, reason: b.reason })) }
              : {}),
            // crew #580 / #581: a tool cursor is notified about, never reassigned.
            ...(cursor !== undefined ? { executor: cursor.executor } : {}),
          };
        }),
    broadcast: (frame) => broadcast(frame),
    stallMinutes: async () =>
      options?.stallWatchdog?.stallMinutes ??
      (await adapter.getSettings()).workerStallMinutes ??
      DEFAULT_WORKER_STALL_MINUTES,
    escalation: {
      // Resolved per sweep so a PUT /settings change arms/disarms/retunes live. Test overrides
      // bypass the settings read field-by-field, same convention as `stallMinutes` above.
      // `minutes` falls back to the perf#4 default (armed at 30) the same way `stallMinutes`
      // falls back above — a stored explicit 0 still reads as OFF.
      config: async () => {
        const o = options?.stallWatchdog;
        const settings = await adapter.getSettings();
        return {
          minutes:
            o?.escalateMinutes ??
            settings.workerStallEscalateMinutes ??
            DEFAULT_WORKER_STALL_ESCALATE_MINUTES,
          action: o?.escalateAction ?? settings.workerStallEscalateAction,
          maxPerRun: o?.maxEscalations ?? settings.workerStallMaxEscalations,
        };
      },
      // The watchdog passes its failover TARGET (perf#4: a different seat from the run's pool
      // when one is available, else the current seat recycled in place); null lets the engine
      // re-run the council.
      reassign: async (runId, ord, cli) => {
        await adapter.reassignUnit(runId, ord, cli ?? null);
      },
      // An automated actor touching a run is a privileged action exactly like an operator
      // doing it — one audit line per escalation, needs-you or not (task #88 posture).
    },
    // wicked-studio#284: every frame the watchdog broadcasts is RECORDED here — the escalation line
    // crew#341 already wrote (`run.stall.escalated`, spelling unchanged) and now the detection line
    // too — and remembered in the index the events route serves. The trail is what survives the run
    // leaving the executing listing and this process exiting; the index is the read-side latency
    // layer, stamped with the entry's OWN ts so live and post-restart answers are the same instant.
    onFrame: (frame) => {
      const { type, session, ...detail } = frame;
      void type; // `stallFrameAction` names the action from it; the tag would only duplicate it
      const ts = audit.record(stallFrameAction(frame), STALL_WATCHDOG_ACTOR, {
        runId: session,
        detail,
      });
      stallFrameIndex.record(frame, ts);
      // The watch registry's watchdog source (§4.6): an O(1) push, never awaited.
      watchRegistry?.offerWatchdog(frame as unknown as { type: string; session?: string } & Record<string, unknown>);
    },
    // The engine's own turn ceiling fired (`stepStatus: "timed_out"`, perf#4) — audit it as
    // what it is, distinct from an operator cancel. Never sent by older engines; the ambiguous
    // "cancelled" spelling deliberately triggers nothing (fail SAFE toward notify-only).
    onTurnTimeout: ({ session, ...detail }) => {
      audit.record(
        'run.turn.timedout',
        { id: 'stall-watchdog', kind: 'system', trust: 'admin' },
        { runId: session, detail },
      );
    },
    // crew#629: a unit whose own processes are working (a test runner, a build) is not silent.
    ...(options?.stallWatchdog?.busy === null
      ? {}
      : {
          busy:
            options?.stallWatchdog?.busy ??
            ((sampler) => (runIds: string[]) => sampler.busy(runIds))(new RunLivenessSampler()),
        }),
    log: (m) => app.log.warn(m),
  });

  // The daemon's single CoreEvent subscription fans out here: cache gate prompts
  // (§3.3), cache elicitation prompts (DES-002), route terminal frames to their owning
  // per-terminal socket (by id, DES-TERMINAL-001 §6), then forward every frame — tagged
  // with its run's `project_id` when the membership table files it (DES-PROJECT-001
  // §5.2; no new socket, additive field) — to all `/ws` clients (§2.1).
  //
  // Unregistered on close: a process can build more than one server over the same
  // adapter (tests do), and a closed server's caches must stop consuming events —
  // otherwise every discarded server keeps folding state forever (listener leak).
  const stallWatchdogArmed =
    options?.stallWatchdog?.enabled ??
    !(process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test');
  // Chat scopes (crew#502): the routes record one per open; the engine's own reclaims (idle TTL,
  // pool cap) and operator closes all surface as `chatClosed`, which frees the id here — removing
  // the scratch root of an engine-side reap, finishing a `DELETE`'s closing window, or cancelling
  // an open still in flight (the index is a small state machine; see `chat-scope.ts`).
  const chatScopes = new ChatScopeIndex();
  // Chat turns (F-RECON-017): which seats are mid-turn in which chat, folded from the same
  // CoreEvent stream below; `POST /chats/:id/messages` refuses a send to a busy seat and the
  // chat frames leave here stamped with the `turn_id` they answer.
  const chatTurns = new ChatTurnIndex();
  // ASK-C2 (DES-ASK-TEAM-CHAT-001 §5.2): the ask relay — the answer unit's deltas as chatDelta, the
  // step.completed row's output as the chatReply, both fed back through the fold below so the turn
  // index stamps them and the transcript/recorder/citations/ws consumers are unchanged.
  const askRelay = new AskRelay({
    paths: askPaths,
    turns: chatTurns,
    workOutput: (unitId) => adapter.workOutput(unitId),
    units: async (runId) => {
      const view = (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
      return (view?.units ?? []).map((u) => {
        const la = (u as { last_attempt?: unknown }).last_attempt;
        return {
          id: u.id,
          ord: u.ord,
          status: String(u.status),
          assigned_cli: u.assigned_cli ?? null,
          ...(typeof la === 'number' ? { last_attempt: la } : {}),
        };
      });
    },
    fold: (frame) => onEngineEvent(frame),
    recorderReconcile: (chat, turnId, seats) => chatDecisionRecorder?.reconcile(chat, turnId, seats),
    log: (m) => app.log.warn(m),
  });
  // Chat transcripts at rest (DES-L5, D-13): one JSONL per LIVE chat under `<state home>/chats/`,
  // written from the stamped frames below, dropped with the chat on `chatClosed`, served on
  // `GET /chats/:id.messages`.
  const chatTranscripts = new ChatTranscriptStore();
  // Chat citations (crew#561, F-RC1-117): what the seat CITED, checked against the very read roots
  // the daemon handed it. Runs off the reply's own path — after the broadcast below — and publishes
  // one `chatCitations` frame per reply; the seat's text is never edited.
  const citationsDisabled = options?.chatCitations?.disabled === true;
  const citationDeps = options?.chatCitations?.deps ?? chatCitationDeps();
  const citationLimits = options?.chatCitations?.limits;
  async function verifyReplyCitations(frame: CoreEvent, projectId: string | undefined): Promise<void> {
    const f = frame as CoreEvent & Record<string, unknown>;
    const chatId = typeof f['chat'] === 'string' ? f['chat'] : undefined;
    const cliKey = typeof f['cliKey'] === 'string' ? f['cliKey'] : undefined;
    const text = typeof f['text'] === 'string' ? f['text'] : '';
    // A NOT-ok reply is the daemon's/engine's own reason line (an eviction, a refusal): it cites
    // nothing the reader would paste, so it is not verified — and never marked.
    if (chatId === undefined || cliKey === undefined || text === '' || f['ok'] === false) return;
    const scope = chatScopes.get(chatId);
    // No scope (a chat this daemon did not open, or `kind: 'none'`/`system`) ⇒ nothing to verify
    // AGAINST. Saying "unverified" then would blame the seat for the daemon's missing roots. A
    // `[rule:<id>]` citation (DC-S7) needs no root, so a root-less chat still gets those marked.
    if (scope === undefined || (scope.repos.length === 0 && !text.includes('[rule:'))) return;
    const roots = scope.repos.map((r) => ({ absRoot: resolvePath(r.rootPath), name: r.name }));
    const turnId = typeof f['turn_id'] === 'string' ? f['turn_id'] : undefined;
    // A chat is filed by its CHAT id (`crew.chat` membership), so the project of a chat frame is
    // looked up by that — the run-keyed lookup on the relay above answers `undefined` for chats.
    const project = projectId ?? membershipIndex.projectOf(chatId);
    try {
      // DC-S7: the in-force rule ids for the chat's project (null = not readable → rule citations stay unchecked).
      const ruleIds = considerations !== null ? await considerations.inForceIds(project ?? null) : null;
      const result = await verifyCitations(text, roots, citationDeps, { ...citationLimits, ruleIds });
      const out = citationsFrame(
        {
          chat: chatId,
          cliKey,
          ...(turnId !== undefined ? { turn_id: turnId } : {}),
          ...(project !== undefined ? { project_id: project } : {}),
        },
        result,
      );
      if (out !== null) {
        broadcast(out as unknown as CoreEvent);
        // ...and into the transcript, so a reload still shows the marks (api-types 0.68.0): the
        // verdicts are their own append-only record, folded onto their reply by the reader.
        chatTranscripts.recordCitations(out);
      }
    } catch (err: unknown) {
      // Loud-non-fatal: a reply is never held hostage to its own verification.
      app.log.warn(
        `[chat] citation verification failed for ${chatId}/${cliKey}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // crew#619: see declaration of chatRetained/runToChat above (before the hydration block).
  // linkChatRun populates both maps and is called from the hydration block (function-hoisted)
  // and from the launch route (via RoutesRuntime.linkChatRun).
  function linkChatRun(chatId: string, runId: string): void {
    runToChat.set(runId, chatId);
    const existing = chatRetained.get(chatId);
    if (existing !== undefined) {
      existing.add(runId);
    } else {
      chatRetained.set(chatId, new Set([runId]));
    }
  }
  // Boot reaper (crew#502 hardening, W6): the scratch namespaces of daemons that died without
  // closing their chats (`<tmp>/wicked-crew-chats/<pid>-*` with a dead pid) are removed once, here,
  // under the same real-directory/ownership checks a live close applies. Not under vitest: the
  // suites build many servers and must never touch the developer's real temp namespace.
  if (!(process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test')) {
    const reaped = reapStaleChatNamespaces();
    if (reaped.length > 0) {
      app.log.info(`chat scratch: reaped ${reaped.length} namespace(s) of dead daemons: ${reaped.join(', ')}`);
    }
    // Clear orphaned transcripts at boot. Transcripts for promoted runs that are still
    // non-terminal (rehydrated above into chatRetained) are PRESERVED so Continue-in-Build
    // prefill remains reproducible across a daemon restart (crew#619).
    chatTranscripts.clearOrphaned(new Set(chatRetained.keys()));
  }
  const onEngineEvent = (event: CoreEvent): void => {
    gateCache.ingest(event);
    elicitationCache.ingest(event);
    seatHealth.ingest(event);
    // ASK-C2: a path run's unit + terminal frames become the chat's frames (re-entering this fold
    // as chatDelta / chatReply, which the relay ignores — no recursion).
    if (typeof event.session === 'string') void askRelay.onCoreEvent(event);
    if (event.type === 'chatClosed' && typeof event.chat === 'string') {
      chatScopes.closed(event.chat);
      // DC-S4b: whatever the chat's open turns gathered is recorded now — into the ledger and onto
      // /ws. The transcript's `decisions` record follows the transcript's OWN retention (D-13): a
      // non-retained chat's file is dropped below before this settles, and `recordDecisions` never
      // recreates a gone file; a chat retained for its promoted run keeps the file and gets the
      // record. Nothing a reader could still open is missing it (codex r1, answered).
      void chatDecisionRecorder?.closed(event.chat);
      considerations?.chatClosed(event.chat);
      // crew#619: retain the transcript when a promoted run is still live — the chat may be
      // idle-TTL'd before the run finishes, and Continue-in-Build needs the transcript.
      const retaining = chatRetained.get(event.chat);
      if (retaining === undefined || retaining.size === 0) {
        // ONE mechanism for DELETE / idle / pool_cap alike: the transcript goes with the chat.
        chatTranscripts.drop(event.chat);
      }
    }
    // Stamp BEFORE folding: the closing `chatReply` is the frame most worth correlating — and the
    // one the transcript records (only a stamped reply is persisted; a straggler after the close
    // carries no `turn_id` and cannot recreate the file).
    const stamped = chatTurns.decorate(event);
    // crew#618 Acceptance 1: rewrite the chatReply frame ONCE — before both observe (persist) and
    // broadcast (/ws → studio render/promote). `observe`'s own rewrite pass is then a no-op.
    const rewritten = chatTranscripts.rewriteEvent(stamped);
    chatTranscripts.observe(rewritten);
    // DC-S4b: the seat's `wicked-decisions` block was cut out of the reply above; the recorder takes
    // it (once) and, when every seat of the turn has answered, records the operator's words — off
    // the hot path, never awaited here. A `chatSessionFailed` ends a seat's part with no reply.
    if (rewritten.type === 'chatReply' || rewritten.type === 'chatSessionFailed') {
      const f = rewritten as CoreEvent & Record<string, unknown>;
      const chat = typeof f['chat'] === 'string' ? f['chat'] : undefined;
      const cliKey = typeof f['cliKey'] === 'string' ? f['cliKey'] : undefined;
      if (chat !== undefined && cliKey !== undefined) {
        const block = rewritten.type === 'chatReply' ? chatTranscripts.takeDecisionsBlock(chat, cliKey) : null;
        void chatDecisionRecorder?.onReply({
          chat,
          cliKey,
          ...(typeof f['turn_id'] === 'string' ? { turnId: f['turn_id'] } : {}),
          ok: f['ok'] === true,
          block,
          kind: rewritten.type === 'chatReply' ? 'reply' : 'failed',
        });
      }
    }
    chatTurns.observe(event);
    // Only feed the watchdog when its sweep is (or will be) armed: sweeping is what
    // prunes its per-run maps, so ingesting while disabled grows without bound
    // (Copilot on #301).
    if (stallWatchdogArmed) stallWatchdog.ingest(event);
    terminals.route(event);
    // Skills keystone: a live run pins the snapshot generation it may be reading; its terminal
    // frame releases the pin and reaps generations no other live run holds (design v3 §1).
    skillsRuntime?.observe(event);
    const session = typeof event.session === 'string' ? event.session : undefined;
    const projectId = session !== undefined ? membershipIndex.projectOf(session) : undefined;
    broadcast(projectId !== undefined ? ({ ...rewritten, project_id: projectId } as CoreEvent) : rewritten);
    // crew#561: the citations in that reply, checked against the chat's read roots — AFTER the
    // broadcast (the answer is never delayed by verification) and never awaited on this path.
    if (!citationsDisabled && rewritten.type === 'chatReply') void verifyReplyCitations(rewritten, projectId);
    // Standing orders (behaviour 10): a gate that opened may be one an order answers, holds or
    // reports — after the gate cache folded it, so the order's decision carries the right ord.
    void standingOrderEvaluator?.onEvent(event);
    // The watch registry (TR-W5a, G3): synchronous, O(1), never awaited, never throws.
    watchRegistry?.offer(event);
    // DC-S7: a unit attempt's output landed — what its rules were, and which it cited (one fact per
    // (run, ord, attempt); the read itself answers GET …/considered). Off the hot path.
    if (event.type === 'unitOutputCaptured' && session !== undefined) {
      const ev = event as CoreEvent & { ord?: unknown; unitOrd?: unknown; attempt?: unknown };
      const ord = typeof ev.ord === 'number' ? ev.ord : typeof ev.unitOrd === 'number' ? ev.unitOrd : undefined;
      if (ord !== undefined) void considerations?.onUnitCaptured(session, ord, typeof ev.attempt === 'number' ? ev.attempt : 0);
      // crew#720: the deliver unit's output landed — whatever its verdict, archive the tree now.
      // Only a unit this daemon saw dispatched as crew's deliver script qualifies, so no other
      // unit's capture costs an engine read (the release smoke's mixed-roster timing, S04).
      const key = ord !== undefined ? archiveKey(session, ord) : undefined;
      // A run whose dispatch this daemon never saw (redriven at boot before the subscription opened,
      // codex r1) is checked against its view once: the capture may be its deliver unit's.
      const unseen = !observedRuns.has(session);
      if (key !== undefined && (deliverDispatches.delete(key) || unseen)) {
        observedRuns.add(session);
        void adapter
          .sessionsDetail()
          .then((views) => {
            const view = views.find((v) => v.session.id === session);
            if (view === undefined) return undefined;
            if (unseen && deliverUnitOf(view)?.ord !== ord) return undefined;
            return archiveRunCodebase(session, 'deliver', view);
          })
          .catch(() => undefined);
      }
    }
    if ((event.type === 'unitDispatched' || event.type === 'toolExecutorDispatched') && session !== undefined) {
      if (observedRuns.size > 5000) observedRuns.clear();
      observedRuns.add(session);
    }
    // crew#720: crew's deliver script is recognised by its own refusal marker in the dispatched
    // command (the structural mark `deliverUnitOf` reads, crew#720 S3).
    const dispatched = deliverDispatchKey(event);
    if (dispatched !== null) {
      if (deliverDispatches.size > 1000) deliverDispatches.clear();
      deliverDispatches.add(dispatched);
    }
    // The delivered-PR record (CREW-UX-8, crew#321): resolved once per run at its terminal
    // frame, best-effort, off the hot path — see `resolveRunDelivery` above for why BOTH
    // terminal frames trigger it and why a failed deliver is a no-op. THEN the delivery-
    // derivation cache warms this run (after, so a just-recorded PR URL skips the git pair),
    // healing the DTO's stranded/vacuous/none label in seconds instead of at the next sweep.
    if (
      (event.type === 'sessionCompleted' || event.type === 'sessionFailed' || event.type === 'runCancelled') &&
      session !== undefined
    ) {
      // crew#619: when a run that was linked to a chat terminates, release the retention hold and
      // drop the transcript if the chat was already reclaimed (not in chatScopes).
      const linkedChat = runToChat.get(session);
      if (linkedChat !== undefined) {
        runToChat.delete(session);
        const retaining = chatRetained.get(linkedChat);
        if (retaining !== undefined) {
          retaining.delete(session);
          if (retaining.size === 0) {
            chatRetained.delete(linkedChat);
            if (!chatScopes.has(linkedChat)) {
              chatTranscripts.drop(linkedChat);
            }
          }
        }
      }
      // `ended_at` (crew#496 / studio#230; api-types 0.38.0): the durable record first (`run.ended`),
      // then the index — the `run.delivered` write order. Synchronous, on the frame, so the DTO dates
      // the run the instant it terminals. IDEMPOTENT per run: a resume/retry re-terminal (or any
      // second terminal frame) finds the run already dated and writes nothing; a restart re-reads the
      // trail (newest entry wins) instead of re-emitting. The one hole — a crash between the engine's
      // status write and this record — leaves that run ABSENT, never null (the wire contract).
      if (runTimingIndex.endedAtFor(session) === undefined) {
        const endedTs = audit.record('run.ended', DAEMON_ACTOR, {
          runId: session,
          detail: { status: event.type },
        });
        if (endedTs > 0) runTimingIndex.setEnded(session, endedTs);
      }
      void resolveRunDelivery(session)
        // crew#720: the final-codebase zip, before the sweep below can remove the worktree.
        .then(() => archiveRunCodebase(session, 'run_end'))
        // crew#620 Acceptance 3: sweep the delivered run's worktree once the PR is open.
        // Best-effort — a sweep error must never fail the terminal frame.
        .then(async () => {
          if (deliveryIndex.urlFor(session) !== undefined) {
            try {
              const views = await adapter.sessionsDetail();
              const repoRef = views.find((v) => v.session.id === session)?.session.repo_ref;
              if (repoRef !== null && repoRef !== undefined) {
                const repos = await adapter.listRepos();
                const repoRoot = repos.find((r) => r.id === repoRef)?.root_path;
                if (repoRoot !== undefined) {
                  await sweepDeliveredWorktree(session, repoRoot, (m) => app.log.info(m));
                }
              }
            } catch (err: unknown) {
              app.log.warn(
                `[runs] worktree sweep failed for ${session}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        })
        .then(() => deliveryCache.warm(session))
        // Wave 6 (F-7R2-014): a terminal `qe-author-tests` run registers its TEST SET — the
        // produced tests as the verify phase judged them — AFTER the delivery record resolved, so
        // the set carries the PR URL when the engine's deliver phase opened one. Best-effort:
        // registration never fails the run; a non-qe run is a no-op. `runCancelled` is a terminal
        // frame too (review L-2 of #536): a run the operator cancelled after verify passed still
        // has a set worth showing (`run_status: 'cancelled'`).
        .then(() =>
          registerTestSetForRun(
            {
              adapter,
              audit,
              index: testSets,
              deliveryUrlFor: (runId) => deliveryIndex.urlFor(runId),
              labelFor: (runId) => {
                const attach = groupIndex.attachOf(runId);
                return attach !== undefined && 'label' in attach ? attach.label : undefined;
              },
              log: (m) => app.log.info(m),
            },
            session,
          ),
        )
        .catch((err: unknown) => {
          app.log.warn(
            `[testing] test-set registration for ${session} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
    // A completed ONBOARDING run refreshes the project graph(s) its repo belongs to (F-2R2-008):
    // bounded (plain refresh — unchanged members skip; one project at a time; at most two rounds),
    // off the hot path, logged. Only runs THIS daemon launched are known here, by design.
    // crew#552: an onboarding completion queues its capture; a chained capture's end frees the slot.
    onboardingCapture.onEvent(event);
    if (event.type === 'sessionCompleted' && session !== undefined) {
      const onboardedRepo = adapter.onboardedRepoOf(session);
      if (onboardedRepo !== undefined) {
        void refreshProjectGraphsAfterOnboarding(adapter, onboardedRepo, {
          log: (m) => app.log.info(m),
        }).catch((err: unknown) => {
          app.log.warn(
            `[projects] auto-refresh after onboarding ${onboardedRepo} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
    // The foundation record's evidence pointer (§3.2 row 3): a project-bound run that completes
    // gets its run-scope pointer written, best-effort, off the hot path.
    if (event.type === 'sessionCompleted' && session !== undefined && projectId !== undefined) {
      void (async () => {
        try {
          const views = await adapter.sessionsDetail();
          const view = views.find((v) => v.session.id === session);
          const repoRef = view?.session.repo_ref ?? null;
          const repoRoot =
            repoRef !== null
              ? ((await adapter.listRepos()).find((r) => r.id === repoRef)?.root_path ?? null)
              : null;
          // The STORED scope, not a derived spelling: `Project.scope` is the designed tenancy
          // seam (ADR §3.1 — a future `org:<o>/project:<id>` prefix must not strand pointers).
          const project = await adapter.projectGet(projectId);
          await writeRunEvidencePointer(
            adapter,
            project?.scope ?? `project:${projectId}`,
            session,
            repoRoot,
            (m) => app.log.warn(m),
          );
        } catch (err) {
          app.log.warn(
            `[projects] evidence-pointer lookup for ${session} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })();
    }
  };
  const offEvent = adapter.onEvent(onEngineEvent);
  // Skills keystone (codex round 4): every launch the daemon hands the engine — run, resume, gate
  // answer, campaign — opens a generation pin BEFORE the engine call, released only by the engine's
  // `skillsSnapshotHanded` report or the terminal frame (live-generations.ts). Unregistered on
  // close like the event listener.
  const offLaunch = adapter.onLaunch((notice) => {
    skillsRuntime?.launched(notice);
  });
  app.addHook('onClose', async () => {
    offEvent();
    offLaunch();
  });

  // (The seat-health `--version` recovery probe that armed here is retired — perf recon
  // fix #3; see seat-health.ts. Recovery = the seat's next real `ok` output.)

  // Arm the stall watchdog's sweep (crew#287). ON in the daemon, OFF under a test runner
  // unless a test opts in — a suite building servers over stub adapters must not have a
  // background interval calling `sessionsDetail()` on them.
  const stallCfg = options?.stallWatchdog;
  if (stallWatchdogArmed) {
    stallWatchdog.start(stallCfg?.sweepIntervalMs);
    app.addHook('onClose', async () => {
      stallWatchdog.stop();
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    // Loopback origins are always allowed (the studio on another localhost
    // port). NON-loopback origins are allowed ONLY when auth is required — the
    // R2 pairing: a hosted skin needs CORS, and CORS beyond the machine is
    // safe exactly when every request must carry a bearer token (no ambient
    // credential exists for a foreign page to ride). An explicit allowlist
    // (`allowedOrigins` / WICKED_CREW_ALLOWED_ORIGINS) narrows it further.
    const allowed =
      origin !== undefined &&
      (LOOPBACK_ORIGIN.test(origin) ||
        (auth.mode === 'required' &&
          (auth.allowedOrigins === null || auth.allowedOrigins.includes(origin))));
    if (origin && allowed) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });

  // Tolerate an empty body on application/json POSTs (some actions take no body).
  // Default Fastify v5 rejects "" with FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined || body === null) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      // A syntactically invalid body is the CLIENT's error: without an explicit statusCode
      // Fastify reports a parser error as a 500, which misfiles "you sent `{not json`" as a
      // server fault — on the elicitation answer path that told an operator the daemon broke
      // when their request did. 400 matches Fastify's own default JSON parser
      // (FST_ERR_CTP_INVALID_JSON) and every schema-level 400 these routes already return.
      // The message is a fixed one, never JSON.parse's: V8 quotes the body around the bad token
      // (`Unexpected token 's', ..."{"value": sk-…"... is not valid JSON`), and Fastify both
      // answers and logs it, so an unquoted `PUT /mcp/servers/:name/secret` value would leave the
      // broker in the response and the log (DES-MCP-TOOLS-001 D-2).
      done(Object.assign(new Error('the request body is not valid JSON'), { statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON' }));
    }
  });

  await app.register(fastifyWebsocket);

  // Identity (401) + trust (403) hooks. Ordering is load-bearing twice over:
  // AFTER the CORS hook, so an OPTIONS preflight (which carries no
  // Authorization by design) is answered 204 above and never reaches the token
  // check — and AFTER the websocket plugin, whose own onRequest hook flags
  // upgrade requests (`request.ws`); if auth 401s first, that flag is never
  // set and the plugin's onResponse cleanup skips destroying the raw upgrade
  // socket, which then holds `app.close()` open forever.
  registerAuthHooks(app, auth);

  app.get('/ws', { websocket: true }, (socket) => {
    // Late-join gets no replay; the studio reconciles with a one-shot GET /runs.
    registerClient(socket as unknown as WebSocket);
  });

  // One dedicated WS channel per PTY: /ws/terminals/:id (DES-TERMINAL-001 §6).
  registerTerminalWs(app, adapter, terminals);

  // Resolved HERE (not at the static-serving block below) because the routes need it too:
  // diagnostics reads the bundle's shipped version manifest from the same root the static
  // handler serves. One resolution, two consumers.
  const studioRoot = options?.studioRoot ?? defaultStudioRoot();

  // DES-MCP-TOOLS-001 S2: the registry over `<state home>/mcp` (created on the first save).
  const mcpRegistry = new McpRegistry({
    store: new McpRegistryStore(),
    secrets: platformSecretStore(),
    probe: probeMcpServer,
    // Read the worker home at request time: `PUT /settings` can move it (applyWorkerConfigRoot).
    discover: (managed) => discoverMcpServers({ home: homedir(), workerHome: process.env['WICKED_WORKER_HOME'] ?? null }, managed),
  });
  // S3: every brokered call is judged by the in-process engine (the token registry is the
  // engine's, process-global), recorded to `<state home>/mcp/calls.ndjson`, and published on /ws
  // and the engine's bus. A bus that is not attached only loses the event; the record is the record.
  // S7: the same file (one serialized chain) is what `GET /mcp/usage` reads back and folds.
  const mcpCallRecords = new McpCallRecordFile();
  const mcpBroker = new McpBroker({
    registry: mcpRegistry,
    engine: () => CoreAdapter.mcpEngineGate(),
    records: mcpCallRecords,
    budgetPerUnit: budgetFromEnv(),
    log: (m) => app.log.warn(m),
    publish: async (record) => {
      broadcast({ type: 'mcpCallCompleted', record } as unknown as CoreEvent);
      if (engineBusDb === undefined) return;
      await emitOnBus(engineBusDb, {
        event_type: MCP_CALL_COMPLETED,
        domain: 'wicked-crew',
        subdomain: 'mcp',
        payload: record,
        producer_id: 'wicked-crew',
        idempotency_key: `${MCP_CALL_COMPLETED}:${record.spanId}`,
      });
    },
  });
  const registered = registerRoutes(
    app,
    adapter,
    gateCache,
    elicitationCache,
    {
      bus: projectBus,
      index: membershipIndex,
      log: (m) => app.log.warn(m),
      settings: projectSettings,
    },
    { audit, authMode: auth.mode },
    {
      seatHealth,
      deliveryFreeze,
      // wicked-studio#284: the watchdog's remembered frames ride `GET /runs/:id/events`.
      stallFrames: (runId) => stallFrameIndex.framesFor(runId),
      // The SAME standing accessor the seams and the adapter launch with (F-RECON-002/003).
      rosterWithStanding,
      retryIndex,
      groupIndex,
      runTimingIndex,
      guidanceIndex,
      runSkillGaps,
      chatScopes,
      chatTurns,
      chatTranscripts,
      deliveryIndex,
      // Wave 6: the doc↔run binding (F-4R2-006) and the registered test sets (F-7R2-014).
      docRuns,
      testSets,
      // The delivery machinery built beside the index above: the started cache, and the SAME
      // probe functions it derives through — so the routes' campaign rollup shares one TTL memo
      // with the sweeper instead of re-probing on its own clock.
      deliveryCache,
      // crew#851: the routes await a pending resolution for a view in the completion window.
      deliveryResolver,
      codebaseArchives,
      worktreeExists: vacuityProbes.worktreeExists,
      worktreeIsClean: vacuityProbes.worktreeIsClean,
      runBranchIsEmpty: vacuityProbes.runBranchIsEmpty,
      canDeliver,
      errorRing,
      studioRoot,
      dropDocLedgerRows,
      evalStore,
      // F-043/F-046: the bridge's bus dir and the create-time grounding store reach the proxy.
      interactiveBridgeBusDataDir: options?.interactiveBridge?.busDataDir ?? null,
      // EP-C4: the one pool, shared with the theme seam above.
      interactiveBridges,
      // EP-C2: where the checks read finds a document's recorded reviews.
      docReviewsDir,
      docGrounding,
      // crew#899: a chat's checkouts are brought to their upstream (when clean) before it reads them.
      freshenCheckout: (root: string) => freshenCheckout(root),
      ...(skillsRuntime !== undefined ? { skills: skillsRuntime } : {}),
      // DES-MCP-TOOLS-001 S2: the registry over `<state home>/mcp` (created on the first save).
      // Route tests drive `registerMcpRoutes` over their own registry (tests/mcp-registry.test.ts).
      mcp: mcpRegistry,
      // DES-MCP-TOOLS-001 S3: the broker's call path over that registry.
      mcpBroker,
      // DES-MCP-TOOLS-001 S7: the call records the usage fold reads.
      mcpCalls: mcpCallRecords,
      // wicked-core#411 / crew#497: the live state-home classification the routes report and gate on.
      stateHome: stateHomeWatch,
      // Routes that say something to the thread (a refused chat seat, F-2R2-007) emit through the
      // SAME /ws fan-out the engine's frames take.
      broadcast: (frame) => broadcast(frame),
      // ASK-C1/C2: the ask-path index the routes write and the relay reads.
      askPaths,
      // ASK-C1: DELETE /chats/:id on an ask path closes through the same fold an engine
      // `chatClosed` takes (scope slot, decisions, considerations, retention-aware transcript).
      closeChat: async (frame, runId, ticket) => {
        // End cancels the path's run: its retention hold goes first, so the fold drops the
        // transcript with the chat (a reused id starts empty — codex on #808 r3, 1).
        if (runId !== undefined && typeof frame.chat === 'string') {
          const retaining = chatRetained.get(frame.chat);
          retaining?.delete(runId);
          if (retaining !== undefined && retaining.size === 0) chatRetained.delete(frame.chat);
          runToChat.delete(runId);
          askRelay.forget(runId);
        }
        // The recorder settles the chat's open turns NOW — resolving the project while the index
        // still names this chat's (the id is parked `closing` until the fold below frees it), and
        // writing the transcript's decisions record before the file is dropped. A deferred close
        // could otherwise file the ended chat's words under a replacement's project and append
        // them to its transcript (codex on #808 r4, 1). The fold's own call then finds nothing.
        if (typeof frame.chat === 'string') await chatDecisionRecorder?.closed(frame.chat);
        // The id is held for this close alone (no timer, a second DELETE joined); the fold frees
        // it. Not held any more = settled elsewhere: nothing to fold (codex on #808 r5, 1+2).
        if (typeof frame.chat !== 'string' || !chatScopes.isHeld(frame.chat, ticket)) return;
        chatScopes.closeHeld(frame.chat, ticket);
        onEngineEvent(frame);
      },
      // crew#619: retain a chat's transcript for the lifetime of its promoted run.
      linkChatRun,
      // TR-W5a: the `watch.*` settings guard validates against the registry's entries.
      watchRegistry: () => watchRegistry,
      // DC-S4a: the decision ledger under the state home (registered `decisions`, fenced from
      // workers by core); facts ride the project bus (ids only). WICKED_DECISIONS picks the mode.
      decisionLedger: new DecisionLedger(),
      decisionsEmit: projectBus !== null ? (type, payload, key) => projectBus.emit(type, payload, key) : null,
    },
  );
  // DC-S4a §6: records whose landing a restart interrupted are re-driven, idempotently (the review
  // proposal is keyed by the decision id). Off the boot path; a failure is a logged outcome.
  chatDecisionRecorder = registered.chatRecorder;
  considerations = registered.considerations;
  if (registered.decisions !== null) {
    const decisionsService = registered.decisions;
    decisionsService.track(decisionsService.redrive());
  }

  // Standing orders (Studio OS behaviour 10): the store, the evaluator over THE gate decision path
  // (`registered.decideGate`), and the routes. See src/standing-orders/.
  // The durable record is the audit trail (store.ts): fold it once, here.
  const standingOrders = new StandingOrderStore(audit);
  await standingOrders.hydrate(audit, (m) => app.log.warn(m));
  standingOrderEvaluator = new StandingOrderEvaluator({
    store: standingOrders,
    decideGate: registered.decideGate,
    audit,
    runFacts: async (runId) => {
      const v = (await adapter.sessionsDetail()).find((x) => x.session.id === runId);
      if (v === undefined) return undefined;
      return {
        projectId: runProject(v, runId, (id) => membershipIndex.projectOf(id)),
        band: runBand(v),
        preset: runPreset(v),
        problem: v.session.problem,
        phaseOf: (ord) => v.units.find((u) => u.ord === ord)?.phase_ref ?? undefined,
        firstOrd: v.units.length === 0 ? undefined : Math.min(...v.units.map((u) => u.ord)),
        landsDoctrine: isSteeringAuthorRun(v),
      };
    },
    openGates: async () => {
      if (typeof adapter.interactionRequests !== 'function') return [];
      const rows = (await adapter.interactionRequests(undefined, 'open')) ?? [];
      return rows
        .filter((r) => r.kind === 'gate' && typeof r.ord === 'number')
        .map((r): GateFact => ({
          runId: r.session_id,
          ord: r.ord as number,
          reviewingOrd: r.reviewing_ord,
          gateKind: typeof r['gate_kind'] === 'string' ? r['gate_kind'] : '',
          prompt: r.prompt,
        }));
    },
    // Brainstorm idea 13: a plan-approval trust order re-reads the open plan gate's own band.
    planGate: async (runId) => openPlanGateRisk(await busRows(adapter.busDbPath, runId)),
    log: (m) => app.log.warn(m),
  });
  // The decided-gate history (brainstorm ideas 7 and 8): a seat's track record, and the preview
  // of what a proposed order would have done — read with the evaluator's own phase and invariant.
  registerGateHistoryRoute(app, {
    audit,
    views: () => adapter.sessionsDetail(),
    gateRows: async () =>
      typeof adapter.interactionRequests === 'function' ? ((await adapter.interactionRequests(undefined, undefined)) ?? []) : [],
    projectOf: (id) => membershipIndex.projectOf(id),
    landsDoctrine: isSteeringAuthorRun,
  });
  registerStandingOrderRoutes(app, {
    store: standingOrders,
    evaluator: standingOrderEvaluator,
    parse: seatParser({ adapter, roster: rosterWithStanding }),
  });
  // Orders hydrated from the trail act on gates ALREADY open: one sweep of the engine's open gate
  // rows at boot. It also covers any gate that opened before the evaluator existed (the live
  // subscription above reads it late-bound); every later gate arrives as a live frame.
  void standingOrderEvaluator.sweep().catch((err) => app.log.warn(`[standing-orders] boot sweep failed: ${String(err)}`));
  // crew#471: a campaign the previous daemon left `running` is crash-resumed by the engine (its
  // node runs froze with that process) — asked once, at boot, never for a paused one.
  void resumeRunningCampaigns(adapter, (m) => app.log.warn(m));
  // crew#830: a run the previous daemon left `executing` with no worker is marked `runOrphaned` by
  // the engine at bootstrap (core#124) but never moved — resume every run whose trail ends on that
  // frame, once, and audit it as `run.resumed {via: 'boot'}`; a live run (trail continues) is untouched.
  void resumeOrphanedRuns(adapter, audit, DAEMON_ACTOR, (m) => app.log.warn(m));

  // The UI-emittable direction of the interactive seam. Registered unconditionally (a null relay
  // answers 503, not 404) and BEFORE the static/SPA fallback below, like every other API route.
  registerInteractiveEventRoutes(app, interactiveRelay);

  // crew#741: route registration + index hydration, from the skills seam to here, is `routes`.
  bootClock.lap('routes');
  // Serve the bundled studio SPA same-origin (DES-STUDIO-SERVING-001 §3). The
  // API routes, `/ws`, and terminal WS are registered ABOVE and keep winning:
  // static uses `wildcard: false` (only serves files that physically exist),
  // and the SPA fallback below explicitly excludes `/api/` and `/ws`.
  if (existsSync(studioRoot)) {
    await app.register(fastifyStatic, {
      root: studioRoot,
      // wildcard: true (default) — uses a catch-all route that reads from disk
      // per-request via `send`. wildcard: false globs at startup and registers
      // one explicit route per file, so new hashed filenames after a deploy are
      // invisible until the daemon restarts. Explicit API/WS routes registered
      // above win over the wildcard; files that don't exist on disk 404 → SPA.
      wildcard: true,
      // We own every Cache-Control value via setHeaders (§4.3) — disable the
      // plugin's automatic header so it can't override us.
      cacheControl: false,
      index: ['index.html'],
      // `@fastify/static` v10 hands this callback a FastifyReply; v9 handed it the raw
      // ServerResponse. That is a genuine breaking change, not a typings correction — v10's
      // index.js calls `setHeaders?.(reply, ...)` — so `res.setHeader` becomes `reply.header`.
      setHeaders: (reply, pathName) => {
        const p = pathName.replace(/\\/g, '/');
        if (p.endsWith('/index.html')) {
          // HTML must revalidate so a redeploy's new asset hashes are picked up.
          reply.header('Cache-Control', 'no-cache');
          // EP-C1 (§8.2): the shell says what any frame in it may point at — crew's editors route,
          // crew's interactive proxy, blob: and data:. A self-navigating plugin can reach nothing else.
          reply.header('Content-Security-Policy', shellCsp(requestOrigin(reply.request)));
        } else if (p.includes('/assets/')) {
          // Content-addressed (hashed) assets are immutable.
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // SPA deep-link fallback (§3.2): a GET that is NOT under /api/ or /ws and
    // matched no static file returns the index.html shell (200) so client-side
    // routes resolve. Everything else keeps normal 404/JSON behavior.
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/api/') &&
        !req.url.startsWith('/ws')
      ) {
        reply.header('Cache-Control', 'no-cache');
        reply.header('Content-Security-Policy', shellCsp(requestOrigin(req)));
        // `root` is dist/studio, so the shell is at 'index.html' (not
        // 'studio/index.html'): sendFile resolves relative to root.
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    // Dev / headless run without a built bundle: degrade gracefully (§3.1).
    app.log.warn(
      `studio bundle not found at ${studioRoot} — serving API + WS only (headless)`,
    );
  }
  bootClock.lap('studio');
  app.decorate('bootStages', bootClock);

  return app;
}

export interface StartedServer {
  app: ReturnType<typeof Fastify>;
  port: number;
  host: string;
  /** crew#741: the boot's exclusive per-stage ms (`setup`, `skills`, `venv`, `routes`, `studio`, `listen`). */
  stages: BootStages;
}

/** The URL a worker on this host reaches the daemon at: a wildcard bind is reached on loopback. */
export function brokerUrlFor(host: string, port: number): string {
  const h = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

export async function startServer(
  adapter: CoreAdapter,
  port = 7701,
  host = '127.0.0.1',
  options?: CreateServerOptions,
): Promise<StartedServer> {
  const app = await createServer(adapter, options);
  await app.listen({ port, host });
  const clock = app.bootStages ?? new BootStageClock();
  clock.lap('listen');
  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const boundHost = typeof addr === 'object' && addr ? addr.address : host;
  app.log.info(`wicked-crew daemon listening on ${boundHost}:${boundPort} (boot: ${clock.describe()})`);
  // DES-MCP-TOOLS-001 S1/S3: the in-process engine hands each governed worker this URL (with its
  // `WICKED_MCP_TOKEN`) as `WICKED_CREW_URL`, so the garden shim reaches THIS daemon's broker. The
  // engine reads the daemon's own env at every spawn; a daemon that never listened hands none.
  process.env['WICKED_CREW_URL'] = brokerUrlFor(boundHost, boundPort);
  return { app, port: boundPort, host: boundHost, stages: clock.snapshot() };
}
