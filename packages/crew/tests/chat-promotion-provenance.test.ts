// crew#641/#642 item 5 — chat-promotion provenance on the run DTO (`chat_seat_count`,
// `chat_grounded`), and the case the first cut got wrong: a chatId that does NOT resolve.
//
// A valid chat always has at least one warm seat (`crew-api-types` ChatOpenResponse), so `0` is not
// a value `chat_seat_count` can honestly hold. A closed or unknown chatId means "provenance
// unavailable" — both fields ABSENT — not "promoted from an ungrounded zero-seat chat". The first
// cut read `chatSeats(...).catch(() => [])` → `0` and `engineOf(...)?.codeGraphDb != null` → `false`
// and stamped both, which asserts a fact about a chat the daemon never saw.
//
// Fastify inject() with a mock adapter (no NAPI), same harness shape as `run-created-at.test.ts`.

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import { ChatScopeIndex } from '../src/api/chat-scope.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { ChatScope, SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

function view(id: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status: 'completed',
      human_confirm: 'none',
      unit_ix: 1,
      attempt: 0,
      workdir: null,
      repo_ref: null,
      extra_write_roots: [],
      archived_at: null,
      archive_note: null,
    },
    units: [],
  } as unknown as SessionView;
}

describe('crew#641 item 5 — chat-promotion provenance is absent when the chat does not resolve', () => {
  let app: FastifyInstance;
  let audit: AuditLog;
  let dir: string;
  let chatSeats: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-chat-promotion-'));
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    // An unknown/closed chat: the engine rejects the lookup. This is what a promoted run carries
    // when the chat was closed before the launch, or when the id is simply wrong.
    chatSeats = vi.fn().mockRejectedValue(new Error("chat 'ghost' is not open"));
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-b')]),
      sessions: vi.fn().mockResolvedValue(['run-b']),
      launchRun: vi.fn().mockResolvedValue('run-b'),
      projectMembers: vi.fn().mockResolvedValue([]),
      projectMemberAttach: vi.fn(),
      projectMemberDetach: vi.fn(),
      chatSeats,
    };
    app = Fastify({ logger: false });
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      if (!body) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    });
    registerRoutes(
      app,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      new QeGateCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit, authMode: 'off' },
      { runTimingIndex: new RunTimingIndex() },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    removeScratch(dir);
  });

  it('a launch naming a chat that does not resolve leaves chat_seat_count and chat_grounded ABSENT on the run DTO', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'promoted from a ghost chat', clisJson: '[]', chatId: 'ghost' },
    });
    expect(res.statusCode).toBe(201);
    expect(chatSeats).toHaveBeenCalledWith('ghost');

    const detail = await app.inject({ method: 'GET', url: '/api/v1/runs/run-b' });
    expect(detail.statusCode).toBe(200);
    const session = (detail.json() as { run: { session: Record<string, unknown> } }).run.session;
    // ABSENT, not 0/false: the daemon has nothing to say about this chat, and `0` would assert a
    // zero-seat chat that cannot exist.
    expect('chat_seat_count' in session, 'chat_seat_count must be absent, not 0').toBe(false);
    expect('chat_grounded' in session, 'chat_grounded must be absent, not false').toBe(false);
  });

  it('the run.launched trail entry carries neither field for an unresolved chat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'promoted from a ghost chat', clisJson: '[]', chatId: 'ghost' },
    });
    expect(res.statusCode).toBe(201);
    await audit.flush();

    const entries = await audit.read({ action: 'run.launched' });
    expect(entries).toHaveLength(1);
    const detail = entries[0]!.detail as Record<string, unknown> | undefined;
    // The chat link itself IS recorded (crew#619) — it is the PROVENANCE that must not be invented.
    expect(detail?.['chatId']).toBe('ghost');
    expect(detail === undefined || !('chatSeatCount' in detail), 'chatSeatCount must not be recorded as 0').toBe(true);
    expect(detail === undefined || !('chatGrounded' in detail), 'chatGrounded must not be recorded as false').toBe(true);
  });
});

// crew#655 — the path that actually CARRIES a value. Everything above asserts the ABSENT answer,
// which is a legal answer on the wire: a tree that stamps nothing satisfies all of it. These pin the
// three stamping seams — the launch-time computation (`routes.ts`, `adapter.chatSeats` ×
// `chatScopes.engineOf`), the DTO decoration on `GET /runs/:id`, and the restart path through
// `RunTimingIndex.hydrateFromLaunchEntries` — so a regression in any of them is loud.
describe('crew#655 — chat-promotion provenance on the path that carries a value', () => {
  let app: FastifyInstance;
  let audit: AuditLog;
  let dir: string;
  let chatScopes: ChatScopeIndex;
  let runTimingIndex: RunTimingIndex;

  /** A live scope for `chatId`, grounded or not — what `chatScopes.engineOf` answers from. */
  const liveScope = (chatId: string, codeGraphDb: string | null): void => {
    const token = chatScopes.reserve(chatId);
    expect(token, 'the fixture must own the reservation it fills').not.toBeNull();
    const scope = {
      kind: 'repos',
      repos: [],
      cwd: join(dir, chatId),
      graph: { bound: codeGraphDb !== null, reason: 'fixture' },
      dangling: [],
    } as unknown as ChatScope;
    expect(chatScopes.set(chatId, scope, token!, [], { cwd: scope.cwd, codeGraphDb, readRoots: [] })).toBe(true);
  };

  /** `grounded` decides the scope's `codeGraphDb` — a path (grounded) or `null` (not). */
  const arm = async (chatId: string, warmSeats: string[], grounded: boolean): Promise<void> => {
    dir = mkdtempSync(join(tmpdir(), 'crew-chat-promotion-positive-'));
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    chatScopes = new ChatScopeIndex(join(dir, 'chats'));
    runTimingIndex = new RunTimingIndex();
    liveScope(chatId, grounded ? join(dir, 'graph.db') : null);
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-p')]),
      sessions: vi.fn().mockResolvedValue(['run-p']),
      launchRun: vi.fn().mockResolvedValue('run-p'),
      projectMembers: vi.fn().mockResolvedValue([]),
      projectMemberAttach: vi.fn(),
      projectMemberDetach: vi.fn(),
      // The chat RESOLVES: the engine answers its warm roster.
      chatSeats: vi.fn().mockResolvedValue(warmSeats),
    };
    app = Fastify({ logger: false });
    app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      if (!body) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error);
      }
    });
    registerRoutes(
      app,
      mockAdapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      new QeGateCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit, authMode: 'off' },
      { runTimingIndex, chatScopes },
    );
    await app.ready();
  };

  const launch = async (chatId: string): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'promoted from a real chat', clisJson: '[]', chatId },
    });
    expect(res.statusCode).toBe(201);
  };

  const sessionOf = async (): Promise<Record<string, unknown>> => {
    const detail = await app.inject({ method: 'GET', url: '/api/v1/runs/run-p' });
    expect(detail.statusCode).toBe(200);
    return (detail.json() as { run: { session: Record<string, unknown> } }).run.session;
  };

  afterEach(async () => {
    await app?.close();
    removeScratch(dir);
  });

  it('a chat that RESOLVES stamps the pair on the run DTO — two seats, grounded', async () => {
    await arm('real', ['claude', 'opencode'], true);
    await launch('real');
    const session = await sessionOf();
    expect(session['chat_seat_count'], 'GET /runs/:id must serve the seat count it stamped').toBe(2);
    expect(session['chat_grounded']).toBe(true);
  });

  it('an UNGROUNDED chat stamps `chat_grounded: false` — a real value, not the absent one', async () => {
    // `codeGraphDb: null` is the chat that ran with no code graph. `false` and ABSENT are different
    // answers: absent says "provenance unavailable", false says "this intent was authored ungrounded".
    await arm('ungrounded', ['claude', 'opencode'], false);
    await launch('ungrounded');
    const session = await sessionOf();
    expect(session['chat_seat_count']).toBe(2);
    expect('chat_grounded' in session, 'ungrounded is a value, so the field must be PRESENT').toBe(true);
    expect(session['chat_grounded']).toBe(false);
  });

  it('the run.launched trail entry carries the same pair — the durable record, not just the live map', async () => {
    await arm('trailed', ['claude', 'opencode', 'codex'], true);
    await launch('trailed');
    await audit.flush();
    const entries = await audit.read({ action: 'run.launched' });
    expect(entries).toHaveLength(1);
    const detail = entries[0]!.detail as Record<string, unknown>;
    expect(detail['chatId']).toBe('trailed');
    expect(detail['chatSeatCount']).toBe(3);
    expect(detail['chatGrounded']).toBe(true);
  });

  it('a restarted daemon answers the pair from the trail alone (hydrateFromLaunchEntries)', async () => {
    await arm('restart', ['claude', 'opencode'], false);
    await launch('restart');
    await audit.flush();

    // The restart: a FRESH index, hydrated from the trail — no carry-over from the live map above.
    const rehydrated = new RunTimingIndex();
    expect(rehydrated.chatSeatCountFor('run-p'), 'a cold index knows nothing yet').toBeUndefined();
    rehydrated.hydrateFromLaunchEntries(await audit.read({ action: 'run.launched' }));

    expect(rehydrated.chatSeatCountFor('run-p')).toBe(2);
    expect(rehydrated.chatGroundedFor('run-p'), 'false must survive the restart as false, not absent').toBe(false);
  });

  // Declared boundary control, NOT a stamping guard: it survives every mutation below (deleting a
  // stamp only makes MORE things absent). It guards the opposite direction — the first cut's
  // `chatSeats(...).catch(() => [])` → `chat_seat_count: 0`, a fact about a chat that cannot exist.
  it('a chat that resolves to ZERO warm seats stamps nothing — 0 is not a value a real chat can hold', async () => {
    // The boundary between the two describes: the lookup SUCCEEDS but answers an empty roster. A
    // valid chat always has at least one warm seat, so this is "provenance unavailable" too.
    await arm('empty', [], true);
    await launch('empty');
    const session = await sessionOf();
    expect('chat_seat_count' in session).toBe(false);
    expect('chat_grounded' in session).toBe(false);
  });
});
