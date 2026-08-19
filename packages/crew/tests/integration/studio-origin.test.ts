// Studio-origin recording on bridge start/adopt (crew#298, DES-MERGE-001 §7.13).
//
// interactive 0.8.0 retired the bridge's own shell: its `GET /` redirects to whatever studio
// origin was recorded via `POST /api/studio-origin` — and crew is the writer, recording the
// daemon's own origin after the health check that starts OR adopts a pooled bridge. Same
// harness as the slice-1 suite: the bridge is a REAL child process with a REAL `.wi-serve.json`,
// only the pool's `spawn` is substituted. Per-root modes cover the contract:
//
//   - start path: the origin is POSTed once; a second proxied request does NOT re-post
//   - adopt path: an already-running bridge (never spawned by this pool) gets the POST too
//   - a bridge WITHOUT the endpoint (interactive < 0.8.0 → 404) is tolerated: debug, no warn
//   - a bridge that REJECTS the post still proxies fine — recording never fails a request

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundOrigin, InteractiveBridgePool, LOCK_NAME } from '../../src/interactive/bridge-pool.js';
import { registerInteractiveProxy } from '../../src/interactive/proxy-routes.js';
import { ProjectSettingsStore } from '../../src/projects/settings.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { Project } from '../../src/core/types.js';

/** The origin the daemon would thread in from its bound listen address. */
const STUDIO_ORIGIN = 'http://127.0.0.1:7799';

/**
 * The fake bridge (same shape as the slice-1 suite) plus the 0.8.0 studio-origin surface,
 * selectable per run: `ok` implements it, `no-endpoint` models an older bridge (404), and
 * `reject` counts the attempt but answers 403. `GET /api/studio-origin` additionally reports
 * `posts` so the tests can observe exactly how many times crew recorded.
 */
const FAKE_BRIDGE = `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];          // under \`node -e\`, script args start at argv[1]
const mode = process.argv[2] || 'ok';  // ok | no-endpoint | reject
let posts = 0;
let studioOrigin = null;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ ok: true, root, pid: process.pid }));
  }
  if (url.pathname === '/api/docs') {
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify([{ id: 'deck-1', title: 'A deck' }]));
  }
  if (url.pathname === '/api/studio-origin' && mode !== 'no-endpoint') {
    if (req.method === 'POST') {
      posts += 1;
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        if (mode === 'reject') {
          return res.writeHead(403, {'content-type':'application/json'})
            .end(JSON.stringify({ error: 'local only' }));
        }
        try { studioOrigin = JSON.parse(body).origin ?? null; } catch { studioOrigin = null; }
        res.writeHead(200, {'content-type':'application/json'})
          .end(JSON.stringify({ ok: true, studio_origin: studioOrigin }));
      });
    }
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ studio_origin: studioOrigin, posts }));
  }
  res.writeHead(404).end();
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(root, '.wi-serve.json'), JSON.stringify({
    port: server.address().port, host: '127.0.0.1', pid: process.pid,
    startedAt: new Date().toISOString(), version: 'fake',
  }));
});
`;

let dir: string;
let app: FastifyInstance;
let base: string;
let startRoot: string;
let adoptRoot: string;
let legacyRoot: string;
let rejectRoot: string;
/** Which fake-bridge mode the pool's spawn uses for each root. */
const modes = new Map<string, string>();
/** Every root the POOL spawned for — the adopt test asserts its root never appears here. */
const spawnCalls: string[] = [];
const children: ChildProcess[] = [];
const warns: string[] = [];
const debugs: string[] = [];

function spawnFake(root: string, mode?: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root, mode ?? modes.get(root) ?? 'ok'], {
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

function stubAdapter(known: Set<string>): CoreAdapter {
  return {
    projectGet: async (id: string): Promise<Project | null> =>
      known.has(id)
        ? { id, name: id, description: null, status: 'active', scope: `project:${id}`, created_at: 0, updated_at: 0 }
        : null,
  } as unknown as CoreAdapter;
}

/** The port the bridge recorded in its lockfile — where the tests observe the POSTs. */
function lockPort(root: string): number {
  return (JSON.parse(readFileSync(join(root, LOCK_NAME), 'utf8')) as { port: number }).port;
}

async function originState(root: string): Promise<{ studio_origin: string | null; posts: number }> {
  const res = await fetch(`http://127.0.0.1:${lockPort(root)}/api/studio-origin`);
  return (await res.json()) as { studio_origin: string | null; posts: number };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` returns true; the fire-and-forget POST has no completion signal to await. */
async function waitFor(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* not there yet */
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wi-origin-'));
  startRoot = join(dir, 'start-docs');
  adoptRoot = join(dir, 'adopt-docs');
  legacyRoot = join(dir, 'legacy-docs');
  rejectRoot = join(dir, 'reject-docs');
  modes.set(legacyRoot, 'no-endpoint');
  modes.set(rejectRoot, 'reject');

  const settingsPath = join(dir, 'project-settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({
      projects: {
        'p-start': { interactiveRoot: startRoot },
        'p-adopt': { interactiveRoot: adoptRoot },
        'p-legacy': { interactiveRoot: legacyRoot },
        'p-reject': { interactiveRoot: rejectRoot },
      },
    }),
  );

  const pool = new InteractiveBridgePool({
    spawn: (root) => {
      spawnCalls.push(root);
      return spawnFake(root);
    },
    startTimeoutMs: 15_000,
    healthTimeoutMs: 1_000,
    log: (m) => warns.push(m),
    debug: (m) => debugs.push(m),
    // What routes.ts threads in for real: the daemon's own origin, resolved lazily.
    studioOrigin: () => STUDIO_ORIGIN,
  });
  app = Fastify({ logger: false });
  registerInteractiveProxy(app, stubAdapter(new Set(['p-start', 'p-adopt', 'p-legacy', 'p-reject'])), {
    settings: new ProjectSettingsStore(settingsPath),
    pool,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 30_000);

afterAll(async () => {
  await app.close();
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const studioOriginNoise = (m: string): boolean => m.includes('studio origin');

describe('studio-origin recording (crew#298)', () => {
  it('START path: the daemon origin is POSTed to the bridge after the health check', async () => {
    const res = await fetch(`${base}/api/v1/projects/p-start/interactive/api/docs`);
    expect(res.status).toBe(200); // the proxied request never waits on the recording
    await waitFor(async () => (await originState(startRoot)).posts === 1, 'the origin POST to the started bridge');
    expect((await originState(startRoot)).studio_origin).toBe(STUDIO_ORIGIN);
  }, 30_000);

  it('a second request does NOT re-post (at most once per pooled bridge)', async () => {
    const res = await fetch(`${base}/api/v1/projects/p-start/interactive/api/docs`);
    expect(res.status).toBe(200);
    await sleep(300); // an (incorrect) second fire-and-forget POST would land within this window
    expect((await originState(startRoot)).posts).toBe(1);
  });

  it('ADOPT path: a bridge crew did not spawn gets the origin POST too', async () => {
    // An operator's already-running bridge: spawned OUTSIDE the pool, discovered via lockfile.
    mkdirSync(adoptRoot, { recursive: true });
    spawnFake(adoptRoot, 'ok');
    await waitFor(() => lockPort(adoptRoot) > 0, 'the pre-started bridge lockfile');
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${lockPort(adoptRoot)}/api/health`)).ok,
      'the pre-started bridge health',
    );

    const res = await fetch(`${base}/api/v1/projects/p-adopt/interactive/api/docs`);
    expect(res.status).toBe(200);
    expect(spawnCalls).not.toContain(adoptRoot); // adopted, not started
    await waitFor(async () => (await originState(adoptRoot)).posts === 1, 'the origin POST to the adopted bridge');
    expect((await originState(adoptRoot)).studio_origin).toBe(STUDIO_ORIGIN);
  }, 30_000);

  it('a bridge WITHOUT the endpoint (pre-0.8.0 → 404) is tolerated: debug, not warn', async () => {
    const res = await fetch(`${base}/api/v1/projects/p-legacy/interactive/api/docs`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'deck-1', title: 'A deck' }]);
    await waitFor(() => debugs.some((m) => m.includes('no /api/studio-origin')), 'the pre-0.8.0 debug skip');
    expect(warns.filter(studioOriginNoise)).toEqual([]); // an expected skip is not a warning
  }, 30_000);

  it('a bridge that REJECTS the post still proxies fine (warn only)', async () => {
    const res = await fetch(`${base}/api/v1/projects/p-reject/interactive/api/docs`);
    expect(res.status).toBe(200); // recording must never fail a proxy request
    expect(await res.json()).toEqual([{ id: 'deck-1', title: 'A deck' }]);
    await waitFor(async () => (await originState(rejectRoot)).posts === 1, 'the rejected origin POST attempt');
    await waitFor(() => warns.some((m) => studioOriginNoise(m) && m.includes('HTTP 403')), 'the rejection warn');

    // ...and the pooled bridge keeps serving afterwards.
    const again = await fetch(`${base}/api/v1/projects/p-reject/interactive/api/docs`);
    expect(again.status).toBe(200);
  }, 30_000);
});

describe('boundOrigin — the daemon address → origin mapping', () => {
  const addr = (address: string, port = 7701): AddressInfo => ({ address, family: 'IPv4', port });

  it('is null before listen (no address) and for unix sockets (string address)', () => {
    expect(boundOrigin(null)).toBeNull();
    expect(boundOrigin('/tmp/crew.sock')).toBeNull();
  });

  it('renders a plain IPv4 bind verbatim', () => {
    expect(boundOrigin(addr('127.0.0.1'))).toBe('http://127.0.0.1:7701');
  });

  it('normalizes the wildcard binds to loopback — a browser cannot dial 0.0.0.0', () => {
    expect(boundOrigin(addr('0.0.0.0'))).toBe('http://127.0.0.1:7701');
    expect(boundOrigin(addr('::'))).toBe('http://127.0.0.1:7701');
  });

  it('brackets IPv6 hosts', () => {
    expect(boundOrigin(addr('::1'))).toBe('http://[::1]:7701');
  });
});
