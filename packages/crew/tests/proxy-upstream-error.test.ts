// crew#1359 (xreview r1): the interactive proxy hijacks its reply, so the daemon's onSend hook never sees what the
// bridge answered. An upstream server error is sanitized like the daemon's own before it is written: a 500 answers a
// code and a generic message, another 5xx keeps its body with file paths taken out, a success streams unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer, type Server } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerInteractiveProxy } from '../src/interactive/proxy-routes.js';
import { INTERNAL_ERROR_MESSAGE } from '../src/api/server-error-body.js';
import type { InteractiveBridgePool, LiveBridge } from '../src/interactive/bridge-pool.js';
import type { ProjectSettingsStore } from '../src/projects/settings.js';
import type { CoreAdapter } from '../src/core/adapter.js';

const DOC = '/home/someone/.wicked-crew/state/projects/default/docs/gen.html';
const ABSOLUTE = /\/home\/|\.wicked-crew/u;

let dir: string;
let upstream: Server;
let app: FastifyInstance;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crew-proxy-upstream-error-'));
  upstream = createHttpServer((req, res) => {
    if (req.url?.includes('boom500')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `cannot read ${DOC}`, docId: 'gen' }));
    } else if (req.url?.includes('boom503')) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(`renderer down: ${DOC} locked`);
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`fine ${DOC}`);
    }
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as { port: number }).port;
  const pool = { ensure: async (): Promise<LiveBridge> => ({ host: '127.0.0.1', port, pid: 0 }) } as unknown as InteractiveBridgePool;
  const settings = { get: () => ({}) } as unknown as ProjectSettingsStore;
  app = Fastify({ logger: false });
  registerInteractiveProxy(app, {} as unknown as CoreAdapter, { pool, settings, stateHome: dir });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('an upstream server error through the interactive proxy', () => {
  it('a bridge 500 answers the generic body (identifiers kept), no path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/default/interactive/boom500' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(ABSOLUTE);
    expect(res.json()).toMatchObject({ error: INTERNAL_ERROR_MESSAGE, code: 'internal_error', docId: 'gen' });
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
  });

  it('a bridge 503 keeps its message with the path taken out', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/default/interactive/boom503' });
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe('renderer down: <path> locked');
  });

  it('a success is forwarded unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/default/interactive/ok' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`fine ${DOC}`);
  });
});
