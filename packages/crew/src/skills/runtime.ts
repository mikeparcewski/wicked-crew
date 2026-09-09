/**
 * The skills seam as the daemon holds it: ONE store + the two things every settings application
 * re-derives from it — the engine env (`WICKED_SKILLS_SNAPSHOT`) and the non-Claude mirror.
 *
 * `apply(settings)` is called at boot (`createServer`) and on every `PUT /settings`, exactly like
 * `applyWorkerConfigRoot` for `worker_config_root`: re-root to `skills_root`, seed from the live
 * plugin when the root is empty, publish a first snapshot when none exists, export the resolved
 * snapshot path, mirror when `skills_mirror` is on. It never throws — a machine without garden
 * installed logs the fallback (the engine resolves its own, design v3 §3) and the daemon boots.
 */

import { homedir } from 'node:os';

import { DEFAULT_SKILLS_MIRROR, type CoreEvent, type SystemSettings } from '../core/types.js';
import { applySkillsSnapshotEnv } from './engine-env.js';
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

export interface SkillsRuntimeOptions {
  store: SkillsStore;
  mirrorHome: string;
  log: (message: string) => void;
}

export class SkillsRuntime {
  readonly store: SkillsStore;
  private readonly mirrorHome: string;
  private readonly log: (message: string) => void;

  constructor(opts: SkillsRuntimeOptions) {
    this.store = opts.store;
    this.mirrorHome = opts.mirrorHome;
    this.log = opts.log;
  }

  /** Boot / settings re-apply. Never throws. */
  apply(settings: SkillsSettings): void {
    const root = resolveSkillsRoot(settings.skills_root);
    if (root !== this.store.root) this.store.reroot(root);
    try {
      const ready = this.store.ensureReady();
      if (ready.seeded) this.log(`[skills] seeded ${this.store.root} from the installed wicked-garden plugin`);
      if (ready.published !== null && ready.published.verdict === 'blocked') {
        const named = ready.published.findings
          .filter((f) => f.severity === 'blocking')
          .map((f) => `${f.kind}: ${f.evidence}`)
          .join('; ');
        this.log(`[skills] first publish BLOCKED — no snapshot; the engine falls back to the live plugin until fixed: ${named}`);
      }
    } catch (err) {
      if (err instanceof SkillsSourceUnavailableError) {
        this.log(`[skills] skills.fallback: ${err.message}; the engine resolves the live installed plugin itself`);
      } else {
        this.log(`[skills] skills root ${this.store.root} unusable: ${err instanceof Error ? err.message : String(err)}`);
      }
      applySkillsSnapshotEnv(null);
      return;
    }
    this.afterPublish(settings);
  }

  /**
   * One CoreEvent from the daemon's event listener: pins the current generation to the live run
   * the event belongs to, releases (and reaps) at the run's terminal frame — live-generations.ts.
   */
  observe(event: CoreEvent): void {
    this.store.observeEvent(event);
  }

  /** Export the resolved current snapshot for the engine and mirror it when the setting is on. */
  afterPublish(settings: SkillsSettings): MirrorResult | null {
    applySkillsSnapshotEnv(this.store.currentSnapshot()?.path ?? null);
    if (!(settings.skills_mirror ?? DEFAULT_SKILLS_MIRROR)) return null;
    try {
      return mirrorSkills(this.store, this.mirrorHome);
    } catch (err) {
      this.log(`[skills] mirror pass failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
