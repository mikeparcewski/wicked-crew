// The /ws relay is ALLOWLIST-FREE: the daemon's single CoreEvent subscription fans every parsed
// frame out to all /ws clients verbatim (src/events/bus.ts `broadcast`; DES-STUDIO-001 §2.1/§5.1).
// The in-daemon consumers ahead of the broadcast (gate/elicitation caches, seat health, the
// terminal hub) each switch on specific `type` values and ignore everything else — so an event
// type the daemon has never heard of still reaches the browser.
//
// This suite pins that property for `unitOutputDelta` (wicked-crew-api-types 0.5.1
// `UnitOutputDeltaEvent`), the upcoming live streamed-output frame: it must reach a
// browser-style WS client BYTE-FOR-BYTE unmodified, before any daemon code names it.
// Driven through the REAL server (createServer → fastify-websocket → registerClient →
// broadcast) over a mock adapter whose captured onEvent listener stands in for the engine
// pump — the same seam the daemon's single subscription feeds.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent, SystemSettings, UnitOutputDeltaEvent } from '../src/core/types.js';

type Listener = (event: CoreEvent) => void;

// createServer applies worker_config_root to process.env at boot; keep the env clean.
const savedWorkerHome = process.env['WICKED_WORKER_HOME'];

const listeners = new Set<Listener>();

/** Stand-in for the engine pump: push one frame through every registered server listener. */
function emit(event: CoreEvent): void {
  for (const l of listeners) l(event);
}

/** The minimal adapter surface createServer touches at boot (settings, hydrate guard, onEvent). */
const mockAdapter = {
  getSettings: async (): Promise<SystemSettings> => ({ graphNodeLimit: 150 }),
  projectsSupported: (): boolean => false,
  onEvent: (l: Listener): (() => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
} as unknown as CoreAdapter;

let app: Awaited<ReturnType<typeof createServer>>;
let ws: WebSocket;

/** Raw wire strings as received — equality against these is the "unmodified" proof. */
const raw: string[] = [];
const waiters: Array<{ pred: (s: string) => boolean; resolve: (s: string) => void; timer: NodeJS.Timeout }> = [];

function onMessage(s: string): void {
  raw.push(s);
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w && w.pred(s)) {
      clearTimeout(w.timer);
      w.resolve(s);
      waiters.splice(i, 1);
    }
  }
}

function waitForRaw(pred: (s: string) => boolean, label: string, ms = 5000): Promise<string> {
  const found = raw.find(pred);
  if (found !== undefined) return Promise.resolve(found);
  return new Promise<string>((resolve, reject) => {
    // The timeout handler deregisters its own waiter before rejecting — a match arriving after
    // the timeout must not "resolve" an already-rejected promise, and a never-matching waiter
    // must not linger in the array for the rest of the suite.
    const waiter = {
      pred,
      resolve,
      timer: setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`timed out (${ms}ms) waiting for: ${label}`));
      }, ms),
    };
    waiters.push(waiter);
  });
}

beforeAll(async () => {
  app = await createServer(mockAdapter, { projectEvents: { disabled: true } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (data: Buffer | string) => onMessage(data.toString()));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
}, 15000);

afterAll(async () => {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  await app.close();
  if (savedWorkerHome === undefined) delete process.env['WICKED_WORKER_HOME'];
  else process.env['WICKED_WORKER_HOME'] = savedWorkerHome;
});

describe('/ws relay pass-through (no allowlist)', () => {
  it('relays a unitOutputDelta frame to a WS client byte-for-byte unmodified', async () => {
    // Checked against the 0.5.1 contract interface (`satisfies` keeps the literal's anonymous
    // type, which is what lets it flow into the CoreEvent-typed relay seam — the same
    // field-by-field compatibility the wire-contract drift guard asserts at type level).
    const frame = {
      type: 'unitOutputDelta',
      session: 'run-delta-1',
      ord: 2,
      attempt: 0,
      text: 'chunk 1 of streamed worker output\nwith a newline and unicode ✓',
    } satisfies UnitOutputDeltaEvent;
    emit(frame);

    const received = await waitForRaw((s) => s.includes('"unitOutputDelta"'), 'unitOutputDelta frame');
    // Byte-for-byte: broadcast() stringifies the SAME object the listener got, so any dropped,
    // added (e.g. a spurious project_id tag), or reordered field breaks this exact-string match.
    expect(received).toBe(JSON.stringify(frame));
    // And the parsed shape is exactly the contract's field set — nothing else.
    expect(JSON.parse(received)).toEqual({
      type: 'unitOutputDelta',
      session: 'run-delta-1',
      ord: 2,
      attempt: 0,
      text: 'chunk 1 of streamed worker output\nwith a newline and unicode ✓',
    });
  });

  it('relays an arbitrary unknown event type verbatim (the general no-allowlist property)', async () => {
    // A type no daemon code has ever named, with a nested payload the permissive CoreEvent only
    // covers via its index signature. If any relay stage filtered on known types — or re-built
    // frames field-by-field — this is the frame that would vanish or arrive mangled.
    const frame: CoreEvent = {
      type: 'someFutureEvent',
      session: 'run-future-1',
      nested: { list: [1, 2, 3], flag: null },
    };
    emit(frame);

    const received = await waitForRaw((s) => s.includes('"someFutureEvent"'), 'someFutureEvent frame');
    expect(received).toBe(JSON.stringify(frame));
  });
});
