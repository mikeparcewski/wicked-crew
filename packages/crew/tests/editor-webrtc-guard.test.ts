/**
 * No WebRTC in an editor frame (`editors/webrtc-guard.ts`): where the prelude goes, what it hashes, and what the
 * prelude does to a window. The browser-level proof (zero UDP from a hostile plugin) is
 * `editor-webrtc-egress.test.ts`.
 */
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { bundleHeaders } from '../src/editors/csp.js';
import { guardBundle, inlineScripts, WEBRTC_GLOBALS, WEBRTC_PRELUDE } from '../src/editors/webrtc-guard.js';

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

  it('a bundle with no inline script is served unchanged and has no hash', () => {
    expect(guard('<!doctype html><p>static</p>')).toEqual({ body: '<!doctype html><p>static</p>', hashes: [] });
  });

  it('every hash is of text that begins with the prelude: that, not the scanner, is what the policy relies on', () => {
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

  it('fails closed: a script whose own hoisted declaration breaks the prelude throws before its first statement runs', () => {
    const ctx = fakeWindow();
    // `function Object(){}` is hoisted over the global before the prelude runs: the prelude throws, the rest never runs.
    expect(() => runInContext(`${P}window.ran = true; function Object(){}`, ctx)).toThrow();
    expect(runInContext('window.ran', ctx)).toBeUndefined();
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
