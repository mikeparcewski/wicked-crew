// proxy-routes.ts — clientGone suppression (#622)
//
// When the CLIENT closes the connection first (reply.raw 'close' → clientGone = true) and the
// upstream bridge then emits aborted / ECONNRESET / ERR_STREAM_PREMATURE_CLOSE, the proxy must
// RESOLVE (not reject) and log at info level (≤30). An upstream error while the client is still
// attached must still reject so callers can surface a 502.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import Fastify from 'fastify';

import {
  isClientGoneError,
  PROXY_SEAT_UNAVAILABLE_REASON,
  registerInteractiveProxy,
} from '../src/interactive/proxy-routes.js';
import type { DocGroundingStore } from '../src/interactive/doc-grounding.js';
import type { InteractiveBridgePool, LiveBridge } from '../src/interactive/bridge-pool.js';
import type { ProjectSettingsStore } from '../src/projects/settings.js';
import type { CoreAdapter } from '../src/core/adapter.js';

// ── Unit: the error classifier ─────────────────────────────────────────────────────────────────

describe('isClientGoneError', () => {
  it('returns true for ECONNRESET, ERR_STREAM_PREMATURE_CLOSE, and "aborted" message variants', () => {
    expect(isClientGoneError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isClientGoneError(Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))).toBe(true);
    expect(isClientGoneError(new Error('aborted'))).toBe(true);
    expect(isClientGoneError(new Error('Aborted by client'))).toBe(true);
  });

  it('returns false for ECONNREFUSED, ENOENT, and generic errors', () => {
    expect(isClientGoneError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isClientGoneError(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(false);
    expect(isClientGoneError(new Error('Internal Server Error'))).toBe(false);
    expect(isClientGoneError(new Error('socket hang up'))).toBe(false);
  });

  it('handles non-Error values without throwing', () => {
    expect(isClientGoneError(null)).toBe(false);
    expect(isClientGoneError(undefined)).toBe(false);
    expect(isClientGoneError('aborted')).toBe(true);
    expect(isClientGoneError(42)).toBe(false);
  });
});

// ── Integration: forward() resolves when client disconnects first ──────────────────────────────
//
// We spin up a real (in-process) upstream HTTP server that sends 200 headers and stalls (SSE-style
// never-ending stream). The test client connects to the Fastify proxy, which forwards to the
// upstream. Once the proxied 200 arrives, the client socket is destroyed (browser-tab-close). The
// upstream sees ECONNRESET. The forward() handler must resolve — NOT reject — so no unhandled
// rejection lands in vitest.

describe('forward() — client-disconnect suppression (real HTTP servers)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crew-proxy-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('client destroys socket after 200 headers → forward() resolves, no unhandled rejection', async () => {
    // 1. Upstream: write 200 SSE headers plus an initial keep-alive chunk so the headers
    //    propagate through the pipe to the client (writeHead alone is buffered until data flows).
    const upstream = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' });
      res.write(':keepalive\n\n'); // flush headers through pipe — then stall
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as { port: number }).port;

    // 2. Minimal deps: pool always returns the mock upstream; settings return no explicit root
    const pool: InteractiveBridgePool = {
      ensure: async (): Promise<LiveBridge> => ({ host: '127.0.0.1', port: upstreamPort, pid: 0 }),
    } as unknown as InteractiveBridgePool;
    const settings: ProjectSettingsStore = {
      get: () => ({}),
    } as unknown as ProjectSettingsStore;
    const adapter: CoreAdapter = {} as unknown as CoreAdapter;

    // 3. Fastify proxy app; stateHome = temp dir so projectDocsRoot returns a well-formed path.
    //
    //    The captured log is what makes the suppression FALSIFIABLE (#637). The predecessor of
    //    this assertion was `process.on('unhandledRejection')` + `toHaveLength(0)`, which cannot
    //    fire: the route `await`s forward(), so Fastify owns any rejection and the process never
    //    sees an unhandled one — and after `reply.hijack()` Fastify does not run the error handler
    //    either, so neither hook observes the failure. Deleting all four `clientGone` guards left
    //    the suite 6/6 green (re-confirmed on this head: neutralising the guards passes both a
    //    rejection listener and an error handler).
    //
    //    The one observable INSIDE the guard is its own `req.log.info` line, so this test captures
    //    the app log: the suppression is proven by the info line's PRESENCE, and the absence of
    //    any error-level line. With the guards removed, the info line is never written and the
    //    first assertion fails.
    const logLines: { level: number; msg?: string }[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        stream: {
          write: (line: string) => {
            try { logLines.push(JSON.parse(line) as { level: number; msg?: string }); }
            catch { /* non-JSON line: not something we assert on */ }
          },
        },
      },
    });
    registerInteractiveProxy(app, adapter, { pool, settings, stateHome: dir });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const appPort = (app.server.address() as { port: number }).port;

    // 4. Client makes a GET (not a create — takes the forward() branch, not forwardCreate)
    //    and destroys the socket once the proxied 200 header arrives.
    let got200 = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout: proxied 200 never arrived')), 4000);
      const req = httpRequest({ host: '127.0.0.1', port: appPort, path: '/api/v1/projects/default/interactive/gen', method: 'GET' });
      req.on('error', () => {/* expected after destroy */});
      req.on('response', (res) => {
        got200 = res.statusCode === 200;
        // We got the forwarded 200 — now simulate tab close
        req.destroy();
        clearTimeout(timer);
        resolve();
      });
      req.end();
    });

    // 5. Wait for the guard's own line rather than for a fixed interval: the ECONNRESET takes as
    //    long as the host is busy, and a sleep long enough on an idle machine is a flake on a
    //    loaded one.
    const suppressed = (): { level: number; msg?: string }[] => logLines.filter(
      (l) => l.level === 30 && typeof l.msg === 'string' && l.msg.startsWith('proxy: client disconnected'),
    );
    const deadline = Date.now() + 4000;
    while (suppressed().length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    await app.close();
    await new Promise<void>((r) => upstream.close(() => r()));

    expect(got200).toBe(true);
    // The guard ran: its info line is the only place this message is written (proxy-routes.ts,
    // inside `if (clientGone && isClientGoneError(err))`). No line ⇒ no suppression.
    expect(suppressed().length).toBeGreaterThanOrEqual(1);
    // And the disconnect was not ALSO reported as a failure.
    expect(logLines.filter((l) => l.level >= 50).map((l) => l.msg)).toEqual([]);
  }, 12_000);

  it('upstream error WITHOUT client close → forward() rejects (surfaces as 502)', async () => {
    // An upstream that immediately errors with ECONNRESET (refuses the connection)
    const upstream = createHttpServer((_req, res) => {
      res.socket?.destroy(); // immediately destroy — simulates crashed bridge
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const pool: InteractiveBridgePool = {
      ensure: async (): Promise<LiveBridge> => ({ host: '127.0.0.1', port: upstreamPort, pid: 0 }),
    } as unknown as InteractiveBridgePool;
    const settings: ProjectSettingsStore = { get: () => ({}) } as unknown as ProjectSettingsStore;
    const adapter: CoreAdapter = {} as unknown as CoreAdapter;

    const app = Fastify({ logger: false });
    registerInteractiveProxy(app, adapter, { pool, settings, stateHome: dir });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const appPort = (app.server.address() as { port: number }).port;

    // Client stays connected — upstream destroys the socket. Expect a 5xx response.
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: appPort, path: '/api/v1/projects/default/interactive/gen', method: 'GET' });
      req.on('error', () => resolve(0)); // connection-level error
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.end();
    });

    await app.close();
    await new Promise<void>((r) => upstream.close(() => r()));

    // The bridge crashed without the client disconnecting — forward() must reject → 5xx.
    // The proxy returns 500 (Fastify error handler) when the upstream errors before sending headers.
    expect(status).toBeGreaterThanOrEqual(500);
  }, 8000);
});

// ── forwardCreate() — clisJson unavailable-seat 400 before the bridge (#631) ──────────────────
//
// The seat validation fires BEFORE any bytes reach the bridge, so this test needs no upstream.
// A mock pool that returns any LiveBridge is enough (pool.ensure is called before body reading,
// but the bridge is never contacted when the 400 fires first).

describe('forwardCreate() — clisJson unavailable-seat 400 before bridge (#631)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crew-proxy-seat-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('doc create body with clisJson naming an absent seat → 400, bridge never contacted', async () => {
    const pool: InteractiveBridgePool = {
      ensure: async (): Promise<LiveBridge> => ({ host: '127.0.0.1', port: 9, pid: 0 }),
    } as unknown as InteractiveBridgePool;
    const settings: ProjectSettingsStore = { get: () => ({}) } as unknown as ProjectSettingsStore;
    const adapter: CoreAdapter = {} as unknown as CoreAdapter;
    // Grounding must be set for the doc-create path to engage.
    const grounding: DocGroundingStore = {
      beginCreate: () => 0,
      settleCreate: () => {},
      cancelCreate: () => {},
    } as unknown as DocGroundingStore;
    // Roster with one known seat — 'no-such-seat' is absent, so validation fires.
    const roster = () => [{ key: 'known-seat-xyz' }];

    const app = Fastify({ logger: false });
    registerInteractiveProxy(app, adapter, { pool, settings, stateHome: dir, grounding, roster });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const appPort = (app.server.address() as { port: number }).port;

    const res = await fetch(
      `http://127.0.0.1:${appPort}/api/v1/projects/default/interactive/api/docs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ brief: 'test', clisJson: JSON.stringify([{ key: 'no-such-seat' }]) }),
      },
    );
    const body = (await res.json()) as { error?: string };

    await app.close();

    expect(res.status).toBe(400);
    expect(body.error).toBe(PROXY_SEAT_UNAVAILABLE_REASON);
  }, 8000);
});
