/**
 * Where a registered repo's artifacts live — resolved from the engine's record, not re-derived here.
 *
 * # What this replaces
 *
 * The code-graph path used to be spelled `join(repo.root_path, '.codegraph', 'estate.db')` in five
 * places in this package, against a sixth spelling inside wicked-core (`.wicked/code-graph.db`). Both
 * halves were individually correct and nothing failed when they disagreed: onboarding indexed 185 MB
 * into crew's path, and the governed worker's estate MCP was pointed at core's — a database nothing
 * had ever written. Every graph query the worker made answered "nothing found" about a repo full of
 * code, which is indistinguishable from a real empty result (FINDING-069, wicked-core#170).
 *
 * The fix is not "spell it the same in six places". The engine now publishes the resolved path on the
 * repo record that this package already reads, and this module is the only thing that touches that
 * field. One producer, one consumer, nothing to keep in step.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { RepoEntry, RepoFinding } from './types.js';

/**
 * The ABSOLUTE path of a repo's code graph, as resolved by the engine.
 *
 * Throws — never falls back to the old hand-join, which is what this module exists to delete (it
 * would restore the exact divergence above and hide it behind a path that looks plausible) — in two
 * DISTINCT situations with different remedies, told apart by the error class:
 *
 * - {@link CodeGraphRootUnresolvableError}: the engine is CURRENT and resolved no repo-graph root
 *   (no `WICKED_ESTATE_REPO_GRAPH_ROOT`, no state home, no `HOME`/`USERPROFILE`), so it published an
 *   EMPTY `code_graph_db` together with a `code_graph_root_unresolvable` finding (wicked-core#406).
 *   The remedy is the daemon's environment; the finding's message says so. Callers that classify
 *   "engine too old" must let this one through (`projects/graph.ts assertEngineFresh`).
 * - a plain `Error` naming wicked-core#170: the field is ABSENT (or empty with no such finding),
 *   which means the running `wicked-core` addon predates it. The remedy is a rebuild/reinstall.
 *
 * Loud is correct in both: every graph-backed surface would otherwise report an empty repo.
 */
export function codeGraphDb(repo: RepoEntry): string {
  const db = repo.code_graph_db;
  if (typeof db !== 'string' || db === '') {
    const unresolvable = repo.findings?.find((f) => f.code === CODE_GRAPH_ROOT_UNRESOLVABLE);
    if (unresolvable !== undefined) {
      throw new CodeGraphRootUnresolvableError(repo.id, unresolvable);
    }
    throw new Error(
      `repo ${repo.id} carries no code_graph_db — the wicked-core addon in use predates the field ` +
        `(wicked-core#170). Rebuild/reinstall wicked-core-ts; do not derive this path locally.`,
    );
  }
  return db;
}

/** The engine's finding code for "no repo-graph root resolves" (`RepoEntry.findings[]`, wicked-core#406). */
export const CODE_GRAPH_ROOT_UNRESOLVABLE = 'code_graph_root_unresolvable';

/**
 * The ONE HTTP mapping every code-graph consumer shares for a `codeGraphDb()` failure this daemon
 * can classify: **503** for {@link CodeGraphRootUnresolvableError} — a CURRENT engine resolved no
 * repo-graph root, a daemon-environment fault (neither a bad request nor Fastify's generic 500) —
 * and `null` for anything else, which the caller maps itself (501 for the stale-addon case on the
 * project routes; the default elsewhere). Applied on the project-graph routes, the repo surfaces
 * (`/repos/:id/{graph,graph/blast-radius,domain-graph,requirements…}`) and nowhere else.
 */
export function codeGraphErrorStatus(err: unknown): number | null {
  return err instanceof CodeGraphRootUnresolvableError ? 503 : null;
}

/**
 * A CURRENT engine resolved no repo-graph root for this repo (wicked-core#406) — see
 * {@link codeGraphDb}. Distinct from the stale-addon `Error` on purpose: `projects/graph.ts` turns
 * every other `codeGraphDb` throw into `ProjectGraphEngineTooOldError` (501, "reinstall the
 * addon"), which is the wrong remedy here; this class is what lets it tell the two apart.
 */
export class CodeGraphRootUnresolvableError extends Error {
  constructor(
    readonly repoId: string,
    readonly finding: RepoFinding,
  ) {
    super(`repo ${repoId} has no code graph: ${finding.message}`);
    this.name = 'CodeGraphRootUnresolvableError';
  }
}

/**
 * The requirements artifacts a repo's domain extraction writes.
 *
 * A DIFFERENT path family from the code graph (`.wicked-estate/requirements/`, written by
 * `wicked-core domain-graph`) and still derived here, because the engine does not publish it. Same
 * hazard, smaller blast radius: it is written and read by this package plus one core subcommand whose
 * `--out` this package passes. Tracked with the rest of the cross-repo path pins.
 */
export function requirementsGraph(repo: RepoEntry): string {
  return join(repo.root_path, '.wicked-estate', 'requirements', 'requirements_graph.json');
}

export function requirementsOverrides(repo: RepoEntry): string {
  return join(repo.root_path, '.wicked-estate', 'requirements', 'requirements_overrides.json');
}

// ── A registered folder that is gone ─────────────────────────────────────────

/**
 * The finding crew adds to a repo whose registered folder is gone (moved, deleted, an unmounted
 * volume). On the rig, tiny-math was registered under a lane folder named `target`; a cleanup that
 * removed every `target/` as build output deleted it, and every spawn with that cwd failed. Node
 * reports a missing spawn `cwd` as `spawn <binary> ENOENT`, so the repo page said "spawn
 * wicked-estate ENOENT" (and git history "git executable not found") about a binary that was
 * installed. Crew's own finding, beside the engine's: derived on every read, never stored.
 */
export const REPO_FOLDER_MISSING = 'repo_folder_missing';

/** What a person reads about a missing folder, and what fixes it. There is no way to unregister a
 *  repo (core has none, crew#753), so re-linking it is the remedy: registering the same name again
 *  at the folder's new place replaces the record (core upserts by the name's slug). */
export function repoFolderMissingMessage(rootPath: string): string {
  return (
    `This repository's folder is missing: ${rootPath}. Re-link it: register it again under the same ` +
    'name at its folder\'s new place, or put the folder back.'
  );
}

/** The `repo_folder_missing` finding a repo record carries, or `null` when its folder is there. */
export function repoFolderMissing(repo: Pick<RepoEntry, 'findings'>): RepoFinding | null {
  return repo.findings?.find((f) => f.code === REPO_FOLDER_MISSING) ?? null;
}

/** The body every refusal over a missing folder answers (409: the registration, not the request,
 *  is wrong), so a route, a launch and a chat say it in the same words. */
export function repoFolderMissingBody(finding: RepoFinding): { code: typeof REPO_FOLDER_MISSING; error: string; path: string | null } {
  return { code: REPO_FOLDER_MISSING, error: finding.message, path: finding.path };
}

/** Whether `path` is a directory. A path that is ABSENT (or not a directory) answers `false`; any
 *  other failure (EACCES, an unreadable mount) answers `true`, because the folder may well be
 *  there and the spawn's own error then says what is wrong. */
export async function isDirectoryPresent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

/** Every repo, each with a `repo_folder_missing` finding when its folder is gone (and never two). */
export async function withFolderFindings(
  repos: RepoEntry[],
  present: (path: string) => Promise<boolean> = isDirectoryPresent,
): Promise<RepoEntry[]> {
  return Promise.all(
    repos.map(async (repo) => {
      const others = (repo.findings ?? []).filter((f) => f.code !== REPO_FOLDER_MISSING);
      if (repo.root_path === '' || (await present(repo.root_path))) {
        return others.length === (repo.findings ?? []).length ? repo : { ...repo, findings: others };
      }
      return {
        ...repo,
        findings: [...others, { code: REPO_FOLDER_MISSING, message: repoFolderMissingMessage(repo.root_path), path: repo.root_path }],
      };
    }),
  );
}
