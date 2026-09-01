/**
 * `DELETE /api/v1/projects/:projectId/interactive/docs/:doc` — the governed doc delete
 * (crew#338, the crew half of studio#119; the bridge half is interactive#189).
 *
 * Deleting a doc is TWO facts in TWO stores, and this route is the one door that changes both:
 *
 *  1. INTERACTIVE retires the lineage — `DELETE /api/docs/:doc` on the bridge tombstones the
 *     workspace (soft, idempotent, 409-guarded while a build is in flight) and emits
 *     `wicked.interactive.doc.retired` exactly once.
 *  2. CREW drops the doc's handoff-ledger rows — the replay-dedup rows in
 *     `~/.wicked-crew/interactive-{draft,edit,chat,demo}-ledger.json`. The draft leg keys by
 *     document id ("one first draft per document lifetime"), so a row that outlives its doc
 *     claims the name forever: a doc later created under the same name is treated as
 *     already-drafted and never gets its first draft. That ghost is what this route exists to
 *     prevent (before it, cleanup was `rm -rf` plus hand-editing the ledger JSON).
 *
 * Deliberately NOT part of the pure-transport proxy (`proxy-routes.ts` stays response-sniffing
 * free): this is its own route, one static path segment more specific than the proxy's wildcard,
 * so fastify routes the governed DELETE here while every other method/path — including a raw
 * `DELETE .../interactive/api/docs/:doc`, which remains verbatim transport — keeps flowing
 * through the proxy untouched. Belt-and-braces for deletions that bypass this route entirely
 * (a direct bridge call, another tool): the `/ws` relay watches `wicked.interactive.doc.retired`
 * on the bus and runs the same idempotent sweep (see `ws-relay.ts` / `server.ts`).
 *
 * LOUD ON PARTIAL FAILURE — the contract's spine. The two halves can genuinely diverge (bridge
 * retired but a ledger file is unwritable), and the worst outcome would be a response that lets
 * the divergence hide. So every answer names exactly which half happened:
 *
 *  - 200  both halves done — the bridge's own 200 body (retire/repeat) + `ledger` report;
 *  - 404  unknown doc in interactive; the ledger was STILL swept (`ledger` report in the body) —
 *         a hand-`rm -rf`'d workspace is precisely a 404 with ghost rows to drop;
 *  - 409  the bridge refused (build in flight) — relayed verbatim, NOTHING swept;
 *  - 500  PARTIAL: interactive's half happened (or was a 404 no-op) but the ledger sweep failed —
 *         the body carries both halves and says the retry instruction out loud;
 *  - 502  interactive did not retire (5xx / unreachable) — the ledger is deliberately untouched
 *         (`skipped: true`), so nothing diverged;
 *  - 503  bridge unavailable (proxy parity: `{code:"bridge_unavailable", hint}`).
 *
 * Every state change lands in the actor audit trail as `interactive.doc.deleted` (task #88).
 */

import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../api/api-prefix.js';
import type { AuditLog } from '../api/audit.js';
import type { CoreAdapter } from '../core/adapter.js';
import { ProjectsUnsupportedError } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import { DEFAULT_PROJECT_ID } from '../projects/routes.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { resolveInteractiveRoot } from './bridge-root.js';
import { BridgeUnavailableError, type InteractiveBridgePool, type LiveBridge } from './bridge-pool.js';
import { DOC_NAME } from './draft-events.js';
import type { DocLedgerSweep } from './doc-ledger-sweep.js';

const V = API_PREFIX;

/** The bridge's answer to `DELETE /api/docs/:doc` (interactive#189's wire). */
interface UpstreamRetire {
  status: number;
  body: Record<string, unknown>;
}

export interface DocDeleteDeps {
  settings: ProjectSettingsStore;
  pool: InteractiveBridgePool;
  audit: AuditLog;
  actorOf: (req: { actor?: Actor }) => Actor;
  /** The four-ledger sweep (`server.ts` wires the real one over the armed seams + their files;
   *  a directly-driven route set gets an inert default so unit tests never touch ~/.wicked-crew). */
  dropDocLedgerRows: (documentId: string) => DocLedgerSweep;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /** Budget for the bridge's retire call (tests shorten it). The tombstone write is local and
   *  fast; the default only has to outlast a busy event-loop, not a build. */
  upstreamTimeoutMs?: number;
}

/** A sweep that deliberately did not run — the "nothing diverged" half of a refused delete. */
const SWEEP_SKIPPED: DocLedgerSweep & { skipped: true } = Object.freeze({
  ok: false,
  removed_keys: [],
  skipped: true,
});

export function registerInteractiveDocDelete(
  app: FastifyInstance,
  adapter: CoreAdapter,
  deps: DocDeleteDeps,
): void {
  const { settings, pool, audit, actorOf, dropDocLedgerRows } = deps;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((): void => undefined);
  const timeoutMs = deps.upstreamTimeoutMs ?? 30_000;

  /** The resolved docs root for a project, or null when no such project exists — the SAME
   *  resolution the proxy uses (`default` is synthesized by the route layer; a pre-projects
   *  engine still answers for the one project it can have). */
  async function rootFor(projectId: string): Promise<string | null> {
    if (projectId !== DEFAULT_PROJECT_ID) {
      try {
        if ((await adapter.projectGet(projectId)) === null) return null;
      } catch (err) {
        if (!(err instanceof ProjectsUnsupportedError)) throw err;
      }
    }
    return resolveInteractiveRoot(settings.get(projectId), env);
  }

  /** One retire call to the bridge. Throws on transport failure (caller retries once). */
  async function retireUpstream(bridge: LiveBridge, doc: string): Promise<UpstreamRetire> {
    const res = await fetch(`http://${bridge.host}:${bridge.port}/api/docs/${doc}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      // A non-JSON body on a JSON-always wire — keep the status (it is the truth that matters)
      // and answer with an empty body rather than inventing fields.
    }
    return { status: res.status, body };
  }

  app.delete(
    `${V}/projects/:projectId/interactive/docs/:doc`,
    {
      config: {
        manifest: {
          responseType: 'InteractiveDocDeleteResponse',
          statusCodes: [200, 404, 409, 500, 502, 503],
        },
      },
    },
    async (req, reply) => {
      const { projectId, doc } = req.params as { projectId: string; doc: string };

      // Interactive's own name grammar, checked before anything moves: a non-slug can neither
      // exist on the bridge nor appear as a seam-written ledger key, so the honest answer is the
      // bridge's own "unknown doc" — without spending a bridge start on it.
      if (!DOC_NAME.test(doc)) {
        return reply
          .code(404)
          .send({ error: 'unknown doc', name: doc, ledger: { ok: true, removed_keys: [] } });
      }

      const root = await rootFor(projectId);
      if (root === null) {
        return reply.code(404).send({ error: `Project ${projectId} not found` });
      }

      let bridge: LiveBridge;
      try {
        bridge = await pool.ensure(root);
      } catch (err) {
        if (!(err instanceof BridgeUnavailableError)) throw err;
        log(`[doc-delete] interactive bridge unavailable: ${err.message}`);
        return reply.code(503).send({ code: 'bridge_unavailable', hint: err.hint });
      }

      // One retry on a dead cached bridge, mirroring the proxy's discipline: invalidate, let
      // `ensure` restart it, try once more — then fail loudly instead of looping.
      let upstream: UpstreamRetire;
      try {
        upstream = await retireUpstream(bridge, doc);
      } catch (firstErr) {
        pool.invalidate(root);
        try {
          bridge = await pool.ensure(root);
          upstream = await retireUpstream(bridge, doc);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log(`[doc-delete] retire call to the bridge failed for ${doc}: ${detail}`);
          return reply.code(502).send({
            error:
              `wicked-interactive was unreachable — the retire of '${doc}' did not happen, and ` +
              `crew's handoff-ledger rows were deliberately left in place (nothing diverged)`,
            name: doc,
            detail,
            first_attempt: firstErr instanceof Error ? firstErr.message : String(firstErr),
            ledger: SWEEP_SKIPPED,
          });
        }
      }

      // The bridge REFUSED (build in flight) — relay its 409 verbatim, sweep nothing: the doc is
      // alive and its ledger rows are still doing their replay-dedup job.
      if (upstream.status === 409) {
        return reply.code(409).send(upstream.body);
      }

      // Any other non-retire answer (5xx, an unexpected shape) — interactive's half did NOT
      // happen, so crew's half deliberately doesn't either. Loud, with the upstream answer
      // attached so the operator sees exactly what the bridge said.
      if (upstream.status !== 200 && upstream.status !== 404) {
        return reply.code(502).send({
          error:
            `wicked-interactive did not retire '${doc}' (HTTP ${upstream.status}) — crew's ` +
            `handoff-ledger rows were deliberately left in place (nothing diverged)`,
          name: doc,
          upstream_status: upstream.status,
          upstream: upstream.body,
          ledger: SWEEP_SKIPPED,
        });
      }

      // Interactive's half is settled (retired now, already retired, or nothing there to
      // retire). Crew's half runs in EVERY one of those cases — a 404 with ghost rows is
      // precisely the hand-deleted-workspace mess this route exists to clean up.
      const sweep = dropDocLedgerRows(doc);
      const retiredNow = upstream.status === 200 && upstream.body['already_retired'] !== true;

      if (upstream.status === 200 || sweep.removed_keys.length > 0) {
        audit.record('interactive.doc.deleted', actorOf(req as { actor?: Actor }), {
          detail: {
            projectId,
            doc,
            outcome:
              upstream.status === 404
                ? 'ledger-only'
                : sweep.ok
                  ? retiredNow
                    ? 'retired'
                    : 'already-retired'
                  : 'partial',
            removed_keys: sweep.removed_keys,
            ...(sweep.ok ? {} : { ledger_errors: sweep.errors ?? [] }),
            ...(typeof upstream.body['event_id'] === 'number'
              ? { event_id: upstream.body['event_id'] }
              : {}),
          },
        });
      }

      if (!sweep.ok) {
        // PARTIAL — the one answer that must never look like success or like nothing happened.
        const interactiveHalf =
          upstream.status === 200
            ? `wicked-interactive retired '${doc}'`
            : `'${doc}' is unknown to wicked-interactive (nothing to retire there)`;
        log(
          `[doc-delete] PARTIAL: ${interactiveHalf} but the handoff-ledger sweep failed — ` +
            `${(sweep.errors ?? []).map((e) => `${e.ledger}: ${e.error}`).join('; ')}`,
        );
        return reply.code(500).send({
          error:
            `partial delete: ${interactiveHalf}, but crew could not drop its handoff-ledger ` +
            `row(s) — stale rows may shadow the name (a re-created doc would never get its ` +
            `first draft). Re-issue this DELETE to retry: the retire is idempotent and the ` +
            `sweep removes only what is still there`,
          name: doc,
          interactive: upstream.status === 200 ? upstream.body : { error: 'unknown doc' },
          ledger: sweep,
        });
      }

      if (upstream.status === 404) {
        // Truthful relay of the bridge's 404 — plus what the sweep did about any ghosts.
        return reply.code(404).send({ error: 'unknown doc', name: doc, ledger: sweep });
      }

      // Both halves done: the bridge's own 200 body (first retire carries `event_id`; a repeat
      // carries `already_retired: true` and the original `retired_at`) plus crew's ledger report.
      return reply.code(200).send({ ...upstream.body, ledger: sweep });
    },
  );
}
