// The repo-snapshot helper (CREW-UX-8 v4): governed interactive runs launch UNBOUND, and an
// unbound worker's boundary is {sandbox, extraWriteRoots, ~/.claude/plugins} — live-repo READS
// are governance-denied (wicked-core#294) and a repoRef binding kills the session
// (wicked-core#293). Grounding therefore means a crew-side snapshot INSIDE the already-readable
// inbox, made BEFORE the launch. These tests pin the snapshot mechanics both seams share:
// shallow git clone preferred, copy fallback that skips .git/node_modules, a hard size cap,
// and NEVER a partial snapshot left behind on failure.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_SNAPSHOT_MAX_BYTES, snapshotRepo } from '../src/interactive/repo-snapshot.js';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('snapshotRepo (CREW-UX-8 v4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-snap-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function plainRepo(name = 'src-repo'): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '# real project content\n', 'utf8');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const answer = 42;\n', 'utf8');
    return root;
  }

  it('snapshots a plain (non-git) directory via the copy fallback, skipping .git and node_modules', () => {
    const root = plainRepo();
    // Junk that must never ride into the snapshot — at any depth.
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'junk', 'utf8');
    mkdirSync(join(root, 'src', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'src', 'node_modules', 'nested.js'), 'junk', 'utf8');

    const dest = join(dir, 'snap');
    const logged: string[] = [];
    expect(snapshotRepo(root, dest, { log: (m) => logged.push(m) })).toBe(true);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('real project content');
    expect(readFileSync(join(dest, 'src', 'index.ts'), 'utf8')).toContain('answer = 42');
    expect(existsSync(join(dest, 'node_modules'))).toBe(false);
    expect(existsSync(join(dest, 'src', 'node_modules'))).toBe(false);
    // The non-git root fell THROUGH the clone to the copy — visibly, in the log.
    expect(logged.some((m) => m.includes('falling back to a file copy'))).toBe(gitAvailable);
  });

  it.skipIf(!gitAvailable)('prefers a SHALLOW local git clone for a real repo — tracked content only, own object store', () => {
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
    expect(snapshotRepo(root, dest, { log: () => {} })).toBe(true);
    expect(readFileSync(join(dest, 'README.md'), 'utf8')).toContain('real project content');
    expect(existsSync(join(dest, 'untracked-scratch.txt'))).toBe(false);
    // A real clone (not the copy fallback): its own .git, and a SHALLOW one (--depth 1).
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(existsSync(join(dest, '.git', 'shallow'))).toBe(true);
  });

  it('refuses a repo over the size budget — and the budget walk skips .git/node_modules and symlinks', () => {
    const root = plainRepo();
    const dest = join(dir, 'snap');
    const logged: string[] = [];
    // README+index are ~50 bytes; a 10-byte budget is exceeded → no snapshot, nothing on disk.
    expect(snapshotRepo(root, dest, { maxBytes: 10, log: (m) => logged.push(m) })).toBe(false);
    expect(existsSync(dest)).toBe(false);
    expect(logged.some((m) => m.includes('exceeds the 10-byte snapshot budget'))).toBe(true);

    // Bulk parked under node_modules (or behind a symlink) does NOT count against the budget…
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'blob.bin'), 'x'.repeat(4096), 'utf8');
    try {
      symlinkSync(join(root, 'node_modules', 'blob.bin'), join(root, 'link-to-blob'));
    } catch {
      // symlink creation can be privilege-gated on Windows — the node_modules half still tests the skip
    }
    expect(snapshotRepo(root, dest, { maxBytes: 4096, log: () => {} })).toBe(true);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
  });

  it('returns false for a missing or non-directory root — never throws into the seam', () => {
    const logged: string[] = [];
    expect(snapshotRepo(join(dir, 'no-such-repo'), join(dir, 'snap'), { log: (m) => logged.push(m) })).toBe(false);
    expect(existsSync(join(dir, 'snap'))).toBe(false);
    expect(logged.some((m) => m.includes('does not exist'))).toBe(true);

    const file = join(dir, 'a-file');
    writeFileSync(file, 'not a dir', 'utf8');
    expect(snapshotRepo(file, join(dir, 'snap2'), { log: () => {} })).toBe(false);
  });

  it('clears a STALE dest before snapshotting — a replayed key never reads a dead clone', () => {
    const root = plainRepo();
    const dest = join(dir, 'snap');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'stale-leftover.txt'), 'from a crashed run', 'utf8');
    expect(snapshotRepo(root, dest, { log: () => {} })).toBe(true);
    expect(existsSync(join(dest, 'stale-leftover.txt'))).toBe(false);
    expect(existsSync(join(dest, 'README.md'))).toBe(true);
  });

  it('ships a ~200MB default budget', () => {
    expect(REPO_SNAPSHOT_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
});
