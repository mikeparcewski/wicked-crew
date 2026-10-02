// C1 (DES-STUDIO-REBUILD-001 §11): `AgentSession.chat_id` on EVERY run launched from a chat — live,
// after it ends, and after a daemon restart — plus `GET /health.capabilities.runChatId: true`.
//
// The chat link was already durable (crew#619 writes `run.launched.detail.chatId`), but it fed only
// the transcript-retention maps, and only for NON-terminal runs, so no run ever carried its chat on
// the wire. The index this reads is `RunTimingIndex`, hydrated from the ONE shared `run.launched`
// scan at boot (`hydrateFromLaunchEntries`), so the field costs no extra trail scan.
//
// Fastify inject() with a mock adapter (no NAPI), the `chat-promotion-provenance.test.ts` harness.

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { RunTimingIndex } from '../src/api/run-timing-index.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

function view(id: string, status: string): SessionView {
  return {
    session: {
      id,
      workflow_id: `wf-${id}`,
      problem: 'p',
      entity_mode: 'shared',
      collection_scope: null,
      clis: ['stub'],
      status,
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

describe('C1 — chat_id on every run, capability runChatId', () => {
  let app: FastifyInstance;
  let audit: AuditLog;
  let dir: string;
  let runTimingIndex: RunTimingIndex;
  /** The status the engine reports for the run; flipped to a terminal one mid-test. */
  let status = 'running';
  const runIds = ['run-chat', 'run-plain'];
  let nextLaunch = 0;

  const build = async (index: RunTimingIndex): Promise<void> => {
    runTimingIndex = index;
    const mockAdapter = {
      sessionsDetail: vi.fn(async () => runIds.map((id) => view(id, status))),
      sessions: vi.fn().mockResolvedValue(runIds),
      launchRun: vi.fn(async () => runIds[nextLaunch++]),
      projectMembers: vi.fn().mockResolvedValue([]),
      projectMemberAttach: vi.fn(),
      projectMemberDetach: vi.fn(),
      // The chat does not resolve: provenance stays absent, the LINK does not (crew#619/C1).
      chatSeats: vi.fn().mockRejectedValue(new Error('chat closed')),
      ping: vi.fn().mockResolvedValue('ok'),
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
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit, authMode: 'off' },
      { runTimingIndex },
    );
    await app.ready();
  };

  const sessionOf = async (id: string): Promise<Record<string, unknown>> => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}` });
    expect(res.statusCode).toBe(200);
    return (res.json() as { run: { session: Record<string, unknown> } }).run.session;
  };

  const listed = async (id: string): Promise<Record<string, unknown>> => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(res.statusCode).toBe(200);
    const runs = (res.json() as { runs: Array<{ session: Record<string, unknown> }> }).runs;
    const hit = runs.find((r) => r.session['id'] === id);
    expect(hit, `GET /runs lists ${id}`).toBeDefined();
    return hit!.session;
  };

  afterEach(async () => {
    await app?.close();
    removeScratch(dir);
    status = 'running';
    nextLaunch = 0;
  });

  it('a run launched with a chatId carries chat_id live, after it ends, and after a restart; a run without one has it ABSENT', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-run-chat-id-'));
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    await build(new RunTimingIndex());

    const a = await app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      payload: { problem: 'from a chat', clisJson: '[]', chatId: 'chat-7' },
    });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'typed', clisJson: '[]' } });
    expect(b.statusCode).toBe(201);

    // Live.
    expect((await sessionOf('run-chat'))['chat_id']).toBe('chat-7');
    expect((await listed('run-chat'))['chat_id']).toBe('chat-7');
    const plain = await sessionOf('run-plain');
    expect('chat_id' in plain, 'a run not launched from a chat has chat_id ABSENT, never null').toBe(false);

    // After it ends: the terminal run still names its chat (crew#619's maps release it; C1 does not).
    status = 'completed';
    expect((await sessionOf('run-chat'))['chat_id']).toBe('chat-7');
    expect((await listed('run-chat'))['chat_id']).toBe('chat-7');

    // After a restart: a cold index hydrated from the shared `run.launched` scan alone.
    await audit.flush();
    await app.close();
    const cold = new RunTimingIndex();
    expect(cold.chatIdFor('run-chat'), 'a cold index knows nothing yet').toBeUndefined();
    cold.hydrateFromLaunchEntries(await audit.read({ action: 'run.launched' }));
    await build(cold);
    expect((await sessionOf('run-chat'))['chat_id']).toBe('chat-7');
    expect('chat_id' in (await sessionOf('run-plain'))).toBe(false);
  });

  it('GET /health.capabilities.runChatId is true — the index is crew-side, whatever the engine', async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-run-chat-id-health-'));
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
    await build(new RunTimingIndex());
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { capabilities: Record<string, unknown> }).capabilities['runChatId']).toBe(true);
  });
});
