/**
 * Who may put the daemon's pages in a frame (clickjacking guard).
 *
 * Studio's gate cards approve, deliver and stop runs with one click. If any page the operator
 * happens to visit could frame `http://localhost:<port>/`, it could dress those buttons up as
 * something else and trick the click. So every response says who may frame it:
 *
 * - `Content-Security-Policy: frame-ancestors 'self' …` — the daemon's own origin, studio's Vite
 *   dev server (it frames editor bundles and documents from the daemon cross-origin, see
 *   `STUDIO_DEV_ORIGINS`) and the origins the operator allowed with `WICKED_CREW_ALLOWED_ORIGINS`.
 *   Those are exactly the pages that may already call the API (origin-guard.ts), so letting them
 *   frame it gives them nothing new. Any other page gets a blank frame.
 * - `X-Frame-Options: SAMEORIGIN` for browsers without `frame-ancestors`. A browser that has it
 *   ignores this header, so the dev server still works there.
 *
 * Two hooks put them on EVERY response, HTML or JSON, success or refusal:
 *
 * - `onRequest` writes both on the raw response first, so a route that hijacks the reply and
 *   writes its own head (the interactive proxy, the ask MCP route) still sends them: Node merges
 *   headers set earlier into `writeHead`.
 * - `onSend` MERGES `frame-ancestors` into a policy a route set itself (the studio shell's
 *   `frame-src`, an editor bundle's sandbox policy), which would otherwise replace the raw one.
 *
 * A route that hijacks AND writes its own `Content-Security-Policy` must keep the guard's policy
 * beside it with {@link keepFrameGuard}. A WebSocket upgrade's `101` is written by `ws` straight to
 * the socket, past both hooks; {@link guardUpgrades} adds the headers there.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { STUDIO_DEV_ORIGINS, type OriginPolicy } from './origin-guard.js';

export const X_FRAME_OPTIONS = 'SAMEORIGIN';

/**
 * A serialized origin exactly as a browser sends it in `Origin`: `http(s)://host[:port]`, nothing after it (no path,
 * no trailing slash, no query, fragment or credentials). Only such an entry can match an `Origin` header in
 * origin-guard's exact allowlist check, and only such an entry is a single CSP host-source that cannot end or widen
 * the directive. The entry is checked as written, never reduced to an origin first: `https://a.example/#; x` would
 * reduce to an origin the API refuses, and a granted frame would outlive that refusal.
 */
const SERIALIZED_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The `frame-ancestors` directive for this daemon: `'self'`, studio's dev server and the allowed origins, each kept
 * exactly as allowed. An entry that is not a serialized origin is left out (it can't be an `Origin` the API accepts).
 */
export function frameAncestors(policy: Pick<OriginPolicy, 'allowedOrigins'>): string {
  const sources = new Set<string>();
  for (const origin of [...STUDIO_DEV_ORIGINS, ...(policy.allowedOrigins ?? [])]) {
    if (SERIALIZED_ORIGIN.test(origin)) sources.add(origin);
  }
  return ["frame-ancestors 'self'", ...sources].join(' ');
}

/**
 * The guard on a WebSocket upgrade's `101`. `ws` writes that response to the socket itself, past both hooks; it is
 * not a document anyone can frame, but every response says the same thing.
 */
export function guardUpgrades(wss: { on(event: 'headers', listener: (headers: string[]) => void): unknown }, directive: string): void {
  wss.on('headers', (headers) => {
    headers.push(`X-Frame-Options: ${X_FRAME_OPTIONS}`, `Content-Security-Policy: ${directive}`);
  });
}

const HAS_FRAME_ANCESTORS = /(^|;)\s*frame-ancestors(\s|;|$)/i;

/**
 * `csp` with `directive` added, never replaced: a policy that already names its frame ancestors is
 * kept as it is (it can only be as strict as it chose); any other policy gets the directive appended.
 */
export function mergeFrameAncestors(csp: string | string[] | number | undefined, directive: string): string | string[] {
  if (csp === undefined) return directive;
  if (Array.isArray(csp)) {
    return csp.some((p) => HAS_FRAME_ANCESTORS.test(p)) ? csp : [...csp, directive];
  }
  const policy = String(csp).trim().replace(/;+\s*$/, '');
  if (policy === '') return directive;
  return HAS_FRAME_ANCESTORS.test(policy) ? policy : `${policy}; ${directive}`;
}

/**
 * For a hijacked response that writes its own `Content-Security-Policy`: that policy plus the
 * guard's, as separate policies (a browser enforces every one). Without the guard, `csp` as it was.
 */
export function keepFrameGuard(raw: ServerResponse, csp: string | string[] | undefined): string | string[] | undefined {
  const guard = raw.getHeader('content-security-policy');
  if (typeof guard !== 'string') return csp;
  if (csp === undefined) return guard;
  return [guard, ...(Array.isArray(csp) ? csp : [csp])];
}

/**
 * Register the guard. Call it before any other `onRequest` hook that can answer the request. Returns the directive,
 * for {@link guardUpgrades}.
 */
export function registerFrameGuard(app: FastifyInstance, policy: Pick<OriginPolicy, 'allowedOrigins'>): string {
  const directive = frameAncestors(policy);
  app.addHook('onRequest', async (_req, reply) => {
    reply.raw.setHeader('X-Frame-Options', X_FRAME_OPTIONS);
    reply.raw.setHeader('Content-Security-Policy', directive);
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    // `getHeader` falls back to the raw response, so an untouched reply reads back the guard's own
    // policy (already has frame-ancestors) and nothing changes.
    const merged = mergeFrameAncestors(reply.getHeader('content-security-policy'), directive);
    reply.header('Content-Security-Policy', merged);
    if (reply.getHeader('x-frame-options') === undefined) reply.header('X-Frame-Options', X_FRAME_OPTIONS);
    return payload;
  });
  return directive;
}
