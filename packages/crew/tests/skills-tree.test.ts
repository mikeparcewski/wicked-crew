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
  copyFileNoFollow,
  copyFiles,
  hashFileSet,
  hashFileSetAsync,
  hashTree,
  impliedDirs,
  makeTreeReadOnly,
  mkdirExact,
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

it('async file-set hashing matches the sync identity across ordered batches (crew#1021)', async () => {
  for (let i = 0; i < 35; i++) {
    const dir = join(base, `dir-${i % 3}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${i}.bin`), Buffer.from([i, 0, 255, i % 2]));
  }
  const files = walkFiles(base).reverse();
  expect(await hashFileSetAsync(files)).toBe(hashFileSet(files));
  expect(await hashFileSetAsync([])).toBe(hashFileSet([]));
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
  it('lists every symlink with its link text (never followed, never descended), files as walkFiles does; a `.venv` LINK is listed although a `.venv` DIR is pruned — and what the pruned dir holds is classified under `pruned`, carried by no view (review pass 10)', () => {
    const real = join(base, 'real');
    mkdirSync(join(real, 'sub'), { recursive: true });
    mkdirSync(join(real, '.venv', 'bin'), { recursive: true }); // a real .venv dir: pruned — walked for classification, part of no file/link/dir view
    writeFileSync(join(real, '.venv', 'bin', 'python3.12'), '');
    symlinkSync('python3.12', join(real, '.venv', 'bin', 'python')); // an interpreter link INSIDE the pruned env
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
    expect(walkTree(join(base, 'missing'))).toEqual({ files: [], links: [], dirs: [], others: [], pruned: [] });
    // Directories are part of the listing too (codex round 9): the real ones, the pruned `.venv` itself included, sorted —
    // nothing BENEATH it (review pass 10: `.venv/bin` is not a carried directory).
    expect(tree.dirs).toEqual(['.venv', 'sub']);
    expect(tree.others).toEqual([]);
    // The pruned subtree is WALKED and classified (review pass 10): every entry beneath `.venv` with its kind,
    // marked with the pruned directory — the interpreter link is seen here and NOWHERE in files/links/dirs.
    expect(tree.pruned.map((e) => [e.rel, e.kind, e.pruned])).toEqual([
      ['.venv/bin', 'dir', '.venv'],
      ['.venv/bin/python', 'symlink', '.venv'],
      ['.venv/bin/python3.12', 'file', '.venv'],
    ]);
    expect(tree.pruned.find((e) => e.rel === '.venv/bin/python')?.target).toBe('python3.12');
    expect(walkEntries(real).find((e) => e.rel === '.venv')).toMatchObject({ kind: 'dir', pruned: null }); // the pruned-name dir itself is a carried entry
  });

  it('walkEntries is THE walker (codex round 9): every entry with its kind — an empty directory, a symlink with its text, a special node — nothing invisible; a pruned directory is DESCENDED for classification and its entries marked (review pass 10); impliedDirs names every ancestor', () => {
    const root = join(base, 'classified');
    mkdirSync(join(root, 'empty'), { recursive: true });
    mkdirSync(join(root, 'a', 'b'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c.md'), 'c');
    writeFileSync(join(root, 'a', 'd.md'), 'd');
    symlinkSync(join(base, 'nowhere'), join(root, 'a', 'link'));
    // A pruned directory with a link, a file and a NESTED pruned name inside: everything beneath is
    // reported, marked with the OUTERMOST pruned directory.
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '__pycache__'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep.js'), 'dep');
    symlinkSync(join('..', 'dep.js'), join(root, 'node_modules', '.bin', 'dep'));
    const entries = walkEntries(root);
    expect(entries.map((e) => [e.rel, e.kind, e.pruned])).toEqual([
      ['a', 'dir', null],
      ['a/b', 'dir', null],
      ['a/b/c.md', 'file', null],
      ['a/d.md', 'file', null],
      ['a/link', 'symlink', null],
      ['empty', 'dir', null],
      ['node_modules', 'dir', null],
      ['node_modules/.bin', 'dir', 'node_modules'],
      ['node_modules/.bin/dep', 'symlink', 'node_modules'],
      ['node_modules/__pycache__', 'dir', 'node_modules'],
      ['node_modules/dep.js', 'file', 'node_modules'],
    ]);
    expect(entries.find((e) => e.rel === 'a/link')?.target).toBe(join(base, 'nowhere'));
    expect(entries.find((e) => e.rel === 'node_modules/.bin/dep')?.target).toBe(join('..', 'dep.js'));
    // The carried views exclude the pruned subtree exactly as before: the pruned-name dir is a directory
    // entry, nothing beneath it is a file, a link or a directory of the tree.
    const tree = walkTree(root);
    expect(tree.dirs).toEqual(['a', 'a/b', 'empty', 'node_modules']);
    expect(tree.links.map((l) => l.rel)).toEqual(['a/link']);
    expect(tree.files.map((f) => f.rel)).toEqual(['a/b/c.md', 'a/d.md']);
    expect(walkFiles(root).map((f) => f.rel)).toEqual(['a/b/c.md', 'a/d.md']);
    expect(tree.pruned.map((e) => e.rel)).toEqual(['node_modules/.bin', 'node_modules/.bin/dep', 'node_modules/__pycache__', 'node_modules/dep.js']);
    expect(impliedDirs(['a/b/c.md', 'a/d.md', 'top.md'])).toEqual(['a', 'a/b']);
    // The hash covers directory entries: an empty directory changes it (codex round 9).
    const files = walkFiles(root);
    expect(hashTree(files, [], ['a', 'a/b'])).not.toBe(hashTree(files, [], ['a', 'a/b', 'empty']));
    expect(hashTree(files, [], [])).toBe(hashFileSet(files)); // a bundle's identity is unchanged
    // …and nothing beneath a pruned directory enters it: another file there leaves the walked hash as it was.
    const before = hashTree(tree.files, tree.links, tree.dirs);
    writeFileSync(join(root, 'node_modules', 'extra.js'), 'extra');
    const after = walkTree(root);
    expect(hashTree(after.files, after.links, after.dirs)).toBe(before);
    expect(after.pruned.map((e) => e.rel)).toContain('node_modules/extra.js');
  });

  it.skipIf(process.platform === 'win32')('a special node (a fifo) is classified as `other`, never as a file the store carries — inside a pruned directory too, where it is reported under `pruned` (review pass 10)', () => {
    const root = join(base, 'special');
    mkdirSync(join(root, '__pycache__'), { recursive: true });
    execFileSync('mkfifo', [join(root, 'pipe')]);
    execFileSync('mkfifo', [join(root, '__pycache__', 'pipe2')]);
    writeFileSync(join(root, 'ok.md'), 'ok');
    const entries = walkEntries(root);
    expect(entries.map((e) => [e.rel, e.kind, e.pruned])).toEqual([
      ['__pycache__', 'dir', null],
      ['__pycache__/pipe2', 'other', '__pycache__'],
      ['ok.md', 'file', null],
      ['pipe', 'other', null],
    ]);
    expect(walkFiles(root).map((f) => f.rel)).toEqual(['ok.md']);
    const tree = walkTree(root);
    expect(tree.others.map((e) => e.rel)).toEqual(['pipe']);
    expect(tree.pruned.map((e) => [e.rel, e.kind])).toEqual([['__pycache__/pipe2', 'other']]);
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

// crew#1955: a skills file's mode is the one asked for (or preserved), not narrowed by the daemon's umask. Under umask
// 077 an executable script used to land 0700 and the rest 0600, and a put-back of a 0755 file came back 0700.
describe('skills file modes are exact under a strict umask (crew#1955)', () => {
  const strict = (fn: () => void): void => {
    const was = process.umask(0o077);
    try {
      fn();
    } finally {
      process.umask(was);
    }
  };
  const modeOf = (p: string): number => lstatSync(p).mode & 0o7777;

  it('a new file lands with the mode asked for: 0755 and 0644', () => {
    if (process.platform === 'win32') return; // modes are advisory there
    strict(() => {
      writeFileAtomic(join(base, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileAtomic(join(base, 'SKILL.md'), '# skill\n', { mode: 0o644 });
    });
    expect(modeOf(join(base, 'run.sh'))).toBe(0o755);
    expect(modeOf(join(base, 'SKILL.md'))).toBe(0o644);
  });

  it("a rewrite (the put-back after a failed pass) keeps the file's earlier 0755", () => {
    if (process.platform === 'win32') return;
    const file = join(base, 'exec.sh');
    writeFileSync(file, 'old');
    chmodSync(file, 0o755);
    strict(() => writeFileAtomic(file, 'new'));
    expect(readFileSync(file, 'utf8')).toBe('new');
    expect(modeOf(file)).toBe(0o755);
  });

  it("a copied baseline script keeps its source's 0755, a document its 0644", () => {
    if (process.platform === 'win32') return;
    const src = join(base, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'tool.sh'), 'x');
    chmodSync(join(src, 'tool.sh'), 0o755);
    writeFileSync(join(src, 'doc.md'), 'y');
    chmodSync(join(src, 'doc.md'), 0o644);
    const dest = join(base, 'dest');
    mkdirSync(dest);
    strict(() => {
      copyFileNoFollow(join(src, 'tool.sh'), join(dest, 'tool.sh'));
      copyFileNoFollow(join(src, 'doc.md'), join(dest, 'doc.md'));
    });
    expect(modeOf(join(dest, 'tool.sh'))).toBe(0o755);
    expect(modeOf(join(dest, 'doc.md'))).toBe(0o644);
  });

  it('never more than 0755: no group or other write, no setuid, setgid or sticky bit (under umask 077 and 000)', () => {
    if (process.platform === 'win32') return;
    for (const umask of [0o077, 0o000]) {
      const dir = join(base, `u${umask.toString(8)}`);
      mkdirSync(dir);
      const src = join(dir, 'wide-src.sh');
      writeFileSync(src, 'x');
      chmodSync(src, 0o777);
      const existing = join(dir, 'group-write.sh');
      writeFileSync(existing, 'old');
      chmodSync(existing, 0o775);
      const was = process.umask(umask);
      try {
        writeFileAtomic(join(dir, 'wide.sh'), 'x', { mode: 0o777 });
        writeFileAtomic(join(dir, 'suid.sh'), 'x', { mode: 0o4755 });
        writeFileAtomic(join(dir, 'sgid.sh'), 'x', { mode: 0o2755 });
        writeFileAtomic(join(dir, 'sticky.sh'), 'x', { mode: 0o1755 });
        writeFileAtomic(existing, 'new'); // an existing file's mode is masked too
        copyFileNoFollow(src, join(dir, 'wide-copy.sh'));
      } finally {
        process.umask(was);
      }
      for (const f of ['wide.sh', 'suid.sh', 'sgid.sh', 'sticky.sh', 'group-write.sh', 'wide-copy.sh']) {
        expect([umask, f, modeOf(join(dir, f))]).toEqual([umask, f, 0o755]);
      }
    }
  });

  it('the directories created for skill content are 0755; an existing one is left alone; no mode, no change', () => {
    if (process.platform === 'win32') return;
    const src = join(base, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'c.md'), 'c');
    chmodSync(join(src, 'c.md'), 0o644);
    const kept = join(base, 'kept');
    mkdirSync(kept);
    chmodSync(kept, 0o700);
    strict(() => {
      copyFiles([{ rel: 'a/b/c.md', abs: join(src, 'c.md') }], join(base, 'gen'));
      writeFileAtomic(join(kept, 'x', 'y', 'f.md'), 'f', { mode: 0o644 });
      writeFileAtomic(join(base, 'private', 'state.json'), '{}'); // the store's own file: no mode asked
    });
    for (const d of ['gen', 'gen/a', 'gen/a/b', 'kept/x', 'kept/x/y']) expect([d, modeOf(join(base, d))]).toEqual([d, 0o755]);
    expect(modeOf(join(base, 'gen', 'a', 'b', 'c.md'))).toBe(0o644);
    expect(modeOf(kept)).toBe(0o700);
    expect(modeOf(join(base, 'private'))).toBe(0o700);
    expect(modeOf(join(base, 'private', 'state.json'))).toBe(0o600);
  });

  it('mkdirExact sets no mode under a parent another user can write (a swapped directory could redirect the chmod)', () => {
    if (process.platform === 'win32') return;
    const shared = join(base, 'shared');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const sticky = join(base, 'sticky');
    mkdirSync(sticky);
    chmodSync(sticky, 0o1777);
    strict(() => {
      mkdirExact(join(shared, 'a', 'b'));
      mkdirExact(join(sticky, 'c'));
    });
    for (const d of ['shared/a', 'shared/a/b', 'sticky/c']) expect([d, modeOf(join(base, d))]).toEqual([d, 0o700]);
    expect(modeOf(shared)).toBe(0o777);
    // Under an owner-only parent the same call sets 0755.
    strict(() => mkdirExact(join(base, 'own', 'd')));
    expect(modeOf(join(base, 'own'))).toBe(0o755);
    expect(modeOf(join(base, 'own', 'd'))).toBe(0o755);
  });

  it('mkdirExact sets the mode only of what it created; a link it passes through keeps its target as it was', () => {
    if (process.platform === 'win32') return;
    const outside = join(base, 'outside');
    mkdirSync(outside);
    chmodSync(outside, 0o700);
    symlinkSync(outside, join(base, 'link'));
    strict(() => mkdirExact(join(base, 'link', 'sub'))); // the link existed: mkdir -p goes through it
    expect(modeOf(outside)).toBe(0o700);
    expect(modeOf(join(outside, 'sub'))).toBe(0o700); // the created dir's parent is a link, not a directory we own: no mode set
    expect(() => mkdirExact(join(base, 'link'))).not.toThrow();
    expect(modeOf(outside)).toBe(0o700);
  });
});
