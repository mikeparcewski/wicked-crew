// crew#1629: offer reads overlap, using the run already read for this gate.
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

describe.each(['cache', 'record'])('GET gate offer concurrency on the %s path (crew#1629)', (path) => {
  it.each(['deliver', 'rejudge'])('overlaps %s offer reads and reads the run once', async (kind) => {
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const read = async <T>(name: string, value: T): Promise<T> => {
      started.push(name);
      peak = Math.max(peak, ++inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return value;
      } finally {
        inFlight--;
      }
    };
    const deliver = kind === 'deliver';
    const id = `run-${kind}`;
    const ord = 4;
    const gateKind = deliver ? 'deliver' : 'escalation';
    const run = {
      session: {
        id, workflow_id: 'bug', status: 'awaiting_human', repo_ref: null, workdir: null,
        ...(deliver ? { assurance: { mode: 'full', required: ['qe_acceptance'] } } : {}),
      },
      units: [{
        id: `${id}:${deliver ? 'deliver' : 'review'}`, session_id: id, ord,
        phase_ref: deliver ? 'deliver' : 'review', status: deliver ? 'pending' : 'rejected',
        ...(!deliver ? { denial: { source: 'judge_unavailable' } } : {}),
      }],
    };
    const actions = [{ action: 'reject', intent: 'stop', note: 'optional' }];
    const runView = vi.fn(() => read('runView', run));
    const rejudgeReadiness = vi.fn(() => read('rejudgeReadiness', {
      applies: true, ord, available: true, eligible: ['codex'], missing: [],
    }));
    const verifiedEvidenceCatalog = vi.fn(() => read('qe', null));
    const adapter = {
      runView,
      rejudgeReadiness,
      verifiedEvidenceCatalog,
      gateActions: vi.fn(() => read('gateActions', { ord, gateKind, actions, planRev: 7 })),
      interactionRequests: vi.fn(async () => [{ kind: 'gate', ord, prompt: 'the gate', gate_kind: gateKind, created_at: 1_785_614_004_730 }]),
      runEvents: vi.fn(async () => []),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      listConformanceClaims: vi.fn(async () => []),
    };
    const cache = new GateCache();
    const entry = { ord, prompt: 'the gate', lifecycle: 'open' as const, receivedAt: new Date(1_785_614_004_730).toISOString(), gateKind };
    if (path === 'cache') cache.adopt(id, entry);
    const app = Fastify({ logger: false });
    registerRoutes(app, adapter as unknown as CoreAdapter, cache, new ElicitationCache());
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        runId: id, ...entry, assurance: null,
        ...(deliver ? {
          skipQe: {
            action: 'skip_qe', reasonRequired: true, actor: 'human_operator', label: 'QE acceptance skipped by operator',
            qeAcceptance: {
              status: 'required', satisfied: false,
              reason: 'run has no repo context — acceptance evidence cannot be located (missing ⇒ deny)',
              verdictId: null, reviewer: null,
            },
          },
        } : { rejudge: { available: true, eligible: ['codex'], missing: [] } }),
        actions, planRev: 7,
      });
      expect(peak, 'independent offer reads must overlap').toBeGreaterThanOrEqual(2);
      expect(runView, 'offers reuse the run already in hand').toHaveBeenCalledTimes(1);
      expect(started.slice(0, 2)).toEqual(['runView', 'gateActions']);
      expect(deliver ? verifiedEvidenceCatalog : rejudgeReadiness).toHaveBeenCalled();
      expect(adapter.interactionRequests).toHaveBeenCalledTimes(path === 'cache' ? 1 : 2);
    } finally {
      await app.close();
    }
  });
});
