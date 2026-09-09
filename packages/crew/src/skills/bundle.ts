/**
 * The bundle = the DEPENDENCY CLOSURE of the plugin root (design v3 §4), not a directory heuristic:
 *
 *   .claude-plugin/{plugin,archetypes,components,specialist,stack-registry}.json
 *                                                                     the manifest + the runtime catalogs
 *                                                                     garden's scripts read, BY NAME
 *                                                                     (`PLUGIN_MANIFEST_FILES`) — plugin.json,
 *                                                                     archetypes.json and components.json
 *                                                                     REQUIRED at publish
 *                                                                     (`REQUIRED_PLUGIN_CATALOGS`); anything
 *                                                                     else in that directory (marketplace.json,
 *                                                                     a publish-time listing) is outside
 *   skills/**                                                         nested layout VERBATIM — never renamed
 *   scripts/**  minus ci/, wg/ and the wg-… dev tools                 what `${CLAUDE_PLUGIN_ROOT}/scripts/…` resolves
 *   schemas/**                                                        `../schemas/evidence.json` links
 *   docs/examples/**                                                  `qe/refs/campaign.md` → the copyable workflows
 *   pyproject.toml, uv.lock                                           `uv run` from the plugin root needs them
 *
 * Hooks, the site, tests, `.venv`, the operator's `_meta/`, and everything else a plugin checkout
 * carries never come along. The content hash of THIS set is the baseline's identity.
 *
 * # ONE allowlist (codex round 6 on #480; the exact spelling — codex round 7)
 *
 * `inBundleClosure` is the closure as a predicate over a plugin-relative path — the single source
 * three consumers share: the seed/refresh copy (`pluginBundleFiles` keeps only members), the support
 * file API (`store.resolveSupportFile` refuses a path outside it with an `outside-closure` blocked
 * envelope) and publish/analyze (a file found under `effective/` outside it — a direct filesystem
 * edit — is a BLOCKING `outside-closure` finding naming the path). What the seed would not copy,
 * the API cannot add and a snapshot never ships. The `.claude-plugin` half is an allowlist BY NAME,
 * adjudicated against the live 12.32.0 layout (six files there; five are runtime catalogs garden's
 * scripts read — `specialist.json` by `scripts/crew/specialist_discovery.py`, `stack-registry.json`
 * by the pack/capability registries); `scripts/wg/` IS a directory in the live plugin, so it is
 * excluded as a directory alongside `ci/`, and the `wg-…` prefix exclusion stays.
 *
 * # No-follow BELOW the source root (codex round 6)
 *
 * The plugin root is resolved ONCE (`realPluginRoot` — an operator's symlinked config dir reaches
 * it legitimately); every designated entry below it — each named manifest file, each root file,
 * each bundle directory and everything under it — is lstat-walked, and a symlink among them refuses
 * the whole ingestion by name (`PluginSourceSymlinkError`): nothing is copied. A link inside a
 * PRUNED subtree (`scripts/ci/`, `node_modules/`, `.venv/`) or at a non-designated name
 * (`.claude-plugin/marketplace.json`) is never reached — it is not part of the closure, so it is
 * neither copied nor judged.
 */

import { lstatSync } from 'node:fs';

import { noFollowEntry, PLUGIN_MANIFEST_REL, PluginSourceSymlinkError, realPluginRoot } from './plugin-source.js';
import { toPosix, walkTree, type FileRecord } from './tree.js';

/** The plugin subdirectory skills live in (and the prefix of every manifest `dir`). */
export const SKILLS_SUBDIR = 'skills';

/** The manifest directory. */
export const PLUGIN_MANIFEST_DIRNAME = '.claude-plugin';

/**
 * The files under `.claude-plugin/` that ride the bundle — BY NAME (codex round 7, adjudicated on the
 * live 12.32.0 layout): the plugin manifest and the four runtime catalogs garden's scripts read.
 * `marketplace.json` (the marketplace's publish-time listing) and anything else are outside.
 */
export const PLUGIN_MANIFEST_FILES: ReadonlyArray<string> = [
  'plugin.json',
  'archetypes.json',
  'components.json',
  'specialist.json',
  'stack-registry.json',
];

/**
 * The runtime catalogs every snapshot MUST carry beside `plugin.json` (design v3 §4): garden's
 * runtime reads `archetypes.json` (`scripts/crew/archetypes_v11.py:60-74` raises when it is absent)
 * and `components.json`. Their absence in `effective/` is a BLOCKING publish finding
 * (`missing-plugin-manifest`) — a seed copies what the source has (a source missing them is a
 * defective install the publish names, not a seed failure).
 */
export const REQUIRED_PLUGIN_CATALOGS: ReadonlyArray<string> = [
  `${PLUGIN_MANIFEST_DIRNAME}/archetypes.json`,
  `${PLUGIN_MANIFEST_DIRNAME}/components.json`,
];

/** Root-level files copied when present. */
const BUNDLE_ROOT_FILES: ReadonlyArray<string> = ['pyproject.toml', 'uv.lock'];

/** Directories copied whole (POSIX-relative to the plugin root). */
const BUNDLE_DIRS: ReadonlyArray<string> = [SKILLS_SUBDIR, 'scripts', 'schemas', 'docs/examples'];

/** Top-level `scripts/` entries that are dev tooling, never runtime: the `ci/` and `wg/` directories and any `wg-…` maintainer tool. */
function isScriptsDevDir(rel: string): boolean {
  return !rel.includes('/') && (rel === 'ci' || rel === 'wg' || rel.startsWith('wg-'));
}

/** The human spelling of the closure — for findings and refusals. */
export const BUNDLE_CLOSURE_SPELLING = `${PLUGIN_MANIFEST_DIRNAME}/{${PLUGIN_MANIFEST_FILES.map((f) => f.replace(/\.json$/, '')).join(',')}}.json, ${SKILLS_SUBDIR}/**, scripts/** (minus ci/, wg/ and wg-*), schemas/**, docs/examples/**, ${BUNDLE_ROOT_FILES.join(', ')}`;

/**
 * Whether a plugin-relative POSIX path is a member of the bundle closure (module header: the ONE
 * allowlist). Lexical — the caller has already validated the path's shape.
 */
export function inBundleClosure(rel: string): boolean {
  const segments = rel.split('/');
  if (segments.length === 2 && segments[0] === PLUGIN_MANIFEST_DIRNAME) return PLUGIN_MANIFEST_FILES.includes(segments[1] ?? '');
  if (segments.length === 1) return BUNDLE_ROOT_FILES.includes(rel);
  for (const dir of BUNDLE_DIRS) {
    const prefix = `${dir}/`;
    if (!rel.startsWith(prefix)) continue;
    if (dir === 'scripts' && isScriptsDevDir(rel.slice(prefix.length).split('/')[0] ?? '')) return false;
    return true;
  }
  return false;
}

/** The plugin root has no `.claude-plugin/plugin.json`. */
export class NotAPluginRootError extends Error {
  constructor(readonly dir: string) {
    super(`${dir} has no ${toPosix(PLUGIN_MANIFEST_REL)} — not a plugin root`);
    this.name = 'NotAPluginRootError';
  }
}

/**
 * The bundle file set of `pluginRoot`, sorted by `rel` — every member of the closure the source
 * carries, reached without following a link below the once-resolved root (module header). Throws
 * `NotAPluginRootError` (no manifest) or `PluginSourceSymlinkError` (a link among the designated
 * entries — nothing is copied by the caller either).
 */
export function pluginBundleFiles(pluginRoot: string): FileRecord[] {
  const root = realPluginRoot(pluginRoot);
  if (root === null) throw new NotAPluginRootError(pluginRoot);
  const manifestAbs = noFollowEntry(root, [PLUGIN_MANIFEST_DIRNAME, 'plugin.json'], pluginRoot);
  if (manifestAbs === null || !lstatSync(manifestAbs).isFile()) throw new NotAPluginRootError(pluginRoot);
  const out: FileRecord[] = [];
  // The manifest files BY NAME (the dir itself was walked no-follow on the way to plugin.json): a
  // designated name that is a link is refused; a name outside the allowlist is never touched.
  for (const name of PLUGIN_MANIFEST_FILES) {
    const abs = noFollowEntry(root, [PLUGIN_MANIFEST_DIRNAME, name], pluginRoot);
    if (abs !== null && lstatSync(abs).isFile()) out.push({ rel: `${PLUGIN_MANIFEST_DIRNAME}/${name}`, abs });
  }
  for (const rel of BUNDLE_ROOT_FILES) {
    const abs = noFollowEntry(root, [rel], pluginRoot);
    if (abs !== null && lstatSync(abs).isFile()) out.push({ rel, abs });
  }
  for (const dir of BUNDLE_DIRS) {
    const abs = noFollowEntry(root, dir.split('/'), pluginRoot);
    if (abs === null || !lstatSync(abs).isDirectory()) continue;
    // Links are ENUMERATED, never skipped (`walkTree`): a linked `skills/<x>` dir or a linked file
    // inside a skill is refused by name rather than silently left out of the bundle.
    const tree = walkTree(abs, dir === 'scripts' ? isScriptsDevDir : undefined);
    const link = tree.links[0];
    if (link !== undefined) throw new PluginSourceSymlinkError(pluginRoot, `${dir}/${link.rel}`, link.target);
    for (const f of tree.files) {
      const rel = `${dir}/${f.rel}`;
      if (inBundleClosure(rel)) out.push({ rel, abs: f.abs }); // the predicate is the source of truth; the prune above is its fast path
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Every `skills/<rel>` dir in a file set that holds a `SKILL.md` (`skills/SKILL.md` itself is not a skill). */
export function skillDirsOf(files: ReadonlyArray<{ rel: string }>): Set<string> {
  const dirs = new Set<string>();
  const prefix = `${SKILLS_SUBDIR}/`;
  for (const f of files) {
    if (!f.rel.startsWith(prefix) || !f.rel.endsWith('/SKILL.md')) continue;
    const dir = f.rel.slice(0, -'/SKILL.md'.length);
    if (dir !== SKILLS_SUBDIR) dirs.add(dir);
  }
  return dirs;
}

/**
 * The skill dir that OWNS a plugin-relative path: the deepest `skillDirs` entry the path sits
 * under, or `null` for a support file. Nested-skill ownership (v3 §6) is exactly this rule.
 */
export function owningSkillDir(rel: string, skillDirs: ReadonlySet<string>): string | null {
  let best: string | null = null;
  for (const dir of skillDirs) {
    if (rel === dir || rel.startsWith(`${dir}/`)) {
      if (best === null || dir.length > best.length) best = dir;
    }
  }
  return best;
}
