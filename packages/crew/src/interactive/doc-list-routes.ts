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
 * with its status and body; a bridge that answers 200 with something other than a JSON array of
 * doc summaries — a non-JSON body, a JSON object, a list holding `null` or a string where a row
 * should be — is a 502 that says which, never an empty list pretending nothing exists and never
 * `[{ projectId }]` minted from nothing. And a body that is malformed is told apart from a body
 * that never fully ARRIVED: the first is the bridge's answer (no retry would change it), the
 * second is a transport failure that takes the same invalidate → retry-once → diagnostic path a
 * refused connect does.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { API_PREFIX } from '../api/api-prefix.js';
import type { CoreAdapter } from '../core/adapter.js';
import { BridgeUnavailableError, type InteractiveBridgePool, type LiveBridge } from './bridge-pool.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { projectDocsRoot } from './project-root.js';

const V = API_PREFIX;

/** The bridge's answer to `GET /api/docs`, fully read. `json` is false when the COMPLETE body
 *  did not parse (then `body` is null). */
interface UpstreamList {
  status: number;
  body: unknown;
  json: boolean;
}

/**
 * The shape of a bridge row this route will vouch for: a plain object naming the doc and its
 * kind (`InteractiveDocSummary` minus the `projectId` this route adds). Everything else on the
 * row is relayed field-for-field — the bridge's DTO, not a crew re-spelling of it.
 */
type DocSummaryRow = Record<string, unknown> & { name: string; kind: string };

function isDocSummaryRow(row: unknown): row is DocSummaryRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false;
  const r = row as Record<string, unknown>;
  return typeof r['name'] === 'string' && typeof r['kind'] === 'string';
}

/** A short, safe rendering of an offending row for the 502 detail — its type and a bounded preview. */
function describeRow(row: unknown): string {
  if (row === null) return 'null';
  if (Array.isArray(row)) return 'an array';
  if (typeof row !== 'object') return `a ${typeof row} (${String(JSON.stringify(row) ?? row).slice(0, 80)})`;
  const keys = Object.keys(row).slice(0, 8).join(', ');
  return `an object without string name/kind (keys: ${keys === '' ? 'none' : keys})`;
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

  /**
   * One list call to the bridge. Throws on transport failure — a refused connect, the timeout, a
   * connection torn down while the body was still arriving — and the caller retries once. Only a
   * COMPLETE body reaches the parser, so a parse failure is exactly what it looks like: the
   * bridge answered with something other than JSON (its default not-found page, say). No retry
   * would change that, so it is reported as the bridge's answer, never as unreachability.
   */
  async function listUpstream(bridge: LiveBridge, query: string): Promise<UpstreamList> {
    const res = await fetch(`http://${bridge.host}:${bridge.port}/api/docs${query}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown, json: true };
    } catch {
      return { status: res.status, body: null, json: false };
    }
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
          // The wire is a JSON ARRAY of rows, spelled in the manifest's TypeScript-inline form
          // (`{ runs: SessionView[] }` is the wrapped-list precedent). 500 is the refused
          // partition (`InteractivePartitionRefusedError`, bridge-root.ts).
          responseType: 'InteractiveDocSummary[]',
          statusCodes: [200, 404, 500, 502, 503],
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

      // The bridge's own failure, relayed with its status: never reshaped into an empty list. A
      // non-JSON failure body (a bridge's default not-found page) gets a JSON error in its place.
      if (upstream.status !== 200) {
        return reply
          .code(upstream.status)
          .send(
            upstream.json && upstream.body !== null
              ? upstream.body
              : { error: `wicked-interactive answered GET /api/docs with HTTP ${upstream.status}` },
          );
      }
      if (!upstream.json) {
        log(`[doc-list] the bridge answered GET /api/docs for project ${projectId} with a body that is not JSON`);
        return reply
          .code(502)
          .send({ error: 'wicked-interactive answered GET /api/docs with a malformed body (not JSON)' });
      }
      if (!Array.isArray(upstream.body)) {
        log(`[doc-list] the bridge answered GET /api/docs for project ${projectId} with a non-list body`);
        return reply.code(502).send({ error: 'wicked-interactive answered GET /api/docs with a non-list body' });
      }
      // Every row must be a doc summary before it is vouched for: `[null]` would otherwise become
      // `[{ projectId }]` with a 200, and a string row would spread into char-indexed keys.
      const rows: unknown[] = upstream.body;
      const summaries: DocSummaryRow[] = [];
      for (const [index, row] of rows.entries()) {
        if (!isDocSummaryRow(row)) {
          const detail = `row ${index} is not a doc summary: ${describeRow(row)}`;
          log(`[doc-list] the bridge answered GET /api/docs for project ${projectId} with a malformed list — ${detail}`);
          return reply
            .code(502)
            .send({ error: 'wicked-interactive answered GET /api/docs with a malformed list', detail });
        }
        summaries.push(row);
      }
      return reply.send(summaries.map((row) => ({ ...row, projectId })));
    },
  );
}
