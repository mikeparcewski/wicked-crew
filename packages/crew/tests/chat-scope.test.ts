// Chat scope (crew#502, F-067) — the resolver, the scratch root and its statement, the index.
//
// Every case runs over FAKE deps (no engine, no registry file) and a mkdtemp scratch base, so the
// suite never touches the developer's repos, state home or the real `<tmp>/wicked-crew-chats`.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChatScopeIndex,
  chatScopeStatement,
  chatScratchBase,
  prepareChatScratch,
  reapStaleChatNamespaces,
  removeChatScratch,
  resolveChatScope,
  type ChatScopeDeps,
} from '../src/api/chat-scope.js';
import type { RepoEntry } from '../src/core/types.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'chat-scope-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function repo(id: string, name: string, root: string, graph = join(base, `graph-${id}.db`)): RepoEntry {
  return {
    id,
    name,
    root_path: root,
    default_branch: 'main',
    registered_at: 1,
    code_graph_db: graph,
  } as RepoEntry;
}

/** Three registered repos; `gamma`'s graph FILE exists (a built graph), the others' do not. */
function REPOS(): RepoEntry[] {
  const gamma = repo('r-gamma', 'gamma', '/srv/repos/gamma');
  writeFileSync(gamma.code_graph_db as string, '');
  return [repo('r-alpha', 'alpha', '/srv/repos/alpha'), repo('r-beta', 'beta', '/srv/repos/beta'), gamma];
}

/** Fake deps: three registered repos; project `p1` holds crew + core + a dangling member. */
function deps(overrides: Partial<ChatScopeDeps> = {}): ChatScopeDeps & { bindCalls: [string, string | undefined][] } {
  const bindCalls: [string, string | undefined][] = [];
  return {
    bindCalls,
    listRepos: async () => REPOS(),
    projectRepoRefs: async (projectId) =>
      projectId === 'p1' ? ['r-alpha', 'r-beta', 'r-gone'] : [],
    bindProjectGraph: async (projectId, repoRef) => {
      bindCalls.push([projectId, repoRef]);
      return {
        binding: {
          dbPath: `/state/project-graphs/${projectId}/estate.db`,
          ...(repoRef !== undefined ? { repoLabel: `label-${repoRef}` } : {}),
        },
        reason: `bound to the project graph (${repoRef ?? 'repo-less'})`,
      };
    },
    scratchBase: base,
    ...overrides,
  };
}

describe('resolveChatScope — project scope (the default)', () => {
  it('scopes a project-filed chat to EVERY registered crew.repo member, names the dangling one, and binds the project graph repo-less', async () => {
    const d = deps();
    const res = await resolveChatScope({ chatId: 'c1', projectId: 'p1', repoRefs: [] }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.kind).toBe('project');
    expect(res.scope.projectId).toBe('p1');
    expect(res.scope.repos.map((r) => r.id)).toEqual(['r-alpha', 'r-beta']);
    expect(res.scope.repos[0]).toEqual({ id: 'r-alpha', name: 'alpha', rootPath: '/srv/repos/alpha' });
    expect(res.scope.dangling).toEqual(['r-gone']);
    expect(res.scope.graph).toEqual({ bound: true, reason: 'bound to the project graph (repo-less)' });
    expect(d.bindCalls).toEqual([['p1', undefined]]);
    // What the engine is handed: the scratch cwd, the project graph, the members' roots.
    expect(res.engine).toEqual({
      cwd: join(base, 'c1'),
      codeGraphDb: '/state/project-graphs/p1/estate.db',
      readRoots: ['/srv/repos/alpha', '/srv/repos/beta'],
    });
    expect(res.scope.cwd).toBe(join(base, 'c1'));
  });

  it('a project whose graph cannot be bound still scopes the repos and SAYS why there is no graph — with the UI action that would build it (F-2R2-008)', async () => {
    const d = deps({
      bindProjectGraph: async () => ({
        binding: null,
        reason: "This project's code graph has not been built yet — build it from the project page. Chat still reads the repositories directly.",
        action: 'projects.graph.refresh',
      }),
    });
    const res = await resolveChatScope({ chatId: 'c1', projectId: 'p1', repoRefs: [] }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.repos).toHaveLength(2);
    expect(res.scope.graph).toEqual({
      bound: false,
      reason: "This project's code graph has not been built yet — build it from the project page. Chat still reads the repositories directly.",
      action: 'projects.graph.refresh',
    });
    expect(res.engine.codeGraphDb).toBeNull();
    expect(res.engine.readRoots).toHaveLength(2);
    // A BOUND decision never carries an action, even if the resolver set one.
    const bound = deps({
      bindProjectGraph: async () => ({ binding: { dbPath: '/g.db' }, reason: 'bound.', action: 'projects.graph.refresh' }),
    });
    const ok = await resolveChatScope({ chatId: 'c2', projectId: 'p1', repoRefs: [] }, bound);
    expect(ok.ok && ok.scope.graph).toEqual({ bound: true, reason: 'bound.' });
  });

  it('a binding that THROWS degrades to no graph with the cause, never a failed open', async () => {
    const d = deps({ bindProjectGraph: async () => { throw new Error('manifest unreadable'); } });
    const res = await resolveChatScope({ chatId: 'c1', projectId: 'p1', repoRefs: [] }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.graph.bound).toBe(false);
    expect(res.scope.graph.reason).toMatch(/manifest unreadable/);
  });
});

describe('resolveChatScope — explicit repos', () => {
  it('resolves ids AND names, keeps order, dedupes, and binds a single repo through the project when filed', async () => {
    const d = deps();
    const res = await resolveChatScope(
      { chatId: 'c2', projectId: 'p1', repoRefs: ['beta', 'r-beta'] },
      d,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.kind).toBe('repos');
    expect(res.scope.projectId).toBe('p1');
    expect(res.scope.repos.map((r) => r.id)).toEqual(['r-beta']);
    // One repo in scope → the binding is REPO-BOUND so it confirms the graph holds it, and the
    // label it is indexed under rides the wire (informational; the engine binds by dbPath).
    expect(d.bindCalls).toEqual([['p1', 'r-beta']]);
    expect(res.scope.graph).toEqual({ bound: true, reason: 'bound to the project graph (r-beta)', repoLabel: 'label-r-beta' });
    expect(res.engine).toEqual({ cwd: join(base, 'c2'), codeGraphDb: '/state/project-graphs/p1/estate.db', readRoots: ['/srv/repos/beta'] });
  });

  it("a single repo the project declines to bind (not a member / not indexed) falls back to the repo's OWN graph, keeping both reasons", async () => {
    const d = deps({
      bindProjectGraph: async () => ({
        binding: null,
        reason: "repo 'r-gamma' is not a crew.repo member of project p1, so the project graph does not describe it; this run uses the repo's own code graph.",
      }),
    });
    const res = await resolveChatScope({ chatId: 'c2', projectId: 'p1', repoRefs: ['r-gamma'] }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // gamma's graph file exists → bound to its own graph; the project's decline is still stated.
    expect(res.scope.graph.bound).toBe(true);
    expect(res.scope.graph.reason).toMatch(/not a crew.repo member/);
    expect(res.scope.graph.reason).toMatch(/own code graph/);
    expect(res.engine.codeGraphDb).toBe(join(base, 'graph-r-gamma.db'));
    // alpha's graph was never built → the fallback is honest about that too.
    const res2 = await resolveChatScope({ chatId: 'c2', projectId: 'p1', repoRefs: ['r-alpha'] }, d);
    expect(res2.ok && res2.scope.graph.bound).toBe(false);
    expect(res2.ok && res2.engine.codeGraphDb).toBeNull();
  });

  it('several explicit repos under a project bind the project graph repo-less', async () => {
    const d = deps();
    const res = await resolveChatScope({ chatId: 'c2', projectId: 'p1', repoRefs: ['r-alpha', 'r-gamma'] }, d);
    expect(res.ok && res.scope.repos.map((r) => r.id)).toEqual(['r-alpha', 'r-gamma']);
    expect(d.bindCalls).toEqual([['p1', undefined]]);
  });

  it("a single repo with NO project is grounded on the repo's OWN graph — when that graph exists", async () => {
    const d = deps();
    const res = await resolveChatScope({ chatId: 'c3', repoRefs: ['r-gamma'] }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.projectId).toBeUndefined();
    expect(res.scope.graph.bound).toBe(true);
    expect(res.scope.graph.reason).toMatch(/own code graph/);
    expect(res.engine.codeGraphDb).toBe(join(base, 'graph-r-gamma.db'));
    expect(d.bindCalls).toEqual([]);
  });

  it('a single repo whose registered graph was never BUILT is not reported as grounded', async () => {
    const res = await resolveChatScope({ chatId: 'c3', repoRefs: ['r-alpha'] }, deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.graph.bound).toBe(false);
    expect(res.scope.graph.reason).toMatch(/no code graph built yet/);
    expect(res.engine.codeGraphDb).toBeNull();
  });

  it('several repos with NO project get no graph, and the reason says how to get one', async () => {
    const res = await resolveChatScope({ chatId: 'c3', repoRefs: ['r-alpha', 'r-beta'] }, deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope.graph.bound).toBe(false);
    expect(res.scope.graph.reason).toMatch(/projectId/);
    expect(res.engine.codeGraphDb).toBeNull();
    expect(res.engine.readRoots).toEqual(['/srv/repos/alpha', '/srv/repos/beta']);
  });

  it('a repo NAME shared by two registered checkouts is ambiguous — a 400 naming the ids, never the first row', async () => {
    const twin = repo('r-alpha-2', 'alpha', '/srv/elsewhere/alpha');
    const res = await resolveChatScope({ chatId: 'c4', repoRefs: ['alpha'] }, deps({ listRepos: async () => [...REPOS(), twin] }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/ambiguous/);
    expect(res.error).toContain("'r-alpha'");
    expect(res.error).toContain("'r-alpha-2'");
    // The id still resolves unambiguously.
    const byId = await resolveChatScope({ chatId: 'c4', repoRefs: ['r-alpha-2'] }, deps({ listRepos: async () => [...REPOS(), twin] }));
    expect(byId.ok && byId.scope.repos.map((r) => r.id)).toEqual(['r-alpha-2']);
  });

  it('an unknown ref is a 404 that names EVERY missing ref — and nothing else was resolved', async () => {
    const d = deps();
    const res = await resolveChatScope({ chatId: 'c4', repoRefs: ['r-alpha', 'nope', 'also-nope'] }, d);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
    expect(res.missing).toEqual(['nope', 'also-nope']);
    expect(res.error).toMatch(/'nope'/);
    expect(res.error).toMatch(/'also-nope'/);
    expect(d.bindCalls).toEqual([]);
  });
});

describe('resolveChatScope — no scope, and the id guard', () => {
  it('no project and no repos: kind none, an empty read-root list, no graph, a reason that names the remedy', async () => {
    const res = await resolveChatScope({ chatId: 'c5', repoRefs: [] }, deps());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.scope).toEqual({
      kind: 'none',
      repos: [],
      cwd: join(base, 'c5'),
      graph: { bound: false, reason: expect.stringMatching(/projectId or repoRefs/) as unknown as string },
      dangling: [],
    });
    expect(res.engine).toEqual({ cwd: join(base, 'c5'), codeGraphDb: null, readRoots: [] });
  });

  it('ANY registered root that overlaps the scratch base is refused (409) on every branch: the scratch root is never inside a repo, nor a repo inside the base', async () => {
    const inside = repo('r-in', 'inside-base', join(base, 'a-repo-under-the-base'));
    const above = repo('r-up', 'above-base', tmpdir());
    for (const [extra, name] of [[inside, 'inside-base'], [above, 'above-base']] as const) {
      const d = deps({ listRepos: async () => [...REPOS(), extra], projectRepoRefs: async () => ['r-alpha'] });
      // Even a chat that never selects the offending repo is refused — the BASE is compromised.
      for (const req of [
        { chatId: 'c-x', repoRefs: ['r-alpha'] },
        { chatId: 'c-y', projectId: 'p1', repoRefs: [] },
        { chatId: 'c-z', repoRefs: [] },
      ]) {
        const res = await resolveChatScope(req, d);
        expect(res.ok, `${name} / ${req.chatId}`).toBe(false);
        if (!res.ok) {
          expect(res.status).toBe(409);
          expect(res.error).toContain(name);
          expect(res.error).toMatch(/overlaps/);
        }
      }
    }
  });

  it('a registered root that EXISTS but cannot be resolved refuses the open only when it is in scope or spelled over the base; otherwise it is logged and the open proceeds (hardening, W7)', async () => {
    // A symlink loop: `realpath` fails with ELOOP — the root is there, its identity is unprovable.
    const loopA = join(base, 'loop-a');
    const loopB = join(base, 'loop-b');
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB);
    const elsewhere = mkdtempSync(join(tmpdir(), 'chat-scope-elsewhere-'));
    try {
      const farA = join(elsewhere, 'far-a');
      const farB = join(elsewhere, 'far-b');
      symlinkSync(farB, farA);
      symlinkSync(farA, farB);
      const logged: string[] = [];
      const unresolvable = repo('r-loop', 'looped', join(farA, 'checkout'));
      const d = deps({ listRepos: async () => [...REPOS(), unresolvable], log: (m) => logged.push(m) });
      // Not in scope, spelled far from the base: noted, the open proceeds on every branch.
      for (const req of [
        { chatId: 'c-x', repoRefs: ['r-alpha'] },
        { chatId: 'c-y', projectId: 'p1', repoRefs: [] },
        { chatId: 'c-z', repoRefs: [] },
      ]) {
        const res = await resolveChatScope(req, d);
        expect(res.ok, req.chatId).toBe(true);
      }
      expect(logged.length).toBe(3);
      expect(logged[0]).toMatch(/looped/);
      expect(logged[0]).toMatch(/cannot be resolved/);
      // IN the chat's scope: refused — the seats would be pointed at a root nobody can prove safe.
      const inScope = await resolveChatScope({ chatId: 'c-s', repoRefs: ['r-loop'] }, d);
      expect(inScope.ok).toBe(false);
      if (!inScope.ok) {
        expect(inScope.status).toBe(409);
        expect(inScope.error).toMatch(/looped/);
        expect(inScope.error).toMatch(/cannot be resolved/);
      }
      const viaProject = await resolveChatScope(
        { chatId: 'c-p', projectId: 'p1', repoRefs: [] },
        deps({ listRepos: async () => [...REPOS(), unresolvable], projectRepoRefs: async () => ['r-loop'], log: (m) => logged.push(m) }),
      );
      expect(viaProject.ok).toBe(false);
      if (!viaProject.ok) expect(viaProject.status).toBe(409);
      // Spelled OVER the base (lexically inside it): refused even when no chat selects it.
      const overBase = repo('r-over', 'over-base', join(loopA, 'checkout'));
      const d2 = deps({ listRepos: async () => [...REPOS(), overBase], log: (m) => logged.push(m) });
      const res = await resolveChatScope({ chatId: 'c-o', repoRefs: ['r-alpha'] }, d2);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(409);
        expect(res.error).toMatch(/over-base/);
      }
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('read roots reach the engine resolved, never as the raw registry spelling', async () => {
    const trailing = repo('r-t', 'trailing', '/srv/repos/trailing/');
    const dotted = repo('r-d', 'dotted', '/srv/repos/./dotted/sub/..');
    const d = deps({ listRepos: async () => [...REPOS(), trailing, dotted] });
    const res = await resolveChatScope({ chatId: 'c-r', repoRefs: ['r-t', 'r-d', 'r-alpha'] }, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.engine.readRoots).toEqual([resolve('/srv/repos/trailing'), resolve('/srv/repos/dotted'), resolve('/srv/repos/alpha')]);
    // The statement still shows the registered spelling: that is what the operator recognises.
    expect(res.scope.repos.map((r) => r.rootPath)).toEqual(['/srv/repos/trailing/', '/srv/repos/./dotted/sub/..', '/srv/repos/alpha']);
  });

  it('the default scratch base is THIS process\'s own namespace, minted once', () => {
    const a = chatScratchBase();
    expect(a).toBe(chatScratchBase());
    expect(a.startsWith(join(tmpdir(), 'wicked-crew-chats') + '/')).toBe(true);
    expect(a).toContain(`${process.pid}-`);
  });

  it('a chat id that would escape the scratch base ("..", ".", a separator) is a 400 before anything is created', async () => {
    for (const bad of ['..', '.', 'a/b', '../x', '']) {
      const res = await resolveChatScope({ chatId: bad, repoRefs: [] }, deps());
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.status, bad).toBe(400);
    }
    expect(existsSync(join(base, '..', 'x'))).toBe(false);
  });
});

describe('the scratch root and its statement', () => {
  it('prepareChatScratch creates a PRIVATE root with AGENTS.md and CLAUDE.md that name the repos, the read-only rule and the grounding', async () => {
    const res = await resolveChatScope({ chatId: 'c6', projectId: 'p1', repoRefs: [] }, deps());
    if (!res.ok) throw new Error(res.error);
    prepareChatScratch('c6', res.scope);
    const cwd = join(base, 'c6');
    expect(statSync(cwd).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(cwd).mode & 0o777).toBe(0o700);
    }
    const agents = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    expect(claude).toBe(agents);
    expect(agents).toContain('`c6`');
    expect(agents).toContain('/srv/repos/alpha');
    expect(agents).toContain('/srv/repos/beta');
    expect(agents).toMatch(/READ-ONLY/);
    expect(agents).toMatch(/Do NOT modify/);
    expect(agents).toMatch(/wicked-estate MCP/);
    expect(agents).toContain('`r-gone`');
    expect(agents).toContain('project `p1`');
    // Idempotent: a second prepare over the same root does not throw.
    prepareChatScratch('c6', res.scope);
  });

  it('refuses a scratch root or base that is a planted symlink, and re-prepares over its own root', () => {
    if (process.platform === 'win32') return;
    const elsewhere = mkdtempSync(join(tmpdir(), 'chat-scope-elsewhere-'));
    try {
      // A link where the ROOT should be.
      const linkedRoot = join(base, 'c-link');
      symlinkSync(elsewhere, linkedRoot);
      const scopeAt = (cwd: string) => ({ kind: 'none' as const, repos: [], cwd, graph: { bound: false, reason: 'x' }, dangling: [] });
      expect(() => prepareChatScratch('c-link', scopeAt(linkedRoot))).toThrow(/symlink/);
      expect(existsSync(join(elsewhere, 'AGENTS.md'))).toBe(false);
      // A link where the BASE should be.
      const linkedBase = join(base, 'linked-base');
      symlinkSync(elsewhere, linkedBase);
      expect(() => prepareChatScratch('c-x', scopeAt(join(linkedBase, 'c-x')))).toThrow(/symlink/);
      expect(existsSync(join(elsewhere, 'c-x'))).toBe(false);
      // A link at an ANCESTOR of the base (the shared `wicked-crew-chats` parent): refused before
      // anything is created, even though the base itself does not exist yet (W2/W3).
      const linkedParent = join(base, 'linked-parent');
      symlinkSync(elsewhere, linkedParent);
      expect(() => prepareChatScratch('c-y', scopeAt(join(linkedParent, 'ns', 'c-y')))).toThrow(/symlink/);
      expect(existsSync(join(elsewhere, 'ns'))).toBe(false);
      // An EXISTING chain (the mkdtemp base, a namespace prepared once) is fine: EEXIST is not an
      // error (independent review, W3) — every segment is still verified real and owned.
      const ns = join(base, 'ns-existing');
      prepareChatScratch('c-a', scopeAt(join(ns, 'c-a')));
      prepareChatScratch('c-b', scopeAt(join(ns, 'c-b')));
      expect(statSync(join(ns, 'c-b')).isDirectory()).toBe(true);
      // A base outside the OS temp dir is refused outright, before anything is created.
      const outsideTmp = join('/', 'w2chat-not-a-temp-dir', 'c-z');
      expect(() => prepareChatScratch('c-z', scopeAt(outsideTmp))).toThrow(/not below the OS temp dir/);
      expect(existsSync(join('/', 'w2chat-not-a-temp-dir'))).toBe(false);
      // A planted LINK as an instruction file inside our own root is replaced, never followed.
      const own = join(base, 'c-own');
      mkdirSync(own, { recursive: true, mode: 0o700 });
      const target = join(elsewhere, 'target.md');
      writeFileSync(target, 'operator content');
      symlinkSync(target, join(own, 'AGENTS.md'));
      prepareChatScratch('c-own', scopeAt(own));
      expect(readFileSync(target, 'utf8')).toBe('operator content');
      expect(lstatSync(join(own, 'AGENTS.md')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(own, 'AGENTS.md'), 'utf8')).toMatch(/Chat scope/);
      // Idempotent over its own root, and the mode is enforced even if it drifted.
      chmodSync(own, 0o755);
      prepareChatScratch('c-own', scopeAt(own));
      expect(statSync(own).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('a project with no readable member is told exactly that — never "opened without a project"', () => {
    const text = chatScopeStatement('c7', {
      kind: 'project',
      projectId: 'p1',
      repos: [],
      cwd: join(base, 'c7'),
      graph: { bound: false, reason: 'nothing to bind' },
      dangling: ['r-gone'],
    });
    expect(text).toMatch(/None readable/);
    expect(text).toContain('project `p1`');
    expect(text).toContain('`r-gone`');
    expect(text).not.toMatch(/opened without a project/);
  });

  it('an unscoped chat is told plainly that no repository is in scope and no graph is attached', () => {
    const text = chatScopeStatement('c7', {
      kind: 'none',
      repos: [],
      cwd: join(base, 'c7'),
      graph: { bound: false, reason: 'nothing to bind' },
      dangling: [],
    });
    expect(text).toMatch(/None\./);
    expect(text).toContain('No code graph is attached: nothing to bind');
    expect(text).not.toMatch(/## Project/);
  });

  it('removeChatScratch removes a root inside the base and REFUSES one outside it', () => {
    const inside = join(base, 'c8');
    prepareChatScratch('c8', { kind: 'none', repos: [], cwd: inside, graph: { bound: false, reason: 'x' }, dangling: [] });
    expect(existsSync(inside)).toBe(true);
    removeChatScratch(inside, base);
    expect(existsSync(inside)).toBe(false);
    // Outside the base: untouched.
    const outside = mkdtempSync(join(tmpdir(), 'chat-scope-outside-'));
    try {
      removeChatScratch(outside, base);
      expect(existsSync(outside)).toBe(true);
      removeChatScratch(base, base); // the base itself is not "inside" the base
      expect(existsSync(base)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ChatScopeIndex: a reservation is token-bound, a close in flight cancels it, DELETE parks the id until the engine closes it, an engine reap removes the root', async () => {
    const index = new ChatScopeIndex(base, 20);
    const scopeFor = (id: string) => ({ kind: 'none' as const, repos: [], cwd: join(base, id), graph: { bound: false, reason: 'x' }, dangling: [] });
    // reserve → set publishes; a second reserve of a taken id is refused.
    const t1 = index.reserve('a');
    expect(t1).not.toBeNull();
    expect(index.reserve('a')).toBeNull();
    expect(index.stateOf('a')).toBe('reserved');
    prepareChatScratch('a', scopeFor('a'));
    expect(index.set('a', scopeFor('a'), t1!)).toBe(true);
    expect(index.stateOf('a')).toBe('live');
    // A stale token publishes nothing.
    expect(index.set('a', scopeFor('a'), 999)).toBe(false);
    // closed() while reserved PARKS the id (closing) rather than freeing it — the in-flight open's
    // set() fails and its own teardown close is still to come (hardening); the grace, or that
    // close, frees it.
    const t2 = index.reserve('b')!;
    index.closed('b');
    expect(index.stateOf('b')).toBe('closing');
    expect(index.set('b', scopeFor('b'), t2)).toBe(false);
    expect(index.reserve('b')).toBeNull();
    index.closed('b');
    expect(index.has('b')).toBe(false);
    const t2b = index.reserve('b2')!;
    index.closed('b2');
    expect(index.set('b2', scopeFor('b2'), t2b)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(index.has('b2')).toBe(false);
    // release() honours only the holder's token.
    const t3 = index.reserve('c')!;
    index.release('c', t3 + 1);
    expect(index.stateOf('c')).toBe('reserved');
    index.release('c', t3);
    expect(index.has('c')).toBe(false);
    // beginClose removes the root at once and parks the id; closed() frees it.
    expect(index.beginClose('a')).toEqual(scopeFor('a'));
    expect(existsSync(join(base, 'a'))).toBe(false);
    expect(index.stateOf('a')).toBe('closing');
    expect(index.get('a')).toBeUndefined();
    expect(index.reserve('a')).toBeNull();
    index.closed('a');
    expect(index.has('a')).toBe(false);
    // DELETE against a RESERVED id parks it (closing) instead of freeing it — the in-flight open's
    // teardown close is still to come; closed() frees it.
    const t7 = index.reserve('h')!;
    expect(index.beginClose('h')).toBeUndefined();
    expect(index.stateOf('h')).toBe('closing');
    expect(index.set('h', scopeFor('h'), t7)).toBe(false);
    expect(index.reserve('h')).toBeNull();
    index.closed('h');
    expect(index.has('h')).toBe(false);
    // The grace timer frees a closing id whose event never comes.
    const t4 = index.reserve('d')!;
    prepareChatScratch('d', scopeFor('d'));
    index.set('d', scopeFor('d'), t4);
    index.beginClose('d');
    expect(index.stateOf('d')).toBe('closing');
    await new Promise((r) => setTimeout(r, 60));
    expect(index.has('d')).toBe(false);
    // An engine-side reap (closed() on a LIVE chat) removes the root and frees the id.
    const t5 = index.reserve('e')!;
    prepareChatScratch('e', scopeFor('e'));
    index.set('e', scopeFor('e'), t5);
    index.closed('e');
    expect(existsSync(join(base, 'e'))).toBe(false);
    expect(index.has('e')).toBe(false);
    // Unknown ids are no-ops everywhere.
    index.closed('never');
    expect(index.beginClose('never')).toBeUndefined();
    // abortToClosing parks a reservation whose engine close is still on its way; closed() frees it.
    const t6 = index.reserve('f')!;
    index.abortToClosing('f', t6);
    expect(index.stateOf('f')).toBe('closing');
    expect(index.reserve('f')).toBeNull();
    index.closed('f');
    expect(index.has('f')).toBe(false);
    index.abortToClosing('g', 123); // no such reservation: no-op
    expect(index.has('g')).toBe(false);
  });

  it('prepareChatScratch never removes a root it did not create, and creates the root itself non-recursively (hardening, no TOCTOU)', () => {
    const scope = { kind: 'none' as const, repos: [], cwd: join(base, 'pre'), graph: { bound: false, reason: 'x' }, dangling: [] };
    // A root that already exists (another same-user process made it) and then fails the
    // preparation: the root stays — it was never this call's to remove.
    mkdirSync(scope.cwd, { mode: 0o700 });
    mkdirSync(join(scope.cwd, 'AGENTS.md')); // a DIRECTORY where the statement file goes: the write fails
    expect(() => prepareChatScratch('pre', scope)).toThrow();
    expect(existsSync(scope.cwd)).toBe(true);
    rmSync(join(scope.cwd, 'AGENTS.md'), { recursive: true });
    // A root this call CREATES is fully prepared, and re-preparing over its own root rewrites the
    // statement in place (the second create sees EEXIST — its own root — and carries on).
    const own = { ...scope, cwd: join(base, 'own') };
    prepareChatScratch('own', own);
    expect(existsSync(join(own.cwd, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(own.cwd, 'CLAUDE.md'))).toBe(true);
    prepareChatScratch('own', own);
    expect(readFileSync(join(own.cwd, 'AGENTS.md'), 'utf8')).toContain('own');
  });

  it('reapStaleChatNamespaces removes only the real, owned, dead-pid namespaces of OTHER daemons (hardening, W6)', () => {
    const parent = join(base, 'wicked-crew-chats');
    mkdirSync(parent);
    // A pid that is certainly dead: a child that has already exited.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    expect(dead).toBeGreaterThan(0);
    const deadNs = join(parent, `${dead}-abcdef0123`);
    mkdirSync(deadNs);
    writeFileSync(join(deadNs, 'c1'), '');
    const ownNs = join(parent, `${process.pid}-0123456789`);
    mkdirSync(ownNs);
    const oddName = join(parent, 'not-a-namespace');
    mkdirSync(oddName);
    const deadFile = join(parent, `${dead}-ffff`);
    writeFileSync(deadFile, '');
    const deadLink = join(parent, `${dead}-eeee`);
    symlinkSync(oddName, deadLink);
    const removed = reapStaleChatNamespaces(parent);
    expect(removed).toEqual([deadNs]);
    expect(existsSync(deadNs)).toBe(false);
    expect(existsSync(ownNs)).toBe(true);
    expect(existsSync(oddName)).toBe(true);
    expect(existsSync(deadFile)).toBe(true);
    expect(lstatSync(deadLink).isSymbolicLink()).toBe(true);
    // A parent that is a link, or missing, reaps nothing and never throws.
    const linkParent = join(base, 'linked-parent');
    symlinkSync(parent, linkParent);
    expect(reapStaleChatNamespaces(linkParent)).toEqual([]);
    expect(reapStaleChatNamespaces(join(base, 'missing'))).toEqual([]);
    expect(existsSync(ownNs)).toBe(true);
  });

  it('ChatScopeIndex.delete forgets the chat AND removes its scratch root; idempotent', () => {
    const index = new ChatScopeIndex(base);
    const scope = { kind: 'none' as const, repos: [], cwd: join(base, 'c9'), graph: { bound: false, reason: 'x' }, dangling: [] };
    prepareChatScratch('c9', scope);
    index.set('c9', scope, index.reserve('c9')!);
    expect(index.get('c9')).toBe(scope);
    expect(index.delete('c9')).toBe(scope);
    expect(index.get('c9')).toBeUndefined();
    expect(existsSync(scope.cwd)).toBe(false);
    expect(index.delete('c9')).toBeUndefined();
    expect(index.delete('never-set')).toBeUndefined();
  });
});
