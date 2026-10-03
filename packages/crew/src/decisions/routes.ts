/**
 * `/decisions` (DES-decision-capture §4.6, DC-S4a; api-types 0.80.0). Every route is operator+,
 * including the GET (the words are the operator's, review N11), and every write additionally passes
 * the human check inside `remember()` & co. No endpoint takes words for a new decision: words
 * enter only through the operator routes (gate, elicitation, inject; chat in DC-S4b).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import { API_PREFIX } from '../api/api-prefix.js';
import type { Actor, ListDecisionsResponse } from '../core/types.js';
import { DecisionError, type DecisionService, type RememberEdits } from './land.js';
import type { DecisionFilter } from './ledger.js';

const V = API_PREFIX;
const STEERING = z.enum(['architecture', 'development', 'security', 'testing', 'operations', 'compliance', 'design-ux']);
const RememberSchema = z
  .object({
    scope: z.enum(['project', 'everywhere']).optional(),
    steering_type: STEERING.optional(),
    statement: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
const DismissSchema = z
  .object({ reason: z.enum(['not-a-rule', 'one-off', 'wrong-type', 'wrong-scope', 'not-the-same', 'undone']) })
  .strict();
const SameSchema = z.object({ same: z.boolean() }).strict();
const STATES = new Set(['recorded', 'offered', 'remembered', 'undone', 'dismissed', 'restated', 'widened', 'landing_failed']);

export function registerDecisionRoutes(app: FastifyInstance, service: DecisionService): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const refuse = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof DecisionError) return reply.code(err.status).send({ error: err.message });
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  };
  const operatorOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    const actor = actorOf(req);
    if (trustAtLeast(actor, 'operator')) return true;
    void reply.code(403).send({ error: `Insufficient trust: decisions require 'operator' (you are '${actor.trust}')` });
    return false;
  };
  const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id.trim();

  app.get(
    `${V}/decisions`,
    { config: { manifest: { responseType: 'ListDecisionsResponse', statusCodes: [200, 400, 403] } } },
    async (req, reply) => {
      if (!operatorOnly(req, reply)) return reply;
      const q = req.query as Record<string, string | string[] | undefined>;
      const one = (k: string): string | undefined => {
        const v = q[k];
        const s = Array.isArray(v) ? v[0] : v;
        return typeof s === 'string' && s.trim() !== '' ? s.trim() : undefined;
      };
      const state = one('state');
      if (state !== undefined && !STATES.has(state)) {
        return reply.code(400).send({ error: `\`state\` must be one of ${[...STATES].join('|')}` });
      }
      const sinceRaw = one('since');
      const since = sinceRaw !== undefined ? Number(sinceRaw) : undefined;
      if (since !== undefined && !Number.isFinite(since)) {
        return reply.code(400).send({ error: '`since` must be epoch milliseconds' });
      }
      const filter: DecisionFilter = {};
      const project = one('project');
      const chat = one('chat');
      const run = one('run');
      if (project !== undefined) filter.project = project;
      if (chat !== undefined) filter.chat = chat;
      if (run !== undefined) filter.run = run;
      if (state !== undefined) filter.state = state as NonNullable<DecisionFilter['state']>;
      if (since !== undefined) filter.since = since;
      const body: ListDecisionsResponse = {
        decisions: service.deps.ledger.list(filter),
        mode: service.mode,
      };
      return body;
    },
  );

  app.post(
    `${V}/decisions/:id/remember`,
    {
      config: {
        manifest: { requestType: 'RememberDecisionBody', responseType: 'RememberDecisionResponse', statusCodes: [200, 400, 403, 404, 409, 502] },
      },
    },
    async (req, reply) => {
      const parsed = RememberSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      try {
        const edits: RememberEdits = {};
        if (parsed.data.statement !== undefined) edits.statement = parsed.data.statement;
        if (parsed.data.scope !== undefined) edits.scope = parsed.data.scope;
        if (parsed.data.steering_type !== undefined) edits.steering_type = parsed.data.steering_type;
        return await service.remember(idOf(req), actorOf(req), { how: 'chip', edits });
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  app.post(
    `${V}/decisions/:id/undo`,
    { config: { manifest: { responseType: '{ ok: true }', statusCodes: [200, 403, 404, 409, 502] } } },
    async (req, reply) => {
      try {
        await service.undo(idOf(req), actorOf(req));
        return { ok: true };
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  app.post(
    `${V}/decisions/:id/dismiss`,
    { config: { manifest: { requestType: 'DismissDecisionBody', responseType: '{ ok: true }', statusCodes: [200, 400, 403, 404, 409, 502] } } },
    async (req, reply) => {
      const parsed = DismissSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      try {
        await service.dismiss(idOf(req), actorOf(req), parsed.data.reason);
        return { ok: true };
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  app.post(
    `${V}/decisions/:id/widen`,
    { config: { manifest: { responseType: '{ rule_id: string }', statusCodes: [200, 403, 404, 409, 502] } } },
    async (req, reply) => {
      try {
        return await service.widen(idOf(req), actorOf(req));
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );

  app.post(
    `${V}/decisions/:id/same`,
    { config: { manifest: { requestType: 'SameDecisionBody', responseType: '{ rule_id?: string }', statusCodes: [200, 400, 403, 404, 409, 502] } } },
    async (req, reply) => {
      const parsed = SameSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      try {
        return await service.same(idOf(req), actorOf(req), parsed.data.same);
      } catch (err) {
        return refuse(reply, err);
      }
    },
  );
}
