/**
 * The skills seam as the daemon holds it: ONE store + the one thing every settings application
 * re-derives from it — the engine env (`WICKED_SKILLS_SNAPSHOT`).
 *
 * `apply(settings)` is called at boot (`createServer`) and on every `PUT /settings`, exactly like
 * `applyWorkerConfigRoot` for `worker_config_root`: re-root to `skills_root`, seed from the live
 * plugin when the root is empty, publish a first snapshot when none exists, export the resolved
 * snapshot path. It never throws — but it does NOT fail open either. The degradation ladder
 * (design v3 §3; codex review of #480) distinguishes three outcomes:
 *
 *   published      `current` verified → `WICKED_SKILLS_SNAPSHOT=<resolved snapshot>`.
 *   fallback       ABSENT configuration — no wicked-garden installed, nothing to seed from. The ONE
 *                  case the engine input is restored to the value this process booted with (an
 *                  operator export or the test harness's arming survives; unset when there was
 *                  none): the engine's own ladder falls back to the live installed cache and logs
 *                  `skills.fallback`. Finding `skills.fallback` (warning). The log line says which
 *                  of the two happened — "restored to <value>" or "left unset" — never one for the
 *                  other (Copilot on #480).
 *   blocked        the FIRST publish is blocked (a defective catalog: unresolved refs, a missing
 *                  required skill, a missing plugin catalog, a baseline env that could not be
 *                  provisioned). There is no snapshot to offer and the live cache is NOT a
 *                  substitute — the engine input is pointed at a path that does not exist
 *                  (`<root>/refused/skills.blocked`), which the engine treats as an invalid explicit
 *                  path: every launch fails loudly naming it until the operator fixes the catalog
 *                  and publishes. Finding `skills.blocked` (error).
 *   config-error   an INVALID configuration — a corrupt manifest, a `current` link that fails
 *                  verification, an unusable `skills_root`. Same refusal path
 *                  (`<root>/refused/skills.config`), same loud launch failure: recorded disablement
 *                  is never bypassed by "restoring" the live cache. Finding `skills.config` (error).
 *
 * What the engine is handed for skills is ONE variable, `WICKED_SKILLS_SNAPSHOT` = the absolute
 * REAL path of `snapshots/<gen>` (v3.1 §2); `WICKED_SKILLS_CURRENT` is withdrawn and never set.
 * Beside it, always, `WICKED_CREW_STATE_HOME` = the canonical realpath of the daemon state home —
 * core derives the worker fence from it and cross-checks that the snapshot is
 * `<state home>/skills/snapshots/<gen>` (core#399 round 3). A `skills_root` OUTSIDE the state home
 * therefore publishes fine but every launch is refused by core: `apply` reports that as a
 * `skills.config` WARNING on the `published` state (engine-env.ts).
 *
 * NOTHING here writes into the user's own CLI directories (design v3.2 §1): the v3 additive
 * mirror into `~/.codex/skills` & co. is withdrawn, and with it the `skills_mirror` setting. Skills
 * reach non-Claude workers only through the per-launch delivery core performs from the snapshot
 * (the generated `views/copilot/` for copilot, `--skill` lists for pi); a CLI without a lever runs
 * without wicked skills — never through a side channel into the user's home.
 *
 * `health()` is the last outcome, surfaced read-only on `GET /diagnostics` (`skills`).
 */

import { join, sep } from 'node:path';

import type { CoreEvent, SystemSettings } from '../core/types.js';
import { applySkillsSnapshotEnv, canonicalCrewStateHome, CREW_STATE_HOME_ENGINE_ENV, SKILLS_SNAPSHOT_ENGINE_ENV } from './engine-env.js';
import { resolveSkillsRoot, SKILLS_DIRNAME, SkillsSourceUnavailableError, SNAPSHOTS_DIRNAME, type SkillsStore } from './store.js';

export type SkillsSettings = Pick<SystemSettings, 'skills_root'>;

export type SkillsHealthState = 'published' | 'fallback' | 'blocked' | 'config-error' | 'disabled';

export type SkillsHealthFindingKind = 'skills.fallback' | 'skills.blocked' | 'skills.config';

export interface SkillsHealthFinding {
  kind: SkillsHealthFindingKind;
  severity: 'warning' | 'error';
  message: string;
}

/** The seam's last outcome — what `GET /diagnostics` reports as `skills`. */
export interface SkillsHealth {
  state: SkillsHealthState;
  /** The resolved skills root, or `null` when the daemon booted without the seam. */
  root: string | null;
  /** The verified published snapshot, or `null`. */
  current: { gen: number; path: string } | null;
  /** What `WICKED_SKILLS_SNAPSHOT` is exported as right now (`null` = unset / boot value). */
  engineInput: string | null;
  /** What `WICKED_CREW_STATE_HOME` is exported as (the canonical state home core fences); `null` when `disabled`. */
  stateHome: string | null;
  findings: SkillsHealthFinding[];
}

/** The `skills` block a daemon booted WITHOUT the seam reports. */
export function disabledSkillsHealth(): SkillsHealth {
  return { state: 'disabled', root: null, current: null, engineInput: null, stateHome: null, findings: [] };
}

/** The directory name under the root whose (non-existent) children are the refusal sentinels. */
export const REFUSED_DIRNAME = 'refused';

/**
 * The path the engine input is pointed at when the daemon has NO valid snapshot to offer and must
 * not fall back: it does not exist, so the engine's "explicit path invalid → launch fails loudly"
 * rung fires, and the path itself names why (`…/refused/skills.blocked`).
 */
export function refusalPath(root: string, kind: 'skills.blocked' | 'skills.config'): string {
  return join(root, REFUSED_DIRNAME, kind);
}

export interface SkillsRuntimeOptions {
  store: SkillsStore;
  log: (message: string) => void;
}

export class SkillsRuntime {
  readonly store: SkillsStore;
  private readonly log: (message: string) => void;
  private lastHealth: SkillsHealth = disabledSkillsHealth();

  constructor(opts: SkillsRuntimeOptions) {
    this.store = opts.store;
    this.log = opts.log;
  }

  /** The seam's last outcome (diagnostics). */
  health(): SkillsHealth {
    return this.lastHealth;
  }

  /** Boot / settings re-apply. Never throws; never fails open (module header). */
  async apply(settings: SkillsSettings): Promise<SkillsHealth> {
    const root = resolveSkillsRoot(settings.skills_root);
    if (root !== this.store.root) this.store.reroot(root);
    let ready: Awaited<ReturnType<SkillsStore['ensureReady']>>;
    try {
      ready = await this.store.ensureReady();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof SkillsSourceUnavailableError) {
        applySkillsSnapshotEnv(null);
        // Say what actually happened to the variable: `applySkillsSnapshotEnv(null)` restores the
        // boot value when this process had one, and deletes it only when it had none.
        const restored = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
        this.log(
          restored === undefined
            ? `[skills] skills.fallback: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV} left unset (this process booted without one) — the engine resolves the live installed plugin itself`
            : `[skills] skills.fallback: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV} restored to the boot value ${restored} (an operator export / harness arming survives the fallback) — the engine reads that path`,
        );
        return this.record({
          state: 'fallback',
          root,
          current: null,
          engineInput: restored ?? null,
          stateHome: process.env[CREW_STATE_HOME_ENGINE_ENV] ?? null,
          findings: [{ kind: 'skills.fallback', severity: 'warning', message }],
        });
      }
      const refusal = refusalPath(root, 'skills.config');
      applySkillsSnapshotEnv(refusal);
      this.log(`[skills] skills.config: skills root ${root} is unusable — ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV}=${refusal} so every launch fails loudly until it is fixed`);
      return this.record({
        state: 'config-error',
        root,
        current: null,
        engineInput: refusal,
        stateHome: process.env[CREW_STATE_HOME_ENGINE_ENV] ?? null,
        findings: [{ kind: 'skills.config', severity: 'error', message }],
      });
    }
    if (ready.seeded) this.log(`[skills] seeded ${root} from the installed wicked-garden plugin`);
    if (ready.published !== null && ready.published.verdict === 'blocked') {
      const named = ready.published.findings
        .filter((f) => f.severity === 'blocking')
        .map((f) => `${f.kind}: ${f.evidence}`)
        .join('; ');
      const refusal = refusalPath(root, 'skills.blocked');
      applySkillsSnapshotEnv(refusal);
      const message = `first publish BLOCKED — no snapshot: ${named}`;
      this.log(`[skills] skills.blocked: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV}=${refusal} so every launch fails loudly until the catalog is fixed and published`);
      return this.record({
        state: 'blocked',
        root,
        current: null,
        engineInput: refusal,
        stateHome: process.env[CREW_STATE_HOME_ENGINE_ENV] ?? null,
        findings: [{ kind: 'skills.blocked', severity: 'error', message }],
      });
    }
    this.afterPublish();
    return this.lastHealth;
  }

  /**
   * One CoreEvent from the daemon's event listener: pins the current generation to the live run
   * the event belongs to, releases (and reaps) at the run's terminal frame — live-generations.ts.
   */
  observe(event: CoreEvent): void {
    this.store.observeEvent(event);
  }

  /**
   * Export the VERIFIED current snapshot for the engine (with the fenced state home beside it).
   * With nothing published (or an unverifiable `current`) the engine input is NOT touched here —
   * `apply` decided it. Answers the health it recorded, or `null` when there was nothing to export.
   * A snapshot that is not `<state home>/skills/snapshots/<gen>` (a `skills_root` pointed outside
   * the state home) is published but every launch is refused by core's cross-check — reported as a
   * `skills.config` WARNING so the operator sees why before the first refused launch.
   */
  afterPublish(): SkillsHealth | null {
    let current: { gen: number; path: string } | null;
    try {
      current = this.store.currentSnapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refusal = refusalPath(this.store.root, 'skills.config');
      applySkillsSnapshotEnv(refusal);
      this.log(`[skills] skills.config: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV}=${refusal}`);
      return this.record({
        state: 'config-error',
        root: this.store.root,
        current: null,
        engineInput: refusal,
        stateHome: process.env[CREW_STATE_HOME_ENGINE_ENV] ?? null,
        findings: [{ kind: 'skills.config', severity: 'error', message }],
      });
    }
    if (current === null) return null;
    applySkillsSnapshotEnv(current.path);
    // Record the generation crew just handed to launches: a run reading `WICKED_SKILLS_SNAPSHOT`
    // may spawn a worker before the engine's `skillsSnapshotHanded` is observed, so reaping keeps
    // this generation until that event confirms which one the launch used (live-generations.ts).
    this.store.live.launched(current.gen);
    const stateHome = canonicalCrewStateHome();
    const findings: SkillsHealthFinding[] = [];
    const fencedSnapshots = join(stateHome, SKILLS_DIRNAME, SNAPSHOTS_DIRNAME) + sep;
    if (!current.path.startsWith(fencedSnapshots)) {
      const message =
        `skills root ${this.store.root} is outside the daemon state home ${stateHome}: core derives the worker fence from ` +
        `${CREW_STATE_HOME_ENGINE_ENV} and cross-checks that ${SKILLS_SNAPSHOT_ENGINE_ENV} is <state home>/skills/snapshots/<gen>, ` +
        `so every launch will be REFUSED until skills_root is "" (the default) and WICKED_CREW_SKILLS_ROOT is unset`;
      this.log(`[skills] skills.config (warning): ${message}`);
      findings.push({ kind: 'skills.config', severity: 'warning', message });
    }
    return this.record({ state: 'published', root: this.store.root, current, engineInput: current.path, stateHome, findings });
  }

  private record(health: SkillsHealth): SkillsHealth {
    this.lastHealth = health;
    return health;
  }
}
