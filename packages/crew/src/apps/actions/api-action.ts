/**
 * API actions (DES-APPS-001 §4 "Action", §7.3): one REST operation or MCP write tool, or one GraphQL mutation
 * with one root field, called with exactly the values the card showed.
 *
 * The outcome of a call: an answer the source gave = `succeeded` (2xx / a result) or `failed` (an error it
 * answered); refused before anything was sent (an address the dialer refuses, a request crew would not
 * build) = `failed`; sent and no answer (a timeout, a lost connection) = `unknown`. Nothing is re-run.
 * A REST operation that maps an `Idempotency-Key` header gets the record id there.
 */

import type { McpRestMapping } from '../../core/types.js';
import { invokeMcpTool } from '../../mcp/invoke.js';
import type { McpUpstreamConfig } from '../../mcp/probe.js';
import { buildRestRequest } from '../../mcp/rest.js';
import { scrubSecrets } from '../../mcp/secrets.js';
import { UpstreamCallError } from '../../mcp/upstream-error.js';
import { DialRefusedError, type DialOptions } from '../../sources/dialer.js';
import { graphqlPost } from '../../sources/graphql.js';
import { graphqlSource } from '../../sources/kinds.js';

export const API_RESULT_MAX = 64 * 1024;

/** The REST argument (if any) the operation sends as its `Idempotency-Key` header. */
export function idempotencyArg(rest: McpRestMapping | null | undefined): string | null {
  if (rest == null) return null;
  for (const [arg, header] of Object.entries(rest.headerMap)) if (header.toLowerCase() === 'idempotency-key') return arg;
  return null;
}

/** How a tool call will go out, for the card (no secret: built without it). */
export function describeToolRequest(config: McpUpstreamConfig, tool: string, rest: McpRestMapping | null | undefined, args: Record<string, unknown>): { operation: string; request: string } {
  if (config.kind === 'rest' && rest != null) {
    const built = buildRestRequest(config, null, rest, args);
    const body = built.init.body !== undefined ? `\n${built.init.body}` : '';
    return { operation: `${rest.method} ${built.url.pathname}`, request: `${rest.method} ${built.url.href}${body}` };
  }
  return { operation: `tool ${tool}`, request: `${config.name}/${tool} ${JSON.stringify(args)}` };
}

/** How a mutation will go out, for the card. */
export function describeMutation(config: McpUpstreamConfig, document: string, variables: Record<string, unknown>, field: string): { operation: string; request: string } {
  return { operation: `mutation ${field}`, request: `POST ${config.url ?? ''}\n${JSON.stringify({ query: document, variables })}` };
}

export type ApiOutcome = { state: 'succeeded'; result: unknown } | { state: 'failed' | 'unknown'; reason: string };

function capped(v: unknown): unknown {
  const text = JSON.stringify(v ?? null);
  return text.length <= API_RESULT_MAX ? (v ?? null) : `${text.slice(0, API_RESULT_MAX)}…`;
}

/** Call one tool. Never throws. */
export async function callTool(config: McpUpstreamConfig, secret: string | null, tool: string, rest: McpRestMapping | null | undefined, args: Record<string, unknown>): Promise<ApiOutcome> {
  const secrets = secret === null ? [] : [secret];
  try {
    const res = await invokeMcpTool(config, secret, tool, args, 30_000, rest ?? null);
    const status = (res['_meta'] as { 'wicked/rest'?: { status?: number } } | undefined)?.['wicked/rest']?.status;
    if (res['isError'] === true) return { state: 'failed', reason: `${config.name}/${tool} answered an error${status !== undefined ? ` (HTTP ${status})` : ''}` };
    return { state: 'succeeded', result: capped(scrubSecrets(res['structuredContent'] ?? res['content'] ?? null, secrets)) };
  } catch (err) {
    return failure(err, `${config.name}/${tool}`);
  }
}

/** Call one mutation. Never throws. */
export async function callMutation(config: McpUpstreamConfig, secret: string | null, document: string, variables: Record<string, unknown>, dial: DialOptions = {}): Promise<ApiOutcome> {
  const secrets = secret === null ? [] : [secret];
  try {
    const { status, json } = await graphqlPost(graphqlSource(config, dial), secret, { query: document, variables });
    const errors = (json as { errors?: unknown } | null)?.errors;
    if (status >= 400 || (Array.isArray(errors) && errors.length > 0)) return { state: 'failed', reason: `the GraphQL source answered ${Array.isArray(errors) ? `${errors.length} error(s)` : `HTTP ${status}`}` };
    return { state: 'succeeded', result: capped(scrubSecrets((json as { data?: unknown } | null)?.data ?? null, secrets)) };
  } catch (err) {
    return failure(err, config.name);
  }
}

function failure(err: unknown, what: string): ApiOutcome {
  // Refused before anything left crew: nothing happened.
  if (err instanceof DialRefusedError) return { state: 'failed', reason: `the connection to ${what} was refused (${err.code}); nothing was sent` };
  if (err instanceof UpstreamCallError) {
    if (err.errorClass === 'boundary') return { state: 'failed', reason: `crew refused the request to ${what} (${err.errorClass}); nothing was sent` };
    if (err.errorClass === 'http') return { state: 'failed', reason: `${what} answered an HTTP error` };
  }
  return { state: 'unknown', reason: `the call to ${what} was sent and no answer came (${err instanceof UpstreamCallError ? err.errorClass : 'transport'}): whether it happened is not known; check the source. It is not run again` };
}
