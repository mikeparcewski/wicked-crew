// Integration test: prove the TERMINAL WEB BRIDGE end-to-end THROUGH the daemon.
//
// Mirrors wicked-core-ts's smoke-terminal.mjs, but drives everything over the
// daemon's REST + per-terminal WS surface instead of calling core-ts directly:
//   1. boot the daemon in-process against the REAL engine (spawnStub Core — the
//      PTY is real regardless of the stub dispatcher), connect a /ws observer
//   2. POST /api/v1/terminals {cmd:["cat"], governed:false} → a terminal id
//   3. open the dedicated WS ws://…/ws/terminals/:id
//   4. send "hi-web\n"; assert the socket receives RAW bytes containing "hi-web"
//      (`cat` echoes stdin back through the PTY)
//   5. POST /api/v1/terminals/:id/close; assert cleanup:
//        - the dedicated socket closes (terminalExited → hub closes it)
//        - terminalOpened{id} + terminalExited{id} were broadcast on /ws
//        - a second close 404s (terminal is gone) and the hub has no sockets
//
// Deterministic + offline: force the lexical memory embedder so nothing downloads.
// `cat`/`governed:false` mirrors the proven smoke path (the loud, opt-in operator
// shell, DES-TERMINAL-001 §7) — the bridge, not governance, is under test here.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

interface Frame {
  type: string;
  id?: string;
  [k: string]: unknown;
}

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;
let port: number;
let ws: WebSocket; // the general /ws observer (verbatim CoreEvent frames)

const frames: Frame[] = [];
const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void; timer: NodeJS.Timeout }> =
  [];

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

const has = (pred: (f: Frame) => boolean): boolean => frames.some(pred);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-term-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

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
  removeScratch(dir);
});

describe('terminal web bridge over core-ts (real PTY)', () => {
  let termId: string;
  let termWs: WebSocket;
  const outChunks: Buffer[] = [];
  const decoded = (): string => Buffer.concat(outChunks).toString('utf8');

  it('POST /terminals opens a `cat` PTY and returns its id', async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: dir, cmd: ['cat'], cols: 80, rows: 24, governed: false }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe('string');
    expect(body.id.length).toBeGreaterThan(0);
    termId = body.id;
  });

  it('broadcasts terminalOpened{id} on the general /ws stream', async () => {
    const opened = await waitForFrame(
      (f) => f.type === 'terminalOpened' && f.id === termId,
      'terminalOpened',
    );
    expect(opened.id).toBe(termId);
  });

  it('the dedicated WS receives raw bytes echoed by the PTY (write→echo round-trip)', async () => {
    termWs = new WebSocket(`ws://127.0.0.1:${port}/ws/terminals/${encodeURIComponent(termId)}`);
    termWs.binaryType = 'nodebuffer';
    termWs.on('message', (data: Buffer) => {
      outChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    });
    await new Promise<void>((resolve, reject) => {
      termWs.on('open', () => resolve());
      termWs.on('error', reject);
    });

    // Send keystrokes as the browser would (xterm.onData → ws.send). `cat` echoes
    // stdin back through the PTY → the daemon decodes the terminalOutput bytes and
    // forwards them RAW to this socket.
    termWs.send('hi-web\n');

    const deadline = Date.now() + 10000;
    while (!decoded().includes('hi-web')) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for "hi-web" echo; got ${JSON.stringify(decoded())}`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(decoded()).toContain('hi-web');
  });

  it('POST /terminals/:id/close tears the PTY down and closes the dedicated socket', async () => {
    const socketClosed = new Promise<void>((resolve) => termWs.on('close', () => resolve()));

    const res = await fetch(`${baseUrl}/api/v1/terminals/${encodeURIComponent(termId)}/close`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);

    // terminalExited fires → the hub closes the browser socket.
    await waitForFrame((f) => f.type === 'terminalExited' && f.id === termId, 'terminalExited');
    await socketClosed;
    expect(termWs.readyState).toBe(WebSocket.CLOSED);
    expect(has((f) => f.type === 'terminalExited' && f.id === termId)).toBe(true);
  });

  it('cleanup: resize of the now-gone terminal 404s (its id left the registry)', async () => {
    // resizeTerminal rejects an unknown id (index.d.ts) — after close the PTY is
    // gone from the engine's registry, so a resize on its id is a 404, not a 200.
    const res = await fetch(`${baseUrl}/api/v1/terminals/${encodeURIComponent(termId)}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    expect(res.status).toBe(404);
  });

  it('resize validates its body (cols/rows required, positive)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/terminals/whatever/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
