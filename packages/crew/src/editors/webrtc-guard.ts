/**
 * No WebRTC in an editor frame.
 *
 * An editor bundle's policy says `connect-src 'none'` (`csp.ts`), which stops fetch, XHR, WebSocket, EventSource and
 * beacons, but no browser applies `connect-src` to WebRTC. A script in the frame could open an `RTCPeerConnection` with
 * a STUN or TURN server of its choosing, and ICE then sends UDP there (Chromium ignores `webrtc 'block'`). A third-party
 * editor could carry what it reads out of the artifact that way.
 *
 * So crew puts {@link WEBRTC_PRELUDE} at the start of every inline script of every bundle it serves. The prelude
 * defines each `RTC*` / `webkitRTC*` global as a non-writable, non-configurable `undefined` before any of the editor's
 * own statements run. It has no `try`: if it cannot do that it throws, and the rest of that script never runs.
 *
 * For a third-party editor, the bundle's `script-src` is then exactly the hashes {@link guardBundle} returns, with no
 * `'unsafe-inline'`. A new JavaScript realm could otherwise bring the constructors back: a `srcdoc` child, a
 * `javascript:` URL, or a `blob:`/`data:` document the frame navigates itself to. Every one of those documents inherits
 * the bundle's policy, so the only scripts that can run in them are copies of crew's prefixed scripts, and the prelude
 * runs first there too. `javascript:` URLs, inline event handlers and new script text are refused.
 *
 * The scanner below finds inline scripts the way an HTML parser does, closely enough for real bundles. Its accuracy
 * is not what keeps the guard sound: every hash crew issues is of text that crew itself built to start with the
 * prelude. A script the scanner misreads gets a hash the browser doesn't compute, so it doesn't run. The editor breaks
 * visibly, and nothing runs without the prelude.
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

/**
 * The prelude: one line of ES5, ending in a newline so the editor's own first line stays its own statement. It holds no
 * `<` at all, so it can never end, open or escape the `<script>` it sits in.
 */
export const WEBRTC_PRELUDE =
  '(function(w,o){var n=' +
  JSON.stringify(WEBRTC_GLOBALS) +
  ',k=o.getOwnPropertyNames(w),i;for(i=0;i!==k.length;i++)if(/^(webkit|moz)?RTC/.test(k[i]))n.push(k[i]);' +
  'for(i=0;i!==n.length;i++){o.defineProperty(w,n[i],{value:void 0,writable:false,enumerable:false,configurable:false});' +
  'if(w[n[i]]!==void 0)throw new TypeError("WebRTC is not available in an editor frame")}})(window,Object);\n';

/** One served bundle: its bytes with the prelude in every inline script, and those scripts' sha256 (base64). */
export interface GuardedBundle {
  body: Buffer;
  /** base64 sha256 of each prefixed script's text, as the browser hashes it; in document order. */
  scriptHashes: string[];
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

/** Whether `<script …>` with these attributes runs its text as a classic or module script (HTML "prepare the script
 *  element"); a `src` makes it external, and an unknown type makes it a data block. */
function runsInline(attrs: Map<string, string>): boolean {
  if (attrs.has('src')) return false;
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
  const attributes = (p: number): { end: number; attrs: Map<string, string> } => {
    const attrs = new Map<string, string>();
    let j = p;
    while (j < n) {
      while (j < n && (WS.test(s[j]!) || s[j] === '/')) j++;
      if (j >= n) break;
      if (s[j] === '>') return { end: j + 1, attrs };
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
          if (close < 0) return { end: -1, attrs };
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
      if (!attrs.has(name)) attrs.set(name, value);
    }
    return { end: -1, attrs };
  };

  /** Where a script's text ends (the `<` of its end tag, or end of file), from `p` just after its start tag. */
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
      const close = s.indexOf('-->', i);
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

  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    const c = s[lt + 1] ?? '';
    if (at(lt, '<!--')) {
      if (s[lt + 4] === '>') { i = lt + 5; continue; }
      if (s.startsWith('->', lt + 4)) { i = lt + 6; continue; }
      const a = s.indexOf('-->', lt + 4);
      const b = s.indexOf('--!>', lt + 4);
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
      const { end } = attributes(k);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) { i = lt + 1; continue; }
    let k = lt + 1;
    while (k < n && !TAG_END.test(s[k]!)) k++;
    const name = s.slice(lt + 1, k).toLowerCase();
    const { end, attrs } = attributes(k);
    if (end < 0) break; // end of file inside a tag: the parser drops it
    if (name === 'script') {
      const textEnd = scriptTextEnd(end);
      out.push({ start: end, end: textEnd, runs: runsInline(attrs) });
      if (textEnd >= n) break;
      const after = attributes(textEnd + 8);
      if (after.end < 0) break;
      i = after.end;
      continue;
    }
    if (RAW_TEXT.has(name)) {
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
 * The bundle as crew serves it: the prelude at the start of every inline script that runs, and those scripts' hashes.
 * Newlines are normalized first (the HTML parser turns CRLF and CR into LF before anything else, so the DOM is the same
 * and a script's text is what crew hashes). A NUL in a script's text reaches the parser as U+FFFD, so crew writes it so.
 */
export function guardBundle(bytes: Buffer): GuardedBundle {
  const html = bytes.toString('utf8').replace(/\r\n?/g, '\n');
  const parts: string[] = [];
  const scriptHashes: string[] = [];
  let last = 0;
  for (const script of inlineScripts(html)) {
    if (!script.runs) continue;
    const text = WEBRTC_PRELUDE + html.slice(script.start, script.end).replace(/\0/g, '�');
    parts.push(html.slice(last, script.start), text);
    last = script.end;
    scriptHashes.push(createHash('sha256').update(text, 'utf8').digest('base64'));
  }
  parts.push(html.slice(last));
  return { body: Buffer.from(parts.join(''), 'utf8'), scriptHashes };
}
