/**
 * REST upstreams (DES-MCP-TOOLS-001 §2, §5, invariant I6; slice S5a): a plain HTTP API wrapped as
 * brokered tools, one tool per chosen OpenAPI 3 operation.
 *
 * - **Import.** The OpenAPI document is fetched from `openapiUrl` (bounded in time and size; the
 *   server's auth header rides along only when the document is on the API's own origin) or taken as
 *   pasted. Local `$ref`s are resolved (a cycle becomes `{}`); an external `$ref` is not followed.
 *   Each operation becomes a tool whose input schema is its path, query and header parameters and
 *   its JSON body, and whose class comes from its method: `GET`/`HEAD`/`OPTIONS` read, `POST`
 *   write, `PUT`/`PATCH`/`DELETE` destructive (the broker's classification, §4.2).
 * - **Mapping, an allowlist.** A tool carries its {@link McpRestMapping}: which argument fills
 *   which path variable, query parameter, header or body key. An argument no map names is DROPPED,
 *   never sent; its name is disclosed in the result's `_meta["wicked/rest"].droppedArgs`.
 * - **Host pin (I6).** Every request is built on the server's base URL and checked before it is
 *   sent: its scheme, host and port must be the base URL's and its path must stay under the base
 *   path. A request that would leave, and a redirect to another host, are refused with
 *   {@link RestBoundaryError}, which the broker records as a `guard_error`. Redirects are never
 *   followed. The auth header can't be set or overridden by an argument.
 *
 * Ideas only from ContextForge (`openapi_service.py`, `tool_service.py`); no code is copied.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { parse as parseYaml } from 'yaml';

import type { McpRestEgress, McpRestMapping, McpToolAnnotations } from '../core/types.js';
import type { UpstreamToolResult } from './invoke.js';
import type { HashedRestTarget } from './classify.js';
import type { McpUpstreamConfig, ProbedTool, ProbeResult } from './probe.js';
import { scrubSecrets } from './secrets.js';
import { UpstreamCallError } from './upstream-error.js';

export const REST_SPEC_TIMEOUT_MS = 10_000;
/** The largest OpenAPI document crew reads (fetched or pasted). */
export const REST_SPEC_MAX_BYTES = 1024 * 1024;
/** The largest response body handed back; the rest is cut and disclosed as `truncated`. */
export const REST_RESPONSE_MAX_BYTES = 1024 * 1024;
export const REST_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 512;
const MAX_REF_DEPTH = 32;
const TOOL_NAME_MAX = 64;

const METHODS = ['get', 'head', 'options', 'post', 'put', 'patch', 'delete'] as const;
type Method = McpRestMapping['method'];

/**
 * Headers an argument may never set: the ones that route or authenticate the request, and the
 * hop-by-hop ones. The server's own auth header is added to this per server.
 */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
]);

/** A request that would leave the API's pinned base URL (I6). Never retried; recorded as `guard_error`. */
export class RestBoundaryError extends UpstreamCallError {
  constructor(message: string) {
    super('boundary', false, message);
  }
}

/** A tool probed from an OpenAPI document: an MCP tool shape plus its request mapping. */
export type RestProbedTool = ProbedTool & { rest: McpRestMapping };

// ── The base URL ────────────────────────────────────────────────────────────────────────────

/** Parse a base URL: http(s), no credentials, no query or fragment. `null` = not acceptable. */
export function parseBaseUrl(raw: string | null): URL | null {
  if (raw === null) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return null;
  return u;
}

function basePath(base: URL): string {
  return base.pathname.replace(/\/+$/, '');
}

/**
 * (G2, DES-data-connectors §3) What a `rest` server's calls go to, and so what its tools' hash
 * covers (`toolSchemaHash`): the base URL's origin and path, and the header its secret rides in
 * (lowercased; header names are case-insensitive). `null` = no valid base URL (never callable).
 */
export function restTarget(config: Pick<McpUpstreamConfig, 'url' | 'auth'>): HashedRestTarget | null {
  const base = parseBaseUrl(config.url);
  if (base === null) return null;
  return { origin: base.origin, basePath: basePath(base), authHeader: config.auth?.header?.toLowerCase() ?? null };
}

// ── Egress: the base URL against the spec's `servers`, and private addresses (G2) ───────────

/**
 * Loopback, private, link-local, CGNAT, "this network", unique-local and (deprecated, RFC 3879)
 * site-local ranges, plus the local-use
 * IPv4/IPv6 translation prefix (RFC 8215), which may reach private IPv4. `BlockList` also matches
 * an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) against the IPv4 rules.
 */
const PRIVATE_RANGES = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['64:ff9b:1::', 48]] as const) list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/** Whether an IP literal is a loopback/private/link-local/unique-local address. Not an IP → `false`. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves a hostname to its addresses; `[]` when it does not resolve. Injectable for tests. */
export type RestLookup = (hostname: string) => Promise<string[]>;

const LOOKUP_TIMEOUT_MS = 3_000;

export const dnsLookup: RestLookup = async (hostname) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return found.map((a) => a.address);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The spec's `servers`, each resolved to an absolute URL: `{variable}`s take their `default`, and a
 * relative URL resolves against the document's own URL (OpenAPI 3 §4.8.5). A server that can't be
 * resolved (a variable with no default, a relative URL in a pasted document) is not checkable and
 * is left out. No `servers` means `[{url: "/"}]`, as the spec defines.
 */
export function specServers(doc: Record<string, unknown>, specUrl: string | null): URL[] {
  const raw = Array.isArray(doc['servers']) && doc['servers'].length > 0 ? (doc['servers'] as unknown[]) : [{ url: '/' }];
  const out: URL[] = [];
  for (const s of raw) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) continue;
    const entry = s as Record<string, unknown>;
    if (typeof entry['url'] !== 'string') continue;
    const vars = entry['variables'] !== null && typeof entry['variables'] === 'object' ? (entry['variables'] as Record<string, unknown>) : {};
    let unresolved = false;
    const filled = entry['url'].replace(/\{([^{}]+)\}/g, (_m, name: string) => {
      const v = vars[name];
      const dflt = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)['default'] : undefined;
      if (typeof dflt !== 'string') {
        unresolved = true;
        return '';
      }
      return dflt;
    });
    if (unresolved) continue;
    let u: URL;
    try {
      u = specUrl === null ? new URL(filled) : new URL(filled, specUrl);
    } catch {
      continue;
    }
    if (u.protocol === 'https:' || u.protocol === 'http:') out.push(u);
  }
  return out;
}

/** What the probe finds of a `rest` server's egress (G2); the registry adds `confirmRequired`. */
export type RestEgress = Omit<McpRestEgress, 'confirmRequired'>;

/** Check `base` against the spec's `servers`, and whether its host is a private address. */
export async function restEgress(base: URL, doc: Record<string, unknown>, specUrl: string | null, lookupImpl: RestLookup = dnsLookup): Promise<RestEgress> {
  const servers = specServers(doc, specUrl);
  const path = basePath(base);
  const matches = servers.some((s) => {
    const prefix = basePath(s);
    return s.origin === base.origin && (prefix === '' || path === prefix || path.startsWith(`${prefix}/`));
  });
  // The URL parser has already normalized an IP literal (`0x7f.1` → `127.0.0.1`); an IPv6 one keeps
  // its brackets. A name is resolved exactly as the request will name it (a trailing dot included).
  const host = base.hostname.replace(/^\[|\]$/g, '');
  const name = host.toLowerCase().replace(/\.$/, '');
  let privateAddress = name === 'localhost' || name.endsWith('.localhost') || isPrivateAddress(host);
  let resolved = true;
  if (!privateAddress && isIP(host) === 0) {
    const addresses = await lookupImpl(host);
    resolved = addresses.length > 0;
    privateAddress = addresses.some(isPrivateAddress);
  }
  return { origin: base.origin, basePath: path, servers: servers.map((s) => s.href), matches, privateAddress, resolved };
}

/**
 * The request URL for `pathTemplate` filled with `values`, pinned to `base`: the same origin, and a
 * path under the base path. Anything else is a {@link RestBoundaryError}.
 */
export function pinnedUrl(base: URL, pathTemplate: string, values: Record<string, string>): URL {
  let missing: string | null = null;
  const filled = pathTemplate.replace(/\{([^{}]+)\}/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) {
      missing ??= name;
      return '';
    }
    if (v === '.' || v === '..' || v === '') throw new RestBoundaryError(`the path value for {${name}} (${JSON.stringify(v)}) would move the request off its path`);
    return encodeURIComponent(v);
  });
  if (missing !== null) throw new UpstreamCallError('protocol', false, `the path variable {${missing}} has no value`);
  if (!filled.startsWith('/')) throw new RestBoundaryError(`the path ${JSON.stringify(pathTemplate)} does not start with /`);
  const url = new URL(base.href);
  const prefix = basePath(base);
  url.pathname = `${prefix}${filled}`;
  // The URL parser normalizes `.`/`..` segments and may re-read the path; check what it produced.
  const escape = boundaryEscape(base, url);
  if (escape !== null) throw new RestBoundaryError(escape);
  return url;
}

/** Why `url` is outside `base` (another origin, or a path off the base path); `null` = inside. */
export function boundaryEscape(base: URL, url: URL): string | null {
  if (url.origin !== base.origin) return `the request to ${url.origin} leaves the pinned host ${base.origin}`;
  const prefix = basePath(base);
  if (prefix !== '' && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return `the request path ${url.pathname} leaves the pinned base path ${prefix}`;
  }
  return null;
}

// ── The OpenAPI document ────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Resolve a local JSON pointer (`#/components/schemas/X`) in `doc`; `undefined` when absent. */
function pointer(doc: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * `value` with every local `$ref` replaced by what it points to. A `$ref` already being resolved
 * on the current path (a cycle), an unresolvable or external one, and anything deeper than
 * {@link MAX_REF_DEPTH} become `{}` (any value): the schema is a hint to the caller, never a check.
 */
export function derefLocal(doc: Json, value: unknown, seen: ReadonlyArray<string> = [], depth = 0): unknown {
  if (depth > MAX_REF_DEPTH) return {};
  if (Array.isArray(value)) return value.map((v) => derefLocal(doc, v, seen, depth + 1));
  if (!isObj(value)) return value;
  const ref = value['$ref'];
  if (typeof ref === 'string') {
    if (seen.includes(ref)) return {};
    const target = pointer(doc, ref);
    if (target === undefined) return {};
    return derefLocal(doc, target, [...seen, ref], depth + 1);
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) out[k] = derefLocal(doc, v, seen, depth + 1);
  return out;
}

/** Parse an OpenAPI document's text: JSON, else YAML. */
export function parseOpenApiText(text: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = parseYaml(text, { maxAliasCount: 100 });
    } catch (err) {
      throw new Error(`the OpenAPI document is neither JSON nor YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!isObj(parsed)) throw new Error('the OpenAPI document is not an object');
  return parsed;
}

function toolNameFor(method: string, path: string, operationId: unknown): string {
  const raw = typeof operationId === 'string' && operationId.trim() !== '' ? operationId : `${method}_${path}`;
  const name = raw
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, TOOL_NAME_MAX);
  return name === '' ? method : name;
}

/** The class an HTTP method implies, as annotations (§4.2): the broker decides it, never the carrier. */
export function annotationsForMethod(method: Method): McpToolAnnotations {
  switch (method) {
    case 'GET':
    case 'HEAD':
    case 'OPTIONS':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    case 'POST':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    case 'PUT':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
    case 'PATCH':
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: method === 'DELETE', openWorldHint: true };
  }
}

interface Param {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: unknown;
  description: string | null;
}

function paramsOf(doc: Json, pathItem: Json, op: Json): Param[] {
  const merged = new Map<string, Param>();
  for (const list of [pathItem['parameters'], op['parameters']]) {
    if (!Array.isArray(list)) continue;
    for (const rawParam of list) {
      const p = derefLocal(doc, rawParam);
      if (!isObj(p) || typeof p['name'] !== 'string' || p['name'] === '') continue;
      const where = p['in'];
      if (where !== 'path' && where !== 'query' && where !== 'header') continue; // cookie: never mapped
      // Header names are case-insensitive: `X-Trace` and `x-trace` are one header, one argument.
      merged.set(`${where}:${where === 'header' ? p['name'].toLowerCase() : p['name']}`, {
        name: p['name'],
        in: where,
        required: where === 'path' || p['required'] === true,
        schema: isObj(p['schema']) ? p['schema'] : { type: 'string' },
        description: typeof p['description'] === 'string' ? p['description'] : null,
      });
    }
  }
  return [...merged.values()];
}

/** The JSON schema of an operation's JSON request body, `null` when none; `'unsupported'` = a non-JSON body. */
function jsonBodyOf(doc: Json, op: Json): { schema: Json; required: boolean } | null | 'unsupported' {
  const body = derefLocal(doc, op['requestBody']);
  if (!isObj(body)) return null;
  const content = body['content'];
  if (!isObj(content)) return null;
  const key = Object.keys(content).find((k) => /^application\/(?:[\w.+-]+\+)?json\b/i.test(k));
  if (key === undefined) return Object.keys(content).length === 0 ? null : 'unsupported';
  const media = content[key];
  const schema = isObj(media) && isObj(media['schema']) ? media['schema'] : {};
  return { schema, required: body['required'] === true };
}

export interface OpenApiImport {
  serverInfo: { name: string; version: string } | null;
  tools: RestProbedTool[];
  /** Operations that could not be wrapped, with why (a non-JSON body, a name clash past 512 tools). */
  skipped: string[];
}

/**
 * Wrap an OpenAPI 3 document's operations as tools. `operations` (by `operationId` or tool name)
 * picks which; a name that matches no operation is an error, so a typo never silently wraps less.
 */
export function importOpenApi(
  doc: Json,
  opts: { authHeader?: string | undefined; operations?: ReadonlyArray<string> | null; timeoutMs?: number } = {},
): OpenApiImport {
  const version = doc['openapi'];
  if (typeof version !== 'string' || !version.startsWith('3.')) {
    throw new Error('only OpenAPI 3.x documents are supported (the document has no "openapi": "3.x" field)');
  }
  const paths = doc['paths'];
  if (!isObj(paths)) throw new Error('the OpenAPI document has no paths');
  const forbidden = new Set(FORBIDDEN_HEADERS);
  if (opts.authHeader !== undefined) forbidden.add(opts.authHeader.toLowerCase());
  const wanted = opts.operations === undefined || opts.operations === null ? null : new Set(opts.operations);
  const matched = new Set<string>();
  const used = new Set<string>();
  const tools: RestProbedTool[] = [];
  const skipped: string[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = derefLocal(doc, rawItem);
    if (!isObj(pathItem) || !path.startsWith('/')) continue;
    for (const m of METHODS) {
      const op = pathItem[m];
      if (!isObj(op)) continue;
      const method = m.toUpperCase() as Method;
      const opId = typeof op['operationId'] === 'string' ? op['operationId'] : null;
      let name = toolNameFor(m, path, opId);
      if (wanted !== null) {
        const hit = [opId, name].find((n): n is string => n !== null && wanted.has(n));
        if (hit === undefined) continue;
        matched.add(hit);
      }
      const label = `${method} ${path}`;
      if (tools.length >= MAX_TOOLS) {
        skipped.push(`${label}: more than ${MAX_TOOLS} operations`);
        continue;
      }
      const body = jsonBodyOf(doc, op);
      if (body === 'unsupported') {
        skipped.push(`${label}: its request body is not JSON`);
        continue;
      }
      for (let n = 2; used.has(name); n++) name = `${toolNameFor(m, path, opId).slice(0, TOOL_NAME_MAX - 4)}_${n}`;

      const properties: Json = {};
      const required: string[] = [];
      const mapping: McpRestMapping = {
        method,
        pathTemplate: path,
        pathMap: {},
        queryMap: {},
        headerMap: {},
        bodyMap: null,
        bodyArg: null,
        argAllowlist: [],
        timeoutMs: opts.timeoutMs ?? REST_DEFAULT_TIMEOUT_MS,
      };
      const argName = (base: string, where: string): string => (base in properties ? `${where}_${base}` : base);
      const templateVars = new Set([...path.matchAll(/\{([^{}]+)\}/g)].map((x) => x[1] as string));
      let unusable: string | null = null;
      for (const p of paramsOf(doc, pathItem, op)) {
        if (p.in === 'header' && forbidden.has(p.name.toLowerCase())) continue; // never argument-settable
        if (p.in === 'path' && !templateVars.has(p.name)) continue;
        const arg = argName(p.name, p.in);
        if (arg in properties) continue;
        properties[arg] = derefLocal(doc, p.description === null ? p.schema : { ...(p.schema as Json), description: p.description });
        if (p.required) required.push(arg);
        if (p.in === 'path') mapping.pathMap[arg] = p.name;
        else if (p.in === 'query') mapping.queryMap[arg] = p.name;
        else mapping.headerMap[arg] = p.name;
      }
      for (const v of templateVars) {
        if (!Object.values(mapping.pathMap).includes(v)) {
          // A path variable no parameter declares still has to be filled: it becomes a string argument.
          const arg = argName(v, 'path');
          if (arg in properties) {
            unusable = `its path variable {${v}} clashes with another argument`;
            break;
          }
          properties[arg] = { type: 'string' };
          required.push(arg);
          mapping.pathMap[arg] = v;
        }
      }
      if (unusable !== null) {
        skipped.push(`${label}: ${unusable}`);
        continue;
      }
      if (body !== null) {
        const schema = derefLocal(doc, body.schema) as Json;
        const props = isObj(schema['properties']) ? (schema['properties'] as Json) : null;
        const fieldsFit = schema['type'] === 'object' && props !== null && Object.keys(props).length > 0 && Object.keys(props).every((k) => !(k in properties));
        if (fieldsFit && props !== null) {
          mapping.bodyMap = {};
          const bodyRequired = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          for (const [k, s] of Object.entries(props)) {
            properties[k] = s;
            mapping.bodyMap[k] = k;
            if (body.required && bodyRequired.includes(k)) required.push(k);
          }
        } else {
          const arg = argName('body', 'request');
          properties[arg] = schema;
          mapping.bodyArg = arg;
          if (body.required) required.push(arg);
        }
      }
      mapping.argAllowlist = Object.keys(properties).sort();
      const summary = typeof op['summary'] === 'string' ? op['summary'] : typeof op['description'] === 'string' ? op['description'] : '';
      const description = `${summary.trim().slice(0, 1024)}${summary.trim() === '' ? '' : ' '}(${label})`;
      const annotations: McpToolAnnotations = annotationsForMethod(method);
      if (typeof op['summary'] === 'string' && op['summary'].trim() !== '') annotations.title = op['summary'].trim().slice(0, 200);
      used.add(name);
      tools.push({
        name,
        description,
        inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
        outputSchema: null,
        annotations,
        rest: mapping,
      });
    }
  }
  if (wanted !== null) {
    const unknown = [...wanted].filter((w) => !matched.has(w));
    if (unknown.length > 0) throw new Error(`operations names ${unknown.map((u) => JSON.stringify(u)).join(', ')}, which the OpenAPI document does not have`);
  }
  if (tools.length === 0) throw new Error(skipped.length > 0 ? `no operation could be wrapped: ${skipped.join('; ')}` : 'the OpenAPI document has no operations to wrap');
  const info = doc['info'];
  const serverInfo =
    isObj(info) && typeof info['title'] === 'string' ? { name: info['title'].slice(0, 200), version: typeof info['version'] === 'string' ? info['version'].slice(0, 64) : '' } : null;
  return { serverInfo, tools, skipped };
}

// ── Reading bodies, bounded ─────────────────────────────────────────────────────────────────

async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (res.body === null) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function authHeaders(config: McpUpstreamConfig, secret: string | null): Record<string, string> {
  if (config.auth?.header === undefined || secret === null) return {};
  return { [config.auth.header]: `${config.auth.prefix ?? ''}${secret}` };
}

// ── The probe ───────────────────────────────────────────────────────────────────────────────

export type RestFetch = typeof fetch;

/**
 * The `rest` probe: read the OpenAPI document and wrap its operations. The auth header goes to the
 * document's URL only when it is on the base URL's own origin. Every string returned has the
 * secret scrubbed out.
 *
 * The document's URL is NOT pinned to the base URL, by design: it is the operator's own input at
 * preview time (an API's spec often lives elsewhere, e.g. a docs host), not a worker's call, and it
 * carries no secret off the API's origin. The host pin (I6) is on the tools' calls.
 *
 * (G2) It also answers `egress`: the base URL checked against the document's `servers`, and
 * whether its host is a private address. The registry refuses to save a mismatch or a private
 * address unless the operator names that exact origin.
 */
export async function probeRestServer(config: McpUpstreamConfig, secret: string | null, fetchImpl: RestFetch = fetch, lookupImpl: RestLookup = dnsLookup): Promise<ProbeResult> {
  const secrets = secret === null ? [] : [secret];
  try {
    const base = parseBaseUrl(config.url);
    if (base === null) throw new Error('a rest server needs an http(s) base url with no credentials, query or fragment');
    let doc: Json;
    if (config.openapi !== null && config.openapi !== undefined) {
      doc = config.openapi;
    } else if (config.openapiUrl !== null && config.openapiUrl !== undefined) {
      const specUrl = new URL(config.openapiUrl);
      const headers = specUrl.origin === base.origin ? authHeaders(config, secret) : {};
      const res = await fetchImpl(specUrl, { headers: { accept: 'application/json, application/yaml;q=0.9, */*;q=0.5', ...headers }, redirect: 'error', signal: AbortSignal.timeout(REST_SPEC_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`fetching the OpenAPI document answered HTTP ${res.status}`);
      const { text, truncated } = await readCapped(res, REST_SPEC_MAX_BYTES + 1);
      if (truncated || Buffer.byteLength(text, 'utf8') > REST_SPEC_MAX_BYTES) throw new Error(`the OpenAPI document is larger than ${REST_SPEC_MAX_BYTES} bytes`);
      doc = parseOpenApiText(text);
    } else {
      throw new Error('a rest server needs openapiUrl or openapi');
    }
    const imported = importOpenApi(doc, { authHeader: config.auth?.header, operations: config.operations ?? null });
    // Every mapping must build a pinned URL; an operation whose path can't is refused here, not at call time.
    for (const t of imported.tools) {
      const sample = Object.fromEntries(Object.values(t.rest.pathMap).map((v) => [v, 'x']));
      pinnedUrl(base, t.rest.pathTemplate, sample);
    }
    const egress = await restEgress(base, doc, config.openapi !== null && config.openapi !== undefined ? null : (config.openapiUrl ?? null), lookupImpl);
    return scrubSecrets({ ok: true as const, serverInfo: imported.serverInfo, tools: imported.tools, skipped: imported.skipped, egress }, secrets);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return scrubSecrets({ ok: false as const, error: message }, secrets);
  }
}

// ── The call ────────────────────────────────────────────────────────────────────────────────

function scalar(v: unknown, what: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new UpstreamCallError('protocol', false, `${what} must be a string, number or boolean`);
}

/**
 * Build the one HTTP request a `rest` tool call makes, from the ALLOWLISTED arguments only, pinned
 * to the base URL. Exported so the allowlist and the pin are testable without a network.
 */
export function buildRestRequest(
  config: McpUpstreamConfig,
  secret: string | null,
  mapping: McpRestMapping,
  args: Record<string, unknown>,
): { url: URL; init: { method: string; headers: Record<string, string>; body?: string }; droppedArgs: string[] } {
  const base = parseBaseUrl(config.url);
  if (base === null) throw new RestBoundaryError('the server has no valid base url to pin the request to');
  const allowed = new Set(mapping.argAllowlist);
  const droppedArgs = Object.keys(args).filter((k) => !allowed.has(k)).sort();
  // Only allowlisted arguments are ever read, whatever the maps say (a map is never wider than it).
  const sent: Record<string, unknown> = Object.fromEntries(Object.entries(args).filter(([k]) => allowed.has(k)));
  args = sent;
  const pathValues: Record<string, string> = {};
  for (const [arg, variable] of Object.entries(mapping.pathMap)) {
    if (args[arg] !== undefined) pathValues[variable] = scalar(args[arg], `the path argument ${arg}`);
  }
  const url = pinnedUrl(base, mapping.pathTemplate, pathValues);
  for (const [arg, q] of Object.entries(mapping.queryMap)) {
    const v = args[arg];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(q, scalar(item, `the query argument ${arg}`));
    else url.searchParams.append(q, scalar(v, `the query argument ${arg}`));
  }
  const forbidden = new Set(FORBIDDEN_HEADERS);
  if (config.auth?.header !== undefined) forbidden.add(config.auth.header.toLowerCase());
  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5' };
  for (const [arg, h] of Object.entries(mapping.headerMap)) {
    const v = args[arg];
    if (v === undefined || v === null || forbidden.has(h.toLowerCase())) continue;
    const text = scalar(v, `the header argument ${arg}`);
    if (/[\r\n\0]/.test(text)) throw new UpstreamCallError('protocol', false, `the header argument ${arg} must be one line`);
    if (Object.keys(headers).some((k) => k.toLowerCase() === h.toLowerCase())) continue; // one argument per header: the first wins
    headers[h] = text;
  }
  let body: string | undefined;
  if (mapping.bodyArg !== null && args[mapping.bodyArg] !== undefined) {
    body = JSON.stringify(args[mapping.bodyArg]);
  } else if (mapping.bodyMap !== null) {
    const obj: Record<string, unknown> = {};
    for (const [arg, key] of Object.entries(mapping.bodyMap)) if (args[arg] !== undefined) obj[key] = args[arg];
    if (Object.keys(obj).length > 0 || mapping.method === 'POST' || mapping.method === 'PUT' || mapping.method === 'PATCH') body = JSON.stringify(obj);
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, authHeaders(config, secret));
  return { url, init: { method: mapping.method, headers, ...(body !== undefined ? { body } : {}) }, droppedArgs };
}

/**
 * Call one `rest` tool. Transport failures, 429 and 5xx are retryable {@link UpstreamCallError}s; a
 * redirect is never followed (one to another host is a {@link RestBoundaryError}); any other
 * status is handed back as the tool's own result (`isError` on 4xx). The result is RAW: the broker
 * scrubs it.
 */
export async function invokeRestTool(
  config: McpUpstreamConfig,
  secret: string | null,
  mapping: McpRestMapping,
  args: Record<string, unknown>,
  timeoutMs: number,
  fetchImpl: RestFetch = fetch,
): Promise<UpstreamToolResult> {
  const { url, init, droppedArgs } = buildRestRequest(config, secret, mapping, args);
  const deadline = Math.max(1, Math.min(timeoutMs, mapping.timeoutMs));
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(deadline) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new UpstreamCallError('timeout', false, `timed out after ${Math.round(deadline / 1000)} s`);
    throw new UpstreamCallError('transport', true, err instanceof Error ? err.message : String(err));
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    const location = res.headers.get('location');
    let target: URL | null = null;
    try {
      target = location === null ? null : new URL(location, url);
    } catch {
      target = null;
    }
    const base = parseBaseUrl(config.url);
    const escape = target !== null && base !== null ? boundaryEscape(base, target) : null;
    if (escape !== null) throw new RestBoundaryError(`the API redirected off its pin (${escape}); not followed`);
    throw new UpstreamCallError('http', false, `the API answered HTTP ${res.status} (a redirect); redirects are not followed`);
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamCallError('http', true, `the API answered HTTP ${res.status}`);
  }
  let read: { text: string; truncated: boolean };
  try {
    read = await readCapped(res, REST_RESPONSE_MAX_BYTES);
  } catch (err) {
    throw new UpstreamCallError('transport', true, `reading the response failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let structured: Record<string, unknown> | undefined;
  if (!read.truncated && /json/i.test(res.headers.get('content-type') ?? '')) {
    try {
      const parsed: unknown = JSON.parse(read.text);
      if (isObj(parsed)) structured = parsed;
    } catch {
      structured = undefined;
    }
  }
  return {
    content: [{ type: 'text', text: read.text }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    isError: res.status >= 400,
    _meta: { 'wicked/rest': { status: res.status, droppedArgs, truncated: read.truncated } },
  };
}
