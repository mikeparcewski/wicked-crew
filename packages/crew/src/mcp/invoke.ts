/**
 * Invoke one tool on one upstream MCP server (DES-MCP-TOOLS-001 §6 step 6).
 *
 * - One connection per call: connect, `tools/call`, close. The upstream is reached exactly as the
 *   registry's probe reaches it (`transportFor`: the SDK's safe env for stdio plus the ONE variable
 *   the secret is injected into, or the one auth header for http), so the secret is resolved and
 *   injected here and nowhere else.
 * - Bounded: connect and call share one deadline; a hung upstream is closed and the call fails
 *   with the error class `timeout`.
 * - Every failure is classified ({@link classifyUpstreamError}) so the broker can decide whether a
 *   retry is allowed (step 7: transport errors, 429 and 5xx only) and what the call record says.
 *
 * A `rest` upstream is not an MCP server: its tools are single HTTP requests (`rest.ts`).
 *
 * The result is returned RAW: the broker scrubs it (D-2) before anything else sees it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import type { McpRestMapping } from '../core/types.js';
import { transportFor, type McpUpstreamConfig } from './probe.js';
import { invokeRestTool } from './rest.js';
import { UpstreamCallError } from './upstream-error.js';

/** The default per-call deadline (connect + call). */
export const MCP_CALL_TIMEOUT_MS = 30_000;

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
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamCallError('timeout', false, `timed out after ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
  });
  const work = (async (): Promise<UpstreamToolResult> => {
    await client.connect(transport);
    return (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs })) as UpstreamToolResult;
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
