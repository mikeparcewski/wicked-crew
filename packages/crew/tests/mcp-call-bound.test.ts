// crew#1212 (J6): a chat's first MCP call after approval timed out at a fixed 30 s at host load 40–47 on
// 14 CPUs. The fastmcp + OpenTelemetry server is started fresh for each call, and its cold start alone took
// 10.9 s at that load. The deadline now scales with host load as the engine's repo-checks floor does
// (`base × clamp(load1 / cores, 1, 3)`), and a timeout says which half ran out and how the bound was set.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { invokeMcpTool, MCP_CALL_TIMEOUT_MS, mcpCallBound } from '../src/mcp/invoke.js';
import { UpstreamCallError } from '../src/mcp/upstream-error.js';
import type { McpUpstreamConfig } from '../src/mcp/probe.js';

const SLOW_CALL_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp', 'slow-call-server.mjs');

const stdio = (args: string[]): McpUpstreamConfig => ({
  name: 'slow',
  kind: 'mcp-stdio',
  command: process.execPath,
  args,
  url: null,
  auth: null,
});

async function failure(p: Promise<unknown>): Promise<UpstreamCallError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof UpstreamCallError) return err;
    throw err;
  }
  throw new Error('the call did not fail');
}

describe('crew#1212 — the MCP call deadline scales with host load', () => {
  it('keeps the base bound on a host with headroom, and on a host with no load reading', () => {
    expect(mcpCallBound(MCP_CALL_TIMEOUT_MS, { load1: 3.2, cores: 14 }).ms).toBe(30_000);
    expect(mcpCallBound(MCP_CALL_TIMEOUT_MS, { load1: null, cores: 14 })).toEqual({
      ms: 30_000,
      note: '30 s (no host load reading)',
    });
  });

  it('scales with load1 / cores, as the floor does: the J6 load gets 90 s, not 30', () => {
    expect(mcpCallBound(MCP_CALL_TIMEOUT_MS, { load1: 28, cores: 14 }).ms).toBe(60_000);
    expect(mcpCallBound(MCP_CALL_TIMEOUT_MS, { load1: 42, cores: 14 })).toEqual({
      ms: 90_000,
      note: '90 s = 30 s × 3.00 for 1-min load 42.0 on 14 CPUs',
    });
  });

  it('is capped at 3x, so a wedged host cannot hold a call for minutes', () => {
    expect(mcpCallBound(MCP_CALL_TIMEOUT_MS, { load1: 400, cores: 14 }).ms).toBe(90_000);
  });

  it('a server that never finishes starting times out naming the start, not the tool', async () => {
    const err = await failure(
      invokeMcpTool(stdio(['-e', 'setInterval(() => undefined, 1000)']), null, 'wt_never', {}, 1_500),
    );
    expect(err.errorClass).toBe('timeout');
    expect(err.message).toMatch(/^timed out after 2 s: the server was still starting \(crew starts a stdio server for each call/);
  }, 20_000);

  it('a server that is up but whose tool never answers times out naming the tool', async () => {
    const err = await failure(invokeMcpTool(stdio([SLOW_CALL_SERVER]), null, 'wt_never', {}, 5_000));
    expect(err.errorClass).toBe('timeout');
    expect(err.message).toMatch(/^timed out after 5 s: the server was up, but wt_never did not answer/);
  }, 30_000);
});
