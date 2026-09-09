/**
 * The ONE per-project docs-root resolution every interactive route shares (crew#472).
 *
 * The proxy, the governed doc delete, and the attributed docs list all answer under
 * `/projects/:projectId/interactive/...`, and all three must agree on which directory — and so
 * which bridge — a project id means. Before this module each route carried its own copy of the
 * existence check + resolution; the partitioning fix touched the resolution, and three copies of
 * a rule that decides which project sees which documents is two too many.
 */

import type { CoreAdapter } from '../core/adapter.js';
import { ProjectsUnsupportedError } from '../core/adapter.js';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import type { ProjectSettingsStore } from '../projects/settings.js';
import { resolveProjectInteractiveRoot } from './bridge-root.js';

/** The injectable halves of the resolution — a test harness points both away from the real home.
 *  Every interactive route's deps object satisfies this structurally, so a route passes its deps. */
export interface ProjectRootOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * The resolved docs root for a project, or null when no such project exists.
 *
 * `default` is SYNTHESIZED by the route layer (DES-PROJECT-001 §7) — the engine has no row for
 * it, so an existence check there would 404 the one project every operator starts with. A
 * pre-0.6.0 engine has no project surface at all: `default` is the only project such a deployment
 * can have, so its legacy shared root is the truthful answer for whatever id was asked —
 * partitioning by an id that cannot name a project there would only manufacture an empty root.
 */
export async function projectDocsRoot(
  adapter: CoreAdapter,
  settings: ProjectSettingsStore,
  projectId: string,
  opts: ProjectRootOptions = {},
): Promise<string | null> {
  let partition = projectId;
  if (projectId !== DEFAULT_PROJECT_ID) {
    try {
      if ((await adapter.projectGet(projectId)) === null) return null;
    } catch (err) {
      if (!(err instanceof ProjectsUnsupportedError)) throw err;
      partition = DEFAULT_PROJECT_ID;
    }
  }
  return resolveProjectInteractiveRoot(partition, settings.get(projectId), opts.env ?? process.env, opts.home);
}
