// `POST /chats` scope lifecycle (crew#502) over a FAKE adapter — the stub engine cannot open chats,
// so the happy path, the live-id refusal, the detail/delete lifecycle and the grounding downgrade
// are pinned here with `app.inject` and a scratch base under mkdtemp (never the real
// `<tmp>/wicked-crew-chats`).

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
/** chatId → the seats that actually warmed, filled by the adapter's `chatOpen` wrapper. */
let warmByChat: Map<string, string[]>;
/** Records exactly what the route hands the engine: `(chatId, clis, cwd, scope)`. */
const chatOpen = vi.fn(async (...args: [string, string[], string?, unknown?]) =>
  args[1].map((c) => ({ cliKey: c, ok: true })),
);

/** The adapter surface `POST /chats` / `GET /chats/:id` / `DELETE /chats/:id` actually touch. */
function fakeAdapter(): CoreAdapter {
  return {
    listRepos: async () => [
      {
        id: 'r1',
        name: 'alpha',
        root_path: '/srv/repos/alpha',
        default_branch: 'main',
        registered_at: 1,
        code_graph_db: graphFile,
      },
    ],
    // Wraps the `chatOpen` spy (so every `mockImplementationOnce` in a test still applies) and
    // records which seats actually WARMED for that chat. Without this the roster was the constant
    // `['claude']`, which made the fixture structurally incapable of expressing a two-warm-seat
    // chat — the case `singleSeat` must NOT fire on (review of #651, defect 2).
    chatOpen: async (...args: [string, string[], string?, unknown?]) => {
      const out = await chatOpen(...args);
      warmByChat.set(args[0], out.filter((s) => s.ok).map((s) => s.cliKey));
      return out;
    },
    chatScopeApplied: async () => applied,
    // The WARM ROSTER of that chat — what `singleSeat` must be decided from.
    chatSeats: async (chatId: string) => warmByChat.get(chatId) ?? [],
    // The seats a turn REACHES: the named targets narrowed to what is warm, else everyone warm.
    // A targeted send returning one seat is not a one-seat chat, and this fixture can now say so.
    chatSend: async (chatId: string, _text: string, targets?: string[]) => {
      const warm = warmByChat.get(chatId) ?? [];
      return targets === undefined ? warm : targets.filter((t) => warm.includes(t));
    },
    chatClose: async () => undefined,
  } as unknown as CoreAdapter;
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'chat-routes-scope-'));
  graphFile = join(base, 'alpha-graph.db');
  writeFileSync(graphFile, '');
  applied = true;
  chatOpen.mockClear();
  signedIn = () => null;
  entityCount = async () => 1; // default: indexed; override per-test for crew#642 zero-entity path
  broadcast = [];
  warmByChat = new Map();
  chatScopes = new ChatScopeIndex(join(base, 'chats'));
  app = Fastify({ logger: false });
  registerRoutes(app, fakeAdapter(), new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {
    chatScopes,
    // Never the real dotfile probe: the suite must not read the developer's worker home.
    signedIn: (seatKey) => signedIn(seatKey),
    broadcast: (frame) => broadcast.push(frame),
    // crew#642: never shell wicked-estate against mkdtemp fixtures.
    entityCount: (dbPath) => entityCount(dbPath),
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
    // What the engine was handed.
    expect(chatOpen).toHaveBeenCalledTimes(1);
    expect(chatOpen.mock.calls[0]).toEqual([
      'live',
      ['claude'],
      body.scope.cwd,
      { codeGraphDb: graphFile, readRoots: ['/srv/repos/alpha'] },
    ]);
    expect(chatScopes.get('live')?.cwd).toBe(body.scope.cwd);
  });

  it('refuses to re-open a chat id this daemon already holds (409) BEFORE touching its root or the engine', async () => {
    expect((await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
    const stamp = readFileSync(join(base, 'chats', 'live', 'AGENTS.md'), 'utf8');
    const again = await open({ chatId: 'live', clis: ['claude'] });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toMatch(/already open/);
    expect(chatOpen).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(base, 'chats', 'live', 'AGENTS.md'), 'utf8')).toBe(stamp);
  });

  it('GET /chats/:id carries the recorded scope; DELETE removes the scratch root at once and parks the id until the engine closes it', async () => {
    await open({ chatId: 'live', clis: ['claude'], repoRefs: ['alpha'] });
    const detail = await app.inject({ method: 'GET', url: '/api/v1/chats/live' });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { scope: { kind: string } | null }).scope?.kind).toBe('repos');
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/chats/live' });
    expect(del.statusCode).toBe(200);
    expect(existsSync(join(base, 'chats', 'live'))).toBe(false);
    expect(chatScopes.get('live')).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/live' })).json()).toMatchObject({ scope: null });
    // Until the engine's own `chatClosed` is observed the id is CLOSING: a reuse is refused, so a
    // close delivered late can never land on a newer chat's root.
    const tooSoon = await open({ chatId: 'live', clis: ['claude'] });
    expect(tooSoon.statusCode).toBe(409);
    expect((tooSoon.json() as { error: string }).error).toMatch(/closing/);
    chatScopes.closed('live'); // the relay delivers the engine's chatClosed
    expect((await open({ chatId: 'live', clis: ['claude'] })).statusCode).toBe(201);
  });

  it('a scoped open on an engine that PREDATES scope (row without the fields) is REFUSED (501) with the seats and torn down; an unscoped one proceeds', async () => {
    applied = false;
    const res = await open({ chatId: 'old-engine', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(501);
    const body = res.json() as { error: string; seats: unknown[] };
    expect(body.error).toMatch(/predates chat scope/);
    expect(body.seats).toEqual([{ cliKey: 'claude', ok: true }]);
    expect(existsSync(join(base, 'chats', 'old-engine'))).toBe(false);
    // The engine chat was closed again, so its `chatClosed` is still on its way: the id is parked
    // as closing (no scope, no reuse) until that event frees it.
    expect(chatScopes.get('old-engine')).toBeUndefined();
    expect(chatScopes.stateOf('old-engine')).toBe('closing');
    chatScopes.closed('old-engine');
    expect(chatScopes.has('old-engine')).toBe(false);
    // `null` with a seat reporting warm — NO row at all — is "nothing warmed", not an engine
    // version guess (independent review, W1): 409 with the seats, torn down.
    applied = null;
    const res2 = await open({ chatId: 'unconfirmed', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res2.statusCode).toBe(409);
    const body2 = res2.json() as { error: string; seats: unknown[] };
    expect(body2.error).toMatch(/nothing warmed/);
    expect(body2.seats).toHaveLength(1);
    expect(existsSync(join(base, 'chats', 'unconfirmed'))).toBe(false);
    // An UNSCOPED chat promises nothing beyond its scratch root and opens regardless.
    const plain = await open({ chatId: 'plain', clis: ['claude'] });
    expect(plain.statusCode).toBe(201);
    expect((plain.json() as { scope: { kind: string } }).scope.kind).toBe('none');
  });

  it('a scoped open where EVERY seat fails reports the per-seat reasons (409 + seats) before any engine probe, tears down, and frees the id (W1)', async () => {
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) =>
      args[1].map((c) => ({ cliKey: c, ok: false, error: `seat '${c}' cannot join a SCOPED chat: its ACP adapter asks no permissions` })),
    );
    applied = null; // what the adapter returns when the engine holds no row — must NOT read as a version problem
    const res = await open({ chatId: 'pi-only', clis: ['pi', 'codex'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; seats: { cliKey: string; ok: boolean; error?: string }[] };
    expect(body.error).toMatch(/no seat warmed \(2 failed\)/);
    expect(body.seats.map((s) => s.cliKey)).toEqual(['pi', 'codex']);
    expect(body.seats[0]!.error).toMatch(/cannot join a SCOPED chat/);
    expect(body.error).not.toMatch(/upgrade the engine/);
    expect(existsSync(join(base, 'chats', 'pi-only'))).toBe(false);
    expect(chatScopes.has('pi-only')).toBe(false);
    // The id is free again immediately (the engine dropped the scope itself; no chatClosed will come).
    applied = true;
    expect((await open({ chatId: 'pi-only', clis: ['claude'], repoRefs: ['alpha'] })).statusCode).toBe(201);
  });

  it('the DEFAULT seats of a SCOPED open are pre-filtered to admissible adapters; an unscoped open keeps the whole roster (W5)', async () => {
    const spy = vi.spyOn(CoreAdapter, 'roster').mockReturnValue([
      { key: 'claude', acp: { acp_input_governance: true, os_sandbox: false } },
      { key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } },
      { key: 'codex', acp: { acp_input_governance: false, os_sandbox: true } },
      { key: 'agy' },
    ]);
    try {
      const scopedRes = await open({ chatId: 'dflt-scoped', repoRefs: ['alpha'] });
      expect(scopedRes.statusCode).toBe(201);
      expect(chatOpen.mock.calls.at(-1)![1]).toEqual(['claude', 'codex']);
      // F-2R2-007: the two dropped seats are NAMED with their reasons — on the response…
      const scopedBody = scopedRes.json() as { refused: { cliKey: string; reason: string }[] };
      expect(scopedBody.refused.map((r) => r.cliKey)).toEqual(['pi', 'agy']);
      expect(scopedBody.refused[0]!.reason).toMatch(/asks no permissions/);
      expect(scopedBody.refused[1]!.reason).toMatch(/no ACP adapter/);
      // …and in the thread, one frame per refused seat, AFTER the scope is published.
      expect(broadcast).toEqual([
        { type: 'chatSeatRefused', chat: 'dflt-scoped', cliKey: 'pi', reason: scopedBody.refused[0]!.reason, source: 'scope' },
        { type: 'chatSeatRefused', chat: 'dflt-scoped', cliKey: 'agy', reason: scopedBody.refused[1]!.reason, source: 'scope' },
      ]);
      broadcast = [];
      // F-W1-003 = A: an UNSCOPED open no longer keeps the whole roster — the wrapped seat `agy`
      // (no ACP adapter) is refused in this mode too, named with the ACP-seat reason.
      const plain = await open({ chatId: 'dflt-plain' });
      expect(plain.statusCode).toBe(201);
      expect(chatOpen.mock.calls.at(-1)![1]).toEqual(['claude', 'pi', 'codex']);
      const plainBody = plain.json() as { refused: { cliKey: string; reason: string }[] };
      expect(plainBody.refused.map((r) => r.cliKey)).toEqual(['agy']);
      expect(plainBody.refused[0]!.reason).toMatch(/no ACP adapter/);
      expect(broadcast).toEqual([
        { type: 'chatSeatRefused', chat: 'dflt-plain', cliKey: 'agy', reason: plainBody.refused[0]!.reason, source: 'scope' },
      ]);
      // A roster with no admissible seat cannot open a scoped chat by default — said plainly, with the list.
      spy.mockReturnValue([{ key: 'pi', acp: { acp_input_governance: false, os_sandbox: false } }]);
      const none = await open({ chatId: 'dflt-none', repoRefs: ['alpha'] });
      expect(none.statusCode).toBe(409);
      expect((none.json() as { error: string }).error).toMatch(/no seat in the roster can be held/);
      expect((none.json() as { refused: { cliKey: string }[] }).refused.map((r) => r.cliKey)).toEqual(['pi']);
      expect(existsSync(join(base, 'chats', 'dflt-none'))).toBe(false);
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
      expect(chatOpen.mock.calls.at(-1)![1]).toEqual(['claude', 'opencode']);
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

  it('a REQUESTED seat the engine refuses joins `refused` with the engine\'s reason, and reaches the thread', async () => {
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) =>
      args[1].map((c) => (c === 'pi' ? { cliKey: c, ok: false, error: "seat 'pi' cannot join a SCOPED chat: its ACP adapter asks no permissions" } : { cliKey: c, ok: true })),
    );
    const res = await open({ chatId: 'req', clis: ['claude', 'pi'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { seats: { cliKey: string; ok: boolean }[]; refused: { cliKey: string; reason: string }[] };
    expect(body.seats.map((s) => [s.cliKey, s.ok])).toEqual([['claude', true], ['pi', false]]);
    expect(body.refused).toEqual([{ cliKey: 'pi', reason: "seat 'pi' cannot join a SCOPED chat: its ACP adapter asks no permissions", source: 'engine' }]);
    expect(broadcast).toEqual([{ type: 'chatSeatRefused', chat: 'req', cliKey: 'pi', reason: body.refused[0]!.reason, source: 'engine' }]);
  });

  it('a chatClosed that lands while an open is in flight cancels it: nothing is recorded and the chat is torn down', async () => {
    // The fake engine "closes" the chat between chatOpen and the route's publish step.
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) => {
      chatScopes.closed(args[0]);
      return args[1].map((c) => ({ cliKey: c, ok: true }));
    });
    const res = await open({ chatId: 'racy', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/closed while it was being opened/);
    // Nothing recorded — but the id is PARKED (closing), not freed (hardening): the route's own
    // teardown `chatClose` has a `chatClosed` still to come, and a reuse of the id in between must
    // not lose its chat to it. That event (or the grace) frees the id.
    expect(chatScopes.get('racy')).toBeUndefined();
    expect(chatScopes.stateOf('racy')).toBe('closing');
    expect(existsSync(join(base, 'chats', 'racy'))).toBe(false);
    chatScopes.closed('racy'); // the teardown's chatClosed lands
    expect(chatScopes.has('racy')).toBe(false);
  });
});

describe('POST /chats/:id/seats — re-seat named seats on a LIVE chat (F-W1-005, the retry lever)', () => {
  it('re-runs chatOpen with the IDENTICAL engine scope; a warmed seat leaves `refused`; the engine\'s refusal folds in and reaches the thread', async () => {
    // Open with an explicit list where the engine refuses pi (the 201 records it as refused: engine).
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) =>
      args[1].map((c) => (c === 'pi' ? { cliKey: c, ok: false, error: "seat 'pi' cannot join a SCOPED chat: its ACP adapter asks no permissions" } : { cliKey: c, ok: true })),
    );
    const opened = await open({ chatId: 'reseat', repoRefs: ['r1'], clis: ['claude', 'pi'] });
    expect(opened.statusCode).toBe(201);
    const openCall = chatOpen.mock.calls[0]!;
    expect((opened.json() as { refused: { cliKey: string }[] }).refused.map((r) => r.cliKey)).toEqual(['pi']);
    broadcast.length = 0;

    // Retry pi: the engine now seats it (say the operator set os_sandbox and re-registered).
    const retry = await app.inject({ method: 'POST', url: '/api/v1/chats/reseat/seats', payload: { clis: ['pi'] } });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ chatId: 'reseat', seats: [{ cliKey: 'pi', ok: true }], refused: [] });
    // The SAME cwd + graph + read roots the open handed the engine — never a re-resolved scope
    // (a different scope would evict every warm seat).
    const retryCall = chatOpen.mock.calls[1]!;
    expect(retryCall[0]).toBe('reseat');
    expect(retryCall[1]).toEqual(['pi']);
    expect(retryCall[2]).toBe(openCall[2]);
    expect(retryCall[3]).toEqual(openCall[3]);
    expect(broadcast, 'a seated retry broadcasts no refusal').toEqual([]);
    // The detail no longer names pi as refused.
    expect((await app.inject({ method: 'GET', url: '/api/v1/chats/reseat' })).json()).toMatchObject({ refused: [] });

    // Retry a seat the engine STILL refuses: the refusal replaces its entry and reaches /ws.
    chatOpen.mockImplementationOnce(async () => [{ cliKey: 'codex', ok: false, error: "no ACP config for 'codex'" }]);
    const again = await app.inject({ method: 'POST', url: '/api/v1/chats/reseat/seats', payload: { clis: ['codex'] } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({
      chatId: 'reseat',
      seats: [{ cliKey: 'codex', ok: false, error: "no ACP config for 'codex'" }],
      refused: [{ cliKey: 'codex', reason: "no ACP config for 'codex'", source: 'engine' }],
    });
    expect(broadcast).toEqual([{ type: 'chatSeatRefused', chat: 'reseat', cliKey: 'codex', reason: "no ACP config for 'codex'", source: 'engine' }]);
  });

  it('an unknown or closed chat is 404 (never a fresh chat); a bad body is 400; no engine call either way', async () => {
    const before = chatOpen.mock.calls.length;
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/nope/seats', payload: { clis: ['claude'] } })).statusCode).toBe(404);
    await open({ chatId: 'gone', repoRefs: ['r1'] });
    await app.inject({ method: 'DELETE', url: '/api/v1/chats/gone' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/gone/seats', payload: { clis: ['claude'] } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/nope/seats', payload: { clis: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/v1/chats/nope/seats', payload: {} })).statusCode).toBe(400);
    // Only the DELETE-d chat's own open reached the engine.
    expect(chatOpen.mock.calls.length - before).toBe(1);
  });
});

describe('crew#641 — single-seat degradation disclosed on open and every turn', () => {
  it('201 carries singleSeat when exactly one seat warmed and at least one was refused — FAILS on main (field absent)', async () => {
    // claude warms; pi is refused by the engine.
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) =>
      args[1].map((c) => (c === 'pi' ? { cliKey: c, ok: false, error: "seat 'pi' cannot join a SCOPED chat: its ACP adapter asks no permissions" } : { cliKey: c, ok: true })),
    );
    const res = await open({ chatId: 'single', clis: ['claude', 'pi'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      seats: { cliKey: string; ok: boolean }[];
      refused: { cliKey: string }[];
      singleSeat?: { degraded: boolean; warmed: string; refused: { cliKey: string }[]; message: string };
    };
    expect(body.singleSeat).toBeDefined();
    expect(body.singleSeat!.degraded).toBe(true);
    expect(body.singleSeat!.warmed).toBe('claude');
    expect(body.singleSeat!.refused.map((r) => r.cliKey)).toContain('pi');
    expect(body.singleSeat!.message).toMatch(/one seat/);
    expect(body.singleSeat!.message).toMatch(/wicked-core#563/);
    // No disclosure of refused seats if not present in PI's reason.
    expect(body.singleSeat!.message).toMatch(/pi/);
  });

  // The boundary the first cut of this feature could not express: TWO warm seats WITH a refusal.
  // `refused.length > 0` is satisfied, so only the seat count can keep the disclosure quiet — and on
  // the 202 the count was read from the seats the TURN REACHED, which a targeted send makes 1.
  const openTwoWarmOneRefused = async (chatId: string) => {
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) =>
      args[1].map((c) => (c === 'pi' ? { cliKey: c, ok: false, error: "seat 'pi' refused" } : { cliKey: c, ok: true })),
    );
    const res = await open({ chatId, clis: ['claude', 'opencode', 'pi'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { seats: { cliKey: string; ok: boolean }[]; refused: unknown[]; singleSeat?: unknown };
    expect(body.seats.filter((s) => s.ok).map((s) => s.cliKey)).toEqual(['claude', 'opencode']);
    expect(body.refused.length).toBe(1);
    expect(body.singleSeat, 'two warm seats are not a degraded chat').toBeUndefined();
    return body;
  };

  it('202 carries NO singleSeat on a BROADCAST to a two-warm-seat chat that had a refusal', async () => {
    await openTwoWarmOneRefused('two-warm-broadcast');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/two-warm-broadcast/messages',
      payload: { text: 'hello both' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { seats: string[]; singleSeat?: unknown };
    expect(body.seats).toEqual(['claude', 'opencode']);
    expect(body.singleSeat).toBeUndefined();
  });

  it('202 carries NO singleSeat on a TARGETED send to ONE seat of a two-warm-seat chat — the turn reached one seat, the chat still has two', async () => {
    await openTwoWarmOneRefused('two-warm-targeted');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/two-warm-targeted/messages',
      payload: { text: 'just you, claude', targets: ['claude'] },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { seats: string[]; singleSeat?: { message: string } };
    // The turn reached exactly one seat…
    expect(body.seats).toEqual(['claude']);
    // …and that is NOT a degraded chat: opencode is still warm and can still disagree.
    expect(body.singleSeat, 'a targeted send must not fabricate a single-seat degradation').toBeUndefined();
  });

  it('201 carries NO singleSeat when two or more seats are warm', async () => {
    // Both claude and opencode warm; no refused.
    const res = await open({ chatId: 'two', clis: ['claude', 'opencode'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { singleSeat?: unknown };
    expect(body.singleSeat).toBeUndefined();
  });

  it('202 carries singleSeat when the chat has one warm seat and refused seats are on record — FAILS on main (field absent)', async () => {
    // Set up a single-seat chat (claude warm, pi refused by engine).
    chatOpen.mockImplementationOnce(async (...args: [string, string[], string?, unknown?]) =>
      args[1].map((c) => (c === 'pi' ? { cliKey: c, ok: false, error: "seat 'pi' refused" } : { cliKey: c, ok: true })),
    );
    await open({ chatId: 'msg-single', clis: ['claude', 'pi'], repoRefs: ['alpha'] });
    // fakeAdapter.chatSend returns ['claude'] (one warm seat).
    const msgRes = await app.inject({
      method: 'POST',
      url: '/api/v1/chats/msg-single/messages',
      payload: { text: 'hello' },
    });
    expect(msgRes.statusCode).toBe(202);
    const body = msgRes.json() as { seats: string[]; singleSeat?: { degraded: boolean; warmed: string } };
    expect(body.seats).toEqual(['claude']);
    expect(body.singleSeat).toBeDefined();
    expect(body.singleSeat!.degraded).toBe(true);
    expect(body.singleSeat!.warmed).toBe('claude');
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
