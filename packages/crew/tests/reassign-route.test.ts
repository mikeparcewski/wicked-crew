// crew#442 — the manual operator lever: POST /runs/:id/reassign recycles a run's cursor unit
// via the same adapter.reassignUnit path the stall-watchdog's automatic escalation uses, for
// when a wedged unit needs recovering and auto-escalation is off, exhausted, or itself failed.
//
// Scoped to `executing` runs only (409 otherwise — only an executing run has a cursor unit),
// `cli` is optional and soft-validated against the run's own seat pool (400 on a mismatch —
// a likely operator typo), and the cursor is resolved the SAME way the watchdog resolves it
// (`core/cursor.ts`, shared by both paths) so the two can never disagree on "the cursor".

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { AuditLog } from '../src/api/audit.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SessionView } from '../src/core/types.js';
import type { FastifyInstance } from 'fastify';
import { removeScratch } from './setup/scratch.js';

/** A run view shaped enough for the reassign route's cursor resolution + seat-pool checks. */
function view(
  id: string,
  status: string,
  unitIx: number,
  ords: { ord: number; cli: string | null }[],
  clis?: string[],
): SessionView {
  return {
    session: { id, status, unit_ix: unitIx, ...(clis !== undefined ? { clis } : {}) },
    units: ords.map((u, i) => ({ id: `${id}:u${i}`, ord: u.ord, assigned_cli: u.cli })),
  } as unknown as SessionView;
}

describe('POST /runs/:id/reassign — the manual operator lever (crew#442)', () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  let audit: AuditLog;
  let reassigns: { runId: string; ord: number; cli: string | null }[];
  let reassignShouldThrow: string | undefined;
  let views: SessionView[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reassign-route-'));
    audit = new AuditLog(join(dir, 'audit.log'));
    reassigns = [];
    reassignShouldThrow = undefined;
    views = [
      // Units DELIBERATELY out of order with ords ≠ indexes: unit_ix 1 of ords [2,4,6] is ord 4.
      view(
        'r-esc',
        'executing',
        1,
        [
          { ord: 2, cli: 'claude' },
          { ord: 4, cli: 'codex' },
          { ord: 6, cli: null },
        ],
        ['claude', 'codex'],
      ),
    ];
    const mockAdapter = {
      sessionsDetail: async (): Promise<SessionView[]> => views,
      reassignUnit: async (runId: string, ord: number, cli?: string | null): Promise<void> => {
        if (reassignShouldThrow !== undefined) throw new Error(reassignShouldThrow);
        reassigns.push({ runId, ord, cli: cli ?? null });
      },
    } as unknown as CoreAdapter;

    app = Fastify({ logger: false });
    registerRoutes(
      app,
      mockAdapter,
      new GateCache(),
      new ElicitationCache(),
      undefined,
      undefined,
      { audit, authMode: 'off' },
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    removeScratch(dir);
  });

  const post = (id: string, payload?: Record<string, unknown>) =>
    app!.inject({
      method: 'POST',
      url: `/api/v1/runs/${id}/reassign`,
      ...(payload !== undefined ? { payload } : {}),
    });

  it('404s an unknown run', async () => {
    const res = await post('r-nope');
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toContain('not found');
  });

  it('409s a run that is not executing, naming the actual status', async () => {
    views = [view('r-esc', 'awaiting_human', 0, [{ ord: 1, cli: 'claude' }])];
    const res = await post('r-esc');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('awaiting_human');
    expect((res.json() as { error: string }).error).toContain('not executing');
  });

  it('409s a completed run too', async () => {
    views = [view('r-esc', 'completed', 0, [{ ord: 1, cli: 'claude' }])];
    const res = await post('r-esc');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('completed');
  });

  it('400s a schema violation — empty cli, non-string cli, and an unknown extra key', async () => {
    for (const payload of [{ cli: '' }, { cli: 123 }, { cli: 'claude', extra: 'nope' }]) {
      const res = await post('r-esc', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('400s a cli not in the run\'s seat pool, naming the pool', async () => {
    const res = await post('r-esc', { cli: 'gemini' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string };
    expect(body.error).toContain('gemini');
    expect(body.error).toContain('claude');
    expect(body.error).toContain('codex');
    expect(reassigns).toEqual([]);
  });

  it('succeeds with cli omitted — resolves the sorted-by-ord cursor, lets the council re-pick', async () => {
    const res = await post('r-esc');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ord: 4 }); // unit_ix 1 of ords [2,4,6] → ord 4
    expect(reassigns).toEqual([{ runId: 'r-esc', ord: 4, cli: null }]);

    const entries = await audit.read({ action: 'run.reassigned' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: 'r-esc', detail: { ord: 4 } });
  });

  it('succeeds with a valid pool cli — passes it through and reports it back', async () => {
    const res = await post('r-esc', { cli: 'claude' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', ord: 4, cli: 'claude' });
    expect(reassigns).toEqual([{ runId: 'r-esc', ord: 4, cli: 'claude' }]);

    const entries = await audit.read({ action: 'run.reassigned' });
    expect(entries[0]).toMatchObject({ runId: 'r-esc', detail: { ord: 4, cli: 'claude' } });
  });

  it('409s when the engine rejects the reassign (e.g. raced to a different status)', async () => {
    reassignShouldThrow = 'run r-esc is not Executing (status: Completed)';
    const res = await post('r-esc');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('not Executing');
    // Nothing was recorded — the attempt failed at the engine, not at crew.
    expect(await audit.read({ action: 'run.reassigned' })).toEqual([]);
  });
});
