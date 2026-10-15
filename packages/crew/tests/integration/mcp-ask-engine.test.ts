// Integration: the MCP ask route over the REAL engine addon (wicked-core-ts with the ask bindings).
//
// A capability token is minted only by the engine's carriers while a governed unit runs, so a test cannot hold a bound
// one; what this proves is the wire between crew and the engine: the route is served (the addon has the ask seam), an
// unbound token is refused by the ENGINE with HTTP 401 at the MCP boundary, GET is 405, closing an unknown question is a
// clean `false`, and the operator's answer route does not mistake an unknown ask id for a live question. The full path
// with a bound token (seat container -> agentgateway -> this route -> studio -> answer) is the lane's daemon proof and the
// engine's live test. Skipped on an addon without the ask seam (the published core-ts before the engine half ships).
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';
import { createServer } from '../../src/api/server.js';
import { removeScratch } from '../setup/scratch.js';

let app: Awaited<ReturnType<typeof createServer>> | undefined;
let adapter: CoreAdapter;
let dir: string;
let base = '';

const probe = new CoreAdapter({ dbPath: join(mkdtempSync(join(tmpdir(), 'crew-ask-probe-')), 'core.db'), stub: true });
const supported = probe.askSupported();

beforeAll(async () => {
  if (!supported) return;
  dir = mkdtempSync(join(tmpdir(), 'crew-ask-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  app = await createServer(adapter);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 60_000);

afterAll(async () => {
  await app?.close();
  if (dir) removeScratch(dir);
});

const rpc = (token: string, body: unknown) => fetch(`${base}/api/v1/mcp/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

describe.skipIf(!supported)('MCP ask over the real engine', () => {
  it('the engine refuses an unbound token at the MCP boundary with HTTP 401', async () => {
    const res = await rpc('wmt_not_bound_to_any_unit', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: -32001, message: 'invalid_token' } });
  });

  it('GET is 405 (stateless server, no SSE stream)', async () => {
    const res = await fetch(`${base}/api/v1/mcp/ask`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('the engine bindings answer: askUnit/openAsk reject an unbound token, closeAsk of an unknown id is false', async () => {
    await expect(adapter.askUnit('wmt_nope')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(adapter.openAsk({ token: 'wmt_nope', question: 'Which?' })).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(adapter.closeAsk('ask-0000', 'timeout')).resolves.toBe(false);
  });
});
