// crew#1546 (coord merge check on #1613) against a REAL wicked-estate-mcp, when WICKED_ESTATE_MCP_EXE names one
// (skipped otherwise; CI has no estate binary). Every store is a temp file. The crash replay: an edit filed a
// replacement and died before approving it; the learning is edited twice; the orphan is then approved. Retired words
// must never come back, and the next brief must hold only the current words.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import { callEstateTool } from '../src/core/estate-mcp-client.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { isApproved, selectLearnings, type MemoryRow } from '../src/learnings/recall.js';
import { removeScratch } from './setup/scratch.js';

const EXE = process.env['WICKED_ESTATE_MCP_EXE'] ?? '';

describe.skipIf(EXE === '' || process.platform === 'win32')('editing an approved learning against a real wicked-estate-mcp', () => {
  let base: string;
  let app: FastifyInstance;
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: base,
    WICKED_HOME: join(base, 'wicked'),
    WICKED_MEMORY_DB: join(base, 'memory.db'),
    WICKED_KNOWLEDGE_DB: join(base, 'knowledge.db'),
    WICKED_XEDGE_DB: join(base, 'xedge.db'),
    WICKED_ESTATE_DB: ':memory:',
  });
  const estate = (tool: string, args: Record<string, unknown>): Promise<unknown> =>
    callEstateTool(tool, args, { spawn: () => spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env() } }), timeoutMs: 60_000 });
  const memories = async (): Promise<MemoryRow[]> => ((await estate('memory.list', {})) as { items: MemoryRow[] }).items;
  const state = async (id: string): Promise<string | undefined> =>
    ((await estate('proposal.list', { kind_type: 'memory' })) as { proposals: Array<{ id: string; state: string }> }).proposals.find((p) => p.id === id)?.state;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'memory-edit-estate-'));
    app = Fastify({ logger: false });
    registerRoutes(app, { sessionsDetail: async () => [], listRepos: async () => [] } as unknown as CoreAdapter, new GateCache(), new ElicitationCache(), undefined, undefined, { callEstateTool: estate });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    if (base !== undefined) removeScratch(base);
  });

  it('a crash-left replacement, two edits, then its approve: refused, the orphan rejected, the brief holds only the current words', async () => {
    const facets = { repo: 'acme-core' };
    const p0 = ((await estate('proposal.submit', { kind_type: 'memory', payload: { content: 'refunds settle nightly', reach: 'project', tier: 'semantic' }, facets })) as { id: string }).id;
    await estate('proposal.approve', { id: p0 });
    // The crash: an edit filed its replacement (naming what it replaces) and died before approving it.
    const orphan = ((await estate('proposal.submit', { kind_type: 'memory', payload: { content: 'refunds settle hourly', reach: 'project', tier: 'semantic', replaces: `proposal:${p0}` }, facets })) as { id: string }).id;

    const first = await app.inject({ method: 'POST', url: '/api/v1/memory/edit', payload: { memory_id: `proposal:${p0}`, content: 'refunds settle weekly' } });
    expect(first.statusCode, first.body).toBe(200);
    expect(await state(orphan)).toBe('rejected');
    const mid = (first.json() as { memory_id: string }).memory_id;
    const second = await app.inject({ method: 'POST', url: '/api/v1/memory/edit', payload: { memory_id: mid, content: 'refunds settle monthly' } });
    expect(second.statusCode, second.body).toBe(200);

    const approve = await app.inject({ method: 'POST', url: `/api/v1/proposals/${orphan}/approve` });
    expect(approve.statusCode).not.toBe(200);
    expect(await state(orphan)).toBe('rejected');

    // The approve side on its own: a replacement of a memory that is gone (filed now, never settled by an edit).
    const late = ((await estate('proposal.submit', { kind_type: 'memory', payload: { content: 'refunds settle yearly', reach: 'project', tier: 'semantic', replaces: `proposal:${p0}` }, facets })) as { id: string }).id;
    const refused = await app.inject({ method: 'POST', url: `/api/v1/proposals/${late}/approve` });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'stale_replacement' });
    expect(await state(late)).toBe('rejected');

    const approved = (await memories()).filter(isApproved);
    expect(approved.map((m) => m.content)).toEqual(['refunds settle monthly']);
    expect(selectLearnings(await memories(), 'how do refunds settle', 'acme-core', null).map((m) => m.content)).toEqual(['refunds settle monthly']);
  }, 180_000);
});
