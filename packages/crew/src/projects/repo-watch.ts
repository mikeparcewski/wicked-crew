/**
 * THE REPO WATCHER (crew-0183, wicked-core#1230): a registered repo's code graph follows its checkout
 * with no click. Without it the repo graph (onboarding's) and the project graphs (refreshed after
 * onboarding or by hand) stayed at whatever they were indexed at while the person edited, pulled,
 * committed and switched branches, and chats, Understand and runs read the stale graph.
 *
 * # One mechanism: git state, polled
 *
 * Per repo, ONE process: `git -c core.fsmonitor=false status --porcelain=v2 -z --branch
 * --untracked-files=all --ignore-submodules=dirty` with `GIT_OPTIONAL_LOCKS=0`. Its fingerprint is
 * HEAD (`branch.oid`), the branch (`branch.head`) and every listed entry with its size and mtime: a
 * commit or pull moves the oid, a switch the head, an edit to an already-modified file its stat, a
 * new file (nested in a new untracked directory too: `all`) adds an entry. Why not `fs.watch`:
 * recursive watching is emulated on Linux with one inotify watch per directory (node_modules
 * exhausts `max_user_watches`, no ignore option); git is the same on macOS, Linux and Windows, holds
 * no OS handle and already knows the ignore rules. `core.fsmonitor=false` because a repo-configured
 * fsmonitor would spawn a `git fsmonitor--daemon` per repo that outlives the poll; optional locks
 * off so a poll never takes `index.lock` beside the person's own git.
 *
 * # Bounded
 *
 * One poll at a time daemon-wide; a repo's next poll comes after `max(5 s, 20 × its last poll)`
 * (git stays under ~5% of a core per repo and slows itself on a loaded machine); a failing poll
 * backs off to 10 min. A change is indexed at the first later poll that sees the same fingerprint
 * (quiet for one poll), or 60 s after the first change under continuous churn. At most
 * {@link REPO_WATCH_CAP} repos. One index at a time (the queue below).
 *
 * # One writer
 *
 * The repo graph is written ONLY by the engine's `indexRepoGraph` (the onboarding index command,
 * under the lock a launch's D8 base index takes). It is never re-indexed while a run holds it at its
 * base: a run actively executing on the repo (its floor's affected set reads the graph at the base),
 * or a `domain-extraction` run, executing or parked (its pages read the graph with no base check,
 * #1230). A parked run does not hold it: its floor finds the graph not at its base and runs the full
 * suite, disclosed (core `floor_affected.rs`, `review_scale::graph_age`). Then every project the repo
 * is in is refreshed through the onboarding hook's own function. Nothing here re-runs
 * `clusters --annotate`: "current" covers symbols, files and references, never clusters.
 *
 * # Restart
 *
 * `<state home>/repo-watch.json` keeps, per repo, the fingerprint last indexed, when, the runs seen on
 * the repo then, and the off switch. At boot every repo's first poll compares against it and indexes
 * a difference (catch-up). A run on the repo that was not seen at the last index has had a launch's D8
 * move the graph to its base since, so the graph is brought back to the checkout once nothing holds it.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { RepoGraphWatch, RepoWatchHold, RepoWatchStatus } from 'wicked-crew-api-types';
import type { RepoEntry, SessionView } from '../core/types.js';
import { runNameOf } from '../core/run-identity.js';

export const REPO_WATCH_CAP = 24;
export const POLL_MIN_MS = 5_000;
/** A repo's poll period is at least this many times its last poll's duration. */
export const POLL_DUTY = 20;
export const POLL_BACKOFF_MAX_MS = 10 * 60_000;
export const CHANGE_MAX_WAIT_MS = 60_000;
export const INDEX_BACKOFF_BASE_MS = 60_000;
export const INDEX_BACKOFF_MAX_MS = 30 * 60_000;
/** Entries whose size and mtime are read per poll; past it the fingerprint is the status text alone. */
export const STAT_CAP = 2_000;
export const GIT_TIMEOUT_MS = 20_000;
/** How long the repo list is reused before it is read again. */
export const REPOS_TTL_MS = 30_000;
/** Run ids remembered per repo (the newest), to see a launch since the last index. */
const SEEN_RUNS_CAP = 200;

/** The poll, verbatim (pinned by a test): no fsmonitor daemon, nested untracked files, dirty submodules ignored. */
export const POLL_ARGS: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty',
];

/** Path segments a change under never counts (a repo that forgot to ignore its build output must not loop). */
export const IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'target', 'dist', 'wicked-worktrees', '.wicked']);

/** Runs that never read the repo graph at a base (a chat, its analysis, crew's one-turn readers). */
const NON_GRAPH_RUNS: ReadonlySet<string> = new Set(['chat', 'analyze', 'detect-shape', 'inspect-unit']);
const ACTIVE: ReadonlySet<string> = new Set(['planning', 'distributing', 'executing']);
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
/** The engine's `graph_required` preset (core `actor.rs`): its pages read the graph with no base check. */
export const DOMAIN_MAPPING = 'domain-extraction';

// ── The poll's output ─────────────────────────────────────────────────────────

export interface PorcelainStatus {
  oid: string | null;
  head: string | null;
  /** `<kind> <XY>` and the repo-relative path, in git's order. */
  entries: Array<{ code: string; path: string }>;
}

/** `git status --porcelain=v2 -z --branch` → HEAD, branch, entries (`2` rename entries carry their origin path as the next field). */
export function parsePorcelainV2(stdout: string): PorcelainStatus {
  const out: PorcelainStatus = { oid: null, head: null, entries: [] };
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f === '') continue;
    if (f.startsWith('# ')) {
      const [, key, ...rest] = f.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') out.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') out.head = value;
      continue;
    }
    const kind = f[0];
    if (kind === '?' || kind === '!') { out.entries.push({ code: kind, path: f.slice(2) }); continue; }
    // 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path\0orig | u XY sub m1 m2 m3 mW h1 h2 h3 path
    const fixed = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (fixed < 0) continue;
    const parts = f.split(' ');
    out.entries.push({ code: `${kind} ${parts[1] ?? ''}`, path: parts.slice(fixed).join(' ') });
    if (kind === '2') i++; // the origin path
  }
  return out;
}

/** Whether a change at `path` (repo-relative, `/`-separated) counts. */
export function countsAsChange(path: string, root: string, stateHome: string | null): boolean {
  const segs = path.split('/');
  if (segs.some((s) => IGNORED_SEGMENTS.has(s))) return false;
  if (stateHome !== null) {
    const rel = relative(stateHome, resolve(root, ...segs));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return false;
  }
  return true;
}

export type StatFn = (path: string) => Promise<{ size: number; mtimeMs: number } | null>;

const statOf: StatFn = async (p) => {
  try {
    const s = await lstat(p);
    return { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
  } catch {
    return null;
  }
};

/** The fingerprint of a repo's state on disk, from its poll. `coarse`: past {@link STAT_CAP}, only the status text counts. */
export async function fingerprintOf(
  root: string,
  status: PorcelainStatus,
  stateHome: string | null,
  stat: StatFn = statOf,
): Promise<{ fingerprint: string; coarse: boolean; changed: number }> {
  const entries = status.entries.filter((e) => countsAsChange(e.path, root, stateHome)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  h.update(`oid ${status.oid ?? '-'}\nhead ${status.head ?? '-'}\n`);
  const coarse = entries.length > STAT_CAP;
  for (const e of entries) {
    h.update(`${e.code} ${e.path}`);
    if (!coarse) {
      const s = await stat(join(root, ...e.path.split('/')));
      h.update(s === null ? ' gone' : ` ${s.size} ${s.mtimeMs}`);
    }
    h.update('\n');
  }
  return { fingerprint: h.digest('hex'), coarse, changed: entries.length };
}

export type GitFn = (cwd: string, args: readonly string[]) => Promise<string>;

/** The poll's git: optional locks off, hidden on Windows, bounded, output capped. */
export const pollGit: GitFn = (cwd, args) =>
  new Promise((ok, fail) => {
    execFile('git', [...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout) => (err ? fail(err) : ok(stdout)));
  });

// ── Who holds a repo's graph ──────────────────────────────────────────────────

/** The runs on `repoId` that hold its graph at their base now. */
export function holdsOf(views: readonly SessionView[], repoId: string): RepoWatchHold[] {
  const out: RepoWatchHold[] = [];
  for (const v of views) {
    if (v.session.repo_ref !== repoId || TERMINAL.has(v.session.status)) continue;
    const name = runNameOf(v);
    if (name === DOMAIN_MAPPING) out.push({ runId: v.session.id, reason: 'domain-mapping' });
    else if (ACTIVE.has(v.session.status) && !NON_GRAPH_RUNS.has(name ?? '')) out.push({ runId: v.session.id, reason: 'executing' });
  }
  return out;
}

// ── The watcher ───────────────────────────────────────────────────────────────

interface Persisted {
  version: 1;
  repos: Record<string, { indexedFp?: string; lastIndexedAt?: number; runsSeen?: string[]; enabled?: boolean }>;
}

interface RepoState {
  repoId: string;
  root: string;
  state: RepoGraphWatch['state'];
  seenFp: string | null;
  changedAt: number | null;
  nextPollAt: number;
  lastPolledAt: number | null;
  lastPollMs: number;
  pollFailures: number;
  indexFailures: number;
  indexBackoffUntil: number;
  failedFp: string | null;
  lastIndexMs: number | null;
  coarse: boolean;
  waitingOn: RepoWatchHold[];
  error: string | null;
  remedy: string | null;
  polls: number;
  indexes: number;
  /** A person pressed Re-index now: the quiet window and the backoff are skipped once. */
  forced: boolean;
}

export interface RepoWatchDeps {
  listRepos: () => Promise<RepoEntry[]>;
  runViews: () => Promise<readonly SessionView[]>;
  /** The engine's checkout re-index (core-ts `indexRepoGraph`). */
  indexRepoGraph: (repoId: string) => Promise<{ outcome: 'indexed' | 'no-graph' }>;
  /** Refresh every project the repo is in (`refreshProjectGraphsForRepo`). */
  refreshProjects: (repoId: string) => Promise<void>;
  /** `<state home>/repo-watch.json`. */
  statePath: string;
  /** The daemon's state home (changes under it never count). */
  stateHome: string | null;
  /** `false` when `WICKED_CREW_REPO_WATCH=off`: nothing is polled; the status says why. */
  enabled: boolean;
  log: (msg: string) => void;
  now?: () => number;
  git?: GitFn;
  stat?: StatFn;
  exists?: (p: string) => boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The person-facing remedy for an index failure (the engine's words name the cause). */
export function indexRemedy(error: string): string {
  if (/could not run the .* indexer/i.test(error)) return 'wicked-estate is not available to the daemon. Install it, then press Re-index now.';
  if (/exceeded \d+s/i.test(error)) return 'The re-index took longer than 2 minutes and was stopped. Press Re-index now to try again; a very large change may need the repository to be onboarded again.';
  if (/no registered repo/i.test(error)) return 'The repository is no longer registered. Register it again on Repositories.';
  return 'Press Re-index now to try again. If it keeps failing, onboard the repository again from its page.';
}

export function pollRemedy(): string {
  return 'Check that the folder still exists and is a git repository, and that git is installed.';
}

export class RepoWatcher {
  private readonly now: () => number;
  private readonly git: GitFn;
  private readonly stat: StatFn;
  private readonly exists: (p: string) => boolean;
  private persisted: Persisted = { version: 1, repos: {} };
  private loaded = false;
  private readonly repos = new Map<string, RepoState>();
  private capped: string[] = [];
  private reposReadAt = -Infinity;
  private readonly queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private stepping: Promise<void> | null = null;

  constructor(private readonly deps: RepoWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.git = deps.git ?? pollGit;
    this.stat = deps.stat ?? statOf;
    this.exists = deps.exists ?? existsSync;
  }

  /** Start the loop (no-op when off). */
  start(): void {
    if (!this.deps.enabled || this.running) return;
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.stepping?.catch(() => undefined);
  }

  private schedule(ms: number): void {
    if (this.stopped || !this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.stepping = this.step().catch((err: unknown) => this.deps.log(`[repo-watch] step failed: ${message(err)}`));
      void this.stepping.finally(() => this.schedule(this.delay()));
    }, ms);
    this.timer.unref?.();
  }

  /** How long until the next thing is due (bounded 250 ms … 1 s, so a new repo or a press is picked up). */
  private delay(): number {
    if (this.queue.length > 0) return 0;
    const t = this.now();
    let next = Infinity;
    for (const r of this.repos.values()) if (r.state !== 'off') next = Math.min(next, r.nextPollAt - t);
    return Math.max(250, Math.min(1_000, Number.isFinite(next) ? next : 1_000));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.deps.statePath, 'utf8')) as Persisted;
      if (raw?.version === 1 && raw.repos !== null && typeof raw.repos === 'object') this.persisted = raw;
    } catch {
      // Missing or unreadable: every repo indexes once (the safe direction).
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.deps.statePath), { recursive: true });
    const tmp = `${this.deps.statePath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.persisted, null, 2), 'utf8');
    await rename(tmp, this.deps.statePath);
  }

  private rec(repoId: string): Persisted['repos'][string] {
    return (this.persisted.repos[repoId] ??= {});
  }

  /** Re-read the registry: onboarded repos with a folder, the first {@link REPO_WATCH_CAP} watched. */
  async syncRepos(force = false): Promise<void> {
    await this.load();
    const t = this.now();
    if (!force && t - this.reposReadAt < REPOS_TTL_MS) return;
    this.reposReadAt = t;
    const all = (await this.deps.listRepos())
      .filter((r) => typeof r.code_graph_db === 'string' && r.code_graph_db !== '' && this.exists(r.code_graph_db) && this.exists(r.root_path))
      .sort((a, b) => (a.registered_at ?? 0) - (b.registered_at ?? 0) || (a.id < b.id ? -1 : 1));
    const watched = all.slice(0, REPO_WATCH_CAP);
    this.capped = all.slice(REPO_WATCH_CAP).map((r) => r.id);
    const keep = new Set(watched.map((r) => r.id));
    for (const id of [...this.repos.keys()]) if (!keep.has(id)) this.repos.delete(id);
    for (const r of watched) {
      const cur = this.repos.get(r.id);
      if (cur !== undefined) { cur.root = r.root_path; continue; }
      const off = this.rec(r.id).enabled === false;
      this.repos.set(r.id, {
        repoId: r.id, root: r.root_path, state: off ? 'off' : 'starting', seenFp: null, changedAt: null,
        nextPollAt: t, lastPolledAt: null, lastPollMs: 0, pollFailures: 0, indexFailures: 0, indexBackoffUntil: 0,
        failedFp: null, lastIndexMs: null, coarse: false, waitingOn: [], error: null, remedy: null, polls: 0, indexes: 0, forced: false,
      });
    }
  }

  /** One unit of work: the next queued index, else the most overdue poll. Exposed for tests. */
  async step(): Promise<void> {
    await this.syncRepos();
    const queued = this.queue.shift();
    if (queued !== undefined) {
      await this.index(queued);
      return;
    }
    const t = this.now();
    let due: RepoState | null = null;
    for (const r of this.repos.values()) {
      if (r.state === 'off' || r.nextPollAt > t) continue;
      if (due === null || r.nextPollAt < due.nextPollAt) due = r;
    }
    if (due !== null) await this.poll(due);
  }

  private async poll(r: RepoState): Promise<void> {
    const started = this.now();
    let fp: { fingerprint: string; coarse: boolean };
    try {
      const out = await this.git(r.root, POLL_ARGS);
      fp = await fingerprintOf(r.root, parsePorcelainV2(out), this.deps.stateHome, this.stat);
    } catch (err) {
      r.pollFailures++;
      r.lastPolledAt = this.now();
      r.nextPollAt = r.lastPolledAt + Math.min(POLL_BACKOFF_MAX_MS, POLL_MIN_MS * 2 ** r.pollFailures);
      r.state = 'failed';
      r.error = `git could not read the folder: ${message(err).split('\n')[0]}`;
      r.remedy = pollRemedy();
      return;
    }
    const ended = this.now();
    r.polls++;
    r.pollFailures = 0;
    r.lastPolledAt = ended;
    r.lastPollMs = ended - started;
    r.nextPollAt = ended + Math.max(POLL_MIN_MS, POLL_DUTY * r.lastPollMs);
    r.coarse = fp.coarse;
    if (r.state === 'failed' && r.failedFp === null) { r.error = null; r.remedy = null; }
    await this.decide(r, fp.fingerprint, ended);
  }

  private async decide(r: RepoState, fp: string, t: number): Promise<void> {
    const rec = this.rec(r.repoId);
    const views = await this.deps.runViews();
    const onRepo = views.filter((v) => v.session.repo_ref === r.repoId).map((v) => v.session.id);
    const seen = new Set(rec.runsSeen ?? []);
    // A launch since the last index ran its D8: the graph may sit at that run's base now.
    const moved = onRepo.some((id) => !seen.has(id));
    const wants = r.forced || rec.indexedFp !== fp || moved;
    if (!wants) {
      r.seenFp = fp;
      r.changedAt = null;
      r.waitingOn = [];
      if (r.state !== 'failed' || r.failedFp !== fp) { r.state = 'current'; r.error = null; r.remedy = null; r.failedFp = null; }
      return;
    }
    let due = r.forced;
    if (!due) {
      if (r.seenFp !== fp) {
        r.seenFp = fp;
        r.changedAt ??= t;
        due = t - r.changedAt >= CHANGE_MAX_WAIT_MS || (rec.indexedFp !== undefined && rec.indexedFp === fp && moved);
      } else {
        due = true; // quiet for one poll
      }
    }
    r.changedAt ??= t;
    if (!due) { if (r.state !== 'failed') r.state = 'changed'; return; }
    if (!r.forced && r.failedFp === fp && t < r.indexBackoffUntil) return; // the same state failed: wait out the backoff
    const holds = holdsOf(views, r.repoId);
    if (holds.length > 0) {
      r.state = 'waiting-runs';
      r.waitingOn = holds;
      return;
    }
    r.waitingOn = [];
    if (!this.queue.includes(r.repoId)) this.queue.push(r.repoId);
    if (r.state !== 'indexing') r.state = 'changed';
  }

  private async index(repoId: string): Promise<void> {
    const r = this.repos.get(repoId);
    if (r === undefined || r.state === 'off') return;
    // Re-checked at the start: a run may have started on the repo since the poll queued this.
    const views = await this.deps.runViews();
    const holds = holdsOf(views, repoId);
    if (holds.length > 0) { r.state = 'waiting-runs'; r.waitingOn = holds; r.forced = false; return; }
    const fp = r.seenFp;
    const runsSeen = views.filter((v) => v.session.repo_ref === repoId).map((v) => v.session.id).slice(-SEEN_RUNS_CAP);
    r.state = 'indexing';
    r.forced = false;
    const started = this.now();
    try {
      const { outcome } = await this.deps.indexRepoGraph(repoId);
      r.lastIndexMs = this.now() - started;
      if (outcome === 'no-graph') {
        r.state = 'failed';
        r.failedFp = fp;
        r.error = 'This repository has no code map yet.';
        r.remedy = 'Onboard it from its page; the code map is kept current from then on.';
        return;
      }
      r.indexes++;
      r.indexFailures = 0;
      r.indexBackoffUntil = 0;
      r.failedFp = null;
      r.error = null;
      r.remedy = null;
      const rec = this.rec(repoId);
      if (fp !== null) rec.indexedFp = fp;
      rec.lastIndexedAt = this.now();
      rec.runsSeen = runsSeen;
      await this.save().catch((err: unknown) => this.deps.log(`[repo-watch] could not save ${this.deps.statePath}: ${message(err)}`));
      try {
        await this.deps.refreshProjects(repoId);
      } catch (err) {
        this.deps.log(`[repo-watch] ${repoId}: project graph refresh failed: ${message(err)}`);
      }
      r.state = 'current';
      r.changedAt = null;
      this.deps.log(`[repo-watch] ${repoId}: code map re-indexed in ${r.lastIndexMs} ms`);
    } catch (err) {
      r.lastIndexMs = this.now() - started;
      r.indexFailures++;
      r.indexBackoffUntil = this.now() + Math.min(INDEX_BACKOFF_MAX_MS, INDEX_BACKOFF_BASE_MS * 2 ** (r.indexFailures - 1));
      r.failedFp = fp;
      r.state = 'failed';
      r.error = message(err).split('\n')[0] ?? 'the re-index failed';
      r.remedy = indexRemedy(r.error);
      this.deps.log(`[repo-watch] ${repoId}: re-index FAILED: ${r.error}`);
    }
  }

  /** An onboarding run of this repo completed: its graph IS the checkout now (no second index). */
  async adopt(repoId: string): Promise<void> {
    await this.syncRepos(true);
    const r = this.repos.get(repoId);
    if (r === undefined) return;
    try {
      const fp = await fingerprintOf(r.root, parsePorcelainV2(await this.git(r.root, POLL_ARGS)), this.deps.stateHome, this.stat);
      const views = await this.deps.runViews();
      const rec = this.rec(repoId);
      rec.indexedFp = fp.fingerprint;
      rec.lastIndexedAt = this.now();
      rec.runsSeen = views.filter((v) => v.session.repo_ref === repoId).map((v) => v.session.id).slice(-SEEN_RUNS_CAP);
      r.seenFp = fp.fingerprint;
      if (r.state !== 'off') r.state = 'current';
      await this.save();
    } catch (err) {
      this.deps.log(`[repo-watch] ${repoId}: could not record the onboarded checkout: ${message(err)}`);
    }
  }

  /** A person pressed Re-index now: queued at the next poll, past the quiet window and any backoff, unless a run holds the graph. */
  async reindexNow(repoId: string): Promise<{ queued: boolean; waitingOn: RepoWatchHold[]; unknown?: true }> {
    await this.syncRepos(true);
    const r = this.repos.get(repoId);
    if (r === undefined) return { queued: false, waitingOn: [], unknown: true };
    const holds = holdsOf(await this.deps.runViews(), repoId);
    if (holds.length > 0) { r.state = 'waiting-runs'; r.waitingOn = holds; return { queued: false, waitingOn: holds }; }
    r.forced = true;
    r.nextPollAt = this.now();
    if (r.state === 'off') r.state = 'starting';
    this.schedule(0);
    return { queued: true, waitingOn: [] };
  }

  /** The per-repo off switch (persisted). */
  async setEnabled(repoId: string, enabled: boolean): Promise<boolean> {
    await this.syncRepos(true);
    const r = this.repos.get(repoId);
    const rec = this.rec(repoId);
    if (enabled) delete rec.enabled;
    else rec.enabled = false;
    await this.save();
    if (r === undefined) return false;
    if (!enabled) { r.state = 'off'; r.waitingOn = []; this.queue.splice(0, this.queue.length, ...this.queue.filter((id) => id !== repoId)); }
    else if (r.state === 'off') { r.state = 'starting'; r.nextPollAt = this.now(); this.schedule(0); }
    return true;
  }

  /** The wire status (`GET /repo-watch`). */
  status(): RepoWatchStatus {
    const repos: RepoGraphWatch[] = [...this.repos.values()].map((r) => ({
      repoId: r.repoId,
      state: r.state,
      enabled: r.state !== 'off',
      lastIndexedAt: this.persisted.repos[r.repoId]?.lastIndexedAt ?? null,
      lastPolledAt: r.lastPolledAt,
      changedAt: r.changedAt,
      waitingOn: r.waitingOn,
      error: r.error,
      remedy: r.remedy,
    }));
    for (const id of this.capped) {
      repos.push({ repoId: id, state: 'capped', enabled: this.persisted.repos[id]?.enabled !== false, lastIndexedAt: this.persisted.repos[id]?.lastIndexedAt ?? null, lastPolledAt: null, changedAt: null, waitingOn: [], error: null, remedy: `Studio keeps up to ${REPO_WATCH_CAP} repositories current; press Re-index now on its page after a change, or turn another repository off.` });
    }
    return { enabled: this.deps.enabled, disabledBy: this.deps.enabled ? null : 'env', cap: REPO_WATCH_CAP, covers: COVERS, repos };
  }

  /** `diagnostics.repoWatch`: the status plus the loop's own numbers. */
  diagnostics(): Record<string, unknown> {
    return {
      ...this.status(),
      queue: [...this.queue],
      watched: this.repos.size,
      perRepo: [...this.repos.values()].map((r) => ({
        repoId: r.repoId, state: r.state, periodMs: Math.max(POLL_MIN_MS, POLL_DUTY * r.lastPollMs), lastPollMs: r.lastPollMs,
        lastIndexMs: r.lastIndexMs, polls: r.polls, indexes: r.indexes, pollFailures: r.pollFailures, indexFailures: r.indexFailures,
        coarse: r.coarse, nextPollInMs: Math.max(0, r.nextPollAt - this.now()),
      })),
    };
  }
}

/** What "current" covers, on the wire so no surface claims more. */
export const COVERS = 'Symbols, files and references for what is on disk now. Clusters refresh when the repository is onboarded again.';

/** `WICKED_CREW_REPO_WATCH=off` (also `0`, `false`, `no`) turns the watcher off for the daemon. */
export function repoWatchEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['WICKED_CREW_REPO_WATCH'] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** Exposed for the path tests (`sep`-independent). */
export const __test = { sep };
