// crew-0183: the repo watcher keeps an onboarded repo's code map current with no click (wicked-core#1230). Over a
// REAL temp git repo (the poll is real git) and FAKE engine/registry/run views; a fake clock drives the cadence.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RepoEntry, SessionView } from '../src/core/types.js';
import {
  CHANGE_MAX_WAIT_MS,
  POLL_ARGS,
  POLL_MIN_MS,
  RepoWatcher,
  countsAsChange,
  fingerprintOf,
  holdsOf,
  parsePorcelainV2,
  pollGit,
  repoWatchEnabledByEnv,
  type GitFn,
} from '../src/projects/repo-watch.js';
import { removeScratch } from './setup/scratch.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

let dir: string;
let repo: string;
let graphDb: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'repo-watch-'));
  repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  graphDb = join(dir, 'graphs', 'estate.db');
  mkdirSync(join(dir, 'graphs'));
  writeFileSync(graphDb, '');
});
afterEach(() => removeScratch(dir));

function view(id: string, status: string, name: string | null, repoRef = 'r1'): SessionView {
  return {
    session: { id, status, repo_ref: repoRef, workflow_id: name ?? `wf-${id}`, run_identity: name === null ? undefined : { kind: 'preset', name, user_plan: false, system: false } },
    units: [],
  } as unknown as SessionView;
}

function harness(opts: { views?: SessionView[]; failIndex?: string | null; enabled?: boolean; gitFn?: GitFn } = {}) {
  let t = 1_000_000;
  const state = { views: opts.views ?? [], failIndex: opts.failIndex ?? null };
  const indexed: string[] = [];
  const refreshed: string[] = [];
  const entry: RepoEntry = { id: 'r1', name: 'r1', root_path: repo, default_branch: 'main', registered_at: 1, code_graph_db: graphDb } as RepoEntry;
  const w = new RepoWatcher({
    listRepos: async () => [entry],
    runViews: async () => state.views,
    indexRepoGraph: async (id) => {
      if (state.failIndex !== null) throw new Error(state.failIndex);
      indexed.push(id);
      return { outcome: 'indexed' };
    },
    refreshProjects: async (id) => { refreshed.push(id); },
    statePath: join(dir, 'state', 'repo-watch.json'),
    stateHome: join(dir, 'state'),
    enabled: opts.enabled ?? true,
    log: () => undefined,
    now: () => t,
    ...(opts.gitFn !== undefined ? { git: opts.gitFn } : {}),
  });
  /** Advance the clock and run every step that is due (a poll per due repo, then the index it queued). */
  const tick = async (ms = POLL_MIN_MS): Promise<void> => {
    t += ms;
    for (let i = 0; i < 4; i++) await w.step();
  };
  const row = () => w.status().repos.find((r) => r.repoId === 'r1')!;
  return { w, tick, row, indexed, refreshed, state, advance: (ms: number) => { t += ms; } };
}

describe('the poll', () => {
  it('is git status with no fsmonitor daemon, nested untracked files and dirty submodules ignored', () => {
    expect(POLL_ARGS).toEqual(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty']);
  });

  it('parses porcelain v2 -z: HEAD, branch, ordinary, renamed (with origin), unmerged and untracked entries', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111', '# branch.head main',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts', 'src/old.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/c.ts',
      '? newdir/x.ts', '',
    ].join('\0');
    const p = parsePorcelainV2(out);
    expect(p.oid).toBe('1111111111111111111111111111111111111111');
    expect(p.head).toBe('main');
    expect(p.entries).toEqual([
      { code: '1 .M', path: 'src/a b.ts' },
      { code: '2 R.', path: 'src/new.ts' },
      { code: 'u UU', path: 'src/c.ts' },
      { code: '?', path: 'newdir/x.ts' },
    ]);
    expect(parsePorcelainV2('# branch.oid (initial)\0# branch.head main\0').oid).toBeNull();
  });

  it('never counts build output, worktrees, .git, or the state home', () => {
    for (const p of ['node_modules/x.js', 'packages/a/node_modules/y.js', 'target/debug/z', 'dist/index.js', 'wicked-worktrees/r1/a.ts', '.wicked/x', '.git/HEAD']) {
      expect(countsAsChange(p, repo, null), p).toBe(false);
    }
    expect(countsAsChange('src/a.ts', repo, null)).toBe(true);
    expect(countsAsChange('home/state/x.json', repo, join(repo, 'home', 'state'))).toBe(false);
  });

  it('changes its fingerprint on an edit, a new file nested in a NEW untracked directory, an edit to that file, a commit and a branch switch', async () => {
    const fp = async (): Promise<string> => (await fingerprintOf(repo, parsePorcelainV2(await pollGit(repo, POLL_ARGS)), null)).fingerprint;
    const seen = [await fp()];
    const step = async (label: string, act: () => void): Promise<void> => {
      act();
      const now = await fp();
      expect(seen, label).not.toContain(now);
      seen.push(now);
    };
    await step('edit', () => writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n'));
    await step('edit again (already modified)', () => writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 22;\nexport const b = 3;\n'));
    await step('new dir', () => { mkdirSync(join(repo, 'newdir')); writeFileSync(join(repo, 'newdir', 'a.ts'), 'export const n = 1;\n'); });
    await step('edit nested untracked', () => writeFileSync(join(repo, 'newdir', 'a.ts'), 'export const n = 1;\nexport function more(): number { return 2; }\n'));
    await step('commit', () => { git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'two'); });
    await step('switch', () => git(repo, 'switch', '-q', '-c', 'feature'));
    // An ignored directory changes nothing.
    const before = await fp();
    mkdirSync(join(repo, 'node_modules', 'p'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'p', 'i.js'), 'x');
    expect(await fp()).toBe(before);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('leaves no fsmonitor daemon behind in a repo that configures one', async () => {
    git(repo, 'config', 'core.fsmonitor', 'true');
    await pollGit(repo, POLL_ARGS);
    await new Promise((r) => setTimeout(r, 500));
    const st = spawnSync('git', ['fsmonitor--daemon', 'status'], { cwd: repo, encoding: 'utf8' });
    expect(`${st.stdout}${st.stderr}`).toMatch(/not watching/i);
    // Control: a plain status in the same repo DOES start one (so the assertion above can fail).
    spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    await new Promise((r) => setTimeout(r, 500));
    const after = spawnSync('git', ['fsmonitor--daemon', 'status'], { cwd: repo, encoding: 'utf8' });
    expect(`${after.stdout}${after.stderr}`).toMatch(/is watching/i);
    spawnSync('git', ['fsmonitor--daemon', 'stop'], { cwd: repo, encoding: 'utf8' });
  });
});

describe('the watcher', () => {
  it('indexes a change after one quiet poll, then refreshes the projects, and stays quiet while nothing changes', async () => {
    const h = harness();
    await h.tick(0); // boot: first poll, no record yet
    await h.tick(); // quiet → the catch-up index
    expect(h.indexed).toEqual(['r1']);
    expect(h.refreshed).toEqual(['r1']);
    expect(h.row().state).toBe('current');
    await h.tick();
    await h.tick();
    expect(h.indexed).toHaveLength(1);

    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\nexport function crew0183Probe(): number { return 1; }\n');
    await h.tick();
    expect(h.row().state).toBe('changed');
    expect(h.indexed).toHaveLength(1);
    await h.tick();
    expect(h.indexed).toHaveLength(2);
    expect(h.row().state).toBe('current');

    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'probe');
    await h.tick();
    await h.tick();
    expect(h.indexed).toHaveLength(3);
    git(repo, 'switch', '-q', '-c', 'b2');
    await h.tick();
    await h.tick();
    expect(h.indexed).toHaveLength(4);
  });

  it('indexes under continuous change once the change is 60 s old', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    let n = 0;
    const churn = (): void => writeFileSync(join(repo, 'src', 'a.ts'), `export const a = ${++n};\n`);
    let elapsed = 0;
    while (h.indexed.length < 2 && elapsed <= CHANGE_MAX_WAIT_MS + 2 * POLL_MIN_MS) {
      churn();
      await new Promise((r) => setTimeout(r, 5)); // a distinct mtime
      await h.tick();
      elapsed += POLL_MIN_MS;
    }
    expect(h.indexed).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(CHANGE_MAX_WAIT_MS);
  });

  it('waits while a run executes on the repo, and while a domain mapping is parked; a parked ordinary run does not hold it', async () => {
    const h = harness({ views: [view('run-a', 'executing', 'feature')] });
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toEqual([]);
    expect(h.row().state).toBe('waiting-runs');
    expect(h.row().waitingOn).toEqual([{ runId: 'run-a', reason: 'executing' }]);

    h.state.views = [view('run-a', 'awaiting_human', 'feature'), view('dx', 'awaiting_human', 'domain-extraction')];
    await h.tick();
    expect(h.indexed).toEqual([]);
    expect(h.row().waitingOn).toEqual([{ runId: 'dx', reason: 'domain-mapping' }]);

    h.state.views = [view('run-a', 'awaiting_human', 'feature'), view('dx', 'completed', 'domain-extraction'), view('c', 'executing', 'chat')];
    await h.tick();
    expect(h.indexed).toEqual(['r1']);
    expect(h.row().state).toBe('current');
  });

  it('brings the graph back to the checkout after a launch on the repo (its D8 moved it to the run base)', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    h.state.views = [view('run-b', 'completed', 'feature')];
    await h.tick();
    expect(h.indexed).toHaveLength(2);
    await h.tick();
    expect(h.indexed).toHaveLength(2);
  });

  it('catches up at boot from its record, and does not re-index an unchanged checkout after a restart', async () => {
    const a = harness();
    await a.tick(0);
    await a.tick();
    expect(a.indexed).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(dir, 'state', 'repo-watch.json'), 'utf8')) as { repos: Record<string, { indexedFp?: string }> };
    expect(saved.repos['r1']?.indexedFp).toMatch(/^[0-9a-f]{64}$/);

    const b = harness();
    await b.tick(0);
    await b.tick();
    expect(b.indexed).toEqual([]);

    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 9;\n'); // edited while the daemon was down
    const c = harness();
    await c.tick(0);
    await c.tick();
    expect(c.indexed).toEqual(['r1']);
  });

  it('reports a failed index with a remedy, backs off, and Re-index now retries at once', async () => {
    const h = harness({ failIndex: 'could not run the `wicked-estate` indexer: No such file or directory' });
    await h.tick(0);
    await h.tick();
    expect(h.row().state).toBe('failed');
    expect(h.row().remedy).toMatch(/wicked-estate is not available.*Re-index now/);
    await h.tick();
    expect(h.row().state).toBe('failed');
    h.state.failIndex = null;
    await h.tick();
    expect(h.indexed).toEqual([]); // backing off
    expect((await h.w.reindexNow('r1')).queued).toBe(true);
    await h.tick(0);
    expect(h.indexed).toEqual(['r1']);
    expect(h.row().state).toBe('current');
  });

  it('Re-index now is refused while a run holds the map, naming it', async () => {
    const h = harness({ views: [view('dx', 'executing', 'domain-extraction')] });
    await h.tick(0);
    const out = await h.w.reindexNow('r1');
    expect(out).toEqual({ queued: false, waitingOn: [{ runId: 'dx', reason: 'domain-mapping' }] });
  });

  it('turned off for a repo polls and indexes nothing, survives a restart, and turns back on', async () => {
    const h = harness();
    await h.tick(0);
    await h.w.setEnabled('r1', false);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 5;\n');
    await h.tick();
    await h.tick();
    expect(h.indexed).toEqual([]);
    expect(h.row()).toMatchObject({ state: 'off', enabled: false });
    const again = harness();
    await again.tick(0);
    expect(again.row().state).toBe('off');
    await again.w.setEnabled('r1', true);
    await again.tick(0);
    await again.tick();
    expect(again.indexed).toEqual(['r1']);
  });

  it('a git failure shows a remedy and backs off', async () => {
    const h = harness({ gitFn: async () => { throw new Error('fatal: not a git repository'); } });
    await h.tick(0);
    expect(h.row().state).toBe('failed');
    expect(h.row().error).toMatch(/not a git repository/);
    expect(h.row().remedy).toMatch(/still exists and is a git repository/);
  });

  it('says what "current" covers, and never claims clusters', () => {
    const h = harness();
    expect(h.w.status().covers).toMatch(/Symbols, files and references/);
    expect(h.w.status().covers).not.toMatch(/clusters (are|is) current/i);
  });

  it('is off for the daemon with WICKED_CREW_REPO_WATCH=off', () => {
    expect(repoWatchEnabledByEnv({ WICKED_CREW_REPO_WATCH: 'off' })).toBe(false);
    expect(repoWatchEnabledByEnv({ WICKED_CREW_REPO_WATCH: '0' })).toBe(false);
    expect(repoWatchEnabledByEnv({})).toBe(true);
    expect(harness({ enabled: false }).w.status()).toMatchObject({ enabled: false, disabledBy: 'env' });
  });
});

describe('holdsOf', () => {
  it('names executing runs and domain mappings on THIS repo only; chats and terminal runs never hold', () => {
    expect(holdsOf([
      view('a', 'planning', 'feature'), view('b', 'awaiting_human', 'bug'), view('c', 'executing', 'chat'),
      view('d', 'failed', 'domain-extraction'), view('e', 'executing', 'feature', 'other'), view('f', 'awaiting_human', 'domain-extraction'),
    ], 'r1')).toEqual([{ runId: 'a', reason: 'executing' }, { runId: 'f', reason: 'domain-mapping' }]);
  });
});
