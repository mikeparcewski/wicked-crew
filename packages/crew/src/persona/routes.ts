/**
 * `/api/v1/persona` (program DES-LEARN §3.3): read and save the orchestrator's personality — the
 * person's own (`scope=user`) and a project's override (`scope=project:<id>`). Reads are anyone's;
 * a save or a removal is a PERSON's (the watch routes' human-operator predicate), audited.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CoreAdapter } from '../core/adapter.js';
import type { Actor } from '../core/types.js';
import { API_PREFIX } from '../api/api-prefix.js';
import { LOCAL_ACTOR } from '../api/auth.js';
import type { AuditLog } from '../api/audit.js';
import { isHumanOperator } from '../api/watch-routes.js';
import { parseScope, PersonaInputSchema, type Persona, type PersonaStore } from './store.js';
import { voiceBlock } from './voice.js';

const V = API_PREFIX;

export const PersonaPutSchema = z.object({ scope: z.string().min(1).max(200), persona: PersonaInputSchema }).strict();

export interface PersonaRouteDeps {
  store: PersonaStore;
  adapter: Pick<CoreAdapter, 'projectGet'>;
  audit: AuditLog;
}

const voices = (m: Record<string, Persona>): Record<string, string> =>
  Object.fromEntries(Object.entries(m).map(([k, p]) => [k, voiceBlock(p)]));

export function registerPersonaRoutes(app: FastifyInstance, deps: PersonaRouteDeps): void {
  const actorOf = (req: { actor?: Actor }): Actor => req.actor ?? LOCAL_ACTOR;
  const refuse = (reply: FastifyReply): FastifyReply =>
    reply.code(403).send({ error: 'Only a person can change a personality (a worker or system actor cannot)' });
  const projectKnown = async (scope: string): Promise<boolean> =>
    !scope.startsWith('project:') || (await deps.adapter.projectGet(scope.slice('project:'.length))) !== null;

  app.get(
    `${V}/persona`,
    { config: { manifest: { responseType: 'PersonaResponse', statusCodes: [200] } } },
    async () => {
      const user = deps.store.userPersona();
      const projects = deps.store.overrides();
      return { user, projects, voice: { user: user === null ? null : voiceBlock(user), projects: voices(projects) } };
    },
  );

  app.put(
    `${V}/persona`,
    { config: { manifest: { requestType: 'PersonaPutBody', responseType: 'PersonaSaved', statusCodes: [200, 400, 403, 404, 500] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const parsed = PersonaPutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      }
      const scope = parseScope(parsed.data.scope);
      if (scope === null) return reply.code(400).send({ error: 'scope is "user" or "project:<id>"' });
      if (!(await projectKnown(scope))) return reply.code(404).send({ error: `no project '${scope.slice('project:'.length)}'` });
      let persona: Persona;
      try {
        persona = deps.store.save(scope, parsed.data.persona);
      } catch (err) {
        return reply.code(500).send({ error: `the personality could not be saved: ${err instanceof Error ? err.message : String(err)}` });
      }
      deps.audit.record('persona.saved', actor, { detail: { scope, version: persona.version } });
      return { scope, persona, voice: voiceBlock(persona) };
    },
  );

  app.delete(
    `${V}/persona`,
    { config: { manifest: { responseType: 'PersonaRemoved', statusCodes: [200, 400, 403, 404, 500] } } },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!isHumanOperator(actor)) return refuse(reply);
      const raw = (req.query as { scope?: string | string[] }).scope;
      const scope = parseScope(Array.isArray(raw) ? raw[0] : raw);
      if (scope === null || scope === 'user') {
        return reply.code(400).send({ error: 'only a project override can be removed: scope=project:<id>' });
      }
      let removed: boolean;
      try {
        removed = deps.store.remove(scope.slice('project:'.length));
      } catch (err) {
        return reply.code(500).send({ error: `the override could not be removed: ${err instanceof Error ? err.message : String(err)}` });
      }
      if (!removed) return reply.code(404).send({ error: `${scope} has no override` });
      deps.audit.record('persona.removed', actor, { detail: { scope } });
      return { removed: true, scope };
    },
  );
}
