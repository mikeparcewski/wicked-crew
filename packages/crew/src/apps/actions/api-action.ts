/**
 * API actions (DES-APPS-001 §4 "Action", §7.3): one REST operation or MCP write tool, or one GraphQL mutation
 * with one root field, called with exactly the values the card showed.
 *
 * The outcome of a call: an answer the source gave = `succeeded` (2xx / a result) or `failed` (an error it
 * answered); refused before anything was sent (an address the dialer refuses, a request crew would not
 * build) = `failed`; sent and no answer (a timeout, a lost connection) = `unknown`. Nothing is re-run.
 * A REST operation that maps an `Idempotency-Key` header gets the record id there.
 */

import { Kind, parse } from 'graphql';

import type { McpRestMapping } from '../../core/types.js';
import { invokeMcpTool } from '../../mcp/invoke.js';
import type { McpUpstreamConfig } from '../../mcp/probe.js';
import { buildRestRequest } from '../../mcp/rest.js';
import { scrubSecrets } from '../../mcp/secrets.js';
import { UpstreamCallError } from '../../mcp/upstream-error.js';
import { DialRefusedError, type DialOptions } from '../../sources/dialer.js';
import { SourceQueryError } from '../../sources/drivers/types.js';
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

/**
 * The one root field a mutation document selects (from its AST, not the contract's sorted lines; codex r1):
 * its name (for the card) and the key its result arrives under, its alias when it has one (codex r2).
 */
export function mutationField(document: string): { name: string; key: string } {
  const op = parse(document, { noLocation: true, maxTokens: 10_000 }).definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
  const sel = op !== undefined && op.kind === Kind.OPERATION_DEFINITION ? op.selectionSet.selections[0] : undefined;
  return sel !== undefined && sel.kind === Kind.FIELD ? { name: sel.name.value, key: sel.alias?.value ?? sel.name.value } : { name: 'mutation', key: 'mutation' };
}

/** How a mutation will go out, for the card. */
export function describeMutation(config: McpUpstreamConfig, document: string, variables: Record<string, unknown>, field: string): { operation: string; request: string } {
  return { operation: `mutation ${field}`, request: `POST ${config.url ?? ''}\n${JSON.stringify({ query: document, variables })}` };
}

export type ApiOutcome = { state: 'succeeded'; result: unknown } | { state: 'failed' | 'unknown'; reason: string };

/** A result cut to 64 KB of serialized UTF-8, the wrapper's own escaping included (codex r1, r2). */
export function capped(v: unknown): unknown {
  const text = JSON.stringify(v ?? null);
  if (Buffer.byteLength(text, 'utf8') <= API_RESULT_MAX) return v ?? null;
  const bytes = Buffer.from(text, 'utf8');
  let n = API_RESULT_MAX - 64;
  for (;;) {
    const cut = bytes.subarray(0, n).toString('utf8').replace(/\uFFFD$/, '');
    const wrapped = { truncated: true, text: cut };
    const size = Buffer.byteLength(JSON.stringify(wrapped), 'utf8');
    if (size <= API_RESULT_MAX || n <= 0) return wrapped;
    n = Math.max(0, Math.floor((n * API_RESULT_MAX) / size) - 64);
  }
}

/** Call one tool. Never throws. */
export async function callTool(config: McpUpstreamConfig, secret: string | null, tool: string, rest: McpRestMapping | null | undefined, args: Record<string, unknown>): Promise<ApiOutcome> {
  const secrets = secret === null ? [] : [secret];
  let sent = false;
  try {
    const res = await invokeMcpTool(config, secret, tool, args, 30_000, rest ?? null, () => {
      sent = true;
    });
    if (res['isError'] === true) {
      // Only crew's own REST invoker writes this status; an MCP server's metadata is its own text.
      const status = config.kind === 'rest' ? (res['_meta'] as { 'wicked/rest'?: { status?: unknown } } | undefined)?.['wicked/rest']?.status : undefined;
      const shown = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
      return { state: 'failed', reason: `${config.name}/${tool} answered an error${shown}` };
    }
    return { state: 'succeeded', result: capped(scrubSecrets(res['structuredContent'] ?? res['content'] ?? null, secrets)) };
  } catch (err) {
    return failure(err, `${config.name}/${tool}`, sent);
  }
}

/** Call one mutation. Never throws. */
export async function callMutation(config: McpUpstreamConfig, secret: string | null, document: string, variables: Record<string, unknown>, field: string, dial: DialOptions = {}): Promise<ApiOutcome> {
  const secrets = secret === null ? [] : [secret];
  try {
    const { status, json } = await graphqlPost(graphqlSource(config, dial), secret, { query: document, variables });
    const body = json as { errors?: unknown; data?: unknown } | null;
    if (Array.isArray(body?.errors) && body.errors.length > 0) return { state: 'failed', reason: `the GraphQL source answered ${body.errors.length} error(s)` };
    if (status >= 400) return { state: 'failed', reason: `the GraphQL source answered HTTP ${status}` };
    // A success is a GraphQL execution result holding the root field (codex r1); anything else after the
    // request went out does not establish what happened.
    // The answer was scrubbed of the secret, keys too: a key that IS the secret arrives as the marker (codex r2).
    const red = (k: string): string => scrubSecrets(k, secrets);
    const data = body === null ? undefined : (body as Record<string, unknown>)['data'] ?? (body as Record<string, unknown>)[red('data')];
    if (data === null || data === undefined || typeof data !== 'object' || !(Object.hasOwn(data, field) || Object.hasOwn(data, red(field)))) return { state: 'unknown', reason: `the GraphQL source answered HTTP ${status} without a result for ${field}: whether it happened is not known; check the source. It is not run again` };
    return { state: 'succeeded', result: capped(scrubSecrets(data, secrets)) };
  } catch (err) {
    // An answer that was not JSON still carries its status: an error status was an answer.
    if (err instanceof SourceQueryError && err.errorClass === 'source') {
      const m = /HTTP (\d{3})/.exec(err.message);
      if (m !== null && Number(m[1]) >= 400) return { state: 'failed', reason: `the GraphQL source answered HTTP ${m[1]}` };
    }
    return failure(err, config.name, !(err instanceof DialRefusedError));
  }
}

/**
 * An error in an outcome's words: refused before anything left crew, or an error the source answered, is
 * `failed`; a call that went out and got no usable answer is `unknown` (codex r1).
 */
function failure(err: unknown, what: string, sent: boolean): ApiOutcome {
  if (err instanceof DialRefusedError) return { state: 'failed', reason: `the connection to ${what} was refused (${err.code}); nothing was sent` };
  if (err instanceof UpstreamCallError) {
    if (err.errorClass === 'boundary') return { state: 'failed', reason: `crew refused the request to ${what} (${err.errorClass}); nothing was sent` };
    if (err.errorClass === 'http') return { state: 'failed', reason: `${what} answered an HTTP error` };
    if (err.errorClass === 'protocol' && sent) return { state: 'failed', reason: `${what} answered an error (the call was refused)` };
  }
  if (!sent) return { state: 'failed', reason: `${what} could not be reached; nothing was sent` };
  return { state: 'unknown', reason: `the call to ${what} was sent and no answer came (${err instanceof UpstreamCallError ? err.errorClass : 'transport'}): whether it happened is not known; check the source. It is not run again` };
}
