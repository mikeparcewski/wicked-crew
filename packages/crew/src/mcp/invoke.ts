/**
 * Invoke one tool on one upstream MCP server (DES-MCP-TOOLS-001 §6 step 6).
 *
 * - One connection per call: connect, `tools/call`, close. The upstream is reached exactly as the
 *   registry's probe reaches it (`transportFor`: the SDK's safe env for stdio plus the ONE variable
 *   the secret is injected into, or the one auth header for http), so the secret is resolved and
 *   injected here and nowhere else.
 * - Bounded: connect and call share one deadline; a hung upstream is closed and the call fails
 *   with the error class `timeout`. The message says which half ran out: a stdio server is started
 *   fresh for each call, so a cold start under host load is the usual cause (crew#1212). The
 *   broker scales the deadline with host load ({@link mcpCallBound}).
 * - Every failure is classified ({@link classifyUpstreamError}) so the broker can decide whether a
 *   retry is allowed (step 7: transport errors, 429 and 5xx only) and what the call record says.
 *
 * A `rest` upstream is not an MCP server: its tools are single HTTP requests (`rest.ts`).
 *
 * The result is returned RAW: the broker scrubs it (D-2) before anything else sees it.
 */

import { cpus, loadavg } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { McpRestMapping } from '../core/types.js';
import { transportFor, type McpUpstreamConfig } from './probe.js';
import { invokeRestTool } from './rest.js';
import { UpstreamCallError } from './upstream-error.js';

/** The default per-call deadline (connect + call) on a host with headroom. */
export const MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * The cap on the host-load multiplier, as the engine's repo-checks floor caps its own
 * (`LOAD_FACTOR_CAP` in core's repo_checks.rs): a wedged host cannot hold a call for minutes.
 * 30 s × 3 = 90 s stays inside garden's broker shim's 150 s wait.
 */
export const MCP_LOAD_FACTOR_CAP = 3;

/** The host's 1-min load average and logical CPU count (`null` load where the OS reports none). */
export interface HostLoad {
  load1: number | null;
  cores: number;
}

export function hostLoad(): HostLoad {
  const load1 = loadavg()[0];
  // Windows reports [0, 0, 0]: no load average, not an idle host.
  return { load1: process.platform === 'win32' || load1 === undefined ? null : load1, cores: cpus().length };
}

/**
 * The deadline for one call right now (crew#1212): `base × clamp(load1 / cores, 1, cap)`, the floor's
 * rule. On rig run J6 the first call after approval timed out at 30 s at load 40–47 on 14 CPUs: the
 * fastmcp + OpenTelemetry server's cold start alone took 10.9 s at that load, against 1.5 s at rest.
 * `note` says how the bound was reached, for the error a timeout returns.
 */
export function mcpCallBound(baseMs: number, load: HostLoad = hostLoad()): { ms: number; note: string } {
  const { load1, cores } = load;
  const factor =
    load1 !== null && Number.isFinite(load1) && cores > 0 ? Math.min(Math.max(load1 / cores, 1), MCP_LOAD_FACTOR_CAP) : 1;
  const ms = Math.round(baseMs * factor);
  const note =
    load1 === null || !Number.isFinite(load1)
      ? `${seconds(ms)} (no host load reading)`
      : `${seconds(ms)} = ${seconds(baseMs)} × ${factor.toFixed(2)} for 1-min load ${load1.toFixed(1)} on ${cores} CPUs`;
  return { ms, note };
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** How far past the call's deadline the SDK's own request timeouts are set. */
const SDK_TIMEOUT_SLACK_MS = 5_000;

export { UpstreamCallError, type UpstreamErrorClass } from './upstream-error.js';

/** A `tools/call` result as the upstream sent it (`content`, `structuredContent?`, `isError?`, ...). */
export type UpstreamToolResult = Record<string, unknown>;

export type Invoker = (
  config: McpUpstreamConfig,
  secret: string | null,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  /** A `rest` tool's request mapping (slice S5a); `null` for an MCP server's tool. */
  rest?: McpRestMapping | null,
) => Promise<UpstreamToolResult>;

/**
 * Classify a failure: transport errors (the connection could not be made or closed under the
 * call), HTTP 429 and 5xx are retryable; a timeout, any other HTTP status and a JSON-RPC error the
 * server answered are not.
 */
export function classifyUpstreamError(err: unknown): UpstreamCallError {
  if (err instanceof UpstreamCallError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof StreamableHTTPError) {
    const status = typeof err.code === 'number' ? err.code : 0;
    return new UpstreamCallError('http', status === 429 || status >= 500, message);
  }
  if (err instanceof McpError) {
    if (err.code === (ErrorCode.ConnectionClosed as number)) return new UpstreamCallError('transport', true, message);
    if (err.code === (ErrorCode.RequestTimeout as number)) return new UpstreamCallError('timeout', false, message);
    return new UpstreamCallError('protocol', false, message);
  }
  return new UpstreamCallError('transport', true, message);
}

/** The real invoker. */
export const invokeMcpTool: Invoker = async (config, secret, tool, args, timeoutMs, rest = null) => {
  if (config.kind === 'rest') {
    // A REST tool is one pinned HTTP request, built from its allowlisted arguments (I6).
    if (rest === null) throw new UpstreamCallError('protocol', false, `${tool} has no REST mapping; test and save the server again`);
    return invokeRestTool(config, secret, rest, args, timeoutMs);
  }
  const { transport, stderrTail } = transportFor(config, secret);
  const client = new Client({ name: 'wicked-crew-mcp-broker', version: '1' }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  /** Which half of the call the deadline caught: the connection, or the tool's own answer. */
  let connected = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const cause = connected
        ? `the server was up, but ${tool} did not answer`
        : config.kind === 'mcp-stdio'
          ? 'the server was still starting (crew starts a stdio server for each call, and a cold start is slow on a loaded host)'
          : 'the server did not accept the connection';
      reject(new UpstreamCallError('timeout', false, `timed out after ${seconds(timeoutMs)}: ${cause}`));
    }, timeoutMs);
  });
  // The SDK's own request timeouts sit past this deadline, so the deadline above is the one that
  // fires and names its cause. `initialize` otherwise has the SDK's 60 s default, which a scaled
  // bound (up to 90 s) would never reach (crew#1212).
  const sdkTimeout = { timeout: timeoutMs + SDK_TIMEOUT_SLACK_MS };
  const work = (async (): Promise<UpstreamToolResult> => {
    await client.connect(transport, sdkTimeout);
    connected = true;
    return (await client.callTool({ name: tool, arguments: args }, undefined, sdkTimeout)) as UpstreamToolResult;
  })();
  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    work.catch(() => undefined);
    const classified = classifyUpstreamError(err);
    const tail = stderrTail().trim();
    throw tail === '' ? classified : new UpstreamCallError(classified.errorClass, classified.retryable, `${classified.message}; stderr: ${tail}`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
};
