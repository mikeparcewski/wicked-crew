// The page, its headers, the image's Dockerfile and the client address rule (DES-APPS-001 §8.2), without a server.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { composePage, pageCsp, pageHeaders } from '../src/page.js';
import { clientAddress, trustList } from '../src/server.js';

const boot = { app: { slug: 'desk', name: 'Desk </title><script>' }, origin: 'https://desk.example.com', signIn: null };
const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');

describe('the page', () => {
  it('normalises CRLF and CR to LF before hashing, as the HTML parser does, so a Windows-checkout file is not blocked by its own hash', () => {
    const page = composePage({ runtimeJs: 'var wickedAppsStandalone = {};\r\nvar a = 1;\r', runtimeCss: ':root {\r\n  --a: 1;\r\n}', hostJs: 'void 0;\r\n', hostCss: '.x {}\r\n', boot, title: 'Desk' });
    expect(page.html).not.toContain('\r');
    const script = /<script>([\s\S]*)<\/script>\n<\/body>/.exec(page.html)![1]!;
    const style = /<style id="wk-apps-sheet">([\s\S]*?)<\/style>/.exec(page.html)![1]!;
    expect(page.scriptHash).toBe(h(script));
    expect(page.styleHash).toBe(h(style));
  });

  it('escapes the title and keeps the bootstrap JSON inert; a script that would end its element is refused', () => {
    const page = composePage({ runtimeJs: 'var wickedAppsStandalone = {};', runtimeCss: '', hostJs: 'void 0;', hostCss: '', boot, title: boot.app.name });
    expect(page.html).toContain('<title>Desk &#60;/title&#62;&#60;script&#62;</title>');
    expect(page.html).toContain('"Desk \\u003c/title>\\u003cscript>"');
    expect(page.html.match(/<script>/g)).toHaveLength(1);
    expect(() => composePage({ runtimeJs: 'x = "</script>"', runtimeCss: '', hostJs: '', hostCss: '', boot, title: 't' })).toThrow(/end its <script>/);
    expect(() => composePage({ runtimeJs: '', runtimeCss: 'a{} </style>', hostJs: '', hostCss: '', boot, title: 't' })).toThrow(/end its <style>/);
  });

  it("sends X-Frame-Options: DENY only when no origin may frame the site", () => {
    const none = pageCsp({ scriptHash: 'a', styleHash: 'b' }, { connect: [], frameAncestors: [] });
    expect(none).toContain("frame-ancestors 'none'");
    expect(pageHeaders(none)['x-frame-options']).toBe('DENY');
    const some = pageCsp({ scriptHash: 'a', styleHash: 'b' }, { connect: ['https://dex.example.com'], frameAncestors: ['https://teams.microsoft.com'] });
    expect(some).toContain('frame-ancestors https://teams.microsoft.com');
    expect(some).toContain("connect-src 'self' https://dex.example.com");
    expect(pageHeaders(some)['x-frame-options']).toBeUndefined();
  });
});

describe('the image', () => {
  it('declares no VOLUME: without an explicit -v the server finds no mount and refuses actions (no anonymous store)', () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'image', 'Dockerfile'), 'utf8');
    const instructions = file.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(instructions.some((l) => /^\s*VOLUME\b/i.test(l))).toBe(false);
    expect(file).toMatch(/^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(file).toMatch(/^USER node$/m);
  });
});

describe('the client address', () => {
  it('is the socket address unless a trusted proxy sent the request; then the nearest untrusted X-Forwarded-For hop', () => {
    const trusted = trustList(['10.0.0.0/8', '::1']);
    expect(clientAddress('203.0.113.9', '198.51.100.1', trusted)).toBe('203.0.113.9');
    expect(clientAddress('10.1.2.3', '198.51.100.1', trusted)).toBe('198.51.100.1');
    expect(clientAddress('::ffff:10.1.2.3', '198.51.100.1, 10.9.9.9', trusted)).toBe('198.51.100.1');
    expect(clientAddress('10.1.2.3', 'spoofed, 198.51.100.7', trusted)).toBe('198.51.100.7');
    expect(clientAddress('10.1.2.3', 'not-an-address', trusted)).toBe('10.1.2.3');
    expect(clientAddress('10.1.2.3', '198.51.100.1', null)).toBe('10.1.2.3');
    expect(() => trustList(['10.0.0.0/33'])).toThrow(/bad prefix/);
    expect(() => trustList(['proxy.internal'])).toThrow(/not an address/);
  });
});
