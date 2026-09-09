// `replace` / `add` are STAGED and ROLL BACK (codex round 5 on #480): the replacement is written in
// full into a staging dir under the root, the skill's own files are parked (renamed, never deleted),
// the staged files are renamed into place — and a failure anywhere in that swap restores the parked
// files exactly and answers a blocking `path-invalid` finding with the revision unchanged. The old
// order (remove, then write) destroyed the notes it could not replace. The preflight
// (`containedDestinations`) catches every collision a lexical + lstat look can see BEFORE the swap
// starts; this suite forces the failure PAST the preflight — a `renameSync` that fails on the
// second placement — to prove the rollback itself, byte for byte and mode for mode. `reset` and
// `refresh-baseline` go through the SAME transaction (`swapStaged`, codex round 6): the suite forces
// the same mid-swap failure on each and proves the original content intact and the revision unchanged.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

/** The placement to fail: set by the test, matched against the rename SOURCE (a staged file) and DESTINATION (hoisted with the mock). */
const fault = vi.hoisted(() => ({ failPlacement: null as ((from: string, to: string) => boolean) | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (fault.failPlacement !== null && fault.failPlacement(from, to)) {
        const err = new Error(`ENOTDIR: not a directory, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
        err.code = 'ENOTDIR';
        throw err;
      }
      actual.renameSync(from, to);
    },
  };
});

let s: Scaffold;

beforeEach(() => {
  s = scaffold();
  s.store.seed();
});

afterEach(() => {
  fault.failPlacement = null;
  removeScratch(s.base);
});

const digest = (dir: string): string =>
  JSON.stringify(
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const abs = join(e.parentPath, e.name);
        return [abs.slice(dir.length + 1), lstatSync(abs).mode & 0o777, readFileSync(abs, 'utf8')];
      })
      .sort(),
  );

describe('replace rolls back a swap that fails past the preflight', () => {
  it('a placement that fails mid-swap restores every own file byte-for-byte (modes included), leaves no staging, keeps the revision, and answers blocked path-invalid', () => {
    const alpha = join(s.root, 'effective', 'skills', 'alpha');
    const before = digest(alpha);
    expect(JSON.parse(before).map((r: [string]) => r[0])).toEqual(['SKILL.md', 'nested/SKILL.md', 'refs/notes.md']);
    // Fail the SECOND placement (`refs/notes.md`) — after SKILL.md was already placed and the old
    // files were already parked: the worst moment. Only the PLACEMENT (a staged `new/` source)
    // fails; the rollback's restore renames (from `old/`) must succeed.
    const notesDest = join(alpha, 'refs', 'notes.md');
    fault.failPlacement = (from, to) => from.includes(`${sep}new${sep}`) && (to === notesDest || to === join(realpathSync(s.root), 'effective', 'skills', 'alpha', 'refs', 'notes.md'));
    const result = s.store.replace(
      'wicked-garden-alpha',
      { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n\nreplaced\n', 'refs/notes.md': 'replaced notes\n' },
      1,
    );
    expect(result).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', skill: 'wicked-garden-alpha' });
    expect(result.findings[0]?.evidence).toContain('ENOTDIR');
    expect(result.findings[0]?.explanation).toContain('rolled back');
    // Byte for byte, mode for mode: the skill is exactly what it was.
    expect(digest(alpha)).toBe(before);
    expect(readFileSync(join(alpha, 'SKILL.md'), 'utf8')).not.toContain('replaced');
    // Nothing of the swap lingers under the root, and the manifest never moved.
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    expect(s.store.revision()).toBe(1);
    expect(s.store.manifest().skills['wicked-garden-alpha']).toMatchObject({ provenance: 'shipped', editedAt: null });
    // With the fault gone, the same replace lands.
    fault.failPlacement = null;
    const ok = s.store.replace('wicked-garden-alpha', { 'SKILL.md': '---\nname: wicked-garden-alpha\n---\n\nreplaced\n', 'refs/notes.md': 'replaced notes\n' }, 1);
    expect(ok.verdict).toBe('clear');
    expect(readFileSync(join(alpha, 'refs', 'notes.md'), 'utf8')).toBe('replaced notes\n');
    expect(readFileSync(join(alpha, 'nested', 'SKILL.md'), 'utf8')).toBe(readFileSync(join(s.upstream, 'skills', 'alpha', 'nested', 'SKILL.md'), 'utf8')); // the nested child is never touched
  });

  it('an add whose placement fails leaves no skill directory and no manifest entry', () => {
    fault.failPlacement = (from, to) => from.includes(`${sep}new${sep}`) && to.endsWith(join('skills', 'zeta', 'refs', 'a.md'));
    const result = s.store.add('wicked-garden-zeta', { 'SKILL.md': '---\nname: wicked-garden-zeta\n---\n\nnew\n', 'refs/a.md': 'a\n' }, 1);
    expect(result).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(result.findings[0]?.kind).toBe('path-invalid');
    expect(readdirSync(join(s.root, 'effective', 'skills'))).not.toContain('zeta');
    expect(s.store.manifest().skills['wicked-garden-zeta']).toBeUndefined();
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    expect(s.store.revision()).toBe(1);
  });
});

describe('reset and refresh-baseline share the park-and-rollback transaction (codex round 6)', () => {
  it('a RESET whose placement fails mid-swap restores the EDITED skill byte-for-byte (modes included), keeps the revision, leaves no staging, answers blocked path-invalid', () => {
    const alpha = join(s.root, 'effective', 'skills', 'alpha');
    // Edit alpha so the reset has two files to restore, then fail the SECOND placement — after
    // SKILL.md was placed and every own file was parked: the worst moment.
    const e1 = s.store.writeFile('wicked-garden-alpha', 'SKILL.md', '---\nname: wicked-garden-alpha\n---\n\nedited\n', 1);
    const e2 = s.store.writeFile('wicked-garden-alpha', 'refs/notes.md', 'edited notes\n', e1.revision);
    expect(e2.verdict).toBe('clear');
    const before = digest(alpha);
    const notesDest = join(alpha, 'refs', 'notes.md');
    fault.failPlacement = (from, to) => from.includes(`${sep}new${sep}`) && (to === notesDest || to === join(realpathSync(s.root), 'effective', 'skills', 'alpha', 'refs', 'notes.md'));
    const result = s.store.reset('wicked-garden-alpha', e2.revision);
    expect(result).toMatchObject({ verdict: 'blocked', revision: e2.revision });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', skill: 'wicked-garden-alpha', file: 'skills/alpha' });
    expect(result.findings[0]?.evidence).toContain('ENOTDIR');
    expect(result.findings[0]?.explanation).toContain('rolled back');
    // The EDITED content is intact — nothing was restored halfway (the old reset had already removed it).
    expect(digest(alpha)).toBe(before);
    expect(readFileSync(join(alpha, 'SKILL.md'), 'utf8')).toContain('edited');
    expect(readFileSync(notesDest, 'utf8')).toBe('edited notes\n');
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    expect(s.store.revision()).toBe(e2.revision);
    expect(s.store.manifest().skills['wicked-garden-alpha']?.provenance).toBe('override');
    // With the fault gone, the same reset lands whole.
    fault.failPlacement = null;
    const ok = s.store.reset('wicked-garden-alpha', e2.revision);
    expect(ok.verdict).toBe('clear');
    expect(readFileSync(join(alpha, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(s.upstream, 'skills', 'alpha', 'SKILL.md'), 'utf8'));
    expect(readFileSync(notesDest, 'utf8')).toBe(readFileSync(join(s.upstream, 'skills', 'alpha', 'refs', 'notes.md'), 'utf8'));
  });

  it('a REFRESH whose placement fails mid-swap restores every effective file — a removal AND an overwritten take — commits nothing, and reaps the unreferenced new baseline', () => {
    const effective = join(s.root, 'effective');
    const before = digest(effective);
    const manifestBefore = JSON.stringify(s.store.manifest());
    const baselinesBefore = s.store.baselinesOnDisk();
    // Upstream: overwrite beta's SKILL.md (a take over an EXISTING file), delete delta's SKILL.md (a
    // removal), add gamma/refs/new.md (the placement that fails — it sorts after beta's take, so
    // beta's new bytes are already in place and delta is already parked when it fails).
    writeFileSync(join(s.upstream, 'skills', 'beta', 'SKILL.md'), '---\nname: wicked-garden-beta\n---\n\nupstream v2 — mentions wicked-garden-gamma\n');
    rmSync(join(s.upstream, 'skills', 'delta', 'SKILL.md'));
    mkdirSync(join(s.upstream, 'skills', 'gamma', 'refs'), { recursive: true });
    writeFileSync(join(s.upstream, 'skills', 'gamma', 'refs', 'new.md'), 'new upstream file\n');
    const newDest = join(effective, 'skills', 'gamma', 'refs', 'new.md');
    fault.failPlacement = (from, to) => from.includes(`${sep}new${sep}`) && (to === newDest || to === join(realpathSync(s.root), 'effective', 'skills', 'gamma', 'refs', 'new.md'));
    const r = s.store.refreshBaseline(1);
    expect(r).toMatchObject({ verdict: 'blocked', revision: 1, taken: [], kept: [], added: [], removed: [], conflicts: [] });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking' });
    expect(r.findings[0]?.evidence).toContain('ENOTDIR');
    expect(r.findings[0]?.explanation).toContain('rolled back');
    // Byte for byte: beta's OLD SKILL.md is back, delta's SKILL.md is back, gamma/refs never appeared.
    expect(digest(effective)).toBe(before);
    expect(existsSync(join(effective, 'skills', 'delta', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(effective, 'skills', 'beta', 'SKILL.md'), 'utf8')).not.toContain('upstream v2');
    expect(existsSync(join(effective, 'skills', 'gamma', 'refs'))).toBe(false);
    // Nothing committed, the new capture reaped, no staging.
    expect(JSON.stringify(s.store.manifest())).toBe(manifestBefore);
    expect(s.store.revision()).toBe(1);
    expect(s.store.baselinesOnDisk()).toEqual(baselinesBefore);
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    // With the fault gone, the same refresh lands whole.
    fault.failPlacement = null;
    const ok = s.store.refreshBaseline(1);
    expect(ok.verdict).toBe('clear');
    expect(ok.revision).toBe(2);
    expect(readFileSync(join(effective, 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('upstream v2');
    expect(existsSync(join(effective, 'skills', 'delta', 'SKILL.md'))).toBe(false);
    expect(readFileSync(newDest, 'utf8')).toBe('new upstream file\n');
    expect(ok.removed).toEqual(['wicked-garden-delta']);
  });
});
