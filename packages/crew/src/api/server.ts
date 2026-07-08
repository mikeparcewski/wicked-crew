import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { registerRoutes } from './routes.js';
import { GateCache } from './gate-cache.js';
import { registerClient, broadcast } from '../events/bus.js';
import type { CoreAdapter } from '../core/adapter.js';

// Allow the studio (a separate localhost origin, e.g. :4200) to call the
// daemon's REST API. Restricted to loopback origins — the daemon only binds
// 127.0.0.1, so this never widens exposure beyond the local machine.
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

export async function createServer(adapter: CoreAdapter): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });
  const gateCache = new GateCache();

  // The daemon's single CoreEvent subscription fans out here: cache gate prompts
  // (§3.3) then forward every frame verbatim to all browser WS clients (§2.1).
  adapter.onEvent((event) => {
    gateCache.ingest(event);
    broadcast(event);
  });

  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && LOOPBACK_ORIGIN.test(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

  registerRoutes(app, adapter, gateCache);

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
): Promise<StartedServer> {
  const app = await createServer(adapter);
  await app.listen({ port, host });
  const addr = app.server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const boundHost = typeof addr === 'object' && addr ? addr.address : host;
  app.log.info(`wicked-crew daemon listening on ${boundHost}:${boundPort}`);
  return { app, port: boundPort, host: boundHost };
}
