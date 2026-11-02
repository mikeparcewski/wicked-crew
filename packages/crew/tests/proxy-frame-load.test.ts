// proxy-routes.ts — an editor plugin's frame cannot navigate itself to a proxied document.
//
// Studio's shell lets any of its frames point at the interactive proxy (Document mode needs it). A document served
// there runs with its own policy, not an editor bundle's WebRTC guard, so a sandboxed editor frame (opaque origin, so
// every navigation it starts is `cross-site`) navigating itself to a document would run that document's scripts in a
// fresh realm. The proxy refuses a frame load from another site before the bridge is reached; studio's own frames
// (same-origin), a document's own images and scripts, and requests without `Sec-Fetch-*` are served as before.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import Fastify from 'fastify';

import { CROSS_SITE_FRAME_REFUSED, isCrossSiteFrameLoad, registerInteractiveProxy } from '../src/interactive/proxy-routes.js';
import { registerFrameGuard } from '../src/api/frame-guard.js';
import type { InteractiveBridgePool, LiveBridge } from '../src/interactive/bridge-pool.js';
import type { ProjectSettingsStore } from '../src/projects/settings.js';
import type { CoreAdapter } from '../src/core/adapter.js';

const nav = (site: string, dest = 'iframe'): Record<string, string> => ({ 'sec-fetch-mode': 'navigate', 'sec-fetch-site': site, 'sec-fetch-dest': dest });

describe('isCrossSiteFrameLoad', () => {
  it('is a frame navigation started by another site (an editor frame is always one); nothing else', () => {
    expect(isCrossSiteFrameLoad(nav('cross-site'))).toBe(true);
    for (const dest of ['frame', 'embed', 'object', 'fencedframe', 'IFRAME']) expect(isCrossSiteFrameLoad(nav('cross-site', dest)), dest).toBe(true);
    expect(isCrossSiteFrameLoad(nav('same-origin'))).toBe(false); // studio framing a document
    expect(isCrossSiteFrameLoad(nav('same-site'))).toBe(false); // studio's dev server on another port
    expect(isCrossSiteFrameLoad(nav('none', 'document'))).toBe(false); // opened in its own tab
    expect(isCrossSiteFrameLoad({ 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' })).toBe(false); // a document's own image
    expect(isCrossSiteFrameLoad({})).toBe(false); // no Sec-Fetch-* (an untrustworthy origin): let through
  });
});

describe('the interactive proxy refuses a cross-site frame load before the bridge', () => {
  let dir: string;
  let upstream: Server;
  let upstreamPort = 0;
  let ensured = 0;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crew-proxy-frame-'));
    ensured = 0;
    upstream = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>doc</p>'); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamPort = (upstream.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });
  const app = async (): Promise<ReturnType<typeof Fastify>> => {
    const pool = { ensure: async (): Promise<LiveBridge> => { ensured += 1; return { host: '127.0.0.1', port: upstreamPort, pid: 0 }; } } as unknown as InteractiveBridgePool;
    const settings = { get: () => ({}) } as unknown as ProjectSettingsStore;
    const a = Fastify();
    registerFrameGuard(a, { allowedOrigins: [] });
    registerInteractiveProxy(a, {} as unknown as CoreAdapter, { pool, settings, stateHome: dir });
    await a.ready();
    return a;
  };
  const DOC = '/api/v1/projects/default/interactive/d/x/doc/1';

  it('cross-site frame load: 403 with the reason, the bridge never asked, the frame guard still on the response', async () => {
    const a = await app();
    const res = await a.inject({ method: 'GET', url: DOC, headers: nav('cross-site') });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe(CROSS_SITE_FRAME_REFUSED);
    expect(ensured).toBe(0);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    await a.close();
  });

  it('a page the frame guard lets frame the daemon (studio on localhost:4200) is served; the daemon\'s own or another origin as Referer is not', async () => {
    const a = await app();
    const from = async (referer: string): Promise<number> => (await a.inject({ method: 'GET', url: DOC, headers: { ...nav('cross-site'), referer, host: '127.0.0.1:7701' } })).statusCode;
    expect(await from('http://localhost:4200/projects')).toBe(200);
    expect(await from('http://127.0.0.1:7701/api/v1/editors/acme/1.0.0/entry')).toBe(403); // an editor frame asking for its own URL
    expect(await from('https://elsewhere.example/')).toBe(403);
    expect(await from('not a url')).toBe(403);
    await a.close();
  });

  it('studio framing it (same-origin), its own image (cross-site, not a frame) and a request with no Sec-Fetch-* are served', async () => {
    const a = await app();
    for (const headers of [nav('same-origin'), { 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' }, {}]) {
      const res = await a.inject({ method: 'GET', url: DOC, headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(200);
      expect(res.body).toBe('<p>doc</p>');
    }
    expect(ensured).toBe(3);
    await a.close();
  });
});
