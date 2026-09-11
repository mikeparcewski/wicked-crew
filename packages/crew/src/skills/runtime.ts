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
 * Orthogonal to the ladder, one persistent WARNING (design v3.6, #490): finding `skills.source` is
 * present while the CURRENT baseline was captured from the installer-managed copy
 * (`source.kind: 'installer-copy'` — plugin-source.ts tier 3): the daemon works on an installer-only
 * machine, but that copy receives no marketplace updates until the plugin is registered with Claude
 * Code. It is judged live from the manifest on every `health()` read, so it appears with the seed
 * and disappears with the first refresh from the marketplace cache (a byte-identical refresh
 * re-records the provenance too). That read FAILS CLOSED (codex on #491): a manifest that cannot be
 * read now is reported as `config-error` with a `skills.manifest` error finding naming the cause —
 * never the stale outcome the ladder recorded at boot. A read never touches the engine input.
 *
 * A second orthogonal WARNING (F-083): finding `skills.stale-rules` is present while the CURRENT
 * generation was published under other portability rules than this daemon runs (an older
 * publisher — every pre-0.7.31 snapshot records no rules identity at all). The generation is
 * accepted and exported unchanged (`state: published`); the finding names the rows that derive
 * differently today (up to five, the count carries the rest) and the remedy — a re-publish, which
 * records the running identity, re-lays the copilot view, rewrites the rows and clears it. A rule
 * change is not tampering: before this, the store's row cross-check refused such a generation
 * outright, and the 0.7.29 → 0.7.30 upgrade left every seat without skills until an operator
 * re-published. It is judged where the generation is verified (`afterPublish`: boot and every
 * publish), never re-judged on a read — staleness changes only with a publish or an upgrade.
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
import type { CoreEvent, SkillManifest } from '../core/types.js';
import { applySkillsSnapshotEnv, BOOT_SKILLS_SNAPSHOT, canonicalCrewStateHome, SKILLS_SNAPSHOT_ENGINE_ENV } from './engine-env.js';
import { SKILLS_SOURCE_ENV, type PluginSource } from './plugin-source.js';
import { REFUSED_DIRNAME } from './root-names.js';
import { SkillsSourceUnavailableError, type CurrentSnapshot, type SkillsStore } from './store.js';

/**
 * The seed source named for the boot log by what it IS (Copilot on #480: the line used to hard-code
 * "the installed wicked-garden plugin" although an explicit `WICKED_CREW_SKILLS_SOURCE` checkout or
 * directory seeds just as well): its kind, its path and the plugin version it declares — so an
 * operator debugging which bytes were seeded reads the actual root, never an assumption.
 */
function describeSeedSource(source: PluginSource): string {
  const what =
    source.kind === 'claude-plugin-cache'
      ? 'the installed wicked-garden plugin (Claude plugin cache)'
      : source.kind === 'installer-copy'
        ? 'the installer-managed wicked-garden copy (plugins/wicked-garden — the LAST-resort source, design v3.6; not the marketplace cache)'
        : source.kind === 'checkout'
          ? `a wicked-garden git checkout (an explicit plugin root — ${SKILLS_SOURCE_ENV} or the configured source)`
          : `a plugin directory (an explicit plugin root — ${SKILLS_SOURCE_ENV} or the configured source)`;
  return `${what} at ${source.path}, plugin version ${source.plugin_version}, source kind ${source.kind}`;
}

/**
 * The persistent `skills.source` WARNING (design v3.6): the CURRENT baseline was captured from the
 * installer-managed copy (`source.kind: 'installer-copy'`) — the daemon works, but that copy receives
 * no marketplace updates until the plugin is registered with Claude Code. Judged LIVE from the
 * manifest, never frozen at publish: a refresh from the marketplace cache re-keys the current
 * baseline WITHOUT a publish, and the warning must follow the baseline. `null` when the manifest
 * baseline. `health()` reads the manifest and fails closed when it cannot.
 */
function sourceFinding(m: SkillManifest): SkillsHealthFinding | null {
  const current = m.baselines[m.baseline];
  if (current === undefined || current.source.kind !== 'installer-copy') return null;
  return {
    kind: 'skills.source',
    severity: 'warning',
    message: `seeded from the installer copy at ${current.source.path}; register the plugin with Claude Code (marketplace) to receive marketplace updates`,
  };
}

/** How many drifted rows the `skills.stale-rules` message names — the count carries the rest. */
const STALE_RULES_NAMED_ROWS = 5;

/**
 * The `skills.stale-rules` WARNING (F-083): the current generation was published under OTHER
 * portability rules than the ones this daemon runs — an older publisher (every pre-0.7.31 snapshot
 * records no identity), or a rule table that moved since — so its rows may derive differently today
 * without a byte having changed. The generation is ACCEPTED and stays the engine input; the message
 * names the rows that now derive differently (up to `STALE_RULES_NAMED_ROWS`), states that every
 * seat is still admitted and served by the RECORDED rows (review M1 — the engine reads the snapshot,
 * never crew's re-derivation), whether the editor manifest was re-derived (review M2), and the
 * remedy: a re-publish, which records the running identity and clears the finding. `null` when the
 * identities agree (a generation this daemon — or one with the same rules — published).
 */
function staleRulesFinding(current: CurrentSnapshot, rederived: { moved: number } | null): SkillsHealthFinding | null {
  if (!current.rules.stale) return null;
  const { recorded, running } = current.rules;
  const was = recorded === null ? 'an unrecorded portability rules version (a publisher before 0.7.31)' : `portability rules v${recorded.version} (${recorded.sha256.slice(0, 12)})`;
  const named = current.drift
    .slice(0, STALE_RULES_NAMED_ROWS)
    .map((d) => `${d.name} (portable ${String(d.recorded.portable)} → ${String(d.derived.portable)}${d.derived.reasons.length === 0 ? '' : `: ${d.derived.reasons.join(', ')}`})`)
    .join(', ');
  const rest = current.drift.length > STALE_RULES_NAMED_ROWS ? ` (+${current.drift.length - STALE_RULES_NAMED_ROWS} more)` : '';
  const rows = current.drift.length === 0 ? 'every row derives the same under the current rules' : `${current.drift.length} row(s) now derive differently: ${named}${rest}`;
  // The seat consequence, said where the operator reads it (review M1): the engine admits and
  // delivers by the snapshot's RECORDED rows — the drift above is what a re-publish WOULD record,
  // not what seats get today. The reverse direction is called out by name: a row recorded portable
  // that now derives non-portable is still handed to every non-Claude seat until the re-publish.
  const seats =
    'every seat is still admitted and served by the RECORDED rows until a re-publish (a row listed false → true stays Claude-only; a row listed true → false is still delivered to non-Claude seats)';
  const reversed = current.drift.filter((d) => d.recorded.portable && !d.derived.portable);
  const reversedNote =
    reversed.length === 0
      ? ''
      : `; ${reversed.length} recorded-portable row(s) now derive NON-portable and are STILL delivered to non-Claude seats: ${reversed
          .slice(0, STALE_RULES_NAMED_ROWS)
          .map((d) => d.name)
          .join(', ')}${reversed.length > STALE_RULES_NAMED_ROWS ? ` (+${reversed.length - STALE_RULES_NAMED_ROWS} more)` : ''}`;
  const editor =
    rederived === null
      ? 'the editor manifest (GET /skills rows) could not be re-derived under the current rules (see the log)'
      : `the editor manifest (GET /skills rows) is re-derived under the current rules (${rederived.moved} row(s) moved)`;
  return {
    kind: 'skills.stale-rules',
    severity: 'warning',
    message: `generation ${current.gen} was published under ${was}; the daemon runs v${running.version} (${running.sha256.slice(0, 12)}) — ${rows}; ${seats}${reversedNote}; ${editor}; re-publish (POST /skills/publish) to refresh the copilot view and the snapshot rows under the current rules — until then the generation is accepted as published and stays the engine input`,
  };
}

/** The refusal sentinel directory name — from the ONE table of root names (design v3.5 §2); re-exported for the tests. */
export { REFUSED_DIRNAME };

export type SkillsHealthState = 'published' | 'fallback' | 'blocked' | 'config-error' | 'disabled';

/** `skills.stale-rules` (F-083) is emitted ahead of its `wicked-crew-api-types` declaration — the next api-types cut adds it to `DiagnosticsSkillsFinding.kind`. */
export type SkillsHealthFindingKind = 'skills.fallback' | 'skills.blocked' | 'skills.config' | 'skills.source' | 'skills.manifest' | 'skills.stale-rules';

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

  /**
   * The seam's last outcome (diagnostics) — plus the live `skills.source` warning when the current
   * baseline is the installer copy (design v3.6). Only a seeded root (`published` / `blocked`) has a
   * current baseline to judge; the other rungs have no manifest, or one their own finding condemns.
   */
  health(): SkillsHealth {
    const base = this.lastHealth;
    if (base.state !== 'published' && base.state !== 'blocked') return base;
    let manifest: SkillManifest;
    try {
      manifest = this.store.manifest();
    } catch (err) {
      // FAIL CLOSED (codex on #491): a manifest that cannot be read NOW is not the outcome the ladder
      // recorded at boot — report `config-error` with the cause instead of that stale state. A read
      // never touches the engine input: whatever is exported stays exported until a restart re-runs
      // the ladder, and the finding says so.
      const cause = err instanceof Error ? err.message : String(err);
      return {
        state: 'config-error',
        root: base.root,
        current: null,
        engineInput: base.engineInput,
        stateHome: base.stateHome,
        findings: [
          {
            kind: 'skills.manifest',
            severity: 'error',
            message: `manifest.json cannot be read: ${cause} — the skills store is unusable (every /skills request fails) until it is fixed; ${SKILLS_SNAPSHOT_ENGINE_ENV} still exports what the last boot or publish set (${base.engineInput ?? 'unset'}) until the daemon restarts`,
          },
        ],
      };
    }
    const source = sourceFinding(manifest);
    return source === null ? base : { ...base, findings: [...base.findings, source] };
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
    if (ready.seeded) this.log(`[skills] seeded ${root} from ${ready.source === null ? 'a source the seed did not record' : describeSeedSource(ready.source)}`);
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
      const blocked = this.record({
        state: 'blocked',
        root,
        current: null,
        engineInput: refusal,
        stateHome: canonicalCrewStateHome(),
        findings: [{ kind: 'skills.blocked', severity: 'error', message }],
      });
      this.logSourceWarning(blocked);
      return blocked;
    }
    if (ready.published !== null && ready.published.verdict === 'warnings') {
      // A first publish WITH warnings landed (design v3.4 §1): the snapshot is written and handed
      // over; the warnings are upstream content bugs the operator fixes locally or upstream — say
      // them once, by kind and file:line, so the day-one log is honest about what shipped.
      const named = ready.published.findings.map((f) => `${f.kind}${f.file === null ? '' : ` ${f.file}${f.line === null ? '' : `:${f.line}`}`}`).join('; ');
      this.log(`[skills] first publish landed with ${ready.published.findings.length} warning(s) (published as found; fix in the editor or upstream): ${named}`);
    }
    this.afterPublish();
    const health = this.health();
    this.logSourceWarning(health);
    return health;
  }

  /** Say once, at boot, that the current baseline is the installer copy (design v3.6) — the finding itself persists in `health()`. */
  private logSourceWarning(health: SkillsHealth): void {
    const source = health.findings.find((f) => f.kind === 'skills.source');
    if (source !== undefined) this.log(`[skills] skills.source: ${source.message}`);
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
    let current: CurrentSnapshot | null;
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
    // Published under OTHER portability rules (F-083): accepted and exported all the same — the ONE
    // warning names the rows that derive differently, the seat consequence, and the re-publish that
    // clears it. The EDITOR manifest is re-derived under the running rules first (review M2), so the
    // `GET /skills` rows and `current.drift` answer from the same rule table; a re-derivation that
    // cannot land (a manifest that cannot be written) is logged and said in the finding — it never
    // turns an accepted generation into a refusal.
    let rederived: { moved: number } | null = null;
    if (current.rules.stale) {
      try {
        const r = this.store.rederiveUnderRunningRules();
        rederived = { moved: r.moved.length };
        if (r.moved.length > 0) {
          this.log(`[skills] skills.stale-rules: re-derived the editor manifest under the current rules — ${r.moved.map((x) => `${x.name} (portable ${String(x.from)} → ${String(x.to)})`).join(', ')} (revision ${r.revision})`);
        }
        for (const f of r.refused) this.log(`[skills] skills.stale-rules: re-derivation skipped ${f.skill ?? f.file ?? 'a skill'} — ${f.kind}: ${f.evidence}`);
      } catch (err) {
        this.log(`[skills] skills.stale-rules: the editor manifest could not be re-derived under the current rules: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const stale = staleRulesFinding(current, rederived);
    if (stale !== null) this.log(`[skills] skills.stale-rules: ${stale.message}`);
    return this.record({
      state: 'published',
      root: this.store.root,
      current: { gen: current.gen, path: current.path },
      engineInput: current.path,
      stateHome: canonicalCrewStateHome(),
      findings: stale === null ? [] : [stale],
    });
  }

  /** Store the ladder's outcome; answer it as `health()` reports it (the live `skills.source` warning included). */
  private record(health: SkillsHealth): SkillsHealth {
    this.lastHealth = health;
    return this.health();
  }
}
