/**
 * Probe an upstream MCP server: connect, `initialize`, page through `tools/list`, disconnect
 * (DES-MCP-TOOLS-001 §8 `POST /mcp/servers/preview` and `/test`).
 *
 * - Bounded: the whole probe has one budget ({@link MCP_PROBE_TIMEOUT_MS}, 45 s). A stdio server
 *   gets all of it to answer `initialize` (a first start right after `npm ci` can take well over
 *   10 s on a loaded host, j6-cert 2026-10-27); an http server that is not listening yet is tried
 *   again with a bounded backoff inside the same budget. A server that never answers is closed and
 *   the probe fails with words that name the server's start, never a seat or a CLI (crew B6).
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
import { probeRestServer, type RestEgress } from './rest.js';
import { scrubSecrets } from './secrets.js';

export const MCP_PROBE_TIMEOUT_MS = 45_000;
/** The waits between http connection attempts while the server is not listening yet. */
export const MCP_PROBE_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000];
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
  | { ok: true; serverInfo: { name: string; version: string } | null; tools: ProbedTool[]; skipped?: string[]; egress?: RestEgress }
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

/** Knobs of {@link probeMcpServerWithin}; tests shorten them. */
export interface ProbeBudget {
  budgetMs: number;
  retryDelaysMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_BUDGET: ProbeBudget = {
  budgetMs: MCP_PROBE_TIMEOUT_MS,
  retryDelaysMs: MCP_PROBE_RETRY_DELAYS_MS,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
};

/** A probe attempt that ran out of time, or found nothing listening: the server may still be starting. */
class StillStarting extends Error {}

/** An http connection the server refused or never accepted (not listening yet). */
function notListening(message: string): boolean {
  return /ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|other side closed/i.test(message);
}

/** The probe's words when the budget ran out: the server's start, not a seat or a CLI. */
export function stillStartingMessage(budgetMs: number, kind: McpUpstreamKind): string {
  const s = Math.round(budgetMs / 1000);
  return kind === 'mcp-http'
    ? `the server is still starting: nothing answered MCP initialize at its URL within ${s} s. This is the server's start, not a seat or a CLI: start the server (or wait for it) and probe again`
    : `the server is still starting: no answer to MCP initialize within ${s} s (a first start right after npm ci can be slow). This is the server's start, not a seat or a CLI: probe again, or run its command by hand to see its output`;
}

/** The real prober. Every string it returns has `secret` scrubbed out. */
export const probeMcpServer: Prober = async (config, secret) => probeMcpServerWithin(config, secret, DEFAULT_BUDGET);

export async function probeMcpServerWithin(config: McpUpstreamConfig, secret: string | null, budget: ProbeBudget): Promise<ProbeResult> {
  if (config.kind === 'rest') return probeRestServer(config, secret);
  const secrets = secret === null ? [] : [secret];
  const end = budget.now() + budget.budgetMs;
  let lastTail = '';
  for (let attempt = 0; ; attempt++) {
    const remaining = end - budget.now();
    const outcome = await probeOnce(config, secret, Math.max(remaining, 1));
    if (outcome.ok) return scrubSecrets(outcome.result, secrets);
    lastTail = outcome.tail;
    const retryable = outcome.stillStarting || (config.kind === 'mcp-http' && notListening(outcome.message));
    const delay = budget.retryDelaysMs[Math.min(attempt, budget.retryDelaysMs.length - 1)] ?? 0;
    // A stdio attempt that timed out has used the whole budget; an http one that found nothing
    // listening waits and tries again while the budget lasts. Any other failure is the server's own.
    if (retryable && config.kind === 'mcp-http' && end - budget.now() > delay) {
      await budget.sleep(delay);
      continue;
    }
    const message = retryable ? stillStartingMessage(budget.budgetMs, config.kind) : outcome.message;
    return scrubSecrets({ ok: false, error: lastTail === '' ? message : `${message}; stderr: ${lastTail}` }, secrets);
  }
}

type Attempt =
  | { ok: true; result: ProbeResult }
  | { ok: false; message: string; tail: string; stillStarting: boolean };

/** One connect + `tools/list`, within `deadlineMs`. Secrets are scrubbed by the caller. */
async function probeOnce(config: McpUpstreamConfig, secret: string | null, deadlineMs: number): Promise<Attempt> {
  const { transport, stderrTail } = transportFor(config, secret);
  const client = new Client({ name: 'wicked-crew-mcp-probe', version: '1' }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StillStarting('timed out')), deadlineMs);
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
    return { ok: true, result: await Promise.race([work, deadline]) };
  } catch (err) {
    work.catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message, tail: stderrTail().trim(), stillStarting: err instanceof StillStarting };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
