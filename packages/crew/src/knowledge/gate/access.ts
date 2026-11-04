/**
 * Who among the agents may use a live source (DES-KNOWLEDGE-DATA-001 §7.1; ported from crew#1309's
 * `sources/agent-access.ts`). A source carries four controls, each set only by a human operator on the
 * source sheet (`PUT /sources/:name/agents`, `knowledge/gate/routes.ts`) and each audited:
 *
 * - `see`: ON by default. Off: the source is in no agent's list, structure or recall.
 * - `query`: OFF by default; needs `see`; turned off again by a version-2 descriptor change. On: a `rows`
 *   tool may read rows, and those rows go to the agent's model provider.
 * - `projects`: NONE by default. `everyProject`: a separate, explicit choice.
 *
 * ONE predicate ({@link agentMay}) decides for every caller that serves an agent (the broker's gate step,
 * the unit's tool list, and later recall's visible set and the chat block). It is read from the registry on
 * every call, so a switch turned off holds from the next call on.
 *
 * **Disclosure class gates the tool, whatever its side effect** (§7.1): a `rows` tool needs "query"; a
 * `structure` or `none` tool needs "see"; a tool with no reviewed class is unavailable to agents.
 */

import { AGENT_ACCESS_DEFAULT, AGENT_PROJECT_RE, agentAccessOf, type SourceAgentAccess, type ToolDisclosureClass } from '../registry/entry.js';

// The switches' shape, defaults and parse are the registry entry's (B1, `knowledge/registry/entry.ts`).
export { AGENT_ACCESS_DEFAULT, AGENT_PROJECT_RE, agentAccessOf, type SourceAgentAccess };

/** What a tool can disclose (§5.1): reviewed per tool and bound to its schema. */
export type DisclosureClass = ToolDisclosureClass;

/** A source names at most this many projects. */
export const AGENT_PROJECTS_MAX = 64;

/** The switch a tool of `cls` needs; `null` = no reviewed class, so no agent may use it. */
export function neededFor(cls: DisclosureClass | null | undefined): 'see' | 'query' | null {
  if (cls === 'rows') return 'query';
  if (cls === 'structure' || cls === 'none') return 'see';
  return null;
}

/**
 * THE predicate: whether a unit of a run (or chat) filed into `projectId` may `see` (list, structure) or
 * `query` (rows) this source. The source's own on/off comes first; a source the gate cannot govern
 * (`queryable: false`, no read policy for its dialect yet) is never queried. A run in no project (`null`)
 * reaches only sources set to every project.
 */
export function agentMay(access: SourceAgentAccess, src: { enabled: boolean; queryable: boolean }, projectId: string | null, what: 'see' | 'query'): boolean {
  if (!src.enabled || !access.see) return false;
  if (what === 'query' && (!access.query || !src.queryable)) return false;
  if (access.everyProject) return true;
  return projectId !== null && access.projects.includes(projectId);
}
