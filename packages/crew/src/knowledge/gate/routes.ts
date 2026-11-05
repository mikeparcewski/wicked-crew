/**
 * The source sheet's agent controls and records (DES-KNOWLEDGE-DATA-001 §7.1, §7.9; ported from crew#1309's
 * `sources/agent-routes.ts`):
 *
 *   PUT /sources/:name/agents          HUMAN      see, query, projects, everyProject; each change audited
 *   GET /sources/:name/agent-queries   observer   the last 20 agent reads of the source (no SQL, no value)
 *   GET /runs/:id/data-use             observer   the sources a run's agents read (gate cards, the delivery)
 *
 * The switches are human-operator only: an agent-kind actor, whatever its trust, gets 403
 * `agents_switch_human_only`. Under auth off, "human" is the person's own processes (the DES §7.3 residual).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from '../../zod.js';

import { API_PREFIX } from '../../api/api-prefix.js';
import { trustAtLeast } from '../../api/auth.js';
import type { Actor, RunDataUseResponse, SourceAgentAccessResponse, SourceAgentQueriesResponse } from '../../core/types.js';
import { MCP_SERVER_NAME_RE } from '../../mcp/classify.js';
import { McpRegistryCorruptError, type McpRegistryStore } from '../../mcp/registry-store.js';
import { AGENT_PROJECT_RE, AGENT_PROJECTS_MAX, type SourceAgentAccess } from './access.js';
import type { SourceReadLog } from './record.js';
import { setAgentAccess } from './sources.js';

const V = API_PREFIX;

export const SourceAgentAccessSchema = z.strictObject({
  see: z.boolean().optional(),
  query: z.boolean().optional(),
  projects: z.array(z.string().regex(AGENT_PROJECT_RE)).max(AGENT_PROJECTS_MAX).optional(),
  everyProject: z.boolean().optional(),
})
  .refine((b) => b.see !== undefined || b.query !== undefined || b.projects !== undefined || b.everyProject !== undefined, { error: 'set see, query, projects or everyProject' });

export interface GateRouteDeps {
  store?: Pick<McpRegistryStore, 'mutate'>;
  record?: Pick<SourceReadLog, 'recent' | 'dataUse'>;
  audit: { record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): unknown };
  actorOf: (req: FastifyRequest) => Actor;
}

function isHumanOperator(actor: Actor): boolean {
  return actor.kind === 'human' && trustAtLeast(actor, 'operator');
}

/** The audit lines a change of the controls writes: one per control that changed (§7.9: `knowledge.source.*`). */
export function accessChanges(before: SourceAgentAccess, after: SourceAgentAccess, source: string): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  if (before.see !== after.see) out.push([after.see ? 'knowledge.source.catalog_visible' : 'knowledge.source.catalog_hidden', { source }]);
  if (before.query !== after.query) out.push([after.query ? 'knowledge.source.agent_query_allowed' : 'knowledge.source.agent_query_disallowed', { source, ...(before.see !== after.see && !after.see ? { because: 'see_off' } : {}) }]);
  if (before.everyProject !== after.everyProject || JSON.stringify(before.projects) !== JSON.stringify(after.projects)) {
    out.push(['knowledge.source.agent_projects_set', { source, projects: after.projects, everyProject: after.everyProject }]);
  }
  return out;
}

export function registerGateRoutes(app: FastifyInstance, deps: GateRouteDeps): void {
  app.put<{ Params: { name: string } }>(
    `${V}/sources/:name/agents`,
    { config: { manifest: { requestType: 'SourceAgentAccessBody', responseType: 'SourceAgentAccessResponse', statusCodes: [200, 400, 403, 404, 409, 503] } } },
    async (req, reply) => {
      const actor = deps.actorOf(req);
      // Human-only, like Allow writes: an agent-kind token, whatever its trust, never changes what agents may use.
      if (!isHumanOperator(actor)) {
        return reply.code(403).send({ error: `only a human operator can change what agents may do with a source; you are ${actor.kind}/${actor.trust}`, code: 'agents_switch_human_only' });
      }
      const parsed = SourceAgentAccessSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'bad_request' });
      if (deps.store === undefined) return reply.code(503).send({ error: 'the connector registry is not available on this daemon', code: 'registry_unavailable' });
      if (!MCP_SERVER_NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'not a source name', code: 'bad_name' });
      const b = parsed.data;
      const patch: Partial<SourceAgentAccess> = {
        ...(b.see !== undefined ? { see: b.see } : {}),
        ...(b.query !== undefined ? { query: b.query } : {}),
        ...(b.projects !== undefined ? { projects: b.projects } : {}),
        ...(b.everyProject !== undefined ? { everyProject: b.everyProject } : {}),
      };
      let r: Awaited<ReturnType<typeof setAgentAccess>>;
      try {
        r = await setAgentAccess(deps.store, req.params.name, patch);
      } catch (err) {
        if (err instanceof McpRegistryCorruptError) return reply.code(503).send({ error: err.message, code: 'registry_corrupt' });
        throw err;
      }
      if ('error' in r) {
        if (r.error === 'unknown_source') return reply.code(404).send({ error: `no source named ${req.params.name}`, code: 'unknown_server' });
        if (r.error === 'not_a_source') return reply.code(400).send({ error: `${req.params.name} is not a data source`, code: 'not_a_source' });
        return reply.code(409).send({ error: `agents cannot query ${req.params.name} while they cannot see its structure: turn "see" on first`, code: 'see_off' });
      }
      for (const [action, detail] of accessChanges(r.before, r.after, req.params.name)) deps.audit.record(action, actor, { detail });
      const body: SourceAgentAccessResponse = { name: req.params.name, agents: r.after };
      return body;
    },
  );

  app.get<{ Params: { name: string } }>(
    `${V}/sources/:name/agent-queries`,
    { config: { manifest: { responseType: 'SourceAgentQueriesResponse', statusCodes: [200, 400, 503] } } },
    async (req, reply) => {
      if (!MCP_SERVER_NAME_RE.test(req.params.name)) return reply.code(400).send({ error: 'not a source name', code: 'bad_name' });
      if (deps.record === undefined) return reply.code(503).send({ error: 'this daemon keeps no agent-query record', code: 'record_unavailable' });
      const recent = await deps.record.recent(req.params.name, 20);
      const body: SourceAgentQueriesResponse = recent === null ? { name: req.params.name, known: false, queries: [] } : { name: req.params.name, known: true, queries: recent };
      return body;
    },
  );

  app.get<{ Params: { id: string } }>(
    `${V}/runs/:id/data-use`,
    { config: { manifest: { responseType: 'RunDataUseResponse', statusCodes: [200, 503] } } },
    async (req, reply) => {
      if (deps.record === undefined) return reply.code(503).send({ error: 'this daemon keeps no agent-query record', code: 'record_unavailable' });
      const use = await deps.record.dataUse(req.params.id);
      // An unreadable record is UNKNOWN, never "no data used".
      const body: RunDataUseResponse = use === null ? { runId: req.params.id, known: false, sources: [] } : { runId: req.params.id, known: true, sources: use };
      return body;
    },
  );
}
