// TOCTOU discipline inside the skills root (design v3.5 §3; codex round 8 on #480). The lstat walk is
// necessary, not sufficient: every open inside the root is `O_NOFOLLOW` with a post-open dev/ino
// identity check (`tree.ts` `openRegularNoFollow`), copies read their SOURCE through such an open
// (never `copyFileSync(path)`), and a staged tree is re-walked and re-hashed AFTER the copy and BEFORE
// the rename into place. This suite drives the two windows the discipline closes:
//
//   - a copy SOURCE swapped for a symlink between enumeration and copy — at the tree level (the
//     records were enumerated, then the file is replaced by a link before `copyFiles` runs) and at
//     the store level, with `node:fs.openSync` hooked to perform the swap at the very moment the
//     source is about to be opened;
//   - a STAGED tree tampered after the copy and before the rename — hooked at a call the store makes
//     between the two (the `snapshot.json` rename inside a publish staging, the owner-write chmod of a
//     reset/refresh staging, the mkdir of the next file during a baseline capture).
//
// The residual v3.5 §3 documents — a DIRECTORY component swapped between the walk and the rename by
// another writer with access to the crew-owned state home — is not tested as caught: it is mitigated
// by the single-writer daemon and the post-operation verification, not eliminated.

import type { PathLike } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  /** Swap this SOURCE path for a symlink to `to` at its (`skip` + 1)-th open — after the enumeration, and after any pre-copy verification read. */
  swapOnOpen: null as { path: string; to: string; skip: number } | null,
  /** When a path matching `when` is chmod'ed / mkdir'ed / renamed-to, run `tamper` once. */
  tamperOn: null as { op: 'chmod' | 'mkdir' | 'rename'; when: (p: string) => boolean; tamper: () => void } | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fire = (op: 'chmod' | 'mkdir' | 'rename', p: string): void => {
    const t = fault.tamperOn;
    if (t !== null && t.op === op && t.when(p)) {
      fault.tamperOn = null;
      t.tamper();
    }
  };
  return {
    ...actual,
    openSync: ((path: PathLike, flags: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
      const swap = fault.swapOnOpen;
      if (swap !== null && String(path) === swap.path) {
        if (swap.skip > 0) {
          swap.skip -= 1;
        } else {
          fault.swapOnOpen = null;
          actual.rmSync(swap.path);
          actual.symlinkSync(swap.to, swap.path);
        }
      }
      return actual.openSync(path, flags, mode);
    }) as typeof actual.openSync,
    chmodSync: ((path: PathLike, mode: Parameters<typeof actual.chmodSync>[1]) => {
      fire('chmod', String(path));
      actual.chmodSync(path, mode);
    }) as typeof actual.chmodSync,
    mkdirSync: ((path: PathLike, options?: Parameters<typeof actual.mkdirSync>[1]) => {
      fire('mkdir', String(path));
      return actual.mkdirSync(path, options);
    }) as typeof actual.mkdirSync,
    renameSync: (from: PathLike, to: PathLike): void => {
      fire('rename', String(to));
      actual.renameSync(from, to);
    },
  };
});

import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SkillsBaselineCorruptError, SkillsPublishError } from '../src/skills/store.js';
import { copyFiles, EntrySwappedError, readFileNoFollow, SymlinkComponentError, walkFiles } from '../src/skills/tree.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

describe('tree.ts — opens are O_NOFOLLOW with an identity check; copies never read a source by path', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'skills-toctou-'));
  });
  afterEach(() => {
    fault.swapOnOpen = null;
    fault.tamperOn = null;
    removeScratch(base);
  });

  it('readFileNoFollow refuses a symlink at the leaf and a non-file; reads a regular file', () => {
    writeFileSync(join(base, 'real.txt'), 'real\n');
    symlinkSync(join(base, 'real.txt'), join(base, 'link.txt'));
    mkdirSync(join(base, 'dir'));
    expect(readFileNoFollow(join(base, 'real.txt')).toString()).toBe('real\n');
    expect(() => readFileNoFollow(join(base, 'link.txt'))).toThrow(SymlinkComponentError);
    expect(() => readFileNoFollow(join(base, 'dir'))).toThrow(EntrySwappedError);
    expect(() => readFileNoFollow(join(base, 'missing.txt'))).toThrow(/ENOENT/);
  });

  it('copyFiles refuses a SOURCE swapped for a symlink after enumeration — nothing is copied through the link, the destination tree keeps what landed before', () => {
    const src = join(base, 'src');
    mkdirSync(join(src, 'skills', 'x'), { recursive: true });
    writeFileSync(join(src, 'skills', 'x', 'SKILL.md'), '---\nname: wicked-garden-x\n---\n');
    writeFileSync(join(src, 'skills', 'x', 'notes.md'), 'notes\n');
    const outside = join(base, 'outside.md');
    writeFileSync(outside, 'OUTSIDE\n');
    const records = walkFiles(src); // enumerated — `notes.md` comes after `SKILL.md`
    // …then the source is swapped for a link before the copy runs.
    rmSync(join(src, 'skills', 'x', 'notes.md'));
    symlinkSync(outside, join(src, 'skills', 'x', 'notes.md'));
    const dest = join(base, 'dest');
    expect(() => copyFiles(records, dest)).toThrow(SymlinkComponentError);
    expect(existsSync(join(dest, 'skills', 'x', 'notes.md'))).toBe(false); // never written through the link
    expect(readFileSync(join(dest, 'skills', 'x', 'SKILL.md'), 'utf8')).toContain('wicked-garden-x'); // the file ahead of it landed (the caller removes the staging)
  });

  it('the swap can happen at the very moment of the open (hooked openSync): refused as EntrySwappedError, never followed', () => {
    const src = join(base, 'src2');
    mkdirSync(src);
    writeFileSync(join(src, 'a.txt'), 'a\n');
    const outside = join(base, 'outside2.md');
    writeFileSync(outside, 'OUTSIDE\n');
    fault.swapOnOpen = { path: join(src, 'a.txt'), to: outside, skip: 0 };
    const dest = join(base, 'dest2');
    expect(() => copyFiles(walkFiles(src), dest)).toThrow(EntrySwappedError);
    expect(existsSync(join(dest, 'a.txt'))).toBe(false);
    expect(lstatSync(join(src, 'a.txt')).isSymbolicLink()).toBe(true); // the swap did happen
  });
});

describe('store — a source swapped between the walk and the copy is a blocked envelope; a staged tree tampered before the rename is refused', () => {
  let s: Scaffold;
  beforeEach(() => {
    s = scaffold();
  });
  afterEach(() => {
    fault.swapOnOpen = null;
    fault.tamperOn = null;
    removeScratch(s.base);
  });

  it('reset: the baseline source swapped for a link as it is opened ⇒ blocked path-invalid, effective untouched, revision unchanged', () => {
    s.store.seed();
    const hash = s.store.manifest().baseline;
    const outside = join(s.base, 'outside.md');
    writeFileSync(outside, 'OUTSIDE\n');
    const edited = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nmine\n', 1);
    const effectiveFile = join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md');
    // The reset opens the source ONCE for the pre-copy hash verification and once for the copy: swap it
    // at the copy's open (skip the verification's) — the window between the walk and the copy.
    const source = join(s.root, 'baseline', hash, 'skills', 'gamma', 'SKILL.md');
    fault.swapOnOpen = { path: source, to: outside, skip: 1 };
    const r = s.store.reset('wicked-garden-gamma', edited.revision);
    expect(fault.swapOnOpen).toBeNull(); // the swap DID happen, at the copy's open
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(r).toMatchObject({ verdict: 'blocked', revision: edited.revision });
    expect(r.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', skill: 'wicked-garden-gamma' });
    expect(r.findings[0]?.explanation).toContain('v3.5 §3');
    expect(readFileSync(effectiveFile, 'utf8')).toContain('mine'); // nothing swapped in
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    expect(s.store.revision()).toBe(edited.revision);
  });

  it('publish: a staged file tampered after the copy (at the snapshot.json rename) ⇒ SkillsPublishError naming the hash mismatch, no generation, no current, revision unchanged', async () => {
    s.store.seed();
    fault.tamperOn = {
      op: 'rename',
      when: (to) => basename(to) === 'snapshot.json',
      tamper: () => {
        // The staging dir is the parent of snapshot.json's destination; tamper a copied skill file in it.
        const staging = readdirSync(join(s.root, 'snapshots')).find((e) => e.startsWith('.staging-')) as string;
        appendFileSync(join(s.root, 'snapshots', staging, 'skills', 'gamma', 'SKILL.md'), 'tampered after the copy\n');
      },
    };
    await expect(s.store.publish(1)).rejects.toBeInstanceOf(SkillsPublishError);
    await expect(s.store.publish(1)).resolves.toMatchObject({ verdict: 'clear' }); // the hook fired once; a clean publish lands
    expect(s.store.generationsOnDisk()).toEqual([1]); // the tampered staging never became a generation
    expect(readdirSync(join(s.root, 'snapshots')).filter((e) => e.startsWith('.staging-'))).toEqual([]);
  });

  it('reset / refresh: a staged file tampered after the copy (at the owner-write chmod) ⇒ blocked path-invalid, nothing swapped, revision unchanged', () => {
    s.store.seed();
    const edited = s.store.writeFile('wicked-garden-gamma', 'SKILL.md', '---\nname: wicked-garden-gamma\n---\n\nmine\n', 1);
    fault.tamperOn = {
      op: 'chmod',
      when: (p) => p.includes(`${join(s.root, '.staging-reset-')}`) && p.endsWith(join('skills', 'gamma', 'SKILL.md')),
      tamper: () => {
        // The staged copy still carries the baseline's read-only bits at this moment (the chmod being
        // hooked is the one that restores owner write): an attacker with write access to the state
        // home is not stopped by mode bits — neither is the test (the hook is single-shot, so this
        // chmod does not re-fire it).
        const staging = readdirSync(s.root).find((e) => e.startsWith('.staging-reset-')) as string;
        const file = join(s.root, staging, 'new', 'skills', 'gamma', 'SKILL.md');
        chmodSync(file, 0o644);
        appendFileSync(file, 'tampered\n');
      },
    };
    const r = s.store.reset('wicked-garden-gamma', edited.revision);
    expect(r).toMatchObject({ verdict: 'blocked', revision: edited.revision });
    expect(r.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking', skill: 'wicked-garden-gamma' });
    expect(r.findings[0]?.evidence).toContain('modified between copy and swap');
    expect(readFileSync(join(s.root, 'effective', 'skills', 'gamma', 'SKILL.md'), 'utf8')).toContain('mine');
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
    expect(s.store.revision()).toBe(edited.revision);
    // Refresh: the same window, the same refusal — and the new capture is reaped.
    writeFileSync(join(s.upstream, 'skills', 'beta', 'SKILL.md'), '---\nname: wicked-garden-beta\n---\n\nupstream v2 wicked-garden-gamma\n');
    const baselines = s.store.baselinesOnDisk();
    fault.tamperOn = {
      op: 'chmod',
      when: (p) => p.includes(join(s.root, '.staging-refresh-')) && p.endsWith(join('skills', 'beta', 'SKILL.md')),
      tamper: () => {
        const staging = readdirSync(s.root).find((e) => e.startsWith('.staging-refresh-')) as string;
        const file = join(s.root, staging, 'new', 'skills', 'beta', 'SKILL.md');
        chmodSync(file, 0o644);
        appendFileSync(file, 'tampered\n');
      },
    };
    const ref = s.store.refreshBaseline(edited.revision);
    expect(ref).toMatchObject({ verdict: 'blocked', revision: edited.revision, taken: [], added: [], removed: [] });
    expect(ref.findings[0]).toMatchObject({ kind: 'path-invalid', severity: 'blocking' });
    expect(ref.findings[0]?.evidence).toContain('modified between copy and swap');
    expect(s.store.baselinesOnDisk()).toEqual(baselines);
    expect(readFileSync(join(s.root, 'effective', 'skills', 'beta', 'SKILL.md'), 'utf8')).not.toContain('upstream v2');
    expect(readdirSync(s.root).filter((e) => e.startsWith('.staging-'))).toEqual([]);
  });

  it('baseline capture: a staged file tampered during the copy (at the next mkdir) ⇒ the seed throws SkillsBaselineCorruptError and nothing bears the hash; the same tamper during a refresh is a blocked baseline-corrupt envelope', () => {
    // The seed copies the bundle into baseline/.staging-<hex>/…; the mkdir for a later file's parent
    // runs after earlier files landed — tamper one of them there.
    fault.tamperOn = {
      op: 'mkdir',
      when: (p) => p.includes(join(s.root, 'baseline', '.staging-')) && p.endsWith(join('skills', 'gamma')),
      tamper: () => {
        const staging = readdirSync(join(s.root, 'baseline')).find((e) => e.startsWith('.staging-')) as string;
        appendFileSync(join(s.root, 'baseline', staging, '.claude-plugin', 'plugin.json'), '\n');
      },
    };
    expect(() => s.store.seed()).toThrow(SkillsBaselineCorruptError);
    expect(() => s.store.seed()).not.toThrow(); // the hook fired once; a clean seed lands
    const hash = s.store.manifest().baseline;
    expect(readdirSync(join(s.root, 'baseline')).sort()).toEqual([hash]); // no torn staging, nothing under a wrong name
    // Refresh over a changed upstream, tampered the same way ⇒ blocked, nothing changed.
    writeFileSync(join(s.upstream, 'skills', 'beta', 'SKILL.md'), '---\nname: wicked-garden-beta\n---\n\nupstream v2 wicked-garden-gamma\n');
    const before = JSON.stringify(s.store.manifest());
    fault.tamperOn = {
      op: 'mkdir',
      when: (p) => p.includes(join(s.root, 'baseline', '.staging-')) && p.endsWith(join('skills', 'gamma')),
      tamper: () => {
        const staging = readdirSync(join(s.root, 'baseline')).find((e) => e.startsWith('.staging-')) as string;
        appendFileSync(join(s.root, 'baseline', staging, '.claude-plugin', 'plugin.json'), '\n');
      },
    };
    const ref = s.store.refreshBaseline(1);
    expect(ref).toMatchObject({ verdict: 'blocked', revision: 1 });
    expect(ref.findings[0]).toMatchObject({ kind: 'baseline-corrupt' });
    expect(ref.findings[0]?.evidence).toContain('modified between copy and rename');
    expect(JSON.stringify(s.store.manifest())).toBe(before);
    expect(readdirSync(join(s.root, 'baseline')).sort()).toEqual([hash]);
  });
});
