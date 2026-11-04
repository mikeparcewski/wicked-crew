/**
 * The site's one page and its headers (DES-APPS-001 §7.1, §8.2).
 *
 * The page holds exactly one stylesheet (the runtime's, then the host's rules) and exactly one script (the
 * runtime's standalone entry, then the in-process host, inside one function so neither is global), both
 * pinned by hash in the CSP, plus a non-executing JSON block with the sign-in bootstrap. Nothing else runs:
 * no other inline code, no style attributes (the runtime styles through the CSSOM only), no network image.
 */

import { createHash } from 'node:crypto';

/** What the page tells the host before sign-in: never a secret, never data. */
export interface SiteBoot {
  app: { slug: string; name: string };
  origin: string;
  /** `null` on a public site. */
  signIn: null | {
    profile: 'oidc' | 'entra';
    issuer: string;
    clientId: string;
    scope: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    /** The ID token signing algorithms the issuer named; absent = the client library's default (RS256). */
    idTokenAlgs?: string[];
  };
}

export interface Page {
  html: string;
  scriptHash: string;
  styleHash: string;
}

const b64sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** JSON that can sit inside a `<script>` element: no `<` at all, so no `</script>` and no `<!--`. */
export function inlineJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Line ends as the HTML parser leaves them: it turns every CRLF and lone CR into LF before a script or style is
 * hashed, so a file with Windows line ends would be blocked by its own hash unless it is normalised first.
 */
export const lf = (s: string): string => s.replace(/\r\n?/g, '\n');

export function composePage(raw: { runtimeJs: string; runtimeCss: string; hostJs: string; hostCss: string; boot: SiteBoot; title: string }): Page {
  const input = { ...raw, runtimeJs: lf(raw.runtimeJs), runtimeCss: lf(raw.runtimeCss), hostJs: lf(raw.hostJs), hostCss: lf(raw.hostCss) };
  for (const [what, text] of [['runtime script', input.runtimeJs], ['host script', input.hostJs]] as const) {
    if (/<\/script/i.test(text) || /<!--/.test(text)) throw new Error(`the ${what} holds a sequence that would end its <script> element`);
  }
  for (const [what, text] of [['runtime stylesheet', input.runtimeCss], ['host stylesheet', input.hostCss]] as const) {
    if (/<\/style/i.test(text)) throw new Error(`the ${what} holds a sequence that would end its <style> element`);
  }
  const style = `${input.runtimeCss}\n${input.hostCss}`;
  // The runtime's IIFE declares one `var`; inside this function it is local, and the host reads it by name.
  const script = `(function(){"use strict";\n${input.runtimeJs}\n;\n${input.hostJs}\n})();`;
  const html = lf(
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="referrer" content="no-referrer">\n' +
    `<title>${escapeHtml(input.title)}</title>\n` +
    `<style id="wk-apps-sheet">${style}</style>\n` +
    `<script type="application/json" id="wk-boot">${inlineJson(input.boot)}</script>\n` +
    `</head>\n<body>\n<script>${script}</script>\n</body>\n</html>\n`,
  );
  return { html, scriptHash: b64sha(script), styleHash: b64sha(style) };
}

/** `https://host[:port]` of a URL, for `connect-src`. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * The page's CSP, exactly as DES §8.2 states it, plus `base-uri 'none'` and `object-src 'none'` (stricter,
 * and nothing on the page uses either).
 */
export function pageCsp(page: Pick<Page, 'scriptHash' | 'styleHash'>, opts: { connect: string[]; frameAncestors: string[] }): string {
  const connect = ["'self'", ...new Set(opts.connect)].join(' ');
  const ancestors = opts.frameAncestors.length === 0 ? "'none'" : [...new Set(opts.frameAncestors)].join(' ');
  return [
    "default-src 'self'",
    `script-src 'sha256-${page.scriptHash}'`,
    `style-src 'sha256-${page.styleHash}'`,
    `connect-src ${connect}`,
    "img-src 'self' data:",
    "frame-src 'none'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`,
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers on every page answer; `X-Frame-Options: DENY` too when no origin may frame the site (older browsers). */
export function pageHeaders(csp: string): Record<string, string> {
  return {
    ...(csp.includes("frame-ancestors 'none'") ? { 'x-frame-options': 'DENY' } : {}),
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

/** Headers on every API answer: JSON only, never framed, never cached, never sniffed. */
export const API_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
});
