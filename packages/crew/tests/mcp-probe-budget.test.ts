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

  it('retries an http server that is not listening yet, within the budget', async () => {
    // Reserve a port, close it, and start listening there only after a delay.
    const probe = createHttpServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    let refused = 0;
    const sleep = async (ms: number): Promise<void> => {
      refused += 1;
      await new Promise((r) => setTimeout(r, ms));
    };
    const r = await probeMcpServerWithin({ name: 'later', kind: 'mcp-http', command: null, args: [], url: `http://127.0.0.1:${port}/mcp`, auth: null }, null, budget(1_500, { sleep }));
    // Nothing ever listened: retried, then the still-starting words.
    expect(refused).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nothing answered MCP initialize at its URL within 2 s');
  }, 20_000);

  it('words both transports', () => {
    expect(stillStartingMessage(45_000, 'mcp-stdio')).toContain('within 45 s');
    expect(stillStartingMessage(45_000, 'mcp-http')).toContain('at its URL within 45 s');
  });
});
