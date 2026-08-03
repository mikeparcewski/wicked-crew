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

import { join } from 'node:path';

import type { RepoEntry } from './types.js';

/**
 * The ABSOLUTE path of a repo's code graph, as resolved by the engine.
 *
 * Throws when the field is absent, which means the running `wicked-core` addon predates the field. A
 * fallback to the old hand-join is what this module exists to delete — it would restore the exact
 * divergence above and hide it behind a path that looks plausible. Loud is correct: the operator's
 * addon is stale and every graph-backed surface would otherwise report an empty repo.
 */
export function codeGraphDb(repo: RepoEntry): string {
  const db = repo.code_graph_db;
  if (typeof db !== 'string' || db === '') {
    throw new Error(
      `repo ${repo.id} carries no code_graph_db — the wicked-core addon in use predates the field ` +
        `(wicked-core#170). Rebuild/reinstall wicked-core-ts; do not derive this path locally.`,
    );
  }
  return db;
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
