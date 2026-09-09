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
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { SkillSourceKind } from '../core/types.js';
import { PLUGIN_NAME } from './frontmatter.js';

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

/** The plugin manifest's `version` at `dir`, or `null` when `dir` is not a plugin root. */
export function pluginVersionAt(dir: string): string | null {
  const manifest = join(dir, PLUGIN_MANIFEST_REL);
  if (!existsSync(manifest)) return null;
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) return null;
  const version = (parsed as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : null;
}

/**
 * Numeric dotted-version order (`12.9.0` < `12.32.0`). A segment that is not a plain integer
 * sorts BELOW any integer, so a `-beta` cache entry never outranks a release; equal-length
 * numeric prefixes fall back to the shorter-first rule.
 */
export function compareVersions(a: string, b: string): number {
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
