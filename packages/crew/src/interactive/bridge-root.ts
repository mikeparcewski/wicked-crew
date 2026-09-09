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

import { lstatSync, mkdirSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
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
  return resolve(partitionsBase(home), projectId);
}

/** The directory holding every partition: `<default root>/projects`. */
export function partitionsBase(home: string = homedir()): string {
  return resolve(defaultInteractiveRoot(home), PROJECTS_DIR);
}

/**
 * A project's partition is NOT a real directory under the projects base — a symbolic link, a
 * regular file, or a path whose real location sits outside the base. Thrown by
 * `preparePartitionedInteractiveRoot`, and so by every route's `projectDocsRoot`
 * (`project-root.ts`). Fastify's default error handler honors `statusCode` and answers with
 * this message verbatim, so the refusal reaches the operator as a 500 that names the offending
 * path — never as a silent fallback to some other root.
 */
export class InteractivePartitionRefusedError extends Error {
  readonly statusCode = 500;
  constructor(
    readonly projectId: string,
    /** The path that failed the check. */
    readonly path: string,
    reason: string,
    base: string,
  ) {
    super(
      `refusing to serve the interactive docs of project ${JSON.stringify(projectId)}: ${path} ${reason}. ` +
        `A per-project partition must be a real directory under ${base} — remove or replace it and retry`,
    );
    this.name = 'InteractivePartitionRefusedError';
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Resolve AND materialize a project's partition, refusing anything that would let the lexical
 * path `<base>/<projectId>` name a different directory.
 *
 * `partitionedInteractiveRoot` is lexical: it proves the id cannot spell its way out of
 * `projects/`, and nothing more. A symbolic link already sitting at `projects/<id>` — pointing
 * at another project's partition, or anywhere else — passes that check and would be followed by
 * the bridge (spawned with `--root` = this path) into the other directory: project A reading and
 * writing B's docs through a URL the id check said was A's. So, on REAL paths:
 *
 *  1. every component under the base is `lstat`ed — a symlink or a non-directory anywhere on the
 *     way refuses (fail closed, naming the path); the base itself is the operator's to place (a
 *     docs root kept on another volume behind a link is legitimate) and is not judged;
 *  2. a missing component is created with `mkdir` WITHOUT `recursive` — `mkdir(2)` never follows
 *     a link at the component it creates, so a link raced in between the `lstat` and the `mkdir`
 *     surfaces as `EEXIST` and is `lstat`ed like anything else found in place, never followed;
 *  3. the real path of the partition must sit inside the real path of the base — belt and braces
 *     over (1), so a containment failure the walk did not name is still refused.
 *
 * Returns the LEXICAL path — it is the bridge pool key, and spelling collapse is unchanged. The
 * check runs per resolution, not per file operation: a link swapped in under a bridge that is
 * already running is that process's (and the filesystem's) business, not something crew can see
 * from the resolution seam.
 */
export function preparePartitionedInteractiveRoot(projectId: string, home: string = homedir()): string {
  const partition = partitionedInteractiveRoot(projectId, home);
  const base = partitionsBase(home);
  mkdirSync(base, { recursive: true });
  const refuse = (path: string, reason: string): never => {
    throw new InteractivePartitionRefusedError(projectId, path, reason, base);
  };

  // One segment today (an id is a single path segment); walked as a path so a deeper layout
  // later inherits the same rule.
  let cursor = base;
  for (const segment of relative(base, partition).split(sep)) {
    cursor = resolve(cursor, segment);
    let st = lstatOrNull(cursor);
    if (st === null) {
      try {
        mkdirSync(cursor);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      st = lstatOrNull(cursor) ?? refuse(cursor, 'vanished while it was being created');
    }
    if (st.isSymbolicLink()) {
      let target = '?';
      try {
        target = readlinkSync(cursor);
      } catch {
        /* an unreadable link — the path alone is the finding */
      }
      refuse(cursor, `is a symbolic link (→ ${target})`);
    }
    if (!st.isDirectory()) refuse(cursor, 'is not a directory');
  }

  const realBase = realpathSync.native(base);
  const realPartition = realpathSync.native(partition);
  if (!realPartition.startsWith(realBase + sep)) {
    refuse(partition, `resolves to ${realPartition}, outside ${realBase}`);
  }
  return partition;
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
  return resolveProjectRootWith(partitionedInteractiveRoot, projectId, setting, env, home);
}

/**
 * `resolveProjectInteractiveRoot` for a caller about to USE the root — the routes, through
 * `project-root.ts`. Same precedence; the difference is that a partition is materialized and
 * containment-checked on real paths (`preparePartitionedInteractiveRoot`) instead of merely
 * spelled, so a symlinked `projects/<id>` throws `InteractivePartitionRefusedError` here rather
 * than being followed by the bridge. An explicit root and the `default` project's legacy root are
 * returned untouched — an operator's own directory is theirs to place, behind a link or not
 * (§7.2) — so those two never cost a disk access.
 */
export function ensureProjectInteractiveRoot(
  projectId: string | undefined,
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return resolveProjectRootWith(preparePartitionedInteractiveRoot, projectId, setting, env, home);
}

/** The one precedence rule, parameterized by how a partition is produced (spelled vs. prepared). */
function resolveProjectRootWith(
  partition: (projectId: string, home: string) => string,
  projectId: string | undefined,
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined>,
  home: string,
): string {
  const explicit = explicitInteractiveRoot(setting, env, home);
  if (explicit !== null) return explicit;
  if (projectId === undefined || projectId === DEFAULT_PROJECT_ID) return defaultInteractiveRoot(home);
  return partition(projectId, home);
}
