/**
 * The shipped baseline is the first installed wicked-garden in this resolution order:
 * 1. WICKED_CREW_SKILLS_SOURCE, an explicit plugin root (no minimum-version check).
 * 2. Claude marketplace cache: the highest valid SemVer under each Claude config dir,
 *    in CLAUDE_CONFIG_DIR order with ~/.claude appended once. Any cache beats any copy.
 * 3. Claude installer copy: plugins/wicked-garden under those same config dirs.
 * 4. npm-global: a wicked-garden launcher on PATH, then wicked-garden beside crew's package.
 * 5. Codex plugin cache: the highest valid SemVer across marketplaces under
 *    <CODEX_HOME or ~/.codex>/plugins/cache/<marketplace>/wicked-garden/<version>.
 *
 * Every candidate must hold .claude-plugin/plugin.json with a version. Automatic tiers
 * enforce REQUIRED_GARDEN_VERSION. Cache directory names must be SemVer and equal the
 * manifest version; every entry is judged, with findings for skipped entries. Equal-precedence
 * versions use cacheDirOrder; equal Codex versions use marketplace name in lexical order.
 * OpenCode, Pi and Antigravity skills-only copies are not plugin sources. No checkout is
 * discovered automatically. Amendment v3.6 added the installer-copy fallback; only that kind
 * retains the persistent skills.source warning about missing marketplace updates.
 *
 * Config roots and npm package roots may be links: resolve each ONCE, then lstat-walk
 * every entry below the canonical root. A link in a discovery directory is a symlink finding;
 * a linked designated file inside the plugin throws PluginSourceSymlinkError. Manifests are
 * read below the canonical path, never through a spelling that can be retargeted mid-walk.
 * The same no-follow, closure and validation rules protect all seeded sources.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { delimiter, dirname, join, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SkillSourceKind } from '../core/types.js';
import { PLUGIN_NAME } from './frontmatter.js';
import { readFileNoFollow } from './tree.js';
import { childEnvWithBootEstateDb } from '../core/governance-store.js';

/** Explicit plugin-source override — the seam tests and proof scripts aim at a fixture plugin. */
export const SKILLS_SOURCE_ENV = 'WICKED_CREW_SKILLS_SOURCE';

/**
 * The oldest wicked-garden this daemon uses (crew#753). Automatic discovery passes over an installed
 * plugin older than this with a `too-old` finding, and the daemon reports it as a blocking
 * `skills.garden` error naming found vs required, so an old copy is never used without a word.
 * 12.68.0 (crew 0.18.11) is the garden whose estate shim sends `rules.recall` to crew's broker on every governed
 * seat, host seats included (crew#1519 answers it from the run's judged rule set), and whose governed-worker E7 pulls
 * each rule's statement before judging it. With an older garden a host seat asks its pinned store, the run's code
 * graph, which holds no steering rules, and the run brief now carries only rule ids and one-liners. It carries everything 12.67.0 (crew 0.18.10) needed:
 * 12.67.0 is the garden whose extractor proposes a repository's business domains and writes each
 * rule's pick as the `business_domain` annotation wicked-core-ts 0.15.39's domain-graph reads into each requirement
 * (reqgraph Fix B), and whose governed-worker floor asks for the one `STACK-CHECK:` line 0.15.39's POL-2101 record
 * clause cites (wicked-core#1381). An older garden still maps, but with no business domains and no citable stack
 * check, so it is refused rather than used silently. It carries everything 12.66.1 (crew 0.18.0) needed, the garden
 * whose scripts this crew calls: the draft skill's `leak_scan.py`,
 * `notes_check.py` and `keep_check.py` (a draft's landing floor and a refine's keep check, A6/A5),
 * editor conformance cases 7-edit and 18-shows with `conformance.py --engine` and the run-plugin cases
 * (editor installs, CS7), the learn skill's report mode (`sourced-report`, CS3) and the draft kinds
 * Respond and Rework (CS5), plus 12.66.1's run-plugin scaffold that reports its first height (CJ9). It carries everything the earlier floor (12.64.0: `wicked-garden-apps`,
 * the skill every Apps turn and publish tells its units to follow, apps/turns.ts) needed. An explicit
 * `WICKED_CREW_SKILLS_SOURCE` is deliberate and is not judged.
 */
export const REQUIRED_GARDEN_VERSION = '12.68.0';

/** The one install command the README, the findings and the refusals name. */
export const GARDEN_INSTALL_COMMAND = 'npx wicked-installer install wicked-garden';

/** crew#1447: the npm command that updates a garden installed with npm (discovery's npm-global tier finds it). */
export const GARDEN_UPDATE_COMMAND = 'npm i -g wicked-garden@latest';

/** crew#1447: the words a `skills.garden` finding uses when a garden that meets the floor is installed but not published (the Nerve Center keys its fix on them). */
export const GARDEN_NOT_PUBLISHED = 'is installed but was not published';

/** Home-independent spellings keep first-run diagnostics safe to show and share. */
export const GARDEN_SOURCE_SEARCH_DETAIL = 'looked for WICKED_CREW_SKILLS_SOURCE; Claude marketplace cache (~/.claude/plugins/cache/wicked-garden/wicked-garden/<version>, or $CLAUDE_CONFIG_DIR); Claude installer copy (~/.claude/plugins/wicked-garden, or $CLAUDE_CONFIG_DIR); npm-global wicked-garden (launcher on PATH to ~/.../lib/node_modules/wicked-garden or ~/.../node_modules/wicked-garden, then beside the crew package); Codex plugin cache (~/.codex/plugins/cache/<marketplace>/wicked-garden/<version>, or $CODEX_HOME); none holds a .claude-plugin/plugin.json with a usable version';

/** Whether `version` is at least the required garden (SemVer precedence; an unparsable version is not). */
export function gardenMeetsMinimum(version: string, required: string = REQUIRED_GARDEN_VERSION): boolean {
  return parseSemver(version) !== null && compareSemver(version, required) >= 0;
}

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
 * `pluginSourceAt`; the automatic tiers pass already-canonical roots
 * directly to manifestVersionBelow.
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

/**
 * A parsed SemVer 2.0.0 version (semver.org). Numeric identifiers are kept as DIGIT STRINGS, never
 * converted to `number`: above `Number.MAX_SAFE_INTEGER` adjacent values would collapse into one
 * (`9007199254740992` == `9007199254740993` as doubles) and the tie-break would pick the lower dir
 * (codex on #491). SemVer forbids leading zeros, so digit strings compare losslessly by length,
 * then lexically (`compareNumeric`).
 */
export interface Semver {
  major: string;
  minor: string;
  patch: string;
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
    major: m[1] as string,
    minor: m[2] as string,
    patch: m[3] as string,
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
    build: m[5] ?? null,
  };
}

/** Two non-negative integers as digit strings without leading zeros (the SemVer grammar guarantees it): shorter is smaller, equal length compares lexically — exact at any magnitude. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer PRECEDENCE (semver.org §11): major, minor, patch numerically; a pre-release version has
 * LOWER precedence than its release; pre-release identifiers compare left to right — numeric ones
 * numerically (losslessly — digit strings, never `number`), numeric before alphanumeric,
 * alphanumeric ones in ASCII order, a shorter set lower when every preceding identifier is equal.
 * Build metadata is IGNORED: `1.0.1` and `1.0.1+build`
 * have equal precedence (0). Throws for a string that is not a SemVer version — callers validate
 * names first (`parseSemver`).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) throw new TypeError(`compareSemver: not a SemVer version: ${pa === null ? a : b}`);
  for (const part of ['major', 'minor', 'patch'] as const) {
    const c = compareNumeric(pa[part], pb[part]);
    if (c !== 0) return c;
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
      const c = compareNumeric(ia, ib);
      if (c !== 0) return c;
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

/** Classify explicit overrides by their installed layout, including non-Claude sources. */
export function classifySource(dir: string, opts: Pick<DiscoverOptions, 'env' | 'home'> = {}): SkillSourceKind {
  const segments = resolve(dir).split(sep);
  const codexRoot = resolve((opts.env ?? process.env)['CODEX_HOME'] || join(opts.home ?? homedir(), '.codex'));
  const canonicalCodexRoot = opts.env !== undefined || opts.home !== undefined ? realPluginRoot(codexRoot) : null;
  const codexCaches = [codexRoot, ...(canonicalCodexRoot === null ? [] : [canonicalCodexRoot])]
    .map((root) => join(root, 'plugins', 'cache') + sep);
  const codexLayout = segments.some((part, i) => part === '.codex' && segments[i + 1] === 'plugins' && segments[i + 2] === 'cache');
  if ((codexCaches.some((cache) => resolve(dir).startsWith(cache)) || codexLayout) && segments.at(-2) === PLUGIN_NAME) return 'codex-plugin-cache';
  if (existsSync(join(dir, '.git')) && !segments.includes('node_modules')) return 'checkout';
  const last = segments.length - 1;
  if (segments[last] === PLUGIN_NAME && segments[last - 1] === 'plugins') return 'installer-copy';
  if (segments.includes('plugins')) return 'claude-plugin-cache';
  if (npmPackageNamedGarden(dir)) return 'npm-global';
  return 'directory';
}

/** A source for an explicit plugin root; automatic version floors do not apply. */
export function pluginSourceAt(dir: string, opts: Pick<DiscoverOptions, 'env' | 'home'> = {}): PluginSource | null {
  const version = pluginVersionAt(dir);
  return version === null ? null : { path: dir, kind: classifySource(dir, opts), plugin_version: version };
}

/** Package identity is read without following a package.json link below the package root. */
function npmPackageNamedGarden(root: string): boolean {
  const manifest = noFollowEntry(root, ['package.json']);
  if (manifest === null || !lstatSync(manifest).isFile()) return false;
  try {
    const parsed: unknown = JSON.parse(readFileNoFollow(manifest).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && (parsed as { name?: unknown }).name === PLUGIN_NAME;
  } catch (err) {
    if (err instanceof SyntaxError) return false;
    throw err;
  }
}

/** Launcher-relative npm layouts; exported so Windows paths can be tested on POSIX hosts. */
export function npmLauncherPackageDirs(launcher: string, platform: NodeJS.Platform = process.platform, resolvedLauncher?: string): string[] {
  const paths = platform === 'win32' ? win32 : { dirname, resolve, join };
  const bin = paths.dirname(launcher);
  return [
    ...(platform !== 'win32' && resolvedLauncher !== undefined ? [paths.dirname(resolvedLauncher)] : []),
    ...(platform === 'win32' ? [paths.join(bin, 'node_modules', PLUGIN_NAME)] : []),
    paths.resolve(bin, '..', 'lib', 'node_modules', PLUGIN_NAME),
  ];
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
export type DiscoveryFindingKind = 'symlink' | 'non-semver-name' | 'version-mismatch' | 'no-manifest' | 'too-old';

export interface DiscoveryFinding {
  kind: DiscoveryFindingKind;
  /** The entry judged — the CANONICAL path (below the once-resolved config or package root). */
  path: string;
  message: string;
  /** `too-old` only: the plugin version found (crew#753). */
  version?: string;
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
 * Tiers (2)/(5) for ONE canonical config dir: the marketplace cache's version dirs, EVERY one judged
 * (codex on #491): a name must parse as SemVer (else `non-semver-name`, ignored), the entry must be
 * no link (else `symlink`, skipped), and its `plugin.json` — read below the canonical dir, never
 * re-resolved — must exist with a `version` (else `no-manifest`) EQUAL to the name (else
 * `version-mismatch`). The pick is the first agreeing dir in `cacheDirOrder` (highest precedence,
 * documented tie-break); every other dir is still validated so a mismatch anywhere is a finding.
 */
function cacheCandidate(root: string, findings: DiscoveryFinding[], hooks: DiscoveryHooks, segments: ReadonlyArray<string> = CACHE_SEGMENTS, kind: SkillSourceKind = 'claude-plugin-cache'): PluginSource | null {
  const cache = noFollowBelow(root, segments, findings);
  if (cache === null || !lstatSync(cache).isDirectory()) return null;
  const names: string[] = [];
  for (const name of readdirSync(cache).sort()) {
    const dir = join(cache, name);
    if (parseSemver(name) === null) {
      findings.push({ kind: 'non-semver-name', path: dir, message: `${dir}: the cache entry's name is not a valid SemVer version (semver.org); ignored` });
      continue;
    }
    if (noFollowBelow(root, [...segments, name], findings) !== null) names.push(name);
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
    if (pick === null) pick = { path: dir, kind, plugin_version: version };
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
  platform?: NodeJS.Platform;
  /** Installed crew package root (src and dist both live one level below it). */
  crewPackageRoot?: string;
  /** Test seam — see `DiscoveryHooks`. */
  hooks?: DiscoveryHooks;
  /** The minimum garden for the automatic tiers (default {@link REQUIRED_GARDEN_VERSION}). */
  requiredVersion?: string;
}

/** Discover the first usable source in the five tiers documented above, retaining skipped findings. */
export function discoverLivePluginDetailed(opts: DiscoverOptions = {}): Discovery {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const hooks = opts.hooks ?? {};
  const findings: DiscoveryFinding[] = [];
  const override = env[SKILLS_SOURCE_ENV];
  if (override !== undefined && override !== '') return { source: pluginSourceAt(override, { env, home }), findings };
  const roots: string[] = [];
  for (const dir of claudeConfigDirs(env, home)) {
    const root = realPluginRoot(dir); // the ONE realpath of a config dir in all of discovery
    if (root !== null && !roots.includes(root)) roots.push(root);
  }
  // crew#753: an installed garden older than the minimum is passed over by name, never used.
  const required = opts.requiredVersion ?? REQUIRED_GARDEN_VERSION;
  const usable = (candidate: PluginSource | null): PluginSource | null => {
    if (candidate === null || gardenMeetsMinimum(candidate.plugin_version, required)) return candidate;
    findings.push({
      kind: 'too-old',
      path: candidate.path,
      version: candidate.plugin_version,
      message: `${candidate.path}: wicked-garden ${candidate.plugin_version} is older than the required ${required}; not used`,
    });
    return null;
  };
  let source: PluginSource | null = null;
  for (const root of roots) {
    source = usable(cacheCandidate(root, findings, hooks));
    if (source !== null) break;
  }
  if (source === null) {
    for (const root of roots) {
      source = usable(copyCandidate(root, findings, hooks));
      if (source !== null) break;
    }
  }
  if (source === null) {
    const platform = opts.platform ?? process.platform;
    const path = env['PATH'] ?? (platform === 'win32' ? env['Path'] : undefined) ?? '';
    const candidates: string[] = [];
    for (const bin of path.split(platform === 'win32' ? ';' : ':')) {
      if (bin === '') continue;
      const launcher = (platform === 'win32' ? win32 : { join }).join(bin, platform === 'win32' ? 'wicked-garden.cmd' : 'wicked-garden');
      if (!existsSync(launcher)) continue;
      let realLauncher: string | undefined;
      try {
        realLauncher = platform === 'win32' ? undefined : realpathSync(launcher);
      } catch {
        continue; // removed or unreadable since existsSync (pi r1): skip this launcher, never fail the boot
      }
      candidates.push(...npmLauncherPackageDirs(launcher, platform, realLauncher));
    }
    const crewRoot = opts.crewPackageRoot ?? fileURLToPath(new URL('../../', import.meta.url));
    candidates.push(resolve(crewRoot, '..', PLUGIN_NAME));
    const visited = new Set<string>();
    for (const candidate of candidates) {
      const root = realPluginRoot(candidate);
      if (root === null || visited.has(root)) continue;
      visited.add(root);
      if (!npmPackageNamedGarden(root)) continue;
      hooks.beforeManifestRead?.(root);
      const version = manifestVersionBelow(root);
      if (version === null) {
        findings.push({ kind: 'no-manifest', path: root, message: `${root}: no .claude-plugin/plugin.json that parses with a version; skipped` });
        continue;
      }
      source = usable({ path: root, kind: 'npm-global', plugin_version: version });
      if (source !== null) break;
    }
  }
  if (source === null) {
    const root = realPluginRoot(env['CODEX_HOME'] || join(home, '.codex'));
    if (root !== null) {
      const cache = noFollowBelow(root, ['plugins', 'cache'], findings);
      const picks: PluginSource[] = [];
      if (cache !== null && lstatSync(cache).isDirectory()) {
        for (const marketplace of readdirSync(cache).sort()) {
          const candidate = usable(cacheCandidate(root, findings, hooks, ['plugins', 'cache', marketplace, PLUGIN_NAME], 'codex-plugin-cache'));
          if (candidate !== null) picks.push(candidate);
        }
      }
      picks.sort((a, b) => cacheDirOrder(a.plugin_version, b.plugin_version));
      source = picks[0] ?? null;
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
      env: childEnvWithBootEstateDb(),
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: source.path,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: childEnvWithBootEstateDb(),
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

/** crew#1021: checkout probes must never hold the request loop while git runs. */
export async function gitStateOfAsync(source: PluginSource): Promise<GitState> {
  if (source.kind !== 'checkout') return { git_sha: null, git_dirty: false };
  const git = promisify(execFile);
  const options = { cwd: source.path, timeout: GIT_TIMEOUT_MS, env: childEnvWithBootEstateDb() };
  try {
    const sha = await git('git', ['rev-parse', 'HEAD'], options);
    const status = await git('git', ['status', '--porcelain'], options);
    return { git_sha: sha.stdout.trim(), git_dirty: status.stdout.trim() !== '' };
  } catch (err) {
    return { git_sha: null, git_dirty: false, error: err instanceof Error ? err.message : String(err) };
  }
}
