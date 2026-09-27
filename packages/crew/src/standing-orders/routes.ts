/**
 * Standing orders (Studio OS behaviour 10) — the routes.
 *
 *   GET    /standing-orders            the away flag, the orders, the queued outbox
 *   PUT    /standing-orders/away       `{ away }` — turning it on re-sweeps the open gates
 *   POST   /standing-orders/parse      `{ text }` → `{ rule, seat }`: ONE seat reads the words (a
 *                                      one-turn chat, closed after); the studio shows the rule back
 *   POST   /standing-orders            `{ text, rule }` — the CONFIRMED rule; the invariant refuses
 *                                      an approve of the deliver gate, a plan approval or a finding
 *   DELETE /standing-orders/:id        retire an order
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_PREFIX } from '../api/api-prefix.js';
import type { AuditLog } from '../api/audit.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { Actor } from '../core/types.js';
import type { StandingOrderEvaluator } from './evaluator.js';
import { refusal, StandingOrderRuleSchema, type StandingOrderRule, type StandingOrderStore } from './store.js';

const V = API_PREFIX;

export const CreateStandingOrderSchema = z
  .object({ text: z.string().trim().min(1).max(500), rule: StandingOrderRuleSchema })
  .strict();
export const ParseStandingOrderSchema = z.object({ text: z.string().trim().min(1).max(500) }).strict();
export const StandingAwaySchema = z.object({ away: z.boolean() }).strict();

/** The seat's parse: a rule it produced, or why it could not (its own answer, for the person). */
export type ParseOutcome =
  | { ok: true; rule: StandingOrderRule; seat: string }
  | { ok: false; code: 409 | 422 | 502; error: string; answer?: string };

export interface StandingOrderRouteDeps {
  store: StandingOrderStore;
  evaluator: StandingOrderEvaluator;
  audit: Pick<AuditLog, 'record'>;
  parse: (text: string) => Promise<ParseOutcome>;
}

/** The seat's instructions: the rule schema in words, the projects it may scope to, the words. */
export function parsePrompt(text: string, projects: Array<{ id: string; name: string }>): string {
  return [
    'Turn this standing order into ONE JSON object and answer with the JSON only, no prose.',
    'Shape: {"scope":{"kind":"all"} or {"kind":"project","projectId":"<id>"},',
    ' "trigger":{"kind":"gate","phase":"<phase name, e.g. intake, design, build, test, review, or *>"}',
    '  or {"kind":"finding","severity":"high"|"medium"|"*"},',
    ' "action":"approve"|"hold"|"notify", "activeWhen":"away"|"always"}.',
    '"wake me", "tell me", "ping me" = notify. "hold", "keep", "wait" = hold. "auto-approve", "clear" = approve.',
    'An order that says nothing about being away applies while away ("activeWhen":"away").',
    `Projects (id: name): ${projects.map((p) => `${p.id}: ${p.name}`).join('; ') || 'none'}.`,
    `Order: ${text}`,
  ].join('\n');
}

/** The first JSON object in a seat's answer that is a valid rule, or undefined. */
export function ruleFromAnswer(answer: string): StandingOrderRule | undefined {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = StandingOrderRuleSchema.safeParse(JSON.parse(answer.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function registerStandingOrderRoutes(app: FastifyInstance, deps: StandingOrderRouteDeps): void {
  const { store, evaluator, audit } = deps;
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const invalid = (error: z.ZodError) => ({ error: 'Invalid request body', details: error.issues });

  app.get(
    `${V}/standing-orders`,
    { config: { manifest: { responseType: 'StandingOrdersState', statusCodes: [200] } } },
    async () => store.snapshot(),
  );

  app.put(
    `${V}/standing-orders/away`,
    { config: { manifest: { requestType: 'StandingAwayBody', responseType: 'StandingOrdersState', statusCodes: [200, 400] } } },
    async (req, reply) => {
      const parsed = StandingAwaySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
      const was = store.away;
      store.setAway(parsed.data.away);
      if (was !== parsed.data.away) audit.record('standing-order.away', actorOf(req), { detail: { away: parsed.data.away } });
      if (parsed.data.away && !was) await evaluator.sweep();
      return store.snapshot();
    },
  );

  app.post(
    `${V}/standing-orders/parse`,
    {
      config: {
        manifest: { requestType: 'ParseStandingOrderBody', responseType: 'ParsedStandingOrder', statusCodes: [200, 400, 409, 422, 502] },
      },
    },
    async (req, reply) => {
      const parsed = ParseStandingOrderSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
      const out = await deps.parse(parsed.data.text);
      if (!out.ok) {
        return reply.code(out.code).send({ error: out.error, ...(out.answer !== undefined ? { answer: out.answer } : {}) });
      }
      const refused = refusal(out.rule);
      return { rule: out.rule, seat: out.seat, ...(refused !== null ? { refused } : {}) };
    },
  );

  app.post(
    `${V}/standing-orders`,
    { config: { manifest: { requestType: 'CreateStandingOrderBody', responseType: '{ order: StandingOrder }', statusCodes: [201, 400] } } },
    async (req, reply) => {
      const parsed = CreateStandingOrderSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
      const refused = refusal(parsed.data.rule);
      if (refused !== null) return reply.code(400).send({ error: refused, code: 'order_refused' });
      const order = store.add(parsed.data.text, parsed.data.rule);
      audit.record('standing-order.created', actorOf(req), { detail: { standingOrder: { id: order.id, text: order.text }, rule: order.rule } });
      await evaluator.sweep();
      return reply.code(201).send({ order });
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${V}/standing-orders/:id`,
    { config: { manifest: { responseType: '{ removed: true }', statusCodes: [200, 404] } } },
    async (req, reply) => {
      if (!store.remove(req.params.id)) return reply.code(404).send({ error: 'Standing order not found' });
      audit.record('standing-order.retired', actorOf(req), { detail: { standingOrder: { id: req.params.id } } });
      return { removed: true };
    },
  );
}
