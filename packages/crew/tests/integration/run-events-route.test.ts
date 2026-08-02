// `GET /runs/:id/events` — the durable log's first general reader (FINDING-057).
//
// The distinction this route has to keep straight is the same one the gate route learned the hard
// way: a run with no history and a build that cannot read history are different answers, and
// collapsing them reports a capability gap as a fact about the run. Here it is sharper, because an
// empty history is legitimately common — every run that predates the log has one.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, expect, describe, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import type { CoreEvent } from '../../src/core/types.js';

const RUN = 'run-with-history';

const HISTORY: CoreEvent[] = [
  { type: 'sessionStarted', session: RUN, ts: 1 } as CoreEvent,
  { type: 'unitDistributed', session: RUN, ord: 1, agreementPct: 33, ts: 2 } as CoreEvent,
  { type: 'gateDecided', session: RUN, ord: 1, allow: true, ts: 3 } as CoreEvent,
  { type: 'gateDecided', session: RUN, ord: 2, allow: false, ts: 4 } as CoreEvent,
  { type: 'sessionCompleted', session: RUN, ts: 5 } as CoreEvent,
];

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

/** What the stubbed `runEvents` answers. Reassigned per case. */
let events: CoreEvent[] | null = HISTORY;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'run-events-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  // The route's existence check reads IDs only, so that is what the stub supplies.
  adapter.sessions = async () => [RUN];
  adapter.runEvents = async () => events;

  // One server for the whole file: this route holds no cache, so nothing a case does can leak
  // into the next (unlike the gate route, whose replay adopts).
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /runs/:id/events', () => {
  it('returns the run history in log order', async () => {
    events = HISTORY;
    const res = await get(`/api/v1/runs/${RUN}/events`);
    expect(res.status).toBe(200);
    expect(res.body['total']).toBe(5);
    expect(res.body['returned']).toBe(5);
    expect((res.body['events'] as CoreEvent[]).map((e) => e.type)).toEqual([
      'sessionStarted',
      'unitDistributed',
      'gateDecided',
      'gateDecided',
      'sessionCompleted',
    ]);
  });

  it('filters by type, and reports the unfiltered total alongside', async () => {
    events = HISTORY;
    const res = await get(`/api/v1/runs/${RUN}/events?type=gateDecided`);
    expect(res.status).toBe(200);
    expect(res.body['returned']).toBe(2);
    // `total` is the whole history, not the filtered slice — a caller narrowing a search needs to
    // know how much it did not ask for, or it cannot tell an empty filter from an empty run.
    expect(res.body['total']).toBe(5);
  });

  it('accepts a comma-separated type list', async () => {
    events = HISTORY;
    const res = await get(`/api/v1/runs/${RUN}/events?type=sessionStarted,sessionCompleted`);
    expect(res.body['returned']).toBe(2);
  });

  it('accepts a repeated type param, which fastify parses as an array', async () => {
    // `?type=a&type=b` is the other obvious spelling of the case above, and the one that
    // arrives as `string[]`. Treating the query value as a bare string 500s here.
    events = HISTORY;
    const res = await get(
      `/api/v1/runs/${RUN}/events?type=sessionStarted&type=sessionCompleted`,
    );
    expect(res.status).toBe(200);
    expect(res.body['returned']).toBe(2);
  });

  it('treats an empty type filter as no filter', async () => {
    // `?type=` is what a caller sends when it builds the query from an empty variable. Reading
    // it as "match nothing" would answer with an empty list indistinguishable from a run with
    // no history — the exact confusion this route exists to remove.
    events = HISTORY;
    const res = await get(`/api/v1/runs/${RUN}/events?type=`);
    expect(res.status).toBe(200);
    expect(res.body['returned']).toBe(5);
  });

  it('answers 200 with an empty list for a run that genuinely recorded nothing', async () => {
    // Pre-log runs. Not an error, and must not be dressed as one.
    events = [];
    const res = await get(`/api/v1/runs/${RUN}/events`);
    expect(res.status).toBe(200);
    expect(res.body['total']).toBe(0);
    expect(res.body['events']).toEqual([]);
  });

  it('503s — naming the missing binding — rather than reporting an empty history', async () => {
    events = null;
    const res = await get(`/api/v1/runs/${RUN}/events`);
    expect(res.status).toBe(503);
    expect(String(res.body['error'])).toMatch(/event-log read binding/);
    // The distinction that matters: the case above returns 200 + [] for the same-looking absence.
  });

  it('404s an unknown run', async () => {
    events = HISTORY;
    const res = await get('/api/v1/runs/no-such-run/events');
    expect(res.status).toBe(404);
    expect(res.body['error']).toBe('Run not found');
  });
});
