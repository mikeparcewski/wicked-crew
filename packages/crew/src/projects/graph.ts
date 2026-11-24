/**
 * The project code graph — every `crew.repo` member of one project in ONE wicked-estate database.
 *
 * # What changed to make this possible
 *
 * One estate database used to hold exactly one repo. SymbolIds embed the repo-relative path, so two
 * repos that both contain `src/index.ts` mint identical file rows AND identical symbol ids: the
 * second index overwrote the first and said nothing. `wicked-estate index <path> --repo <label>`
 * (wicked-estate#117) namespaces every path as `<label>/…`, so N repos co-exist, each queryable,
 * with a guard that refuses — before a row is written — any index that would overwrite another
 * repo's content.
 *
 * # THE LIMIT
 *
 * CO-LOCATION IS NOT LINKAGE. estate resolves edges within a labelled repo's own nodes, exactly as
 * if each repo sat in its own database. `studio → wicked-crew-api-types → crew` does not traverse.
 * What this module federates is per-repo results into one answer with the repo named on every hit —
 * which is genuinely useful ("who calls `record`, anywhere in this project") and is NOT a cross-repo
 * dependency trace. Every response carries `linkage: 'co-located'` and {@link CO_LOCATION_NOTE} so a
 * consumer cannot mistake one for the other.
 *
 * # Why the estate binary is capability-PROBED before anything is indexed
 *
 * `wicked-estate 0.14.4` — the version installed on this machine while this was written — accepts
 * `--repo`, IGNORES it, and exits 0. Indexing three repos through it produces a database holding
 * only the third, with no error anywhere and results that look perfectly healthy. That is the exact
 * silent-loss failure the labelling work exists to end, reachable by nothing worse than a stale
 * binary on PATH. So the flag's support is established from the binary that will actually run,
 * before the first index (help text), and confirmed from the database afterwards (the labelled repo
 * registry `stats` prints) — a claim, then evidence.
 *
 * # Honest degradation
 *
 * Every path out of here names its cause. A project with no repo members, one whose graph was never
 * built, one whose member repo the registry no longer knows, an addon too old to publish
 * `code_graph_db`, and a CURRENT engine that resolved no repo-graph root at all
 * (`CodeGraphRootUnresolvableError` → the routes' 503; wicked-core#406) are five different
 * situations with five different remedies; collapsing them into an empty result set is the failure
 * estate's own R3 rule exists to prevent, and it is the failure FINDING-069 actually shipped.
 */

import { constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve as resolvePath } from 'node:path';

import type { CoreAdapter, IndexBudget } from '../core/adapter.js';
import { ExecOutputTooLarge, execCapped } from '../core/exec.js';
import { codeGraphDb, CodeGraphRootUnresolvableError } from '../core/repoPaths.js';
import type {
  BlastRadiusFreshness,
  ProjectBlastRadius,
  ProjectBlastRadiusFreshness,
  ProjectGraphBoundaries,
  ProjectGraphMemberCoverage,
  ProjectGraphPath,
  ProjectGraphPathEnd,
  ProjectGraphPathHop,
  ProjectGraphPossible,
  ProjectGraphAction,
  ProjectGraphCrossing,
  ProjectGraphLinkRun,
  ProjectGraphHit,
  ProjectGraphVia,
  ProjectGraphRefreshFailure,
  ProjectGraphRefreshResult,
  ProjectGraphRefreshState,
  ProjectGraphRepo,
  ProjectGraphRepoCount,
  ProjectGraphSearch,
  ProjectGraphStatus,
  RepoEntry,
} from '../core/types.js';
import { projectGraphDb, projectGraphManifest, projectGraphRoot, repoLabel } from './graph-paths.js';

/** The sentence every project-graph response carries. Stated on the wire, not just in this file. */
export const CO_LOCATION_NOTE =
  'Co-located, not linked: each repo is indexed under its own label and edges do not resolve ' +
  'across repos. Results are per-repo hits gathered into one answer, never a cross-repo trace.';

/**
 * The sentence an answer carries when it traversed a cross-repo package link (wicked-estate >= 0.34.0,
 * slice X1): the crossings are proven from package identity and listed, the rest are per-repo hits.
 */
export const LINKED_NOTE =
  'Linked: this answer crossed from one repo into another through package links that ' +
  'wicked-estate proved from package identity (listed in `crossings`; each dependent reached ' +
  'through one names it in `via_crossing`). Other hits are per-repo results, and a dependency the ' +
  'linker could not prove is not followed.';

/** Added to the answer's note when the project's link generation predates the current indexes. */
export const LINK_STALE_NOTE =
  'The links are from an earlier refresh and some repos changed since (`link_stale_labels`): ' +
  'refresh the code graph to relink.';

/**
 * The second sentence `/graph/search` carries, and only it.
 *
 * `matches: []` from an exact-name resolver against a healthy graph is the empty-result-that-reads-
 * as-an-answer this whole surface is built to refuse: a caller who typed half a name is told
 * "nothing in this project", which is false. estate's `resolve` has no substring mode (the header
 * on {@link projectSymbolSearch} argues why a `nodes --json` dump is not the answer), so the
 * matching RULE goes on the wire instead of a matching mode that does not exist.
 */
export const EXACT_NAME_NOTE =
  'Exact-name matching only: this resolves a whole symbol name, so a partial or fuzzy name ' +
  'returns no matches even when the symbol exists. An empty `matches` means "no symbol by that ' +
  'exact name", never "not in this project".';

/** `wicked-estate`, overridable exactly as `WICKED_CORE_EXE` overrides `wicked-core` in routes.ts.
 *  Exported (DES-L8 PR-8D) so the repo-graph route's `stats` spawn rides the same override the
 *  project-graph refresh and its test stub already use — one spelling of which binary answers. */
export function estateExe(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_ESTATE_EXE'] ?? 'wicked-estate';
}

/**
 * The whole-graph counts from `wicked-estate stats --db` stdout (`nodes=N edges=M files=F …`, the
 * first line estate prints — `main.rs`'s `stats` summary). `undefined` when the line does not parse
 * (an older/newer estate, an error message): the caller leaves `CodeGraphData.totals` ABSENT.
 * Shared by the repo-graph route (routes.ts) and the chat-scope liveness check (crew#642).
 */
export function parseEstateTotals(stdout: string): { nodes: number; edges: number; files: number } | undefined {
  const m = /^nodes=(\d+) edges=(\d+) files=(\d+)/m.exec(stdout);
  if (m === null) return undefined;
  return { nodes: Number(m[1]), edges: Number(m[2]), files: Number(m[3]) };
}

/** Queries are interactive; a full repo index is not. Both are bounded — neither hangs the daemon. A member repo's
 *  index is bounded by its own index budget, sized by the ENGINE from its file count (`adapter.indexBudget`,
 *  wicked-crew#1481); this file keeps no copy of the formula. */
const QUERY_TIMEOUT_MS = 30_000;

/** `760035` → `12 min 40 s`; `6037500` → `1 h 40 min`: a budget in the words a person reads. */
export function formatBudget(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return sec > 0 ? `${m} min ${sec} s` : `${m} min`;
  return `${sec} s`;
}

/** Node's timers cap at 2^31 - 1 ms (24.8 days; a larger delay becomes 1 ms, codex r1): a longer deadline is chained. */
const NODE_TIMER_MAX_MS = 2_147_483_647;

/** Calls `fire` once `ms` have passed, in timer steps Node can hold; the returned function disarms it. */
export function armDeadline(ms: number, fire: () => void, maxStep: number = NODE_TIMER_MAX_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = Math.max(0, ms);
  const step = (): void => {
    const now = Math.min(left, maxStep);
    left -= now;
    timer = setTimeout(left > 0 ? step : fire, now);
  };
  step();
  return () => clearTimeout(timer);
}

/** A member's index ran past its budget: it was killed when the deadline fired, whatever it then exited with. */
class IndexBudgetExceeded extends Error {
  constructor(readonly label: string, readonly budget: IndexBudget) {
    super(`wicked-estate index of ${label} ran past its budget (${budgetWords(budget)}) and was stopped`);
    this.name = 'IndexBudgetExceeded';
  }
}

/**
 * `wicked-estate index`, bounded by the member's index budget (wicked-crew#1481). The deadline is crew's own (chained
 * past Node's timer cap) and aborts the child with SIGKILL, as the engine's own indexes are killed: a child that traps
 * SIGTERM and exits 0, or with a code, still reads as over budget (codex r1/r2), never as an index that landed.
 */
async function indexWithinBudget(
  file: string,
  args: string[],
  cwd: string,
  label: string,
  budget: IndexBudget,
): Promise<{ stdout: string; stderr: string }> {
  const ctl = new AbortController();
  let over = false;
  const disarm = armDeadline(budget.budgetMs, () => {
    over = true;
    ctl.abort();
  });
  try {
    const out = await execCapped(file, args, { cwd, signal: ctl.signal, killSignal: 'SIGKILL' });
    if (over) throw new IndexBudgetExceeded(label, budget);
    return out;
  } catch (err) {
    if (over) throw new IndexBudgetExceeded(label, budget);
    throw err;
  } finally {
    disarm();
  }
}

/** Which budget an index hit, in the words its failure says. */
function budgetWords(b: IndexBudget): string {
  return `${formatBudget(b.budgetMs)}${b.trackedFiles === null ? '' : `, sized from ${b.trackedFiles} files`}`;
}

// ── Refresh state (wicked-crew#1481) ──────────────────────────────────────────

/** Per project, the refresh as this daemon runs it (in memory: a restart forgets it, the manifest does not). */
const refreshStates = new Map<string, ProjectGraphRefreshState>();

/** The project's refresh state, ABSENT when no refresh ran since the daemon started. */
export function projectGraphRefreshState(projectId: string): ProjectGraphRefreshState | undefined {
  const st = refreshStates.get(projectId);
  return st === undefined ? undefined : { ...st, lastFailure: st.lastFailure === null ? null : { ...st.lastFailure } };
}

/** `diagnostics.projectGraphRefresh`: every project refreshed since the daemon started. */
export function projectGraphRefreshDiagnostics(): Array<{ projectId: string } & ProjectGraphRefreshState> {
  return [...refreshStates.keys()].map((projectId) => ({ projectId, ...projectGraphRefreshState(projectId)! }));
}

/** Test seam: forget every refresh state. */
export function resetProjectGraphRefreshStates(): void {
  refreshStates.clear();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── The manifest ──────────────────────────────────────────────────────────────

export interface ManifestRepo {
  repoId: string;
  label: string;
  rootPath: string;
  /** HEAD at index time; absent when git could not answer, which forces a re-index. */
  head?: string;
  indexedAt: number;
}

export interface Manifest {
  version: 1;
  projectId: string;
  repos: ManifestRepo[];
}

/** Open flags that never follow a link at the last step (`O_NOFOLLOW` is 0 where the platform has none). */
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export async function readManifest(projectId: string, env: NodeJS.ProcessEnv): Promise<Manifest | null> {
  try {
    // A link in place of the manifest is not crew's manifest: it reads as missing (re-index everything).
    const fh = await open(projectGraphManifest(projectId, env), fsConstants.O_RDONLY | NOFOLLOW);
    let text: string;
    try {
      text = await fh.readFile('utf8');
    } finally {
      await fh.close();
    }
    const raw = JSON.parse(text) as Manifest;
    if (raw?.version !== 1 || !Array.isArray(raw.repos)) return null;
    return raw;
  } catch {
    // Missing or malformed. A lost manifest costs a re-index, never a wrong answer: the fallback is
    // "index everything", which is the safe direction. The dangerous direction — trusting a manifest
    // that describes rows the database does not hold — is closed separately, by ignoring the
    // manifest entirely when the database is absent.
    return null;
  }
}

export async function writeManifest(projectId: string, manifest: Manifest, env: NodeJS.ProcessEnv): Promise<void> {
  const path = projectGraphManifest(projectId, env);
  await mkdir(dirname(path), { recursive: true });
  // crew#1497: a fresh, unguessable temp name created exclusively (`O_EXCL` never follows or reuses whatever is at
  // the name, a link included), then renamed over the manifest (a rename replaces a link; it never writes through one).
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fh = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o644);
  try {
    await fh.writeFile(JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fh.close();
  await rename(tmp, path);
}

/** Upper bound on estate's writer open plus its journal switch (it waits up to 15 s for other connections). */
const GRAPH_PREPARE_TIMEOUT_MS = 120_000;

/**
 * crew#1497: make the project graph readable by a seat that may only read it. A seat's read-only estate refuses a
 * graph whose schema is older than its own build, and cannot open a WAL graph from a directory it cannot write. So the
 * owner does both after its writes, with estate's own binary (only estate's SQLite ever opens estate's graph):
 * `wicked-estate stats --db <graph> --journal delete` is a writer open (estate migrates on every one, even when the
 * refresh indexed nothing) that then leaves the graph in DELETE journal mode (wicked-estate#491, 0.35.7). Returns null
 * when that landed, else why not; the caller records it as a failed refresh, and the project's chat gets no graph.
 */
export async function prepareGraphForReaders(dbPath: string, env: NodeJS.ProcessEnv = process.env, run: typeof execCapped = execCapped): Promise<string | null> {
  const why = await prepareOnce(dbPath, env, run);
  noteReaders(dbPath, why);
  return why;
}

async function prepareOnce(dbPath: string, env: NodeJS.ProcessEnv, run: typeof execCapped): Promise<string | null> {
  // Never through a link: the migration and the journal switch would land on whatever it names (codex r2 #18).
  try {
    if (!lstatSync(dbPath).isFile()) return 'the graph is not a regular file';
  } catch (err) {
    return message(err);
  }
  try {
    await run(estateExe(env), ['stats', '--db', dbPath, '--journal', 'delete'], { timeout: GRAPH_PREPARE_TIMEOUT_MS });
    return null;
  } catch (err) {
    // The message carries estate's stderr (a locked graph, an older estate without `--journal`): one line for a status.
    return `wicked-estate stats --journal delete failed (${stderrTail(message(err).replace(/\s+/gu, ' '), 400)}); it needs wicked-estate 0.35.7 or later`;
  }
}

/** Why each project graph is not ready for read-only seats, by db path; absent when it is (codex r2 #1). */
const readersNotReady = new Map<string, string>();

function noteReaders(dbPath: string, why: string | null): void {
  if (why === null) readersNotReady.delete(resolvePath(dbPath));
  else readersNotReady.set(resolvePath(dbPath), why);
}

/** Why the graph at `dbPath` is not ready for read-only seats (its last preparation failed), or null. */
export function graphReadersError(dbPath: string): string | null {
  return readersNotReady.get(resolvePath(dbPath)) ?? null;
}

/** Whether `dbPath` is a project graph this daemon owns (`<project-graph root>/<id>/code-graph.db`). */
function isProjectGraphDb(dbPath: string, env: NodeJS.ProcessEnv): boolean {
  const abs = resolvePath(dbPath);
  return basename(abs) === PROJECT_GRAPH_DB_NAME && dirname(dirname(abs)) === resolvePath(projectGraphRoot(env));
}
const PROJECT_GRAPH_DB_NAME = 'code-graph.db';

/**
 * crew#1497 (codex r2 #2): estate's CLI opens a graph as a writer for every verb, reads included, and a writer open
 * switches it to WAL. A read-only seat cannot read a WAL graph from a directory it cannot write. So each of crew's own
 * CLI reads of a project graph puts it back in DELETE mode afterwards (a failure is recorded like a failed
 * preparation). Any other graph is read as before.
 */
export async function readProjectGraph<T>(dbPath: string, read: () => Promise<T>, env: NodeJS.ProcessEnv = process.env, run: typeof execCapped = execCapped): Promise<T> {
  try {
    return await read();
  } finally {
    if (isProjectGraphDb(dbPath, env) && existsSync(dbPath)) noteReaders(dbPath, await prepareOnce(dbPath, env, run));
  }
}

/**
 * Prepare one project's graph for read-only seats in that project's refresh slot: after any refresh in flight, so the
 * migration and journal switch never interleave with its index. Returns null when ready, else why not.
 */
export async function prepareProjectGraphForReaders(projectId: string, env: NodeJS.ProcessEnv = process.env, run: typeof execCapped = execCapped): Promise<string | null> {
  const running = inFlight.get(projectId);
  if (running !== undefined) await running.promise.catch(() => undefined);
  const why = await prepareGraphForReaders(projectGraphDb(projectId, env), env, run);
  // Said where a person sees a refresh fail (the project's refresh status), not only in the log (coord, crew#1597).
  if (why !== null) {
    const at = Date.now();
    const prior = refreshStates.get(projectId);
    refreshStates.set(projectId, {
      ...(prior ?? { state: 'idle', startedAt: at, finishedAt: at, budgetMs: null, repoId: null, repoStartedAt: null, repoBudgetMs: null }),
      lastFailure: { at, repoId: null, label: null, error: `the graph is not ready for read-only seats: ${why}`, timedOut: false, budgetMs: null },
    });
  }
  return why;
}

// ── Membership → labelled repos ───────────────────────────────────────────────

/** A member repo the registry still vouches for, with the label its rows carry. */
interface MemberRepo {
  repoId: string;
  label: string;
  repo: RepoEntry;
}

/** A member ref the registry no longer knows — carried, not dropped, so the status can say so. */
interface DanglingMember {
  repoId: string;
  label: string;
}

interface Members {
  repos: MemberRepo[];
  dangling: DanglingMember[];
}

/**
 * The project's `crew.repo` members, resolved against the registry.
 *
 * Note the `.filter`, where `resolveProjectRepo` (draft-events.ts) takes `.find`. That is not a
 * style difference: the only thing in this daemon that reads project repo membership today looks at
 * the FIRST member and ignores the rest, which is correct for its job (ground one launch in one
 * repo) and would be a silent half-answer here.
 *
 * A member whose ref the registry does not know is kept as `dangling` rather than skipped, because
 * "this project claims a repo that no longer exists" and "this project has no repos" need different
 * responses from an operator.
 */
async function resolveMembers(adapter: CoreAdapter, projectId: string): Promise<Members> {
  const members = await adapter.projectMembers(projectId);
  const refs = members.filter((m) => m.member_kind === 'crew.repo').map((m) => m.member_ref);
  if (refs.length === 0) return { repos: [], dangling: [] };
  const registry = await adapter.listRepos();
  const repos: MemberRepo[] = [];
  const dangling: DanglingMember[] = [];
  for (const ref of refs) {
    const repo = registry.find((r) => r.id === ref);
    if (repo === undefined) dangling.push({ repoId: ref, label: repoLabel(ref) });
    else repos.push({ repoId: ref, label: repoLabel(ref), repo });
  }
  return { repos, dangling };
}

/**
 * Two member repos resolving to ONE label would have repo B's rows overwrite repo A's under a name
 * that looks right in every result. estate's guard catches it too (it refuses a label already bound
 * to another repo), but only after the first repo is already in the database and only with a message
 * about estate labels rather than about the two project members that produced them.
 */
function assertLabelsUnique(repos: MemberRepo[]): void {
  const seen = new Map<string, string>();
  for (const r of repos) {
    const first = seen.get(r.label);
    if (first !== undefined) {
      throw new Error(
        `repos '${first}' and '${r.repoId}' both map to the estate label '${r.label}' — ` +
          `one would overwrite the other's symbols in the project graph`,
      );
    }
    seen.set(r.label, r.repoId);
  }
}

// ── Capability probes ─────────────────────────────────────────────────────────

/**
 * Does the `wicked-estate` that will actually run support `--repo`?
 *
 * A version comparison would be the obvious probe and the wrong one: it asks a string on disk
 * instead of the binary on PATH, and a locally built or vendored estate can carry any version it
 * likes. The usage banner is printed by the same binary that would do the indexing.
 */
export async function estateSupportsMultiRepo(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const { stdout } = await execCapped(estateExe(env), ['--help'], { timeout: 10_000 });
    return /index <path>[^\n]*--repo <name>/.test(stdout);
  } catch (err) {
    // `--help` exits non-zero on some builds; the banner still went to stdout on the error object.
    const out = (err as { stdout?: unknown }).stdout;
    return typeof out === 'string' && /index <path>[^\n]*--repo <name>/.test(out);
  }
}

/**
 * Does the `wicked-estate` that will run support `link --project` (wicked-estate >= 0.34.0, slice X1)?
 * Probed from `--help`, like `--repo`: an older binary has no `link`, and the refresh stays
 * co-located.
 */
export async function estateSupportsLink(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const probe = /^\s*wicked-estate link --project <id>/m;
  try {
    const { stdout } = await execCapped(estateExe(env), ['--help'], { timeout: 10_000 });
    return probe.test(stdout);
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    return typeof out === 'string' && probe.test(out);
  }
}

/** Upper bound on one `wicked-estate link` run (it reads the stored inputs; it does not re-index). */
const LINK_TIMEOUT_MS = 10 * 60_000;

/**
 * The refresh's last step: link the CURRENT member labels (leaving a removed member out retracts
 * its links). Never throws: a failed link leaves the co-located graph as it always was, and the
 * failure is reported on the refresh result.
 */
async function linkMembers(
  projectId: string,
  dbPath: string,
  labels: string[],
  env: NodeJS.ProcessEnv,
  log?: (msg: string) => void,
): Promise<ProjectGraphLinkRun | undefined> {
  if (labels.length === 0 || !(await estateSupportsLink(env))) return undefined;
  try {
    const { stdout } = await execCapped(
      estateExe(env),
      ['link', '--db', dbPath, '--project', projectId, '--labels', labels.join(','), '--json'],
      { timeout: LINK_TIMEOUT_MS },
    );
    const r = JSON.parse(stdout) as Record<string, unknown>;
    const num = (k: string): number | undefined => (typeof r[k] === 'number' ? (r[k] as number) : undefined);
    const counts = (k: string): Record<string, number> | undefined => {
      const v = r[k];
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : undefined;
    };
    const generation = num('generation');
    const links = num('links');
    const byIdentity = counts('links_by_identity');
    const byReason = counts('boundaries_by_reason');
    return {
      ...(generation === undefined ? {} : { generation }),
      ...(links === undefined ? {} : { links }),
      ...(typeof r['replayed'] === 'boolean' ? { replayed: r['replayed'] } : {}),
      ...(byIdentity === undefined ? {} : { links_by_identity: byIdentity }),
      ...(byReason === undefined ? {} : { boundaries_by_reason: byReason }),
      incomplete: Array.isArray(r['incomplete'])
        ? (r['incomplete'] as unknown[]).filter((x): x is string => typeof x === 'string')
        : [],
    };
  } catch (err) {
    const error = err instanceof ExecOutputTooLarge ? err.message : message(err);
    log?.(`wicked-estate link (project ${projectId}) failed: ${error}`);
    return { error };
  }
}

/**
 * Confirm from the DATABASE that the label landed, after the first repo goes in.
 *
 * `stats` prints a `repos (N):` block listing every labelled repo. Its absence after a `--repo`
 * index means the binary accepted the flag and dropped it — 0.14.4's behaviour — and every
 * subsequent repo would overwrite this one. Evidence, after the help text's claim.
 */
async function graphHoldsLabel(dbPath: string, label: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const { stdout } = await execCapped(estateExe(env), ['stats', '--db', dbPath], {
    timeout: QUERY_TIMEOUT_MS,
  });
  return new RegExp(`^\\s+${escapeRe(label)}\\s+files=`, 'm').test(stdout);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The evidence check failed: the binary took `--repo` and dropped it.
 *
 * A distinct type because it is NOT a per-repo failure and must not be collected as one. It is the
 * same fact the capability probe establishes — this binary cannot co-locate — discovered one step
 * later, and the only safe response is the probe's: stop, before the next repo's index overwrites
 * the rows just written. Recording it in `failed` and continuing runs a full index per member, each
 * clobbering the last, while the message on every entry claims the opposite.
 */
export class EstateDroppedRepoLabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EstateDroppedRepoLabelError';
  }
}

// ── Git freshness ─────────────────────────────────────────────────────────────

/**
 * The commit a clean checkout is at, or `null` for a dirty tree, a non-git directory, or a git that
 * would not answer.
 *
 * `null` means NO EVIDENCE OF UNCHANGEDNESS, and every caller treats it as "re-index". A dirty tree
 * genuinely cannot be identified by its HEAD — the working copy differs from it — so skipping one
 * would serve stale symbols for edits already on disk.
 */
async function cleanHead(rootPath: string): Promise<string | null> {
  try {
    // One git at a time, no fsmonitor daemon left behind, never `index.lock` (crew-0183: the repo watcher now runs this
    // after every re-index, beside the person's own git).
    const safe = { cwd: rootPath, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
    const { stdout: head } = await execCapped('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { timeout: 10_000, ...safe });
    const { stdout: status } = await execCapped('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], { timeout: 30_000, ...safe });
    if (status.trim() !== '') return null;
    const sha = head.trim();
    return sha === '' ? null : sha;
  } catch {
    return null;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

interface StatusInput {
  projectId: string;
  members: Members;
  manifest: Manifest | null;
  dbExists: boolean;
  env: NodeJS.ProcessEnv;
}

function refreshField(projectId: string): { refresh?: ProjectGraphRefreshState } {
  const refresh = projectGraphRefreshState(projectId);
  return refresh === undefined ? {} : { refresh };
}

function buildStatus({ projectId, members, manifest, dbExists, env }: StatusInput): ProjectGraphStatus {
  const dbPath = projectGraphDb(projectId, env);
  const indexedBy = new Map((manifest?.repos ?? []).map((r) => [r.label, r]));

  const repos: ProjectGraphRepo[] = [
    ...members.repos.map((m): ProjectGraphRepo => {
      const row = dbExists ? indexedBy.get(m.label) : undefined;
      if (row === undefined) {
        return {
          repoId: m.repoId,
          label: m.label,
          rootPath: m.repo.root_path,
          indexed: false,
          reason: dbExists
            ? 'attached since the last refresh — not in the graph yet'
            : 'the project graph has never been built',
          // Both causes are exactly what a refresh is for: the member is registered and its root
          // is where the registry says, there are simply no rows for it yet.
          // Customer copy (crew#1036): it reaches a chat's scope card through the bind reason.
          remedy: `Refreshing the code graph (the project's Repositories tab) fixes it.`,
        };
      }
      // The rows under this label were written from a DIFFERENT root than the registry now names.
      // `indexed: true` here would be a claim about a checkout that was never indexed, and it is
      // the shape a refused refresh leaves behind: estate binds a label to the root it first saw,
      // so re-indexing a repo that moved is refused as a collision (`repo_scope.rs::guard` #4) and
      // the prior manifest row survives untouched. Reporting that as a healthy graph made a project
      // read `ready` with `missingRepos: []` for ever while queries served the old tree's symbols.
      // The repo is NOT in the graph as currently registered, so it is missing, its rows are
      // excluded from answers (`queryable` builds its label map from `indexed`), and the reason
      // names both roots plus the remedy the guard's own message asks for.
      if (row.rootPath !== m.repo.root_path) {
        return {
          repoId: m.repoId,
          label: m.label,
          rootPath: m.repo.root_path,
          indexed: false,
          reason:
            `the graph holds '${m.label}' as indexed from ${row.rootPath}, but the registry now ` +
            `points at ${m.repo.root_path} — those rows describe a different checkout and are ` +
            `excluded. A refresh re-indexes it; if wicked-estate refuses the label as already ` +
            `bound to the old root, delete ${dbPath} and rebuild the project graph.`,
        };
      }
      return {
        repoId: m.repoId,
        label: m.label,
        rootPath: m.repo.root_path,
        indexed: true,
        ...(row.head === undefined ? {} : { head: row.head }),
        indexedAt: row.indexedAt,
      };
    }),
    ...members.dangling.map(
      (d): ProjectGraphRepo => ({
        repoId: d.repoId,
        label: d.label,
        rootPath: '',
        indexed: false,
        reason: 'attached as a member, but the repo registry no longer knows this ref',
        // NOT a refresh: there is no registered repo to index, so a refresh would report the same
        // dangling member and change nothing. The member ref and the registry have to agree first.
        remedy:
          `Re-register the repo under this ref, or drop the member with ` +
          `DELETE /api/v1/projects/${projectId}/members/${d.repoId}.`,
      }),
    ),
  ];

  const missingRepos = repos.filter((r) => !r.indexed).map((r) => r.repoId);
  const memberLabels = new Set(members.repos.map((m) => m.label));
  const staleRepos = (manifest?.repos ?? [])
    .filter((r) => !memberLabels.has(r.label))
    .map((r) => r.label);
  const indexedCount = repos.filter((r) => r.indexed).length;

  const base = {
    projectId,
    dbPath: dbExists ? dbPath : null,
    repos,
    missingRepos,
    staleRepos,
    linkage: 'co-located' as const,
    note: CO_LOCATION_NOTE,
    updatedAt:
      manifest === null || !dbExists
        ? null
        : manifest.repos.reduce((max, r) => Math.max(max, r.indexedAt), 0) || null,
    ...refreshField(projectId),
  };

  // Customer copy (F-2R2-008, crew#1036): every `detail` below is shown to a person on the project
  // page and a chat's scope card, so it says "this project" — never the raw project id or a route.
  if (members.repos.length === 0 && members.dangling.length === 0) {
    return {
      ...base,
      state: 'no-repo-members',
      detail:
        `This project has no repositories yet, so there is nothing to build a code graph from. ` +
        `Attach one on the project's Repositories tab.`,
    };
  }
  const dangling = members.dangling.map((d) => d.repoId).join(', ');
  if (members.repos.length === 0) {
    // Every member ref is dangling. `not-indexed` is the right STATE (there is no graph), but the
    // refresh remedy the branch below offers is not the right advice: a refresh would resolve zero
    // repos and build nothing, so an operator would run it, see no change, and have learned
    // nothing. The cause is the membership, and the message says so.
    return {
      ...base,
      state: 'not-indexed',
      detail:
        `This project's only repo member(s) — ${dangling} — are not in the repo registry, ` +
        `so there is nothing to index. Re-attach a registered repo, or re-register the missing one; ` +
        `a refresh cannot help while every member is dangling.`,
    };
  }
  if (!dbExists || indexedCount === 0) {
    // Customer copy (F-2R2-008): this sentence is what a chat's scope card and the project page
    // show a person, so it names the page action, not the route — the route rides on `action` for
    // the UI to wire. The member count says how big the build is.
    const n = members.repos.length;
    return {
      ...base,
      state: 'not-indexed',
      detail:
        `This project's code graph has not been built yet — build it from the project page ` +
        `(${n} member repositor${n === 1 ? 'y' : 'ies'}).` +
        (dangling === '' ? '' : ` (${dangling} is listed as a member but is no longer a registered repository.)`),
      action: 'projects.graph.refresh',
    };
  }
  // crew#1497: a graph its seats cannot read (its preparation failed) is never bound to a chat or a run. The state
  // stays what the graph holds; dbPath is withheld, and the detail says why and what fixes it.
  const readers = graphReadersError(dbPath);
  if (readers !== null) {
    return {
      ...base,
      dbPath: null,
      state: indexedCount === 1 ? 'ready-single-repo' : 'ready',
      detail:
        `This project's code graph could not be prepared for its chats and runs (${readers}), so they get no ` +
        `project graph until a refresh succeeds. Refresh it from the project page.`,
      action: 'projects.graph.refresh',
    };
  }
  if (indexedCount === 1) {
    return {
      ...base,
      state: 'ready-single-repo',
      detail:
        `This project's code graph holds exactly one repo (${
          repos.find((r) => r.indexed)?.label ?? '?'
        })` +
        `${missingRepos.length > 0 ? `, with ${missingRepos.length} member repo(s) missing from it` : ''}` +
        `. Answers are correct but cannot span repos.`,
    };
  }
  return {
    ...base,
    state: 'ready',
    detail:
      `This project's code graph holds ${indexedCount} co-located repos` +
      `${missingRepos.length > 0 ? `; ${missingRepos.length} member repo(s) are NOT in it and every answer is partial` : ''}.`,
  };
}

/**
 * Thrown when the running addon predates `code_graph_db` on the repo record. Mapped to 501: this is
 * a capability gap in the engine, not a bad request.
 *
 * WHY this surface gates on a field it does not itself use. The project graph lives in crew's own
 * state directory and is built from `root_path`, so it could be built against any addon. But
 * `code_graph_db` is the engine's statement that it can vouch for where a repo's graph lives, and
 * `/repos/:id/graph` HARD-THROWS without it (repoPaths.ts, deliberately — a local re-derivation is
 * what FINDING-069 was). Quietly serving a project graph on a daemon whose per-repo graph surface
 * cannot answer would leave two graph endpoints disagreeing about whether this repo has a graph at
 * all, and the operator's real problem — a stale addon — unmentioned.
 */
export class ProjectGraphEngineTooOldError extends Error {
  constructor(readonly cause: string) {
    super(cause);
    this.name = 'ProjectGraphEngineTooOldError';
  }
}

function assertEngineFresh(repos: MemberRepo[]): void {
  for (const m of repos) {
    try {
      codeGraphDb(m.repo);
    } catch (err) {
      // A CURRENT engine that resolved no repo-graph root (wicked-core#406) is not a stale addon:
      // its remedy is the daemon's environment, and "engine too old" (501, reinstall) would send
      // the operator the wrong way. Let it through with its own class; the routes classify it.
      if (err instanceof CodeGraphRootUnresolvableError) throw err;
      throw new ProjectGraphEngineTooOldError(message(err));
    }
  }
}

/** Read the project graph's standing without touching it. */
export async function projectGraphStatus(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectGraphStatus> {
  const members = await resolveMembers(adapter, projectId);
  try {
    assertEngineFresh(members.repos);
  } catch (err) {
    if (!(err instanceof ProjectGraphEngineTooOldError)) throw err;
    return {
      projectId,
      state: 'engine-too-old',
      detail: err.cause,
      dbPath: null,
      repos: [],
      missingRepos: members.repos.map((m) => m.repoId),
      staleRepos: [],
      linkage: 'co-located',
      note: CO_LOCATION_NOTE,
      updatedAt: null,
      ...refreshField(projectId),
    };
  }
  const dbPath = projectGraphDb(projectId, env);
  const dbExists = existsSync(dbPath);
  // The manifest is read ONLY when the database exists. A manifest describing rows in a file
  // somebody deleted would make every repo look fresh and every refresh a no-op, leaving the
  // project permanently answering "nothing found" — indistinguishable from a project of empty repos.
  const manifest = dbExists ? await readManifest(projectId, env) : null;
  return buildStatus({ projectId, members, manifest, dbExists, env });
}

// ── Refresh ───────────────────────────────────────────────────────────────────

/** What a refresh was asked to do, and where it may say things. Both optional, both additive. */
export interface RefreshOptions {
  /**
   * Bypass the clean-HEAD skip for every member repo AND pass `--force` to `wicked-estate index`.
   * The migration path: after a wicked-estate upgrade, an UNCHANGED repo never re-indexes under
   * the plain rules, so its rows keep the old binary's id scheme and unresolved accounting until
   * its HEAD happens to move. Costs a full rebuild — the same bound as the project's first build.
   */
  force?: boolean;
  /** Receives one line per index run that wrote to stderr (estate's migration notice, warnings). */
  log?: (msg: string) => void;
}

/**
 * One refresh at a time per project. Two `wicked-estate index` runs against one SQLite file is a
 * writer race, and the second caller wanting the same work done is served by the first — so
 * concurrent callers COALESCE onto the in-flight refresh rather than getting a 409 for asking.
 *
 * Force-aware: a plain caller is served by ANY in-flight refresh (a forced one does strictly more
 * work), and a forced caller is served by an in-flight FORCED one — but never by a plain one,
 * which would silently not-force. A forced request arriving while a plain refresh runs QUEUES
 * behind it (same single-writer rule) and then runs its own build.
 */
interface InFlightRefresh {
  promise: Promise<ProjectGraphRefreshResult>;
  force: boolean;
}
const inFlight = new Map<string, InFlightRefresh>();

export async function refreshProjectGraph(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: RefreshOptions = {},
): Promise<ProjectGraphRefreshResult> {
  const force = opts.force === true;
  const running = inFlight.get(projectId);
  if (running !== undefined && (running.force || !force)) return running.promise;
  const after = running?.promise ?? Promise.resolve(undefined);
  const promise = after
    // The prior refresh's failure belongs to its own caller; this one still runs.
    .catch(() => undefined)
    .then(() => doRefresh(adapter, projectId, env, force, opts.log))
    // The delete is guarded: a queued forced entry replaces a plain one in the map, and the plain
    // one settling must not evict its successor.
    .finally(() => {
      if (inFlight.get(projectId) === entry) inFlight.delete(projectId);
    });
  const entry: InFlightRefresh = { force, promise };
  inFlight.set(projectId, entry);
  return promise;
}

/**
 * A refresh that is never served by one already in flight (crew-0183): the repo watcher's index happened AFTER any
 * refresh running now started, so that refresh may hold the repo's older rows. Waits for it, then refreshes (a plain
 * refresh: unchanged clean members skip). A refresh started after this call coalesces with it, which is fine.
 */
export async function refreshProjectGraphAfter(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: RefreshOptions = {},
): Promise<ProjectGraphRefreshResult> {
  const running = inFlight.get(projectId);
  if (running !== undefined) await running.promise.catch(() => undefined);
  return refreshProjectGraph(adapter, projectId, env, opts);
}

/** Last `max` bytes of a stderr stream, trimmed — enough to carry estate's migration notice. */
const STDERR_TAIL_BYTES = 2048;
function stderrTail(stderr: string, max = STDERR_TAIL_BYTES): string {
  const trimmed = stderr.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(trimmed.length - max)}`;
}

/**
 * One refresh, with its state kept for the project page and diagnostics (wicked-crew#1481): `refreshing` from the
 * start, its budget once the members are sized, the member being indexed; `idle` at the end with the last failure
 * (a member's, or the refresh's own error), cleared by a refresh that lands with none.
 */
async function doRefresh(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv,
  force: boolean,
  log?: (msg: string) => void,
): Promise<ProjectGraphRefreshResult> {
  const prior = refreshStates.get(projectId);
  const st: ProjectGraphRefreshState = {
    state: 'refreshing',
    startedAt: Date.now(),
    finishedAt: prior?.finishedAt ?? null,
    budgetMs: null,
    repoId: null,
    repoStartedAt: null,
    repoBudgetMs: null,
    lastFailure: prior?.lastFailure ?? null,
  };
  refreshStates.set(projectId, st);
  let lastFailure: ProjectGraphRefreshFailure | null = null;
  let result: ProjectGraphRefreshResult;
  try {
    result = await refreshOnce(adapter, projectId, env, force, st, log);
    const failedRow = [...(result.repos ?? [])].reverse().find((r) => r.action === 'failed');
    const linkFailed =
      result.link?.error ?? ((result.link?.incomplete?.length ?? 0) > 0 ? `incomplete: ${result.link!.incomplete!.join(', ')}` : undefined);
    if (failedRow === undefined && linkFailed !== undefined) {
      // The indexes landed but the link step did not publish (codex r1): still a failure, owed by the watcher.
      lastFailure = { at: Date.now(), repoId: null, label: null, error: `the link step did not publish: ${linkFailed}`, timedOut: false, budgetMs: null };
    }
    // crew#1497 (codex r2 #1): a graph read-only seats cannot read is a failed refresh, said in its status and owed.
    const readers = graphReadersError(projectGraphDb(projectId, env));
    if (failedRow === undefined && linkFailed === undefined && readers !== null) {
      lastFailure = { at: Date.now(), repoId: null, label: null, error: `the graph is not ready for read-only seats: ${readers}`, timedOut: false, budgetMs: null };
    }
    if (failedRow !== undefined) {
      lastFailure = {
        at: Date.now(),
        repoId: failedRow.repoId,
        label: failedRow.label,
        error: failedRow.error ?? 'the index failed',
        timedOut: failedRow.timedOut === true,
        budgetMs: failedRow.budget?.budgetMs ?? null,
      };
    }
  } catch (err) {
    lastFailure = { at: Date.now(), repoId: null, label: null, error: message(err), timedOut: false, budgetMs: null };
    throw err;
  } finally {
    st.state = 'idle';
    st.finishedAt = Date.now();
    st.repoId = null;
    st.repoStartedAt = null;
    st.repoBudgetMs = null;
    st.lastFailure = lastFailure;
  }
  // The status the result carries was read mid-refresh; it reports the refresh as it ended.
  return { ...result, status: { ...result.status, ...refreshField(projectId) } };
}

async function refreshOnce(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv,
  force: boolean,
  st: ProjectGraphRefreshState,
  log?: (msg: string) => void,
): Promise<ProjectGraphRefreshResult> {
  const members = await resolveMembers(adapter, projectId);
  assertEngineFresh(members.repos);

  const dbPath = projectGraphDb(projectId, env);
  const indexed: string[] = [];
  const skipped: string[] = [];
  const failed: ProjectGraphRefreshResult['failed'] = [];
  const repoRows: NonNullable<ProjectGraphRefreshResult['repos']> = [];

  // No members and no graph: nothing to build and nothing to prune (crew#1476 prunes an existing one below).
  if (members.repos.length === 0 && !existsSync(dbPath)) {
    return {
      status: buildStatus({ projectId, members, manifest: null, dbExists: false, env }),
      indexed,
      skipped,
      failed,
      repos: repoRows,
    };
  }

  assertLabelsUnique(members.repos);

  if (members.repos.length > 0 && !(await estateSupportsMultiRepo(env))) {
    // Refusing is the ONLY safe answer. An estate without `--repo` accepts the flag, drops it, and
    // exits 0, so proceeding would co-locate three repos into a database holding one of them, with
    // nothing in any output to say so.
    throw new Error(
      `${estateExe(env)} does not support 'index --repo <name>' (wicked-estate#117). ` +
        `Older builds ACCEPT the flag, ignore it, and exit 0 — every member repo after the first ` +
        `would silently overwrite the one before it. Upgrade that binary, or point ` +
        `WICKED_ESTATE_EXE at a build that has it.`,
    );
  }

  // Every member's index budget, sized by the engine (wicked-crew#1481): the refresh's budget is their sum. Each
  // member is sized AGAIN right before its own index (its checkout may have moved while earlier members indexed,
  // codex r1). An addon that cannot size one refuses the refresh rather than guess a bound.
  const budgets = new Map<string, IndexBudget>();
  for (const m of members.repos) budgets.set(m.label, await adapter.indexBudget(m.repo.root_path));
  st.budgetMs = [...budgets.values()].reduce((sum, b) => sum + b.budgetMs, 0);

  await mkdir(dirname(dbPath), { recursive: true });
  let dbExisted = existsSync(dbPath);
  const prior = dbExisted ? await readManifest(projectId, env) : null;
  const currentLabels = new Set(members.repos.map((m) => m.label));
  const pruned = (prior?.repos ?? []).map((r) => r.label).filter((label) => !currentLabels.has(label));
  if (dbExisted && pruned.length > 0) {
    // crew#1476: estate has no per-label delete; rebuild only on refresh, including journal siblings.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        await unlink(`${dbPath}${suffix}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    dbExisted = false;
    // The old manifest describes the database just deleted. Left in place, the first member to re-index
    // recreates the db and status reads every not-yet-rebuilt member as indexed (`ready` mid-rebuild).
    await writeManifest(projectId, { version: 1, projectId, repos: [] }, env);
    log?.(`project graph ${projectId}: rebuild to prune removed labels ${pruned.join(', ')}`);
  }
  const priorByLabel = new Map((prior?.repos ?? []).map((r) => [r.label, r]));
  // Prior rows survive a refresh only if the database they describe does. When it does not, every
  // repo is re-indexed and the manifest is rebuilt from this run alone.
  const rows: ManifestRepo[] = dbExisted ? [...(prior?.repos ?? [])] : [];
  // FALSE at the start of EVERY refresh, deliberately — not seeded from the prior manifest.
  //
  // Seeding it from "a previous run wrote labels" makes the evidence check a one-time initiation
  // rite, and the thing it guards against is not a property of the graph, it is a property of the
  // BINARY THIS RUN WILL USE. A `wicked-estate` that advertises `--repo` and drops it (0.14.4's
  // behaviour under a newer usage banner — a vendored build, a downgrade, a WICKED_ESTATE_EXE
  // pointed somewhere else) sails past the help-text probe, and with the check already "verified"
  // nothing looks at the database again: the refresh answers 200 / `indexed: [...]` / `failed: []`
  // and the status reads `ready` with `missingRepos: []` while every repo's rows have been
  // overwritten by unlabelled ones and every query returns `[]`. Reproduced end-to-end against the
  // real 0.14.4 before this line changed.
  //
  // The price is one extra `stats` per refresh that indexes anything at all, and none when every
  // repo skips.
  let verifiedLabelling = false;

  for (const m of members.repos) {
    const head = await cleanHead(m.repo.root_path);
    const before = priorByLabel.get(m.label);
    // Skip only on POSITIVE evidence: a clean checkout, at the same commit the graph already holds,
    // in the same place it was indexed from. Anything less re-indexes — estate's own incremental
    // digest skip usually makes an unchanged re-index cheap (the exception is estate's id_scheme
    // migration gate, which turns the first index under a new scheme into a full re-extract — once,
    // and the stderr tail on the repo's row says so), so the cost of being wrong here is bounded,
    // never a stale answer.
    //
    // `force` bypasses this ON PURPOSE: the skip fires on git evidence alone, so it also skips a
    // repo whose rows were written by an OLDER estate binary — the one situation where "unchanged
    // checkout" does not mean "current graph". Force is the migration path for exactly that.
    if (
      !force &&
      dbExisted &&
      before !== undefined &&
      head !== null &&
      before.head === head &&
      before.rootPath === m.repo.root_path
    ) {
      skipped.push(m.label);
      repoRows.push({ repoId: m.repoId, label: m.label, action: 'skipped-head-unchanged' });
      continue;
    }
    const sized = budgets.get(m.label)!;
    const budget = await adapter.indexBudget(m.repo.root_path);
    st.budgetMs = (st.budgetMs ?? 0) - sized.budgetMs + budget.budgetMs;
    const budgetInfo = { budgetMs: budget.budgetMs, trackedFiles: budget.trackedFiles };
    st.repoId = m.repoId;
    st.repoStartedAt = Date.now();
    st.repoBudgetMs = budget.budgetMs;
    try {
      const { stderr } = await indexWithinBudget(
        estateExe(env),
        [
          'index',
          m.repo.root_path,
          '--db',
          dbPath,
          '--repo',
          m.label,
          // estate's own digest skip would otherwise no-op an unchanged repo, leaving the very rows
          // a forced refresh exists to rewrite.
          ...(force ? ['--force'] : []),
        ],
        m.repo.root_path,
        m.label,
        budget,
      );
      // The index child's stderr used to be discarded here, which swallowed estate's id_scheme
      // migration notice — the ONE signal explaining why a one-second incremental refresh suddenly
      // ran for minutes. Bounded tail on the repo's row, full-line through the logger.
      const tail = stderrTail(stderr);
      if (tail !== '') log?.(`wicked-estate index ${m.label} (project ${projectId}) stderr: ${tail}`);
      if (!verifiedLabelling) {
        if (!(await graphHoldsLabel(dbPath, m.label, env))) {
          throw new EstateDroppedRepoLabelError(
            `wicked-estate indexed ${m.repoId} but the graph records no repo labelled ` +
              `'${m.label}' — the binary accepted --repo and ignored it, so the next repo would ` +
              `overwrite this one. Refusing to continue; delete ${dbPath} and upgrade wicked-estate.`,
          );
        }
        verifiedLabelling = true;
      }
      const row: ManifestRepo = {
        repoId: m.repoId,
        label: m.label,
        rootPath: m.repo.root_path,
        ...(head === null ? {} : { head }),
        indexedAt: Date.now(),
      };
      const at = rows.findIndex((r) => r.label === m.label);
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      indexed.push(m.label);
      repoRows.push({
        repoId: m.repoId,
        label: m.label,
        action: 'indexed',
        ...(tail === '' ? {} : { stderrTail: tail }),
        budget: budgetInfo,
      });
    } catch (err) {
      // A binary that drops `--repo` is a property of the RUN, not of this repo: every remaining
      // member would index over the rows just written, so this refresh stops here.
      //
      // And the PRIOR manifest goes with it. By the time the evidence check can fire, the offending
      // index has already run: whatever labelled rows the database held have been overwritten by
      // unlabelled ones. Leaving the manifest describing them makes the refusal loud on the write
      // path and silent on the read path — `GET /graph` keeps answering `ready` / `missingRepos:
      // []` while every query returns `[]` at 200, which is the exact shape this surface exists to
      // refuse. Emptying it re-derives the truth: nothing in that database can be attributed to a
      // repo, so the project is `not-indexed` and the query routes refuse WITH A CAUSE. The
      // database itself is left on disk, because the error names deleting it as the operator's
      // step and destroying data on the way out of an error path is not this function's call.
      if (err instanceof EstateDroppedRepoLabelError) {
        await writeManifest(projectId, { version: 1, projectId, repos: [] }, env);
        throw err;
      }
      // Only the index itself can run past its budget; the label check's own stats query is not it (codex r2).
      const timedOut = err instanceof IndexBudgetExceeded;
      const error = err instanceof ExecOutputTooLarge ? err.message : message(err);
      failed.push({ repoId: m.repoId, label: m.label, error });
      // execFile errors carry the child's stderr; the failure tail is worth as much as a success's.
      const errStderr = (err as { stderr?: unknown }).stderr;
      const tail = typeof errStderr === 'string' ? stderrTail(errStderr) : '';
      if (tail !== '') log?.(`wicked-estate index ${m.label} (project ${projectId}) stderr: ${tail}`);
      repoRows.push({
        repoId: m.repoId,
        label: m.label,
        action: 'failed',
        error,
        ...(tail === '' ? {} : { stderrTail: tail }),
        ...(timedOut ? { timedOut: true as const } : {}),
        budget: budgetInfo,
      });
    } finally {
      st.repoId = null;
      st.repoStartedAt = null;
      st.repoBudgetMs = null;
    }
  }

  const manifest: Manifest = { version: 1, projectId, repos: rows };
  await writeManifest(projectId, manifest, env);
  // X1: link LAST, over the current members, once every index of this refresh has finished.
  const link = await linkMembers(
    projectId,
    dbPath,
    members.repos.map((m) => m.label),
    env,
    log,
  );
  // crew#1497: the last write of a refresh. Seats read the graph from a directory they cannot write.
  if (existsSync(dbPath)) {
    const why = await prepareGraphForReaders(dbPath, env);
    if (why !== null) log?.(`project graph ${projectId}: ${dbPath} is not ready for read-only seats (${why}); their estate refuses it, with this cause, until the next refresh`);
  }
  return {
    status: buildStatus({ projectId, members, manifest, dbExists: existsSync(dbPath), env }),
    indexed,
    skipped,
    failed,
    repos: repoRows,
    ...(link === undefined ? {} : { link }),
    ...(pruned.length === 0 ? {} : { pruned }),
  };
}

// ── Binding a run to the project graph ────────────────────────────────────────

/**
 * Passed to the engine as `LaunchOptions.projectGraph`. `repoLabel` names this run's repo inside
 * the co-located graph so the engine can confirm the graph actually holds it; a repo-less run
 * carries no label because it has no own repo to confirm.
 */
export interface ProjectGraphBinding {
  dbPath: string;
  repoLabel?: string;
}

/**
 * What a launch decided about the project graph, and why. The `reason` is carried on BOTH outcomes
 * because "you got the project graph" and "you got the repo graph instead, because X" are equally
 * worth saying, and the operator asking "why can't this run see the sibling repo" needs the second
 * one to have been recorded somewhere.
 */
export interface ProjectGraphBindingDecision {
  /** The binding to hand the engine; `null` ⇒ the run keeps whatever graph it would have had. */
  binding: ProjectGraphBinding | null;
  /** One sentence: what the run got, and what would change it. */
  reason: string;
  /** The UI action that would change a `binding: null` outcome, when one would (F-2R2-008):
   *  `projects.graph.refresh` = build/refresh the project graph from the project page. */
  action?: ProjectGraphAction;
}

/**
 * How many repo labels a binding reason names before it starts counting instead. Eight fits a
 * readable log line and covers every project anyone has built so far; past that the count carries
 * the information and the labels are just volume.
 */
const MAX_NAMED_LABELS = 8;

/** `a, b, c` — or `a, b, … and 12 more` once the list stops being readable. */
function labelList(labels: string[]): string {
  if (labels.length <= MAX_NAMED_LABELS) return labels.join(', ');
  const shown = labels.slice(0, MAX_NAMED_LABELS).join(', ');
  return `${shown}, and ${labels.length - MAX_NAMED_LABELS} more`;
}

/**
 * What a run actually falls back TO when the project graph is unavailable — which is not the same
 * sentence for every run, and saying the wrong one misdirects the operator reading it.
 *
 * A repo-bound run degrades to its own repo's graph: strictly less than the project's, still a
 * complete description of the worktree the worker sits in. A repo-LESS run (the interactive
 * draft/demo seams, which launch with no `repoRef` at all) has no own repo to degrade to, so it
 * gets nothing. Telling such a run it "uses its own repo's code graph" names a graph that does not
 * exist and sends whoever is debugging it looking for one.
 */
function degradedTo(repoRef: string | undefined, subject: BindingSubject): string {
  if (subject === 'chat') return 'Chat still reads the repositories directly.';
  return repoRef === undefined
    ? 'This repo-less run gets no code graph.'
    : "This run uses its own repo's code graph in the meantime.";
}

/**
 * WHO is asking for the binding — a governed run or a chat. The two degrade to different things
 * (a chat has no worktree and no "own repo", it keeps reading the scoped roots directly), and
 * F-2R2-008 recorded a 9-repo project chat being told "this repo-less run gets no code graph".
 */
export type BindingSubject = 'run' | 'chat';

export interface ResolveBindingOptions {
  /** Default `'run'`. */
  subject?: BindingSubject;
}

/**
 * Decide which code graph a run launched into `projectId` should be bound to.
 *
 * # This never indexes
 *
 * A refresh is `wicked-estate index` per member repo, bounded by its index budget EACH (#1481). Doing that
 * inside a launch would turn "start a run" into an unannounced multi-repo indexing job that blocks
 * the response, and the first thing an operator would learn about it is a request that appears to
 * hang. So a missing or stale graph DEGRADES the run to the per-repo graph and says so; refreshing
 * stays an explicit `POST /projects/:id/graph/refresh`.
 *
 * # Why the run's OWN repo decides it
 *
 * The engine independently verifies whatever it is handed and falls back on its own, so this
 * function cannot make a run unsafe — but it can make one confusing, and it has information the
 * engine does not. `projectGraphStatus` knows a repo was attached after the last refresh, that its
 * registry root moved out from under the label, that its member ref is dangling. Declining HERE,
 * with that cause attached, is the difference between an operator reading "attached since the last
 * refresh — not in the graph yet" and reading the engine's generic "no files under that label".
 *
 * The rule itself is the engine's, restated on this side: bind when the graph holds THIS RUN'S
 * repo. A graph missing some OTHER member is still bound — it is strictly more than the per-repo
 * graph, and the run's own code is described correctly. A graph missing THIS repo is not, because
 * its answers about the worktree the worker is sitting in would all be "nothing found".
 */
export async function resolveProjectGraphBinding(
  adapter: CoreAdapter,
  projectId: string,
  repoRef: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveBindingOptions = {},
): Promise<ProjectGraphBindingDecision> {
  const subject: BindingSubject = opts.subject ?? 'run';
  let status: ProjectGraphStatus;
  try {
    status = await projectGraphStatus(adapter, projectId, env);
  } catch (err) {
    // A CURRENT engine that resolved no repo-graph root at all (wicked-core#406): there is no
    // per-repo graph to degrade to either — the engine will ship the worker no estate tools —
    // so the reason must not promise one. Name the environment fault instead; it is the remedy.
    if (err instanceof CodeGraphRootUnresolvableError) {
      return {
        binding: null,
        reason:
          `no code graph can be bound: ${err.finding.message}. This run gets no code graph ` +
          `(not the project's, not its own repo's) until the daemon's environment resolves a ` +
          `repo-graph root.`,
      };
    }
    // Resolving the binding is an ENHANCEMENT to the launch. A project whose membership cannot be
    // read, or an addon too old to vouch for repo graph paths, must not take the run down with it —
    // the run is still perfectly launchable against its own repo's graph.
    return {
      binding: null,
      reason: `the project graph could not be read (${message(err)}). ${degradedTo(repoRef, subject)}`,
    };
  }

  if (status.dbPath === null) {
    return {
      binding: null,
      reason: `${status.detail} ${degradedTo(repoRef, subject)}`,
      ...(status.action !== undefined ? { action: status.action } : {}),
    };
  }

  // A repo-less run has no own-repo that could be missing from the graph, so any graph with
  // something in it is a strict gain over the nothing such a run gets today.
  if (repoRef === undefined) {
    const indexed = status.repos.filter((r) => r.indexed);
    if (indexed.length === 0) {
      return {
        binding: null,
        reason: `${status.detail} ${degradedTo(repoRef, subject)}`,
        ...(status.action !== undefined ? { action: status.action } : {}),
      };
    }
    // The COUNT is exact; the label list is capped. This string is a log line on every repo-less
    // launch, and a project with a hundred members would put a hundred labels on one line of every
    // operator's structured logs — the labels are there to make the answer recognisable at a
    // glance, which a wall of them defeats. Naming a few and counting the rest keeps both.
    return {
      binding: { dbPath: status.dbPath },
      reason:
        `this repo-less run is bound to the project graph (${indexed.length} repo(s): ` +
        `${labelList(indexed.map((r) => r.label))}).`,
    };
  }

  const own = status.repos.find((r) => r.repoId === repoRef);
  if (own === undefined) {
    // The run targets a repo that is not a member of the project it is filed into. Legal — filing a
    // run and attaching a repo are separate acts — but the project graph provably does not describe
    // this repo, so there is nothing to gain and an own-repo blind spot to lose.
    return {
      binding: null,
      reason:
        // Customer copy (crew#1036): a chat's scope card shows this, so no raw id or route.
        `repo '${repoRef}' is not a member of this project, so the project graph does not ` +
        `describe it; this run uses the repo's own code graph. Attach it on the project's ` +
        `Repositories tab and refresh the graph to widen future runs.`,
    };
  }
  if (!own.indexed) {
    // The remedy comes from the ROW, which knows the cause, and is omitted when no single action
    // resolves it. Appending "a refresh fixes it" unconditionally — the first cut — was wrong for
    // two of the four causes: a DANGLING member ref has no registered repo to index, and a MOVED
    // root carries its own longer remedy (estate refuses to rebind the label, so the graph must be
    // rebuilt). An operator mid-incident who runs the suggested refresh and sees nothing change
    // has lost the time and stopped believing the next sentence.
    return {
      binding: null,
      reason:
        `the project graph does not hold '${repoRef}' (${own.reason ?? 'not indexed'}), so binding ` +
        `it would give this run tools that answer "not found" about its own worktree; it uses the ` +
        `repo's own code graph instead.${own.remedy === undefined ? '' : ` ${own.remedy}`}`,
    };
  }

  // Bound. Staleness is NOT checked: `own.head` is the commit indexed, the worktree is wherever it
  // is now, and every code graph — including the per-repo one this would fall back to — is behind
  // its checkout the moment anyone commits. Refusing on drift would disqualify the project graph
  // after a single commit and hand back a graph with exactly the same drift and less in it.
  const partial = status.missingRepos.length;
  return {
    binding: { dbPath: status.dbPath, repoLabel: own.label },
    reason:
      `bound to the project graph as '${own.label}'` +
      (own.head === undefined ? '' : ` (indexed at ${own.head.slice(0, 8)})`) +
      (partial === 0
        ? '.'
        : `; ${partial} member repo(s) are not in it, so cross-repo answers are partial.`),
  };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * A query can run only against a graph that exists and holds at least one MEMBER repo. Anything
 * else is returned as the status, so the caller gets the cause and the remedy instead of `[]`.
 */
export type Queryable =
  | { ok: true; dbPath: string; status: ProjectGraphStatus; labels: Map<string, string> }
  | { ok: false; status: ProjectGraphStatus };

export async function queryable(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Queryable> {
  const status = await projectGraphStatus(adapter, projectId, env);
  if (status.state !== 'ready' && status.state !== 'ready-single-repo') return { ok: false, status };
  const labels = new Map(status.repos.filter((r) => r.indexed).map((r) => [r.label, r.repoId]));
  return { ok: true, dbPath: status.dbPath as string, status, labels };
}

/**
 * Split an estate path into the repo it belongs to and the repo-relative path inside it.
 *
 * `null` when the prefix is not a CURRENT member's label: rows of a repo that has since been
 * detached are still in the database (estate has no per-label delete), and returning them under a
 * project-scoped query would answer about a repo the project no longer contains. They are excluded
 * here and named in `status.staleRepos` until refresh rebuilds without them (crew#1476).
 */
function attribute(
  path: string,
  labels: Map<string, string>,
): { repo: string; repoId: string; file: string } | null {
  const slash = path.indexOf('/');
  if (slash <= 0) return null;
  const label = path.slice(0, slash);
  const repoId = labels.get(label);
  if (repoId === undefined) return null;
  return { repo: label, repoId, file: path.slice(slash + 1) };
}

/**
 * estate's raw hit list → attributed hits plus their per-repo counts. THE federation step, and the
 * only place a result acquires its provenance — exported so the attribution rules are testable
 * without a graph on disk, which is what makes the stale-label exclusion below coverable at all.
 */
export function attributeHits(
  raw: unknown,
  labels: Map<string, string>,
  detached: ReadonlySet<string> = new Set(),
): { hits: ProjectGraphHit[]; byRepo: ProjectGraphRepoCount[] } {
  const hits: ProjectGraphHit[] = [];
  // crew#1714: the rows left out (a removed member's) are not in the answer, so a `via` edge to one
  // points at nothing a client can place: it goes with them, as does one to a `detached` symbol
  // (a removed member's end of a crossing, which may be a start rather than a row).
  const dropped = new Set<string>(detached);
  for (const r of Array.isArray(raw) ? (raw as RawHit[]) : []) {
    const h = toHit(r, labels);
    if (h !== null) hits.push(h);
    else if (typeof r?.id === 'string') dropped.add(r.id);
  }
  if (dropped.size > 0) {
    for (const h of hits) if (h.via !== undefined) h.via = h.via.filter((v) => !dropped.has(v.id));
  }
  return { hits, byRepo: countByRepo(hits) };
}

function countByRepo(hits: ProjectGraphHit[]): ProjectGraphRepoCount[] {
  const counts = new Map<string, ProjectGraphRepoCount>();
  for (const h of hits) {
    const row = counts.get(h.repo);
    if (row === undefined) counts.set(h.repo, { repoId: h.repoId, repo: h.repo, count: 1 });
    else row.count += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

interface RawHit {
  id?: unknown;
  symbol_id?: unknown;
  name?: unknown;
  kind?: unknown;
  file?: unknown;
  line?: unknown;
  depth?: unknown;
  stale?: unknown;
  via_crossing?: unknown;
  via_crossing_omitted?: unknown;
  via?: unknown;
  via_omitted?: unknown;
}

/** crew#1714: estate's `via` (wicked-estate#557): `{id, kind}` edges to the inner ring; `kind` is the
 *  edge-kind wire form, a string or `{other: <tag>}`. A malformed entry is left out, never guessed. */
function viaOf(raw: unknown): ProjectGraphVia[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((v: unknown): ProjectGraphVia[] => {
    const { id, kind } = (v ?? {}) as { id?: unknown; kind?: unknown };
    if (typeof id !== 'string') return [];
    if (typeof kind === 'string') return [{ id, kind }];
    const other = (kind as { other?: unknown } | null)?.other;
    return typeof other === 'string' ? [{ id, kind: { other } }] : [];
  });
}

function toHit(raw: RawHit, labels: Map<string, string>): ProjectGraphHit | null {
  const file = typeof raw.file === 'string' ? raw.file : '';
  const where = attribute(file, labels);
  if (where === null) return null;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.symbol_id === 'string' ? raw.symbol_id : '';
  const via = viaOf(raw.via);
  return {
    repoId: where.repoId,
    repo: where.repo,
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    file: where.file,
    line: typeof raw.line === 'number' ? raw.line : 0,
    ...(typeof raw.depth === 'number' ? { depth: raw.depth } : {}),
    ...(raw.stale === 'modified' || raw.stale === 'deleted' ? { stale: raw.stale } : {}),
    ...(typeof raw.via_crossing === 'string' ? { via_crossing: raw.via_crossing } : {}),
    ...(raw.via_crossing_omitted === true ? { via_crossing_omitted: true } : {}),
    ...(via === undefined ? {} : { via }),
    ...(typeof raw.via_omitted === 'number' ? { via_omitted: raw.via_omitted } : {}),
  };
}

/** Safety stop for following estate's blast-radius cursor: a server that kept issuing cursors would
 *  loop forever. 200 pages of ~235 rows is far past any real answer. */
const MAX_BLAST_PAGES = 200;

/** crew#1556: estate's cap on the stale-file sample, retained across reply pages. */
const STALE_FILES_CAP = 20;

function mergeFreshness(pages: BlastRadiusFreshness[]): BlastRadiusFreshness {
  const staleFiles = new Map<string, NonNullable<BlastRadiusFreshness['stale_files']>[number]>();
  const indexing = new Set<string>();
  let commitsBehind: number | null | undefined;
  let unindexedFiles: number | null = null;
  let staleFilesTotal = 0;
  let checkedFiles = 0;
  let notFileBacked = 0;
  let totalPartial = false;
  for (const page of pages) {
    if (page.stale_files_total_partial === true) totalPartial = true;
    for (const row of page.stale_files ?? []) {
      if (!staleFiles.has(row.file) && staleFiles.size < STALE_FILES_CAP) staleFiles.set(row.file, row);
    }
    for (const label of page.indexing ?? []) indexing.add(label);
    if (page.commits_behind === null) commitsBehind = null;
    else if (commitsBehind !== null && typeof page.commits_behind === 'number') {
      commitsBehind = Math.max(commitsBehind ?? 0, page.commits_behind);
    }
    if (typeof page.unindexed_files === 'number') unindexedFiles = Math.max(unindexedFiles ?? 0, page.unindexed_files);
    // crew#1556: per-page counts; a file spanning pages counts once on each page.
    if (typeof page.stale_files_total === 'number') staleFilesTotal += page.stale_files_total;
    if (typeof page.checked_files === 'number') checkedFiles += page.checked_files;
    if (typeof page.not_file_backed === 'number') notFileBacked += page.not_file_backed;
  }
  const roots = pages.at(-1)?.roots;
  return {
    stale_files: [...staleFiles.values()], stale_files_total: staleFilesTotal,
    ...(totalPartial ? { stale_files_total_partial: true as const } : {}),
    checked_files: checkedFiles, not_file_backed: notFileBacked,
    ...(commitsBehind === undefined ? {} : { commits_behind: commitsBehind }),
    unindexed_files: unindexedFiles, indexing: [...indexing],
    ...(roots === undefined ? {} : { roots }),
  };
}

/**
 * crew#1713: ONE reply page's freshness, current members only. A removed member's rows stay in the
 * database until the next refresh, and estate counts their files too, so its stale files leave the
 * page's total (the sample's and every stale-marked row's: estate marks every drifted row unless its
 * budget dropped the marks, and then the sample still names them up to its cap) and its label leaves
 * `indexing`. Per page, before the pages are summed (crew#1556 counts a file once per page). Paths
 * stay estate's; {@link attributeFreshness} attributes them.
 */
function memberFreshness(raw: BlastRadiusFreshness, page: Record<string, unknown>, labels: Map<string, string>): BlastRadiusFreshness {
  const dependents = page['dependents'];
  const member = (file: string) => attribute(file, labels) !== null;
  const removed = new Set<string>();
  const kept = raw.stale_files?.filter((row) => {
    if (typeof row?.file === 'string' && member(row.file)) return true;
    if (typeof row?.file === 'string') removed.add(row.file);
    return false;
  });
  const rows = Array.isArray(dependents) ? (dependents as RawHit[]) : [];
  let anyMarked = false;
  const rowFiles = new Set<string>();
  for (const row of rows) {
    const marked = row?.stale === 'modified' || row?.stale === 'deleted';
    if (marked) anyMarked = true;
    if (typeof row?.file === 'string') rowFiles.add(row.file);
    if (marked && typeof row.file === 'string' && !member(row.file)) removed.add(row.file);
  }
  // crew#1797: estate's budget can drop the row marks and empty the sample while it keeps the count. A counted file
  // that no sample entry or mark names may then be a removed member's, and crew cannot take it out: the total is
  // marked partial (an upper bound). Only when the count is not explained by the named member files AND the page
  // carries a file outside the members that is not accounted for: removed already, or a dependents row whose missing
  // mark (with marks present on the page) says it is not stale. Every file the probe counted is looked at, the name
  // miss's `suggestions` included.
  const unexplained = typeof raw.stale_files_total === 'number' && raw.stale_files_total - removed.size > (kept?.length ?? 0);
  const probed = new Set<string>();
  probedFiles(page, probed);
  const unknown = [...probed].some((file) => !member(file) && !removed.has(file) && !(anyMarked && rowFiles.has(file)));
  const partial = unexplained && unknown;
  const { indexing, ...rest } = raw;
  delete rest.stale_files;
  return {
    ...rest,
    ...(typeof raw.stale_files_total === 'number'
      ? { stale_files_total: Math.max(kept?.length ?? 0, raw.stale_files_total - removed.size) }
      : {}),
    ...(partial ? { stale_files_total_partial: true as const } : {}),
    ...(Array.isArray(indexing) ? { indexing: indexing.filter((label) => labels.has(label)) } : {}),
    ...(kept === undefined ? {} : { stale_files: kept }),
  };
}

/**
 * The files estate's freshness probe checks on a reply page: every non-empty `file` string, and every `files` /
 * `*_files` path list, anywhere in it but the `freshness` block (wicked-estate `freshness.rs` `collect_files`).
 */
function probedFiles(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const item of v) probedFiles(item, out);
    return;
  }
  if (v === null || typeof v !== 'object') return;
  for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
    if (k === 'freshness') continue;
    if (k === 'file' && typeof child === 'string') {
      if (child !== '') out.add(child);
    } else if ((k === 'files' || k.endsWith('_files')) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === 'string') {
          if (item !== '') out.add(item);
        } else probedFiles(item, out);
      }
    } else probedFiles(child, out);
  }
}

/** crew#1555: attribute the (member-scoped, {@link memberFreshness}) sample and remove host paths. */
function attributeFreshness(raw: BlastRadiusFreshness, labels: Map<string, string>): ProjectBlastRadiusFreshness {
  const { stale_files, ...rest } = raw;
  delete rest.roots;
  return {
    ...rest,
    ...(stale_files === undefined ? {} : { stale_files: stale_files.flatMap((row) => {
      const where = attribute(row.file, labels);
      return where === null ? [] : [{ ...where, status: row.status }];
    }) }),
  };
}

/**
 * `wicked-estate blast-radius --json`, EVERY page of it (operator ruling "full graph"; estate#279,
 * wicked-estate 0.28.0+). estate pages a wide answer: a page names the rest with `next_cursor`
 * (null on the last page), and `--cursor` returns the next rows of the SAME answer. The pages'
 * `dependents` are joined and freshness is merged (crew#1556); other fields are the LAST page's, so once every page is in,
 * `truncated_dependents` says only what the walk itself cut (and `next_cursor` is null). A cursor
 * still unread at the page cap is left on the answer with that page's `truncated_dependents`, so
 * the unread rows read as cut, never as absent. An estate that does not page sends no
 * `next_cursor`: one call, its JSON unchanged. Shared by the repo route and the project route.
 */
export async function readBlastRadiusPages(
  exe: string,
  name: string,
  dbPath: string,
  opts: { timeout: number; cwd?: string },
  /** Applied to each page's freshness before the pages merge (the project route scopes it to members). */
  pageFreshness?: (freshness: BlastRadiusFreshness, page: Record<string, unknown>) => BlastRadiusFreshness,
): Promise<Record<string, unknown>> {
  const dependents: unknown[] = [];
  const freshnessPages: BlastRadiusFreshness[] = [];
  let first: Record<string, unknown> | null = null;
  let last: Record<string, unknown> = {};
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_BLAST_PAGES; pages += 1) {
    const args = ['blast-radius', name, '--db', dbPath, '--json', ...(cursor === null ? [] : ['--cursor', cursor])];
    const { stdout } = await execCapped(exe, args, opts);
    last = JSON.parse(stdout) as Record<string, unknown>;
    first ??= last;
    if (last['freshness'] !== null && typeof last['freshness'] === 'object') {
      if (pageFreshness !== undefined) last['freshness'] = pageFreshness(last['freshness'] as BlastRadiusFreshness, last);
      freshnessPages.push(last['freshness'] as BlastRadiusFreshness);
    }
    if (Array.isArray(last['dependents'])) dependents.push(...(last['dependents'] as unknown[]));
    cursor = typeof last['next_cursor'] === 'string' && last['next_cursor'] !== '' ? last['next_cursor'] : null;
    if (cursor === null) break;
  }
  if (first === last) return last;
  const merged: Record<string, unknown> = { ...last, dependents };
  if (freshnessPages.length > 0) merged['freshness'] = mergeFreshness(freshnessPages);
  // The joined rows' window: from the first page's start, over the last page's total.
  const p0 = first?.['page'] as { from?: unknown } | undefined;
  const pn = last['page'] as { total?: unknown } | undefined;
  if (pn !== undefined && pn !== null && typeof pn === 'object') {
    merged['page'] = { count: dependents.length, from: typeof p0?.from === 'number' ? p0.from : 0, total: pn.total };
  }
  return merged;
}

/** Dependents of a symbol across every member repo, each hit attributed to the repo it is in. */
export async function projectBlastRadius(
  q: Extract<Queryable, { ok: true }>,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectBlastRadius> {
  const raw = (await readProjectGraph(q.dbPath, () => readBlastRadiusPages(
    estateExe(env), name, q.dbPath, { timeout: QUERY_TIMEOUT_MS },
    (freshness, page) => memberFreshness(freshness, page, q.labels),
  ), env)) as {
    dependents?: RawHit[];
    resolved?: unknown;
    freshness?: BlastRadiusFreshness;
    unresolved?: number;
    target?: string;
    truncated_dependents?: unknown;
    searched_depth?: unknown;
    depth_horizon_reached?: unknown;
    node_cap_reached?: unknown;
    crossings?: unknown;
    crossings_total?: unknown;
    crossings_truncated?: unknown;
    link?: unknown;
  };
  // X1: estate lists the same (shallowest, capped) crossings on every page; the last page's list.
  // Only crossings between CURRENT members count: a removed member's links stay in the database
  // until the next refresh relinks without it, and must not make an answer read `linked`.
  const { crossings, dropped, detached } = memberCrossings(raw.crossings, q.labels);
  const { hits: allHits, byRepo } = attributeHits(raw.dependents, q.labels, detached);
  // A hit reached through a dropped crossing loses its provenance claim along with the crossing.
  const hits = allHits.map((h) => {
    if (h.via_crossing === undefined || !dropped.has(h.via_crossing)) return h;
    const kept: ProjectGraphHit = { ...h };
    delete kept.via_crossing;
    delete kept.via_crossing_omitted;
    return kept;
  });
  const linked = crossings.length > 0;
  const link = linkState(raw.link, q.status.projectId, q.labels);
  // crew#751: estate's completeness causes (wicked-estate#222), carried through verbatim when the
  // installed estate reports them, and ABSENT when it does not — never a fabricated `false`, which
  // would read as "the walk was complete" on an estate that cannot say.
  const causes = {
    ...(typeof raw.depth_horizon_reached === 'boolean' ? { depth_horizon_reached: raw.depth_horizon_reached } : {}),
    ...(typeof raw.node_cap_reached === 'boolean' ? { node_cap_reached: raw.node_cap_reached } : {}),
    ...(typeof raw.searched_depth === 'number' ? { searched_depth: raw.searched_depth } : {}),
    ...(typeof raw.truncated_dependents === 'number' ? { truncated_dependents: raw.truncated_dependents } : {}),
  };
  return {
    ...causes,
    ...(typeof raw.resolved === 'boolean' ? { resolved: raw.resolved } : {}),
    ...(raw.freshness === undefined ? {} : { freshness: attributeFreshness(raw.freshness, q.labels) }),
    ...link.coverage,
    projectId: q.status.projectId,
    target: typeof raw.target === 'string' ? raw.target : name,
    dependents: hits,
    byRepo,
    // Carried through verbatim: the honesty contract of `/repos/:id/graph/blast-radius` is that an
    // empty `dependents` never reads as "safe to change", and it does not become less true for
    // being federated.
    unresolved: typeof raw.unresolved === 'number' ? raw.unresolved : 0,
    reposSearched: [...q.labels.keys()].sort(),
    missingRepos: q.status.missingRepos,
    linkage: linked ? 'linked' : 'co-located',
    note: `${linked ? LINKED_NOTE : CO_LOCATION_NOTE}${link.note}`,
    ...(Array.isArray(raw.crossings) ? { crossings } : {}),
    ...(typeof raw.crossings_total === 'number'
      ? { crossings_total: Math.max(crossings.length, raw.crossings_total - dropped.size) }
      : {}),
    ...(raw.crossings_truncated === true ? { crossings_truncated: true } : {}),
    ...link.stale,
  };
}

/** crew#1476: only crossings between current members can substantiate a project answer. */
function memberCrossings(raw: unknown, labels: Map<string, string>): {
  crossings: ProjectGraphCrossing[];
  dropped: Set<string>;
  /** crew#1714: the removed member's end of each dropped crossing (a `via` edge must not point there). */
  detached: Set<string>;
} {
  const listed = Array.isArray(raw) ? raw as ProjectGraphCrossing[] : [];
  const crossings = listed.filter((c) => labels.has(c.from?.repo) && labels.has(c.to?.repo));
  const gone = listed.filter((c) => !crossings.includes(c));
  const detached = new Set(gone.flatMap((c) => [c.from, c.to])
    .filter((end) => !labels.has(end?.repo) && typeof end?.symbol === 'string')
    .map((end) => end.symbol as string));
  return { crossings, dropped: new Set(gone.map((c) => c.id)), detached };
}

interface LinkStatus {
  project?: string;
  generation?: number;
  stale?: boolean;
  stale_labels?: string[];
  last_error?: string | null;
  coverage?: Array<Omit<ProjectGraphMemberCoverage, 'repoId' | 'repo'> & {
    label: string;
    boundaries?: Record<string, string[]>;
  }>;
}

/** crew#1476, crew#1477: shared coverage attribution; omitted metrics stay unknown. */
function memberCoverage(state: LinkStatus, labels: Map<string, string>): ProjectGraphMemberCoverage[] {
  // Untrusted shape: a coverage that is not a list, or an entry that is not an object, is no coverage.
  const rows = (Array.isArray(state.coverage) ? state.coverage : [])
    .filter((c): c is NonNullable<LinkStatus['coverage']>[number] => c !== null && typeof c === 'object');
  return [...labels].sort(([a], [b]) => a.localeCompare(b)).map(([repo, repoId]) => {
    const row = rows.find((c) => c.label === repo);
    return {
      repoId, repo,
      ...(typeof row?.links_in === 'number' ? { links_in: row.links_in } : {}),
      ...(typeof row?.links_out === 'number' ? { links_out: row.links_out } : {}),
      ...(typeof row?.incomplete === 'boolean' ? { incomplete: row.incomplete } : {}),
      ...(typeof row?.package_imports === 'number' ? { package_imports: row.package_imports } : {}),
      ...(typeof row?.manifests === 'number' ? { manifests: row.manifests } : {}),
      ...(row?.boundary_counts === undefined ? {} : { boundary_counts: row.boundary_counts }),
    };
  });
}

/**
 * THIS project's link state from estate's `link` array (blast-radius and, wicked-estate#557, path: one
 * entry per project in the store): its members' coverage, and (crew#1714) whether its links predate the
 * current indexes. Another project's stale link says nothing about this one. Stale is stated on a
 * co-located answer too: a crossing the stale links miss is why it found none (estate's LINK-STALE:
 * "cross-repo dependents may be missing").
 */
function linkState(raw: unknown, projectId: string, labels: Map<string, string>): {
  coverage: { coverage?: ProjectGraphMemberCoverage[] };
  stale: { link_stale?: true; link_stale_labels?: string[] };
  note: string;
} {
  const state = (Array.isArray(raw) ? raw as LinkStatus[] : []).find((s) => s !== null && typeof s === 'object' && s.project === projectId);
  if (state === undefined) return { coverage: {}, stale: {}, note: '' };
  const coverage = { coverage: memberCoverage(state, labels) };
  if (state.stale !== true) return { coverage, stale: {}, note: '' };
  // A removed member can be why the link is stale; the answer still names current members only (crew#1713).
  const staleLabels = (Array.isArray(state.stale_labels) ? state.stale_labels : [])
    .filter((l): l is string => typeof l === 'string' && labels.has(l));
  return { coverage, stale: { link_stale: true, link_stale_labels: [...new Set(staleLabels)].sort() }, note: ` ${LINK_STALE_NOTE}` };
}

interface RawPathEnd {
  symbol: string;
  name: string;
  kind: string;
  file: string;
  line_1based: number;
}

function pathEnd(raw: RawPathEnd, labels: Map<string, string>): ProjectGraphPathEnd | null {
  // estate emits a bare `{symbol}` only if an endpoint is missing from its own result: not attributable.
  if (typeof raw.file !== 'string') return null;
  const where = attribute(raw.file, labels);
  return where === null ? null : { ...where, symbol: raw.symbol, name: raw.name, kind: raw.kind, line: raw.line_1based };
}

/** crew#1476: an estate route is a project answer only when every endpoint is a current member. */
export async function projectGraphPath(
  q: Extract<Queryable, { ok: true }>,
  from: string,
  to: string,
  maxDepth?: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectGraphPath> {
  const { stdout } = await readProjectGraph(q.dbPath, () => execCapped(estateExe(env), [
    'path', from, to, '--db', q.dbPath, '--json', ...(maxDepth === undefined ? [] : ['--max-depth', String(maxDepth)]),
  ], { timeout: QUERY_TIMEOUT_MS }), env);
  const raw = JSON.parse(stdout) as {
    from: string; to: string; found: boolean; resolved?: boolean; unresolved: 'from' | 'to' | null;
    depth_bounded: boolean; node_bounded: boolean; crossings?: unknown; link?: unknown;
    hops: Array<{ source: RawPathEnd; target: RawPathEnd; kind: string; confidence?: number }>;
  };
  const hops: ProjectGraphPathHop[] = [];
  let excluded = false;
  for (const hop of raw.hops) {
    const source = pathEnd(hop.source, q.labels);
    const target = pathEnd(hop.target, q.labels);
    if (source === null || target === null) { excluded = true; break; }
    hops.push({ source, target, kind: hop.kind, ...(typeof hop.confidence === 'number' ? { confidence: hop.confidence } : {}) });
  }
  const { crossings } = memberCrossings(raw.crossings, q.labels);
  const linked = crossings.length > 0;
  // crew#1714: `path --json` carries the project link state too (wicked-estate#557), read as blast-radius reads it.
  const link = linkState(raw.link, q.status.projectId, q.labels);
  return {
    projectId: q.status.projectId, from: raw.from, to: raw.to, found: excluded ? false : raw.found,
    ...(typeof raw.resolved === 'boolean' ? { resolved: raw.resolved } : {}),
    unresolved: raw.unresolved, hops: excluded ? [] : hops,
    depth_bounded: raw.depth_bounded, node_bounded: raw.node_bounded,
    ...(Array.isArray(raw.crossings) ? { crossings } : {}),
    ...(excluded ? { excluded: 'the route found runs through a repository that is no longer in this project; refresh the project graph' } : {}),
    reposSearched: [...q.labels.keys()].sort(), missingRepos: q.status.missingRepos,
    ...link.coverage,
    ...link.stale,
    linkage: linked ? 'linked' : 'co-located',
    note: `${linked ? LINKED_NOTE : CO_LOCATION_NOTE}${link.note}${raw.depth_bounded || raw.node_bounded ? ' The search stopped at its depth or node bound, so a route it did not find may still exist.' : ''}`,
  };
}

/** crew#1477: possible boundaries are imports the linker could not prove, never graph edges. */
export async function projectGraphBoundaries(
  q: Extract<Queryable, { ok: true }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectGraphBoundaries> {
  const base = { projectId: q.status.projectId, linked: false, possible: [], members: [] };
  if (!(await estateSupportsLink(env))) return {
    ...base, note: 'this wicked-estate cannot link repositories (X1, wicked-estate 0.34.0+); upgrade it to see boundaries',
  };
  const { stdout } = await readProjectGraph(q.dbPath, () => execCapped(estateExe(env), [
    'link', '--project', q.status.projectId, '--status', '--json', '--db', q.dbPath,
  ], { timeout: QUERY_TIMEOUT_MS }), env);
  const raw = JSON.parse(stdout) as LinkStatus | null;
  if (raw === null) return { ...base, note: 'this project has not been linked yet; refresh its code graph' };
  const possible: ProjectGraphPossible[] = [];
  for (const row of raw.coverage ?? []) {
    const repoId = q.labels.get(row.label);
    if (repoId === undefined) continue;
    for (const [reason, packages] of Object.entries(row.boundaries ?? {})) {
      for (const pkg of packages) possible.push({ repoId, repo: row.label, reason, package: pkg });
    }
  }
  possible.sort((a, b) => a.repo.localeCompare(b.repo) || a.reason.localeCompare(b.reason) || a.package.localeCompare(b.package));
  return {
    projectId: q.status.projectId, linked: true,
    ...(raw.generation === undefined ? {} : { generation: raw.generation }),
    ...(raw.stale === undefined ? {} : { stale: raw.stale }),
    stale_labels: (raw.stale_labels ?? []).filter((label) => q.labels.has(label)),
    ...(raw.last_error === undefined ? {} : { last_error: raw.last_error }),
    members: memberCoverage(raw, q.labels), possible: possible.slice(0, 500),
    ...(possible.length > 500 ? { possible_total: possible.length, possible_truncated: true } : {}),
    note: 'possible = imports estate could not prove are links to another member, by reason; never edges',
  };
}

/**
 * Symbol search across every member repo — exact name, which is what estate's `resolve` answers.
 *
 * Not a substring search on purpose: the only estate primitive that would give one is a full
 * `nodes --json` dump filtered daemon-side, whose cost scales with the whole project rather than
 * with the query, and which would need a cap whose truncation is itself a silent wrong answer.
 * `resolve` is the same primitive the repo-scoped surface uses to turn a name into SymbolIds; run
 * against a co-located graph it returns every repo's matches in one call.
 */
export async function projectSymbolSearch(
  q: Extract<Queryable, { ok: true }>,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectGraphSearch> {
  const { stdout } = await readProjectGraph(
    q.dbPath,
    () => execCapped(estateExe(env), ['resolve', name, '--db', q.dbPath, '--json'], { timeout: QUERY_TIMEOUT_MS }),
    env,
  );
  const { hits, byRepo } = attributeHits(JSON.parse(stdout), q.labels);
  return {
    projectId: q.status.projectId,
    query: name,
    matches: hits,
    byRepo,
    reposSearched: [...q.labels.keys()].sort(),
    missingRepos: q.status.missingRepos,
    linkage: 'co-located',
    note: `${CO_LOCATION_NOTE} ${EXACT_NAME_NOTE}`,
  };
}
