/**
 * The app store (DES-APPS-001 §4, §6.4, §9.1): apps as git repos under the apps root, and crew's own
 * record of each app — its versions, the RECEIPT per (app, tree), the undo pointer and the turn lock.
 *
 * Where things live, and why:
 *  - Each app is a repo at `<apps root>/<slug>` (`~/.wicked/apps` by default), registered in crew's repo
 *    registry so a turn's run can work in a worktree of it. That repo is mounted into agent seats, so
 *    nothing that decides what may run lives in it.
 *  - The record is ONE file in the daemon's state home, `daemon-apps.json`: the state home is fenced from
 *    every worker, and the registered `daemon-` FILE prefix is the place a crew store may add a file
 *    without a core release (a new directory there would refuse every launch).
 *
 * Every change to an app runs under that app's lock (one daemon per state home), and every change a
 * person makes carries the version it was made on: a stale `base` is refused (compare-and-swap), so two
 * tabs cannot both step back. A turn in flight holds the app read-only. The record is the authority on
 * which commit is the app's head; the repo's `main` mirrors it and is re-pointed when it has moved (an
 * agent seat could move it; nothing crew serves reads `main`).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  Actor,
  AppCheckFinding,
  AppCheckSummary,
  AppDetail,
  AppEditOp,
  AppHistory,
  AppLock,
  AppReceipt,
  AppReceiptKind,
  AppSpec,
  AppSummary,
  AppTurnRecord,
  AppTurnState,
  AppVersion,
  AppsCheckResponse,
  RepoEntry,
} from '../core/types.js';
import { EMPTY_LOCK, LOCK_PATH, QUERIES_DIR, QUERY_EXT, SPEC_PATH, lockBytes, ownText, readAppTree, specBytes, stagedCheck, type AppFiles, type AppSourceStage } from './check.js';
import { AppGit, gitProblem, SHA_RE } from './git.js';

/** The state-home file name (the registered `daemon-` file prefix). */
export const APPS_STATE_FILENAME = 'daemon-apps.json';

/**
 * App slugs: a path component, a URL segment, and the app repo's id in crew's repo registry. The registry
 * keys a repo by the first four kebab words of its name (core `repo.rs` `slug`), so a slug is at most four
 * words: then the registry id IS the slug, and two apps can never share one. `check` and `uploads` are
 * routes, not apps.
 */
export const APP_SLUG_RE = /^(?=.{1,48}$)[a-z][a-z0-9]*(?:-[a-z0-9]+){0,3}$/;
export const RESERVED_APP_SLUGS: ReadonlySet<string> = new Set(['check', 'uploads']);

/** The receipts that make a tree part of an app's accepted history (DES §6.4). */
const ACCEPTED: ReadonlySet<AppReceiptKind> = new Set(['you', 'reviewed', 'restored']);

export class AppStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: { head?: number; turn?: AppTurnState; findings?: AppCheckFinding[]; suggestion?: string } = {},
  ) {
    super(message);
  }
}

/** A turn in flight, as crew keeps it: who launched it, and the tree its check offered. */
interface StoredTurn extends AppTurnState {
  launchedBy: Actor;
  /** The commit `POST /apps/check` wrote the lock on; the only tree a review can land. */
  checked: string | null;
  /** That commit's tree, kept as checked (never re-resolved from the agent-writable repo). */
  checkedTree?: string | null;
  /** What that check ran. */
  checkedSummary: AppCheckSummary | null;
}

interface StoredApp {
  slug: string;
  name: string;
  projectId: string;
  repoId: string;
  root: string;
  createdAt: number;
  /** The empty commit the first version stands on. */
  baseCommit: string;
  versions: AppVersion[];
  /** Tree → every receipt it holds IN THIS APP. */
  receipts: Record<string, AppReceipt[]>;
  history: { states: number[]; pointer: number };
  turn: StoredTurn | null;
  /** (K5) The app's turns, oldest first, the last {@link TURN_LOG_MAX}: the chat reads them (no new thread store). */
  turnLog?: AppTurnRecord[];
}

/** How many turns an app's record keeps, and how many its detail answers. */
export const TURN_LOG_MAX = 50;
export const TURN_LOG_SHOWN = 20;

/** How a turn whose run is no longer running ends: it lands, or it ends with a reason (DES §9.2). */
export type AppTurnSettlement =
  | { kind: 'land'; builder: string; reviewer: string; summary: string; change: string }
  | { kind: 'end'; state: 'refused' | 'failed' | 'cancelled'; code: string; reason: string }
  /** Not known yet (the engine did not answer, or would not stop a refused run): the turn stays in flight. */
  | { kind: 'pending'; why: string };

interface StateFile {
  version: 1;
  apps: Record<string, StoredApp>;
}

/** The turn seam: launching an `apps-turn` run, asking whether one still runs, and how one that ended ends. */
export interface AppTurnLauncher {
  /** Launch the run under `runId`, which crew chose and recorded first (a crash between the two leaves a turn crew can check). */
  launch(input: {
    runId: string; app: string; repoId: string; base: number; message: string; about: string[]; actor: Actor;
    /** (K5) The app as the builder starts from it: its project, name, spec at head and last turns. */
    projectId?: string; name?: string; spec?: AppSpec; recent?: AppTurnRecord[];
  }): Promise<void>;
  isActive(runId: string): Promise<boolean>;
  /**
   * (K5) How a turn whose run is no longer running ends, read from the engine's record (never from the
   * worker): `land` only when its review by a seat distinct from its builder passed on exactly `checkedTree`.
   * Absent on a launcher that cannot tell: the turn then ends with no version.
   */
  settlement?(input: { slug: string; runId: string; checkedTree: string | null; base: () => Promise<AppFiles>; landedSpec: (tree: string) => Promise<AppFiles> }): Promise<AppTurnSettlement>;
}

/** crew's repo registry, as the store needs it. */
export interface AppRepoRegistry {
  /** Register the repo at `root` under `name`. */
  register(name: string, root: string): Promise<RepoEntry>;
  /** Whether a repo already holds `id` (a registration would replace it). */
  idTaken(id: string): Promise<boolean>;
}

export interface AppStoreOptions {
  /** `<state home>/daemon-apps.json`. */
  stateFile: string;
  /** Where app repos are made (`~/.wicked/apps`). */
  appsRoot: string;
  /** Where an app's repo is registered. */
  registry: AppRepoRegistry;
  /** The source stage, when this daemon has one (the sources slice wires it). */
  sourceStage?: AppSourceStage | null;
  turns?: AppTurnLauncher | null;
  now?: () => number;
  log?: (msg: string) => void;
}

/** The person-or-crew author of a version from the actor that made it. */
const humanAuthor = (actor: Actor): AppVersion['author'] => ({ kind: 'human', id: actor.id });

export class AppStore {
  readonly stateFile: string;
  readonly appsRoot: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private state: StateFile;
  private readonly locks = new Map<string, Promise<unknown>>();
  /**
   * Runs whose launch THIS process has in flight: the engine may not know them yet, so no poll may release
   * their turn. In memory on purpose (codex/pi r3): after a restart nothing is launching, and the engine is
   * asked about every turn.
   */
  private readonly launching = new Set<string>();
  /** Parsed trees, by (repo root, tree): trees are immutable. */
  private readonly treeCache = new Map<string, AppFiles>();
  sourceStage: AppSourceStage | null;
  turns: AppTurnLauncher | null;
  private readonly registry: AppRepoRegistry;

  constructor(opts: AppStoreOptions) {
    this.stateFile = opts.stateFile;
    this.appsRoot = opts.appsRoot;
    this.registry = opts.registry;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.sourceStage = opts.sourceStage ?? null;
    this.turns = opts.turns ?? null;
    this.state = this.read();
  }

  private read(): StateFile {
    if (!existsSync(this.stateFile)) return { version: 1, apps: {} };
    const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile;
    if (parsed.version !== 1 || typeof parsed.apps !== 'object' || parsed.apps === null) {
      throw new Error(`${this.stateFile} is not an apps store this daemon can read`);
    }
    return parsed;
  }

  /** Atomic: a temp file beside it (same `daemon-` prefix), then a rename. */
  private persist(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 1)}\n`, 'utf8');
    renameSync(tmp, this.stateFile);
  }

  /**
   * Apply `mutate` to `slug`'s record and persist it, or put the record back as it was: memory never holds
   * a change the file does not (codex r1 on the store: a failed write left a version accepted in memory).
   */
  private transact(slug: string, mutate: () => void): void {
    const before = Object.hasOwn(this.state.apps, slug) ? structuredClone(this.state.apps[slug]!) : undefined;
    mutate();
    try {
      this.persist();
    } catch (err) {
      if (before === undefined) delete this.state.apps[slug];
      else this.state.apps[slug] = before;
      throw err;
    }
  }

  /** Run `fn` holding `slug`'s lock: one change to an app at a time. */
  /** Apps runs git only where git honours its lazy-fetch switch (git.ts); else every operation says why. */
  private async requireGit(): Promise<void> {
    const problem = await gitProblem();
    if (problem !== null) throw new AppStoreError(503, 'apps_unavailable', problem);
  }

  private async withApp<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    await this.requireGit();
    const prev = this.locks.get(slug) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(slug, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(slug) === tail) this.locks.delete(slug);
    }
  }

  private app(slug: string): StoredApp {
    const a = Object.hasOwn(this.state.apps, slug) ? this.state.apps[slug] : undefined;
    if (a === undefined) throw new AppStoreError(404, 'unknown_app', `no app ${JSON.stringify(slug)}`);
    return a;
  }

  private head(a: StoredApp): AppVersion {
    return a.versions[a.versions.length - 1]!;
  }

  private git(a: StoredApp): AppGit {
    return new AppGit(a.root);
  }

  // ── Reads ───────────────────────────────────────────────────────────────────────────────────────

  has(slug: string): boolean {
    return Object.hasOwn(this.state.apps, slug);
  }

  /**
   * (crew#1324) Where app files live on disk: the apps root, and each app's own repo root (an app made under an
   * earlier `WICKED_CREW_APPS_ROOT` keeps its root). A turn's worktree is under its app's root.
   */
  fileRoots(): string[] {
    return [this.appsRoot, ...Object.values(this.state.apps).map((a) => a.root)];
  }

  private summary(a: StoredApp): AppSummary {
    const h = this.head(a);
    const turn = a.turn === null ? null : { runId: a.turn.runId, startedAt: a.turn.startedAt, base: a.turn.base, actor: a.turn.actor };
    return { slug: a.slug, name: a.name, projectId: a.projectId, repoId: a.repoId, createdAt: a.createdAt, head: { version: h.version, tree: h.tree, receipt: h.receipt?.kind ?? null }, turn };
  }

  list(projectId?: string): AppSummary[] {
    return Object.values(this.state.apps)
      .filter((a) => projectId === undefined || a.projectId === projectId)
      .sort((x, y) => x.createdAt - y.createdAt || x.slug.localeCompare(y.slug))
      .map((a) => this.summary(a));
  }

  private historyOf(a: StoredApp): AppHistory {
    const { states, pointer } = a.history;
    return { states: [...states], pointer, canUndo: pointer > 0, canRedo: pointer >= 0 && pointer < states.length - 1 };
  }

  /** A tree crew landed, read from the repo's objects (cached: trees are immutable). */
  private async files(a: StoredApp, tree: string): Promise<AppFiles> {
    const key = `${a.root}\0${tree}`;
    const hit = this.treeCache.get(key);
    if (hit !== undefined) return hit;
    const read = await readAppTree(this.git(a), tree, { requireLock: true });
    if (!read.ok) throw new AppStoreError(409, 'unreadable_tree', `app ${a.slug} tree ${tree} cannot be read from its repo (it may have been changed): ${read.findings.map((f) => f.message).join('; ')}`);
    const files: AppFiles = { ...read.files, lock: read.files.lock ?? EMPTY_LOCK };
    if (this.treeCache.size > 256) this.treeCache.clear();
    this.treeCache.set(key, files);
    return files;
  }

  async detail(slug: string): Promise<AppDetail> {
    await this.requireGit();
    const a = this.app(slug);
    await this.refreshTurn(a, { locked: false });
    // The record may have been replaced meanwhile (a settlement's rollback swaps in a clone): read it again.
    const now = this.app(slug);
    // One snapshot: the summary, versions, pointer AND turn log are taken together with the head whose files are
    // read, so a landing during the read cannot pair a new base with an old spec (codex r1 on the store), nor a
    // turn log that says landed with the head before it (xreview r1 on K5).
    const snap = structuredClone({ summary: this.summary(now), versions: now.versions, history: this.historyOf(now), root: now.root, turns: (now.turnLog ?? []).slice(-TURN_LOG_SHOWN) });
    const files = await this.files({ ...now, root: snap.root }, snap.summary.head.tree);
    return { ...snap.summary, spec: files.spec, lock: files.lock, queryText: { ...files.queryText }, versions: snap.versions, history: snap.history, turns: snap.turns };
  }

  /** (K5) The app whose turn in flight is `runId`, or `null`. */
  turnApp(runId: string): string | null {
    for (const a of Object.values(this.state.apps)) if (a.turn?.runId === runId) return a.slug;
    return null;
  }

  /** (K5) The turns of `slug`, oldest first (at most {@link TURN_LOG_SHOWN}). */
  turnLog(slug: string): AppTurnRecord[] {
    return structuredClone((this.app(slug).turnLog ?? []).slice(-TURN_LOG_SHOWN));
  }

  /** (K5) Write `patch` onto `runId`'s turn record (inside a transaction). */
  private patchTurnRecord(a: StoredApp, runId: string, patch: Partial<AppTurnRecord>): void {
    const r = (a.turnLog ?? []).find((x) => x.runId === runId);
    if (r !== undefined) Object.assign(r, patch);
  }

  /**
   * After a version is committed to the record, point `main` at it. A failure here never undoes or fails
   * the landing (the record is the truth): it is logged, and the next change or the boot repairs `main`.
   */
  private async mirror(a: StoredApp, commit: string): Promise<void> {
    try {
      await this.git(a).setMain(commit);
    } catch (err) {
      this.log(`[apps] ${a.slug}: main could not be pointed at ${commit} (repaired on the next change): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The first accepted receipt `tree` holds in this app, or `null`. */
  acceptedReceipt(slug: string, tree: string): AppReceipt | null {
    const a = this.app(slug);
    return (Object.hasOwn(a.receipts, tree) ? a.receipts[tree]! : []).find((r) => ACCEPTED.has(r.kind)) ?? null;
  }

  /**
   * A version number of this app, or a commit of its repo → its commit and tree; `null` when the app has
   * no such version and its repo no such commit.
   */
  async resolve(slug: string, version: number | string): Promise<{ commit: string; tree: string; version: number | null } | null> {
    const a = this.app(slug);
    if (typeof version === 'number') {
      const v = Number.isInteger(version) && version >= 1 ? a.versions[version - 1] : undefined;
      return v === undefined ? null : { commit: v.commit, tree: v.tree, version: v.version };
    }
    const sha = version.toLowerCase();
    if (!SHA_RE.test(sha)) return null;
    const known = a.versions.find((v) => v.commit === sha);
    if (known !== undefined) return { commit: known.commit, tree: known.tree, version: known.version };
    const tree = await this.git(a).treeOf(sha);
    return tree === null ? null : { commit: sha, tree, version: null };
  }

  /** The spec at an accepted tree of this app (the query route's step 1-2). */
  async acceptedSpec(slug: string, version: number | string): Promise<{ spec: AppSpec; tree: string; receipt: AppReceipt }> {
    await this.requireGit();
    const a = this.app(slug);
    const r = await this.resolve(slug, version);
    if (r === null) throw new AppStoreError(404, 'unknown_version', `app ${slug} has no version ${JSON.stringify(version)}`);
    const receipt = this.acceptedReceipt(slug, r.tree);
    if (receipt === null) throw new AppStoreError(409, 'not_accepted', `tree ${r.tree} holds no accepted receipt for app ${slug}: it never runs against a source`);
    return { spec: (await this.files(a, r.tree)).spec, tree: r.tree, receipt };
  }

  /**
   * (K2b) The files at an accepted tree of this app: the spec, the query texts and the lock crew wrote, read
   * from the repo's verified objects. The executor's and the write path's step 1 (DES §7.2, §7.3).
   */
  async acceptedFiles(slug: string, version: number | string): Promise<{ files: AppFiles; tree: string; commit: string; version: number | null; receipt: AppReceipt }> {
    await this.requireGit();
    const a = this.app(slug);
    const r = await this.resolve(slug, version);
    if (r === null) throw new AppStoreError(404, 'unknown_version', `app ${slug} has no version ${JSON.stringify(version)}`);
    const receipt = this.acceptedReceipt(slug, r.tree);
    if (receipt === null) throw new AppStoreError(409, 'not_accepted', `tree ${r.tree} holds no accepted receipt for app ${slug}: it never runs against a source`);
    return { files: await this.files(a, r.tree), tree: r.tree, commit: r.commit, version: r.version, receipt };
  }

  // ── The turn lock ───────────────────────────────────────────────────────────────────────────────

  /**
   * A turn whose run has ended no longer holds the app (a lost end event, a restart). The engine is asked
   * outside any lock; the turn is cleared only under the app's lock (`locked`: the caller holds it), only if
   * it is still the turn that was asked about, and never while its launch is in flight (codex r2).
   */
  private async refreshTurn(a: StoredApp, opts: { locked: boolean }): Promise<void> {
    if (a.turn === null || this.launching.has(a.turn.runId) || this.turns === null) return;
    const runId = a.turn.runId;
    let active = true;
    try {
      active = await this.turns.isActive(runId);
    } catch (err) {
      this.log(`[apps] cannot tell whether turn ${runId} of ${a.slug} still runs (it keeps the app read-only): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (active) return;
    const settle = async (): Promise<void> => {
      const current = Object.hasOwn(this.state.apps, a.slug) ? this.state.apps[a.slug]! : undefined;
      if (current === undefined || current.turn?.runId !== runId || this.launching.has(runId)) return;
      await this.settleLocked(current, runId);
    };
    if (opts.locked) await settle();
    else await this.withApp(a.slug, settle);
  }

  /**
   * (K5) A turn whose run ended, settled under the app's lock: it lands as a `reviewed` version only when the
   * launcher's reading of the engine's record says its review by a distinct seat passed on the tree the check
   * offered; otherwise it ends with the reason, and nothing lands. Either way the app is editable again.
   */
  private async settleLocked(a: StoredApp, runId: string): Promise<void> {
    const t = a.turn;
    if (t === null || t.runId !== runId) return;
    let outcome: AppTurnSettlement;
    if (this.turns?.settlement === undefined) {
      outcome = { kind: 'end', state: 'failed', code: 'unknown', reason: 'this daemon cannot read how the turn ended, so nothing landed' };
    } else {
      try {
        // The head's files are read only when a landed turn's change line needs them (xreview r4: a cold read failing
        // must never end a turn whose run is still parked).
        outcome = await this.turns.settlement({ slug: a.slug, runId, checkedTree: t.checkedTree ?? null, base: () => this.files(a, this.head(a).tree), landedSpec: (tree) => this.files(a, tree) });
      } catch (err) {
        // The launcher throws only for a run the engine says has ENDED (a parked or running one answers `pending`):
        // a defect then ends the turn (failed), so the app is never wedged read-only (xreview r3, r4).
        outcome = { kind: 'end', state: 'failed', code: 'unknown', reason: `crew could not read how the turn ended (${err instanceof Error ? err.message : String(err)}), so nothing landed` };
      }
    }
    if (outcome.kind === 'pending') {
      // Not known yet: the turn stays in flight and settles on a later read; nothing is recorded that the engine's
      // record does not say, and no other turn starts meanwhile (xreview r2, r3).
      this.log(`[apps] turn ${runId} of ${a.slug} is not settled yet (it stays read-only): ${outcome.why}`);
      return;
    }
    if (outcome.kind === 'land') {
      try {
        await this.landTurnLocked(a, { runId, commit: t.checked ?? '', builder: outcome.builder, reviewer: outcome.reviewer, summary: outcome.summary, change: outcome.change });
        return;
      } catch (err) {
        // Only crew's own refusal ends the turn: a failure to write the record (a full disk) leaves the turn in
        // flight, to settle on the next read, rather than recording an outcome the file does not hold (xreview r1).
        if (!(err instanceof AppStoreError)) throw err;
        outcome = { kind: 'end', state: 'refused', code: err.code, reason: err.message };
      }
    }
    this.log(`[apps] turn ${runId} of ${a.slug} ended (${outcome.state}: ${outcome.code}); nothing landed, and the app is editable again`);
    const ended = outcome;
    // The record as it is now (a rolled-back transaction replaces it with a clone).
    const cur = this.app(a.slug);
    if (cur.turn?.runId !== runId) return;
    this.transact(a.slug, () => {
      cur.turn = null;
      this.patchTurnRecord(cur, runId, { state: ended.state, endedAt: this.now(), code: ended.code, reason: ended.reason.slice(0, 2000) });
    });
    await this.git(a).dropRef(['wicked', 'apps-checked', runId]).catch(() => undefined);
  }

  /** (K5) Settle `runId`'s turn now (its run ended): the event path's entry. A turn still running is left alone. */
  async settleTurn(slug: string, runId: string): Promise<void> {
    if (!this.has(slug)) return;
    await this.withApp(slug, async () => {
      const a = this.app(slug);
      if (a.turn?.runId !== runId || this.launching.has(runId)) return;
      let active = true;
      try {
        active = this.turns === null ? false : await this.turns.isActive(runId);
      } catch {
        active = true;
      }
      if (!active) await this.settleLocked(a, runId);
    });
  }

  private turnInFlight(a: StoredApp, what: string): AppStoreError {
    const t = a.turn!;
    return new AppStoreError(409, 'turn_in_flight', `a turn (run ${t.runId}) is changing ${a.slug}; ${what} waits until it ends. Preview still works.`, {
      turn: { runId: t.runId, startedAt: t.startedAt, base: t.base, actor: t.actor },
    });
  }

  /** The guard every change runs first: no turn in flight, the base is the head, `main` mirrors the head. */
  private async guard(a: StoredApp, base: number, what: string, opts: { turnRun?: string } = {}): Promise<void> {
    // Landing a turn is that turn settling: asking the engine about it again would settle it twice.
    if (opts.turnRun === undefined) await this.refreshTurn(a, { locked: true });
    if (a.turn !== null && a.turn.runId !== opts.turnRun) throw this.turnInFlight(a, what);
    const h = this.head(a);
    if (base !== h.version) {
      throw new AppStoreError(409, 'stale_base', `${what} was made on v${base}, but ${a.slug} is at v${h.version}; reload and try again`, { head: h.version });
    }
    const main = await this.git(a).main();
    if (main !== h.commit) {
      this.log(`[apps] ${a.slug}: main was at ${main ?? '(none)'}, not crew's head ${h.commit}; re-pointing it`);
      await this.mirror(a, h.commit);
    }
  }

  async beginTurn(slug: string, input: { base: number; message: string; about: string[]; actor: Actor }): Promise<AppTurnState> {
    const turns = this.turns;
    if (turns === null) throw new AppStoreError(501, 'not_implemented', 'this daemon cannot launch apps-turn runs yet');
    return this.withApp(slug, async () => {
      const a = this.app(slug);
      await this.guard(a, input.base, 'a new turn');
      if (a.repoId === '') throw new AppStoreError(409, 'not_registered', `${slug}'s repository is not registered yet, so no turn can work in it; try again in a moment`);
      // The turn is recorded under the run id crew chose BEFORE the run starts, so a crash between the two
      // leaves a turn crew can ask about, never a run with no lock (codex r1 on the store).
      const runId = `apps-${slug}-${randomBytes(6).toString('hex')}`;
      const turn: StoredTurn = { runId, startedAt: this.now(), base: input.base, actor: input.actor.id, launchedBy: input.actor, checked: null, checkedTree: null, checkedSummary: null };
      this.launching.add(runId);
      const record: AppTurnRecord = {
        runId, at: turn.startedAt, actor: input.actor.id, message: input.message, about: [...input.about], base: input.base,
        state: 'running', endedAt: null, version: null, change: null, summary: null, builder: null, reviewer: null, code: null, reason: null,
      };
      try {
        this.transact(slug, () => {
          a.turn = turn;
          a.turnLog = [...(a.turnLog ?? []), record].slice(-TURN_LOG_MAX);
        });
        const head = await this.files(a, this.head(a).tree);
        const recent = structuredClone((a.turnLog ?? []).filter((r) => r.runId !== runId).slice(-5));
        await turns.launch({ runId, app: slug, repoId: a.repoId, base: input.base, message: input.message, about: input.about, actor: input.actor, projectId: a.projectId, name: a.name, spec: head.spec, recent });
      } catch (err) {
        if (a.turn?.runId === runId) {
          // A launch the engine refused is a turn that never ran: its record says why, and nothing landed.
          const reason = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
          this.transact(slug, () => {
            a.turn = null;
            this.patchTurnRecord(a, runId, { state: 'refused', endedAt: this.now(), code: err instanceof AppStoreError ? err.code : 'launch_refused', reason });
          });
        }
        throw err;
      } finally {
        this.launching.delete(runId);
      }
      return { runId, startedAt: turn.startedAt, base: turn.base, actor: turn.actor };
    });
  }

  /** The turn's run ended (any outcome): the app is editable again. Idempotent; another run's end is ignored. */
  async endTurn(slug: string, runId: string, outcome: { state: 'refused' | 'failed' | 'cancelled'; code: string; reason: string } = { state: 'cancelled', code: 'ended', reason: 'the turn ended' }): Promise<void> {
    await this.withApp(slug, async () => {
      const a = this.app(slug);
      if (a.turn?.runId !== runId) return;
      this.transact(slug, () => {
        a.turn = null;
        this.patchTurnRecord(a, runId, { state: outcome.state, endedAt: this.now(), code: outcome.code, reason: outcome.reason.slice(0, 2000) });
      });
      await this.git(a).dropRef(['wicked', 'apps-checked', runId]);
    });
  }

  /**
   * `apps_check` for the turn in flight (DES §9.2 `check`): the candidate commit the builder made, read
   * from the repo's objects, through the staged check against the head; on a pass crew writes the lock
   * and commits it on the candidate. That commit is the tree the turn offers, and the only one a review
   * can land.
   */
  async checkTurn(slug: string, runId: string, given: string | { commit: string } | { tree: string }): Promise<AppsCheckResponse> {
    return this.withApp(slug, async () => {
      const a = this.app(slug);
      if (a.turn?.runId !== runId) throw new AppStoreError(409, 'not_this_turn', `run ${runId} is not ${slug}'s turn in flight`);
      const git = this.git(a);
      let candidate: string;
      let tree: string | null;
      if (typeof given === 'string' || 'commit' in given) {
        candidate = (typeof given === 'string' ? given : given.commit).toLowerCase();
        tree = await git.treeOf(candidate);
        if (tree === null) throw new AppStoreError(404, 'unknown_version', `${slug}'s repo has no commit ${candidate}`);
      } else {
        // (K5) The engine's snapshot of the builder's worktree, a TREE in the app repo's objects (`WICKED_TREE`):
        // crew makes the candidate commit itself, on the head, reading only verified objects.
        tree = given.tree.toLowerCase();
        if (!SHA_RE.test(tree)) throw new AppStoreError(400, 'bad_request', 'tree must be a 40-hex object id');
        try {
          await git.readTree(tree);
        } catch {
          throw new AppStoreError(404, 'unknown_version', `${slug}'s repo has no tree ${tree}`);
        }
        candidate = await git.commitTree(tree, this.head(a).commit, `apps-turn ${runId}: the builder's tree`, this.now());
      }
      const read = await readAppTree(git, tree);
      if (!read.ok) return { ok: false, code: 'check_failed', findings: read.findings };
      const base = await this.files(a, this.head(a).tree);
      const outcome = await stagedCheck({ app: slug, spec: read.files.spec, queryText: read.files.queryText, base, level: 'auto', sourceStage: this.sourceStage });
      if (!outcome.ok) return { ok: false, code: outcome.code, findings: outcome.findings };
      const checkedTree = await this.writeTree(git, read.files.spec, read.files.queryText, outcome.lock);
      const commit = await git.commitTree(checkedTree, candidate, `apps-check: lock for turn ${runId}`, this.now());
      const t = a.turn;
      // Anchored under a crew ref so a gc in the builder's seat cannot prune it before it lands (pi r3).
      await git.writeRef(['wicked', 'apps-checked', runId], commit);
      this.transact(slug, () => {
        t.checked = commit;
        t.checkedTree = checkedTree;
        t.checkedSummary = outcome.summary;
      });
      return { ok: true, commit, tree: checkedTree, summary: outcome.summary, files: this.treeFiles(read.files.spec, read.files.queryText, outcome.lock) };
    });
  }

  /**
   * (K5) The files of a tree {@link writeTree} makes, as text: what `wicked-crew apps-check` writes into the
   * turn's worktree so the review is dispatched on exactly the checked tree.
   */
  private treeFiles(spec: AppSpec, queryText: Record<string, string>, lock: AppLock): Array<{ path: string; text: string }> {
    return [
      { path: SPEC_PATH, text: specBytes(spec) },
      { path: LOCK_PATH, text: lockBytes(lock) },
      ...spec.queries.map((q) => ({ path: `${QUERIES_DIR}/${q.id}.${QUERY_EXT[q.kind]}`, text: ownText(queryText, q.id) ?? '' })),
    ];
  }

  /**
   * A turn whose review by a seat distinct from its builder named `commit` lands it (DES §9.1 `reviewed`).
   * Refused unless `commit` is exactly the tree this turn's check offered, the seats differ, and the app is
   * still at the turn's base.
   */
  async landTurn(slug: string, input: { runId: string; commit: string; builder: string; reviewer: string; summary: string; change?: string }): Promise<AppVersion> {
    return this.withApp(slug, async () => this.landTurnLocked(this.app(slug), input));
  }

  private async landTurnLocked(a: StoredApp, input: { runId: string; commit: string; builder: string; reviewer: string; summary: string; change?: string }): Promise<AppVersion> {
    const slug = a.slug;
    {
      const t = a.turn;
      if (t === null || t.runId !== input.runId) throw new AppStoreError(409, 'not_this_turn', `run ${input.runId} is not ${slug}'s turn in flight`);
      if (t.checked === null || t.checked !== input.commit.toLowerCase()) {
        throw new AppStoreError(409, 'not_checked', `commit ${input.commit} is not the tree this turn's check offered`);
      }
      if (input.builder.trim() === '' || input.reviewer.trim() === '' || input.builder === input.reviewer) {
        throw new AppStoreError(409, 'reviewer_not_distinct', 'a turn lands only after a review by a seat distinct from its builder');
      }
      await this.guard(a, t.base, 'the turn', { turnRun: t.runId });
      const git = this.git(a);
      const tree = t.checkedTree ?? null;
      if (tree === null) throw new AppStoreError(409, 'not_checked', 'this turn has no checked tree');
      const at = this.now();
      const version = a.versions.length + 1;
      const receipt: AppReceipt = { kind: 'reviewed', tree, version, at, actor: t.launchedBy, review: { runId: t.runId, builder: input.builder, reviewer: input.reviewer } };
      // The version is a commit on the head whose tree is the checked one (the builder's intermediate
      // commits stay on the run's branch).
      const commit = await git.commitTree(tree, this.head(a).commit, `v${version}: ${(input.change ?? input.summary).replace(/\s+/g, ' ').trim()}`, at);
      const check: AppCheckSummary = t.checkedSummary ?? { level: 'data', checked: [] };
      const name = (await this.files(a, tree)).spec.name;
      let landed: AppVersion | null = null;
      this.transact(slug, () => {
        // The version strip's summary is one line (the turn record keeps the builder's lines as written).
        landed = this.record(a, { commit, tree, at, author: { kind: 'seat', id: input.builder }, receipt, summary: (input.change ?? input.summary).replace(/\s+/g, ' ').trim() || 'A turn', check, base: t.base });
        a.turn = null;
        this.pushHistory(a, landed.version);
        // The app is called what its spec calls it (a turn or an edit may rename it).
        if (typeof name === 'string' && name.trim() !== '') a.name = name;
        this.patchTurnRecord(a, t.runId, {
          state: 'landed', endedAt: at, version: landed.version, change: (input.change ?? '').slice(0, 300) || null,
          summary: input.summary.slice(0, 600) || null, builder: input.builder, reviewer: input.reviewer, code: null, reason: null,
        });
      });
      await this.mirror(a, commit);
      await git.dropRef(['wicked', 'apps-checked', t.runId]);
      return landed!;
    }
  }

  // ── Creating an app ─────────────────────────────────────────────────────────────────────────────

  /** Whether anything (a file, a directory, a dangling link) holds `name` under the apps root. */
  private pathTaken(name: string): boolean {
    try {
      lstatSync(join(this.appsRoot, name));
      return true;
    } catch {
      return false;
    }
  }

  private async free(slug: string): Promise<boolean> {
    return APP_SLUG_RE.test(slug) && !RESERVED_APP_SLUGS.has(slug) && !this.has(slug) && !this.pathTaken(slug) && !(await this.registry.idTaken(slug));
  }

  /**
   * A free slug like `slug`: `<slug>-2`, `-3`, … while it has fewer than four words, else its last word
   * numbered (`a-b-c-d2`), always a valid slug that is neither an app, a path under the root, nor a
   * registered repo id.
   */
  async suggest(slug: string): Promise<string> {
    const words = slug.split('-');
    /** `slug` with `suffix` added, shortened (longest word first, each kept to one letter at least) to fit 48. */
    const candidate = (suffix: string): string => {
      const w = words.length < 4 ? [...words, suffix] : [...words.slice(0, 3), `${words[3]}${suffix}`];
      const last = w.length - 1;
      const keep = (i: number): number => (i === last ? suffix.length + 1 : 1);
      while (w.join('-').length > 48) {
        let longest = -1;
        for (let i = 0; i < w.length; i++) if (w[i]!.length > keep(i) && (longest < 0 || w[i]!.length > w[longest]!.length)) longest = i;
        if (longest < 0) break;
        w[longest] = longest === last ? `${w[longest]!.slice(0, w[longest]!.length - suffix.length - 1)}${suffix}` : w[longest]!.slice(0, -1);
      }
      return w.join('-');
    };
    for (let i = 2; i < 100; i++) {
      const c = candidate(String(i));
      if (await this.free(c)) return c;
    }
    for (let i = 0; i < 20; i++) {
      const c = candidate(randomBytes(3).toString('hex'));
      if (await this.free(c)) return c;
    }
    throw new AppStoreError(409, 'slug_taken', `${slug} is taken and no free name like it was found`);
  }

  /** The slug rules a new app or a new empty repo meets; throws the refusal. */
  async assertNewSlug(slug: string): Promise<void> {
    if (!APP_SLUG_RE.test(slug)) throw new AppStoreError(400, 'bad_request', 'an app slug is 1-48 of a-z 0-9 in at most four words joined by -, starting with a letter');
    if (RESERVED_APP_SLUGS.has(slug)) throw new AppStoreError(422, 'reserved_slug', `${slug} is reserved`, { suggestion: await this.suggest(`${slug}-app`) });
    if (!(await this.free(slug))) throw new AppStoreError(409, 'slug_taken', `${slug} is taken`, { suggestion: await this.suggest(slug) });
  }

  /** A new empty repo at `<apps root>/<slug>` (the `POST /repos {create: true}` path). */
  async createEmptyRepo(slug: string): Promise<{ root: string; commit: string }> {
    const root = join(this.appsRoot, slug);
    try {
      const { commit } = await AppGit.createEmpty(root);
      return { root, commit };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new AppStoreError(409, 'slug_taken', `${slug} is taken`, { suggestion: await this.suggest(slug) });
      throw err;
    }
  }

  /** `POST /repos {create: true}`: a new empty repo, registered (its id is the slug); no app record. */
  async createRepo(slug: string): Promise<{ root: string; repo: RepoEntry }> {
    return this.withApp(slug, async () => {
      await this.assertNewSlug(slug);
      const { root } = await this.createEmptyRepo(slug);
      try {
        if (await this.registry.idTaken(slug)) throw new AppStoreError(409, 'slug_taken', `${slug} was registered by something else meanwhile`, { suggestion: await this.suggest(slug) });
        return { root, repo: await this.registry.register(slug, root) };
      } catch (err) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    });
  }

  /**
   * A new app: the empty repo and crew's first version (one empty page) are made first, then the record
   * is written, then the repo is registered: a failure at any step leaves nothing behind that blocks a
   * retry, and a crash after the record leaves an app whose registration {@link reconcile} finishes. The
   * first version holds a `you` receipt only when a human made it (an agent-kind caller may add an app,
   * never accept a tree).
   */
  async create(input: { slug: string; name: string; projectId: string; actor: Actor }): Promise<AppDetail> {
    const { slug } = input;
    return this.withApp(slug, async () => {
      await this.assertNewSlug(slug);
      const { root, commit: empty } = await this.createEmptyRepo(slug);
      const at = this.now();
      const a: StoredApp = { slug, name: input.name, projectId: input.projectId, repoId: '', root, createdAt: at, baseCommit: empty, versions: [], receipts: {}, history: { states: [], pointer: -1 }, turn: null };
      const human = input.actor.kind === 'human';
      try {
        const spec: AppSpec = { schema: 'wicked.apps/v1', name: input.name, pages: [{ id: 'page-1', title: 'Page 1', components: [] }], queries: [], actions: [], linkHosts: [] };
        const git = this.git(a);
        const tree = await this.writeTree(git, spec, {}, EMPTY_LOCK);
        const commit = await git.commitTree(tree, empty, 'v1: a new app', at);
        await git.setMain(commit);
        const receipt: AppReceipt | null = human ? { kind: 'you', tree, version: 1, at, actor: input.actor } : null;
        this.transact(slug, () => {
          this.state.apps[slug] = a;
          this.record(a, { commit, tree, at, author: { kind: 'crew', id: 'wicked-crew' }, receipt, summary: 'A new app', check: { level: 'spec', checked: [] }, base: null });
          if (human) this.pushHistory(a, 1);
        });
      } catch (err) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      await this.registerApp(slug, { compensate: true });
      return this.detail(slug);
    });
  }

  /**
   * Register an app whose record has no repo id yet. At creation (`compensate`) a refusal removes the app
   * and its repo, so the slug can be tried again; at recovery it never does (the app may already hold
   * accepted versions): the app stays, and the next boot tries again (codex r2). Just before registering,
   * the id is checked again, narrowing the window in which another registration could take it.
   */
  private async registerApp(slug: string, opts: { compensate: boolean }): Promise<void> {
    const a = this.app(slug);
    let repoId: string;
    try {
      const existing = await this.registry.idTaken(slug);
      if (existing && opts.compensate) throw new AppStoreError(409, 'slug_taken', `${slug} was registered by something else meanwhile`, { suggestion: await this.suggest(slug) });
      repoId = (await this.registry.register(slug, a.root)).id;
    } catch (err) {
      if (opts.compensate) {
        this.transact(slug, () => {
          delete this.state.apps[slug];
        });
        await rm(a.root, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    }
    this.transact(slug, () => {
      a.repoId = repoId;
    });
  }

  /** At boot: finish any registration a crash interrupted, and point every app's `main` at its head. */
  async reconcile(): Promise<void> {
    if ((await gitProblem()) !== null) return;
    for (const slug of Object.keys(this.state.apps)) {
      await this.withApp(slug, async () => {
        const a = this.app(slug);
        if (a.repoId === '') await this.registerApp(slug, { compensate: false });
        const head = this.head(a).commit;
        if ((await this.git(a).main()) !== head) await this.mirror(a, head);
      }).catch((err: unknown) => this.log(`[apps] ${slug} could not be reconciled: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  // ── Changes a person makes (human-only routes) ──────────────────────────────────────────────────

  private async writeTree(git: AppGit, spec: AppSpec, queryText: Record<string, string>, lock: AppLock): Promise<string> {
    const queryEntries: Array<{ mode: string; type: 'blob'; sha: string; name: string }> = [];
    for (const q of spec.queries) {
      queryEntries.push({ mode: '100644', type: 'blob', sha: await git.writeBlob(ownText(queryText, q.id) ?? ''), name: `${q.id}.${QUERY_EXT[q.kind]}` });
    }
    const root: Array<{ mode: string; type: 'blob' | 'tree'; sha: string; name: string }> = [
      { mode: '100644', type: 'blob', sha: await git.writeBlob(specBytes(spec)), name: SPEC_PATH },
      { mode: '100644', type: 'blob', sha: await git.writeBlob(lockBytes(lock)), name: LOCK_PATH },
    ];
    if (queryEntries.length > 0) root.push({ mode: '040000', type: 'tree', sha: await git.mktree(queryEntries), name: QUERIES_DIR });
    return git.mktree(root);
  }

  private record(
    a: StoredApp,
    v: { commit: string; tree: string; at: number; author: AppVersion['author']; receipt: AppReceipt | null; summary: string; check: AppCheckSummary; base: number | null },
  ): AppVersion {
    const version: AppVersion = { version: a.versions.length + 1, commit: v.commit, tree: v.tree, base: v.base, at: v.at, author: v.author, receipt: v.receipt, summary: v.summary.slice(0, 200), check: v.check };
    a.versions.push(version);
    if (v.receipt !== null) (a.receipts[v.tree] ??= []).push(v.receipt);
    return version;
  }

  /** A new accepted state: everything after the pointer is dropped (a new edit clears redo). */
  private pushHistory(a: StoredApp, version: number): void {
    a.history.states = [...a.history.states.slice(0, a.history.pointer + 1), version];
    a.history.pointer = a.history.states.length - 1;
  }

  /** Check `candidate` against the head and land it as a new version with `receipt`. */
  private async land(
    a: StoredApp,
    candidate: { spec: AppSpec; queryText: Record<string, string> },
    opts: { level: 'auto' | 'full'; actor: Actor; summary: string; receipt: (version: number, tree: string, at: number) => AppReceipt; history: (version: number) => void },
  ): Promise<AppVersion> {
    const h = this.head(a);
    const base = await this.files(a, h.tree);
    const outcome = await stagedCheck({ app: a.slug, spec: candidate.spec, queryText: candidate.queryText, base, level: opts.level, sourceStage: this.sourceStage });
    if (!outcome.ok) {
      const status = outcome.code === 'source_check_unavailable' ? 409 : 422;
      throw new AppStoreError(status, outcome.code, outcome.findings.map((f) => f.message).slice(0, 5).join('; '), { findings: outcome.findings });
    }
    const git = this.git(a);
    const tree = await this.writeTree(git, candidate.spec, candidate.queryText, outcome.lock);
    const at = this.now();
    const version = a.versions.length + 1;
    const commit = await git.commitTree(tree, h.commit, `v${version}: ${opts.summary}`, at);
    let landed: AppVersion | null = null;
    this.transact(a.slug, () => {
      landed = this.record(a, { commit, tree, at, author: humanAuthor(opts.actor), receipt: opts.receipt(version, tree, at), summary: opts.summary, check: outcome.summary, base: h.version });
      opts.history(version);
      if (candidate.spec.name.trim() !== '') a.name = candidate.spec.name;
    });
    await this.mirror(a, commit);
    return landed!;
  }

  /** `POST /apps/:app/edits`: one `you` version from one edit burst. */
  async edit(slug: string, input: { base: number; ops: AppEditOp[]; summary?: string | undefined; actor: Actor }): Promise<AppVersion> {
    return this.withApp(slug, async () => {
      const a = this.app(slug);
      await this.guard(a, input.base, 'this edit');
      const head = await this.files(a, this.head(a).tree);
      let spec = head.spec;
      const queryText = { ...head.queryText };
      for (const op of input.ops) {
        if (op.op === 'spec') spec = op.spec;
        else queryText[op.query] = op.text;
      }
      // The text of a query the spec no longer declares goes with it.
      const declared = new Set(spec.queries.map((q) => q.id));
      for (const id of Object.keys(queryText)) if (!declared.has(id)) delete queryText[id];
      return this.land(a, { spec, queryText }, {
        level: 'auto',
        actor: input.actor,
        summary: input.summary ?? 'Edited',
        receipt: (version, tree, at) => ({ kind: 'you', tree, version, at, actor: input.actor }),
        history: (version) => this.pushHistory(a, version),
      });
    });
  }

  /** The `restored` receipt for landing the tree of `from` (a version holding `held`), with its provenance. */
  private restoredReceipt(from: number, held: AppReceipt, actor: Actor): (version: number, tree: string, at: number) => AppReceipt {
    const origin = held.kind === 'restored' && held.restoredFrom !== undefined
      ? { originKind: held.restoredFrom.originKind, originVersion: held.restoredFrom.originVersion }
      : { originKind: held.kind as 'you' | 'reviewed', originVersion: held.version };
    return (version, tree, at) => ({ kind: 'restored', tree, version, at, actor, restoredFrom: { version: from, ...origin } });
  }

  /** `POST /apps/:app/undo` and `/redo`: move the pointer one accepted state, landing that state's tree after the full check. */
  async move(slug: string, direction: 'undo' | 'redo', input: { base: number; actor: Actor }): Promise<AppVersion> {
    return this.withApp(slug, async () => {
      const a = this.app(slug);
      await this.guard(a, input.base, direction === 'undo' ? 'this undo' : 'this redo');
      const { states, pointer } = a.history;
      const to = direction === 'undo' ? pointer - 1 : pointer + 1;
      if (to < 0 || to >= states.length || pointer < 0) {
        throw new AppStoreError(409, direction === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo', direction === 'undo' ? 'there is no earlier accepted version to go back to' : 'there is nothing to redo');
      }
      const target = a.versions[states[to]! - 1]!;
      const held = target.receipt !== null && ACCEPTED.has(target.receipt.kind) ? target.receipt : this.acceptedReceipt(slug, target.tree);
      if (held === null) throw new AppStoreError(409, 'not_accepted', `v${target.version} holds no accepted receipt`);
      const files = await this.files(a, target.tree);
      return this.land(a, { spec: files.spec, queryText: files.queryText }, {
        level: 'full',
        actor: input.actor,
        summary: `${direction === 'undo' ? 'Undo' : 'Redo'} to v${target.version}`,
        receipt: this.restoredReceipt(target.version, held, input.actor),
        history: () => {
          a.history.pointer = to;
        },
      });
    });
  }

  /** `POST /apps/:app/restore`: land an accepted version's tree as a new version (a new accepted state; redo is cleared). */
  async restore(slug: string, input: { base: number; version: number | string; actor: Actor }): Promise<AppVersion> {
    return this.withApp(slug, async () => {
      const a = this.app(slug);
      await this.guard(a, input.base, 'this restore');
      const r = await this.resolve(slug, input.version);
      if (r === null) throw new AppStoreError(404, 'unknown_version', `${slug} has no version ${JSON.stringify(input.version)}`);
      // A known version's OWN accepted receipt carries its provenance; a tree-level one only for a commit
      // that is no accepted version of this app (codex r2: two versions can share a tree).
      const own = r.version !== null ? a.versions[r.version - 1]!.receipt : null;
      const held = own !== null && ACCEPTED.has(own.kind) ? own : this.acceptedReceipt(slug, r.tree);
      if (held === null) {
        throw new AppStoreError(409, 'not_accepted', `${typeof input.version === 'number' ? `v${input.version}` : input.version} is not in ${slug}'s accepted history (no you, reviewed or restored receipt); it cannot be restored`);
      }
      const read = await readAppTree(this.git(a), r.tree);
      if (!read.ok) throw new AppStoreError(422, 'check_failed', read.findings.map((f) => f.message).join('; '), { findings: read.findings });
      const from = r.version ?? held.version;
      return this.land(a, { spec: read.files.spec, queryText: read.files.queryText }, {
        level: 'full',
        actor: input.actor,
        summary: `Restored v${from}`,
        receipt: this.restoredReceipt(from, held, input.actor),
        history: (version) => this.pushHistory(a, version),
      });
    });
  }
}

/** The apps root: `WICKED_CREW_APPS_ROOT`, else `~/.wicked/apps`. */
export function defaultAppsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['WICKED_CREW_APPS_ROOT'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '/tmp';
  return join(home, '.wicked', 'apps');
}
