// tree.ts — the no-follow primitives every store path runs through (codex review of #480): a
// walk refuses a symlinked root and skips link entries; a copy refuses a link at any destination
// component; an atomic write refuses a link target, opens its temp file exclusively under an
// unpredictable name, and preserves the target's mode bits; the read-only lock and its force-remove.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoSymlinkComponents,
  assertSafeRelSegments,
  copyFiles,
  makeTreeReadOnly,
  removeTreeForce,
  SymlinkComponentError,
  UnsafePathSegmentError,
  walkFiles,
  writeFileAtomic,
} from '../src/skills/tree.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'skills-tree-'));
});

afterEach(() => {
  removeTreeForce(base);
});

describe('walkFiles', () => {
  it('refuses a symlinked root, skips symlink entries, answers [] for a missing root', () => {
    const real = join(base, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'a.md'), 'a');
    writeFileSync(join(base, 'elsewhere.md'), 'outside');
    symlinkSync(join(base, 'elsewhere.md'), join(real, 'link.md'));
    expect(walkFiles(real).map((f) => f.rel)).toEqual(['a.md']);
    symlinkSync(real, join(base, 'linked-root'));
    expect(() => walkFiles(join(base, 'linked-root'))).toThrow(SymlinkComponentError);
    expect(walkFiles(join(base, 'missing'))).toEqual([]);
  });
});

describe('assertNoSymlinkComponents + copyFiles', () => {
  it('refuses a symlink at any destination component (nothing lands outside) and carries mode bits', () => {
    const src = join(base, 'src');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'scripts', 'run.sh'), '#!/bin/sh\n');
    chmodSync(join(src, 'scripts', 'run.sh'), 0o755);
    const dest = join(base, 'dest');
    mkdirSync(dest);
    copyFiles(walkFiles(src), dest);
    expect(lstatSync(join(dest, 'scripts', 'run.sh')).mode & 0o777).toBe(0o755);

    const outside = join(base, 'outside');
    mkdirSync(outside);
    const trap = join(base, 'trap');
    mkdirSync(trap);
    symlinkSync(outside, join(trap, 'scripts'));
    expect(() => copyFiles(walkFiles(src), trap)).toThrow(SymlinkComponentError);
    expect(readdirSync(outside)).toEqual([]);
    expect(() => assertNoSymlinkComponents(trap, ['scripts', 'run.sh'])).toThrow(/crosses a symlink at scripts/);
    // A not-yet-existing tail ends the walk: the write creates it.
    expect(assertNoSymlinkComponents(trap, ['fresh', 'file.md'])).toBe(join(trap, 'fresh', 'file.md'));
  });

  it('copyFiles PREFLIGHTS every destination: an unsafe record (`..`, absolute, empty, separator or drive prefix in a segment) is refused and NOTHING is written — not the safe records ahead of it (codex round 4)', () => {
    const src = join(base, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'a.md'), 'a');
    writeFileSync(join(src, 'b.md'), 'b');
    const dest = join(base, 'dest');
    mkdirSync(dest);
    for (const bad of ['../escape.md', '/abs.md', '', 'x/../y.md', 'x/./y.md', 'seg\\win.md', 'C:evil.md', 'a//b.md']) {
      expect(() => copyFiles([{ rel: 'ok/a.md', abs: join(src, 'a.md') }, { rel: bad, abs: join(src, 'b.md') }], dest), bad).toThrow(UnsafePathSegmentError);
      expect(readdirSync(dest), bad).toEqual([]); // the safe record AHEAD of the refusal did not land either
    }
    expect(existsSync(join(base, 'escape.md'))).toBe(false);
    // The walk itself refuses an unsafe segment lexically, before any lstat — whatever the caller checked.
    expect(() => assertNoSymlinkComponents(dest, ['..', 'x'])).toThrow(UnsafePathSegmentError);
    expect(() => assertNoSymlinkComponents(dest, ['views', 'a/b'])).toThrow(UnsafePathSegmentError);
    expect(() => assertSafeRelSegments('views/copilot/.github/skills/../../../../outside/SKILL.md')).toThrow(/".."/);
    expect(assertSafeRelSegments('views/copilot/.github/skills/wicked-garden-gamma/SKILL.md')).toHaveLength(6);
    // A safe set lands whole.
    copyFiles([{ rel: 'ok/a.md', abs: join(src, 'a.md') }, { rel: 'ok/b.md', abs: join(src, 'b.md') }], dest);
    expect(walkFiles(dest).map((f) => f.rel)).toEqual(['ok/a.md', 'ok/b.md']);
  });
});

describe('writeFileAtomic', () => {
  it("preserves an existing file's mode, refuses a symlink target, honours a new-file mode, leaves no temp file", () => {
    const file = join(base, 'exec.sh');
    writeFileSync(file, 'old');
    chmodSync(file, 0o755);
    writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(lstatSync(file).mode & 0o777).toBe(0o755);

    const victim = join(base, 'victim.md');
    writeFileSync(victim, 'victim');
    const link = join(base, 'link.md');
    symlinkSync(victim, link);
    expect(() => writeFileAtomic(link, 'pwned')).toThrow(SymlinkComponentError);
    expect(readFileSync(victim, 'utf8')).toBe('victim');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(base).filter((e) => e.includes('.tmp-'))).toEqual([]);

    writeFileAtomic(join(base, 'deep', 'new.md'), 'x', { mode: 0o600 });
    expect(lstatSync(join(base, 'deep', 'new.md')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(base, 'deep'))).toEqual(['new.md']);
  });
});

describe('makeTreeReadOnly / removeTreeForce', () => {
  it('strips the write bits from every dir and file; the force-remove still takes the tree down', () => {
    const venv = join(base, '.venv');
    mkdirSync(join(venv, 'lib'), { recursive: true });
    writeFileSync(join(venv, 'lib', 'x.py'), 'x');
    makeTreeReadOnly(venv);
    expect(lstatSync(venv).mode & 0o222).toBe(0);
    expect(lstatSync(join(venv, 'lib')).mode & 0o222).toBe(0);
    expect(lstatSync(join(venv, 'lib', 'x.py')).mode & 0o222).toBe(0);
    // root ignores permission bits; everyone else is refused a write into the locked tree.
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      expect(() => writeFileSync(join(venv, 'lib', 'y.py'), 'y')).toThrow();
    }
    removeTreeForce(venv);
    expect(existsSync(venv)).toBe(false);
  });

  it('surfaces a permission failure instead of claiming the tree is locked (codex round 2)', () => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return; // modes are advisory there
    const venv = join(base, 'venv');
    const sealed = join(venv, 'lib', 'sealed');
    mkdirSync(sealed, { recursive: true });
    writeFileSync(join(sealed, 'x.py'), 'x');
    chmodSync(sealed, 0o000); // cannot be listed → the lock cannot reach its files
    try {
      expect(() => makeTreeReadOnly(venv)).toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(sealed, 0o700);
    }
    // A vanished entry is the one tolerated case: locking a tree that is gone is a no-op, not an error.
    expect(() => makeTreeReadOnly(join(base, 'never-existed'))).not.toThrow();
  });
});
