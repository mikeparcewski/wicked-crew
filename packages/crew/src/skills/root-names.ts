/**
 * EVERY name the daemon can ever create directly under `<state home>/skills/` and under its
 * `snapshots/` slot — settled AND transient — in one table (design v3.5 §2; codex round 8 on #480).
 *
 * The worker Read fence (wicked-core) classifies the children of `skills/` and of `snapshots/` from
 * the shared fixture `tests/fixtures/state-home-subtrees.json` (byte-identical in core and crew) and
 * REFUSES a launch naming a child it does not know — so a transient name the store creates during a
 * mutation (a `.staging-*` park-and-place directory, the `manifest.json.tmp-*` of a commit, a
 * generation being written under `snapshots/.staging-*`, the `snapshots/.tmp-current-*` link before
 * its rename) that is missing from the fixture is a live race between a mutation and a worker launch.
 *
 * This table is the store's side of that contract: the store binds its own constants to it
 * (`store.ts`, `tree.ts`), `tests/skills-fence-names.test.ts` asserts the fixture's `skills` entry
 * lists EXACTLY these patterns with these kinds (a static audit over the store's source backs it —
 * every `join(this.rootDir, …)` / `join(this.snapshotsDir(), …)` the store writes must resolve to a
 * row here), and a paused-operation test observes the transient names at the moment they exist.
 * Adding a name the store writes means adding it HERE first; the tests then demand the fixture (and,
 * through the coordinator, core) follow.
 *
 * Not listed: `baseline/.staging-*` (a capture being written) — `baseline/` is denied WHOLE, so its
 * children are never classified individually.
 */

export type SkillsRootNameKind = 'dir' | 'file' | 'link';

export interface SkillsRootName {
  /** Exact name, or a `prefix-*` glob; `snapshots/…` for a child of the slot. */
  pattern: string;
  kind: SkillsRootNameKind;
  /** Exists only for the width of one mutation (created, then renamed away or removed). */
  transient: boolean;
  /** Where the store creates it — prose for the reader and the audit. */
  created_by: string;
}

/** The park-and-place staging prefix (`.staging-<op>-<hex>` under the root; `.staging-<hex>` under `baseline/` and `snapshots/`). */
export const STAGING_PREFIX = '.staging-';
/** The transient `current` link's prefix inside `snapshots/` (created there, renamed over `skills/current`). */
export const CURRENT_TMP_PREFIX = '.tmp-current-';
/** `writeFileAtomic`'s temp-file infix: `<file>.tmp-<hex>`, renamed over `<file>` — `manifest.json.tmp-*` at the root. */
export const ATOMIC_TMP_INFIX = '.tmp-';
/** The refusal sentinel directory name (`<root>/refused/skills.{blocked,config}`) — NAMED, never created. */
export const REFUSED_DIRNAME = 'refused';

export const SKILLS_ROOT_NAMES: ReadonlyArray<SkillsRootName> = [
  { pattern: 'baseline', kind: 'dir', transient: false, created_by: 'store.ts captureBaseline — baseline/<hash>/ per captured bundle' },
  { pattern: 'effective', kind: 'dir', transient: false, created_by: 'store.ts seed — the operator-edited plugin root' },
  { pattern: 'manifest.json', kind: 'file', transient: false, created_by: 'store.ts writeManifest' },
  { pattern: `manifest.json${ATOMIC_TMP_INFIX}*`, kind: 'file', transient: true, created_by: 'tree.ts writeFileAtomic — the manifest commit writes manifest.json.tmp-<hex> and renames it over manifest.json' },
  { pattern: 'snapshots', kind: 'dir', transient: false, created_by: 'store.ts publishSerialized — the read slot; <gen>/ children are what a worker reads' },
  { pattern: 'current', kind: 'link', transient: false, created_by: 'store.ts flipCurrent — current -> snapshots/<gen>' },
  { pattern: '.uv-cache', kind: 'dir', transient: false, created_by: "venv.ts UV_CACHE_DIRNAME — the daemon's own uv cache (UV_CACHE_DIR)" },
  { pattern: `${STAGING_PREFIX}*`, kind: 'dir', transient: true, created_by: 'store.ts swapOwnFiles / stageSingleFile / reset / refreshBaseline — the park-and-place staging (new/ + old/) of one mutation' },
  { pattern: REFUSED_DIRNAME, kind: 'dir', transient: false, created_by: 'runtime.ts refusalPath — NAMED as the non-existent engine input <root>/refused/skills.{blocked,config}; never created' },
  { pattern: `snapshots/${STAGING_PREFIX}*`, kind: 'dir', transient: true, created_by: 'store.ts publishSerialized — a generation being written, renamed to snapshots/<gen>' },
  { pattern: `snapshots/${CURRENT_TMP_PREFIX}*`, kind: 'link', transient: true, created_by: 'store.ts flipCurrent — the transient current link, renamed over skills/current' },
];
