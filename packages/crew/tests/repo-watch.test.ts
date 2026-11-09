// crew-0183: the repo watcher keeps an onboarded repo's code map current with no click (wicked-core#1230). Over a
// REAL temp git repo (the poll is real git) and FAKE engine/registry/run views; a fake clock drives the cadence.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RepoEntry, SessionView } from '../src/core/types.js';
import {
  CHANGE_MAX_WAIT_MS,
  INDEX_BACKOFF_BASE_MS,
  POLL_ARGS,
  REPO_WATCH_CAP,
  indexRemedy,
  POLL_MAX_MS,
  POLL_MIN_MS,
  QUIET_MS,
  pollPeriod,
  RepoWatcher,
  countsAsChange,
  fingerprintOf,
  holdsOf,
  outsideDirs,
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

function harness(opts: { views?: SessionView[]; failIndex?: string | null; enabled?: boolean; gitFn?: GitFn; extra?: RepoEntry[] } = {}) {
  let t = 1_000_000;
  const state = { views: opts.views ?? [], failIndex: opts.failIndex ?? null, heldBy: [] as string[], refreshOk: true, gate: null as Promise<void> | null, entered: null as (() => void) | null };
  const indexed: string[] = [];
  const refreshed: string[] = [];
  const entry: RepoEntry = { id: 'r1', name: 'r1', root_path: repo, default_branch: 'main', registered_at: 1, code_graph_db: graphDb } as RepoEntry;
  const w = new RepoWatcher({
    listRepos: async () => [entry, ...(opts.extra ?? [])],
    runViews: async () => state.views,
    indexRepoGraph: async (id) => {
      if (state.failIndex !== null) throw new Error(state.failIndex);
      if (state.heldBy.length > 0) return { outcome: 'held', heldBy: state.heldBy };
      if (state.gate !== null) { state.entered?.(); await state.gate; }
      indexed.push(id);
      return { outcome: 'indexed' };
    },
    refreshProjects: async (id) => { refreshed.push(id); return state.refreshOk; },
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
  const row = (id = 'r1') => w.status().repos.find((r) => r.repoId === id)!;
  return { w, tick, row, indexed, refreshed, state, advance: (ms: number) => { t += ms; }, now: () => t };
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
      { code: '2 R.', path: 'src/new.ts', from: 'src/old.ts' },
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

  it('a rename into an ignored directory still counts: the source file is gone (codex r2)', async () => {
    const rename = parsePorcelainV2(['# branch.oid 1111111111111111111111111111111111111111', '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa bbb R100 dist/a.ts', 'src/a.ts', ''].join('\0'));
    expect(rename.entries).toEqual([{ code: '2 R.', path: 'dist/a.ts', from: 'src/a.ts' }]);
    const clean = parsePorcelainV2('# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0');
    expect((await fingerprintOf(repo, rename, null)).fingerprint).not.toBe((await fingerprintOf(repo, clean, null)).fingerprint);
  });

  it('a changed file too big to hash moves the fingerprint once a minute (codex r2)', async () => {
    const st = { size: 10 * 1024 * 1024, mtimeMs: 5 };
    const status = parsePorcelainV2('# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0? big.bin\0');
    const a = await fingerprintOf(repo, status, null, async () => st, async () => null, () => 0);
    const b = await fingerprintOf(repo, status, null, async () => st, async () => null, () => CHANGE_MAX_WAIT_MS);
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });

  it.runIf(process.platform !== 'win32')('hashes a symlink by its target text and never reads a FIFO or a big target (codex r2)', async () => {
    const big = join(dir, 'big.txt');
    writeFileSync(big, 'x'.repeat(200_000));
    symlinkSync(big, join(repo, 'src', 'link.ts'));
    execFileSync('mkfifo', [join(repo, 'src', 'pipe')]);
    const status = parsePorcelainV2(await pollGit(repo, POLL_ARGS));
    const started = Date.now();
    const fp = await fingerprintOf(repo, status, null);
    expect(Date.now() - started).toBeLessThan(5_000); // the FIFO never blocked it
    expect(fp.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sees a same-size edit inside one mtime tick (small files are hashed) and is coarse but not blind past the stat cap', async () => {
    const st: { size: number; mtimeMs: number } = { size: 21, mtimeMs: 5 };
    const status = parsePorcelainV2('# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0? src/x.ts\0');
    let bytes = Buffer.from('export const x = 111;');
    const a = await fingerprintOf(repo, status, null, async () => st, async () => bytes);
    bytes = Buffer.from('export const x = 222;');
    const b = await fingerprintOf(repo, status, null, async () => st, async () => bytes);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    const many = parsePorcelainV2(['# branch.oid 1111111111111111111111111111111111111111', '# branch.head main',
      ...Array.from({ length: 2_001 }, (_, i) => `? gen/f${i}.ts`)].join('\0'));
    let t = 0;
    const c1 = await fingerprintOf(repo, many, null, async () => st, async () => null, () => t);
    const c2 = await fingerprintOf(repo, many, null, async () => st, async () => null, () => t + 1_000);
    t = CHANGE_MAX_WAIT_MS;
    const c3 = await fingerprintOf(repo, many, null, async () => st, async () => null, () => t);
    expect(c1.coarse).toBe(true);
    expect(c2.fingerprint).toBe(c1.fingerprint);
    expect(c3.fingerprint).not.toBe(c1.fingerprint); // a minute on, it moves: indexed within ~1 min, never "current" forever
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('leaves no fsmonitor daemon behind in a repo that configures one', async () => {
    git(repo, 'config', 'core.fsmonitor', 'true');
    try {
      await pollGit(repo, POLL_ARGS);
      await new Promise((r) => setTimeout(r, 500));
      const st = spawnSync('git', ['fsmonitor--daemon', 'status'], { cwd: repo, encoding: 'utf8' });
      expect(`${st.stdout}${st.stderr}`).toMatch(/not watching/i);
      // Control: a plain status in the same repo DOES start one (so the assertion above can fail).
      spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      await new Promise((r) => setTimeout(r, 500));
      const after = spawnSync('git', ['fsmonitor--daemon', 'status'], { cwd: repo, encoding: 'utf8' });
      expect(`${after.stdout}${after.stderr}`).toMatch(/is watching/i);
    } finally {
      // Never left behind, whichever assertion fails (codex r1).
      spawnSync('git', ['fsmonitor--daemon', 'stop'], { cwd: repo, encoding: 'utf8' });
    }
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
    // Each write a different length, so a 1 s mtime filesystem still sees it (pi r1).
    const churn = (): void => writeFileSync(join(repo, 'src', 'a.ts'), `export const a = ${'1'.repeat(++n)};\n`);
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

  it('brings the graph back to the checkout after a launch on the repo (its D8 moved it to the run base), once, durably', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    h.advance(1);
    h.w.noteLaunch('r1');
    h.state.views = [view('run-b', 'executing', 'feature')];
    await h.tick();
    expect(h.indexed).toHaveLength(1); // the run holds its base
    h.state.views = [view('run-b', 'completed', 'feature')];
    await h.tick();
    expect(h.indexed).toHaveLength(2);
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.indexed).toHaveLength(2); // never again for the same launch
    // Hundreds of finished runs on the repo cost nothing (codex + pi r1: a capped run list re-indexed every poll).
    h.state.views = Array.from({ length: 250 }, (_, i) => view(`old-${i}`, 'completed', 'feature'));
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.indexed).toHaveLength(2);
    // A launch noted before a restart is still owed after it.
    h.advance(1);
    h.w.noteLaunch('r1');
    await h.w.stop();
    const again = harness();
    await again.tick(0);
    await again.tick();
    expect(again.indexed).toEqual(['r1']);
  });

  it('the engine\'s own hold check wins: a launch between crew\'s read and the index leaves nothing written', async () => {
    const h = harness();
    h.state.heldBy = ['run-late'];
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toEqual([]);
    expect(h.row()).toMatchObject({ state: 'waiting-runs', waitingOn: [{ runId: 'run-late', reason: 'executing' }] });
    h.state.heldBy = [];
    await h.tick();
    expect(h.indexed).toEqual(['r1']);
  });

  it('catches up at boot from its record: once per start (a launch during startup left no count; codex r4), then quiet', async () => {
    const a = harness();
    await a.tick(0);
    await a.tick();
    expect(a.indexed).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(dir, 'state', 'repo-watch.json'), 'utf8')) as { repos: Record<string, { indexedFp?: string }> };
    expect(saved.repos['r1']?.indexedFp).toMatch(/^[0-9a-f]{64}$/);

    const b = harness();
    await b.tick(0);
    await b.tick();
    expect(b.indexed).toEqual(['r1']); // the once-per-start catch-up
    await b.tick();
    await b.tick();
    expect(b.indexed).toEqual(['r1']);

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
    // Changes keep coming while it backs off: still no retry (codex r1: churn bypassed the backoff).
    h.state.failIndex = 'the indexer failed (exit status: 3)';
    let attempts = 0;
    const counting = h.state;
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(repo, 'src', 'a.ts'), `export const a = ${'2'.repeat(i + 1)};\n`);
      await h.tick();
      if (h.row().error === counting.failIndex) attempts++;
    }
    expect(attempts).toBe(0);
    h.state.failIndex = null;
    expect((await h.w.reindexNow('r1')).queued).toBe(true);
    await h.tick(0);
    expect(h.indexed).toEqual(['r1']);
    expect(h.row().state).toBe('current');
  });

  it('names the engine\'s own timeout in its remedy', () => {
    expect(indexRemedy('the indexer exceeded 120s and was killed')).toMatch(/longer than 2 minutes/);
    expect(indexRemedy('the indexer exceeded 45s and was killed')).toMatch(/longer than 45 seconds/);
  });

  it('Re-index now while a run holds the map names it, and is kept: it runs when the run lets go', async () => {
    const h = harness({ views: [view('dx', 'executing', 'domain-extraction')] });
    await h.tick(0);
    await h.tick();
    const out = await h.w.reindexNow('r1');
    expect(out).toEqual({ queued: false, waitingOn: [{ runId: 'dx', reason: 'domain-mapping' }] });
    await h.tick();
    expect(h.indexed).toEqual([]);
    h.state.views = [view('dx', 'completed', 'domain-extraction')];
    await h.tick();
    expect(h.indexed).toEqual(['r1']);
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
    // Re-index now on a repo that is off runs once and leaves it off (codex r1: it turned polling back on).
    expect((await h.w.reindexNow('r1')).queued).toBe(true);
    await h.tick(0);
    expect(h.indexed).toEqual(['r1']);
    expect(h.row()).toMatchObject({ state: 'off', enabled: false });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 55;\n');
    await h.tick();
    await h.tick();
    expect(h.indexed).toEqual(['r1']);
    const again = harness();
    await again.tick(0);
    expect(again.row()).toMatchObject({ state: 'off', enabled: false });
    await again.w.setEnabled('r1', true);
    await again.tick(0);
    await again.tick();
    expect(again.indexed).toEqual(['r1']);
  });

  it('an unknown repo id changes nothing, and `__proto__` is just an unknown id (codex + pi r1)', async () => {
    const h = harness();
    await h.tick(0);
    expect(await h.w.setEnabled('__proto__', false)).toBe(false);
    expect(await h.w.setEnabled('nope', false)).toBe(false);
    expect(({} as Record<string, unknown>)['enabled']).toBeUndefined();
    await h.tick();
    expect(h.row()).toMatchObject({ enabled: true });
    const saved = existsSync(join(dir, 'state', 'repo-watch.json')) ? readFileSync(join(dir, 'state', 'repo-watch.json'), 'utf8') : '{}';
    expect(saved).not.toMatch(/nope|__proto__/);
  });

  it('a malformed record is dropped, never a stall: the repo indexes once', async () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    writeFileSync(join(dir, 'state', 'repo-watch.json'), JSON.stringify({ version: 1, repos: { r1: { indexedFp: 7, runsSeen: 123, launchedAt: 'x', enabled: 'no' }, r2: 'junk', __proto__: { enabled: false } } }));
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toEqual(['r1']);
    expect(h.row()).toMatchObject({ state: 'current', enabled: true });
  });

  it('the cap counts enabled repos: turning one off frees its slot, and a capped repo can still be re-indexed by hand', async () => {
    const extra = Array.from({ length: REPO_WATCH_CAP }, (_, i) => {
      const root = join(dir, `x${i}`);
      mkdirSync(root);
      return { id: `x${String(i).padStart(2, '0')}`, name: `x${i}`, root_path: root, default_branch: 'main', registered_at: 2 + i, code_graph_db: graphDb } as RepoEntry;
    });
    const h = harness({ extra, gitFn: async () => '# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0' });
    await h.tick(0);
    const last = extra[extra.length - 1]!.id;
    expect(h.row(last)).toMatchObject({ state: 'capped', enabled: true });
    expect(h.row(last).remedy).toMatch(/Turn another repository off/);
    expect((await h.w.reindexNow(last)).queued).toBe(true);
    for (let i = 0; i < 40 && !h.indexed.includes(last); i++) await h.w.step();
    expect(h.indexed).toContain(last);
    expect(h.row(last).state).toBe('capped');
    expect(await h.w.setEnabled('x00', false)).toBe(true);
    expect(h.row(last).state).not.toBe('capped');
  });

  it('the loop runs one step at a time: a press during a slow poll waits for it; stop() waits for the step in flight', async () => {
    let inFlight = 0;
    let most = 0;
    let entered: (() => void) | null = null;
    const enteredP = new Promise<void>((r) => { entered = r; });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let polls = 0;
    const h = harness({
      gitFn: async (cwd, args) => {
        inFlight++; most = Math.max(most, inFlight); polls++;
        if (polls === 1) { entered!(); await gate; }
        const out = await pollGit(cwd, args);
        inFlight--;
        return out;
      },
    });
    h.w.start();
    await enteredP; // the boot poll is running, held at the gate
    void h.w.reindexNow('r1'); // a press while it runs: owed, not a second step
    await new Promise((r) => setTimeout(r, 200));
    expect(most).toBe(1);
    let stopped = false;
    const stopping = h.w.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(stopped).toBe(false); // waits for the step in flight
    release!();
    await stopping;
    expect(stopped).toBe(true);
    const after = polls;
    await new Promise((r) => setTimeout(r, 600));
    expect(polls).toBe(after); // nothing runs after stop
    expect(most).toBe(1);
  });

  it('a press records the fingerprint it indexed (codex r2: A, edit to B, press, back to A read as current)', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1234567;\n'); // B
    await h.w.reindexNow('r1');
    await h.tick(0);
    expect(h.indexed).toHaveLength(2);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n'); // back to A (as committed)
    await h.tick();
    await h.tick();
    expect(h.indexed).toHaveLength(3);
  });

  it('a second press during an index is not consumed by it (codex r2)', async () => {
    const h = harness();
    await h.w.setEnabled('r1', false);
    let open: () => void = () => undefined;
    h.state.gate = new Promise<void>((r) => { open = r; });
    const entered = new Promise<void>((r) => { h.state.entered = r; });
    await h.w.reindexNow('r1');
    const stepping = (async () => { for (let i = 0; i < 2; i++) await h.w.step(); })(); // poll, then the gated index
    await entered; // the first index is running, held at the gate (codex r3: no sleep)
    await h.w.reindexNow('r1'); // pressed again while the first runs
    open();
    await stepping;
    h.state.gate = null;
    for (let i = 0; i < 4; i++) await h.w.step();
    expect(h.indexed).toHaveLength(2);
    expect(h.row()).toMatchObject({ state: 'off', enabled: false });
  });

  it('a switch between the quiet poll and the index is not certified current (codex r4: B queued, C indexed, B back)', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 222;\n'); // B
    h.advance(POLL_MIN_MS);
    await h.w.step(); // sees B
    h.advance(POLL_MIN_MS);
    await h.w.step(); // quiet: B queued
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 33333;\n'); // C, before the index runs
    await h.w.step(); // the index reads C right before it runs
    expect(h.indexed).toHaveLength(2);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 222;\n'); // back to B
    await h.tick();
    await h.tick();
    expect(h.indexed).toHaveLength(3); // B is not mistaken for what was indexed (C)
  });

  it('owed refreshes never starve the polls (codex r4)', async () => {
    const extra = ['p1', 'p2'].map((id, i) => { const root = join(dir, id); mkdirSync(root); return { id, name: id, root_path: root, default_branch: 'main', registered_at: 10 + i, code_graph_db: graphDb } as RepoEntry; });
    const h = harness({ extra, gitFn: async (cwd, args) => (cwd === repo ? pollGit(cwd, args) : '# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0') });
    await h.tick(0);
    for (const id of ['p1', 'p2']) await h.w.setEnabled(id, false);
    h.state.refreshOk = false;
    for (const id of ['p1', 'p2']) { await h.w.reindexNow(id); for (let i = 0; i < 6; i++) await h.w.step(); }
    const polledBefore = h.row('r1').lastPolledAt;
    h.advance(INDEX_BACKOFF_BASE_MS + POLL_MIN_MS);
    await h.w.step();
    expect(h.row('r1').lastPolledAt).not.toBe(polledBefore); // the enabled repo's poll came first
  });

  it('an owed project refresh retries on a repo that is not polled (off), and a press after an index was queued polls first (codex r3)', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    await h.w.setEnabled('r1', false);
    h.state.refreshOk = false;
    await h.w.reindexNow('r1');
    await h.tick(0);
    expect(h.indexed).toHaveLength(2);
    const before = h.refreshed.length;
    h.state.refreshOk = true;
    h.advance(INDEX_BACKOFF_BASE_MS);
    await h.tick();
    expect(h.refreshed.length).toBe(before + 1);
    expect(h.indexed).toHaveLength(2);
  });

  it('a press after an index was queued polls before it indexes (codex r3)', async () => {
    const h = harness();
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 31;\n');
    await h.advance(POLL_MIN_MS);
    await h.w.step(); // sees the change
    h.advance(POLL_MIN_MS);
    await h.w.step(); // quiet: queued under generation 0
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 3131;\n'); // B, after it was queued
    await h.w.reindexNow('r1');
    await h.w.step(); // the queued index sees a newer press: it polls first instead
    expect(h.indexed).toHaveLength(1);
    for (let i = 0; i < 3; i++) await h.w.step();
    expect(h.indexed).toHaveLength(2);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 31;\n'); // back to A: not current
    await h.tick();
    await h.tick();
    expect(h.indexed).toHaveLength(3);
  });

  it('a failed project refresh is owed and retried, backed off, without indexing again (codex r2)', async () => {
    const h = harness();
    h.state.refreshOk = false;
    await h.tick(0);
    await h.tick();
    expect(h.indexed).toHaveLength(1);
    expect(h.refreshed).toHaveLength(1);
    await h.tick();
    expect(h.refreshed).toHaveLength(1); // backed off
    h.state.refreshOk = true;
    h.advance(INDEX_BACKOFF_BASE_MS);
    await h.tick();
    expect(h.refreshed).toHaveLength(2);
    expect(h.indexed).toHaveLength(1);
    await h.tick();
    expect(h.refreshed).toHaveLength(2);
  });

  it('a launch noted before the records load never saves over them (codex r2)', async () => {
    const a = harness();
    await a.tick(0);
    await a.w.setEnabled('r1', false);
    const b = harness();
    await b.w.noteLaunch('r1'); // before b's first step loads anything
    await b.tick(0);
    expect(b.row()).toMatchObject({ state: 'off', enabled: false });
    const saved = JSON.parse(readFileSync(join(dir, 'state', 'repo-watch.json'), 'utf8')) as { repos: Record<string, { enabled?: boolean; launches?: number }> };
    expect(saved.repos['r1']).toMatchObject({ enabled: false, launches: 1 });
  });

  it('counters that disagree prove nothing: the repo indexes once (codex r2)', async () => {
    const a = harness();
    await a.tick(0);
    await a.tick();
    const path = join(dir, 'state', 'repo-watch.json');
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { version: 1; repos: Record<string, Record<string, unknown>> };
    saved.repos['r1'] = { ...saved.repos['r1'], indexedLaunches: 5 };
    writeFileSync(path, JSON.stringify(saved));
    const b = harness();
    await b.tick(0);
    await b.tick();
    expect(b.indexed).toEqual(['r1']);
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

describe('the cadence', () => {
  it('polls every max(5 s, 10x the last poll), never past 30 s; a change seen is polled again within the quiet window', async () => {
    expect(pollPeriod(0)).toBe(POLL_MIN_MS);
    expect(pollPeriod(1_812)).toBe(18_120); // the throwaway daemon's poll under load 57
    expect(pollPeriod(9_000)).toBe(POLL_MAX_MS);
    let t = 0;
    let pollMs = 9_000;
    const polls: number[] = [];
    const real: GitFn = pollGit;
    const w = new RepoWatcher({
      listRepos: async () => [{ id: 'r1', name: 'r1', root_path: repo, default_branch: 'main', registered_at: 1, code_graph_db: graphDb } as RepoEntry],
      runViews: async () => [], indexRepoGraph: async () => ({ outcome: 'indexed' }), refreshProjects: async () => true,
      statePath: join(dir, 'state', 'w.json'), stateHome: null, enabled: true, log: () => undefined, now: () => t,
      git: async (cwd, args) => { polls.push(t); const out = await real(cwd, args); t += pollMs; return out; },
    });
    await w.step(); // boot poll (slow: 9 s): no record yet, so a change — polled again in the quiet window, not 30 s on
    t += QUIET_MS;
    await w.step(); // the quiet poll → queued
    await w.step(); // the catch-up index (it reads the checkout right before and right after)
    expect(polls).toHaveLength(4);
    const after = polls[1]! + pollMs; // the end of the last POLL (the index's own reads are not polls)
    t = after + POLL_MAX_MS - 1;
    await w.step();
    expect(polls).toHaveLength(4); // idle: not before 30 s (10x 9 s would be 90 s)
    t = after + POLL_MAX_MS;
    await w.step();
    expect(polls).toHaveLength(5);
    pollMs = 0;
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 7;\n');
    t += POLL_MAX_MS;
    await w.step(); // sees the change
    expect(w.status().repos[0]?.state).toBe('changed');
    t += QUIET_MS;
    await w.step(); // the quiet check, 5 s later
    expect(polls).toHaveLength(7);
  });
});

describe('outsideDirs', () => {
  it.runIf(process.platform !== 'win32')('canonicalizes a graph root that does not exist yet through its existing ancestor (codex r3)', () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'link');
    symlinkSync(real, link);
    const out = outsideDirs(null, { WICKED_CREW_PROJECT_GRAPH_ROOT: join(link, 'later', 'graphs') });
    expect(out).toContain(join(realpathSync(real), 'later', 'graphs'));
  });
});

describe('codex r5', () => {
  it.runIf(process.platform !== 'win32')('the state home under the OTHER spelling of a checkout never counts', () => {
    const real = join(dir, 'realrepo');
    mkdirSync(join(real, 'state'), { recursive: true });
    const link = join(dir, 'linkrepo');
    symlinkSync(real, link);
    // Registered as the link; the state home spelled canonically.
    expect(countsAsChange('state/repo-watch.json', link, [join(realpathSync(real), 'state')])).toBe(false);
    expect(countsAsChange('src/a.ts', link, [join(realpathSync(real), 'state')])).toBe(true);
  });

  it('the minute tick moves the fingerprint, never the stable read an index is compared by', async () => {
    const st = { size: 10 * 1024 * 1024, mtimeMs: 5 };
    const status = parsePorcelainV2('# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0? big.bin\0');
    const a = await fingerprintOf(repo, status, null, async () => st, async () => null, () => 0);
    const b = await fingerprintOf(repo, status, null, async () => st, async () => null, () => 2 * CHANGE_MAX_WAIT_MS);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(b.stable).toBe(a.stable);
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
