// Route-level branches of `GET /runs/:id/gate` (FINDING-051).
//
// `tests/gate-cache.test.ts` pins the fold; this pins what the ROUTE does with it, which is a
// separate question and the one CI caught: the first cut replayed the event log on every cache
// miss, so on a build whose addon predates the `runEvents` binding a plainly-finished run answered
// 503 "history unavailable" instead of the 404 it had always answered. The status read that fixes
// it is not defensive padding — it is the only thing that distinguishes "there is no gate" from
// "there is a gate and I cannot read it", and skipping it collapsed the two.
//
// The two engine reads are stubbed rather than driven through a real run because the branch matrix
// is a cross-product of run status and binding presence, and the absent binding is a property of
// the installed addon — not something a live engine can be asked to have.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, afterEach, beforeAll, beforeEach, expect, describe, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { RecordedEvent, SessionView } from '../../src/core/types.js';

const PARKED = 'parked-run';
const FINISHED = 'finished-run';
const PROMPT = 'Approve unit 2 before it runs: design';

/** A `sessionsDetail()` view reduced to the one field this route reads. */
function view(id: string, status: string): SessionView {
  return { session: { id, status }, units: [] } as unknown as SessionView;
}

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

/** What the stubbed `runEvents` answers, and how many times it was asked. */
let events: RecordedEvent[] | null;
let eventReads: number;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-route-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });

  adapter.sessionsDetail = async () => [
    view(PARKED, 'awaiting_human'),
    view(FINISHED, 'completed'),
  ];
  adapter.runEvents = async () => {
    eventReads += 1;
    return events;
  };
});

// A fresh server per case, because `createServer` owns the `GateCache` and a successful replay
// ADOPTS its result into it (that is the point — the next poll should be free). Sharing one server
// would therefore let the replay case pre-warm the cases after it, and they would pass on a cache
// hit while asserting nothing about the code path they name. Every case here starts cold, which is
// also the only state FINDING-051 is about.
beforeEach(async () => {
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await app.close();
});

afterAll(() => {
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function getGate(id: string) {
  eventReads = 0;
  const res = await fetch(`${baseUrl}/api/v1/runs/${id}/gate`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /runs/:id/gate', () => {
  it('404s an unknown run without reading any history', async () => {
    events = [];
    const res = await getGate('no-such-run');
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('Run not found');
    expect(eventReads, 'a run that does not exist has no log to replay').toBe(0);
  });

  // The regression CI caught. Asserted on the build that CANNOT read the log (`events = null`),
  // because that is where the wrong answer was: a completed run is knowably gateless from its
  // status alone, so the missing binding must not enter into it.
  it('404s a run that is not awaiting a human, on a build with no event-log binding', async () => {
    events = null;
    const res = await getGate(FINISHED);
    expect(res.status, 'a finished run has no gate — a fact its status already settles').toBe(404);
    expect(res.body['error']).toBe('No open gate for this run');
    expect(eventReads, 'and settling it from status must not cost a replay').toBe(0);
  });

  it('serves the recorded prompt for a parked run whose cache is cold', async () => {
    events = [
      { type: 'sessionStarted', session: PARKED, ts: 1, seq: 0 } as RecordedEvent,
      { type: 'awaitingHuman', session: PARKED, ord: 2, prompt: PROMPT, ts: 1_785_614_004_730, seq: 0 } as RecordedEvent,
    ];
    const res = await getGate(PARKED);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runId: PARKED, ord: 2, prompt: PROMPT, lifecycle: 'open' });
    // Event time, not replay time: studio sorts open gates newest-first on this field, so stamping
    // a replay with `Date.now()` would collapse every rebuilt gate to the restart instant.
    expect(res.body['receivedAt']).toBe('2026-08-01T19:53:24.730Z');

    // The replay adopts, so the restart costs one read and not one per poll — studio polls this
    // route. Pinned because it is also what forces every case in this file to build its own server.
    const again = await getGate(PARKED);
    expect(again.body).toEqual(res.body);
    expect(eventReads, 'an adopted gate is served from cache thereafter').toBe(0);
  });

  it('503s — naming the missing binding — when a parked run genuinely cannot be read', async () => {
    events = null;
    const res = await getGate(PARKED);
    expect(res.status).toBe(503);
    // The operator's remedy is to upgrade, so the body has to say so. "No open gate" here would be
    // a lie about a run that is, at this moment, holding for them.
    expect(String(res.body['error'])).toMatch(/event-log read binding/);
  });

  it('404s a parked run whose history records no gate (pre-log runs)', async () => {
    // `a338d177-…` in the wild: parked, but it ran before the event log existed, so its prompt is
    // genuinely gone. Distinct from the 503 above — nothing is broken, the answer is just absent.
    events = [{ type: 'sessionStarted', session: PARKED, ts: 1, seq: 0 } as RecordedEvent];
    const res = await getGate(PARKED);
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('No open gate for this run');
    expect(eventReads, 'a parked run is the one case worth replaying').toBe(1);
  });
});
