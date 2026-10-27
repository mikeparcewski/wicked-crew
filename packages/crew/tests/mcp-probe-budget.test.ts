// B6 (PRODUCT-WORKS J6): the MCP preview probe waited 10 s. A server's first start right after
// `npm ci` timed out on a loaded rig, and the failure read so vaguely that triage blamed a CLI
// (opencode). The probe now has one 45 s budget (an http server not yet listening is retried with
// a bounded backoff inside it) and says the server is still starting, never naming a seat.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { MCP_PROBE_TIMEOUT_MS, probeMcpServerWithin, stillStartingMessage, type ProbeBudget } from '../src/mcp/probe.js';
import { removeScratch } from './setup/scratch.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'fixture-server.mjs');

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) removeScratch(dir);
  dir = undefined;
});

/** The argv of a stdio server that sleeps `ms` before it starts serving (a cold first start). */
function slowStart(ms: number): string[] {
  dir = mkdtempSync(join(tmpdir(), 'mcp-probe-budget-'));
  const script = join(dir, 'slow.mjs');
  const spec = join(dir, 'spec.json');
  writeFileSync(spec, JSON.stringify({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }));
  writeFileSync(script, `await new Promise((r) => setTimeout(r, ${ms}));\nawait import(${JSON.stringify(pathToFileURL(FIXTURE).href)});\n`);
  return [script, spec];
}

const budget = (budgetMs: number, extra: Partial<ProbeBudget> = {}): ProbeBudget => ({
  budgetMs,
  retryDelaysMs: [50, 100, 200],
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  ...extra,
});

describe('the MCP probe budget', () => {
  it('is 45 s', () => {
    expect(MCP_PROBE_TIMEOUT_MS).toBe(45_000);
  });

  it('waits for a stdio server that takes longer than the old 10 s budget would allow, scaled down', async () => {
    const args = slowStart(1_500);
    const r = await probeMcpServerWithin({ name: 'slow', kind: 'mcp-stdio', command: process.execPath, args, url: null, auth: null }, null, budget(10_000));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }, 20_000);

  it('says the server is still starting, and names no seat or CLI, when the budget runs out', async () => {
    const args = slowStart(5_000);
    const r = await probeMcpServerWithin({ name: 'slow', kind: 'mcp-stdio', command: process.execPath, args, url: null, auth: null }, null, budget(800));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('the server is still starting');
      expect(r.error).toContain("This is the server's start, not a seat or a CLI");
      expect(r.error).not.toMatch(/opencode|claude|codex/i);
    }
  }, 20_000);

  it('keeps a crash as the server\'s own error, at once (no wait for the budget)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-probe-budget-'));
    const script = join(dir, 'crash.mjs');
    writeFileSync(script, "process.stderr.write('boom: missing module\\n'); process.exit(1);\n");
    const t0 = Date.now();
    const r = await probeMcpServerWithin({ name: 'crash', kind: 'mcp-stdio', command: process.execPath, args: [script], url: null, auth: null }, null, budget(30_000));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain('still starting');
      expect(r.error).toContain('boom: missing module');
    }
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it('keeps polling an http server that is not listening through the whole budget, the last wait cut short', async () => {
    // A port nothing listens on: every attempt is refused at once. The clock is virtual (sleep moves it).
    const probe = createHttpServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    let now = 0;
    const waits: number[] = [];
    const r = await probeMcpServerWithin(
      { name: 'never', kind: 'mcp-http', command: null, args: [], url: `http://127.0.0.1:${port}/mcp`, auth: null },
      null,
      { budgetMs: 45_000, retryDelaysMs: [500, 1_000, 2_000, 4_000, 8_000], sleep: async (ms) => { waits.push(ms); now += ms; }, now: () => now },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nothing answered MCP initialize at its URL within 45 s');
    // 0.5+1+2+4+8x4 = 39.5 s, then a 5.25 s wait (not 8 s, and not giving up) leaves 250 ms for one more try.
    expect(waits.slice(-2)).toEqual([8_000, 5_250]);
    expect(now).toBe(44_750);
  }, 20_000);

  it('reaches an http server that starts listening late in the budget', async () => {
    const reserve = createHttpServer();
    await new Promise<void>((r) => reserve.listen(0, '127.0.0.1', r));
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((r) => reserve.close(() => r()));
    const late = createHttpServer(async (req, res) => {
      const server = new McpServer({ name: 'late', version: '1.0.0' });
      server.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport as never);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      await transport.handleRequest(req, res, body);
      res.on('close', () => void server.close());
    });
    const timer = setTimeout(() => late.listen(port, '127.0.0.1'), 1_200);
    try {
      const r = await probeMcpServerWithin({ name: 'late', kind: 'mcp-http', command: null, args: [], url: `http://127.0.0.1:${port}/mcp`, auth: null }, null, budget(6_000, { retryDelaysMs: [200, 400, 800] }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.tools.map((t) => t.name)).toEqual(['ping']);
    } finally {
      clearTimeout(timer);
      await new Promise<void>((r) => late.close(() => r()));
    }
  }, 20_000);

  it('words both transports', () => {
    expect(stillStartingMessage(45_000, 'mcp-stdio')).toContain('within 45 s');
    expect(stillStartingMessage(45_000, 'mcp-http')).toContain('at its URL within 45 s');
  });
});
