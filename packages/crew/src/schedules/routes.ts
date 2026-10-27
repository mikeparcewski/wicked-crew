/**
 * `/api/v1/schedules` (DES-RUNS-REVIEW-001 §2): read, save, delete and run-now a workflow schedule. Writes are a
 * person's (the watch routes' human-operator predicate): a worker or system actor may read but never schedule spend.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { isHumanOperator } from '../api/watch-routes.js';
import { ScheduleBusyError, type WorkflowScheduler } from './scheduler.js';
import { MAX_EVERY_HOURS, MIN_EVERY_HOURS, SCHEDULE_ID, type ScheduleStore, type WorkflowSchedule } from './store.js';

const V = API_PREFIX;

export const SchedulePutSchema = z
  .object({
    workflow: z.string().min(1).max(128),
    everyHours: z.number().int().min(MIN_EVERY_HOURS).max(MAX_EVERY_HOURS),
    enabled: z.boolean().optional(),
    projectIds: z.array(z.string().min(1).max(128)).max(64).optional(),
    repoRef: z.string().min(1).max(256).nullable().optional(),
    problem: z.string().trim().min(1).max(4000).nullable().optional(),
  })
  .strict();

export interface ScheduleRouteDeps {
  store: ScheduleStore;
  scheduler: Pick<WorkflowScheduler, 'runNow'>;
  /** Whether a workflow id is one this daemon can launch. */
  knowsWorkflow: (id: string) => boolean;
  /** The latest review (date and outcome) for Settings, when the schedule runs the review. */
  lastReview?: () => { runId: string; launchedAt: string; endedAt: string | null; status: string } | null;
  audit: AuditLog;
  now?: () => Date;
}

export function registerScheduleRoutes(app: FastifyInstance, deps: ScheduleRouteDeps): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const now = (): Date => deps.now?.() ?? new Date();
  const refuse = (reply: FastifyReply): FastifyReply =>
    reply.code(403).send({ error: 'Only a person can change a schedule (a worker or system actor cannot)' });
  const view = (row: WorkflowSchedule): WorkflowSchedule & { lastReview?: ReturnType<NonNullable<ScheduleRouteDeps['lastReview']>> } =>
    row.workflow === 'review-recent-work' && deps.lastReview !== undefined ? { ...row, lastReview: deps.lastReview() } : row;

  app.get(
    `${V}/schedules`,
    { config: { manifest: { responseType: 'SchedulesResponse', statusCodes: [200] } } },
    async () => ({ schedules: deps.store.list().map(view) }),
  );

  app.put(
    `${V}/schedules/:id`,
    { config: { manifest: { requestType: 'SchedulePutBody', responseType: 'WorkflowSchedule', statusCodes: [200, 400, 403, 404] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      if (!SCHEDULE_ID.test(id)) return reply.code(400).send({ error: 'a schedule id is kebab-case, at most 64 characters' });
      const parsed = SchedulePutSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      if (!deps.knowsWorkflow(parsed.data.workflow)) return reply.code(404).send({ error: `no workflow ${parsed.data.workflow}` });
      const row = deps.store.put(id, parsed.data, now());
      deps.audit.record('schedule.saved', actor, { detail: { id, workflow: row.workflow, everyHours: row.everyHours, enabled: row.enabled } });
      return view(row);
    },
  );

  app.delete(
    `${V}/schedules/:id`,
    { config: { manifest: { responseType: '{ deleted: true; id: string }', statusCodes: [200, 403, 404] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      if (!deps.store.delete(id)) return reply.code(404).send({ error: `no schedule ${id}` });
      deps.audit.record('schedule.deleted', actor, { detail: { id } });
      return { deleted: true as const, id };
    },
  );

  app.post(
    `${V}/schedules/:id/run`,
    { config: { manifest: { responseType: 'ScheduleRunResponse', statusCodes: [200, 403, 404, 409, 502] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      if (deps.store.get(id) === undefined) return reply.code(404).send({ error: `no schedule ${id}` });
      try {
        const runId = await deps.scheduler.runNow(id);
        deps.audit.record('schedule.run_now', actor, { runId, detail: { id } });
        return { runId, schedule: view(deps.store.get(id) as WorkflowSchedule) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(err instanceof ScheduleBusyError ? 409 : 502).send({ error: message });
      }
    },
  );
}
