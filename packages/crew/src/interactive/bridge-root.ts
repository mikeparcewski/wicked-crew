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
 *  - the synthesized `default` ("Unfiled") project gets the SHARED default root — since crew
 *    0.7.35 `<crew state home>/interactive/docs` (D-L7-1 / BC-49, F-RC1-122): one per daemon, so
 *    two daemons on one host never meet on one docs directory. It is no longer interactive's own
 *    `~/wicked-interactive/docs`: crew ALWAYS passes `--root`, so the bridge's default matters
 *    only to a standalone `serve`. Documents an earlier daemon left under the old HOME default are
 *    NOT moved — the boot names them once (`legacyHomeDocsNotice`) and they stay reachable through
 *    `WICKED_INTERACTIVE_ROOT` or a project's `interactiveRoot`, which may now point anywhere,
 *    inside the state home included;
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

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PROJECT_ID } from '../projects/default-project.js';
import { crewStateHome } from '../projects/state-home.js';

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
 * The SHARED default docs root: `<crew state home>/interactive/docs` (crew 0.7.35, D-L7-1 /
 * BC-49). One per daemon — the state home is what isolates two daemons on one host — and a
 * registered state-home entry (`interactive`, tests/fixtures/state-home-subtrees.json), so the
 * worker Read fence classifies it. Spelled as a literal `join(crewStateHome(), …)` on purpose:
 * `tests/state-home-subtrees.test.ts` scans src/ for exactly that shape.
 *
 * Until 0.7.34 this was `~/wicked-interactive/docs`, "kept byte-identical to interactive's own
 * default" so an operator's hand-started default bridge could be adopted. That coupling is gone:
 * crew always spawns with `--root`, and a bridge on the old path is still adopted when a project
 * names it. `stateHome` is injectable for tests; production always resolves the daemon's own.
 */
export function defaultInteractiveRoot(stateHome?: string): string {
  return stateHome === undefined ? join(crewStateHome(), 'interactive', 'docs') : join(stateHome, 'interactive', 'docs');
}

/**
 * Where the recorder's Playwright browser is provisioned and looked for — the third variable crew
 * hands every bridge it starts (`PLAYWRIGHT_BROWSERS_PATH`, BC-50 / R-L7-d): under the same
 * registered `interactive` entry, never the global Playwright cache (interactive #228). A
 * bridge started before this key existed is recycled by the pool (its sidecar lacks the key) —
 * which is also how interactive 0.9.3 reaches a running daemon.
 */
export function recorderBrowsersPath(stateHome?: string): string {
  return stateHome === undefined
    ? join(crewStateHome(), 'interactive', 'recorder-browsers')
    : join(stateHome, 'interactive', 'recorder-browsers');
}

/** The pre-0.7.35 default docs root — interactive's own standalone default under HOME. */
export function legacyHomeDocsRoot(home: string = homedir()): string {
  return resolve(home, 'wicked-interactive', 'docs');
}

/** A doc directory name as the bridge lists it (interactive's `DOC_NAME`). */
const DOC_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function countDocDirs(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && DOC_SLUG.test(e.name) && existsSync(join(dir, e.name, 'versions.json')),
    ).length;
  } catch {
    return 0; // absent or unreadable — nothing to report
  }
}

/**
 * The ONE boot notice the root move owes an operator (BC-49): documents left under the old
 * `~/wicked-interactive/docs` default (its top level and its `projects/<id>` partitions) while
 * nothing explicit names that directory. Null when there is nothing to say — the variable is set
 * (an explicit shared root says where docs live), the two defaults coincide, or no doc is there.
 * Pure over its inputs so the CLI prints it once and the tests exercise it on a scratch HOME.
 */
export function legacyHomeDocsNotice(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  stateHome: string = crewStateHome(),
): string | null {
  const shared = env[ROOT_ENV];
  if (typeof shared === 'string' && shared.trim() !== '') return null;
  const legacy = legacyHomeDocsRoot(home);
  const current = defaultInteractiveRoot(stateHome);
  if (resolve(legacy) === resolve(current)) return null;
  let count = countDocDirs(legacy);
  try {
    for (const e of readdirSync(join(legacy, PROJECTS_DIR), { withFileTypes: true })) {
      if (e.isDirectory()) count += countDocDirs(join(legacy, PROJECTS_DIR, e.name));
    }
  } catch {
    /* no partitions there */
  }
  if (count === 0) return null;
  return (
    `${count} interactive document${count === 1 ? '' : 's'} found under ${legacy} — the pre-0.7.35 default docs root. ` +
    `The default is now ${current} (one per daemon state home) and existing documents are NOT moved. ` +
    `To keep serving them, set ${ROOT_ENV}=${legacy} or bind a project's interactiveRoot to that directory.`
  );
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
export function partitionedInteractiveRoot(projectId: string, stateHome: string = crewStateHome()): string {
  if (!PARTITION_SEGMENT.test(projectId)) {
    throw new Error(`project id ${JSON.stringify(projectId)} cannot name an interactive docs partition`);
  }
  return resolve(partitionsBase(stateHome), projectId);
}

/** The directory holding every partition: `<default root>/projects`. */
export function partitionsBase(stateHome: string = crewStateHome()): string {
  return resolve(defaultInteractiveRoot(stateHome), PROJECTS_DIR);
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
export function preparePartitionedInteractiveRoot(projectId: string, stateHome: string = crewStateHome()): string {
  return containPartitionedInteractiveRoot(projectId, stateHome, true);
}

/**
 * The SAME containment check WITHOUT materialization (crew#474, Copilot) — for a caller that only
 * reads what is already there: the interactive event seams (`server.ts` `interactiveDocsRoot`),
 * which `readDocHead` a manifest under a root the routes materialized, or install a demo spec
 * into a doc workspace that must already exist. Every component that EXISTS under the base is
 * judged exactly as `preparePartitionedInteractiveRoot` judges it — a symbolic link or a
 * non-directory refuses, an existing partition must realpath-resolve inside the base — and a
 * component that does not exist ends the walk: nothing sits there to be followed, and a reader
 * creates nothing (an event naming a project that never had a partition must not mint one).
 * Returns the lexical path either way.
 */
export function checkPartitionedInteractiveRoot(projectId: string, stateHome: string = crewStateHome()): string {
  return containPartitionedInteractiveRoot(projectId, stateHome, false);
}

/**
 * The ONE containment walk both entry points above run — `materialize` is the only difference
 * (create a missing component vs. stop at it). Kept single on purpose: the routes and the event
 * seams must agree on what `projects/<id>` may be, or a link the routes refuse is still followed
 * through the seam path (the gap Copilot found on #474).
 */
function containPartitionedInteractiveRoot(projectId: string, stateHome: string, materialize: boolean): string {
  const partition = partitionedInteractiveRoot(projectId, stateHome);
  const base = partitionsBase(stateHome);
  if (materialize) {
    mkdirSync(base, { recursive: true });
  } else if (lstatOrNull(base) === null) {
    return partition; // no base yet ⇒ no partition ⇒ nothing on disk a link could redirect
  }
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
      if (!materialize) return partition; // absent: nothing to follow, and a reader mints nothing
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
 *
 * Two injectable homes, deliberately distinct: `stateHome` places the DEFAULT (and the
 * partitions under it); `home` only expands a leading `~` in an EXPLICIT setting.
 */
export function resolveInteractiveRoot(
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  stateHome: string = crewStateHome(),
  home: string = homedir(),
): string {
  return explicitInteractiveRoot(setting, env, home) ?? defaultInteractiveRoot(stateHome);
}

/**
 * The resolved, canonical docs root for a PROJECT (crew#472). Precedence: the project's own
 * `interactiveRoot` › `WICKED_INTERACTIVE_ROOT` › the project's default — the legacy shared root
 * for `default` (and for an unknown project identity, `undefined`: an event that carries no
 * `project_id` belongs to Unfiled), the `projects/<projectId>` partition for everything else.
 *
 * The partition is containment-checked on REAL paths (crew#474): whatever already sits at
 * `projects/<projectId>` — or on the way to it — must be a real directory whose real path is
 * inside `projects/`, else `InteractivePartitionRefusedError`; a partition that does not exist
 * yet is returned as its lexical path and NOTHING is created (`checkPartitionedInteractiveRoot`).
 * This is the event seams' resolver (`server.ts` `interactiveDocsRoot`): they read manifests
 * under a root the routes materialized, and a lexical-only answer here was the one path left on
 * which a symlinked partition would still have been followed (Copilot on #474).
 */
export function resolveProjectInteractiveRoot(
  projectId: string | undefined,
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  stateHome: string = crewStateHome(),
  home: string = homedir(),
): string {
  return resolveProjectRootWith(checkPartitionedInteractiveRoot, projectId, setting, env, stateHome, home);
}

/**
 * `resolveProjectInteractiveRoot` for a caller about to USE the root and entitled to create it —
 * the routes, through `project-root.ts`. Same precedence, the SAME containment walk; the one
 * difference is that a missing partition is materialized (`preparePartitionedInteractiveRoot`)
 * instead of merely spelled. An explicit root and the `default` project's legacy root are
 * returned untouched by both resolvers — an operator's own directory is theirs to place, behind
 * a link or not (§7.2) — so those two never cost a disk access.
 */
export function ensureProjectInteractiveRoot(
  projectId: string | undefined,
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined> = process.env,
  stateHome: string = crewStateHome(),
  home: string = homedir(),
): string {
  return resolveProjectRootWith(preparePartitionedInteractiveRoot, projectId, setting, env, stateHome, home);
}

/** The one precedence rule, parameterized by how a partition is produced (spelled vs. prepared). */
function resolveProjectRootWith(
  partition: (projectId: string, stateHome: string) => string,
  projectId: string | undefined,
  setting: InteractiveRootSetting | null | undefined,
  env: Record<string, string | undefined>,
  stateHome: string,
  home: string,
): string {
  const explicit = explicitInteractiveRoot(setting, env, home);
  if (explicit !== null) return explicit;
  if (projectId === undefined || projectId === DEFAULT_PROJECT_ID) return defaultInteractiveRoot(stateHome);
  return partition(projectId, stateHome);
}
