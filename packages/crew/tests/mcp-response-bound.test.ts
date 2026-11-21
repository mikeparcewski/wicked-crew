import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { invokeMcpTool } from '../src/mcp/invoke.js';
import { type McpUpstreamConfig, probeMcpServer, transportFor } from '../src/mcp/probe.js';

const stdio: McpUpstreamConfig = {
  name: 'response-bound', kind: 'mcp-stdio', command: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/mcp/response-bound-server.mjs', import.meta.url))], url: null, auth: null,
};
const tooLarge = { errorClass: 'too_large', retryable: false, message: "the server's answer passed crew's 10 MiB read bound; crew stopped reading it" };

describe('MCP responses before SDK parsing (crew#1297)', () => {
  it('handles a bound trip with no racer and still rejects a later race', async () => {
    const { bound } = transportFor(stdio, null);
    bound.trip();
    // Leave the rejection without a racer for an event-loop turn (Vitest catches unhandled rejections).
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(Promise.race([bound.promise, new Promise<never>(() => {})])).rejects.toMatchObject(tooLarge);
  });

  it('refuses a 12 MiB stdio answer quickly without retry; a fresh normal invocation answers', async () => {
    const started = Date.now();
    await expect(invokeMcpTool(stdio, null, 'answer', { big: true }, 15_000)).rejects.toMatchObject(tooLarge);
    expect(Date.now() - started).toBeLessThan(8_000);
    await expect(invokeMcpTool(stdio, null, 'answer', {}, 15_000)).resolves.toMatchObject({ content: [{ text: 'ok' }] });
  }, 25_000);

  for (const mode of ['json', 'sse'] as const) {
    it(`refuses a 12 MiB HTTP ${mode} answer; a following normal invocation answers`, async () => {
      const server = createServer((req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        let body = '';
        req.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
        req.on('end', () => {
          const msg = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { big?: boolean } } };
          if (msg.id === undefined) { res.writeHead(202).end(); return; }
          const result = msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-bound', version: '1' } }
            : { content: [{ type: 'text', text: msg.params?.arguments?.big === true ? 'x'.repeat(12 * 1024 * 1024) : 'ok' }] };
          const json = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
          res.writeHead(200, { 'content-type': mode === 'json' ? 'application/json' : 'text/event-stream' });
          res.end(mode === 'json' ? json : `event: message\ndata: ${json}\n\n`);
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no server address');
      const config: McpUpstreamConfig = { ...stdio, kind: 'mcp-http', url: `http://127.0.0.1:${address.port}/mcp`, address: { allow: ['127.0.0.0/8'], plaintext: true } };
      try {
        await expect(invokeMcpTool(config, null, 'answer', { big: true }, 15_000).then(() => 'resolved oversized answer')).rejects.toMatchObject(tooLarge);
        await expect(invokeMcpTool(config, null, 'answer', {}, 15_000)).resolves.toMatchObject({ content: [{ text: 'ok' }] });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      }
    }, 25_000);
  }

  it('refuses a stdio tools/list page past the bound, then probes a normal server', async () => {
    expect(await probeMcpServer({ ...stdio, args: [...stdio.args, 'big-list'] }, null)).toEqual({ ok: false, error: tooLarge.message });
    expect(await probeMcpServer(stdio, null)).toMatchObject({ ok: true, tools: [{ name: 'answer' }] });
  }, 25_000);
});
