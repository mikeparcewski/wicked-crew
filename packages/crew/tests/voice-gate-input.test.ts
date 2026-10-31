// A gate answered by voice (program DES-VOICE §3): studio confirms a spoken answer on screen and sends it with
// `input: "voice"`. Crew keeps it on the `gate.decided` audit line, and the decided-gate history says it. It
// grants nothing: the same route, the same checks, the same confirm.

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { decidedGates } from '../src/standing-orders/history.js';

const RUN = 'run-voice';

function view(id: string) {
  return {
    session: {
      id, workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null, clis: ['claude'],
      status: 'awaiting_human', human_confirm: 'all', unit_ix: 4, attempt: 0, workdir: null, repo_ref: null,
      extra_write_roots: [], archived_at: null, archive_note: null,
    },
    units: [{
      id: `${id}:review`, session_id: id, ord: 4, description: '', stage: 'build', phase_ref: 'review',
      assigned_cli: null, assigned_invocation: null, council_task_ref: null, routing: null, status: 'pending',
    }],
  };
}

describe('POST /runs/:id/gate {input: "voice"}', () => {
  let app: FastifyInstance;
  const confirmCalls: unknown[][] = [];
  const recorded: Array<{ action: string; detail?: Record<string, unknown> }> = [];
  const gateCache = new GateCache();
  const audit = {
    record: vi.fn((action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
      recorded.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const adapter = {
      sessionsDetail: vi.fn().mockResolvedValue([view(RUN)]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      interactionRequests: vi.fn(async (id: string) => {
        const open = gateCache.get(id);
        return open === undefined ? [] : [{ kind: 'gate', ord: open.ord, prompt: open.prompt, created_at: open.receivedAt }];
      }),
      runEvents: vi.fn(async () => null),
      confirmGate: vi.fn(async (...args: unknown[]) => { confirmCalls.push(args); return 'executing'; }),
    };
    app = Fastify({ logger: false });
    registerRoutes(app, adapter as unknown as CoreAdapter, gateCache, new ElicitationCache(), undefined, { audit, authMode: 'off' });
    await app.ready();
  });
  beforeEach(() => {
    confirmCalls.length = 0;
    recorded.length = 0;
    gateCache.adopt(RUN, { ord: 4, prompt: 'Approve review?', lifecycle: 'open', receivedAt: '2026-10-31T10:00:00Z' });
  });
  afterAll(async () => { await app.close(); });

  it('is recorded on the gate.decided line and confirms exactly like a typed approve', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/gate`, payload: { approve: true, ord: 4, input: 'voice' } });
    expect(res.statusCode).toBe(200);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.slice(0, 2)).toEqual([RUN, true]);
    const line = recorded.find((r) => r.action === 'gate.decided');
    expect(line?.detail).toMatchObject({ approve: true, ord: 4, input: 'voice' });
  });

  it('a typed answer records no input, and any other input word is a 400', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/gate`, payload: { approve: true, ord: 4 } })).statusCode).toBe(200);
    expect(recorded.find((r) => r.action === 'gate.decided')?.detail).not.toHaveProperty('input');
    recorded.length = 0;
    const bad = await app.inject({ method: 'POST', url: `/api/v1/runs/${RUN}/gate`, payload: { approve: true, ord: 4, input: 'typing' } });
    expect(bad.statusCode).toBe(400);
    expect(recorded).toEqual([]);
  });
});

describe('decided-gate history', () => {
  it('says "voice" for a voice answer and nothing for a typed one', async () => {
    const actor = { id: 'local', kind: 'human', trust: 'admin' };
    const entries = [
      { ts: 2, action: 'gate.decided', actor, runId: RUN, detail: { approve: true, ord: 4, input: 'voice' } },
      { ts: 1, action: 'gate.decided', actor, runId: RUN, detail: { approve: true, ord: 4 } },
    ];
    const rows = await decidedGates({
      audit: { read: async () => entries } as never,
      views: async () => [view(RUN)] as never,
      gateRows: async () => [],
      projectOf: () => undefined,
      landsDoctrine: () => false,
    }, undefined);
    expect(rows.map((r) => r.input)).toEqual(['voice', undefined]);
  });
});
