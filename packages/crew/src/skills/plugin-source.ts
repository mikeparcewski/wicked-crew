/**
 * Where the shipped baseline comes from: the installed wicked-garden plugin.
 *
 * The daemon seeds (and refreshes) its skills root from the plugin Claude Code actually runs —
 * the marketplace cache under `<CLAUDE_CONFIG_DIR|~/.claude>/plugins/cache/wicked-garden/
 * wicked-garden/<version>` (highest version wins). Design v3 §3/§8 (codex review of #480) made that
 * the ONLY automatic source, because the hand-installed `<config dir>/plugins/wicked-garden` copy
 * was the exact stale artifact the operator's `clis.toml` hack pointed workers at (12.28.1 while the
 * live cache was 12.32.0 — design v3 §"Verified mechanics"). Amendment v3.6 (#490) admits that copy
 * as a LAST resort — `npx wicked-installer install wicked-garden` lays it down without registering
 * the marketplace, so an installer-only machine had no source at all — without hiding the difference:
 *
 * Design amendment v3.6 (verbatim):
 * "Discovery order: (1) `WICKED_CREW_SKILLS_SOURCE` explicit override; (2) the marketplace cache
 * `<config dir>/plugins/cache/wicked-garden/wicked-garden/<highest version>` for each dir in
 * `CLAUDE_CONFIG_DIR` (may list several) else `~/.claude`; (3) LAST resort, the installer-managed
 * copy `<config dir>/plugins/wicked-garden` for each of those dirs AND `~/.claude/plugins/wicked-garden`
 * (garden's `install.mjs` hard-codes homedir), accepted only when its `.claude-plugin/plugin.json`
 * parses with a `version`. A source of kind (3) is recorded in the baseline as `source.kind:
 * 'installer-copy'` and surfaces a persistent WARNING finding `skills.source` in
 * `GET /diagnostics.skills.findings` — 'seeded from the installer copy at <path>; register the plugin
 * with Claude Code (marketplace) to receive marketplace updates' — so the daemon works on
 * installer-only machines without hiding the difference. When BOTH a cache and a copy exist, the
 * cache wins regardless of version; the copy is never preferred. Every source kind passes the same
 * no-follow, closure and validation rules."
 *
 * How the automatic tiers walk (codex on #491, both passes): the config dirs are `CLAUDE_CONFIG_DIR`'s
 * entries in the order listed (platform path delimiter) with the literal `~/.claude` appended once
 * unless already listed — the default when the variable is unset. Each config dir is resolved exactly
 * ONCE, at the top of discovery (`realpath` — the one link the automatic tiers follow: operators
 * symlink `~/.claude`); that canonical root is carried through both tiers, every level below it that
 * discovery touches — `plugins`, `cache`, the marketplace dir, the plugin dir, each version dir, the
 * copy dir — is lstat-walked ON THE CANONICAL PATH, a symlink at any of them skips that candidate with
 * a `symlink` finding (never followed), and a candidate's manifest is read only below that
 * already-validated canonical dir — never through the spelled path, so a link retargeted mid-walk is
 * never read. The recorded `PluginSource.path` is that canonical path. Tier (2) visits every dir in
 * order and the FIRST dir holding a valid cache wins; inside a cache every entry is judged: a name
 * must be a SemVer version by the semver.org grammar (no leading zeros in numeric identifiers, legal
 * pre-release / build identifiers — else ignored with a finding), EVERY such dir's `plugin.json`
 * version must equal its name (else skipped with a finding — every dir is validated, not only the
 * winner; a manifest that does not parse is a `no-manifest` finding, never a crash), and the pick is
 * the highest by SemVer PRECEDENCE (build metadata ignored for ordering,
 * pre-release below release, numeric identifiers before alphanumeric) with a documented tie-break
 * (`cacheDirOrder`). Tier (3) visits the same dirs in the same order; ANY cache beats ANY copy — a
 * `~/.claude` cache beats a `$CLAUDE_CONFIG_DIR/plugins/wicked-garden` copy. What was passed over
 * rides beside the answer as `DiscoveryFinding`s (the daemon logs them). NEVER a repo checkout by
 * default. `WICKED_CREW_SKILLS_SOURCE` is the one explicit override — for tests, and for an operator
 * who deliberately wants a checkout or some other plugin root. A machine with neither a cache nor a
 * copy has no source at all: crew does not vendor garden — the seed says "install garden first"
 * loudly (`SkillsSourceUnavailableError`) and the runtime leaves the engine input unset.
 *
 * # No-follow BELOW the root (codex round 6 on #480)
 *
 * The source ROOT may legitimately be reached through a symlink — operators symlink `~/.claude`,
 * and the marketplace cache may sit behind a linked config dir — so the root is resolved ONCE
 * (`realPluginRoot`, the one place a link is followed) and every designated entry BELOW it is
 * lstat-walked (`noFollowEntry`): the manifest dir, `plugin.json`, each catalog, each root file,
 * each bundle directory and everything inside it. A symlink among them is refused by name
 * (`PluginSourceSymlinkError`) — a seed refuses to start (the runtime's `skills.config`), a
 * refresh answers a `blocked` envelope — and nothing is copied: a linked catalog or a linked skill
 * dir would otherwise copy bytes from outside the declared source into the daemon's root and hand
 * them to every worker.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';

import type { SkillSourceKind } from '../core/types.js';
import { PLUGIN_NAME } from './frontmatter.js';
import { readFileNoFollow } from './tree.js';

/** Explicit plugin-source override — the seam tests and proof scripts aim at a fixture plugin. */
export const SKILLS_SOURCE_ENV = 'WICKED_CREW_SKILLS_SOURCE';

/** Relative path of the Claude Code plugin manifest inside a plugin root. */
export const PLUGIN_MANIFEST_REL = join('.claude-plugin', 'plugin.json');

export interface PluginSource {
  /** Absolute plugin root (the directory holding `.claude-plugin/plugin.json`). */
  path: string;
  kind: SkillSourceKind;
  /** `version` from the plugin manifest. */
  plugin_version: string;
}

/**
 * The Claude Code config dirs discovery walks, IN ORDER: every non-empty entry of `CLAUDE_CONFIG_DIR`
 * (it may list several, separated by the platform path delimiter) as listed, then the literal
 * `~/.claude` appended once unless already listed — the default when the variable is unset, and the
 * dir garden's `install.mjs` hard-codes (design v3.6; codex on #491). Spelled as given (the walk
 * resolves each dir once); a dir listed twice is walked once.
 */
export function claudeConfigDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...(env['CLAUDE_CONFIG_DIR'] ?? '').split(delimiter), join(home, '.claude')]) {
    if (dir === '') continue;
    const key = resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * A designated entry of the plugin source is a symlink — the seed/refresh is refused by name and
 * nothing is copied (module header). `entry` is the plugin-relative POSIX path of the link.
 */
export class PluginSourceSymlinkError extends Error {
  constructor(
    readonly root: string,
    readonly entry: string,
    readonly target: string,
  ) {
    super(
      `plugin source ${root}: ${entry} is a symlink (-> ${target}) — the plugin source is copied into the daemon's skills root and ` +
        'handed to every worker, so a link among its designated files or directories would copy whatever it reaches; ' +
        'refused, nothing was copied (the source root itself may be reached through a link; its contents may not)',
    );
    this.name = 'PluginSourceSymlinkError';
  }
}

/**
 * The plugin root with every link resolved — the ONE place a link is followed (an operator's
 * symlinked config dir reaches the root). `null` when it does not exist or is not a directory.
 */
export function realPluginRoot(dir: string): string | null {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
  return lstatSync(real).isDirectory() ? real : null;
}

/**
 * `join(root, ...segments)` after lstat-walking every segment BELOW the canonical root: a symlink at
 * any of them throws `PluginSourceSymlinkError` naming it; a component that does not exist (or sits
 * below a regular file) answers `null`. `sourceSpelling` is the root as the operator spelled it, for
 * the error.
 */
export function noFollowEntry(root: string, segments: ReadonlyArray<string>, sourceSpelling: string = root): string | null {
  let cur = root;
  for (let i = 0; i < segments.length; i += 1) {
    cur = join(cur, segments[i] as string);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
    if (st.isSymbolicLink()) throw new PluginSourceSymlinkError(sourceSpelling, segments.slice(0, i + 1).join('/'), readlinkSync(cur));
  }
  return cur;
}

/**
 * The plugin manifest's `version` at `dir`, or `null` when `dir` is not a plugin root — the root
 * resolved once (`realPluginRoot`), then `manifestVersionBelow`. For the explicit override and
 * `pluginSourceAt`; the automatic tiers never call this (they resolve the CONFIG dir once and read
 * below the canonical candidate directly).
 */
export function pluginVersionAt(dir: string): string | null {
  const root = realPluginRoot(dir);
  return root === null ? null : manifestVersionBelow(root, dir);
}

/**
 * The manifest `version` below an already-canonical plugin dir, or `null` when there is no
 * `.claude-plugin/plugin.json` that PARSES with a non-empty string `version` — missing, not a
 * regular file, not JSON, not an object, or versionless are all "not a plugin root" (design v3.6:
 * "accepted only when its plugin.json parses with a version"; Copilot on #491: one corrupt manifest
 * in a cache must skip that candidate, not take discovery down). NO-FOLLOW below the root and no
 * re-resolution of the root itself: a symlinked `.claude-plugin/` or `plugin.json` throws
 * `PluginSourceSymlinkError` — never a version read through a link (codex round 6) — and an I/O
 * error reading the file stays an error. `spelling` is the root as the caller spelled it, for the
 * symlink error.
 */
export function manifestVersionBelow(root: string, spelling: string = root): string | null {
  const manifest = noFollowEntry(root, PLUGIN_MANIFEST_REL.split(sep), spelling);
  if (manifest === null || !lstatSync(manifest).isFile()) return null;
  const text = readFileNoFollow(manifest).toString('utf8'); // the entry the walk judged is the one read (v3.5 §3)
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : null;
}

/** A parsed SemVer 2.0.0 version (semver.org). */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers; empty for a release. */
  prerelease: string[];
  /** Build metadata after `+`, or `null`; ignored by precedence. */
  build: string | null;
}

/**
 * The official SemVer grammar (semver.org §BNF / the suggested regex): numeric identifiers without
 * leading zeros, pre-release identifiers `[0-9A-Za-z-]` non-empty (numeric ones without leading
 * zeros), build identifiers `[0-9A-Za-z-]` non-empty. `01.0.0`, `1.0.0-alpha..1`, `1.0.0-01`, `1.0`
 * and `v1.0.0` are NOT versions.
 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parse a SemVer version, or `null` when the string is not one by the official grammar. */
export function parseSemver(v: string): Semver | null {
  const m = SEMVER_RE.exec(v);
  if (m === null) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
    build: m[5] ?? null,
  };
}

/**
 * SemVer PRECEDENCE (semver.org §11): major, minor, patch numerically; a pre-release version has
 * LOWER precedence than its release; pre-release identifiers compare left to right — numeric ones
 * numerically, numeric before alphanumeric, alphanumeric ones in ASCII order, a shorter set lower
 * when every preceding identifier is equal. Build metadata is IGNORED: `1.0.1` and `1.0.1+build`
 * have equal precedence (0). Throws for a string that is not a SemVer version — callers validate
 * names first (`parseSemver`).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) throw new TypeError(`compareSemver: not a SemVer version: ${pa === null ? a : b}`);
  for (const part of ['major', 'minor', 'patch'] as const) {
    if (pa[part] !== pb[part]) return pa[part] < pb[part] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length === 0 ? 1 : -1;
  }
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i += 1) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const numA = /^\d+$/.test(ia);
    const numB = /^\d+$/.test(ib);
    if (numA && numB) {
      if (Number(ia) !== Number(ib)) return Number(ia) < Number(ib) ? -1 : 1;
      continue;
    }
    if (numA !== numB) return numA ? -1 : 1;
    if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}

/**
 * The PICK order over cache version-directory names (all valid SemVer): the highest precedence
 * first; for EQUAL precedence (names differing only in build metadata — `1.0.1` vs `1.0.1+build`)
 * the plain release name (no build metadata) first, else the lexicographically smallest full name
 * (`1.0.1+a` before `1.0.1+b`). A total order over distinct names, so the pick never depends on
 * `readdir` or creation order (codex on #491).
 */
export function cacheDirOrder(a: string, b: string): number {
  const precedence = compareSemver(b, a);
  if (precedence !== 0) return precedence;
  if (a === b) return 0;
  const plainA = !a.includes('+');
  const plainB = !b.includes('+');
  if (plainA !== plainB) return plainA ? -1 : 1;
  return a < b ? -1 : 1;
}

/**
 * Classify a plugin root by what it IS: a git checkout when it carries `.git`; the installer-managed
 * copy when it is a `plugins/wicked-garden` directory (garden's `install.mjs` layout — design v3.6,
 * so an explicit override aimed at that copy is recorded, and warned about, as the copy it is); the
 * installed plugin when it sits anywhere else under a `plugins/` directory (the marketplace cache);
 * anything else is an explicit plugin-shaped directory (an unpacked tarball, a test fixture).
 */
export function classifySource(dir: string): SkillSourceKind {
  if (existsSync(join(dir, '.git'))) return 'checkout';
  const segments = resolve(dir).split(sep);
  if (!segments.includes('plugins')) return 'directory';
  const last = segments.length - 1;
  if (segments[last] === PLUGIN_NAME && segments[last - 1] === 'plugins') return 'installer-copy';
  return 'claude-plugin-cache';
}

/** A `PluginSource` for an explicit plugin root, or `null` when it is not a plugin root. */
export function pluginSourceAt(dir: string): PluginSource | null {
  const version = pluginVersionAt(dir);
  return version === null ? null : { path: dir, kind: classifySource(dir), plugin_version: version };
}

/** The marketplace cache dir the live plugin versions live under, for a config dir. */
export function livePluginCacheDir(configDir: string): string {
  return join(configDir, 'plugins', 'cache', PLUGIN_NAME, PLUGIN_NAME);
}

/** The installer-managed copy (`npx wicked-installer install wicked-garden`, garden's `install.mjs`), for a config dir. */
export function installerCopyDir(configDir: string): string {
  return join(configDir, 'plugins', PLUGIN_NAME);
}

/** Why discovery passed over something that EXISTS (an absent path is never a finding) — logged by the daemon, asserted by tests. */
export type DiscoveryFindingKind = 'symlink' | 'non-semver-name' | 'version-mismatch' | 'no-manifest';

export interface DiscoveryFinding {
  kind: DiscoveryFindingKind;
  /** The entry judged — the CANONICAL path (below the once-resolved config dir). */
  path: string;
  message: string;
}

/** What discovery answered and what it passed over on the way (design v3.6; codex on #491). */
export interface Discovery {
  source: PluginSource | null;
  findings: DiscoveryFinding[];
}

/**
 * TEST SEAM for the TOCTOU probe (codex confirmation pass on #491): called with the canonical
 * candidate dir just before its manifest is read, so a test can retarget the config-dir link
 * mid-walk and prove the retargeted manifest is never read. The daemon passes nothing.
 */
export interface DiscoveryHooks {
  beforeManifestRead?: (canonicalDir: string) => void;
}

const CACHE_SEGMENTS: ReadonlyArray<string> = ['plugins', 'cache', PLUGIN_NAME, PLUGIN_NAME];
const COPY_SEGMENTS: ReadonlyArray<string> = ['plugins', PLUGIN_NAME];

/**
 * `noFollowEntry` from the once-resolved config dir, for the automatic tiers: a symlink among the
 * walked segments becomes a `symlink` finding and the candidate is skipped — never followed; `null`
 * also when the entry does not exist. Only a symlinked designated entry INSIDE a plugin root stays a
 * thrown `PluginSourceSymlinkError` (`manifestVersionBelow`): that refusal is loud by design (codex
 * round 6 on #480).
 */
function noFollowBelow(root: string, segments: ReadonlyArray<string>, findings: DiscoveryFinding[]): string | null {
  try {
    return noFollowEntry(root, segments);
  } catch (err) {
    if (!(err instanceof PluginSourceSymlinkError)) throw err;
    const path = join(root, ...err.entry.split('/'));
    findings.push({ kind: 'symlink', path, message: `${path} is a symlink (-> ${err.target}); discovery never follows a link below the config dir — skipped` });
    return null;
  }
}

/**
 * Tier (2) for ONE canonical config dir: the marketplace cache's version dirs, EVERY one judged
 * (codex on #491): a name must parse as SemVer (else `non-semver-name`, ignored), the entry must be
 * no link (else `symlink`, skipped), and its `plugin.json` — read below the canonical dir, never
 * re-resolved — must exist with a `version` (else `no-manifest`) EQUAL to the name (else
 * `version-mismatch`). The pick is the first agreeing dir in `cacheDirOrder` (highest precedence,
 * documented tie-break); every other dir is still validated so a mismatch anywhere is a finding.
 */
function cacheCandidate(root: string, findings: DiscoveryFinding[], hooks: DiscoveryHooks): PluginSource | null {
  const cache = noFollowBelow(root, CACHE_SEGMENTS, findings);
  if (cache === null || !lstatSync(cache).isDirectory()) return null;
  const names: string[] = [];
  for (const name of readdirSync(cache).sort()) {
    const dir = join(cache, name);
    if (parseSemver(name) === null) {
      findings.push({ kind: 'non-semver-name', path: dir, message: `${dir}: the cache entry's name is not a valid SemVer version (semver.org); ignored` });
      continue;
    }
    if (noFollowBelow(root, [...CACHE_SEGMENTS, name], findings) !== null) names.push(name);
  }
  names.sort(cacheDirOrder);
  let pick: PluginSource | null = null;
  for (const name of names) {
    const dir = join(cache, name);
    hooks.beforeManifestRead?.(dir);
    const version = manifestVersionBelow(dir); // a linked `.claude-plugin/` or `plugin.json` throws — loud, never a silent skip to another version
    if (version === null) {
      findings.push({ kind: 'no-manifest', path: dir, message: `${dir}: no .claude-plugin/plugin.json that parses with a version; skipped` });
      continue;
    }
    if (version !== name) {
      findings.push({ kind: 'version-mismatch', path: dir, message: `${dir}: plugin.json declares version ${version} but the directory is named ${name}; skipped` });
      continue;
    }
    if (pick === null) pick = { path: dir, kind: 'claude-plugin-cache', plugin_version: version };
  }
  return pick;
}

/** Tier (3) for ONE canonical config dir: its installer-managed copy — `plugins/wicked-garden` exists, is no link, and its `plugin.json` (read below the canonical dir) parses with a `version`. */
function copyCandidate(root: string, findings: DiscoveryFinding[], hooks: DiscoveryHooks): PluginSource | null {
  const dir = noFollowBelow(root, COPY_SEGMENTS, findings);
  if (dir === null || !lstatSync(dir).isDirectory()) return null;
  hooks.beforeManifestRead?.(dir);
  const version = manifestVersionBelow(dir);
  if (version === null) {
    findings.push({ kind: 'no-manifest', path: dir, message: `${dir} exists but has no .claude-plugin/plugin.json that parses with a version — not a plugin root; skipped` });
    return null;
  }
  return { path: dir, kind: 'installer-copy', plugin_version: version };
}

export interface DiscoverOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Test seam — see `DiscoveryHooks`. */
  hooks?: DiscoveryHooks;
}

/**
 * Discover the installed plugin in the order design amendment v3.6 fixes (module header), with what
 * was passed over: (1) the explicit `WICKED_CREW_SKILLS_SOURCE` override; (2) the FIRST config dir
 * (as listed, `~/.claude` appended) holding a valid marketplace cache — the highest-precedence
 * agreeing version dir inside it; (3) LAST resort, the first of those dirs holding a valid installer
 * copy. ANY cache beats ANY copy. Each config dir is resolved exactly ONCE, here, and only its
 * canonical root is handed to the tiers (two spellings of one dir walk once). `env`/`home` are
 * injectable so tests never read the developer's real config dir. `source` is `null` when nothing is
 * installed — the caller says "install garden first" loudly. A finding is reported once per entry
 * even when both tiers meet it (a linked `plugins/`, say).
 */
export function discoverLivePluginDetailed(opts: DiscoverOptions = {}): Discovery {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const hooks = opts.hooks ?? {};
  const findings: DiscoveryFinding[] = [];
  const override = env[SKILLS_SOURCE_ENV];
  if (override !== undefined && override !== '') return { source: pluginSourceAt(override), findings };
  const roots: string[] = [];
  for (const dir of claudeConfigDirs(env, home)) {
    const root = realPluginRoot(dir); // the ONE realpath of a config dir in all of discovery
    if (root !== null && !roots.includes(root)) roots.push(root);
  }
  let source: PluginSource | null = null;
  for (const root of roots) {
    source = cacheCandidate(root, findings, hooks);
    if (source !== null) break;
  }
  if (source === null) {
    for (const root of roots) {
      source = copyCandidate(root, findings, hooks);
      if (source !== null) break;
    }
  }
  const seen = new Set<string>();
  return { source, findings: findings.filter((f) => !seen.has(`${f.kind}\0${f.path}`) && seen.add(`${f.kind}\0${f.path}`) !== undefined) };
}

/** `discoverLivePluginDetailed` answering the source alone; pass `findings` to collect what was passed over. */
export function discoverLivePlugin(opts: DiscoverOptions & { findings?: DiscoveryFinding[] } = {}): PluginSource | null {
  const { source, findings } = discoverLivePluginDetailed(opts);
  opts.findings?.push(...findings);
  return source;
}

export interface GitState {
  git_sha: string | null;
  git_dirty: boolean;
  /** Present when the source is a checkout but git could not answer — the caller logs it. */
  error?: string;
}

const GIT_TIMEOUT_MS = 5_000;

/** The checkout's HEAD sha + dirty flag; `{null,false}` for a non-checkout source. */
export function gitStateOf(source: PluginSource): GitState {
  if (source.kind !== 'checkout') return { git_sha: null, git_dirty: false };
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: source.path,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: source.path,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { git_sha: sha, git_dirty: status.trim() !== '' };
  } catch (err) {
    return {
      git_sha: null,
      git_dirty: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
