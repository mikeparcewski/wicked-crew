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
import type { CoreAdapter } from '../core/adapter.js';

// Allow the studio (a separate localhost origin, e.g. :4200) to call the
// daemon's REST API. Restricted to loopback origins — the daemon only binds
// 127.0.0.1, so this never widens exposure beyond the local machine.
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

/**
 * The bundled studio SPA lives at `dist/studio` next to the compiled server
 * (`dist/api/server.js` → `../studio`). See DES-STUDIO-SERVING-001 §2.3/§3.1
 * and `scripts/bundle-studio.mjs` which copies `packages/studio/dist` there.
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

  // The daemon's single CoreEvent subscription fans out here: cache gate prompts
  // (§3.3), cache elicitation prompts (DES-002), route terminal frames to their owning
  // per-terminal socket (by id, DES-TERMINAL-001 §6), then forward every frame verbatim
  // to all `/ws` clients (§2.1).
  adapter.onEvent((event) => {
    gateCache.ingest(event);
    elicitationCache.ingest(event);
    terminals.route(event);
    broadcast(event);
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

  registerRoutes(app, adapter, gateCache, elicitationCache, qeGateCache);

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
