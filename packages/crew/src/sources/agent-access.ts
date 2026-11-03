/**
 * Who among the agents may use a data source (DES-APPS-001 rev 12 §5.4, operator 2026-11-03: "it's knowledge
 * just needs to be orchestrated differently"). A source carries three controls, each set only by a human
 * operator on the source sheet (`PUT /sources/:name/agents`) and each audited:
 *
 * - `see`: "Agents can see this structure", ON by default. Off: the source is in no agent tool's answer.
 * - `query`: "Agents can query this source", OFF by default. On: `sources_query` may read rows from it, and
 *   those rows go to the agent's model provider. Needs `see`.
 * - `projects` / `everyProject`: the projects whose runs and chats may use it. NONE by default (rev 12, codex r12
 *   #3): no source reaches any agent until a person names its projects, or explicitly chooses every project.
 *
 * ONE predicate decides, for every tool and the chat block alike ({@link agentMay}); it is read from the
 * registry on every call, so a switch turned off holds from the next call on.
 */

/** A source's agent controls as the registry stores them. */
export interface SourceAgentAccess {
  see: boolean;
  query: boolean;
  /** The project ids whose runs and chats may use it: sorted, without duplicates. */
  projects: string[];
  /** Every project on this daemon (and runs or chats in none): a separate, explicit choice. */
  everyProject: boolean;
}

/** A new source: "see" on and "query" off, in no project yet (nothing reaches an agent until a person names one). */
export const AGENT_ACCESS_DEFAULT: Readonly<SourceAgentAccess> = Object.freeze({ see: true, query: false, projects: [], everyProject: false });

/** A project id as crew's projects spell them (`proj_…`, `default`): a bounded token. */
export const AGENT_PROJECT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** A source names at most this many projects. */
export const AGENT_PROJECTS_MAX = 64;

/** The controls a stored record holds, with the defaults filled in (a record from before rev 12 has none). */
export function agentAccessOf(rec: { agents?: Partial<SourceAgentAccess> | null }): SourceAgentAccess {
  const a = rec.agents ?? {};
  const see = typeof a.see === 'boolean' ? a.see : AGENT_ACCESS_DEFAULT.see;
  // Query never outlives see: a record that says otherwise is read as query off.
  const query = see && a.query === true;
  const projects = Array.isArray(a.projects) ? normalizeProjects(a.projects) : [];
  return { see, query, projects, everyProject: a.everyProject === true };
}

/** Sorted, unique, valid project ids. */
export function normalizeProjects(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((p) => typeof p === 'string' && AGENT_PROJECT_RE.test(p)))].sort();
}

/**
 * THE predicate: whether a unit of a run (or chat) filed into `projectId` may `see` (list, describe) or
 * `query` this source. The source's own on/off comes first. A run in no project (`null`) reaches only
 * sources set to every project. `query` is for SQL kinds only (GraphQL is catalog-only in rev 12).
 */
export function agentMay(access: SourceAgentAccess, src: { enabled: boolean; kind: string }, projectId: string | null, what: 'see' | 'query'): boolean {
  if (!src.enabled || !access.see) return false;
  if (what === 'query' && (!access.query || src.kind !== 'sql')) return false;
  if (access.everyProject) return true;
  return projectId !== null && access.projects.includes(projectId);
}
