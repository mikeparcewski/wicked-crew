// The requirements-graph minimum coverage (operator ruling 2026-10-31): a repository's requirements
// graph is built, and shown labelled with its share ("82% of behaviours mapped"), once at least
// this percentage of its behaviour-bearing code is mapped. Default 80, adjustable in Settings
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

/** A valid `requirementsGraph` settings object: `{}` or `{ minCoveragePct }`, nothing else. */
export function isRequirementsGraphSettings(v: unknown): v is { minCoveragePct?: number } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.some((k) => k !== 'minCoveragePct')) return false;
  const pct = (v as { minCoveragePct?: unknown }).minCoveragePct;
  return pct === undefined || isMinCoveragePct(pct);
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
  const pct = (settings.requirementsGraph as { minCoveragePct?: unknown } | undefined)?.minCoveragePct;
  if (isMinCoveragePct(pct)) env[REQUIREMENTS_MIN_COVERAGE_ENV] = String(pct);
  else delete env[REQUIREMENTS_MIN_COVERAGE_ENV];
}
