// Route tests for the memory proposal queue (DES-MEM-FACETED-001 §5.0):
//   GET  /api/v1/proposals            → proposal.list
//   POST /api/v1/proposals/:id/approve → proposal.approve
//   POST /api/v1/proposals/:id/reject  → proposal.reject
//
// Fastify inject() with a mock adapter and a STUBBED estate-mcp client (runtime.callEstateProposalTool)
// — no `wicked-estate-mcp` process is ever spawned. Covers: the right tool + args reach the client,
// the response is shaped through, the handed_off outcome passes through as-is, and the fail-loud
// ladder (bad state / whitespace id → 400 without calling the client; estate -32602 → 400; any other
// estate/transport failure → 502).

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

describe('proposal queue routes (DES-MEM-FACETED-001 §5.0)', () => {
  let app: FastifyInstance;
  let proposalTool: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mockAdapter: MockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockResolvedValue([]),
    };
    proposalTool = vi.fn();
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
      { callEstateProposalTool: proposalTool as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── GET /proposals ──────────────────────────────────────────────────────────

  it('lists proposals, forwarding kind_type + state to proposal.list', async () => {
    const proposals = [
      { id: 'p1', kind_type: 'memory', payload: { content: 'x' }, facets: {}, provenance: {}, state: 'pending', created_at: 1 },
    ];
    proposalTool.mockResolvedValueOnce({ proposals });

    const res = await app.inject({ method: 'GET', url: '/api/v1/proposals?kind_type=memory&state=pending' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ proposals });
    expect(proposalTool).toHaveBeenCalledWith('proposal.list', { kind_type: 'memory', state: 'pending' });
  });

  it('lists with no filters when the query is empty (args {})', async () => {
    proposalTool.mockResolvedValueOnce({ proposals: [] });

    const res = await app.inject({ method: 'GET', url: '/api/v1/proposals' });

    expect(res.statusCode).toBe(200);
    expect(proposalTool).toHaveBeenCalledWith('proposal.list', {});
  });

  it('400s a bad state token and never calls the client', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/proposals?state=bogus' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('pending|approved|rejected');
    expect(proposalTool).not.toHaveBeenCalled();
  });

  // ── POST /proposals/:id/approve ───────────────────────────────────────────────

  it('approves a memory proposal → promoted, forwarding the id', async () => {
    proposalTool.mockResolvedValueOnce({ outcome: 'promoted', active_id: 'm-42' });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: 'promoted', active_id: 'm-42' });
    expect(proposalTool).toHaveBeenCalledWith('proposal.approve', { id: 'p1' });
  });

  it('passes a handed_off policy outcome through as-is (steering routing out of scope)', async () => {
    const handed = { outcome: 'handed_off', payload: { rule: 'no secrets in logs' } };
    proposalTool.mockResolvedValueOnce(handed);

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/pol1/approve' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(handed);
  });

  it('400s a whitespace-only id on approve and never calls the client', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/%20/approve' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('`id` is required');
    expect(proposalTool).not.toHaveBeenCalled();
  });

  it('maps an estate -32602 invalid-params error to 400', async () => {
    proposalTool.mockRejectedValueOnce(new EstateMcpError('id (string) required', -32602));

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('id (string) required');
  });

  it('maps any other estate/transport failure to 502', async () => {
    proposalTool.mockRejectedValueOnce(new EstateMcpError('wicked-estate-mcp exited before answering', undefined));

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve' });

    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: string }).error).toContain('exited before answering');
  });

  // ── POST /proposals/:id/reject ────────────────────────────────────────────────

  it('rejects a proposal → { ok: true }, forwarding the id', async () => {
    proposalTool.mockResolvedValueOnce({ ok: true });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(proposalTool).toHaveBeenCalledWith('proposal.reject', { id: 'p1' });
  });

  it('400s a whitespace-only id on reject and never calls the client', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals/%20/reject' });

    expect(res.statusCode).toBe(400);
    expect(proposalTool).not.toHaveBeenCalled();
  });
});
