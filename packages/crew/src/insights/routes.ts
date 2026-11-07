/**
 * `/api/v1/insights` (DES-RUNS-REVIEW-001 §6): the review history the Run insights plugin draws, and a person's
 * decision on one recommendation. Reads are open to any actor; Accept and Dismiss are a person's only.
 *
 * (DES-CATALOG-002 CS6) `POST /insights/facts {token}` is WORKER-FACING: the `run-cost` workflow's `facts` Tool
 * (`wicked-crew insights-facts`) asks it with its unit's capability token, which is its only credential (it is a
 * unit-token route in `api/auth.ts`). It answers the cost facts of the last 90 days ({@link costFacts}).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from '../zod.js';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { isHumanOperator } from '../api/watch-routes.js';
import { METRICS } from './analyze.js';
import { MIN_SAMPLE } from './stats.js';
import { RecommendationError, type ReviewService } from './review-service.js';
import type { InsightsStore } from './store.js';
import type { SessionView } from 'wicked-crew-api-types';
import { runNameOf } from '../core/run-identity.js';
import { RUN_COST_FACTS_CMD, RUN_COST_FACTS_STEP, RUN_COST_WORKFLOW, costFacts, costWindow } from './cost.js';
import type { CollectOptions } from './review-service.js';
import type { RunFact } from './run-facts.js';

const V = API_PREFIX;
const DismissSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const FactsSchema = z.strictObject({ token: z.string().min(1).max(512) });

/** What a unit token resolves to: its run, its step id, the run's workflow name and the unit's Tool command. */
export interface FactsUnit {
  runId: string;
  phase: string;
  workflow: string | null;
  toolCmd: string[] | null;
}

export interface InsightsFactsDeps {
  /** The engine resolves the token to its run and ord; crew reads the rest from the run's own record. */
  unitOf: (token: string) => Promise<FactsUnit | null>;
  /** The review preparer over an explicit window (`ReviewService.collect`). */
  collect: (opts: CollectOptions, nowMs: number) => Promise<RunFact[]>;
  now?: () => number;
}

/**
 * The facts route's verifier: the engine resolves the unit's capability token (`Core.resolveEstateScope`, the
 * resolver `POST /apps/check` uses), and crew reads which step that unit is, its Tool command and its run's name
 * from the run's own units. A unit crew cannot place resolves with phase `(unknown)`, which the route refuses.
 */
export function factsUnitResolver(
  resolve: (requestJson: string) => Promise<string>,
  sessions: () => Promise<SessionView[]>,
): (token: string) => Promise<FactsUnit | null> {
  return async (token) => {
    let unit: { runId?: unknown; ord?: unknown } | undefined;
    try {
      unit = (JSON.parse(await resolve(JSON.stringify({ token }))) as { unit?: { runId?: unknown; ord?: unknown } }).unit;
    } catch {
      return null;
    }
    if (typeof unit?.runId !== 'string' || typeof unit.ord !== 'number') return null;
    const runId = unit.runId;
    const ord = unit.ord;
    const view = (await sessions()).find((v) => v.session.id === runId);
    const u = view?.units.find((x) => x.ord === ord);
    const cmd = (u as { tool_cmd?: unknown } | undefined)?.tool_cmd;
    return {
      runId,
      phase: u !== undefined && u.id.startsWith(`${runId}:`) ? u.id.slice(runId.length + 1) : '(unknown)',
      workflow: view === undefined ? null : runNameOf(view),
      toolCmd: Array.isArray(cmd) && cmd.every((c) => typeof c === 'string') ? (cmd as string[]) : null,
    };
  };
}

const sameCmd = (cmd: readonly string[] | null): boolean =>
  cmd !== null && cmd.length === RUN_COST_FACTS_CMD.length && cmd.every((c, i) => c === RUN_COST_FACTS_CMD[i]);

export interface InsightsRouteDeps {
  store: InsightsStore;
  service: Pick<ReviewService, 'accept' | 'dismiss'>;
  audit: AuditLog;
  /** (CS6) The run-cost facts route's verifier and preparer; absent = `POST /insights/facts` answers 503. */
  facts?: InsightsFactsDeps;
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

  // WORKER-FACING (bearer-exempt, `isUnitTokenRoute`): the body's unit token is the credential, verified on every
  // call. Only the `facts` step of a `run-cost` run, running its exact command, is answered: any other unit's token
  // (an agent step, another workflow's Tool, an unknown unit) is refused. Nothing here reads `req.actor`.
  app.post(
    `${V}/insights/facts`,
    { config: { manifest: { statusCodes: [200, 400, 401, 403, 503] } } },
    async (req, reply) => {
      const facts = deps.facts;
      if (facts === undefined) {
        return reply.code(503).send({ code: 'facts_unavailable', error: "this engine cannot verify a unit's token for the run-cost facts yet" });
      }
      const parsed = FactsSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: 'bad_request', error: 'body must be { token }' });
      const unit = await facts.unitOf(parsed.data.token);
      if (unit === null) return reply.code(401).send({ code: 'invalid_token', error: 'the unit token is not valid' });
      if (unit.workflow !== RUN_COST_WORKFLOW || unit.phase !== RUN_COST_FACTS_STEP || !sameCmd(unit.toolCmd)) {
        return reply.code(403).send({
          code: 'not_the_facts_step',
          error: `the ${unit.phase} step of run ${unit.runId} (${unit.workflow ?? 'unnamed'}) cannot read the run-cost facts; only a run-cost run's facts step can`,
        });
      }
      const now = (facts.now ?? Date.now)();
      const window = costWindow(now);
      const runs = await facts.collect({ startMs: window.startMs, endMs: window.endMs }, now);
      return costFacts(runs, { window, generatedAtMs: now, excludeRunId: unit.runId });
    },
  );
}
