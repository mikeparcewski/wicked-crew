// Integration test: the run evidence export endpoint, driven THROUGH the daemon.
//
// Mirrors daemon-bridge.test.ts: boot the daemon in-process against the STUB
// engine, run a real run to completion over the HTTP + WS surface, then pull
// `GET /runs/:id/evidence` back and assert the bundle is a faithful, complete,
// downloadable record of that run.
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
import type { EvidenceBundle } from '../../src/api/evidence.js';

interface Frame {
  type: string;
  session?: string;
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

const SEATS = JSON.stringify([
  { key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' },
  { key: 'beta', display_name: 'Beta', binary: 'beta', headless_invocation: 'beta {PROMPT}' },
]);

const RUN_ID = 'it-evidence-1';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-evidence-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  // Connect before launching so the whole event stream is observed.
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

  // An ungated run runs straight through to completion on the stub engine.
  const res = await fetch(`${baseUrl}/api/v1/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem: 'Do step one. Do step two',
      sessionId: RUN_ID,
      clisJson: SEATS,
      entityMode: 'shared',
    }),
  });
  if (res.status !== 201) throw new Error(`launch failed: ${res.status} ${await res.text()}`);
  await waitForFrame((f) => f.type === 'sessionCompleted' && f.session === RUN_ID, 'sessionCompleted');
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

async function getEvidence(runId = RUN_ID): Promise<{ res: Response; bundle: EvidenceBundle }> {
  const res = await fetch(`${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/evidence`);
  return { res, bundle: (await res.json()) as EvidenceBundle };
}

describe('GET /runs/:id/evidence', () => {
  it('serves the bundle as a named JSON attachment', async () => {
    const { res } = await getEvidence();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="${RUN_ID}-evidence.json"`,
    );
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('bundles the run, its ordered units, and the derived event trail', async () => {
    const { bundle } = await getEvidence();
    expect(Object.keys(bundle).sort()).toEqual(['events', 'exportedAt', 'session', 'units']);

    // The run itself, verbatim from the run DTO.
    expect(bundle.session.id).toBe(RUN_ID);
    expect(bundle.session.status).toBe('completed');
    expect(bundle.session.problem).toBe('Do step one. Do step two');

    // Units in `ord` order, carrying the full unit DTO (not a trimmed projection).
    expect(bundle.units.length).toBe(2);
    expect(bundle.units.map((u) => u.ord)).toEqual([1, 2]);
    const [first] = bundle.units;
    expect(first?.id).toBe(`${RUN_ID}:u1`);
    expect(first?.session_id).toBe(RUN_ID);
    expect(first?.status).toBe('done');
    expect(typeof first?.description).toBe('string');
    expect(first).toHaveProperty('stage');
    expect(first).toHaveProperty('routing');
    expect(first).toHaveProperty('denial_reason');

    expect(new Date(bundle.exportedAt).toISOString()).toBe(bundle.exportedAt);
    expect(Array.isArray(bundle.events)).toBe(true);
  });

  it('includes each unit’s captured transcript', async () => {
    const { bundle } = await getEvidence();
    for (const unit of bundle.units) {
      expect(unit).toHaveProperty('transcript');
      expect(unit.transcriptError).toBeUndefined();
      expect(typeof unit.transcript).toBe('string');
      expect(unit.transcript).toContain('stub-output');
    }

    // Same text the per-unit output endpoint serves — the bundle is not a re-render.
    const res = await fetch(`${baseUrl}/api/v1/runs/${RUN_ID}/units/u1/output`);
    const { output } = (await res.json()) as { output: string | null };
    expect(bundle.units[0]?.transcript).toBe(output);
  });

  it('derives a gate decision per resolved unit and a routing record per routed unit', async () => {
    const { bundle } = await getEvidence();

    const gates = bundle.events.filter((e) => e.type === 'gateDecided');
    const resolved = bundle.units.filter((u) => u.status === 'done' || u.status === 'rejected');
    expect(gates.length).toBe(resolved.length);
    expect(gates.map((g) => g.ord)).toEqual(resolved.map((u) => u.ord));
    for (const gate of gates) {
      const unit = bundle.units.find((u) => u.ord === gate.ord);
      expect(gate.unitId).toBe(unit?.id);
      expect(gate.allow).toBe(unit?.status === 'done');
      expect(gate.denialReason).toBe(unit?.denial_reason ?? null);
    }

    // Routing provenance is emitted for exactly the units that carry one.
    const routed = bundle.units.filter((u) => u.routing !== null);
    const routing = bundle.events.filter((e) => e.type === 'routingDecided');
    expect(routing.length).toBe(routed.length);
    for (const event of routing) {
      const unit = bundle.units.find((u) => u.ord === event.ord);
      expect(event.routing).toEqual(unit?.routing);
      expect(event.assignedCli).toBe(unit?.assigned_cli ?? null);
    }

    // Events stay in unit order so the trail reads as the run happened.
    expect(bundle.events.map((e) => e.ord)).toEqual([...bundle.events.map((e) => e.ord)].sort((a, b) => a - b));
  });

  it('404s on an unknown run id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runs/nope/evidence`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'Run not found' });
  });
});
