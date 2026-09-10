// `/api/v1/projects/:projectId/interactive/*` end to end (DES-MERGE-001 slice 1).
//
// The bridge here is a REAL child process serving a REAL `.wi-serve.json` — a tiny http server in
// its own node process, not a mock — because the behaviors under test are exactly the ones a mock
// would paper over: a pid that can be killed, a lockfile discovered on disk, a socket that streams.
// Only the SPAWN is substituted (the pool is handed a `spawn` that launches this fake instead of
// `npx wicked-interactive serve`), so discovery, health, reuse, restart, and streaming all run
// against the production code paths.
//
// Pins the slice's acceptance criteria:
//   - no bridge running → GET .../interactive/api/docs → 200 JSON list
//   - a second request reuses the SAME pid
//   - kill the bridge → the next request restarts it → 200 again
//   - start impossible → 503 {code:"bridge_unavailable", hint:<a real command>}
//   - Location rewritten back onto the proxy prefix
//   - an SSE chunk arrives BEFORE the stream closes (unbuffered)

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveBridgePool, INTERACTIVE_SPEC, LOCK_NAME } from '../../src/interactive/bridge-pool.js';
import { CREW_GROUNDING_FILE, DocGroundingStore } from '../../src/interactive/doc-grounding.js';
import { registerInteractiveProxy } from '../../src/interactive/proxy-routes.js';
import { mkdirSync as mkdirp } from 'node:fs';
import { ProjectSettingsStore } from '../../src/projects/settings.js';
import type { CoreAdapter } from '../../src/core/adapter.js';
import type { Project } from '../../src/core/types.js';
import { removeScratch } from '../setup/scratch.js';

/**
 * The fake bridge, as a standalone script. Implements the contract the pool depends on
 * (`.wi-serve.json` with pid+port, `GET /api/health` reporting its root) plus the handful of
 * endpoints the proxy tests exercise. Run with `node -e`, so it is a genuine separate pid.
 */
const FAKE_BRIDGE = `
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const root = process.argv[1];  // under \`node -e\`, the first script arg is argv[1]
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/health') {
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ ok: true, root, pid: process.pid }));
  }
  if (url.pathname === '/api/docs' && req.method === 'POST') {  // the create: echoes what arrived
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      let received = {};
      try { received = JSON.parse(body); } catch { received = { unparsed: body }; }
      res.writeHead(200, {'content-type':'application/json'})
        .end(JSON.stringify({ name: received.name || 'made-doc', head: 0, generating: true, received }));
    });
  }
  if (url.pathname === '/api/docs') {
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify([{ id: 'deck-1', title: 'A deck' }]));
  }
  if (url.pathname === '/api/whoami') {  // echoes what actually arrived at the bridge
    return res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ url: req.url, method: req.method, auth: req.headers.authorization ?? null }));
  }
  if (url.pathname === '/api/echo') {    // proves the request BODY streamed through
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => res.writeHead(200, {'content-type':'application/json'})
      .end(JSON.stringify({ got: body })));
  }
  if (url.pathname === '/api/redirect-abs') {
    return res.writeHead(302, { location: 'http://127.0.0.1:' + server.address().port + '/api/docs' }).end();
  }
  if (url.pathname === '/api/redirect-rel') {
    return res.writeHead(302, { location: '/api/docs' }).end();
  }
  if (url.pathname === '/api/redirect-foreign') {
    return res.writeHead(302, { location: 'https://example.com/elsewhere' }).end();
  }
  if (url.pathname === '/api/stream') {  // SSE: one frame now, close much later
    res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
    res.write('data: first\\n\\n');
    return setTimeout(() => { res.write('data: last\\n\\n'); res.end(); }, 1500);
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
let settingsPath: string;
let app: FastifyInstance;
let base: string;
let pool: InteractiveBridgePool;
const children: ChildProcess[] = [];
/** Set to make the next spawn fail — the "bridge cannot start" case. */
let spawnBroken = false;

function spawnFake(root: string): ChildProcess {
  if (spawnBroken) {
    // A command that does not exist: exactly what a missing wicked-interactive install looks like.
    const child = spawn('wicked-interactive-does-not-exist', [root], { stdio: 'ignore' });
    children.push(child);
    return child;
  }
  const child = spawn(process.execPath, ['-e', FAKE_BRIDGE, root], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** Only `interactiveRoot` matters to the proxy; the rest is a well-formed engine row. */
function stubAdapter(known: Set<string>): CoreAdapter {
  return {
    projectGet: async (id: string): Promise<Project | null> =>
      known.has(id)
        ? { id, name: id, description: null, status: 'active', scope: `project:${id}`, created_at: 0, updated_at: 0 }
        : null,
  } as unknown as CoreAdapter;
}

/** The pid the bridge recorded in its lockfile — the identity the AC talks about. */
function lockPid(root: string): number {
  return (JSON.parse(readFileSync(join(root, LOCK_NAME), 'utf8')) as { pid: number }).pid;
}

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wi-proxy-'));
  settingsPath = join(dir, 'project-settings.json');
  const sharedRoot = join(dir, 'shared-docs');
  const boundRoot = join(dir, 'bound-docs');

  // p-bound is explicitly bound; p-a and p-b are unbound and share the default root.
  writeFileSync(settingsPath, JSON.stringify({ projects: { 'p-bound': { interactiveRoot: boundRoot } } }));

  pool = new InteractiveBridgePool({ spawn: spawnFake, startTimeoutMs: 15_000, healthTimeoutMs: 1_000 });
  app = Fastify({ logger: false });
  registerInteractiveProxy(app, stubAdapter(new Set(['p-a', 'p-b', 'p-bound'])), {
    settings: new ProjectSettingsStore(settingsPath),
    pool,
    // The env moves the SHARED DEFAULT into the temp dir, so nothing touches ~/wicked-interactive.
    env: { WICKED_INTERACTIVE_ROOT: sharedRoot },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 30_000);

afterEach(() => {
  spawnBroken = false;
});

afterAll(async () => {
  await app.close();
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  removeScratch(dir);
});

describe('interactive proxy — acceptance (slice 1)', () => {
  let firstPid: number;

  it('with NO bridge running, GET .../interactive/api/docs → 200 JSON list', async () => {
    expect(existsSync(join(dir, 'shared-docs', LOCK_NAME))).toBe(false);
    const res = await get('/api/v1/projects/p-a/interactive/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual([{ id: 'deck-1', title: 'A deck' }]);
    firstPid = lockPid(join(dir, 'shared-docs'));
    expect(firstPid).toBeGreaterThan(0);
  }, 30_000);

  it('a second request REUSES the same bridge pid', async () => {
    const res = await get('/api/v1/projects/p-a/interactive/api/docs');
    expect(res.status).toBe(200);
    const pid = lockPid(join(dir, 'shared-docs'));
    expect(pid).toBe(firstPid);
  });

  it('a DIFFERENT project on the same resolved root reuses that same bridge', async () => {
    const res = await get('/api/v1/projects/p-b/interactive/api/docs');
    expect(res.status).toBe(200);
    expect(pool.keys()).toEqual([join(dir, 'shared-docs')]);
  });

  it('a project bound to its OWN root gets its own bridge', async () => {
    const res = await get('/api/v1/projects/p-bound/interactive/api/docs');
    expect(res.status).toBe(200);
    const bound = lockPid(join(dir, 'bound-docs'));
    expect(bound).not.toBe(firstPid);
    expect(new Set(pool.keys())).toEqual(new Set([join(dir, 'shared-docs'), join(dir, 'bound-docs')]));
  }, 30_000);

  it('after KILLING the bridge, the next request restarts it → 200 again', async () => {
    process.kill(firstPid, 'SIGKILL');
    // Wait for the pid to actually be reaped, so the pool sees a dead pid, not a slow one.
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(firstPid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const res = await get('/api/v1/projects/p-a/interactive/api/docs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'deck-1', title: 'A deck' }]);
    const restarted = lockPid(join(dir, 'shared-docs'));
    expect(restarted).not.toBe(firstPid);
  }, 30_000);

  it('503 {code:"bridge_unavailable", hint} — with a hint naming a REAL command', async () => {
    // A project whose root has never had a bridge, and whose spawn is broken.
    const settings = new ProjectSettingsStore(settingsPath);
    const deadRoot = join(dir, 'dead-docs');
    settings.set('p-dead', { interactiveRoot: deadRoot });
    const deadApp = Fastify({ logger: false });
    registerInteractiveProxy(deadApp, stubAdapter(new Set(['p-dead'])), {
      settings,
      pool: new InteractiveBridgePool({ spawn: spawnFake, startTimeoutMs: 1_500, healthTimeoutMs: 300 }),
    });
    spawnBroken = true;
    const res = await deadApp.inject({ method: 'GET', url: '/api/v1/projects/p-dead/interactive/api/docs' });
    await deadApp.close();

    expect(res.statusCode).toBe(503);
    const body = res.json() as { code: string; hint: string };
    expect(body.code).toBe('bridge_unavailable');
    expect(body.hint).toContain(`npx ${INTERACTIVE_SPEC} serve --root ${deadRoot}`);
  }, 30_000);

  it('404s an unknown project instead of starting a bridge for it', async () => {
    const res = await get('/api/v1/projects/p-nope/interactive/api/docs');
    expect(res.status).toBe(404);
  });
});

describe('interactive proxy — transport semantics', () => {
  const P = '/api/v1/projects/p-a/interactive';

  it('forwards method, path remainder and query VERBATIM (prefix stripped)', async () => {
    const res = await fetch(`${base}${P}/api/whoami?doc=a%2Fb&n=1`);
    const body = (await res.json()) as { url: string; method: string; auth: string | null };
    // The percent-encoding survives the hop — a decoded wildcard param would have mangled it.
    expect(body.url).toBe('/api/whoami?doc=a%2Fb&n=1');
    expect(body.method).toBe('GET');
  });

  it("does not relay crew's Authorization header to the bridge", async () => {
    const res = await fetch(`${base}${P}/api/whoami`, { headers: { authorization: 'Bearer crew-secret' } });
    expect(((await res.json()) as { auth: string | null }).auth).toBeNull();
  });

  it('streams the request body through (POST)', async () => {
    const res = await fetch(`${base}${P}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(((await res.json()) as { got: string }).got).toBe('{"hello":"world"}');
  });

  it('rewrites an ABSOLUTE Location on the bridge origin back onto the proxy prefix', async () => {
    const res = await fetch(`${base}${P}/api/redirect-abs`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${P}/api/docs`);
  });

  it('rewrites a ROOT-RELATIVE Location too', async () => {
    const res = await fetch(`${base}${P}/api/redirect-rel`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe(`${P}/api/docs`);
  });

  it('leaves a FOREIGN Location alone (rewriting it would invent a target)', async () => {
    const res = await fetch(`${base}${P}/api/redirect-foreign`, { redirect: 'manual' });
    expect(res.headers.get('location')).toBe('https://example.com/elsewhere');
  });

  it('SSE: a chunk arrives BEFORE the stream closes (unbuffered)', async () => {
    const res = await fetch(`${base}${P}/api/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    const startedAt = Date.now();
    const first = await reader.read();
    const firstChunkAt = Date.now() - startedAt;
    expect(new TextDecoder().decode(first.value)).toContain('data: first');
    // The bridge holds the stream open for 1500 ms after that frame. If the proxy buffered,
    // nothing could have been read before then — this margin is what "live" means here.
    expect(firstChunkAt).toBeLessThan(1000);

    // ...and the tail still arrives on the same connection.
    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain('data: last');
  }, 30_000);
});

describe('interactive proxy — doc create interception (F-046)', () => {
  let createApp: FastifyInstance;
  let createBase: string;
  let grounding: DocGroundingStore;
  const studioRoot = (): string => join(dir, 'repos', 'wicked-studio');

  beforeAll(async () => {
    mkdirp(studioRoot(), { recursive: true });
    grounding = new DocGroundingStore();
    // The adapter knows p-a's members and the registry — what the proxy validates a repo_ref against.
    const adapter = Object.assign(stubAdapter(new Set(['p-a'])), {
      projectMembers: async (id: string) =>
        id === 'p-a'
          ? [
              { member_kind: 'crew.repo', member_ref: 'repo-studio' },
              { member_kind: 'crew.run', member_ref: 'run-1' },
            ]
          : [],
      listRepos: async () => [{ id: 'repo-studio', name: 'wicked-studio', root_path: studioRoot() }],
    }) as CoreAdapter;
    createApp = Fastify({ logger: false });
    registerInteractiveProxy(createApp, adapter, {
      settings: new ProjectSettingsStore(settingsPath),
      pool,
      env: { WICKED_INTERACTIVE_ROOT: join(dir, 'shared-docs') },
      grounding,
    });
    await createApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = createApp.server.address();
    createBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }, 30_000);

  afterAll(async () => {
    await createApp.close();
  });

  const post = (project: string, body: unknown, raw = false): Promise<Response> =>
    fetch(`${createBase}/api/v1/projects/${project}/interactive/api/docs`, {
      method: 'POST',
      headers: { 'content-type': raw ? 'text/plain' : 'application/json' },
      body: raw ? String(body) : JSON.stringify(body),
    });

  it('REFUSES a repo the project does not have — 400 repo_not_in_project naming the fix, nothing forwarded, nothing recorded', async () => {
    const res = await post('p-a', { name: 'brochure', kind: 'source', brief: 'x', project: 'p-a', repo_ref: 'wicked-crew' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; requested: string[]; missing: string[]; available: Array<{ id: string; name: string }>; error: string };
    expect(body.code).toBe('repo_not_in_project');
    expect(body.requested).toEqual(['wicked-crew']);
    expect(body.missing).toEqual(['wicked-crew']);
    expect(body.available).toEqual([{ id: 'repo-studio', name: 'wicked-studio' }]);
    expect(body.error).toContain('pick one of: wicked-studio');
    expect(existsSync(join(dir, 'shared-docs', 'brochure'))).toBe(false); // nothing recorded, nothing created
    expect(grounding.pendingCount('p-a')).toBe(0);
  }, 30_000);

  it('REFUSES a repo on the Unfiled mount — an unbound doc cannot be about a project repository', async () => {
    const res = await post('default', { name: 'loose', kind: 'source', brief: 'x', repo_refs: ['wicked-studio'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unfiled_doc_repo');
  }, 30_000);

  it('REFUSES junk refs before touching the project', async () => {
    const res = await post('p-a', { name: 'd', kind: 'source', brief: 'x', repo_refs: 'not-an-array' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; requested: string[] };
    expect(body.code).toBe('invalid_repo_ref');
    expect(body.requested).toEqual(['not-an-array']); // as the client spelled it
  }, 30_000);

  it('forwards a valid create with repo_ref STRIPPED and style INFERRED from the brief, and records the binding under the doc name the bridge answered with', async () => {
    const res = await post('p-a', {
      name: 'brochure',
      kind: 'source',
      brief: 'A high-end product brochure. Print-ready A4, two pages.',
      project: 'p-a',
      repo_ref: 'wicked-studio', // by NAME — canonicalized to the registry id below
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; received: Record<string, unknown> };
    expect(body.name).toBe('brochure');
    expect('repo_ref' in body.received).toBe(false);
    expect('repo_refs' in body.received).toBe(false);
    expect(body.received.style).toBe('brochure');
    expect(body.received.brief).toBe('A high-end product brochure. Print-ready A4, two pages.');
    // Recorded as a sidecar BESIDE THE DOC under the project's docs root — never under the state home.
    const sidecar = join(dir, 'shared-docs', 'brochure', CREW_GROUNDING_FILE);
    expect(existsSync(sidecar)).toBe(true);
    expect(grounding.get(join(dir, 'shared-docs'), 'brochure')).toMatchObject({ project_id: 'p-a', repo_refs: ['repo-studio'], style: 'brochure' });
    expect(grounding.pendingCount('p-a')).toBe(0);
  }, 30_000);

  it('passes a client style through untouched, and leaves a brief with no format words style-less', async () => {
    const kept = (await (await post('p-a', { name: 'deck', kind: 'source', brief: 'notes', style: 'ppt', project: 'p-a' })).json()) as {
      received: Record<string, unknown>;
    };
    expect(kept.received.style).toBe('ppt');
    const bare = (await (await post('p-a', { name: 'plain', kind: 'source', brief: 'notes for the team', project: 'p-a' })).json()) as {
      received: Record<string, unknown>;
    };
    expect('style' in bare.received).toBe(false);
    expect(grounding.get(join(dir, 'shared-docs'), 'plain')).toBeUndefined(); // nothing named → nothing recorded
  }, 30_000);

  it('is pure transport for a create body that is not a JSON object', async () => {
    const res = await post('p-a', 'not json at all', true);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { received: { unparsed?: string } }).received.unparsed).toBe('not json at all');
  }, 30_000);

  it('WITHOUT a grounding store the create is untouched transport — repo_ref reaches the bridge as sent', async () => {
    const res = await fetch(`${base}/api/v1/projects/p-a/interactive/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'raw', kind: 'source', brief: 'x', repo_ref: 'wicked-studio' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { received: Record<string, unknown> }).received.repo_ref).toBe('wicked-studio');
  }, 30_000);
});
