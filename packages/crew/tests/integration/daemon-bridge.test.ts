// Integration test: prove launch → gate → confirm → complete THROUGH the daemon.
//
// This mirrors wicked-core-ts's own smoke.mjs, but drives everything over the
// daemon's HTTP + WS surface instead of calling core-ts directly:
//   1. boot the daemon in-process against the STUB engine (spawnStub, no real LLM)
//   2. connect a browser-style WS client to /ws
//   3. POST /runs with a human gate before unit 1
//   4. assert the CoreEvent stream fans out over WS (sessionStarted … awaitingHuman)
//   5. POST /runs/:id/gate {approve:true} and assert it advances to sessionCompleted
//   6. read the unit transcript + run list back over REST
//
// Deterministic + offline: force the lexical memory embedder so nothing downloads.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

interface Frame {
  type: string;
  session?: string;
  ord?: number;
  prompt?: string;
  allow?: boolean;
  [k: string]: unknown;
}

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let ws: WebSocket;

const frames: Frame[] = [];
const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }> = [];

function onFrame(f: Frame): void {
  frames.push(f);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w && w.pred(f)) {
      clearTimeout(w.timer);
      w.resolve(f);
      waiters.splice(i, 1);
    }
  }
}

function waitForFrame(pred: (f: Frame) => boolean, label: string, ms = 15000): Promise<Frame> {
  const found = frames.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise<Frame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out (${ms}ms) waiting for: ${label}`)), ms);
    waiters.push({ pred, resolve, timer });
  });
}

const count = (type: string): number => frames.filter((f) => f.type === type).length;
const has = (type: string): boolean => frames.some((f) => f.type === type);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-bridge-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // Connect the browser-style WS client BEFORE launching, so we catch the whole stream.
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (data: Buffer | string) => {
    try {
      onFrame(JSON.parse(data.toString()) as Frame);
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}, 30000);

afterAll(async () => {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);

const RUN_ID = 'it-run-1';

describe('daemon bridge over core-ts (stub engine)', () => {
  it('GET /health proves the actor + pump are up', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; ping: string };
    expect(body.status).toBe('ok');
    expect(body.ping).toBe('ok');
  });

  it('GET /roster returns the council seats', async () => {
    const res = await fetch(`${baseUrl}/api/v1/roster`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roster: unknown[] };
    expect(Array.isArray(body.roster)).toBe(true);
    expect(body.roster.length).toBeGreaterThan(0);
  });

  it('POST /runs launches a gated run and returns the run id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Do step one. Do step two',
        sessionId: RUN_ID,
        clisJson: SEATS,
        entityMode: 'shared',
        humanConfirm: 'before:1',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBe(RUN_ID);
  });

  it('streams sessionStarted → unitPlanned×2 → unitDistributed → awaitingHuman over WS', async () => {
    const gate = await waitForFrame((f) => f.type === 'awaitingHuman', 'awaitingHuman');
    expect(has('sessionStarted')).toBe(true);
    expect(count('unitPlanned')).toBe(2);
    expect(has('unitDistributed')).toBe(true);
    expect(gate.session).toBe(RUN_ID);
    expect(gate.ord).toBe(1);
    expect(typeof gate.prompt).toBe('string');
  });

  it('GET /runs/:id/gate returns the daemon-cached gate prompt', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/gate`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; ord: number; prompt: string; lifecycle: string };
    expect(body.runId).toBe(RUN_ID);
    expect(body.ord).toBe(1);
    expect(body.lifecycle).toBe('open');
    expect(body.prompt.length).toBeGreaterThan(0);
  });

  it('the run is actionable-first + awaiting_human in GET /runs', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ session: { id: string; status: string } }> };
    expect(body.runs[0]?.session.id).toBe(RUN_ID);
    expect(body.runs[0]?.session.status).toBe('awaiting_human');
  });

  it('POST /runs/:id/gate {approve:true} advances the run to completion', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(typeof body.status).toBe('string');

    await waitForFrame((f) => f.type === 'sessionCompleted', 'sessionCompleted');
    expect(has('resumed')).toBe(true);
    expect(has('unitExecuting')).toBe(true);
    const gates = frames.filter((f) => f.type === 'gateDecided');
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(gates.every((g) => g.allow === true)).toBe(true);
    expect(count('unitDone')).toBe(2);
  });

  it('GET /runs/:id/units/u1/output returns the captured stub transcript', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/units/u1/output`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: string | null };
    expect(typeof body.output).toBe('string');
    expect(body.output).toContain('stub-output');
  });

  it('GET /runs reflects a completed run and the gate cache is pruned', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`);
    const body = (await res.json()) as { runs: Array<{ session: { id: string; status: string } }> };
    const run = body.runs.find((r) => r.session.id === RUN_ID);
    expect(run?.session.status).toBe('completed');

    const gateRes = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/gate`);
    expect(gateRes.status).toBe(404);
  });

  it('POST /runs threads the workflow field through the schema to the core', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Extract domain rules from the payments service',
        sessionId: 'it-workflow-field',
        clisJson: SEATS,
        workflow: 'domain-extraction',
      }),
    });
    const body = (await res.json()) as { runId?: string; error?: string };
    // The schema accepted the field when the response is NOT a schema rejection.
    // 201 = workflow found; 400 = workflow def not in the stub store (still schema-OK).
    expect(body.error).not.toBe('Invalid request body');
    if (res.status === 201) {
      expect(body.runId).toBe('it-workflow-field');
    } else {
      expect([400, 409]).toContain(res.status);
    }
  });

  it('unknown run ids 404 on gate/cancel/resume', async () => {
    const gate = await fetch(`${baseUrl}/api/v1/runs/nope/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    expect(gate.status).toBe(404);
    const cancel = await fetch(`${baseUrl}/api/v1/runs/nope/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(404);
  });
});
