// The required-mode 401/403/200 matrix (task #88), REST + WS — the request-level
// proof of the identity/actor contract:
//
//   - no/bad token → 401 everywhere under /api/v1 AND on the /ws upgrade
//   - observer reads (200) but cannot write (403 on work, 403 on governance)
//   - operator launches a run and answers a gate (200) — and the gate-decision
//     AUDIT names the operator's actor id — but cannot write governance (403)
//   - admin writes governance/settings and archives a project (the one
//     body-dependent rule: PATCH project rename is operator, status is admin)
//   - CORS pairing: a NON-loopback origin is reflected only because auth is on
//   - local-mode control: a default server keeps answering tokenless requests
//     with the implicit local actor (the rest of the suite is the full proof)
//
// The engine is stubbed at the adapter boundary (the gate-route test's
// pattern): the matrix is about the HTTP layer's deny semantics, not about
// what a live engine does after they pass.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { tokenHash } from '../../src/api/auth.js';
import type { AuditEntry, SessionView, SystemSettings } from '../../src/core/types.js';

const TOKENS = {
  observer: 'obs-token-1',
  operator: 'op-token-1',
  agent: 'agent-token-1',
  admin: 'admin-token-1',
} as const;

const PARKED = 'parked-run';

function view(id: string, status: string): SessionView {
  return { session: { id, status }, units: [] } as unknown as SessionView;
}

let dir: string;
let adapter: CoreAdapter;
let app: Awaited<ReturnType<typeof createServer>>;
let localApp: Awaited<ReturnType<typeof createServer>>;
let base: string;
let localBase: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'auth-required-'));
  writeFileSync(
    join(dir, 'tokens.json'),
    JSON.stringify({
      version: 1,
      tokens: [
        { sha256: tokenHash(TOKENS.observer), actor: { id: 'watcher-1', kind: 'human', trust: 'observer' } },
        { sha256: tokenHash(TOKENS.operator), actor: { id: 'maria', kind: 'human', trust: 'operator' } },
        { sha256: tokenHash(TOKENS.agent), actor: { id: 'ci-runner', kind: 'agent', trust: 'operator' } },
        { sha256: tokenHash(TOKENS.admin), actor: { id: 'root-op', kind: 'human', trust: 'admin' } },
      ],
    }),
  );

  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  // Stub the engine boundary: the matrix tests the HTTP layer's decisions.
  adapter.launchRun = async () => 'run-launched-1';
  adapter.sessionsDetail = async () => [view(PARKED, 'awaiting_human')];
  adapter.sessions = async () => [PARKED];
  adapter.confirmGate = async () => 'resumed';
  adapter.upsertPolicy = async () => undefined;
  adapter.getSettings = async () => ({ graphNodeLimit: 150 });
  adapter.updateSettings = async (patch: Partial<SystemSettings>) =>
    ({ graphNodeLimit: 150, ...patch }) as SystemSettings;
  adapter.projectGet = async (id: string) =>
    ({ id, name: 'p', description: null, status: 'active', scope: `project:${id}`, created_at: 1, updated_at: 1 });
  adapter.projectUpdate = async (id: string, patch: { name?: string; status?: string }) =>
    ({
      id,
      name: patch.name ?? 'p',
      description: null,
      status: (patch.status ?? 'active') as 'active' | 'archived',
      scope: `project:${id}`,
      created_at: 1,
      updated_at: 2,
    });
  adapter.projectMembers = async () => [];

  app = await createServer(adapter, {
    auth: { mode: 'required', tokensPath: join(dir, 'tokens.json') },
    auditPath: join(dir, 'audit.log'),
    projectEvents: { disabled: true },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // The LOCAL-MODE control: same adapter, default auth (off), tokenless.
  localApp = await createServer(adapter, {
    auth: { mode: 'off' },
    auditPath: join(dir, 'audit-local.log'),
    projectEvents: { disabled: true },
  });
  await localApp.listen({ port: 0, host: '127.0.0.1' });
  const lAddr = localApp.server.address();
  localBase = `http://127.0.0.1:${typeof lAddr === 'object' && lAddr ? lAddr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await localApp.close();
  adapter.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Attempt a WS upgrade; resolve with 'open' or the HTTP status the server denied it with. */
function wsAttempt(url: string, headers?: Record<string, string>): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers !== undefined ? { headers } : {});
    const timer = setTimeout(() => reject(new Error('ws attempt timed out')), 5000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', () => {
      /* follows unexpected-response; the resolve above already happened */
    });
  });
}

describe('401 — missing/invalid token in required mode', () => {
  it('no token → 401 with WWW-Authenticate, on reads and writes alike', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/runs'],
      ['GET', '/api/v1/health'],
      ['POST', '/api/v1/runs'],
      ['PUT', '/api/v1/settings'],
    ] as const) {
      const res = await call(method, path, undefined, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
      expect(((await res.json()) as { error: string }).error).toMatch(/Authentication required/);
    }
  });

  it('an unknown token → 401 with a distinct message', async () => {
    const res = await call('GET', '/api/v1/runs', 'not-a-registered-token');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/Invalid or unknown token/);
  });

  it('the WS upgrade 401s without a token, and on a bad token — header or query', async () => {
    expect(await wsAttempt(`${base.replace('http', 'ws')}/ws`)).toBe(401);
    expect(await wsAttempt(`${base.replace('http', 'ws')}/ws`, { Authorization: 'Bearer wrong' })).toBe(401);
    expect(await wsAttempt(`${base.replace('http', 'ws')}/ws?access_token=wrong`)).toBe(401);
    expect(await wsAttempt(`${base.replace('http', 'ws')}/ws/terminals/t1`)).toBe(401);
  });

  it('OPTIONS preflight needs no token (browsers do not send Authorization on it)', async () => {
    const res = await fetch(`${base}/api/v1/runs`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://crew.example.com', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
  });

  it('the SPA scope stays public — only /api/v1 and /ws are behind the boundary', async () => {
    // No studio bundle in this fixture, so / is a 404 — the point is it is NOT a 401.
    const res = await fetch(`${base}/`);
    expect(res.status).not.toBe(401);
  });
});

describe('observer — reads yes, writes no', () => {
  it('reads runs and its own identity', async () => {
    const runs = await call('GET', '/api/v1/runs', TOKENS.observer);
    expect(runs.status).toBe(200);
    const who = await call('GET', '/api/v1/whoami', TOKENS.observer);
    expect(await who.json()).toEqual({
      actor: { id: 'watcher-1', kind: 'human', trust: 'observer' },
      authMode: 'required',
    });
  });

  it('403s on a governance write AND on plain operator work', async () => {
    const gov = await call('POST', '/api/v1/governance/policies', TOKENS.observer, { id: 'p1' });
    expect(gov.status).toBe(403);
    expect(((await gov.json()) as { error: string }).error).toMatch(/requires 'admin'.*'observer'/);
    const launch = await call('POST', '/api/v1/runs', TOKENS.observer, { problem: 'x' });
    expect(launch.status).toBe(403);
    expect(((await launch.json()) as { error: string }).error).toMatch(/requires 'operator'/);
  });

  it('connects to /ws (the stream is a read) — via query token, the browser path', async () => {
    expect(await wsAttempt(`${base.replace('http', 'ws')}/ws?access_token=${TOKENS.observer}`)).toBe('open');
  });
});

describe('operator — does the work, cannot govern', () => {
  it('launches a run and answers a gate; the gate-decision audit names the actor', async () => {
    const launch = await call('POST', '/api/v1/runs', TOKENS.operator, { problem: 'build it' });
    expect(launch.status).toBe(201);

    const gate = await call('POST', `/api/v1/runs/${PARKED}/gate`, TOKENS.operator, {
      approve: true,
      amend: 'ship it',
    });
    expect(gate.status).toBe(200);

    // The audit trail is the "who approved" record (readable at observer trust).
    const audit = await call('GET', `/api/v1/audit?runId=${PARKED}`, TOKENS.observer);
    expect(audit.status).toBe(200);
    const { entries } = (await audit.json()) as { entries: AuditEntry[] };
    const decision = entries.find((e) => e.action === 'gate.decided');
    expect(decision?.actor).toEqual({ id: 'maria', kind: 'human', trust: 'operator' });
    expect(decision?.detail?.['approve']).toBe(true);
    expect(decision?.detail?.['amend']).toBe('ship it');

    const launched = (await (await call('GET', '/api/v1/audit?action=run.launched', TOKENS.observer)).json()) as {
      entries: AuditEntry[];
    };
    expect(launched.entries[0]?.actor.id).toBe('maria');
    expect(launched.entries[0]?.runId).toBe('run-launched-1');
  });

  it('an agent-kind workload token does operator work under its own id', async () => {
    const res = await call('POST', '/api/v1/runs', TOKENS.agent, { problem: 'nightly job' });
    expect(res.status).toBe(201);
    const { entries } = (await (
      await call('GET', '/api/v1/audit?action=run.launched&limit=1', TOKENS.observer)
    ).json()) as { entries: AuditEntry[] };
    expect(entries[0]?.actor).toEqual({ id: 'ci-runner', kind: 'agent', trust: 'operator' });
  });

  it('403s on governance writes, settings writes, and project archive', async () => {
    expect((await call('POST', '/api/v1/governance/policies', TOKENS.operator, { id: 'p1' })).status).toBe(403);
    expect((await call('DELETE', '/api/v1/governance/rules/r-1', TOKENS.operator)).status).toBe(403);
    expect((await call('PUT', '/api/v1/settings', TOKENS.operator, { graphNodeLimit: 100 })).status).toBe(403);
    expect(
      (await call('PATCH', '/api/v1/projects/p1', TOKENS.operator, { status: 'archived' })).status,
    ).toBe(403);
  });

  it('but a project RENAME is operator work (the body-dependent rule cuts both ways)', async () => {
    const res = await call('PATCH', '/api/v1/projects/p1', TOKENS.operator, { name: 'renamed' });
    expect(res.status).toBe(200);
  });
});

describe('admin — governs', () => {
  it('writes a governance policy, updates settings, archives a project', async () => {
    expect((await call('POST', '/api/v1/governance/policies', TOKENS.admin, { id: 'p1' })).status).toBe(200);
    expect((await call('PUT', '/api/v1/settings', TOKENS.admin, { graphNodeLimit: 100 })).status).toBe(200);
    expect((await call('PATCH', '/api/v1/projects/p1', TOKENS.admin, { status: 'archived' })).status).toBe(200);
  });
});

describe('CORS pairing (the R2 gap)', () => {
  it('required mode reflects a non-loopback origin, with Authorization allowed', async () => {
    const res = await call('GET', '/api/v1/health', TOKENS.observer);
    void res;
    const cors = await fetch(`${base}/api/v1/health`, {
      headers: { Origin: 'https://crew.example.com', Authorization: `Bearer ${TOKENS.observer}` },
    });
    expect(cors.headers.get('access-control-allow-origin')).toBe('https://crew.example.com');
    expect(cors.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
  });

  it('local mode does NOT — loopback origins only, exactly as before', async () => {
    const res = await fetch(`${localBase}/api/v1/health`, {
      headers: { Origin: 'https://crew.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const loop = await fetch(`${localBase}/api/v1/health`, {
      headers: { Origin: 'http://127.0.0.1:4200' },
    });
    expect(loop.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4200');
  });
});

describe('local mode — the zero-config control', () => {
  it('tokenless requests work and act as the implicit full-trust local actor', async () => {
    expect((await fetch(`${localBase}/api/v1/runs`)).status).toBe(200);
    expect(await (await fetch(`${localBase}/api/v1/whoami`)).json()).toEqual({
      actor: { id: 'local', kind: 'human', trust: 'admin' },
      authMode: 'off',
    });
    // Governance writes included — full trust is the local contract.
    expect(
      (
        await fetch(`${localBase}/api/v1/governance/policies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'p1' }),
        })
      ).status,
    ).toBe(200);
    expect(await wsAttempt(`${localBase.replace('http', 'ws')}/ws`)).toBe('open');
  });

  it('the local audit trail records the local actor (one shape downstream)', async () => {
    await fetch(`${localBase}/api/v1/runs/${PARKED}/gate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: false }),
    });
    const { entries } = (await (await fetch(`${localBase}/api/v1/audit?action=gate.decided`)).json()) as {
      entries: AuditEntry[];
    };
    expect(entries[0]?.actor).toEqual({ id: 'local', kind: 'human', trust: 'admin' });
    expect(entries[0]?.detail?.['approve']).toBe(false);
  });
});
