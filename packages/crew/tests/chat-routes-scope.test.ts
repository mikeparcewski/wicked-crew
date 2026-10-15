// `POST /chats` scope lifecycle (crew#502) over a FAKE adapter — the stub engine cannot open chats,
// so the happy path, the live-id refusal, the detail/delete lifecycle and the grounding downgrade
// are pinned here with `app.inject` and a scratch base under mkdtemp (never the real
// `<tmp>/wicked-crew-chats`).

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AskRelay } from '../src/api/ask-relay.js';
import { ChatTranscriptStore } from '../src/api/chat-transcripts.js';
import { ConsiderationService } from '../src/decisions/consider.js';
import type { CoreEvent, LaunchRunInput } from '../src/core/types.js';
import type { BusEvent } from '../src/core/bus.js';
import { AskPathIndex } from '../src/api/ask-paths.js';
import { ChatScopeIndex } from '../src/api/chat-scope.js';
import { ChatTurnIndex } from '../src/api/chat-turns.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import * as projectGraph from '../src/projects/graph.js';

let base: string;
/** crew#823: the membership index the routes file runs into (a run of the chat's project). */
let membership: MembershipIndex;
/** crew#823: what the ask's first message hands the engine. */
let launched: LaunchRunInput[];
/** CoreAdapter.launchRun fills this binding only when the caller left projectGraph undefined. */
let launchSafetyNetBinding: LaunchRunInput['projectGraph'];
let graphFile: string;
let adapter: CoreAdapter;
let projectRepoRefs: string[];
let registryFails: boolean;
let app: FastifyInstance;
let chatScopes: ChatScopeIndex;
let askPaths: AskPathIndex;
let relay: AskRelay;
let transcripts: ChatTranscriptStore;
const linkChatRun = vi.fn();
let chatTurns: ChatTurnIndex;
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
    listRepos: vi.fn(async () => {
      if (registryFails) throw new Error('registry unreadable');
      const held = holdReposOnce;
      holdReposOnce = null;
      if (held !== null) await held.promise;
      return repos();
    }),
    projectMembers: async () => projectRepoRefs.map((ref) => ({ member_kind: 'crew.repo', member_ref: ref })),
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
    launchRun: vi.fn(async (input: LaunchRunInput) => {
      if (input.projectId !== undefined && input.projectGraph === undefined && launchSafetyNetBinding !== undefined) {
        input.projectGraph = launchSafetyNetBinding;
      }
      launched.push(input);
      return `run-p${launched.length}`;
    }),
    projectGet: vi.fn(async (id: string) => (id === 'p-live' ? { id, status: 'active' } : null)),
    projectMemberAttach: async (_projectId: string, kind: string, ref: string) => {
      if (kind === 'crew.repo') projectRepoRefs.push(ref);
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
  projectRepoRefs = [];
  registryFails = false;
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
  chatTurns = new ChatTurnIndex();
  askPaths = new AskPathIndex();
  transcripts = new ChatTranscriptStore({ dir: join(base, 'transcripts') });
  relay = new AskRelay({
    paths: askPaths,
    turns: chatTurns,
    units: async (runId) => [{ id: `${runId}:answer-1`, ord: 1, status: 'done', assigned_cli: askPaths.get(askPaths.chatOf(runId) ?? '')?.pa ?? 'claude' }],
    workOutput: async () => 'See /srv/repos/alpha/src/index.ts:10',
    fold: (frame) => {
      const stamped = transcripts.rewriteEvent(chatTurns.decorate(frame));
      transcripts.observe(stamped);
      broadcast.push(stamped);
      chatTurns.observe(frame);
    },
  });
  linkChatRun.mockClear();
  membership = new MembershipIndex();
  launched = [];
  launchSafetyNetBinding = undefined;
  app = Fastify({ logger: false });
  adapter = fakeAdapter();
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), { bus: null, index: membership, log: () => undefined }, undefined, {
    chatScopes,
    chatTurns,
    askPaths,
    chatTranscripts: transcripts,
    linkChatRun,
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

  it('crew#823: an ask in a project scope files its run in the chat\'s project and is titled by the question; the scope statement rides the step instructions', async () => {
    expect((await open({ chatId: 'proj-ask', clis: ['claude'], repoRefs: ['alpha'], projectId: 'p-live' })).statusCode).toBe(201);
    const sent = await app.inject({ method: 'POST', url: '/api/v1/chats/proj-ask/messages', payload: { text: 'Which module owns loan due dates?' } });
    expect(sent.statusCode).toBe(202);
    expect(launched).toHaveLength(1);
    const input = launched[0]!;
    expect(input['problem'], 'never the "# Chat scope" preamble').toBe('Which module owns loan due dates?');
    expect(input['projectId']).toBe('p-live');
    const instructions = input.plan!.steps[0]!['instructions'] as string;
    expect(instructions.startsWith('# Chat scope')).toBe(true);
    expect(instructions.endsWith('Which module owns loan due dates?')).toBe(true);
    expect(membership.projectOf('run-p1'), 'GET /runs/:id.session.project_id reads this index').toBe('p-live');
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

  it("scopeKind 'everything' reads every registered repo; the run cannot BIND several repositories, so a seat whose governance mode is none for the scope is refused (ASK-C2; IG1-crew-2)", async () => {
    const spy = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', governance_class: 'acp_input_governance', acp: { acp_input_governance: true, os_sandbox: false } },
      // pi is on the floor, but its floor is the repository boundary — which needs a bound run.
      { key: 'pi', governance_class: 'os_sandbox', acp: { acp_input_governance: false, os_sandbox: false } },
    ]);
    try {
      const res = await open({ chatId: 'all', scopeKind: 'everything' });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { scope: { kind: string; repos: { rootPath: string }[]; cwd: string }; refused: { cliKey: string }[] };
      expect(body.scope.kind).toBe('everything');
      expect(body.scope.repos.map((r) => r.rootPath)).toEqual(['/srv/repos/alpha']);
      expect(body.refused.map((r) => r.cliKey), 'pi: repository boundary only — unbound scope').toEqual(['pi']);
      expect((body.refused as unknown as { reason: string }[])[0]!.reason).toMatch(/governance mode for this scope is none/);
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


// crew#1020: project membership and the registry can change while the same chat stays open.
describe('POST /chats/:id/messages — refresh dynamic scopes', () => {
  const send = (id: string) => app.inject({ method: 'POST', url: `/api/v1/chats/${id}/messages`, payload: { text: 'Where is the entry point?' } });

  it('sees a repo attached after an empty project chat opened, retaining its scratch files', async () => {
    const opened = await open({ chatId: 'dynamic', clis: ['claude'], projectId: 'p-live' });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().scope.repos).toEqual([]);
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      expect(readFileSync(join(opened.json().scope.cwd as string, file), 'utf8')).toContain('attach it to this project and start a NEW chat to read it');
    }
    const cwd = opened.json().scope.cwd as string;
    writeFileSync(join(cwd, 'notes.txt'), 'keep me');
    const attached = await app.inject({ method: 'POST', url: '/api/v1/projects/p-live/members', payload: { kind: 'crew.repo', ref: 'r1' } });
    expect(attached.statusCode).toBe(201);
    expect((await send('dynamic')).statusCode).toBe(202);
    const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/dynamic' });
    expect(detail.json().scope.repos).toEqual([expect.objectContaining({ id: 'r1', rootPath: '/srv/repos/alpha' })]);
    expect(detail.json().scope.cwd).toBe(cwd);
    expect(chatScopes.engineOf('dynamic')?.readRoots).toEqual(['/srv/repos/alpha']);
    expect(launched[0]).toMatchObject({ projectId: 'p-live' });
    for (const field of ['cwd', 'readRoots', 'codeGraphDb']) expect(launched[0]).not.toHaveProperty(field);
    // crew#1034: the repository is the run's read root whether or not the project graph is built.
    expect(launched[0]?.extraReadRoots).toEqual(['/srv/repos/alpha']);
    expect(askPaths.get('dynamic')?.launchReadRoots).toEqual(['/srv/repos/alpha']);
    for (const file of ['AGENTS.md', 'CLAUDE.md']) expect(readFileSync(join(cwd, file), 'utf8')).toContain('/srv/repos/alpha');
    expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('keep me');
    const instructions = launched[0]!.plan!.steps[0]!['instructions'] as string;
    expect(instructions).toContain('/srv/repos/alpha');
  });

  function park(id: string) {
    chatTurns.observe({ type: 'chatReply', chat: id, cliKey: askPaths.get(id)?.pa ?? 'claude', text: 'Attach the repository and start a new chat to read it.', ok: true });
    adapter.sessionsDetail = async () => [{ session: { id: askPaths.get(id)?.runId, status: 'awaiting_human' } }] as Awaited<ReturnType<CoreAdapter['sessionsDetail']>>;
    const propose = vi.fn<CoreAdapter['proposePlan']>(async () => ({} as Awaited<ReturnType<CoreAdapter['proposePlan']>>));
    adapter.proposePlan = propose;
    adapter.confirmGate = vi.fn(async () => 'approved');
    adapter.cancelRun = vi.fn(async () => 'cancelled');
    return propose;
  }

  it.each([false, true])('continues a fixed repo chat using its launch binding (filed in project: %s)', async (filed) => {
    if (filed) launchSafetyNetBinding = { dbPath: graphFile, repoLabel: 'alpha' };
    expect((await open({ chatId: 'fixed-binding', clis: ['claude'], repoRefs: ['alpha'], ...(filed ? { projectId: 'p-live' } : {}) })).statusCode).toBe(201);
    expect((await send('fixed-binding')).statusCode).toBe(202);
    expect(askPaths.get('fixed-binding')?.launchGraphBinding).toBe(filed ? graphFile : null);
    const propose = park('fixed-binding');
    expect((await send('fixed-binding')).statusCode).toBe(202);
    expect(propose).toHaveBeenCalledOnce();
    expect(launched).toHaveLength(1);
  });

  it.each([null, 'bound'])('records the graph actually launched despite an opposite adapter safety-net result (resolver: %s)', async (resolved) => {
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue(
      resolved === null ? { binding: null, reason: 'not built yet' } : { binding: { dbPath: graphFile }, reason: 'ready' },
    );
    // Model the real adapter's === undefined guard and mutation of the caller's input:
    // a graph can appear after scope resolution, or its second lookup can fail.
    launchSafetyNetBinding = resolved === null ? { dbPath: graphFile } : undefined;
    try {
      expect((await open({ chatId: 'launch-binding', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      expect((await send('launch-binding')).statusCode).toBe(202);
      expect(launched[0]?.projectGraph).toEqual({ dbPath: graphFile });
      expect(askPaths.get('launch-binding')?.launchGraphBinding).toBe(graphFile);
      binding.mockResolvedValue({ binding: { dbPath: graphFile }, reason: 'ready' });
      const propose = park('launch-binding');
      expect((await send('launch-binding')).statusCode).toBe(202);
      expect(propose).toHaveBeenCalledOnce();
      expect(launched).toHaveLength(1);
    } finally {
      binding.mockRestore();
    }
  });

  it.each(['executing', 'gone'])('checks path status before publishing a changed graph (%s)', async (status) => {
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue({ binding: null, reason: 'not built yet' });
    try {
      expect((await open({ chatId: 'busy-graph', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      expect((await send('busy-graph')).statusCode).toBe(202);
      const propose = park('busy-graph'); // The turn index is clear even though the engine can still be executing.
      const storedScope = chatScopes.get('busy-graph');
      const storedEngine = chatScopes.engineOf('busy-graph');
      const statements = ['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'));
      const roots = vi.spyOn(transcripts, 'registerRoots');
      const refresh = vi.spyOn(chatScopes, 'refresh');
      adapter.sessionsDetail = vi.fn(async () => {
        expect(refresh).not.toHaveBeenCalled();
        expect(roots).not.toHaveBeenCalled();
        expect(['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'))).toEqual(statements);
        return (status === 'gone' ? [] : [{ session: { id: 'run-p1', status } }]) as Awaited<ReturnType<CoreAdapter['sessionsDetail']>>;
      });
      projectRepoRefs.push('r1');
      binding.mockResolvedValue({ binding: { dbPath: graphFile }, reason: 'ready' });
      const sent = await send('busy-graph');
      expect(sent.statusCode).toBe(409);
      expect(adapter.sessionsDetail).toHaveBeenCalledOnce();
      if (status === 'executing') expect(sent.json().code).toBe('turn_in_flight');
      else expect(sent.json().error).toContain('is gone');
      expect(chatScopes.get('busy-graph')).toBe(storedScope);
      expect(chatScopes.engineOf('busy-graph')).toEqual(storedEngine);
      expect(refresh).not.toHaveBeenCalled();
      expect(roots).not.toHaveBeenCalled();
      expect(['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'))).toEqual(statements);
      expect(askPaths.busy('busy-graph')).toBe(false);
      expect(chatTurns.inFlight('busy-graph')).toBeNull();
      expect(propose).not.toHaveBeenCalled();
    } finally {
      binding.mockRestore();
    }
  });

  it('names a graph-only change in the refusal even when the repository list is unchanged', async () => {
    projectRepoRefs.push('r1');
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue({ binding: null, reason: 'not built yet' });
    try {
      expect((await open({ chatId: 'graph-only', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      expect((await send('graph-only')).statusCode).toBe(202);
      park('graph-only');
      const storedScope = chatScopes.get('graph-only');
      binding.mockResolvedValue({ binding: { dbPath: graphFile }, reason: 'ready' });
      const sent = await send('graph-only');
      expect(sent.statusCode).toBe(409);
      expect(sent.json()).toEqual({
        code: 'chat_scope_changed',
        error: "This chat's repositories or their code graph changed since it started (1 now in scope). Start a new chat to read them — this one keeps its original scope.",
      });
      expect(chatScopes.get('graph-only')).toBe(storedScope);
    } finally {
      binding.mockRestore();
    }
  });

  it.each([null, 'bound'])('refuses a changed graph binding without consuming a turn; a new chat can launch (initial: %s)', async (initial) => {
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue(
      initial === null ? { binding: null, reason: 'no members' } : { binding: { dbPath: graphFile }, reason: 'ready' },
    );
    try {
      expect((await open({ chatId: 'continuing', clis: ['claude'], primary: 'claude', projectId: 'p-live' })).statusCode).toBe(201);
      expect((await send('continuing')).statusCode).toBe(202);
      const original = askPaths.get('continuing')!;
      expect(original.launchGraphBinding).toBe(initial === null ? null : graphFile);
      const propose = park('continuing');
      const before = { ...original, steps: [...original.steps] };
      const transcript = transcripts.read('continuing');
      const turns = chatTurns.turnsOf('continuing');
      const storedScope = chatScopes.get('continuing');
      const storedEngine = chatScopes.engineOf('continuing');
      const statements = ['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'));
      const roots = vi.spyOn(transcripts, 'registerRoots');
      projectRepoRefs.push('r1');
      binding.mockResolvedValue(initial === null ? { binding: { dbPath: graphFile }, reason: 'ready' } : { binding: null, reason: 'unavailable' });

      for (let attempt = 0; attempt < 2; attempt++) {
        const sent = await send('continuing');
        expect(sent.statusCode).toBe(409);
        expect(sent.json()).toEqual({
          code: 'chat_scope_changed',
          error: "This chat's repositories or their code graph changed since it started (1 now in scope). Start a new chat to read them — this one keeps its original scope.",
        });
        expect(askPaths.get('continuing')).toBe(original);
        expect(askPaths.get('continuing')).toEqual(before);
        expect(askPaths.busy('continuing')).toBe(false);
        expect(chatTurns.turnsOf('continuing')).toEqual(turns);
        expect(transcripts.read('continuing')).toEqual(transcript);
        expect(chatScopes.get('continuing')).toBe(storedScope);
        expect(chatScopes.engineOf('continuing')).toEqual(storedEngine);
        expect(['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'))).toEqual(statements);
        expect(roots).not.toHaveBeenCalled();
      }
      expect(adapter.cancelRun).not.toHaveBeenCalled();
      expect(propose).not.toHaveBeenCalled();
      expect(adapter.confirmGate).not.toHaveBeenCalled();
      expect(launched).toHaveLength(1);
      expect(linkChatRun.mock.calls).toEqual([['continuing', 'run-p1']]);
      const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/continuing' });
      expect(detail.json().scope).toEqual(storedScope);
      roots.mockRestore();

      expect((await open({ chatId: 'fresh', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      const fresh = await send('fresh');
      expect(fresh.statusCode).toBe(202);
      expect(fresh.json()).toMatchObject({ runId: 'run-p2', stepId: 'answer-1' });
      expect(launched).toHaveLength(2);
      expect(launched[1]?.plan?.steps[0]?.['instructions']).toContain('/srv/repos/alpha');
    } finally {
      binding.mockRestore();
    }
  });

  function completed(runId: string) {
    relay.onTeamRow({ event_type: 'wicked.team.step.completed', payload: { run_id: runId, step_id: 'answer-1', status: 'ok', output_ref: `unit:${runId}:1:1` } } as BusEvent);
    return relay.onCoreEvent({ type: 'unitDone', session: runId, ord: 1 } as CoreEvent);
  }

  it('refreshes transcript roots before the first answer from a newly attached repo', async () => {
    expect((await open({ chatId: 'roots', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
    projectRepoRefs.push('r1');
    const sent = await send('roots');
    expect(sent.statusCode).toBe(202);
    await completed('run-p1');
    expect(broadcast).toContainEqual(expect.objectContaining({ type: 'chatReply', text: 'See alpha/src/index.ts:10' }));
    expect(transcripts.read('roots')).toContainEqual(expect.objectContaining({ kind: 'seat', text: 'See alpha/src/index.ts:10' }));
  });

  it('refuses a repository attached after launch at once, even when the graph binding is unchanged (crew#1034)', async () => {
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue({ binding: { dbPath: graphFile }, reason: 'project graph ready' });
    try {
      expect((await open({ chatId: 'same-graph', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      expect((await send('same-graph')).statusCode).toBe(202);
      expect(askPaths.get('same-graph')?.launchReadRoots).toEqual([]);
      const propose = park('same-graph');
      const storedScope = chatScopes.get('same-graph');
      projectRepoRefs.push('r1');
      const sent = await send('same-graph');
      // The run's read boundary was fixed at launch: accepting the message would hand the seats a
      // statement naming a repository that every read of is refused (verify-e2e r4, crew#1034).
      expect(sent.statusCode).toBe(409);
      expect(sent.json()).toEqual({
        code: 'chat_scope_changed',
        error: "This chat's repositories or their code graph changed since it started (1 now in scope). Start a new chat to read them — this one keeps its original scope.",
      });
      expect(propose).not.toHaveBeenCalled();
      expect(adapter.confirmGate).not.toHaveBeenCalled();
      expect(chatScopes.get('same-graph')).toBe(storedScope);
      expect(askPaths.busy('same-graph')).toBe(false);
      expect(launched).toHaveLength(1);
    } finally {
      binding.mockRestore();
    }
  });

  it('a project chat with an unbuilt graph reads its repository: the launch declares it as a read root (crew#1034)', async () => {
    projectRepoRefs.push('r1');
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue({ binding: null, reason: 'not built yet' });
    try {
      expect((await open({ chatId: 'no-graph', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      expect((await send('no-graph')).statusCode).toBe(202);
      expect(launched[0]).not.toHaveProperty('projectGraph');
      expect(launched[0]?.extraReadRoots).toEqual(['/srv/repos/alpha']);
      // Unchanged roots and graph: the follow-up continues the same run.
      const propose = park('no-graph');
      expect((await send('no-graph')).statusCode).toBe(202);
      expect(propose).toHaveBeenCalledOnce();
      expect(launched).toHaveLength(1);
    } finally {
      binding.mockRestore();
    }
  });

  it('a second registration of the same checkout is not a scope change: the read-root set is compared (crew#1034, codex r1)', async () => {
    vi.mocked(adapter.listRepos).mockResolvedValueOnce(repos());
    expect((await open({ chatId: 'alias', clis: ['claude'], scopeKind: 'everything' })).statusCode).toBe(201);
    vi.mocked(adapter.listRepos).mockResolvedValueOnce(repos());
    expect((await send('alias')).statusCode).toBe(202);
    expect(askPaths.get('alias')?.launchReadRoots).toEqual(['/srv/repos/alpha']);
    const propose = park('alias');
    vi.mocked(adapter.listRepos).mockResolvedValueOnce([...repos(), { ...repos()[0]!, id: 'r2', name: 'alpha-again' }]);
    expect((await send('alias')).statusCode).toBe(202);
    expect(propose).toHaveBeenCalledOnce();
    expect(launched).toHaveLength(1);
  });

  it('every follow-up carries the scope statement, not only the first answer step (crew#1033)', async () => {
    projectRepoRefs.push('r1');
    expect((await open({ chatId: 'every-turn', clis: ['codex'], projectId: 'p-live' })).statusCode).toBe(201);
    expect((await send('every-turn')).statusCode).toBe(202);
    const first = launched[0]!.plan!.steps[0]!['instructions'] as string;
    expect(first).toContain('## Repositories in scope (READ-ONLY)');
    for (const step of ['answer-2', 'answer-3']) {
      const propose = park('every-turn');
      const sent = await send('every-turn');
      expect(sent.statusCode).toBe(202);
      expect(sent.json()).toMatchObject({ runId: 'run-p1', stepId: step });
      const instructions = propose.mock.calls[0]?.[1].steps[0]?.instructions as string;
      expect(instructions).toContain('## Repositories in scope (READ-ONLY)');
      expect(instructions).toContain('/srv/repos/alpha');
      expect(instructions.endsWith('Where is the entry point?')).toBe(true);
    }
    expect(launched).toHaveLength(1);
  });

  it('an everything chat refuses a repository registered after launch, and its empty statement says to start a new chat (crew#1034)', async () => {
    vi.mocked(adapter.listRepos).mockResolvedValueOnce([]);
    expect((await open({ chatId: 'retry-scope', clis: ['claude'], scopeKind: 'everything' })).statusCode).toBe(201);
    vi.mocked(adapter.listRepos).mockResolvedValueOnce([]);
    expect((await send('retry-scope')).statusCode).toBe(202);
    expect(launched[0]).not.toHaveProperty('extraReadRoots');
    const propose = park('retry-scope');
    const storedScope = chatScopes.get('retry-scope');
    const sent = await send('retry-scope');
    expect(sent.statusCode).toBe(409);
    expect(sent.json().code).toBe('chat_scope_changed');
    expect(propose).not.toHaveBeenCalled();
    expect(chatScopes.get('retry-scope')).toBe(storedScope);
    expect(askPaths.get('retry-scope')).toMatchObject({ steps: ['answer-1'], busy: false });
    expect(chatTurns.inFlight('retry-scope')).toBeNull();
    // Nothing changed since launch: the follow-up continues the same run.
    const same = park('retry-scope');
    vi.mocked(adapter.listRepos).mockResolvedValueOnce([]);
    expect((await send('retry-scope')).statusCode).toBe(202);
    expect(same).toHaveBeenCalledOnce();
    expect(launched).toHaveLength(1);
  });

  it('refreshes everything when another repository is registered', async () => {
    vi.mocked(adapter.listRepos).mockResolvedValueOnce([]);
    const opened = await open({ chatId: 'dynamic-all', clis: ['claude'], scopeKind: 'everything' });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().scope.repos).toEqual([]);
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const statement = readFileSync(join(opened.json().scope.cwd as string, file), 'utf8');
      expect(statement).toContain('register it with this daemon');
      // crew#1034: a run cannot acquire a read root after launch, so the advice is a new chat.
      expect(statement).toContain('start a NEW chat');
      expect(statement).not.toContain('next message');
    }
    expect((await send('dynamic-all')).statusCode).toBe(202);
    expect(chatScopes.get('dynamic-all')?.repos.map((repo) => repo.id)).toEqual(['r1']);
    expect(chatScopes.engineOf('dynamic-all')?.readRoots).toEqual(['/srv/repos/alpha']);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.extraReadRoots).toEqual(['/srv/repos/alpha']);
  });

  it('refreshes a changed graph binding even with the same repository list', async () => {
    const binding = vi.spyOn(projectGraph, 'resolveProjectGraphBinding').mockResolvedValue({ binding: null, reason: 'not indexed yet' });
    try {
      expect((await open({ chatId: 'new-graph', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
      binding.mockResolvedValue({ binding: { dbPath: graphFile }, reason: 'project graph ready' });
      expect((await send('new-graph')).statusCode).toBe(202);
      expect(chatScopes.get('new-graph')?.graph.bound).toBe(true);
      expect(launched[0]).toMatchObject({ projectId: 'p-live' });
      expect(launched[0]).not.toHaveProperty('codeGraphDb');
      expect(chatScopes.engineOf('new-graph')?.codeGraphDb).toBe(graphFile);
    } finally {
      binding.mockRestore();
    }
  });

  it.each(['scope', 'status', 'preface'])('does not publish or overwrite a reopened chat while the old message awaits %s', async (stage) => {
    expect((await open({ chatId: 'reused', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
    expect((await send('reused')).statusCode).toBe(202);
    const propose = park('reused');
    const storedScope = chatScopes.get('reused');
    const statements = ['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'));
    const roots = vi.spyOn(transcripts, 'registerRoots');
    const refresh = vi.spyOn(chatScopes, 'refresh');
    // A changed repository set is refused (409 chat_scope_changed, crew#1034) BEFORE the preface
    // read, so the preface stage holds a message whose scope is unchanged.
    if (stage !== 'preface') projectRepoRefs.push('r1');
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    let entered = false;
    const preface = vi.spyOn(ConsiderationService.prototype, 'pendingPreface');
    if (stage === 'scope') holdReposOnce = { promise: held, release: () => release() };
    if (stage === 'status') {
      adapter.sessionsDetail = async () => {
        entered = true;
        await held;
        return [{ session: { id: 'run-p1', status: 'awaiting_human' } }] as Awaited<ReturnType<CoreAdapter['sessionsDetail']>>;
      };
    }
    if (stage === 'preface') {
      preface.mockImplementationOnce(async () => {
        entered = true;
        await held;
        return { preface: null, commit: () => undefined };
      });
    }
    const sending = send('reused').then((result) => result);
    await vi.waitFor(() => stage === 'scope' ? expect(holdReposOnce).toBeNull() : expect(entered).toBe(true));
    expect(chatScopes.get('reused')).toBe(storedScope);
    expect(['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(storedScope!.cwd, file), 'utf8'))).toEqual(statements);
    expect(refresh).not.toHaveBeenCalled();
    expect(roots).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/chats/reused' })).statusCode).toBe(200);
    const reopened = await open({ chatId: 'reused', clis: ['claude'], repoRefs: ['alpha'] });
    expect(reopened.statusCode).toBe(201);
    const newStatements = ['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(reopened.json().scope.cwd as string, file), 'utf8'));
    const rootCalls = roots.mock.calls.length;
    release();
    expect((await sending).statusCode).toBe(409);
    expect(chatScopes.get('reused')?.kind).toBe('repos');
    expect(['AGENTS.md', 'CLAUDE.md'].map((file) => readFileSync(join(reopened.json().scope.cwd as string, file), 'utf8'))).toEqual(newStatements);
    expect(refresh).not.toHaveBeenCalled();
    expect(roots.mock.calls).toHaveLength(rootCalls);
    expect(launched).toHaveLength(1);
    expect(propose).not.toHaveBeenCalled();
    preface.mockRestore();
  });

  it('never re-resolves an explicit repos chat', async () => {
    expect((await open({ chatId: 'fixed', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
    vi.mocked(adapter.listRepos).mockClear();
    registryFails = true;
    expect((await send('fixed')).statusCode).toBe(202);
    expect(adapter.listRepos).not.toHaveBeenCalled();
    expect(chatScopes.get('fixed')?.repos.map((repo) => repo.id)).toEqual(['r1']);
  });

  it('keeps the old scope if its project was deleted', async () => {
    projectRepoRefs = ['r1'];
    expect((await open({ chatId: 'deleted-project', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
    const previous = chatScopes.get('deleted-project');
    vi.mocked(adapter.projectGet).mockResolvedValue(null);
    expect((await send('deleted-project')).statusCode).toBe(202);
    expect(chatScopes.get('deleted-project')).toBe(previous);
    expect(launched).toHaveLength(1);
  });

  it('keeps the old scope and still accepts a send when the registry cannot be read', async () => {
    projectRepoRefs = ['r1'];
    expect((await open({ chatId: 'unreadable', clis: ['claude'], projectId: 'p-live' })).statusCode).toBe(201);
    expect((await send('unreadable')).statusCode).toBe(202);
    const propose = park('unreadable');
    const previous = chatScopes.get('unreadable');
    const engine = chatScopes.engineOf('unreadable');
    registryFails = true;
    expect((await send('unreadable')).statusCode).toBe(202);
    expect(chatScopes.get('unreadable')).toBe(previous);
    expect(chatScopes.engineOf('unreadable')).toEqual(engine);
    expect(propose).toHaveBeenCalledOnce();
    expect(propose.mock.calls[0]?.[0]).toBe('run-p1');
    expect(adapter.cancelRun).not.toHaveBeenCalled();
    expect(launched).toHaveLength(1);
  });
});
