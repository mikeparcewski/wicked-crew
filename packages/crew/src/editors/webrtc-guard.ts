/**
 * No WebRTC in an editor frame.
 *
 * An editor bundle's policy says `connect-src 'none'` (`csp.ts`), which stops fetch, XHR, WebSocket, EventSource and
 * beacons, but no browser applies `connect-src` to WebRTC. A script in the frame could open an `RTCPeerConnection` with
 * a STUN or TURN server of its choosing, and ICE then sends UDP there (Chromium ignores `webrtc 'block'`). A third-party
 * editor could carry what it reads out of the artifact that way.
 *
 * So crew puts {@link WEBRTC_PRELUDE} at the start of every inline script of every bundle it serves (after the
 * script's hashbang and its directive prologue: those are inert, and moving them would turn strict mode off; a
 * directive ended by automatic semicolon insertion is kept too, with crew's own `;` before the prelude). The
 * prelude defines each WebRTC global as a non-writable, non-configurable `undefined` before any of the editor's own
 * statements run. It has no `try`: if it cannot do that it throws, and the rest of that script never runs. It names no
 * global a script can shadow and calls nothing a script can define first. A module's own `function window(){}` is
 * bound before its first statement runs, so the prelude checks that `window` really is the window. It takes `Object`
 * from an object literal, and its failure path throws a string (not `new TypeError`, which a hoisted declaration
 * could replace).
 *
 * For a third-party editor, the bundle's `script-src` is then exactly the hashes {@link guardBundle} returns, with no
 * `'unsafe-inline'`. A new JavaScript realm could otherwise bring the constructors back: a `srcdoc` child, a
 * `javascript:` URL, or a `blob:`/`data:` document the frame navigates itself to. Every one of those documents inherits
 * the bundle's policy, so the only scripts that can run in them are copies of crew's prefixed scripts, and the prelude
 * runs first there too. `javascript:` URLs, inline event handlers and new script text are refused.
 *
 * The scanner below finds inline scripts the way an HTML parser does, closely enough for real bundles. For a
 * third-party bundle its accuracy is not what keeps the guard sound: every hash crew issues is of text that crew itself
 * built with the prelude first (after an inert prologue). A script the scanner misreads gets a hash the browser doesn't
 * compute, so it doesn't run. The editor breaks visibly, and nothing runs without the prelude. A first-party bundle
 * keeps `'unsafe-inline'` (it is studio's own code), so there the prelude is only where the scanner finds a script.
 *
 * Every script gains the prelude and a hash in one response header, so a third-party bundle may hold at most
 * {@link MAX_INLINE_SCRIPTS} inline scripts; past that crew refuses to serve it, with the reason.
 */

import { createHash } from 'node:crypto';

/** The WebRTC globals Chromium, Firefox and Safari expose, by name. The prelude also takes any other `RTC*`/`webkitRTC*`
 *  global the browser has, so a new interface is covered without a crew release. */
export const WEBRTC_GLOBALS = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'RTCDataChannel',
  'RTCIceTransport',
  'RTCDtlsTransport',
  'RTCSctpTransport',
  'RTCRtpSender',
  'RTCRtpReceiver',
  'RTCRtpTransceiver',
  'RTCIceCandidate',
  'RTCSessionDescription',
  'RTCCertificate',
] as const;

/** The prelude's one failure message (thrown as a string: see the module comment). */
export const WEBRTC_PRELUDE_REFUSAL = 'WebRTC is not available in an editor frame';

/**
 * The prelude: one line of ES5, ending in a newline so the editor's own first line stays its own statement. It holds no
 * `<` at all, so it can never end, open or escape the `<script>` it sits in. `w` must be the window itself (a module's
 * hoisted `function window(){}` is a function, a `var window` is undefined, a `let`/`class` is not yet initialized).
 * It takes the listed names always, and any other `RTC*`/`webkitRTC*`/`mozRTC*` global the browser defines (an
 * interface object is configurable; a script's own `var RTCConfig` is not, and is left alone).
 */
export const WEBRTC_PRELUDE =
  '(function(w,o){if(typeof w!=="object"||w===null||w.window!==w)throw ' + JSON.stringify(WEBRTC_PRELUDE_REFUSAL) + ';var n=' +
  JSON.stringify(WEBRTC_GLOBALS) +
  ',k=o.getOwnPropertyNames(w),i,d;for(i=0;i!==k.length;i++)if(/^(webkit|moz)?RTC/.test(k[i])&&(d=o.getOwnPropertyDescriptor(w,k[i]))&&d.configurable)n.push(k[i]);' +
  'for(i=0;i!==n.length;i++){o.defineProperty(w,n[i],{value:void 0,writable:false,configurable:false});' +
  'if(w[n[i]]!==void 0)throw ' + JSON.stringify(WEBRTC_PRELUDE_REFUSAL) + '}})(window,({}).constructor);\n';

/** The most inline scripts a third-party bundle may hold: each gains the prelude and is one hash in the policy header. */
export const MAX_INLINE_SCRIPTS = 200;

const LINE_END = /[\n\r\u2028\u2029]/;
const SPACE = /\s/;
const IDENTIFIER_PART = /[\w$\u0080-\uFFFF]/;

/**
 * Whether a directive with no `;` ends before `text[i]` by automatic semicolon insertion: a line ended after it, and
 * what follows cannot continue the expression (end of text, a statement-starting word other than `in`/`instanceof`, a
 * number, a string, a block, a unary `!` or `~`, or `++`/`--`, which may not follow a line end). Any binary operator,
 * bracket, dot or template continues it, so it does not count.
 */
function endsByAsi(text: string, i: number): boolean {
  if (i >= text.length) return true;
  const c = text[i]!;
  if (c === '"' || c === "'" || c === '{' || c === '~' || /[0-9]/.test(c)) return true;
  if (c === '!') return text[i + 1] !== '=';
  if (c === '+' || c === '-') return text[i + 1] === c;
  if (!IDENTIFIER_PART.test(c)) return false;
  let j = i;
  while (j < text.length && IDENTIFIER_PART.test(text[j]!)) j++;
  const word = text.slice(i, j);
  return word !== 'in' && word !== 'instanceof';
}

/**
 * Where the prelude goes in a script's text, read the way a JavaScript lexer reads it: past a hashbang line and a
 * directive prologue (string-literal statements, each ended by its own `;` or by automatic semicolon insertion), with
 * whitespace and comments between. No regular expression does this: a backtracking pattern can be made to end a
 * comment early or late. Here a block comment ends at its first `*\/` and a line comment at the end of its line, exactly
 * as in JavaScript, so nothing before the place found is code. `semicolon` says the last directive ended by insertion,
 * so the prelude must be written after a `;` of its own.
 */
export function prologueEnd(text: string): { at: number; afterHashbang: boolean; semicolon: boolean } {
  const n = text.length;
  let i = 0;
  let at = 0;
  let afterHashbang = false;
  let semicolon = false;
  if (text.startsWith('#!')) {
    while (i < n && !LINE_END.test(text[i]!)) i++;
    at = i;
    afterHashbang = true;
  }
  let crossed = false;
  /** Past whitespace and whole comments (noting a line end); false at a block comment that never closes. */
  const skip = (): boolean => {
    for (;;) {
      while (i < n && SPACE.test(text[i]!)) {
        if (LINE_END.test(text[i]!)) crossed = true;
        i++;
      }
      if (text.startsWith('/*', i)) {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) return false;
        if (LINE_END.test(text.slice(i, close))) crossed = true;
        i = close + 2;
      } else if (text.startsWith('//', i)) {
        while (i < n && !LINE_END.test(text[i]!)) i++;
      } else {
        return true;
      }
    }
  };
  while (skip()) {
    const quote = text[i];
    if (quote !== '"' && quote !== "'") break;
    let j = i + 1;
    let closed = false;
    while (j < n) {
      const c = text[j]!;
      if (c === '\\') { j += 2; continue; }
      if (c === quote) { closed = true; j += 1; break; }
      if (c === '\n' || c === '\r') break;
      j += 1;
    }
    if (!closed) break;
    const end = j;
    i = j;
    crossed = false;
    if (!skip()) break;
    if (text[i] === ';') {
      i += 1;
      at = i;
      semicolon = false;
    } else if ((crossed || i >= n) && endsByAsi(text, i)) {
      at = end;
      semicolon = true;
    } else {
      break;
    }
    afterHashbang = false;
  }
  return { at, afterHashbang, semicolon };
}

/** `text` with the prelude before its first statement (see {@link prologueEnd}): after a `;` of its own when the last
 *  directive ended by insertion, and on its own line after a lone hashbang. */
export function withPrelude(text: string): string {
  const { at, afterHashbang, semicolon } = prologueEnd(text);
  return text.slice(0, at) + (semicolon ? ';' : '') + (afterHashbang ? '\n' : '') + WEBRTC_PRELUDE + text.slice(at);
}

/** One served bundle: its bytes with the prelude in every inline script, and those scripts' sha256 (base64). */
export interface GuardedBundle {
  body: Buffer;
  /** base64 sha256 of each prefixed script's text, as the browser hashes it; in document order. */
  scriptHashes: string[];
  /** Set (and nothing built) when the bundle holds more running inline scripts than the limit allowed. */
  tooMany?: number;
}

/** The essences HTML runs as a classic script (HTML "JavaScript MIME type essence match"). */
const JS_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
]);
/** Elements whose content is text up to their own end tag (scripting is on in the frame, so `noscript` is one). */
const RAW_TEXT = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title']);
const WS = /[\t\n\f\r ]/;
const TAG_END = /[\t\n\f\r />]/;

/** One inline script the bundle holds: where its text is, and whether the browser runs it as JavaScript. */
export interface InlineScript {
  start: number;
  end: number;
  runs: boolean;
}

const NAMED_REFS: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/', period: '.', plus: '+', lowbar: '_', colon: ':', semi: ';', comma: ',' };

/** An attribute value as the parser hands it on: numeric character references, and the named ones a script type can
 *  use. One it does not know stays as written, so the script reads as a data block and is refused, never run unguarded. */
export function decodeAttribute(v: string): string {
  return v
    .replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g, (_m, hex: string | undefined, dec: string | undefined) => {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '\uFFFD';
    })
    .replace(/&([a-z]+);/g, (m, name: string) => NAMED_REFS[name] ?? m);
}

/** Whether `<script …>` with these attributes runs its text as a classic or module script (HTML "prepare the script
 *  element"); a `src` makes it external (`href` or `xlink:href` for an SVG script), and an unknown type makes it a
 *  data block. */
function runsInline(attrs: Map<string, string>, svg: boolean): boolean {
  if (svg ? attrs.has('href') || attrs.has('xlink:href') : attrs.has('src')) return false;
  const language = attrs.get('language');
  const raw = attrs.has('type') ? attrs.get('type')! : language !== undefined && language !== '' ? `text/${language}` : '';
  if (raw === '') return true;
  const type = raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
  return type === 'module' || JS_TYPES.has(type);
}

/**
 * The inline scripts of `html` (already newline-normalized), in document order. A tokenizer cut down to what decides
 * where a script's text is: comments, doctypes and bogus comments, quoted attribute values, raw-text elements, and
 * the script-data escape states (`<!--`, `<script`, `-->` inside a script).
 */
export function inlineScripts(html: string): InlineScript[] {
  const s = html;
  const n = s.length;
  const out: InlineScript[] = [];
  const at = (p: number, word: string): boolean => s.slice(p, p + word.length).toLowerCase() === word;
  const delimited = (p: number): boolean => p < n && TAG_END.test(s[p]!);

  /** Attributes from `p` (just after the tag name) to the tag's `>`; `end` is past the `>`, or -1 at end of file. */
  const attributes = (p: number): { end: number; attrs: Map<string, string>; selfClosing: boolean } => {
    const attrs = new Map<string, string>();
    let j = p;
    while (j < n) {
      const from = j;
      while (j < n && (WS.test(s[j]!) || s[j] === '/')) j++;
      if (j >= n) break;
      // Self-closing is a `/` between attributes right before `>`, never the last character of an unquoted value.
      if (s[j] === '>') return { end: j + 1, attrs, selfClosing: j > from && s[j - 1] === '/' };
      let k = j + 1; // a name may start with `=`
      while (k < n && !TAG_END.test(s[k]!) && s[k] !== '=') k++;
      const name = s.slice(j, k).toLowerCase();
      let m = k;
      while (m < n && WS.test(s[m]!)) m++;
      let value = '';
      if (s[m] === '=') {
        m++;
        while (m < n && WS.test(s[m]!)) m++;
        const q = s[m];
        if (q === '"' || q === "'") {
          const close = s.indexOf(q, m + 1);
          if (close < 0) return { end: -1, attrs, selfClosing: false };
          value = s.slice(m + 1, close);
          j = close + 1;
        } else {
          let e = m;
          while (e < n && !WS.test(s[e]!) && s[e] !== '>') e++;
          value = s.slice(m, e);
          j = e;
        }
      } else {
        j = m;
      }
      if (!attrs.has(name)) attrs.set(name, decodeAttribute(value));
    }
    return { end: -1, attrs, selfClosing: false };
  };

  /** Where a script's text ends (the `<` of its end tag, or end of file), from `p` just after its start tag. */
  // The next `-->`, `--!>` from where the scan is: found once and kept while it is still ahead, so a long run of `<`
  // after an open `<!--` costs one search, not one per `<` (the scan stays linear in the bundle's size).
  const ahead = { close: -2, bang: -2 };
  const nextFrom = (key: 'close' | 'bang', needle: string, from: number): number => {
    if (ahead[key] === -2 || (ahead[key] !== -1 && ahead[key] < from)) ahead[key] = s.indexOf(needle, from);
    return ahead[key];
  };
  const scriptTextEnd = (p: number): number => {
    let state: 'data' | 'escaped' | 'double' = 'data';
    let i = p;
    while (i < n) {
      if (state === 'data') {
        const lt = s.indexOf('<', i);
        if (lt < 0) return n;
        if (at(lt, '</script') && delimited(lt + 8)) return lt;
        if (at(lt, '<!--')) { state = 'escaped'; i = lt + 2; continue; } // `<!-->` closes again at once
        i = lt + 1;
        continue;
      }
      const lt = s.indexOf('<', i);
      const close = nextFrom('close', '-->', i);
      if (close >= 0 && (lt < 0 || close < lt)) { state = 'data'; i = close + 3; continue; }
      if (lt < 0) return n;
      if (at(lt, '</script') && delimited(lt + 8)) {
        if (state === 'escaped') return lt;
        state = 'escaped';
        i = lt + 8;
        continue;
      }
      if (state === 'escaped' && at(lt, '<script') && delimited(lt + 7)) { state = 'double'; i = lt + 7; continue; }
      i = lt + 1;
    }
    return n;
  };

  // Inside <svg> or <math> (foreign content) `style`, `title` and the like are ordinary elements, not raw text, and a
  // self-closing `<script/>` is empty.
  let foreign = 0;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const c = s[lt + 1] ?? '';
    if (at(lt, '<!--')) {
      if (s[lt + 4] === '>') { i = lt + 5; continue; }
      if (s.startsWith('->', lt + 4)) { i = lt + 6; continue; }
      const a = nextFrom('close', '-->', lt + 4);
      const b = nextFrom('bang', '--!>', lt + 4);
      const end = a < 0 ? (b < 0 ? -1 : b + 4) : b < 0 || a < b ? a + 3 : b + 4;
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === '!' || c === '?') {
      const end = s.indexOf('>', lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === '/') {
      if (!/[A-Za-z]/.test(s[lt + 2] ?? '')) {
        const end = s.indexOf('>', lt + 2); // `</>` is nothing; `</ x>` a bogus comment
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      let k = lt + 2;
      while (k < n && !TAG_END.test(s[k]!)) k++;
      const closing = s.slice(lt + 2, k).toLowerCase();
      if (foreign > 0 && (closing === 'svg' || closing === 'math')) foreign--;
      const { end } = attributes(k);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) { i = lt + 1; continue; }
    let k = lt + 1;
    while (k < n && !TAG_END.test(s[k]!)) k++;
    const name = s.slice(lt + 1, k).toLowerCase();
    const { end, attrs, selfClosing } = attributes(k);
    if (end < 0) break; // end of file inside a tag: the parser drops it
    if ((name === 'svg' || name === 'math') && !selfClosing) { foreign++; i = end; continue; }
    if (name === 'script' && foreign > 0 && selfClosing) { i = end; continue; }
    if (name === 'script') {
      const textEnd = scriptTextEnd(end);
      out.push({ start: end, end: textEnd, runs: runsInline(attrs, foreign > 0) });
      if (textEnd >= n) break;
      const after = attributes(textEnd + 8);
      if (after.end < 0) break;
      i = after.end;
      continue;
    }
    if (RAW_TEXT.has(name) && foreign === 0) {
      let j = end;
      for (;;) {
        const close = s.indexOf('</', j);
        if (close < 0) { j = n; break; }
        if (at(close + 2, name) && delimited(close + 2 + name.length)) { j = close; break; }
        j = close + 2;
      }
      i = j;
      continue;
    }
    if (name === 'plaintext') break;
    i = end;
  }
  return out;
}

/**
 * The bundle as crew serves it: the prelude first in every inline script that runs, and those scripts' hashes.
 * Newlines are normalized first (the HTML parser turns CRLF and CR into LF before anything else, so the DOM is the same
 * and a script's text is what crew hashes). A NUL in a script's text reaches the parser as U+FFFD, so crew writes it so.
 */
export function guardBundle(bytes: Buffer, maxScripts = Number.POSITIVE_INFINITY): GuardedBundle {
  const html = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  const scripts = inlineScripts(html).filter((x) => x.runs);
  // Counted before anything is built: each script gains the prelude, so many small ones would multiply the body.
  if (scripts.length > maxScripts) return { body: Buffer.alloc(0), scriptHashes: [], tooMany: scripts.length };
  const parts: string[] = [];
  const scriptHashes: string[] = [];
  let last = 0;
  for (const script of scripts) {
    const text = withPrelude(html.slice(script.start, script.end).replace(/\0/g, '\uFFFD'));
    parts.push(html.slice(last, script.start), text);
    last = script.end;
    scriptHashes.push(createHash('sha256').update(text, 'utf8').digest('base64'));
  }
  parts.push(html.slice(last));
  return { body: Buffer.from(parts.join(''), 'utf8'), scriptHashes };
}
