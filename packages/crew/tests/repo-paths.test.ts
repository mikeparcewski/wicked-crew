/**
 * The code-graph path comes from the engine, or it fails — it is never re-derived here.
 *
 * FINDING-069 / wicked-core#170: this package spelled `join(root_path, '.codegraph', 'estate.db')`
 * in five places while wicked-core spelled `.wicked/code-graph.db` in its own. Both halves worked.
 * Onboarding indexed 185 MB into crew's path and the governed worker's estate MCP was opened on
 * core's — a file nothing had written — so every graph query the worker made returned nothing, which
 * is indistinguishable from a repo with nothing in it.
 *
 * The test that matters here is the THROW. A fallback to the old hand-join would look like defensive
 * programming and would restore the exact divergence, silently, on any operator running a stale
 * addon.
 */
import { describe, it, expect } from 'vitest';

import { codeGraphDb, requirementsGraph, requirementsOverrides } from '../src/core/repoPaths.js';
import type { RepoEntry } from '../src/core/types.js';

const DEFAULT_DB = '/repos/demo/.codegraph/estate.db';

const BASE = {
  id: 'demo',
  name: 'demo',
  root_path: '/repos/demo',
  default_branch: 'main',
  registered_at: 0,
};

/** A repo record as a current engine publishes it. */
function repo(codeGraphDb: string = DEFAULT_DB): RepoEntry {
  return { ...BASE, code_graph_db: codeGraphDb };
}

/**
 * A repo record as a STALE addon publishes it: the key is ABSENT, not set to `undefined`.
 *
 * A separate function rather than `repo(undefined)`, because a default parameter fires on an
 * explicit `undefined` — so `repo(undefined)` would hand back the default path and the throw tests
 * would silently assert nothing. (Observed: they went green against a repo that had a db.) The
 * distinction is also the real one: the field is missing from the engine's JSON, so `JSON.parse`
 * yields a record without the key, which is exactly what `exactOptionalPropertyTypes` models.
 */
function repoWithoutDb(): RepoEntry {
  return { ...BASE };
}

describe('repoPaths', () => {
  it('returns the path the engine resolved, verbatim', () => {
    // Verbatim matters: the engine may resolve a path this package would not have guessed (a moved
    // repo, a future relocation). Passing it through is the point; re-checking its shape here would
    // be a second opinion about a value that has only one owner.
    expect(codeGraphDb(repo())).toBe('/repos/demo/.codegraph/estate.db');
    expect(codeGraphDb(repo('/elsewhere/graph.db'))).toBe('/elsewhere/graph.db');
  });

  it('throws when the engine did not publish one, rather than guessing', () => {
    // Two distinct shapes of the same defect: the key absent (a stale addon) and the key present but
    // empty (an engine that resolved nothing). Both must throw; neither may fall back to a hand-join.
    expect(() => codeGraphDb(repoWithoutDb())).toThrow(/code_graph_db/);
    expect(() => codeGraphDb(repo(''))).toThrow(/code_graph_db/);
    // Named, so the operator knows which repo and what to do — a bare "path missing" sends them
    // reading source to find out that their addon is stale.
    expect(() => codeGraphDb(repoWithoutDb())).toThrow(/wicked-core#170/);
  });

  it('derives the requirements artifacts, which the engine does not publish', () => {
    expect(requirementsGraph(repo())).toBe(
      '/repos/demo/.wicked-estate/requirements/requirements_graph.json',
    );
    expect(requirementsOverrides(repo())).toBe(
      '/repos/demo/.wicked-estate/requirements/requirements_overrides.json',
    );
  });
});
