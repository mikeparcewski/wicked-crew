/**
 * Multi-codebase scope resolution — the PINNED multiscope wire shared by the testing launch
 * surfaces (`POST /testing/recon`, `POST /campaigns`).
 *
 * Both launch bodies accept two OPTIONAL camelCase fields:
 *
 *  - `repoRefs?: string[]` — explicit codebase attachments. Each ref must resolve in the repo
 *    registry (by id, or by unique name — resolved TO the id) or the whole request fails with a
 *    400 that NAMES the bad ref. Deduped, first occurrence wins.
 *  - `projectId?: string` — crew resolves the project's `crew.repo` members server-side.
 *    Unknown project ⇒ 404; a project with zero repo members (and no explicit `repoRefs` to
 *    fall back on) ⇒ 400 naming the fix.
 *
 * BOTH given ⇒ the union (explicit `repoRefs` order first, then project members not already
 * named). NEITHER ⇒ `repos: []` and the launch behaves exactly as it did before this wire
 * existed — backward compatible by construction.
 *
 * Fail-closed by doctrine (FINDING-031 posture): a ref that would not launch is refused HERE,
 * before anything is persisted, with the offending token named — never a silently narrowed
 * scope or a mid-run "no such repo" a worker discovers for the operator.
 */

import type { CoreAdapter } from '../core/adapter.js';

/** The two optional launch-body fields, as parsed by the route's zod schema. */
export interface MultiscopeFields {
  projectId?: string | undefined;
  repoRefs?: string[] | undefined;
}

/** A resolved repo — id is what launches carry (`repoRef`/`repo_ref`), name is for display. */
export interface ScopedRepo {
  id: string;
  name: string;
}

export type ScopeResolution =
  | { ok: true; repos: ScopedRepo[] }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Resolve the launch scope. Throws only what the adapter throws (notably
 * `ProjectsUnsupportedError` on a pre-projects addon — the caller maps it to 501, the same
 * "upgrade the engine" posture every project route holds).
 */
export async function resolveScopeRepos(
  adapter: CoreAdapter,
  fields: MultiscopeFields,
): Promise<ScopeResolution> {
  const { projectId, repoRefs } = fields;
  if (projectId === undefined && repoRefs === undefined) {
    return { ok: true, repos: [] };
  }

  const registry = await adapter.listRepos();
  const byId = new Map(registry.map((r) => [r.id, r]));
  const byName = new Map(registry.map((r) => [r.name, r]));

  const repos: ScopedRepo[] = [];
  const seen = new Set<string>();
  const admit = (id: string, name: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      repos.push({ id, name });
    }
  };

  for (const ref of repoRefs ?? []) {
    const hit = byId.get(ref) ?? byName.get(ref);
    if (hit === undefined) {
      return {
        ok: false,
        status: 400,
        error:
          `repoRefs: '${ref}' does not name a registered repo — register it first ` +
          `(POST /api/v1/repos) or pick a ref from GET /api/v1/repos`,
      };
    }
    admit(hit.id, hit.name);
  }

  if (projectId !== undefined) {
    if (projectId === 'default') {
      // The synthesized "Unfiled" container (ADR §7) is computed, never stored — it has no
      // membership rows to resolve, and `projectGet` answering null would mislabel it unknown.
      return {
        ok: false,
        status: 400,
        error:
          `projectId: 'default' is the synthesized unfiled container and has no repo members ` +
          `to resolve — name a real project or pass repoRefs explicitly`,
      };
    }
    const project = await adapter.projectGet(projectId);
    if (project === null) {
      return { ok: false, status: 404, error: `unknown project: ${projectId}` };
    }
    if (project.status === 'archived') {
      return {
        ok: false,
        status: 409,
        error:
          `project '${projectId}' is archived — restore it (PATCH /api/v1/projects/` +
          `${projectId} with status "active") or pass repoRefs explicitly`,
      };
    }
    const members = (await adapter.projectMembers(projectId)).filter(
      (m) => m.member_kind === 'crew.repo',
    );
    if (members.length === 0 && (repoRefs === undefined || repoRefs.length === 0)) {
      return {
        ok: false,
        status: 400,
        error:
          `project '${projectId}' has no repo members — attach one ` +
          `(POST /api/v1/projects/${projectId}/members with kind "crew.repo") ` +
          `or pass repoRefs explicitly`,
      };
    }
    for (const m of members) {
      const hit = byId.get(m.member_ref);
      if (hit === undefined) {
        // A member ref pointing at nothing in the registry would launch a run that fails on a
        // repo the CALLER never named — refuse loudly, with the dangling ref and the fix named.
        return {
          ok: false,
          status: 400,
          error:
            `project '${projectId}' has a repo member '${m.member_ref}' that is not in the ` +
            `repo registry — detach the stale member (DELETE /api/v1/projects/${projectId}` +
            `/members/${m.id}) or re-register the repo, then retry`,
        };
      }
      admit(hit.id, hit.name);
    }
  }

  return { ok: true, repos };
}
