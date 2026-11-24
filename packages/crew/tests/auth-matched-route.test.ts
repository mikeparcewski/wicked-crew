// The auth boundary decides on the route the router matched, never only on the raw request path: any spelling the
// router reads as a protected API route is protected, and its trust rule is judged on the path the router read. A
// protected request that reaches a handler always carries an actor. Auth off (the local loopback default) is unchanged.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_ACTOR, registerAuthHooks, tokenHash } from '../src/api/auth.js';
import { createServer } from '../src/api/server.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { registerUiTextScrub } from '../src/api/ui-text.js';
import type { Actor } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

const AGENT: Actor = { id: 'seat-1', kind: 'agent', trust: 'operator' };
const ADMIN: Actor = { id: 'op-1', kind: 'human', trust: 'admin' };
const OPERATOR: Actor = { id: 'op-2', kind: 'human', trust: 'operator' };
const TOKENS: Record<string, Actor> = { agent: AGENT, admin: ADMIN, operator: OPERATOR };

let app: FastifyInstance;

async function serve(mode: 'required' | 'off'): Promise<FastifyInstance> {
  const a = Fastify({ routerOptions: { maxParamLength: 256 } }); // as server.ts
  registerAuthHooks(a, { mode, verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
  const who = async (req: { actor?: Actor | null }) => ({ actor: req.actor ?? null });
  a.put('/api/v1/desk/snoozes/:key', who);
  a.get('/api/v1/runs', who);
  a.post('/api/v1/governance/rules', who);
  a.post('/api/v1/mcp/call', async (req) => ({ unit: true, actor: (req as { actor?: Actor | null }).actor ?? null }));
  a.get('/ws', who);
  a.get('/', async () => ({ shell: true }));
  await a.ready();
  return a;
}

/** Spellings of a path the router may read as the same route. */
function spellings(path: string): string[] {
  const enc = (c: string): string => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  const segs = path.split('/');
  const out = new Set<string>();
  // each letter of the first two segments, percent-encoded one at a time, both hex cases
  for (const s of [1, 2]) {
    const seg = segs[s]!;
    for (let i = 0; i < seg.length; i++) {
      for (const up of [false, true]) {
        const e = up ? enc(seg[i]!).toUpperCase() : enc(seg[i]!);
        const next = [...segs];
        next[s] = seg.slice(0, i) + e + seg.slice(i + 1);
        out.add(next.join('/'));
      }
    }
  }
  // the whole prefix encoded
  out.add(`/${[...'api'].map(enc).join('')}/${[...'v1'].map(enc).join('')}${path.slice('/api/v1'.length)}`);
  return [...out];
}

describe('auth: protection is decided on the matched route', () => {
  afterEach(async () => {
    await app.close();
  });
  it('every spelling the router serves as a protected route needs a token (401) and its trust (403)', async () => {
    app = await serve('required');
    for (const url of spellings('/api/v1/desk/snoozes/run%3Ax')) {
      const none = await app.inject({ method: 'PUT', url, payload: {} });
      if (none.statusCode === 404) continue; // not served under this spelling: nothing to protect
      expect(none.statusCode, url).toBe(401);
      const agent = await app.inject({ method: 'PUT', url, payload: {}, headers: { authorization: 'Bearer agent' } });
      expect(agent.statusCode, url).toBe(200); // trust operator passes the boundary; the route itself judges the kind
      expect(agent.json().actor, url).toEqual(AGENT);
    }
    for (const url of spellings('/api/v1/governance/rules')) {
      const none = await app.inject({ method: 'POST', url, payload: {} });
      if (none.statusCode === 404) continue;
      expect(none.statusCode, url).toBe(401);
      const op = await app.inject({ method: 'POST', url, payload: {}, headers: { authorization: 'Bearer operator' } });
      expect(op.statusCode, url).toBe(403); // governance writes are admin: judged on the path the router read
      const admin = await app.inject({ method: 'POST', url, payload: {}, headers: { authorization: 'Bearer admin' } });
      expect(admin.statusCode, url).toBe(200);
    }
    // At least one encoded spelling IS served by the router, so the loops above are not vacuous.
    const served = await app.inject({ method: 'GET', url: spellings('/api/v1/runs')[0]! });
    expect(served.statusCode).toBe(401);
  });

  it('other spellings the router does not serve stay 404 or 401, never a handler without an actor', async () => {
    app = await serve('required');
    const odd = [
      '/api/v1/runs/',
      '//api/v1/runs',
      '/API/v1/runs',
      '/api/v1/../v1/runs',
      '/x/../api/v1/runs',
      '/%2561pi/v1/runs',
      '/api%2Fv1/runs',
      '/api/v1/runs;x',
      '/api/v1/runs%00',
      '/api/v1/%E0%A4%A',
    ];
    for (const url of odd) {
      const r = await app.inject({ method: 'GET', url });
      expect([400, 401, 404], url).toContain(r.statusCode);
      if (r.statusCode === 200) expect(r.json().actor, url).not.toBeNull();
    }
  });

  it('the unit-token routes still pass to their own check, and the shell stays public', async () => {
    app = await serve('required');
    const unit = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: {} });
    expect(unit.statusCode).toBe(200);
    expect(unit.json()).toEqual({ unit: true, actor: null });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ws' })).statusCode).toBe(401);
  });

  it('auth off: every protected spelling runs as the local actor, as before', async () => {
    app = await serve('off');
    for (const url of ['/api/v1/runs', ...spellings('/api/v1/runs')]) {
      const r = await app.inject({ method: 'GET', url });
      if (r.statusCode === 404) continue;
      expect(r.statusCode, url).toBe(200);
      expect(r.json().actor, url).toEqual(LOCAL_ACTOR);
    }
  });

  it('the home-path scrub applies to the matched route under every spelling', async () => {
    app = Fastify({ routerOptions: { maxParamLength: 256 } });
    const home = '/home/someone';
    registerUiTextScrub(app, ['/api/v1/health'], home);
    app.get('/api/v1/health', async () => ({ where: `${home}/state` }));
    await app.ready();
    let served = 0;
    for (const url of ['/api/v1/health', ...spellings('/api/v1/health')]) {
      const r = await app.inject({ method: 'GET', url });
      if (r.statusCode === 404) continue;
      served++;
      expect(r.body, url).not.toContain(home);
    }
    expect(served).toBeGreaterThan(1);
  });

  it('a protected route that reaches the trust stage without an actor is refused', async () => {
    app = Fastify({ routerOptions: { maxParamLength: 256 } });
    registerAuthHooks(app, { mode: 'required', verifiers: [{ name: 'test', verify: async (t) => TOKENS[t] ?? null }], allowedOrigins: null });
    app.addHook('onRequest', async (req) => {
      (req as { actor?: Actor | null }).actor = null; // a gap in the identity stage, simulated
    });
    app.get('/api/v1/runs', async () => ({ served: true }));
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/v1/runs', headers: { authorization: 'Bearer admin' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('auth: the daemon route table, each route under another spelling of its prefix', () => {
  let daemon: FastifyInstance;
  let scratch: string;
  let savedLogLevel: string | undefined;
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'auth-matched-route-'));
    const tokens = join(scratch, 'tokens.json');
    writeFileSync(tokens, JSON.stringify({ tokens: [{ sha256: tokenHash('agent-token'), actor: AGENT }] }));
    savedLogLevel = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'silent';
    const adapter = { stub: true, projectsSupported: () => false, getSettings: async () => ({}), onLaunch: (): (() => void) => () => undefined, onEvent: () => () => {} } as unknown as CoreAdapter;
    daemon = await createServer(adapter, {
      auth: { mode: 'required', tokensPath: tokens },
      auditPath: join(scratch, 'audit.log'),
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      studioRoot: join(scratch, 'no-studio'),
    });
    await daemon.ready();
  });
  afterAll(async () => {
    await daemon.close();
    if (savedLogLevel === undefined) delete process.env['LOG_LEVEL'];
    else process.env['LOG_LEVEL'] = savedLogLevel;
    removeScratch(scratch);
  });

  it('no protected route answers without a token, and none of the admin or human-only ones lets an agent through', async () => {
    const routes = (daemon.endpointManifest ?? []).filter((e) => e.path.startsWith('/api/v1/') && e.method !== 'HEAD');
    expect(routes.length).toBeGreaterThan(100);
    const respell = (path: string): string => `/%61${path.slice(2)}`; // the prefix's first letter, percent-encoded
    const concrete = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, 'x1').replace(/\*$/, 'x1');
    let served = 0;
    for (const { method, path } of routes) {
      const url = respell(concrete(path));
      const unit = ['POST /api/v1/mcp/call', 'POST /api/v1/mcp/tools', 'POST /api/v1/mcp/ask', 'GET /api/v1/mcp/ask', 'DELETE /api/v1/mcp/ask', 'POST /api/v1/apps/check', 'POST /api/v1/apps/produce', 'POST /api/v1/insights/facts'].includes(`${method} ${path}`);
      if (unit) continue; // their own credential is the unit token in the body, checked by the route
      const payload = method === 'GET' || method === 'DELETE' || method === 'OPTIONS' ? undefined : {};
      const plain = await daemon.inject({ method: method as 'GET', url: concrete(path), payload });
      if (plain.statusCode !== 401) continue; // answered before the boundary under its own spelling too (a preflight)
      const none = await daemon.inject({ method: method as 'GET', url, payload });
      if (none.statusCode !== 404) served++;
      expect([401, 404], `${method} ${url}`).toContain(none.statusCode);
    }
    expect(served).toBeGreaterThan(100); // the router does serve these spellings: the sweep is not vacuous
    // An agent bearer on an admin route and on a human-only route, under the other spelling.
    const auth = { authorization: 'Bearer agent-token' };
    expect((await daemon.inject({ method: 'POST', url: respell('/api/v1/governance/rules'), payload: {}, headers: auth })).statusCode).toBe(403);
    const human = await daemon.inject({ method: 'GET', url: respell('/api/v1/sources/x1/catalog'), headers: auth });
    expect(human.statusCode).toBe(403);
    expect(human.json()).toMatchObject({ code: 'human_only' });
  }, 60_000);
});
