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
   * The PROJECT's co-located code graph this run's governed workers should query instead of the
   * run repo's own — resolved by `projects/graph.ts::resolveProjectGraphBinding`, which is the ONE
   * thing that knows where a project graph lives and what each repo is labelled inside it.
   *
   * `repoLabel` is optional in the TYPE because a repo-LESS run legitimately has none — there is
   * no own repo to name. It is not optional in MEANING for a repo-bound run: the engine uses it to
   * confirm the co-located graph actually holds this run's repo.
   *
   * TypeScript cannot catch a missing label here — the invariant ties this field to `repoRef`, a
   * sibling field — so `CoreAdapter.launchRun` enforces it at RUNTIME. Two failure modes, and they
   * are NOT the same thing:
   *
   *  - **crew refuses the launch outright.** Passing `projectGraph` without `projectId`, or with
   *    `repoRef` set and no `repoLabel`, THROWS: no session is created and nothing runs. These are
   *    caller bugs with no sensible degraded reading, so they fail before anything is persisted.
   *  - **the ENGINE declines the binding.** A well-formed binding whose graph turns out not to hold
   *    the named label is refused engine-side and the run proceeds against its own repo graph — a
   *    real launch, quietly narrower. That is the fallback; it is not what a missing `repoLabel`
   *    gets you.
   *
   * Omit the whole field for the per-repo behaviour.
   */
  projectGraph?: { dbPath: string; repoLabel?: string };
  /**
   * Delivery mode (crew#293). `"pr"` ⇒ the adapter appends the hardened deliver Tool phase
   * (push the run branch + `gh pr create`, see `core/deliver.ts`) to a PER-RUN copy of the
   * selected workflow def and launches that copy — the shared def is never mutated. Requires
   * `workflow`; a free-text run has no def to append to. Omit ⇒ no delivery phase.
   *
   * NOTE (crew#393): "omit" here is the ADAPTER's spelling of no-delivery — the HTTP boundary
   * is where the wire's `deliver: 'pr' | 'none'` and the DEFAULT (`'pr'` for repo-scoped
   * launches of code-work workflows — defs with an `executes_code` phase — flippable via the
   * `deliverDefault` daemon setting) are resolved; `'none'` and the repo-less/free-text/
   * read-only-workflow defaults all reach this input as an omitted field. See `POST /runs`
   * in api/routes.ts.
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
 * Default `workerStallEscalateMinutes` (perf#4): silent minutes before the watchdog ACTS.
 * The escalation ladder is ON BY DEFAULT as of perf#4 — run 616c8661 sat wedged for a full 2h
 * turn ceiling (106 min of output silence) while the detection-only watchdog fired once and
 * watched; the engine's `reassignUnit` supersedes the wedged turn safely (attempt bump + epoch
 * cancel: the stale turn's late output drops, no double-charge), so acting is strictly better
 * than watching. An explicit `workerStallEscalateMinutes: 0` disarms it (the crew#341 opt-out).
 *
 * WHY 30: the trigger clock (silence since the last CoreEvent) is exactly the clock a slow but
 * legitimate first turn rides — the recon's max legitimate time-to-first-output across 68 units
 * was 1,161s ≈ 19.35 min, which leaves only a 3–6% margin at a 20-minute threshold. 30 minutes
 * gives ~55% headroom over that observed worst case while still recovering ~4x faster than the
 * 2h ceiling. The 15-minute detection (notify) rung is unchanged.
 */
export const DEFAULT_WORKER_STALL_ESCALATE_MINUTES = 30;

/**
 * Default `workerStallEscalateAction` (crew#341) when escalation is armed: recycle the wedged
 * cursor unit via the engine's `reassignUnit` — routed to a DIFFERENT seat from the run's pool
 * when one is available (perf#4), in place otherwise.
 */
export const DEFAULT_WORKER_STALL_ESCALATE_ACTION = 'reassign' as const;

/**
 * Default `workerStallMaxEscalations` (crew#341): automatic reassigns per run before the
 * watchdog stops acting and hands the run to a human (`outcome: 'exhausted'`, `needsYou`).
 */
export const DEFAULT_WORKER_STALL_MAX_ESCALATIONS = 2;

/**
 * LOCAL extension of the published `SystemSettings`. The stall-watchdog knobs
 * (`workerStallMinutes`, crew#287; `workerStallEscalateMinutes` /
 * `workerStallEscalateAction` / `workerStallMaxEscalations`, crew#341) live in the published
 * contract as of api-types 0.18.0 and are INHERITED here — what remains local is the
 * `studio.*` restatement below. Note the escalation ladder is ON BY DEFAULT as of perf#4
 * (`workerStallEscalateMinutes` defaults to [`DEFAULT_WORKER_STALL_ESCALATE_MINUTES`]); an
 * explicit `0` disarms it.
 */
export interface CrewSystemSettings extends SystemSettings {
  /**
   * Skin-owned preference blobs, round-tripped verbatim (crew#323). RESTATED here rather than
   * merely inherited from `SystemSettings` so the daemon's own type SAYS the settings store is
   * shared with the experience plane — the fact that used to live only in a comment in the
   * studio's client, which is how `studio.appearance` / `studio.notifications` could be
   * silently dropped by `PUT /settings` without either side's types objecting.
   *
   * The daemon never interprets a value here; it enforces only "JSON-serializable, under the
   * per-key byte cap" at the PUT boundary (`api/routes.ts` `STUDIO_SETTINGS_MAX_BYTES`).
   */
  [key: `studio.${string}`]: unknown;
}

export const DEFAULT_SETTINGS: CrewSystemSettings = {
  graphNodeLimit: 150,
  workerStallMinutes: DEFAULT_WORKER_STALL_MINUTES,
  // perf#4 — the escalation ladder is armed by default: 30 silent minutes → reassign the wedged
  // cursor unit to a different seat. An explicit 0 (via PUT /settings or settings.json) disarms.
  workerStallEscalateMinutes: DEFAULT_WORKER_STALL_ESCALATE_MINUTES,
  // crew#393 — repo-scoped CODE-WORK launches (a def with an `executes_code` phase) DELIVER by
  // default: a completed code run ends with a PR, or with the operator's explicit
  // `deliver: 'none'` (or this setting flipped) saying why not.
  deliverDefault: 'pr',
};
