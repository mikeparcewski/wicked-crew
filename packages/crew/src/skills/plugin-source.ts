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
 * How the automatic tiers walk (codex on #491): the config dirs are `CLAUDE_CONFIG_DIR`'s entries in
 * the order listed (platform path delimiter) with the literal `~/.claude` appended once unless already
 * listed — the default when the variable is unset. Tier (2) visits every dir in that order and the
 * FIRST dir holding a valid cache wins; inside a cache the highest SEMVER version-DIRECTORY NAME wins
 * (`compareVersions`, a total order — never `readdir` order), a dir whose `plugin.json` version does
 * not equal its name is skipped with a finding, a non-semver name is ignored with a finding. Tier (3)
 * visits the same dirs in the same order; ANY cache beats ANY copy — a `~/.claude` cache beats a
 * `$CLAUDE_CONFIG_DIR/plugins/wicked-garden` copy. Each config dir is resolved ONCE (`realpath` — the
 * one link the automatic tiers follow: operators symlink `~/.claude`); every level below it that
 * discovery touches — `plugins`, `cache`, the marketplace dir, the plugin dir, each version dir, the
 * copy dir — is lstat-walked, and a symlink at any of them skips that candidate with a `symlink`
 * finding, never followed; the chosen root is then re-checked to lie canonically inside the resolved
 * config dir. What was passed over rides beside the answer as `DiscoveryFinding`s (the daemon logs
 * them). NEVER a repo checkout by default. `WICKED_CREW_SKILLS_SOURCE` is the one explicit override
 * — for tests, and for an operator who deliberately wants a checkout or some other plugin root. A
 * machine with neither a cache nor a copy has no source at all: crew does not vendor garden — the
 * seed says "install garden first" loudly (`SkillsSourceUnavailableError`) and the runtime leaves
 * the engine input unset.
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
 * The plugin manifest's `version` at `dir`, or `null` when `dir` is not a plugin root. The manifest
 * is read NO-FOLLOW below the (once-resolved) root: a symlinked `.claude-plugin/` or `plugin.json`
 * throws `PluginSourceSymlinkError` — never a version read through a link (codex round 6).
 */
export function pluginVersionAt(dir: string): string | null {
  const root = realPluginRoot(dir);
  if (root === null) return null;
  const manifest = noFollowEntry(root, PLUGIN_MANIFEST_REL.split(sep), dir);
  if (manifest === null || !lstatSync(manifest).isFile()) return null;
  const parsed: unknown = JSON.parse(readFileNoFollow(manifest).toString('utf8')); // the entry the walk judged is the one read (v3.5 §3)
  if (typeof parsed !== 'object' || parsed === null) return null;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : null;
}

/**
 * A TOTAL order over version strings, so "highest version wins" never depends on `readdir` order
 * (Copilot on #480). Numeric dotted order first (`12.9.0` < `12.32.0`; a shorter release sorts
 * before a longer one with the same prefix; a non-integer segment sorts below any integer). A
 * prerelease suffix (`12.0.0-beta`, everything after the first `-`) sorts BELOW its release
 * (`12.0.0-beta` < `12.0.0`), and two prereleases compare identifier by identifier the semver way
 * (numeric identifiers numerically and before alphanumeric ones, then lexically, shorter first).
 * Distinct strings NEVER compare equal: whatever survives all of that (`12.00.0` vs `12.0.0`) is
 * ordered lexically.
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const [coreA, preA] = splitPrerelease(a);
  const [coreB, preB] = splitPrerelease(b);
  const core = compareDotted(coreA, coreB);
  if (core !== 0) return core;
  if (preA === null && preB !== null) return 1;
  if (preA !== null && preB === null) return -1;
  if (preA !== null && preB !== null) {
    const pre = comparePrerelease(preA, preB);
    if (pre !== 0) return pre;
  }
  return a < b ? -1 : 1;
}

/** `12.0.0-beta.1` → [`12.0.0`, `beta.1`]; no `-` → [`v`, null]. */
function splitPrerelease(v: string): [string, string | null] {
  const dash = v.indexOf('-');
  return dash === -1 ? [v, null] : [v.slice(0, dash), v.slice(dash + 1)];
}

/** Dotted numeric segments: shorter-first on a shared prefix, a non-integer segment below any integer. */
function compareDotted(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = /^\d+$/.test(sa) ? Number(sa) : -1;
    const nb = /^\d+$/.test(sb) ? Number(sb) : -1;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** Semver prerelease identifiers: numeric before alphanumeric, numeric numerically, else lexically; shorter first. */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const sa = pa[i];
    const sb = pb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const numA = /^\d+$/.test(sa);
    const numB = /^\d+$/.test(sb);
    if (numA && numB) {
      if (Number(sa) !== Number(sb)) return Number(sa) < Number(sb) ? -1 : 1;
      continue;
    }
    if (numA !== numB) return numA ? -1 : 1;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
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
export type DiscoveryFindingKind = 'symlink' | 'non-semver-name' | 'version-mismatch' | 'no-manifest' | 'outside-config-dir';

export interface DiscoveryFinding {
  kind: DiscoveryFindingKind;
  /** The entry judged, spelled under the config dir as the operator spelled it. */
  path: string;
  message: string;
}

/** What discovery answered and what it passed over on the way (design v3.6; codex on #491). */
export interface Discovery {
  source: PluginSource | null;
  findings: DiscoveryFinding[];
}

/** A marketplace-cache version DIRECTORY name: a semver release with an optional prerelease / build suffix. */
const SEMVER_DIR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const CACHE_SEGMENTS: ReadonlyArray<string> = ['plugins', 'cache', PLUGIN_NAME, PLUGIN_NAME];
const COPY_SEGMENTS: ReadonlyArray<string> = ['plugins', PLUGIN_NAME];

/**
 * `noFollowEntry` from a once-resolved config dir, for the automatic tiers: a symlink among the walked
 * segments becomes a `symlink` finding and the candidate is skipped — never followed; `null` also when
 * the entry does not exist. Only a symlinked designated entry INSIDE a plugin root stays a thrown
 * `PluginSourceSymlinkError` (`pluginVersionAt`): that refusal is loud by design (codex round 6 on #480).
 */
function noFollowBelow(realRoot: string, segments: ReadonlyArray<string>, spelling: string, findings: DiscoveryFinding[]): string | null {
  try {
    return noFollowEntry(realRoot, segments, spelling);
  } catch (err) {
    if (!(err instanceof PluginSourceSymlinkError)) throw err;
    const path = join(spelling, ...err.entry.split('/'));
    findings.push({ kind: 'symlink', path, message: `${path} is a symlink (-> ${err.target}); discovery never follows a link below the config dir — skipped` });
    return null;
  }
}

/**
 * The chosen root must lie canonically inside the resolved config dir — re-derived from the spelled
 * path after the walk, never assumed from it (codex on #491): a link that appeared between the walk
 * and the pick, or a spelling that resolves elsewhere, is a finding, not a source.
 */
function containedInConfigDir(spelled: string, realRoot: string, findings: DiscoveryFinding[]): boolean {
  let real: string;
  try {
    real = realpathSync(spelled);
  } catch (err) {
    findings.push({ kind: 'outside-config-dir', path: spelled, message: `${spelled} cannot be resolved (${(err as NodeJS.ErrnoException).code ?? String(err)}); skipped` });
    return false;
  }
  if (real.startsWith(realRoot + sep)) return true;
  findings.push({ kind: 'outside-config-dir', path: spelled, message: `${spelled} resolves to ${real}, outside the config dir ${realRoot}; skipped` });
  return false;
}

/**
 * Tier (2) for ONE config dir: the highest semver version-DIRECTORY NAME in its marketplace cache
 * whose `plugin.json` version equals that name. Two passes over the entries in descending
 * `compareVersions` order (a total order over distinct names — the pick never depends on `readdir`):
 * first every name is judged by shape and by lstat (a non-semver name is ignored, a link skipped,
 * each with a finding); then the surviving dirs are inspected highest-first and the first one whose
 * manifest agrees with its name, and which resolves inside the config dir, is the pick — a
 * manifest-less or mismatching dir above it is skipped with a finding, dirs below it are not read.
 */
function cacheCandidate(configDir: string, findings: DiscoveryFinding[]): PluginSource | null {
  const root = realPluginRoot(configDir); // the ONE link the automatic tiers follow: the config dir itself
  if (root === null) return null;
  const cache = noFollowBelow(root, CACHE_SEGMENTS, configDir, findings);
  if (cache === null || !lstatSync(cache).isDirectory()) return null;
  const spelledCache = livePluginCacheDir(configDir);
  const names: string[] = [];
  for (const name of readdirSync(cache).sort((a, b) => compareVersions(b, a))) {
    if (!SEMVER_DIR_RE.test(name)) {
      findings.push({ kind: 'non-semver-name', path: join(spelledCache, name), message: `${join(spelledCache, name)}: the cache entry's name is not a semver version; ignored` });
      continue;
    }
    if (noFollowBelow(root, [...CACHE_SEGMENTS, name], configDir, findings) !== null) names.push(name);
  }
  for (const name of names) {
    const spelled = join(spelledCache, name);
    const version = pluginVersionAt(spelled); // a linked `.claude-plugin/` or `plugin.json` throws — loud, never a silent skip to another version
    if (version === null) {
      findings.push({ kind: 'no-manifest', path: spelled, message: `${spelled}: no .claude-plugin/plugin.json with a version; skipped` });
      continue;
    }
    if (version !== name) {
      findings.push({ kind: 'version-mismatch', path: spelled, message: `${spelled}: plugin.json declares version ${version} but the directory is named ${name}; skipped` });
      continue;
    }
    if (!containedInConfigDir(spelled, root, findings)) continue;
    return { path: spelled, kind: 'claude-plugin-cache', plugin_version: version };
  }
  return null;
}

/** Tier (3) for ONE config dir: its installer-managed copy — `plugins/wicked-garden` exists, is no link, and its `plugin.json` parses with a `version`. */
function copyCandidate(configDir: string, findings: DiscoveryFinding[]): PluginSource | null {
  const root = realPluginRoot(configDir);
  if (root === null) return null;
  const dir = noFollowBelow(root, COPY_SEGMENTS, configDir, findings);
  if (dir === null || !lstatSync(dir).isDirectory()) return null;
  const spelled = installerCopyDir(configDir);
  const version = pluginVersionAt(spelled);
  if (version === null) {
    findings.push({ kind: 'no-manifest', path: spelled, message: `${spelled} exists but has no .claude-plugin/plugin.json with a version — not a plugin root; skipped` });
    return null;
  }
  if (!containedInConfigDir(spelled, root, findings)) return null;
  return { path: spelled, kind: 'installer-copy', plugin_version: version };
}

/**
 * Discover the installed plugin in the order design amendment v3.6 fixes (module header), with what
 * was passed over: (1) the explicit `WICKED_CREW_SKILLS_SOURCE` override; (2) the FIRST config dir
 * (as listed, `~/.claude` appended) holding a valid marketplace cache — the highest version-dir name
 * inside it; (3) LAST resort, the first of those dirs holding a valid installer copy. ANY cache beats
 * ANY copy. `env`/`home` are injectable so tests never read the developer's real config dir. `source`
 * is `null` when nothing is installed — the caller says "install garden first" loudly. A finding is
 * reported once per entry even when both tiers meet it (a linked `plugins/`, say).
 */
export function discoverLivePluginDetailed(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): Discovery {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const findings: DiscoveryFinding[] = [];
  const override = env[SKILLS_SOURCE_ENV];
  if (override !== undefined && override !== '') return { source: pluginSourceAt(override), findings };
  const dirs = claudeConfigDirs(env, home);
  let source: PluginSource | null = null;
  for (const dir of dirs) {
    source = cacheCandidate(dir, findings);
    if (source !== null) break;
  }
  if (source === null) {
    for (const dir of dirs) {
      source = copyCandidate(dir, findings);
      if (source !== null) break;
    }
  }
  const seen = new Set<string>();
  return { source, findings: findings.filter((f) => !seen.has(`${f.kind}\0${f.path}`) && seen.add(`${f.kind}\0${f.path}`) !== undefined) };
}

/** `discoverLivePluginDetailed` answering the source alone; pass `findings` to collect what was passed over. */
export function discoverLivePlugin(opts: { env?: NodeJS.ProcessEnv; home?: string; findings?: DiscoveryFinding[] } = {}): PluginSource | null {
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
