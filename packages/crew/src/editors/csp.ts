/**
 * The two Content-Security-Policies of the editor plugin contract (DES-artifact-editor-plugins §8.2,
 * EP-C1). Spelled once, pinned by test — a header is only as good as its exact text.
 *
 *  - {@link bundleHeaders}: on the bundle response. `sandbox allow-scripts` sandboxes the bundle even
 *    when opened top-level; `default-src 'none'` + `connect-src 'none'` is the line that protects the
 *    local no-auth daemon (no fetch, XHR, WebSocket, EventSource or beacon); `form-action 'none'`,
 *    `base-uri 'none'`, no workers, no manifest. `script-src 'unsafe-inline'` is acceptable only
 *    because the bundle is ONE hashed file and nothing else can load. An editor holding
 *    `network.media` (first-party `wicked-page`: agent-authored pages use web images) gets
 *    `img-src … https:` and `font-src … https:` — a GET-only channel, never `connect-src`.
 *    `navigate-to` / `prefetch-src` are deliberately absent: no browser enforces them (review B1).
 *  - {@link shellCsp}: on studio's own shell document. A sandboxed frame may navigate ITSELF, and
 *    once it does the bundle's policy is gone — so the shell limits what any frame may point at:
 *    crew's own editors route, crew's interactive proxy (today's Document mode), `blob:` and
 *    `data:`. The origin is written per response because a path cannot follow `'self'`.
 */

import type { EditorRecord } from './registry.js';

export const BUNDLE_CSP_BASE =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:{MEDIA}; media-src blob:; font-src data:{MEDIA}; frame-src blob: data: about:; " +
  "child-src blob: data: about:; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
  "worker-src 'none'; manifest-src 'none'";

/** Exactly the §8.2 header set for one editor's bundle. */
export function bundleHeaders(record: Pick<EditorRecord, 'manifest' | 'firstParty'>): Record<string, string> {
  // `network.media` widens only for a first-party editor: a third-party one would have to ASK
  // (§6.1), and no third-party editor can be installed before EP-C8.
  const media = record.firstParty && record.manifest.permissions.some((p) => p.id === 'network.media') ? ' https:' : '';
  return {
    'Content-Security-Policy': BUNDLE_CSP_BASE.replaceAll('{MEDIA}', media),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

/** The shell's `frame-src` policy for the request's own origin (`scheme://host[:port]`). */
export function shellCsp(origin: string): string {
  return `frame-src ${origin}/api/v1/editors/ ${origin}/api/v1/projects/ blob: data:`;
}

/** `scheme://host` of a request, from what the client sent (a hosted skin may sit behind a proxy). */
export function requestOrigin(req: { protocol?: string | undefined; headers: { host?: string | undefined } }): string {
  const proto = req.protocol === 'https' ? 'https' : 'http';
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
  return `${proto}://${host}`;
}
