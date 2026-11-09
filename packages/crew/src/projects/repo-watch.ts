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
 * One poll at a time daemon-wide; a repo's next poll comes after `max(5 s, 10 × its last poll)`,
 * at most 30 s (git takes ~10% of the loop's time per repo and slows itself on a loaded machine,
 * while a change is still seen within 30 s); a failing poll backs off to 10 min. A change seen is
 * polled again 5 s later and indexed when that poll sees the same fingerprint (the quiet window),
 * or 60 s after the first change under continuous churn. At most
 * {@link REPO_WATCH_CAP} repos. One index at a time (the queue below).
 *
 * # One writer
 *
 * The repo graph is written ONLY by the engine's `indexRepoGraph` (the onboarding index command,
 * under the lock a launch's D8 base index takes; the engine re-reads the active runs on the repo under
 * that lock and answers `held`). It is never re-indexed while a run holds it at its base: a run
 * actively executing on the repo (its floor's affected set reads the graph at the base), or a
 * `domain-extraction` run, executing or parked (its pages read the graph with no base check, #1230). A parked run does not hold it: its floor finds the graph not at its base and runs the full
 * suite, disclosed (core `floor_affected.rs`, `review_scale::graph_age`). Then every project the repo
 * is in is refreshed through the onboarding hook's own function. Nothing here re-runs
 * `clusters --annotate`: "current" covers symbols, files and references, never clusters.
 *
 * # Restart
 *
 * `<state home>/repo-watch.json` (registered in the state-home registry crew and wicked-core ship) keeps,
 * per repo, the fingerprint last indexed, when, when a launch on the repo last resolved its base, and the
 * off switch. At boot every repo's first poll compares against it and indexes a difference (catch-up). A
 * launch since the last index (`runBaseResolved`, then its D8 re-indexes the graph at that run's base)
 * brings the graph back to the checkout once nothing holds it.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { RepoGraphWatch, RepoWatchHold, RepoWatchStatus } from 'wicked-crew-api-types';
import type { RepoEntry, SessionView } from '../core/types.js';
import { runNameOf } from '../core/run-identity.js';

export const REPO_WATCH_CAP = 24;
export const POLL_MIN_MS = 5_000;
/** A repo's poll period is at least this many times its last poll's duration (git stays near 10% of its time)… */
export const POLL_DUTY = 10;
/** …and never longer than this, so a change is seen within it even when spawning git is slow on a loaded host. */
export const POLL_MAX_MS = 30_000;
/** A change seen is looked at again this soon: the quiet window (the index starts when it has not moved since). */
export const QUIET_MS = 5_000;
export const POLL_BACKOFF_MAX_MS = 10 * 60_000;
export const CHANGE_MAX_WAIT_MS = 60_000;
export const INDEX_BACKOFF_BASE_MS = 60_000;
export const INDEX_BACKOFF_MAX_MS = 30 * 60_000;
/** Entries whose size and mtime are read per poll; past it the fingerprint is the status text alone. */
export const STAT_CAP = 2_000;
export const GIT_TIMEOUT_MS = 20_000;
/** How long the repo list is reused before it is read again. */
export const REPOS_TTL_MS = 30_000;

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
/** The bytes of a small changed file, so a same-size edit inside one mtime tick still moves the fingerprint. */
export type ReadFn = (path: string) => Promise<Buffer | null>;

const statOf: StatFn = async (p) => {
  try {
    const s = await lstat(p);
    return s.isFile() || s.isSymbolicLink() || s.isDirectory() ? { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) } : null;
  } catch {
    return null;
  }
};

const readOf: ReadFn = async (p) => {
  try {
    return await readFile(p);
  } catch {
    return null;
  }
};

/** Changed files at most this big are hashed by content (pi r1: a 1 s mtime filesystem hides a same-size edit)… */
export const HASH_FILE_MAX = 64 * 1024;
/** …within this many bytes per poll; past it, size and mtime alone. */
export const HASH_BUDGET = 4 * 1024 * 1024;

/**
 * The fingerprint of a repo's state on disk, from its poll. Every counted entry contributes its status, size and mtime,
 * and a small file its content hash. `coarse`: past {@link STAT_CAP} entries (build output git does not ignore), the
 * stats stop and the fingerprint moves once a minute instead, so a change there is still indexed within ~1 min —
 * never reported current on no evidence (codex r1).
 */
export async function fingerprintOf(
  root: string,
  status: PorcelainStatus,
  stateHome: string | null,
  stat: StatFn = statOf,
  read: ReadFn = readOf,
  now: () => number = Date.now,
): Promise<{ fingerprint: string; coarse: boolean; changed: number }> {
  const entries = status.entries.filter((e) => countsAsChange(e.path, root, stateHome)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  h.update(`oid ${status.oid ?? '-'}\nhead ${status.head ?? '-'}\n`);
  const coarse = entries.length > STAT_CAP;
  let budget = HASH_BUDGET;
  for (const [i, e] of entries.entries()) {
    h.update(`${e.code} ${e.path}`);
    if (i < STAT_CAP) {
      const file = join(root, ...e.path.split('/'));
      const st = await stat(file);
      h.update(st === null ? ' gone' : ` ${st.size} ${st.mtimeMs}`);
      if (st !== null && st.size <= HASH_FILE_MAX && st.size <= budget && !e.path.endsWith('/')) {
        const bytes = await read(file);
        if (bytes !== null) { budget -= bytes.length; h.update(` ${createHash('sha1').update(bytes).digest('hex')}`); }
      }
    }
    h.update('\n');
  }
  if (coarse) h.update(`coarse ${Math.floor(now() / CHANGE_MAX_WAIT_MS)}\n`);
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

/** One repo's persisted record. Every field is validated on load (codex r1: a malformed record must not stall decisions). */
interface Rec {
  /** The fingerprint the last successful index saw. */
  indexedFp?: string;
  /** When the repo graph was last indexed from the checkout (unix ms). */
  lastIndexedAt?: number;
  /** How many launches on the repo resolved their base (each one's D8 moves the graph to that base)… */
  launches?: number;
  /** …and how many of them the last index came after. A counter, not a clock, so a clock step never fakes a move. */
  indexedLaunches?: number;
  /** The per-repo switch; absent = on. */
  enabled?: false;
}

function readRec(v: unknown): Rec | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: Rec = {};
  if (typeof o['indexedFp'] === 'string' && /^[0-9a-f]{64}$/.test(o['indexedFp'])) out.indexedFp = o['indexedFp'];
  if (typeof o['lastIndexedAt'] === 'number' && Number.isFinite(o['lastIndexedAt'])) out.lastIndexedAt = o['lastIndexedAt'];
  if (Number.isSafeInteger(o['launches']) && (o['launches'] as number) >= 0) out.launches = o['launches'] as number;
  if (Number.isSafeInteger(o['indexedLaunches']) && (o['indexedLaunches'] as number) >= 0) out.indexedLaunches = o['indexedLaunches'] as number;
  if (o['enabled'] === false) out.enabled = false;
  return out;
}

interface RepoState {
  repoId: string;
  root: string;
  /** The person's switch (persisted); never derived from `state` (codex r1). */
  enabled: boolean;
  /** Past the cap among enabled repos: tracked, not polled (a manual Re-index now still runs once). */
  capped: boolean;
  state: RepoGraphWatch['state'];
  seenFp: string | null;
  changedAt: number | null;
  nextPollAt: number;
  lastPolledAt: number | null;
  lastPollMs: number;
  pollFailures: number;
  indexFailures: number;
  indexBackoffUntil: number;
  lastIndexMs: number | null;
  coarse: boolean;
  waitingOn: RepoWatchHold[];
  error: string | null;
  remedy: string | null;
  polls: number;
  indexes: number;
  /** A person pressed Re-index now: the quiet window and the backoff are skipped once, past the switch and the cap,
   *  and the request is kept while runs hold the map (it runs when they let go). */
  forced: boolean;
}

export interface IndexAnswer {
  outcome: 'indexed' | 'no-graph' | 'held';
  heldBy?: string[];
}

export interface RepoWatchDeps {
  listRepos: () => Promise<RepoEntry[]>;
  runViews: () => Promise<readonly SessionView[]>;
  /** The engine's checkout re-index (core-ts `indexRepoGraph`): it re-reads active runs under its lock (`held`). */
  indexRepoGraph: (repoId: string) => Promise<IndexAnswer>;
  /** Refresh every project the repo is in (`refreshProjectGraphsForRepo`, never served by a refresh that predates this index). */
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
  read?: ReadFn;
  exists?: (p: string) => boolean;
}

/** The idle poll period after a poll that took `lastPollMs`. */
export function pollPeriod(lastPollMs: number): number {
  return Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, POLL_DUTY * lastPollMs));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The person-facing remedy for an index failure (the engine's words name the cause). */
export function indexRemedy(error: string): string {
  if (/could not run the .* indexer/i.test(error)) return 'wicked-estate is not available to the daemon. Install it, then press Re-index now.';
  const over = /exceeded (\d+)s/i.exec(error);
  if (over !== null) {
    const s = Number(over[1]);
    const words = s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`;
    return `The re-index took longer than ${words} and was stopped. Press Re-index now to try again; a very large change may need the repository to be onboarded again.`;
  }
  if (/no registered repo/i.test(error)) return 'The repository is no longer registered. Register it again on Repositories.';
  return 'Press Re-index now to try again. If it keeps failing, onboard the repository again from its page.';
}

export function pollRemedy(): string {
  return 'Check that the folder still exists and is a git repository, and that git is installed.';
}

const TOO_MANY = (n: number): string =>
  `${n} changed files is more than studio reads closely, so the code map is re-indexed about once a minute while they change. Adding build output to .gitignore fixes it.`;

export class RepoWatcher {
  private readonly now: () => number;
  private readonly git: GitFn;
  private readonly stat: StatFn;
  private readonly read: ReadFn;
  private readonly exists: (p: string) => boolean;
  /** Repo id → record. A Map, so no repo id (`__proto__`) can reach an object's prototype (codex r1). */
  private readonly records = new Map<string, Rec>();
  private loaded = false;
  private readonly repos = new Map<string, RepoState>();
  private reposReadAt = -Infinity;
  private readonly queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  /** The ONE step in flight; a wake while it runs only marks another step owed (codex + pi r1). */
  private busy: Promise<void> | null = null;
  private wakeOwed = false;
  private saving: Promise<void> = Promise.resolve();
  private saves = 0;

  constructor(private readonly deps: RepoWatchDeps) {
    this.now = deps.now ?? Date.now;
    this.git = deps.git ?? pollGit;
    this.stat = deps.stat ?? statOf;
    this.read = deps.read ?? readOf;
    this.exists = deps.exists ?? existsSync;
  }

  /** Start the loop (no-op when off for the daemon). */
  start(): void {
    if (!this.deps.enabled || this.running) return;
    this.running = true;
    this.stopped = false;
    this.kick(0);
  }

  /** Stop: no new step starts; the one in flight and any pending save are awaited. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await this.busy?.catch(() => undefined);
    await this.saving.catch(() => undefined);
  }

  /** Wake the loop: a step now, unless one is running (then right after it). */
  private kick(ms: number): void {
    if (this.stopped || !this.running) return;
    if (this.busy !== null) { this.wakeOwed = true; return; }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.busy = this.step()
        .catch((err: unknown) => this.deps.log(`[repo-watch] step failed: ${message(err)}`))
        .finally(() => {
          this.busy = null;
          const owed = this.wakeOwed;
          this.wakeOwed = false;
          this.kick(owed ? 0 : this.delay());
        });
    }, ms);
    this.timer.unref?.();
  }

  /** How long until the next thing is due (bounded 250 ms … 1 s, so a new repo or a press is picked up). */
  private delay(): number {
    if (this.queue.length > 0) return 0;
    const t = this.now();
    let next = Infinity;
    for (const r of this.repos.values()) if (this.pollable(r)) next = Math.min(next, r.nextPollAt - t);
    return Math.max(250, Math.min(1_000, Number.isFinite(next) ? next : 1_000));
  }

  private pollable(r: RepoState): boolean {
    return r.forced || (r.enabled && !r.capped);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.deps.statePath, 'utf8')) as { version?: unknown; repos?: unknown };
      if (raw?.version !== 1 || raw.repos === null || typeof raw.repos !== 'object' || Array.isArray(raw.repos)) return;
      for (const [id, v] of Object.entries(raw.repos as Record<string, unknown>)) {
        const rec = readRec(v);
        if (rec !== null) this.records.set(id, rec);
      }
    } catch {
      // Missing or unreadable: every repo indexes once (the safe direction).
    }
  }

  /** Persist, one write at a time, each through its own temporary file (codex + pi r1). */
  private save(): Promise<void> {
    const body = JSON.stringify({ version: 1, repos: Object.fromEntries(this.records) }, null, 2);
    const path = this.deps.statePath;
    const tmp = `${path}.tmp-${process.pid}-${(this.saves += 1)}`;
    this.saving = this.saving.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, path);
    });
    return this.saving.catch((err: unknown) => this.deps.log(`[repo-watch] could not save ${path}: ${message(err)}`));
  }

  private rec(repoId: string): Rec {
    let r = this.records.get(repoId);
    if (r === undefined) { r = {}; this.records.set(repoId, r); }
    return r;
  }

  /** Re-read the registry: onboarded repos with a folder; the first {@link REPO_WATCH_CAP} ENABLED ones are polled. */
  async syncRepos(force = false): Promise<void> {
    await this.load();
    const t = this.now();
    if (!force && t - this.reposReadAt < REPOS_TTL_MS) return;
    this.reposReadAt = t;
    const all = (await this.deps.listRepos())
      .filter((r) => typeof r.code_graph_db === 'string' && r.code_graph_db !== '' && this.exists(r.code_graph_db) && this.exists(r.root_path))
      .sort((a, b) => (a.registered_at ?? 0) - (b.registered_at ?? 0) || (a.id < b.id ? -1 : 1));
    const keep = new Set(all.map((r) => r.id));
    for (const id of [...this.repos.keys()]) if (!keep.has(id)) this.repos.delete(id);
    let slots = REPO_WATCH_CAP;
    for (const r of all) {
      const enabled = this.records.get(r.id)?.enabled !== false;
      const capped = enabled && (slots -= 1) < 0;
      let cur = this.repos.get(r.id);
      if (cur === undefined) {
        cur = {
          repoId: r.id, root: r.root_path, enabled, capped, state: 'starting', seenFp: null, changedAt: null,
          nextPollAt: t, lastPolledAt: null, lastPollMs: 0, pollFailures: 0, indexFailures: 0, indexBackoffUntil: 0,
          lastIndexMs: null, coarse: false, waitingOn: [], error: null, remedy: null, polls: 0, indexes: 0, forced: false,
        };
        this.repos.set(r.id, cur);
      }
      cur.root = r.root_path;
      cur.enabled = enabled;
      if (cur.capped && !capped) cur.nextPollAt = t; // a slot came free
      cur.capped = capped;
      if (cur.state !== 'indexing') this.restate(cur);
    }
  }

  /** The resting state a switch or the cap implies (the operational states stand otherwise). */
  private restate(r: RepoState): void {
    if (!r.enabled && !r.forced) { r.state = 'off'; r.waitingOn = []; return; }
    if (r.capped && !r.forced) { r.state = 'capped'; r.waitingOn = []; return; }
    if (r.state === 'off' || r.state === 'capped') r.state = 'starting';
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
      if (!this.pollable(r) || r.nextPollAt > t) continue;
      if (due === null || r.nextPollAt < due.nextPollAt) due = r;
    }
    if (due !== null) await this.poll(due);
  }

  private async poll(r: RepoState): Promise<void> {
    const started = this.now();
    let fp: { fingerprint: string; coarse: boolean; changed: number };
    try {
      const out = await this.git(r.root, POLL_ARGS);
      fp = await fingerprintOf(r.root, parsePorcelainV2(out), this.deps.stateHome, this.stat, this.read, this.now);
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
    r.nextPollAt = ended + pollPeriod(r.lastPollMs);
    r.coarse = fp.coarse;
    await this.decide(r, fp.fingerprint, ended, fp.coarse ? TOO_MANY(fp.changed) : null);
  }

  private async decide(r: RepoState, fp: string, t: number, note: string | null): Promise<void> {
    const rec = this.rec(r.repoId);
    // A launch on the repo since the last index ran its D8: the graph may sit at that run's base now.
    const moved = (rec.launches ?? 0) > (rec.indexedLaunches ?? 0);
    const wants = r.forced || rec.indexedFp !== fp || moved;
    if (!wants) {
      r.seenFp = fp;
      r.changedAt = null;
      r.waitingOn = [];
      if (r.indexFailures === 0) { r.state = 'current'; r.error = null; r.remedy = note; }
      return;
    }
    let due = r.forced;
    if (!due) {
      if (r.seenFp !== fp) {
        r.seenFp = fp;
        r.changedAt ??= t;
        // Only the graph moved (a launch's D8), not the checkout: nothing to wait out.
        due = t - r.changedAt >= CHANGE_MAX_WAIT_MS || (rec.indexedFp === fp && moved);
      } else {
        due = true; // quiet for one poll
      }
    }
    r.changedAt ??= t;
    if (!due) {
      if (r.state !== 'failed') { r.state = 'changed'; r.remedy = note; }
      r.nextPollAt = Math.min(r.nextPollAt, t + QUIET_MS); // the quiet check comes soon, whatever the idle period
      return;
    }
    // A failing index waits out its backoff whatever changes meanwhile; only a person's press skips it (codex r1).
    if (!r.forced && t < r.indexBackoffUntil) return;
    const holds = holdsOf(await this.deps.runViews(), r.repoId);
    if (holds.length > 0) {
      r.state = 'waiting-runs';
      r.waitingOn = holds;
      return;
    }
    r.waitingOn = [];
    if (!this.queue.includes(r.repoId)) this.queue.push(r.repoId);
    if (r.state !== 'indexing' && r.state !== 'failed') r.state = 'changed';
  }

  private async index(repoId: string): Promise<void> {
    const r = this.repos.get(repoId);
    if (r === undefined || (!r.forced && (!r.enabled || r.capped))) return;
    // Crew's own check (a domain mapping parked at a gate holds the map too); the engine re-reads active runs under
    // its lock, so a launch between this read and the index is caught there (`held`).
    const holds = holdsOf(await this.deps.runViews(), repoId);
    if (holds.length > 0) { r.state = 'waiting-runs'; r.waitingOn = holds; return; }
    const fp = r.seenFp;
    const launchesBefore = this.rec(repoId).launches ?? 0;
    r.state = 'indexing';
    const started = this.now();
    try {
      const answer = await this.deps.indexRepoGraph(repoId);
      r.lastIndexMs = this.now() - started;
      if (answer.outcome === 'held') {
        r.state = 'waiting-runs';
        r.waitingOn = (answer.heldBy ?? []).map((runId) => ({ runId, reason: 'executing' as const }));
        return;
      }
      r.forced = false;
      if (answer.outcome === 'no-graph') {
        r.state = 'failed';
        r.error = 'This repository has no code map yet.';
        r.remedy = 'Onboard it from its page; the code map is kept current from then on.';
        return;
      }
      r.indexes++;
      r.indexFailures = 0;
      r.indexBackoffUntil = 0;
      r.error = null;
      r.remedy = r.coarse ? r.remedy : null;
      const rec = this.rec(repoId);
      if (fp !== null) rec.indexedFp = fp;
      rec.lastIndexedAt = this.now();
      rec.indexedLaunches = launchesBefore;
      await this.save();
      try {
        await this.deps.refreshProjects(repoId);
      } catch (err) {
        this.deps.log(`[repo-watch] ${repoId}: project graph refresh failed: ${message(err)}`);
      }
      r.changedAt = null;
      r.state = 'current';
      this.restate(r);
      this.deps.log(`[repo-watch] ${repoId}: code map re-indexed in ${r.lastIndexMs} ms`);
    } catch (err) {
      r.forced = false;
      r.lastIndexMs = this.now() - started;
      r.indexFailures++;
      r.indexBackoffUntil = this.now() + Math.min(INDEX_BACKOFF_MAX_MS, INDEX_BACKOFF_BASE_MS * 2 ** (r.indexFailures - 1));
      r.state = 'failed';
      r.error = message(err).split('\n')[0] ?? 'the re-index failed';
      r.remedy = indexRemedy(r.error);
      this.deps.log(`[repo-watch] ${repoId}: re-index FAILED: ${r.error}`);
    }
  }

  /**
   * A run on `repoId` resolved its base (`runBaseResolved`): its D8 re-indexes the repo graph at that base, so the
   * graph no longer follows the checkout. Recorded (durably), so once nothing holds the map it is indexed again.
   */
  noteLaunch(repoId: string): void {
    if (!this.deps.enabled) return;
    const rec = this.rec(repoId);
    rec.launches = (rec.launches ?? 0) + 1;
    void this.save();
  }

  /** Something changed the registry (a repo onboarded): read it at the next step, now. */
  wake(): void {
    this.reposReadAt = -Infinity;
    this.kick(0);
  }

  /** A person pressed Re-index now: queued at the next step, past the quiet window, the backoff, the switch and the cap;
   *  while runs hold the map the request is kept and runs when they let go. */
  async reindexNow(repoId: string): Promise<{ queued: boolean; waitingOn: RepoWatchHold[]; unknown?: true }> {
    await this.syncRepos(true);
    const r = this.repos.get(repoId);
    if (r === undefined) return { queued: false, waitingOn: [], unknown: true };
    r.forced = true;
    r.indexBackoffUntil = 0;
    r.nextPollAt = this.now();
    const holds = holdsOf(await this.deps.runViews(), repoId);
    if (holds.length > 0) {
      r.state = 'waiting-runs';
      r.waitingOn = holds;
      this.kick(0);
      return { queued: false, waitingOn: holds };
    }
    if (r.state === 'off' || r.state === 'capped') r.state = 'starting';
    this.kick(0);
    return { queued: true, waitingOn: [] };
  }

  /** The per-repo switch (persisted). An unknown repo changes nothing (codex + pi r1). */
  async setEnabled(repoId: string, enabled: boolean): Promise<boolean> {
    await this.syncRepos(true);
    const r = this.repos.get(repoId);
    if (r === undefined) return false;
    const rec = this.rec(repoId);
    if (enabled) delete rec.enabled;
    else rec.enabled = false;
    await this.save();
    if (!enabled) {
      const at = this.queue.indexOf(repoId);
      if (at >= 0 && !r.forced) this.queue.splice(at, 1);
    }
    await this.syncRepos(true); // re-allocate the cap among enabled repos
    if (enabled && r.state === 'starting') r.nextPollAt = this.now();
    this.kick(0);
    return true;
  }

  /** The wire status (`GET /repo-watch`). */
  status(): RepoWatchStatus {
    const repos: RepoGraphWatch[] = [...this.repos.values()].map((r) => ({
      repoId: r.repoId,
      state: r.state,
      enabled: r.enabled,
      lastIndexedAt: this.records.get(r.repoId)?.lastIndexedAt ?? null,
      lastPolledAt: r.lastPolledAt,
      changedAt: r.changedAt,
      waitingOn: r.waitingOn,
      error: r.error,
      remedy: r.state === 'capped'
        ? `Studio keeps up to ${REPO_WATCH_CAP} repositories current. Turn another repository off to free a slot, or press Re-index now on this one after a change.`
        : r.remedy,
    }));
    return { enabled: this.deps.enabled, disabledBy: this.deps.enabled ? null : 'env', cap: REPO_WATCH_CAP, covers: COVERS, repos };
  }

  /** `diagnostics.repoWatch`: the status plus the loop's own numbers. */
  diagnostics(): Record<string, unknown> {
    return {
      ...this.status(),
      queue: [...this.queue],
      watched: [...this.repos.values()].filter((r) => r.enabled && !r.capped).length,
      perRepo: [...this.repos.values()].map((r) => ({
        repoId: r.repoId, state: r.state, enabled: r.enabled, capped: r.capped, periodMs: pollPeriod(r.lastPollMs), lastPollMs: r.lastPollMs,
        lastIndexMs: r.lastIndexMs, polls: r.polls, indexes: r.indexes, pollFailures: r.pollFailures, indexFailures: r.indexFailures,
        coarse: r.coarse, forced: r.forced, nextPollInMs: Math.max(0, r.nextPollAt - this.now()),
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

