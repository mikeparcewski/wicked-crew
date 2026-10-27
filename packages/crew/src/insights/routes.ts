/**
 * `/api/v1/insights` (DES-RUNS-REVIEW-001 §6): the review history the Run insights plugin draws, and a person's
 * decision on one recommendation. Reads are open to any actor; Accept and Dismiss are a person's only.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { isHumanOperator } from '../api/watch-routes.js';
import { METRICS } from './analyze.js';
import { MIN_SAMPLE } from './stats.js';
import { RecommendationError, type ReviewService } from './review-service.js';
import type { InsightsStore } from './store.js';

const V = API_PREFIX;
const DismissSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

export interface InsightsRouteDeps {
  store: InsightsStore;
  service: Pick<ReviewService, 'accept' | 'dismiss'>;
  audit: AuditLog;
}

export function registerInsightsRoutes(app: FastifyInstance, deps: InsightsRouteDeps): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const refuse = (reply: FastifyReply): FastifyReply =>
    reply.code(403).send({ error: 'Only a person can accept or dismiss a recommendation' });
  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof RecommendationError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get(
    `${V}/insights`,
    { config: { manifest: { responseType: 'InsightsResponse', statusCodes: [200] } } },
    async () => {
      const reviews = deps.store.list();
      const latest = reviews.find((r) => r.status !== 'running') ?? null;
      return {
        reviews,
        newRecommendations: deps.store.newCount(),
        running: reviews.some((r) => r.status === 'running'),
        lastReview: latest === null ? null : { runId: latest.runId, launchedAt: latest.launchedAt, endedAt: latest.endedAt, status: latest.status },
        metrics: METRICS,
        minSample: MIN_SAMPLE,
      };
    },
  );

  app.post(
    `${V}/insights/recommendations/:id/accept`,
    { config: { manifest: { responseType: 'AcceptRecommendationResponse', statusCodes: [200, 403, 404, 409] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      try {
        const res = await deps.service.accept(id);
        deps.audit.record('insights.recommendation.accepted', actor, { detail: { id, kind: res.recommendation.kind } });
        return res;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    `${V}/insights/recommendations/:id/dismiss`,
    { config: { manifest: { requestType: 'DismissRecommendationBody', responseType: 'DismissRecommendationResponse', statusCodes: [200, 400, 403, 404, 409, 502] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const parsed = DismissSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'body must be { reason: <why, 1 to 500 characters> }' });
      const { id } = req.params as { id: string };
      try {
        const res = await deps.service.dismiss(id, parsed.data.reason);
        deps.audit.record('insights.recommendation.dismissed', actor, { detail: { id, reason: parsed.data.reason } });
        return res;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
