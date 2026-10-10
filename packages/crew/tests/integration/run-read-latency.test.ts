// crew#944 — on a long-lived state home a single run read must stay cheap, and `/health` must keep
// answering while run reads are in flight.
//
// Every `GET /runs/:id` (and `GET /runs`) is the engine's sessions-detail fold. That fold used to
// re-read and re-parse every work unit on the store once PER SESSION (wicked-core `list_projects`
// → `session_units`), O(runs × units): ~3 s per read on a ~120-run home. The reads serialize on the
// engine's actor and each holds a libuv worker thread while it waits, so a burst of them starved
// `/health` past 10 s. wicked-core#869 made the fold one unit scan.
//
// The home here is the REAL stub engine's: two template runs on a 12-phase tool-only def (one
// completed, one parked at a gate), cloned row for row to 120 runs (tests/setup/long-lived-home.mts),
// then opened ONCE by this process. On the per-session fold a read costs ~120 × 1,440 unit parses
// and both budgets below fail by an order of magnitude.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

const RUNS = 120;
const UNITS_PER_RUN = 12;
/** p95 of one run read on the 120-run home (the per-session fold: ~1 s). */
const RUN_READ_P95_MS = 100;
/** `/health` while 20 run reads are in flight (the per-session fold: many seconds). */
const HEALTH_UNDER_LOAD_MS = 200;

const HELPER = fileURLToPath(new URL('../setup/long-lived-home.mts', import.meta.url));

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let runIds: string[];
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
    const samples: number[] = [];
    for (const id of runIds.slice(0, 30)) {
      const { ms, status } = await timed(`/runs/${id}`);
      expect(status).toBe(200);
      samples.push(ms);
    }
    expect(p95(samples), `run-read samples (ms): ${samples.map((s) => s.toFixed(0)).join(' ')}`).toBeLessThan(RUN_READ_P95_MS);
  }, 120_000);

  it(`/health answers within ${HEALTH_UNDER_LOAD_MS} ms while 20 run reads are in flight`, async () => {
    const reads = runIds.slice(0, 20).map((id) => timed(`/runs/${id}`));
    const health = await timed('/health');
    const done = await Promise.all(reads);
    expect(health.status).toBe(200);
    expect(done.every((r) => r.status === 200)).toBe(true);
    expect(health.ms, `reads (ms): ${done.map((r) => r.ms.toFixed(0)).join(' ')}`).toBeLessThan(HEALTH_UNDER_LOAD_MS);
  }, 120_000);
});
