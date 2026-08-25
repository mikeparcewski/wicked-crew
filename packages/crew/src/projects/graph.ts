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
 * built, one whose member repo the registry no longer knows, and an addon too old to publish
 * `code_graph_db` are four different situations with four different remedies; collapsing them into
 * an empty result set is the failure estate's own R3 rule exists to prevent, and it is the failure
 * FINDING-069 actually shipped.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { CoreAdapter } from '../core/adapter.js';
import { ExecOutputTooLarge, execCapped } from '../core/exec.js';
import { codeGraphDb } from '../core/repoPaths.js';
import type {
  ProjectBlastRadius,
  ProjectGraphHit,
  ProjectGraphRefreshResult,
  ProjectGraphRepo,
  ProjectGraphRepoCount,
  ProjectGraphSearch,
  ProjectGraphStatus,
  RepoEntry,
} from '../core/types.js';
import { projectGraphDb, projectGraphManifest, repoLabel } from './graph-paths.js';

/** The sentence every project-graph response carries. Stated on the wire, not just in this file. */
export const CO_LOCATION_NOTE =
  'Co-located, not linked: each repo is indexed under its own label and edges do not resolve ' +
  'across repos. Results are per-repo hits gathered into one answer, never a cross-repo trace.';

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

/** `wicked-estate`, overridable exactly as `WICKED_CORE_EXE` overrides `wicked-core` in routes.ts. */
function estateExe(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_ESTATE_EXE'] ?? 'wicked-estate';
}

/** Queries are interactive; a full repo index is not. Both are bounded — neither hangs the daemon. */
const QUERY_TIMEOUT_MS = 30_000;
const INDEX_TIMEOUT_MS = 600_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── The manifest ──────────────────────────────────────────────────────────────

interface ManifestRepo {
  repoId: string;
  label: string;
  rootPath: string;
  /** HEAD at index time; absent when git could not answer, which forces a re-index. */
  head?: string;
  indexedAt: number;
}

interface Manifest {
  version: 1;
  projectId: string;
  repos: ManifestRepo[];
}

async function readManifest(projectId: string, env: NodeJS.ProcessEnv): Promise<Manifest | null> {
  try {
    const raw = JSON.parse(await readFile(projectGraphManifest(projectId, env), 'utf8')) as Manifest;
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

async function writeManifest(projectId: string, manifest: Manifest, env: NodeJS.ProcessEnv): Promise<void> {
  const path = projectGraphManifest(projectId, env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await rename(tmp, path);
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
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execCapped('git', ['rev-parse', 'HEAD'], { timeout: 10_000, cwd: rootPath, windowsHide: true }),
      execCapped('git', ['status', '--porcelain'], { timeout: 30_000, cwd: rootPath, windowsHide: true }),
    ]);
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
  };

  if (members.repos.length === 0 && members.dangling.length === 0) {
    return {
      ...base,
      state: 'no-repo-members',
      detail:
        `Project ${projectId} has no crew.repo members, so there is nothing to build a code graph ` +
        `from. Attach one with POST /api/v1/projects/${projectId}/members {"kind":"crew.repo","ref":"<repoId>"}.`,
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
        `Project ${projectId}'s only repo member(s) — ${dangling} — are not in the repo registry, ` +
        `so there is nothing to index. Re-attach a registered repo, or re-register the missing one; ` +
        `a refresh cannot help while every member is dangling.`,
    };
  }
  if (!dbExists || indexedCount === 0) {
    return {
      ...base,
      state: 'not-indexed',
      detail:
        `Project ${projectId} has ${members.repos.length} repo member(s) but no code graph yet. ` +
        `Build it with POST /api/v1/projects/${projectId}/graph/refresh.` +
        (dangling === '' ? '' : ` (${dangling} is a member the repo registry does not know.)`),
    };
  }
  if (indexedCount === 1) {
    return {
      ...base,
      state: 'ready-single-repo',
      detail:
        `Project ${projectId}'s graph holds exactly one repo (${
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
      `Project ${projectId}'s graph holds ${indexedCount} co-located repos` +
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

/**
 * One refresh at a time per project. Two `wicked-estate index` runs against one SQLite file is a
 * writer race, and the second caller wanting the same work done is served by the first — so
 * concurrent callers COALESCE onto the in-flight refresh rather than getting a 409 for asking.
 */
const inFlight = new Map<string, Promise<ProjectGraphRefreshResult>>();

export async function refreshProjectGraph(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectGraphRefreshResult> {
  const running = inFlight.get(projectId);
  if (running !== undefined) return running;
  const started = doRefresh(adapter, projectId, env).finally(() => inFlight.delete(projectId));
  inFlight.set(projectId, started);
  return started;
}

async function doRefresh(
  adapter: CoreAdapter,
  projectId: string,
  env: NodeJS.ProcessEnv,
): Promise<ProjectGraphRefreshResult> {
  const members = await resolveMembers(adapter, projectId);
  assertEngineFresh(members.repos);

  const dbPath = projectGraphDb(projectId, env);
  const indexed: string[] = [];
  const skipped: string[] = [];
  const failed: ProjectGraphRefreshResult['failed'] = [];

  if (members.repos.length === 0) {
    return {
      status: buildStatus({ projectId, members, manifest: null, dbExists: existsSync(dbPath), env }),
      indexed,
      skipped,
      failed,
    };
  }

  assertLabelsUnique(members.repos);

  if (!(await estateSupportsMultiRepo(env))) {
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

  await mkdir(dirname(dbPath), { recursive: true });
  const dbExisted = existsSync(dbPath);
  const prior = dbExisted ? await readManifest(projectId, env) : null;
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
    // digest skip then makes an unchanged re-index cheap, so the cost of being wrong here is a
    // second, not a stale answer.
    if (
      dbExisted &&
      before !== undefined &&
      head !== null &&
      before.head === head &&
      before.rootPath === m.repo.root_path
    ) {
      skipped.push(m.label);
      continue;
    }
    try {
      await execCapped(
        estateExe(env),
        ['index', m.repo.root_path, '--db', dbPath, '--repo', m.label],
        { timeout: INDEX_TIMEOUT_MS, cwd: m.repo.root_path },
      );
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
      failed.push({
        repoId: m.repoId,
        label: m.label,
        error: err instanceof ExecOutputTooLarge ? err.message : message(err),
      });
    }
  }

  const manifest: Manifest = { version: 1, projectId, repos: rows };
  await writeManifest(projectId, manifest, env);
  return {
    status: buildStatus({ projectId, members, manifest, dbExists: existsSync(dbPath), env }),
    indexed,
    skipped,
    failed,
  };
}

// ── Binding a run to the project graph ────────────────────────────────────────

/**
 * What a launch decided about the project graph, and why. The `reason` is carried on BOTH outcomes
 * because "you got the project graph" and "you got the repo graph instead, because X" are equally
 * worth saying, and the operator asking "why can't this run see the sibling repo" needs the second
 * one to have been recorded somewhere.
 */
export interface ProjectGraphBindingDecision {
  /** Passed to the engine as `LaunchOptions.projectGraph`; `null` ⇒ the run keeps the repo graph. */
  binding: { dbPath: string; repoLabel?: string } | null;
  /** One sentence: what the run got, and what would change it. */
  reason: string;
}

/**
 * Decide which code graph a run launched into `projectId` should be bound to.
 *
 * # This never indexes
 *
 * A refresh is `wicked-estate index` per member repo, bounded at ten minutes EACH. Doing that
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
): Promise<ProjectGraphBindingDecision> {
  let status: ProjectGraphStatus;
  try {
    status = await projectGraphStatus(adapter, projectId, env);
  } catch (err) {
    // Resolving the binding is an ENHANCEMENT to the launch. A project whose membership cannot be
    // read, or an addon too old to vouch for repo graph paths, must not take the run down with it —
    // the run is still perfectly launchable against its own repo's graph.
    return {
      binding: null,
      reason:
        `the project graph could not be read (${message(err)}), so this run uses its own repo's ` +
        `code graph`,
    };
  }

  if (status.dbPath === null) {
    return {
      binding: null,
      reason: `${status.detail} This run uses its own repo's code graph in the meantime.`,
    };
  }

  // A repo-less run has no own-repo that could be missing from the graph, so any graph with
  // something in it is a strict gain over the nothing such a run gets today.
  if (repoRef === undefined) {
    const indexed = status.repos.filter((r) => r.indexed);
    if (indexed.length === 0) {
      return {
        binding: null,
        reason: `${status.detail} This repo-less run gets no code graph.`,
      };
    }
    return {
      binding: { dbPath: status.dbPath },
      reason:
        `this repo-less run is bound to the project graph (${indexed.length} repo(s): ` +
        `${indexed.map((r) => r.label).join(', ')}).`,
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
        `repo '${repoRef}' is not a crew.repo member of project ${projectId}, so the project ` +
        `graph does not describe it; this run uses the repo's own code graph. Attach it with ` +
        `POST /api/v1/projects/${projectId}/members and refresh the graph to widen future runs.`,
    };
  }
  if (!own.indexed) {
    return {
      binding: null,
      reason:
        `the project graph does not hold '${repoRef}' (${own.reason ?? 'not indexed'}), so binding ` +
        `it would give this run tools that answer "not found" about its own worktree; it uses the ` +
        `repo's own code graph instead. POST /api/v1/projects/${projectId}/graph/refresh fixes it.`,
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
 * here and named in `status.staleRepos`, which is a different thing from being dropped silently.
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
): { hits: ProjectGraphHit[]; byRepo: ProjectGraphRepoCount[] } {
  const hits = (Array.isArray(raw) ? (raw as RawHit[]) : [])
    .map((r) => toHit(r, labels))
    .filter((h): h is ProjectGraphHit => h !== null);
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
}

function toHit(raw: RawHit, labels: Map<string, string>): ProjectGraphHit | null {
  const file = typeof raw.file === 'string' ? raw.file : '';
  const where = attribute(file, labels);
  if (where === null) return null;
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.symbol_id === 'string' ? raw.symbol_id : '';
  return {
    repoId: where.repoId,
    repo: where.repo,
    id,
    name: typeof raw.name === 'string' ? raw.name : '',
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    file: where.file,
    line: typeof raw.line === 'number' ? raw.line : 0,
  };
}

/** Dependents of a symbol across every member repo, each hit attributed to the repo it is in. */
export async function projectBlastRadius(
  q: Extract<Queryable, { ok: true }>,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectBlastRadius> {
  const { stdout } = await execCapped(
    estateExe(env),
    ['blast-radius', name, '--db', q.dbPath, '--json'],
    { timeout: QUERY_TIMEOUT_MS },
  );
  const raw = JSON.parse(stdout) as { dependents?: RawHit[]; unresolved?: number; target?: string };
  const { hits, byRepo } = attributeHits(raw.dependents, q.labels);
  return {
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
    linkage: 'co-located',
    note: CO_LOCATION_NOTE,
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
  const { stdout } = await execCapped(estateExe(env), ['resolve', name, '--db', q.dbPath, '--json'], {
    timeout: QUERY_TIMEOUT_MS,
  });
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
