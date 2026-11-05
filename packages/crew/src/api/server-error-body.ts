/**
 * crew#1359: a 500 answered the engine's own message, and an engine message can name a file under the daemon's state
 * folder (an absolute path, so the account's home folder too). A server error now answers a code and a generic
 * message, with the request id to find the detail in the daemon log; the detail goes to the log only.
 *
 *  - 500: `error` is a generic message and `requestId` points at the log line; `code` is the route's own code when it
 *    set a plain token one (a client may branch on it), else `internal_error`. The route's other structured fields
 *    stay (paths taken out), its free text (`error`, `message`, `detail`, `stack`) does not.
 *  - Any other 5xx keeps its body (studio branches on 501/502/503 codes and messages), with every absolute file path
 *    in it replaced by `<path>`.
 *
 * One `onSend` hook over every route, so a route that forgets (or a thrown error that reaches Fastify's default
 * handler) is covered too. A streamed body is left alone: no route streams a server error.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const INTERNAL_ERROR_MESSAGE = 'The daemon hit an internal error. Its log has the detail (look up the requestId).';
const CODE_TOKEN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;

/**
 * Absolute file paths: POSIX (two or more segments, not part of a URL, not an `/api/...` route a message points at)
 * and Windows drive paths. A preceding word character, `:` or `/` means a URL or a relative path, left alone.
 */
const POSIX_PATH = /(?<![\w.:/~-])\/(?!api\/)(?:[^\s/"'`<>()[\]{},;]+\/)+[^\s"'`<>()[\]{},;]*/gu;
const WINDOWS_PATH = /(?<![\w])[A-Za-z]:\\(?:[^\s"'`<>()[\]{},;\\]+\\?)+/gu;
const HOME_PATH = /~\/[^\s"'`<>()[\]{},;]+/gu;

/** `text` with every absolute (or home-relative) file path replaced by `<path>`. */
export function redactPaths(text: string): string {
  return text.replace(WINDOWS_PATH, '<path>').replace(POSIX_PATH, '<path>').replace(HOME_PATH, '<path>');
}

function asText(payload: unknown): string | null {
  if (typeof payload === 'string') return payload;
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  return null;
}

/** Every string in `v` with its paths taken out (structure kept). */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return redactPaths(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]));
  return v;
}

/** The free-text fields a 500 drops (the log keeps them); every other field stays, paths taken out. */
const MESSAGE_FIELDS = new Set(['error', 'message', 'detail', 'stack', 'statusCode', 'code']);

/**
 * The body a 500 answers instead of `original` (pure; the hook logs `original`). The route's message goes; its
 * structured fields stay (a mid-fan failure's `runIds` still names what already launched), with paths taken out.
 */
export function internalErrorBody(original: string, requestId: string): Record<string, unknown> & { error: string; code: string; requestId: string } {
  let code = 'internal_error';
  let rest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(original) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const own = obj['code'];
      if (typeof own === 'string' && CODE_TOKEN.test(own)) code = own;
      rest = scrub(Object.fromEntries(Object.entries(obj).filter(([k]) => !MESSAGE_FIELDS.has(k)))) as Record<string, unknown>;
    }
  } catch {
    // not JSON: the generic body stands
  }
  return { ...rest, error: INTERNAL_ERROR_MESSAGE, code, requestId };
}

export function registerServerErrorBody(app: FastifyInstance): void {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const status = reply.statusCode;
    if (status < 500) return payload;
    const text = asText(payload);
    if (text === null) return payload;
    if (status === 500) {
      req.log.error({ statusCode: status, body: text }, `[server-error] ${req.method} ${req.routeOptions?.url ?? req.url} answered 500; detail kept here only`);
      reply.removeHeader('content-length');
      reply.header('content-type', 'application/json; charset=utf-8');
      return JSON.stringify(internalErrorBody(text, req.id));
    }
    const scrubbed = redactPaths(text);
    if (scrubbed === text) return payload;
    req.log.warn({ statusCode: status, body: text }, `[server-error] ${req.method} ${req.routeOptions?.url ?? req.url} answered ${status}; paths taken out of the body`);
    reply.removeHeader('content-length');
    return scrubbed;
  });
}
