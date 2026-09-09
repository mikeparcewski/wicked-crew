/**
 * The daemon-owned skills root (design v3 DECISIONS 1/4/5/6/7): ONE effective garden-shaped plugin
 * root the operator edits like a filesystem, PUBLISHED as immutable snapshots the engine hands to
 * every worker. Nothing a worker runs is ever read from `effective/`.
 *
 * # Layout — `<root>/` (`<crewStateHome()>/skills` by default; never a `~/.wicked-crew` literal)
 *
 *   manifest.json              the state (`SkillManifest`; presence = seeded), CAS `revision`
 *   baseline/<contentHash>/    the shipped bundle (dependency closure, bundle.ts) — identity is the
 *                              content hash of the bundle, never the version string alone; `.venv`
 *                              is provisioned here once per hash (venv.ts)
 *   effective/                 the same shape, holding what the operator edits: EVERY skill, enabled
 *                              or not (enablement is manifest state, orthogonal to content)
 *   snapshots/<gen>/           immutable published trees: enabled skills only, nested layout
 *                              verbatim, support closure, `snapshot.json`, `.venv -> baseline venv`
 *   current -> snapshots/<gen> flipped atomically after each publish; the engine receives the
 *                              RESOLVED path as `WICKED_SKILLS_SNAPSHOT` (engine-env.ts)
 *
 * # Identity, ownership, hashes
 *
 * A skill is a directory holding `SKILL.md`, keyed by frontmatter `name` (the live plugin spells
 * it `wicked-garden-<dir segments joined by '-'>` for all 142, unique). A skill's OWN files are
 * everything under its dir except a nested skill's subtree — the deepest `SKILL.md` ancestor owns
 * a path (v3 §6), so disabling/resetting/replacing a parent never touches a child, and the file
 * API refuses a child's path through the parent's endpoint. Every managed file carries
 * `{baselineHash, effectiveHash, lastPublishedHash}`; provenance is derived from them, never
 * asserted. Every mutation takes `expectedRevision` (CAS) and bumps `revision`; direct
 * filesystem edits are detected by hash at publish and REPORTED (`fs-drift`), never silently
 * trusted.
 *
 * # Publish
 *
 * Validates the WHOLE tree — frontmatter, name == path, the core closure intact, every
 * `${CLAUDE_PLUGIN_ROOT}/<p>` and `../<p>` reference of an enabled skill resolving INSIDE the
 * would-be snapshot, no unregistered `SKILL.md` — then writes `snapshots/<gen>/` via tmp+rename,
 * flips `current`, and reaps generations beyond the newest three that no LIVE run may still be
 * reading (`live`, fed from the CoreEvent stream — live-generations.ts). A `blocked` verdict
 * publishes nothing and is a normal result.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

import { readFileCapped } from '../api/run-files.js';
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
import { crewStateHome } from '../projects/state-home.js';
import { NotAPluginRootError, owningSkillDir, pluginBundleFiles, skillDirsOf, SKILLS_SUBDIR } from './bundle.js';
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
  resolveRelativeRef,
} from './refs.js';
import {
  copyFiles,
  hashFileSet,
  pruneEmptyDirs,
  removeFiles,
  sha256Hex,
  walkFiles,
  writeFileAtomic,
  type FileRecord,
} from './tree.js';
import { baselineVenvDir, type VenvProvisioner } from './venv.js';

/** Explicit root override — the more specific instruction, and what the hermetic test harness arms. */
export const SKILLS_ROOT_ENV = 'WICKED_CREW_SKILLS_ROOT';
/** The default root's name under the daemon state home. */
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

/**
 * Where the root lives: env override, then the `skills_root` setting (absolute only — a relative
 * path is meaningless against an arbitrary cwd), then `<state home>/skills`.
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

/** `snapshot.json` inside every published generation — what the engine reads (never a parent dir). */
export interface SnapshotManifest {
  gen: number;
  contentHash: string;
  gardenSource: { kind: SkillSourceKind; path: string; plugin_version: string; baseline: string };
  skills: Array<{ name: string; dir: string; kind: SkillKind; core: boolean; portable: boolean }>;
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
  /** Per-baseline `uv sync` (venv.ts). Tests pass `noVenv`; the daemon passes `uvSyncBaseline`. */
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

/** The dir a user-added skill lands at: always top-level (`skills/<name minus the prefix>`). */
export function dirForUserSkill(name: string): string {
  return `${SKILLS_SUBDIR}/${name.slice(SKILL_NAME_PREFIX.length)}`;
}

/** Zero-padded so a lexical listing of `snapshots/` is the generation order. */
export function generationDirName(gen: number): string {
  return String(gen).padStart(6, '0');
}
const GENERATION_DIR_RE = /^\d{6}$/;

export class SkillsStore {
  private rootDir: string;
  private readonly registeredRefs: () => ReadonlySet<string>;
  private readonly provisionVenv: VenvProvisioner;
  private readonly sourceFn: () => PluginSource | null;
  readonly now: () => string;
  private readonly warn: (message: string) => void;
  /** Resolves when the most recent venv provisioning has recorded its state — tests await it. */
  pendingVenv: Promise<void> = Promise.resolve();
  /** Generations live runs may still read — the reaper keeps them (fed by `observeEvent`). */
  readonly live = new LiveGenerations();
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

  private manifestPath(): string {
    return join(this.rootDir, MANIFEST_FILENAME);
  }

  private pluginPath(rel: string, base: string = this.effectiveDir()): string {
    return join(base, ...rel.split('/'));
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SkillsUnseededError(this.rootDir);
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

  /** The published snapshot `current` resolves to, or `null` (never published, or a dangling link). */
  currentSnapshot(): { gen: number; path: string } | null {
    const link = this.currentLink();
    let target: string;
    try {
      target = readlinkSync(link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const path = resolve(this.rootDir, target);
    const manifestPath = join(path, SNAPSHOT_MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<SnapshotManifest>;
    return typeof parsed.gen === 'number' ? { gen: parsed.gen, path } : null;
  }

  /** `currentSnapshot()?.gen` without touching disk after the first read — publish keeps it current. */
  private currentGen(): number | null {
    if (this.currentGenMemo === undefined) this.currentGenMemo = this.currentSnapshot()?.gen ?? null;
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
    const current = this.currentSnapshot();
    if (current !== null) this.reapGenerations(current.gen);
  }

  // ── Seed ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Seed the root from the live plugin when it has no manifest. Idempotent: a seeded root is left
   * alone. A torn earlier seed (dirs but no manifest) is cleared and redone. Throws
   * `SkillsSourceUnavailableError` when no plugin is installed.
   */
  seed(): SeedResult {
    if (this.isSeeded()) return { seeded: false, baseline: null, source: null };
    const source = this.requireSource('no installed wicked-garden plugin found under the Claude config dir (plugins/cache or plugins/wicked-garden)');
    const bundle = pluginBundleFiles(source.path);
    const hash = hashFileSet(bundle);
    mkdirSync(this.rootDir, { recursive: true });
    this.captureBaseline(bundle, hash);
    const effective = this.effectiveDir();
    rmSync(effective, { recursive: true, force: true });
    copyFiles(bundle, effective);
    rmSync(this.snapshotsDir(), { recursive: true, force: true });
    rmSync(this.currentLink(), { force: true });
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
    this.scheduleVenv(hash);
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
    const staging = join(this.rootDir, BASELINE_DIRNAME, `.staging-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    copyFiles(bundle, staging);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(staging, dest);
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

  /** Kick off `uv sync` for a baseline; record the outcome without bumping the revision (state, not a user mutation). */
  private scheduleVenv(hash: string): void {
    const root = this.rootDir;
    this.pendingVenv = this.provisionVenv(this.baselineDir(hash), this.warn)
      .then((state) => this.recordVenv(root, hash, state))
      .catch((err: unknown) => {
        this.warn(`[skills] venv provisioning for ${hash} could not be recorded: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  private recordVenv(root: string, hash: string, state: SkillVenvState): void {
    if (root !== this.rootDir || !this.isSeeded()) return; // re-rooted or torn down meanwhile
    const m = this.manifest();
    const record = m.baselines[hash];
    if (record === undefined) return; // superseded by a refresh
    record.venv = state;
    this.writeManifest(m);
  }

  /**
   * Boot / settings entry point: seed when unseeded, publish when nothing is published. Throws
   * `SkillsSourceUnavailableError` only for the seed; a blocked first publish is returned, not thrown.
   */
  ensureReady(): { seeded: boolean; published: SkillPublishResult | null } {
    const seeded = this.seed().seeded;
    if (this.currentSnapshot() !== null) return { seeded, published: null };
    return { seeded, published: this.publish(this.revision()) };
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
   * (keyed by frontmatter name, falling back to the path-derived name — warned), keep existing
   * entries' state, recompute every content-derived field and the core closure.
   */
  private rebuildCatalog(m: SkillManifest): void {
    const present = new Set(Object.entries(m.files).filter(([, r]) => r.effectiveHash !== null).map(([rel]) => rel));
    const dirs = skillDirsOf([...present].map((rel) => ({ rel })));
    const byDir = new Map(Object.entries(m.skills).map(([name, e]) => [e.dir, name]));
    for (const dir of [...dirs].sort()) {
      if (byDir.has(dir)) continue;
      const name = this.nameForDir(m, dir);
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

  /** The manifest key for a freshly discovered skill dir. */
  private nameForDir(m: SkillManifest, dir: string): string {
    const derived = derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
    const skillMd = this.pluginPath(`${dir}/SKILL.md`);
    const parsed = parseFrontmatter(readFileSync(skillMd, 'utf8'));
    let name = derived;
    if (!parsed.ok) {
      this.warn(`[skills] ${dir}/SKILL.md frontmatter does not parse (${parsed.reason}); keyed by the path-derived name ${derived}`);
    } else {
      const declared = parsed.fields['name'];
      if (declared !== undefined && declared !== '') {
        if (declared !== derived) {
          this.warn(`[skills] ${dir}/SKILL.md declares name ${JSON.stringify(declared)} but its path derives ${JSON.stringify(derived)}; keyed by the declared name`);
        }
        name = declared;
      }
    }
    if (m.skills[name] !== undefined) {
      this.warn(`[skills] ${dir} declares name ${name}, already taken by ${m.skills[name]?.dir ?? '?'}; keyed by the path-derived name ${derived}`);
      name = derived;
    }
    return name;
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
   * sides) or a refresh's name-collision flag — the latter only meaningful while the skill is
   * user-added (upstream shipped the name at another dir); refresh clears and re-derives it.
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

  /**
   * After a validation pass: a change to the file records (drift) is a real state change and bumps
   * the revision; derived-field movement alone is written without a bump, and an unchanged
   * manifest is not rewritten — a `blocked` answer must not stale every client's revision.
   */
  private persistBookkeeping(m: SkillManifest, filesBefore: string, manifestBefore: string): void {
    if (JSON.stringify(m.files) !== filesBefore) this.commit(m);
    else if (JSON.stringify(m) !== manifestBefore) this.writeManifest(m);
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
   * skill owns, lstat-walk refusing symlinks. Returns the on-disk target in `effective/` and both
   * spellings of the path.
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
    const abs = containedPath(this.pluginPath(entry.dir), segments);
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
    return { abs: containedPath(this.effectiveDir(), segments), rel };
  }

  /** A typed, capped read of one of the skill's files (`side: 'baseline'` reads the shipped copy). */
  async readFile(name: string, rawRel: string, side: ReadSide = 'effective'): Promise<SkillReadResult> {
    const target = this.resolveSkillFile(name, rawRel);
    const abs = side === 'effective' ? target.abs : this.pluginPath(target.pluginRel, this.baselineDir(this.manifest().baseline));
    return this.typedRead(target.pluginRel, abs);
  }

  async readSupport(rawRel: string, side: ReadSide = 'effective'): Promise<SkillReadResult> {
    const target = this.resolveSupportFile(rawRel);
    const abs = side === 'effective' ? target.abs : this.pluginPath(target.rel, this.baselineDir(this.manifest().baseline));
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

  disable(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const findings = compact([coreDisableGuard(name, entry)]);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    if (!entry.enabled) return this.result(m, name, findings);
    entry.enabled = false;
    this.commit(m);
    return this.result(m, name, findings);
  }

  /** Restore the skill's own files from the current baseline. `enabled` is untouched by design. */
  reset(name: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const findings = compact([noBaselineGuard(name, !this.hasBaselineDir(m, entry.dir))]);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
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

  /** Write one file inside the skill (containment via `resolveSkillFile`); guards on SKILL.md + support paths. */
  writeFile(name: string, rawRel: string, content: string, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const target = this.resolveSkillFile(name, rawRel);
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
    const target = this.resolveSupportFile(rawRel);
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

  /** Replace the skill's own files wholesale (nested skills untouched). */
  replace(name: string, files: Readonly<Record<string, string>>, expectedRevision: number): SkillMutationResult {
    const m = this.manifest();
    const entry = this.requireEntry(m, name, expectedRevision);
    const findings = this.replaceGuards(m, name, entry, files);
    if (verdictOf(findings) === 'blocked') return this.blocked(m, findings);
    const effective = this.effectiveDir();
    removeFiles(this.ownFilesIn(effective, entry.dir, this.manifestDirs(m)), effective);
    for (const [rel, text] of Object.entries(files)) writeFileAtomic(this.pluginPath(`${entry.dir}/${rel}`), text);
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
   * effective) with the v3 §7 truth table. A held-back upstream skill (its name collides with a
   * user-added skill at another dir) is left in the baseline only and flagged. The old baseline dir
   * is removed once the merge is on disk; the manifest keeps one record per baseline that exists.
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

    // Held-back upstream skills: a NEW upstream dir whose frontmatter name is already a manifest
    // key at a different dir (a user-added skill) — v3 §7's name-collision conflict. Every
    // name-collision flag is re-derived by this pass, so clear the previous refresh's first.
    const findings: SkillConflictFinding[] = [];
    const heldBack = new Set<string>();
    const conflicts = new Set<string>();
    const manifestDirs = this.manifestDirs(m);
    for (const entry of Object.values(m.skills)) entry.conflict = false;
    for (const dir of skillDirsOf(bundle)) {
      if (manifestDirs.has(dir)) continue;
      const parsed = parseFrontmatter(readFileSync(this.pluginPath(`${dir}/SKILL.md`, newBase), 'utf8'));
      const declared = parsed.ok ? parsed.fields['name'] : undefined;
      const name = declared !== undefined && declared !== '' ? declared : derivedSkillName(dir.slice(`${SKILLS_SUBDIR}/`.length));
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
        } else if (e === bo || e === null) {
          if (bn !== bo) take();
          else if (e === null && record !== undefined) record.baselineHash = bn; // deletion respected, upstream unchanged
        } else if (e === bn) {
          m.files[rel] = { baselineHash: bn, effectiveHash: e, lastPublishedHash: record?.lastPublishedHash ?? null, conflict: false };
        } else if (bn === bo) {
          // user-modified, upstream unchanged → keep (record already says so)
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

    // Catalog: register upstream-new dirs, drop skills whose files all went, recompute the rest.
    const before = new Set(Object.keys(m.skills));
    for (const [name, entry] of Object.entries(m.skills)) {
      if (existsSync(this.pluginPath(`${entry.dir}/SKILL.md`))) continue;
      if (this.ownRecords(m, entry.dir).some(([, r]) => r.effectiveHash !== null)) continue;
      for (const [rel] of this.ownRecords(m, entry.dir)) delete m.files[rel];
      delete m.skills[name];
    }
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
          'both the operator and upstream changed this skill; the operator\'s content is kept and the upstream side is readable as ?side=baseline — reset takes upstream wholesale',
          `${name} (${entry.dir}) has conflicting files`,
          { skill: name },
        ),
      );
    }

    // Promote: the old baseline dir goes, its record with it (records mirror the dirs that exist).
    m.baselines[newHash] = this.baselineRecord(source);
    m.baseline = newHash;
    rmSync(this.baselineDir(previous), { recursive: true, force: true });
    delete m.baselines[previous];
    this.commit(m);
    this.scheduleVenv(newHash);
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

  /** Dry-run of the publish validation. Records observed drift (bookkeeping), publishes nothing. */
  analyze(): SkillAnalyzeResult {
    const m = this.manifest();
    const manifestBefore = JSON.stringify(m);
    const filesBefore = JSON.stringify(m.files);
    const v = this.validate(m);
    this.persistBookkeeping(m, filesBefore, manifestBefore);
    return { verdict: verdictOf(v.findings), findings: v.findings, revision: m.revision };
  }

  /**
   * Validate the whole tree, then write `snapshots/<gen>/` (tmp + rename), flip `current`, record
   * `lastPublishedHash`, and reap generations beyond `KEEP_GENERATIONS`.
   */
  publish(expectedRevision: number): SkillPublishResult {
    const m = this.manifest();
    this.assertRevision(m, expectedRevision);
    const manifestBefore = JSON.stringify(m);
    const filesBefore = JSON.stringify(m.files);
    const v = this.validate(m);
    if (verdictOf(v.findings) === 'blocked') {
      this.persistBookkeeping(m, filesBefore, manifestBefore);
      return { verdict: 'blocked', findings: v.findings, revision: m.revision, snapshot: null };
    }
    const gen = (m.published?.gen ?? 0) + 1;
    const contentHash = hashFileSet(v.snapshotFiles);
    const dest = this.snapshotDir(gen);
    const staging = join(this.snapshotsDir(), `.tmp-${generationDirName(gen)}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
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
      skills: v.enabledSkills
        .map(({ name, entry }) => ({ name, dir: entry.dir, kind: entry.kind, core: entry.core, portable: entry.portable }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
    writeFileAtomic(join(staging, SNAPSHOT_MANIFEST_FILENAME), `${JSON.stringify(snapshot, null, 2)}\n`);
    // The shared per-baseline env: a relative link so a relocated root still resolves. It may
    // dangle until `uv sync` lands — `uv run` then creates the env THROUGH the link, in the baseline.
    this.symlink(posix.join('..', '..', BASELINE_DIRNAME, m.baseline, '.venv'), join(staging, '.venv'), baselineVenvDir(this.baselineDir(m.baseline)));
    renameSync(staging, dest);
    this.flipCurrent(gen);
    this.currentGenMemo = gen;
    this.live.published(gen);

    const included = new Set(v.snapshotFiles.map((f) => f.rel));
    for (const [rel, r] of Object.entries(m.files)) {
      if (included.has(rel)) r.lastPublishedHash = r.effectiveHash;
    }
    m.published = { gen, contentHash, at: this.now() };
    this.commit(m);
    this.reapGenerations(gen);
    return {
      verdict: verdictOf(v.findings),
      findings: v.findings,
      revision: m.revision,
      snapshot: { gen, path: dest, contentHash, skills: snapshot.skills.length },
    };
  }

  /** `current -> snapshots/<gen>`: create the link beside it, then rename over — atomic on POSIX. */
  private flipCurrent(gen: number): void {
    const link = this.currentLink();
    const tmp = `${link}.tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    this.symlink(posix.join(SNAPSHOTS_DIRNAME, generationDirName(gen)), tmp, this.snapshotDir(gen));
    renameSync(tmp, link);
  }

  /** A directory symlink: relative target on POSIX; Windows junctions need the absolute target. */
  private symlink(relTarget: string, linkPath: string, absTarget: string): void {
    if (process.platform === 'win32') symlinkSync(absTarget, linkPath, 'junction');
    else symlinkSync(relTarget, linkPath);
  }

  /**
   * Remove every generation older than the newest `KEEP_GENERATIONS` — never the current one, and
   * never one a live session still pins (it is reaped by the release that frees it).
   */
  private reapGenerations(currentGen: number): void {
    let entries: string[];
    try {
      entries = readdirSync(this.snapshotsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const pinned = this.live.pinned();
    const gens = entries
      .filter((e) => GENERATION_DIR_RE.test(e))
      .map((e) => Number(e))
      .filter((g) => g !== currentGen)
      .sort((a, b) => b - a);
    for (const gen of gens.slice(KEEP_GENERATIONS - 1)) {
      if (pinned.has(gen)) continue;
      rmSync(this.snapshotDir(gen), { recursive: true, force: true });
    }
  }

  /** The generations present on disk, ascending. */
  generationsOnDisk(): number[] {
    if (!existsSync(this.snapshotsDir())) return [];
    return readdirSync(this.snapshotsDir())
      .filter((e) => GENERATION_DIR_RE.test(e) && lstatSync(join(this.snapshotsDir(), e)).isDirectory())
      .map((e) => Number(e))
      .sort((a, b) => a - b);
  }

  /**
   * Whole-tree validation (v3 §API "unresolved refs blocking at publish", §5 core closure, §6
   * nested ownership). Mutates `m` for bookkeeping only: drift into the file records, derived
   * fields, the core closure. Never touches `effective/`.
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
          'a SKILL.md appeared on disk that the manifest never registered — a nested skill created outside the API; register it with POST /skills or remove it',
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
    const closure = coreClosure(this.registeredRefs(), catalogMd);
    for (const ref of closure.missing) {
      findings.push(
        finding(
          'core-missing',
          'warning',
          'a registered workflow names this skill as a phase skill_ref, but no skill by that name is in the catalog; a run dispatching that phase would find no skill in the snapshot',
          `skill_ref ${ref} names no catalog skill`,
          { skill: ref },
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
    const resolves = (p: string): boolean => {
      if (p === '') return true;
      if (snapshotSet.has(p)) return true;
      const prefix = `${p}/`;
      for (const rel of snapshotSet) if (rel.startsWith(prefix)) return true;
      return false;
    };
    const whyMissing = (p: string): string => {
      const owner = owningSkillDir(p, dirs);
      const ownerName = owner === null ? null : registered.get(owner);
      if (ownerName !== undefined && ownerName !== null && m.skills[ownerName]?.enabled === false) {
        return ` — it belongs to the DISABLED skill ${ownerName}`;
      }
      return onDisk.has(p) || [...onDisk.keys()].some((rel) => rel.startsWith(`${p}/`))
        ? ' — present in effective/ but outside the snapshot'
        : ' — no such file in effective/';
    };
    for (const { name, entry } of enabledSkills) {
      for (const f of filesByOwner.get(entry.dir) ?? []) {
        const buf = readFileSync(f.abs);
        if (looksBinary(buf)) continue;
        const text = buf.toString('utf8');
        for (const ref of extractPluginRootRefs(text)) {
          if (resolves(ref.path)) continue;
          findings.push(
            finding(
              'unresolved-ref',
              'blocking',
              'the snapshot is the plugin root workers see; a `${CLAUDE_PLUGIN_ROOT}` reference that does not resolve inside it fails at first use',
              `\${CLAUDE_PLUGIN_ROOT}/${ref.path}${whyMissing(ref.path)}`,
              { skill: name, file: f.rel, line: ref.line },
            ),
          );
        }
        for (const ref of extractRelativeRefs(text)) {
          const target = resolveRelativeRef(f.rel, ref.path);
          const ok = target !== null && resolves(target);
          if (ok) continue;
          findings.push(
            finding(
              'unresolved-ref',
              'blocking',
              'a `../` link must land inside the snapshot; one that climbs out of the plugin root or into a skill the snapshot omits is broken for every worker',
              `${ref.path}${target === null ? ' — escapes the plugin root' : whyMissing(target)}`,
              { skill: name, file: f.rel, line: ref.line },
            ),
          );
        }
      }
    }

    // The plugin manifest: present and still naming this plugin.
    const pluginJson = onDisk.get(PLUGIN_JSON_REL);
    if (pluginJson === undefined) {
      findings.push(finding('missing-skill-md', 'blocking', 'a plugin root is its .claude-plugin/plugin.json', `no ${PLUGIN_JSON_REL} in effective/`, { file: PLUGIN_JSON_REL }));
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
