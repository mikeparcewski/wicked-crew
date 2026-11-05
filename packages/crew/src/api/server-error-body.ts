/**
 * crew#1359: a 500 answered the engine's own message, and an engine message can name a file under the daemon's state
 * folder (an absolute path, so the account's home folder too). A server error now answers a code and a generic
 * message, with the request id to find the detail in the daemon log; the detail goes to the log only.
 *
 *  - 500: `error` is a generic message and `requestId` points at the log line; `code` is the route's own code when it
 *    set a plain token one (a client may branch on it), else `internal_error`. Of the route's other fields only
 *    identifiers survive (numbers, booleans and token strings such as run ids, so a mid-fan failure still names what
 *    launched); every free-text string, nested ones included, goes to the log only (xreview r1).
 *  - Any other 5xx keeps its body (studio branches on 501/502/503 codes and messages), with every absolute file path
 *    in its decoded strings replaced by `<path>` and the JSON serialized again (never substituted into JSON text).
 *
 * One `onSend` hook over every route, so a route that forgets (or a thrown error that reaches Fastify's default
 * handler) is covered too. A hijacked reply bypasses `onSend`: the interactive proxy calls
 * {@link sanitizeServerErrorBody} itself before it writes an upstream 5xx.
 */

import { homedir, tmpdir } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const INTERNAL_ERROR_MESSAGE = 'The daemon hit an internal error. Its log has the detail (look up the requestId).';
const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;
/** A string a 500 may keep: one identifier-like token (a run id, a repo id, a status word). No space, no slash. */
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:@#+-]{0,127}$/u;

/**
 * The top directories of an absolute filesystem path (POSIX). A route pointer such as `/skills/publish` or
 * `/api/v1/runs` is not one of them, so a 501/503's remediation pointer survives (xreview r1).
 */
const FS_ROOTS = ['Users', 'home', 'private', 'var', 'tmp', 'opt', 'root', 'srv', 'Volumes', 'etc', 'mnt', 'usr', 'Library', 'System', 'Applications', 'run', 'nix', 'data', 'workspace', 'workspaces', 'media', 'snap'];
const POSIX_PATH = new RegExp(`(?<![A-Za-z0-9_])(?:file://)?/(?:${FS_ROOTS.join('|')})(?![A-Za-z0-9_.-])(?:/[^\\s"'\`<>()[\\]{},;]*)?`, 'gu');
/** A drive path with either separator (`C:\\Users\\x`, `C:/Data/x`). */
const WINDOWS_PATH = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'`<>()[\]{},;]*/gu;
/** A home-relative path, and any path through a dot-folder (`…/.wicked-crew/…`), whatever its root. */
const HOME_PATH = /~[\\/][^\s"'`<>()[\]{},;]*/gu;
const DOT_DIR_PATH = /(?<![A-Za-z0-9_:/])\/(?:[^\s/"'`<>()[\]{},;]+\/)*\.[A-Za-z0-9_-]+\/[^\s"'`<>()[\]{},;]*/gu;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** This host's own home and temp folders, matched literally first (a folder name with a space is still caught). */
const OWN_ROOTS: RegExp[] = [homedir(), tmpdir()]
  .filter((p) => p.length > 1)
  .sort((a, b) => b.length - a.length)
  .map((p) => new RegExp(escapeRegExp(p), 'gu'));

/** `text` with every absolute (or home-relative) file path replaced by `<path>`. */
export function redactPaths(text: string): string {
  let out = text;
  for (const own of OWN_ROOTS) out = out.replace(own, '~');
  return out
    .replace(WINDOWS_PATH, '<path>')
    .replace(POSIX_PATH, '<path>')
    .replace(HOME_PATH, '<path>')
    .replace(DOT_DIR_PATH, '<path>');
}

/** Every string in `v` with its paths taken out (structure kept). */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return redactPaths(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]));
  return v;
}

const DROP = Symbol('drop');
/** Only identifiers survive a 500: numbers, booleans, null, token strings; arrays and objects of them. */
function identifiersOnly(v: unknown): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return ID_TOKEN.test(v) ? v : DROP;
  if (Array.isArray(v)) return v.map(identifiersOnly).filter((x) => x !== DROP);
  if (typeof v === 'object') {
    const kept = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => [k, identifiersOnly(x)] as const)
      .filter(([, x]) => x !== DROP);
    return Object.fromEntries(kept);
  }
  return DROP;
}

/** Fields a 500 never keeps from the route's body (its own message, Fastify's default fields). */
const MESSAGE_FIELDS = new Set(['error', 'message', 'detail', 'stack', 'statusCode', 'code']);

/** The body a 500 answers instead of `original` (pure; the caller logs `original`). */
export function internalErrorBody(original: string, requestId: string): Record<string, unknown> & { error: string; code: string; requestId: string } {
  let code = 'internal_error';
  let rest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(original) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const own = obj['code'];
      if (typeof own === 'string' && CODE_TOKEN.test(own)) code = own;
      rest = identifiersOnly(Object.fromEntries(Object.entries(obj).filter(([k]) => !MESSAGE_FIELDS.has(k)))) as Record<string, unknown>;
    }
  } catch {
    // not JSON: the generic body stands
  }
  return { ...rest, error: INTERNAL_ERROR_MESSAGE, code, requestId };
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
