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
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
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
