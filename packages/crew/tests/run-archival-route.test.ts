// crew#265 — run archival routes: write-off, not delete.
//
// Fastify inject() with a mock adapter (no NAPI). Covers:
//   POST /runs/:id/archive — happy archive + unarchive, 400 bad body, 404 unknown,
//                            409 non-terminal (engine message), 500 other errors
//   POST /runs/archive     — bulk per-id outcomes (partial success named, not rolled back)
//   GET  /runs             — archived excluded by default, returned with ?include=archived

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { FastifyInstance } from 'fastify';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  archiveRun: ReturnType<typeof vi.fn>;
};

function view(id: string, archivedAt: number | null) {
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
      archived_at: archivedAt,
      archive_note: null,
    },
    units: [],
  };
}

function buildApp(mockAdapter: MockAdapter): FastifyInstance {
  const app = Fastify({ logger: false });
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
  );
  return app;
}

describe('run archival (crew#265)', () => {
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('live-1', null), view('old-1', 1786700000000)]),
      archiveRun: vi.fn().mockResolvedValue(true),
    };
    app = buildApp(mockAdapter);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('archives and unarchives with the adapter told exactly what was asked', async () => {
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/old-1/archive',
      payload: { archived: true, note: 'campaign backlog' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAdapter.archiveRun).toHaveBeenCalledWith('old-1', true, 'campaign backlog');

    res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/old-1/archive',
      payload: { archived: false },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAdapter.archiveRun).toHaveBeenLastCalledWith('old-1', false, undefined);
  });

  it('400 on a malformed body, 404 on an unknown run', async () => {
    let res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/x/archive',
      payload: { archived: 'yes' },
    });
    expect(res.statusCode).toBe(400);

    mockAdapter.archiveRun.mockResolvedValueOnce(false);
    res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/nope/archive',
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409 when the engine refuses a non-terminal run — and names the status', async () => {
    mockAdapter.archiveRun.mockRejectedValueOnce(
      new Error('run live-1 is Executing — only a terminal run can be (un)archived'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/live-1/archive',
      payload: { archived: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('Executing');
  });

  it('bulk archive reports per-id outcomes without rolling back', async () => {
    mockAdapter.archiveRun
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('run live-1 is Executing — only a terminal run can be (un)archived'))
      .mockResolvedValueOnce(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/runs/archive',
      payload: { ids: ['old-1', 'live-1', 'ghost'], note: 'sweep' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { archived: number; results: Array<{ id: string; ok: boolean; error?: string }> };
    expect(body.archived).toBe(1);
    expect(body.results).toHaveLength(3);
    expect(body.results[1]?.error).toContain('Executing');
    expect(body.results[2]?.error).toBe('not found');
  });

  it('GET /runs hides archived by default and returns them with ?include=archived', async () => {
    let res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
    let ids = (res.json() as { runs: Array<{ session: { id: string } }> }).runs.map((r) => r.session.id);
    expect(ids).toContain('live-1');
    expect(ids).not.toContain('old-1');

    res = await app.inject({ method: 'GET', url: '/api/v1/runs?include=archived' });
    ids = (res.json() as { runs: Array<{ session: { id: string } }> }).runs.map((r) => r.session.id);
    expect(ids).toContain('live-1');
    expect(ids).toContain('old-1');
  });
});
