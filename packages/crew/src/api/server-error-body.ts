/**
 * crew#1359: a 500 answered the engine's own message, and an engine message can name a file under the daemon's state
 * folder (an absolute path, so the account's home folder too). A server error now answers a code and a generic
 * message, with the request id to find the detail in the daemon log; the detail goes to the log only.
 *
 *  - 500: `error` is a generic message and `requestId` points at the log line; `code` is the route's own code when it
 *    set a plain token one (a client may branch on it), else `internal_error`. Of the route's other fields only the
 *    named structured ones a client reads survive ({@link SAFE_500_FIELDS}: run ids a partial fan-out launched, an MCP
 *    call's outcome and subject), as scalars or lists of scalars with paths taken out; everything else goes to the
 *    log only (xreview r1/r2).
 *  - Any other 5xx keeps its body (studio branches on 501/502/503 codes and messages), with every absolute file path
 *    in its decoded strings AND keys replaced by `<path>` and the JSON serialized again (never substituted into JSON
 *    text). The daemon's own state home, home and temp folders are matched literally, wherever they live.
 *
 * One `onSend` hook over every route, so a route that forgets (or a thrown error that reaches Fastify's default
 * handler) is covered too. A hijacked reply bypasses `onSend`: the interactive proxy calls
 * {@link sanitizeServerErrorBody} itself before it writes an upstream 5xx.
 */

import { homedir, tmpdir } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { crewStateHome } from '../projects/state-home.js';

export const INTERNAL_ERROR_MESSAGE = 'The daemon hit an internal error. Its log has the detail (look up the requestId).';
const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
/** The structured fields a 500 keeps (scalars or lists of scalars): what launched before a fan-out failed, and the
 *  MCP call response's own fields (`McpCallResponse`), and a partial delete's `name` and `ledger` (its counts and
 *  removed keys, never its errors: studio tells a partial delete by `ledger`, xreview r3). Every other field is the
 *  route's detail, kept in the log. */
export const SAFE_500_FIELDS: ReadonlySet<string> = new Set(['runIds', 'runId', 'launched', 'outcome', 'subject', 'callId', 'ruleIds', 'denied', 'document_id', 'docId', 'name', 'ledger']);

/** Message fields a partial-success object (`ledger`) never keeps inside a 500. */
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['error', 'message', 'detail', 'stack', 'statusCode', 'code', 'hint', 'reason']);

/**
 * The top directories of a filesystem path. A route segment never exempts one of these (xreview r3).
 */
const FS_ROOTS: ReadonlySet<string> = new Set(['Users', 'home', 'private', 'var', 'tmp', 'opt', 'root', 'srv', 'Volumes', 'etc', 'mnt', 'usr', 'Library', 'System', 'Applications', 'run', 'nix', 'data', 'workspace', 'workspaces', 'media', 'snap', 'code', 'src']);
/**
 * The first segments of the daemon's own routes (`/api/v1/skills/publish` gives `skills`), filled as routes register.
 * A 5xx message that points at a route (`POST /skills/publish`, `GET /runs/abc`, anything under `/api/`) keeps the
 * pointer; any other absolute path of two or more segments, whatever its root, is a file path and is taken out
 * (xreview r3/r4).
 */
const ROUTE_ROOTS = new Set<string>(['api']);
export function noteRoute(url: string): void {
  const parts = url.split('/').filter((p) => p !== '');
  const rest = parts[0] === 'api' && /^v\d+$/u.test(parts[1] ?? '') ? parts.slice(2) : parts;
  const first = rest[0];
  if (first !== undefined && !first.startsWith(':') && !FS_ROOTS.has(first)) ROUTE_ROOTS.add(first);
}
/** An HTTP pointer, never a file path: under `/api/`, or one of the daemon's route segments right after a method
 *  (`POST /skills/publish`). A bare `/projects/acme/...` is a file path even though `projects` is a route (xreview r4). */
const METHOD_BEFORE = /(?:GET|POST|PUT|PATCH|DELETE|HEAD) $/u;
function isRoutePointer(first: string, before: string): boolean {
  return first === 'api' || (ROUTE_ROOTS.has(first) && METHOD_BEFORE.test(before));
}
/** An absolute POSIX path of two or more segments (optionally `file:` / `file://`), not inside a URL. */
const POSIX_PATH = /(?<![A-Za-z0-9_.~:/-])(file:(?:\/\/)?)?\/([^\s/"'`<>()[\]{},;:]+)((?:\/[^\s"'`<>()[\]{},;:]*)+)/gu;
/** A drive path with either separator (`C:\\Users\\x`, `C:/Data/x`). */
const WINDOWS_PATH = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'`<>()[\]{},;]*/gu;
/** A home-relative path, and any path through a dot-folder (`…/.wicked-crew/…`), whatever its root. */
const HOME_PATH = /~[\\/][^\s"'`<>()[\]{},;]*/gu;
const DOT_DIR_PATH = /(?<![A-Za-z0-9_:/])\/(?:[^\s/"'`<>()[\]{},;]+\/)*\.[A-Za-z0-9_-]+\/[^\s"'`<>()[\]{},;]*/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The daemon's own state home, home and temp folders, matched literally first: a folder name with a space, or a
 *  state home outside the usual roots, is still caught (xreview r2). Longest first, so the most specific wins. */
function ownRoots(): string[] {
  const roots = [homedir(), tmpdir()];
  try {
    roots.push(crewStateHome());
  } catch {
    // under a test runner with no configured state home: home and temp still apply
  }
  return [...new Set(roots.filter((p) => p.length > 1))].sort((a, b) => b.length - a.length);
}

/** `text` with every absolute (or home-relative) file path replaced by `<path>`. */
export function redactPaths(text: string): string {
  let out = text;
  for (const own of ownRoots()) out = out.replace(new RegExp(`${escapeRegExp(own)}(?:[\\/][^\\s"'\`<>()[\\]{},;]*)?`, 'gu'), '<path>');
  return out
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, (whole: string, file: string | undefined, first: string, _rest: string, at: number, all: string) =>
      file === undefined && isRoutePointer(first, all.slice(Math.max(0, at - 8), at)) ? whole : '<path>',
    )
    .replace(HOME_PATH, '<path>')
    .replace(DOT_DIR_PATH, '<path>');
}

/** A field named as a path (`browsers_path`, `root`, `dir`): any absolute value is a file path, one segment or many. */
const PATH_FIELD = /(?:path|dir|directory|root|folder|file|home)$/iu;
const ABSOLUTE_VALUE = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|file:)/u;

/** Every string in `v`, keys included, with its paths taken out (structure kept; on a key collision the first stays). */
function scrub(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return PATH_FIELD.test(key) && ABSOLUTE_VALUE.test(v) ? '<path>' : redactPaths(v);
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const safeKey = redactPaths(k);
      if (!(safeKey in out)) out[safeKey] = scrub(x, k);
    }
    return out;
  }
  return v;
}

function isScalar(x: unknown): boolean {
  return x === null || ['string', 'number', 'boolean'].includes(typeof x);
}

/**
 * A safe field's value: a scalar or a list of scalars (strings with paths taken out); for an object (the partial
 * delete's `ledger`, which studio reads to tell a partial delete from a failure), its scalar and scalar-list fields
 * other than message ones. Anything else is not kept.
 */
function safeValue(v: unknown, key: string, depth = 0): unknown {
  if (isScalar(v)) return scrub(v, key);
  if (Array.isArray(v)) return v.every(isScalar) ? v.map((x) => scrub(x, key)) : undefined;
  if (depth === 0 && v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (MESSAGE_FIELDS.has(k) || k === 'errors') continue;
      const kept = safeValue(x, k, 1);
      if (kept !== undefined && !(typeof kept === 'object' && kept !== null && !Array.isArray(kept))) out[redactPaths(k)] = kept;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** The body a 500 answers instead of `original` (pure; the caller logs `original`). */
export function internalErrorBody(original: string, requestId: string): Record<string, unknown> & { error: string; code: string; requestId: string } {
  let code = 'internal_error';
  const kept: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(original) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const own = obj['code'];
      if (typeof own === 'string' && CODE_TOKEN.test(own)) code = own;
      for (const field of SAFE_500_FIELDS) {
        const value = field in obj ? safeValue(obj[field], field) : undefined;
        if (value !== undefined) kept[field] = value;
      }
    }
  } catch {
    // not JSON: the generic body stands
  }
  return { ...kept, error: INTERNAL_ERROR_MESSAGE, code, requestId };
}

/**
 * The body a server error (`status` >= 500) answers instead of `text`, or `null` when it is unchanged. JSON is parsed,
 * scrubbed and serialized again; anything else is scrubbed as text. `json` says the answer is JSON (a 500 always is).
 */
export function sanitizeServerErrorBody(status: number, text: string, requestId: string): { body: string; json: boolean } | null {
  if (status < 500) return null;
  if (status === 500) return { body: JSON.stringify(internalErrorBody(text, requestId)), json: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const scrubbed = redactPaths(text);
    return scrubbed === text ? null : { body: scrubbed, json: false };
  }
  const body = JSON.stringify(scrub(parsed));
  return body === JSON.stringify(parsed) ? null : { body, json: true };
}

function asText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return null;
}

export function registerServerErrorBody(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => noteRoute(route.url));
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const status = reply.statusCode;
    if (status < 500) return payload;
    const text = asText(payload);
    if (text === null) return payload;
    const out = sanitizeServerErrorBody(status, text, req.id);
    if (out === null) return payload;
    const route = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    if (status === 500) req.log.error({ statusCode: status, body: text }, `[server-error] ${route} answered 500; the detail is kept here only`);
    else req.log.warn({ statusCode: status, body: text }, `[server-error] ${route} answered ${status}; paths taken out of the body`);
    reply.removeHeader('content-length');
    if (out.json) reply.header('content-type', 'application/json; charset=utf-8');
    return out.body;
  });
}
