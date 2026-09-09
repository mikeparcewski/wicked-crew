/**
 * The skills seam as the daemon holds it: ONE store over `<state home>/skills` + the one thing the
 * daemon derives from it — the engine env (`WICKED_SKILLS_SNAPSHOT`).
 *
 * `apply()` is called at boot (`createServer`), after the root passed the fence (root-fence.ts):
 * seed from the live plugin when the root is empty, publish a first snapshot when none exists,
 * export the resolved snapshot path. There is NO skills setting to re-apply on `PUT /settings` —
 * the root is `<state home>/skills`, full stop (design v3.1 §1 one storage root; v3.2 §1 never a
 * user CLI directory; codex round 5 on #480 retired `skills_root` and `WICKED_CREW_SKILLS_ROOT`:
 * a configurable root let seeding write into `~/.codex/skills`). `apply` never throws — but it does
 * NOT fail open either. The degradation ladder (design v3 §3; codex review of #480) distinguishes
 * three outcomes:
 *
 *   published      `current` verified → `WICKED_SKILLS_SNAPSHOT=<resolved snapshot>`.
 *   fallback       ABSENT configuration — no wicked-garden installed, nothing to seed from. The ONE
 *                  case the engine input is restored to the value this process booted with (an
 *                  operator export or the test harness's arming survives; unset when there was
 *                  none): the engine's own ladder falls back to the live installed cache and logs
 *                  `skills.fallback`. Finding `skills.fallback` (warning). The log line says which
 *                  of the two happened — "restored to <value>" or "left unset" — never one for the
 *                  other (Copilot on #480).
 *   blocked        the FIRST publish is blocked (a defective catalog: a reference that ESCAPES the
 *                  plugin root, a missing required skill, a missing plugin catalog, a file outside
 *                  the bundle closure, a baseline env that could not be provisioned — a reference
 *                  whose target is merely MISSING is a warning and publishes, design v3.4 §1).
 *                  There is no snapshot to offer and the live cache is NOT a
 *                  substitute — the engine input is pointed at a path that does not exist
 *                  (`<root>/refused/skills.blocked`), which the engine treats as an invalid explicit
 *                  path: every launch fails loudly naming it until the operator fixes the catalog
 *                  and publishes. Finding `skills.blocked` (error).
 *   config-error   an INVALID configuration — a corrupt manifest, a `current` link that fails
 *                  verification, a root that is not the directory the store bound. Same refusal path
 *                  (`<root>/refused/skills.config`), same loud launch failure: recorded disablement
 *                  is never bypassed by "restoring" the live cache. Finding `skills.config` (error).
 *
 * What the engine is handed is EXACTLY ONE variable, `WICKED_SKILLS_SNAPSHOT` = the absolute REAL
 * path of `snapshots/<gen>` (v3.1 §2, v3.4 §2); `WICKED_SKILLS_CURRENT` is withdrawn and never set,
 * and `WICKED_CREW_STATE_HOME` is RETIRED as an engine input (v3.4 §2): core derives the state home
 * it fences from the snapshot path's fixed layout (`<state home>/skills/snapshots/<gen>` — parent
 * `snapshots`, grandparent `skills`, else a config error naming the path). Because the root IS
 * `<state home>/skills` (asserted at boot, identity-checked on every operation), that layout holds
 * by construction. The canonical state home is still REPORTED (`health().stateHome`) for humans.
 *
 * NOTHING here writes into the user's own CLI directories (design v3.2 §1): the v3 additive
 * mirror into the user's codex/pi/copilot/opencode skill dirs is withdrawn, and with it the
 * `skills_mirror` setting. Skills reach non-Claude workers only through the per-launch delivery
 * core performs from the snapshot (the generated `views/copilot/` for copilot, `--skill` lists for
 * pi); a CLI without a lever runs without wicked skills — never through a side channel into the
 * user's home.
 *
 * `health()` is the last outcome, surfaced read-only on `GET /diagnostics` (`skills`).
 */

import { join } from 'node:path';

import type { LaunchNotice } from '../core/adapter.js';
import type { CoreEvent } from '../core/types.js';
import { applySkillsSnapshotEnv, BOOT_SKILLS_SNAPSHOT, canonicalCrewStateHome, SKILLS_SNAPSHOT_ENGINE_ENV } from './engine-env.js';
import { REFUSED_DIRNAME } from './root-names.js';
import { SkillsSourceUnavailableError, type SkillsStore } from './store.js';

/** The refusal sentinel directory name — from the ONE table of root names (design v3.5 §2); re-exported for the tests. */
export { REFUSED_DIRNAME };

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
  /** The skills root (`<state home>/skills`), or `null` when the daemon booted without the seam. */
  root: string | null;
  /** The verified published snapshot, or `null`. */
  current: { gen: number; path: string } | null;
  /** What `WICKED_SKILLS_SNAPSHOT` is exported as right now (`null` = unset / boot value). */
  engineInput: string | null;
  /** The canonical daemon state home — reported for HUMANS (`GET /diagnostics`); NOT an engine input
   *  (v3.4 §2: core reads only `WICKED_SKILLS_SNAPSHOT` and derives the state home from its layout).
   *  `null` when `disabled`. */
  stateHome: string | null;
  findings: SkillsHealthFinding[];
}

/** The `skills` block a daemon booted WITHOUT the seam reports. */
export function disabledSkillsHealth(): SkillsHealth {
  return { state: 'disabled', root: null, current: null, engineInput: null, stateHome: null, findings: [] };
}

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
  /** The `WICKED_SKILLS_SNAPSHOT` this process BOOTED with (default: the real one, `BOOT_SKILLS_SNAPSHOT`); tests inject `''` / `undefined`. */
  bootSnapshot?: string | undefined;
}

export class SkillsRuntime {
  readonly store: SkillsStore;
  private readonly log: (message: string) => void;
  private readonly bootSnapshot: string | undefined;
  private lastHealth: SkillsHealth = disabledSkillsHealth();

  constructor(opts: SkillsRuntimeOptions) {
    this.store = opts.store;
    this.log = opts.log;
    this.bootSnapshot = 'bootSnapshot' in opts ? opts.bootSnapshot : BOOT_SKILLS_SNAPSHOT;
  }

  /** The seam's last outcome (diagnostics). */
  health(): SkillsHealth {
    return this.lastHealth;
  }

  /** Boot entry point. Never throws; never fails open (module header). Idempotent: a seeded, published root is only re-verified. */
  async apply(): Promise<SkillsHealth> {
    const root = this.store.root;
    let ready: Awaited<ReturnType<SkillsStore['ensureReady']>>;
    try {
      ready = await this.store.ensureReady();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.live.exported(null); // no published generation is handed to launches from here on
      if (err instanceof SkillsSourceUnavailableError) {
        applySkillsSnapshotEnv(null, this.bootSnapshot);
        // Say what actually happened to the variable: the boot value is restored EXACTLY — a path,
        // an explicitly EMPTY value, or nothing (deleted). Set-but-empty is a configuration error
        // core refuses (design v3.5 §4): it is preserved, reported as `skills.config`, and never
        // widened into the live-cache fallback rung — only an ABSENT variable reaches that rung.
        const restored = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
        if (restored === '') {
          const detail = `${SKILLS_SNAPSHOT_ENGINE_ENV} is set but EMPTY — a configuration error core refuses at every launch (export a snapshot path, or unset it to reach the live-plugin fallback); and there is no plugin to publish from: ${message}`;
          this.log(`[skills] skills.config: ${detail}`);
          return this.record({
            state: 'config-error',
            root,
            current: null,
            engineInput: '',
            stateHome: canonicalCrewStateHome(),
            findings: [{ kind: 'skills.config', severity: 'error', message: detail }],
          });
        }
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
          stateHome: canonicalCrewStateHome(),
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
        stateHome: canonicalCrewStateHome(),
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
      this.store.live.exported(null);
      const message = `first publish BLOCKED — no snapshot: ${named}`;
      this.log(`[skills] skills.blocked: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV}=${refusal} so every launch fails loudly until the catalog is fixed and published`);
      return this.record({
        state: 'blocked',
        root,
        current: null,
        engineInput: refusal,
        stateHome: canonicalCrewStateHome(),
        findings: [{ kind: 'skills.blocked', severity: 'error', message }],
      });
    }
    if (ready.published !== null && ready.published.verdict === 'warnings') {
      // A first publish WITH warnings landed (design v3.4 §1): the snapshot is written and handed
      // over; the warnings are upstream content bugs the operator fixes locally or upstream — say
      // them once, by kind and file:line, so the day-one log is honest about what shipped.
      const named = ready.published.findings.map((f) => `${f.kind}${f.file === null ? '' : ` ${f.file}${f.line === null ? '' : `:${f.line}`}`}`).join('; ');
      this.log(`[skills] first publish landed with ${ready.published.findings.length} warning(s) (published as found; fix in the editor or upstream): ${named}`);
    }
    this.afterPublish();
    return this.lastHealth;
  }

  /**
   * One CoreEvent from the daemon's event listener: pins the generation the engine reports it
   * handed the live run the event belongs to, releases (and reaps) at the run's terminal frame —
   * live-generations.ts.
   */
  observe(event: CoreEvent): void {
    this.store.observeEvent(event);
  }

  /**
   * One launch notice from the adapter (`CoreAdapter.onLaunch`): the daemon is handing a run or
   * campaign to the engine — open its launch pin at the generation the env exports right now,
   * BEFORE the engine call, so no spawn can read the env ahead of the pin — or the engine refused
   * it (release the pin; nothing will spawn). The pin is otherwise released only by the engine's
   * `skillsSnapshotHanded` report or the terminal frame — never by publish count (codex round 4).
   */
  launched(notice: LaunchNotice): void {
    if (notice.status === 'handed') this.store.live.launched(notice.kind, notice.id);
    else this.store.live.launchRejected(notice.kind, notice.id);
  }

  /**
   * Export the VERIFIED current snapshot for the engine — the ONE engine input (v3.4 §2). With
   * nothing published (or an unverifiable `current`) the engine input is NOT touched here — `apply`
   * decided it. Answers the health it recorded, or `null` when there was nothing to export.
   */
  afterPublish(): SkillsHealth | null {
    let current: { gen: number; path: string } | null;
    try {
      current = this.store.currentSnapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refusal = refusalPath(this.store.root, 'skills.config');
      applySkillsSnapshotEnv(refusal);
      this.store.live.exported(null);
      this.log(`[skills] skills.config: ${message}; ${SKILLS_SNAPSHOT_ENGINE_ENV}=${refusal}`);
      return this.record({
        state: 'config-error',
        root: this.store.root,
        current: null,
        engineInput: refusal,
        stateHome: canonicalCrewStateHome(),
        findings: [{ kind: 'skills.config', severity: 'error', message }],
      });
    }
    if (current === null) {
      this.store.live.exported(null);
      return null;
    }
    applySkillsSnapshotEnv(current.path);
    // Record the generation the env now hands to launches: every launch the adapter announces from
    // here on opens its pin at this generation (and accumulates later publishes) until the engine's
    // `skillsSnapshotHanded` says which one it used or the run ends (live-generations.ts).
    this.store.live.exported(current.gen);
    return this.record({ state: 'published', root: this.store.root, current, engineInput: current.path, stateHome: canonicalCrewStateHome(), findings: [] });
  }

  private record(health: SkillsHealth): SkillsHealth {
    this.lastHealth = health;
    return health;
  }
}
