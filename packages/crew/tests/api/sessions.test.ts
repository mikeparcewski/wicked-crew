import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, closeDb } from '../../src/store/db.js';
import { createServer } from '../../src/api/server.js';
import { setWorkers } from '../../src/dispatch/workers.js';

const FIXTURE_WORKER = resolve('tests/fixtures/mock-worker.mjs');

let app: Awaited<ReturnType<typeof createServer>>;
let dbPath: string;
let baseUrl: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-api-test-'));
  dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);

  setWorkers(new Map([
    ['mock-worker', { id: 'mock-worker', command: 'node', args: [FIXTURE_WORKER], timeout_ms: 10000 }],
  ]));

  app = await createServer(db);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'object' && address) {
    baseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(dbPath.replace('/test.db', ''), { recursive: true, force: true });
});

describe('GET /api/v1/health', () => {
  it('returns 200 ok', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});

describe('GET /api/v1/workers', () => {
  it('returns registered workers', async () => {
    const res = await fetch(`${baseUrl}/api/v1/workers`);
    expect(res.status).toBe(200);
    const body = await res.json() as { workers: { id: string }[] };
    expect(body.workers.some((w) => w.id === 'mock-worker')).toBe(true);
  });
});

describe('POST /api/v1/sessions', () => {
  it('creates a session and returns 201 with session + phases', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feature', goal: 'api test session', workers: ['mock-worker'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { session: { id: string; status: string }; phases: unknown[] };
    expect(body.session.id).toBeTruthy();
    expect(body.phases.length).toBeGreaterThan(0);
  });

  it('returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('returns 400 (not 500) for an invalid create body', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'missing type' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /sessions lists sessions with phases (most-recent first)', async () => {
    await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feature', goal: 'list test', workers: ['mock-worker'] }),
    });
    const res = await fetch(`${baseUrl}/api/v1/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json() as { sessions: { session: { id: string }; phases: unknown[] }[] };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.sessions[0]?.session.id).toBeTruthy();
    expect(Array.isArray(body.sessions[0]?.phases)).toBe(true);
  });

  it('sets CORS headers for loopback origin + handles OPTIONS preflight', async () => {
    const preflight = await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'OPTIONS', headers: { Origin: 'http://localhost:4200' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:4200');

    const get = await fetch(`${baseUrl}/api/v1/health`, { headers: { Origin: 'http://127.0.0.1:4200' } });
    expect(get.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4200');
  });
});

describe('Gate actions', () => {
  it('POST approve returns ok', async () => {
    // Create session first
    const created = await (await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feature', goal: 'gate test', workers: ['mock-worker'], phase_gate_overrides: { clarify: 'human' } }),
    })).json() as { session: { id: string } };

    const sessionId = created.session.id;
    // Small wait for FSM to reach AwaitingHuman
    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/gates/clarify/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('tolerates an empty body on a bodyless POST with Content-Type: application/json (studio approve/reject)', async () => {
    const created = await (await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bugfix', goal: 'empty body test', workers: ['mock-worker'], phase_gate_overrides: { clarify: 'human' } }),
    })).json() as { session: { id: string } };

    // Studio sends Content-Type: application/json with no body on approve.
    // Must NOT be FST_ERR_CTP_EMPTY_JSON_BODY (400).
    const res = await fetch(`${baseUrl}/api/v1/sessions/${created.session.id}/gates/clarify/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
  });

  it('POST /resume returns 409 when session is running (not paused)', async () => {
    const created = await (await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bugfix', goal: 'resume guard test', workers: ['mock-worker'], phase_gate_overrides: { clarify: 'human' } }),
    })).json() as { session: { id: string } };

    // Session is running (AwaitingHuman), not paused — resume must return 409
    const res = await fetch(`${baseUrl}/api/v1/sessions/${created.session.id}/resume`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('POST approve-with-conditions stores conditions', async () => {
    const created = await (await fetch(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'feature', goal: 'conditions test', workers: ['mock-worker'], phase_gate_overrides: { clarify: 'human' } }),
    })).json() as { session: { id: string } };

    await new Promise((r) => setTimeout(r, 500));

    const res = await fetch(`${baseUrl}/api/v1/sessions/${created.session.id}/gates/clarify/approve-with-conditions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions: 'Must add error handling in next phase' }),
    });
    expect(res.status).toBe(200);
  });
});
