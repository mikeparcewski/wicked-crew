/**
 * The non-Claude CLI mirror (design v3 §2/§8): the PUBLISHED snapshot's enabled, PORTABLE skills as
 * `<frontmatter-name>/<the skill's own files>` into the skill dirs codex, pi, opencode and copilot
 * read — additive discovery, documented as additive, never exclusive. Behind the `skills_mirror`
 * setting (ON by default).
 *
 * Targets: `~/.codex/skills` always (created when absent — codex is the roster's primary
 * non-Claude seat); `~/.pi/agent/skills`, `~/.config/opencode/skills`, `~/.copilot/skills` only
 * when those dirs already exist (the daemon does not conjure another CLI's home).
 *
 * What is mirrored is the skill's WHOLE own tree (its dir minus nested skills' subtrees) — a
 * portable skill may link `refs/notes.md` beside its SKILL.md, and a mirror carrying only SKILL.md
 * would arrive broken (codex review of #480). Hashes are therefore TREE hashes (tree.ts
 * `hashFileSet` over the dir), on disk and in the ledger alike.
 *
 * The adoption ledger (manifest `mirror.ledger[target][name] = {hash, origin}`) is what makes a
 * pass safe to run after every publish:
 *   - first run per target: every pre-existing `wicked-garden-*` entry is ADOPTED — its current
 *     tree hash recorded — so the operator's existing codex copies are tracked, never duplicated;
 *   - an ADOPTED entry is NEVER overwritten: byte-identical to ours it is simply in sync; different
 *     it is `foreign-modified` — left alone and named (design v3 §8: "never overwritten if the hash
 *     differs from ours"). Adoption records the foreign hash and stops there;
 *   - an entry the daemon WROTE is rewritten only while its on-disk hash still equals the ledger's
 *     (ours, untouched since); one that differs is `foreign-modified` too;
 *   - an entry is removed (a skill disabled, removed, or gone non-portable) only when the ledger
 *     says the daemon WROTE it and it is unmodified; adopted and unknown entries are never deleted.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { SkillMirrorLedgerEntry, SkillMirrorState } from '../core/types.js';
import { SKILL_NAME_PREFIX } from './frontmatter.js';
import type { SkillsStore } from './store.js';
import { copyFiles, hashFileSet, walkFiles, type FileRecord } from './tree.js';

/** The target always written (created when absent). */
export const PRIMARY_MIRROR_REL: ReadonlyArray<string> = ['.codex', 'skills'];
/** Targets written only when the CLI's skill dir already exists. */
export const OPTIONAL_MIRROR_RELS: ReadonlyArray<ReadonlyArray<string>> = [
  ['.pi', 'agent', 'skills'],
  ['.config', 'opencode', 'skills'],
  ['.copilot', 'skills'],
];

/** The target dirs a pass writes for `home`. */
export function mirrorTargets(home: string): string[] {
  const out = [join(home, ...PRIMARY_MIRROR_REL)];
  for (const rel of OPTIONAL_MIRROR_RELS) {
    const dir = join(home, ...rel);
    if (existsSync(dir)) out.push(dir);
  }
  return out;
}

export interface MirrorResult {
  /** Names written (created or refreshed) per target dir. */
  written: Record<string, string[]>;
  /** Names removed per target dir (entries the daemon wrote, no longer eligible). */
  removed: Record<string, string[]>;
  /** Names adopted per target dir on this pass (pre-existing garden entries found). */
  adopted: Record<string, string[]>;
  /** Names left alone per target because their on-disk tree differs from ours / the ledger. */
  foreign_modified: Record<string, string[]>;
  skipped_non_portable: string[];
}

/** Tree hash of a mirrored skill dir on disk, or `null` when absent, not a directory, a link, or empty. */
function treeHashOnDisk(dir: string): string | null {
  try {
    if (!lstatSync(dir).isDirectory()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const files = walkFiles(dir);
  return files.length === 0 ? null : hashFileSet(files);
}

/** The skill's OWN files inside the snapshot (nested skills' subtrees excluded), rel to the skill dir. */
function ownFilesInSnapshot(snapshotPath: string, skillDir: string, snapshotDirs: ReadonlySet<string>): FileRecord[] {
  return walkFiles(join(snapshotPath, ...skillDir.split('/')), (rel) => snapshotDirs.has(`${skillDir}/${rel}`));
}

/**
 * Sync every target with the current snapshot's enabled, portable skills. `home` is injectable so
 * tests never touch the developer's real dotfiles. Returns `null` when nothing is published yet.
 */
export function mirrorSkills(store: SkillsStore, home: string): MirrorResult | null {
  const current = store.currentSnapshot();
  if (current === null) return null;
  const snapshot = store.readSnapshotManifest(current.path);
  const snapshotDirs = new Set(snapshot.skills.map((s) => s.dir));
  const eligible = snapshot.skills.filter((s) => s.portable);
  const skipped = snapshot.skills.filter((s) => !s.portable).map((s) => s.name).sort();
  const manifest = store.manifest();
  const ledger: Record<string, Record<string, SkillMirrorLedgerEntry>> = { ...manifest.mirror.ledger };

  const result: MirrorResult = { written: {}, removed: {}, adopted: {}, foreign_modified: {}, skipped_non_portable: skipped };
  for (const target of mirrorTargets(home)) {
    mkdirSync(target, { recursive: true });
    const book: Record<string, SkillMirrorLedgerEntry> = { ...(ledger[target] ?? {}) };
    const written: string[] = [];
    const removed: string[] = [];
    const adopted: string[] = [];
    const foreign: string[] = [];

    // Adoption: garden-named entries on disk the ledger has never seen — recorded, never touched.
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(SKILL_NAME_PREFIX) || book[entry.name] !== undefined) continue;
      const hash = treeHashOnDisk(join(target, entry.name));
      if (hash === null) continue;
      book[entry.name] = { hash, origin: 'adopted' };
      adopted.push(entry.name);
    }

    for (const skill of eligible) {
      const dir = join(target, skill.name);
      const own = ownFilesInSnapshot(current.path, skill.dir, snapshotDirs);
      const wanted = hashFileSet(own);
      const onDisk = treeHashOnDisk(dir);
      const known = book[skill.name];
      if (onDisk === wanted) {
        book[skill.name] = { hash: wanted, origin: known?.origin ?? 'written' };
        continue;
      }
      if (onDisk !== null && (known === undefined || known.origin === 'adopted' || onDisk !== known.hash)) {
        // Not ours-and-unmodified: an adopted copy that differs, a hand edit of what we wrote, or
        // a dir that appeared since adoption ran. Left alone, named.
        foreign.push(skill.name);
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      copyFiles(own, dir);
      book[skill.name] = { hash: wanted, origin: 'written' };
      written.push(skill.name);
    }

    const eligibleNames = new Set(eligible.map((s) => s.name));
    for (const [name, known] of Object.entries(book)) {
      if (eligibleNames.has(name) || known.origin !== 'written') continue;
      const dir = join(target, name);
      const onDisk = treeHashOnDisk(dir);
      if (onDisk === null) {
        delete book[name]; // already gone
        continue;
      }
      if (onDisk !== known.hash) {
        foreign.push(name);
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      delete book[name];
      removed.push(name);
    }

    ledger[target] = book;
    result.written[target] = written.sort();
    result.removed[target] = removed.sort();
    result.adopted[target] = adopted.sort();
    result.foreign_modified[target] = [...new Set(foreign)].sort();
  }

  const state: SkillMirrorState = {
    ledger,
    skipped_non_portable: skipped,
    foreign_modified: Object.fromEntries(Object.entries(result.foreign_modified).filter(([, v]) => v.length > 0)),
    last_run: store.now(),
  };
  store.setMirrorState(state);
  return result;
}
