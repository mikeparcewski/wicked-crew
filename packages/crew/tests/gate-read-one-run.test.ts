// crew#1775: a gate read took 5-30 s while runs were active. Every request about one run read it out of the shared
// whole-store snapshot, and every engine frame (bar the live streams) and every engine call that may write made that
// snapshot stale, so while runs moved each gate read paid for a fresh fold of every run on the store and its parse on
// the event loop, and studio's per-page gate reads queued behind those folds. A request about one run now reads that
// run alone, off the actor (`Core.sessionDetail`, core#1346). These fail on the snapshot read.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoreAdapter } from '../src/core/adapter.js';
import { registerDemoRoutes } from '../src/api/recording.js';
import { DeliveryResolver } from '../src/api/delivery-index.js';
import { workingDocRunFacts } from '../src/api/server.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { AuditLog } from '../src/api/audit.js';
import { removeScratch } from './setup/scratch.js';
import { RunUnits, resyncRunUnits } from '../src/interactive/run-units.js';
import { registerTestSetForRun, TestSetIndex } from '../src/qe/test-sets.js';

let dir: string;
let adapter: CoreAdapter;
let app: FastifyInstance | null;
let store: Array<{ session: Record<string, unknown>; units: unknown[] }>;
let folds: number;
let oneRunReads: number;

function parkedRun(id: string, status = 'awaiting_human'): { session: Record<string, unknown>; units: unknown[] } {
  return {
    session: {
      id, workflow_id: 'feature', problem: `problem ${id} `.repeat(20), status, team_plan: { rev: 1 },
      clis: ['claude', 'codex'], unit_ix: 2, attempt: 1, workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null,
    },
    units: Array.from({ length: 6 }, (_, ord) => ({
      id: `${id}:${ord}`, session_id: id, ord, description: `step ${ord} `.repeat(30), status: ord < 2 ? 'done' : 'pending',
      assigned_cli: 'claude', note: '', instructions: 'do the thing '.repeat(40),
    })),
  };
}

const frame = (event: Record<string, unknown>): void =>
  (adapter as unknown as { onEngineFrame: (e: Error | null, j: string) => void }).onEngineFrame(null, JSON.stringify(event));
const core = (): Record<string, unknown> => (adapter as unknown as { core: Record<string, unknown> }).core;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-read-one-run-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = null;
  folds = 0;
  oneRunReads = 0;
  store = Array.from({ length: 150 }, (_, i) => parkedRun(`run-${i}`));
  core()['sessionsDetail'] = () => new Promise<string>((resolve) => {
    folds++;
    const json = JSON.stringify(store);
    setImmediate(() => resolve(json));
  });
  core()['sessionDetail'] = (id: string) => new Promise<string>((resolve) => {
    oneRunReads++;
    const json = JSON.stringify(store.find((v) => v.session['id'] === id) ?? null);
    setImmediate(() => resolve(json));
  });
  core()['interactionRequests'] = async (sessionId: string) =>
    JSON.stringify([{ id: `g-${sessionId}`, session_id: sessionId, kind: 'gate', ord: 2, prompt: 'Approve step 2?', status: 'open', created_at: 1_785_614_004_730 }]);
  core()['runEvents'] = async () => '[]';
  core()['gateActions'] = async () => 'null';
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (app !== null) await app.close();
  adapter.close();
  removeScratch(dir);
});

async function routes(): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  registerRoutes(app, adapter, new GateCache(), new ElicitationCache(), undefined, {
    audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
    authMode: 'off',
  });
  await app.ready();
  return app;
}

describe('crew#1775: a gate read reads its one run, whatever the other runs are doing', () => {
  it('20 gate reads, each after an engine frame from another run, fold no store: one engine read of the run each', async () => {
    const server = await routes();
    for (let i = 0; i < 20; i++) {
      frame({ type: 'unitStarted', session: `run-${100 + i}`, ord: 1 }); // another run moves on
      const res = await server.inject({ method: 'GET', url: `/api/v1/runs/run-${i % 8}/gate` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ runId: `run-${i % 8}`, ord: 2, prompt: 'Approve step 2?' });
    }
    expect(folds).toBe(0);
    expect(oneRunReads).toBe(20);
  });

  it('runView answers from the engine as it is now: no snapshot age, frame or write stands between', async () => {
    expect((await adapter.runView('run-3'))!.session.status).toBe('awaiting_human');
    store[3] = parkedRun('run-3', 'executing'); // the engine moved it; no frame has landed yet
    expect((await adapter.runView('run-3'))!.session.status).toBe('executing');
    expect(await adapter.runView('no-such-run')).toBeUndefined();
    expect(folds).toBe(0);
  });

  it('each caller gets its own copy', async () => {
    const [a, b] = await Promise.all([adapter.runView('run-3'), adapter.runView('run-3')]);
    a!.session.status = 'failed';
    expect(b!.session.status).toBe('awaiting_human');
    expect((await adapter.runView('run-3'))!.session.status).toBe('awaiting_human');
  });

  it('the one-run read leaves the run list\'s shared snapshot valid', async () => {
    await adapter.sessionsDetail();
    await adapter.runView('run-1');
    await adapter.sessionsDetail();
    expect(folds).toBe(1);
  });
});

describe('crew#1775: the other per-run reads on a page load or a gate also read their one run', () => {
  it('GET /runs/:id/team reads the run alone', async () => {
    const server = await routes();
    frame({ type: 'unitStarted', session: 'run-120', ord: 1 });
    await server.inject({ method: 'GET', url: '/api/v1/runs/run-3/team' }); // the stub engine has no team to answer with
    expect(folds).toBe(0);
    expect(oneRunReads).toBeGreaterThan(0);
  });

  it('the after-gate unit resync and the terminal test-set check read the run alone', async () => {
    await resyncRunUnits(adapter, 'run-3', new RunUnits());
    expect(await registerTestSetForRun({ adapter, audit: AuditLog.noop(), index: new TestSetIndex() }, 'run-3')).toBeNull();
    expect(folds).toBe(0);
    expect(oneRunReads).toBe(2);
  });
});

describe('crew#1775 review: the demo view and the working document read their one run', () => {
  it('the demo view (polled by the recording reader) reads its one run', async () => {
    const app = Fastify({ logger: false });
    registerDemoRoutes(app, adapter, vi.fn() as never);
    await app.ready();
    try {
      frame({ type: 'unitStarted', session: 'run-120', ord: 1 });
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/run-3/demo' });
      expect(res.statusCode).toBe(404); // run-3 is no demo run
      expect(folds).toBe(0);
      expect(oneRunReads).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('a working document sees a run launched after any list was read, without a fold', async () => {
    await adapter.sessionsDetail(); // a list read, before the run exists
    store.push(parkedRun('run-new'));
    const facts = await workingDocRunFacts(adapter, () => undefined, 'run-new');
    expect(facts?.title).toBeTruthy();
    expect(facts?.terminal).toBe(false);
    expect(await workingDocRunFacts(adapter, () => undefined, 'no-such-run')).toBeNull();
    expect(folds).toBe(1);
  });

  it("a run end's delivery read reads that run alone", async () => {
    const resolver = new DeliveryResolver({
      viewOf: (id) => adapter.runView(id),
      workOutput: async () => null,
      isDelivered: () => false,
      record: () => undefined,
    });
    frame({ type: 'sessionCompleted', session: 'run-120' });
    await resolver.resolve('run-3');
    expect(folds).toBe(0);
    expect(oneRunReads).toBe(1);
  });
});

