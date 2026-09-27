// Studio OS behaviour 10 — STANDING ORDERS, the journey the spec names as its proof:
//
//   Set "auto-approve intake on project A" and mark yourself away. An intake gate on A clears
//   within 5 s, the audit log names the order, and the handover (behaviour 1: `GET /audit?since=`)
//   lists it.
//
// Over the REAL server assembly (createServer) on a stub engine: the order is stored through the
// API, the away flag is set through the API, and the gate arrives as the engine's own
// `awaitingHuman` frame on the daemon's single CoreEvent subscription. The order answers through
// the SAME gate decision path `POST /runs/:id/gate` uses (the ord check, `confirmGate`, the
// `gate.decided` audit) — so the proof is `confirmGate` called with the gate's ord and a
// `gate.decided` entry whose actor is the order. The invariant rides the same journey: a DELIVER
// gate on A, under an order that would match it, stays open.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AuditPage } from 'wicked-crew-api-types';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

function view(id: string, projectId: string, phases: string[]) {
  return {
    session: {
      id, workflow_id: 'feature', problem: `work on ${projectId}`, entity_mode: 'shared', collection_scope: null,
      clis: ['claude'], status: 'awaiting_human', human_confirm: 'all', unit_ix: 0, attempt: 0, workdir: null,
      repo_ref: null, extra_write_roots: [], archived_at: null, archive_note: null, project_id: projectId,
    },
    units: phases.map((phase, ord) => ({ id: `${id}:${ord}`, ord, phase_ref: phase, status: 'pending' })),
  };
}

let scratch: string;
let app: FastifyInstance;
let emit: (e: CoreEvent) => void = () => undefined;
const confirmCalls: unknown[][] = [];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'crew-standing-orders-'));
  // The intake gate is the engine's pre-run gate: before the run's FIRST unit, reviewing nothing.
  const views = [view('run-a', 'A', ['understand', 'build']), view('run-b', 'B', ['understand', 'build']), view('run-d', 'A', ['build', 'deliver'])];
  const adapter = {
    stub: true,
    projectsSupported: () => false,
    getSettings: async () => ({}),
    onLaunch: (): (() => void) => () => undefined,
    onEvent: (fn: (e: CoreEvent) => void) => {
      emit = fn;
      return () => undefined;
    },
    sessionsDetail: async () => views,
    listRepos: async () => [],
    interactionRequests: async () => [],
    runEvents: async () => null,
    confirmGate: async (...args: unknown[]) => {
      confirmCalls.push(args);
      return 'executing';
    },
  } as unknown as CoreAdapter;
  app = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(scratch, 'audit.log'),
    projectEvents: { disabled: true },
    interactiveWsRelay: { disabled: true },
    stallWatchdog: { enabled: false },
    studioRoot: join(scratch, 'no-studio'),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  removeScratch(scratch);
});

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

describe('standing orders — the behaviour-10 journey', () => {
  it('auto-approve intake on A + away: the intake gate on A clears within 5 s, the audit names the order, the deliver gate stays open', async () => {
    const t0 = Date.now();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/standing-orders',
      payload: {
        text: 'Auto-approve intake on project A',
        rule: {
          scope: { kind: 'project', projectId: 'A' },
          trigger: { kind: 'gate', phase: 'intake' },
          action: 'approve',
          activeWhen: 'away',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const orderId = (created.json() as { order: { id: string } }).order.id;
    // A wildcard approve on A: it WOULD match the deliver gate — the invariant refuses it.
    const wide = await app.inject({
      method: 'POST',
      url: '/api/v1/standing-orders',
      payload: {
        text: 'approve everything on A',
        rule: { scope: { kind: 'project', projectId: 'A' }, trigger: { kind: 'gate', phase: '*' }, action: 'approve', activeWhen: 'away' },
      },
    });
    expect(wide.statusCode).toBe(201);

    // Not away yet: the order is dormant.
    emit({ type: 'awaitingHuman', session: 'run-b', ord: 0, reviewingOrd: null, prompt: 'Approve unit 0 before it runs?', gateKind: 'run_level' } as CoreEvent);
    await new Promise((r) => setTimeout(r, 200));
    expect(confirmCalls).toEqual([]);

    const away = await app.inject({ method: 'PUT', url: '/api/v1/standing-orders/away', payload: { away: true } });
    expect(away.statusCode).toBe(200);

    const opened = Date.now();
    emit({ type: 'awaitingHuman', session: 'run-a', ord: 0, reviewingOrd: null, prompt: 'Approve unit 0 before it runs?', gateKind: 'run_level' } as CoreEvent);
    emit({ type: 'awaitingHuman', session: 'run-d', ord: 1, reviewingOrd: 0, prompt: 'Deliver?', gateKind: 'deliver' } as CoreEvent);
    expect(await until(() => confirmCalls.some((c) => c[0] === 'run-a'), 5000)).toBe(true);
    expect(Date.now() - opened).toBeLessThan(5000);
    const call = confirmCalls.find((c) => c[0] === 'run-a')!;
    expect(call[1]).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    // Project B's intake gate and A's deliver gate: never answered by an order.
    expect(confirmCalls.filter((c) => c[0] !== 'run-a')).toEqual([]);

    // The handover's read (behaviour 1): the trail since the absence began names the order.
    const trail = (await app.inject({ method: 'GET', url: `/api/v1/audit?since=${t0}` })).json() as AuditPage;
    const decided = trail.entries.find((e) => e.action === 'gate.decided' && e.runId === 'run-a');
    expect(decided).toBeDefined();
    expect(decided!.actor.kind).toBe('system');
    expect(decided!.actor.id).toBe(`standing-order:${orderId}`);
    expect(decided!.detail).toMatchObject({
      approve: true,
      ord: 0,
      standingOrder: { id: orderId, text: 'Auto-approve intake on project A' },
    });
    expect(trail.entries.some((e) => e.action === 'gate.decided' && e.runId === 'run-d')).toBe(false);
  });
});
