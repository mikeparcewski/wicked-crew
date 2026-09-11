/**
 * Chat scope (crew#502, acceptance finding F-067): WHAT a chat's seats can see, decided up front
 * and stated — to the seats and to the caller.
 *
 * `POST /chats` used to set the seats' cwd only when `repoRef` was sent, and the engine fell back
 * to `current_dir()` — the DAEMON's working directory. Studio's GroupChat never sent `repoRef`, so
 * every chat explored wherever `wicked-crew serve` had been started from (a customer's `$HOME`),
 * with no estate MCP, no repo list and no statement of the scope; "chat with all 9 repos" worked
 * only because the acceptance rig started the daemon from the parent of `repos/`, and the seats
 * browsed the rig's other clones and the INSTALLED package's `.d.ts` files as if they were sources.
 *
 * The scope is a first-class input now: a PROJECT (default: every registered `crew.repo` member)
 * or an explicit repo list. From it this module derives the three things the engine is handed
 * (`wicked-core-ts chatOpen(chatId, clis, cwd, scopeJson)`):
 *
 *   - `cwd`         — a PRIVATE SCRATCH ROOT of the chat's own, under THIS daemon's per-process
 *                     namespace (`<os tmp>/wicked-crew-chats/<pid>-<random>/<chatId>`, see
 *                     {@link chatScratchBase}), never a repo and never the daemon's cwd. Relative
 *                     writes land there and the
 *                     OS sandbox, where the seat's config arms it, contains writes to it — the
 *                     repos are READ. Deliberately NOT under the state home: the engine's worker
 *                     fence denies `Read/Edit/Write(<state home>/**)` to every seat (wicked-core
 *                     `execute_wrapped::deny_rules`), so a seat whose cwd sat there could not read
 *                     its own working directory — and a new state-home store needs core's registry
 *                     (`tests/fixtures/state-home-subtrees.json`) released first.
 *   - `readRoots`   — the scoped repos' REGISTERED root paths (the run worktree read-roots idea,
 *                     applied to live repos): advertised to a claude seat as the SDK's
 *                     `additionalDirectories`, recorded on every seat (`GET /chats`).
 *   - `codeGraphDb` — the graph the seats' READ-ONLY estate MCP is bound to: the project's
 *                     co-located graph (`resolveProjectGraphBinding`, DES-GROUNDING-001 — the SAME
 *                     seam governed runs get) when the chat is filed into a project; a single
 *                     repo's own graph otherwise; none for several repos with no project.
 *
 * and STATES it: an `AGENTS.md` + `CLAUDE.md` in the scratch root (every seat CLI reads its cwd's
 * instructions file — claude `CLAUDE.md`; codex, pi, opencode and copilot `AGENTS.md`) names the
 * repos, their paths, the read-only rule and the grounding, so a seat that starts in an empty
 * directory knows exactly what it was pointed at; the same {@link ChatScope} rides the
 * `POST /chats` response and `GET /chats/:id` for the UI (studio's New Chat).
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { CoreAdapter } from '../core/adapter.js';
import { codeGraphDb } from '../core/repoPaths.js';
import type { ChatScope, ChatScopeRepo, RepoEntry } from '../core/types.js';
import { resolveProjectGraphBinding, type ProjectGraphBindingDecision } from '../projects/graph.js';

/** The scope a `POST /chats` asked for, after body validation. `repoRefs` is `repoRef` merged in. */
export interface ChatScopeRequest {
  chatId: string;
  projectId?: string;
  /** Registry ids or names; empty when the caller named none. */
  repoRefs: string[];
}

/** What the engine is handed for the chat — the wire shape of `chatOpen`'s `scopeJson` plus `cwd`. */
export interface EngineChatScope {
  cwd: string;
  codeGraphDb: string | null;
  readRoots: string[];
}

export type ChatScopeResolution =
  | { ok: true; scope: ChatScope; engine: EngineChatScope }
  | { ok: false; status: 400 | 404 | 409; error: string; missing?: string[] };

/** The reads the resolver needs — injectable so the resolver is testable without an engine. */
export interface ChatScopeDeps {
  listRepos(): Promise<RepoEntry[]>;
  /** The `crew.repo` member refs of a project, in attach order. */
  projectRepoRefs(projectId: string): Promise<string[]>;
  /** The project-graph decision for a chat — repo-bound when exactly one repo is in scope. */
  bindProjectGraph(
    projectId: string,
    repoRef: string | undefined,
  ): Promise<ProjectGraphBindingDecision>;
  /** Where chat scratch roots live. Default {@link chatScratchBase}. */
  scratchBase?: string;
}

let processScratchBase: string | undefined;

/**
 * `<os tmp>/wicked-crew-chats/<pid>-<random>` — THIS daemon's own namespace, minted once per
 * process (Copilot, #518): a shared `<os tmp>/wicked-crew-chats/<chatId>` could already exist from
 * another daemon running as the same OS user, which would pass every ownership check, overwrite the
 * live chat's statement and remove its root. Chats do not survive a daemon restart (the engine's pool
 * is in memory), so a stale namespace left by a crashed daemon holds nothing live. See the module
 * doc for why the base is not the state home.
 */
export function chatScratchBase(): string {
  processScratchBase ??= join(
    tmpdir(),
    'wicked-crew-chats',
    `${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  return processScratchBase;
}

/**
 * The real path of `p` even when `p` does not exist yet: its longest EXISTING ancestor is
 * canonicalized and the remaining segments re-appended — so a path under a symlinked temp dir
 * (macOS: `/var/folders/…` → `/private/var/folders/…`) compares equal to one that was resolved
 * through the link, whether or not the leaf has been created.
 */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** Whether `a` and `b` are the same directory or one contains the other, judged on real paths. */
function overlaps(a: string, b: string): boolean {
  const ra = realish(a);
  const rb = realish(b);
  return ra === rb || ra.startsWith(rb + sep) || rb.startsWith(ra + sep);
}

/**
 * ANY registered root that contains, or sits inside, the scratch base breaks the "private, never a
 * repo" guarantee (Copilot, #518): the seat's cwd would be part of a live repository — whether or
 * not that repository is in this chat's scope — and, when it is, that read root would expose every
 * sibling chat's scratch directory. Judged over EVERY registered repo, on every branch (scoped or
 * not). Refused as a 409 — it is an operator setup conflict (a repo registered under the OS temp
 * dir, or a daemon whose TMPDIR sits under a checkout), not a caller error.
 */
function refuseOverlap(repos: RepoEntry[], base: string): ChatScopeResolution | null {
  const clash = repos.find((r) => overlaps(r.root_path, base));
  if (clash === undefined) return null;
  return {
    ok: false,
    status: 409,
    error:
      `repo '${clash.name}' is registered at ${clash.root_path}, which overlaps this daemon's chat ` +
      `scratch base ${base}; a chat's scratch root can never sit inside a repository (nor a ` +
      'repository inside the scratch base) — register the repo elsewhere or set TMPDIR for the daemon.',
  };
}

/** The production deps over a live adapter. */
export function chatScopeDeps(adapter: CoreAdapter): ChatScopeDeps {
  return {
    listRepos: () => adapter.listRepos(),
    projectRepoRefs: async (projectId) =>
      (await adapter.projectMembers(projectId))
        .filter((m) => m.member_kind === 'crew.repo')
        .map((m) => m.member_ref),
    bindProjectGraph: (projectId, repoRef) => resolveProjectGraphBinding(adapter, projectId, repoRef),
  };
}

/** The route's own id rule, re-applied here: the id becomes ONE path segment under the base. */
const CHAT_ID = /^[A-Za-z0-9._-]+$/;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function row(r: RepoEntry): ChatScopeRepo {
  return { id: r.id, name: r.name, rootPath: r.root_path };
}

/**
 * Decide a chat's scope. Never throws on a caller error: an unknown repo is a 404 naming EVERY
 * missing ref (not just the first), a chat id that cannot name a scratch directory is a 400. A
 * graph that cannot be bound degrades to "no graph" WITH the reason — the same posture as a run
 * launch (`resolveProjectGraphBinding` never indexes; a refresh is an explicit act).
 */
export async function resolveChatScope(
  req: ChatScopeRequest,
  deps: ChatScopeDeps,
): Promise<ChatScopeResolution> {
  const base = resolve(deps.scratchBase ?? chatScratchBase());
  const cwd = resolve(base, req.chatId);
  // `..` and `.` pass the route's character class; a resolved cwd that is not strictly INSIDE the
  // base (one segment down) is refused before anything is created.
  if (
    !CHAT_ID.test(req.chatId) ||
    !cwd.startsWith(base + sep) ||
    cwd.slice(base.length + 1).includes(sep)
  ) {
    return {
      ok: false,
      status: 400,
      error: `chatId ${JSON.stringify(req.chatId)} cannot name a chat scratch directory`,
    };
  }
  const repos = await deps.listRepos();
  // Every registered repo, before any branch: the base itself must not be part of a repository.
  const overlap = refuseOverlap(repos, base);
  if (overlap !== null) return overlap;
  const refs = [...new Set(req.repoRefs)];

  if (refs.length > 0) {
    const found: RepoEntry[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const byId = repos.find((r) => r.id === ref);
      if (byId !== undefined) {
        if (!found.some((f) => f.id === byId.id)) found.push(byId);
        continue;
      }
      // A NAME is a human spelling, not an identifier: two checkouts can share one (Copilot,
      // #518). One match resolves; several are refused naming the ids — the same rule the
      // interactive grounding resolver applies — never "whichever row came first".
      const byName = repos.filter((r) => r.name === ref);
      if (byName.length > 1) {
        return {
          ok: false,
          status: 400,
          error:
            `repoRef '${ref}' is ambiguous — ${byName.length} registered repos share that name ` +
            `(${byName.map((r) => `'${r.id}' at ${r.root_path}`).join(', ')}); name the repo by id.`,
        };
      }
      if (byName.length === 1) {
        if (!found.some((f) => f.id === byName[0]!.id)) found.push(byName[0]!);
      } else {
        missing.push(ref);
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        status: 404,
        error: `Repo ${missing.map((m) => `'${m}'`).join(', ')} not found`,
        missing,
      };
    }
    const graph = await graphForRepos(found, req.projectId, deps);
    return ok(
      {
        kind: 'repos',
        ...(req.projectId !== undefined ? { projectId: req.projectId } : {}),
        repos: found.map(row),
        cwd,
        graph: graph.wire,
        dangling: [],
      },
      graph.dbPath,
      found,
    );
  }

  if (req.projectId !== undefined) {
    const memberRefs = await deps.projectRepoRefs(req.projectId);
    const found: RepoEntry[] = [];
    const dangling: string[] = [];
    for (const ref of memberRefs) {
      const repo = repos.find((r) => r.id === ref);
      if (repo === undefined) dangling.push(ref);
      else found.push(repo);
    }
    const decision = await bindOrExplain(deps, req.projectId, undefined);
    return ok(
      {
        kind: 'project',
        projectId: req.projectId,
        repos: found.map(row),
        cwd,
        graph: graphWire(decision),
        dangling,
      },
      decision.binding?.dbPath ?? null,
      found,
    );
  }

  return ok(
    {
      kind: 'none',
      repos: [],
      cwd,
      graph: {
        bound: false,
        reason:
          'the chat names no project and no repos, so its seats see only their own scratch root ' +
          'and no code graph; pass projectId or repoRefs to scope it.',
      },
      dangling: [],
    },
    null,
    [],
  );
}

function ok(scope: ChatScope, dbPath: string | null, repos: RepoEntry[]): ChatScopeResolution {
  return {
    ok: true,
    scope,
    engine: { cwd: scope.cwd, codeGraphDb: dbPath, readRoots: repos.map((r) => r.root_path) },
  };
}

async function bindOrExplain(
  deps: ChatScopeDeps,
  projectId: string,
  repoRef: string | undefined,
): Promise<ProjectGraphBindingDecision> {
  try {
    return await deps.bindProjectGraph(projectId, repoRef);
  } catch (err) {
    // Resolving the binding is an ENHANCEMENT to the chat; a failure is stated, never fatal.
    return {
      binding: null,
      reason:
        `the project graph binding could not be resolved (${message(err)}). ` +
        'This chat gets no code graph.',
    };
  }
}

/**
 * The wire half of a binding decision. `repoLabel` (the estate label the project graph indexes a
 * repo under — set by a REPO-BOUND decision) rides along for the UI and the statement; the engine
 * side needs only `dbPath`: a run hands the label so the engine can confirm the graph holds ITS
 * worktree, and a chat has no worktree — the decision already confirmed the graph holds the repo
 * (Copilot, #518).
 */
function graphWire(decision: ProjectGraphBindingDecision): ChatScope['graph'] {
  return {
    bound: decision.binding !== null,
    reason: decision.reason,
    ...(decision.binding?.repoLabel !== undefined ? { repoLabel: decision.binding.repoLabel } : {}),
  };
}

async function graphForRepos(
  repos: RepoEntry[],
  projectId: string | undefined,
  deps: ChatScopeDeps,
): Promise<{ wire: ChatScope['graph']; dbPath: string | null }> {
  if (projectId !== undefined) {
    // Filed into a project: the project's co-located graph, repo-bound when there is exactly one
    // repo (so the binding confirms the graph HOLDS it, as a repo-bound run does).
    const decision = await bindOrExplain(deps, projectId, repos.length === 1 ? repos[0]!.id : undefined);
    if (decision.binding !== null || repos.length !== 1) {
      return { wire: graphWire(decision), dbPath: decision.binding?.dbPath ?? null };
    }
    // The project declined to bind ONE repo (not a member, not indexed yet, …): its reason says
    // "uses its own repo's code graph", so DO that — the same existence-checked fallback the
    // no-project path takes — rather than hand the engine no graph behind a reason that promises
    // one (Copilot, #518). Both reasons are kept: why the project graph was declined, and what
    // the chat actually got.
    const own = ownGraph(repos[0]!);
    return {
      wire: { bound: own.wire.bound, reason: `${decision.reason} ${own.wire.reason}` },
      dbPath: own.dbPath,
    };
  }
  if (repos.length === 1) {
    return ownGraph(repos[0]!);
  }
  return {
    wire: {
      bound: false,
      reason:
        `${repos.length} repos and no project: there is no co-located graph to bind. File the ` +
        'chat into a project (projectId) whose graph is refreshed to ground it across repos; ' +
        'this chat gets no code graph.',
    },
    dbPath: null,
  };
}

/** A single repo's OWN graph — bound only when the registered graph file exists. */
function ownGraph(only: RepoEntry): { wire: ChatScope['graph']; dbPath: string | null } {
  try {
  const dbPath = codeGraphDb(only);
    // The registry field says WHERE the repo's graph lives, not that it was ever built
    // (Copilot, #518): a repo indexed by nothing would otherwise be reported as grounded while
    // the estate MCP answers "not found" about everything. Existence is the honest floor here
    // (the project path gets the same from `projectGraphStatus`).
    if (!existsSync(dbPath)) {
      return {
        wire: {
          bound: false,
          reason:
            `'${only.name}' has no code graph built yet (nothing at its registered graph path); ` +
            'index the repo (wicked-estate index / onboarding) to ground this chat. This chat gets none.',
        },
        dbPath: null,
      };
    }
    return {
      wire: { bound: true, reason: `bound to '${only.name}'s own code graph.` },
      dbPath,
    };
  } catch (err) {
    return {
      wire: {
        bound: false,
        reason: `'${only.name}' has no resolvable code graph (${message(err)}); this chat gets none.`,
      },
      dbPath: null,
    };
  }
}

/**
 * The statement every seat reads on start — written as BOTH `AGENTS.md` (codex, pi, opencode,
 * copilot) and `CLAUDE.md` (claude) into the scratch root. Plain prose, repo paths verbatim: the
 * seat is in an empty directory and this is how it learns what it was pointed at.
 */
export function chatScopeStatement(chatId: string, scope: ChatScope): string {
  const lines: string[] = [
    '# Chat scope',
    '',
    `This directory is the scratch root of wicked-crew chat \`${chatId}\`. It is the ONLY place you may write.`,
    '',
  ];
  if (scope.repos.length === 0 && scope.kind === 'project') {
    // A project whose every `crew.repo` member is dangling (or that has none): filed, but nothing
    // readable — say exactly that, never "opened without a project" (Copilot, #518).
    lines.push(
      '## Repositories in scope',
      '',
      `None readable. This chat is filed into project \`${scope.projectId ?? ''}\`, but no registered`,
      'repository of that project could be resolved' +
        (scope.dangling.length > 0
          ? ` (members whose repository is no longer registered: ${scope.dangling.map((d) => `\`${d}\``).join(', ')}).`
          : ' (it has no `crew.repo` member).'),
      'Answer from general knowledge, and say plainly that no repository is readable if asked about code.',
      '',
    );
  } else if (scope.repos.length === 0) {
    lines.push(
      '## Repositories in scope',
      '',
      'None. This chat was opened without a project or repo scope: answer from general knowledge,',
      'and say plainly that no repository is in scope if asked about code.',
      '',
    );
  } else {
    lines.push(
      '## Repositories in scope (READ-ONLY)',
      '',
      ...scope.repos.map((r) => `- **${r.name}** (\`${r.id}\`): \`${r.rootPath}\``),
      '',
      'Explore and answer questions about these repositories by reading them at the paths above.',
      'Cite files by their full path. Do NOT modify, create or delete anything inside them — this',
      'chat is read-only exploration; write scratch files only under this directory. Nothing',
      'outside these repositories and this directory is in scope.',
      '',
    );
  }
  if (scope.dangling.length > 0 && scope.repos.length > 0) {
    lines.push(
      `Project members whose repository is no longer registered (not readable): ${scope.dangling
        .map((d) => `\`${d}\``)
        .join(', ')}.`,
      '',
    );
  }
  lines.push('## Code graph', '');
  lines.push(
    scope.graph.bound
      ? 'A READ-ONLY wicked-estate MCP server over the code graph is attached to this session: use its ' +
          'search / blast-radius / lineage tools to find symbols and relationships before grepping. ' +
          (scope.graph.repoLabel !== undefined
            ? `The repository is indexed under the label \`${scope.graph.repoLabel}\`. `
            : '') +
          `(${scope.graph.reason})`
      : `No code graph is attached: ${scope.graph.reason}`,
    '',
  );
  if (scope.projectId !== undefined) {
    lines.push('## Project', '', `This chat is filed into project \`${scope.projectId}\`.`, '');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Create the chat's scratch root (private) and write the scope statement into it. Throws on an
 * unwritable temp — the route reports that rather than opening seats with no working directory.
 *
 * The root lives under the shared system temp dir, where another local user can pre-place an
 * entry under a predictable name (Copilot, #518) — so nothing here follows a link or trusts an
 * existing entry: the base and the root must be REAL directories (never symlinks), an existing
 * root must be OWNED by this process's user (POSIX), the mode is ENFORCED with `chmod` (mkdir's
 * `mode` applies only on creation), and each instruction file is unlinked before it is written
 * exclusively (`wx`) so a planted link cannot redirect the write.
 */
export function prepareChatScratch(chatId: string, scope: ChatScope): void {
  const base = resolve(scope.cwd, '..');
  // The WHOLE chain below the OS temp dir is created and validated one segment at a time (Copilot,
  // #518): a recursive mkdir would follow a planted symlink at `<tmp>/wicked-crew-chats` (the
  // parent every daemon's namespace shares) and create the "private" root inside its target. The
  // OS temp dir itself is trusted as the platform's (macOS's `/var -> /private/var` is root-owned).
  const stop = resolve(tmpdir());
  const chain: string[] = [];
  for (let dir = base; dir !== stop && dirname(dir) !== dir; dir = dirname(dir)) chain.unshift(dir);
  if (chain.length === 0 || !base.startsWith(stop + sep)) {
    throw new Error(`refusing chat scratch base ${base}: not below the OS temp dir ${stop}`);
  }
  for (const dir of chain) {
    // Non-recursive on purpose (a recursive mkdir resolves the whole parent chain through any
    // link): an existing segment is fine — `EEXIST` alone is ignored (independent review, W3) —
    // and EVERY segment, existing or not, must then be a real directory owned by this user.
    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    assertRealOwnedDirectory(dir, 'chat scratch base');
  }
  // Remember whether THIS call created the root: on a later failure only a root this invocation
  // made is removed — a pre-existing entry (a planted directory the ownership check refuses) is
  // never deleted on its planter's behalf (Copilot, #518).
  const created = !existsSync(scope.cwd);
  try {
    mkdirSync(scope.cwd, { recursive: true, mode: 0o700 });
    assertRealOwnedDirectory(scope.cwd, 'chat scratch root');
    chmodSync(scope.cwd, 0o700);
    const statement = chatScopeStatement(chatId, scope);
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = join(scope.cwd, name);
      rmSync(file, { force: true }); // removes a planted LINK itself, never its target
      writeFileSync(file, statement, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
  } catch (err) {
    if (created) removeChatScratch(scope.cwd, base);
    throw err;
  }
}

/** `path` must be a real directory (no link), owned by this user where the platform can tell. */
function assertRealOwnedDirectory(path: string, what: string): void {
  const meta = lstatSync(path);
  if (meta.isSymbolicLink()) {
    throw new Error(`refusing ${what} ${path}: it is a symlink`);
  }
  if (!meta.isDirectory()) {
    throw new Error(`refusing ${what} ${path}: not a directory`);
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    const uid = statSync(path).uid;
    if (uid !== process.getuid()) {
      throw new Error(`refusing ${what} ${path}: owned by uid ${uid}, not this daemon's user`);
    }
  }
}

/**
 * Remove a chat's scratch root — fail closed (Copilot, #518): the base must be a REAL directory
 * (a planted `<tmp>/wicked-crew-chats` link would make a lexical prefix test pass and the
 * recursive removal follow it), the target must sit DIRECTLY under the base by realpath, must not
 * itself be a link, and must be owned by this user. Anything else is left alone: a wrong guess
 * here deletes someone else's files, so the policy is the same as `prepareChatScratch`'s.
 */
export function removeChatScratch(cwd: string, base: string = chatScratchBase()): void {
  // Every check AND the removal sit under one catch-all (Copilot, #518): a filesystem race between
  // the checks and the removal (the entry replaced or gone) must leave the path untouched and the
  // caller's lifecycle intact — never throw out of a `DELETE` or an engine `chatClosed`.
  try {
    if (lstatSync(base).isSymbolicLink()) return;
    const baseReal = realpathSync(base);
    const target = resolve(cwd);
    const meta = lstatSync(target);
    if (meta.isSymbolicLink() || !meta.isDirectory()) return;
    if (realpathSync(dirname(target)) !== baseReal) return;
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && statSync(target).uid !== process.getuid()) {
      return;
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // no base, already gone, or unresolvable: nothing of ours is provably here — leave it
  }
}

/** One chat id's lifecycle slot in the index — see {@link ChatScopeIndex}. */
type ChatSlot =
  /** An open is in flight: reserved synchronously before the route's first `await`. */
  | { state: 'reserved'; token: number }
  /** The chat is open; its scratch root exists and its seats are reading the statement there. */
  | { state: 'live'; scope: ChatScope }
  /** `DELETE` ran: the root is already gone, and the id stays taken until the engine's own
   *  `chatClosed` for it is observed (or the grace timer gives up) — so a delayed close can never
   *  land on a chat that reused the id, and a reuse cannot race the close. */
  | { state: 'closing'; timer: ReturnType<typeof setTimeout> };

/**
 * The daemon's live chat scopes, keyed by chat id — in memory, like the engine's own chat pool (a
 * daemon restart loses both). A small state machine (Copilot, #518) rather than a map, because the
 * open is asynchronous and the engine's close is an event:
 *
 *   - `reserve` claims an id SYNCHRONOUSLY (before the route's first `await`) and hands back a
 *     token; `set` publishes the scope only if THAT reservation is still standing — an engine
 *     `chatClosed` or a `DELETE` that cancelled it in the meantime makes `set` return `false`, and
 *     the route tears the just-opened chat down instead of registering a scope for a closed one.
 *   - `beginClose` (DELETE) removes the root at once and parks the id as `closing`; `closed` (the
 *     engine's `chatClosed`) frees it. Until then a re-open of the same id is refused, so the
 *     engine's close — which may be delivered after `DELETE` returns — can never delete a newer
 *     chat's root, and a `chatClosed` for a merely reserved id cancels that open.
 *   - a `closing` slot whose event never arrives (an engine without the event, a lost relay) is
 *     freed after `closeGraceMs`; a late event after THAT is the documented residual (the engine's
 *     `chatClosed` carries no per-open token).
 */
export class ChatScopeIndex {
  private readonly slots = new Map<string, ChatSlot>();
  private nextToken = 1;

  /** `base`: where this daemon's chat scratch roots live — the resolver is handed the SAME base. */
  constructor(
    readonly base: string = chatScratchBase(),
    private readonly closeGraceMs: number = 5000,
  ) {}

  /** Live, reserved or closing — every state in which the id is not free. */
  has(chatId: string): boolean {
    return this.slots.has(chatId);
  }

  /** The state the id is in, for the route's refusal wording. */
  stateOf(chatId: string): ChatSlot['state'] | 'free' {
    return this.slots.get(chatId)?.state ?? 'free';
  }

  /** Reserve `chatId` for an open in flight; `null` when it is live, reserved or closing. */
  reserve(chatId: string): number | null {
    if (this.slots.has(chatId)) return null;
    const token = this.nextToken++;
    this.slots.set(chatId, { state: 'reserved', token });
    return token;
  }

  /** Give a reservation back (the open failed before `set`) — only the holder's own. */
  release(chatId: string, token: number): void {
    const slot = this.slots.get(chatId);
    if (slot?.state === 'reserved' && slot.token === token) this.slots.delete(chatId);
  }

  /**
   * Abort an open that already reached the ENGINE (the route closed the engine chat again): the
   * engine's `chatClosed` for this id is still on its way, so the id is parked as `closing` — not
   * released — until that event (or the grace) frees it; a reuse in between would otherwise have
   * its root removed by the late event (Copilot, #518). Only the holder's own reservation.
   */
  abortToClosing(chatId: string, token: number): void {
    const slot = this.slots.get(chatId);
    if (slot?.state !== 'reserved' || slot.token !== token) return;
    const timer = setTimeout(() => {
      if (this.slots.get(chatId)?.state === 'closing') this.slots.delete(chatId);
    }, this.closeGraceMs);
    timer.unref?.();
    this.slots.set(chatId, { state: 'closing', timer });
  }

  /** Publish the scope of a finished open. `false` when the reservation is gone (cancelled by a
   *  close in the meantime): the caller must tear the chat down, nothing was recorded. */
  set(chatId: string, scope: ChatScope, token: number): boolean {
    const slot = this.slots.get(chatId);
    if (slot?.state !== 'reserved' || slot.token !== token) return false;
    this.slots.set(chatId, { state: 'live', scope });
    return true;
  }

  /** The scope of a LIVE chat; `undefined` while reserved, closing or unknown. */
  get(chatId: string): ChatScope | undefined {
    const slot = this.slots.get(chatId);
    return slot?.state === 'live' ? slot.scope : undefined;
  }

  /**
   * `DELETE /chats/:id`: remove the root now and park the id until the engine's `chatClosed` (or
   * the grace) frees it. A reserved id is cancelled instead (the in-flight open cleans up on its
   * failed `set`). Returns the scope that was live, if any.
   */
  beginClose(chatId: string): ChatScope | undefined {
    const slot = this.slots.get(chatId);
    if (slot === undefined || slot.state === 'closing') return undefined;
    if (slot.state === 'live') removeChatScratch(slot.scope.cwd, this.base);
    // A RESERVED id is parked too, not freed (Copilot, #518): the in-flight open will find its
    // reservation gone, tear the engine chat down and that close's `chatClosed` is still to come —
    // a reuse before then would lose its own chat to it. The grace covers an open that never
    // reached the engine (no event will ever come).
    const timer = setTimeout(() => {
      if (this.slots.get(chatId)?.state === 'closing') this.slots.delete(chatId);
    }, this.closeGraceMs);
    timer.unref?.();
    this.slots.set(chatId, { state: 'closing', timer });
    return slot.state === 'live' ? slot.scope : undefined;
  }

  /**
   * The engine's `chatClosed` for `chatId` (any reason): frees a closing id, removes and frees a
   * live one (an engine-side reap), cancels a reservation (the open in flight tears down). Idempotent.
   */
  closed(chatId: string): void {
    const slot = this.slots.get(chatId);
    if (slot === undefined) return;
    if (slot.state === 'closing') clearTimeout(slot.timer);
    if (slot.state === 'live') removeChatScratch(slot.scope.cwd, this.base);
    this.slots.delete(chatId);
  }

  /** Forget the chat and remove its scratch root at once — no closing window (tests, teardown). */
  delete(chatId: string): ChatScope | undefined {
    const slot = this.slots.get(chatId);
    const scope = slot?.state === 'live' ? slot.scope : undefined;
    if (slot?.state === 'closing') clearTimeout(slot.timer);
    this.slots.delete(chatId);
    if (scope !== undefined) removeChatScratch(scope.cwd, this.base);
    return scope;
  }
}
