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
import type { CoreAdapter } from '../src/core/adapter.js';

let base: string;
let graphFile: string;
let app: FastifyInstance;
let chatScopes: ChatScopeIndex;
let applied: boolean | null;
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
    chatOpen,
    chatScopeApplied: async () => applied,
    chatSeats: async () => ['claude'],
    chatClose: async () => undefined,
  } as unknown as CoreAdapter;
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'chat-routes-scope-'));
  graphFile = join(base, 'alpha-graph.db');
  writeFileSync(graphFile, '');
  applied = true;
  chatOpen.mockClear();
  chatScopes = new ChatScopeIndex(join(base, 'chats'));
  app = Fastify({ logger: false });
  registerRoutes(app, fakeAdapter(), new GateCache(), new ElicitationCache(), undefined, undefined, undefined, {
    chatScopes,
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
    expect(agents).toMatch(/wicked-estate MCP/);
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

  it('a scoped open the engine did not confirm is REFUSED (501) and torn down — never opened unbounded; an unscoped one proceeds', async () => {
    applied = false;
    const res = await open({ chatId: 'old-engine', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: string }).error).toMatch(/predates chat scope/);
    expect(existsSync(join(base, 'chats', 'old-engine'))).toBe(false);
    // The engine chat was closed again, so its `chatClosed` is still on its way: the id is parked
    // as closing (no scope, no reuse) until that event frees it.
    expect(chatScopes.get('old-engine')).toBeUndefined();
    expect(chatScopes.stateOf('old-engine')).toBe('closing');
    chatScopes.closed('old-engine');
    expect(chatScopes.has('old-engine')).toBe(false);
    // `null` — nothing confirmed — is refused too, with its own reason.
    applied = null;
    const res2 = await open({ chatId: 'unconfirmed', clis: ['claude'], repoRefs: ['alpha'] });
    expect(res2.statusCode).toBe(501);
    expect((res2.json() as { error: string }).error).toMatch(/did not confirm/);
    // An UNSCOPED chat promises nothing beyond its scratch root and opens regardless.
    const plain = await open({ chatId: 'plain', clis: ['claude'] });
    expect(plain.statusCode).toBe(201);
    expect((plain.json() as { scope: { kind: string } }).scope.kind).toBe('none');
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
    expect(chatScopes.has('racy')).toBe(false);
    expect(existsSync(join(base, 'chats', 'racy'))).toBe(false);
  });
});
