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
    // 1. Upstream: write 200 SSE headers then stall
    const upstream = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' });
      res.flushHeaders(); // push headers without ending the response — real SSE pattern
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

    // 3. Fastify proxy app; stateHome = temp dir so projectDocsRoot returns a well-formed path
    const app = Fastify({ logger: false });
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
        // Give the ECONNRESET time to propagate through the proxy to the upstream
        setTimeout(resolve, 250);
      });
      req.end();
    });

    // 5. Cleanup (close after assertions so unhandled rejections fire before close)
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
    await new Promise<void>((r) => upstream.close(() => r()));

    // The client received the proxied 200.
    expect(got200).toBe(true);
    // If forward() had rejected with ECONNRESET, vitest would catch an unhandledRejection and fail
    // the test. Reaching here without a vitest-caught rejection means the suppression worked.
  }, 8000);

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

    // The bridge crashed without the client disconnecting — forward() must reject → 5xx
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
