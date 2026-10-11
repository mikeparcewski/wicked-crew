/**
 * `/api/v1/learn/schedules` (DES-learn-workflow §5.2): read, save, delete and run-now a learned
 * topic's refresh schedule. Writes are a person's (the watch routes' human-operator predicate): a
 * worker or system actor may read but never schedule spend.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { isHumanOperator } from '../api/watch-routes.js';
import { mergedSource, readTopics } from './topics.js';
import { LEARN_SLUG, MAX_EVERY_HOURS, MIN_EVERY_HOURS, scheduleId, type LearnScheduleStore } from './schedule-store.js';

const V = API_PREFIX;

export const LearnSchedulePutSchema = z
  .object({
    repoRef: z.string().min(1).max(256),
    slug: z.string().regex(LEARN_SLUG, 'slug is kebab-case, at most 64 characters'),
    topic: z.string().trim().min(1).max(200),
    everyHours: z.number().int().min(MIN_EVERY_HOURS).max(MAX_EVERY_HOURS),
    enabled: z.boolean().optional(),
    projectId: z.string().min(1).max(128).optional(),
  })
  .strict();

export interface LearnRouteDeps {
  store: LearnScheduleStore;
  adapter: Pick<CoreAdapter, 'listRepos'>;
  /** Days without re-verification after which an UNSCHEDULED topic's active claim counts as stale. */
  defaultStaleDays?: number;
  audit: AuditLog;
  now?: () => Date;
}

function bad(reply: FastifyReply, error: string): FastifyReply {
  return reply.code(400).send({ error });
}

export function registerLearnRoutes(app: FastifyInstance, deps: LearnRouteDeps): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const now = (): Date => deps.now?.() ?? new Date();
  const refuse = (reply: FastifyReply): FastifyReply =>
    reply.code(403).send({ error: 'Only a person can change a learn schedule (a worker or system actor cannot)' });

  app.get(
    `${V}/learn/schedules`,
    { config: { manifest: { responseType: 'LearnSchedulesResponse', statusCodes: [200] } } },
    async () => ({ schedules: deps.store.list() }),
  );

  // The learned topics of one registered repository, read from its checkout. A topic on a schedule
  // goes stale after two of its intervals without re-verification; an unscheduled one after 60 days.
  app.get(
    `${V}/learn/topics`,
    { config: { manifest: { responseType: 'LearnTopicsResponse', statusCodes: [200, 400, 404] } } },
    async (req, reply) => {
      const { repoRef } = req.query as { repoRef?: string };
      if (typeof repoRef !== 'string' || repoRef === '') return bad(reply, 'repoRef is required');
      const repo = (await deps.adapter.listRepos()).find((r) => r.id === repoRef);
      if (repo === undefined) return reply.code(404).send({ error: `no registered repository ${repoRef}` });
      const schedules = deps.store.list().filter((s) => s.repoRef === repoRef);
      const staleDays = (slug: string): number => {
        const s = schedules.find((x) => x.slug === slug);
        return s !== undefined ? (2 * s.everyHours) / 24 : (deps.defaultStaleDays ?? 60);
      };
      return { repoRef, topics: await readTopics(await mergedSource(repo.root_path, repo.default_branch), staleDays, now()) };
    },
  );

  app.put(
    `${V}/learn/schedules/:id`,
    { config: { manifest: { requestType: 'LearnSchedulePutBody', responseType: 'LearnSchedule', statusCodes: [200, 400, 403, 404] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const parsed = LearnSchedulePutSchema.safeParse(req.body);
      if (!parsed.success) return bad(reply, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
      const { id } = req.params as { id: string };
      const body = parsed.data;
      if (id !== scheduleId(body.repoRef, body.slug)) return bad(reply, 'the id must be <repoRef>:<slug>');
      if (!(await deps.adapter.listRepos()).some((r) => r.id === body.repoRef)) {
        return reply.code(404).send({ error: `no registered repository ${body.repoRef}` });
      }
      const row = deps.store.put(body, now());
      deps.audit.record('learn.schedule.saved', actor, { detail: { id, everyHours: row.everyHours, enabled: row.enabled } });
      return row;
    },
  );

  app.delete(
    `${V}/learn/schedules/:id`,
    { config: { manifest: { responseType: '{ deleted: true; id: string }', statusCodes: [200, 403, 404] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      if (!deps.store.delete(id)) return reply.code(404).send({ error: `no learn schedule ${id}` });
      deps.audit.record('learn.schedule.deleted', actor, { detail: { id } });
      return { deleted: true as const, id };
    },
  );

  app.post(
    `${V}/learn/schedules/:id/run-now`,
    { config: { manifest: { responseType: 'LearnSchedule', statusCodes: [200, 403, 404] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const { id } = req.params as { id: string };
      const row = deps.store.update(id, { nextDueAt: now().toISOString() }, now());
      if (row === undefined) return reply.code(404).send({ error: `no learn schedule ${id}` });
      deps.audit.record('learn.schedule.run_now', actor, { detail: { id } });
      return row;
    },
  );
}
