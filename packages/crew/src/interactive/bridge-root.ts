/**
 * Which wicked-interactive document root a crew project speaks to (DES-MERGE-001 §7.1/§7.2).
 *
 * §7.1 closed the identity question: a crew Project is THE entity, and an interactive
 * "instance" (a docs directory) maps onto it through ONE nullable setting, `interactiveRoot`.
 * Null means "the default root" — it is a default, never a constraint (§7.2): a project that
 * sets it gets exactly the directory it named.
 *
 * WHAT "THE DEFAULT" IS DEPENDS ON THE PROJECT (crew#472). It used to be one shared directory for
 * every project, which meant `:projectId` in the proxy path was honored only to resolve a setting
 * no project ever had — every project fell through to the same root, one bridge, one registry,
 * the same 31 docs under every project's URL. Now:
 *
 *  - the synthesized `default` ("Unfiled") project keeps the LEGACY shared root, byte-identical
 *    to `wicked-interactive serve`'s own default — so every doc created before partitioning stays
 *    visible under Unfiled with no data migration, and an operator's already-running default
 *    bridge is still adopted rather than duplicated;
 *  - every other project without an explicit root gets its own partition UNDER that root,
 *    `<default root>/projects/<projectId>`. Nested there on purpose: the legacy bridge's
 *    `listDocs` only lists slug-named children carrying a `versions.json`, so `projects/` is
 *    invisible to it, and the whole interactive footprint stays in the one place it always was.
 *
 * The resolved string is also the BRIDGE POOL KEY, which is why every spelling of the same
 * directory has to collapse to one value here rather than in the pool. `~/decks`, `decks`
 * (relative), and `/Users/me/decks/` are the same instance; keying on the raw setting would
 * start a second `wicked-interactive serve` on a second port for each spelling — exactly the
 * "why is it on 5 ports" confusion ADR-0025 exists to prevent.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';

/** The setting carrier — a `Project` record or a crew-side settings row both satisfy this. */
export interface InteractiveRootSetting {
  /** Absolute or `~`-relative docs root; null/absent ⇒ the project's default root. */
  interactiveRoot?: string | null | undefined;
}

/** Env override for the SHARED DEFAULT only (never for an explicit per-project setting).
 *  Exists so a test harness or an e2e run can point "the default root" at a scratch dir. It is
 *  an explicit shared binding: while set, EVERY unbound project — `default` included — resolves
 *  to it, exactly as before partitioning existed. */
export const ROOT_ENV = 'WICKED_INTERACTIVE_ROOT';

/** The directory under the default root that holds the per-project partitions (crew#472). */
export const PROJECTS_DIR = 'projects';

/**
 * A project id that can be a directory name: one path segment, no separators, never `.`/`..`.
 * Engine-minted ids are `proj_<ms><seq>`; the reserved `default` never reaches this check.
 */
const PARTITION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * What `wicked-interactive serve` uses with no `--root`: the canonical shared root
 * `~/wicked-interactive/docs` (ADR-0025 amended, `bin/wicked-interactive.js:181`). Kept
 * byte-identical to interactive's own default on purpose — that is what lets an operator's
 * already-running default bridge be ADOPTED by the pool instead of duplicated.
 */
export function defaultInteractiveRoot(home: string = homedir()): string {
  return resolve(home, 'wicked-interactive', 'docs');
}

/**
 * The default docs root of a NON-default project with no explicit binding:
 * `<default root>/projects/<projectId>` (crew#472). The directory is created on first use by the
 * bridge pool (it `mkdir -p`s any root before spawning a bridge), so resolution stays pure.
 *
 * Throws on an id that cannot be a directory name. The route layer 404s unknown projects before
 * resolving, and the seams only see ids the engine minted, so reaching this is a bug — and the
 * one answer that must never be given is a silent fallback to the shared root, which would
 * quietly re-open the leak this partition closes.
 */
export function partitionedInteractiveRoot(projectId: string, home: string = homedir()): string {
  if (!PARTITION_SEGMENT.test(projectId)) {
    throw new Error(`project id ${JSON.stringify(projectId)} cannot name an interactive docs partition`);
  }
  return resolve(defaultInteractiveRoot(home), PROJECTS_DIR, projectId);
}

/** Expand a leading `~` and absolutize, so every spelling of one directory keys the same. */
function canonicalize(value: string, home: string): string {
  const expanded =
    value === '~' ? home : value.startsWith('~/') || value.startsWith('~\\') ? resolve(home, value.slice(2)) : value;
  return resolve(expanded);
}

/**
 * The EXPLICIT half of the precedence — the project's own `interactiveRoot`, else the
 * `WICKED_INTERACTIVE_ROOT` shared binding — or null when neither is set. A blank/whitespace
 * setting is treated as null, not as "the cwd".
 */
function explicitInteractiveRoot(
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined>,
  home: string,
): string | null {
  const own = setting?.interactiveRoot;
  if (typeof own === 'string' && own.trim() !== '') return canonicalize(own.trim(), home);
  const shared = env[ROOT_ENV];
  if (typeof shared === 'string' && shared.trim() !== '') return canonicalize(shared.trim(), home);
  return null;
}

/**
 * The resolved, canonical docs root for a setting WITHOUT a project identity — and therefore its
 * bridge pool key. Precedence: the own `interactiveRoot` › `WICKED_INTERACTIVE_ROOT` › the
 * shared default. This is the `default` project's resolution; callers that know which project
 * they are resolving for use `resolveProjectInteractiveRoot` so other projects partition.
 */
export function resolveInteractiveRoot(
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return explicitInteractiveRoot(setting, env, home) ?? defaultInteractiveRoot(home);
}

/**
 * The resolved, canonical docs root for a PROJECT (crew#472). Precedence: the project's own
 * `interactiveRoot` › `WICKED_INTERACTIVE_ROOT` › the project's default — the legacy shared root
 * for `default` (and for an unknown project identity, `undefined`: an event that carries no
 * `project_id` belongs to Unfiled), the `projects/<projectId>` partition for everything else.
 */
export function resolveProjectInteractiveRoot(
  projectId: string | undefined,
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const explicit = explicitInteractiveRoot(setting, env, home);
  if (explicit !== null) return explicit;
  if (projectId === undefined || projectId === DEFAULT_PROJECT_ID) return defaultInteractiveRoot(home);
  return partitionedInteractiveRoot(projectId, home);
}
