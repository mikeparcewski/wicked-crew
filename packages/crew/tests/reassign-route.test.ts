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

  it('409s an awaiting_human run — naming the status — when the adapter cannot approve the gate on the caller’s behalf (wave 6, F-7R2-007: a capable adapter approves-then-reassigns instead — see reassign-awaiting-human.test.ts)', async () => {
    views = [view('r-esc', 'awaiting_human', 0, [{ ord: 1, cli: 'claude' }])];
    const res = await post('r-esc');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('awaiting_human');
    expect((res.json() as { error: string }).error).toContain('not executing');
    // Named, never a TypeError dressed as a refusal (this fake adapter has no confirmGate).
    expect((res.json() as { error: string }).error).toContain('POST /runs/r-esc/gate');
    expect((res.json() as { error: string }).error).not.toContain('is not a function');
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

// crew#1153: an operator note rides a GATED reassign as the approve's amendment.
describe('POST /runs/:id/reassign — the operator note (crew#1153)', () => {
  let app: FastifyInstance | undefined;
  let calls: unknown[][];
  let events: { action: string; detail?: Record<string, unknown> }[];
  let approveFails: boolean;

  const gatedView = (id: string): SessionView =>
    ({
      session: { id, status: 'awaiting_human', unit_ix: 0, clis: ['claude', 'codex'], human_confirm: 'all', workflow_id: 'wf-x' },
      units: [{ id: `${id}:u0`, ord: 0, assigned_cli: 'claude' }],
    }) as unknown as SessionView;

  beforeEach(() => {
    calls = [];
    events = [];
    approveFails = false;
    const views = [gatedView('r-gated'), view('r-exec', 'executing', 0, [{ ord: 0, cli: 'claude' }], ['claude', 'codex'])];
    const mockAdapter = {
      sessionsDetail: async (): Promise<SessionView[]> => views,
      listRepos: async () => [],
      listWorkflows: () => [],
      confirmGate: async (...args: unknown[]): Promise<string> => {
        calls.push(['confirmGate', ...args]);
        if (approveFails) throw new Error('approve exploded');
        return 'executing';
      },
      reassignUnit: async (runId: string, ord: number, cli?: string | null): Promise<void> => {
        calls.push(['reassignUnit', runId, ord, cli ?? null]);
      },
    } as unknown as CoreAdapter;
    const audit = {
      record: (action: string, _actor: unknown, fields?: { detail?: Record<string, unknown> }) => {
        events.push({ action, ...(fields?.detail !== undefined ? { detail: fields.detail } : {}) });
        return 0;
      },
    } as unknown as AuditLog;
    app = Fastify({ logger: false });
    registerRoutes(app, mockAdapter, new GateCache(), new ElicitationCache(), undefined, { audit, authMode: 'off' });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const post = (id: string, payload: Record<string, unknown>) =>
    app!.inject({ method: 'POST', url: `/api/v1/runs/${id}/reassign`, payload });
  const reassigned = () => events.find((e) => e.action === 'run.reassigned')?.detail;

  it('cli named: re-seats, then approves with the (trimmed) note as the amendment; the audit holds note:true, never the text', async () => {
    const res = await post('r-gated', { cli: 'codex', note: '  host runtime blip, not the seat  ' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([
      ['reassignUnit', 'r-gated', 0, 'codex'],
      ['confirmGate', 'r-gated', true, 'host runtime blip, not the seat'],
    ]);
    expect(reassigned()).toMatchObject({ approved: true, note: true });
    expect(JSON.stringify(events)).not.toContain('runtime blip');
  });

  it('cli omitted: approves with the note, then reassigns', async () => {
    const res = await post('r-gated', { note: 'retry, the seat was fine' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([
      ['confirmGate', 'r-gated', true, 'retry, the seat was fine'],
      ['reassignUnit', 'r-gated', 0, null],
    ]);
    expect(reassigned()).toMatchObject({ note: true });
  });

  it('without a note, or with a whitespace note, confirmGate gets exactly two arguments and the audit has no note', async () => {
    for (const body of [{ cli: 'codex' }, { cli: 'codex', note: '   \n\t ' }, { note: '' }]) {
      calls.length = 0;
      events.length = 0;
      const res = await post('r-gated', body);
      expect(res.statusCode).toBe(200);
      expect(calls.find((c) => c[0] === 'confirmGate')).toEqual(['confirmGate', 'r-gated', true]);
      expect(reassigned()).not.toHaveProperty('note');
    }
  });

  it('a failed approve does not claim the note rode it', async () => {
    approveFails = true;
    const res = await post('r-gated', { cli: 'codex', note: 'why' });
    expect(res.statusCode).toBe(409);
    expect(reassigned()).toMatchObject({ approved: false });
    expect(reassigned()).not.toHaveProperty('note');
  });

  it('an executing run with a note is a 400 naming the gated-only rule, and nothing is reassigned', async () => {
    const res = await post('r-exec', { cli: 'codex', note: 'why' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('only a gated reassign');
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('an executing run with a whitespace note still reassigns (the note is absent)', async () => {
    const res = await post('r-exec', { note: '  ' });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([['reassignUnit', 'r-exec', 0, null]]);
  });

  it('caps the RAW note at 8192 UTF-8 bytes (checked before trimming): 8192 passes; 8193, a padded overflow and a multibyte overflow are 400s naming the limit', async () => {
    const ok = await post('r-gated', { note: 'a'.repeat(8192) });
    expect(ok.statusCode).toBe(200);
    calls.length = 0;
    for (const note of ['a'.repeat(8193), ` ${'a'.repeat(8192)} `, 'é'.repeat(4097)]) {
      const res = await post('r-gated', { note });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('8192');
    }
    expect(calls).toEqual([]);
  });

  it('an oversize whitespace-only note is absent, not a 400 — on a gated and on an executing run', async () => {
    const blank = ' '.repeat(9000);
    const gated = await post('r-gated', { cli: 'codex', note: blank });
    expect(gated.statusCode).toBe(200);
    expect(calls.find((c) => c[0] === 'confirmGate')).toEqual(['confirmGate', 'r-gated', true]);
    expect(reassigned()).not.toHaveProperty('note');
    calls.length = 0;
    const exec = await post('r-exec', { note: blank });
    expect(exec.statusCode).toBe(200);
    expect(calls).toEqual([['reassignUnit', 'r-exec', 0, null]]);
  });

  it('an unknown body field is still a 400', async () => {
    const res = await post('r-gated', { note: 'x', amend: 'y' });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});
