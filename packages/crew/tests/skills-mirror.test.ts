// The non-Claude CLI mirror (design v3 §2/§8): portable + enabled skills of the PUBLISHED snapshot
// as `<name>/SKILL.md` into a temp HOME's `.codex/skills` (always) and the other CLIs' dirs (when
// present); the adoption ledger adopts pre-existing garden entries, never overwrites an entry whose
// hash differs from the ledger, and never deletes an entry the daemon did not write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mirrorSkills, mirrorTargets } from '../src/skills/mirror.js';
import { sha256Hex } from '../src/skills/tree.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

let s: Scaffold;
let codex: string;
let pi: string;

const FOREIGN_BETA = '---\nname: wicked-garden-beta\n---\n\nthe operator\'s hand copy\n';
const FOREIGN_OTHER = '---\nname: wicked-garden-other\n---\n\nnot in the catalog\n';

beforeEach(() => {
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
  expect(s.store.publish(1).verdict).toBe('clear');
});

afterEach(async () => {
  await s.store.pendingVenv;
  removeScratch(s.base);
});

const read = (dir: string, name: string): string => readFileSync(join(dir, name, 'SKILL.md'), 'utf8');

describe('mirrorSkills', () => {
  it('targets codex always and the other CLIs only where their dir exists', () => {
    expect(mirrorTargets(s.home)).toEqual([codex, pi]);
    expect(existsSync(join(s.home, '.copilot'))).toBe(false);
  });

  it('writes portable enabled skills only, adopts pre-existing garden entries, leaves foreign entries alone', () => {
    const r = mirrorSkills(s.store, s.home);
    expect(r).not.toBeNull();
    const result = r as NonNullable<typeof r>;
    // beta (adopted → synced) + gamma (written); alpha/nested/delta/epsilon are non-portable.
    expect(result.adopted[codex]).toEqual(['wicked-garden-beta', 'wicked-garden-other']);
    expect(result.written[codex]).toEqual(['wicked-garden-beta', 'wicked-garden-gamma']);
    expect(result.written[pi]).toEqual(['wicked-garden-beta', 'wicked-garden-gamma']);
    expect(result.skipped_non_portable).toEqual([
      'wicked-garden-alpha',
      'wicked-garden-alpha-nested',
      'wicked-garden-delta',
      'wicked-garden-epsilon',
    ]);
    expect(read(codex, 'wicked-garden-beta')).toContain('Use the **wicked-garden-gamma** skill');
    expect(read(codex, 'wicked-garden-other')).toBe(FOREIGN_OTHER);
    expect(existsSync(join(codex, 'wicked-garden-alpha'))).toBe(false);
    expect(existsSync(join(s.home, '.copilot', 'skills'))).toBe(false);
    // The ledger records what was written and what was adopted, with hashes.
    const ledger = s.store.manifest().mirror.ledger[codex] ?? {};
    expect(ledger['wicked-garden-beta']).toEqual({ hash: sha256Hex(read(codex, 'wicked-garden-beta')), origin: 'adopted' });
    expect(ledger['wicked-garden-gamma']?.origin).toBe('written');
    expect(ledger['wicked-garden-other']).toEqual({ hash: sha256Hex(FOREIGN_OTHER), origin: 'adopted' });
    expect(s.store.manifest().mirror.last_run).toBe('2026-09-08T12:00:00.000Z');
  });

  it('never overwrites an entry whose on-disk hash differs from the ledger (foreign-modified), and reports it', () => {
    mirrorSkills(s.store, s.home);
    writeFileSync(join(codex, 'wicked-garden-gamma', 'SKILL.md'), 'edited by hand after the daemon wrote it\n');
    const again = mirrorSkills(s.store, s.home) as NonNullable<ReturnType<typeof mirrorSkills>>;
    expect(again.foreign_modified[codex]).toEqual(['wicked-garden-gamma']);
    expect(again.written[codex]).toEqual([]);
    expect(read(codex, 'wicked-garden-gamma')).toBe('edited by hand after the daemon wrote it\n');
    expect(s.store.manifest().mirror.foreign_modified[codex]).toEqual(['wicked-garden-gamma']);
  });

  it('removes only entries it wrote and left unmodified when a skill leaves the eligible set; adopted/foreign entries stay', () => {
    mirrorSkills(s.store, s.home);
    // beta goes non-portable (a plugin-root ref) and gamma stays; also hand-edit the pi copy of gamma.
    const rev = s.store.revision();
    const edit = s.store.writeFile('wicked-garden-beta', 'SKILL.md', '---\nname: wicked-garden-beta\n---\n\n`${CLAUDE_PLUGIN_ROOT}/scripts/_python.sh` wicked-garden-gamma\n', rev);
    expect(edit.skill?.portable).toBe(false);
    const pub = s.store.publish(edit.revision);
    expect(pub.verdict).toBe('clear');
    // Disable nothing else: make gamma ineligible on the CODEX side by hand-editing it there —
    // and on the pi side leave the daemon's copy pristine so a later ineligibility removes it.
    const r = mirrorSkills(s.store, s.home) as NonNullable<ReturnType<typeof mirrorSkills>>;
    // beta was ADOPTED: it is never deleted even though it is no longer eligible.
    expect(existsSync(join(codex, 'wicked-garden-beta', 'SKILL.md'))).toBe(true);
    expect(r.removed[codex]).toEqual([]);
    // On pi, beta was WRITTEN by the daemon and is unmodified → removed.
    expect(r.removed[pi]).toEqual(['wicked-garden-beta']);
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
