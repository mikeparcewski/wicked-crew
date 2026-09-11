/**
 * The daemon-owned skills root (design v3 DECISIONS 1/4/5/6/7): ONE effective garden-shaped plugin
 * root the operator edits like a filesystem, PUBLISHED as immutable snapshots the engine hands to
 * every worker. Nothing a worker runs is ever read from `effective/`.
 *
 * # Layout — `<root>/` (`<crewStateHome()>/skills` by default; never a `~/.wicked-crew` literal —
 * the ONE storage root every crew store shares, design v3.1 §1; the worker Read fence is core's
 * explicit denylist of state-home subtrees — `skills/baseline/`, `skills/effective/`,
 * `skills/manifest.json`, `skills/current`, … — with the resolved `skills/snapshots/<gen>/` the
 * only non-denied path; `tests/fixtures/state-home-subtrees.json` is the shared registry)
 *
 *   manifest.json              the state (`SkillManifest`; presence = seeded), CAS `revision`
 *   baseline/<contentHash>/    the shipped bundle (dependency closure, bundle.ts) — identity is the
 *                              content hash of the bundle, never the version string alone; `.venv`
 *                              is provisioned here once per hash (venv.ts) and shared READ-ONLY;
 *                              a baseline lives as long as ANY snapshot on disk references it
 *   effective/                 the same shape, holding what the operator edits: EVERY skill, enabled
 *                              or not (enablement is manifest state, orthogonal to content)
 *   snapshots/<gen>/           immutable published trees, LOCKED read-only at publish: enabled
 *                              skills only, nested layout verbatim, support closure, `snapshot.json`,
 *                              `.venv -> baseline venv` (only when that env exists), and the
 *                              generated delivery VIEWS (below)
 *   snapshots/<gen>/views/copilot/.github/skills/<name>/
 *                              the copilot view (design v3.2 §2/§4): a copy of every enabled
 *                              PORTABLE skill's own files under its frontmatter name — what core
 *                              hands a copilot seat as `--add-dir <snapshot>/views/copilot`.
 *                              Generated at publish, part of the content hash, never edited. The
 *                              ONLY view today; `portable` is the admission key for every one.
 *   current -> snapshots/<gen> flipped atomically after each publish; the engine receives the
 *                              absolute REAL path of the generation as `WICKED_SKILLS_SNAPSHOT`
 *                              (engine-env.ts) — the ONLY input core reads (v3.1 §2)
 *   .uv-cache/                 the daemon's own uv cache (`UV_CACHE_DIR`), never the operator's
 *
 * NOTHING under this root is ever written into the user's own CLI directories — `~/.codex`,
 * `~/.pi`, `~/.copilot`, `~/.config/opencode`, `~/.claude` are never touched (design v3.2 §1; the
 * v3 additive mirror is withdrawn). Skills reach workers only through per-launch, wicked-owned
 * delivery core performs from the snapshot (Claude: the plugin root; pi: `--skill` per portable
 * skill; copilot: `--add-dir <snapshot>/views/copilot`). A CLI without a lever (codex today) runs
 * WITHOUT wicked skills, and a unit on such a seat that requires one (`skill_ref` / mandate) is
 * REFUSED at launch by core — there is no proceed-with-disclosure setting and never a side channel.
 *
 * # Identity, ownership, hashes
 *
 * A skill is a directory holding `SKILL.md`, keyed by the PATH-DERIVED name
 * `wicked-garden-<dir segments joined by '-'>` — which the live plugin's frontmatter `name` equals
 * for all 142 (unique). A declared name that differs is a `name-mismatch` finding, blocking at
 * publish; a declared name that is ANOTHER catalog skill's key is a `name-collision`, blocking
 * whether or not the declaring skill is enabled: the manifest key, the directory, and the
 * invocation identity are one thing. A skill's OWN files are everything under its dir except a
 * nested skill's subtree — the deepest `SKILL.md` ancestor ON DISK owns a path (v3 §6; codex round
 * 2: ownership follows the filesystem, not the manifest, so a child created by a direct edit is
 * still nobody else's), so disabling/resetting/replacing a parent never touches a child, and the
 * file API refuses a child's path through the parent's endpoint. Every managed file carries
 * `{baselineHash, effectiveHash, lastPublishedHash}`; provenance is derived from them, never
 * asserted. Every mutation takes `expectedRevision` (CAS) and bumps `revision`; direct filesystem
 * edits are detected by hash at publish and REPORTED (`fs-drift`), never silently trusted.
 *
 * # Containment (no-follow everywhere, the root included)
 *
 * Every path the store reads or writes — a write's DESTINATION (replace/add descendants included),
 * a baseline READ (reset, the `?side=baseline` copy, every baseline hash lookup) — is lstat-walked
 * FROM THE SKILLS ROOT (`effective/…`, `baseline/<hash>/…`), so a skill directory replaced by a
 * symlink, a symlinked child inside it, or a symlinked baseline ancestor is refused, never
 * followed (contain.ts / tree.ts). The ROOT ITSELF is checked before EVERY read and mutation
 * (`assertRootIdentity`, codex round 4): it must be a real directory, never a symlink, whose
 * canonical path is the one the store bound at boot — a root replaced by a link to a copied store
 * (or an ancestor swapped under the daemon) refuses every operation (`SkillsRootInvalidError`, a
 * loud 503), never redirects one. Every PERSISTED name is validated at manifest parse — a skill
 * `dir`, a baseline hash, a file-record key, and the skill KEY itself (a safe single segment that
 * IS the path-derived name of its `dir`; the copilot view lays a skill out under its key) — and
 * `copyFiles` re-checks every destination's shape and walk before the first byte moves. A
 * path-guard failure on a WRITE answers the normal 2xx `{verdict: 'blocked', findings:
 * [path-invalid]}` envelope, never a 400 — a refresh included: it preflights every destination,
 * stages under the root and swaps, so a refused destination changes NOTHING. Names the store itself
 * owns at the snapshot/root level (`snapshot.json`, `manifest.json`, `current`, `views/`, `.venv`)
 * are refused as support paths.
 *
 * # Publish (serialized, root-bound, crash-safe, idempotent on retry)
 *
 * ONE publish at a time (a second concurrent request is refused, `SkillsPublishInFlightError`; the
 * route answers it as a 2xx `blocked` `publish-in-flight` envelope — nothing was written, so it is
 * not a 409, codex round 3). The operation binds the root's identity (path + realpath) at start and
 * re-checks it after every await: a root whose canonical path moved or vanished while the baseline
 * env was provisioning aborts the publish (`SkillsRootChangedError` → the 2xx `blocked`
 * `root-changed` envelope) — nothing is written through a root the operation did not validate. (The
 * root is never re-aimed: `<state home>/skills`, full stop — root-fence.ts; there is no `skills_root`
 * setting and no env override, codex round 5.) Provisions the
 * baseline's `.venv` (awaited; one provisioning per baseline
 * hash — a concurrent caller awaits the in-flight one; a snapshot never links an env still being
 * written; a FAILED provisioning is BLOCKING, `venv-failed` — the shared env is required, not
 * best-effort), re-checks the CAS, validates the WHOLE tree — frontmatter (strict subset), name ==
 * path, no cross-catalog name collision, the core closure COMPLETE (a missing registered ref or an
 * absent transitive mandate is BLOCKING), every `${CLAUDE_PLUGIN_ROOT}/<p>` and `../<p>` reference
 * of an enabled skill judged by TARGET (one that ESCAPES the plugin root is BLOCKING; one whose
 * target is MISSING inside it is a WARNING — design v3.4 §1: an upstream content bug publishes as
 * found, `verdict: 'warnings'`), every support file INSIDE the bundle closure (a file outside the
 * ONE allowlist — bundle.ts `inBundleClosure` — is BLOCKING, `outside-closure`), the plugin manifest
 * naming the plugin and the `.claude-plugin/*` catalogs present AND well-formed, no unregistered
 * `SKILL.md` — then: allocates the generation from the FILESYSTEM (max existing + 1), writes
 * `snapshots/.staging-<random>/` (the snapshot files + the generated views), renames it to
 * `snapshots/<gen>/` (never over an existing generation), LOCKS it read-only, commits the manifest
 * (the venv state included — nothing is persisted before validation passes), and only THEN flips
 * `current`. A crash between the commit and the flip is finished at the next boot (`ensureReady`);
 * a torn staging dir is swept by the next publish. Generations beyond the newest three that no
 * LIVE run may still be reading are reaped (`live`, fed from the CoreEvent stream AND from the
 * daemon's own launch handoffs — live-generations.ts: a generation handed to a launch stays pinned
 * until the engine reports what that launch used or the run ends, never released by publish
 * count), and a baseline is removed only once no generation on disk references it.
 * `analyze` is the same validation as a PURE dry run: it persists nothing and moves no revision; a
 * `blocked` publish persists nothing either — not the drift it observed, not the provisioning state.
 *
 * # `current` is never trusted — for the daemon's whole lifetime
 *
 * `currentSnapshot()` realpaths the link, requires the target to be a generation directory directly
 * under `snapshots/`, requires a well-formed `snapshot.json` whose `gen` matches the directory and
 * whose skill rows are safe relative `skills/…` dirs with the path-derived name, and re-hashes the
 * tree against `contentHash` before it exports the path or reads the metadata — on EVERY call
 * (codex round 2: a verification cached by link text was ineffective after its first success; a
 * snapshot modified under a running daemon is refused by the same store instance). Any failure is
 * `SkillsCurrentInvalidError` — a loud config error, never a silent "not published".
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';

import { NotARegularFileError, readFileCapped } from '../api/run-files.js';
import { crewStateHome } from '../projects/state-home.js';
import type {
  CoreEvent,
  SkillAnalyzeResult,
  SkillBaselineRecord,
  SkillConflictFinding,
  SkillEntry,
  SkillFileRecord,
  SkillFileTree,
  SkillKind,
  SkillManifest,
  SkillMutationResult,
  SkillPortability,
  SkillProvenance,
  SkillPublishResult,
  SkillReadResult,
  SkillRefreshResult,
  SkillSourceKind,
  SkillVenvState,
} from '../core/types.js';
import {
  BUNDLE_CLOSURE_SPELLING,
  inBundleClosure,
  NotAPluginRootError,
  owningSkillDir,
  pluginBundleFiles,
  REQUIRED_PLUGIN_CATALOGS,
  skillDirsOf,
  SKILLS_SUBDIR,
} from './bundle.js';
import { containedPath, SkillPathError, validateRelSegments } from './contain.js';
import { coreClosure } from './core-closure.js';
import { derivedSkillName, parseFrontmatter, PLUGIN_NAME, SKILL_NAME_PREFIX, skillKindOf } from './frontmatter.js';
import {
  collisionGuard,
  coreDisableGuard,
  finding,
  frontmatterGuard,
  nameGuard,
  nestedSkillCreateGuard,
  noBaselineGuard,
  nonPortableGuard,
  SKILL_NAME_RE,
  supportFileGuard,
  verdictOf,
  type CatalogView,
} from './guards.js';
import { LiveGenerations } from './live-generations.js';
import { discoverLivePluginDetailed, gitStateOf, PluginSourceSymlinkError, type PluginSource } from './plugin-source.js';
import {
  existsIn,
  extractPluginRootRefs,
  extractRelativeRefs,
  looksBinary,
  PORTABILITY_EVIDENCE_CAP,
  PORTABILITY_REASONS,
  portabilityEvidenceOf,
  portabilityIssuesOf,
  portabilityReasonsOf,
  resolvePluginRootRef,
  resolveRelativeRef,
  type PortabilityContext,
  type PortabilityHit,
} from './refs.js';
import { CURRENT_TMP_PREFIX, STAGING_PREFIX } from './root-names.js';
import {
  assertNoSymlinkComponents,
  copyFiles,
  EntrySwappedError,
  hashFileSet,
  hashTree,
  impliedDirs,
  isCarriedFile,
  makeTreeReadOnly,
  pruneEmptyDirs,
  readFileNoFollow,
  removeTreeForce,
  sha256Hex,
  SKIP_DIR_NAMES,
  SymlinkComponentError,
  walkEntries,
  walkFiles,
  walkTree,
  writeFileAtomic,
  type FileRecord,
  type LinkRecord,
  type TreeEntry,
  type TreeListing,
} from './tree.js';

/** The root-level names the store creates live in ONE table (`root-names.ts`, design v3.5 §2) — re-exported for the tests that observe the flip. */
export { CURRENT_TMP_PREFIX } from './root-names.js';
import { baselineVenvDir, UV_CACHE_DIRNAME, VENV_READY_MARKER, type VenvProvisioner } from './venv.js';

/** The root's name under the daemon state home — a top-level entry `tests/fixtures/state-home-subtrees.json` registers. */
export const SKILLS_DIRNAME = 'skills';
export const MANIFEST_FILENAME = 'manifest.json';
export const EFFECTIVE_DIRNAME = 'effective';
export const BASELINE_DIRNAME = 'baseline';
export const SNAPSHOTS_DIRNAME = 'snapshots';
export const CURRENT_LINKNAME = 'current';
export const SNAPSHOT_MANIFEST_FILENAME = 'snapshot.json';
/** The generated delivery views inside a snapshot (design v3.2 §4). */
export const VIEWS_DIRNAME = 'views';
/** The copilot view root inside a snapshot — what core passes as `--add-dir`. */
export const COPILOT_VIEW_REL = `${VIEWS_DIRNAME}/copilot`;
/** Where the copilot view lays its skills out: copilot loads `.github/skills/<name>/SKILL.md` from an added dir. */
export const COPILOT_VIEW_SKILLS_REL = `${COPILOT_VIEW_REL}/.github/skills`;
/** The `.venv` link name inside a snapshot (the shared per-baseline env). */
const VENV_LINKNAME = '.venv';
/**
 * Root-level names the store itself owns — refused as support paths (codex round 2: a support
 * file named `snapshot.json` published `clear` and then failed `current` verification because
 * publish overwrote it with the generated metadata).
 */
export const RESERVED_SUPPORT_NAMES: ReadonlySet<string> = new Set([
  SNAPSHOT_MANIFEST_FILENAME,
  MANIFEST_FILENAME,
  CURRENT_LINKNAME,
  VIEWS_DIRNAME,
  VENV_LINKNAME,
]);
export const MANIFEST_VERSION = 2;
/** Generations kept after a publish (the newest `current` included) — older ones are reaped. */
export const KEEP_GENERATIONS = 3;
/** The `.claude-plugin/plugin.json` every snapshot must carry with the plugin's own name. */
const PLUGIN_JSON_REL = '.claude-plugin/plugin.json';
/** Drift findings name at most this many paths — the count carries the rest. */
const DRIFT_LIST_CAP = 12;
// `STAGING_PREFIX` (a half-written directory — a torn publish / seed / refresh — swept at the next
// pass) and `CURRENT_TMP_PREFIX` (the transient `current` link while it is being flipped — created
// INSIDE `snapshots/`, a name core's fence classifies, renamed over `skills/current`) come from
// `root-names.ts`: the ONE table of every name the store creates under the root (design v3.5 §2).

/**
 * Where the root lives: `<state home>/skills` — full stop (design v3.1 §1: the same storage root as
 * every other crew store; v3.2 §1: never a user CLI directory). There is no setting and no env
 * override (codex round 5 on #480: a configurable root let seeding write into `~/.codex/skills`);
 * the daemon's state home is the ONE knob (`--db`), and the boot asserts the resolved root stays
 * fenced (root-fence.ts). Tests redirect the state home, never the root.
 */
export function resolveSkillsRoot(): string {
  return join(crewStateHome(), SKILLS_DIRNAME);
}

/** The root has no manifest: nothing was seeded (no installed plugin, or the seed is not armed). */
export class SkillsUnseededError extends Error {
  constructor(readonly root: string) {
    super(
      `skills root ${root} is not seeded — no manifest.json. The daemon seeds it at boot from the live ` +
        `installed wicked-garden plugin; install the plugin (or set WICKED_CREW_SKILLS_SOURCE) and restart`,
    );
    this.name = 'SkillsUnseededError';
  }
}

/** No plugin source could be found to seed or refresh from — crew does not vendor garden (v3 §8; the discovery order is design v3.6, plugin-source.ts). */
export class SkillsSourceUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `no wicked-garden plugin source: ${detail} — install wicked-garden first — \`npx wicked-installer install wicked-garden\`, or register the plugin with Claude Code`,
    );
    this.name = 'SkillsSourceUnavailableError';
  }
}

/** `manifest.json` exists but is not a manifest — refused loudly, never blanked (it holds enablement). */
export class SkillsManifestCorruptError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path} is not a skills manifest (${detail}) — fix or remove it; it is not rewritten from a blank state because it records which skills are enabled`);
    this.name = 'SkillsManifestCorruptError';
  }
}

/**
 * `current` exists but does not point at a valid published generation — a loud config error. The
 * store never exports or reads through a link it could not verify (design v3 §3: "explicit path
 * invalid → fails loudly").
 */
export class SkillsCurrentInvalidError extends Error {
  constructor(readonly link: string, detail: string) {
    super(`${link} does not point at a valid published snapshot: ${detail} — re-publish (POST /skills/publish) or remove the link`);
    this.name = 'SkillsCurrentInvalidError';
  }
}

/** A publish could not land its generation directory without destroying an existing one, or could not lock it. */
export class SkillsPublishError extends Error {
  constructor(detail: string) {
    super(`publish refused: ${detail}`);
    this.name = 'SkillsPublishError';
  }
}

/** A publish is already in flight — one at a time. The route answers a 2xx `blocked`
 *  `publish-in-flight` envelope (nothing was written), never a 409 (codex round 3). */
export class SkillsPublishInFlightError extends Error {
  constructor(readonly revision: number) {
    super('publish refused: another publish is in flight — one publish runs at a time; wait for it and retry against the revision it answers');
    this.name = 'SkillsPublishInFlightError';
  }
}

/** The skills root changed identity (its canonical path moved, or it vanished) while a publish was
 *  awaiting its baseline env — the operation is aborted, nothing was written. The route answers a
 *  2xx `blocked` `root-changed` envelope, not a 409 (codex round 3). */
export class SkillsRootChangedError extends Error {
  constructor(
    readonly root: string,
    detail: string,
    readonly revision: number,
  ) {
    super(`publish aborted: the skills root ${root} ${detail} while the baseline environment was being provisioned — nothing was published; re-read GET /skills and retry`);
    this.name = 'SkillsRootChangedError';
  }
}

/**
 * The skills root ITSELF is not the directory the store bound: a symlink stands in for it, it is
 * not a directory, or its canonical path moved under the running daemon. Every read and mutation
 * is refused (a loud 503 on the routes, `skills.config` at boot) — nothing is ever read or written
 * through it (codex round 4).
 */
export class SkillsRootInvalidError extends Error {
  constructor(
    readonly root: string,
    detail: string,
  ) {
    super(`skills root ${root} is not usable: ${detail} — every read and mutation is refused; restore the directory under the daemon state home and restart`);
    this.name = 'SkillsRootInvalidError';
  }
}

/**
 * A `baseline/<hash>` on disk does not hash to `<hash>` (a bundle file modified, planted or removed,
 * a symlink inside) — content-addressed baselines are verified before EVERY reuse (codex round 7):
 * a refresh refuses to reuse it (its 2xx `blocked` `baseline-corrupt` envelope, nothing copied),
 * reset refuses to restore from it, publish/analyze report it blocking; only the seed re-captures.
 */
export class SkillsBaselineCorruptError extends Error {
  constructor(
    readonly dir: string,
    detail: string,
  ) {
    super(`baseline ${dir} is corrupt: ${detail} — its content does not hash to its name; nothing was copied from it`);
    this.name = 'SkillsBaselineCorruptError';
  }
}

/**
 * A content swap that LANDED under `effective/` with its parked originals still under staging:
 * `rollback` puts everything back byte for byte, `dispose` removes the staging. `commitSwap` drives
 * it — the content and the manifest move together or not at all (codex round 7).
 */
interface SwapHandle {
  rollback: () => void;
  dispose: () => void;
}

export class UnknownSkillError extends Error {
  constructor(readonly skillName: string) {
    super(`unknown skill: ${skillName}`);
    this.name = 'UnknownSkillError';
  }
}

/** The caller's `expectedRevision` is stale — the 409 of every mutation. */
export class RevisionMismatchError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`revision mismatch: expected ${expected}, the manifest is at ${actual} — re-read GET /skills and retry`);
    this.name = 'RevisionMismatchError';
  }
}

/** Which copy of a file a read addresses. */
export type ReadSide = 'effective' | 'baseline';

/** One skill row of `snapshot.json` — what core checks a seat's invocability against (v3.1 §5). */
export interface SnapshotSkillRow {
  name: string;
  /** Plugin-relative dir, nested layout verbatim. */
  dir: string;
  kind: SkillKind;
  core: boolean;
  /** REQUIRED boolean: non-Claude seats may only invoke portable skills. */
  portable: boolean;
  /** Per-reason portability (F-079): `portable` again, the sorted unique reasons, up to five
   *  `file:line` anchors. Written by every publish since 0.7.30; absent on older generations
   *  (verify then re-derives `portable` alone). Core ignores it (`portable` is its admission key). */
  portability?: SkillPortability;
  /** `true` when the dir is not directly under `skills/` — Claude Code discovers top-level skill dirs
   *  only, so a nested skill is not invocable for a Claude seat (core enforces; crew just says so). */
  nested: boolean;
}

/**
 * Why `value` is not a well-formed `SkillPortability` for a row whose `portable` is `portable` —
 * or `null` when it is: an object whose `portable` repeats the row's, whose `reasons` is a
 * strictly sorted, unique list of known tokens (empty exactly when portable), and whose optional
 * `evidence` is at most five strings. Shared by the manifest parse and the snapshot-row check.
 */
function portabilityProblem(value: unknown, portable: boolean): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'is not an object';
  const p = value as Record<string, unknown>;
  for (const k of Object.keys(p)) if (!['portable', 'reasons', 'evidence'].includes(k)) return `carries an unknown key ${JSON.stringify(k)}`;
  if (p['portable'] !== portable) return `.portable is ${JSON.stringify(p['portable'])}, not the row's ${String(portable)}`;
  const reasons = p['reasons'];
  if (!Array.isArray(reasons)) return '.reasons is not an array';
  for (let i = 0; i < reasons.length; i += 1) {
    const r: unknown = reasons[i];
    if (typeof r !== 'string' || !PORTABILITY_REASONS.has(r)) return `.reasons[${i}] is ${JSON.stringify(r)}, not a known reason (${[...PORTABILITY_REASONS].join('|')})`;
    if (i > 0 && !((reasons[i - 1] as string) < r)) return '.reasons is not sorted and unique';
  }
  if ((reasons.length === 0) !== portable) return `.reasons is ${reasons.length === 0 ? 'empty' : 'non-empty'} but the row is ${portable ? 'portable' : 'not portable'}`;
  if (Object.hasOwn(p, 'evidence')) {
    const ev = p['evidence'];
    if (!Array.isArray(ev) || ev.some((e) => typeof e !== 'string')) return '.evidence is not an array of strings';
    if (ev.length > PORTABILITY_EVIDENCE_CAP) return `.evidence carries ${ev.length} anchors (cap ${PORTABILITY_EVIDENCE_CAP})`;
  }
  return null;
}

/** Two string lists, equal element for element. */
function sameStrings(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** One generated delivery view inside a snapshot: its root (snapshot-relative) and the skills it carries. */
export interface SnapshotView {
  /** Snapshot-relative dir core hands the CLI (`views/copilot` → `--add-dir <snapshot>/views/copilot`). */
  dir: string;
  /** Frontmatter names of the enabled, PORTABLE skills laid out in the view, sorted. */
  skills: string[];
}

/** `snapshot.json` inside every published generation — what the engine reads (never a parent dir). */
export interface SnapshotManifest {
  gen: number;
  contentHash: string;
  gardenSource: { kind: SkillSourceKind; path: string; plugin_version: string; baseline: string };
  /** The baseline env's state at publish: `synced` ⇒ `.venv` links it; `skipped` ⇒ no link (nothing to provision). */
  venv: SkillVenvState;
  skills: SnapshotSkillRow[];
  /** The generated delivery views (design v3.2 §4) — today only `copilot`. */
  views: { copilot: SnapshotView };
}

/**
 * A skill row is `{name, dir}` + a boolean `portable` (the seat-compatibility fact core requires),
 * and — codex round 2: metadata is never trusted to name paths — `name` is a legal skill name,
 * `dir` a safe relative `skills/<…>` path (no `..`, no absolute, no empty segment, no separator
 * but the nested `/`) whose path-derived name IS `name`. A row that fails this cannot address any
 * file of the snapshot it sits in.
 */
function isSnapshotSkillRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Partial<SnapshotSkillRow>;
  if (typeof r.name !== 'string' || !SKILL_NAME_RE.test(r.name) || !r.name.startsWith(SKILL_NAME_PREFIX)) return false;
  if (typeof r.dir !== 'string' || typeof r.portable !== 'boolean') return false;
  // `portability` (F-079) is optional — older generations lack it — but when present it must be
  // well-formed and agree with `portable`; its reasons are re-derived at verify (`snapshotRowsProblem`).
  if (Object.hasOwn(r, 'portability') && portabilityProblem(r.portability, r.portable) !== null) return false;
  // EVERY field is typed (codex round 7): `kind` an enum, `core` / `nested` real booleans — and
  // `nested` IS the fact the dir spells, a row cannot claim otherwise. `kind` and `portable` are
  // re-derived from the generation's own files at verify (`snapshotRowsProblem`); `core` is
  // authenticated by the manifest's metadata hash.
  if (!SKILL_KINDS.has(String(r.kind)) || typeof r.core !== 'boolean' || typeof r.nested !== 'boolean') return false;
  let segments: string[];
  try {
    segments = validateRelSegments(r.dir);
  } catch {
    return false;
  }
  if (segments.length < 2 || segments[0] !== SKILLS_SUBDIR) return false;
  if (r.nested !== isNestedSkillDir(r.dir)) return false;
  return derivedSkillName(segments.slice(1).join('/')) === r.name;
}

/** Rows sorted by name and unique — the order publish writes; a reordered or duplicated row is not publish's metadata. */
function isSortedUniqueRows(rows: ReadonlyArray<SnapshotSkillRow>): boolean {
  for (let i = 1; i < rows.length; i += 1) {
    if (!((rows[i - 1] as SnapshotSkillRow).name < (rows[i] as SnapshotSkillRow).name)) return false;
  }
  return true;
}

/**
 * The `views` block: exactly the copilot view at its fixed dir, naming EXACTLY the sorted set of the
 * portable rows — no subset, no extra (codex round 7: a subset used to pass, so a view that dropped
 * a portable skill or claimed one verified).
 */
function isSnapshotViews(views: unknown, rows: ReadonlyArray<SnapshotSkillRow>): boolean {
  if (typeof views !== 'object' || views === null) return false;
  const copilot = (views as { copilot?: Partial<SnapshotView> }).copilot;
  if (typeof copilot !== 'object' || copilot === null) return false;
  if (copilot.dir !== COPILOT_VIEW_REL || !Array.isArray(copilot.skills)) return false;
  const portable = rows.filter((r) => r.portable).map((r) => r.name).sort();
  return copilot.skills.length === portable.length && copilot.skills.every((n, i) => n === portable[i]);
}

/** Whether a skill dir is nested: anything deeper than `skills/<dir>`. */
export function isNestedSkillDir(dir: string): boolean {
  return dir.slice(`${SKILLS_SUBDIR}/`.length).includes('/');
}

export interface SeedResult {
  /** `false` when the root was already seeded (idempotent no-op). */
  seeded: boolean;
  baseline: string | null;
  source: PluginSource | null;
}

export interface SkillsStoreOptions {
  root: string;
  /** Every `skill_ref` of every workflow the daemon knows — the seeds of the core closure. Read at use time. */
  registeredSkillRefs: () => ReadonlySet<string>;
  /** Per-baseline `uv sync` (venv.ts), AWAITED by publish. Tests pass `noVenv`; the daemon passes `uvSyncBaseline`. */
  provisionVenv: VenvProvisioner;
  /** Plugin-source discovery; defaults to the installed plugin (plugin-source.ts, design v3.6), whose discovery findings the default logs through `warn`. */
  source?: () => PluginSource | null;
  /** Clock, ISO-8601 (tests pin it). */
  now?: () => string;
  warn?: (message: string) => void;
}

/** One scanned file: plugin-relative path, on-disk path, content digest. */
interface ScannedFile {
  rel: string;
  abs: string;
  sha: string;
}

/**
 * The classified `effective/` tree (codex round 9): the carried files hashed, plus every entry the
 * validation must refuse or see — symlinks (there is NO permitted link under `effective/`), special
 * nodes, and every carried directory (empty ones included: nothing is invisible to the walk).
 * `links` and `others` INCLUDE the entries beneath a pruned directory (`.venv`, `node_modules`,
 * `__pycache__`; `TreeEntry.pruned` names it — codex round 10): such a subtree is never copied or
 * hashed, which is exactly why what it holds must be judged rather than skipped. `files` and `dirs`
 * exclude it, as every copy and hash view does.
 */
interface EffectiveScan {
  files: ScannedFile[];
  links: TreeEntry[];
  others: TreeEntry[];
  dirs: string[];
}

/** The whole-tree validation's answer: findings + the snapshot file set when not blocked. */
interface Validation {
  findings: SkillConflictFinding[];
  snapshotFiles: FileRecord[];
  enabledSkills: Array<{ name: string; entry: SkillEntry }>;
}

function compact<T>(items: ReadonlyArray<T | null>): T[] {
  return items.filter((x): x is T => x !== null);
}

function sortedRels<T extends { rel: string }>(items: T[]): T[] {
  return items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** `lstat`, or `null` when nothing can stand at `path` — it does not exist (ENOENT) or a parent is a regular file (ENOTDIR). */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/** The dir a user-added skill lands at: always top-level (`skills/<name minus the prefix>`). */
export function dirForUserSkill(name: string): string {
  return `${SKILLS_SUBDIR}/${name.slice(SKILL_NAME_PREFIX.length)}`;
}

/** Zero-padded so a lexical listing of `snapshots/` is the generation order. */
export function generationDirName(gen: number): string {
  return String(gen).padStart(6, '0');
}
const GENERATION_DIR_RE = /^\d{6}$/;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
/** The persisted enums `snapshot.json` may carry — validated on read, never trusted as free text (codex round 6). */
const SOURCE_KINDS: ReadonlySet<string> = new Set<SkillSourceKind>(['claude-plugin-cache', 'installer-copy', 'checkout', 'directory']);
const VENV_STATES: ReadonlySet<string> = new Set<SkillVenvState>(['pending', 'synced', 'failed', 'skipped']);
/** The persisted enums `manifest.json` may carry — the schema validator refuses anything else (codex round 7). */
const SKILL_KINDS: ReadonlySet<string> = new Set<SkillKind>(['router', 'fork-worker', 'module']);
const PROVENANCES: ReadonlySet<string> = new Set<SkillProvenance>(['shipped', 'override', 'user-added']);
/** POSIX write bits — a locked env / snapshot carries none (mirrors tree.ts). */
const WRITE_BITS = 0o222;

/** The structural storage directories under the root a symlink must never stand in for. */
const STORAGE_CHILD_DIRS: ReadonlyArray<string> = [EFFECTIVE_DIRNAME, BASELINE_DIRNAME, SNAPSHOTS_DIRNAME];

/**
 * A safe relative `skills/<…>` dir: at least two segments, first `skills`, every segment a legal
 * path component (no `..`, no absolute/separator/NUL) — the shape a persisted skill `dir` must
 * have before the store ever joins it onto the root. Returns the reason it is unsafe, or `null`.
 */
function unsafeSkillDir(dir: unknown): string | null {
  if (typeof dir !== 'string') return `dir ${JSON.stringify(dir)} is not a string`;
  let segments: string[];
  try {
    segments = validateRelSegments(dir);
  } catch (err) {
    return err instanceof SkillPathError ? err.message : String(err);
  }
  if (segments.length < 2 || segments[0] !== SKILLS_SUBDIR) return `dir ${JSON.stringify(dir)} is not a nested skills/… path`;
  return null;
}

/** A safe persisted file-record path (plugin-relative, no traversal), or the reason it is not. */
function unsafeRecordPath(rel: unknown): string | null {
  if (typeof rel !== 'string') return `file path ${JSON.stringify(rel)} is not a string`;
  try {
    validateRelSegments(rel);
    return null;
  } catch (err) {
    return err instanceof SkillPathError ? err.message : String(err);
  }
}

export class SkillsStore {
  private rootDir: string;
  private readonly registeredRefs: () => ReadonlySet<string>;
  private readonly provisionVenv: VenvProvisioner;
  private readonly sourceFn: () => PluginSource | null;
  readonly now: () => string;
  private readonly warn: (message: string) => void;
  /** Generations live runs may still read — the reaper keeps them (fed by `observeEvent`). */
  readonly live = new LiveGenerations();
  /** The one publish that may run at a time (module header) — `null` when none is in flight. */
  private publishInFlight: Promise<SkillPublishResult> | null = null;
  /** One provisioning per baseline hash: a concurrent caller awaits the in-flight one. */
  private readonly venvInFlight = new Map<string, Promise<SkillVenvState>>();
  /** The canonical (realpath) identity of the root the store BOUND — recorded the first time the
   *  root is seen as a real directory (boot / seed), compared on every operation for the store's
   *  whole lifetime (the root is never re-aimed: a new root is a new store). */
  private boundRootReal: string | null = null;

  constructor(opts: SkillsStoreOptions) {
    this.rootDir = opts.root;
    this.registeredRefs = opts.registeredSkillRefs;
    this.provisionVenv = opts.provisionVenv;
    this.sourceFn =
      opts.source ??
      (() => {
        const { source, findings } = discoverLivePluginDetailed();
        for (const f of findings) this.warn(`[skills] skills.discovery ${f.kind}: ${f.message}`);
        return source;
      });
    this.now = opts.now ?? (() => new Date().toISOString());
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  // ── Paths ─────────────────────────────────────────────────────────────────────────────────

  get root(): string {
    return this.rootDir;
  }

  /** Whether a publish is running right now (diagnostics + tests). */
  isPublishing(): boolean {
    return this.publishInFlight !== null;
  }

  effectiveDir(): string {
    return join(this.rootDir, EFFECTIVE_DIRNAME);
  }

  baselineDir(hash: string): string {
    return join(this.rootDir, BASELINE_DIRNAME, hash);
  }

  snapshotsDir(): string {
    return join(this.rootDir, SNAPSHOTS_DIRNAME);
  }

  snapshotDir(gen: number): string {
    return join(this.snapshotsDir(), generationDirName(gen));
  }

  currentLink(): string {
    return join(this.rootDir, CURRENT_LINKNAME);
  }

  /** The daemon's uv cache (`UV_CACHE_DIR`) — a writable cache under the root, not the operator's. */
  uvCacheDir(): string {
    return join(this.rootDir, UV_CACHE_DIRNAME);
  }

  private manifestPath(): string {
    return join(this.rootDir, MANIFEST_FILENAME);
  }

  private pluginPath(rel: string, base: string = this.effectiveDir()): string {
    return join(base, ...rel.split('/'));
  }

  /** `effective/<dir>` after the lstat walk from the ROOT — the skill dir itself is a walked component. */
  private containedEffective(segments: ReadonlyArray<string>): string {
    this.assertRootIdentity();
    return containedPath(this.rootDir, [EFFECTIVE_DIRNAME, ...segments]);
  }

  private containedBaseline(hash: string, segments: ReadonlyArray<string>): string {
    this.assertRootIdentity();
    return containedPath(this.rootDir, [BASELINE_DIRNAME, hash, ...segments]);
  }

  /**
   * The skills root ITSELF must be a REAL directory whose canonical path is the one the store bound
   * at boot — checked before EVERY read and mutation, not only at publish (codex round 4: the
   * containment walk started BENEATH the root, so a root replaced by a symlink to a copied store
   * after boot redirected file reads, writes and manifest commits outside the configured root).
   * Refuses a symlink standing in for the root, a non-directory, and a root whose realpath moved (an
   * ancestor replaced under the running daemon). A root that does not exist yet is not refused —
   * there is nothing to redirect through; `manifest()` reports it unseeded and the seed binds it
   * once it has created it. Throws `SkillsRootInvalidError`.
   */
  private assertRootIdentity(): void {
    const root = this.rootDir;
    let st;
    try {
      st = lstatSync(root);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new SkillsRootInvalidError(root, 'a symlink stands in for the skills root — the store never follows links, the root included');
    if (!st.isDirectory()) throw new SkillsRootInvalidError(root, 'it is not a directory');
    const real = realpathSync(root);
    if (this.boundRootReal === null) {
      this.boundRootReal = real;
      return;
    }
    if (real !== this.boundRootReal) {
      throw new SkillsRootInvalidError(root, `its canonical path is now ${real} but the store bound ${this.boundRootReal} at boot — an ancestor was replaced under the running daemon`);
    }
  }

  /** A skill's dir must be reachable without crossing a link before anything walks or writes it. */
  private assertSkillDirContained(dir: string): void {
    this.containedEffective(dir.split('/'));
  }

  /**
   * The structural storage directories — the root itself and its `effective/`, `baseline/`,
   * `snapshots/` children — must be REAL directories, never symlinks (codex round 3). The
   * per-destination walk `copyFiles`/`writeFileAtomic` do starts BENEATH a staging dir, so a
   * `snapshots -> /outside` (or `baseline -> …`) redirect would take a publish, a baseline
   * capture, an env provisioning, a reap or a `current` verification outside the store before that
   * walk ever ran. Refuses a symlink at the `skills` component and each child (the operator's
   * state-home path ABOVE the root is theirs — only the store's own dirs are checked). Throws
   * `SymlinkComponentError`; callers map it to their own refusal.
   */
  private assertStorageAncestorsClean(): void {
    assertNoSymlinkComponents(dirname(this.rootDir), [basename(this.rootDir)]);
    for (const child of STORAGE_CHILD_DIRS) assertNoSymlinkComponents(this.rootDir, [child]);
  }

  // ── Manifest ──────────────────────────────────────────────────────────────────────────────

  isSeeded(): boolean {
    this.assertRootIdentity(); // never answered THROUGH a link standing in for the root
    // lstat, not exists (codex round 6): a `manifest.json` that is a SYMLINK counts as seeded, so the
    // seed never wipes `effective/` around it — and `manifest()` refuses it by name, never follows it.
    return lstatOrNull(this.manifestPath()) !== null;
  }

  /** The manifest, or `SkillsUnseededError` / `SkillsManifestCorruptError` / `SkillsRootInvalidError`. */
  manifest(): SkillManifest {
    this.assertRootIdentity(); // every read and mutation begins here — the root is checked first
    const path = this.manifestPath();
    // NO-FOLLOW (codex round 6): the manifest is lstat'ed before it is read — a symlink standing in
    // for `manifest.json` would route every catalog read (and every commit) through a file outside
    // the skills root; it is refused by name, never followed. A missing manifest is "unseeded".
    const st = lstatOrNull(path);
    if (st === null) throw new SkillsUnseededError(this.rootDir);
    if (st.isSymbolicLink()) {
      throw new SkillsManifestCorruptError(path, `${MANIFEST_FILENAME} is a symlink (-> ${readlinkSync(path)}) — the store never reads its state through a link`);
    }
    if (!st.isFile()) throw new SkillsManifestCorruptError(path, `${MANIFEST_FILENAME} is not a regular file`);
    const raw = readFileNoFollow(path).toString('utf8'); // O_NOFOLLOW + identity: the entry lstat judged is the one read (v3.5 §3)
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SkillsManifestCorruptError(path, err instanceof Error ? err.message : String(err));
    }
    return this.validateManifest(path, parsed);
  }

  /**
   * The COMPLETE runtime schema of `manifest.json` (codex round 7): every field is typed strictly
   * and ONE malformed field refuses the whole manifest — `manifest-invalid` →
   * `SkillsManifestCorruptError`, the routes' 503 and the daemon's `skills.config` — never a
   * truthiness fallback (`"enabled": "false"` used to load, and a `!== true` check read it as
   * disabled while `=== false` read it as enabled). Enums (`kind`, `provenance`, `source.kind`,
   * `venv`), hashes (64-hex, or `null` where allowed), integers (`revision` ≥ 0, `published.gen`
   * ≥ 1), strings, unknown or missing keys — all refused by name. Every PERSISTED path is validated
   * here too (codex rounds 3/4): a skill `dir`, a baseline identifier, a file-record key and the
   * skill KEY itself (a safe single segment that IS the path-derived name of its `dir` — the copilot
   * view lays a skill out under `views/copilot/.github/skills/<name>/`; the manifest key, the
   * directory and the invocation identity are one thing) — a manifest is disk state an attacker (or
   * a bad merge) can craft, never a path the store follows out of the root. The same validator runs
   * on every manifest the store is about to WRITE (`writeManifest`). The answer is a fresh object
   * holding exactly the validated fields.
   */
  private validateManifest(path: string, parsed: unknown): SkillManifest {
    const fail = (detail: string): never => {
      throw new SkillsManifestCorruptError(path, `manifest-invalid: ${detail}`);
    };
    const record = (value: unknown, where: string): Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(`${where} is not an object`);
    const exactKeys = (obj: Record<string, unknown>, keys: ReadonlyArray<string>, where: string, optional: ReadonlyArray<string> = []): void => {
      for (const k of keys) if (!(k in obj)) fail(`${where} lacks ${JSON.stringify(k)}`);
      for (const k of Object.keys(obj)) if (!keys.includes(k) && !optional.includes(k)) fail(`${where} carries an unknown key ${JSON.stringify(k)}`);
    };
    const bool = (value: unknown, where: string): boolean => (typeof value === 'boolean' ? value : fail(`${where} is ${JSON.stringify(value)}, not a boolean`));
    const str = (value: unknown, where: string): string => (typeof value === 'string' ? value : fail(`${where} is ${JSON.stringify(value)}, not a string`));
    const strOrNull = (value: unknown, where: string): string | null => (value === null ? null : str(value, where));
    const hash = (value: unknown, where: string): string =>
      typeof value === 'string' && CONTENT_HASH_RE.test(value) ? value : fail(`${where} is ${JSON.stringify(value)}, not a sha256 content hash`);
    const hashOrNull = (value: unknown, where: string): string | null => (value === null ? null : hash(value, where));
    const oneOf = <T extends string>(value: unknown, set: ReadonlySet<string>, where: string): T =>
      typeof value === 'string' && set.has(value) ? (value as T) : fail(`${where} is ${JSON.stringify(value)}, not one of ${[...set].join('|')}`);
    const integerAtLeast = (value: unknown, min: number, where: string): number =>
      typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fail(`${where} is ${JSON.stringify(value)}, not an integer ≥ ${min}`);

    const top = record(parsed, 'the manifest');
    exactKeys(top, ['version', 'revision', 'baseline', 'baselines', 'skills', 'files', 'published'], 'the manifest');
    if (top['version'] !== MANIFEST_VERSION) fail(`version ${JSON.stringify(top['version'])} (expected ${MANIFEST_VERSION})`);
    const revision = integerAtLeast(top['revision'], 0, 'revision');
    const baseline = hash(top['baseline'], 'baseline');
    const baselines: Record<string, SkillBaselineRecord> = {};
    for (const [key, value] of Object.entries(record(top['baselines'], 'baselines'))) {
      hash(key, 'a baselines key');
      const where = `baselines[${key}]`;
      const r = record(value, where);
      exactKeys(r, ['plugin_version', 'source', 'git_sha', 'captured_at', 'venv'], where);
      const source = record(r['source'], `${where}.source`);
      exactKeys(source, ['kind', 'path'], `${where}.source`);
      baselines[key] = {
        plugin_version: str(r['plugin_version'], `${where}.plugin_version`),
        source: { kind: oneOf<SkillSourceKind>(source['kind'], SOURCE_KINDS, `${where}.source.kind`), path: str(source['path'], `${where}.source.path`) },
        git_sha: strOrNull(r['git_sha'], `${where}.git_sha`),
        captured_at: str(r['captured_at'], `${where}.captured_at`),
        venv: oneOf<SkillVenvState>(r['venv'], VENV_STATES, `${where}.venv`),
      };
    }
    if (baselines[baseline] === undefined) fail(`baseline ${baseline} has no record under baselines`);
    const skills: Record<string, SkillEntry> = {};
    for (const [name, value] of Object.entries(record(top['skills'], 'skills'))) {
      if (!SKILL_NAME_RE.test(name) || !name.startsWith(SKILL_NAME_PREFIX) || name.length === SKILL_NAME_PREFIX.length) {
        fail(`skill key ${JSON.stringify(name)} is not a skill name (${SKILL_NAME_RE.source} with the ${SKILL_NAME_PREFIX} prefix and a non-empty remainder)`);
      }
      const where = `skills[${name}]`;
      const e = record(value, where);
      // `portability` (F-079) is OPTIONAL: a manifest written before 0.7.30 carries `portable` alone
      // and still loads — the next recompute (any mutation, analyze, publish) fills the field in.
      exactKeys(e, ['dir', 'kind', 'core', 'portable', 'enabled', 'provenance', 'editedAt', 'upgradeAvailable', 'conflict', 'upstreamDir'], where, ['portability']);
      const dir = str(e['dir'], `${where}.dir`);
      const bad = unsafeSkillDir(dir);
      if (bad !== null) fail(`${where}: ${bad}`);
      const derived = derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
      if (derived !== name) fail(`${where} sits at ${dir}, which derives ${JSON.stringify(derived)} — the key must be the path-derived name of its dir`);
      const portable = bool(e['portable'], `${where}.portable`);
      skills[name] = {
        dir,
        kind: oneOf<SkillKind>(e['kind'], SKILL_KINDS, `${where}.kind`),
        core: bool(e['core'], `${where}.core`),
        portable,
        enabled: bool(e['enabled'], `${where}.enabled`),
        provenance: oneOf<SkillProvenance>(e['provenance'], PROVENANCES, `${where}.provenance`),
        editedAt: strOrNull(e['editedAt'], `${where}.editedAt`),
        upgradeAvailable: bool(e['upgradeAvailable'], `${where}.upgradeAvailable`),
        conflict: bool(e['conflict'], `${where}.conflict`),
        upstreamDir: strOrNull(e['upstreamDir'], `${where}.upstreamDir`),
      };
      if (Object.hasOwn(e, 'portability')) {
        const problem = portabilityProblem(e['portability'], portable);
        if (problem !== null) fail(`${where}.portability ${problem}`);
        (skills[name] as SkillEntry).portability = e['portability'] as SkillPortability;
      }
      const upstreamDir = skills[name]?.upstreamDir ?? null;
      if (upstreamDir !== null) {
        const badUpstream = unsafeSkillDir(upstreamDir);
        if (badUpstream !== null) fail(`${where}.upstreamDir: ${badUpstream}`);
        if (upstreamDir === dir) fail(`${where}.upstreamDir equals dir — a held-back upstream skill lives at ANOTHER directory`);
      }
    }
    const files: Record<string, SkillFileRecord> = {};
    for (const [rel, value] of Object.entries(record(top['files'], 'files'))) {
      const bad = unsafeRecordPath(rel);
      if (bad !== null) fail(`file record: ${bad}`);
      const where = `files[${rel}]`;
      const r = record(value, where);
      exactKeys(r, ['baselineHash', 'effectiveHash', 'lastPublishedHash', 'conflict'], where);
      files[rel] = {
        baselineHash: hashOrNull(r['baselineHash'], `${where}.baselineHash`),
        effectiveHash: hashOrNull(r['effectiveHash'], `${where}.effectiveHash`),
        lastPublishedHash: hashOrNull(r['lastPublishedHash'], `${where}.lastPublishedHash`),
        conflict: bool(r['conflict'], `${where}.conflict`),
      };
    }
    let published: SkillManifest['published'] = null;
    if (top['published'] !== null) {
      const p = record(top['published'], 'published');
      exactKeys(p, ['gen', 'contentHash', 'at', 'snapshotHash'], 'published');
      published = {
        gen: integerAtLeast(p['gen'], 1, 'published.gen'),
        contentHash: hash(p['contentHash'], 'published.contentHash'),
        at: str(p['at'], 'published.at'),
        snapshotHash: hash(p['snapshotHash'], 'published.snapshotHash'),
      };
    }
    return { version: MANIFEST_VERSION, revision, baseline, baselines, skills, files, published };
  }

  revision(): number {
    return this.manifest().revision;
  }

  /** Write the manifest with its revision bumped — every mutation ends here. */
  private commit(m: SkillManifest): void {
    m.revision += 1;
    this.writeManifest(m);
  }

  private writeManifest(m: SkillManifest): void {
    this.assertRootIdentity(); // a commit never lands through a root that changed identity
    // Validated on the way OUT too (codex round 7): a manifest the store is about to write must pass
    // the schema it demands on load — a bug producing a malformed field never lands on disk.
    const text = `${JSON.stringify(m, null, 2)}\n`;
    this.validateManifest(this.manifestPath(), JSON.parse(text));
    writeFileAtomic(this.manifestPath(), text);
  }

  private assertRevision(m: SkillManifest, expected: number): void {
    if (expected !== m.revision) throw new RevisionMismatchError(expected, m.revision);
  }

  // ── `current` ─────────────────────────────────────────────────────────────────────────────

  /**
   * The published snapshot `current` resolves to, VERIFIED (module header), or `null` when there
   * is no link (never published). `path` is the absolute REAL path of the generation — exactly the
   * value the engine is handed as `WICKED_SKILLS_SNAPSHOT` (v3.1 §2). A link that exists but fails
   * verification throws `SkillsCurrentInvalidError`. Verified on EVERY call — never memoized by
   * link text (codex round 2): the answer holds for the daemon's whole lifetime only because it is
   * re-derived each time it is handed out.
   */
  currentSnapshot(): { gen: number; path: string } | null {
    this.assertRootIdentity(); // never answered through a root that changed identity (codex round 4)
    const link = this.currentLink();
    let target: string;
    try {
      target = readlinkSync(link);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null;
      if (errnoCode(err) === 'EINVAL') throw new SkillsCurrentInvalidError(link, 'it is not a symbolic link');
      throw err;
    }
    return this.verifyCurrent(link, target);
  }

  private verifyCurrent(link: string, target: string): { gen: number; path: string } {
    const invalid = (detail: string): never => {
      throw new SkillsCurrentInvalidError(link, detail);
    };
    // The root itself first (codex round 4), then containment judged against the LSTAT-CLEAN
    // `snapshots/` path, never the realpath of a redirected one (codex round 3): a
    // `snapshots -> /outside` symlink would otherwise make the target's realpath fall inside the
    // redirected boundary and verify. Refuse it up front.
    this.assertRootIdentity();
    try {
      this.assertStorageAncestorsClean();
    } catch (err) {
      if (err instanceof SymlinkComponentError) return invalid(`a storage directory is a symlink (${err.message}) — the snapshots boundary is not trusted`);
      throw err;
    }
    const lexical = resolve(this.rootDir, target);
    let real: string;
    try {
      real = realpathSync(lexical);
    } catch (err) {
      return invalid(`its target ${target} does not resolve (${errnoCode(err) ?? 'error'})`);
    }
    let snapshotsReal: string;
    try {
      snapshotsReal = realpathSync(this.snapshotsDir());
    } catch {
      return invalid(`${this.snapshotsDir()} does not exist`);
    }
    if (dirname(real) !== snapshotsReal) return invalid(`its target resolves to ${real}, outside ${this.snapshotsDir()}`);
    const dirName = basename(real);
    if (!GENERATION_DIR_RE.test(dirName)) return invalid(`its target ${dirName} is not a generation directory`);
    if (!lstatSync(real).isDirectory()) return invalid(`its target ${dirName} is not a directory`);
    const meta = this.readSnapshotMetadata(lexical);
    if (typeof meta === 'string') return invalid(meta);
    const parsed = meta.parsed;
    if (parsed.gen !== Number(dirName)) return invalid(`snapshot.json says gen ${parsed.gen} but the directory is ${dirName}`);
    // `snapshot.json` is AUTHENTICATED by the crew-owned manifest (codex round 7): it is excluded from
    // the content hash, so its claims — kind, core, portable, nested, the view membership — used to
    // be trusted as written. Publish records the sha256 of the exact bytes it wrote
    // (`manifest.published.snapshotHash`); `current` must be THAT generation with THAT metadata. A
    // torn flip (`current` behind `published`) is finished by `ensureReady` before verification —
    // an older generation is never verified on trust. The recorded baseline (codex round 6) must
    // also be one THIS root's manifest knows — it authorizes the `.venv` link below.
    let known: SkillManifest;
    try {
      known = this.manifest();
    } catch (err) {
      return invalid(`the snapshot cannot be cross-checked against ${MANIFEST_FILENAME} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (known.published === null) return invalid(`${MANIFEST_FILENAME} records no publish — a generation the manifest does not own`);
    if (known.published.gen !== parsed.gen) {
      return invalid(`current names generation ${parsed.gen} but ${MANIFEST_FILENAME} published generation ${known.published.gen} — not the generation manifest.json published`);
    }
    if (known.published.contentHash !== parsed.contentHash || known.published.snapshotHash !== meta.rawSha) {
      return invalid(`snapshot.json is not the metadata this root published for generation ${parsed.gen} (recorded content hash ${known.published.contentHash} / metadata hash ${known.published.snapshotHash}; found ${parsed.contentHash} / ${meta.rawSha}) — the metadata was modified`);
    }
    if (known.baselines[parsed.gardenSource.baseline] === undefined) {
      return invalid(`snapshot.json records baseline ${parsed.gardenSource.baseline}, which ${MANIFEST_FILENAME} does not know — the metadata is not this root's`);
    }
    // EVERY entry is judged, links included (codex round 5): the walk enumerates symlinks instead of
    // skipping them, the hash covers them (path + link text), and the only link a generation may
    // carry is `.venv` at its root, pointing at THIS root's baseline env for the recorded baseline.
    const tree = walkTree(real);
    const special = tree.others[0];
    if (special !== undefined) return invalid(`${special.rel} is neither a file, a directory nor a symlink — a published generation carries no special nodes`);
    // A pruned-name directory (`SKIP_DIR_NAMES`) never enters a generation: publish copies a file set
    // that excludes such subtrees, and the environment is the `.venv` LINK at the generation root. One
    // on disk is therefore an unexpected entry, refused BY NAME before the hash is compared (codex
    // round 10) — whatever it holds, and however the metadata was re-stamped.
    const prunedDir = tree.dirs.find((d) => SKIP_DIR_NAMES.has(posix.basename(d)));
    if (prunedDir !== undefined) {
      return invalid(`unexpected directory ${prunedDir} — a published generation never carries a ${posix.basename(prunedDir)} directory (publish copies no pruned directory; the environment is the .venv link at the generation root): the immutable snapshot was modified`);
    }
    const hash = this.snapshotHash(tree);
    if (hash !== parsed.contentHash) {
      return invalid(`content hash mismatch — snapshot.json records ${parsed.contentHash}, the tree hashes ${hash}: the immutable snapshot was modified`);
    }
    const rowProblem = this.snapshotRowsProblem(parsed, tree);
    if (rowProblem !== null) return invalid(rowProblem);
    const linkProblem = this.snapshotLinkProblem(real, tree.links, parsed);
    if (linkProblem !== null) return invalid(linkProblem);
    return { gen: parsed.gen, path: real };
  }

  /**
   * Re-derive every claim of a skill row from the generation's OWN files (codex round 7; the
   * metadata hash authenticates the rest): `dir/SKILL.md` must be in the tree, `kind` must be what
   * its frontmatter derives, `portable` what the skill's own files (nested subtrees excluded)
   * derive, `nested` what the dir spells (checked at parse); the copilot view ON DISK must lay out
   * EXACTLY the sorted set of portable rows — no skill missing, no extra directory — and nothing
   * else may sit under `views/`. `core` is the registered-reference closure AT PUBLISH (the
   * registered set may legitimately move afterwards), so it is authenticated by the metadata hash
   * rather than re-derived. Read-only mode bits are re-checked by nobody: they are a guard against
   * accidents, never the integrity boundary — the hashes are.
   */
  private snapshotRowsProblem(parsed: SnapshotManifest, tree: TreeListing): string | null {
    const files = tree.files;
    const byRel = new Map(files.map((f) => [f.rel, f]));
    const dirs = new Set(parsed.skills.map((r) => r.dir));
    // The validator's universe at verify is the generation's OWN bundle files — the views and the
    // metadata file are crew's, not the plugin's — the same universe recompute judged against
    // (closure support files + enabled skills' own files), so the reasons re-derive identically.
    const bundle = new Set(files.map((f) => f.rel).filter((rel) => rel !== SNAPSHOT_MANIFEST_FILENAME && !rel.startsWith(`${VIEWS_DIRNAME}/`)));
    const exists = (p: string): boolean => existsIn(bundle, p);
    for (const row of parsed.skills) {
      const skillMd = byRel.get(`${row.dir}/SKILL.md`);
      if (skillMd === undefined) return `skill row ${row.name} names ${row.dir}, but the generation carries no ${row.dir}/SKILL.md`;
      const fm = parseFrontmatter(readFileNoFollow(skillMd.abs).toString('utf8'));
      if (!fm.ok) return `${row.dir}/SKILL.md frontmatter does not parse (${fm.reason}) — its row cannot be re-derived`;
      const kind = skillKindOf(fm.fields);
      if (kind !== row.kind) return `skill row ${row.name} claims kind ${row.kind}, but its SKILL.md derives ${kind}`;
      const hits: PortabilityHit[] = [];
      const prefix = `${row.dir}/`;
      for (const f of files) {
        if (!f.rel.startsWith(prefix) || owningSkillDir(f.rel, dirs) !== row.dir) continue;
        const buf = readFileNoFollow(f.abs);
        if (looksBinary(buf)) continue;
        hits.push(...portabilityIssuesOf(buf.toString('utf8'), { fileRel: f.rel, skillDir: row.dir, skillDirs: dirs, exists }));
      }
      const reasons = portabilityReasonsOf(hits);
      const portable = reasons.length === 0;
      if (portable !== row.portable) return `skill row ${row.name} claims portable: ${String(row.portable)}, but its files derive ${String(portable)}`;
      // The per-reason claim (F-079) is re-derived too — a row cannot name reasons its files do not carry.
      if (row.portability !== undefined && !sameStrings(row.portability.reasons, reasons)) {
        return `skill row ${row.name} claims portability reasons [${row.portability.reasons.join(', ')}], but its files derive [${reasons.join(', ')}]`;
      }
    }
    // The copilot view as a WHOLE tree (codex round 9): EXACTLY `views/copilot/.github/skills/<name>/…`
    // for the sorted portable rows — the files each row owns, the directories they imply — and nothing
    // else under `views/`: no other directory (empty or not), no other file; every unexpected entry is
    // named. Links and special nodes anywhere in the generation are refused by `verifyCurrent` /
    // `snapshotLinkProblem` before this runs.
    const expectedView = parsed.skills.filter((r) => r.portable).map((r) => r.name).sort();
    const expectedFiles = new Set<string>();
    for (const row of parsed.skills) {
      if (!row.portable) continue;
      const prefix = `${row.dir}/`;
      for (const f of files) {
        if (f.rel.startsWith(prefix) && owningSkillDir(f.rel, dirs) === row.dir) expectedFiles.add(`${COPILOT_VIEW_SKILLS_REL}/${row.name}/${f.rel.slice(prefix.length)}`);
      }
    }
    const underViews = (rel: string): boolean => rel === VIEWS_DIRNAME || rel.startsWith(`${VIEWS_DIRNAME}/`);
    const expectedDirs = new Set(impliedDirs(expectedFiles).filter(underViews));
    const shape = `the copilot view is exactly ${COPILOT_VIEW_SKILLS_REL}/<name>/… for [${expectedView.join(', ')}] (each skill's own files and the directories they imply); a view entry is missing or extra`;
    for (const f of files) if (underViews(f.rel) && !expectedFiles.has(f.rel)) return `unexpected view file ${f.rel} — ${shape}`;
    for (const d of tree.dirs) if (underViews(d) && !expectedDirs.has(d)) return `unexpected view directory ${d} — ${shape}`;
    for (const f of expectedFiles) if (!byRel.has(f)) return `the copilot view is missing ${f} — ${shape}`;
    const dirSet = new Set(tree.dirs);
    for (const d of expectedDirs) if (!dirSet.has(d)) return `the copilot view is missing directory ${d} — ${shape}`;
    return null;
  }

  /** Hash over a snapshot tree — files (`snapshot.json` excluded), link entries (path + link text) AND directory entries (codex round 9: an extra empty directory changes it). */
  private snapshotHash(tree: TreeListing): string {
    return hashTree(
      tree.files.filter((f) => f.rel !== SNAPSHOT_MANIFEST_FILENAME),
      tree.links,
      tree.dirs,
    );
  }

  /** The link text publish writes for a snapshot's `.venv`: relative on POSIX, the absolute target for a Windows junction. */
  private venvLinkText(baseline: string): { text: string; absTarget: string } {
    const absTarget = baselineVenvDir(this.baselineDir(baseline));
    return {
      text: process.platform === 'win32' ? absTarget : posix.join('..', '..', BASELINE_DIRNAME, baseline, VENV_LINKNAME),
      absTarget,
    };
  }

  /**
   * Why a generation's symlinks are not acceptable, or `null`: any link other than the root-level
   * `.venv` is refused by name and target; `.venv` may exist only when `snapshot.json` records the
   * env as `synced`, must carry EXACTLY the link text publish writes (the relative path to this
   * root's `baseline/<recorded baseline>/.venv`), and must resolve to that very directory (a
   * dangling or redirected link is refused — a worker's `uv run` through it would create or read
   * an env somewhere else). A `synced` snapshot WITHOUT the link is not what publish wrote either.
   *
   * The link is verified INDEPENDENTLY of the metadata text (codex round 6: an altered manifest,
   * link and recorded hash used to let an outside-pointing `.venv` verify, because the expected
   * target was JOINED from a `gardenSource.baseline` validated only as a string). The only two facts
   * of `snapshot.json` this decision consumes are that the baseline is a 64-hex content hash
   * (`parseSnapshotManifest`) that `manifest.json` knows (`verifyCurrent`); the env it must reach is
   * then walked FROM THE ROOT with lstat — no link at `baseline`, `<hash>` or `.venv` — must be a
   * REAL directory, and the link's canonical target must equal that directory's canonical path
   * inside the canonical root.
   */
  private snapshotLinkProblem(snapshotDir: string, links: ReadonlyArray<LinkRecord>, parsed: SnapshotManifest): string | null {
    const venv = links.find((l) => l.rel === VENV_LINKNAME);
    for (const l of links) {
      if (l.rel !== VENV_LINKNAME) return `unexpected symlink ${l.rel} -> ${l.target}: a published generation carries no link but its root-level ${VENV_LINKNAME}`;
    }
    if (venv === undefined) {
      return parsed.venv === 'synced' ? `snapshot.json records the baseline env as synced but the generation has no ${VENV_LINKNAME} link` : null;
    }
    if (parsed.venv !== 'synced') return `${VENV_LINKNAME} -> ${venv.target} is present although snapshot.json records the env as ${parsed.venv}`;
    const hash = parsed.gardenSource.baseline; // 64-hex by parse; a manifest.json key by verifyCurrent
    const expected = this.venvLinkText(hash);
    if (venv.target !== expected.text) return `${VENV_LINKNAME} -> ${venv.target} is not the baseline env link publish wrote (${expected.text})`;
    let envDir: string;
    try {
      envDir = containedPath(this.rootDir, [BASELINE_DIRNAME, hash, VENV_LINKNAME]);
    } catch (err) {
      if (err instanceof SkillPathError) return `${VENV_LINKNAME} -> ${venv.target}: the baseline env is not reachable without following a link (${err.message})`;
      throw err;
    }
    const envStat = lstatOrNull(envDir);
    if (envStat === null || !envStat.isDirectory()) return `${VENV_LINKNAME} -> ${venv.target} names ${envDir}, which is not a real directory`;
    let resolved: string;
    let rootReal: string;
    try {
      resolved = realpathSync(join(snapshotDir, VENV_LINKNAME));
      rootReal = realpathSync(this.rootDir);
    } catch (err) {
      return `${VENV_LINKNAME} -> ${venv.target} does not resolve (${errnoCode(err) ?? 'error'})`;
    }
    const expectedReal = join(rootReal, BASELINE_DIRNAME, hash, VENV_LINKNAME);
    if (resolved !== expectedReal) return `${VENV_LINKNAME} resolves to ${resolved}, not the baseline env ${expectedReal} inside the canonical root ${rootReal}`;
    return null;
  }

  /** `snapshot.json` at `dir`, structurally validated (`readSnapshotMetadata`) — for readers that need no authentication (baseline retention). */
  private parseSnapshotManifest(dir: string): SnapshotManifest | string {
    const meta = this.readSnapshotMetadata(dir);
    return typeof meta === 'string' ? meta : meta.parsed;
  }

  /**
   * `snapshot.json` at `dir`, read NO-FOLLOW and structurally validated — with the sha256 of its
   * exact bytes (`rawSha`, what `manifest.published.snapshotHash` authenticates; codex round 7) — or
   * the reason it is not one. Every field a decision consumes is regex- or enum-validated here
   * (codex round 6): `gardenSource.baseline` must be a sha256 content hash (it authorizes the `.venv`
   * link — a free string could carry `..`), `venv` one of the four states, `gardenSource.kind` a
   * known source kind, every skill row fully typed (`isSnapshotSkillRow`), rows sorted and unique,
   * the view block naming EXACTLY the portable rows.
   */
  private readSnapshotMetadata(dir: string): { parsed: SnapshotManifest; rawSha: string } | string {
    const path = join(dir, SNAPSHOT_MANIFEST_FILENAME);
    const st = lstatOrNull(path);
    if (st === null) return `no ${SNAPSHOT_MANIFEST_FILENAME} in ${dir}`;
    if (st.isSymbolicLink()) return `${SNAPSHOT_MANIFEST_FILENAME} in ${dir} is a symlink (-> ${readlinkSync(path)}) — the store never reads snapshot metadata through a link`;
    if (!st.isFile()) return `${SNAPSHOT_MANIFEST_FILENAME} in ${dir} is not a regular file`;
    let raw: string;
    try {
      raw = readFileNoFollow(path).toString('utf8'); // O_NOFOLLOW + identity (v3.5 §3)
    } catch (err) {
      return `no readable ${SNAPSHOT_MANIFEST_FILENAME} in ${dir} (${err instanceof EntrySwappedError || err instanceof SymlinkComponentError ? err.message : (errnoCode(err) ?? 'error')})`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return `${SNAPSHOT_MANIFEST_FILENAME} does not parse: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (typeof parsed !== 'object' || parsed === null) return `${SNAPSHOT_MANIFEST_FILENAME} is not an object`;
    const s = parsed as Partial<SnapshotManifest>;
    if (typeof s.gen !== 'number' || !Number.isInteger(s.gen) || s.gen < 1) return `${SNAPSHOT_MANIFEST_FILENAME} has no integer gen`;
    if (typeof s.contentHash !== 'string' || !CONTENT_HASH_RE.test(s.contentHash)) return `${SNAPSHOT_MANIFEST_FILENAME} has no sha256 contentHash`;
    if (!Array.isArray(s.skills)) return `${SNAPSHOT_MANIFEST_FILENAME} has no skills array`;
    if (!s.skills.every(isSnapshotSkillRow)) {
      return `${SNAPSHOT_MANIFEST_FILENAME} has a skill row that is not {name: a wicked-garden-* skill name, dir: a safe relative skills/… path deriving that name, kind: ${[...SKILL_KINDS].join('|')}, core: boolean, portable: boolean, portability?: {portable: the same boolean, reasons: sorted unique tokens (empty iff portable), evidence?: ≤ ${PORTABILITY_EVIDENCE_CAP} anchors}, nested: what the dir spells} — metadata is never trusted to name a path, and core cannot judge seat compatibility from it`;
    }
    if (!isSortedUniqueRows(s.skills as SnapshotSkillRow[])) return `${SNAPSHOT_MANIFEST_FILENAME} skill rows are not sorted by unique name — not what publish writes`;
    const gs = s.gardenSource as Partial<SnapshotManifest['gardenSource']> | null | undefined;
    if (typeof gs !== 'object' || gs === null || typeof gs.baseline !== 'string' || !CONTENT_HASH_RE.test(gs.baseline)) {
      return `${SNAPSHOT_MANIFEST_FILENAME} has no gardenSource.baseline that is a sha256 content hash — the recorded baseline authorizes the ${VENV_LINKNAME} link and is never trusted as free text`;
    }
    if (typeof gs.path !== 'string' || typeof gs.plugin_version !== 'string' || !SOURCE_KINDS.has(String(gs.kind))) {
      return `${SNAPSHOT_MANIFEST_FILENAME} gardenSource is not {kind: ${[...SOURCE_KINDS].join('|')}, path, plugin_version, baseline}`;
    }
    if (!VENV_STATES.has(String(s.venv))) return `${SNAPSHOT_MANIFEST_FILENAME} has no venv state (${[...VENV_STATES].join('|')})`;
    if (!isSnapshotViews(s.views, s.skills as SnapshotSkillRow[])) {
      return `${SNAPSHOT_MANIFEST_FILENAME} has no well-formed views block ({copilot: {dir: "${COPILOT_VIEW_REL}", skills: EXACTLY the sorted portable names}})`;
    }
    return { parsed: s as SnapshotManifest, rawSha: sha256Hex(raw) };
  }

  /** The verified `snapshot.json` of a published generation. */
  readSnapshotManifest(dir: string): SnapshotManifest {
    const parsed = this.parseSnapshotManifest(dir);
    if (typeof parsed === 'string') throw new SkillsCurrentInvalidError(dir, parsed);
    return parsed;
  }

  /**
   * Fold one CoreEvent into the live-generation ledger (v3 §1 reaping rule): a live session pins
   * the EXACT generation the engine reports it was handed (`skillsSnapshotHanded`), plus every
   * generation published while it stays live; a launch pin the daemon opened when it handed the
   * launch to the engine (`live.launched`) is released by that report or the terminal frame — never
   * by publish count (codex round 4); a terminal frame releases the pins and reaps what no other
   * live session or open launch holds. The daemon calls this from its one `adapter.onEvent`
   * listener (live-generations.ts).
   */
  observeEvent(event: CoreEvent): void {
    if (this.live.observe(event) === 'released') this.reapStale();
  }

  /** Reap generations beyond the newest `KEEP_GENERATIONS` that no live session or open launch pins (no-op before a publish). */
  reapStale(): void {
    // A root that changed identity or a symlinked storage ancestor makes reaping unsafe (it would
    // rm through the link): skip it, never throw — this runs from the event listener (codex round 3).
    try {
      this.assertRootIdentity();
      this.assertStorageAncestorsClean();
    } catch (err) {
      this.warn(`[skills] reaping skipped, the skills root is not intact: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let current: { gen: number; path: string } | null;
    try {
      current = this.currentSnapshot();
    } catch (err) {
      this.warn(`[skills] reaping skipped, current snapshot unverifiable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (current !== null) {
      this.reapGenerations(current.gen);
      this.reapBaselines();
    }
  }

  // ── Seed ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Seed the root from the live plugin when it has no manifest. Idempotent: a seeded root is left
   * alone. A torn earlier seed (dirs but no manifest) is cleared and redone. Throws
   * `SkillsSourceUnavailableError` when no plugin is installed, and `PluginSourceSymlinkError` when
   * a designated entry of the source is a symlink (codex round 6) — BEFORE the root is created:
   * nothing is copied, the runtime reports it as `skills.config` naming the entry.
   */
  seed(): SeedResult {
    if (this.isSeeded()) return { seeded: false, baseline: null, source: null };
    const source = this.requireSource(
      'no installed wicked-garden plugin found: neither the marketplace cache (<config dir>/plugins/cache/wicked-garden/wicked-garden/<version>) nor the installer-managed copy (<config dir>/plugins/wicked-garden, ~/.claude/plugins/wicked-garden) holds a .claude-plugin/plugin.json with a version; set WICKED_CREW_SKILLS_SOURCE to use another plugin root deliberately',
    );
    const bundle = pluginBundleFiles(source.path);
    const hash = hashFileSet(bundle);
    mkdirSync(this.rootDir, { recursive: true });
    this.assertRootIdentity(); // bind the identity of the directory just created — or refuse a link that stood there
    this.captureBaseline(bundle, hash, 'recapture');
    const effective = this.effectiveDir();
    rmSync(effective, { recursive: true, force: true });
    copyFiles(bundle, effective);
    removeTreeForce(this.snapshotsDir()); // published generations are locked read-only
    rmSync(this.currentLink(), { force: true });

    const files: Record<string, SkillFileRecord> = {};
    for (const f of this.scanEffective().files) {
      files[f.rel] = { baselineHash: f.sha, effectiveHash: f.sha, lastPublishedHash: null, conflict: false };
    }
    const m: SkillManifest = {
      version: MANIFEST_VERSION,
      revision: 1,
      baseline: hash,
      baselines: { [hash]: this.baselineRecord(source) },
      skills: {},
      files,
      published: null,
    };
    this.rebuildCatalog(m);
    this.writeManifest(m);
    return { seeded: true, baseline: hash, source };
  }

  private requireSource(detail: string): PluginSource {
    const source = this.sourceFn();
    if (source === null) throw new SkillsSourceUnavailableError(detail);
    return source;
  }

  /**
   * Copy the bundle to `baseline/<hash>/` through a staging dir (a torn copy never bears the hash),
   * LOCKED read-only before it lands. An EXISTING `baseline/<hash>` is reused only after its tree
   * re-hashes to `<hash>` (codex round 7): a dir that merely exists proved nothing — modified,
   * planted or pre-planted content would have been restored by reset and published as ordinary
   * drift. On a mismatch the seed RE-CAPTURES over it (`recapture`: the seed is creating the root's
   * first state and says so); a refresh REFUSES (`SkillsBaselineCorruptError` → its 2xx `blocked`
   * `baseline-corrupt` envelope, nothing copied).
   */
  private captureBaseline(bundle: ReadonlyArray<FileRecord>, hash: string, onCorrupt: 'recapture' | 'refuse'): void {
    // A symlinked `baseline/` (or root) would redirect the capture outside the store (codex round 3).
    this.assertRootIdentity();
    try {
      this.assertStorageAncestorsClean();
    } catch (err) {
      if (err instanceof SymlinkComponentError) throw new SkillsPublishError(`a storage directory is a symlink (${err.message}) — baseline capture refused`);
      throw err;
    }
    const dest = this.baselineDir(hash);
    if (this.entryExists(dest)) {
      const problem = this.baselineProblem(hash);
      if (problem === null) return;
      if (onCorrupt === 'refuse') throw new SkillsBaselineCorruptError(dest, problem);
      this.warn(`[skills] ${problem} — re-captured from the source (the seed owns the root's first state)`);
      removeTreeForce(dest);
    }
    const parent = join(this.rootDir, BASELINE_DIRNAME);
    mkdirSync(parent, { recursive: true });
    this.sweepStaging(parent);
    const staging = join(parent, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    copyFiles(bundle, staging);
    // Re-walk (lstat) and re-hash the staged capture AFTER the copy and BEFORE the rename (design
    // v3.5 §3): links enumerated (none allowed), every file's digest — a staged tree that is not the
    // bundle its hash names never becomes `baseline/<hash>`.
    const staged = walkTree(staging);
    const stagedHash = hashFileSet(staged.files);
    if (staged.links.length > 0 || stagedHash !== hash) {
      removeTreeForce(staging);
      const link = staged.links[0];
      throw new SkillsBaselineCorruptError(
        staging,
        link !== undefined ? `the staged capture carries a symlink at ${link.rel} -> ${link.target}` : `the staged capture hashes to ${stagedHash}, not to ${hash} — modified between copy and rename`,
      );
    }
    if (this.entryExists(dest)) {
      removeTreeForce(staging); // raced by another capture of the same bytes — theirs is as good, and verified on its next reuse
      return;
    }
    this.lockBaseline(staging);
    renameSync(staging, dest);
  }

  /**
   * Why `baseline/<hash>` is not the bundle its name claims, or `null`: a real directory whose tree
   * — links ENUMERATED (a link inside is a corruption, never followed), the per-baseline `.venv`
   * excluded (it is provisioned INTO the dir after capture; `SKIP_DIR_NAMES`) — hashes to `<hash>`
   * (`hashFileSet`, the identity the seed computed). Re-derived on EVERY reuse (codex round 7):
   * before a refresh reuses it, before publish provisions in it and after the provisioner ran
   * (`validate`), and per file before reset restores from it. Read-only mode bits are a guard
   * against accidents, never the integrity boundary — this hash is.
   *
   * The pruned subtrees stay pruned AND UNCLASSIFIED here (codex round 10; `walkTree(...).pruned`
   * is deliberately not consulted), unlike under `effective/`: the provisioned `.venv` is an
   * interpreter environment and legitimately holds symlinks (`bin/python -> python3.x`,
   * `lib64 -> lib`). That is safe because nothing beneath a pruned directory is ever DELIVERED
   * except through the snapshot's `.venv` link, whose target both verifiers check by identity —
   * `snapshotLinkProblem` here (this root's `baseline/<hash>/.venv` for the recorded baseline, the
   * link text as publish wrote it) and core on its side (every component a real directory, the
   * target ending exactly at `<baseline>/<64-hex>/.venv`). A link inside the env reaches a worker
   * only as part of the env the store itself provisioned; the bundle identity re-derived here never
   * covers it, and no other pruned name is linked from anywhere.
   */
  private baselineProblem(hash: string): string | null {
    const dir = this.baselineDir(hash);
    const st = lstatOrNull(dir);
    if (st === null) return `${dir} does not exist`;
    if (st.isSymbolicLink()) return `${dir} is a symlink`;
    if (!st.isDirectory()) return `${dir} is not a directory`;
    let tree: TreeListing;
    try {
      tree = walkTree(dir);
    } catch (err) {
      return `${dir} cannot be walked (${err instanceof Error ? err.message : String(err)})`;
    }
    const link = tree.links[0];
    if (link !== undefined) return `${dir} carries a symlink at ${link.rel} -> ${link.target}`;
    const special = tree.others[0];
    if (special !== undefined) return `${dir} carries ${special.rel}, which is neither a file nor a directory`;
    const actual = hashFileSet(tree.files);
    if (actual !== hash) return `${dir} hashes to ${actual}, not to its name — a bundle file was modified, added or removed`;
    return null;
  }

  /**
   * Lock a captured bundle's FILES read-only — every bundle file loses its write bits. Directories
   * stay writable: `.venv` is provisioned into the top dir afterwards (venv.ts — the provisioner may
   * write only there, and publish re-hashes the bundle after it ran), and the store's own reap and
   * re-capture unlink through them. Mode bits are a guard against accidental edits, NOT the
   * integrity boundary: `baselineProblem` re-hashes the tree on every reuse regardless of what the
   * bits say, and `reset` re-hashes every file it restores against the manifest's record.
   */
  private lockBaseline(dir: string): void {
    if (process.platform === 'win32') return;
    for (const f of walkFiles(dir)) chmodSync(f.abs, lstatSync(f.abs).mode & 0o777 & ~0o222);
  }

  /** Give the operator's copies their owner-write bit back: a baseline file is locked read-only, an `effective/` file is theirs to edit. */
  private restoreOwnerWrite(paths: ReadonlyArray<string>): void {
    if (process.platform === 'win32') return;
    for (const p of paths) {
      const st = lstatOrNull(p);
      if (st !== null && st.isFile()) chmodSync(p, (st.mode & 0o777) | 0o200);
    }
  }

  /**
   * Re-walk (lstat) and re-hash a staged tree AFTER the copy and BEFORE the swap/rename (design v3.5
   * §3; codex round 8): every expected file present with its expected digest, nothing else, no
   * symlink. Answers why the staged tree is not what the copy was meant to produce, or `null`.
   */
  private stagedTreeProblem(stagedDir: string, expected: ReadonlyMap<string, string>): string | null {
    const tree = walkTree(stagedDir);
    const link = tree.links[0];
    if (link !== undefined) return `the staged tree carries a symlink at ${link.rel} -> ${link.target}`;
    const special = tree.others[0];
    if (special !== undefined) return `the staged tree carries ${special.rel}, which is neither a file nor a directory`;
    const implied = new Set(impliedDirs(expected.keys()));
    const extraDir = tree.dirs.find((d) => !implied.has(d));
    if (extraDir !== undefined) return `the staged tree carries a directory ${extraDir} that no staged file implies`;
    const seen = new Set<string>();
    for (const f of tree.files) {
      const want = expected.get(f.rel);
      if (want === undefined) return `the staged tree carries ${f.rel}, which was not staged`;
      const got = sha256Hex(readFileNoFollow(f.abs));
      if (got !== want) return `staged ${f.rel} hashes to ${got}, expected ${want} — modified between copy and swap`;
      seen.add(f.rel);
    }
    if (seen.size !== expected.size) return `the staged tree is missing ${[...expected.keys()].filter((k) => !seen.has(k)).join(', ')}`;
    return null;
  }

  /** The blocking finding for a staged tree (or a copy source) that changed under the operation — nothing swapped, nothing written (v3.5 §3). */
  private stagedTreeFinding(skill: string | null, file: string, evidence: string): SkillConflictFinding {
    return finding(
      'path-invalid',
      'blocking',
      'the staged tree was re-walked and re-hashed before the swap and was not what the copy produced — a file modified, added, removed or swapped for a symlink between copy and rename (design v3.5 §3: the lstat walk is necessary, not sufficient); nothing was swapped or written',
      evidence,
      { skill, file },
    );
  }

  /** The blocking `baseline-corrupt` finding (codex round 7). */
  private baselineCorruptFinding(skill: string | null, file: string, evidence: string): SkillConflictFinding {
    return finding(
      'baseline-corrupt',
      'blocking',
      'a content-addressed baseline must hash to its name before anything is copied from it or provisioned in it — a bundle file that was modified, planted or removed (or a symlink inside) would otherwise be restored by reset and published as ordinary drift; nothing was copied or written. Remove the directory (POST /skills/refresh-baseline re-captures it) and retry',
      evidence,
      { skill, file },
    );
  }

  /** Remove torn `.staging-*` (and legacy `.tmp-*`) dirs under `parent` — the idempotent-retry sweep. */
  private sweepStaging(parent: string): void {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      if (e.startsWith(STAGING_PREFIX) || e.startsWith('.tmp-')) removeTreeForce(join(parent, e));
    }
  }

  private baselineRecord(source: PluginSource): SkillBaselineRecord {
    const git = gitStateOf(source);
    if (git.error !== undefined) {
      this.warn(`[skills] ${source.path} is a checkout but git could not answer (${git.error}); git_sha recorded as null`);
    }
    return {
      plugin_version: source.plugin_version,
      source: { kind: source.kind, path: source.path },
      git_sha: git.git_sha,
      captured_at: this.now(),
      venv: 'pending',
    };
  }

  /**
   * A baseline env is READY only when its on-disk marker is present AND the tree is actually
   * read-only (codex round 3): the marker is written before the lock, so a marker whose lock never
   * took is NOT trust — the fast path and the post-lock verification both demand both. On POSIX the
   * marker's own mode bit and the venv root's prove the lock (a completed `makeTreeReadOnly` strips
   * every write bit); on Windows (no POSIX modes) the marker alone is the signal.
   */
  private venvReady(venvDir: string): boolean {
    let marker;
    try {
      marker = lstatSync(join(venvDir, VENV_READY_MARKER));
    } catch {
      return false;
    }
    if (!marker.isFile()) return false;
    if (process.platform === 'win32') return true;
    if ((marker.mode & WRITE_BITS) !== 0) return false;
    try {
      return (lstatSync(venvDir).mode & WRITE_BITS) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Provision the baseline's `.venv` unless it is already READY (marker + read-only bits verify),
   * and lock a synced env read-only. The marker is written, THEN the tree is locked, THEN both are
   * re-verified — and a FAILED lock removes the whole env (marker included) so nothing partial is
   * ever trusted and a retry re-provisions and re-locks from scratch (codex round 3: the marker
   * used to survive a failed lock and admit the env unconditionally on retry). PERSISTS NOTHING in
   * the manifest — the publish that succeeds records the state in its commit (a blocked publish
   * persists nothing, provisioning state included). One provisioning per hash: a concurrent caller
   * awaits the in-flight one. A `.venv` without a verified marker is a torn earlier sync and is
   * removed before `uv sync` runs again — the manifest is never the authority on what exists on
   * disk. AWAITED by publish.
   */
  private ensureVenv(hash: string): Promise<SkillVenvState> {
    // Every path provisioning touches is validated BEFORE the first filesystem operation — the
    // ready check, the torn-env removal, `uv sync`, the marker write and the lock all go through
    // `baseline/<hash>` (codex round 4). Throws `SkillsPublishError`; the publish rejects loudly.
    const { baselineDir, venvDir, cacheDir } = this.venvPaths(hash);
    if (this.venvReady(venvDir)) return Promise.resolve('synced');
    const inFlight = this.venvInFlight.get(hash);
    if (inFlight !== undefined) return inFlight;
    const run = (async (): Promise<SkillVenvState> => {
      if (this.entryExists(venvDir)) {
        this.warn(`[skills] ${venvDir} exists without a verified ready marker (a torn earlier sync or an unlockable env) — removed and re-provisioned`);
        removeTreeForce(venvDir);
      }
      const state = await this.provisionVenv(baselineDir, { log: this.warn, cacheDir });
      if (state !== 'synced') return state;
      if (!existsSync(venvDir)) {
        this.warn(`[skills] the provisioner answered synced but ${venvDir} does not exist — recorded as failed`);
        return 'failed';
      }
      try {
        // Marker FIRST (it must land inside the tree before the lock seals it), THEN lock.
        writeFileAtomic(join(venvDir, VENV_READY_MARKER), `synced ${this.now()}\n`);
        makeTreeReadOnly(venvDir);
      } catch (err) {
        // An env this daemon cannot lock read-only is not the shared read-only env the contract
        // requires (tree.ts surfaces the permission failure; codex round 2). A failed lock must
        // leave NO marker — remove the whole partial env so a retry re-provisions and re-locks
        // rather than trusting a marker whose lock never took (codex round 3).
        this.warn(`[skills] could not lock ${venvDir} read-only: ${err instanceof Error ? err.message : String(err)} — removed and recorded as failed`);
        removeTreeForce(venvDir);
        return 'failed';
      }
      // The lock must actually be in place before we call the env ready — a partial lock that left
      // the marker or the root writable is a failed provisioning, removed so a retry redoes it.
      if (!this.venvReady(venvDir)) {
        this.warn(`[skills] ${venvDir} did not verify read-only after locking — removed and recorded as failed`);
        removeTreeForce(venvDir);
        return 'failed';
      }
      return 'synced';
    })();
    const tracked = run.finally(() => {
      this.venvInFlight.delete(hash);
    });
    this.venvInFlight.set(hash, tracked);
    return tracked;
  }

  /**
   * The provisioning paths of baseline `hash`, VALIDATED before `ensureVenv` deletes, syncs, writes
   * a marker or chmods anything (codex round 4: the structural check covered `baseline/` but never
   * `baseline/<hash>`, so a symlink AT the hash redirected the env removal, `uv sync`, the marker
   * write and the read-only lock outside the store). Requires: the content-hash charset; the root
   * and `baseline/` intact; `baseline/<hash>` reached without crossing a link and a REAL directory
   * (a manifest naming a baseline that is not on disk is refused, not provisioned into a void);
   * `baseline/<hash>/.venv`, its ready marker and the daemon's `.uv-cache` symlink-free (each may
   * not exist yet — the walk ends at the first missing component). Throws `SkillsPublishError`.
   */
  private venvPaths(hash: string): { baselineDir: string; venvDir: string; cacheDir: string } {
    const refuse = (detail: string): never => {
      throw new SkillsPublishError(`baseline environment refused before any filesystem operation: ${detail}`);
    };
    if (!CONTENT_HASH_RE.test(hash)) refuse(`baseline identifier ${JSON.stringify(hash)} is not a content hash`);
    this.assertRootIdentity();
    try {
      this.assertStorageAncestorsClean();
    } catch (err) {
      if (err instanceof SymlinkComponentError) refuse(`a storage directory is a symlink (${err.message})`);
      throw err;
    }
    const walked = (segments: string[]): string => {
      try {
        return containedPath(this.rootDir, segments);
      } catch (err) {
        if (err instanceof SkillPathError) return refuse(err.message);
        throw err;
      }
    };
    const baselineDir = walked([BASELINE_DIRNAME, hash]);
    let st;
    try {
      st = lstatSync(baselineDir);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') refuse(`${baselineDir} does not exist — the manifest names a baseline that is not on disk; POST /skills/refresh-baseline re-captures it`);
      throw err;
    }
    if (!st.isDirectory()) refuse(`${baselineDir} is not a directory`);
    const venvDir = walked([BASELINE_DIRNAME, hash, VENV_LINKNAME]);
    walked([BASELINE_DIRNAME, hash, VENV_LINKNAME, VENV_READY_MARKER]);
    const cacheDir = walked([UV_CACHE_DIRNAME]);
    return { baselineDir, venvDir, cacheDir };
  }

  /**
   * Boot / settings entry point: wait out a publish in flight (never start a second one), seed
   * when unseeded, finish a publish a crash interrupted between the manifest commit and the
   * `current` flip, publish when nothing is published. Throws `SkillsSourceUnavailableError` for
   * the seed and `SkillsCurrentInvalidError` / `SkillsManifestCorruptError` for a corrupt root; a
   * blocked first publish is returned, not thrown. `source` is the plugin root the seed copied
   * from — its kind, path and plugin version — so the boot log names what was actually seeded (an
   * explicit `WICKED_CREW_SKILLS_SOURCE` checkout or directory as readily as the installed plugin;
   * Copilot on #480); `null` when the root was already seeded.
   */
  async ensureReady(): Promise<{ seeded: boolean; source: PluginSource | null; published: SkillPublishResult | null }> {
    while (this.publishInFlight !== null) {
      try {
        await this.publishInFlight;
      } catch {
        // Its own caller reports that outcome; this entry point only needed it to settle.
      }
    }
    const { seeded, source } = this.seed();
    const m = this.manifest();
    // A crash between the manifest commit and the `current` flip leaves `current` ABSENT or naming an
    // OLDER generation. Finish the flip FIRST — from the published generation the manifest
    // AUTHENTICATES (gen, content hash, metadata hash, the tree re-hashed) — because `current` is then
    // verified as THE published generation (codex round 7: only that metadata is authenticated), never
    // as an older one taken on trust. ONLY those two shapes are repaired: a `current` that names
    // anything else (a non-generation target, a generation ahead of the manifest) is not a torn flip
    // but a corruption, left for the verification below to refuse loudly; so is a published
    // generation that does not verify.
    const named = this.currentLinkGen();
    if (m.published !== null && (named === null || (typeof named === 'number' && named < m.published.gen))) {
      const dir = this.snapshotDir(m.published.gen);
      const meta = this.readSnapshotMetadata(dir);
      if (
        typeof meta !== 'string' &&
        meta.parsed.gen === m.published.gen &&
        meta.parsed.contentHash === m.published.contentHash &&
        meta.rawSha === m.published.snapshotHash &&
        this.snapshotHash(walkTree(dir)) === meta.parsed.contentHash
      ) {
        this.warn(`[skills] finishing an interrupted publish: current -> ${generationDirName(meta.parsed.gen)}`);
        this.flipCurrent(meta.parsed.gen);
      }
    }
    const current = this.currentSnapshot();
    if (current !== null) return { seeded, source, published: null };
    return { seeded, source, published: await this.publish(m.revision) };
  }

  /**
   * What `current` LEXICALLY names (its link text) — a hint for the torn-flip recovery, never a
   * verified answer: `null` when there is no entry at all, the generation number when the text names
   * a generation directory, `'other'` for anything else (a non-link entry, a target that is not a
   * generation dir) — which is never repaired, only refused by `verifyCurrent`.
   */
  private currentLinkGen(): number | null | 'other' {
    let target: string;
    try {
      target = readlinkSync(this.currentLink());
    } catch (err) {
      return errnoCode(err) === 'ENOENT' ? null : 'other';
    }
    const name = basename(target);
    return GENERATION_DIR_RE.test(name) ? Number(name) : 'other';
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────────────────

  /** Every managed file under `effective/`, hashed. */
  private scanEffective(): EffectiveScan {
    this.assertRootIdentity();
    // ONE walker classifies every entry (tree.ts `walkEntries`; codex round 9): the files are hashed,
    // the links and special nodes are handed to the validation to refuse by name, the directories are
    // visible — a symlink or a fifo under effective/ used to be skipped and therefore never judged.
    // The walk DESCENDS pruned directories too (codex round 10): a link or special node beneath
    // `node_modules/`, `.venv/` or `__pycache__/` is in `links` / `others` (marked `pruned`) for the
    // validation to refuse; the files and directories beneath one stay out of the scan — never
    // carried, never hashed, exactly as before.
    const entries = walkEntries(this.effectiveDir());
    return {
      files: entries.filter(isCarriedFile).map((e) => ({ rel: e.rel, abs: e.abs, sha: sha256Hex(readFileNoFollow(e.abs)) })),
      links: entries.filter((e) => e.kind === 'symlink'),
      others: entries.filter((e) => e.kind === 'other'),
      dirs: entries.filter((e) => e.kind === 'dir' && e.pruned === null).map((e) => e.rel),
    };
  }

  /** Every manifest `dir` — the registered skills. */
  private manifestDirs(m: SkillManifest): Set<string> {
    return new Set(Object.values(m.skills).map((e) => e.dir));
  }

  /**
   * Every skill dir that OWNS files (v3 §6): the registered dirs plus every dir holding a `SKILL.md`
   * on disk in `effective/` — ownership follows the FILESYSTEM, so a nested skill created by a
   * direct edit (unregistered until publish reports it) still owns its subtree: a parent's
   * edit/reset/replace never reaches it, and the parent's endpoint refuses its paths (codex round 2).
   */
  private ownershipDirs(m: SkillManifest): Set<string> {
    const dirs = this.manifestDirs(m);
    for (const dir of skillDirsOf(walkFiles(this.effectiveDir()))) dirs.add(dir);
    return dirs;
  }

  /** Plugin-relative paths of the skill's own files ON DISK in `base` (nested skill subtrees excluded). */
  private ownFilesIn(base: string, dir: string, skillDirs: ReadonlySet<string>): FileRecord[] {
    return walkFiles(this.pluginPath(dir, base), (rel) => skillDirs.has(`${dir}/${rel}`)).map((f) => ({
      rel: `${dir}/${f.rel}`,
      abs: f.abs,
    }));
  }

  /** Manifest file records that belong to the skill (nested skills — registered or on disk — excluded). */
  private ownRecords(m: SkillManifest, dir: string): Array<[string, SkillFileRecord]> {
    const dirs = this.ownershipDirs(m);
    return Object.entries(m.files).filter(([rel]) => owningSkillDir(rel, dirs) === dir);
  }

  /**
   * The baseline copy of a plugin-relative file, lstat-walked from the root (a symlinked baseline
   * ancestor is refused, never read through), or `null` when the baseline has no such file.
   */
  private baselineFile(m: SkillManifest, rel: string): string | null {
    const abs = this.containedBaseline(m.baseline, rel.split('/'));
    return this.entryExists(abs) && lstatSync(abs).isFile() ? abs : null;
  }

  /** `sha256` of the baseline copy of `rel`, or `null` when the baseline has none. */
  private baselineHashOf(m: SkillManifest, rel: string): string | null {
    const abs = this.baselineFile(m, rel);
    return abs === null ? null : sha256Hex(readFileNoFollow(abs));
  }

  private catalogView(m: SkillManifest): CatalogView {
    const view: Record<string, { core: boolean; enabled: boolean; dir: string }> = {};
    for (const [name, e] of Object.entries(m.skills)) view[name] = { core: e.core, enabled: e.enabled, dir: e.dir };
    return view;
  }

  /**
   * Rebuild the catalog from the file records: register skills for every `skills/**\/SKILL.md`
   * under its PATH-DERIVED name (a differing declared name is warned here and blocks at publish),
   * keep existing entries' state, recompute every content-derived field and the core closure.
   * Answers the recompute's refusals (a skill behind a symlink — `recomputeDerived`).
   */
  private rebuildCatalog(m: SkillManifest): SkillConflictFinding[] {
    const present = new Set(Object.entries(m.files).filter(([, r]) => r.effectiveHash !== null).map(([rel]) => rel));
    const dirs = skillDirsOf([...present].map((rel) => ({ rel })));
    const byDir = new Map(Object.entries(m.skills).map(([name, e]) => [e.dir, name]));
    for (const dir of [...dirs].sort()) {
      if (byDir.has(dir)) continue;
      const name = this.nameForDir(m, dir);
      if (name === null) continue;
      m.skills[name] = {
        dir,
        kind: 'module',
        core: false,
        portable: true,
        enabled: true,
        provenance: 'shipped',
        editedAt: null,
        upgradeAvailable: false,
        conflict: false,
        upstreamDir: null,
      };
      byDir.set(dir, name);
    }
    return this.recomputeDerived(m);
  }

  /**
   * The manifest key for a freshly discovered skill dir: ALWAYS the path-derived name (v3 §5 —
   * identity is one thing). A declared frontmatter name that differs is warned here and reported
   * as `name-mismatch` (blocking) at publish; two dirs deriving the same name (`a-b/c` and `a/b-c`)
   * cannot both be registered — the second is left for publish to report as `unregistered-skill`.
   * The `SKILL.md` is read CONTAINED (lstat-walked from the root; codex round 5): a dir behind a
   * link is warned and left unregistered, never read through.
   */
  private nameForDir(m: SkillManifest, dir: string): string | null {
    const derived = derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
    let skillMd: Buffer | null;
    try {
      skillMd = this.containedEffectiveBytes(`${dir}/SKILL.md`);
    } catch (err) {
      if (!(err instanceof SkillPathError)) throw err;
      this.warn(`[skills] ${dir}/SKILL.md is not reachable without crossing a symlink (${err.message}); not registered — publish reports it`);
      return null;
    }
    if (skillMd === null) return null; // a record without a regular file behind it — drift, reported at publish
    const parsed = parseFrontmatter(skillMd.toString('utf8'));
    if (!parsed.ok) {
      this.warn(`[skills] ${dir}/SKILL.md frontmatter does not parse (${parsed.reason}); keyed by the path-derived name ${derived} — publish blocks until it parses`);
    } else {
      const declared = parsed.fields['name'];
      if (declared !== undefined && declared !== '' && declared !== derived) {
        this.warn(`[skills] ${dir}/SKILL.md declares name ${JSON.stringify(declared)} but its path derives ${JSON.stringify(derived)}; keyed by the path-derived name — publish reports name-mismatch`);
      }
    }
    const taken = m.skills[derived];
    if (taken !== undefined) {
      this.warn(`[skills] ${dir} derives ${derived}, already registered at ${taken.dir}; not registered — publish reports it as unregistered`);
      return null;
    }
    return derived;
  }

  /** Every file record grouped by the skill dir that owns it (`null` = support), computed once per pass. */
  private recordsByOwner(m: SkillManifest): Map<string | null, Array<[string, SkillFileRecord]>> {
    const dirs = this.ownershipDirs(m);
    const out = new Map<string | null, Array<[string, SkillFileRecord]>>();
    for (const pair of Object.entries(m.files)) {
      const owner = owningSkillDir(pair[0], dirs);
      const list = out.get(owner);
      if (list === undefined) out.set(owner, [pair]);
      else list.push(pair);
    }
    return out;
  }

  /**
   * Recompute provenance / kind / portable / upgradeAvailable / conflict for every entry, then the
   * core closure. `conflict` is `upgradeAvailable` (a file the last refresh saw change on both
   * sides — a user DELETION counts as the user's side) or a refresh's name-collision flag — the
   * latter only meaningful while the skill is user-added (upstream shipped the name at another
   * dir); refresh clears and re-derives it.
   *
   * CONTAINED (codex round 5): every byte this reads — a skill's `SKILL.md`, every recorded file it
   * judges portability from — is reached by an lstat walk from the SKILLS ROOT through the skill
   * dir and every component below it, never by a bare join that would follow `effective/skills/
   * gamma -> /outside` because only the leaf was checked. A skill whose dir (or a file inside it)
   * crosses a link is SKIPPED — its derived fields keep their last values, nothing outside is read —
   * and the refusal is answered as a blocking `path-invalid` finding: publish/analyze report it
   * blocking; a mutation on ANOTHER skill carries it as a warning (that mutation did land).
   */
  private recomputeDerived(m: SkillManifest): SkillConflictFinding[] {
    const refused: SkillConflictFinding[] = [];
    const catalogMd = new Map<string, string>();
    const byOwner = this.recordsByOwner(m);
    const skillDirs = this.ownershipDirs(m);
    const bundleView = this.publishedBundleView(m, skillDirs);
    for (const [name, entry] of Object.entries(m.skills)) {
      const records = byOwner.get(entry.dir) ?? [];
      const userAdded = records.length > 0 && records.every(([, r]) => r.baselineHash === null);
      const pristine = records.every(([, r]) => r.baselineHash !== null && r.effectiveHash === r.baselineHash);
      entry.provenance = userAdded ? 'user-added' : pristine ? 'shipped' : 'override';
      const fileConflict = records.some(([, r]) => r.conflict);
      entry.upgradeAvailable = fileConflict;
      entry.conflict = fileConflict || (entry.conflict && userAdded);
      // The skill dir first — walked from the root — so a linked dir is ONE finding, not one per file.
      let skillDirAbs: string;
      try {
        skillDirAbs = this.containedEffective(entry.dir.split('/'));
      } catch (err) {
        refused.push(this.pathFinding(err, name, entry.dir));
        continue;
      }
      const below = (rel: string): Buffer | null => this.regularFileBytes(containedPath(skillDirAbs, rel.slice(entry.dir.length + 1).split('/')));
      let skillMd: Buffer | null;
      try {
        skillMd = below(`${entry.dir}/SKILL.md`);
      } catch (err) {
        refused.push(this.pathFinding(err, name, `${entry.dir}/SKILL.md`));
        continue;
      }
      let kind: SkillKind = 'module';
      if (skillMd !== null) {
        const text = skillMd.toString('utf8');
        catalogMd.set(name, text);
        const parsed = parseFrontmatter(text);
        if (parsed.ok) kind = skillKindOf(parsed.fields);
      }
      entry.kind = kind;
      // Judged from what is on disk as a REGULAR file reached without crossing a link: a recorded
      // file that vanished is drift (publish reports it; the mutation in progress must not die on
      // it); one that became a link, or sits behind one, is refused and reported — never read.
      // EVERY reason is collected (F-079), against the bundle the next publish would carry — so
      // the snapshot row re-derives to the same reasons at verify.
      const ctx = bundleView.contextFor(entry.dir);
      const hits: Array<PortabilityHit & { fileRel: string }> = [];
      for (const [rel, r] of records) {
        if (r.effectiveHash === null) continue;
        let buf: Buffer | null;
        try {
          buf = below(rel);
        } catch (err) {
          refused.push(this.pathFinding(err, name, rel));
          continue;
        }
        if (buf === null || looksBinary(buf)) continue;
        for (const hit of portabilityIssuesOf(buf.toString('utf8'), ctx(rel))) hits.push({ ...hit, fileRel: rel });
      }
      const reasons = portabilityReasonsOf(hits);
      entry.portable = reasons.length === 0;
      entry.portability = { portable: entry.portable, reasons, evidence: portabilityEvidenceOf(hits) };
    }
    // A DIRECTLY registered reference is core regardless of its readability (design v3.5 §5; codex
    // round 8): a skill a workflow names by `skill_ref` keeps `core: true` when its `SKILL.md` is
    // missing or symlink-refused — it is absent from `catalogMd`, so the closure alone would have
    // dropped it and `disable` would have committed against the downgraded flag. The closure's
    // `missing` set (a ref naming NO catalog entry) is reported by `validate` as `core-missing`.
    const registered = this.registeredRefs();
    const closure = coreClosure(registered, catalogMd);
    for (const [name, entry] of Object.entries(m.skills)) entry.core = closure.core.has(name) || registered.has(name);
    return refused;
  }

  /**
   * The portability validator's view of the bundle (F-079): what the NEXT publish would carry —
   * support files inside the closure and ENABLED skills' own files. A disabled skill's files, a
   * file outside the closure, a vanished record: not there. Judging against this universe (rather
   * than everything under `effective/`) is what lets `snapshotRowsProblem` re-derive the SAME
   * reasons from the generation alone — a `../` link into a disabled skill is a broken link
   * (`unresolved-ref` at publish), not a portability fact about a file the snapshot omits. The
   * judged skill's own files are always visible to it (own-directory links stay portable anyway),
   * and `extra` lets a write guard see the files it is about to land.
   */
  private publishedBundleView(
    m: SkillManifest,
    skillDirs: ReadonlySet<string>,
    extra: Readonly<Record<string, string>> = {},
  ): { contextFor: (skillDir: string) => (fileRel: string) => PortabilityContext } {
    const enabledDirs = new Set(Object.values(m.skills).filter((e) => e.enabled).map((e) => e.dir));
    const present = Object.entries(m.files).filter(([, r]) => r.effectiveHash !== null).map(([rel]) => rel);
    const visible = new Set<string>();
    const own = new Map<string, Set<string>>();
    for (const rel of present) {
      const owner = owningSkillDir(rel, skillDirs);
      if (owner === null) {
        if (inBundleClosure(rel)) visible.add(rel);
        continue;
      }
      if (enabledDirs.has(owner)) visible.add(rel);
      const list = own.get(owner);
      if (list === undefined) own.set(owner, new Set([rel]));
      else list.add(rel);
    }
    for (const rel of Object.keys(extra)) visible.add(rel);
    return {
      contextFor: (skillDir) => {
        const dirs = skillDirs.has(skillDir) ? skillDirs : new Set([...skillDirs, skillDir]);
        const mine = own.get(skillDir) ?? new Set<string>();
        const exists = (p: string): boolean => existsIn(visible, p) || existsIn(mine, p);
        return (fileRel) => ({ fileRel, skillDir, skillDirs: dirs, exists });
      },
    };
  }

  /** The recompute's refusals as WARNINGS — for a mutation that landed on another skill (the blocking form is publish's). */
  private recomputeWarnings(m: SkillManifest): SkillConflictFinding[] {
    return this.recomputeDerived(m).map((f) => ({ ...f, severity: 'warning' as const }));
  }

  /**
   * The bytes of the REGULAR file at plugin-relative `rel` in `effective/`, every component
   * lstat-walked from the skills root (`containedEffective`; a link anywhere on the way is a
   * `SkillPathError` the caller decides on — never a read through it), `null` when absent.
   */
  private containedEffectiveBytes(rel: string): Buffer | null {
    return this.regularFileBytes(this.containedEffective(rel.split('/')));
  }

  /**
   * The bytes of `abs` when it is a REGULAR file, `null` when absent or anything else. The leaf is
   * lstat'ed here; the PATH to it is the caller's business (`containedEffectiveBytes` /
   * `recomputeDerived` walk it from the root — a bare join is never enough, codex round 5).
   */
  private regularFileBytes(abs: string): Buffer | null {
    try {
      if (!lstatSync(abs).isFile()) return null;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null;
      throw err;
    }
    return readFileNoFollow(abs); // the entry lstat judged is the one read (v3.5 §3)
  }

  /** Whether the current baseline ships a skill at `dir` (a user-added skill has no baseline dir). */
  private hasBaselineDir(m: SkillManifest, dir: string): boolean {
    return this.baselineFile(m, `${dir}/SKILL.md`) !== null;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────────

  entryOf(name: string): SkillEntry {
    const entry = this.manifest().skills[name];
    if (entry === undefined) throw new UnknownSkillError(name);
    return entry;
  }

  listFiles(name: string): SkillFileTree {
    const m = this.manifest();
    const entry = m.skills[name];
    if (entry === undefined) throw new UnknownSkillError(name);
    this.assertSkillDirContained(entry.dir);
    const files = this.ownFilesIn(this.effectiveDir(), entry.dir, this.ownershipDirs(m)).map((f) => ({
      path: f.rel.slice(entry.dir.length + 1),
      size: statSync(f.abs).size,
      sha256: sha256Hex(readFileNoFollow(f.abs)),
      record: m.files[f.rel] ?? null,
    }));
    return { name, dir: entry.dir, enabled: entry.enabled, files };
  }

  /**
   * Contain a skill-relative path (the URL wildcard as Fastify hands it — ALREADY decoded once, never
   * decoded again; codex round 5): validate, refuse a path a NESTED skill owns (registered or merely
   * present on disk), lstat-walk FROM THE ROOT through the skill dir refusing symlinks. Returns the
   * on-disk target in `effective/` and both spellings of the path.
   */
  resolveSkillFile(name: string, rawRel: string): { abs: string; rel: string; pluginRel: string } {
    const m = this.manifest();
    const entry = m.skills[name];
    if (entry === undefined) throw new UnknownSkillError(name);
    const segments = validateRelSegments(rawRel);
    const rel = segments.join('/');
    const pluginRel = `${entry.dir}/${rel}`;
    const owner = owningSkillDir(pluginRel, this.ownershipDirs(m));
    if (owner !== entry.dir) {
      const ownerName = Object.entries(m.skills).find(([, e]) => e.dir === owner)?.[0];
      throw new SkillPathError(
        'nested-skill',
        ownerName === undefined
          ? `${rel} belongs to the nested skill at ${owner} (a SKILL.md on disk the manifest has not registered) — register it with POST /skills or remove it; it is not addressed through ${name}`
          : `${rel} belongs to the nested skill ${ownerName} (${owner}) — address it through that skill`,
      );
    }
    const abs = this.containedEffective([...entry.dir.split('/'), ...segments]);
    return { abs, rel, pluginRel };
  }

  /**
   * Contain a root support path: not under `skills/` (those belong to a skill's endpoint), not a
   * name the store itself owns (`RESERVED_SUPPORT_NAMES`), INSIDE the bundle closure (the ONE
   * allowlist — bundle.ts `inBundleClosure`; codex round 6), no symlinks.
   */
  resolveSupportFile(rawRel: string): { abs: string; rel: string } {
    const segments = validateRelSegments(rawRel);
    const rel = segments.join('/');
    const head = segments[0] ?? '';
    if (head === SKILLS_SUBDIR) {
      throw new SkillPathError(
        'nested-skill',
        `${rel} is under ${SKILLS_SUBDIR}/ — skill files are addressed through /skills/:name/files`,
      );
    }
    if (RESERVED_SUPPORT_NAMES.has(head)) {
      throw new SkillPathError(
        'reserved',
        `${rel}: ${head} is reserved — the store generates it at publish (${SNAPSHOT_MANIFEST_FILENAME}, ${VIEWS_DIRNAME}/), links it (${VENV_LINKNAME}, ${CURRENT_LINKNAME}) or keeps its state in it (${MANIFEST_FILENAME}); a support file by that name would be overwritten or break the snapshot`,
      );
    }
    // The bundle closure is the ONE allowlist (bundle.ts; codex round 6): a support path the seed
    // would never copy (hooks/, tests/, the site, a stray docs/ page, the scripts/ dev tooling) is
    // not a support file the store manages — it cannot be added or read through the API, and a
    // snapshot never ships it. A write answers the 2xx `blocked` `outside-closure` envelope.
    if (!inBundleClosure(rel)) {
      throw new SkillPathError(
        'outside-closure',
        `${rel} is outside the bundle closure — the support tree a snapshot carries is exactly what the seed copies (${BUNDLE_CLOSURE_SPELLING}); hooks, tests, the site and everything else a plugin checkout holds never ride a snapshot`,
      );
    }
    return { abs: this.containedEffective(segments), rel };
  }

  /** A typed, capped read of one of the skill's files (`side: 'baseline'` reads the shipped copy, contained the same way). */
  async readFile(name: string, rawRel: string, side: ReadSide = 'effective'): Promise<SkillReadResult> {
    const target = this.resolveSkillFile(name, rawRel);
    if (side === 'effective') return this.typedRead(target.pluginRel, target.abs);
    // The baseline side of a skill a refresh HELD BACK — upstream ships a skill under this name at
    // ANOTHER directory (`upstreamDir`, codex round 9) — is that upstream directory in the current
    // baseline, so the two sides of the collision are actually comparable; otherwise the skill's own
    // dir. `path` in the answer names the plugin-relative file actually read.
    const m = this.manifest();
    const entry = m.skills[name];
    if (entry === undefined) throw new UnknownSkillError(name);
    const baseDir = entry.upstreamDir ?? entry.dir;
    const pluginRel = `${baseDir}/${target.rel}`;
    return this.typedRead(pluginRel, this.containedBaseline(m.baseline, pluginRel.split('/')));
  }

  async readSupport(rawRel: string, side: ReadSide = 'effective'): Promise<SkillReadResult> {
    const target = this.resolveSupportFile(rawRel);
    const abs = side === 'effective' ? target.abs : this.containedBaseline(this.manifest().baseline, target.rel.split('/'));
    return this.typedRead(target.rel, abs);
  }

  /**
   * The capped read as the wire spells it: `content` is `null` — not `""` — when the file is binary.
   * The leaf the containment walk judged is lstat'ed here and the read opens it `O_NOFOLLOW` with a
   * dev/ino identity check against that lstat (v3.5 §3): a link swapped in between the walk and the
   * open is refused, never served.
   */
  private async typedRead(path: string, abs: string): Promise<SkillReadResult> {
    const before = lstatSync(abs);
    if (!before.isFile()) throw new NotARegularFileError(abs);
    const read = await readFileCapped(abs, { noFollow: true, identity: { dev: before.dev, ino: before.ino } });
    return { path, content: read.binary ? null : read.content, size: read.size, truncated: read.truncated, binary: read.binary };
  }

  // ── Mutations ─────────────────────────────────────────────────────────────────────────────

  private result(m: SkillManifest, name: string | null, findings: SkillConflictFinding[]): SkillMutationResult {
    const entry = name === null ? undefined : m.skills[name];
    return entry === undefined || name === null
      ? { verdict: verdictOf(findings), findings, revision: m.revision }
      : { verdict: verdictOf(findings), findings, revision: m.revision, skill: { name, ...entry } };
  }

  private blocked(m: SkillManifest, findings: SkillConflictFinding[]): SkillMutationResult {
    return { verdict: 'blocked', findings, revision: m.revision };
  }

  /**
   * A containment failure on a WRITE is a guard result, not a transport error (design v3 §API:
   * "guard results ALWAYS return 2xx {verdict, findings, revision}"). Anything that is not a
   * `SkillPathError` is rethrown.
   */
  private pathFinding(err: unknown, skill: string | null, file: string): SkillConflictFinding {
    if (!(err instanceof SkillPathError)) throw err;
    if (err.reason === 'outside-closure') {
      return finding(
        'outside-closure',
        'blocking',
        `the bundle closure (${BUNDLE_CLOSURE_SPELLING}) is the ONE allowlist of what the seed copies and a snapshot may carry; a support file outside it would ship a tree the plugin contract excludes — nothing was written`,
        err.message,
        { skill, file },
      );
    }
    const explanation =
      err.reason === 'symlink'
        ? 'the skills root never follows symlinks — a link on the path (the skill directory itself, a child directory, or a baseline ancestor included) would redirect the operation outside the store'
        : err.reason === 'nested-skill'
          ? 'a nested skill owns its own files; address it through that skill'
          : err.reason === 'reserved'
            ? 'the name is owned by the store at that level (snapshot metadata, the manifest, the current link, the generated views, the shared env link)'
            : 'the path must be a normalized skill-relative POSIX path that stays inside the skill directory';
    return finding('path-invalid', 'blocking', explanation, err.message, { skill, file });
  }

  /** Re-hash the skill's own files on disk into the records (absent baseline files stay as `effectiveHash: null`). */
  private refreshRecords(m: SkillManifest, dir: string): void {
    const onDisk = new Map(this.ownFilesIn(this.effectiveDir(), dir, this.ownershipDirs(m)).map((f) => [f.rel, f.abs]));
    for (const [rel, record] of this.ownRecords(m, dir)) {
      const abs = onDisk.get(rel);
      if (abs === undefined) {
        if (record.baselineHash === null) delete m.files[rel];
        else record.effectiveHash = null;
      } else {
        record.effectiveHash = sha256Hex(readFileNoFollow(abs));
        onDisk.delete(rel);
      }
    }
    for (const [rel, abs] of onDisk) {
      m.files[rel] = {
        baselineHash: this.baselineHashOf(m, rel),
        effectiveHash: sha256Hex(readFileNoFollow(abs)),
        lastPublishedHash: null,
        conflict: false,
      };
    }
  }

  /** The named entry, or `UnknownSkillError` — checked BEFORE the revision: a missing resource is a 404, not a stale-client 409. */
  private requireEntry(m: SkillManifest, name: string, expectedRevision: number): SkillEntry {
    const entry = m.skills[name];
    if (entry === undefined) throw new UnknownSkillError(name);
    this.assertRevision(m, expectedRevision);
    return entry;
  }

  /**
   * Enable — with the content + containment guards a write gets (codex round 2: enable used to
   * flip the flag blind): the skill dir and its `SKILL.md` are lstat-walked from the root (a
   * symlinked skill is `path-invalid`), the `SKILL.md` must exist (`missing-skill-md`), parse
   * (`frontmatter-invalid`) and declare the path-derived name (`name-mismatch`) — a skill that
   * would block the next publish is not enabled.
   */
  enable(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const skillMdRel = `${entry.dir}/SKILL.md`;
    let skillMdAbs: string;
    try {
      skillMdAbs = this.containedEffective(skillMdRel.split('/'));
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, skillMdRel)]);
    }
    // The walk above ended at the leaf without crossing a link: an existing entry here is the real file.
    const skillMd = this.entryExists(skillMdAbs) && lstatSync(skillMdAbs).isFile() ? readFileNoFollow(skillMdAbs).toString('utf8') : undefined;
    const recompute = this.recomputeWarnings(m); // `core` from the live registered refs, never the cached entry
    const findings = [...frontmatterGuard(skillMd, name, { isCore: entry.core, file: skillMdRel }), ...recompute];
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    if (entry.enabled) return this.result(m, name, findings);
    entry.enabled = true;
    // Enablement moves the bundle the validator judges against (F-079): another skill's `../`
    // link into this one now resolves. Re-derive so the manifest's `portability` stays honest
    // between publishes (refusals were reported by the recompute above).
    this.recomputeDerived(m);
    this.commit(m);
    return this.result(m, name, findings);
  }

  /** Disable — core membership is RECOMPUTED here (registered refs are read at use time), never trusted from the cached entry. */
  disable(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const recompute = this.recomputeWarnings(m);
    const findings = [...compact([coreDisableGuard(name, entry)]), ...recompute];
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    if (!entry.enabled) return this.result(m, name, findings);
    entry.enabled = false;
    // See `enable`: the disabled skill's files leave the validator's bundle view.
    this.recomputeDerived(m);
    this.commit(m);
    return this.result(m, name, findings);
  }

  /**
   * Restore the skill's own files from the current baseline (mode bits ride the copy). `enabled`
   * is untouched by design. Both sides are walked from the root (a symlinked baseline ancestor is
   * refused, never imported from; codex round 2).
   *
   * Restore candidates EXCLUDE every path a nested `SKILL.md` owns in the EFFECTIVE tree — not only
   * one present in the baseline (codex round 3): a child created directly under the parent
   * (`alpha/refs/SKILL.md`) owns its files even though the baseline has none, so a parent reset must
   * not restore baseline bytes over the child's. And the reset PREFLIGHTS every destination
   * (containment, no-follow) and STAGES the baseline bytes into a temp dir under the root BEFORE it
   * removes a single effective file, so a blocked reset (a symlinked `alpha/refs`) mutates nothing
   * — the `SymlinkComponentError` maps to the 2xx `blocked` envelope, never an escaped 500 that
   * already deleted the parent's SKILL.md (codex round 3).
   */
  reset(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    let baseSkillDir: string;
    try {
      this.assertSkillDirContained(entry.dir);
      baseSkillDir = this.containedBaseline(m.baseline, entry.dir.split('/'));
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, entry.dir)]);
    }
    // "User-added" is what the MANIFEST says (no record of the skill carries a baseline hash), never
    // what happens to be on disk (codex round 7): a baseline dir that vanished under a recorded skill
    // is a corrupt baseline, reported below by name — not a skill without a baseline.
    const records = new Map(this.ownRecords(m, entry.dir));
    const findings = compact([noBaselineGuard(name, [...records.values()].every((r) => r.baselineHash === null))]);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    const effective = this.effectiveDir();
    const owned = this.ownershipDirs(m); // effective + manifest ownership — a nested child is its own
    // Restore candidates from the baseline, pruning every subtree a nested skill owns in EFFECTIVE.
    const fresh = walkFiles(baseSkillDir, (rel) => owned.has(`${entry.dir}/${rel}`)).map((f) => ({ rel: `${entry.dir}/${f.rel}`, abs: f.abs }));
    const own = this.ownFilesIn(effective, entry.dir, owned);
    // The baseline is content-addressed (codex round 7): every file about to be restored must hash
    // to the record the manifest holds for it, and every recorded baseline file of the skill must be
    // there — a modified, planted or removed baseline file is `baseline-corrupt`, nothing written.
    const freshRels = new Set(fresh.map((f) => f.rel));
    for (const f of fresh) {
      const record = records.get(f.rel);
      const actual = sha256Hex(readFileNoFollow(f.abs));
      if (record === undefined || record.baselineHash === null) {
        return this.blocked(m, [this.baselineCorruptFinding(name, f.rel, `${BASELINE_DIRNAME}/${m.baseline}/${f.rel} is not a recorded baseline file of ${name} — planted`)]);
      }
      if (record.baselineHash !== actual) {
        return this.blocked(m, [this.baselineCorruptFinding(name, f.rel, `${BASELINE_DIRNAME}/${m.baseline}/${f.rel} hashes to ${actual}, the manifest recorded ${record.baselineHash} — modified`)]);
      }
    }
    for (const [rel, record] of records) {
      if (record.baselineHash !== null && !freshRels.has(rel)) {
        return this.blocked(m, [this.baselineCorruptFinding(name, rel, `${BASELINE_DIRNAME}/${m.baseline}/${rel} is recorded in the manifest but missing from the baseline — removed`)]);
      }
    }
    // Preflight: every destination path — the files to restore AND the files to remove — must be
    // symlink-free from the root BEFORE anything is removed; a refusal is a blocked envelope.
    const staging = join(this.rootDir, `${STAGING_PREFIX}reset-${randomBytes(6).toString('hex')}`);
    const stagedDir = join(staging, 'new');
    let place: Array<{ src: string; dest: string }>;
    try {
      for (const f of own) this.containedEffective(f.rel.split('/'));
      place = fresh.map((f) => ({ src: join(stagedDir, ...f.rel.split('/')), dest: this.containedEffective(f.rel.split('/')) }));
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, entry.dir)]);
    }
    // Stage the baseline bytes under the root (owner-write restored: the baseline is locked, the
    // operator's copies are theirs to edit), then the park-and-place transaction (`swapStaged`, codex
    // round 6) and the manifest half under `commitSwap` (codex round 7): a failure anywhere after the
    // swap — the records, the validated manifest write, the rename into place — rolls the content
    // back from the parked originals, so the skill is byte-for-byte what it was and the revision
    // unchanged.
    let swap: { handle: SwapHandle } | { finding: SkillConflictFinding };
    try {
      copyFiles(fresh, stagedDir);
      this.restoreOwnerWrite(place.map((p) => p.src));
      // Re-walked and re-hashed against the records the sources were verified with (v3.5 §3).
      const stagedProblem = this.stagedTreeProblem(stagedDir, new Map(fresh.map((f) => [f.rel, records.get(f.rel)?.baselineHash ?? ''])));
      if (stagedProblem !== null) {
        removeTreeForce(staging);
        return this.blocked(m, [this.stagedTreeFinding(name, entry.dir, stagedProblem)]);
      }
      swap = this.swapStaged(name, entry.dir, staging, own, place);
    } catch (err) {
      removeTreeForce(staging);
      // A source swapped for a link between the walk and the copy is refused, never copied (v3.5 §3).
      if (err instanceof EntrySwappedError || err instanceof SymlinkComponentError) return this.blocked(m, [this.stagedTreeFinding(name, entry.dir, err.message)]);
      throw err;
    }
    if ('finding' in swap) return this.blocked(m, [swap.finding]);
    this.commitSwap(swap.handle, m, () => {
      for (const [rel, record] of this.ownRecords(m, entry.dir)) {
        if (record.baselineHash === null) delete m.files[rel];
        else {
          record.effectiveHash = record.baselineHash;
          record.conflict = false;
        }
      }
      entry.editedAt = null;
      entry.conflict = false;
      findings.push(...this.recomputeWarnings(m));
    });
    return this.result(m, name, findings);
  }

  /** Write one file inside the skill (containment via `resolveSkillFile` → a `blocked` envelope on refusal); guards on SKILL.md + support paths. */
  writeFile(name: string, rawRel: string, content: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    let target: { abs: string; rel: string; pluginRel: string };
    try {
      target = this.resolveSkillFile(name, rawRel);
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, rawRel)]);
    }
    const findings = this.putGuards(m, name, entry, target.rel, content);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    // One file, the same transaction as every multi-file swap (codex round 7): staged, the existing
    // file parked, placed, and committed WITH the manifest — a failed manifest commit rolls it back.
    const swap = this.stageSingleFile(name, target.pluginRel, target.abs, content);
    if ('finding' in swap) return this.blocked(m, [swap.finding]);
    this.commitSwap(swap.handle, m, () => {
      entry.editedAt = this.now();
      this.refreshRecords(m, entry.dir);
      findings.push(...this.recomputeWarnings(m));
    });
    return this.result(m, name, findings);
  }

  /**
   * Stage ONE file for the park-and-place transaction (codex round 7): the content is written under
   * `staging/new` (an existing regular file's mode bits carried over), the existing file — if any —
   * is parked, the staged file placed. `commitSwap` then commits the manifest or rolls this back.
   */
  private stageSingleFile(skill: string | null, rel: string, dest: string, content: string): { handle: SwapHandle } | { finding: SkillConflictFinding } {
    const staging = join(this.rootDir, `${STAGING_PREFIX}write-${randomBytes(6).toString('hex')}`);
    const src = join(staging, 'new', ...rel.split('/'));
    const existing = lstatOrNull(dest);
    const current = existing !== null && existing.isFile() ? existing : null;
    try {
      writeFileAtomic(src, content, current === null ? {} : { mode: current.mode & 0o777 });
    } catch (err) {
      removeTreeForce(staging);
      throw err;
    }
    const stagedProblem = this.stagedTreeProblem(join(staging, 'new'), new Map([[rel, sha256Hex(Buffer.from(content, 'utf8'))]]));
    if (stagedProblem !== null) {
      removeTreeForce(staging);
      return { finding: this.stagedTreeFinding(skill, rel, stagedProblem) };
    }
    return this.swapStaged(skill, rel, staging, current === null ? [] : [{ rel, abs: dest }], [{ src, dest }]);
  }

  /** Write one root support file (`scripts/`, `schemas/`, `.claude-plugin/`, …) — always a warning. */
  writeSupport(rawRel: string, content: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    this.assertRevision(m, expectedRevision);
    let target: { abs: string; rel: string };
    try {
      target = this.resolveSupportFile(rawRel);
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, null, rawRel)]);
    }
    const findings = [
      finding(
        'support-file-edit',
        'warning',
        'root support files (scripts, schemas, the plugin manifest) back the behavior of every skill that resolves them — an edit here changes what skills DO across the whole catalog',
        `edit: ${target.rel}`,
        { file: target.rel },
      ),
    ];
    const swap = this.stageSingleFile(null, target.rel, target.abs, content);
    if ('finding' in swap) return this.blocked(m, [swap.finding]);
    this.commitSwap(swap.handle, m, () => {
      const sha = sha256Hex(Buffer.from(content, 'utf8'));
      const record = m.files[target.rel];
      if (record === undefined) {
        m.files[target.rel] = {
          baselineHash: this.baselineHashOf(m, target.rel),
          effectiveHash: sha,
          lastPublishedHash: null,
          conflict: false,
        };
      } else {
        record.effectiveHash = sha;
      }
    });
    return this.result(m, null, findings);
  }

  /**
   * Every destination of a multi-file write, lstat-walked from the ROOT (the skill dir AND every
   * component below it): a symlinked child directory inside the skill would otherwise redirect a
   * descendant write outside the store (codex round 2: `gamma/link -> /outside` + `link/victim.txt`).
   * And every destination is checked for an entry OF THE OTHER KIND already standing there (codex
   * round 5): a key that names an existing directory (one the swap cannot clear — it holds anything
   * but the skill's own files and empty dirs), or a key whose would-be parent is an existing NON-own
   * regular file, cannot land; refused here, BEFORE any mutation, so the ENOTDIR/EISDIR the
   * placement would hit never happens after the old files are gone. Answers the blocking
   * `path-invalid` finding for the first refused path, or the resolved targets.
   */
  private containedDestinations(
    name: string,
    dir: string,
    files: Readonly<Record<string, string>>,
    own: ReadonlyArray<FileRecord>,
  ): { targets: Array<{ rel: string; abs: string; text: string }> } | { finding: SkillConflictFinding } {
    const targets: Array<{ rel: string; abs: string; text: string }> = [];
    const ownAbs = new Set(own.map((f) => f.abs));
    const kindConflict = (rel: string, evidence: string): { finding: SkillConflictFinding } => ({
      finding: finding(
        'path-invalid',
        'blocking',
        'a files map lays each key out as a regular file; an entry of the other kind already standing on that path (a directory where the file goes, a file where a parent directory goes) cannot be replaced by it — nothing was changed',
        evidence,
        { skill: name, file: rel },
      ),
    });
    for (const [rel, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      let abs: string;
      try {
        abs = this.containedEffective([...dir.split('/'), ...rel.split('/')]);
      } catch (err) {
        return { finding: this.pathFinding(err, name, rel) };
      }
      // The walk ended without crossing a link, so an existing entry here is real. A DIRECTORY at
      // the destination survives the replace unless it holds nothing but own files / empty dirs.
      const st = lstatOrNull(abs);
      if (st !== null && st.isDirectory() && !this.clearableDir(abs, ownAbs)) {
        return kindConflict(rel, `${rel} names an existing directory in ${dir} that is not made of the skill's own files alone`);
      }
      if (st !== null && !st.isDirectory() && !st.isFile()) {
        return kindConflict(rel, `${rel} names an existing entry in ${dir} that is neither a file nor a directory`);
      }
      // A would-be PARENT that exists as a non-directory (a regular file the replace does not remove) blocks the child.
      const segments = rel.split('/');
      let parent = this.pluginPath(dir);
      for (let i = 0; i < segments.length - 1; i += 1) {
        parent = join(parent, segments[i] as string);
        const pst = lstatOrNull(parent);
        if (pst === null) break; // nothing below exists yet — the write creates it
        if (!pst.isDirectory()) {
          if (ownAbs.has(parent)) break; // an own file the swap parks first — the directory can then be made
          return kindConflict(rel, `${rel} needs ${segments.slice(0, i + 1).join('/')} as a directory, but a file the replace does not remove stands there`);
        }
      }
      targets.push({ rel, abs, text });
    }
    return { targets };
  }

  /** Whether a directory holds nothing but the skill's own regular files (removed by the swap) and empty subdirectories. */
  private clearableDir(dir: string, ownAbs: ReadonlySet<string>): boolean {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!this.clearableDir(abs, ownAbs)) return false;
        continue;
      }
      if (!entry.isFile() || !ownAbs.has(abs)) return false;
    }
    return true;
  }

  /**
   * The atomic heart of `add` and `replace` (codex round 5): the replacement is WRITTEN in full into
   * a staging dir under the root, THEN the skill's own files are parked and the staged files placed
   * by the park-and-place transaction every multi-file swap shares (`swapStaged` — reset and refresh
   * go through the same one, codex round 6). Any failure ROLLS BACK: the skill is byte-for-byte
   * what it was, the revision unchanged. The removal used to come first, so a placement that failed
   * (`x` a file, `x/y` needing it as a directory) had already destroyed the notes it could not replace.
   */
  private swapOwnFiles(
    name: string,
    dir: string,
    own: ReadonlyArray<FileRecord>,
    targets: ReadonlyArray<{ rel: string; abs: string; text: string }>,
    modes: ReadonlyMap<string, number>,
  ): { handle: SwapHandle } | { finding: SkillConflictFinding } {
    const staging = join(this.rootDir, `${STAGING_PREFIX}swap-${randomBytes(6).toString('hex')}`);
    const stagedDir = join(staging, 'new');
    let place: Array<{ src: string; dest: string }>;
    try {
      // The whole replacement lands in staging first — a write failure here touches nothing live.
      place = targets.map((t) => {
        const src = join(stagedDir, ...t.rel.split('/'));
        const mode = modes.get(`${dir}/${t.rel}`);
        writeFileAtomic(src, t.text, mode === undefined ? {} : { mode });
        return { src, dest: t.abs };
      });
    } catch (err) {
      removeTreeForce(staging);
      throw err;
    }
    // Re-walked and re-hashed against the texts just written (v3.5 §3) before a single rename.
    const stagedProblem = this.stagedTreeProblem(stagedDir, new Map(targets.map((t) => [t.rel, sha256Hex(Buffer.from(t.text, 'utf8'))])));
    if (stagedProblem !== null) {
      removeTreeForce(staging);
      return { finding: this.stagedTreeFinding(name, dir, stagedProblem) };
    }
    return this.swapStaged(name, dir, staging, own, place);
  }

  /**
   * The park-and-place transaction EVERY content mutation goes through — replace/add (codex round
   * 5), reset and refresh-baseline (codex round 6), the single-file write (codex round 7). `park` is
   * every existing file the swap removes OR overwrites; `place` every staged source (already written
   * under `staging/new`) and its destination.
   *
   *   1. park: every `park` file is RENAMED into `staging/old` (never deleted), then the directories
   *      it left empty are pruned up to `effective/`;
   *   2. place: every staged file is renamed into its destination (a destination that is now an
   *      empty directory tree is removed first, parents are created).
   *
   * Every step is a same-filesystem rename. A failure INSIDE the swap rolls back — what was placed
   * is removed and its parents pruned, what was parked is renamed back (mode bits ride the rename)
   * — removes the staging and answers a blocking `path-invalid` finding: the tree is byte-for-byte
   * what it was. A swap that LANDED answers a `SwapHandle` whose parked originals stay under the
   * staging until `commitSwap` either committed the manifest or rolled the content back (codex round
   * 7): content and revision move together or not at all.
   */
  private swapStaged(
    skill: string | null,
    label: string,
    staging: string,
    park: ReadonlyArray<FileRecord>,
    place: ReadonlyArray<{ src: string; dest: string }>,
  ): { handle: SwapHandle } | { finding: SkillConflictFinding } {
    const effective = this.effectiveDir();
    const parkedDir = join(staging, 'old');
    const parked: Array<{ from: string; to: string }> = [];
    const placed: string[] = [];
    const rollback = (): void => {
      for (const d of placed) rmSync(d, { force: true });
      // Prune the parents of EVERY destination, not only the placed ones: a failing placement had
      // already created its parent directories before its rename failed.
      for (const p of place) pruneEmptyDirs(dirname(p.dest), effective);
      for (const { from, to } of parked) {
        mkdirSync(dirname(from), { recursive: true });
        renameSync(to, from);
      }
    };
    try {
      for (const f of park) {
        const to = join(parkedDir, ...f.rel.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        renameSync(f.abs, to);
        parked.push({ from: f.abs, to });
      }
      for (const f of park) pruneEmptyDirs(dirname(f.abs), effective);
      for (const p of place) {
        this.removeEmptyDirTree(p.dest);
        mkdirSync(dirname(p.dest), { recursive: true });
        renameSync(p.src, p.dest);
        placed.push(p.dest);
      }
      return { handle: { rollback, dispose: () => removeTreeForce(staging) } };
    } catch (err) {
      rollback();
      removeTreeForce(staging);
      const code = errnoCode(err);
      return {
        finding: finding(
          'path-invalid',
          'blocking',
          'the files could not be laid out on disk (a path collided with an entry of the other kind, or the filesystem refused a rename mid-swap); the swap was rolled back — every parked file is back byte-for-byte, nothing was written, the revision is unchanged',
          `${code === undefined ? 'error' : code}: ${err instanceof Error ? err.message : String(err)}`,
          { skill, file: label },
        ),
      };
    }
  }

  /**
   * The manifest half of a mutation whose content swap already LANDED (codex round 7): `finish`
   * updates the in-memory manifest (records re-hashed from the placed bytes, derived fields
   * recomputed from them — which is why it runs after the swap), then the manifest is validated and
   * written (`commit`: `manifest.json.tmp-…` + rename). If ANY of that fails — a record refresh, the
   * schema, the temp write, the rename into place — the content swap is rolled back from the parked
   * originals, so `effective/` and `manifest.json` move together or not at all: the request fails
   * with the error, the content is byte-for-byte what it was, and the persisted revision is
   * unchanged (it was never reusable against changed content). The parked originals are released
   * only after the commit landed or the rollback ran.
   */
  private commitSwap(handle: SwapHandle, m: SkillManifest, finish: () => void): void {
    const revision = m.revision;
    try {
      finish();
      this.commit(m);
    } catch (err) {
      handle.rollback();
      m.revision = revision;
      throw err;
    } finally {
      handle.dispose();
    }
  }

  /** Remove `path` when it is a directory tree holding only (empty) directories; anything else is left alone. */
  private removeEmptyDirTree(path: string): void {
    const st = lstatOrNull(path);
    if (st === null || !st.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) return;
      this.removeEmptyDirTree(join(path, entry.name));
    }
    if (readdirSync(path).length === 0) rmSync(path, { recursive: false, force: true });
  }

  /** Add a user skill at `skills/<name minus the prefix>` — staged, then swapped in (`swapOwnFiles`). */
  add(name: string, files: Readonly<Record<string, string>>, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    this.assertRevision(m, expectedRevision);
    const findings = this.addGuards(m, name, files);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    const dir = dirForUserSkill(name);
    try {
      this.assertSkillDirContained(dir);
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, dir)]);
    }
    const destinations = this.containedDestinations(name, dir, files, []);
    if ('finding' in destinations) return this.blocked(m, [destinations.finding]);
    const swap = this.swapOwnFiles(name, dir, [], destinations.targets, new Map());
    if ('finding' in swap) return this.blocked(m, [swap.finding]);
    this.commitSwap(swap.handle, m, () => {
      m.skills[name] = {
        dir,
        kind: 'module',
        core: false,
        portable: true,
        enabled: true,
        provenance: 'user-added',
        editedAt: this.now(),
        upgradeAvailable: false,
        conflict: false,
        upstreamDir: null,
      };
      this.refreshRecords(m, dir);
      findings.push(...this.recomputeWarnings(m));
    });
    return this.result(m, name, findings);
  }

  /**
   * Replace the skill's own files wholesale (nested skills — registered or on disk — untouched); an
   * existing file's mode bits survive the replace. EVERY destination is lstat-walked from the root
   * and checked against entries of the other kind BEFORE the first byte moves, and the swap itself
   * is staged + rolled back on failure (`swapOwnFiles`): a refused or failed replace changes nothing.
   */
  replace(name: string, files: Readonly<Record<string, string>>, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const findings = this.replaceGuards(m, name, entry, files);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    try {
      this.assertSkillDirContained(entry.dir);
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, entry.dir)]);
    }
    const effective = this.effectiveDir();
    const own = this.ownFilesIn(effective, entry.dir, this.ownershipDirs(m));
    const destinations = this.containedDestinations(name, entry.dir, files, own);
    if ('finding' in destinations) return this.blocked(m, [destinations.finding]);
    const modes = new Map(own.map((f) => [f.rel, lstatSync(f.abs).mode & 0o777]));
    const swap = this.swapOwnFiles(name, entry.dir, own, destinations.targets, modes);
    if ('finding' in swap) return this.blocked(m, [swap.finding]);
    this.commitSwap(swap.handle, m, () => {
      entry.editedAt = this.now();
      this.refreshRecords(m, entry.dir);
      findings.push(...this.recomputeWarnings(m));
    });
    return this.result(m, name, findings);
  }

  private putGuards(m: SkillManifest, name: string, entry: SkillEntry, rel: string, content: string): SkillConflictFinding[] {
    const out: SkillConflictFinding[] = [];
    if (rel === 'SKILL.md') out.push(...frontmatterGuard(content, name, { isCore: entry.core, file: `${entry.dir}/SKILL.md` }));
    out.push(...compact([nestedSkillCreateGuard(rel, name), supportFileGuard(rel, name)]));
    if (entry.portable) out.push(...nonPortableGuard({ [rel]: content }, name, this.writeContext(m, entry.dir, { [rel]: content })));
    return out;
  }

  /**
   * The portability validator's context for a write of `files` (skill-relative keys) into
   * `skillDir`: the would-be bundle plus the files about to land, keyed by the skill-relative
   * path the guard iterates.
   */
  private writeContext(m: SkillManifest, skillDir: string, files: Readonly<Record<string, string>>): (rel: string) => PortabilityContext {
    const extra: Record<string, string> = {};
    for (const [rel, content] of Object.entries(files)) extra[`${skillDir}/${rel}`] = content;
    const ctx = this.publishedBundleView(m, this.ownershipDirs(m), extra).contextFor(skillDir);
    return (rel) => ctx(`${skillDir}/${rel}`);
  }

  private filesGuards(m: SkillManifest, name: string, dir: string, files: Readonly<Record<string, string>>): SkillConflictFinding[] {
    const out: SkillConflictFinding[] = [];
    const keys = Object.keys(files).sort();
    for (const rel of keys) {
      try {
        const norm = validateRelSegments(rel).join('/');
        if (norm !== rel) {
          out.push(finding('path-invalid', 'blocking', 'file paths are normalized skill-relative POSIX paths', `${JSON.stringify(rel)} is not normalized (expected ${JSON.stringify(norm)})`, { skill: name, file: rel }));
        }
      } catch (err) {
        if (!(err instanceof SkillPathError)) throw err;
        out.push(finding('path-invalid', 'blocking', 'the path must stay inside the skill directory', err.message, { skill: name, file: rel }));
      }
      out.push(...compact([nestedSkillCreateGuard(rel, name), supportFileGuard(rel, name)]));
    }
    // Incompatible paths within ONE map (codex round 5): a key that is also a directory prefix of
    // another (`x` and `x/y`) cannot both land — the first makes `x` a file, the second needs it as
    // a directory. Refused here, before any mutation, whichever of add/replace carries the map.
    const ancestors = new Map<string, string>();
    for (const rel of keys) {
      const segments = rel.split('/');
      for (let i = 1; i < segments.length; i += 1) {
        const prefix = segments.slice(0, i).join('/');
        if (!ancestors.has(prefix)) ancestors.set(prefix, rel);
      }
    }
    for (const rel of keys) {
      const under = ancestors.get(rel);
      if (under === undefined) continue;
      out.push(
        finding(
          'path-invalid',
          'blocking',
          'a files map lays each key out as a regular file, so a key cannot also be a directory on the way to another key — the two cannot both exist on disk',
          `${JSON.stringify(rel)} is a file AND a directory prefix of ${JSON.stringify(under)}`,
          { skill: name, file: rel },
        ),
      );
    }
    out.push(...nonPortableGuard(files, name, this.writeContext(m, dir, files)));
    return out;
  }

  private addGuards(m: SkillManifest, name: string, files: Readonly<Record<string, string>>): SkillConflictFinding[] {
    const out = compact([nameGuard(name)]);
    if (out.length > 0) return out; // a malformed name has no dir to derive further guards from
    out.push(...compact([collisionGuard(this.catalogView(m), name)]));
    const dir = dirForUserSkill(name);
    if (existsSync(this.pluginPath(dir)) || this.hasBaselineDir(m, dir)) {
      out.push(finding('name-collision', 'blocking', 'a directory already exists where this skill would land', `${dir} exists`, { skill: name }));
    }
    out.push(...this.filesGuards(m, name, dir, files));
    out.push(...frontmatterGuard(files['SKILL.md'], name, { isCore: this.registeredRefs().has(name), file: `${dir}/SKILL.md` }));
    return out;
  }

  private replaceGuards(m: SkillManifest, name: string, entry: SkillEntry, files: Readonly<Record<string, string>>): SkillConflictFinding[] {
    const out = this.filesGuards(m, name, entry.dir, files);
    const nestedUnder = [...this.ownershipDirs(m)].filter((d) => d !== entry.dir && d.startsWith(`${entry.dir}/`));
    for (const rel of Object.keys(files)) {
      const owner = owningSkillDir(`${entry.dir}/${rel}`, new Set([entry.dir, ...nestedUnder]));
      if (owner !== entry.dir) {
        out.push(finding('path-invalid', 'blocking', 'a nested skill owns its own files; address it through that skill', `${rel} lies under the nested skill at ${owner}`, { skill: name, file: rel }));
      }
    }
    out.push(...frontmatterGuard(files['SKILL.md'], name, { isCore: entry.core, file: `${entry.dir}/SKILL.md` }));
    return out;
  }

  // ── Refresh (three-way per FILE) ──────────────────────────────────────────────────────────

  /**
   * Re-capture the live plugin as a new baseline and merge per file (base_old / base_new /
   * effective) with the v3 §7 truth table. A user DELETION is a modification: with upstream
   * unchanged the deletion stands; with upstream changed the deletion is kept and the file is a
   * `conflict` (the new side readable as `?side=baseline`). A held-back upstream skill (its
   * path-derived name collides with a user-added skill at another dir) is left in the baseline only
   * and flagged. The previous baseline dir is NOT removed here — a baseline lives while any
   * snapshot on disk references it (`reapBaselines`).
   *
   * ATOMIC against refusal (codex round 4): the merge is DECIDED in memory first; then EVERY
   * destination it would write or remove is preflighted (lstat-walked from the root, no symlink
   * component — `containedEffective`); only then is the new baseline captured, every taken file
   * STAGED into a temp dir under the root, and the swap (removals + renames) performed, followed by
   * the manifest commit. A refused destination — an upstream-added file whose `effective/` parent
   * is a symlink, say — answers the normal 2xx `blocked` `path-invalid` envelope with NOTHING
   * changed: no file copied or removed, no baseline captured, the revision unchanged (it used to
   * copy file by file and escape as a 500 after the files ahead of the refusal had landed).
   */
  refreshBaseline(expectedRevision: number): SkillRefreshResult {
    const m = this.manifest();
    this.assertRevision(m, expectedRevision);
    const source = this.requireSource('no installed wicked-garden plugin found to refresh from (neither the marketplace cache nor the installer-managed copy)');
    const previous = m.baseline;
    let bundle: FileRecord[];
    try {
      bundle = pluginBundleFiles(source.path);
    } catch (err) {
      if (!(err instanceof PluginSourceSymlinkError)) throw err;
      // A symlink among the source's designated entries (codex round 6): refused by name as the
      // normal 2xx `blocked` envelope — nothing copied, no baseline captured, the revision unchanged.
      return {
        verdict: 'blocked',
        findings: [this.sourceSymlinkFinding(err)],
        revision: m.revision,
        previous_baseline: previous,
        baseline: previous,
        plugin_version: source.plugin_version,
        taken: [],
        kept: [],
        added: [],
        removed: [],
        conflicts: [],
      };
    }
    const newHash = hashFileSet(bundle);
    const base = (extra: Partial<SkillRefreshResult> = {}): SkillRefreshResult => ({
      verdict: 'clear',
      findings: [],
      revision: m.revision,
      previous_baseline: previous,
      baseline: newHash,
      plugin_version: source.plugin_version,
      taken: [],
      kept: [],
      added: [],
      removed: [],
      conflicts: [],
      ...extra,
    });
    if (newHash === previous) {
      // Byte-identical upstream: nothing to merge. The PROVENANCE may still have moved (codex on
      // #491): a copy seed followed by the marketplace registration discovers the same bytes in the
      // cache — record where the current baseline is sourced from NOW (kind, path, declared version,
      // git state; `captured_at` and `venv` stay: the bytes did not change) so the runtime's
      // `skills.source` warning follows the truth. The revision moves with the manifest commit; the
      // same source again is a no-op and the revision stands.
      const record = m.baselines[previous];
      if (record !== undefined && (record.source.kind !== source.kind || record.source.path !== source.path)) {
        const now = this.baselineRecord(source);
        m.baselines[previous] = { ...record, plugin_version: now.plugin_version, source: now.source, git_sha: now.git_sha };
        this.commit(m);
        return base({ revision: m.revision });
      }
      return base();
    }

    // ── Decide (in memory — nothing on disk moves until the preflight below has passed) ─────
    const newFiles = new Map(bundle.map((f) => [f.rel, sha256Hex(readFileNoFollow(f.abs))])); // the source entries the bundle walk judged, read no-follow
    const effective = new Map(this.scanEffective().files.map((f) => [f.rel, f.sha]));
    const oldFiles = new Map(
      Object.entries(m.files).filter(([, r]) => r.baselineHash !== null).map(([rel, r]) => [rel, r.baselineHash as string]),
    );

    // Held-back upstream skills: a NEW upstream dir whose PATH-DERIVED name is already a manifest
    // key at a different dir (a user-added skill) — v3 §7's name-collision conflict. Every
    // name-collision flag is re-derived by this pass, so clear the previous refresh's first.
    const findings: SkillConflictFinding[] = [];
    const heldBack = new Set<string>();
    const conflicts = new Set<string>();
    const manifestDirs = this.manifestDirs(m);
    for (const entry of Object.values(m.skills)) {
      entry.conflict = false;
      entry.upstreamDir = null;
    }
    for (const dir of skillDirsOf(bundle)) {
      if (manifestDirs.has(dir)) continue;
      const name = derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
      const existing = m.skills[name];
      if (existing === undefined || existing.dir === dir) continue;
      heldBack.add(dir);
      existing.conflict = true;
      existing.upstreamDir = dir; // `?side=baseline` reads of this skill resolve HERE (codex round 9)
      conflicts.add(name);
      findings.push(
        finding(
          'refresh-conflict',
          'warning',
          'upstream now ships a skill under a name the operator added; the user-added skill is kept and the upstream one is left in the baseline (readable as ?side=baseline) — rename or remove one of them',
          `${name}: user-added at ${existing.dir}, upstream at ${dir}`,
          { skill: name, file: `${dir}/SKILL.md`, against: { name, core: existing.core } },
        ),
      );
    }
    const isHeld = (rel: string): boolean => [...heldBack].some((d) => rel.startsWith(`${d}/`));
    const dirOfBefore = new Map(Object.entries(m.skills).map(([name, e]) => [e.dir, name]));

    const touched = new Set<string>();
    /** Files to copy from the NEW baseline into `effective/` (the truth table's "take"). */
    const takes: string[] = [];
    /** Files to remove from `effective/` (upstream deleted, user unmodified). */
    const removals: string[] = [];
    const rels = new Set([...oldFiles.keys(), ...newFiles.keys(), ...effective.keys()]);
    for (const rel of [...rels].sort()) {
      if (isHeld(rel)) continue;
      const bo = oldFiles.get(rel) ?? null;
      const bn = newFiles.get(rel) ?? null;
      const e = effective.get(rel) ?? null;
      const record = m.files[rel];
      const take = (): void => {
        takes.push(rel);
        m.files[rel] = { baselineHash: bn, effectiveHash: bn, lastPublishedHash: record?.lastPublishedHash ?? null, conflict: false };
        touched.add(rel);
      };
      if (bn !== null) {
        if (bo === null) {
          if (e === null || e === bn) take();
          else {
            m.files[rel] = { baselineHash: bn, effectiveHash: e, lastPublishedHash: record?.lastPublishedHash ?? null, conflict: true };
            touched.add(rel);
          }
        } else if (e === bo) {
          if (bn !== bo) take(); // user unmodified → take upstream
        } else if (e === null) {
          // The user DELETED the file — a modification. Upstream unchanged: the deletion stands
          // (baseline = bo = bn, effective = null). Upstream changed: keep the deletion, flag the
          // conflict, the new side sits in the baseline for diffing (reset restores it).
          if (bn !== bo) {
            m.files[rel] = { baselineHash: bn, effectiveHash: null, lastPublishedHash: record?.lastPublishedHash ?? null, conflict: true };
            touched.add(rel);
          } else if (record !== undefined) {
            record.effectiveHash = null;
          }
        } else if (e === bn) {
          m.files[rel] = { baselineHash: bn, effectiveHash: e, lastPublishedHash: record?.lastPublishedHash ?? null, conflict: false };
        } else if (bn === bo) {
          // user-modified, upstream unchanged → keep (the record follows the bytes on disk)
          if (record !== undefined) record.effectiveHash = e;
        } else {
          m.files[rel] = { baselineHash: bn, effectiveHash: e, lastPublishedHash: record?.lastPublishedHash ?? null, conflict: true };
          touched.add(rel);
        }
      } else if (bo !== null) {
        // upstream deleted
        if (e === bo) {
          removals.push(rel);
          delete m.files[rel];
          touched.add(rel);
        } else if (e === null) {
          delete m.files[rel];
        } else if (record !== undefined) {
          record.baselineHash = null; // kept as user-added
          record.conflict = false;
        }
      }
      // else: a user-added file upstream never had — kept as is
    }

    // ── Preflight EVERY destination before anything moves (codex round 4) ──────────────────
    // A refused path answers the 2xx `blocked` envelope with NOTHING changed: the in-memory
    // decisions above are simply dropped (the manifest on disk was never touched).
    const destinations = new Map<string, string>();
    for (const rel of [...takes, ...removals].sort()) {
      try {
        destinations.set(rel, this.containedEffective(rel.split('/')));
      } catch (err) {
        const owner = owningSkillDir(rel, new Set(dirOfBefore.keys()));
        const skill = owner === null ? null : (dirOfBefore.get(owner) ?? null);
        return base({ verdict: 'blocked', findings: [this.pathFinding(err, skill, rel)] });
      }
    }

    // ── Capture the new baseline (staging + rename; refused through a symlinked `baseline/`) ──
    // An existing `baseline/<newHash>` is reused only if it re-hashes to its name (codex round 7):
    // a corrupt one is the 2xx `blocked` `baseline-corrupt` envelope — nothing copied, nothing changed.
    try {
      this.captureBaseline(bundle, newHash, 'refuse');
    } catch (err) {
      if (!(err instanceof SkillsBaselineCorruptError)) throw err;
      return base({ verdict: 'blocked', findings: [this.baselineCorruptFinding(null, `${BASELINE_DIRNAME}/${newHash}`, err.message)] });
    }

    // ── Stage every take under the root, then swap: removals, then renames into place ─────────
    // Sources are walked from the root through `baseline/<newHash>/…` (a link inside the freshly
    // captured baseline is refused, never read through); a refusal here leaves `effective/` and
    // the manifest untouched and reaps the unreferenced capture.
    const staging = join(this.rootDir, `${STAGING_PREFIX}refresh-${randomBytes(6).toString('hex')}`);
    const stagedDir = join(staging, 'new');
    let sources: FileRecord[];
    try {
      sources = takes.map((rel) => ({ rel, abs: this.containedBaseline(newHash, rel.split('/')) }));
    } catch (err) {
      const blocked = base({ verdict: 'blocked', findings: [this.pathFinding(err, null, `${BASELINE_DIRNAME}/${newHash}`)] });
      this.reapBaselines();
      return blocked;
    }
    // The park-and-place transaction (`swapStaged`, codex round 6): what the merge REMOVES and what
    // a take OVERWRITES are both parked by rename before a single placement, so a failure mid-swap
    // restores every effective file byte-for-byte, the manifest is never committed (the revision
    // is unchanged) and the unreferenced new baseline is reaped — the old code removed and
    // overwrote in place, leaving partial content behind a 500.
    const park: FileRecord[] = removals.map((rel) => ({ rel, abs: destinations.get(rel) as string }));
    for (const rel of takes) {
      const dest = destinations.get(rel) as string;
      if (lstatOrNull(dest)?.isFile() === true) park.push({ rel, abs: dest });
    }
    const place = takes.map((rel) => ({ src: join(stagedDir, ...rel.split('/')), dest: destinations.get(rel) as string }));
    let swap: { handle: SwapHandle } | { finding: SkillConflictFinding };
    try {
      copyFiles(sources, stagedDir);
      this.restoreOwnerWrite(place.map((p) => p.src)); // the new baseline is locked; the operator's copies are theirs to edit
      // Re-walked and re-hashed against the new bundle's digests (v3.5 §3).
      const stagedProblem = this.stagedTreeProblem(stagedDir, new Map(takes.map((rel) => [rel, newFiles.get(rel) ?? ''])));
      if (stagedProblem !== null) {
        removeTreeForce(staging);
        const blocked = base({ verdict: 'blocked', findings: [this.stagedTreeFinding(null, `${BASELINE_DIRNAME}/${newHash}`, stagedProblem)] });
        this.reapBaselines();
        return blocked;
      }
      swap = this.swapStaged(null, `${BASELINE_DIRNAME}/${newHash}`, staging, park, place);
    } catch (err) {
      removeTreeForce(staging);
      this.reapBaselines();
      // A source swapped for a link between the walk and the copy is refused, never copied (v3.5 §3).
      if (err instanceof EntrySwappedError || err instanceof SymlinkComponentError) {
        return base({ verdict: 'blocked', findings: [this.stagedTreeFinding(null, `${BASELINE_DIRNAME}/${newHash}`, err.message)] });
      }
      throw err;
    }
    if ('finding' in swap) {
      const blocked = base({ verdict: 'blocked', findings: [swap.finding] });
      this.reapBaselines();
      return blocked;
    }

    // Catalog: register upstream-new dirs, drop skills with NO records left (upstream removed them
    // and the operator never touched them — a skill the operator deleted files from keeps its
    // baseline-backed records, stays in the catalog as an override, and blocks publish until reset
    // or disabled), recompute the rest — all of it the manifest half of the transaction
    // (`commitSwap`, codex round 7): a failure anywhere up to and including the manifest rename rolls
    // the content swap back, and the unreferenced new baseline is reaped with it.
    let added: string[] = [];
    let removed: string[] = [];
    let baselineDirsToRemove: string[] = [];
    const taken = new Set<string>();
    const kept = new Set<string>();
    try {
      this.commitSwap(swap.handle, m, () => {
        const before = new Set(Object.keys(m.skills));
        for (const [name, entry] of Object.entries(m.skills)) {
          if (existsSync(this.pluginPath(`${entry.dir}/SKILL.md`))) continue;
          if (this.ownRecords(m, entry.dir).length > 0) continue;
          delete m.skills[name];
        }
        // The new baseline is the one `recomputeDerived` / `hasBaselineDir` read from now on.
        m.baselines[newHash] = this.baselineRecord(source);
        m.baseline = newHash;
        // The previous baseline's record leaves in THIS commit when no generation on disk references
        // it (codex round 9: one mutation, one revision); its directory goes once the commit landed.
        baselineDirsToRemove = this.pruneBaselineRecords(m, this.generationsOnDisk()).dirs;
        findings.push(...this.rebuildCatalog(m).map((f) => ({ ...f, severity: 'warning' as const })));
        for (const [name, entry] of Object.entries(m.skills)) {
          if (conflicts.has(name)) entry.conflict = true;
          else if (entry.upgradeAvailable) conflicts.add(name);
        }
        const after = new Set(Object.keys(m.skills));
        added = [...after].filter((n) => !before.has(n)).sort();
        removed = [...before].filter((n) => !after.has(n)).sort();
        const dirOf = new Map(Object.entries(m.skills).map(([name, e]) => [e.dir, name]));
        const skillOfRel = (rel: string): string | null => {
          const owner = owningSkillDir(rel, new Set(dirOf.keys()));
          return owner === null ? null : (dirOf.get(owner) ?? null);
        };
        for (const rel of touched) {
          const name = skillOfRel(rel);
          if (name === null || added.includes(name)) continue;
          if (m.files[rel]?.conflict === true) kept.add(name);
          else taken.add(name);
        }
        for (const [name, entry] of Object.entries(m.skills)) {
          if (entry.provenance !== 'shipped' && !added.includes(name) && !taken.has(name)) kept.add(name);
        }
        for (const name of conflicts) {
          const entry = m.skills[name];
          if (entry === undefined) continue;
          findings.push(
            finding(
              'refresh-conflict',
              'warning',
              "both the operator and upstream changed this skill (a deletion by the operator counts); the operator's content is kept and the upstream side is readable as ?side=baseline — reset takes upstream wholesale",
              `${name} (${entry.dir}) has conflicting files`,
              { skill: name },
            ),
          );
        }
      });
    } catch (err) {
      this.reapBaselines(); // the content is back; the new capture nothing references goes with the failed commit
      throw err;
    }
    // The previous baseline's directory goes only when no snapshot on disk still links its `.venv` /
    // records it — its record already left in the commit above.
    for (const dir of baselineDirsToRemove) removeTreeForce(dir);
    return base({
      verdict: verdictOf(findings),
      findings,
      revision: m.revision,
      taken: [...taken].sort(),
      kept: [...kept].sort(),
      added,
      removed,
      conflicts: [...conflicts].sort(),
    });
  }

  // ── Publish ───────────────────────────────────────────────────────────────────────────────

  /** PURE dry run of the publish validation: nothing is persisted, the revision does not move. */
  analyze(): SkillAnalyzeResult {
    const m = this.manifest();
    const v = this.validate(m);
    return { verdict: verdictOf(v.findings), findings: v.findings, revision: m.revision };
  }

  /**
   * ONE publish at a time (module header): a concurrent call is refused with
   * `SkillsPublishInFlightError` (the route's 409) rather than queued — the caller's revision would
   * be stale by the time a queued publish ran.
   */
  async publish(expectedRevision: number): Promise<SkillPublishResult> {
    if (this.publishInFlight !== null) throw new SkillsPublishInFlightError(this.revision());
    const run = this.publishSerialized(expectedRevision);
    this.publishInFlight = run;
    try {
      return await run;
    } finally {
      this.publishInFlight = null;
    }
  }

  /** The root's identity a publish binds to: the configured path AND what it resolves to. */
  private bindRoot(): { root: string; real: string } {
    return { root: this.rootDir, real: realpathSync(this.rootDir) };
  }

  /** After EVERY await: the root must still be the very directory the operation started on. */
  private assertRootUnchanged(bound: { root: string; real: string }, revision: number): void {
    let real: string | null;
    try {
      real = realpathSync(this.rootDir);
    } catch {
      real = null;
    }
    if (real === null) throw new SkillsRootChangedError(bound.root, 'vanished', revision);
    if (real !== bound.real) throw new SkillsRootChangedError(bound.root, `moved (its canonical path is now ${real}, it was ${bound.real})`, revision);
  }

  /**
   * Bind the root, CAS, provision the baseline env (awaited), re-check the root identity and the
   * CAS, validate the whole tree (a failed provisioning is a blocking `venv-failed`), then write
   * `snapshots/<gen>/` (staging + rename, never over an existing generation) with the generated
   * views, LOCK it read-only, COMMIT the manifest (venv state included), flip `current`, and reap
   * generations / baselines nothing references. A `blocked` verdict persists nothing — the caller's
   * revision stays valid. Everything after the one await is synchronous: no interleaving.
   */
  private async publishSerialized(expectedRevision: number): Promise<SkillPublishResult> {
    // Refuse a root that changed identity (codex round 4) or a symlinked storage ancestor (codex
    // round 3) BEFORE anything is provisioned, staged or copied: a `snapshots -> /outside` would
    // take the first copy out of the store.
    this.assertRootIdentity();
    try {
      this.assertStorageAncestorsClean();
    } catch (err) {
      if (err instanceof SymlinkComponentError) throw new SkillsPublishError(`a storage directory is a symlink (${err.message}) — publish refused before writing anything`);
      throw err;
    }
    const bound = this.bindRoot();
    const pre = this.manifest();
    this.assertRevision(pre, expectedRevision);
    // The baseline must be the bundle its name claims BEFORE anything is provisioned in it (codex
    // round 7): a corrupt baseline is `baseline-corrupt`, blocking — nothing provisioned, nothing
    // written. `validate` re-derives the same hash AFTER the provisioner ran.
    const preProblem = this.baselineProblem(pre.baseline);
    if (preProblem !== null) {
      return { verdict: 'blocked', findings: [this.baselineCorruptFinding(null, `${BASELINE_DIRNAME}/${pre.baseline}`, preProblem)], revision: pre.revision, snapshot: null };
    }
    // Provisioning FIRST (it may take minutes): a snapshot never links an env still being written.
    const venv = await this.ensureVenv(pre.baseline);
    // The world may have moved while uv ran: the root must be the same directory, the CAS re-checked.
    this.assertRootUnchanged(bound, this.isSeeded() ? this.revision() : expectedRevision);
    const m = this.manifest();
    this.assertRevision(m, expectedRevision);
    const v = this.validate(m);
    if (venv === 'failed') {
      v.findings.push(
        finding(
          'venv-failed',
          'blocking',
          "the baseline's shared read-only Python environment is REQUIRED (the bundle carries a pyproject.toml; skills `uv run` from the plugin root): a snapshot without it hands every worker a plugin whose scripts cannot start. Install uv, fix the sync error the log names, and publish again",
          `uv sync did not produce ${baselineVenvDir(this.baselineDir(m.baseline))} (see the daemon log)`,
          {},
        ),
      );
    }
    if (verdictOf(v.findings) === 'blocked') {
      return { verdict: 'blocked', findings: v.findings, revision: m.revision, snapshot: null };
    }
    const gen = this.nextGeneration(m);
    const views = this.viewFiles(v);
    const allFiles = sortedRels([...v.snapshotFiles, ...views.files]);
    // The shared per-baseline env is linked ONLY when it exists (a Windows junction needs its
    // target; a dangling link would let a worker's `uv run` create the env THROUGH it into the
    // baseline). The link is part of the content hash — path + link text — so `current`
    // verification sees it added, removed or re-pointed (codex round 5). `snapshot.json.venv`
    // carries the state either way.
    const venvDir = baselineVenvDir(this.baselineDir(m.baseline));
    const venvLink = venv === 'synced' && existsSync(venvDir) ? this.venvLinkText(m.baseline) : null;
    // The hash covers the directories the file set IMPLIES (codex round 9): the staged tree and every
    // later verification hash the directories they WALK, so an extra directory — empty or not — is a
    // mismatch, never an invisible passenger.
    const contentHash = hashTree(allFiles, venvLink === null ? [] : [{ rel: VENV_LINKNAME, target: venvLink.text }], impliedDirs(allFiles.map((f) => f.rel)));
    const snapshots = this.snapshotsDir();
    mkdirSync(snapshots, { recursive: true });
    this.sweepStaging(snapshots);
    const staging = join(snapshots, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    copyFiles(allFiles, staging);
    const record = m.baselines[m.baseline];
    const snapshot: SnapshotManifest = {
      gen,
      contentHash,
      gardenSource: {
        kind: record?.source.kind ?? 'directory',
        path: record?.source.path ?? '',
        plugin_version: record?.plugin_version ?? '',
        baseline: m.baseline,
      },
      venv,
      skills: v.enabledSkills
        .map(({ name, entry }) => ({
          name,
          dir: entry.dir,
          kind: entry.kind,
          core: entry.core,
          portable: entry.portable,
          // `validate` recomputed every entry (F-079), so the per-reason claim is fresh here; the
          // fallback only guards the type — a row is never written without `portability`.
          portability: entry.portability ?? { portable: entry.portable, reasons: [], evidence: [] },
          nested: isNestedSkillDir(entry.dir),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      views: { copilot: { dir: COPILOT_VIEW_REL, skills: views.copilotSkills } },
    };
    // The exact bytes of `snapshot.json` are what `manifest.published.snapshotHash` authenticates
    // (codex round 7): the metadata is excluded from the content hash, so the crew-owned manifest is
    // what makes its claims (kind, core, portable, nested, the view membership) trustworthy at verify.
    const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
    writeFileAtomic(join(staging, SNAPSHOT_MANIFEST_FILENAME), snapshotText);
    if (venvLink !== null) this.symlink(venvLink.text, join(staging, VENV_LINKNAME), venvLink.absTarget);
    // Re-walk (lstat) and re-hash the staged generation AFTER the copy and BEFORE the rename (design
    // v3.5 §3): files and the one permitted link must hash to the content it was copied from.
    const stagedHash = this.snapshotHash(walkTree(staging));
    if (stagedHash !== contentHash) {
      removeTreeForce(staging);
      throw new SkillsPublishError(`the staged generation hashes to ${stagedHash}, not to the content it was copied from (${contentHash}) — modified between copy and rename; nothing published`);
    }
    const dest = this.snapshotDir(gen);
    if (this.entryExists(dest)) {
      removeTreeForce(staging);
      throw new SkillsPublishError(`${dest} already exists — a published generation is never removed or overwritten`);
    }
    renameSync(staging, dest);
    // Immutable by contract, and now by mode bits: a published generation is locked read-only
    // (verification by hash stays the authority — the lock is what makes an accidental edit fail).
    try {
      makeTreeReadOnly(dest);
    } catch (err) {
      removeTreeForce(dest);
      throw new SkillsPublishError(`could not lock ${dest} read-only: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Manifest FIRST, then `current`: a crash in between leaves a committed generation `ensureReady`
    // finishes flipping to; the reverse order would leave a live `current` the manifest disowns.
    const included = new Set(v.snapshotFiles.map((f) => f.rel));
    for (const [rel, r] of Object.entries(m.files)) {
      if (included.has(rel)) r.lastPublishedHash = r.effectiveHash;
    }
    if (record !== undefined) record.venv = venv; // provisioning state rides the SUCCESSFUL publish only
    m.published = { gen, contentHash, at: this.now(), snapshotHash: sha256Hex(snapshotText) };
    // Retention is decided BEFORE the commit and rides it (codex round 9): the generations this
    // publish retires, and the baseline records nothing will reference once they are gone, leave the
    // manifest in this very commit — one mutation, one revision — and their directories are removed
    // only after it landed (the new generation is on disk already, so it counts as live).
    const retiredGens = this.generationsToReap(gen);
    const prune = this.pruneBaselineRecords(m, this.generationsOnDisk().filter((g) => !retiredGens.includes(g)));
    try {
      this.commit(m);
    } catch (err) {
      // No manifest, no generation (codex round 7): a generation the manifest never came to own is
      // removed rather than left for later publishes to skip over.
      removeTreeForce(dest);
      throw err;
    }
    this.flipCurrent(gen);
    this.live.published(gen);
    for (const g of retiredGens) removeTreeForce(this.snapshotDir(g)); // locked read-only at publish
    for (const dir of prune.dirs) removeTreeForce(dir);
    return {
      verdict: verdictOf(v.findings),
      findings: v.findings,
      revision: m.revision,
      // The REAL path — the same spelling `currentSnapshot()` answers and the engine is handed.
      snapshot: { gen, path: realpathSync(dest), contentHash, skills: snapshot.skills.length },
    };
  }

  /**
   * The generated delivery views (design v3.2 §2/§4) as snapshot-relative file records over the
   * EFFECTIVE bytes the validation admitted — today the copilot view only: every enabled, PORTABLE
   * skill's own files (nested subtrees excluded — they are their own skills) under
   * `views/copilot/.github/skills/<frontmatter name>/`. A non-portable skill needs the plugin root,
   * the snapshot cwd or a sibling link, none of which a flat `.github/skills` layout provides.
   */
  private viewFiles(v: Validation): { files: FileRecord[]; copilotSkills: string[] } {
    const files: FileRecord[] = [];
    const copilotSkills: string[] = [];
    const byRel = new Map(v.snapshotFiles.map((f) => [f.rel, f]));
    const dirs = new Set(v.enabledSkills.map(({ entry }) => entry.dir));
    for (const { name, entry } of v.enabledSkills) {
      if (!entry.portable) continue;
      // The persisted key becomes ONE path segment of the view. Validated here again, independently
      // of the manifest parse (codex round 4): the generator joins only a name it checked itself.
      if (!SKILL_NAME_RE.test(name)) {
        throw new SkillsPublishError(`skill name ${JSON.stringify(name)} is not a safe path segment — the copilot view cannot lay it out`);
      }
      copilotSkills.push(name);
      const prefix = `${entry.dir}/`;
      for (const [rel, f] of byRel) {
        if (!rel.startsWith(prefix) || owningSkillDir(rel, dirs) !== entry.dir) continue;
        files.push({ rel: `${COPILOT_VIEW_SKILLS_REL}/${name}/${rel.slice(prefix.length)}`, abs: f.abs });
      }
    }
    return { files: sortedRels(files), copilotSkills: copilotSkills.sort() };
  }

  /** The next generation: one past the highest that EXISTS (on disk or in the manifest) — never a reuse. */
  private nextGeneration(m: SkillManifest): number {
    return Math.max(m.published?.gen ?? 0, ...this.generationsOnDisk()) + 1;
  }

  private entryExists(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    }
  }

  /**
   * `current -> snapshots/<gen>`, flipped atomically: the link is created INSIDE `snapshots/` under
   * `.tmp-current-<hex>` — a name core's launch-time fence classifies (`snapshots/.tmp-*` is a
   * denied child, and v3.3 §1's listing of `snapshots/` accepts `.staging-*` / `.tmp-*` entries) —
   * and `rename()`d over `current` on the same filesystem, so NO unclassified child ever appears
   * under `skills/` (core#399 round 4: the former `skills/current.tmp-<hex>` would have refused a
   * launch that listed `skills/` in that window). The link's RELATIVE target (`snapshots/<gen>`) is
   * spelled for its FINAL location; while it sits in `snapshots/` it dangles and nothing reads it
   * there — a torn flip leaves a `.tmp-current-*` the next publish's staging sweep removes.
   */
  private flipCurrent(gen: number): void {
    const link = this.currentLink();
    const tmp = join(this.snapshotsDir(), `${CURRENT_TMP_PREFIX}${randomBytes(6).toString('hex')}`);
    this.symlink(posix.join(SNAPSHOTS_DIRNAME, generationDirName(gen)), tmp, this.snapshotDir(gen));
    renameSync(tmp, link);
  }

  /** A directory symlink: the given link text on POSIX (relative); Windows junctions need the absolute target (and it must exist). */
  private symlink(linkText: string, linkPath: string, absTarget: string): void {
    if (process.platform === 'win32') symlinkSync(absTarget, linkPath, 'junction');
    else symlinkSync(linkText, linkPath);
  }

  /**
   * Remove every generation older than the newest `KEEP_GENERATIONS` — never the current one, and
   * never one a live session still pins (it is reaped by the release that frees it).
   */
  private reapGenerations(currentGen: number): void {
    for (const gen of this.generationsToReap(currentGen)) removeTreeForce(this.snapshotDir(gen)); // locked read-only at publish
  }

  /** The generations `reapGenerations(currentGen)` would remove: beyond the newest `KEEP_GENERATIONS`, never the current one, never a pinned one. */
  private generationsToReap(currentGen: number): number[] {
    const pinned = this.live.pinned();
    return this.generationsOnDisk()
      .filter((g) => g !== currentGen)
      .sort((a, b) => b - a)
      .slice(KEEP_GENERATIONS - 1)
      .filter((g) => !pinned.has(g));
  }

  /**
   * Drop, IN MEMORY, every baseline record that neither `m.baseline` nor any of `liveGens` (the
   * generations that will remain on disk) references — and every record whose directory is gone.
   * The caller commits `m` (a publish's or refresh's OWN commit, or the standalone reap's) and only
   * THEN removes the directories answered here (codex round 9): the record change rides a validated
   * commit with the revision advanced, a client never sees two manifests at one revision, and a
   * failed commit removes nothing.
   */
  private pruneBaselineRecords(m: SkillManifest, liveGens: ReadonlyArray<number>): { changed: boolean; dirs: string[] } {
    const referenced = new Set<string>([m.baseline]);
    for (const gen of liveGens) {
      const parsed = this.parseSnapshotManifest(this.snapshotDir(gen));
      if (typeof parsed !== 'string') referenced.add(parsed.gardenSource.baseline);
    }
    const parent = join(this.rootDir, BASELINE_DIRNAME);
    let entries: string[] = [];
    try {
      entries = readdirSync(parent);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') throw err;
    }
    const dirs: string[] = [];
    let changed = false;
    for (const e of entries) {
      if (e.startsWith('.') || referenced.has(e)) continue;
      dirs.push(join(parent, e));
      if (m.baselines[e] !== undefined) {
        delete m.baselines[e];
        changed = true;
      }
    }
    for (const hash of Object.keys(m.baselines)) {
      if (hash !== m.baseline && !existsSync(join(parent, hash))) {
        delete m.baselines[hash];
        changed = true;
      }
    }
    return { changed, dirs };
  }

  /**
   * Remove every baseline dir (and its record) that neither the manifest nor ANY generation on
   * disk references — a retained snapshot keeps the `.venv` it links alive. Dropping the records is
   * a COMMITTED, revision-advancing mutation (the validated `manifest.json.tmp-…` → rename path,
   * codex round 9), landed BEFORE any directory is removed. Answers the revision that commit
   * produced, or `null` when no record changed (nothing to reap, or an unseeded root) — directories
   * with no record left are still removed in that case.
   */
  private reapBaselines(): number | null {
    if (!this.isSeeded()) return null;
    const m = this.manifest();
    const prune = this.pruneBaselineRecords(m, this.generationsOnDisk());
    // Dropping a baseline record is a MUTATION like any other (codex round 9): it goes through the
    // validated `manifest.json.tmp-…` → rename commit with the revision ADVANCED — a client never sees
    // two different manifests at one revision, and a stale `expectedRevision` after a reap is the 409
    // it should be. The commit lands BEFORE any directory is removed, so a failed commit removes
    // nothing (there is nothing to roll back); the removals that follow are of directories no
    // generation and no record references. (A publish or refresh folds this into its OWN commit —
    // `pruneBaselineRecords` — so one mutation stays one revision; this standalone form serves the
    // event-driven reap of a generation a run stopped pinning.)
    let committed: number | null = null;
    if (prune.changed) {
      this.commit(m);
      committed = m.revision;
    }
    for (const dir of prune.dirs) removeTreeForce(dir);
    return committed;
  }

  /** The generations present on disk, ascending. */
  generationsOnDisk(): number[] {
    if (!existsSync(this.snapshotsDir())) return [];
    return readdirSync(this.snapshotsDir())
      .filter((e) => GENERATION_DIR_RE.test(e) && lstatSync(join(this.snapshotsDir(), e)).isDirectory())
      .map((e) => Number(e))
      .sort((a, b) => a - b);
  }

  /** The baseline hashes present on disk (diagnostics + tests). */
  baselinesOnDisk(): string[] {
    const parent = join(this.rootDir, BASELINE_DIRNAME);
    if (!existsSync(parent)) return [];
    return readdirSync(parent)
      .filter((e) => !e.startsWith('.') && lstatSync(join(parent, e)).isDirectory())
      .sort();
  }

  /** The 2xx `blocked` finding for a plugin source whose designated entry is a symlink (seed/refresh; codex round 6). */
  private sourceSymlinkFinding(err: PluginSourceSymlinkError): SkillConflictFinding {
    return finding(
      'path-invalid',
      'blocking',
      'the plugin source is copied INTO the skills root and handed to every worker; a symlink among its designated files or directories would copy whatever the link reaches — the ingestion is refused by name and nothing was copied (the source root itself may be reached through a link; its contents may not)',
      err.message,
      { file: err.entry },
    );
  }

  /**
   * Whole-tree validation (v3 §API refs — an ESCAPE blocking, a MISSING target a warning per design
   * v3.4 §1 —, §5 core closure, §6 nested ownership, the bundle closure as the ONE allowlist —
   * codex round 6). Mutates `m` IN MEMORY for bookkeeping only (drift into the file records,
   * derived fields, the core closure) — the caller decides whether that is persisted (publish
   * commits it; analyze and a blocked publish drop it). Never touches `effective/`.
   */
  private validate(m: SkillManifest): Validation {
    const findings: SkillConflictFinding[] = [];
    // The baseline the records point at must be the bundle its name claims (codex round 7): reset
    // restores from it, `?side=baseline` reads it, the env is provisioned in it — and publish calls
    // this AFTER the provisioner ran, so a provisioner that wrote outside `.venv` is caught here.
    const baselineProblem = this.baselineProblem(m.baseline);
    if (baselineProblem !== null) findings.push(this.baselineCorruptFinding(null, `${BASELINE_DIRNAME}/${m.baseline}`, baselineProblem));
    const scan = this.scanEffective();
    const scanned = scan.files;
    const onDisk = new Map(scanned.map((f) => [f.rel, f]));

    // Direct filesystem edits: detected by hash, reported, recorded — never silently trusted.
    const drift: string[] = [];
    for (const f of scanned) {
      const record = m.files[f.rel];
      if (record === undefined) {
        m.files[f.rel] = {
          baselineHash: this.baselineHashOf(m, f.rel),
          effectiveHash: f.sha,
          lastPublishedHash: null,
          conflict: false,
        };
        drift.push(f.rel);
      } else if (record.effectiveHash !== f.sha) {
        record.effectiveHash = f.sha;
        drift.push(f.rel);
      }
    }
    for (const [rel, record] of Object.entries(m.files)) {
      if (onDisk.has(rel) || record.effectiveHash === null) continue;
      if (record.baselineHash === null) delete m.files[rel];
      else record.effectiveHash = null;
      drift.push(rel);
    }
    if (drift.length > 0) {
      const shown = drift.sort().slice(0, DRIFT_LIST_CAP);
      findings.push(
        finding(
          'fs-drift',
          'warning',
          'these files changed on disk outside the API since the manifest last saw them; the hashes are updated and the content is published as found — review it',
          `${drift.length} file${drift.length === 1 ? '' : 's'} drifted: ${shown.join(', ')}${drift.length > shown.length ? ', …' : ''}`,
        ),
      );
    }

    // Catalog shape: every SKILL.md on disk is registered; every entry has its SKILL.md.
    const diskDirs = skillDirsOf(scanned);
    const registered = new Map(Object.entries(m.skills).map(([name, e]) => [e.dir, name]));
    for (const dir of [...diskDirs].sort()) {
      if (registered.has(dir)) continue;
      const owner = owningSkillDir(dir, new Set(registered.keys()));
      findings.push(
        finding(
          'unregistered-skill',
          'blocking',
          'a SKILL.md appeared on disk that the manifest never registered — a nested skill created outside the API, or a dir whose path-derived name another skill already holds; register it with POST /skills or remove it',
          `${dir}/SKILL.md is unregistered${owner === null ? '' : ` (inside ${registered.get(owner) ?? owner})`}`,
          { file: `${dir}/SKILL.md` },
        ),
      );
    }
    // Derived fields are recomputed CONTAINED: a skill whose dir (or a file in it) crosses a symlink
    // is skipped, never read through, and BLOCKS here by name (codex round 5).
    findings.push(...this.recomputeDerived(m));
    // EVERY entry of effective/ is classified (codex round 9): a symlink ANYWHERE under it is refused
    // by name — there is no permitted link there (the store never follows one, and a snapshot would
    // otherwise copy whatever it reaches) — and so is a node that is neither a file nor a directory.
    // Empty directories are visible to the walk (`scan.dirs`); a snapshot is a file set, so they are
    // not carried, but nothing is invisible. An entry the containment recompute already refused by
    // the same path (a skill dir that IS a link) is not reported twice. The entries BENEATH a pruned
    // directory (`.venv`, `node_modules`, `__pycache__`) are classified too (codex round 10): such a
    // directory is not bundle content — nothing beneath it is copied or hashed — so a link or a
    // special node inside one is refused by name with that reason; the store's provisioned env lives
    // under baseline/<hash>/.venv and is linked from the snapshot root, never held under effective/.
    const alreadyRefused = new Set(findings.filter((f) => f.kind === 'path-invalid').map((f) => f.file));
    const ownerNameOf = (rel: string): string | null => {
      const owner = owningSkillDir(rel, new Set(registered.keys()));
      return owner === null ? null : (registered.get(owner) ?? null);
    };
    const prunedNames = [...SKIP_DIR_NAMES].sort().join(', ');
    const prunedLinkReason = (prunedBy: string): string =>
      `a pruned directory (${prunedNames}) is not bundle content — nothing beneath one is copied into a snapshot or hashed — and holds no links: every entry beneath one is still classified, and a symlink there is refused by name${
        posix.basename(prunedBy) === VENV_LINKNAME ? "; provisioned environments live under baseline/, not the editable root (publish links the snapshot's .venv to baseline/<hash>/.venv)" : ''
      }`;
    for (const e of scan.links) {
      if (alreadyRefused.has(e.rel)) continue;
      findings.push(
        e.pruned === null
          ? finding(
              'path-invalid',
              'blocking',
              'the skills root carries no symlinks — there is no permitted link under effective/ (no-follow everywhere, design v3 §API): a link would make a snapshot copy whatever it reaches on the worker host, so every entry is classified and a link is refused by name, never skipped',
              `${e.rel} is a symlink -> ${e.target ?? ''}`,
              { skill: ownerNameOf(e.rel), file: e.rel },
            )
          : finding('path-invalid', 'blocking', prunedLinkReason(e.pruned), `${e.rel} is a symlink -> ${e.target ?? ''} inside the pruned directory ${e.pruned}`, {
              skill: ownerNameOf(e.rel),
              file: e.rel,
            }),
      );
    }
    for (const e of scan.others) {
      findings.push(
        e.pruned === null
          ? finding(
              'path-invalid',
              'blocking',
              'only regular files and directories live under effective/: a socket, fifo or device node cannot be copied into a snapshot and is refused by name',
              `${e.rel} is neither a regular file nor a directory`,
              { skill: ownerNameOf(e.rel), file: e.rel },
            )
          : finding(
              'path-invalid',
              'blocking',
              `a pruned directory (${prunedNames}) is classified like the rest of effective/ — nothing beneath one is copied or hashed, but what it holds is judged: a socket, fifo or device node inside one is refused by name`,
              `${e.rel} is neither a regular file nor a directory (inside the pruned directory ${e.pruned})`,
              { skill: ownerNameOf(e.rel), file: e.rel },
            ),
      );
    }
    const catalogMd = new Map<string, string>();
    for (const [name, entry] of Object.entries(m.skills)) {
      const rel = `${entry.dir}/SKILL.md`;
      const f = onDisk.get(rel);
      if (f !== undefined) catalogMd.set(name, readFileNoFollow(f.abs).toString('utf8'));
    }

    // The core closure must be COMPLETE: a registered ref or a mandate naming no catalog skill is
    // a phase the engine would refuse to launch — blocking here, not a warning (v3 §3/§5).
    const closure = coreClosure(this.registeredRefs(), catalogMd);
    for (const ref of closure.missing) {
      findings.push(
        finding(
          'core-missing',
          'blocking',
          'a registered workflow names this skill as a phase skill_ref, but no skill by that name is in the catalog; a run dispatching that phase would find no skill in the snapshot and the engine refuses the launch',
          `skill_ref ${ref} names no catalog skill`,
          { skill: ref, against: { name: ref, core: true } },
        ),
      );
    }
    for (const a of closure.absentMandates) {
      findings.push(
        finding(
          'core-missing',
          'blocking',
          'a core-by-reference skill mandates this skill by qualified name, but no catalog skill answers to it — the method a governed phase depends on would be missing from the snapshot',
          `${a.from} names ${a.name}, which is not in the catalog`,
          { skill: a.from, file: `${m.skills[a.from]?.dir ?? ''}/SKILL.md`, line: a.line, against: { name: a.name, core: true } },
        ),
      );
    }

    // Per skill.
    const enabledSkills: Array<{ name: string; entry: SkillEntry }> = [];
    const dirs = new Set([...registered.keys(), ...diskDirs]); // ownership follows the filesystem (v3 §6)
    const declaredBy = new Map<string, string[]>();
    for (const [name, entry] of Object.entries(m.skills).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const severity = entry.enabled ? 'blocking' : 'warning';
      const skillMd = catalogMd.get(name);
      findings.push(...frontmatterGuard(skillMd, name, { isCore: entry.core, file: `${entry.dir}/SKILL.md`, severity }));
      if (skillMd !== undefined) {
        const parsed = parseFrontmatter(skillMd);
        const declared = parsed.ok ? parsed.fields['name'] : undefined;
        if (declared !== undefined && declared !== '' && declared !== name) {
          const list = declaredBy.get(declared);
          if (list === undefined) declaredBy.set(declared, [name]);
          else list.push(name);
        }
      }
      if (entry.core && !entry.enabled) findings.push(...compact([coreDisableGuard(name, entry)]));
      if (entry.enabled) enabledSkills.push({ name, entry });
    }
    // Declared names are checked across the FULL catalog, disabled entries included (codex round
    // 2): a skill — enabled or not — whose frontmatter declares ANOTHER catalog skill's name is a
    // blocking collision (a disabled one downgraded to a mismatch warning could still shadow a core
    // skill's identity the moment it is enabled or read by a tool keyed on frontmatter).
    for (const [declared, holders] of [...declaredBy.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const target = m.skills[declared];
      for (const from of holders) {
        if (target !== undefined) {
          findings.push(
            finding(
              'name-collision',
              'blocking',
              target.core
                ? 'the declared name is a core-by-reference skill\'s identity (a registered workflow dispatches phases to it); a second SKILL.md declaring it would shadow the one the workflow means'
                : 'the declared name is another catalog skill\'s identity (disabled skills count — the manifest is keyed by name); two definitions of one name cannot both be loaded',
              `${m.skills[from]?.dir ?? from}/SKILL.md declares ${JSON.stringify(declared)}, the name of the catalog skill at ${target.dir} (${target.enabled ? 'enabled' : 'disabled'})`,
              { skill: from, file: `${m.skills[from]?.dir ?? ''}/SKILL.md`, against: { name: declared, core: target.core } },
            ),
          );
        }
      }
      const enabledHolders = holders.filter((h) => m.skills[h]?.enabled === true);
      if (target === undefined && enabledHolders.length > 1) {
        findings.push(
          finding(
            'name-collision',
            'blocking',
            'two enabled skills declare the same frontmatter name — the plugin would load two definitions of one identity',
            `${enabledHolders.join(' and ')} both declare ${JSON.stringify(declared)}`,
            { skill: enabledHolders[0] ?? null, against: { name: declared, core: false } },
          ),
        );
      }
    }

    // The would-be snapshot: support files + enabled skills' own files (owner computed once per file).
    const ownerOf = new Map(scanned.map((f) => [f.rel, owningSkillDir(f.rel, dirs)]));
    const snapshotFiles: FileRecord[] = [];
    const filesByOwner = new Map<string, FileRecord[]>();
    for (const f of scanned) {
      const owner = ownerOf.get(f.rel) ?? null;
      if (owner === null) {
        if (f.rel.startsWith(`${SKILLS_SUBDIR}/`)) continue;
        // A support file is admitted ONLY inside the bundle closure (the ONE allowlist, bundle.ts;
        // codex round 6): a file outside it under effective/ got there by a direct filesystem edit
        // (the API refuses the path) — reported BLOCKING by name, never shipped.
        if (!inBundleClosure(f.rel)) {
          findings.push(
            finding(
              'outside-closure',
              'blocking',
              `a file outside the bundle closure (${BUNDLE_CLOSURE_SPELLING}) sits under effective/ — a direct filesystem edit the API would have refused; a snapshot never ships it: remove it (or move it into the closure) and publish again`,
              `${f.rel} is outside the bundle closure`,
              { file: f.rel },
            ),
          );
          continue;
        }
        snapshotFiles.push({ rel: f.rel, abs: f.abs });
        continue;
      }
      const name = registered.get(owner);
      if (name === undefined || m.skills[name]?.enabled !== true) continue;
      const record = { rel: f.rel, abs: f.abs };
      snapshotFiles.push(record);
      const list = filesByOwner.get(owner);
      if (list === undefined) filesByOwner.set(owner, [record]);
      else list.push(record);
    }
    const snapshotSet = new Set(snapshotFiles.map((f) => f.rel));
    /** `ok` / `escape` (climbs out of the plugin root) / `missing` (inside, but not in the snapshot). */
    const resolves = (p: string): 'ok' | 'escape' | 'missing' => {
      const norm = resolvePluginRootRef(p);
      if (norm === null) return 'escape';
      if (norm === '' || snapshotSet.has(norm)) return 'ok';
      const prefix = `${norm}/`;
      for (const rel of snapshotSet) if (rel.startsWith(prefix)) return 'ok';
      return 'missing';
    };
    const whyMissing = (p: string): string => {
      const norm = resolvePluginRootRef(p) ?? p;
      const owner = owningSkillDir(norm, dirs);
      const ownerName = owner === null ? null : registered.get(owner);
      if (ownerName !== undefined && ownerName !== null && m.skills[ownerName]?.enabled === false) {
        return ` — it belongs to the DISABLED skill ${ownerName}`;
      }
      return onDisk.has(norm) || [...onDisk.keys()].some((rel) => rel.startsWith(`${norm}/`))
        ? ' — present in effective/ but outside the snapshot'
        : ' — no such file in effective/';
    };
    for (const { name, entry } of enabledSkills) {
      for (const f of filesByOwner.get(entry.dir) ?? []) {
        const buf = readFileNoFollow(f.abs);
        if (looksBinary(buf)) continue;
        const text = buf.toString('utf8');
        // Severity follows the TARGET (design v3.4 §1): a reference that ESCAPES the plugin root is a
        // boundary claim — blocking; one whose target is MISSING inside it is a content bug the
        // skill's author owns — a warning, published as found (the live 12.32.0 plugin carries 18 of
        // them; garden's own structural gate treats them as advisory, wicked-garden#1111 tracks them).
        const anchor = (line: number): { skill: string; file: string; line: number } => ({ skill: name, file: f.rel, line });
        for (const ref of extractPluginRootRefs(text)) {
          const verdict = resolves(ref.path);
          if (verdict === 'ok') continue;
          findings.push(
            verdict === 'escape'
              ? finding(
                  'unresolved-ref',
                  'blocking',
                  'a `${CLAUDE_PLUGIN_ROOT}` reference must stay inside the plugin root; one that climbs out of it (`..`) reaches whatever lies beside the snapshot on the worker host — a boundary the snapshot must not cross',
                  `\${CLAUDE_PLUGIN_ROOT}/${ref.path} — escapes the plugin root`,
                  anchor(ref.line),
                )
              : finding(
                  'unresolved-ref',
                  'warning',
                  "the snapshot is the plugin root workers see; a `${CLAUDE_PLUGIN_ROOT}` reference that names nothing inside it fails at first use — a content bug the skill's author owns (fix it in the editor, or upstream), published as found",
                  `\${CLAUDE_PLUGIN_ROOT}/${ref.path}${whyMissing(ref.path)}`,
                  anchor(ref.line),
                ),
          );
        }
        for (const ref of extractRelativeRefs(text)) {
          const target = resolveRelativeRef(f.rel, ref.path);
          const verdict = target === null ? 'escape' : resolves(target);
          if (verdict === 'ok') continue;
          findings.push(
            target === null || verdict === 'escape'
              ? finding(
                  'unresolved-ref',
                  'blocking',
                  'a `../` link must land inside the plugin root; one that climbs out of it reaches whatever lies beside the snapshot on the worker host — a boundary the snapshot must not cross',
                  `${ref.path} — escapes the plugin root`,
                  anchor(ref.line),
                )
              : finding(
                  'unresolved-ref',
                  'warning',
                  "a `../` link that lands inside the plugin root on nothing the snapshot carries (a file the bundle omits, or a skill that is disabled) is broken for every worker at first use — a content bug the skill's author owns, published as found",
                  `${ref.path}${whyMissing(target)}`,
                  anchor(ref.line),
                ),
          );
        }
      }
    }

    // The plugin manifest + the runtime catalogs: present, parseable, the right SHAPE (codex round
    // 2: existence alone let a manifest without `name` and a catalog holding `[]` publish clear).
    const parseJsonObject = (rel: string, f: ScannedFile): Record<string, unknown> | null => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileNoFollow(f.abs).toString('utf8'));
      } catch (err) {
        findings.push(finding('catalog-invalid', 'blocking', "Claude Code loads the plugin from its manifest and garden's runtime reads the catalogs beside it as JSON; one that does not parse loads nothing", `${rel}: ${err instanceof Error ? err.message : String(err)}`, { file: rel }));
        return null;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        findings.push(finding('catalog-invalid', 'blocking', 'the plugin manifest and the runtime catalogs are JSON OBJECTS (a top-level array or scalar is not a catalog)', `${rel}: top-level value is ${Array.isArray(parsed) ? 'an array' : typeof parsed}`, { file: rel }));
        return null;
      }
      return parsed as Record<string, unknown>;
    };
    const pluginJson = onDisk.get(PLUGIN_JSON_REL);
    if (pluginJson === undefined) {
      findings.push(finding('missing-plugin-manifest', 'blocking', 'a plugin root is its .claude-plugin/plugin.json — Claude Code loads nothing without it', `no ${PLUGIN_JSON_REL} in effective/`, { file: PLUGIN_JSON_REL }));
    } else {
      const manifestJson = parseJsonObject(PLUGIN_JSON_REL, pluginJson);
      if (manifestJson !== null) {
        const declared = manifestJson['name'];
        if (typeof declared !== 'string' || declared === '') {
          findings.push(finding('name-mismatch', 'blocking', `a plugin manifest MUST declare its \`name\` — workers invoke skills as \`${PLUGIN_NAME}:<skill>\`, and Claude Code registers the plugin under it`, `${PLUGIN_JSON_REL} declares no "name" (expected ${JSON.stringify(PLUGIN_NAME)})`, { file: PLUGIN_JSON_REL }));
        } else if (declared !== PLUGIN_NAME) {
          findings.push(finding('name-mismatch', 'blocking', `workers invoke skills as \`${PLUGIN_NAME}:<skill>\`; the plugin manifest must keep that name`, `${PLUGIN_JSON_REL} names ${JSON.stringify(declared)}`, { file: PLUGIN_JSON_REL }));
        }
      }
    }
    for (const rel of REQUIRED_PLUGIN_CATALOGS) {
      const f = onDisk.get(rel);
      if (f === undefined) {
        findings.push(
          finding(
            'missing-plugin-manifest',
            'blocking',
            "garden's runtime reads the plugin catalogs beside plugin.json (archetypes_v11.py raises without archetypes.json); a snapshot missing one hands every worker a plugin whose runtime cannot start",
            `no ${rel} in effective/`,
            { file: rel },
          ),
        );
        continue;
      }
      const catalog = parseJsonObject(rel, f);
      if (catalog === null) continue;
      if (rel.endsWith('/archetypes.json')) {
        const archetypes = catalog['archetypes'];
        if (typeof archetypes !== 'object' || archetypes === null) {
          findings.push(finding('catalog-invalid', 'blocking', "garden's archetype detector reads the `archetypes` collection of archetypes.json (archetypes_v11.py load_catalog); a catalog without it is not a catalog", `${rel} has no \`archetypes\` collection`, { file: rel }));
        }
      }
    }
    if (enabledSkills.length === 0) {
      findings.push(finding('empty-snapshot', 'blocking', 'a snapshot with no enabled skills would hand every worker an empty plugin', 'no enabled skills', {}));
    }
    return { findings, snapshotFiles: sortedRels(snapshotFiles), enabledSkills };
  }
}

/** Re-export for callers that only need to classify the source-missing case. */
export { NotAPluginRootError };
