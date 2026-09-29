/**
 * The LIVE installed wicked-garden plugin, as the catalog reports it (wicked-studio#388).
 *
 * The daemon-owned root holds a BASELINE — a content-addressed copy of the plugin as it was when
 * `refresh-baseline` last captured it — and publishes immutable snapshots from it. Nothing said
 * whether the plugin ON DISK had moved since. In the MCP S8 dogfood the published snapshot was
 * generation 5, captured before wicked-garden#1192 added `scripts/mcp/shim.py`, so the first
 * governed run failed with `scripts/mcp/shim.py: not found under the plugin root
 * …/snapshots/000005`. The remedy (Refresh baseline → Publish) worked, but nothing on the page had
 * told the operator the root was behind their install — and every MCP call a worker makes goes
 * through that shim.
 *
 * The comparison is the CONTENT HASH, the same identity `refresh-baseline` decides on
 * (`hashFileSet` over the dependency closure). Not the version string: two installs of one version
 * with different bytes are two baselines, and a checkout that moved without a version bump is the
 * dogfood's exact case. The cost is one bundle read, on a route studio calls when the page loads.
 */

import { hashFileSet, type FileRecord } from './tree.js';
import { pluginBundleFiles } from './bundle.js';
import { discoverLivePlugin, gitStateOf, type PluginSource } from './plugin-source.js';
import type { SkillSourceKind } from '../core/types.js';

/** What `GET /skills` reports about the installed plugin (`SkillsManifestResponse.installed`). */
export interface InstalledPluginState {
  source: { kind: SkillSourceKind; path: string; plugin_version: string };
  /** HEAD sha for a `checkout` source; `null` otherwise (or when git could not answer). */
  git_sha: string | null;
  /**
   * The content hash of the installed bundle — comparable with `SkillManifest.baseline`. `null`
   * when the bundle could not be read, and then `unreadable` says why: a comparison crew could not
   * make is stated, never reported as agreement.
   */
  baseline: string | null;
  unreadable: string | null;
}

/**
 * The installed plugin's identity, or `null` when no plugin is installed at all (the unseeded case
 * the catalog's own 503 already covers). `discover` / `bundle` / `hash` are injectable so a test
 * never reads the developer's own config dir.
 */
export function installedPluginState(opts: {
  discover?: () => PluginSource | null;
  bundle?: (root: string) => FileRecord[];
  hash?: (files: FileRecord[]) => string;
  git?: (source: PluginSource) => { git_sha: string | null };
} = {}): InstalledPluginState | null {
  const source = (opts.discover ?? (() => discoverLivePlugin()))();
  if (source === null) return null;
  const bundle = opts.bundle ?? pluginBundleFiles;
  const hash = opts.hash ?? hashFileSet;
  const git = opts.git ?? gitStateOf;
  const state = {
    source: { kind: source.kind, path: source.path, plugin_version: source.plugin_version },
    git_sha: git(source).git_sha,
  };
  try {
    return { ...state, baseline: hash(bundle(source.path)), unreadable: null };
  } catch (err) {
    // A symlink among the bundle's designated entries, a file that vanished mid-walk, a permission
    // refusal. The catalog still answers — this one comparison is simply unavailable, and says so.
    return { ...state, baseline: null, unreadable: err instanceof Error ? err.message : String(err) };
  }
}
