import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { registerRoutes } from './routes.js';
import { GateCache } from './gate-cache.js';
import { ElicitationCache } from './elicitation-cache.js';
import { registerAuthHooks, resolveAuth, type AuthOptions } from './auth.js';
import { AuditLog } from './audit.js';
import { RetryIndex } from './retry-index.js';
import { registerClient, broadcast } from '../events/bus.js';
import { TerminalHub, registerTerminalWs } from '../events/terminals.js';
import { QeGateCache, startQeGateSubscriber } from '../qe/gate-events.js';
import { startInteractiveDraftSubscriber } from '../interactive/draft-events.js';
import { startInteractiveEditSubscriber } from '../interactive/edit-events.js';
import { startInteractiveChatSubscriber } from '../interactive/chat-events.js';
import { resolveInteractiveRoot } from '../interactive/bridge-root.js';
import { ProjectSettingsStore } from '../projects/settings.js';
import { startProjectBus, MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import { startInteractiveWsRelay, registerInteractiveEventRoutes } from '../interactive/ws-relay.js';
import { MembershipIndex } from '../projects/membership-index.js';
import { writeRunEvidencePointer } from '../projects/charter.js';
import { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent } from '../core/types.js';
import { SeatHealthTracker, startSeatHealthProbe, type ProbeSeat } from './seat-health.js';
import { WorkerStallWatchdog } from './stall-watchdog.js';
import { applyWorkerConfigRoot } from './seat-signin.js';
import { DEFAULT_WORKER_STALL_MINUTES } from '../core/types.js';

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
   * Opt-in QE gate-event consumption over wicked-bus (Phase 6a). When enabled,
   * a durable subscriber folds `wicked.qe.gate.*` / `wicked.qe.deploy.completed`
   * into the acceptance route's freshness cache; when absent (the default),
   * the route's lazy ledger read stands alone — same answers, read on demand.
   */
  qeGateEvents?: {
    enabled: boolean;
    /** Bus db path; omit for wicked-bus's own default resolution. */
    dbPath?: string;
    /** Poll cadence, ms (tests shorten it). */
    pollIntervalMs?: number;
  };
  /**
   * Opt-in governed answering of wicked-interactive first-draft generation (task #86 spike,
   * Phase 7c). When enabled, a durable subscriber answers `wicked.interactive.doc.created`
   * (kind:source) with a governed `interactive-draft` run that ends in
   * `wicked.interactive.draft.completed`; when absent (the default), interactive's own assist
   * loop remains the answerer and crew never touches that bus traffic.
   */
  interactiveDraftEvents?: {
    enabled: boolean;
    /** Bus db path; omit for wicked-bus's own default resolution (honors WICKED_BUS_DATA_DIR). */
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
    /** Bus db path; omit for wicked-bus's own default resolution (honors WICKED_BUS_DATA_DIR). */
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
  interactiveChatEvents?: {
    enabled: boolean;
    /** Bus db path; omit for wicked-bus's own default resolution (honors WICKED_BUS_DATA_DIR). */
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
    /** Bus db path; omit for wicked-bus's own default resolution (honors WICKED_BUS_DATA_DIR). */
    dbPath?: string;
    /** Poll cadence for the /ws activity bridge, ms (tests shorten it). */
    pollIntervalMs?: number;
  };
  /**
   * DES-MERGE-001 §5.4/§6.1 (slice 3) — the interactive /ws relay. DEFAULT-ON: every
   * wicked.interactive.** bus event is bridged onto the /ws stream as an `interactiveEvent`
   * frame so the studio needs exactly ONE socket. `disabled: true` turns it off (tests).
   */
  interactiveWsRelay?: {
    disabled?: boolean;
    /** Bus db path; omit for wicked-bus's own default resolution. */
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
  /**
   * The seat-health recovery probe (crew#274): every `intervalMs` (default 10 min), INACTIVE
   * seats only, run the seat's `version_probe`; exit 0 flips the seat active again. `enabled`
   * defaults to ON in the daemon and OFF under a test runner (VITEST / NODE_ENV=test), so a
   * test-built server never spawns CLI probes unless it opts in explicitly.
   */
  seatHealthProbe?: {
    enabled?: boolean;
    intervalMs?: number;
    timeoutMs?: number;
  };
  /**
   * The worker stall watchdog (crew#287): DETECTION ONLY. For every run whose engine status is
   * `executing`, the daemon tracks the last CoreEvent observed on its own relay (any frame for
   * that run, `unitOutputDelta` included); silence past `workerStallMinutes` (setting, default
   * 15) broadcasts ONE synthetic `{ type: "workerStalled", session, ord?, quietForMs }` frame
   * on /ws per quiet period and logs at warn. Any new event re-arms. The run is never killed
   * or mutated — the operator decides. `enabled` defaults to ON in the daemon and OFF under a
   * test runner (VITEST / NODE_ENV=test), the seat-health-probe posture.
   */
  stallWatchdog?: {
    enabled?: boolean;
    /** Sweep cadence, ms (default 30 s; tests shorten it). */
    sweepIntervalMs?: number;
    /** Threshold override, minutes — bypasses the settings read (tests). */
    stallMinutes?: number;
  };
}

export async function createServer(
  adapter: CoreAdapter,
  options?: CreateServerOptions,
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });
  const gateCache = new GateCache();
  const elicitationCache = new ElicitationCache();
  const terminals = new TerminalHub();
  const qeGateCache = new QeGateCache();
  // Per-seat runtime health (crew#274): folded from the single CoreEvent subscription below,
  // surfaced on GET /roster, recovered by the low-frequency probe armed further down.
  const seatHealth = new SeatHealthTracker();

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

  // Seat sign-in: export the persisted worker-config root as WICKED_WORKER_HOME at boot (the
  // PUT /settings route re-applies it on every change). The engine reads the env PER SPAWN
  // (acp_runner.rs claude_worker_home), so boot + on-change application is sufficient — no
  // engine restart is ever needed. settings.json is the source of truth: unset/empty deletes
  // the env, restoring the engine default ~/.wicked-worker.
  applyWorkerConfigRoot((await adapter.getSettings()).worker_config_root);

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
  // PATCH land in one while the other keeps serving the stale root.
  const projectSettings = new ProjectSettingsStore();
  // Retry lineage (CREW-UX-3): hydrated from the audit trail — the durable record the launch
  // route writes — so a restarted daemon still echoes `retry_of` on prior runs' DTOs.
  const retryIndex = new RetryIndex();
  await retryIndex.hydrate(audit, (m) => app.log.warn(m));
  const projectBus =
    options?.projectEvents?.disabled === true
      ? null
      : await startProjectBus({
          ...(options?.projectEvents?.dbPath !== undefined
            ? { dbPath: options.projectEvents.dbPath }
            : {}),
          ...(options?.projectEvents?.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.projectEvents.pollIntervalMs }
            : {}),
          log: (m) => app.log.warn(m),
        });
  if (projectBus !== null) {
    app.log.info('project bus seam armed (wicked.crew.project.* + /ws activity bridge)');
    app.addHook('onClose', async () => {
      await projectBus.stop();
    });
  }

  // The interactive relay seam (DES-MERGE-001 §5.4/§6.1, slice 3): every wicked.interactive.**
  // bus event becomes an `interactiveEvent` frame on the SAME /ws socket the studio already
  // holds, and POST /projects/:id/interactive-events puts a whitelisted UI event back on the bus.
  // Default ON — the merged skin needs it to render a generating doc — with the seam's usual
  // posture: a machine without wicked-bus gets a logged null and boots anyway.
  const interactiveRelay =
    options?.interactiveWsRelay?.disabled === true
      ? null
      : await startInteractiveWsRelay({
          ...(options?.interactiveWsRelay?.dbPath !== undefined
            ? { dbPath: options.interactiveWsRelay.dbPath }
            : {}),
          ...(options?.interactiveWsRelay?.pollIntervalMs !== undefined
            ? { pollIntervalMs: options.interactiveWsRelay.pollIntervalMs }
            : {}),
          log: (m) => app.log.warn(m),
        });
  if (interactiveRelay !== null) {
    app.log.info('interactive /ws relay armed (filter wicked.interactive.** → interactiveEvent)');
    app.addHook('onClose', async () => {
      await interactiveRelay.stop();
    });
  }

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

  // Arm the opt-in QE gate-event subscription (crew's bus seam). Failure to
  // arm is LOUD but non-fatal: the acceptance route never depends on the bus.
  if (options?.qeGateEvents?.enabled === true) {
    const { dbPath, pollIntervalMs } = options.qeGateEvents;
    const sub = await startQeGateSubscriber(qeGateCache, {
      ...(dbPath !== undefined ? { dbPath } : {}),
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      log: (m) => app.log.warn(m),
    });
    if (sub !== null) {
      app.log.info(`qe gate-event subscription armed (filter wicked.qe.**)`);
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // Arm the opt-in interactive-draft answering seam (task #86 spike). Same posture as the QE
  // seam: failure to arm is LOUD but non-fatal — interactive's assist loop is the fallback
  // answerer, and this daemon must boot on a machine whose bus is broken. The handle is kept:
  // the chat seam below consults its in-flight docs (CREW-UX-5 per-doc serialization).
  let draftSub: Awaited<ReturnType<typeof startInteractiveDraftSubscriber>> = null;
  if (options?.interactiveDraftEvents?.enabled === true) {
    const o = options.interactiveDraftEvents;
    draftSub = await startInteractiveDraftSubscriber(adapter, {
      ...(o.dbPath !== undefined ? { dbPath: o.dbPath } : {}),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.draftDir !== undefined ? { draftDir: o.draftDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
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
  let editSub: Awaited<ReturnType<typeof startInteractiveEditSubscriber>> = null;
  if (options?.interactiveEditEvents?.enabled === true) {
    const o = options.interactiveEditEvents;
    editSub = await startInteractiveEditSubscriber(adapter, {
      ...(o.dbPath !== undefined ? { dbPath: o.dbPath } : {}),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.editDir !== undefined ? { editDir: o.editDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
    });
    if (editSub !== null) {
      const sub = editSub;
      app.log.info('interactive-edit subscription armed (filter wicked.interactive.feedback.processed)');
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
  if (options?.interactiveChatEvents?.enabled === true) {
    const o = options.interactiveChatEvents;
    const sub = await startInteractiveChatSubscriber(adapter, {
      ...(o.dbPath !== undefined ? { dbPath: o.dbPath } : {}),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.chatDir !== undefined ? { chatDir: o.chatDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      ...(o.queueSweepMs !== undefined ? { queueSweepMs: o.queueSweepMs } : {}),
      ...(o.landingGateMs !== undefined ? { landingGateMs: o.landingGateMs } : {}),
      resolveDocsRoot:
        o.resolveDocsRoot ??
        ((projectId) =>
          resolveInteractiveRoot(projectId !== undefined ? projectSettings.get(projectId) : null)),
      isDocBusy: (documentId) =>
        (draftSub?.inFlightDocs().includes(documentId) ?? false) ||
        (editSub?.inFlightDocs().includes(documentId) ?? false),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
    });
    if (sub !== null) {
      app.log.info('interactive-chat subscription armed (filter wicked.interactive.chat.posted)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // The worker stall watchdog (crew#287). Built BEFORE the single CoreEvent subscription below
  // so every relayed frame stamps its run's liveness clock; armed (sweep interval) further down
  // beside the seat-health probe, under the same test-runner gate. Detection only: its sole
  // outputs are one synthetic `workerStalled` /ws frame per quiet period and a warn log.
  const stallWatchdog = new WorkerStallWatchdog({
    listExecuting: async () =>
      (await adapter.sessionsDetail())
        .filter((v) => v.session.status === 'executing')
        .map((v) => ({ id: v.session.id, ord: v.session.unit_ix })),
    broadcast: (frame) => broadcast(frame),
    stallMinutes: async () =>
      options?.stallWatchdog?.stallMinutes ??
      (await adapter.getSettings()).workerStallMinutes ??
      DEFAULT_WORKER_STALL_MINUTES,
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
  const offEvent = adapter.onEvent((event) => {
    gateCache.ingest(event);
    elicitationCache.ingest(event);
    seatHealth.ingest(event);
    // Only feed the watchdog when its sweep is (or will be) armed: sweeping is what
    // prunes its per-run maps, so ingesting while disabled grows without bound
    // (Copilot on #301).
    if (stallWatchdogArmed) stallWatchdog.ingest(event);
    terminals.route(event);
    const session = typeof event.session === 'string' ? event.session : undefined;
    const projectId = session !== undefined ? membershipIndex.projectOf(session) : undefined;
    broadcast(projectId !== undefined ? ({ ...event, project_id: projectId } as CoreEvent) : event);
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
  });
  app.addHook('onClose', async () => {
    offEvent();
  });

  // The seat-health recovery probe (crew#274 §3). A plain setInterval, unref'd, torn down on
  // close. Default ON in the daemon, OFF under a test runner — a test suite building servers
  // must never spawn `<cli> --version` children unless it opts in with `enabled: true`.
  const probeCfg = options?.seatHealthProbe;
  const underTestRunner =
    process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test';
  if (probeCfg?.enabled ?? !underTestRunner) {
    const probe = startSeatHealthProbe(
      seatHealth,
      () => CoreAdapter.roster() as ProbeSeat[],
      {
        ...(probeCfg?.intervalMs !== undefined ? { intervalMs: probeCfg.intervalMs } : {}),
        ...(probeCfg?.timeoutMs !== undefined ? { timeoutMs: probeCfg.timeoutMs } : {}),
        log: (m) => app.log.warn(m),
      },
    );
    app.addHook('onClose', async () => {
      probe.stop();
    });
  }

  // Arm the stall watchdog's sweep (crew#287). Same gate as the probe: ON in the daemon, OFF
  // under a test runner unless a test opts in — a suite building servers over stub adapters
  // must not have a background interval calling `sessionsDetail()` on them.
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
    } catch (err) {
      done(err as Error);
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

  registerRoutes(
    app,
    adapter,
    gateCache,
    elicitationCache,
    qeGateCache,
    {
      bus: projectBus,
      index: membershipIndex,
      log: (m) => app.log.warn(m),
      settings: projectSettings,
    },
    { audit, authMode: auth.mode },
    { seatHealth, retryIndex },
  );

  // The UI-emittable direction of the interactive seam. Registered unconditionally (a null relay
  // answers 503, not 404) and BEFORE the static/SPA fallback below, like every other API route.
  registerInteractiveEventRoutes(app, interactiveRelay);

  // Serve the bundled studio SPA same-origin (DES-STUDIO-SERVING-001 §3). The
  // API routes, `/ws`, and terminal WS are registered ABOVE and keep winning:
  // static uses `wildcard: false` (only serves files that physically exist),
  // and the SPA fallback below explicitly excludes `/api/` and `/ws`.
  const studioRoot = options?.studioRoot ?? defaultStudioRoot();
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

  return app;
}

export interface StartedServer {
  app: ReturnType<typeof Fastify>;
  port: number;
  host: string;
}

export async function startServer(
  adapter: CoreAdapter,
  port = 7701,
  host = '127.0.0.1',
  options?: CreateServerOptions,
): Promise<StartedServer> {
  const app = await createServer(adapter, options);
  await app.listen({ port, host });
  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const boundHost = typeof addr === 'object' && addr ? addr.address : host;
  app.log.info(`wicked-crew daemon listening on ${boundHost}:${boundPort}`);
  return { app, port: boundPort, host: boundHost };
}
