/**
 * `/api/v1/runs/:id/working-doc` (program DES-POWER-MODE §8.3, §9; spike 3).
 *
 *  - `GET  /runs/:id/working-doc` (observer+): the document's sections at its head, the version trail (who, through
 *    which surface, which sections, when, and the steer each made) and the steering notes (sent, picked up by which
 *    step). `doc: null` until one is made.
 *  - `POST /runs/:id/working-doc` (operator+): make it (idempotent). Its Goal is seeded from the run's intent, by crew.
 *  - `POST /runs/:id/working-doc/versions {base, sections, author, plugin?}` (operator+): one version. `author:
 *    'operator'` only from a person (403 otherwise); `author: 'plugin'` writes only the plugin's own section. A
 *    person's version becomes one steering note (see `service.ts`); a plugin's never does. 409 `{head}` when the
 *    document moved since `base`.
 *
 * Nothing here answers a gate or launches a run.
 */

import type { FastifyInstance } from 'fastify';

import { LOCAL_ACTOR, trustAtLeast } from '../api/auth.js';
import type { Actor } from '../core/types.js';
import type { WorkingDocService } from './service.js';

const V = '/api/v1';

export function registerWorkingDocRoutes(app: FastifyInstance, deps: { service: WorkingDocService; exists(runId: string): Promise<boolean> }): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const operator = (actor: Actor): boolean => trustAtLeast(actor, 'operator');

  app.get(`${V}/runs/:id/working-doc`, { config: { manifest: { responseType: 'WorkingDocView', statusCodes: [200, 404, 503] } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await deps.exists(id))) return reply.code(404).send({ error: 'Run not found' });
    try {
      return await deps.service.view(id);
    } catch (err) {
      return reply.code(503).send({ error: `the working document could not be read: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post(`${V}/runs/:id/working-doc`, { config: { manifest: { responseType: 'WorkingDocView', statusCodes: [200, 403, 404, 503] } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!operator(actorOf(req))) return reply.code(403).send({ error: 'making a working document needs operator trust' });
    if (!(await deps.exists(id))) return reply.code(404).send({ error: 'Run not found' });
    try {
      const view = await deps.service.ensure(id);
      if (view === null) return reply.code(404).send({ error: 'Run not found' });
      return view;
    } catch (err) {
      return reply.code(503).send({ error: `the working document could not be made: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.post(`${V}/runs/:id/working-doc/versions`, { config: { manifest: { requestType: 'ProposeWorkingDocRequest', responseType: 'ProposeWorkingDocResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // A plugin actor (observer trust) writes its OWN lines, as itself, and nothing else; everyone else needs operator.
    const pluginSelf = actor.kind === 'plugin' && body['author'] === 'plugin'
      && typeof body['plugin'] === 'object' && body['plugin'] !== null
      && actor.id === `plugin:${String((body['plugin'] as Record<string, unknown>)['id'])}@${String((body['plugin'] as Record<string, unknown>)['version'])}`;
    if (!operator(actor) && !pluginSelf) return reply.code(403).send({ error: 'editing the working document needs operator trust' });
    const plugin = body['plugin'];
    const pluginRef = typeof plugin === 'object' && plugin !== null
      && typeof (plugin as Record<string, unknown>)['id'] === 'string' && typeof (plugin as Record<string, unknown>)['version'] === 'string'
      ? { id: (plugin as { id: string }).id, version: (plugin as { version: string }).version }
      : undefined;
    if (plugin !== undefined && pluginRef === undefined) return reply.code(400).send({ error: 'plugin must be {id, version}' });
    if (typeof body['sections'] !== 'object' || body['sections'] === null || Array.isArray(body['sections'])) {
      return reply.code(400).send({ error: 'sections must be an object of section id to text' });
    }
    if (!(await deps.exists(id))) return reply.code(404).send({ error: 'Run not found' });
    try {
      const r = await deps.service.propose(id, {
        base: body['base'] as number,
        sections: body['sections'] as Record<string, unknown>,
        author: body['author'] as 'operator' | 'plugin',
        plugin: pluginRef,
      }, actor);
      if (!r.ok) return reply.code(r.code).send({ error: r.error, ...(r.head !== undefined ? { head: r.head } : {}) });
      return { version: r.version, unchanged: r.unchanged, steer: r.steer, view: r.view };
    } catch (err) {
      return reply.code(503).send({ error: `the edit could not be saved: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}
