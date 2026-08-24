// The repo-snapshot helper (CREW-UX-8 v4): governed interactive runs launch UNBOUND, and an
// unbound worker's boundary is {sandbox, extraWriteRoots, ~/.claude/plugins} — live-repo READS
// are governance-denied (wicked-core#294) and a repoRef binding kills the session
// (wicked-core#293). Grounding therefore means a crew-side snapshot INSIDE the already-readable
// inbox, made BEFORE the launch. These tests pin the snapshot mechanics both seams share:
// shallow git clone preferred (swept + re-measured), copy fallback that skips
// .git/node_modules AND symlinks, a hard size cap, per-cause failure reasons, an overlap
// refusal that never deletes live repo content, and NEVER a partial snapshot left behind.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { REPO_SNAPSHOT_MAX_BYTES, pathsOverlap, snapshotRepo } from '../src/interactive/repo-snapshot.js';

// A seam into the copy fallback (Copilot round 2): the post-copy re-measure guards against a
// source that GROWS between the preflight walk and the copy — unreproducible with a real
// filesystem race, so `cp` is wrapped to let one test append to the DEST after the copy lands
// (equivalent divergence: materialized tree ≠ preflighted tree). Undefined = passthrough.
const cpHook = vi.hoisted(() => ({ tail: undefined as ((dest: string) => void) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const cp: typeof real.cp = async (src, dest, opts) => {
    await real.cp(src, dest, opts);
    cpHook.tail?.(String(dest));
  };
  return { ...real, cp };
});

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

/** `true` when this platform let the test create a symlink (privilege-gated on Windows). */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

describe('snapshotRepo (CREW-UX-8 v4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-snap-'));
  });
  afterEach(() => {
    cpHook.tail = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function plainRepo(name = 'src-repo'): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# real project content\n', 'utf8');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
    return root;
  }

  it('snapshots a plain (non-git) directory via the copy fallback, skipping .git and node_modules', async () => {
    const root = plainRepo();
    // Junk that must never ride into the snapshot — at any depth. The `.git` entry is REAL
    // (Copilot round 2: the fixture previously never created one, so the .git skip branch was
    // claimed-covered but green under any regression) — a stray metadata dir, not a valid
    // repo, so the clone still fails through to the copy path this test is about.
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD-ish'), 'not a real repo', 'utf8');
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'junk', 'utf8');
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'src', 'node_modules', 'nested.js'), 'junk', 'utf8');

    const dest = join(dir, 'snap');
    const logged: string[] = [];
    await expect(snapshotRepo(root, dest, { log: (m) => logged.push(m) })).resolves.toEqual({ ok: true });
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('real project content');
    expect(readFileSync(join(dest, 'src', 'index.ts'), 'utf8')).toContain('answer = 42');
    expect(existsSync(join(dest, '.git'))).toBe(false);
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(dest, 'src', 'node_modules'))).toBe(false);
    // The non-git root fell THROUGH the clone to the copy — visibly, in the log. Logged whether
    // or not a git binary exists: with git the clone fails on a non-repo, without git the spawn
    // itself throws — either way the fallback is what produced the snapshot (Copilot, crew#313:
    // the old `.toBe(gitAvailable)` predicate was vacuously true and failed on git-less hosts).
    expect(logged.some((m) => m.includes('falling back to a file copy'))).toBe(true);
  });

  it('the copy fallback NEVER copies symlinks — a repo link to an outside file must not reach the worker-visible inbox', async () => {
    const root = plainRepo();
    // A secret OUTSIDE the repo, reachable only through a symlink inside it.
    const secret = join(dir, 'outside-secret.txt');
    writeFileSync(secret, 'the boundary must hide this', 'utf8');
    const linked = trySymlink(secret, join(root, 'leak.txt'));
    const linkedDir = trySymlink(dir, join(root, 'src', 'leak-dir'));

    const dest = join(dir, 'snap');
    await expect(snapshotRepo(root, dest, { log: () => {} })).resolves.toEqual({ ok: true });
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('real project content');
    if (linked) expect(existsSync(join(dest, 'leak.txt'))).toBe(false);
    if (linkedDir) expect(existsSync(join(dest, 'src', 'leak-dir'))).toBe(false);
  });

  it.skipIf(!gitAvailable)('prefers a SHALLOW local git clone for a real repo — tracked content only, own object store', async () => {
    const root = plainRepo('git-repo');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-m', 'initial');
    // Untracked after the commit: a clone snapshots HEAD, so this must NOT appear.
    writeFileSync(join(root, 'untracked-scratch.txt'), 'not committed', 'utf8');

    const dest = join(dir, 'snap');
    await expect(snapshotRepo(root, dest, { log: () => {} })).resolves.toEqual({ ok: true });
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('real project content');
    expect(existsSync(join(dest, 'untracked-scratch.txt'))).toBe(false);
    // A real clone (not the copy fallback): its own .git, and a SHALLOW one (--depth 1).
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(existsSync(join(dest, '.git', 'shallow'))).toBe(true);
  });

  it.skipIf(!gitAvailable)('SWEEPS a clone: tracked symlinks and tracked node_modules never survive into the snapshot (Copilot, crew#313)', async () => {
    const root = plainRepo('git-leaky');
    const secret = join(dir, 'outside-secret.txt');
    writeFileSync(secret, 'boundary-external data', 'utf8');
    const linked = trySymlink(secret, join(root, 'leak.txt'));
    // Tracked dependencies: `git clone` checks out EVERY tracked path, ignoring the skip list —
    // the sweep must remove them so the snapshot honors the contract (and the byte cap).
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x'.repeat(512), 'utf8');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-f', '.'); // -f: force-add node_modules past any global ignore
    git('commit', '-m', 'leaky');

    const dest = join(dir, 'snap');
    await expect(snapshotRepo(root, dest, { log: () => {} })).resolves.toEqual({ ok: true });
    expect(existsSync(join(dest, '.git'))).toBe(true); // still a real clone
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    if (linked) {
      expect(existsSync(join(dest, 'leak.txt'))).toBe(false);
      expect(() => lstatSync(join(dest, 'leak.txt'))).toThrow(); // not even a dangling link
    }
  });

  it('refuses a repo over the size budget — and the budget walk skips .git/node_modules and symlinks', async () => {
    const root = plainRepo();
    const dest = join(dir, 'snap');
    const logged: string[] = [];
    // README+index are ~50 bytes; a 10-byte budget is exceeded → no snapshot, nothing on disk.
    await expect(snapshotRepo(root, dest, { maxBytes: 10, log: (m) => logged.push(m) })).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(existsSync(dest)).toBe(false);
    expect(logged.some((m) => m.includes('exceeds the 10-byte snapshot budget'))).toBe(true);

    // Bulk parked under node_modules (or behind a symlink) does NOT count against the budget…
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'blob.bin'), 'x'.repeat(4096), 'utf8');
    trySymlink(join(root, 'node_modules', 'blob.bin'), join(root, 'link-to-blob'));
    await expect(snapshotRepo(root, dest, { maxBytes: 4096, log: () => {} })).resolves.toEqual({ ok: true });
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
    // …and neither the node_modules bulk nor the symlink reached the snapshot.
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(dest, 'link-to-blob'))).toBe(false);
  });

  it('returns root-unreadable for a missing or non-directory root — never throws into the seam', async () => {
    const logged: string[] = [];
    await expect(
      snapshotRepo(join(dir, 'no-such-repo'), join(dir, 'snap'), { log: (m) => logged.push(m) }),
    ).resolves.toEqual({ ok: false, reason: 'root-unreadable' });
    expect(existsSync(join(dir, 'snap'))).toBe(false);
    expect(logged.some((m) => m.includes('does not exist'))).toBe(true);

    const file = join(dir, 'a-file');
    writeFileSync(file, 'not a dir', 'utf8');
    await expect(snapshotRepo(file, join(dir, 'snap2'), { log: () => {} })).resolves.toEqual({
      ok: false,
      reason: 'root-unreadable',
    });
  });

  it('REFUSES an overlapping source/dest — and deletes NOTHING from the live repo (Copilot, crew#313)', async () => {
    const root = plainRepo();
    const logged: string[] = [];

    // dest INSIDE the repo: the old order rm-rf'd it (live repo content!) before noticing.
    const inside = join(root, 'src', 'snap');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, 'precious.txt'), 'live repo data', 'utf8');
    await expect(snapshotRepo(root, inside, { log: (m) => logged.push(m) })).resolves.toEqual({
      ok: false,
      reason: 'dest-overlap',
    });
    expect(readFileSync(join(inside, 'precious.txt'), 'utf8')).toBe('live repo data'); // untouched
    expect(logged.some((m) => m.includes('overlaps'))).toBe(true);

    // dest === root, and root INSIDE dest: refused in both directions.
    await expect(snapshotRepo(root, root, { log: () => {} })).resolves.toEqual({ ok: false, reason: 'dest-overlap' });
    await expect(snapshotRepo(root, dir, { log: () => {} })).resolves.toEqual({ ok: false, reason: 'dest-overlap' });
    expect(existsSync(join(root, 'README.md'))).toBe(true); // the repo survived every refusal
  });

  it('clears a STALE dest before snapshotting — a replayed key never reads a dead clone', async () => {
    const root = plainRepo();
    const dest = join(dir, 'snap');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'stale-leftover.txt'), 'from a crashed run', 'utf8');
    await expect(snapshotRepo(root, dest, { log: () => {} })).resolves.toEqual({ ok: true });
    expect(existsSync(join(dest, 'stale-leftover.txt'))).toBe(false);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
  });

  it('the copy fallback RE-MEASURES what it materialized — growth between preflight and copy cannot smuggle an over-budget tree into the inbox (Copilot round 2)', async () => {
    const root = plainRepo(); // ~50 bytes: comfortably under the 4096-byte budget at preflight
    const dest = join(dir, 'snap');
    // Simulate a source that grew DURING the copy: the materialized dest ends up over budget
    // even though the preflight walk passed.
    cpHook.tail = (copied) => writeFileSync(join(copied, 'grew-mid-copy.bin'), 'x'.repeat(8192), 'utf8');
    const logged: string[] = [];
    await expect(snapshotRepo(root, dest, { maxBytes: 4096, log: (m) => logged.push(m) })).resolves.toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(existsSync(dest), 'an over-budget copy must not be left behind').toBe(false);
    expect(logged.some((m) => m.includes('exceeds the 4096-byte budget'))).toBe(true);

    // Passthrough sanity: without growth the same budget succeeds.
    cpHook.tail = undefined;
    await expect(snapshotRepo(root, dest, { maxBytes: 4096, log: () => {} })).resolves.toEqual({ ok: true });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a NON-ENOENT realpath failure on the dest fails CLOSED (no snapshot) — never judged lexically past an unresolvable parent (Copilot round 2)',
    async () => {
      const root = plainRepo();
      // A dest whose EXISTING parent cannot be traversed: realpath fails with EACCES, not
      // ENOENT — the old walk-up treated that as "missing" and reconstructed a lexical path
      // that could hide an overlap behind the unresolvable component.
      const blocked = join(dir, 'blocked');
      mkdirSync(blocked, { recursive: true });
      const dest = join(blocked, 'inner', 'snap');
      chmodSync(blocked, 0o000);
      try {
        const logged: string[] = [];
        await expect(snapshotRepo(root, dest, { log: (m) => logged.push(m) })).resolves.toEqual({
          ok: false,
          reason: 'root-unreadable',
        });
        expect(logged.some((m) => m.includes('overlap check'))).toBe(true);
      } finally {
        chmodSync(blocked, 0o700); // let afterEach's rmSync clean up
      }
    },
  );

  it('ships a ~200MB default budget', () => {
    expect(REPO_SNAPSHOT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe('pathsOverlap (Copilot round 2: root bases must match)', () => {
  it('detects containment under a POSIX filesystem ROOT base — `/` never got past the old `base + sep` spelling', () => {
    expect(pathsOverlap('/', '/tmp/crew-snap/x', path.posix)).toBe(true);
    expect(pathsOverlap('/tmp/crew-snap/x', '/', path.posix)).toBe(true); // both directions
    expect(pathsOverlap('/', '/', path.posix)).toBe(true);
  });

  it('detects containment under a win32 DRIVE-ROOT base (C:\\) and rejects cross-drive paths', () => {
    expect(pathsOverlap('C:\\', 'C:\\snapshots\\x', path.win32)).toBe(true);
    expect(pathsOverlap('C:\\snapshots\\x', 'C:\\', path.win32)).toBe(true);
    expect(pathsOverlap('C:\\', 'D:\\elsewhere', path.win32)).toBe(false); // different drive ≠ overlap
  });

  it('keeps ordinary containment semantics — and never false-positives on a sibling name prefix', () => {
    expect(pathsOverlap('/repo', '/repo/sub/dir', path.posix)).toBe(true);
    expect(pathsOverlap('/repo', '/repo', path.posix)).toBe(true);
    expect(pathsOverlap('/repo', '/repo-snapshots/x', path.posix)).toBe(false);
    expect(pathsOverlap('/a/b', '/a/c', path.posix)).toBe(false);
  });
});
