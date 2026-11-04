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
