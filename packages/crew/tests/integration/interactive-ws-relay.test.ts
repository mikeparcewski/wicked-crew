// DES-MERGE-001 §5.4/§6.1 (slice 3) — the wicked.interactive.* ↔ /ws relay, end to end over a
// REAL wicked-bus on a temp db and a REAL browser-style WebSocket client.
//
// What this pins, in acceptance order:
//   - a `wicked.interactive.status.posted` frame published while a doc generates (the synthetic
//     publisher stands in for interactive's service) arrives on the EXISTING /ws socket as
//     {type: "interactiveEvent", event: <the full bus event>} — one envelope, no field renaming
//   - a NON-interactive bus event (wicked.qe.gate.passed) is NOT relayed
//   - POST /projects/:projectId/interactive-events with a whitelisted type lands on the bus,
//     carrying interactive's own envelope conventions
//   - a non-whitelisted type is a 400 that NAMES the whitelist
//   - with the seam disabled the route is still there and answers 503 (never a 404)
//
// No second websocket and no second port appear anywhere in this file: every assertion rides the
// one `/ws` the studio already holds, on the server's own listening port.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from '../../src/api/server.js';
import { EMITTABLE_TYPES } from '../../src/interactive/ws-relay.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { SystemSettings } from '../../src/core/types.js';

const STATUS_POSTED = 'wicked.interactive.status.posted';
const FEEDBACK_SUBMITTED = 'wicked.interactive.feedback.submitted';

// createServer applies worker_config_root to process.env at boot; keep the env clean.
const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

/** The minimal adapter surface createServer touches at boot — the engine is irrelevant here:
 *  every frame under test originates on the BUS, not the CoreEvent pump. */
const mockAdapter = {
  getSettings: async (): Promise<SystemSettings> => ({ graphNodeLimit: 150 }),
  projectsSupported: (): boolean => false,
  onEvent: (): (() => void) => () => undefined,
} as unknown as CoreAdapter;

let dir: string;
let busDb: string;
let bus: typeof import('wicked-bus');
let app: Awaited<ReturnType<typeof createServer>>;
let baseUrl: string;
let ws: WebSocket;

/** Every frame the WS client received, parsed, in arrival order. */
const frames: Array<Record<string, unknown>> = [];

async function waitForFrame(
  pred: (f: Record<string, unknown>) => boolean,
  label: string,
  ms = 8000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const found = frames.find(pred);
    if (found !== undefined) return found;
    if (Date.now() - start > ms) throw new Error(`timed out (${ms}ms) waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Publish one event on the temp bus, exactly as a foreign producer would. */
function publish(
  eventType: string,
  domain: string,
  subdomain: string,
  payload: Record<string, unknown>,
): void {
  const db = bus.openDb({ db_path: busDb });
  bus.emit(db, bus.loadConfig({ db_path: busDb }), {
    event_type: eventType,
    domain,
    subdomain,
    payload,
    producer_id: 'wi-service',
  });
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'interactive-relay-'));
  busDb = join(dir, 'bus.db');
  bus = await import('wicked-bus');
  // Create the db BEFORE the server subscribes (the acceptance-route bus test's ordering).
  bus.openDb({ db_path: busDb });

  app = await createServer(mockAdapter, {
    projectEvents: { disabled: true },
    interactiveWsRelay: { dbPath: busDb, pollIntervalMs: 25 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api/v1`;

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (data: Buffer | string) => {
    frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}, 20000);

afterAll(async () => {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  await app.close(); // stops the relay subscriber via the onClose hook
  rmSync(dir, { recursive: true, force: true });
  if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
  else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
});

describe('bus → /ws relay', () => {
  it('relays a status.posted event as {type: interactiveEvent, event} with the payload intact', async () => {
    // The shape interactive's service posts while a doc generates (draft-events.ts vocabulary).
    const payload = {
      document_id: 'doc-relay-1',
      state: 'working',
      message: 'drafting section 2 of 5 ✓',
      nested: { list: [1, 2, 3], flag: null },
    };
    publish(STATUS_POSTED, 'wicked-interactive', 'status', payload);

    const frame = await waitForFrame(
      (f) => f['type'] === 'interactiveEvent',
      'the interactiveEvent envelope',
    );
    // ONE envelope type, the original event NESTED — not spread, not renamed.
    expect(Object.keys(frame).sort()).toEqual(['event', 'type']);
    const event = frame['event'] as Record<string, unknown>;
    expect(event['event_type']).toBe(STATUS_POSTED);
    expect(event['domain']).toBe('wicked-interactive');
    expect(event['subdomain']).toBe('status');
    // The FULL payload survives, nested values and all — no field renaming anywhere.
    expect(event['payload']).toEqual(payload);
    // And the bus row's own envelope fields ride along, so a consumer can order/dedupe.
    expect(typeof event['event_id']).toBe('number');
    expect(typeof event['emitted_at']).toBe('number');
  });

  it('preserves ordering as received', async () => {
    for (const n of [1, 2, 3]) {
      publish(STATUS_POSTED, 'wicked-interactive', 'status', {
        document_id: 'doc-order',
        seq: n,
      });
    }
    await waitForFrame(
      (f) =>
        f['type'] === 'interactiveEvent' &&
        ((f['event'] as { payload?: { seq?: number; document_id?: string } }).payload?.seq === 3),
      'the third ordered status frame',
    );
    const seqs = frames
      .filter((f) => f['type'] === 'interactiveEvent')
      .map((f) => (f['event'] as { payload?: { seq?: number; document_id?: string } }).payload)
      .filter((p) => p?.document_id === 'doc-order')
      .map((p) => p?.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('does NOT relay a non-interactive bus event type', async () => {
    publish('wicked.qe.gate.passed', 'qe', 'gate', { run_id: 'qe-run-1', gate_verdict: 'PASS' });
    // A marker interactive event published AFTER it: once the marker has arrived, the qe event —
    // emitted first, same subscription, same cursor — has had its chance and demonstrably didn't.
    publish(STATUS_POSTED, 'wicked-interactive', 'status', { document_id: 'doc-marker' });

    await waitForFrame(
      (f) =>
        f['type'] === 'interactiveEvent' &&
        (f['event'] as { payload?: { document_id?: string } }).payload?.document_id ===
          'doc-marker',
      'the marker frame that follows the qe event',
    );
    const relayedTypes = frames
      .filter((f) => f['type'] === 'interactiveEvent')
      .map((f) => (f['event'] as { event_type: string }).event_type);
    expect(relayedTypes).not.toContain('wicked.qe.gate.passed');
    expect(relayedTypes.every((t) => t.startsWith('wicked.interactive.'))).toBe(true);
  });
});

describe('POST /projects/:projectId/interactive-events (the UI-emittable direction)', () => {
  it('puts a whitelisted event on the bus with interactive envelope conventions', async () => {
    // An independent probe on the same temp db — the bus is the assertion target, not the relay.
    const seen: Array<Record<string, unknown>> = [];
    const probe = bus.subscribe({
      db: bus.openDb({ db_path: busDb }),
      plugin: 'test-emit-probe',
      filter: `${FEEDBACK_SUBMITTED}@wicked-interactive`,
      cursor_init: 'oldest',
      pollIntervalMs: 25,
      maxRetries: 0,
      handler: (e) => {
        seen.push(e as unknown as Record<string, unknown>);
      },
    });
    try {
      const res = await post('/projects/proj-1/interactive-events', {
        type: FEEDBACK_SUBMITTED,
        payload: { document_id: 'doc-relay-1', items: [{ selector: '#h1', instruction: 'shorter' }] },
      });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ emitted: true, type: FEEDBACK_SUBMITTED, projectId: 'proj-1' });
      expect(typeof res.json['idempotencyKey']).toBe('string');

      const start = Date.now();
      while (seen.length === 0 && Date.now() - start < 8000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(seen.length, 'the emitted event must land on the bus').toBe(1);
      const landed = seen[0]!;
      expect(landed['event_type']).toBe(FEEDBACK_SUBMITTED);
      expect(landed['domain']).toBe('wicked-interactive');
      // Subdomain derived from interactive's own type grammar (wicked.interactive.<sub>.<verb>).
      expect(landed['subdomain']).toBe('feedback');
      expect(landed['producer_id']).toBe('wi-crew');
      expect(landed['idempotency_key']).toBe(res.json['idempotencyKey']);
      const payload = landed['payload'] as Record<string, unknown>;
      expect(payload['document_id']).toBe('doc-relay-1');
      // Server-stamped, not caller-supplied (task #88) — plus interactive's `ts` convention.
      expect(payload['project_id']).toBe('proj-1');
      expect(typeof payload['actor']).toBe('string');
      expect(typeof payload['ts']).toBe('string');
    } finally {
      await probe.stop();
    }
  });

  it('refuses a caller-supplied project_id/actor override — the daemon states both', async () => {
    const res = await post('/projects/proj-2/interactive-events', {
      type: 'wicked.interactive.status.requested',
      payload: { project_id: 'spoofed', actor: 'root', document_id: 'doc-spoof' },
    });
    expect(res.status).toBe(202);
    const frame = await waitForFrame(
      (f) =>
        f['type'] === 'interactiveEvent' &&
        (f['event'] as { payload?: { document_id?: string } }).payload?.document_id === 'doc-spoof',
      'the echoed status.requested frame',
    );
    const payload = (frame['event'] as { payload: Record<string, unknown> }).payload;
    expect(payload['project_id']).toBe('proj-2');
    expect(payload['actor']).not.toBe('root');
  });

  it('rejects a non-whitelisted type with 400 naming the whitelist', async () => {
    const res = await post('/projects/proj-1/interactive-events', {
      type: 'wicked.interactive.doc.deleted',
      payload: {},
    });
    expect(res.status).toBe(400);
    expect(String(res.json['error'])).toContain('wicked.interactive.doc.deleted');
    expect(res.json['allowed']).toEqual([...EMITTABLE_TYPES]);
    expect(res.json['allowed']).toContain(FEEDBACK_SUBMITTED);
    expect(res.json['allowed']).toContain('wicked.interactive.status.requested');
  });

  it('rejects a malformed body with 400 (strict: no unknown keys)', async () => {
    expect((await post('/projects/proj-1/interactive-events', { payload: {} })).status).toBe(400);
    expect(
      (await post('/projects/proj-1/interactive-events', { type: FEEDBACK_SUBMITTED, junk: 1 }))
        .status,
    ).toBe(400);
  });
});

describe('seam disabled', () => {
  it('still registers the route and answers 503 — never a 404', async () => {
    const app2 = await createServer(mockAdapter, {
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
    });
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const addr = app2.server.address();
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1/projects/proj-1/interactive-events`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: FEEDBACK_SUBMITTED, payload: {} }),
      });
      expect(res.status).toBe(503);
      // …and the whitelist check still runs ahead of it: a bad type is the caller's bug either way.
      const bad = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'wicked.interactive.nope', payload: {} }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await app2.close();
    }
  });
});
