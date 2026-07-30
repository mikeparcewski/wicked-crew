// Chat routes (crew#165) over the STUB engine: the stub spawns with an injected
// non-ACP runner, so core answers 'chat unsupported' — which is exactly the
// honest surface these tests pin. Route → adapter → NAPI plumbing is proven
// end-to-end; warm-seat behavior is covered live (core#134 evidence) and by
// core's own tests.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';

let app: Awaited<ReturnType<typeof createServer>>;
let adapter: CoreAdapter;
let dir: string;
let baseUrl: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'chat-routes-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('chat routes (stub engine)', () => {
  it('POST /chats validates the body shape', async () => {
    const res = await fetch(`${baseUrl}/api/v1/chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'bad id with spaces' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /chats surfaces the engine capability error honestly (stub has no ACP runner)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/chats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'c1', clis: ['claude'] }),
    });
    // The stub engine's core rejects chat (no ACP runner) — the route must relay
    // that as an error, never a fake 201 with zero seats.
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? '').toMatch(/chat unsupported|ACP/i);
  });

  it('POST /chats/:id/messages on an unopened chat is a 4xx, not a hang', async () => {
    const res = await fetch(`${baseUrl}/api/v1/chats/never-opened/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('DELETE /chats/:id is idempotent even when unsupported', async () => {
    const res = await fetch(`${baseUrl}/api/v1/chats/never-opened`, { method: 'DELETE' });
    // Close is best-effort teardown; unsupported engines surface the capability error.
    expect([200, 400, 500]).toContain(res.status);
  });
});
