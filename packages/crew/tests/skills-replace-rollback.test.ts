// `replace` / `add` are STAGED and ROLL BACK (codex round 5 on #480): the replacement is written in
// full into a staging dir under the root, the skill's own files are parked (renamed, never deleted),
// the staged files are renamed into place — and a failure anywhere in that swap restores the parked
// files exactly and answers a blocking `path-invalid` finding with the revision unchanged. The old
// order (remove, then write) destroyed the notes it could not replace. The preflight
// (`containedDestinations`) catches every collision a lexical + lstat look can see BEFORE the swap
// starts; this suite forces the failure PAST the preflight — a `renameSync` that fails on the
// second placement — to prove the rollback itself, byte for byte and mode for mode.

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
