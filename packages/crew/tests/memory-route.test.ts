// Route tests for the memory-management surface (DES-MEM-FACETED-001):
//   GET  /api/v1/memory           → memory.list (complete browse) + query/facet/limit post-filter
//   GET  /api/v1/memory/coverage  → memory.coverage
//   POST /api/v1/memory/retire    → memory.erase {scope_prefix}  (SUBTREE-scoped)
//   POST /api/v1/memory/retire-item → memory.erase {id}  (exactly ONE memory — studio#206)
//   POST /api/v1/memory/edit      → memory.list + memory.capture + memory.erase {id} (whole or not at all)
//
// Fastify inject() with a mock adapter and a STUBBED estate-mcp client (runtime.callEstateTool) —
// no `wicked-estate-mcp` process is ever spawned. Covers: browse calls memory.list with only
// scope_prefix (query/facets/limit are CREW-side post-filters over the complete set, never
// forwarded), facets ride through to MemoryItem.facets, retire refuses an empty scope_prefix (400
// without calling the client) and forwards a valid one, and the fail-loud ladder (bad limit /
// malformed facets → 400 without the client; estate -32602 → 400; a malformed estate response or
// any other estate/transport failure → 502).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { EstateMcpError } from '../src/core/estate-mcp-client.js';
import type { CoreAdapter } from '../src/core/adapter.js';

type MockAdapter = {
  sessionsDetail: Mock;
  listRepos: Mock;
};

describe('memory-management routes (DES-MEM-FACETED-001)', () => {
  let app: FastifyInstance;
  let estateTool: Mock;

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
      { callEstateTool: estateTool as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── GET /memory (browse) ──────────────────────────────────────────────────────

  it('browses the complete set via memory.list (no query/budget), passing facets through', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 'org:acme', content: 'a fact', tier: 'semantic', facets: { cli: 'codex' }, created_at: 100 },
        { memory_id: 'm2', scope: '', content: 'root note', tier: 'episodic', facets: {}, created_at: 90 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });

    expect(res.statusCode).toBe(200);
    // `created_at` (unix seconds) rides through from memory.list verbatim — the date-filter anchor.
    expect(res.json()).toEqual({
      // crew#740: the store the list came from rides beside it.
      store: expect.objectContaining({ path: expect.any(String), source: expect.stringMatching(/^(explicit|state-home|global)$/) }),
      memories: [
        { id: 'm1', content: 'a fact', tier: 'semantic', scope: 'org:acme', facets: { cli: 'codex' }, created_at: 100 },
        { id: 'm2', content: 'root note', tier: 'episodic', scope: '', facets: {}, created_at: 90 },
      ],
    });
    // memory.list takes only scope_prefix (absent here) — no query, no token_budget, no intent.
    expect(estateTool).toHaveBeenCalledWith('memory.list', {});
  });

  it('forwards scope_prefix to memory.list but NOT query/facets/limit (those are post-filters)', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 'org:acme/agent:claude', content: 'deploy runbook', tier: 'semantic', facets: { cli: 'codex' }, created_at: 100 },
        { memory_id: 'm2', scope: 'org:acme/agent:claude', content: 'deploy checklist', tier: 'semantic', facets: { cli: 'claude' }, created_at: 90 },
        { memory_id: 'm3', scope: 'org:acme/agent:claude', content: 'unrelated', tier: 'episodic', facets: { cli: 'codex' }, created_at: 80 },
      ],
    });

    const facets = encodeURIComponent(JSON.stringify({ cli: 'codex' }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/memory?query=deploy&scope_prefix=org:acme/agent:claude&facets=${facets}&limit=500`,
    });

    expect(res.statusCode).toBe(200);
    // Only scope_prefix reaches estate; query + facets narrow the returned set, limit caps it.
    expect(estateTool).toHaveBeenCalledWith('memory.list', { scope_prefix: 'org:acme/agent:claude' });
    // m1 matches "deploy" AND cli=codex; m2 fails the facet; m3 fails the query substring.
    expect(res.json()).toEqual({
      // crew#740: the store the list came from rides beside it.
      store: expect.objectContaining({ path: expect.any(String), source: expect.stringMatching(/^(explicit|state-home|global)$/) }),
      memories: [{ id: 'm1', content: 'deploy runbook', tier: 'semantic', scope: 'org:acme/agent:claude', facets: { cli: 'codex' }, created_at: 100 }],
    });
  });

  it('applies query as a case-insensitive content substring filter (finds faceted memories)', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 's', content: 'The DEPLOY step', tier: 'semantic', facets: { cli: 'codex' }, created_at: 1 },
        { memory_id: 'm2', scope: 's', content: 'something else', tier: 'semantic', facets: {}, created_at: 2 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?query=deploy' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { memories: { id: string }[] }).memories.map((m) => m.id)).toEqual(['m1']);
  });

  it('caps the returned rows with limit (a row cap over the complete set)', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 's', content: 'a', tier: 'working', facets: {}, created_at: 1 },
        { memory_id: 'm2', scope: 's', content: 'b', tier: 'working', facets: {}, created_at: 2 },
        { memory_id: 'm3', scope: 's', content: 'c', tier: 'working', facets: {}, created_at: 3 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?limit=2' });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { memories: unknown[] }).memories).toHaveLength(2);
  });

  // ── since / until date-range filter (unix seconds, inclusive) ─────────────────

  it('filters by since (inclusive lower bound) over created_at, excluding older rows', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 's', content: 'new', tier: 'working', facets: {}, created_at: 200 },
        { memory_id: 'm2', scope: 's', content: 'boundary', tier: 'working', facets: {}, created_at: 150 },
        { memory_id: 'm3', scope: 's', content: 'old', tier: 'working', facets: {}, created_at: 100 },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?since=150' });
    expect(res.statusCode).toBe(200);
    // 150 is inclusive; 100 falls out. since/until are post-filters — estate still sees only args {}.
    expect((res.json() as { memories: { id: string }[] }).memories.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(estateTool).toHaveBeenCalledWith('memory.list', {});
  });

  it('filters by until (inclusive upper bound) and combines with since into a closed range', async () => {
    estateTool.mockResolvedValue({
      items: [
        { memory_id: 'm1', scope: 's', content: 'newest', tier: 'working', facets: {}, created_at: 300 },
        { memory_id: 'm2', scope: 's', content: 'mid', tier: 'working', facets: {}, created_at: 200 },
        { memory_id: 'm3', scope: 's', content: 'oldest', tier: 'working', facets: {}, created_at: 100 },
      ],
    });
    const upper = await app.inject({ method: 'GET', url: '/api/v1/memory?until=200' });
    expect((upper.json() as { memories: { id: string }[] }).memories.map((m) => m.id)).toEqual(['m2', 'm3']);
    const range = await app.inject({ method: 'GET', url: '/api/v1/memory?since=200&until=200' });
    expect((range.json() as { memories: { id: string }[] }).memories.map((m) => m.id)).toEqual(['m2']);
  });

  it('excludes a memory with no created_at once a date bound is set (never dated with a fabricated now)', async () => {
    estateTool.mockResolvedValueOnce({
      items: [
        { memory_id: 'm1', scope: 's', content: 'dated', tier: 'working', facets: {}, created_at: 500 },
        { memory_id: 'm2', scope: 's', content: 'undated', tier: 'working', facets: {} },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?since=1' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { memories: { id: string }[] }).memories.map((m) => m.id)).toEqual(['m1']);
  });

  it('400s a non-integer since / until and never calls the client', async () => {
    for (const url of [
      '/api/v1/memory?since=abc',
      '/api/v1/memory?since=1.5',
      '/api/v1/memory?since=-3',
      '/api/v1/memory?until=xyz',
      '/api/v1/memory?until=-1',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/since|until/);
    }
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('forwards a blank scope_prefix (root subtree = every memory) rather than dropping it', async () => {
    estateTool.mockResolvedValueOnce({ items: [] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?scope_prefix=' });

    expect(res.statusCode).toBe(200);
    expect(estateTool).toHaveBeenCalledWith('memory.list', { scope_prefix: '' });
  });

  it('omits score (memory.list is not relevance-ranked) and defaults facets to {} when absent', async () => {
    estateTool.mockResolvedValueOnce({
      items: [{ memory_id: 'm3', scope: 'p:x', content: 'no score', tier: 'working' }],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // crew#740: the store the list came from rides beside it.
      store: expect.objectContaining({ path: expect.any(String), source: expect.stringMatching(/^(explicit|state-home|global)$/) }),
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

  it('maps an estate -32602 on the list call to 400', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('invalid params: scope_prefix', -32602));

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory?scope_prefix=org:acme' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('invalid params');
  });

  it('502s a malformed list response (items missing)', async () => {
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

  it('502s a spawn ENOENT with the not-installed text and the install pointer', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('failed to spawn wicked-estate-mcp: spawn wicked-estate-mcp ENOENT'));

    const res = await app.inject({ method: 'GET', url: '/api/v1/memory/coverage' });

    expect(res.statusCode).toBe(502);
    const error = (res.json() as { error: string }).error;
    expect(error).toContain('wicked-estate is not installed');
    expect(error).toContain('npx wicked-installer');
    expect(error).toContain('WICKED_ESTATE_MCP_EXE');
    expect(error).not.toContain('spawn wicked-estate-mcp ENOENT');
  });

  it('keeps its own message for a non-spawn error that mentions ENOENT', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('wicked-estate-mcp exited before answering memory.list: ENOENT: no such file /x/memory.db'));
    const exited = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(exited.statusCode).toBe(502);
    expect((exited.json() as { error: string }).error).toContain('exited before answering');

    estateTool.mockRejectedValueOnce(new EstateMcpError('tool failed: ENOENT data file', -32603));
    const coded = await app.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(coded.statusCode).toBe(502);
    expect((coded.json() as { error: string }).error).toContain('tool failed');
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

  // ── POST /memory/retire-item (studio#206: one row, never its scope subtree) ──────

  it('retires ONE memory by id: sends only `id` to memory.erase, never a scope_prefix', async () => {
    estateTool.mockResolvedValueOnce({ deleted_count: 1 });

    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire-item', payload: { memory_id: 'm1' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ erased: 1 });
    expect(estateTool).toHaveBeenCalledTimes(1);
    expect(estateTool).toHaveBeenCalledWith('memory.erase', { id: 'm1' });
  });

  it('404s an id estate does not hold (it erased 0)', async () => {
    estateTool.mockResolvedValueOnce({ deleted_count: 0 });

    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire-item', payload: { memory_id: 'gone' } });

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain('gone');
  });

  it('refuses a scope_prefix beside the id (strict) and an empty id, never calling the client', async () => {
    for (const payload of [{ memory_id: 'm1', scope_prefix: 'org:acme' }, { memory_id: '' }, { memory_id: '   ' }, {}]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire-item', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('answers 501 estate_upgrade_required when the estate predates erase-by-id, with no fallback erase', async () => {
    estateTool.mockRejectedValueOnce(new EstateMcpError('scope_prefix (non-empty) required for erase', -32602));

    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire-item', payload: { memory_id: 'm1' } });

    expect(res.statusCode).toBe(501);
    const body = res.json() as { error: string; code: string };
    expect(body.code).toBe('estate_upgrade_required');
    expect(body.error).toContain('nothing was deleted');
    // Exactly the one id-only call: the route never retries as a subtree erase.
    expect(estateTool).toHaveBeenCalledTimes(1);
    expect(estateTool).toHaveBeenCalledWith('memory.erase', { id: 'm1' });
  });

  it('502s an erase that reports more than one deletion for one id', async () => {
    estateTool.mockResolvedValueOnce({ deleted_count: 3 });

    const res = await app.inject({ method: 'POST', url: '/api/v1/memory/retire-item', payload: { memory_id: 'm1' } });

    expect(res.statusCode).toBe(502);
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
  // ── POST /memory/edit (a new memory replaces the old one; the store decides the answer) ──

  const OLD = { memory_id: 'm1', scope: 'org:acme/doc:ops', content: 'old words', tier: 'episodic', facets: { project: 'p1' }, created_at: 100 };
  const NO_ERASE_BY_ID = (): EstateMcpError => new EstateMcpError('scope_prefix (non-empty) required for erase', -32602);

  /** A stateful estate: memory.list / capture / erase over one store, with per-call failure hooks. */
  function store(initial: Array<typeof OLD>, hooks: {
    capture?: (args: Record<string, unknown>, s: Map<string, typeof OLD>) => unknown;
    erase?: (id: string, s: Map<string, typeof OLD>) => unknown;
  } = {}): Map<string, typeof OLD> {
    const s = new Map(initial.map((m) => [m.memory_id, m]));
    let n = 0;
    estateTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'memory.list') return { items: [...s.values()] };
      if (tool === 'memory.capture') {
        if (hooks.capture !== undefined) return hooks.capture(args, s);
        const id = `m9${n++ === 0 ? '' : n}`;
        s.set(id, { ...OLD, memory_id: id, content: String(args['content']), scope: String(args['scope']) });
        return { memory_id: id };
      }
      if (tool === 'memory.erase') {
        const id = String(args['id']);
        if (hooks.erase !== undefined) return hooks.erase(id, s);
        return { deleted_count: s.delete(id) ? 1 : 0 };
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    return s;
  }
  const edit = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/memory/edit', payload });

  it('probes erase-by-id, captures the new words with the old tier, scope and facets, then erases the old', async () => {
    const s = store([OLD, { ...OLD, memory_id: 'm2', content: 'other' }]);
    const res = await edit({ memory_id: 'm1', content: '  new words ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ memory_id: 'm9', retired: 'm1' });
    expect(estateTool.mock.calls).toEqual([
      ['memory.list', {}],
      ['memory.erase', { id: 'crew:erase-by-id-probe' }],
      ['memory.capture', { content: 'new words', scope: 'org:acme/doc:ops', facets: { project: 'p1' }, tier: 'episodic', kind: 'episode' }],
      ['memory.erase', { id: 'm1' }],
    ]);
    expect([...s.keys()].sort()).toEqual(['m2', 'm9']);
  });

  it('404s an id the store does not hold, and 400s unchanged words, writing nothing', async () => {
    store([OLD]);
    expect((await edit({ memory_id: 'nope', content: 'x' })).statusCode).toBe(404);
    expect((await edit({ memory_id: 'm1', content: 'old words ' })).statusCode).toBe(400);
    expect(estateTool.mock.calls.map((c) => c[0])).toEqual(['memory.list', 'memory.list']);
  });

  it('refuses an unknown field, an empty id and empty words without calling the client', async () => {
    for (const payload of [{ memory_id: 'm1', content: 'x', scope_prefix: 'org:acme' }, { memory_id: '  ', content: 'x' }, { memory_id: 'm1', content: '   ' }, { memory_id: 'm1' }]) {
      expect((await edit(payload)).statusCode).toBe(400);
    }
    expect(estateTool).not.toHaveBeenCalled();
  });

  it('an estate without erase-by-id answers 501 before anything is written', async () => {
    const s = store([OLD], { erase: () => { throw NO_ERASE_BY_ID(); } });
    const res = await edit({ memory_id: 'm1', content: 'new words' });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ code: 'estate_upgrade_required' });
    expect(estateTool.mock.calls.map((c) => c[0])).not.toContain('memory.capture');
    expect([...s.keys()]).toEqual(['m1']);
  });

  it('an erase that throws AFTER deleting is a landed edit (the store, not the answer, decides)', async () => {
    const s = store([OLD], { erase: (id, st) => { const had = st.delete(id); if (id === 'm1') throw new EstateMcpError('xedge cleanup failed'); return { deleted_count: had ? 1 : 0 }; } });
    const res = await edit({ memory_id: 'm1', content: 'new words' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ memory_id: 'm9', retired: 'm1' });
    expect([...s.keys()]).toEqual(['m9']);
  });

  it('an erase that fails without deleting takes the new copy back out: 502, nothing changed', async () => {
    const s = store([OLD], { erase: (id, st) => { if (id === 'm1') return { deleted_count: 0 }; return { deleted_count: st.delete(id) ? 1 : 0 }; } });
    const res = await edit({ memory_id: 'm1', content: 'new words' });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/nothing changed$/);
    expect([...s.keys()]).toEqual(['m1']);
  });

  it('a take-back that answers but deletes nothing is caught by the re-read: both remain, named', async () => {
    store([OLD], { erase: (id) => (id === 'crew:erase-by-id-probe' ? { deleted_count: 0 } : {}) });
    const res = await edit({ memory_id: 'm1', content: 'new words' });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/both m1 and m9 remain/);
  });

  it('a capture whose answer is lost but which wrote is found by the re-read and the edit completes', async () => {
    const s = store([OLD], { capture: (args, st) => { st.set('m7', { ...OLD, memory_id: 'm7', content: String(args['content']) }); throw new EstateMcpError('exited before answering memory.capture'); } });
    const res = await edit({ memory_id: 'm1', content: 'new words' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ memory_id: 'm7', retired: 'm1' });
    expect([...s.keys()]).toEqual(['m7']);
  });

  it('a capture that fails and wrote nothing is a 502 that says nothing changed', async () => {
    const s = store([OLD], { capture: () => { throw new EstateMcpError('unknown tool: memory.capture', -32602); } });
    const res = await edit({ memory_id: 'm1', content: 'new words' });
    // crew built every argument itself: an estate -32602 is upstream (502), never the caller's 400.
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toMatch(/nothing changed$/);
    expect([...s.keys()]).toEqual(['m1']);
  });

  it('refuses a second edit of the same memory while one is in flight (409)', async () => {
    store([OLD]);
    const base = estateTool.getMockImplementation()!;
    let release!: () => void;
    estateTool.mockImplementationOnce(async (tool: string, args: Record<string, unknown>) => { await new Promise<void>((r) => { release = r; }); return base(tool, args); });
    const first = edit({ memory_id: 'm1', content: 'new words' });
    await vi.waitFor(() => expect(estateTool).toHaveBeenCalledTimes(1));
    expect((await edit({ memory_id: 'm1', content: 'other words' })).statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  });
});
