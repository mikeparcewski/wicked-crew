/**
 * The bundle = the DEPENDENCY CLOSURE of the plugin root (design v3 §4), not a directory heuristic:
 *
 *   .claude-plugin/{plugin.json, archetypes.json, components.json}   the manifest + the catalogs the
 *                                                                     runtime reads (archetypes_v11.py
 *                                                                     raises when archetypes.json is
 *                                                                     absent) — all three REQUIRED at
 *                                                                     publish (`REQUIRED_PLUGIN_CATALOGS`)
 *   skills/**                                                         nested layout VERBATIM — never renamed
 *   scripts/**  minus ci/ and the wg dev tools                        what `${CLAUDE_PLUGIN_ROOT}/scripts/…` resolves
 *   schemas/                                                          `../schemas/evidence.json` links
 *   docs/examples/                                                    `qe/refs/campaign.md` → the copyable workflows
 *   pyproject.toml, uv.lock                                           `uv run` from the plugin root needs them
 *
 * Hooks, the site, tests, `.venv`, the operator's `_meta/`, and everything else a plugin checkout
 * carries never come along. The content hash of THIS set is the baseline's identity.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN_MANIFEST_REL } from './plugin-source.js';
import { toPosix, walkFiles, type FileRecord } from './tree.js';

/** The plugin subdirectory skills live in (and the prefix of every manifest `dir`). */
export const SKILLS_SUBDIR = 'skills';

/**
 * The runtime catalogs every snapshot MUST carry beside `plugin.json` (design v3 §4): garden's
 * runtime reads `archetypes.json` (`scripts/crew/archetypes_v11.py:60-74` raises when it is absent)
 * and `components.json`. Their absence in `effective/` is a BLOCKING publish finding
 * (`missing-plugin-manifest`) — a seed copies what the source has (a source missing them is a
 * defective install the publish names, not a seed failure).
 */
export const REQUIRED_PLUGIN_CATALOGS: ReadonlyArray<string> = [
  '.claude-plugin/archetypes.json',
  '.claude-plugin/components.json',
];

/** Root-level files copied when present (`plugin.json` is required — its absence means "not a plugin"). */
const OPTIONAL_ROOT_FILES: ReadonlyArray<string> = [...REQUIRED_PLUGIN_CATALOGS, 'pyproject.toml', 'uv.lock'];

/** Directories copied whole (POSIX-relative to the plugin root). */
const BUNDLE_DIRS: ReadonlyArray<string> = [SKILLS_SUBDIR, 'scripts', 'schemas', 'docs/examples'];

/** Top-level `scripts/` entries that are dev tooling, never runtime: CI and the `wg` maintainer CLI. */
function isScriptsDevDir(rel: string): boolean {
  return !rel.includes('/') && (rel === 'ci' || rel === 'wg' || rel.startsWith('wg-'));
}

/** The plugin root has no `.claude-plugin/plugin.json`. */
export class NotAPluginRootError extends Error {
  constructor(readonly dir: string) {
    super(`${dir} has no ${toPosix(PLUGIN_MANIFEST_REL)} — not a plugin root`);
    this.name = 'NotAPluginRootError';
  }
}

/** The bundle file set of `pluginRoot`, sorted by `rel`. */
export function pluginBundleFiles(pluginRoot: string): FileRecord[] {
  const manifestAbs = join(pluginRoot, PLUGIN_MANIFEST_REL);
  if (!existsSync(manifestAbs)) throw new NotAPluginRootError(pluginRoot);
  const out: FileRecord[] = [{ rel: toPosix(PLUGIN_MANIFEST_REL), abs: manifestAbs }];
  for (const rel of OPTIONAL_ROOT_FILES) {
    const abs = join(pluginRoot, ...rel.split('/'));
    if (existsSync(abs)) out.push({ rel, abs });
  }
  for (const dir of BUNDLE_DIRS) {
    const skip = dir === 'scripts' ? isScriptsDevDir : undefined;
    for (const f of walkFiles(join(pluginRoot, ...dir.split('/')), skip)) {
      out.push({ rel: `${dir}/${f.rel}`, abs: f.abs });
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
