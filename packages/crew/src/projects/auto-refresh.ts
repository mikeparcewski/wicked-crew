/**
 * Refresh the project graph(s) a repo belongs to once its ONBOARDING run completes (F-2R2-008).
 *
 * # Why
 *
 * Onboarding indexes a repo into its OWN graph; the project's co-located graph is a separate
 * database that only `POST /projects/:id/graph/refresh` builds. On the fresh rig every one of nine
 * member repos had been onboarded and the project chat still read "no code graph yet" — the one
 * control that would have fixed it was a raw POST no customer surface called. This hook makes the
 * project graph follow the repo graphs: when a repo's onboarding run reaches `sessionCompleted`,
 * every project the repo is a `crew.repo` member of is refreshed.
 *
 * # Bounded, asynchronous, logged
 *
 *  - Only an onboarding run THIS daemon launched triggers it (`adapter.onboardedRepoOf`), and only
 *    on `sessionCompleted` — a failed onboarding refreshes nothing.
 *  - A PLAIN refresh (never `force`): `refreshProjectGraph` skips every member whose clean checkout
 *    is still at the HEAD the manifest recorded, so the marginal cost after the first build is the
 *    one repo that changed; each index is bounded by the refresh's own per-repo timeout.
 *  - Projects are refreshed one at a time (never in parallel), and concurrent completions COALESCE
 *    onto the in-flight refresh of the same project (`refreshProjectGraph`'s single-writer rule).
 *    Coalescing has one gap: a completion that joins a refresh already past its repo is served a
 *    manifest without it — so when the repo is still missing afterwards the hook runs ONE more
 *    refresh, which finds only that repo to index. Never a third.
 *  - Off the request path (`void`), and every start / outcome / failure goes to the log; a failure
 *    never touches the run.
 */

import type { CoreAdapter } from '../core/adapter.js';
import type { ProjectGraphRefreshResult } from '../core/types.js';
import { refreshProjectGraph } from './graph.js';

export interface AutoRefreshDeps {
  /** The projects a repo is a `crew.repo` member of. Default: the adapter's `memberProjects`. */
  memberProjects?: (repoId: string) => Promise<string[]>;
  /** The refresh itself. Default: {@link refreshProjectGraph} (plain, never forced). */
  refresh?: (projectId: string) => Promise<ProjectGraphRefreshResult>;
  log: (msg: string) => void;
}

export interface AutoRefreshOutcome {
  repoId: string;
  /** Projects refreshed, in order, with how many refresh rounds each took (1, or 2 after a coalescing miss). */
  refreshed: { projectId: string; rounds: number; indexed: string[]; skipped: string[]; failed: string[] }[];
  /** Projects whose refresh threw — the message, never the run. */
  failed: { projectId: string; error: string }[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether the refresh's answer shows `repoId` in the graph (indexed now, or skipped as already current). */
function holdsRepo(result: ProjectGraphRefreshResult, repoId: string): boolean {
  const row = (result.repos ?? []).find((r) => r.repoId === repoId);
  return row !== undefined && (row.action === 'indexed' || row.action === 'skipped-head-unchanged');
}

export async function refreshProjectGraphsAfterOnboarding(
  adapter: CoreAdapter,
  repoId: string,
  deps: AutoRefreshDeps,
): Promise<AutoRefreshOutcome> {
  const out: AutoRefreshOutcome = { repoId, refreshed: [], failed: [] };
  const memberProjects =
    deps.memberProjects ?? ((id: string) => adapter.memberProjects('crew.repo', id));
  const refresh =
    deps.refresh ?? ((projectId: string) => refreshProjectGraph(adapter, projectId, process.env, { log: deps.log }));

  let projectIds: string[];
  try {
    projectIds = await memberProjects(repoId);
  } catch (err) {
    // An engine without projects, or a registry that cannot be read: nothing to refresh, said once.
    deps.log(`[projects] auto-refresh after onboarding ${repoId}: membership lookup failed (${message(err)}); no project graph refreshed`);
    return out;
  }
  if (projectIds.length === 0) return out;

  for (const projectId of projectIds) {
    deps.log(`[projects] auto-refresh: onboarding of ${repoId} completed — refreshing project ${projectId}'s code graph`);
    try {
      let result = await refresh(projectId);
      let rounds = 1;
      if (!holdsRepo(result, repoId)) {
        // Coalesced onto a refresh that had already passed this repo: one more, which skips every
        // unchanged member and indexes only what is missing.
        result = await refresh(projectId);
        rounds = 2;
      }
      const failed = result.failed.map((f) => f.label);
      out.refreshed.push({ projectId, rounds, indexed: result.indexed, skipped: result.skipped, failed });
      deps.log(
        `[projects] auto-refresh: project ${projectId} graph is ${result.status.state} ` +
          `(indexed ${result.indexed.length}, skipped ${result.skipped.length}, failed ${failed.length}` +
          `${rounds === 2 ? ', second round after a coalesced refresh missed the repo' : ''})`,
      );
    } catch (err) {
      out.failed.push({ projectId, error: message(err) });
      deps.log(`[projects] auto-refresh: project ${projectId} graph refresh FAILED: ${message(err)}`);
    }
  }
  return out;
}
