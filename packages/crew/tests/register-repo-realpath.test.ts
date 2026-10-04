// crew#778 — a repository registered through a path with a symlink component (`/tmp/link-repo` →
// the real checkout; on macOS `/tmp` is itself a symlink) was accepted as typed. The
// engine then minted worktrees under that path, and codex's Seatbelt sandbox refuses a writable root
// with a symlink component, so every codex unit failed at start-up. Registration now resolves the
// path to its real path, so seats are handed worktree paths without a link in them.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

describe.skipIf(process.platform === 'win32')('registering a repo through a symlinked path (crew#778)', () => {
  let dir: string;
  let real: string;
  let link: string;
  let adapter: CoreAdapter;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'repo-realpath-'));
    real = join(dir, 'checkout');
    mkdirSync(real);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: real });
    execFileSync('git', ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'root'], { cwd: real });
    link = join(dir, 'link-repo');
    symlinkSync(real, link);
    adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  });

  afterAll(() => {
    adapter?.close();
    if (dir) removeScratch(dir);
  });

  it('stores the real path, so no seat is handed a worktree under a link', async () => {
    const entry = await adapter.registerRepo('link-repo', link);
    expect(entry.root_path).toBe(realpathSync(real));
    expect(entry.root_path).not.toContain('link-repo');
    const listed = (await adapter.listRepos()).find((r) => r.id === entry.id);
    expect(listed?.root_path).toBe(realpathSync(real));
  });
});
