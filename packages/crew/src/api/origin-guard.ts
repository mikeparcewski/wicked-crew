/**
 * Which pages may talk to the daemon when auth is off (crew#1048).
 *
 * The daemon binds loopback, but a browser on the same machine runs pages from anywhere: another
 * local dev server, an agent-built app, or a remote site using DNS rebinding. With auth off (the
 * local default) no token stands between such a page and the API, and WebSockets (`/ws`,
 * `/ws/terminals/:id`, which writes to a PTY) are not covered by CORS at all. So, in local mode:
 *
 * - **Host** must be a loopback name on every request. A rebinding page reaches us under its own
 *   name (`evil.example:7701`), and a plain-http page sends no `Origin` or `Sec-Fetch-*` on a read,
 *   so the Host is the only thing that tells it apart. The worker MCP routes are exempt: the seat
 *   gateway reaches them under a host alias, and the engine checks their unit token in every mode.
 * - **A write or WebSocket upgrade** must come from the daemon's own origin or an allowed one
 *   (studio's dev server, `WICKED_CREW_ALLOWED_ORIGINS`). A write that names a foreign site in
 *   `Sec-Fetch-Site` without an `Origin` is refused too.
 * - **CORS** is reflected only for allowed origins.
 *
 * Required mode is unchanged: a bearer token carries no ambient credential, so a foreign page
 * without one holds nothing (docs/auth.md "CORS pairing").
 */
import type { AuthMode } from './auth.js';
import { isUnitTokenRoute } from './auth.js';

/** Studio's Vite dev server (`wicked-studio/vite.config.ts`, `server.port`), which calls the daemon cross-origin. */
export const STUDIO_DEV_ORIGINS: readonly string[] = ['http://127.0.0.1:4200', 'http://localhost:4200'];

/** Required mode's pre-#1048 rule: any loopback port is reflected. */
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;
const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginPolicy {
  mode: AuthMode;
  /** `null` = no allowlist (required mode then reflects any origin). */
  allowedOrigins: readonly string[] | null;
}

export interface GuardedRequest {
  method: string;
  /** The request path, without the query string. */
  path: string;
  host: string | undefined;
  origin: string | undefined;
  secFetchSite: string | undefined;
  upgrade: string | undefined;
}

/** `scheme://host[:port]`, lowercased, without a trailing dot or a default port; `null` if unparseable. */
export function canonicalOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return `${u.protocol}//${host}${u.port === '' ? '' : `:${u.port}`}`;
  } catch {
    return null;
  }
}

function loopbackHost(host: string | undefined): string | null {
  if (host === undefined || host === '') return null;
  const own = canonicalOrigin(`http://${host}`);
  if (own === null) return null;
  return LOOPBACK_NAMES.has(new URL(own).hostname) ? own : null;
}

/** May this origin read our responses (CORS reflection)? */
export function corsAllowed(origin: string, policy: OriginPolicy): boolean {
  if (policy.mode === 'required') {
    return LOOPBACK_ORIGIN.test(origin) || policy.allowedOrigins === null || policy.allowedOrigins.includes(origin);
  }
  return STUDIO_DEV_ORIGINS.includes(origin) || (policy.allowedOrigins?.includes(origin) ?? false);
}

/** `null` = let it through; otherwise the reason it is refused (403 `origin_refused`). */
export function refuseRequest(req: GuardedRequest, policy: OriginPolicy): string | null {
  if (policy.mode === 'required') return null;
  if (isUnitTokenRoute(req.method, req.path)) return null;
  const own = loopbackHost(req.host);
  if (own === null) {
    return `host '${req.host ?? ''}' is not a loopback name; open studio at http://127.0.0.1 or http://localhost`;
  }
  const writes = !SAFE_METHODS.has(req.method.toUpperCase()) || req.upgrade?.toLowerCase() === 'websocket';
  if (!writes) return null;
  if (req.origin === undefined) {
    const site = req.secFetchSite?.toLowerCase();
    if (site === undefined || site === 'same-origin' || site === 'none') return null;
    return `a ${site} page may not change anything here`;
  }
  const origin = canonicalOrigin(req.origin);
  // The daemon serves plain http, so its own origin is `http://<host>`; any other scheme is another app.
  if (origin !== null && origin === own) return null;
  if (corsAllowed(req.origin, policy)) return null;
  return `origin '${req.origin}' may not change anything here; allow it with WICKED_CREW_ALLOWED_ORIGINS`;
}
