// crew#1880: at 4k runs the first `GET /runs` after a daemon start took 7-80 s. Every terminal run's event log was
// read twice (the run's launch name for its identity, then its terminal frame for `ended_at`), and both answers were
// remembered only in memory, so every start paid for them again. A run's launch frame and first terminal frame never
// change, so the daemon derives them once per run (one read) and keeps the positive facts beside the store
// (`<db>.run-facts.jsonl`, DES-1880). These tests fail on the old adapter.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoreAdapter } from '../src/core/adapter.js';
import { registerRoutes } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import type { AuditLog } from '../src/api/audit.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let dbPath: string;
let adapters: CoreAdapter[];
let apps: FastifyInstance[];
/** The store every adapter folds: the session views as the engine answers `sessionsDetail`. */
let store: Array<{ session: Record<string, unknown>; units: unknown[] }>;
/** Each run's event log, as `runEvents` answers it. */
let logs: Map<string, Array<Record<string, unknown>>>;
/** `runEvents` calls per run id, across every adapter. */
let reads: Map<string, number>;

const T0 = 1_785_600_000_000;

/** A run as the engine folds it: a synthetic `wf-<run>` workflow id and no team plan (a preset or free-text launch). */
function run(id: string, status: string, problem = `problem ${id}`): { session: Record<string, unknown>; units: unknown[] } {
  return {
    session: {
      id, workflow_id: `wf-${id}`, problem, status, clis: ['claude'], unit_ix: 0, attempt: 1, workdir: null, repo_ref: null,
      extra_write_roots: [], archived_at: null, entity_mode: 'none', collection_scope: null, human_confirm: 'never',
    },
    units: [],
  };
}

/** A run's log as the engine records it: the launch frame (with its `workflowId`), then the terminal frame. */
function log(id: string, launched: string | null, ended: number | null, terminal = 'sessionCompleted'): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ type: 'sessionStarted', session: id, problem: `problem ${id}`, workflowId: launched, ts: T0, seq: 0 }];
  if (ended !== null) out.push({ type: terminal, session: id, ts: ended, seq: 1 });
  return out;
}

function newAdapter(): CoreAdapter {
  const a = new CoreAdapter({ dbPath, stub: true });
  const core = (a as unknown as { core: Record<string, unknown> }).core;
  core['sessionsDetail'] = async () => JSON.stringify(store);
  core['sessionDetail'] = async (id: string) => JSON.stringify(store.find((v) => v.session['id'] === id) ?? null);
  core['interactionRequests'] = async () => '[]';
  core['gateActions'] = async () => 'null';
  core['runEvents'] = async (id: string) => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    return JSON.stringify(logs.get(id) ?? []);
  };
  adapters.push(a);
  return a;
}

async function list(a: CoreAdapter, flush = true): Promise<Array<Record<string, unknown>>> {
  const app = Fastify({ logger: false });
  registerRoutes(app, a, new GateCache(), new ElicitationCache(), undefined, {
    audit: { record: vi.fn(() => Date.now()) } as unknown as AuditLog,
    authMode: 'off',
  });
  await app.ready();
  apps.push(app);
  const res = await app.inject({ method: 'GET', url: '/api/v1/runs?include=archived' });
  expect(res.statusCode, res.body).toBe(200);
  if (flush) await a.flushRunFacts();
  // The run DTO: `{ session, units }`; the fields under test are the session's.
  return (res.json() as { runs: Array<{ session: Record<string, unknown> }> }).runs.map((r) => r.session);
}

const byId = (runs: Array<Record<string, unknown>>, id: string): Record<string, unknown> => runs.find((r) => r['id'] === id)!;
const totalReads = (): number => [...reads.values()].reduce((a, b) => a + b, 0);
const factsPath = (): string => `${dbPath}.run-facts.jsonl`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-facts-1880-'));
  dbPath = join(dir, 'core.db');
  // The store file exists before the daemon starts, as on a real install (the facts bind to it). An empty file is an
  // empty SQLite database; the stub engine may otherwise create it only after the first list.
  writeFileSync(dbPath, '');
  adapters = [];
  apps = [];
  reads = new Map();
  store = [run('done', 'completed'), run('free', 'failed'), run('stopped', 'cancelled')];
  logs = new Map([
    ['done', log('done', 'feature', T0 + 60_000)],
    ['free', log('free', null, T0 + 120_000, 'sessionFailed')],
    ['stopped', log('stopped', 'bugfix', T0 + 180_000, 'runCancelled')],
  ]);
});

afterEach(async () => {
  for (const app of apps) await app.close();
  for (const a of adapters) a.close();
  removeScratch(dir);
});

describe('crew#1880: a terminal run log is read once, and never again after a restart', () => {
  it('one list reads each terminal run once (identity and ended_at share the read)', async () => {
    const runs = await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ done: 1, free: 1, stopped: 1 });
    expect(byId(runs, 'done')).toMatchObject({ workflow_id: 'feature', ended_at: (T0 + 60_000) / 1000 });
    expect(byId(runs, 'free')['ended_at']).toBe((T0 + 120_000) / 1000);
  });

  it('a restarted daemon on the same store serves the same list and reads no terminal run log', async () => {
    const first = await list(newAdapter());
    reads.clear();
    const second = await list(newAdapter());
    expect(totalReads()).toBe(0);
    const pick = (r: Record<string, unknown>) => ({ id: r['id'], workflow_id: r['workflow_id'], run_identity: r['run_identity'], ended_at: r['ended_at'] });
    expect(second.map(pick)).toEqual(first.map(pick));
    expect(byId(second, 'free')['run_identity']).toEqual(byId(first, 'free')['run_identity']);
  });

  it('the sidecar is a pure cache: deleting it costs one rebuild from the logs and the list is unchanged', async () => {
    const pick = (r: Record<string, unknown>) => ({ id: r['id'], workflow_id: r['workflow_id'], run_identity: r['run_identity'], ended_at: r['ended_at'] });
    const before = (await list(newAdapter())).map(pick);
    rmSync(factsPath());
    reads.clear();
    const rebuilt = (await list(newAdapter())).map(pick);
    expect(Object.fromEntries(reads)).toEqual({ done: 1, free: 1, stopped: 1 });
    expect(rebuilt).toEqual(before);
    reads.clear();
    expect((await list(newAdapter())).map(pick)).toEqual(before);
    expect(totalReads()).toBe(0);
  });

  it('a run read while live is not kept as final: once terminal it is read once, then kept', async () => {
    store.push(run('live', 'executing'));
    logs.set('live', log('live', 'feature', null));
    const a = newAdapter();
    await list(a);
    expect(reads.get('live')).toBe(1);
    expect(readFileSync(factsPath(), 'utf8')).not.toContain('"live"');
    // It ends: the engine's fold says completed and its log gains the terminal frame.
    store[3] = run('live', 'completed');
    logs.set('live', log('live', 'feature', T0 + 240_000));
    (a as unknown as { viewsEpoch: number }).viewsEpoch++;
    const runs = await list(a);
    expect(byId(runs, 'live')['ended_at']).toBe((T0 + 240_000) / 1000);
    reads.clear();
    await list(newAdapter());
    expect(reads.get('live')).toBeUndefined();
  });

  it('a negative is never kept: a terminal run with no launch or terminal frame is read again after a restart', async () => {
    store.push(run('prelog', 'completed'));
    logs.set('prelog', []);
    const runs = await list(newAdapter());
    expect(byId(runs, 'prelog')['ended_at']).toBeUndefined();
    reads.clear();
    const again = await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ prelog: 1 });
    expect(byId(again, 'prelog')['ended_at']).toBeUndefined();
    expect(byId(again, 'prelog')['run_identity']).toEqual(byId(runs, 'prelog')['run_identity']);
  });

  it('a kept terminal frame without a kept launch frame: ended_at is served, the launch name is read again', async () => {
    store.push(run('nolaunch', 'completed'));
    logs.set('nolaunch', [{ type: 'sessionCompleted', session: 'nolaunch', ts: T0 + 300_000, seq: 4 }]);
    const runs = await list(newAdapter());
    reads.clear();
    const again = await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ nolaunch: 1 });
    expect(byId(again, 'nolaunch')['ended_at']).toBe((T0 + 300_000) / 1000);
    expect(byId(again, 'nolaunch')['run_identity']).toEqual(byId(runs, 'nolaunch')['run_identity']);
  });

  it('a kept fact answers only the run it was derived from: another problem under the same id is read again', async () => {
    await list(newAdapter());
    store[0] = run('done', 'completed', 'another problem');
    logs.set('done', log('done', 'bugfix', T0 + 99_000));
    reads.clear();
    const runs = await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ done: 1 });
    expect(byId(runs, 'done')).toMatchObject({ workflow_id: 'bugfix', ended_at: (T0 + 99_000) / 1000 });
  });

  it('a new store at the same path (a new file) discards the kept facts', async () => {
    await list(newAdapter());
    for (const a of adapters.splice(0)) {
      await a.flushRunFacts();
      a.close();
    }
    for (const f of ['core.db', 'core.db-wal', 'core.db-shm']) rmSync(join(dir, f), { force: true });
    writeFileSync(dbPath, '');
    reads.clear();
    await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ done: 1, free: 1, stopped: 1 });
  });

  it('a torn tail and malformed rows are skipped; the fact derived again after them is readable on the next start', async () => {
    await list(newAdapter());
    expect(existsSync(factsPath())).toBe(true);
    const lines = readFileSync(factsPath(), 'utf8').split('\n').filter((l) => l !== '');
    // codex r1: `null` and `42` parse as JSON but are not rows; a torn last line has no newline after it.
    writeFileSync(factsPath(), lines.filter((l) => !l.includes('"done"')).join('\n') + '\nnull\n42\nnot json\n{"v":1,"run":"done","fp":');
    reads.clear();
    const runs = await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ done: 1 });
    expect(byId(runs, 'done')['ended_at']).toBe((T0 + 60_000) / 1000);
    reads.clear();
    await list(newAdapter());
    expect(totalReads()).toBe(0);
  });

  it('duplicate lines: the last one wins; a file grown far past its runs is compacted at start', async () => {
    await list(newAdapter());
    const done = readFileSync(factsPath(), 'utf8').split('\n').find((l) => l.includes('"done"'))!;
    const row = JSON.parse(done) as Record<string, unknown>;
    const stale = JSON.stringify({ ...row, endedAt: T0 + 1_000 });
    appendFileSync(factsPath(), Array.from({ length: 200 }, () => stale + '\n').join('') + JSON.stringify({ ...row, endedAt: T0 + 7_000 }) + '\n');
    reads.clear();
    const runs = await list(newAdapter());
    expect(totalReads()).toBe(0);
    expect(byId(runs, 'done')['ended_at']).toBe((T0 + 7_000) / 1000);
    const after = readFileSync(factsPath(), 'utf8').split('\n').filter((l) => l !== '');
    expect(after.length).toBe(1 + 3); // the header + one line per kept run
  });

  it('a run read while live never answers ended_at, even when its log already holds the terminal frame', async () => {
    store.push(run('lag', 'executing'));
    logs.set('lag', log('lag', 'feature', T0 + 400_000)); // the log is ahead of the fold
    const a = newAdapter();
    const first = await list(a);
    expect('ended_at' in byId(first, 'lag')).toBe(false);
    store[3] = run('lag', 'completed');
    (a as unknown as { viewsEpoch: number }).viewsEpoch++;
    const runs = await list(a);
    expect(reads.get('lag')).toBe(2); // the terminal-time read, not the live one, dates it
    expect(byId(runs, 'lag')['ended_at']).toBe((T0 + 400_000) / 1000);
  });

  it('the run fence fallback answers a terminal run with no launch frame from the memo, as before (no read)', async () => {
    store.push(run('nolaunch', 'completed'));
    logs.set('nolaunch', [{ type: 'sessionCompleted', session: 'nolaunch', ts: T0 + 300_000, seq: 4 }]);
    const a = newAdapter();
    await list(a);
    reads.clear();
    await expect(a.launchedWorkflowOfRun('nolaunch')).resolves.toBeUndefined();
    await expect(a.launchedWorkflowOfRun('done')).resolves.toBe('feature');
    expect(totalReads()).toBe(0);
  });

  it('kept facts are written on their own within the batch window (no explicit flush), in one batch', async () => {
    for (let i = 0; i < 40; i++) {
      store.push(run(`many-${i}`, 'completed'));
      logs.set(`many-${i}`, log(`many-${i}`, 'feature', T0 + i + 1));
    }
    await list(newAdapter(), false);
    await new Promise((r) => setTimeout(r, 1_200));
    const lines = readFileSync(factsPath(), 'utf8').split('\n').filter((l) => l !== '');
    expect(lines.length).toBe(1 + 43);
    reads.clear();
    await list(newAdapter());
    expect(totalReads()).toBe(0);
  });

  it('a facts file that cannot be written leaves the list right (memory only)', async () => {
    mkdirSync(factsPath());
    const runs = await list(newAdapter());
    expect(byId(runs, 'done')).toMatchObject({ workflow_id: 'feature', ended_at: (T0 + 60_000) / 1000 });
    reads.clear();
    await list(newAdapter());
    expect(Object.fromEntries(reads)).toEqual({ done: 1, free: 1, stopped: 1 });
  });

  it('with no event-log binding the list dates nothing and keeps nothing', async () => {
    const a = newAdapter();
    delete (a as unknown as { core: Record<string, unknown> }).core['runEvents'];
    const runs = await list(a);
    expect('ended_at' in byId(runs, 'done')).toBe(false);
    expect(existsSync(factsPath()) ? readFileSync(factsPath(), 'utf8') : '').not.toContain('"done"');
  });
});
