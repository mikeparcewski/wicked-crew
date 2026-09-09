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
 *   snapshots/<gen>/           immutable published trees: enabled skills only, nested layout
 *                              verbatim, support closure, `snapshot.json`, `.venv -> baseline venv`
 *                              (only when that env exists)
 *   current -> snapshots/<gen> flipped atomically after each publish; the engine receives the
 *                              absolute REAL path of the generation as `WICKED_SKILLS_SNAPSHOT`
 *                              (engine-env.ts) — the ONLY input core reads (v3.1 §2)
 *   .uv-cache/                 the daemon's own uv cache (`UV_CACHE_DIR`), never the operator's
 *
 * # Identity, ownership, hashes
 *
 * A skill is a directory holding `SKILL.md`, keyed by the PATH-DERIVED name
 * `wicked-garden-<dir segments joined by '-'>` — which the live plugin's frontmatter `name` equals
 * for all 142 (unique). A declared name that differs is a `name-mismatch` finding, blocking at
 * publish: the manifest key, the directory, and the invocation identity are one thing. A skill's
 * OWN files are everything under its dir except a nested skill's subtree — the deepest `SKILL.md`
 * ancestor owns a path (v3 §6), so disabling/resetting/replacing a parent never touches a child,
 * and the file API refuses a child's path through the parent's endpoint. Every managed file
 * carries `{baselineHash, effectiveHash, lastPublishedHash}`; provenance is derived from them,
 * never asserted. Every mutation takes `expectedRevision` (CAS) and bumps `revision`; direct
 * filesystem edits are detected by hash at publish and REPORTED (`fs-drift`), never silently
 * trusted.
 *
 * # Containment (no-follow everywhere)
 *
 * Every path the store reads or writes is lstat-walked FROM THE SKILLS ROOT (`effective/…`,
 * `baseline/<hash>/…`), so a skill directory replaced by a symlink — not only a link inside it —
 * is refused (contain.ts / tree.ts). A path-guard failure on a WRITE answers the normal 2xx
 * `{verdict: 'blocked', findings: [path-invalid]}` envelope, never a 400.
 *
 * # Publish (crash-safe, idempotent on retry)
 *
 * Provisions the baseline's `.venv` (awaited — a snapshot never links an env still being written),
 * re-checks the CAS, validates the WHOLE tree — frontmatter, name == path, the core closure
 * COMPLETE (a missing registered ref or an absent transitive mandate is BLOCKING), every
 * `${CLAUDE_PLUGIN_ROOT}/<p>` and `../<p>` reference of an enabled skill resolving INSIDE the
 * would-be snapshot (never out of it), the required `.claude-plugin/*` catalogs present, no
 * unregistered `SKILL.md` — then: allocates the generation from the FILESYSTEM (max existing + 1),
 * writes `snapshots/.staging-<random>/`, renames it to `snapshots/<gen>/` (never over an existing
 * generation), commits the manifest, and only THEN flips `current`. A crash between the commit and
 * the flip is finished at the next boot (`ensureReady`); a torn staging dir is swept by the next
 * publish. Generations beyond the newest three that no LIVE run may still be reading are reaped
 * (`live`, fed from the CoreEvent stream — live-generations.ts), and a baseline is removed only once
 * no generation on disk references it. `analyze` is the same validation as a PURE dry run: it
 * persists nothing and moves no revision; a `blocked` publish persists nothing either.
 *
 * # `current` is never trusted
 *
 * `currentSnapshot()` realpaths the link, requires the target to be a generation directory directly
 * under `snapshots/`, requires a well-formed `snapshot.json` whose `gen` matches the directory, and
 * re-hashes the tree against `contentHash` before it exports the path or reads the metadata. Any
 * failure is `SkillsCurrentInvalidError` — a loud config error, never a silent "not published".
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { readFileCapped } from '../api/run-files.js';
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
  SkillMirrorState,
  SkillMutationResult,
  SkillPublishResult,
  SkillReadResult,
  SkillRefreshResult,
  SkillSourceKind,
  SkillVenvState,
} from '../core/types.js';
import {
  NotAPluginRootError,
  owningSkillDir,
  pluginBundleFiles,
  REQUIRED_PLUGIN_CATALOGS,
  skillDirsOf,
  SKILLS_SUBDIR,
} from './bundle.js';
import { containedPath, decodePathParam, SkillPathError, validateRelSegments } from './contain.js';
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
  supportFileGuard,
  verdictOf,
  type CatalogView,
} from './guards.js';
import { LiveGenerations } from './live-generations.js';
import { discoverLivePlugin, gitStateOf, type PluginSource } from './plugin-source.js';
import {
  extractPluginRootRefs,
  extractRelativeRefs,
  looksBinary,
  portabilityIssueOf,
  resolvePluginRootRef,
  resolveRelativeRef,
} from './refs.js';
import {
  copyFiles,
  hashFileSet,
  makeTreeReadOnly,
  pruneEmptyDirs,
  removeFiles,
  removeTreeForce,
  sha256Hex,
  walkFiles,
  writeFileAtomic,
  type FileRecord,
} from './tree.js';
import { baselineVenvDir, UV_CACHE_DIRNAME, type VenvProvisioner } from './venv.js';

/** Explicit root override — the more specific instruction, and what the hermetic test harness arms. */
export const SKILLS_ROOT_ENV = 'WICKED_CREW_SKILLS_ROOT';
/** The default root's name under the daemon state home — a top-level entry `tests/fixtures/state-home-subtrees.json` registers. */
export const SKILLS_DIRNAME = 'skills';
export const MANIFEST_FILENAME = 'manifest.json';
export const EFFECTIVE_DIRNAME = 'effective';
export const BASELINE_DIRNAME = 'baseline';
export const SNAPSHOTS_DIRNAME = 'snapshots';
export const CURRENT_LINKNAME = 'current';
export const SNAPSHOT_MANIFEST_FILENAME = 'snapshot.json';
export const MANIFEST_VERSION = 2;
/** Generations kept after a publish (the newest `current` included) — older ones are reaped. */
export const KEEP_GENERATIONS = 3;
/** The `.claude-plugin/plugin.json` every snapshot must carry with the plugin's own name. */
const PLUGIN_JSON_REL = '.claude-plugin/plugin.json';
/** Drift findings name at most this many paths — the count carries the rest. */
const DRIFT_LIST_CAP = 12;
/** Prefix of a half-written directory (a torn publish / seed / refresh) — swept at the next pass. */
const STAGING_PREFIX = '.staging-';

/**
 * Where the root lives: env override, then the `skills_root` setting (absolute only — a relative
 * path is meaningless against an arbitrary cwd), then `<state home>/skills` (design v3.1 §1: the
 * same storage root as every other crew store).
 */
export function resolveSkillsRoot(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SKILLS_ROOT_ENV];
  if (override !== undefined && override !== '') return override;
  if (typeof setting === 'string' && setting !== '' && isAbsolute(setting)) return setting;
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

/** No plugin source could be found to seed or refresh from — crew does not vendor garden (v3 §8). */
export class SkillsSourceUnavailableError extends Error {
  constructor(detail: string) {
    super(`no wicked-garden plugin source: ${detail} — install wicked-garden first`);
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

/** A publish could not land its generation directory without destroying an existing one. */
export class SkillsPublishError extends Error {
  constructor(detail: string) {
    super(`publish refused: ${detail}`);
    this.name = 'SkillsPublishError';
  }
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
  /** `true` when the dir is not directly under `skills/` — Claude Code discovers top-level skill dirs
   *  only, so a nested skill is not invocable for a Claude seat (core enforces; crew just says so). */
  nested: boolean;
}

/** `snapshot.json` inside every published generation — what the engine reads (never a parent dir). */
export interface SnapshotManifest {
  gen: number;
  contentHash: string;
  gardenSource: { kind: SkillSourceKind; path: string; plugin_version: string; baseline: string };
  /** The baseline env's state at publish: `synced` ⇒ `.venv` links it; anything else ⇒ no link. */
  venv: SkillVenvState;
  skills: SnapshotSkillRow[];
}

/** A skill row is `{name, dir}` strings + a boolean `portable` (the seat-compatibility fact core requires). */
function isSnapshotSkillRow(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Partial<SnapshotSkillRow>;
  return typeof r.name === 'string' && r.name !== '' && typeof r.dir === 'string' && r.dir !== '' && typeof r.portable === 'boolean';
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
  /** Plugin-source discovery; defaults to the live installed plugin. */
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

export class SkillsStore {
  private rootDir: string;
  private readonly registeredRefs: () => ReadonlySet<string>;
  private readonly provisionVenv: VenvProvisioner;
  private readonly sourceFn: () => PluginSource | null;
  readonly now: () => string;
  private readonly warn: (message: string) => void;
  /** Generations live runs may still read — the reaper keeps them (fed by `observeEvent`). */
  readonly live = new LiveGenerations();
  /** The VERIFIED answer for one `current` link target — snapshots are immutable, so it holds until the link moves. */
  private currentMemo: { target: string; value: { gen: number; path: string } } | null = null;
  /** `currentSnapshot()?.gen` memoized for the per-event hot path; `undefined` = not yet read. */
  private currentGenMemo: number | null | undefined = undefined;

  constructor(opts: SkillsStoreOptions) {
    this.rootDir = opts.root;
    this.registeredRefs = opts.registeredSkillRefs;
    this.provisionVenv = opts.provisionVenv;
    this.sourceFn = opts.source ?? (() => discoverLivePlugin());
    this.now = opts.now ?? (() => new Date().toISOString());
    this.warn = opts.warn ?? ((m) => console.warn(m));
  }

  // ── Paths ─────────────────────────────────────────────────────────────────────────────────

  get root(): string {
    return this.rootDir;
  }

  /** Re-aim the store (the `skills_root` setting changed). Touches no disk. */
  reroot(root: string): void {
    this.rootDir = root;
    this.currentMemo = null;
    this.currentGenMemo = undefined;
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
    return containedPath(this.rootDir, [EFFECTIVE_DIRNAME, ...segments]);
  }

  private containedBaseline(hash: string, segments: ReadonlyArray<string>): string {
    return containedPath(this.rootDir, [BASELINE_DIRNAME, hash, ...segments]);
  }

  /** A skill's dir must be reachable without crossing a link before anything walks or writes it. */
  private assertSkillDirContained(dir: string): void {
    this.containedEffective(dir.split('/'));
  }

  // ── Manifest ──────────────────────────────────────────────────────────────────────────────

  isSeeded(): boolean {
    return existsSync(this.manifestPath());
  }

  /** The manifest, or `SkillsUnseededError` / `SkillsManifestCorruptError`. */
  manifest(): SkillManifest {
    const path = this.manifestPath();
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') throw new SkillsUnseededError(this.rootDir);
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SkillsManifestCorruptError(path, err instanceof Error ? err.message : String(err));
    }
    if (typeof parsed !== 'object' || parsed === null) throw new SkillsManifestCorruptError(path, 'not an object');
    const m = parsed as Partial<SkillManifest>;
    if (m.version !== MANIFEST_VERSION) throw new SkillsManifestCorruptError(path, `version ${String(m.version)}`);
    if (typeof m.revision !== 'number') throw new SkillsManifestCorruptError(path, 'no revision');
    if (typeof m.skills !== 'object' || m.skills === null) throw new SkillsManifestCorruptError(path, 'no skills map');
    if (typeof m.files !== 'object' || m.files === null) throw new SkillsManifestCorruptError(path, 'no files map');
    if (typeof m.baseline !== 'string' || typeof m.baselines !== 'object' || m.baselines === null) {
      throw new SkillsManifestCorruptError(path, 'no baseline record');
    }
    return m as SkillManifest;
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
    writeFileAtomic(this.manifestPath(), `${JSON.stringify(m, null, 2)}\n`);
  }

  private assertRevision(m: SkillManifest, expected: number): void {
    if (expected !== m.revision) throw new RevisionMismatchError(expected, m.revision);
  }

  // ── `current` ─────────────────────────────────────────────────────────────────────────────

  /**
   * The published snapshot `current` resolves to, VERIFIED (module header), or `null` when there
   * is no link (never published). `path` is the absolute REAL path of the generation — exactly the
   * value the engine is handed as `WICKED_SKILLS_SNAPSHOT` (v3.1 §2). A link that exists but fails
   * verification throws `SkillsCurrentInvalidError`. The verified answer is memoized per link target.
   */
  currentSnapshot(): { gen: number; path: string } | null {
    const link = this.currentLink();
    let target: string;
    try {
      target = readlinkSync(link);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return null;
      if (errnoCode(err) === 'EINVAL') throw new SkillsCurrentInvalidError(link, 'it is not a symbolic link');
      throw err;
    }
    if (this.currentMemo !== null && this.currentMemo.target === target) return this.currentMemo.value;
    const value = this.verifyCurrent(link, target);
    this.currentMemo = { target, value };
    return value;
  }

  private verifyCurrent(link: string, target: string): { gen: number; path: string } {
    const invalid = (detail: string): never => {
      throw new SkillsCurrentInvalidError(link, detail);
    };
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
    const parsed = this.parseSnapshotManifest(lexical);
    if (typeof parsed === 'string') return invalid(parsed);
    if (parsed.gen !== Number(dirName)) return invalid(`snapshot.json says gen ${parsed.gen} but the directory is ${dirName}`);
    const hash = this.snapshotHash(real);
    if (hash !== parsed.contentHash) {
      return invalid(`content hash mismatch — snapshot.json records ${parsed.contentHash}, the tree hashes ${hash}: the immutable snapshot was modified`);
    }
    return { gen: parsed.gen, path: real };
  }

  /** Hash over a snapshot dir's files, `snapshot.json` excluded (the `.venv` link is skipped by the walk). */
  private snapshotHash(dir: string): string {
    return hashFileSet(walkFiles(dir).filter((f) => f.rel !== SNAPSHOT_MANIFEST_FILENAME));
  }

  /** `snapshot.json` at `dir`, structurally validated — or the reason it is not one. */
  private parseSnapshotManifest(dir: string): SnapshotManifest | string {
    let raw: string;
    try {
      raw = readFileSync(join(dir, SNAPSHOT_MANIFEST_FILENAME), 'utf8');
    } catch (err) {
      return `no readable ${SNAPSHOT_MANIFEST_FILENAME} in ${dir} (${errnoCode(err) ?? 'error'})`;
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
      return `${SNAPSHOT_MANIFEST_FILENAME} has a skill row without {name, dir} strings and a boolean portable — core cannot judge seat compatibility from it`;
    }
    if (typeof s.gardenSource !== 'object' || s.gardenSource === null || typeof s.gardenSource.baseline !== 'string') {
      return `${SNAPSHOT_MANIFEST_FILENAME} has no gardenSource.baseline`;
    }
    return s as SnapshotManifest;
  }

  /** The verified `snapshot.json` of a published generation (the mirror reads it through here). */
  readSnapshotManifest(dir: string): SnapshotManifest {
    const parsed = this.parseSnapshotManifest(dir);
    if (typeof parsed === 'string') throw new SkillsCurrentInvalidError(dir, parsed);
    return parsed;
  }

  /** `currentSnapshot()?.gen` without touching disk after the first read — publish keeps it current. */
  private currentGen(): number | null {
    if (this.currentGenMemo === undefined) {
      try {
        this.currentGenMemo = this.currentSnapshot()?.gen ?? null;
      } catch (err) {
        // The event listener must not die on a corrupt root; pin nothing and say so once.
        this.warn(`[skills] current snapshot unverifiable, live runs pin no generation: ${err instanceof Error ? err.message : String(err)}`);
        this.currentGenMemo = null;
      }
    }
    return this.currentGenMemo;
  }

  /**
   * Fold one CoreEvent into the live-generation ledger (v3 §1 reaping rule): a live session pins
   * the generation `current` resolves to; its terminal frame releases the pins and reaps what no
   * other live session holds. The daemon calls this from its one `adapter.onEvent` listener.
   */
  observeEvent(event: CoreEvent): void {
    if (this.live.observe(event, this.currentGen()) === 'released') this.reapStale();
  }

  /** Reap generations beyond the newest `KEEP_GENERATIONS` that no live session pins (no-op before a publish). */
  reapStale(): void {
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
   * `SkillsSourceUnavailableError` when no plugin is installed.
   */
  seed(): SeedResult {
    if (this.isSeeded()) return { seeded: false, baseline: null, source: null };
    const source = this.requireSource('no installed wicked-garden plugin found in the Claude plugin cache (plugins/cache/wicked-garden); set WICKED_CREW_SKILLS_SOURCE to use another plugin root deliberately');
    const bundle = pluginBundleFiles(source.path);
    const hash = hashFileSet(bundle);
    mkdirSync(this.rootDir, { recursive: true });
    this.captureBaseline(bundle, hash);
    const effective = this.effectiveDir();
    rmSync(effective, { recursive: true, force: true });
    copyFiles(bundle, effective);
    rmSync(this.snapshotsDir(), { recursive: true, force: true });
    rmSync(this.currentLink(), { force: true });
    this.currentMemo = null;
    this.currentGenMemo = null;

    const files: Record<string, SkillFileRecord> = {};
    for (const f of this.scanEffective()) {
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
      mirror: { ledger: {}, skipped_non_portable: [], foreign_modified: {}, last_run: null },
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

  /** Copy the bundle to `baseline/<hash>/` through a staging dir (a torn copy never bears the hash). */
  private captureBaseline(bundle: ReadonlyArray<FileRecord>, hash: string): void {
    const dest = this.baselineDir(hash);
    if (existsSync(dest)) return;
    const parent = join(this.rootDir, BASELINE_DIRNAME);
    mkdirSync(parent, { recursive: true });
    this.sweepStaging(parent);
    const staging = join(parent, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    copyFiles(bundle, staging);
    if (existsSync(dest)) {
      removeTreeForce(staging); // raced by another capture of the same bytes — theirs is as good
      return;
    }
    renameSync(staging, dest);
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
   * Provision the baseline's `.venv` unless it is already `synced`, record the outcome (state, not
   * a user mutation — no revision bump), and lock a synced env read-only. AWAITED by publish.
   */
  private async ensureVenv(hash: string): Promise<SkillVenvState> {
    const before = this.manifest().baselines[hash];
    if (before?.venv === 'synced' && existsSync(baselineVenvDir(this.baselineDir(hash)))) return 'synced';
    const state = await this.provisionVenv(this.baselineDir(hash), { log: this.warn, cacheDir: this.uvCacheDir() });
    if (state === 'synced') makeTreeReadOnly(baselineVenvDir(this.baselineDir(hash)));
    if (!this.isSeeded()) return state; // torn down meanwhile
    const m = this.manifest();
    const record = m.baselines[hash];
    if (record !== undefined && record.venv !== state) {
      record.venv = state;
      this.writeManifest(m);
    }
    return state;
  }

  /**
   * Boot / settings entry point: seed when unseeded, finish a publish a crash interrupted between
   * the manifest commit and the `current` flip, publish when nothing is published. Throws
   * `SkillsSourceUnavailableError` for the seed and `SkillsCurrentInvalidError` /
   * `SkillsManifestCorruptError` for a corrupt root; a blocked first publish is returned, not thrown.
   */
  async ensureReady(): Promise<{ seeded: boolean; published: SkillPublishResult | null }> {
    const seeded = this.seed().seeded;
    const m = this.manifest();
    const current = this.currentSnapshot();
    if (m.published !== null && (current === null || current.gen < m.published.gen)) {
      const dir = this.snapshotDir(m.published.gen);
      const parsed = this.parseSnapshotManifest(dir);
      if (
        typeof parsed !== 'string' &&
        parsed.gen === m.published.gen &&
        parsed.contentHash === m.published.contentHash &&
        this.snapshotHash(dir) === parsed.contentHash
      ) {
        this.warn(`[skills] finishing an interrupted publish: current -> ${generationDirName(parsed.gen)}`);
        this.flipCurrent(parsed.gen);
        return { seeded, published: null };
      }
    }
    if (current !== null) return { seeded, published: null };
    return { seeded, published: await this.publish(m.revision) };
  }

  // ── Scanning ──────────────────────────────────────────────────────────────────────────────

  /** Every managed file under `effective/`, hashed. */
  private scanEffective(): ScannedFile[] {
    return walkFiles(this.effectiveDir()).map((f) => ({ rel: f.rel, abs: f.abs, sha: sha256Hex(readFileSync(f.abs)) }));
  }

  /** Every manifest `dir` — what a skill's own-files walk prunes nested skills against. */
  private manifestDirs(m: SkillManifest): Set<string> {
    return new Set(Object.values(m.skills).map((e) => e.dir));
  }

  /** Plugin-relative paths of the skill's own files ON DISK in `base` (nested skill subtrees excluded). */
  private ownFilesIn(base: string, dir: string, skillDirs: ReadonlySet<string>): FileRecord[] {
    return walkFiles(this.pluginPath(dir, base), (rel) => skillDirs.has(`${dir}/${rel}`)).map((f) => ({
      rel: `${dir}/${f.rel}`,
      abs: f.abs,
    }));
  }

  /** Manifest file records that belong to the skill (nested skills excluded), keyed by plugin-relative path. */
  private ownRecords(m: SkillManifest, dir: string): Array<[string, SkillFileRecord]> {
    const dirs = this.manifestDirs(m);
    return Object.entries(m.files).filter(([rel]) => owningSkillDir(rel, dirs) === dir);
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
   */
  private rebuildCatalog(m: SkillManifest): void {
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
      };
      byDir.set(dir, name);
    }
    this.recomputeDerived(m);
  }

  /**
   * The manifest key for a freshly discovered skill dir: ALWAYS the path-derived name (v3 §5 —
   * identity is one thing). A declared frontmatter name that differs is warned here and reported
   * as `name-mismatch` (blocking) at publish; two dirs deriving the same name (`a-b/c` and `a/b-c`)
   * cannot both be registered — the second is left for publish to report as `unregistered-skill`.
   */
  private nameForDir(m: SkillManifest, dir: string): string | null {
    const derived = derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
    const parsed = parseFrontmatter(readFileSync(this.pluginPath(`${dir}/SKILL.md`), 'utf8'));
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
    const dirs = this.manifestDirs(m);
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
   */
  private recomputeDerived(m: SkillManifest): void {
    const catalogMd = new Map<string, string>();
    const byOwner = this.recordsByOwner(m);
    for (const [name, entry] of Object.entries(m.skills)) {
      const records = byOwner.get(entry.dir) ?? [];
      const userAdded = records.length > 0 && records.every(([, r]) => r.baselineHash === null);
      const pristine = records.every(([, r]) => r.baselineHash !== null && r.effectiveHash === r.baselineHash);
      entry.provenance = userAdded ? 'user-added' : pristine ? 'shipped' : 'override';
      const fileConflict = records.some(([, r]) => r.conflict);
      entry.upgradeAvailable = fileConflict;
      entry.conflict = fileConflict || (entry.conflict && userAdded);
      const skillMdAbs = this.pluginPath(`${entry.dir}/SKILL.md`);
      let kind: SkillKind = 'module';
      if (existsSync(skillMdAbs)) {
        const text = readFileSync(skillMdAbs, 'utf8');
        catalogMd.set(name, text);
        const parsed = parseFrontmatter(text);
        if (parsed.ok) kind = skillKindOf(parsed.fields);
      }
      entry.kind = kind;
      entry.portable = records
        .filter(([, r]) => r.effectiveHash !== null)
        .every(([rel]) => {
          const buf = readFileSync(this.pluginPath(rel));
          return looksBinary(buf) || portabilityIssueOf(buf.toString('utf8')) === null;
        });
    }
    const closure = coreClosure(this.registeredRefs(), catalogMd);
    for (const [name, entry] of Object.entries(m.skills)) entry.core = closure.core.has(name);
  }

  /** Whether the current baseline ships a skill at `dir` (a user-added skill has no baseline dir). */
  private hasBaselineDir(m: SkillManifest, dir: string): boolean {
    return existsSync(join(this.baselineDir(m.baseline), ...dir.split('/'), 'SKILL.md'));
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
    const files = this.ownFilesIn(this.effectiveDir(), entry.dir, this.manifestDirs(m)).map((f) => ({
      path: f.rel.slice(entry.dir.length + 1),
      size: statSync(f.abs).size,
      sha256: sha256Hex(readFileSync(f.abs)),
      record: m.files[f.rel] ?? null,
    }));
    return { name, dir: entry.dir, enabled: entry.enabled, files };
  }

  /**
   * Contain a skill-relative path (raw from the URL): decode once, validate, refuse a path a NESTED
   * skill owns, lstat-walk FROM THE ROOT through the skill dir refusing symlinks. Returns the
   * on-disk target in `effective/` and both spellings of the path.
   */
  resolveSkillFile(name: string, rawRel: string): { abs: string; rel: string; pluginRel: string } {
    const m = this.manifest();
    const entry = m.skills[name];
    if (entry === undefined) throw new UnknownSkillError(name);
    const segments = validateRelSegments(decodePathParam(rawRel));
    const rel = segments.join('/');
    const pluginRel = `${entry.dir}/${rel}`;
    const owner = owningSkillDir(pluginRel, this.manifestDirs(m));
    if (owner !== entry.dir) {
      const ownerName = Object.entries(m.skills).find(([, e]) => e.dir === owner)?.[0] ?? owner;
      throw new SkillPathError(
        'nested-skill',
        `${rel} belongs to the nested skill ${ownerName} (${owner}) — address it through that skill`,
      );
    }
    const abs = this.containedEffective([...entry.dir.split('/'), ...segments]);
    return { abs, rel, pluginRel };
  }

  /** Contain a root support path: not under `skills/` (those belong to a skill's endpoint), no symlinks. */
  resolveSupportFile(rawRel: string): { abs: string; rel: string } {
    const segments = validateRelSegments(decodePathParam(rawRel));
    const rel = segments.join('/');
    if (segments[0] === SKILLS_SUBDIR) {
      throw new SkillPathError(
        'nested-skill',
        `${rel} is under ${SKILLS_SUBDIR}/ — skill files are addressed through /skills/:name/files`,
      );
    }
    return { abs: this.containedEffective(segments), rel };
  }

  /** A typed, capped read of one of the skill's files (`side: 'baseline'` reads the shipped copy, contained the same way). */
  async readFile(name: string, rawRel: string, side: ReadSide = 'effective'): Promise<SkillReadResult> {
    const target = this.resolveSkillFile(name, rawRel);
    const abs = side === 'effective' ? target.abs : this.containedBaseline(this.manifest().baseline, target.pluginRel.split('/'));
    return this.typedRead(target.pluginRel, abs);
  }

  async readSupport(rawRel: string, side: ReadSide = 'effective'): Promise<SkillReadResult> {
    const target = this.resolveSupportFile(rawRel);
    const abs = side === 'effective' ? target.abs : this.containedBaseline(this.manifest().baseline, target.rel.split('/'));
    return this.typedRead(target.rel, abs);
  }

  /** The capped read as the wire spells it: `content` is `null` — not `""` — when the file is binary. */
  private async typedRead(path: string, abs: string): Promise<SkillReadResult> {
    const read = await readFileCapped(abs);
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
    const explanation =
      err.reason === 'symlink'
        ? 'the skills root never follows symlinks — a link on the path (the skill directory itself included) would redirect the write outside the store'
        : err.reason === 'nested-skill'
          ? 'a nested skill owns its own files; address it through that skill'
          : 'the path must be a normalized skill-relative POSIX path that stays inside the skill directory';
    return finding('path-invalid', 'blocking', explanation, err.message, { skill, file });
  }

  /** Re-hash the skill's own files on disk into the records (absent baseline files stay as `effectiveHash: null`). */
  private refreshRecords(m: SkillManifest, dir: string): void {
    const onDisk = new Map(this.ownFilesIn(this.effectiveDir(), dir, this.manifestDirs(m)).map((f) => [f.rel, f.abs]));
    for (const [rel, record] of this.ownRecords(m, dir)) {
      const abs = onDisk.get(rel);
      if (abs === undefined) {
        if (record.baselineHash === null) delete m.files[rel];
        else record.effectiveHash = null;
      } else {
        record.effectiveHash = sha256Hex(readFileSync(abs));
        onDisk.delete(rel);
      }
    }
    const base = this.baselineDir(m.baseline);
    for (const [rel, abs] of onDisk) {
      const baseAbs = this.pluginPath(rel, base);
      m.files[rel] = {
        baselineHash: existsSync(baseAbs) ? sha256Hex(readFileSync(baseAbs)) : null,
        effectiveHash: sha256Hex(readFileSync(abs)),
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

  enable(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    if (entry.enabled) return this.result(m, name, []);
    entry.enabled = true;
    this.commit(m);
    return this.result(m, name, []);
  }

  /** Disable — core membership is RECOMPUTED here (registered refs are read at use time), never trusted from the cached entry. */
  disable(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    this.recomputeDerived(m);
    const findings = compact([coreDisableGuard(name, entry)]);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    if (!entry.enabled) return this.result(m, name, findings);
    entry.enabled = false;
    this.commit(m);
    return this.result(m, name, findings);
  }

  /** Restore the skill's own files from the current baseline (mode bits ride the copy). `enabled` is untouched by design. */
  reset(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const findings = compact([noBaselineGuard(name, !this.hasBaselineDir(m, entry.dir))]);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    try {
      this.assertSkillDirContained(entry.dir);
    } catch (err) {
      return this.blocked(m, [this.pathFinding(err, name, entry.dir)]);
    }
    const base = this.baselineDir(m.baseline);
    const baseDirs = skillDirsOf(walkFiles(base));
    const fresh = this.ownFilesIn(base, entry.dir, baseDirs);
    const effective = this.effectiveDir();
    removeFiles(this.ownFilesIn(effective, entry.dir, this.manifestDirs(m)), effective);
    copyFiles(fresh, effective);
    for (const [rel, record] of this.ownRecords(m, entry.dir)) {
      if (record.baselineHash === null) delete m.files[rel];
      else {
        record.effectiveHash = record.baselineHash;
        record.conflict = false;
      }
    }
    entry.editedAt = null;
    entry.conflict = false;
    this.recomputeDerived(m);
    this.commit(m);
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
    const findings = this.putGuards(name, entry, target.rel, content);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    writeFileAtomic(target.abs, content);
    entry.editedAt = this.now();
    this.refreshRecords(m, entry.dir);
    this.recomputeDerived(m);
    this.commit(m);
    return this.result(m, name, findings);
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
    writeFileAtomic(target.abs, content);
    const sha = sha256Hex(Buffer.from(content, 'utf8'));
    const record = m.files[target.rel];
    if (record === undefined) {
      const baseAbs = this.pluginPath(target.rel, this.baselineDir(m.baseline));
      m.files[target.rel] = {
        baselineHash: existsSync(baseAbs) ? sha256Hex(readFileSync(baseAbs)) : null,
        effectiveHash: sha,
        lastPublishedHash: null,
        conflict: false,
      };
    } else {
      record.effectiveHash = sha;
    }
    this.commit(m);
    return this.result(m, null, findings);
  }

  /** Add a user skill at `skills/<name minus the prefix>`. */
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
    for (const [rel, text] of Object.entries(files)) writeFileAtomic(this.pluginPath(`${dir}/${rel}`), text);
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
    };
    this.refreshRecords(m, dir);
    this.recomputeDerived(m);
    this.commit(m);
    return this.result(m, name, findings);
  }

  /** Replace the skill's own files wholesale (nested skills untouched); an existing file's mode bits survive the replace. */
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
    const own = this.ownFilesIn(effective, entry.dir, this.manifestDirs(m));
    const modes = new Map(own.map((f) => [f.rel, lstatSync(f.abs).mode & 0o777]));
    removeFiles(own, effective);
    for (const [rel, text] of Object.entries(files)) {
      const mode = modes.get(`${entry.dir}/${rel}`);
      writeFileAtomic(this.pluginPath(`${entry.dir}/${rel}`), text, mode === undefined ? {} : { mode });
    }
    entry.editedAt = this.now();
    this.refreshRecords(m, entry.dir);
    this.recomputeDerived(m);
    this.commit(m);
    return this.result(m, name, findings);
  }

  private putGuards(name: string, entry: SkillEntry, rel: string, content: string): SkillConflictFinding[] {
    const out: SkillConflictFinding[] = [];
    if (rel === 'SKILL.md') out.push(...frontmatterGuard(content, name, { isCore: entry.core, file: `${entry.dir}/SKILL.md` }));
    out.push(...compact([nestedSkillCreateGuard(rel, name), supportFileGuard(rel, name)]));
    if (entry.portable) out.push(...compact([nonPortableGuard({ [rel]: content }, name)]));
    return out;
  }

  private filesGuards(name: string, files: Readonly<Record<string, string>>): SkillConflictFinding[] {
    const out: SkillConflictFinding[] = [];
    for (const rel of Object.keys(files).sort()) {
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
    out.push(...compact([nonPortableGuard(files, name)]));
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
    out.push(...this.filesGuards(name, files));
    out.push(...frontmatterGuard(files['SKILL.md'], name, { isCore: this.registeredRefs().has(name), file: `${dir}/SKILL.md` }));
    return out;
  }

  private replaceGuards(m: SkillManifest, name: string, entry: SkillEntry, files: Readonly<Record<string, string>>): SkillConflictFinding[] {
    const out = this.filesGuards(name, files);
    const nestedUnder = [...this.manifestDirs(m)].filter((d) => d !== entry.dir && d.startsWith(`${entry.dir}/`));
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
   */
  refreshBaseline(expectedRevision: number): SkillRefreshResult {
    const m = this.manifest();
    this.assertRevision(m, expectedRevision);
    const source = this.requireSource('no installed wicked-garden plugin found to refresh from');
    const bundle = pluginBundleFiles(source.path);
    const newHash = hashFileSet(bundle);
    const previous = m.baseline;
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
    if (newHash === previous) return base(); // byte-identical upstream: nothing to merge

    this.captureBaseline(bundle, newHash);
    const newBase = this.baselineDir(newHash);
    const newFiles = new Map(bundle.map((f) => [f.rel, sha256Hex(readFileSync(f.abs))]));
    const effective = new Map(this.scanEffective().map((f) => [f.rel, f.sha]));
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
    for (const entry of Object.values(m.skills)) entry.conflict = false;
    for (const dir of skillDirsOf(bundle)) {
      if (manifestDirs.has(dir)) continue;
      const name = derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
      const existing = m.skills[name];
      if (existing === undefined || existing.dir === dir) continue;
      heldBack.add(dir);
      existing.conflict = true;
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

    const touched = new Set<string>();
    const rels = new Set([...oldFiles.keys(), ...newFiles.keys(), ...effective.keys()]);
    for (const rel of [...rels].sort()) {
      if (isHeld(rel)) continue;
      const bo = oldFiles.get(rel) ?? null;
      const bn = newFiles.get(rel) ?? null;
      const e = effective.get(rel) ?? null;
      const record = m.files[rel];
      const take = (): void => {
        copyFiles([{ rel, abs: this.pluginPath(rel, newBase) }], this.effectiveDir());
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
          rmSync(this.pluginPath(rel), { force: true });
          pruneEmptyDirs(dirname(this.pluginPath(rel)), this.effectiveDir());
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

    // Catalog: register upstream-new dirs, drop skills with NO records left (upstream removed them
    // and the operator never touched them — a skill the operator deleted files from keeps its
    // baseline-backed records, stays in the catalog as an override, and blocks publish until reset
    // or disabled), recompute the rest.
    const before = new Set(Object.keys(m.skills));
    for (const [name, entry] of Object.entries(m.skills)) {
      if (existsSync(this.pluginPath(`${entry.dir}/SKILL.md`))) continue;
      if (this.ownRecords(m, entry.dir).length > 0) continue;
      delete m.skills[name];
    }
    // The new baseline is the one `recomputeDerived` / `hasBaselineDir` read from now on.
    m.baselines[newHash] = this.baselineRecord(source);
    m.baseline = newHash;
    this.rebuildCatalog(m);
    for (const [name, entry] of Object.entries(m.skills)) {
      if (conflicts.has(name)) entry.conflict = true;
      else if (entry.upgradeAvailable) conflicts.add(name);
    }
    const after = new Set(Object.keys(m.skills));
    const added = [...after].filter((n) => !before.has(n)).sort();
    const removed = [...before].filter((n) => !after.has(n)).sort();
    const dirOf = new Map(Object.entries(m.skills).map(([name, e]) => [e.dir, name]));
    const skillOfRel = (rel: string): string | null => {
      const owner = owningSkillDir(rel, new Set(dirOf.keys()));
      return owner === null ? null : (dirOf.get(owner) ?? null);
    };
    const taken = new Set<string>();
    const kept = new Set<string>();
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
          'both the operator and upstream changed this skill (a deletion by the operator counts); the operator\'s content is kept and the upstream side is readable as ?side=baseline — reset takes upstream wholesale',
          `${name} (${entry.dir}) has conflicting files`,
          { skill: name },
        ),
      );
    }

    this.commit(m);
    // The previous baseline goes only when no snapshot on disk still links its `.venv` / records it.
    this.reapBaselines();
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
   * Provision the baseline env (awaited), re-check the CAS, validate the whole tree, then write
   * `snapshots/<gen>/` (staging + rename, never over an existing generation), COMMIT the manifest,
   * flip `current`, and reap generations / baselines nothing references. A `blocked` verdict
   * persists nothing — the caller's revision stays valid.
   */
  async publish(expectedRevision: number): Promise<SkillPublishResult> {
    const pre = this.manifest();
    this.assertRevision(pre, expectedRevision);
    // Provisioning FIRST (it may take minutes): a snapshot never links an env still being written.
    const venv = await this.ensureVenv(pre.baseline);
    const m = this.manifest(); // the world may have moved while uv ran — the CAS is re-checked
    this.assertRevision(m, expectedRevision);
    const v = this.validate(m);
    if (verdictOf(v.findings) === 'blocked') {
      return { verdict: 'blocked', findings: v.findings, revision: m.revision, snapshot: null };
    }
    const gen = this.nextGeneration(m);
    const contentHash = hashFileSet(v.snapshotFiles);
    const snapshots = this.snapshotsDir();
    mkdirSync(snapshots, { recursive: true });
    this.sweepStaging(snapshots);
    const staging = join(snapshots, `${STAGING_PREFIX}${randomBytes(6).toString('hex')}`);
    copyFiles(v.snapshotFiles, staging);
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
          nested: isNestedSkillDir(entry.dir),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
    writeFileAtomic(join(staging, SNAPSHOT_MANIFEST_FILENAME), `${JSON.stringify(snapshot, null, 2)}\n`);
    // The shared per-baseline env, linked ONLY when it exists (a Windows junction needs its target;
    // a dangling link would let a worker's `uv run` create the env THROUGH it into the baseline).
    // `snapshot.json.venv` carries the state either way.
    const venvDir = baselineVenvDir(this.baselineDir(m.baseline));
    if (venv === 'synced' && existsSync(venvDir)) {
      this.symlink(posix.join('..', '..', BASELINE_DIRNAME, m.baseline, '.venv'), join(staging, '.venv'), venvDir);
    }
    const dest = this.snapshotDir(gen);
    if (this.entryExists(dest)) {
      removeTreeForce(staging);
      throw new SkillsPublishError(`${dest} already exists — a published generation is never removed or overwritten`);
    }
    renameSync(staging, dest);

    // Manifest FIRST, then `current`: a crash in between leaves a committed generation `ensureReady`
    // finishes flipping to; the reverse order would leave a live `current` the manifest disowns.
    const included = new Set(v.snapshotFiles.map((f) => f.rel));
    for (const [rel, r] of Object.entries(m.files)) {
      if (included.has(rel)) r.lastPublishedHash = r.effectiveHash;
    }
    m.published = { gen, contentHash, at: this.now() };
    this.commit(m);
    this.flipCurrent(gen);
    this.live.published(gen);
    this.reapGenerations(gen);
    this.reapBaselines();
    return {
      verdict: verdictOf(v.findings),
      findings: v.findings,
      revision: m.revision,
      // The REAL path — the same spelling `currentSnapshot()` answers and the engine is handed.
      snapshot: { gen, path: realpathSync(dest), contentHash, skills: snapshot.skills.length },
    };
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

  /** `current -> snapshots/<gen>`: create the link beside it under a random name, then rename over — atomic on POSIX. */
  private flipCurrent(gen: number): void {
    const link = this.currentLink();
    const tmp = `${link}.tmp-${randomBytes(6).toString('hex')}`;
    this.symlink(posix.join(SNAPSHOTS_DIRNAME, generationDirName(gen)), tmp, this.snapshotDir(gen));
    renameSync(tmp, link);
    this.currentMemo = null;
    this.currentGenMemo = gen;
  }

  /** A directory symlink: relative target on POSIX; Windows junctions need the absolute target (and it must exist). */
  private symlink(relTarget: string, linkPath: string, absTarget: string): void {
    if (process.platform === 'win32') symlinkSync(absTarget, linkPath, 'junction');
    else symlinkSync(relTarget, linkPath);
  }

  /**
   * Remove every generation older than the newest `KEEP_GENERATIONS` — never the current one, and
   * never one a live session still pins (it is reaped by the release that frees it).
   */
  private reapGenerations(currentGen: number): void {
    const pinned = this.live.pinned();
    const gens = this.generationsOnDisk()
      .filter((g) => g !== currentGen)
      .sort((a, b) => b - a);
    for (const gen of gens.slice(KEEP_GENERATIONS - 1)) {
      if (pinned.has(gen)) continue;
      rmSync(this.snapshotDir(gen), { recursive: true, force: true });
    }
  }

  /**
   * Remove every baseline dir (and its record) that neither the manifest nor ANY generation on
   * disk references — a retained snapshot keeps the `.venv` it links alive. Records mirror the dirs
   * that exist; the write is bookkeeping (no revision bump).
   */
  private reapBaselines(): void {
    if (!this.isSeeded()) return;
    const m = this.manifest();
    const referenced = new Set<string>([m.baseline]);
    for (const gen of this.generationsOnDisk()) {
      const parsed = this.parseSnapshotManifest(this.snapshotDir(gen));
      if (typeof parsed !== 'string') referenced.add(parsed.gardenSource.baseline);
    }
    const parent = join(this.rootDir, BASELINE_DIRNAME);
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return;
      throw err;
    }
    let changed = false;
    for (const e of entries) {
      if (e.startsWith('.') || referenced.has(e)) continue;
      removeTreeForce(join(parent, e));
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
    if (changed) this.writeManifest(m);
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

  /**
   * Whole-tree validation (v3 §API "unresolved refs blocking at publish", §5 core closure, §6
   * nested ownership). Mutates `m` IN MEMORY for bookkeeping only (drift into the file records,
   * derived fields, the core closure) — the caller decides whether that is persisted (publish
   * commits it; analyze and a blocked publish drop it). Never touches `effective/`.
   */
  private validate(m: SkillManifest): Validation {
    const findings: SkillConflictFinding[] = [];
    const scanned = this.scanEffective();
    const onDisk = new Map(scanned.map((f) => [f.rel, f]));

    // Direct filesystem edits: detected by hash, reported, recorded — never silently trusted.
    const drift: string[] = [];
    const base = this.baselineDir(m.baseline);
    for (const f of scanned) {
      const record = m.files[f.rel];
      if (record === undefined) {
        const baseAbs = this.pluginPath(f.rel, base);
        m.files[f.rel] = {
          baselineHash: existsSync(baseAbs) ? sha256Hex(readFileSync(baseAbs)) : null,
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
    this.recomputeDerived(m);
    const catalogMd = new Map<string, string>();
    for (const [name, entry] of Object.entries(m.skills)) {
      const rel = `${entry.dir}/SKILL.md`;
      const f = onDisk.get(rel);
      if (f !== undefined) catalogMd.set(name, readFileSync(f.abs, 'utf8'));
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
    const dirs = this.manifestDirs(m);
    for (const [name, entry] of Object.entries(m.skills).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const severity = entry.enabled ? 'blocking' : 'warning';
      const skillMd = catalogMd.get(name);
      findings.push(...frontmatterGuard(skillMd, name, { isCore: entry.core, file: `${entry.dir}/SKILL.md`, severity }));
      if (entry.core && !entry.enabled) findings.push(...compact([coreDisableGuard(name, entry)]));
      if (entry.enabled) enabledSkills.push({ name, entry });
    }

    // The would-be snapshot: support files + enabled skills' own files (owner computed once per file).
    const ownerOf = new Map(scanned.map((f) => [f.rel, owningSkillDir(f.rel, dirs)]));
    const snapshotFiles: FileRecord[] = [];
    const filesByOwner = new Map<string, FileRecord[]>();
    for (const f of scanned) {
      const owner = ownerOf.get(f.rel) ?? null;
      if (owner === null) {
        if (!f.rel.startsWith(`${SKILLS_SUBDIR}/`)) snapshotFiles.push({ rel: f.rel, abs: f.abs });
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
        const buf = readFileSync(f.abs);
        if (looksBinary(buf)) continue;
        const text = buf.toString('utf8');
        for (const ref of extractPluginRootRefs(text)) {
          const verdict = resolves(ref.path);
          if (verdict === 'ok') continue;
          findings.push(
            finding(
              'unresolved-ref',
              'blocking',
              verdict === 'escape'
                ? 'a `${CLAUDE_PLUGIN_ROOT}` reference must stay inside the plugin root; one that climbs out of it (`..`) reaches whatever lies beside the snapshot on the worker host'
                : 'the snapshot is the plugin root workers see; a `${CLAUDE_PLUGIN_ROOT}` reference that does not resolve inside it fails at first use',
              `\${CLAUDE_PLUGIN_ROOT}/${ref.path}${verdict === 'escape' ? ' — escapes the plugin root' : whyMissing(ref.path)}`,
              { skill: name, file: f.rel, line: ref.line },
            ),
          );
        }
        for (const ref of extractRelativeRefs(text)) {
          const target = resolveRelativeRef(f.rel, ref.path);
          const verdict = target === null ? 'escape' : resolves(target);
          if (verdict === 'ok') continue;
          findings.push(
            finding(
              'unresolved-ref',
              'blocking',
              'a `../` link must land inside the snapshot; one that climbs out of the plugin root or into a skill the snapshot omits is broken for every worker',
              `${ref.path}${target === null || verdict === 'escape' ? ' — escapes the plugin root' : whyMissing(target)}`,
              { skill: name, file: f.rel, line: ref.line },
            ),
          );
        }
      }
    }

    // The plugin manifest + the runtime catalogs: present, parseable, still naming this plugin.
    const pluginJson = onDisk.get(PLUGIN_JSON_REL);
    if (pluginJson === undefined) {
      findings.push(finding('missing-plugin-manifest', 'blocking', 'a plugin root is its .claude-plugin/plugin.json — Claude Code loads nothing without it', `no ${PLUGIN_JSON_REL} in effective/`, { file: PLUGIN_JSON_REL }));
    } else {
      let declared: unknown;
      try {
        declared = (JSON.parse(readFileSync(pluginJson.abs, 'utf8')) as { name?: unknown }).name;
      } catch (err) {
        findings.push(finding('frontmatter-invalid', 'blocking', 'Claude Code loads a plugin from its manifest; one it cannot parse loads nothing', `${PLUGIN_JSON_REL}: ${err instanceof Error ? err.message : String(err)}`, { file: PLUGIN_JSON_REL }));
      }
      if (declared !== undefined && declared !== PLUGIN_NAME) {
        findings.push(finding('name-mismatch', 'blocking', `workers invoke skills as \`${PLUGIN_NAME}:<skill>\`; the plugin manifest must keep that name`, `${PLUGIN_JSON_REL} names ${JSON.stringify(declared)}`, { file: PLUGIN_JSON_REL }));
      }
    }
    for (const rel of REQUIRED_PLUGIN_CATALOGS) {
      if (onDisk.has(rel)) continue;
      findings.push(
        finding(
          'missing-plugin-manifest',
          'blocking',
          "garden's runtime reads the plugin catalogs beside plugin.json (archetypes_v11.py raises without archetypes.json); a snapshot missing one hands every worker a plugin whose runtime cannot start",
          `no ${rel} in effective/`,
          { file: rel },
        ),
      );
    }
    if (enabledSkills.length === 0) {
      findings.push(finding('empty-snapshot', 'blocking', 'a snapshot with no enabled skills would hand every worker an empty plugin', 'no enabled skills', {}));
    }
    return { findings, snapshotFiles: sortedRels(snapshotFiles), enabledSkills };
  }

  // ── Mirror bookkeeping ────────────────────────────────────────────────────────────────────

  /** Record a mirror pass. Bumps the revision: the ledger is manifest state clients may hold. */
  setMirrorState(state: SkillMirrorState): void {
    const m = this.manifest();
    m.mirror = state;
    this.commit(m);
  }
}

/** Re-export for callers that only need to classify the source-missing case. */
export { NotAPluginRootError };
