// Route tests for filing ONE memory proposal from a skin (api-types 0.54.0):
//   POST /api/v1/proposals {content, project?, source?} → proposal.submit (kind_type "memory")
//
// Studio's "takes" (a person picks one of two candidate outputs) records the pick as a preference
// the person then reviews in the SAME queue — nothing is learned until it is accepted. The route can
// only file a memory: the kind, tier and `capture` marker are the daemon's, never the caller's.

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
  // The policy→steering landing seam (DES-MEM-FACETED-001 §5.2).
  steeringSupported: ReturnType<typeof vi.fn>;
  upsertConformanceRule: ReturnType<typeof vi.fn>;
};

describe('POST /proposals — file a preference memory (api-types 0.54.0)', () => {
  let app: FastifyInstance;
  let proposalTool: ReturnType<typeof vi.fn>;
  let adapter: MockAdapter;

  beforeEach(async () => {
    adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([]),
      listRepos: vi.fn().mockResolvedValue([]),
      steeringSupported: vi.fn().mockReturnValue(true),
      upsertConformanceRule: vi.fn().mockResolvedValue(undefined),
    };
    const mockAdapter: MockAdapter = adapter;
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
      { callEstateTool: proposalTool as (t: string, a: Record<string, unknown>) => Promise<unknown> },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('files a memory proposal: kind_type memory, capture preference, the project as its facet', async () => {
    proposalTool.mockResolvedValueOnce({ id: 'prop-7' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/proposals',
      payload: { content: '  Prefers takes like v3 of launch-plan  ', project: 'northwind', source: 'doc:launch-plan@v3' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'prop-7' });
    expect(proposalTool).toHaveBeenCalledTimes(1);
    expect(proposalTool).toHaveBeenCalledWith('proposal.submit', {
      kind_type: 'memory',
      payload: { content: 'Prefers takes like v3 of launch-plan', tier: 'semantic', capture: 'preference', source: 'doc:launch-plan@v3' },
      facets: { project: 'northwind' },
    });
  });

  it('files with no facets when no project is named', async () => {
    proposalTool.mockResolvedValueOnce({ id: 'prop-8' });

    const res = await app.inject({ method: 'POST', url: '/api/v1/proposals', payload: { content: 'Prefers short takes' } });

    expect(res.statusCode).toBe(201);
    expect(proposalTool).toHaveBeenCalledWith('proposal.submit', {
      kind_type: 'memory',
      payload: { content: 'Prefers short takes', tier: 'semantic', capture: 'preference' },
      facets: {},
    });
  });

  it('400s a blank or missing content, an unknown key (no caller-chosen kind), and never calls estate', async () => {
    for (const payload of [
      {},
      { content: '   ' },
      { content: 'x', kind_type: 'policy:security' },
      { content: 'x', project: '' },
      { content: 'x'.repeat(4001) },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/proposals', payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
    }
    expect(proposalTool).not.toHaveBeenCalled();
  });

  it('502s when estate answers no id, and maps estate -32602 to 400', async () => {
    proposalTool.mockResolvedValueOnce({});
    const noId = await app.inject({ method: 'POST', url: '/api/v1/proposals', payload: { content: 'x' } });
    expect(noId.statusCode).toBe(502);

    proposalTool.mockRejectedValueOnce(new EstateMcpError('facet value is empty', -32602));
    const bad = await app.inject({ method: 'POST', url: '/api/v1/proposals', payload: { content: 'x' } });
    expect(bad.statusCode).toBe(400);

    proposalTool.mockRejectedValueOnce(new Error('spawn failed'));
    const down = await app.inject({ method: 'POST', url: '/api/v1/proposals', payload: { content: 'x' } });
    expect(down.statusCode).toBe(502);
  });
});
