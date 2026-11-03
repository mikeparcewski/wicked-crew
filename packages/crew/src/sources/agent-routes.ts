/**
 * The source sheet's agent controls and records (DES-APPS-001 rev 12 §5.4):
 *
 *   PUT /sources/:name/agents          HUMAN      "Agents can see this structure", "Agents can query this source",
 *                                                 and the projects; each change audited
 *   GET /sources/:name/agent-queries   observer   the last 20 agent queries of the source (no SQL, no value)
 *   GET /runs/:id/data-use             observer   the sources a run's agents queried (gate cards, delivery)
 *
 * The agent tools themselves are `agent-tools.ts`, reached through the broker (`mcp:sources/<tool>`).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { API_PREFIX } from '../api/api-prefix.js';
import { trustAtLeast } from '../api/auth.js';
import type { Actor, RunDataUseResponse, SourceAgentAccessResponse, SourceAgentQueriesResponse } from '../core/types.js';
import { MCP_SERVER_NAME_RE } from '../mcp/classify.js';
import { McpRegistryError, type McpRegistry } from '../mcp/registry.js';
import { McpRegistryCorruptError } from '../mcp/registry-store.js';
import { AGENT_PROJECT_RE, AGENT_PROJECTS_MAX, type SourceAgentAccess } from './agent-access.js';
import type { SourceAgentQueryLog } from './agent-queries.js';

const V = API_PREFIX;

export const SourceAgentAccessSchema = z
  .object({
    see: z.boolean().optional(),
    query: z.boolean().optional(),
    projects: z.array(z.string().regex(AGENT_PROJECT_RE)).max(AGENT_PROJECTS_MAX).optional(),
    everyProject: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.see !== undefined || b.query !== undefined || b.projects !== undefined || b.everyProject !== undefined, { message: 'set see, query, projects or everyProject' });

export interface SourceAgentRouteDeps {
  registry?: McpRegistry;
  queries?: SourceAgentQueryLog;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
}

function isHumanOperator(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

/** The audit lines a change of the controls writes: one per control that changed. */
function changes(before: SourceAgentAccess, after: SourceAgentAccess, source: string): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  if (before.see !== after.see) out.push([after.see ? 'apps.source.catalog_visible' : 'apps.source.catalog_hidden', { source }]);
  if (before.query !== after.query) out.push([after.query ? 'apps.source.agent_query_allowed' : 'apps.source.agent_query_disallowed', { source, ...(before.see !== after.see && !after.see ? { because: 'see_off' } : {}) }]);
  if (before.everyProject !== after.everyProject || JSON.stringify(before.projects) !== JSON.stringify(after.projects)) {
    out.push(['apps.source.agent_projects_set', { source, projects: after.projects, everyProject: after.everyProject }]);
  }
  return out;
}

export function registerSourceAgentRoutes(app: FastifyInstance, deps: SourceAgentRouteDeps): void {
  app.put<{ Params: { name: string } }>(
    `${V}/sources/:name/agents`,
    { config: { manifest: { requestType: 'SourceAgentAccessBody', responseType: 'SourceAgentAccessResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } },
    async (req, reply) => {
      const parsed = SourceAgentAccessSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      const actor = deps.actorOf(req);
      // Human-only, like Allow writes: an agent-kind token, whatever its trust, never changes what agents may use.
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `only a human operator can change what agents may do with a source; you are ${actor.kind}/${actor.trust}`, code: 'agents_switch_human_only' });
      }
      if (deps.registry === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      if (!MCP_SERVER_NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'not a source name', code: 'bad_name' });
      try {
        const b = parsed.data;
        const patch: Partial<SourceAgentAccess> = {
          ...(b.see !== undefined ? { see: b.see } : {}),
          ...(b.query !== undefined ? { query: b.query } : {}),
          ...(b.projects !== undefined ? { projects: b.projects } : {}),
          ...(b.everyProject !== undefined ? { everyProject: b.everyProject } : {}),
        };
        const { before, after } = await deps.registry.setAgentAccess(req.params.name, patch);
        for (const [action, detail] of changes(before, after, req.params.name)) deps.audit.record(action, actor, { detail });
        const body: SourceAgentAccessResponse = { name: req.params.name, agents: after };
        return body;
      } catch (err) {
        if (err instanceof McpRegistryError) return reply.code(err.status).send({ error: err.message, code: err.code });
        if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
        throw err;
      }
    },
  );

  app.get<{ Params: { name: string } }>(
    `${V}/sources/:name/agent-queries`,
    { config: { manifest: { responseType: 'SourceAgentQueriesResponse', statusCodes: [200, 400, 503] } } },
    async (req, reply) => {
      if (!MCP_SERVER_NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'not a source name', code: 'bad_name' });
      if (deps.queries === undefined) return reply.code(503).send({ error: 'this daemon keeps no agent-query record', code: 'record_unavailable' });
      const recent = await deps.queries.recent(req.params.name, 20);
      const body: SourceAgentQueriesResponse =
        recent === null
          ? { name: req.params.name, known: false, queries: [] }
          : { name: req.params.name, known: true, queries: recent };
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    `${V}/runs/:id/data-use`,
    { config: { manifest: { responseType: 'RunDataUseResponse', statusCodes: [200, 503] } } },
    async (req, reply) => {
      if (deps.queries === undefined) return reply.code(503).send({ error: 'this daemon keeps no agent-query record', code: 'record_unavailable' });
      const use = await deps.queries.dataUse(req.params.id);
      // An unreadable record is UNKNOWN, never "no data used" (codex r12 #15).
      const body: RunDataUseResponse = use === null ? { runId: req.params.id, known: false, sources: [] } : { runId: req.params.id, known: true, sources: use };
      return body;
    },
  );
}
