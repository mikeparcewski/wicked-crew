// The attributed docs list's treatment of what the bridge ANSWERS (crew#474 review).
//
// The integration suite (tests/integration/interactive-doc-list.test.ts) proves the list against a
// real child-process bridge that always answers well. This file is the other half: what the route
// does when the bridge's answer is wrong in each way a wire can be wrong — and, above all, that it
// tells a broken BODY from a broken CONNECTION:
//
//   - a COMPLETE body that is not a list of doc summaries (`{}`, `[null]`, `["str"]`, HTML) is the
//     bridge's answer, malformed: a 502 saying exactly which, with NO retry — a retry would only
//     fetch the same malformed answer again and burn the pool's invalidate/restart cycle on it;
//   - a connection that dies WHILE the body is being read is a transport failure like a refused
//     connect: it goes through the same invalidate → ensure → retry once → 502-with-diagnostics
//     path the proxy and the governed delete use, and that 502 says "unreachable", not "malformed".
//
// The bridge is an in-process http server switched per case; the pool is a stub whose `ensure`
// and `invalidate` are spied, so the retry discipline is asserted rather than inferred.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractiveBridgePool, LiveBridge } from '../src/interactive/bridge-pool.js';
import { registerInteractiveDocList } from '../src/interactive/doc-list-routes.js';
import { ProjectSettingsStore } from '../src/projects/settings.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { Project } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

type Mode = 'ok' | 'object' | 'null-row' | 'string-row' | 'not-json' | 'html-404' | 'truncated';

const GOOD_ROW = { name: 'brief', kind: 'doc', head: 1, versions: 1, updated_at: null };
const MALFORMED_LIST = 'wicked-interactive answered GET /api/docs with a malformed list';

let mode: Mode = 'ok';
let hits = 0;
let dir: string;
let bridgeServer: Server;
let app: FastifyInstance;
let base: string;
const ensure = vi.fn<(root: string) => Promise<LiveBridge>>();
const invalidate = vi.fn<(root: string) => void>();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wi-doc-list-routes-'));
  const settingsPath = join(dir, 'project-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ projects: {} }));

  bridgeServer = createServer((req, res) => {
    hits++;
    if (req.method !== 'GET' || !(req.url ?? '').startsWith('/api/docs')) {
      res.writeHead(404).end();
      return;
    }
    switch (mode) {
      case 'ok':
        json(res, 200, [GOOD_ROW]);
        return;
      case 'object':
        json(res, 200, {});
        return;
      case 'null-row':
        json(res, 200, [null]);
        return;
      case 'string-row':
        json(res, 200, ['str']);
        return;
      case 'not-json':
        res.writeHead(200, { 'content-type': 'application/json' }).end('<html>not json</html>');
        return;
      case 'html-404':
        res.writeHead(404, { 'content-type': 'text/html' }).end('<html>Cannot GET /api/docs</html>');
        return;
      case 'truncated':
        // Headers and the first bytes of a body, then the socket is torn down mid-body — what a
        // bridge dying under load (or a body timeout) looks like from the reading side.
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
        res.write('[{"name":"bri', () => res.socket?.destroy());
        return;
    }
  });
  await new Promise<void>((r) => bridgeServer.listen(0, '127.0.0.1', r));
  const addr = bridgeServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const bridge: LiveBridge = { host: '127.0.0.1', port, pid: process.pid };
  ensure.mockImplementation(async () => bridge);

  const pool = { ensure, invalidate, keys: () => [] } as unknown as InteractiveBridgePool;
  const adapter = {
    projectGet: async (id: string): Promise<Project | null> =>
      id === 'p-x'
        ? { id, name: id, description: null, status: 'active', scope: `project:${id}`, created_at: 0, updated_at: 0 }
        : null,
  } as unknown as CoreAdapter;
  app = Fastify({ logger: false });
  registerInteractiveDocList(app, adapter, {
    settings: new ProjectSettingsStore(settingsPath),
    pool,
    env: {},
    home: join(dir, 'home'),
    upstreamTimeoutMs: 5_000,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const bound = app.server.address();
  base = `http://127.0.0.1:${typeof bound === 'object' && bound ? bound.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => bridgeServer.close(() => r()));
  removeScratch(dir);
});

beforeEach(() => {
  hits = 0;
  ensure.mockClear();
  invalidate.mockClear();
});

async function list(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/projects/p-x/interactive/api/docs`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /projects/:projectId/interactive/api/docs — the bridge's answer, validated", () => {
  it('relays a well-formed list, each row stamped with the project — no retry', async () => {
    mode = 'ok';
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body).toEqual([{ ...GOOD_ROW, projectId: 'p-x' }]);
    expect(hits).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('`[null]` is a malformed list → 502, not `[{ projectId }]` with a 200', async () => {
    mode = 'null-row';
    const { status, body } = await list();
    expect(status).toBe(502);
    expect(body['error']).toBe(MALFORMED_LIST);
    expect(String(body['detail'])).toMatch(/row 0 .* null/);
    expect(hits).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('`["str"]` is a malformed list → 502, not a row of char-indexed keys', async () => {
    mode = 'string-row';
    const { status, body } = await list();
    expect(status).toBe(502);
    expect(body['error']).toBe(MALFORMED_LIST);
    expect(String(body['detail'])).toMatch(/row 0 .* a string/);
    expect(hits).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a JSON body that is not a list at all → 502 "non-list body"', async () => {
    mode = 'object';
    const { status, body } = await list();
    expect(status).toBe(502);
    expect(body['error']).toBe('wicked-interactive answered GET /api/docs with a non-list body');
    expect(hits).toBe(1);
  });

  it('a COMPLETE non-JSON body (HTML on the JSON wire) → 502 malformed body, and NO transport retry', async () => {
    mode = 'not-json';
    const { status, body } = await list();
    expect(status).toBe(502);
    expect(body['error']).toBe('wicked-interactive answered GET /api/docs with a malformed body (not JSON)');
    expect(hits).toBe(1);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a connection torn down MID-BODY is a transport failure: invalidate, re-ensure, retry once, then 502 "unreachable"', async () => {
    mode = 'truncated';
    const { status, body } = await list();
    expect(status).toBe(502);
    expect(String(body['error'])).toMatch(/unreachable/);
    expect(String(body['error'])).not.toMatch(/malformed/);
    expect(typeof body['detail']).toBe('string');
    expect(typeof body['first_attempt']).toBe('string');
    expect(hits).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("the bridge's own non-200 is relayed with its status; a non-JSON failure body gets a JSON error in its place", async () => {
    mode = 'html-404';
    const { status, body } = await list();
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'wicked-interactive answered GET /api/docs with HTTP 404' });
    expect(hits).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
