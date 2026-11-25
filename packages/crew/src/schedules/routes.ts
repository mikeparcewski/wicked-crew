/**
 * `/api/v1/schedules` (DES-RUNS-REVIEW-001 §2): read, save, delete and run-now a workflow schedule. Writes are a
 * person's (the watch routes' human-operator predicate): a worker or system actor may read but never schedule spend.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from '../zod.js';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { isHumanOperator } from '../api/watch-routes.js';
import { NoIndependentReviewer, ReviewPreparationRefused, isNoIndependentReviewerNote } from '../insights/review-service.js';
import { ScheduleBusyError, type WorkflowScheduler } from './scheduler.js';
import { MAX_EVERY_HOURS, MIN_EVERY_HOURS, notSchedulable, SCHEDULE_ID, type ScheduleStore, type WorkflowSchedule } from './store.js';

const V = API_PREFIX;

export const SchedulePutSchema = z.strictObject({
  workflow: z.string().min(1).max(128),
  everyHours: z.int().min(MIN_EVERY_HOURS).max(MAX_EVERY_HOURS),
  enabled: z.boolean().optional(),
  projectIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  repoRef: z.string().min(1).max(256).nullable().optional(),
  problem: z.string().trim().min(1).max(4000).nullable().optional(),
  /** (crew#1837) Accept (or withdraw) reduced assurance for this schedule's runs. */
  reducedAssurance: z.boolean().optional(),
});

/** (crew#1837) `POST /schedules/:id/run`: `reducedAssurance: true` is the person accepting it, kept on the schedule. */
export const ScheduleRunSchema = z.strictObject({
  reducedAssurance: z.literal(true).optional(),
});

/** The answer to a run every eligible seat took part in: the shape a hand launch of the review answers with. */
const RETRY_REDUCED = { reducedAssurance: true } as const;

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
  type View = WorkflowSchedule & { lastReview?: ReturnType<NonNullable<ScheduleRouteDeps['lastReview']>>; retryWith?: typeof RETRY_REDUCED };
  const view = (row: WorkflowSchedule): View => {
    const out: View = row.workflow === 'review-recent-work' && deps.lastReview !== undefined ? { ...row, lastReview: deps.lastReview() } : { ...row };
    // (crew#1837) The last start was refused because every seat that could review the work ran some of it: the
    // person's one accept (PUT or Run it now with reducedAssurance) lets it run.
    if (row.lastOutcome === 'refused' && !row.reducedAssurance && isNoIndependentReviewerNote(row.lastNote)) out.retryWith = RETRY_REDUCED;
    // (J6 M1, codex r1) A row whose workflow can never run on a schedule says so in every listing, due or not.
    const never = notSchedulable(row.workflow);
    if (never !== null) out.lastNote = `skipped: ${never}`;
    return out;
  };

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
      // (J6 K1, coord R2 F4) A domain model maps what a person says it should cover, after they see its scope; a
      // schedule has no one to say it, so it would fail on every tick. Refused when it is saved, in words.
      const never = notSchedulable(parsed.data.workflow);
      if (never !== null) return reply.code(400).send({ code: 'workflow_not_schedulable', error: never });
      const row = deps.store.put(id, parsed.data, now());
      deps.audit.record('schedule.saved', actor, { detail: { id, workflow: row.workflow, everyHours: row.everyHours, enabled: row.enabled, reducedAssurance: row.reducedAssurance } });
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
    { config: { manifest: { requestType: 'ScheduleRunBody', responseType: 'ScheduleRunResponse', statusCodes: [200, 400, 403, 404, 409, 502] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      const parsed = ScheduleRunSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      const row = deps.store.get(id);
      if (row === undefined) return reply.code(404).send({ error: `no schedule ${id}` });
      // (crew#1837) The person's accept is kept: the schedule's own runs take it from here, not only this one.
      if (parsed.data.reducedAssurance === true && !row.reducedAssurance) {
        deps.store.update(id, { reducedAssurance: true }, now());
        deps.audit.record('schedule.saved', actor, { detail: { id, workflow: row.workflow, reducedAssurance: true, via: 'run_now' } });
      }
      try {
        const runId = await deps.scheduler.runNow(id);
        deps.audit.record('schedule.run_now', actor, { runId, detail: { id } });
        return { runId, schedule: view(deps.store.get(id) as WorkflowSchedule) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A review that can't be prepared (crew#1592: its seat, the `newWorkSeats` setting) is the person's to fix: 409 with
        // the same words as a hand launch, never a 502.
        if (err instanceof NoIndependentReviewer) {
          return reply.code(409).send({ code: err.code, error: `the review could not be prepared: ${message}`, excluded: err.excluded, retryWith: RETRY_REDUCED });
        }
        if (err instanceof ReviewPreparationRefused) return reply.code(409).send({ error: `the review could not be prepared: ${message}` });
        return reply.code(err instanceof ScheduleBusyError ? 409 : 502).send({ error: message });
      }
    },
  );
}
