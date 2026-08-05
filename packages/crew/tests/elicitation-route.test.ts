// Unit tests: GET + POST /api/v1/runs/:id/elicitation (DES-002 §4 P-3).
//
// Tests use Fastify inject() with a minimal mock adapter so no real core-ts binary
// or NAPI module is required. Covers:
//   GET  — cache-hit 200, run-not-found 404, no-pending 404
//   POST — validation 400, run-not-found 404, no-pending 409, stale-id 409,
//          accept-missing-response 400, enum-mismatch 400, adapter-error 501/500,
//          happy accept, happy decline, happy cancel, restore-on-error

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { ElicitationUnsupportedError } from '../src/core/adapter.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { FastifyInstance } from 'fastify';

// ── Constants ──────────────────────────────────────────────────────────────────

const RUN = 'run-elicit-route-01';
const ELICIT_ID = 'eid-route-01';

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeEntry(opts: { options?: string[] | null; elicitationId?: string } = {}) {
  return {
    runId: RUN,
    elicitationId: opts.elicitationId ?? ELICIT_ID,
    message: 'What is your decision?',
    options: opts.options !== undefined ? opts.options : ['yes', 'no'],
    receivedAt: new Date().toISOString(),
  };
}

// ── Test harness ───────────────────────────────────────────────────────────────

type MockAdapter = {
  sessions: ReturnType<typeof vi.fn>;
  resolveElicitation: ReturnType<typeof vi.fn>;
};

function buildApp(
  mockAdapter: MockAdapter,
  elicitationCache: ElicitationCache,
): FastifyInstance {
  const app = Fastify({ logger: false });
  // Parse JSON bodies the same way server.ts does.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error);
    }
  });
  const gateCache = new GateCache();
  registerRoutes(
    app,
    mockAdapter as unknown as CoreAdapter,
    gateCache,
    elicitationCache,
  );
  return app;
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('GET /api/v1/runs/:id/elicitation', () => {
  let elicitationCache: ElicitationCache;
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    elicitationCache = new ElicitationCache();
    mockAdapter = {
      sessions: vi.fn().mockResolvedValue([RUN]),
      resolveElicitation: vi.fn().mockResolvedValue(undefined),
    };
    app = buildApp(mockAdapter, elicitationCache);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('200 with elicitation when the cache has an entry for the run', async () => {
    elicitationCache.create(makeEntry());
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/elicitation` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ runId: string; elicitationId: string; message: string; options: string[] }>();
    expect(body.runId).toBe(RUN);
    expect(body.elicitationId).toBe(ELICIT_ID);
    expect(body.message).toBe('What is your decision?');
    expect(body.options).toEqual(['yes', 'no']);
  });

  it('404 with "Run not found" when the run does not exist', async () => {
    mockAdapter.sessions.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/elicitation` });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/not found/i);
  });

  it('404 with "No pending elicitation" when run exists but cache is empty', async () => {
    // sessions() returns RUN → run exists, but no entry in cache
    const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}/elicitation` });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/no pending elicitation/i);
  });
});

describe('POST /api/v1/runs/:id/elicitation', () => {
  let elicitationCache: ElicitationCache;
  let mockAdapter: MockAdapter;
  let app: FastifyInstance;

  beforeEach(async () => {
    elicitationCache = new ElicitationCache();
    mockAdapter = {
      sessions: vi.fn().mockResolvedValue([RUN]),
      resolveElicitation: vi.fn().mockResolvedValue(undefined),
    };
    app = buildApp(mockAdapter, elicitationCache);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it('400 when the request body is missing required fields', async () => {
    elicitationCache.create(makeEntry());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { action: 'accept' }, // missing elicitationId
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when action is not one of accept|decline|cancel', async () => {
    elicitationCache.create(makeEntry());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'approve' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Run-existence check ──────────────────────────────────────────────────────

  it('404 when the run does not exist', async () => {
    mockAdapter.sessions.mockResolvedValue([]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'cancel' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toMatch(/not found/i);
  });

  // ── Cache-take checks ────────────────────────────────────────────────────────

  it('409 when there is no pending elicitation for the run', async () => {
    // Cache is empty → take() returns undefined → 409
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'cancel' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/no pending elicitation/i);
  });

  it('409 when the submitted elicitationId does not match the current one (stale tab)', async () => {
    // Cache has e-002, client submits e-001
    elicitationCache.create(makeEntry({ elicitationId: 'e-002' }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: 'e-001', action: 'cancel' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/superseded/i);
    // The entry should be restored so a subsequent GET still works
    expect(elicitationCache.get(RUN)).toBeDefined();
  });

  // ── Accept validation ────────────────────────────────────────────────────────

  it('400 when action is accept but content.response is absent', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'accept' /* no content */ },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/content\.response/i);
  });

  it('400 when action is accept and response is not in the allowed enum', async () => {
    // options: ['yes', 'no'] — submitting 'maybe' is rejected
    elicitationCache.create(makeEntry({ options: ['yes', 'no'] }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'accept', content: { response: 'maybe' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/allowed options/i);
    // Restored
    expect(elicitationCache.get(RUN)).toBeDefined();
  });

  // ── Adapter error ────────────────────────────────────────────────────────────

  it('501 when the adapter throws ElicitationUnsupportedError', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    mockAdapter.resolveElicitation.mockRejectedValue(
      new ElicitationUnsupportedError('not bound'),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'decline' },
    });
    expect(res.statusCode).toBe(501);
    // Entry is restored so the UI can retry once the binding lands
    expect(elicitationCache.get(RUN)).toBeDefined();
  });

  it('500 when the adapter throws a generic error', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    mockAdapter.resolveElicitation.mockRejectedValue(new Error('actor crashed'));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'decline' },
    });
    expect(res.statusCode).toBe(500);
    expect(elicitationCache.get(RUN)).toBeDefined();
  });

  // ── Happy paths ──────────────────────────────────────────────────────────────

  it('200 {status:resolved} for an accept with a valid enum response', async () => {
    elicitationCache.create(makeEntry({ options: ['yes', 'no'] }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'accept', content: { response: 'yes' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('resolved');
    expect(mockAdapter.resolveElicitation).toHaveBeenCalledWith(RUN, ELICIT_ID, 'accept', 'yes');
    // Entry consumed — cache is empty
    expect(elicitationCache.get(RUN)).toBeUndefined();
  });

  it('200 {status:resolved} for an accept on a free-text schema', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'accept', content: { response: 'my answer' } },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAdapter.resolveElicitation).toHaveBeenCalledWith(RUN, ELICIT_ID, 'accept', 'my answer');
  });

  it('200 {status:resolved} for a decline (no content, response=null forwarded)', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'decline' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAdapter.resolveElicitation).toHaveBeenCalledWith(RUN, ELICIT_ID, 'decline', null);
  });

  it('200 {status:resolved} for a cancel', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'cancel' },
    });
    expect(res.statusCode).toBe(200);
    expect(mockAdapter.resolveElicitation).toHaveBeenCalledWith(RUN, ELICIT_ID, 'cancel', null);
  });

  // ── F5 regression: content on non-accept actions ─────────────────────────────

  it('400 when action is decline but content is provided (F5)', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'decline', content: { response: 'ignored' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when action is cancel but content is provided (F5)', async () => {
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'cancel', content: { response: 'ignored' } },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── F1 regression: empty accept response ────────────────────────────────────

  it('400 when action is accept and content.response is an empty string (F1)', async () => {
    // An empty response is not a valid accept — the Zod schema requires min(1).
    elicitationCache.create(makeEntry({ options: null }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN}/elicitation`,
      payload: { elicitationId: ELICIT_ID, action: 'accept', content: { response: '' } },
    });
    expect(res.statusCode).toBe(400);
    // Entry is restored so the UI can retry
    expect(elicitationCache.get(RUN)).toBeDefined();
  });

  // ── F2 regression: elicitationCache.reconcile called from GET /runs ─────────

  it('GET /runs prunes elicitation entries for terminal-status runs (F2)', async () => {
    // Seed a completed run's elicitation into the cache.
    elicitationCache.create(makeEntry());
    expect(elicitationCache.get(RUN)).toBeDefined();

    // sessionsDetail returns the run as completed.
    mockAdapter.sessions = vi.fn();  // GET /runs uses sessionsDetail, not sessions
    const sessionsDetailMock = vi.fn().mockResolvedValue([
      { session: { id: RUN, status: 'completed' }, units: [] },
    ]);
    const adapterWithDetail = {
      ...mockAdapter,
      sessionsDetail: sessionsDetailMock,
    };
    const cacheForReconcile = elicitationCache;
    const testApp = buildApp(adapterWithDetail as unknown as typeof mockAdapter, cacheForReconcile);
    await testApp.ready();

    await testApp.inject({ method: 'GET', url: '/api/v1/runs' });
    expect(cacheForReconcile.get(RUN)).toBeUndefined();

    await testApp.close();
  });
});
