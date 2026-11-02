/**
 * The two Content-Security-Policies of the editor plugin contract (DES-artifact-editor-plugins §8.2,
 * EP-C1). Spelled once, pinned by test — a header is only as good as its exact text.
 *
 *  - {@link bundleHeaders}: on the bundle response. `sandbox allow-scripts` sandboxes the bundle even
 *    when opened top-level; `default-src 'none'` + `connect-src 'none'` is the line that protects the
 *    local no-auth daemon (no fetch, XHR, WebSocket, EventSource or beacon); `form-action 'none'`,
 *    `base-uri 'none'`, no workers, no manifest. An editor holding
 *    `network.media` (first-party `wicked-page`: agent-authored pages use web images) gets
 *    `img-src … https:` and `font-src … https:` — a GET-only channel, never `connect-src`.
 *    `navigate-to` / `prefetch-src` are deliberately absent: no browser enforces them (review B1).
 *    WebRTC is outside `connect-src`, so crew serves every bundle with the `webrtc-guard.ts` prelude at the
 *    start of each inline script. A THIRD-PARTY bundle's `script-src` is exactly those scripts' hashes, so no
 *    new realm it can make (a `srcdoc` child, a `blob:`/`data:` document it navigates to) runs a line before
 *    the prelude, and `javascript:` URLs and inline handlers are refused. A first-party bundle keeps
 *    `'unsafe-inline'`: its nested frames run agent HTML, which studio guards (from the studio release that carries
 *    `guardNestedHtml`; until crew bundles it, those nested frames are not covered). No bundle
 *    may load a child frame from a URL (`frame-src 'none'`); `srcdoc` frames are not URL loads.
 *  - {@link shellCsp}: on studio's own shell document. A sandboxed frame may navigate ITSELF, and
 *    once it does the bundle's policy is gone — so the shell limits what any frame may point at:
 *    crew's own editors route, crew's interactive proxy (today's Document mode), `blob:` and
 *    `data:`. The origin is written per response because a path cannot follow `'self'`.
 */

import type { EditorRecord } from './registry.js';

export const BUNDLE_CSP_BASE =
  "sandbox allow-scripts; default-src 'none'; script-src {SCRIPTS}; style-src 'unsafe-inline'; " +
  "img-src data: blob:{MEDIA}; media-src blob:; font-src data:{MEDIA}; frame-src 'none'; " +
  "child-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
  "worker-src 'none'; manifest-src 'none'";

/** A first-party bundle's `script-src`: its own inline scripts, whatever their text (see the module comment). */
export const FIRST_PARTY_SCRIPTS = "'unsafe-inline'";

/**
 * The second policy every third-party bundle carries: inline scripts only, no URL at all. A hash source would also let
 * an external script through when its `integrity` names that hash (CSP3), and the browser fetches it before checking:
 * a plugin knows its own script's hash, so the hash policy alone would let it send a request anywhere. A script must
 * satisfy both policies; documents the frame makes inherit both.
 */
export const INLINE_ONLY_POLICY = "script-src 'unsafe-inline'";

/** A third-party bundle's `script-src`: exactly its prefixed inline scripts (`guardBundle`), each once, or nothing. */
export function thirdPartyScripts(scriptHashes: readonly string[]): string {
  const unique = [...new Set(scriptHashes)];
  return unique.length === 0 ? "'none'" : unique.map((h) => `'sha256-${h}'`).join(' ');
}

/**
 * Exactly the §8.2 header set for one editor's bundle. `scriptHashes` are the served bundle's prefixed inline
 * scripts (`guardBundle`); a third-party bundle runs those and nothing else, so none given means none run.
 */
export function bundleHeaders(record: Pick<EditorRecord, 'manifest' | 'firstParty'>, scriptHashes: readonly string[] = []): Record<string, string> {
  // `network.media` widens only for a first-party editor: a third-party pack editor never gets the
  // network (§6.1 would have it ASK; garden's editor scaffold refuses to declare it at all).
  const media = record.firstParty && record.manifest.permissions.some((p) => p.id === 'network.media') ? ' https:' : '';
  const policy = BUNDLE_CSP_BASE.replaceAll('{MEDIA}', media);
  return {
    // One header, a comma-separated policy list (CSP3): the third-party hash policy, then the inline-only one.
    'Content-Security-Policy': record.firstParty
      ? policy.replace('{SCRIPTS}', FIRST_PARTY_SCRIPTS)
      : `${policy.replace('{SCRIPTS}', thirdPartyScripts(scriptHashes))}, ${INLINE_ONLY_POLICY}`,
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
