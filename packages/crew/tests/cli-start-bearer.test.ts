// cli/index.ts — daemonFetch bearer-token injection (#632)
//
// `wicked-crew start` POSTs to /api/v1/runs. Under WICKED_RUNTIME=team the daemon requires
// a bearer token; without one the request returns 401, which the start command surfaces as
// "launch failed (401)". The fix adds WICKED_CREW_TOKEN → Authorization: Bearer header
// injection inside daemonFetch via the exported withBearerHeader helper.
//
// Tests:
//   (a) Unit: withBearerHeader injects the header when the env var is set; leaves headers
//       untouched when absent. No server needed.
//   (b) Integration: a minimal node:http server that gates on a known bearer token confirms
//       that fetch calls built by withBearerHeader carry the header (or not) correctly.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { withBearerHeader } from '../src/cli/bearer.js';

// ── Unit ──────────────────────────────────────────────────────────────────────

describe('withBearerHeader', () => {
  const TOKEN = 'test-crew-token-abc';

  afterEach(() => {
    delete process.env['WICKED_CREW_TOKEN'];
  });

  it('adds Authorization: Bearer when WICKED_CREW_TOKEN is set', () => {
    const result = withBearerHeader({ method: 'POST' }, { WICKED_CREW_TOKEN: TOKEN });
    expect((result.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(result.method).toBe('POST');
  });

  it('leaves headers unchanged when WICKED_CREW_TOKEN is absent', () => {
    const result = withBearerHeader({ method: 'GET', headers: { 'Content-Type': 'application/json' } }, {});
    expect((result.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect((result.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('returns an empty RequestInit when init is undefined and no token is set', () => {
    const result = withBearerHeader(undefined, {});
    expect(result).toEqual({});
  });

  it('preserves caller headers alongside the injected bearer', () => {
    const result = withBearerHeader(
      { headers: { 'Content-Type': 'application/json' } },
      { WICKED_CREW_TOKEN: TOKEN },
    );
    const h = result.headers as Record<string, string>;
    expect(h['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(h['Content-Type']).toBe('application/json');
  });

  it('reads WICKED_CREW_TOKEN from process.env when no env override is supplied', () => {
    process.env['WICKED_CREW_TOKEN'] = TOKEN;
    const result = withBearerHeader({ method: 'POST' });
    expect((result.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
  });
});

// ── Integration: stub HTTP server ─────────────────────────────────────────────

describe('withBearerHeader — end-to-end with a bearer-gated server', () => {
  const GOOD_TOKEN = 'valid-daemon-token';

  afterEach(() => {
    delete process.env['WICKED_CREW_TOKEN'];
  });

  it('401 without the env var — the request carries no Authorization header', async () => {
    const server = createServer((req, res) => {
      const auth = req.headers['authorization'];
      if (auth === `Bearer ${GOOD_TOKEN}`) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: 'stub-run-id' }));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    delete process.env['WICKED_CREW_TOKEN'];
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/runs`,
      withBearerHeader({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    );

    await new Promise<void>((r) => server.close(() => r()));
    expect(res.status).toBe(401);
  }, 5000);

  it('201 with WICKED_CREW_TOKEN set — the request carries the Authorization header', async () => {
    const server = createServer((req, res) => {
      const auth = req.headers['authorization'];
      if (auth === `Bearer ${GOOD_TOKEN}`) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runId: 'stub-run-id' }));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    process.env['WICKED_CREW_TOKEN'] = GOOD_TOKEN;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/v1/runs`,
      withBearerHeader({ method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    );

    await new Promise<void>((r) => server.close(() => r()));
    expect(res.status).toBe(201);
  }, 5000);
});
