// The requirements-graph minimum coverage (operator ruling 2026-10-31): a repository's requirements
// graph is built, and shown labelled with its share, once REAL requirements reach this percentage
// of its behaviour-bearing product code (operator decision 2026-11-01, wicked-core#1233:
// risk-flagged placeholders never count). Default 80, adjustable in Settings
// (`requirementsGraph.minCoveragePct`, an integer 1..100).
//
// One mechanism, the same as the council settings: the daemon exports the persisted value as env at
// boot and on every settings change, and the engine reads it where it gates —
// `wicked-core coverage --min-coverage-pct` (the domain-extraction preset's pinned coverage
// validator, which the engine hands the variable explicitly) and `wicked-core domain-graph` (the
// preset's last step, a tool process that inherits the daemon's env). A change is live on the next
// run with no restart. An absent or invalid setting deletes the variable and the engine's default
// (80) holds, so the two defaults are one number.

export const REQUIREMENTS_MIN_COVERAGE_ENV = 'WICKED_REQUIREMENTS_MIN_COVERAGE_PCT';

/** The engine's default (`wicked_governance::DEFAULT_MIN_COVERAGE_PCT`). */
export const DEFAULT_MIN_COVERAGE_PCT = 80;

/** A valid `minCoveragePct`: a whole percentage 1..100. */
export function isMinCoveragePct(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100;
}

// A GENERATION keeps mapping page after page until the target (domain-graph-3); its budget per
// grant ends in an ask (map more, lower the target for the repository, or stop). The host steps
// read these from the daemon's environment like the minimum: garden's `next_page.py` (pages and
// minutes) and `prepare_worklist.py` (the page size). Absent = the garden's defaults (20 pages,
// 240 minutes, 500 behaviours a page).
export const DOMAIN_MAX_PAGES_ENV = 'WICKED_DOMAIN_MAX_PAGES';
export const DOMAIN_MAX_MINUTES_ENV = 'WICKED_DOMAIN_MAX_MINUTES';
export const DOMAIN_PAGE_SIZE_ENV = 'WICKED_DOMAIN_PAGE_SIZE';

/** Each generation knob: its env variable and its whole-number range. */
const GENERATION_KNOBS = {
  maxPages: { env: DOMAIN_MAX_PAGES_ENV, min: 1, max: 200 },
  maxMinutes: { env: DOMAIN_MAX_MINUTES_ENV, min: 1, max: 1440 },
  pageSize: { env: DOMAIN_PAGE_SIZE_ENV, min: 50, max: 2000 },
} as const;
type GenerationKnob = keyof typeof GENERATION_KNOBS;

const isKnob = (k: GenerationKnob, v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= GENERATION_KNOBS[k].min && v <= GENERATION_KNOBS[k].max;

/** The settings object's shape: the minimum and the generation's budget and page size. */
export interface RequirementsGraphSettings {
  minCoveragePct?: number;
  maxPages?: number;
  maxMinutes?: number;
  pageSize?: number;
}

/** Why a `requirementsGraph` settings object is refused, in the operator's words. */
export const REQUIREMENTS_GRAPH_SETTINGS_RULE =
  'requirementsGraph.minCoveragePct must be a whole percentage between 1 and 100; maxPages 1..200, ' +
  'maxMinutes 1..1440 and pageSize 50..2000 are whole numbers; no other keys';

/** A valid `requirementsGraph` settings object: any of its four keys, nothing else. */
export function isRequirementsGraphSettings(v: unknown): v is RequirementsGraphSettings {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k === 'minCoveragePct') {
      if (o[k] !== undefined && !isMinCoveragePct(o[k])) return false;
    } else if (Object.hasOwn(GENERATION_KNOBS, k)) {
      if (o[k] !== undefined && !isKnob(k as GenerationKnob, o[k])) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** The minimum in force: the setting when valid, else the default. */
export function minCoveragePct(settings: { requirementsGraph?: unknown } | null | undefined): number {
  const pct = (settings?.requirementsGraph as { minCoveragePct?: unknown } | undefined)?.minCoveragePct;
  return isMinCoveragePct(pct) ? pct : DEFAULT_MIN_COVERAGE_PCT;
}

/**
 * Export the minimum to `env` (default: this process, whose environment the in-process engine and
 * every tool step it spawns read). A missing or invalid value deletes the variable, so the engine's
 * own default applies.
 */
export function applyRequirementsGraphSettings(
  settings: { requirementsGraph?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const rg = settings.requirementsGraph as Record<string, unknown> | undefined;
  const pct = rg?.minCoveragePct;
  if (isMinCoveragePct(pct)) env[REQUIREMENTS_MIN_COVERAGE_ENV] = String(pct);
  else delete env[REQUIREMENTS_MIN_COVERAGE_ENV];
  for (const k of Object.keys(GENERATION_KNOBS) as GenerationKnob[]) {
    const v = rg?.[k];
    if (isKnob(k, v)) env[GENERATION_KNOBS[k].env] = String(v);
    else delete env[GENERATION_KNOBS[k].env];
  }
}
