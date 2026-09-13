/**
 * The BASE skill posture (crew#554 — the launcher half of wicked-core#468).
 *
 * The engine prepends ONE role-keyed discipline directive to EVERY agent unit's prompt —
 * `Invoke your skill "<base>" … and follow its §<role> section` — when a base skill is in force:
 * the workflow def's `base_skill_ref`, else the engine-config default `WICKED_BASE_SKILL_REF`.
 * It is GATED AT INTAKE: a launch whose handed skills snapshot lacks the skill is refused before
 * any unit is planned (`SkillsError::BaseSkillRefused`). Crew is the launcher, so crew owns the
 * default (`SystemSettings.baseSkillRef`, shipped as `wicked-garden-governed-worker`) and must
 * decide what a snapshot WITHOUT the skill means:
 *
 *   `baseSkillPolicy: 'warn'`    (default) — export the env ONLY when the published generation
 *                                holds the skill; otherwise leave it unset (runs proceed without
 *                                the directive) and raise a `skills.base-skill` WARNING. A fresh
 *                                install lacks the skill until the garden that ships it is
 *                                installed and published — a visible warning, never a dead Send.
 *   `baseSkillPolicy: 'require'` — export the env whatever the generation holds; the engine
 *                                refuses every launch at intake until a generation with the skill
 *                                is published. The finding is an ERROR that says so.
 *
 * Pure: the posture is a function of the configured default, the published generation's skill
 * rows and the editor catalog — the runtime applies it to `process.env` (engine-env.ts) and
 * reports it (`GET /health.baseSkill`, `GET /diagnostics.skills.baseSkill`, the publish/refresh
 * results). `gen` here is the generation the NEXT launch is judged against; the generation a
 * RUNNING unit was handed is that unit's `skillsSnapshotHanded.gen`, joined with its
 * `unitDispatched.baseSkill {name, role}` frame.
 */

import type { SkillsHealthFinding } from './runtime.js';

/** The engine-config variable wicked-core reads at intake (`workflow::BASE_SKILL_REF_ENV`). */
export const BASE_SKILL_REF_ENGINE_ENV = 'WICKED_BASE_SKILL_REF';

/** The shipped default: the cross-CLI discipline skill wicked-garden publishes (garden#1131). */
export const DEFAULT_BASE_SKILL_REF = 'wicked-garden-governed-worker';

export type BaseSkillPolicy = 'warn' | 'require';

export const BASE_SKILL_POLICIES: ReadonlySet<string> = new Set<BaseSkillPolicy>(['warn', 'require']);

/**
 * What a base skill NAME may look like once trimmed: empty (off) or a frontmatter skill name —
 * lowercase letters, digits, `-`, `_`, `:`, `.` (the `wicked-garden-<dir>` convention and the
 * `wicked-garden:<dir>` plugin spelling), ≤ 128 chars. The PUT /settings boundary and the
 * hand-edited settings.json read both hold to it, so the engine is never handed whitespace, a path
 * or a sentence as `WICKED_BASE_SKILL_REF` (which would refuse every launch by a name nobody typed).
 */
export const BASE_SKILL_REF_SHAPE = /^(?:[a-z0-9][a-z0-9._:-]{0,127})?$/;

/** What the settings store says: the skill name (`''` = off) and the missing-skill policy. */
export interface BaseSkillConfig {
  ref: string;
  policy: BaseSkillPolicy;
}

/** The published generation the engine is handed, reduced to what the posture needs. */
export interface PublishedSkills {
  gen: number;
  /** Frontmatter names of every skill row in the generation's `snapshot.json`. */
  skills: ReadonlyArray<string>;
}

/**
 * The base skill in force for the next launch — `null` when the setting is off (`''`).
 * Additive on every surface that carries it (api-types declares it as optional).
 */
export interface BaseSkillPosture {
  /** The frontmatter name the engine is (or would be) handed. */
  name: string;
  policy: BaseSkillPolicy;
  /** The published generation the engine is handed holds the skill — the intake admission will pass. */
  present: boolean;
  /** The editor catalog holds the skill enabled — a publish would hand it (`present` after the next publish). */
  inCatalog: boolean;
  /** The generation judged, or `null` when nothing is published (fallback / blocked / config-error / disabled). */
  gen: number | null;
  /** What `WICKED_BASE_SKILL_REF` is exported as: the name, or `null` = unset (the engine runs without a base skill). */
  engineInput: string | null;
  /** The `skills.base-skill` finding when the generation lacks the skill; `null` when it holds it. */
  finding: SkillsHealthFinding | null;
}

/** Trim the configured name; `''`/blank is "no base skill". */
export function normalizeBaseSkillRef(ref: string | undefined): string {
  return typeof ref === 'string' ? ref.trim() : '';
}

/**
 * Compute the posture. `published` is `null` when no verified generation is exported (the engine
 * either falls back to the live plugin or refuses — either way the base skill is not KNOWN to be
 * handed, so it counts as absent); `inCatalog` answers whether the editor manifest holds the
 * skill enabled (what a publish would hand).
 */
export function baseSkillPosture(
  config: BaseSkillConfig,
  published: PublishedSkills | null,
  inCatalog: (name: string) => boolean,
): BaseSkillPosture | null {
  const name = normalizeBaseSkillRef(config.ref);
  if (name === '') return null;
  const present = published !== null && published.skills.includes(name);
  const catalog = inCatalog(name);
  const gen = published?.gen ?? null;
  const engineInput = config.policy === 'require' || present ? name : null;
  const finding = present ? null : missingFinding(name, config.policy, gen, catalog);
  return { name, policy: config.policy, present, inCatalog: catalog, gen, engineInput, finding };
}

function missingFinding(name: string, policy: BaseSkillPolicy, gen: number | null, inCatalog: boolean): SkillsHealthFinding {
  const where = gen === null ? 'no published snapshot is handed to the engine' : `the published snapshot (gen ${gen}) does not hold it`;
  const remedy = inCatalog
    ? 'it is in the catalog — POST /skills/publish hands it to the next launch'
    : 'install a wicked-garden that ships it, POST /skills/refresh-baseline, then POST /skills/publish';
  if (policy === 'require') {
    return {
      kind: 'skills.base-skill',
      severity: 'error',
      message: `the base skill "${name}" (baseSkillRef — the role-keyed discipline every governed unit follows) is REQUIRED but ${where}: the engine refuses every launch at intake until a generation holding it is published — ${remedy}; or set baseSkillPolicy "warn" to run without the discipline directive meanwhile`,
    };
  }
  return {
    kind: 'skills.base-skill',
    severity: 'warning',
    message: `the base skill "${name}" (baseSkillRef — the role-keyed discipline every governed unit follows) is not handed: ${where}, so runs proceed WITHOUT the discipline directive — ${remedy}; set baseSkillPolicy "require" to refuse such runs at intake instead`,
  };
}

/**
 * Apply a posture to THIS process's environment. The engine reads `WICKED_BASE_SKILL_REF` at
 * INTAKE (plan time) per launch — never cached — so applying it at boot, after every publish /
 * refresh and on every settings change is the whole mechanism: no daemon or engine restart.
 * Crew OWNS the variable while the seam is live: a value the process booted with is overwritten
 * (the setting is the source of truth; `baseSkillRef: ""` deletes it).
 */
export function applyBaseSkillEnv(posture: BaseSkillPosture | null): void {
  if (posture !== null && posture.engineInput !== null) {
    process.env[BASE_SKILL_REF_ENGINE_ENV] = posture.engineInput;
  } else {
    delete process.env[BASE_SKILL_REF_ENGINE_ENV];
  }
}

/** The one-line disclosure a composer / run header renders: `discipline skill: <name> gen N`. */
export function describeBaseSkill(posture: BaseSkillPosture | null): string {
  if (posture === null) return 'discipline skill: off';
  if (posture.present) return `discipline skill: ${posture.name} gen ${posture.gen ?? '?'}`;
  return posture.policy === 'require'
    ? `discipline skill: ${posture.name} MISSING — runs will be refused at intake`
    : `discipline skill: ${posture.name} MISSING — runs proceed without it`;
}
