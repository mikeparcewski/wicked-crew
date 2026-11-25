/**
 * The tracker set T(u) (DES-PM-001 §3.2): which trackers a unit (a governed unit, a chat answer step, a launch's
 * linked-issue read, a governed action) may use. Computed on EVERY call from the registry (the links a person made,
 * the source's Agents switches) and the engine's project memberships; never from the worker's arguments, from estate,
 * or from anything cached at launch.
 *
 * - R_u, the unit's repos: its own repo, plus every repo that is a live `crew.repo` member of its project. A failed
 *   membership read leaves the run's own repo only (narrower, never wider).
 * - T(u): every tracker whose source S passes `agentMay(S, P_u, 'see')` and that is linked to P_u itself, or to a
 *   repo in R_u. A project's own links reach only units filed in that project: never another project through a repo
 *   both share. A run in no project gets only its repos' trackers, from sources set to every project.
 * - L(u, S): the trackers of T(u) whose source is S (the binding's linked set). A key of one source never
 *   authorises a call to another.
 */

import { entryId, normalizeRegistryFile } from '../../mcp/registry.js';
import type { McpRegistryFile, McpServerRecord } from '../../mcp/registry-store.js';
import { agentMay } from '../gate/access.js';
import { agentAccessOf, pmOf, type PmSystem, type SourceAgentAccess, type StoredTracker, trackersOf } from '../registry/entry.js';
import type { LinkedTracker } from './bindings.js';

/** A PM entry as the tracker set reads it. */
export interface PmEntry {
  id: string;
  name: string;
  system: PmSystem;
  enabled: boolean;
  access: SourceAgentAccess;
  trackers: StoredTracker[];
  record: McpServerRecord;
}

/** How a tracker reaches the unit: linked to its project, or through one of its repos. */
export type TrackerVia = { kind: 'project' } | { kind: 'repo'; id: string };

/** One tracker of T(u). */
export interface TrackerSetEntry {
  sourceId: string;
  source: string;
  system: PmSystem;
  trackerId: string;
  tenant: string;
  tenantLabel: string | null;
  siteHost: string | null;
  key: string;
  label: string;
  via: TrackerVia[];
}

/** The unit's scope as the engine bound it. */
export interface TrackerScope {
  projectId: string | null;
  repoId: string | null;
}

/** Every PM entry of a registry file. */
export function pmEntriesOf(file: McpRegistryFile): PmEntry[] {
  const out: PmEntry[] = [];
  for (const r of normalizeRegistryFile(file).servers) {
    const pm = pmOf(r);
    if (pm === null) continue;
    out.push({ id: entryId(r), name: r.name, system: pm.system, enabled: r.enabled, access: agentAccessOf(r), trackers: trackersOf(r), record: r });
  }
  return out;
}

/** R_u: the unit's own repo and its project's live `crew.repo` members. A failed read leaves the run's own repo. */
export async function unitRepos(scope: TrackerScope, members: ((projectId: string) => Promise<string[]>) | undefined): Promise<string[]> {
  const repos = new Set<string>();
  if (scope.repoId !== null && scope.repoId !== '') repos.add(scope.repoId);
  if (scope.projectId !== null && members !== undefined) {
    try {
      for (const r of await members(scope.projectId)) if (typeof r === 'string' && r !== '') repos.add(r);
    } catch {
      // narrower, never wider
    }
  }
  return [...repos].sort();
}

/** T(u) over `entries` for a unit in `projectId` with repos `repos` (§3.2's rules; module doc). */
export function trackerSetOf(entries: readonly PmEntry[], projectId: string | null, repos: readonly string[]): TrackerSetEntry[] {
  const out: TrackerSetEntry[] = [];
  const repoSet = new Set(repos);
  for (const e of entries) {
    if (!agentMay(e.access, { enabled: e.enabled, queryable: true }, projectId, 'see')) continue;
    for (const t of e.trackers) {
      const via: TrackerVia[] = [];
      for (const l of t.links) {
        if (l.target.kind === 'project' && projectId !== null && l.target.id === projectId) {
          if (!via.some((v) => v.kind === 'project')) via.push({ kind: 'project' });
        } else if (l.target.kind === 'repo' && repoSet.has(l.target.id)) {
          const id = l.target.id;
          if (!via.some((v) => v.kind === 'repo' && v.id === id)) via.push({ kind: 'repo', id });
        }
      }
      if (via.length === 0) continue;
      out.push({ sourceId: e.id, source: e.name, system: e.system, trackerId: t.id, tenant: t.tenant, tenantLabel: t.tenantLabel, siteHost: t.siteHost ?? null, key: t.key, label: t.label, via });
    }
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.key.localeCompare(b.key) || a.tenant.localeCompare(b.tenant));
}

/** L(u, S): the trackers of `set` whose source is `sourceId`. */
export function linkedSetOf(set: readonly TrackerSetEntry[], sourceId: string): LinkedTracker[] {
  return set.filter((t) => t.sourceId === sourceId).map((t) => ({ trackerId: t.trackerId, tenant: t.tenant, key: t.key, siteHost: t.siteHost }));
}

/** A GitHub repository a person names for a project's act: `owner/repo`, or `<source>:owner/repo` to pick the source. */
export interface RepoSelector {
  source: string | null;
  /** `owner/repo`, lower-cased. */
  repo: string;
}

/** `owner/repo` or `<source>:owner/repo`, or `null` when it is neither. */
export function parseRepoSelector(raw: string): RepoSelector | null {
  const m = /^(?:([^\s:/]{1,100}):)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(raw.trim());
  return m === null ? null : { source: m[1] ?? null, repo: `${m[2]}/${m[3]}`.toLowerCase() };
}

/**
 * (crew#372) The ONE GitHub tracker a project's own act may use for `sel`: from {@link trackerSetOf} over the project
 * alone (no unit repositories, so the source-visibility policy is the set's own), a GitHub tracker linked to the
 * project ITSELF (a link inherited through a repository does not count) for that repository, of the named source when
 * one is named. Product publish's card, its confirm and every dispatch re-check go through this.
 */
export function projectGithubTracker(
  entries: readonly PmEntry[],
  projectId: string,
  sel: RepoSelector,
): { ok: true; t: TrackerSetEntry; e: PmEntry } | { ok: false; code: 'repo_not_linked' | 'ambiguous'; error: string } {
  const hits = trackerSetOf(entries, projectId, []).filter(
    (t) => t.system === 'github' && t.tenant === 'github.com' && t.via.some((v) => v.kind === 'project') && t.key.toLowerCase() === sel.repo && (sel.source === null || t.source === sel.source),
  );
  if (hits.length === 0) return { ok: false, code: 'repo_not_linked', error: `${sel.source !== null ? `${sel.source}:` : ''}${sel.repo} is not a GitHub repository linked to this project as a tracker` };
  if (hits.length > 1) return { ok: false, code: 'ambiguous', error: `${hits.length} GitHub sources link ${sel.repo} to this project: name it as <source>:${sel.repo} (${hits.map((h) => `${h.source}:${sel.repo}`).join(', ')})` };
  const t = hits[0]!;
  return { ok: true, t, e: entries.find((x) => x.id === t.sourceId)! };
}

/** The GitHub repositories linked to `projectId` itself, as {@link projectGithubTracker} admits them. */
export function projectGithubTargets(entries: readonly PmEntry[], projectId: string): Array<{ repo: string; source: string }> {
  return trackerSetOf(entries, projectId, [])
    .filter((t) => t.system === 'github' && t.tenant === 'github.com' && t.via.some((v) => v.kind === 'project'))
    .map((t) => ({ repo: t.key.toLowerCase(), source: t.source }));
}
