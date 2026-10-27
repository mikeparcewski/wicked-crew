// POST /api/v1/runs/:id/resolve (api-types 0.140.0) over the real server assembly: unresolved work
// (`GET /system.unresolved[]`) is resolved, never hidden. Archiving needs a reason (a missing or
// blank one is refused), closing as superseded names the run that replaced it, a run parked at a
// gate is stopped first, and live work is never ended by a resolve. A resolved run leaves
// `unresolved[]`; the record keeps the reason as its archive note.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ResolveRunResponse, SystemSnapshot } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

const ENV_KEYS = ['WICKED_SEAT_FLOOR', 'WICKED_MEMORY_DB', 'WICKED_ESTATE_EXE', 'LOG_LEVEL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const SESSION = {
  entity_mode: 'none', collection_scope: null, clis: ['claude', 'codex'], human_confirm: 'all',
  unit_ix: 0, attempt: 0, workdir: null, repo_ref: 'tiny-math', extra_write_roots: [], archived_at: null as number | null, archive_note: null as string | null,
};
const nowS = (): number => Math.floor(Date.now() / 1000);

let scratch: string;
let app: FastifyInstance;
const archived: Array<{ id: string; note: string | undefined }> = [];
const cancelled: string[] = [];
type V = { session: Record<string, unknown> & typeof SESSION & { id: string; status: string }; units: unknown[] };
let views: V[];

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  scratch = mkdtempSync(join(tmpdir(), 'crew-resolve-route-'));
  const home = join(scratch, 'state-home');
  mkdirSync(home);
  const dbPath = join(home, 'core.db');
  writeFileSync(dbPath, 'not-a-real-sqlite-file', 'utf8');
  mkdirSync(join(home, 'core.db.events'));
  process.env['WICKED_SEAT_FLOOR'] = 'host';
  process.env['WICKED_MEMORY_DB'] = join(scratch, 'memory.db');
  process.env['WICKED_ESTATE_EXE'] = join(scratch, 'no-such-estate');
  process.env['LOG_LEVEL'] = 'error';

  views = [
    // A probe that failed 10 days ago and nobody retried or archived.
    { session: { ...SESSION, id: 'old-fail', workflow_id: 'ask/adhoc', problem: 'Say hi.', status: 'failed', created_at: nowS() - 10 * 86_400 }, units: [] },
    // A run parked at its deliver gate, superseded by a later completed run with the same title.
    { session: { ...SESSION, id: 'old-gate', workflow_id: 'editor-plugin', problem: 'Build the plugin', status: 'awaiting_human', created_at: nowS() - 17 * 3600 }, units: [{ id: 'old-gate:8', ord: 8, status: 'pending' }] },
    { session: { ...SESSION, id: 'new-done', workflow_id: 'editor-plugin', problem: 'Build the plugin', status: 'completed', created_at: nowS() - 3600, delivery: 'delivered' }, units: [] },
    { session: { ...SESSION, id: 'live', workflow_id: 'bug', problem: 'fix it', status: 'executing', created_at: nowS() - 60 }, units: [{ id: 'live:0', ord: 0, status: 'distributed' }] },
  ];
  const adapter = {
    stub: true,
    dbPath,
    projectsSupported: () => false,
    getSettings: async () => ({ workerStallMinutes: 15 }),
    ping: async () => 'ok',
    listRepos: async () => [],
    sessionsDetail: async () => views.map((v) => ({ session: { ...v.session }, units: v.units })),
    runEvents: async (id: string) => (id === 'old-fail' ? [{ type: 'cliUsage', session: id, ord: 0, inputTokens: 1200, outputTokens: 300, costUsd: 0.42, ts: 1, seq: 1 }] : []),
    interactionRequests: async () => [
      { id: 'ir_old', session_id: 'old-gate', kind: 'gate', ord: 8, reviewing_ord: null, prompt: 'Approve delivery?', gate_kind: 'deliver', status: 'open', created_at: Date.now() - 16 * 3_600_000 },
    ],
    listConformanceRules: async () => [],
    cancelRun: async (id: string) => {
      cancelled.push(id);
      const v = views.find((x) => x.session.id === id)!;
      v.session.status = 'cancelled';
      return 'cancelled';
    },
    archiveRun: async (id: string, on: boolean, note?: string) => {
      const v = views.find((x) => x.session.id === id);
      if (v === undefined) return false;
      if (!['completed', 'cancelled', 'failed'].includes(v.session.status)) throw new Error(`run ${id} is ${v.session.status} — only a terminal run can be archived`);
      archived.push({ id, note });
      v.session.archived_at = on ? nowS() : null;
      v.session.archive_note = note ?? null;
      return true;
    },
    onLaunch: (): (() => void) => () => undefined,
    onEvent: () => () => {},
  } as unknown as CoreAdapter;

  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  removeScratch(scratch);
});

const system = async (): Promise<SystemSnapshot> => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/system' });
  expect(res.statusCode).toBe(200);
  return res.json() as SystemSnapshot;
};
const resolve = (id: string, body: unknown) => app.inject({ method: 'POST', url: `/api/v1/runs/${id}/resolve`, payload: body as Record<string, unknown> });

describe('unresolved work and POST /runs/:id/resolve', () => {
  it('is advertised on /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect((res.json() as HealthResponse).capabilities?.attentionRanked).toBe(true);
  });

  it('GET /system lists the unresolved runs with what they cost; the superseded gate is not stuck', async () => {
    let s = await system();
    // The cost read is bounded per snapshot; a loaded host may need a second read.
    if (s.unresolved?.find((u) => u.runId === 'old-fail')?.cost.costUsd == null) s = await system();
    const by = Object.fromEntries((s.unresolved ?? []).map((u) => [u.runId, u]));
    expect(Object.keys(by).sort()).toEqual(['old-fail', 'old-gate']);
    expect(by['old-fail']).toMatchObject({ why: 'failed', actions: ['retry', 'archive'], cost: { costUsd: 0.42, tokens: { input: 1200, output: 300 } } });
    expect(by['old-gate']).toMatchObject({ why: 'superseded', supersededBy: 'new-done', actions: ['close_superseded', 'archive'] });
    expect(s.unresolvedSpend).toMatchObject({ costUsd: 0.42, costKnown: 1 });
    expect(s.attention.some((a) => (a.blockedRunIds ?? []).includes('old-gate') && a.kind === 'prevents')).toBe(false);
    expect(s.level).not.toBe('green');
    expect(s).toHaveProperty('toReview');
  });

  it('archiving without a reason is refused, and a blank reason too', async () => {
    for (const body of [{ action: 'archive' }, { action: 'archive', reason: '   ' }, {}]) {
      const res = await resolve('old-fail', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(archived).toEqual([]);
  });

  it('archiving with a reason resolves the run: it leaves unresolved[] and the note keeps the reason', async () => {
    const res = await resolve('old-fail', { action: 'archive', reason: 'a routing probe; the bug was fixed in 0.9' });
    expect(res.statusCode).toBe(200);
    expect(res.json() as ResolveRunResponse).toEqual({ runId: 'old-fail', action: 'archive', archived: true, cancelled: false, note: 'resolved: a routing probe; the bug was fixed in 0.9' });
    expect(archived).toContainEqual({ id: 'old-fail', note: 'resolved: a routing probe; the bug was fixed in 0.9' });
    expect(((await system()).unresolved ?? []).map((u) => u.runId)).toEqual(['old-gate']);
  });

  it('close as superseded: `by` must be another, existing run; a parked gate is stopped first, then archived', async () => {
    expect((await resolve('old-gate', { action: 'superseded', by: 'old-gate' })).statusCode).toBe(400);
    expect((await resolve('old-gate', { action: 'superseded', by: 'nope' })).statusCode).toBe(400);
    expect((await resolve('missing', { action: 'archive', reason: 'x' })).statusCode).toBe(404);
    const res = await resolve('old-gate', { action: 'superseded', by: 'new-done' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cancelled: true, note: 'superseded by new-done' });
    expect(cancelled).toEqual(['old-gate']);
    expect((await system()).unresolved).toEqual([]);
  });

  it('a running job is never resolved', async () => {
    const res = await resolve('live', { action: 'archive', reason: 'done with it' });
    expect(res.statusCode).toBe(409);
    expect(cancelled).not.toContain('live');
  });
});
