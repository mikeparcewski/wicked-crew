/**
 * Boundary types for the wicked-core-ts JSON surface.
 *
 * core-ts returns every complex result as a JSON string, which the adapter
 * `JSON.parse`s. The WIRE-SHAPE types — everything that flows on through the
 * daemon's `/api/v1` + `/ws` surface (SessionView, CoreEvent, governance and
 * workflow shapes, …) — live in the shared contract package
 * `wicked-crew-api-types` and are re-exported here verbatim, so the route
 * layer and the studio SPA compile against the SAME definitions and the two
 * can no longer drift (task #84; `tests/wire-contract.test.ts` is the guard).
 *
 * What remains in THIS file is engine-internal: inputs the adapter maps onto
 * the native addon (`LaunchRunInput`), shapes that never leave the daemon
 * (`RepoOnboardRef`), and runtime constants (`DEFAULT_SETTINGS`) — a types-only
 * contract package cannot carry values.
 *
 * ONLY `core/adapter.ts` imports from the native addon itself; the rest of the
 * daemon speaks these daemon-owned shapes, which is what quarantines the
 * FINALIZING core-ts `subscribe` seam to a single file (DES-STUDIO-001 §5.2).
 */

export type * from 'wicked-crew-api-types';

import type { SystemSettings } from 'wicked-crew-api-types';

/** The run id of the onboarding run started when a repo was registered. */
export interface RepoOnboardRef {
  repoId: string;
  runId: string;
}

/** The daemon's launch-run input (mapped by the adapter onto the addon's `LaunchOptions`). */
export interface LaunchRunInput {
  /** Free-text problem, decomposed into ordered work units. */
  problem: string;
  /** Stable run id. */
  sessionId: string;
  /** JSON array of `AgenticCli` seats — the council roster. */
  clisJson: string;
  /** `shared` (default) | `isolated`. */
  entityMode?: string;
  /** Human-confirm gate policy: `none` (default) | `all` | `before:<ord>`. */
  humanConfirm?: string;
  /** Id of a registered repo to run within. Omit for a repo-less run. */
  repoRef?: string;
  /** Workflow def id to drive (e.g. `domain-extraction`). Omit ⇒ free-text planning. */
  workflow?: string;
  /**
   * Project to file this run into (DES-PROJECT-001 §2.2). The engine attaches the `crew.run`
   * membership atomically with the launch record; unknown/archived ⇒ the launch fails with no
   * session persisted. Omit ⇒ unfiled (the synthesized `default` project).
   */
  projectId?: string;
  /**
   * ADDITIONAL absolute write roots for the run's deliverables (wicked-core#259 / crew#263) —
   * e.g. the interactive-draft inbox the workflow contract names as the output destination.
   * The engine validates each root at launch (absolute, never the engine config/pin tree) and
   * widens the governed units' filesystem boundary by exactly these roots; an invalid root
   * fails the launch with no session persisted. Omit for runs that deliver inside their workdir.
   */
  extraWriteRoots?: string[];
  /**
   * Delivery mode (crew#293). `"pr"` ⇒ the adapter appends the hardened deliver Tool phase
   * (push the run branch + `gh pr create`, see `core/deliver.ts`) to a PER-RUN copy of the
   * selected workflow def and launches that copy — the shared def is never mutated. Requires
   * `workflow`; a free-text run has no def to append to. Omit ⇒ no delivery phase (default).
   */
  deliver?: 'pr';
  /**
   * THE DELIVERABLE FLOOR (crew#311) — absolute paths this run MUST have produced by the time
   * it finishes. When non-empty (and `workflow` is set), the adapter appends a deterministic
   * verification Tool phase to a PER-RUN copy of the def (see `core/deliverable-floor.ts`)
   * which re-derives "done" from the artifacts: every declared path must exist and carry bytes,
   * or the phase exits non-zero and the RUN FAILS, naming what was expected and what was found.
   *
   * This is the instrument for runs whose deliverable is a FILE in a declared write root rather
   * than a worktree diff — every crew interactive seam. The engine's own two floors do not
   * reach them: the built-in evidence floor re-verifies a git diff and is fail-closed on a
   * repo-less run, and `required_deliverables` is checked only by the wrapped-CLI runner and
   * only against the unit's cwd (an absolute path counts as missing there by construction).
   *
   * Omit for runs whose evidence is the worktree diff — those are the engine's to floor.
   */
  requireDeliverables?: string[];
}

/** Default `workerStallMinutes` (crew#287): silent minutes before the stall watchdog fires. */
export const DEFAULT_WORKER_STALL_MINUTES = 15;

/**
 * LOCAL extension of the published `SystemSettings` (wicked-crew-api-types 0.6.0): the crew#287
 * stall-watchdog knob is daemon-owned until the contract picks it up. NOTE for the next
 * api-types release: fold `workerStallMinutes` into `SystemSettings` (and the synthetic
 * `workerStalled` /ws frame — see `api/stall-watchdog.ts` `WorkerStalledFrame` — into the
 * event documentation). Extra fields are forward-additive on the wire (DES-STUDIO-001 §5.1),
 * so shipping it daemon-side first breaks no consumer.
 */
export interface CrewSystemSettings extends SystemSettings {
  /**
   * Minutes a run in `executing` may go without ANY engine event on the daemon's relay before
   * a synthetic `workerStalled` frame is broadcast on /ws (detection only; default 15).
   */
  workerStallMinutes?: number;
}

export const DEFAULT_SETTINGS: CrewSystemSettings = {
  graphNodeLimit: 150,
  workerStallMinutes: DEFAULT_WORKER_STALL_MINUTES,
};
