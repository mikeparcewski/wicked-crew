/**
 * Where the shipped baseline comes from: the LIVE installed wicked-garden plugin.
 *
 * The daemon seeds (and refreshes) its skills root from the plugin Claude Code actually runs —
 * the marketplace cache under `<CLAUDE_CONFIG_DIR|~/.claude>/plugins/cache/wicked-garden/
 * wicked-garden/<version>` (highest version wins). That is the ONLY automatic source (design v3
 * §3/§8; codex review of #480): the hand-installed `<config dir>/plugins/wicked-garden` copy is the
 * exact stale artifact the operator's `clis.toml` hack pointed workers at (12.28.1 while the live
 * cache was 12.32.0 — design v3 §"Verified mechanics"), so it is never a fallback. NEVER a repo
 * checkout by default either. `WICKED_CREW_SKILLS_SOURCE` is the one explicit override — for
 * tests, and for an operator who deliberately wants a checkout or that hand copy. A machine without
 * the cache has no source at all: crew does not vendor garden — the seed says "install garden
 * first" loudly (`SkillsSourceUnavailableError`) and the runtime leaves the engine input unset.
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
import { join, sep } from 'node:path';

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

/** The Claude Code config dir the plugin cache lives under: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env['CLAUDE_CONFIG_DIR'];
  return configured !== undefined && configured !== '' ? configured : join(home, '.claude');
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
 * Classify a plugin root: a git checkout when it carries `.git`; the installed plugin when it
 * sits under a `plugins/` directory (the marketplace cache or the hand-installed copy); anything
 * else is an explicit plugin-shaped directory (an unpacked tarball, a test fixture).
 */
export function classifySource(dir: string): SkillSourceKind {
  if (existsSync(join(dir, '.git'))) return 'checkout';
  if (dir.split(sep).includes('plugins')) return 'claude-plugin-cache';
  return 'directory';
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

/**
 * Discover the live installed plugin: the explicit `WICKED_CREW_SKILLS_SOURCE` override, else the
 * highest version in the marketplace cache. NOTHING else — in particular not the hand-installed
 * `plugins/wicked-garden` copy (see the module header). `env`/`home` are injectable so tests never
 * read the developer's real config dir. Returns `null` when nothing is installed — the caller says
 * "install garden first" loudly.
 */
export function discoverLivePlugin(
  opts: { env?: NodeJS.ProcessEnv; home?: string } = {},
): PluginSource | null {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const override = env[SKILLS_SOURCE_ENV];
  if (override !== undefined && override !== '') return pluginSourceAt(override);

  const cache = livePluginCacheDir(claudeConfigDir(env, home));
  if (!existsSync(cache)) return null;
  const versions = readdirSync(cache)
    .filter((entry) => pluginVersionAt(join(cache, entry)) !== null)
    .sort(compareVersions);
  const top = versions[versions.length - 1];
  if (top === undefined) return null;
  const dir = join(cache, top);
  return { path: dir, kind: 'claude-plugin-cache', plugin_version: pluginVersionAt(dir) ?? top };
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
