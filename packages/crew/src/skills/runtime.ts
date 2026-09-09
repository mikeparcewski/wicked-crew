/**
 * The skills seam as the daemon holds it: ONE store + the two things every settings application
 * re-derives from it — the engine env (`WICKED_SKILLS_SNAPSHOT`) and the non-Claude mirror.
 *
 * `apply(settings)` is called at boot (`createServer`) and on every `PUT /settings`, exactly like
 * `applyWorkerConfigRoot` for `worker_config_root`: re-root to `skills_root`, seed from the live
 * plugin when the root is empty, publish a first snapshot when none exists, export the resolved
 * snapshot path, mirror when `skills_mirror` is on. It never throws — but it does NOT fail open
 * either. The degradation ladder (design v3 §3; codex review of #480) distinguishes three outcomes:
 *
 *   published      `current` verified → `WICKED_SKILLS_SNAPSHOT=<resolved snapshot>`.
 *   fallback       ABSENT configuration — no wicked-garden installed, nothing to seed from. The ONE
 *                  case the engine input is left unset (restored to the value this process booted
 *                  with): the engine's own ladder falls back to the live installed cache and logs
 *                  `skills.fallback`. Finding `skills.fallback` (warning).
 *   blocked        the FIRST publish is blocked (a defective catalog: unresolved refs, a missing
 *                  required skill, a missing plugin catalog). There is no snapshot to offer and the
 *                  live cache is NOT a substitute — the engine input is pointed at a path that does
 *                  not exist (`<root>/refused/skills.blocked`), which the engine treats as an
 *                  invalid explicit path: every launch fails loudly naming it until the operator
 *                  fixes the catalog and publishes. Finding `skills.blocked` (error).
 *   config-error   an INVALID configuration — a corrupt manifest, a `current` link that fails
 *                  verification, an unusable `skills_root`. Same refusal path
 *                  (`<root>/refused/skills.config`), same loud launch failure: recorded disablement
 *                  is never bypassed by "restoring" the live cache. Finding `skills.config` (error).
 *
 * `health()` is the last outcome, surfaced read-only on `GET /diagnostics` (`skills`).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SKILLS_MIRROR, type CoreEvent, type SystemSettings } from '../core/types.js';
import { applySkillsSnapshotEnv, SKILLS_SNAPSHOT_ENGINE_ENV } from './engine-env.js';
import { mirrorSkills, type MirrorResult } from './mirror.js';
import { resolveSkillsRoot, SkillsSourceUnavailableError, type SkillsStore } from './store.js';

/** Explicit mirror-home override — what the hermetic test harness arms so no test boot ever
 *  writes into the developer's real `~/.codex/skills`. */
export const SKILLS_MIRROR_HOME_ENV = 'WICKED_CREW_SKILLS_MIRROR_HOME';

/** The home whose CLI skill dirs the mirror writes: the env override, else the real home. */
export function defaultMirrorHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SKILLS_MIRROR_HOME_ENV];
  return override !== undefined && override !== '' ? override : homedir();
}

export type SkillsSettings = Pick<SystemSettings, 'skills_root' | 'skills_mirror'>;

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
  findings: SkillsHealthFinding[];
}

/** The `skills` block a daemon booted WITHOUT the seam reports. */
export function disabledSkillsHealth(): SkillsHealth {
  return { state: 'disabled', root: null, current: null, engineInput: null, findings: [] };
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
  mirrorHome: string;
  log: (message: string) => void;
}

export class SkillsRuntime {
  readonly store: SkillsStore;
  private readonly mirrorHome: string;
  private readonly log: (message: string) => void;
  private lastHealth: SkillsHealth = disabledSkillsHealth();

  constructor(opts: SkillsRuntimeOptions) {
    this.store = opts.store;
    this.mirrorHome = opts.mirrorHome;
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
        this.log(`[skills] skills.fallback: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV} left unset — the engine resolves the live installed plugin itself`);
        return this.record({
          state: 'fallback',
          root,
          current: null,
          engineInput: process.env[SKILLS_SNAPSHOT_ENGINE_ENV] ?? null,
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
        findings: [{ kind: 'skills.blocked', severity: 'error', message }],
      });
    }
    this.afterPublish(settings);
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
   * Export the VERIFIED current snapshot for the engine and mirror it when the setting is on. With
   * nothing published (or an unverifiable `current`) the engine input is NOT touched here — `apply`
   * decided it.
   */
  afterPublish(settings: SkillsSettings): MirrorResult | null {
    let current: { gen: number; path: string } | null;
    try {
      current = this.store.currentSnapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refusal = refusalPath(this.store.root, 'skills.config');
      applySkillsSnapshotEnv(refusal);
      this.log(`[skills] skills.config: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV}=${refusal}`);
      this.record({ state: 'config-error', root: this.store.root, current: null, engineInput: refusal, findings: [{ kind: 'skills.config', severity: 'error', message }] });
      return null;
    }
    if (current === null) return null;
    applySkillsSnapshotEnv(current.path);
    this.record({ state: 'published', root: this.store.root, current, engineInput: current.path, findings: [] });
    if (!(settings.skills_mirror ?? DEFAULT_SKILLS_MIRROR)) return null;
    try {
      return mirrorSkills(this.store, this.mirrorHome);
    } catch (err) {
      this.log(`[skills] mirror pass failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private record(health: SkillsHealth): SkillsHealth {
    this.lastHealth = health;
    return health;
  }
}
