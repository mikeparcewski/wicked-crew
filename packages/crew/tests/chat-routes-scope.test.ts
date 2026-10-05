// `POST /chats` scope lifecycle (crew#502) over a FAKE adapter — the stub engine cannot open chats,
// so the happy path, the live-id refusal, the detail/delete lifecycle and the grounding downgrade
// are pinned here with `app.inject` and a scratch base under mkdtemp (never the real
// `<tmp>/wicked-crew-chats`).

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatScopeIndex } from '../src/api/chat-scope.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { CoreAdapter } from '../src/core/adapter.js';

let base: string;
let graphFile: string;
let app: FastifyInstance;
let chatScopes: ChatScopeIndex;
let applied: boolean | null;
/** The injected sign-in probe: `null` (unknown → admitted) unless a test says otherwise. */
let signedIn: (seatKey: string) => boolean | null = () => null;
/** crew#642 — entity-count probe: returns 1 (indexed) by default; override per-test for zero-entity. */
let entityCount: (dbPath: string) => Promise<number> = async () => 1;
/** Every frame the route broadcast to /ws (the thread's copy of a refusal). */
let broadcast: unknown[];
/** When set, the close fold parks until released — a DELETE that is still settling (codex on #808 r5). */
let holdFold: { promise: Promise<void>; release: () => void } | null = null;
/** chatId → the seats that actually warmed, filled by the adapter's `chatOpen` wrapper. */
let warmByChat: Map<string, string[]>;
/** What `registerRoutes` handed back (DC-S7: the consideration service's per-chat state). */
/** When set, decides what a send REACHES — used to model a turn that reaches fewer seats than are
 *  warm (a transient engine drop), which is the only broadcast that can tell "roster" from "reach". */
let sendReaches: ((chatId: string, targets?: string[]) => string[]) | null = null;
/** When set, `projectMemberAttach` parks until released — the open-in-flight window (codex on #808 r2, 3+4). */
let holdAttach: { promise: Promise<void>; release: () => void } | null = null;
let attachCount = 0;
/** When set, the NEXT `listRepos` (scope resolution, before the scratch root is written) parks until
 *  released — the stale-open window (codex on #808 r3, 3). */
let holdReposOnce: { promise: Promise<void>; release: () => void } | null = null;
/** Records exactly what the route hands the engine: `(chatId, clis, cwd, scope)`. */
const chatOpen = vi.fn(async (...args: [string, string[], string?, unknown?]) =>
  args[1].map((c) => ({ cliKey: c, ok: true })),
);

/** The adapter surface `POST /chats` / `GET /chats/:id` / `DELETE /chats/:id` actually touch. */
function fakeAdapter(): CoreAdapter {
  return {
    listRepos: async () => {
      const held = holdReposOnce;
      holdReposOnce = null;
      if (held !== null) await held.promise;
      return repos();
    },
    chatOpen: async (...args: [string, string[], string?, unknown?]) => {
      const out = await chatOpen(...args);
      warmByChat.set(args[0], out.filter((s) => s.ok).map((s) => s.cliKey));
      return out;
    },
    chatScopeApplied: async () => applied,
    chatSeats: async (chatId: string) => warmByChat.get(chatId) ?? [],
    chatSend: async (chatId: string, _text: string, targets?: string[]) => {
      if (sendReaches !== null) return sendReaches(chatId, targets);
      const warm = warmByChat.get(chatId) ?? [];
      return targets === undefined ? warm : targets.filter((t) => warm.includes(t));
    },
    chatClose: async () => undefined,
    chatList: async () => [],
    projectGet: async (id: string) => (id === 'p-live' ? { id, status: 'active' } : null),
    projectMemberAttach: async () => {
      // Parks the FIRST attach only (a reopen's own attach goes straight through).
      const held = holdAttach;
      holdAttach = null;
      if (held !== null) await held.promise;
      attachCount += 1;
      return { member: { id: `m-${attachCount}`, attached_at: attachCount }, created: true };
    },
    projectMemberDetach: async () => true,
  } as unknown as CoreAdapter;
}

function repos() {
  return [
    {
      id: 'r1',
      name: 'alpha',
      root_path: '/srv/repos/alpha',
      default_branch: 'main',
      registered_at: 1,
      code_graph_db: graphFile,
    },
  ];
}


beforeEach(async () => {
  holdFold = null;
  holdAttach = null;
  holdReposOnce = null;
  base = mkdtempSync(join(tmpdir(), 'chat-routes-scope-'));
  graphFile = join(base, 'alpha-graph.db');
  writeFileSync(graphFile, '');
  applied = true;
  chatOpen.mockClear();
  signedIn = () => null;
  entityCount = async () => 1; // default: indexed; override per-test for crew#642 zero-entity path
  broadcast = [];
  warmByChat = new Map();
  sendReaches = null;
  chatScopes = new ChatScopeIndex(join(base, 'chats'));
  app = Fastify({ logger: false });
  registerRoutes(app, fakeAdapter(), new GateCache(), new ElicitationCache(), undefined, undefined, {
    chatScopes,
    // Never the real dotfile probe: the suite must not read the developer's worker home.
    signedIn: (seatKey) => signedIn(seatKey),
    broadcast: (frame) => broadcast.push(frame),
    // crew#642: never shell wicked-estate against mkdtemp fixtures.
    entityCount: (dbPath) => entityCount(dbPath),
    // The server's fold, as a test double: settles the held close only when the fixture lets it.
    closeChat: async (frame, _runId, ticket) => {
      if (holdFold !== null) await holdFold.promise;
      const chat = String(frame.chat);
      if (!chatScopes.isHeld(chat, ticket)) return;
      chatScopes.closeHeld(chat, ticket);
      broadcast.push(frame);
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(base, { recursive: true, force: true });
});

const open = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/chats', payload: body });

describe('POST /chats — scope lifecycle over a fake engine', () => {
  it('opens in a private scratch root, states the scope to the seats, hands the engine cwd + graph + roots, and returns the scope', async () => {
    const res = await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { chatId: string; seats: unknown[]; scope: { kind: string; cwd: string; repos: { rootPath: string }[]; graph: { bound: boolean } } };
    expect(body.chatId).toBe('live');
    expect(body.seats).toEqual([{ cliKey: 'claude', ok: true }]);
    expect(body.scope.kind).toBe('repos');
    expect(body.scope.repos.map((r) => r.rootPath)).toEqual(['/srv/repos/alpha']);
    expect(body.scope.graph.bound).toBe(true);
    expect(body.scope.cwd).toBe(join(base, 'chats', 'live'));
    // The seats read this — repo path, read-only rule, grounding.
    const agents = readFileSync(join(body.scope.cwd, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('/srv/repos/alpha');
    expect(agents).toMatch(/READ-ONLY/);
    // DES-L5 §5-a re-cut (recon-w1-grounding Q4 cause #1): the grounding hands ONE worked shim command — never an MCP server.
    expect(agents).toMatch(/## Grounding/);
    expect(agents).toContain("wicked-garden run scripts/_estate_client.py --readonly call '{\"tool\":\"SearchEntity\"");
    expect(agents).toContain('the store is pinned by `WICKED_ESTATE_DB`');
    expect(agents).not.toMatch(/MCP/);
    expect(existsSync(join(body.scope.cwd, 'CLAUDE.md'))).toBe(true);
    // ASK-C1 (DES-ASK-TEAM-CHAT-001 §5.1): the open warms NOTHING — the chat is a path its first
    // message launches; the seats are the eligible roster and the engine scope is recorded for it.
    expect(chatOpen).toHaveBeenCalledTimes(0);
    expect(chatScopes.get('live')?.cwd).toBe(body.scope.cwd);
    expect(chatScopes.engineOf('live')).toEqual({ cwd: body.scope.cwd, codeGraphDb: graphFile, readRoots: ['/srv/repos/alpha'] });
  });

  it('refuses to re-open a chat id this daemon already holds (409) BEFORE touching its root or the engine', async () => {
    expect((await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
    const stamp = readFileSync(join(base, 'chats', 'live', 'AGENTS.md'), 'utf8');
    const again = await open({ chatId: 'live', clis: ['claude'] });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toMatch(/already open/);
    expect(chatOpen).toHaveBeenCalledTimes(0);
    expect(readFileSync(join(base, 'chats', 'live', 'AGENTS.md'), 'utf8')).toBe(stamp);
  });

  it('GET /chats/:id carries the recorded scope; DELETE removes the scratch root and frees the id at once (ASK-C1: no engine close is coming for a path)', async () => {
    await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] });
    const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/live' });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { scope: { kind: string } | null }).scope?.kind).toBe('repos');
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/chats/live' });
    expect(del.statusCode).toBe(200);
    expect(existsSync(join(base, 'chats', 'live'))).toBe(false);
    expect(chatScopes.get('live')).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/live' })).json()).toMatchObject({ scope: null });
    // ASK-C1: the daemon owns the close (the engine holds no row for a path), so the id is free
    // the moment DELETE answers — the route's own fold ran `chatScopes.closed` (codex on #808, 5).
    expect((await open({ chatId: 'live', clis: ['claude'] })).statusCode).toBe(201);
  });

  it('the DEFAULT seats of a SINGLE-REPO ask are every seat in STANDING — the run is bound, so the pool\'s ACP pre-filter does not apply (W5 re-cut for ASK-C2); a disabled seat is named', async () => {
    const spy = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } },
      { key: 'codex', acp: { acp_input_governance: false, os_sandbox: true } },
      { key: 'agy', enabled_for_council: false },
    ]);
    try {
      const scopedRes = await open({ chatId: 'dflt-scoped', repoRefs: ['alpha'] });
      expect(scopedRes.statusCode).toBe(201);
      expect((scopedRes.json() as { seats: { cliKey: string }[] }).seats.map((x) => x.cliKey)).toEqual(['claude', 'pi', 'codex']);
      const scopedBody = scopedRes.json() as { refused: { cliKey: string; reason: string }[] };
      expect(scopedBody.refused.map((r) => r.cliKey)).toEqual(['agy']);
      expect(scopedBody.refused[0]!.reason).toMatch(/disabled for the council/);
      expect(broadcast).toEqual([{ type: 'chatSeatRefused', chat: 'dflt-scoped', cliKey: 'agy', reason: scopedBody.refused[0]!.reason, source: 'scope' }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a SIGNED-OUT default seat is refused up front with the reason (the roster\'s auth predicate); a free-tier seat with no credential is seated (F-2R2-009)', async () => {
    const spy = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'opencode', acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'codex', acp: { acp_input_governance: false, os_sandbox: true } },
    ]);
    // The fresh rig: claude signed in, the rest not observable as signed in.
    signedIn = (seatKey) => seatKey === 'claude';
    try {
      const res = await open({ chatId: 'auth-scoped', repoRefs: ['alpha'] });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { seats: { cliKey: string }[] }).seats.map((x) => x.cliKey)).toEqual(['claude', 'opencode']);
      const body = res.json() as { refused: { cliKey: string; reason: string }[] };
      expect(body.refused).toHaveLength(1);
      expect(body.refused[0]!.cliKey).toBe('codex');
      expect(body.refused[0]!.reason).toMatch(/signed out/);
      expect(body.refused[0]!.reason).not.toMatch(/asks no permissions/);
      // Everyone signed out and no free tier: nothing can take a turn, said plainly (unscoped too).
      spy.mockReturnValue([{ key: 'codex', acp: { acp_input_governance: true, os_sandbox: false } }]);
      signedIn = () => false;
      const none = await open({ chatId: 'auth-none' });
      expect(none.statusCode).toBe(409);
      expect((none.json() as { error: string }).error).toMatch(/every seat is signed out/);
      expect(chatOpen).not.toHaveBeenCalledWith('auth-none', expect.anything(), expect.anything(), expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

});

// crew#650 — the other branch of #641's condition. `singleSeat` was gated on `refused.length > 0`,
// so the case an operator is most likely to create — a chat opened with ONE seat on purpose, nothing
// refused — opened silently: `ok: true`, `refused: []`, no disclosure at all. The chat is just as
// unable to disagree with itself, which is the property the field exists to state.
/** The disclosure as a consumer sees it (crew#650 + the #658 review's `refusalsKnown`). */

describe('ASK-C1 — an ask starts a path: the open records eligibility and a chosen primary, warms nothing', () => {
  it('`primary` must be one of the eligible seats (400 names the eligible list); a valid one is recorded as the chosen PA', async () => {
    const bad = await open({ chatId: 'pick-bad', clis: ['claude', 'opencode'], repoRefs: ['alpha'], primary: 'codex' });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toMatch(/primary names a seat that is not eligible.*claude, opencode/);
    expect(existsSync(join(base, 'chats', 'pick-bad')), 'a refused open frees its root').toBe(false);
    const good = await open({ chatId: 'pick', clis: ['claude', 'opencode'], repoRefs: ['alpha'], primary: 'opencode' });
    expect(good.statusCode).toBe(201);
    expect((good.json() as { seats: { cliKey: string; ok: boolean }[] }).seats).toEqual([
      { cliKey: 'claude', ok: true },
      { cliKey: 'opencode', ok: true },
    ]);
    expect(chatOpen, 'the engine warms nothing at open').not.toHaveBeenCalled();
    // No path yet: the first message launches it.
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/pick' })).json()).not.toHaveProperty('path');
  });

  it('POST /chats/:id/seats re-admits a seat into the eligible roster with no engine call; an unknown chat is 404', async () => {
    expect((await open({ chatId: 'reseat', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
    const retry = await app.inject({ method: 'POST', url: '/api/v1/chats/reseat/seats', payload: { clis: ['opencode'] } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ chatId: 'reseat', seats: [{ cliKey: 'opencode', ok: true }], refused: [] });
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/reseat' })).json()).toMatchObject({ seats: ['claude', 'opencode'] });
    expect(chatOpen).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/nope/seats', payload: { clis: ['claude'] } })).statusCode).toBe(404);
    // codex on #808 (4): a re-seat ADMITS, it does not blindly admit — an unknown key is refused
    // by name (a wrapped seat like pi IS eligible on a path, ASK-C2); the roster grows by pi only.
    const bad = await app.inject({ method: 'POST', url: '/api/v1/chats/reseat/seats', payload: { clis: ['pi', 'nobody'] } });
    expect(bad.statusCode).toBe(200);
    expect((bad.json() as { seats: { cliKey: string; ok: boolean }[] }).seats.map((s) => s.ok)).toEqual([true, false]);
    expect((bad.json() as { refused: { cliKey: string; reason: string }[] }).refused.map((r) => r.cliKey)).toEqual(['nobody']);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/reseat' })).json()).toMatchObject({ seats: ['claude', 'opencode', 'pi'] });
  });

  it('codex on #808 (4) + r2 (5) / ASK-C2: seats NAMED in `clis` go through the SAME admission as the default roster — the seat\'s STANDING; an ask is a team run, so the pool\'s ACP rules do not apply (pi and codex are eligible)', async () => {
    const both = await open({ chatId: 'named-pi', clis: ['claude', 'pi'], repoRefs: ['alpha'] });
    expect(both.statusCode).toBe(201);
    const body = both.json() as { seats: { cliKey: string; ok: boolean }[]; refused: { cliKey: string; reason: string }[] };
    expect(body.seats, 'a wrapped / permission-less ACP seat is eligible on a PATH').toEqual([{ cliKey: 'claude', ok: true }, { cliKey: 'pi', ok: true }]);
    expect(body.refused).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/named-pi' })).json()).toMatchObject({ seats: ['claude', 'pi'] });
    // A key the roster does not know is refused by name.
    const unknown = await open({ chatId: 'named-unknown', clis: ['claude', 'nobody'], repoRefs: ['alpha'] });
    expect(unknown.statusCode).toBe(201);
    expect((unknown.json() as { seats: { cliKey: string; ok: boolean }[] }).seats).toEqual([{ cliKey: 'claude', ok: true }]);
    expect((unknown.json() as { refused: { cliKey: string; reason: string }[] }).refused[0]).toMatchObject({ cliKey: 'nobody', reason: expect.stringMatching(/not in the roster/) });
    // A named seat that is signed out is refused like a default one — nothing is launched that
    // the engine would bench on arrival.
    signedIn = () => false;
    const out = await open({ chatId: 'named-out', clis: ['claude'], repoRefs: ['alpha'] });
    expect(out.statusCode).toBe(409);
    expect((out.json() as { refused: { cliKey: string; reason: string }[] }).refused[0]).toMatchObject({ cliKey: 'claude', reason: expect.stringMatching(/signed out/) });
    expect(existsSync(join(base, 'chats', 'named-out')), 'a refused open leaves no root').toBe(false);
  });

  it('codex on #808 r2 (3+4): the path record is published only once the scope is COMMITTED; an open cancelled mid-flight never touches the replacement that reused the id', async () => {
    let releaseAttach: () => void = () => undefined;
    const held = { promise: new Promise<void>((r) => { releaseAttach = r; }), release: () => releaseAttach() };
    holdAttach = held;
    const first = open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'], projectId: 'p-live' });
    await new Promise((r) => setTimeout(r, 20));
    // Mid-open: no path yet — a message finds nothing to launch against, and the list is empty.
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/live/messages', payload: { text: 'too early' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats' })).json()).toEqual({ chats: [] });
    // End it while it is still opening, then reuse the id.
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/live' })).statusCode).toBe(200);
    const second = await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] });
    expect(second.statusCode).toBe(201);
    const cwd = (second.json() as { scope: { cwd: string } }).scope.cwd;
    expect(existsSync(cwd)).toBe(true);
    // The first open resumes: its reservation is gone — 409, and the replacement is untouched.
    held.release();
    const res = await first;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/closed while it was being opened/);
    expect(existsSync(cwd), 'the replacement keeps its scratch root').toBe(true);
    expect(chatScopes.get('live')?.cwd).toBe(cwd);
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats' })).json()).toEqual({
      chats: [{ chatId: 'live', seats: ['claude'], idleSecs: null, cwd, codeGraphDb: graphFile, readRoots: ['/srv/repos/alpha'] }],
    });
    holdAttach = null;
  });

  it('codex on #808 r5 (2): while a DELETE is still settling, the id is HELD — a reopen is refused (409 closing), no grace timer frees it; once the fold settles the id is free', async () => {
    expect((await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
    let releaseFold: () => void = () => undefined;
    holdFold = { promise: new Promise<void>((r) => { releaseFold = r; }), release: () => releaseFold() };
    const del = app.inject({ method: 'DELETE', url: '/api/v1/chats/live' });
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(join(base, 'chats', 'live')), 'the root goes at once').toBe(false);
    const tooSoon = await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] });
    expect(tooSoon.statusCode).toBe(409);
    expect((tooSoon.json() as { error: string }).error).toMatch(/closing/);
    expect(chatScopes.stateOf('live')).toBe('held');
    holdFold.release();
    holdFold = null;
    expect((await del).statusCode).toBe(200);
    expect(chatScopes.has('live')).toBe(false);
    expect((await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
  });

  it('codex on #808 r4 (2): a stale open\'s project attach neither publishes nor erases the reopened chat\'s project mapping', async () => {
    let releaseAttach: () => void = () => undefined;
    const held = { promise: new Promise<void>((r) => { releaseAttach = r; }), release: () => releaseAttach() };
    holdAttach = held;
    const stale = open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'], projectId: 'p-live' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/live' })).statusCode).toBe(200);
    const fresh = await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'], projectId: 'p-live' });
    expect(fresh.statusCode).toBe(201);
    held.release();
    expect((await stale).statusCode).toBe(409);
    // The newcomer's filing stands: its close frame names the project.
    broadcast.length = 0;
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/live' })).statusCode).toBe(200);
    const closed = broadcast.find((f) => (f as { type: string }).type === 'chatClosed') as { project_id?: string } | undefined;
    expect(closed?.project_id, 'the stale open\'s cleanup did not erase the replacement\'s project').toBe('p-live');
  });

  it('codex on #808 r4 (3): a scratch root that pre-exists and cannot be prepared is preserved by the 500 — the route removes nothing the helper did not create', async () => {
    const root = join(base, 'chats', 'pre');
    mkdirSync(join(root, 'AGENTS.md'), { recursive: true }); // a DIRECTORY where the file goes: EEXIST
    const res = await open({ chatId: 'pre', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(500);
    expect(existsSync(join(root, 'AGENTS.md')), 'the pre-existing root and its contents stand').toBe(true);
    // The id is free again.
    rmSync(root, { recursive: true, force: true });
    expect((await open({ chatId: 'pre', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
  });

  it('codex on #808 r3 (3): an open parked in scope resolution, closed, and overtaken by a reopen of its id neither rewrites nor removes the newcomer\'s scratch root', async () => {
    let releaseRepos: () => void = () => undefined;
    holdReposOnce = { promise: new Promise<void>((r) => { releaseRepos = r; }), release: () => releaseRepos() };
    // `primary` names an ineligible seat: without the ownership check this open would reach the
    // 400 arm and remove the root it shares with the newcomer.
    const stale = open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'], primary: 'codex' });
    await new Promise((r) => setTimeout(r, 20));
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/live' })).statusCode).toBe(200);
    const fresh = await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] });
    expect(fresh.statusCode).toBe(201);
    const cwd = (fresh.json() as { scope: { cwd: string } }).scope.cwd;
    const stamp = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    releaseRepos();
    const res = await stale;
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/closed while it was being opened/);
    expect(existsSync(cwd), 'the newcomer keeps its root').toBe(true);
    expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8'), 'and its statement').toBe(stamp);
    expect(chatScopes.get('live')?.cwd).toBe(cwd);
  });
});

describe('crew#642 — zero-entity graph reports ungrounded on the 201 scope', () => {
  it('a zero-entity graph (entityCount → 0) reports ungrounded on the scope.graph — FAILS on main (returns bound:true)', async () => {
    entityCount = async () => 0;
    const res = await open({ chatId: 'zerogr', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { scope: { graph: { bound: boolean; reason: string } } };
    expect(body.scope.graph.bound).toBe(false);
    expect(body.scope.graph.reason).toMatch(/holds no entities/);
    expect(body.scope.graph.reason).toMatch(/index the repo/);
  });

  it('a populated graph (entityCount → 1) reports grounded — guards over-fire', async () => {
    entityCount = async () => 1;
    const res = await open({ chatId: 'fullgr', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { scope: { graph: { bound: boolean } } };
    expect(body.scope.graph.bound).toBe(true);
  });
});

// studio#323 R4 — `scopeKind` on the wire: system + everything / project / repo.
describe('POST /chats — named scope kinds (studio#323 R4)', () => {
  it("scopeKind 'system' opens a stated platform chat: no read roots, the UNSCOPED seat admission, and a statement the seats read", async () => {
    const spy = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } },
    ]);
    try {
      const res = await open({ chatId: 'sys', scopeKind: 'system' });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { scope: { kind: string; repos: unknown[]; cwd: string; graph: { bound: boolean; reason: string } } };
      expect(body.scope.kind).toBe('system');
      expect(body.scope.repos).toEqual([]);
      expect(body.scope.graph.bound).toBe(false);
      // pi (no permission asks) is admitted: a system chat holds no repository read-only.
      expect((res.json() as { seats: { cliKey: string }[] }).seats.map((x) => x.cliKey)).toEqual(['claude', 'pi']);
      expect(chatScopes.engineOf('sys')).toEqual({ cwd: body.scope.cwd, codeGraphDb: null, readRoots: [] });
      expect(chatOpen).not.toHaveBeenCalled();
      expect(readFileSync(join(body.scope.cwd, 'AGENTS.md'), 'utf8')).toMatch(/## Scope: system/);
    } finally {
      spy.mockRestore();
    }
  });

  it("scopeKind 'system' opens on an engine that predates chat scope (it promises no read roots)", async () => {
    applied = false;
    const res = await open({ chatId: 'sys-old', clis: ['claude'], scopeKind: 'system' });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { scope: { kind: string } }).scope.kind).toBe('system');
  });

  it("scopeKind 'everything' reads every registered repo; the run cannot BIND several repositories, so a seat that cannot hold itself read-only is refused (ASK-C2; codex on #810 r9)", async () => {
    const spy = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } },
    ]);
    try {
      const res = await open({ chatId: 'all', scopeKind: 'everything' });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { scope: { kind: string; repos: { rootPath: string }[]; cwd: string }; refused: { cliKey: string }[] };
      expect(body.scope.kind).toBe('everything');
      expect(body.scope.repos.map((r) => r.rootPath)).toEqual(['/srv/repos/alpha']);
      expect(body.refused.map((r) => r.cliKey), 'pi: no permissions, no sandbox — unbound scope').toEqual(['pi']);
      expect((res.json() as { seats: { cliKey: string }[] }).seats.map((x) => x.cliKey)).toEqual(['claude']);
      expect(chatScopes.engineOf('all')).toEqual({ cwd: body.scope.cwd, codeGraphDb: null, readRoots: ['/srv/repos/alpha'] });
      expect(chatOpen).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("scopeKind 'repo' is the explicit repo list; a kind missing what it needs is a 400 BEFORE any seat warms", async () => {
    const one = await open({ chatId: 'one', clis: ['claude'], scopeKind: 'repo', repoRefs: ['alpha'] });
    expect(one.statusCode).toBe(201);
    expect((one.json() as { scope: { kind: string } }).scope.kind).toBe('repos');
    chatOpen.mockClear();
    const noRepos = await open({ chatId: 'no-repos', clis: ['claude'], scopeKind: 'repo' });
    expect(noRepos.statusCode).toBe(400);
    expect((noRepos.json() as { error: string }).error).toMatch(/repoRefs/);
    const noProject = await open({ chatId: 'no-project', clis: ['claude'], scopeKind: 'project' });
    expect(noProject.statusCode).toBe(400);
    expect((noProject.json() as { error: string }).error).toMatch(/projectId/);
    const sysRepos = await open({ chatId: 'sys-repos', clis: ['claude'], scopeKind: 'system', repoRefs: ['alpha'] });
    expect(sysRepos.statusCode).toBe(400);
    expect(chatOpen).not.toHaveBeenCalled();
    // A refused open frees its id: nothing is held.
    expect(chatScopes.has('no-repos')).toBe(false);
    expect(existsSync(join(base, 'chats', 'no-repos'))).toBe(false);
  });

  it('a named-scope SHAPE error is a 400 even when the project does not exist — the shape is checked before the project lookup (codex on #664)', async () => {
    const none = await open({ chatId: 'none-missing', clis: ['claude'], scopeKind: 'none', projectId: 'missing' });
    expect(none.statusCode).toBe(400);
    expect((none.json() as { error: string }).error).toMatch(/scopeKind 'none' takes no projectId/);
    const sys = await open({ chatId: 'sys-missing', clis: ['claude'], scopeKind: 'system', projectId: 'missing', repoRefs: ['alpha'] });
    expect(sys.statusCode).toBe(400);
    expect((sys.json() as { error: string }).error).toMatch(/scopeKind 'system' takes no repoRefs/);
    expect(chatOpen).not.toHaveBeenCalled();
    expect(chatScopes.has('none-missing')).toBe(false);
    expect(chatScopes.has('sys-missing')).toBe(false);
  });

  it('an unknown scopeKind is a 400 from body validation', async () => {
    const res = await open({ chatId: 'bad', clis: ['claude'], scopeKind: 'galaxy' });
    expect(res.statusCode).toBe(400);
    expect(chatOpen).not.toHaveBeenCalled();
  });
});

