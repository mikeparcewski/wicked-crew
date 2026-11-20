// crew#1508: drive cancellation/reap ordering through the real server assembly.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/api/server.js';
import type { CodebaseArchive } from '../src/api/codebase-archive.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { crewStateHome, setCrewStateHome } from '../src/projects/state-home.js';
import { removeScratch } from './setup/scratch.js';

const armedStateHome = crewStateHome();
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(pred: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 8_000) throw new Error(`timed out waiting for ${label}`);
    await settle(20);
  }
}
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
}

describe('crew#1508 — cancelled codebase archives follow the reap outcome', () => {
  let scratch: string;
  let repoRoot: string;
  let archiveRoot: string;
  let app: FastifyInstance;
  let emit: (frame: CoreEvent) => void;
  const runs = new Map<string, string>();
  let seq = 0;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'codebase-archive-cancel-'));
    repoRoot = join(scratch, 'repo');
    mkdirSync(repoRoot);
    git(repoRoot, 'init', '-q', '-b', 'main');
    git(repoRoot, 'config', 'user.email', 't@example.invalid');
    git(repoRoot, 'config', 'user.name', 'T');
    writeFileSync(join(repoRoot, 'tracked.txt'), 'keep this committed file\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-qm', 'base');
    const home = join(scratch, 'state-home');
    mkdirSync(home);
    setCrewStateHome(home);
    archiveRoot = join(scratch, 'archives');
    const listeners = new Set<(frame: CoreEvent) => void>();
    emit = (frame) => { for (const listener of listeners) listener(frame); };
    const adapter = {
      dbPath: join(home, 'core.db'),
      projectsSupported: () => false,
      getSettings: async () => ({}),
      onLaunch: (): (() => void) => () => undefined,
      onEvent: (listener: (frame: CoreEvent) => void): (() => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      listRepos: async () => [
        { id: 'r1', name: 'repo', root_path: repoRoot, default_branch: 'main', registered_at: 1, code_graph_db: null },
      ],
      sessionsDetail: async () => [...runs].map(([id, workdir]) => ({
        session: { id, status: 'cancelled', repo_ref: 'r1', workdir }, units: [],
      })),
      workOutput: async () => '',
      onboardedRepoOf: () => undefined,
    } as unknown as CoreAdapter;
    app = await createServer(adapter, {
      auth: { mode: 'off' },
      seats: { signedIn: () => true },
      auditPath: join(scratch, 'audit.log'),
      evalStoreRoot: join(scratch, 'evals'),
      codebaseArchiveRoot: archiveRoot,
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      skills: { disabled: true },
    });
    await app.ready();
  }, 150_000);

  afterAll(async () => {
    await app?.close();
    setCrewStateHome(armedStateHome);
    removeScratch(scratch);
  });

  function fixture(dirty = false): { id: string; workdir: string } {
    const id = `15080000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
    const workdir = join(scratch, id);
    git(repoRoot, 'worktree', 'add', '-q', '-b', `wicked/${id}`, workdir, 'main');
    writeFileSync(join(workdir, 'run.txt'), 'committed run output\n');
    git(workdir, 'add', '-A');
    git(workdir, 'commit', '-qm', 'run output');
    if (dirty) writeFileSync(join(workdir, 'uncommitted.txt'), 'retained run output\n');
    runs.set(id, workdir);
    return { id, workdir };
  }

  function recordDir(id: string): string {
    return join(archiveRoot, createHash('sha256').update(id).digest('hex').slice(0, 32));
  }
  function record(id: string): (CodebaseArchive & { file: string }) | undefined {
    const path = join(recordDir(id), 'codebase.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as CodebaseArchive & { file: string } : undefined;
  }
  function assertArchive(id: string, source: 'branch' | 'worktree', entries: string[]): void {
    const rec = record(id)!;
    expect(rec.source).toBe(source);
    expect(rec.trigger).toBe('run_end');
    expect(rec.bytes).toBeGreaterThan(0);
    expect(existsSync(join(recordDir(id), rec.file))).toBe(true);
    // The record's tree is the exact input to git archive; its objects live in the repo.
    expect(git(repoRoot, 'ls-tree', '-r', '--name-only', rec.tree).split('\n').sort()).toEqual(entries);
  }
  const cancel = (id: string): void => emit({ type: 'runCancelled', session: id } as CoreEvent);
  const retain = (id: string, path: string): void => emit({ type: 'worktreeRetained', session: id, path } as CoreEvent);
  async function assertRetained(id: string): Promise<void> {
    await waitFor(() => record(id)?.source === 'worktree', 'retained worktree archive');
    assertArchive(id, 'worktree', ['run.txt', 'tracked.txt', 'uncommitted.txt']);
    await settle(300);
    assertArchive(id, 'worktree', ['run.txt', 'tracked.txt', 'uncommitted.txt']);
  }

  it('1. clean tree mid-reap archives the intact run branch', async () => {
    const { id, workdir } = fixture();
    // Deterministic delayed reap: removal has deleted a tracked file but still holds the tree.
    unlinkSync(join(workdir, 'tracked.txt'));
    cancel(id);
    await waitFor(() => record(id) !== undefined, 'cancel archive');
    expect(record(id)!.source).toBe('branch');
    expect(record(id)!.tree).toBe(git(repoRoot, 'rev-parse', `wicked/${id}^{tree}`));
    assertArchive(id, 'branch', ['run.txt', 'tracked.txt']);
  }, 15_000);

  it('2. retained in the same tick after cancellation cannot be overwritten by branch', async () => {
    const { id, workdir } = fixture(true);
    cancel(id);
    retain(id, workdir);
    await assertRetained(id);
  }, 15_000);

  it('3. late retained refreshes an already landed branch archive', async () => {
    const { id, workdir } = fixture(true);
    cancel(id);
    await waitFor(() => record(id) !== undefined, 'initial cancel archive');
    assertArchive(id, 'branch', ['run.txt', 'tracked.txt']);
    retain(id, workdir);
    await assertRetained(id);
  }, 15_000);

  it('4. quick reap retained before cancellation archives the worktree', async () => {
    const { id, workdir } = fixture(true);
    retain(id, workdir);
    cancel(id);
    await assertRetained(id);
  }, 15_000);

  it('5. resume clears the earlier terminal reap outcome before a clean cancellation', async () => {
    const { id, workdir } = fixture(true);
    retain(id, workdir);
    emit({ type: 'unitDispatched', session: id, ord: 2 } as CoreEvent);
    git(workdir, 'add', '-A');
    git(workdir, 'commit', '-qm', 'resumed run output');
    // The clean reap has started removing files from the formerly retained worktree.
    unlinkSync(join(workdir, 'tracked.txt'));
    cancel(id);
    await waitFor(() => record(id) !== undefined, 'resumed cancel archive');
    expect(record(id)!.source).toBe('branch');
    expect(record(id)!.tree).toBe(git(repoRoot, 'rev-parse', `wicked/${id}^{tree}`));
    assertArchive(id, 'branch', ['run.txt', 'tracked.txt', 'uncommitted.txt']);
    await settle(300);
    assertArchive(id, 'branch', ['run.txt', 'tracked.txt', 'uncommitted.txt']);
  }, 15_000);

  it('6. a re-dispatch after a cancel ends it: a later lifecycle\'s worktreeRetained is not a cancel refresh', async () => {
    const { id, workdir } = fixture(true);
    cancel(id);
    await waitFor(() => record(id) !== undefined, 'cancel archive');
    assertArchive(id, 'branch', ['run.txt', 'tracked.txt']);
    // A campaign relaunch reuses the id; its own terminal (not a cancel) then keeps the dirty tree.
    emit({ type: 'unitDispatched', session: id, ord: 1 } as CoreEvent);
    retain(id, workdir);
    await settle(500);
    assertArchive(id, 'branch', ['run.txt', 'tracked.txt']);
  }, 15_000);
});
