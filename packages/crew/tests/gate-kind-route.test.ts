// studio#814 (E2E run 9ec286dc): a refused hand-over parks the run at an ESCALATION whose `ord` is
// still the deliver unit. The live `awaitingHuman` frame says `gateKind: 'escalation'`, but
// `GET /runs/:id/gate` served only `{ord, prompt}`, so a reloaded studio inferred the gate from its
// unit and drew the original "Ready to hand it over" card. The gate read now carries the kind the
// engine gave — from the live frame, the event-log replay, or the durable row after a restart.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { type CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';

const REFUSED =
  'The deliver phase refused: deliver: the push identity mikeparcewski applies to github.com origins only\n' +
  'deliver: nothing to deliver — the run produced no committed change (wicked/x is not ahead of origin/main); nothing was pushed. ' +
  'Approve to re-run the deliver phase now, or reject to cancel the run.';

function view(id: string) {
  return {
    session: {
      id, workflow_id: 'wf-x', problem: 'p', entity_mode: 'shared', collection_scope: null,
      clis: ['pi'], status: 'awaiting_human', human_confirm: 'all', unit_ix: 1, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [],
  };
}

describe('GET /runs/:id/gate serves the gate kind (studio#814)', () => {
  let app: FastifyInstance;
  const gateCache = new GateCache();

  beforeAll(async () => {
    gateCache.ingest({ type: 'awaitingHuman', session: 'run-live', ord: 2, prompt: REFUSED, gateKind: 'escalation' } as unknown as CoreEvent);
    gateCache.ingest({ type: 'awaitingHuman', session: 'run-old', ord: 2, prompt: 'Approve unit 2?' } as unknown as CoreEvent);
    const mockAdapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view('run-live'), view('run-old'), view('run-durable'), view('run-replay')]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      // The engine writes each gate's row with the pause, before it emits the frame, so the live runs
      // have theirs too; a GET judges the cache by it (crew#1083 round 7). run-replay predates the table.
      interactionRequests: vi.fn(async (id: string) => {
        if (id === 'run-durable' || id === 'run-live') return [{ kind: 'gate', ord: 2, prompt: REFUSED, gate_kind: 'escalation', created_at: 1_785_614_004_730 }];
        if (id === 'run-old') return [{ kind: 'gate', ord: 2, prompt: 'Approve unit 2?', created_at: 1_785_614_004_730 }];
        return [];
      }),
      runEvents: vi.fn(async (id: string) =>
        id === 'run-replay'
          ? [
              { type: 'awaitingHuman', session: id, ord: 2, prompt: 'Approve delivery before unit 2 runs.', gateKind: 'deliver', ts: 1 },
              { type: 'resumed', session: id, ts: 2 },
              { type: 'awaitingHuman', session: id, ord: 2, prompt: REFUSED, gateKind: 'escalation', ts: 3 },
            ]
          : []),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, {
      audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
      authMode: 'off',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const gate = async (id: string) => (await app.inject({ method: 'GET', url: `/api/v1/runs/${id}/gate` })).json() as Record<string, unknown>;

  it('the live frame\'s kind, the replayed log\'s and the durable row\'s are all served', async () => {
    expect(await gate('run-live')).toMatchObject({ ord: 2, gateKind: 'escalation' });
    expect(await gate('run-replay')).toMatchObject({ ord: 2, gateKind: 'escalation', prompt: REFUSED });
    expect(await gate('run-durable')).toMatchObject({ ord: 2, gateKind: 'escalation' });
  });

  it('a frame that names no kind serves none (no guess)', async () => {
    expect(await gate('run-old')).not.toHaveProperty('gateKind');
  });
});
