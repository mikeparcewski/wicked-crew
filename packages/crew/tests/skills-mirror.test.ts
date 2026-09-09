// The non-Claude CLI mirror (design v3 §2/§8): portable + enabled skills of the PUBLISHED snapshot
// as `<name>/<the skill's whole own tree>` into a temp HOME's `.codex/skills` (always) and the
// other CLIs' dirs (when present); the adoption ledger adopts pre-existing garden entries and
// NEVER overwrites them (a differing tree is foreign-modified — codex review of #480), never
// overwrites an entry whose tree differs from the ledger, and never deletes an entry the daemon
// did not write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorSkills, mirrorTargets } from '../src/skills/mirror.js';
import { hashFileSet, walkFiles } from '../src/skills/tree.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

let s: Scaffold;
let codex: string;
let pi: string;

const FOREIGN_BETA = '---\nname: wicked-garden-beta\n---\n\nthe operator\'s hand copy\n';
const FOREIGN_OTHER = '---\nname: wicked-garden-other\n---\n\nnot in the catalog\n';

beforeEach(async () => {
  s = scaffold();
  codex = join(s.home, '.codex', 'skills');
  pi = join(s.home, '.pi', 'agent', 'skills');
  // Pre-existing state on the machine: a garden-named codex entry (an old hand copy of beta), a
  // garden-named entry no catalog skill owns, and a pi skills dir; no opencode/copilot dirs.
  mkdirSync(join(codex, 'wicked-garden-beta'), { recursive: true });
  writeFileSync(join(codex, 'wicked-garden-beta', 'SKILL.md'), FOREIGN_BETA);
  mkdirSync(join(codex, 'wicked-garden-other'), { recursive: true });
  writeFileSync(join(codex, 'wicked-garden-other', 'SKILL.md'), FOREIGN_OTHER);
  mkdirSync(pi, { recursive: true });
  s.store.seed();
  expect((await s.store.publish(1)).verdict).toBe('clear');
});

afterEach(() => {
  removeScratch(s.base);
});

const read = (dir: string, name: string): string => readFileSync(join(dir, name, 'SKILL.md'), 'utf8');
const treeHash = (dir: string): string => hashFileSet(walkFiles(dir));
const pass = (): NonNullable<ReturnType<typeof mirrorSkills>> => mirrorSkills(s.store, s.home) as NonNullable<ReturnType<typeof mirrorSkills>>;

describe('mirrorSkills', () => {
  it('targets codex always and the other CLIs only where their dir exists', () => {
    expect(mirrorTargets(s.home)).toEqual([codex, pi]);
    expect(existsSync(join(s.home, '.copilot'))).toBe(false);
  });

  it('writes portable enabled skills, ADOPTS pre-existing garden entries without overwriting them, leaves foreign entries alone', () => {
    const result = pass();
    expect(result.adopted[codex]).toEqual(['wicked-garden-beta', 'wicked-garden-other']);
    // beta: the operator's hand copy differs from ours → adopted (hash recorded), NOT overwritten, named.
    expect(result.written[codex]).toEqual(['wicked-garden-gamma']);
    expect(result.foreign_modified[codex]).toEqual(['wicked-garden-beta']);
    expect(read(codex, 'wicked-garden-beta')).toBe(FOREIGN_BETA);
    // pi had nothing: both portable skills are written there.
    expect(result.written[pi]).toEqual(['wicked-garden-beta', 'wicked-garden-gamma']);
    expect(read(pi, 'wicked-garden-beta')).toContain('Use the **wicked-garden-gamma** skill');
    expect(result.skipped_non_portable).toEqual([
      'wicked-garden-alpha',
      'wicked-garden-alpha-nested',
      'wicked-garden-delta',
      'wicked-garden-epsilon',
    ]);
    expect(read(codex, 'wicked-garden-other')).toBe(FOREIGN_OTHER);
    expect(existsSync(join(codex, 'wicked-garden-alpha'))).toBe(false);
    expect(existsSync(join(s.home, '.copilot', 'skills'))).toBe(false);
    // The ledger records TREE hashes: what was written and what was adopted.
    const ledger = s.store.manifest().mirror.ledger[codex] ?? {};
    expect(ledger['wicked-garden-beta']).toEqual({ hash: treeHash(join(codex, 'wicked-garden-beta')), origin: 'adopted' });
    expect(ledger['wicked-garden-gamma']).toEqual({ hash: treeHash(join(codex, 'wicked-garden-gamma')), origin: 'written' });
    expect(ledger['wicked-garden-other']).toEqual({ hash: treeHash(join(codex, 'wicked-garden-other')), origin: 'adopted' });
    expect(s.store.manifest().mirror.foreign_modified[codex]).toEqual(['wicked-garden-beta']);
    expect(s.store.manifest().mirror.last_run).toBe('2026-09-08T12:00:00.000Z');
    // A second pass changes nothing: beta stays foreign, gamma is in sync.
    const again = pass();
    expect(again.written[codex]).toEqual([]);
    expect(again.foreign_modified[codex]).toEqual(['wicked-garden-beta']);
    expect(read(codex, 'wicked-garden-beta')).toBe(FOREIGN_BETA);
  });

  it('an adopted entry byte-identical to ours is simply in sync — recorded as adopted, not rewritten', () => {
    const current = s.store.currentSnapshot() as NonNullable<ReturnType<typeof s.store.currentSnapshot>>;
    mkdirSync(join(codex, 'wicked-garden-gamma'), { recursive: true });
    writeFileSync(join(codex, 'wicked-garden-gamma', 'SKILL.md'), readFileSync(join(current.path, 'skills', 'gamma', 'SKILL.md')));
    const result = pass();
    expect(result.adopted[codex]).toContain('wicked-garden-gamma');
    expect(result.written[codex]).toEqual([]);
    expect(result.foreign_modified[codex]).toEqual(['wicked-garden-beta']);
    expect(s.store.manifest().mirror.ledger[codex]?.['wicked-garden-gamma']?.origin).toBe('adopted');
  });

  it("mirrors the skill's WHOLE own tree, not only SKILL.md", async () => {
    const edit = s.store.writeFile('wicked-garden-gamma', 'refs/extra.md', 'portable extra notes\n', s.store.revision());
    expect(edit.verdict).toBe('clear');
    expect(edit.skill?.portable).toBe(true);
    expect((await s.store.publish(edit.revision)).verdict).toBe('clear');
    const result = pass();
    expect(result.written[codex]).toEqual(['wicked-garden-gamma']);
    expect(walkFiles(join(codex, 'wicked-garden-gamma')).map((f) => f.rel)).toEqual(['SKILL.md', 'refs/extra.md']);
    expect(readFileSync(join(codex, 'wicked-garden-gamma', 'refs', 'extra.md'), 'utf8')).toBe('portable extra notes\n');
    expect(s.store.manifest().mirror.ledger[codex]?.['wicked-garden-gamma']?.hash).toBe(treeHash(join(codex, 'wicked-garden-gamma')));
  });

  it('never overwrites an entry whose on-disk tree differs from the ledger (foreign-modified) — a hand edit of what it wrote included', () => {
    pass();
    writeFileSync(join(codex, 'wicked-garden-gamma', 'SKILL.md'), 'edited by hand after the daemon wrote it\n');
    const again = pass();
    expect(again.foreign_modified[codex]).toEqual(['wicked-garden-beta', 'wicked-garden-gamma']);
    expect(again.written[codex]).toEqual([]);
    expect(read(codex, 'wicked-garden-gamma')).toBe('edited by hand after the daemon wrote it\n');
    expect(s.store.manifest().mirror.foreign_modified[codex]).toEqual(['wicked-garden-beta', 'wicked-garden-gamma']);
  });

  it('removes only entries it wrote and left unmodified when a skill leaves the eligible set; adopted/foreign entries stay', async () => {
    pass();
    // beta goes non-portable (a plugin-root ref); gamma stays.
    const edit = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-beta\n---\n\n`${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh` wicked-garden-gamma\n', s.store.revision());
    expect(edit.skill?.portable).toBe(false);
    expect((await s.store.publish(edit.revision)).verdict).toBe('clear');
    const result = pass();
    // codex: beta was ADOPTED — never deleted, never overwritten, even though it is no longer eligible.
    expect(existsSync(join(codex, 'wicked-garden-beta', 'SKILL.md'))).toBe(true);
    expect(read(codex, 'wicked-garden-beta')).toBe(FOREIGN_BETA);
    expect(result.removed[codex]).toEqual([]);
    // pi: beta was WRITTEN by the daemon and is unmodified → removed (the whole dir).
    expect(result.removed[pi]).toEqual(['wicked-garden-beta']);
    expect(existsSync(join(pi, 'wicked-garden-beta'))).toBe(false);
    expect(existsSync(join(pi, 'wicked-garden-gamma', 'SKILL.md'))).toBe(true);
    // The foreign entry is untouched throughout.
    expect(read(codex, 'wicked-garden-other')).toBe(FOREIGN_OTHER);
    expect(s.store.manifest().mirror.ledger[pi]?.['wicked-garden-beta']).toBeUndefined();
  });

  it('answers null before anything is published', () => {
    const fresh = scaffold();
    try {
      fresh.store.seed();
      expect(mirrorSkills(fresh.store, fresh.home)).toBeNull();
      expect(existsSync(join(fresh.home, '.codex'))).toBe(false);
    } finally {
      removeScratch(fresh.base);
    }
  });
});
