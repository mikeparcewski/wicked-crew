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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoSymlinkComponents,
  assertSafeRelSegments,
  copyFiles,
  hashFileSet,
  hashTree,
  impliedDirs,
  makeTreeReadOnly,
  removeTreeForce,
  SymlinkComponentError,
  UnsafePathSegmentError,
  walkEntries,
  walkFiles,
  walkTree,
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

describe('walkTree + hashTree — a verification that SEES links (codex round 5)', () => {
  it('lists every symlink with its link text (never followed, never descended), files as walkFiles does; a `.venv` LINK is listed although a `.venv` DIR is pruned', () => {
    const real = join(base, 'real');
    mkdirSync(join(real, 'sub'), { recursive: true });
    mkdirSync(join(real, '.venv', 'bin'), { recursive: true }); // a real .venv dir: pruned
    writeFileSync(join(real, '.venv', 'bin', 'python'), '');
    writeFileSync(join(real, 'a.md'), 'a');
    writeFileSync(join(base, 'elsewhere.md'), 'outside');
    mkdirSync(join(base, 'outside-dir'));
    writeFileSync(join(base, 'outside-dir', 'secret.md'), 'secret');
    symlinkSync(join(base, 'elsewhere.md'), join(real, 'sub', 'link.md'));
    symlinkSync(join(base, 'outside-dir'), join(real, 'dirlink')); // a link to a DIRECTORY is listed, not walked into
    symlinkSync(join(base, 'nowhere'), join(real, 'dangling'));
    const tree = walkTree(real);
    expect(tree.files.map((f) => f.rel)).toEqual(['a.md']);
    expect(tree.links.map((l) => [l.rel, l.target])).toEqual([
      ['dangling', join(base, 'nowhere')],
      ['dirlink', join(base, 'outside-dir')],
      ['sub/link.md', join(base, 'elsewhere.md')],
    ]);
    expect(tree.files.some((f) => f.rel.includes('secret'))).toBe(false); // nothing beyond a link is enumerated
    // A .venv LINK is what a snapshot carries: listed.
    const snap = join(base, 'snap');
    mkdirSync(snap);
    symlinkSync(join('..', 'real', '.venv'), join(snap, '.venv'));
    expect(walkTree(snap).links).toEqual([{ rel: '.venv', abs: join(snap, '.venv'), target: join('..', 'real', '.venv') }]);
    // A symlinked root is refused; a missing root is empty.
    symlinkSync(real, join(base, 'linked-root'));
    expect(() => walkTree(join(base, 'linked-root'))).toThrow(SymlinkComponentError);
    expect(walkTree(join(base, 'missing'))).toEqual({ files: [], links: [], dirs: [], others: [] });
    // Directories are part of the listing too (codex round 9): the real ones, the pruned `.venv` included, sorted.
    expect(tree.dirs).toEqual(['.venv', 'sub']);
    expect(tree.others).toEqual([]);
  });

  it('walkEntries is THE walker (codex round 9): every entry with its kind — an empty directory, a symlink with its text, a special node — nothing invisible; impliedDirs names every ancestor', () => {
    const root = join(base, 'classified');
    mkdirSync(join(root, 'empty'), { recursive: true });
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c.md'), 'c');
    writeFileSync(join(root, 'a', 'd.md'), 'd');
    symlinkSync(join(base, 'nowhere'), join(root, 'a', 'link'));
    const entries = walkEntries(root);
    expect(entries.map((e) => [e.rel, e.kind])).toEqual([
      ['a', 'dir'],
      ['a/b', 'dir'],
      ['a/b/c.md', 'file'],
      ['a/d.md', 'file'],
      ['a/link', 'symlink'],
      ['empty', 'dir'],
    ]);
    expect(entries.find((e) => e.rel === 'a/link')?.target).toBe(join(base, 'nowhere'));
    expect(walkTree(root).dirs).toEqual(['a', 'a/b', 'empty']);
    expect(impliedDirs(['a/b/c.md', 'a/d.md', 'top.md'])).toEqual(['a', 'a/b']);
    // The hash covers directory entries: an empty directory changes it (codex round 9).
    const files = walkFiles(root);
    expect(hashTree(files, [], ['a', 'a/b'])).not.toBe(hashTree(files, [], ['a', 'a/b', 'empty']));
    expect(hashTree(files, [], [])).toBe(hashFileSet(files)); // a bundle's identity is unchanged
  });

  it.skipIf(process.platform === 'win32')('a special node (a fifo) is classified as `other`, never as a file the store carries', () => {
    const root = join(base, 'special');
    mkdirSync(root);
    execFileSync('mkfifo', [join(root, 'pipe')]);
    writeFileSync(join(root, 'ok.md'), 'ok');
    const entries = walkEntries(root);
    expect(entries.map((e) => [e.rel, e.kind])).toEqual([
      ['ok.md', 'file'],
      ['pipe', 'other'],
    ]);
    expect(walkFiles(root).map((f) => f.rel)).toEqual(['ok.md']);
    expect(walkTree(root).others.map((e) => e.rel)).toEqual(['pipe']);
  });

  it('hashTree equals hashFileSet with no links, and changes when a link is added, removed or re-pointed — by link TEXT, never by what it reaches', () => {
    const real = join(base, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'a.md'), 'a');
    const files = walkFiles(real);
    expect(hashTree(files, [])).toBe(hashFileSet(files));
    const withLink = hashTree(files, [{ rel: '.venv', target: '../../baseline/x/.venv' }]);
    expect(withLink).not.toBe(hashFileSet(files));
    expect(hashTree(files, [{ rel: '.venv', target: '../../baseline/y/.venv' }])).not.toBe(withLink);
    expect(hashTree(files, [{ rel: 'other', target: '../../baseline/x/.venv' }])).not.toBe(withLink);
    // Order-independent, target-existence-independent: the same text hashes the same wherever it points.
    expect(
      hashTree(files, [
        { rel: 'b', target: '/nowhere' },
        { rel: 'a', target: '/elsewhere' },
      ]),
    ).toBe(
      hashTree(files, [
        { rel: 'a', target: '/elsewhere' },
        { rel: 'b', target: '/nowhere' },
      ]),
    );
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
