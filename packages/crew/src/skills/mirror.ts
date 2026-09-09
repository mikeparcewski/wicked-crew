/**
 * The non-Claude CLI mirror (design v3 §2/§8): the PUBLISHED snapshot's enabled, PORTABLE skills as
 * `<frontmatter-name>/SKILL.md` into the skill dirs codex, pi, opencode and copilot read — additive
 * discovery, documented as additive, never exclusive. Behind the `skills_mirror` setting (ON by
 * default).
 *
 * Targets: `~/.codex/skills` always (created when absent — codex is the roster's primary
 * non-Claude seat); `~/.pi/agent/skills`, `~/.config/opencode/skills`, `~/.copilot/skills` only
 * when those dirs already exist (the daemon does not conjure another CLI's home).
 *
 * The adoption ledger (manifest `mirror.ledger[target][name] = {hash, origin}`) is what makes a
 * pass safe to run after every publish:
 *   - first run per target: every pre-existing `wicked-garden-*` entry is ADOPTED — its current
 *     hash recorded — so the operator's 48 existing codex copies are kept in sync, never duplicated;
 *   - an entry is (over)written only when its on-disk hash equals the ledger's (ours, or adopted
 *     and untouched since); one that differs is `foreign-modified` — left alone and named;
 *   - an entry is removed (a skill disabled, removed, or gone non-portable) only when the ledger
 *     says the daemon WROTE it and it is unmodified; adopted and unknown entries are never deleted.
 * Only `SKILL.md` is mirrored: a portable skill by definition needs nothing beside it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { SkillMirrorLedgerEntry, SkillMirrorState } from '../core/types.js';
import { SKILL_NAME_PREFIX } from './frontmatter.js';
import { SNAPSHOT_MANIFEST_FILENAME, type SkillsStore, type SnapshotManifest } from './store.js';
import { pruneEmptyDirs, sha256Hex, writeFileAtomic } from './tree.js';

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
  /** Names left alone per target because their on-disk hash differs from the ledger. */
  foreign_modified: Record<string, string[]>;
  skipped_non_portable: string[];
}

function hashOnDisk(file: string): string | null {
  try {
    return sha256Hex(readFileSync(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Sync every target with the current snapshot's enabled, portable skills. `home` is injectable so
 * tests never touch the developer's real dotfiles. Returns `null` when nothing is published yet.
 */
export function mirrorSkills(store: SkillsStore, home: string): MirrorResult | null {
  const current = store.currentSnapshot();
  if (current === null) return null;
  const snapshot = JSON.parse(readFileSync(join(current.path, SNAPSHOT_MANIFEST_FILENAME), 'utf8')) as SnapshotManifest;
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

    // Adoption: garden-named entries on disk the ledger has never seen.
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(SKILL_NAME_PREFIX) || book[entry.name] !== undefined) continue;
      const hash = hashOnDisk(join(target, entry.name, 'SKILL.md'));
      if (hash === null) continue;
      book[entry.name] = { hash, origin: 'adopted' };
      adopted.push(entry.name);
    }

    for (const skill of eligible) {
      const file = join(target, skill.name, 'SKILL.md');
      const content = readFileSync(join(current.path, ...skill.dir.split('/'), 'SKILL.md'));
      const wanted = sha256Hex(content);
      const onDisk = hashOnDisk(file);
      const known = book[skill.name];
      if (onDisk !== null && known !== undefined && onDisk !== known.hash) {
        foreign.push(skill.name);
        continue;
      }
      if (onDisk === wanted) {
        book[skill.name] = { hash: wanted, origin: known?.origin ?? 'written' };
        continue;
      }
      writeFileAtomic(file, content.toString('utf8'));
      book[skill.name] = { hash: wanted, origin: known?.origin === 'adopted' ? 'adopted' : 'written' };
      written.push(skill.name);
    }

    const eligibleNames = new Set(eligible.map((s) => s.name));
    for (const [name, known] of Object.entries(book)) {
      if (eligibleNames.has(name) || known.origin !== 'written') continue;
      const file = join(target, name, 'SKILL.md');
      const onDisk = hashOnDisk(file);
      if (onDisk === null) {
        delete book[name]; // already gone
        continue;
      }
      if (onDisk !== known.hash) {
        foreign.push(name);
        continue;
      }
      rmSync(file, { force: true });
      pruneEmptyDirs(join(target, name), target);
      delete book[name];
      removed.push(name);
    }

    ledger[target] = book;
    result.written[target] = written.sort();
    result.removed[target] = removed.sort();
    result.adopted[target] = adopted.sort();
    result.foreign_modified[target] = foreign.sort();
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
