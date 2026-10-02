/**
 * The watch registry's routes (DES-TRIGGER-REGISTRY-001 §4.5, TR-W5a).
 *
 * Reads, plus one command:
 *   GET  /watch?project=&kind=&run=&since=&limit=   the feed fold, newest first (+ coverage with run=)
 *   GET  /watch/health                              armed? sources, queue, emit failures, entries
 *   GET  /watch/entries                             the effective entries, thresholds in plain words
 *   POST /watch/:watch_id/dismiss                   "Seen, not a problem" (a human only)
 * Settings (`watch.*`) go through the existing `PUT /settings` (routes.ts), behind the same human
 * predicate as dismiss.
 *
 * A daemon whose registry did not arm still answers: health says `armed:false` and why, the feed is
 * empty and every run's coverage says watching is off. Nothing here can allow, approve or block.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WatchHealth, WatchKind } from 'wicked-crew-api-types';
import type { Actor } from '../core/types.js';
import type { WatchRegistry } from '../watch/registry.js';
import { API_PREFIX } from './api-prefix.js';
import { LOCAL_ACTOR, trustAtLeast } from './auth.js';
import type { AuditLog } from './audit.js';

const V = API_PREFIX;
const KINDS: ReadonlySet<string> = new Set<WatchKind>(['problem', 'decision', 'done', 'quiet', 'delivery']);
const WATCH_ID = /^w-[0-9a-f]{32}$/;

/**
 * The "human" predicate (DES-DECISION-CAPTURE §4.5 step 1, reused by DES-TRIGGER-REGISTRY §4.2): a
 * human actor at operator trust or above. A worker's MCP bearer resolves to a non-human actor and is
 * refused. Under `auth=off` every request is the full-trust local human, so this holds only as far
 * as the bearer refusal does (the residual §7 records).
 */
export function isHumanOperator(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

const UNARMED: WatchHealth = {
  armed: false,
  reason: 'watching is not configured on this daemon',
  sources: { bus: 'down', core: 'down', watchdog: 'down' },
  queue: { depth: 0, hwm: 0, shed_by_priority: { p0: 0, p1: 0, p2: 0 } },
  tail_lag_ms: 0,
  emit: { failed: 0 },
  entries: { loaded: 0, refused: [], off: [], thresholds_changed: [] },
  llm: { enabled: false, inflight: 0, timeouts: 0, skipped_no_seat: 0 },
};

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function bad(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(400).send({ error });
}

export function registerWatchRoutes(
  app: FastifyInstance,
  deps: { registry: () => WatchRegistry | null; audit: AuditLog },
): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;

  app.get(
    `${V}/watch`,
    { config: { manifest: { responseType: 'WatchFeedResponse', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const q = req.query as Record<string, string | string[] | undefined>;
      const project = one(q['project']);
      const kind = one(q['kind']);
      const run = one(q['run']);
      const sinceRaw = one(q['since']);
      const limitRaw = one(q['limit']);
      if (project !== undefined && project.trim() === '') return bad(reply, '`project` must not be empty');
      if (run !== undefined && run.trim() === '') return bad(reply, '`run` must not be empty');
      if (kind !== undefined && !KINDS.has(kind)) return bad(reply, `\`kind\` must be one of ${[...KINDS].join('|')}`);
      const since = sinceRaw === undefined ? undefined : Number(sinceRaw);
      if (since !== undefined && (!Number.isInteger(since) || since < 0)) return bad(reply, '`since` must be Unix millis');
      const limit = limitRaw === undefined ? undefined : Number(limitRaw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
        return bad(reply, '`limit` must be an integer between 1 and 500');
      }
      const registry = deps.registry();
      if (registry === null) {
        return { findings: [], cleared: [], ...(run !== undefined ? { coverage: [] } : {}) };
      }
      return registry.feed({
        ...(project !== undefined ? { project } : {}),
        ...(kind !== undefined ? { kind: kind as WatchKind } : {}),
        ...(run !== undefined ? { run } : {}),
        ...(since !== undefined ? { since } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    },
  );

  app.get(
    `${V}/watch/health`,
    { config: { manifest: { responseType: 'WatchHealth', statusCodes: [200] } } },
    async () => deps.registry()?.health() ?? UNARMED,
  );

  app.get(
    `${V}/watch/entries`,
    { config: { manifest: { responseType: '{ entries: WatchEntry[] }', statusCodes: [200] } } },
    async () => ({ entries: deps.registry()?.entries() ?? [] }),
  );

  app.post(
    `${V}/watch/:watch_id/dismiss`,
    { config: { manifest: { responseType: '{ dismissed: true; watch_id: string }', statusCodes: [200, 400, 403, 404, 409, 502, 503] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: 'Only a person can dismiss a watch finding (a worker or system actor cannot)' });
      }
      const { watch_id: watchId } = req.params as { watch_id: string };
      if (!WATCH_ID.test(watchId)) return bad(reply, 'watch_id must be "w-" followed by 32 lowercase hex characters');
      const registry = deps.registry();
      if (registry === null || !registry.armed) {
        return reply.code(503).send({ error: 'watching is off on this daemon; nothing to dismiss' });
      }
      const result = await registry.dismiss(watchId, actor.id);
      if (result === 'not_found') return reply.code(404).send({ error: `no watch finding ${watchId}` });
      if (result === 'already_cleared') return reply.code(409).send({ error: `${watchId} is already cleared` });
      if (result === 'emit_failed') return reply.code(502).send({ error: `the dismissal of ${watchId} could not be recorded on the event bus` });
      deps.audit.record('watch.finding.dismissed', actor, { detail: { watch_id: watchId } });
      return { dismissed: true, watch_id: watchId };
    },
  );
}
