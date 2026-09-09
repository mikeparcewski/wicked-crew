/**
 * `GET /api/v1/projects/:projectId/interactive/api/docs` — the project-attributed docs list
 * (crew#472).
 *
 * The bridge's own `GET /api/docs` lists the docs of ONE root and knows nothing about crew's
 * projects: a row says `name`/`kind`/`head`/`versions`/`updated_at`, never which project it was
 * listed for. With docs roots partitioned per project (`bridge-root.ts`), the mount a list was
 * fetched under IS the attribution — so this route relays the bridge's rows field-for-field and
 * stamps each with the `projectId` of the mount, the one fact the bridge cannot supply and a
 * client rendering docs from several projects at once cannot otherwise recover.
 *
 * Deliberately NOT part of the pure-transport proxy (`proxy-routes.ts` stays response-sniffing
 * free, the same posture as the governed delete): this is its own route, one static segment more
 * specific than the proxy's wildcard, so fastify routes exactly this GET here while every other
 * method on the same path — `POST /api/docs` creates a doc — and every other path keep flowing
 * through the proxy verbatim. The query string (`?includeRetired=1`) is forwarded untouched.
 *
 * Non-list answers are relayed rather than reshaped: a bridge that fails its own listing answers
 * with its status and body; a bridge that answers 200 with something other than a JSON array is a
 * 502 that says so, never an empty list pretending nothing exists.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_PREFIX } from '../api/api-prefix.js';
import type { CoreAdapter } from '../core/adapter.js';
import { BridgeUnavailableError, type InteractiveBridgePool, type LiveBridge } from './bridge-pool.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { projectDocsRoot } from './project-root.js';

const V = API_PREFIX;

/** The bridge's answer to `GET /api/docs`, before crew parses the body. */
interface UpstreamList {
  status: number;
  body: unknown;
}

export interface DocListDeps {
  settings: ProjectSettingsStore;
  pool: InteractiveBridgePool;
  env?: NodeJS.ProcessEnv;
  /** The home the default root hangs off (tests point it at a scratch dir). */
  home?: string;
  log?: (msg: string) => void;
  /** Budget for the bridge's list call (tests shorten it). The list is a directory scan. */
  upstreamTimeoutMs?: number;
}

export function registerInteractiveDocList(app: FastifyInstance, adapter: CoreAdapter, deps: DocListDeps): void {
  const { settings, pool } = deps;
  const log = deps.log ?? ((): void => undefined);
  const timeoutMs = deps.upstreamTimeoutMs ?? 30_000;

  /** One list call to the bridge. Throws on transport failure (caller retries once). */
  async function listUpstream(bridge: LiveBridge, query: string): Promise<UpstreamList> {
    const res = await fetch(`http://${bridge.host}:${bridge.port}/api/docs${query}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // A non-JSON body on a JSON-always wire (a bridge's default not-found page) — keep the
      // status (it is the truth that matters); the null body fails the list-shape check below
      // rather than being invented into rows.
    }
    return { status: res.status, body };
  }

  function unavailable(reply: FastifyReply, err: unknown): FastifyReply {
    if (!(err instanceof BridgeUnavailableError)) throw err;
    log(`[doc-list] interactive bridge unavailable: ${err.message}`);
    return reply.code(503).send({ code: 'bridge_unavailable', hint: err.hint });
  }

  app.get(
    `${V}/projects/:projectId/interactive/api/docs`,
    {
      config: {
        manifest: {
          responseType: 'InteractiveDocSummary',
          statusCodes: [200, 404, 502, 503],
        },
      },
    },
    async (req, reply) => {
      const { projectId } = req.params as { projectId: string };
      // The RAW query, so percent-encoding survives the hop (the proxy's verbatim rule).
      const raw = req.raw.url ?? '';
      const query = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';

      const root = await projectDocsRoot(adapter, settings, projectId, deps);
      if (root === null) return reply.code(404).send({ error: `Project ${projectId} not found` });

      let bridge: LiveBridge;
      try {
        bridge = await pool.ensure(root);
      } catch (err) {
        return unavailable(reply, err);
      }

      // One retry on a dead cached bridge, the proxy's discipline: invalidate, let `ensure`
      // restart it, try once more — then fail loudly instead of looping.
      let upstream: UpstreamList;
      try {
        upstream = await listUpstream(bridge, query);
      } catch (firstErr) {
        pool.invalidate(root);
        try {
          bridge = await pool.ensure(root);
        } catch (startErr) {
          return unavailable(reply, startErr);
        }
        try {
          upstream = await listUpstream(bridge, query);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log(`[doc-list] list call to the bridge failed for project ${projectId}: ${detail}`);
          return reply.code(502).send({
            error: 'wicked-interactive was unreachable — GET /api/docs did not answer',
            detail,
            first_attempt: firstErr instanceof Error ? firstErr.message : String(firstErr),
          });
        }
      }

      // The bridge's own failure, relayed with its status: never reshaped into an empty list.
      if (upstream.status !== 200) {
        return reply
          .code(upstream.status)
          .send(upstream.body ?? { error: `wicked-interactive answered GET /api/docs with HTTP ${upstream.status}` });
      }
      if (!Array.isArray(upstream.body)) {
        log(`[doc-list] the bridge answered GET /api/docs for project ${projectId} with a non-list body`);
        return reply.code(502).send({ error: 'wicked-interactive answered GET /api/docs with a non-list body' });
      }
      return reply.send(upstream.body.map((row: unknown) => ({ ...(row as Record<string, unknown>), projectId })));
    },
  );
}
