// F35 (crew daemon JS heap OOM on the rig): studio polls `GET /runs/:id/gate` for every parked run from
// every open tab, and each poll used to fold AND parse every run on the store, one to three times, one
// copy per caller. The views are now read through one shared snapshot per fold: a request about one
// run copies only that run, and concurrent callers share one parse. These tests fail on the old adapter.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoreAdapter, VIEWS_SNAPSHOT_MAX_AGE_MS } from '../src/core/adapter.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
let app: FastifyInstance | null;
/** The engine's fold answers handed out, by identity, so a parse of one can be counted. */
let foldStrings: Set<string>;
let folds: number;
/** JSON.parse calls on a fold's answer: how many whole-store copies the daemon built. */
let fullParses: number;
let store: unknown[];

/** A parked run with a few units, about the size of a real one's view. */
function parkedRun(id: string): unknown {
  return {
    session: {
      id, workflow_id: 'feature', problem: `problem ${id} `.repeat(20), status: 'awaiting_human', team_plan: { rev: 1 },
      clis: ['claude', 'codex'], unit_ix: 2, attempt: 1, workdir: null, repo_ref: null, extra_write_roots: [], archived_at: null,
    },
    units: Array.from({ length: 6 }, (_, ord) => ({
      id: `${id}:${ord}`, session_id: id, ord, description: `step ${ord} `.repeat(30), status: ord < 2 ? 'done' : 'pending',
      assigned_cli: 'claude', note: '', instructions: 'do the thing '.repeat(40),
    })),
  };
}

const core = (): Record<string, unknown> => (adapter as unknown as { core: Record<string, unknown> }).core;
const tick = () => new Promise((r) => setImmediate(r));

function seed(n: number): void {
  store = Array.from({ length: n }, (_, i) => parkedRun(`run-${i}`));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'f35-views-snapshot-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = null;
  foldStrings = new Set();
  folds = 0;
  fullParses = 0;
  seed(150);
  // The engine's whole-store fold: answered on a later turn, like the actor's reply.
  core()['sessionsDetail'] = () =>
    new Promise<string>((resolve) => {
      folds++;
      // A fresh string per fold (as the binding returns), so parses of it can be told apart.
      const json = JSON.stringify(store) + ' '.repeat(folds);
      foldStrings.add(json);
      setTimeout(() => resolve(json), 5);
    });
  core()['interactionRequests'] = async (sessionId: string) =>
    JSON.stringify([{ id: `g-${sessionId}`, session_id: sessionId, kind: 'gate', ord: 2, prompt: 'Approve step 2?', status: 'open', created_at: 1_785_614_004_730 }]);
  core()['runEvents'] = async () => '[]';
  const parse = JSON.parse.bind(JSON);
  vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
    if (foldStrings.has(text)) fullParses++;
    return parse(text, reviver);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

/** M concurrent gate polls over the N runs; the folds and full parses they cost. */
async function pollGates(m: number): Promise<{ folds: number; fullParses: number }> {
  const server = await routes();
  const before = { folds, fullParses };
  const answers = await Promise.all(
    Array.from({ length: m }, (_, i) => server.inject({ method: 'GET', url: `/api/v1/runs/run-${i % store.length}/gate` })),
  );
  for (const a of answers) expect(a.statusCode, a.body).toBe(200);
  expect(answers[0]!.json()).toMatchObject({ runId: 'run-0', ord: 2, prompt: 'Approve step 2?' });
  return { folds: folds - before.folds, fullParses: fullParses - before.fullParses };
}

describe('F35: run views are read through one shared snapshot', () => {
  it('40 concurrent gate polls over 150 runs cost one fold and one parse of the store, not one per poll', async () => {
    const cost = await pollGates(40);
    expect(cost.folds).toBe(1);
    expect(cost.fullParses).toBe(1);
  });

  it('the cost does not grow with the number of runs or of polls', async () => {
    seed(15);
    const small = await pollGates(10);
    await app!.close();
    app = null;
    seed(150);
    core()['launchRun'] = async () => '{}'; // any engine write moves the version
    await (core()['launchRun'] as () => Promise<string>)();
    const large = await pollGates(80);
    expect(large).toEqual(small);
  });

  it('runView copies one run, so a caller decorating it leaves the snapshot and other callers untouched', async () => {
    const [a, b] = await Promise.all([adapter.runView('run-3'), adapter.runView('run-3')]);
    expect(folds).toBe(1);
    a!.session.status = 'failed';
    expect(b!.session.status).toBe('awaiting_human');
    expect((await adapter.runView('run-3'))!.session.status).toBe('awaiting_human');
    expect(Object.isFrozen((await adapter.runViewsSnapshot()).views[3]!.session)).toBe(true);
    expect(await adapter.runView('no-such-run')).toBeUndefined();
  });

  it('a snapshot serves until an engine frame, an engine write, or its age says the store may have changed', async () => {
    await adapter.runView('run-0');
    await adapter.sessionsDetail();
    expect(folds).toBe(1);
    // A live output stream changes no view.
    (adapter as unknown as { onEngineFrame: (e: Error | null, j: string) => void }).onEngineFrame(null, JSON.stringify({ type: 'unitOutputDelta', session: 'run-0' }));
    await adapter.runView('run-0');
    expect(folds).toBe(1);
    // Any other frame may follow a change.
    store = [parkedRun('run-0'), { ...(parkedRun('run-1') as object), session: { id: 'run-1', status: 'completed', team_plan: { rev: 1 } } }];
    (adapter as unknown as { onEngineFrame: (e: Error | null, j: string) => void }).onEngineFrame(null, JSON.stringify({ type: 'sessionCompleted', session: 'run-1' }));
    expect((await adapter.runView('run-1'))!.session.status).toBe('completed');
    expect(folds).toBe(2);
    // An engine call that may write (here a cancel) moves the version too: read-your-writes.
    core()['cancelRun'] = async () => JSON.stringify('cancelled');
    store = [{ ...(parkedRun('run-0') as object), session: { id: 'run-0', status: 'cancelled', team_plan: { rev: 1 } } }];
    await adapter.cancelRun('run-0');
    expect((await adapter.runView('run-0'))!.session.status).toBe('cancelled');
    expect(folds).toBe(3);
    // A known read does not.
    await adapter.sessions().catch(() => undefined);
    await adapter.runView('run-0');
    expect(folds).toBe(3);
    // Age bounds a change no frame reported.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + VIEWS_SNAPSHOT_MAX_AGE_MS + 1);
    await adapter.runView('run-0');
    expect(folds).toBe(4);
  });

  it('a caller never takes a fold that started before a change it saw; at most one fold runs and one is queued', async () => {
    const first = adapter.runView('run-0');
    await tick();
    core()['cancelRun'] = async () => JSON.stringify('cancelled');
    await adapter.cancelRun('run-0'); // moves the version while the first fold runs
    const later = Array.from({ length: 20 }, () => adapter.runView('run-0'));
    await tick();
    expect(folds).toBe(1); // the 20 wait for the queued fold; they do not start their own
    await first;
    await Promise.all(later);
    expect(folds).toBe(2);
    expect(fullParses).toBe(2);
  });

  it('20 concurrent /roster/record reads fold the run logs once', async () => {
    let logReads = 0;
    core()['runEvents'] = async () => {
      logReads++;
      return '[]';
    };
    const server = await routes();
    const answers = await Promise.all(Array.from({ length: 20 }, () => server.inject({ method: 'GET', url: '/api/v1/roster/record?days=7' })));
    for (const a of answers) expect(a.statusCode, a.body).toBe(200);
    expect(folds).toBe(1);
    // An undated run counts as in the window, so one fold of the record reads each run's log once.
    expect(answers[0]!.json()).toMatchObject({ days: 7, runsRead: 150 });
    expect(logReads).toBe(150);
    // A read while the snapshot holds is served from that fold.
    await server.inject({ method: 'GET', url: '/api/v1/roster/record?days=7' });
    expect(logReads).toBe(150);
  });
});
