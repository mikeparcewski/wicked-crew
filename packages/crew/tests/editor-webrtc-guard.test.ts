/**
 * No WebRTC in an editor frame (`editors/webrtc-guard.ts`): where the prelude goes, what it hashes, and what the
 * prelude does to a window. The browser-level proof (zero UDP from a hostile plugin) is
 * `editor-webrtc-egress.test.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { bundleHeaders } from '../src/editors/csp.js';
import { sha256Of, type EditorRecord } from '../src/editors/registry.js';
import { serveBundle } from '../src/editors/routes.js';
import { decodeAttribute, guardBundle, inlineScripts, MAX_INLINE_SCRIPTS, withPrelude, WEBRTC_GLOBALS, WEBRTC_PRELUDE, WEBRTC_PRELUDE_REFUSAL } from '../src/editors/webrtc-guard.js';

const P = WEBRTC_PRELUDE;
const b64 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('base64');
const guard = (html: string): { body: string; hashes: string[] } => {
  const g = guardBundle(Buffer.from(html, 'utf8'));
  return { body: g.body.toString('utf8'), hashes: g.scriptHashes };
};
const texts = (html: string): string[] => inlineScripts(html).map((s) => html.slice(s.start, s.end));

describe('guardBundle: the prelude goes first in every inline script that runs, and crew hashes exactly those', () => {
  it('a classic and a module script are both prefixed; their hashes are of the prefixed text', () => {
    const { body, hashes } = guard('<!doctype html><html><head><script>a()</script></head><body><script type="module">b()</script></body></html>');
    expect(body).toBe(`<!doctype html><html><head><script>${P}a()</script></head><body><script type="module">${P}b()</script></body></html>`);
    expect(hashes).toEqual([b64(`${P}a()`), b64(`${P}b()`)]);
  });

  it('the document before the first script is untouched (the doctype stays first: no quirks mode)', () => {
    const { body } = guard('<!DOCTYPE html>\n<meta charset=utf-8><title>t</title><script>x</script>');
    expect(body.startsWith('<!DOCTYPE html>\n<meta charset=utf-8><title>t</title><script>')).toBe(true);
  });

  it('an external script, a data block, an import map and a non-JS type are left alone (and get no hash)', () => {
    const html =
      '<script src="x.js"></script><script type="application/json">{"a":1}</script><script type="importmap">{}</script>' +
      '<script type="text/x-template"><b>t</b></script><script language="vbscript">x</script><script type="text/javascript; charset=utf-8">y</script>';
    const { body, hashes } = guard(html);
    expect(body).toBe(html);
    expect(hashes).toEqual([]);
  });

  it('the JavaScript types HTML runs are prefixed: empty type, JS MIME types any case with spaces, language=javascript', () => {
    const html = '<script type="">a</script><script type=" Text/JavaScript ">b</script><script type=MODULE>c</script><script language="javascript">d</script><script language="">e</script>';
    expect(guard(html).hashes).toEqual(['a', 'b', 'c', 'd', 'e'].map((t) => b64(P + t)));
  });

  it('a whitespace-only type is a data block (HTML strips it to empty, which is no JavaScript type)', () => {
    expect(guard('<script type="  ">x</script>').hashes).toEqual([]);
  });

  it('"<script>" inside a script\'s JavaScript is text, not a second script (the shape of the deck and page bundles)', () => {
    const html = '<script>var a="<script>"+"x";var b=\'<scr\'+\'ipt>\';</script><p>after</p>';
    expect(texts(html)).toEqual(['var a="<script>"+"x";var b=\'<scr\'+\'ipt>\';']);
  });

  it('script-data escapes: "<!--<script>" makes the first "</script>" not the end, as the parser does', () => {
    const html = '<script>s="<!--<script>";t="</script>";u="-->";v=1</script><p>x</p>';
    expect(texts(html)).toEqual(['s="<!--<script>";t="</script>";u="-->";v=1']);
    // without the nested <script, "</script>" after "<!--" still ends it
    expect(texts('<script>a="<!--";</script><b>')).toEqual(['a="<!--";']);
    // "<!-->" closes the escape at once
    expect(texts('<script>a="<!-->";</script><b>')).toEqual(['a="<!-->";']);
  });

  it('"</scripts>" or "</script" at end of file does not end the script; "</SCRIPT >" does', () => {
    expect(texts('<script>a="</scripts>"</SCRIPT ><i>')).toEqual(['a="</scripts>"']);
    expect(texts('<script>a</script')).toEqual(['a</script']);
  });

  it('"<script>" in a comment, a doctype-like declaration, a quoted attribute or raw text is no script', () => {
    const html =
      '<!-- <script>a</script> --><!x <script>b</script> ><div title="<script>c</script>" data-x=\'<script>\'></div>' +
      '<style>/*<script>d</script>*/</style><textarea><script>e</script></textarea><title><script>f</script></title>' +
      '<noscript><script>g</script></noscript><script>h</script>';
    expect(texts(html)).toEqual(['h']);
    const { body } = guard(html);
    expect(body).toBe(html.replace('<script>h</script>', `<script>${P}h</script>`));
  });

  it('a self-closing <script/> still opens a script (HTML ignores the slash); attributes are read with quotes', () => {
    expect(texts('<script/>a</script>')).toEqual(['a']);
    expect(texts('<script data-x="a>b" type=\'module\'>m</script>')).toEqual(['m']);
  });

  it('newlines are normalized the way the parser does, and a NUL in script text is written as U+FFFD', () => {
    const { body, hashes } = guard('<p>a\r\nb\rc</p><script>x=1;\r\ny=2\u0000</script>');
    expect(body).toBe(`<p>a\nb\nc</p><script>${P}x=1;\ny=2�</script>`);
    expect(hashes).toEqual([b64(`${P}x=1;\ny=2�`)]);
  });

  it('a directive prologue and a hashbang stay first (strict mode is kept); the prelude goes before the first statement', () => {
    expect(withPrelude('"use strict";x()')).toBe(`"use strict";${P}x()`);
    expect(withPrelude("#!/usr/bin/env node\n'use strict'; /* c */ \"b\";\ny()")).toBe(`#!/usr/bin/env node\n'use strict'; /* c */ "b";${P}\ny()`);
    // A hashbang alone: the prelude goes on the next line, never into the hashbang's comment.
    expect(withPrelude('#!/usr/bin/env node\ny()')).toBe(`#!/usr/bin/env node\n${P}\ny()`);
    // Without its own `;` a directive is not skipped (ASI could join it to the next line): the prelude goes first.
    // Ended by automatic semicolon insertion (a line ends, a statement follows): kept first, with crew's own `;`.
    expect(withPrelude('"use strict"\nb()')).toBe(`"use strict";${P}\nb()`);
    // A line that continues the expression ("(", "in", an operator): no insertion there, the prelude goes first.
    expect(withPrelude('"use strict"\n(b)')).toBe(`${P}"use strict"\n(b)`);
    expect(withPrelude('"use strict"\nin b')).toBe(`${P}"use strict"\nin b`);
    expect(withPrelude('"a" b')).toBe(`${P}"a" b`);
    // A unary `!`/`~` or `++`/`--` on the next line starts a new statement (the minified IIFE shape); `!=` and `+` do not.
    expect(withPrelude('"use strict"\n!function(){}()')).toBe(`"use strict";${P}\n!function(){}()`);
    expect(withPrelude('"use strict"\n++i')).toBe(`"use strict";${P}\n++i`);
    expect(withPrelude('"a"\n!= b')).toBe(`${P}"a"\n!= b`);
    expect(withPrelude('"a"\n+ b')).toBe(`${P}"a"\n+ b`);
    expect(withPrelude('"use strict"\n.5;x()')).toBe(`"use strict";${P}\n.5;x()`);
    expect(withPrelude('"use strict"\n\\u0074op()')).toBe(`"use strict";${P}\n\\u0074op()`);
    expect(withPrelude('"a"\n.length')).toBe(`${P}"a"\n.length`);
    // A string that starts an expression is not a directive.
    expect(withPrelude("'use strict';\n'x'+y")).toBe(`'use strict';${P}\n'x'+y`);
    const { body, hashes } = guard('<script>"use strict";x</script>');
    expect(body).toBe(`<script>"use strict";${P}x</script>`);
    expect(hashes).toEqual([b64(`"use strict";${P}x`)]);
  });

  it('a type written with character references runs as the browser runs it: decoded, then prefixed', () => {
    expect(decodeAttribute('text&#47;java&#x73;cript')).toBe('text/javascript');
    expect(decodeAttribute('text&sol;javascript&amp;&unknown;')).toBe('text/javascript&&unknown;');
    expect(guard('<script type="text&#47;javascript">a</script><script type="&#x6d;odule">b</script>').hashes).toEqual([b64(P + 'a'), b64(P + 'b')]);
  });

  it('an SVG script is external by href (src does nothing there); a value ending in "/" does not close its tag', () => {
    const html = '<svg data-path=/a/><style><script>b</script></style><script src=x>c</script><script href=y>d</script></svg><script src=z>e</script>';
    expect(inlineScripts(html).map((x) => [html.slice(x.start, x.end), x.runs])).toEqual([['b', true], ['c', true], ['d', false], ['e', false]]);
  });

  it('inside <svg>/<math>, style and title are not raw text and a self-closing <script/> is empty; HTML <style> still is', () => {
    const html = '<svg><title><script>a</script></title><style><script>b</script></style><script/></svg><style><script>c</script></style><script>d</script>';
    expect(texts(html)).toEqual(['a', 'b', 'd']);
    expect(texts('<svg><title/><style/></svg><script>e</script>')).toEqual(['e']);
  });

  it('a bundle with no inline script is served unchanged and has no hash', () => {
    expect(guard('<!doctype html><p>static</p>')).toEqual({ body: '<!doctype html><p>static</p>', hashes: [] });
  });

  it('every hash is of text that begins with the prelude: that, not the scanner, is what the policy relies on', () => {
    // The SVG script holds an entity: the browser hashes its decoded text, so this one is refused, never run unguarded.
    const odd = '<script>a</script><svg><script>b&amp;c</script></svg><script type=module><!--<script></script>--></script><script>';
    const { hashes, body } = guard(odd);
    const scripts = inlineScripts(body);
    expect(hashes.length).toBe(scripts.filter((s) => s.runs).length);
    for (const s of scripts.filter((x) => x.runs)) {
      const t = body.slice(s.start, s.end);
      expect(t.startsWith(P)).toBe(true);
      expect(hashes).toContain(b64(t));
    }
  });
});

describe('the prelude: WebRTC is gone from the window, for good, before the editor\'s first statement', () => {
  /** A window-shaped global with WebRTC on it, the way a browser defines interfaces (configurable, writable). */
  const fakeWindow = (): object => {
    const ctx = createContext({});
    runInContext(
      'var window = this; this.RTCPeerConnection = function RTCPeerConnection(){}; this.webkitRTCPeerConnection = this.RTCPeerConnection;' +
        'this.RTCFutureTransport = function(){}; this.fetchLike = 1;',
      ctx,
    );
    return ctx;
  };

  it('every listed name and any other RTC* global is undefined, non-writable and non-configurable; other globals stay', () => {
    const ctx = fakeWindow();
    runInContext(P, ctx);
    for (const name of [...WEBRTC_GLOBALS, 'RTCFutureTransport']) {
      const d = runInContext(`Object.getOwnPropertyDescriptor(window, ${JSON.stringify(name)})`, ctx) as PropertyDescriptor;
      expect(d, name).toMatchObject({ value: undefined, writable: false, configurable: false });
    }
    expect(runInContext('window.fetchLike', ctx)).toBe(1);
  });

  it('the editor cannot put a constructor back: delete is refused, assignment does nothing, redefining throws', () => {
    const ctx = fakeWindow();
    runInContext(P, ctx);
    expect(runInContext('delete window.RTCPeerConnection', ctx)).toBe(false);
    runInContext('window.RTCPeerConnection = function(){}', ctx);
    expect(runInContext('typeof window.RTCPeerConnection', ctx)).toBe('undefined');
    expect(() => runInContext("Object.defineProperty(window, 'RTCPeerConnection', { value: function(){} })", ctx)).toThrow();
  });

  it('it runs again at the start of each script without error (idempotent)', () => {
    const ctx = fakeWindow();
    runInContext(P, ctx);
    expect(() => runInContext(`${P}window.second = true;`, ctx)).not.toThrow();
    expect(runInContext('window.second', ctx)).toBe(true);
  });

  it('fails closed when `window` is not the window: a module-scope `function window(){}` (here a function scope) throws a string before the first statement, and calls no hoisted TypeError', () => {
    const ctx = fakeWindow();
    // A module's top-level declarations are bound before its first statement runs, and shadow the global names.
    const shadowed = `(function(){ ${P} window.ran = true; function window(){} function TypeError(){ globalThis.called = true } })()`;
    let thrown: unknown;
    try { runInContext(shadowed, ctx); } catch (e) { thrown = e; }
    expect(thrown).toBe(WEBRTC_PRELUDE_REFUSAL);
    expect(runInContext('typeof globalThis.called', ctx)).toBe('undefined');
    expect(runInContext('typeof RTCPeerConnection', ctx)).toBe('function'); // nothing ran in this script
    let thrownVar: unknown;
    try { runInContext(`(function(){ ${P} var window; })()`, ctx); } catch (e) { thrownVar = e; }
    expect(thrownVar).toBe(WEBRTC_PRELUDE_REFUSAL);
  });

  it('a comment cannot be read short or long to move the prelude: it still runs before the first statement (review r2)', () => {
    // A line comment that a backtracking pattern could end early (reading `"a";` as a directive), and a block comment it
    // could stretch past its real end: JavaScript ends them at the line's end and at the first `*/`, and so does crew.
    for (const body of ['//"a";\nwindow.seen = typeof RTCPeerConnection;', '/* */ window.seen = typeof RTCPeerConnection; /* */ "a";', '"use strict"; //"a";\nwindow.seen = typeof RTCPeerConnection;']) {
      const ctx = fakeWindow();
      runInContext(withPrelude(body), ctx);
      expect(runInContext('window.seen', ctx), body).toBe('undefined');
    }
    expect(withPrelude('//"a";\nx()')).toBe(`${P}//"a";\nx()`);
    expect(withPrelude('/* */ x(); /* */ "a";')).toBe(`${P}/* */ x(); /* */ "a";`);
    expect(withPrelude('"a" // c\n;b()')).toBe(`"a" // c\n;${P}b()`);
    expect(withPrelude('/* never closed')).toBe(`${P}/* never closed`);
  });

  it('a directive ended by automatic semicolon insertion keeps strict mode, and the prelude still runs first', () => {
    const ctx = fakeWindow();
    runInContext(withPrelude('"use strict"\nwindow.strict = (function(){ return this })() === undefined; window.seen = typeof RTCPeerConnection;'), ctx);
    expect(runInContext('window.strict + " " + window.seen', ctx)).toBe('true undefined');
  });

  it('a script with a hashbang and no directive still runs the prelude first (it is not swallowed by the hashbang)', () => {
    const ctx = fakeWindow();
    runInContext(withPrelude('#!/usr/bin/env node\nwindow.seen = typeof RTCPeerConnection;'), ctx);
    expect(runInContext('window.seen', ctx)).toBe('undefined');
  });

  it('takes Object from a literal: a script that hoists its own `function Object(){}` still gets WebRTC locked', () => {
    const ctx = fakeWindow();
    runInContext(`${P}window.ran = true; function Object(){}`, ctx);
    expect(runInContext('window.ran', ctx)).toBe(true);
    expect(runInContext("typeof window.RTCPeerConnection + ' ' + typeof window.webkitRTCPeerConnection", ctx)).toBe('undefined undefined');
  });


  it('is the same text studio puts in its nested frames (studio src/plugins/_shared/nestedGuard.ts pins the same sha256)', () => {
    expect(b64(P)).toBe('bshWuuB2sbcxfqYhEzM37dLx7kpAWeLCBXSHtjRL1zI=');
  });

  it('the prelude holds no "<" (it can never end, open or escape the script it sits in) and ends in a newline', () => {
    expect(P).not.toContain('<');
    expect(P.endsWith('\n')).toBe(true);
  });
});

describe('bundle headers: a third-party bundle runs exactly its prefixed scripts; no bundle loads a child frame from a URL', () => {
  const manifest = { permissions: [] } as never;

  it('third-party: script-src is the hashes, never unsafe-inline; none given means none run', () => {
    const csp = bundleHeaders({ manifest, firstParty: false }, ['AAA=', 'BBB='])['Content-Security-Policy']!;
    expect(csp).toContain("script-src 'sha256-AAA=' 'sha256-BBB=';");
    expect(csp).not.toContain('unsafe-inline\'; style'); // script-src only: style-src keeps its own
    expect(bundleHeaders({ manifest, firstParty: false })['Content-Security-Policy']).toContain("script-src 'none';");
  });

  it('first-party: unsafe-inline (its nested frames run agent HTML that studio guards); hashes are not added (they would switch unsafe-inline off)', () => {
    const csp = bundleHeaders({ manifest, firstParty: true }, ['AAA='])['Content-Security-Policy']!;
    expect(csp).toContain("script-src 'unsafe-inline';");
    expect(csp).not.toContain('sha256-');
  });

  it("every bundle: frame-src 'none' and child-src 'none', connect-src 'none' kept", () => {
    for (const firstParty of [true, false]) {
      const csp = bundleHeaders({ manifest, firstParty })['Content-Security-Policy']!;
      expect(csp).toContain("frame-src 'none'; child-src 'none'; connect-src 'none';");
    }
  });
});

describe('the policy header has a budget: a third-party bundle with too many distinct inline scripts is refused, with the reason', () => {
  const serve = (html: string, firstParty: boolean): { code: number; body: unknown; headers: Record<string, string> } => {
    const dir = mkdtempSync(join(tmpdir(), 'webrtc-budget-'));
    try {
      const entryPath = join(dir, 'index.html');
      writeFileSync(entryPath, html);
      const record = {
        manifest: { id: 'acme-many', version: '1.0.0', permissions: [] },
        sha256: sha256Of(Buffer.from(html)), bytes: Buffer.byteLength(html), entryPath, firstParty, source: firstParty ? 'studio-bundle' : 'pack', enabled: true,
      } as unknown as EditorRecord;
      const out = { code: 200, body: undefined as unknown, headers: {} as Record<string, string> };
      const reply = {
        code(c: number) { out.code = c; return { send: (b: unknown) => { out.body = b; } }; },
        header(k: string, v: string) { out.headers[k] = v; return this; },
        type() { return { send: (b: unknown) => { out.body = b; } }; },
      } as unknown as Parameters<typeof serveBundle>[1];
      serveBundle(record, reply);
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const scripts = (count: number): string => Array.from({ length: count }, (_, i) => `<script>s${i}()</script>`).join('');

  it(`${MAX_INLINE_SCRIPTS} scripts are served; one more is a 409 that says why; repeats count (each gains the prelude); the header lists each hash once`, () => {
    expect(serve(scripts(MAX_INLINE_SCRIPTS), false).code).toBe(200);
    const over = serve(scripts(MAX_INLINE_SCRIPTS + 1), false);
    expect(over.code).toBe(409);
    expect(over.body).toMatchObject({ code: 'bundle_too_many_scripts' });
    expect(String((over.body as { error: string }).error)).toMatch(/at most 200/);
    // Many copies of one tiny script would otherwise multiply the body by the prelude's size.
    expect(serve('<script></script>'.repeat(MAX_INLINE_SCRIPTS + 1), false).code).toBe(409);
    const repeated = serve('<script>s0()</script>'.repeat(10), false);
    expect(repeated.code).toBe(200);
    expect(repeated.headers['Content-Security-Policy']!.match(/'sha256-/g)).toHaveLength(1);
  });

  it('scanning is linear: a script that opens "<!--" and then holds a megabyte of "<" is guarded quickly', () => {
    const big = `<script>var t="<!--${'<'.repeat(1_000_000)}";</script>`;
    const started = Date.now();
    const g = guardBundle(Buffer.from(big));
    expect(g.scriptHashes).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(3000); // quadratic took ~9 s here; linear takes milliseconds
    const comments = `${'<!-- c -->'.repeat(100_000)}<script>x()</script>`;
    const t2 = Date.now();
    expect(guardBundle(Buffer.from(comments)).scriptHashes).toHaveLength(1);
    expect(Date.now() - t2).toBeLessThan(3000);
  });

  it('a first-party bundle has no hash list, so no budget', () => {
    expect(serve(scripts(MAX_INLINE_SCRIPTS + 1), true).code).toBe(200);
  });
});
