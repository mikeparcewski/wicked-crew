// Route tests for the memory-management surface (DES-MEM-FACETED-001):
//   GET  /api/v1/memory           → memory.recall (broad browse)
//   GET  /api/v1/memory/coverage  → memory.coverage
//   POST /api/v1/memory/retire    → memory.erase  (SUBTREE-scoped — no per-id delete in estate)
//
// Fastify inject() with a mock adapter and a STUBBED estate-mcp client (runtime.callEstateTool) —
// no `wicked-estate-mcp` process is ever spawned. Covers: the right tool + args reach the client,
// the recall/coverage responses are shaped through, retire refuses an empty scope_prefix (400
// without calling the client) and forwards a valid one, and the fail-loud ladder (bad limit /
// malformed facets → 400 without the client; estate -32602 → 400; a malformed estate response or
// any other estate/transport failure → 502).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { EstateMcpError } from '../src/core/estate-mcp-client.js';
import type { CoreAdapter } from '../src/core/adapter.js';

type MockAdapter = {
  sessionsDetail: ReturnType<typeof vi.fn>;
  listRepos: ReturnType<typeof vi.fn>;
};

describe('memory-management routes (DES-MEM-FACETED-001)', () => {
  let app: FastifyInstance;
  let estateTool: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockResolvedValue([]),
    };
    estateTool = vi.fn();
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
      undefined,
      undefined,
      undefined,
      { callEstateTool: estateTool as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── GET /memory (browse) ──────────────────────────────────────────────────────

  it('browses with a broad default: empty query + the large browse token budget, shaping items', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 'org:acme', content: 'a fact', tier: 'semantic', score: 0.9 },
        { memory_id: 'm2', scope: '', content: 'root note', tier: 'episodic', score: 0.1 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      memories: [
        { id: 'm1', content: 'a fact', tier: 'semantic', scope: 'org:acme', facets: {}, score: 0.9 },
        { id: 'm2', content: 'root note', tier: 'episodic', scope: '', facets: {}, score: 0.1 },
      ],
    });
    expect(estateTool).toHaveBeenCalledWith('memory.recall', { query: '', token_budget: 8000 });
  });

  it('forwards query, scope, scope_prefix and facets (as intent) to memory.recall', async () => {
    estateTool.mockResolvedValueOnce({ items: [] });

    const facets = encodeURIComponent(JSON.stringify({ cli: 'codex' }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/memory?query=deploy&scope=org:acme&scope_prefix=org:acme/agent:claude&facets=${facets}&limit=500`,
    });

    expect(res.statusCode).toBe(200);
    expect(estateTool).toHaveBeenCalledWith('memory.recall', {
      query: 'deploy',
      scope: 'org:acme',
      scope_prefix: 'org:acme/agent:claude',
      intent: { cli: 'codex' },
      token_budget: 500,
    });
  });

  it('forwards a blank scope_prefix (root subtree = every memory) rather than dropping it', async () => {
    estateTool.mockResolvedValueOnce({ items: [] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?scope_prefix=' });

    expect(res.statusCode).toBe(200);
    expect(estateTool).toHaveBeenCalledWith('memory.recall', {
      query: '',
      scope_prefix: '',
      token_budget: 8000,
    });
  });

  it('drops the score when estate omits it, and defaults facets to {}', async () => {
    estateTool.mockResolvedValueOnce({
      items: [{ memory_id: 'm3', scope: 'p:x', content: 'no score', tier: 'working' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      memories: [{ id: 'm3', content: 'no score', tier: 'working', scope: 'p:x', facets: {} }],
    });
  });

  it('400s a non-integer limit and never calls the client', async () => {
    for (const url of ['/api/v1/memory?limit=abc', '/api/v1/memory?limit=1.5', '/api/v1/memory?limit=0', '/api/v1/memory?limit=-3']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { error: string }).error).toContain('positive integer');
    }
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('400s malformed / present-but-blank facets and never calls the client', async () => {
    for (const url of [
      '/api/v1/memory?facets=', // present-but-blank
      `/api/v1/memory?facets=${encodeURIComponent('not json')}`,
      `/api/v1/memory?facets=${encodeURIComponent('["arr"]')}`, // JSON but not an object
      `/api/v1/memory?facets=${encodeURIComponent(JSON.stringify({ cli: 1 }))}`, // non-string value
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { error: string }).error).toContain('facets');
    }
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('maps an estate -32602 (e.g. a bad facet axis) to 400', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('invalid intent: axis must match ^[a-z]', -32602));

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/memory?facets=${encodeURIComponent(JSON.stringify({ BadAxis: 'x' }))}`,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('invalid intent');
  });

  it('502s a malformed recall response (items missing)', async () => {
    estateTool.mockResolvedValueOnce({ notItems: [] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('unexpected shape');
  });

  it('502s any other estate/transport failure on browse', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('wicked-estate-mcp exited before answering', undefined));

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('exited before answering');
  });

  // ── GET /memory/coverage ──────────────────────────────────────────────────────

  it('returns coverage counts, forwarding scope_prefix', async () => {
    estateTool.mockResolvedValueOnce({ total: 3, by_tier: { semantic: 2, episodic: 1 }, by_kind: { fact: 2, episode: 1 } });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/coverage?scope_prefix=org:acme' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ total: 3, by_tier: { semantic: 2, episodic: 1 }, by_kind: { fact: 2, episode: 1 } });
    expect(estateTool).toHaveBeenCalledWith('memory.coverage', { scope_prefix: 'org:acme' });
  });

  it('returns global coverage (args {}) when no scope_prefix is given', async () => {
    estateTool.mockResolvedValueOnce({ total: 0, by_tier: {}, by_kind: {} });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/coverage' });

    expect(res.statusCode).toBe(200);
    expect(estateTool).toHaveBeenCalledWith('memory.coverage', {});
  });

  it('502s a malformed coverage response', async () => {
    estateTool.mockResolvedValueOnce({ total: 'lots' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/coverage' });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('unexpected shape');
  });

  // ── POST /memory/retire ───────────────────────────────────────────────────────

  it('retires a subtree, forwarding scope_prefix and mapping deleted_count → { erased }', async () => {
    estateTool.mockResolvedValueOnce({ deleted_count: 7 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/retire',
      payload: { scope_prefix: 'org:acme/agent:claude' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ erased: 7 });
    expect(estateTool).toHaveBeenCalledWith('memory.erase', { scope_prefix: 'org:acme/agent:claude' });
  });

  it('400s an empty / whitespace-only scope_prefix and never calls the client', async () => {
    for (const scope_prefix of ['', '   ']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire', payload: { scope_prefix } });
      expect(res.statusCode, JSON.stringify(scope_prefix)).toBe(400);
      expect((res.json() as { error: string }).error).toContain('scope_prefix');
    }
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('400s a missing scope_prefix (strict body) and never calls the client', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('400s an unknown field (strict) and never calls the client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/retire',
      payload: { scope_prefix: 'org:acme', id: 'm1' },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('id');
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('maps an estate -32602 on erase to 400', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('scope_prefix (non-empty) required for erase', -32602));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/retire',
      payload: { scope_prefix: 'org:acme' },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('scope_prefix');
  });

  it('502s any other estate/transport failure on retire', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('wicked-estate-mcp exited before answering', undefined));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memory/retire',
      payload: { scope_prefix: 'org:acme' },
    });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('exited before answering');
  });
});
