/**
 * Probe an upstream MCP server: connect, `initialize`, page through `tools/list`, disconnect
 * (DES-MCP-TOOLS-001 §8 `POST /mcp/servers/preview` and `/test`).
 *
 * - Bounded: the whole probe has one deadline (10 s by default); a server that hangs is closed and
 *   the probe fails with `timed out`.
 * - Hardened env for stdio: the SDK's safe inherited set (HOME, LOGNAME, PATH, SHELL, TERM, USER on
 *   POSIX) plus, when the server has auth, the ONE variable the secret is injected into. Nothing
 *   else of the daemon's env (tokens, `WICKED_*`) reaches the upstream.
 * - Scrubbed: the resolved secret is removed from everything the probe returns — tool
 *   descriptions and schemas, server info, and an error's message and stderr tail — so an
 *   upstream that echoes its credential cannot carry it into a response (D-2).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpAuthConfig, McpRestMapping, McpToolAnnotations, McpUpstreamKind } from '../core/types.js';
import { probeRestServer } from './rest.js';
import { scrubSecrets } from './secrets.js';

export const MCP_PROBE_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 2048;
const MAX_TOOLS = 512;
const MAX_PAGES = 32;

/** What crew needs to reach an upstream. Secret values are passed separately, never stored here. */
export interface McpUpstreamConfig {
  name: string;
  kind: McpUpstreamKind;
  command: string | null;
  args: string[];
  url: string | null;
  auth: McpAuthConfig | null;
  /** `rest` only (slice S5a): where the OpenAPI document is fetched from. */
  openapiUrl?: string | null;
  /** `rest` only: the OpenAPI document as pasted (instead of `openapiUrl`). */
  openapi?: Record<string, unknown> | null;
  /** `rest` only: the operations to wrap; `null`/absent = all. */
  operations?: string[] | null;
}

export interface ProbedTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  annotations: McpToolAnnotations | null;
  /** A `rest` tool's request mapping; absent/`null` for an MCP server's tool. */
  rest?: McpRestMapping | null;
}

export type ProbeResult =
  | { ok: true; serverInfo: { name: string; version: string } | null; tools: ProbedTool[]; skipped?: string[] }
  | { ok: false; error: string };

export type Prober = (config: McpUpstreamConfig, secret: string | null) => Promise<ProbeResult>;

const ANNOTATION_BOOLEANS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Keep only the annotation fields the spec defines, with the types it defines. */
export function normalizeAnnotations(raw: unknown): McpToolAnnotations | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: McpToolAnnotations = {};
  for (const key of ANNOTATION_BOOLEANS) {
    if (typeof src[key] === 'boolean') out[key] = src[key] as boolean;
  }
  if (typeof src['title'] === 'string') out.title = src['title'];
  return Object.keys(out).length === 0 ? null : out;
}

function objectOrNull(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * The transport to one upstream, with the hardened env (stdio) or the auth header (http). Shared by
 * the probe and the broker's call path (`invoke.ts`), so both reach an upstream the same way.
 */
export function transportFor(config: McpUpstreamConfig, secret: string | null): { transport: Transport; stderrTail: () => string } {
  if (config.kind === 'rest') throw new Error('a rest upstream is not an MCP server; it has no MCP transport');
  if (config.kind === 'mcp-stdio') {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    if (config.auth?.env !== undefined && secret !== null) env[config.auth.env] = secret;
    const transport = new StdioClientTransport({ command: config.command ?? '', args: config.args, env, stderr: 'pipe' });
    let tail = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    return { transport, stderrTail: () => tail };
  }
  const headers: Record<string, string> = {};
  if (config.auth?.header !== undefined && secret !== null) headers[config.auth.header] = `${config.auth.prefix ?? ''}${secret}`;
  const http = new StreamableHTTPClientTransport(new URL(config.url ?? ''), { requestInit: { headers } });
  // The SDK's own class declares `sessionId?: string` against its `Transport` interface, which
  // `exactOptionalPropertyTypes` refuses; the runtime shapes are the same.
  return { transport: http as unknown as Transport, stderrTail: () => '' };
}

/** The real prober. Every string it returns has `secret` scrubbed out. */
export const probeMcpServer: Prober = async (config, secret) => {
  if (config.kind === 'rest') return probeRestServer(config, secret);
  const secrets = secret === null ? [] : [secret];
  const { transport, stderrTail } = transportFor(config, secret);
  const client = new Client({ name: 'wicked-crew-mcp-probe', version: '1' }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${MCP_PROBE_TIMEOUT_MS / 1000} s`)), MCP_PROBE_TIMEOUT_MS);
  });
  const work = (async (): Promise<ProbeResult> => {
    await client.connect(transport);
    const tools: ProbedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await client.listTools(cursor === undefined ? {} : { cursor });
      for (const t of res.tools) {
        if (tools.length >= MAX_TOOLS) break;
        tools.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : null,
          inputSchema: objectOrNull(t.inputSchema),
          outputSchema: objectOrNull((t as { outputSchema?: unknown }).outputSchema),
          annotations: normalizeAnnotations(t.annotations),
        });
      }
      cursor = res.nextCursor;
      if (cursor === undefined || tools.length >= MAX_TOOLS) break;
    }
    const info = client.getServerVersion();
    return { ok: true, serverInfo: info === undefined ? null : { name: info.name, version: info.version }, tools };
  })();
  try {
    return scrubSecrets(await Promise.race([work, deadline]), secrets);
  } catch (err) {
    work.catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    const tail = stderrTail().trim();
    return scrubSecrets({ ok: false, error: tail === '' ? message : `${message}; stderr: ${tail}` }, secrets);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
};
