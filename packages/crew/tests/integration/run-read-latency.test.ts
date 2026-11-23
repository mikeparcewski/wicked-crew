// crew#944 — on a long-lived state home a single run read must stay cheap, and `/health` must keep
// answering while run reads are in flight.
//
// `GET /runs` is the engine's whole-store fold (`sessionsDetail`); `GET /runs/:id` is its one-run read
// (`sessionDetail`, F35 / crew#1775). The fold used to re-read and re-parse every work unit on the
// store once PER SESSION (wicked-core `list_projects` → `session_units`), O(runs × units): ~3 s per
// read on a ~120-run home. The reads serialize on the engine's actor and each holds a libuv worker
// thread while it waits, so a burst of them starved `/health` past 10 s. wicked-core#869 made the fold
// one unit scan. Both reads are measured (crew#1812: the fold could regress while the one-run read
// stays cheap); a list read is measured cold, past the adapter's snapshot, so it is a real fold.
//
// The home here is the REAL stub engine's: two template runs on a 6-phase tool-only def (one
// completed, one parked at a gate), cloned row for row to 120 runs (tests/setup/long-lived-home.mts),
// then opened ONCE by this process. On the per-session fold a read costs ~120 × 720 unit parses
// (~0.5 s) and every budget below fails by far more than the tolerance.
//
// Tolerance: CI runs this beside the rest of the suite, so a measurement may take up to ATTEMPTS
// tries and passes on its best one; every attempt is reported. The per-session fold fails all of
// them.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter, VIEWS_SNAPSHOT_MAX_AGE_MS } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

const RUNS = 120;
const UNITS_PER_RUN = 6;
const ATTEMPTS = 3;
/** p95 of one run read on the 120-run home (the per-session fold: ~0.5 s). */
const RUN_READ_P95_MS = 100;
/**
 * `/health` while 20 run reads are in flight. The fault this guards (crew#944) is `/health` starved behind them: when
 * a run read cost the whole-store fold (~0.5 s here), `/health` waited many seconds. A run read is now the engine's
 * one-run read (F35, crew#1775), and `/health` answers as the burst drains, about 20 reads' worth: 200-290 ms on loaded
 * CI runners (crew#1780: 200.3, 224, 253, 261 ms), so 200 ms flaked. 1 s still fails a run read that costs ~50 ms or
 * more (20 of them in the burst), and leaves ~3.5x headroom over the worst run seen.
 */
const HEALTH_UNDER_LOAD_MS = 1_000;
/** Cold `GET /runs` reads per attempt (each one past the snapshot's age bound, so each is a fresh fold). */
const COLD_LIST_SAMPLES = 8;
/**
 * crew#1812: median of a cold `GET /runs` on the 120-run home: the engine's whole-store fold
 * (`sessionsDetail`), its parse, identity pass and freeze, and the route's copy and reply. The fault this
 * guards is the per-session fold (crew#944, wicked-core#869) coming back in `sessionsDetail` while the
 * one-run read stays cheap. Measured at host 1-min load ~30 on 14 cores: the fold as it is, p50 29-36 ms;
 * the fold with one unit read per session added (that fault's shape), p50 460-523 ms on every attempt.
 * On CI runners the fold as it is took p50 63 ms (Linux) and 104 ms (macOS). 300 ms leaves ~3x over the
 * slowest runner seen and still fails the fault's shape on the fastest host.
 */
const COLD_LIST_P50_MS = 300;

const HELPER = fileURLToPath(new URL('../setup/long-lived-home.mts', import.meta.url));

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let runIds: string[];
/** Callers that have entered `adapter.runView()` — proves the reads reached the adapter's run read. */
let readsEntered = 0;
/** The engine's whole-store folds (`sessionsDetail`) — proves each cold list read paid for its own. */
let folds = 0;
const savedEnv: Record<string, string | undefined> = {};

function scratchBase(): string {
  const runnerTemp = process.env['RUNNER_TEMP'];
  return process.platform === 'linux' && runnerTemp !== undefined && runnerTemp !== '' ? runnerTemp : tmpdir();
}

function helper(...args: string[]): void {
  execFileSync(process.execPath, ['--import', 'tsx', HELPER, ...args], { stdio: 'pipe', timeout: 90_000 });
}

async function timed(path: string): Promise<{ ms: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${path}`);
  await res.arrayBuffer();
  return { ms: performance.now() - t0, status: res.status };
}

async function until(pred: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

beforeAll(async () => {
  dir = mkdtempSync(join(scratchBase(), 'crew-run-read-latency-'));
  for (const k of ['WICKED_WORKFLOWS_DIR', 'WICKED_CREW_AUDIT_LOG']) savedEnv[k] = process.env[k];
  // Outside the state home (the daemon's worker Read fence refuses an overlay inside it).
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  process.env['WICKED_WORKFLOWS_DIR'] = join(dir, 'workflows');
  process.env['WICKED_CREW_AUDIT_LOG'] = join(dir, 'home', 'audit.log');
  helper('seed', dir);
  helper('clone', dir, String(RUNS));

  adapter = new CoreAdapter({ dbPath: join(dir, 'home', 'core.db'), stub: true });
  // F35, crew#1775: a single-run read is `runView` (the engine's one-run read, `sessionDetail`).
  const read = adapter.runView.bind(adapter);
  adapter.runView = (id) => {
    readsEntered += 1;
    return read(id);
  };
  // crew#1812: count the engine's whole-store folds under the adapter's snapshot and single-flight.
  const engine = (adapter as unknown as { core: Record<string, (...a: unknown[]) => Promise<string>> }).core;
  const fold = engine['sessionsDetail']!;
  engine['sessionsDetail'] = (...a: unknown[]) => {
    folds += 1;
    return fold(...a);
  };
  app = await createServer(adapter, { stallWatchdog: { enabled: false } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;
  const list = (await (await fetch(`${baseUrl}/runs`)).json()) as {
    runs: Array<{ session: { id: string }; units: unknown[] }>;
  };
  runIds = list.runs.map((r) => r.session.id);
  // The precondition, or the budgets below prove nothing: the home really holds the long history.
  expect(runIds).toHaveLength(RUNS);
  expect(list.runs.every((r) => r.units.length === UNITS_PER_RUN)).toBe(true);
}, 180_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    adapter?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dir !== undefined) removeScratch(dir);
  }
});

describe('crew#944 — run reads on a long-lived home', () => {
  it(`GET /runs/:id answers within a p95 of ${RUN_READ_P95_MS} ms over ${RUNS} runs`, async () => {
    await timed(`/runs/${runIds[0]}`); // warm the daemon's first-read memos
    const report: string[] = [];
    let best = Infinity;
    for (let attempt = 1; attempt <= ATTEMPTS && best >= RUN_READ_P95_MS; attempt++) {
      const samples: number[] = [];
      for (const id of runIds.slice(0, 30)) {
        const { ms, status } = await timed(`/runs/${id}`);
        expect(status).toBe(200);
        samples.push(ms);
      }
      best = Math.min(best, p95(samples));
      report.push(`attempt ${attempt}: p95 ${p95(samples).toFixed(1)} ms (${samples.map((x) => x.toFixed(0)).join(' ')})`);
    }
    console.info(`[crew#944] run reads: ${report.join('; ')}`);
    expect(best, report.join('; ')).toBeLessThan(RUN_READ_P95_MS);
  }, 240_000);

  it(`a cold GET /runs (a fresh whole-store fold) answers within a median of ${COLD_LIST_P50_MS} ms over ${RUNS} runs`, async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const report: string[] = [];
    let best = Infinity;
    for (let attempt = 1; attempt <= ATTEMPTS && best >= COLD_LIST_P50_MS; attempt++) {
      const samples: number[] = [];
      let warm = 0;
      while (samples.length < COLD_LIST_SAMPLES) {
        // Past the snapshot's age bound, so the read needs a fold of its own. The daemon's own pollers
        // (the schedulers) read the run list too: a read their fold served started no fold, is not a
        // cold read, and is not counted.
        await sleep(VIEWS_SNAPSHOT_MAX_AGE_MS + 50);
        const before = folds;
        const { ms, status } = await timed('/runs');
        expect(status).toBe(200);
        if (folds - before !== 1) {
          warm += 1;
          expect(warm, 'a list read past the age bound almost always folds the store itself').toBeLessThan(COLD_LIST_SAMPLES);
          continue;
        }
        samples.push(ms);
      }
      const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
      best = Math.min(best, median);
      report.push(`attempt ${attempt}: p50 ${median.toFixed(1)} ms (${samples.map((x) => x.toFixed(0)).join(' ')}; ${warm} warm skipped)`);
    }
    console.info(`[crew#1812] cold run list: ${report.join('; ')}`);
    expect(best, report.join('; ')).toBeLessThan(COLD_LIST_P50_MS);
  }, 240_000);

  it(`/health answers within ${HEALTH_UNDER_LOAD_MS} ms while 20 run reads are in flight`, async () => {
    const report: string[] = [];
    let best = Infinity;
    for (let attempt = 1; attempt <= ATTEMPTS && best >= HEALTH_UNDER_LOAD_MS; attempt++) {
      const entered = readsEntered;
      const reads = runIds.slice(0, 20).map((id) => timed(`/runs/${id}`));
      // All 20 handlers have reached the engine read before /health is sent (a counter of entries,
      // not of reads still open: on the one-scan fold the first reads may already have answered).
      await until(() => readsEntered - entered >= 20, '20 run reads to reach the engine');
      const health = await timed('/health');
      const done = await Promise.all(reads);
      expect(health.status).toBe(200);
      expect(done.every((r) => r.status === 200)).toBe(true);
      best = Math.min(best, health.ms);
      report.push(`attempt ${attempt}: health ${health.ms.toFixed(1)} ms (reads ${done.map((r) => r.ms.toFixed(0)).join(' ')})`);
    }
    console.info(`[crew#944] health under load: ${report.join('; ')}`);
    expect(best, report.join('; ')).toBeLessThan(HEALTH_UNDER_LOAD_MS);
  }, 240_000);
});
