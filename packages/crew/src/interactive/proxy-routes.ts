/**
 * `/api/v1/projects/:projectId/interactive/*` — crew reverse-proxies the wicked-interactive
 * bridge (DES-MERGE-001 §5.3, §7.2; slice 1).
 *
 * PURE TRANSPORT. Nothing user-visible moves in this slice: what changes is that interactive's
 * HTTP surface becomes reachable through crew's OWN origin, so the studio client never learns a
 * second origin, never needs CORS, and never carries a `:4400` literal — ADR-0022's dynamic port
 * is honored rather than worked around, and the bridge stops being browser-reachable at all.
 *
 * The path encodes the project (§7.2) because the ROOT is a per-project setting: the same proxy
 * mount serves N interactive instances, one bridge per resolved root.
 *
 * Two things are deliberately hand-rolled over `node:http` rather than delegated to `fetch`:
 *
 *  1. UNBUFFERED STREAMING BOTH WAYS. Interactive's generation surface is SSE; a proxy that
 *     buffers turns a live narration into a single blob delivered at stream close. Piping raw
 *     sockets keeps every chunk flowing as it arrives, in both directions.
 *  2. VERBATIM FORWARDING. The path remainder and query string are taken from `req.raw.url`,
 *     not from Fastify's decoded wildcard param, so percent-encoding survives the hop intact.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { API_PREFIX } from '../api/api-prefix.js';
import type { CoreAdapter } from '../core/adapter.js';
import { ProjectsUnsupportedError } from '../core/adapter.js';
import { DEFAULT_PROJECT_ID } from '../projects/routes.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { resolveInteractiveRoot } from './bridge-root.js';
import { BridgeUnavailableError, InteractiveBridgePool, type LiveBridge } from './bridge-pool.js';

/** Per-hop headers that must never be forwarded across a proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardableRequestHeaders(headers: IncomingHttpHeaders, bridge: LiveBridge): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    // Crew's bearer token is CREW's credential. The bridge is a local process with no auth of
    // its own and no use for it; forwarding it would hand a third-party child crew's ambient
    // authority for free. One auth path (§5.3) means crew terminates auth, it does not relay it.
    if (name === 'authorization') continue;
    out[name] = value;
  }
  out['host'] = `${bridge.host}:${bridge.port}`;
  return out;
}

/**
 * Point a `Location` back at the proxy. The bridge answers on its own origin and knows nothing
 * about the mount prefix, so both spellings it can emit have to be re-anchored: an absolute URL
 * on the bridge origin, and a root-relative path. Anything else (a foreign origin, a relative
 * path) is left exactly as-is — rewriting those would be inventing a redirect target.
 */
export function rewriteLocation(location: string, bridge: LiveBridge, prefix: string): string {
  for (const host of new Set([bridge.host, 'localhost', '127.0.0.1'])) {
    const origin = `http://${host}:${bridge.port}`;
    if (location.startsWith(origin)) return `${prefix}${location.slice(origin.length)}`;
  }
  if (location.startsWith('/')) return `${prefix}${location}`;
  return location;
}

export interface InteractiveProxyDeps {
  settings: ProjectSettingsStore;
  pool: InteractiveBridgePool;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export function registerInteractiveProxy(app: FastifyInstance, adapter: CoreAdapter, deps: InteractiveProxyDeps): void {
  const { settings, pool } = deps;
  const env = deps.env ?? process.env;
  // Strips exactly the mount prefix off the RAW url, leaving the remainder + query untouched.
  const prefixRe = new RegExp(`^${API_PREFIX}/projects/[^/?#]+/interactive`);

  /** The resolved docs root for a project, or null when no such project exists. */
  async function rootFor(projectId: string): Promise<string | null> {
    // `default` is SYNTHESIZED by the route layer (DES-PROJECT-001 §7) — the engine has no row
    // for it, so an existence check there would 404 the one project every operator starts with.
    if (projectId !== DEFAULT_PROJECT_ID) {
      try {
        if ((await adapter.projectGet(projectId)) === null) return null;
      } catch (err) {
        // A pre-0.6.0 engine has no project surface at all; the shared default root is still
        // a truthful answer for the only project such a deployment can have.
        if (!(err instanceof ProjectsUnsupportedError)) throw err;
      }
    }
    return resolveInteractiveRoot(settings.get(projectId), env);
  }

  // Encapsulated so the raw-body parser below applies to the PROXY ONLY. The root instance
  // installs a JSON parser that buffers and parses the body — correct for every other route,
  // fatal here: a parsed body is a consumed stream, and an SSE POST would arrive at the bridge
  // only once the client finished sending.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });

    scope.all(`${API_PREFIX}/projects/:projectId/interactive/*`, async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      const prefix = `${API_PREFIX}/projects/${encodeURIComponent(projectId)}/interactive`;

      const root = await rootFor(projectId);
      if (root === null) return reply.code(404).send({ error: `Project ${projectId} not found` });

      let bridge: LiveBridge;
      try {
        bridge = await pool.ensure(root);
      } catch (err) {
        return unavailable(reply, err, deps.log);
      }

      const target = (req.raw.url ?? '').replace(prefixRe, '') || '/';
      try {
        await forward(req, reply, bridge, target, prefix);
      } catch (err) {
        // The cached bridge died between the pid check and the connect (an operator killed it,
        // a crash). Invalidate and let `ensure` restart it — ONE retry, so a genuinely broken
        // bridge fails fast to a 503 instead of looping.
        if (!isConnectionRefused(err) || reply.raw.headersSent) throw err;
        pool.invalidate(root);
        try {
          bridge = await pool.ensure(root);
        } catch (startErr) {
          return unavailable(reply, startErr, deps.log);
        }
        await forward(req, reply, bridge, target, prefix);
      }
      return reply;
    });
  });
}

function isConnectionRefused(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH';
}

/** §5.6's failure shape: a machine-readable code plus a command the operator can actually run. */
function unavailable(reply: FastifyReply, err: unknown, log?: (msg: string) => void): FastifyReply {
  if (!(err instanceof BridgeUnavailableError)) throw err;
  log?.(`interactive bridge unavailable: ${err.message}`);
  return reply.code(503).send({ code: 'bridge_unavailable', hint: err.hint });
}

/**
 * One proxied exchange, socket to socket. `reply.hijack()` hands us the raw response before
 * Fastify can serialize or buffer anything, which is what lets an SSE chunk reach the browser
 * the moment the bridge emits it rather than at stream close.
 */
function forward(
  req: FastifyRequest,
  reply: FastifyReply,
  bridge: LiveBridge,
  target: string,
  prefix: string,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const upstream = httpRequest(
      {
        host: bridge.host,
        port: bridge.port,
        method: req.method,
        path: target,
        headers: forwardableRequestHeaders(req.headers, bridge),
      },
      (res) => {
        reply.hijack();
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (HOP_BY_HOP.has(name) || value === undefined) continue;
          headers[name] = name === 'location' && typeof value === 'string' ? rewriteLocation(value, bridge, prefix) : value;
        }
        reply.raw.writeHead(res.statusCode ?? 502, headers);
        // No `pipeline` and no buffering layer: `pipe` forwards each chunk as it lands, and
        // Node flushes it because we never set a highWaterMark barrier in between.
        res.pipe(reply.raw);
        res.on('end', () => resolvePromise());
        res.on('error', (err) => {
          reply.raw.destroy();
          rejectPromise(err);
        });
      },
    );

    upstream.on('error', (err) => {
      if (reply.raw.headersSent) reply.raw.destroy();
      rejectPromise(err);
    });
    // If the client hangs up mid-stream (closing an SSE tab), stop pulling from the bridge.
    reply.raw.on('close', () => upstream.destroy());
    req.raw.pipe(upstream);
  });
}
