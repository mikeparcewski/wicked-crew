// Integration test: the daemon serves the bundled studio SPA same-origin
// alongside the existing API + WS surfaces (DES-STUDIO-SERVING-001 §3, §6.1).
//
// Fixture: instead of depending on a real vite build, we point the static root
// at a tiny temp `studio/` dir (index.html + one hashed asset). This exercises
// the exact serving/precedence/cache-header wiring with zero build coupling.
//
// Deterministic + offline: stub engine, forced lexical embedder.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

const SHELL = [
  '<!doctype html>',
  '<html>',
  '<head><script type="module" src="/assets/index-abc123.js"></script></head>',
  '<body><div id="root"></div></body>',
  '</html>',
].join('\n');

const ASSET_JS = 'console.log("studio-asset");';

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let studioRoot: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-studio-'));
  studioRoot = join(dir, 'studio');
  mkdirSync(join(studioRoot, 'assets'), { recursive: true });
  writeFileSync(join(studioRoot, 'index.html'), SHELL);
  writeFileSync(join(studioRoot, 'assets', 'index-abc123.js'), ASSET_JS);

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter, { studioRoot });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('studio serving (static + SPA fallback alongside API/WS)', () => {
  it('AC-3: GET / returns the SPA shell (200 text/html, #root + hashed asset)', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<div id="root">');
    expect(res.body).toContain('/assets/index-abc123.js');
  });

  it('AC-4: GET /runs/does-not-exist falls back to the identical shell (200)', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    const deep = await app.inject({ method: 'GET', url: '/runs/does-not-exist' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    expect(deep.body).toBe(root.body);
    expect(deep.body).toContain('<div id="root">');
  });

  it('AC-5: GET /api/v1/health is 200 JSON; GET /api/v1/nope is 404 JSON (not the shell)', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-type']).toMatch(/application\/json/);
    const healthBody = health.json() as { status: string; version: string; ping: string };
    expect(healthBody.status).toBe('ok');
    expect(typeof healthBody.version).toBe('string');

    const nope = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(nope.statusCode).toBe(404);
    expect(nope.headers['content-type']).toMatch(/application\/json/);
    expect(nope.body).not.toContain('<div id="root">');
    expect(nope.json()).toEqual({ error: 'not found' });
  });

  it('AC-6: /assets/* is immutable; / and the SPA fallback are no-cache', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.headers['cache-control']).toBe('no-cache');

    const fallback = await app.inject({ method: 'GET', url: '/deep/link' });
    expect(fallback.headers['cache-control']).toBe('no-cache');
  });

  it('a non-GET to a non-API path is 404 JSON, not the SPA shell', async () => {
    const res = await app.inject({ method: 'POST', url: '/some/random/path' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
    expect(res.json()).toEqual({ error: 'not found' });
  });
});

describe('headless degradation (no bundle present)', () => {
  it('skips static registration and does not crash when studioRoot is absent', async () => {
    const headlessDir = mkdtempSync(join(tmpdir(), 'crew-headless-'));
    const headlessAdapter = new CoreAdapter({
      dbPath: join(headlessDir, 'core.db'),
      stub: true,
    });
    const headlessApp = await createServer(headlessAdapter, {
      studioRoot: join(headlessDir, 'studio'), // does not exist
    });
    await headlessApp.ready();
    try {
      // API still works…
      const health = await headlessApp.inject({ method: 'GET', url: '/api/v1/health' });
      expect(health.statusCode).toBe(200);
      // …and there is no SPA fallback (default 404, no shell).
      const root = await headlessApp.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(404);
      expect(root.body).not.toContain('<div id="root">');
    } finally {
      await headlessApp.close();
      headlessAdapter.close();
      rmSync(headlessDir, { recursive: true, force: true });
    }
  });
});
