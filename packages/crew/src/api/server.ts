import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { registerRoutes } from './routes.js';
import { GateCache } from './gate-cache.js';
import { ElicitationCache } from './elicitation-cache.js';
import { registerClient, broadcast } from '../events/bus.js';
import { TerminalHub, registerTerminalWs } from '../events/terminals.js';
import { QeGateCache, startQeGateSubscriber } from '../qe/gate-events.js';
import { startInteractiveDraftSubscriber } from '../interactive/draft-events.js';
import { startInteractiveEditSubscriber } from '../interactive/edit-events.js';
import { startProjectBus, MEMBERSHIP_ATTACHED, membershipAttachedKey } from '../projects/events.js';
import { MembershipIndex } from '../projects/membership-index.js';
import { writeRunEvidencePointer } from '../projects/charter.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent } from '../core/types.js';

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

  // The project seam (DES-PROJECT-001): the bus handle for post-commit event emission + the
  // /ws activity bridge, and the run→project index that tags outbound frames (§5.2). Hydrated
  // from the engine so a restarted daemon tags correctly from the first frame. Created BEFORE
  // the interactive seams below: their project-bound launches share the launch route's
  // post-commit half (index tag + membership.attached emit) via `fileRun`.
  const membershipIndex = new MembershipIndex();
  await membershipIndex.hydrate(adapter, (m) => app.log.warn(m));
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

  /** The post-commit half of a project-FILED launch, shared with the launch route (§2.2/§4):
   *  the engine already attached the crew.run membership atomically with the launch — here we
   *  tag future /ws frames and announce the attach on the project bus. */
  const fileRun = (runId: string, projectId: string): void => {
    membershipIndex.set(runId, projectId);
    projectBus?.emit(
      MEMBERSHIP_ATTACHED,
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
  // answerer, and this daemon must boot on a machine whose bus is broken.
  if (options?.interactiveDraftEvents?.enabled === true) {
    const o = options.interactiveDraftEvents;
    const sub = await startInteractiveDraftSubscriber(adapter, {
      ...(o.dbPath !== undefined ? { dbPath: o.dbPath } : {}),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.draftDir !== undefined ? { draftDir: o.draftDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
    });
    if (sub !== null) {
      app.log.info('interactive-draft subscription armed (filter wicked.interactive.doc.created)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // Arm the opt-in interactive STRUCTURAL-edit answering seam (task #86 final leg). Same
  // posture as the draft seam: failure to arm is LOUD but non-fatal — interactive's assist
  // loop is the fallback answerer, and this daemon must boot on a machine whose bus is broken.
  if (options?.interactiveEditEvents?.enabled === true) {
    const o = options.interactiveEditEvents;
    const sub = await startInteractiveEditSubscriber(adapter, {
      ...(o.dbPath !== undefined ? { dbPath: o.dbPath } : {}),
      ...(o.pollIntervalMs !== undefined ? { pollIntervalMs: o.pollIntervalMs } : {}),
      ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
      ...(o.ledgerPath !== undefined ? { ledgerPath: o.ledgerPath } : {}),
      ...(o.editDir !== undefined ? { editDir: o.editDir } : {}),
      ...(o.clisJson !== undefined ? { clisJson: o.clisJson } : {}),
      onRunFiled: fileRun,
      log: (m) => app.log.warn(m),
    });
    if (sub !== null) {
      app.log.info('interactive-edit subscription armed (filter wicked.interactive.feedback.processed)');
      app.addHook('onClose', async () => {
        await sub.stop();
      });
    }
  }

  // The daemon's single CoreEvent subscription fans out here: cache gate prompts
  // (§3.3), cache elicitation prompts (DES-002), route terminal frames to their owning
  // per-terminal socket (by id, DES-TERMINAL-001 §6), then forward every frame — tagged
  // with its run's `project_id` when the membership table files it (DES-PROJECT-001
  // §5.2; no new socket, additive field) — to all `/ws` clients (§2.1).
  //
  // Unregistered on close: a process can build more than one server over the same
  // adapter (tests do), and a closed server's caches must stop consuming events —
  // otherwise every discarded server keeps folding state forever (listener leak).
  const offEvent = adapter.onEvent((event) => {
    gateCache.ingest(event);
    elicitationCache.ingest(event);
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

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && LOOPBACK_ORIGIN.test(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
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

  app.get('/ws', { websocket: true }, (socket) => {
    // Late-join gets no replay; the studio reconciles with a one-shot GET /runs.
    registerClient(socket as unknown as WebSocket);
  });

  // One dedicated WS channel per PTY: /ws/terminals/:id (DES-TERMINAL-001 §6).
  registerTerminalWs(app, adapter, terminals);

  registerRoutes(app, adapter, gateCache, elicitationCache, qeGateCache, {
    bus: projectBus,
    index: membershipIndex,
    log: (m) => app.log.warn(m),
  });

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
