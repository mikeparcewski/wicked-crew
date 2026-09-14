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
 *   `baseSkillPolicy: 'require'` — the ONLY policy (DES-L4 PR-⑧, D-8 / D-8b): export the env
 *                                whatever the generation holds; the engine refuses every launch at
 *                                intake until a generation with the skill is published, and the
 *                                finding is an ERROR that says so. The former `'warn'` rung is
 *                                DELETED: it left the env unset when the skill was missing, so every
 *                                seat ran UNGROUNDED — no launcher, no estate shim reachable — with
 *                                a /health warning as the only signal (a silent-ungrounded state
 *                                under D1). A fresh install lacks the skill until the garden that
 *                                ships it is installed and published; the refusal names that remedy.
 *                                `baseSkillRef: ""` remains the one explicit OFF switch.
 *
 * Pure: the posture is a function of the configured default, the published generation's skill
 * rows and the editor catalog — the runtime applies it to `process.env` (engine-env.ts) and
 * reports it (`GET /health.baseSkill`, `GET /diagnostics.skills.baseSkill`, the publish/refresh
 * results). `gen` here is the generation the NEXT launch is judged against; the generation a
 * RUNNING unit was handed is that unit's `skillsSnapshotHanded.gen`, joined with its
 * `unitDispatched.baseSkill {name, role}` frame.
 */

import type { SkillsHealthFinding } from './runtime.js';
import type { BaseSkillPosture as WireBaseSkillPosture } from 'wicked-crew-api-types';

/** The engine-config variable wicked-core reads at intake (`workflow::BASE_SKILL_REF_ENV`). */
export const BASE_SKILL_REF_ENGINE_ENV = 'WICKED_BASE_SKILL_REF';

/** The shipped default: the cross-CLI discipline skill wicked-garden publishes (garden#1131). */
export const DEFAULT_BASE_SKILL_REF = 'wicked-garden-governed-worker';

export type BaseSkillPolicy = 'require';

/**
 * What the PUBLISHED wire (`wicked-crew-api-types` 0.38.0 `BaseSkillPosture.policy`) still spells —
 * it predates D-8b and keeps the deleted `'warn'` token until the next api-types field list narrows
 * it. The disclosed posture is typed by the wire so the both-way wire-contract pin holds; the daemon
 * only ever emits `'require'` (`BaseSkillConfig.policy` is the narrow type).
 */
export type WireBaseSkillPolicy = WireBaseSkillPosture['policy'];

/** The accepted `baseSkillPolicy` values — `'require'` only; `'warn'` is refused (400) since D-8b. */
export const BASE_SKILL_POLICIES: ReadonlySet<string> = new Set<BaseSkillPolicy>(['require']);

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
  /** Always `'require'` from this daemon (D-8b); typed by the wire, see `WireBaseSkillPolicy`. */
  policy: WireBaseSkillPolicy;
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
  // `'require'` is the only policy: the engine variable is ALWAYS exported and the engine refuses
  // at intake when the handed generation lacks the skill — never an unset env and an ungrounded run.
  const engineInput = name;
  const finding = present ? null : missingFinding(name, gen, catalog);
  return { name, policy: config.policy, present, inCatalog: catalog, gen, engineInput, finding };
}

function missingFinding(name: string, gen: number | null, inCatalog: boolean): SkillsHealthFinding {
  const where = gen === null ? 'no published snapshot is handed to the engine' : `the published snapshot (gen ${gen}) does not hold it`;
  const remedy = inCatalog
    ? 'it is in the catalog — POST /skills/publish hands it to the next launch'
    : 'install a wicked-garden that ships it, POST /skills/refresh-baseline, then POST /skills/publish';
  return {
    kind: 'skills.base-skill',
    severity: 'error',
    message: `the base skill "${name}" (baseSkillRef — the role-keyed discipline every governed unit follows) is REQUIRED but ${where}: the engine refuses every launch at intake until a generation holding it is published — ${remedy}; set baseSkillRef "" (PUT /settings) to turn the base skill off explicitly`,
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
  // `'require'` is the only policy (D-8b): a missing skill always refuses launches at intake.
  return `discipline skill: ${posture.name} MISSING — runs will be refused at intake`;
}
