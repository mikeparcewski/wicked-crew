import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { BUILTIN_WORKFLOWS } from './support/builtin-fixtures.js';
import { withRunViews } from './support/run-views.js';

describe('gate decision client attribution (crew#1553)', () => {
  let app: FastifyInstance;
  const recorded: Array<{ action: string; actor: unknown; runId?: string; detail?: Record<string, unknown> }> = [];
  const audit = {
    record: vi.fn((action: string, actor: unknown, fields?: { runId?: string; detail?: Record<string, unknown> }) => {
      recorded.push({ action, actor, ...fields });
      return Date.now();
    }),
  } as unknown as AuditLog;

  beforeAll(async () => {
    const adapter = withRunViews({
      sessionsDetail: vi.fn().mockResolvedValue([{
        session: {
          id: 'run-gated', workflow_id: 'bug', problem: 'p', entity_mode: 'shared', collection_scope: null,
          clis: ['claude', 'codex'], status: 'awaiting_human', human_confirm: 'all', unit_ix: 2, attempt: 0,
          workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null,
        },
        units: [],
      }]),
      listRepos: vi.fn().mockResolvedValue([]),
      listWorkflows: () => BUILTIN_WORKFLOWS,
      confirmGate: vi.fn().mockResolvedValue('executing'),
    });
    app = Fastify({ logger: false });
    registerRoutes(app, adapter as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, {
      audit,
      authMode: 'off',
    });
    await app.ready();
  });

  beforeEach(() => { recorded.length = 0; });
  afterAll(async () => { await app.close(); });

  it('records the user agent and choice without copying credentials', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/runs/run-gated/gate',
      headers: {
        'user-agent': 'curl/9.9 test',
        cookie: 'sid=SECRETCOOKIE',
        authorization: 'Bearer SECRETTOKEN',
      },
      payload: { approve: true, action: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const entry = recorded.find((r) => r.action === 'gate.decided');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('SECRETCOOKIE');
    expect(JSON.stringify(entry)).not.toContain('SECRETTOKEN');
    expect(entry?.detail?.client).toEqual({ userAgent: 'curl/9.9 test' });
    expect(entry?.detail?.choice).toBe('approve');
  });

  it('truncates a 500-character user agent to 200 characters', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/runs/run-gated/gate',
      headers: { 'user-agent': 'x'.repeat(500) },
      payload: { approve: true },
    });
    expect(res.statusCode).toBe(200);
    const entry = recorded.find((r) => r.action === 'gate.decided');
    expect(entry?.detail?.client).toEqual({ userAgent: 'x'.repeat(200) });
    expect(entry?.detail?.choice).toBe('approve');
  });
});
