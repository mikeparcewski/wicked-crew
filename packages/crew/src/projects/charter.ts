/**
 * The foundation record of a project (DES-PROJECT-001 §3.2) — thin crew glue, deliberately.
 *
 * On create/update/archive the daemon writes the PROJECT CHARTER (name, description, lifecycle
 * note) into the engine's knowledge store under the project's stored scope, and a memory at that
 * scope. On a project-bound run's completion it writes the EVIDENCE POINTER (run id → the
 * conventional in-repo verdict path). Estate needs no schema change: `project:` is pure
 * convention over the kind:id scope grammar.
 *
 * Everything here is BEST-EFFORT with retry-free logging: the record is eventually consistent
 * with the state by design ("no cross-plane transactionality", ADR §10) — a knowledge-store
 * hiccup must never fail the API call that already committed control state. And the plane rule
 * holds in both directions: delete core.db and the charter + memories still say what this
 * project was; delete the record and the project still operates, with amnesia.
 */

import type { CoreAdapter } from '../core/adapter.js';
import type { Project } from '../core/types.js';

type Log = (msg: string) => void;

/** Write/refresh the charter after a committed create/update/archive. Fire-and-forget. */
export async function writeCharter(
  adapter: CoreAdapter,
  project: Project,
  action: 'created' | 'updated' | 'archived' | 'restored',
  log: Log,
): Promise<void> {
  try {
    const when = new Date(project.updated_at).toISOString();
    const chunks = [
      `Project charter — ${project.name} (${project.id}). Status: ${project.status}. ` +
        `Scope: ${project.scope}. ${action} at ${when} via crew.`,
      ...(project.description !== null && project.description !== undefined
        ? [project.description]
        : []),
    ];
    await adapter.ingestKnowledge(project.scope, chunks);
    await adapter.captureMemory(
      `Project '${project.name}' (${project.id}) ${action}. Charter recorded in the knowledge store under ${project.scope}.`,
      project.scope,
    );
  } catch (err) {
    log(
      `[projects] charter write for ${project.id} failed (state committed; record lags): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Write the evidence pointer for a completed project-bound run (§3.2 row 3): the run id plus the
 * conventional in-repo verdict path. The evidence FILES stay in-repo (QE convention) — the
 * foundation holds pointers, never copies.
 */
export async function writeRunEvidencePointer(
  adapter: CoreAdapter,
  projectScope: string,
  runId: string,
  repoRoot: string | null,
  log: Log,
): Promise<void> {
  try {
    const scope = `${projectScope}/run:${runId}`;
    const pointer =
      repoRoot !== null
        ? `${repoRoot}/.wicked-testing/evidence/${runId}/verdict.json`
        : `(repo-less run — no evidence tree)`;
    await adapter.ingestKnowledge(scope, [
      `Run ${runId} completed under ${projectScope}. Evidence pointer: ${pointer}`,
    ]);
  } catch (err) {
    log(
      `[projects] evidence-pointer write for ${runId} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
