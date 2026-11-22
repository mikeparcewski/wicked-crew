// crew#1261: a rejected proposal says who rejected it and why. estate keeps only `state: rejected`; crew records the
// decisions it makes (a person's rejection; an accept-with-edit's replaced original and withdrawn copy) on its audit
// trail and returns them on `GET /proposals` as `decision`. A rejection crew did not make carries none.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { PROPOSAL_DECIDED, decisionOf, recordProposalDecision } from '../src/api/proposal-decisions.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Actor } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const dirs: string[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
});

interface Row { id: string; kind_type: string; payload: Record<string, unknown>; facets: Record<string, string>; provenance: Record<string, string>; state: string; created_at: number }

/** estate's proposal queue, in memory. `approveFails`: ids whose approve estate refuses. */
function estate(rows: Row[], approveFails = new Set<string>()) {
  let n = 0;
  return vi.fn(async (tool: string, args: Record<string, unknown>) => {
    const row = (): Row => {
      const r = rows.find((x) => x.id === args['id']);
      if (r === undefined) throw new Error(`no proposal ${String(args['id'])}`);
      return r;
    };
    switch (tool) {
      case 'proposal.list':
        return { proposals: rows.filter((r) => (args['state'] === undefined || r.state === args['state']) && (args['kind_type'] === undefined || r.kind_type === args['kind_type'])).map((r) => ({ ...r })) };
      case 'proposal.reject': row().state = 'rejected'; return { ok: true };
      case 'proposal.approve':
        if (approveFails.has(String(args['id']))) throw new Error('estate refused the approve');
        row().state = 'approved';
        return { outcome: 'promoted', active_id: `m-${String(args['id'])}` };
      case 'proposal.submit': {
        const id = `copy-${++n}`;
        rows.push({ id, kind_type: String(args['kind_type']), payload: args['payload'] as Record<string, unknown>, facets: args['facets'] as Record<string, string>, provenance: {}, state: 'pending', created_at: 2 });
        return { id };
      }
      case 'memory.list': return { memories: [] };
      default: throw new Error(`unexpected tool ${tool}`);
    }
  });
}

const memory = (id: string, state = 'pending'): Row => ({ id, kind_type: 'memory', payload: { content: `memory ${id}`, capture: 'memory' }, facets: {}, provenance: {}, state, created_at: 1 });

async function server(o: { rows: Row[]; audit?: AuditLog; actor?: Actor; approveFails?: Set<string> }) {
  let audit = o.audit;
  if (audit === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'proposal-decisions-'));
    dirs.push(dir);
    audit = new AuditLog(join(dir, 'audit.log'), () => undefined);
  }
  const tool = estate(o.rows, o.approveFails);
  const adapter = {
    sessionsDetail: vi.fn().mockResolvedValue([]),
    listRepos: vi.fn().mockResolvedValue([]),
    readConformanceRule: vi.fn().mockResolvedValue(null),
    retireConformanceRule: vi.fn().mockResolvedValue(true),
  };
  const app = Fastify({ logger: false });
  apps.push(app);
  const actor: Actor = o.actor ?? { id: 'local', kind: 'human', trust: 'admin' };
  app.addHook('onRequest', async (req) => { (req as { actor?: Actor }).actor = actor; });
  registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' },
    { callEstateTool: tool as (t: string, a: Record<string, unknown>) => Promise<unknown> });
  await app.ready();
  const rejected = async (): Promise<Array<Record<string, unknown>>> =>
    ((await app.inject({ method: 'GET', url: '/api/v1/proposals?state=rejected' })).json() as { proposals: Array<Record<string, unknown>> }).proposals;
  return { app, audit, rejected };
}

describe('crew#1261: who rejected a proposal, and why', () => {
  it('a person’s rejection says operator/rejected with when; a row crew made no decision on says nothing', async () => {
    const s = await server({ rows: [memory('p1'), memory('p2', 'rejected'), memory('p3'), memory('p4', 'approved')] });
    // Decisions on record for rows that are not rejected (a stale line) are never attached to them.
    recordProposalDecision(s.audit, { id: 'local', kind: 'human', trust: 'admin' }, 'p3', 'rejected');
    recordProposalDecision(s.audit, { id: 'local', kind: 'human', trust: 'admin' }, 'p4', 'rejected');
    expect((await s.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' })).statusCode).toBe(200);
    const rows = await s.rejected();
    const p1 = rows.find((r) => r['id'] === 'p1')!;
    expect(p1['decision']).toEqual({ by: 'operator', reason: 'rejected', at: expect.any(Number) });
    expect(Math.abs((p1['decision'] as { at: number }).at - Date.now() / 1000)).toBeLessThan(60);
    expect(rows.find((r) => r['id'] === 'p2')).not.toHaveProperty('decision');
    // Pending and approved rows never carry one.
    const all = ((await s.app.inject({ method: 'GET', url: '/api/v1/proposals' })).json() as { proposals: Array<Record<string, unknown>> }).proposals;
    const others = all.filter((r) => r['state'] !== 'rejected');
    expect(others.map((r) => r['id'])).toEqual(['p3', 'p4']);
    expect(others.some((r) => 'decision' in r)).toBe(false);
  });

  it('a reject estate refuses records nothing, and never changes an earlier decision (review r2)', async () => {
    const s = await server({ rows: [memory('p1')] });
    await s.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' });
    const before = (await s.rejected())[0]!['decision'];
    // An id estate does not know: it refuses.
    expect((await s.app.inject({ method: 'POST', url: '/api/v1/proposals/ghost/reject' })).statusCode).toBeGreaterThanOrEqual(400);
    await s.audit.flush();
    expect((await s.audit.readAll({ action: PROPOSAL_DECIDED })).map((e) => e.detail?.['proposalId'])).toEqual(['p1']);
    expect((await s.rejected())[0]!['decision']).toEqual(before);
  });

  it('a decision made after the first list (the trail already read) shows on the next one', async () => {
    const s = await server({ rows: [memory('p1')] });
    expect(await s.rejected()).toEqual([]);
    await s.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' });
    expect((await s.rejected())[0]!['decision']).toMatchObject({ by: 'operator', reason: 'rejected' });
  });

  it('a caller that is not a person never reads as the operator', async () => {
    const s = await server({ rows: [memory('p1')], actor: { id: 'worker-1', kind: 'agent', trust: 'operator' } });
    expect((await s.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' })).statusCode).toBe(200);
    expect((await s.rejected())[0]!['decision']).toMatchObject({ by: 'crew', reason: 'rejected' });
    // Nor does a hand-made line claiming so.
    expect(decisionOf({ ts: 5_000, action: PROPOSAL_DECIDED, actor: { id: 'x', kind: 'agent', trust: 'operator' } as Actor, detail: { proposalId: 'p9', by: 'operator', reason: 'rejected' } })?.decision.by).toBe('crew');
    expect(decisionOf({ ts: 5_000, action: PROPOSAL_DECIDED, actor: { id: 'local', kind: 'human', trust: 'admin' } as Actor, detail: { proposalId: 'p9', by: 'operator', reason: 'made-up' } })).toBeNull();
  });

  it('an accept with an edit: the original is replaced by its copy (crew’s decision, naming the copy)', async () => {
    const s = await server({ rows: [memory('p1')] });
    const res = await s.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { content: 'memory p1, worded better' } });
    expect(res.statusCode).toBe(200);
    expect((await s.rejected()).map((r) => [r['id'], r['decision']])).toEqual([
      ['p1', { by: 'crew', reason: 'replaced-by-edit', at: expect.any(Number), copy_id: 'copy-1' }],
    ]);
  });

  it('an accept with an edit whose approve fails: the withdrawn copy says so; the original stays pending', async () => {
    const s = await server({ rows: [memory('p1')], approveFails: new Set(['copy-1']) });
    expect((await s.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/approve', payload: { content: 'memory p1, worded better' } })).statusCode).toBe(502);
    expect((await s.rejected()).map((r) => [r['id'], r['decision']])).toEqual([
      ['copy-1', { by: 'crew', reason: 'withdrawn-copy', at: expect.any(Number) }],
    ]);
  });

  it('after a restart the decisions are read back from the trail', async () => {
    const rows = [memory('p1')];
    const first = await server({ rows });
    await first.app.inject({ method: 'POST', url: '/api/v1/proposals/p1/reject' });
    await first.audit.flush();
    const again = await server({ rows, audit: new AuditLog((first.audit as unknown as { path: string }).path, () => undefined) });
    expect((await again.rejected())[0]!['decision']).toMatchObject({ by: 'operator', reason: 'rejected' });
  });
});
