// DES-KNOWLEDGE-DATA-001 §10.1, §19 B4: a data shape (`knowledge` proposal) becomes knowledge only when a PERSON
// approves it. The shared proposal routes refuse an agent-kind actor, whatever its trust, on a knowledge proposal
// (approve and reject alike); memory and policy proposals keep their rules; a human passes as before.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor } from '../src/core/types.js';

const AGENT = (trust: Actor['trust']): Actor => Object.freeze({ id: 'unit-token', kind: 'agent', trust }) as Actor;

describe('reviewing a data shape is a person\'s', () => {
  let app: FastifyInstance;
  let tool: Mock;
  let actor: Actor | undefined;

  beforeEach(async () => {
    actor = undefined;
    tool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'proposal.list') {
        const all = [
          { id: 'k1', kind_type: 'knowledge', payload: { content: 'support.tickets …', relate: [] }, facets: {}, provenance: {}, state: 'pending', created_at: 1 },
          { id: 'm1', kind_type: 'memory', payload: { content: 'x' }, facets: {}, provenance: {}, state: 'pending', created_at: 1 },
        ];
        return { proposals: all.filter((p) => args['kind_type'] === undefined || p.kind_type === args['kind_type']) };
      }
      if (name === 'proposal.approve') return { outcome: 'promoted', active_id: 'kconcept synthetic proposal:k1:' };
      if (name === 'proposal.reject') return { ok: true };
      throw new Error(name);
    });
    app = Fastify({ logger: false });
    app.addHook('onRequest', async (req) => {
      if (actor !== undefined) (req as { actor?: Actor }).actor = actor;
    });
    const adapter = { sessionsDetail: vi.fn().mockResolvedValue([]), listRepos: vi.fn().mockResolvedValue([]), steeringSupported: vi.fn().mockReturnValue(true), readConformanceRule: vi.fn().mockResolvedValue(null), retireConformanceRule: vi.fn().mockResolvedValue(true) };
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, { callEstateTool: tool as (t: string, a: Record<string, unknown>) => Promise<unknown> });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  for (const trust of ['operator', 'admin'] as const) {
    it(`refuses an agent actor at ${trust} trust: approve and reject of a knowledge proposal, nothing decided`, async () => {
      actor = AGENT(trust);
      for (const verb of ['approve', 'reject']) {
        const r = await app.inject({ method: 'POST', url: `/api/v1/proposals/k1/${verb}` });
        expect(r.statusCode, r.body).toBe(403);
        expect(r.json()).toMatchObject({ code: 'knowledge_review_human_only' });
      }
      expect(tool.mock.calls.map((c) => c[0])).toEqual(['proposal.list', 'proposal.list']);
    });
  }

  it('a person approves and rejects a knowledge proposal as before; an agent\'s memory decision is not this rule\'s', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/v1/proposals/k1/approve' });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ outcome: 'promoted' });
    const r = await app.inject({ method: 'POST', url: '/api/v1/proposals/k1/reject' });
    expect(r.statusCode, r.body).toBe(200);
    actor = AGENT('operator');
    const m = await app.inject({ method: 'POST', url: '/api/v1/proposals/m1/reject' });
    expect(m.statusCode, m.body).toBe(200);
  });
});
