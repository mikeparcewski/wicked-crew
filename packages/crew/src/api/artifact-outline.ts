/**
 * What a chat seat is told about the artifact the person has open (DES-CHAT-ARTIFACTS-001 §5.1): its title, an outline
 * by slide or section (so "what does slide 4 say?" has a numbered answer even before the seat opens the copy), and the
 * text of each part the person selected, by `data-wid`.
 *
 * A small tolerant tokenizer, not a browser: the documents are interactive's own HTML (`<section class="wi-slide"
 * data-slide-id=… data-wid=…>`, speaker notes in `<aside class="notes">`), and the result is only ever DATA handed to
 * a seat, so a malformed document yields a rougher outline, never a crash. Scripts, styles, templates and comments are
 * dropped before anything is read; nothing is evaluated.
 */

/** The deepest a parsed tree nests. */
const MAX_DEPTH = 256;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** Elements that separate words when their text is joined. */
const BLOCK = /^(address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)$/;

export interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<HtmlNode | string>;
  parent: HtmlNode | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', harr: '↔', uarr: '↑', darr: '↓',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•',
  times: '×', divide: '÷', plusmn: '±', le: '≤', ge: '≥', ne: '≠', deg: '°', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', euro: '€', pound: '£', check: '✓', cross: '✗',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[name.toLowerCase()] ?? m;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  // No prototype: an attribute named `constructor` or `toString` is an attribute like any other.
  const attrs = Object.create(null) as Record<string, string>;
  for (const m of raw.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/**
 * `html` without comments and raw-text bodies (scripts, styles, templates, noscript, svg), in ONE linear pass: each
 * opening is closed with `indexOf`, and an opening that is never closed drops the rest of the document. A lazy regex
 * here would rescan to the end once per unclosed opening (quadratic on a hostile document).
 */
export function stripRaw(html: string): string {
  const out: string[] = [];
  // Every search runs on `html` itself (a lower-cased copy can differ in length: `İ` lower-cases to two units).
  // An opening's own `>` is found first: a self-closing `<svg … />` has no body to drop.
  const open = /<!--|<(script|style|template|noscript|svg)(?=[\s>/])[^<>]*>/gi;
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const m = open.exec(html);
    if (m === null) break;
    out.push(html.slice(from, m.index));
    if (m[1] === undefined) {
      const end = html.indexOf('-->', m.index + 4);
      if (end === -1) return out.join('');
      from = end + 3;
      continue;
    }
    if (/\/\s*>$/.test(m[0])) {
      from = m.index + m[0].length;
      continue;
    }
    // The close must be the tag itself (`</script>`, `</script >`), never a longer name (`</scriptlet>`).
    const close = new RegExp(`</${m[1]}(?=[\\s>/])[^<>]*>`, 'gi');
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(html);
    if (c === null) return out.join('');
    from = c.index + c[0].length;
  }
  out.push(html.slice(from));
  return out.join('');
}

/** Parse `html` into a loose tree. Unmatched closing tags are ignored; a close pops to its nearest open ancestor. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  let depth = 0;
  const src = stripRaw(html);
  // Linear by construction: the tag name ends where name characters end (the lookahead stops it giving characters
  // back to the attribute run), and the attribute run, quoted values included, stops at the next `<`. A tag that never
  // closes costs at most the distance to the next tag, never the rest of the document.
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w:-]*)(?![\w:-])((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>|([^<]+)|</g)) {
    if (m[4] !== undefined) {
      cur.children.push(decodeEntities(m[4]));
      continue;
    }
    if (m[2] === undefined) continue; // a stray '<'
    const tag = m[2].toLowerCase();
    if (m[1] === '/') {
      let up = 1;
      for (let n: HtmlNode | null = cur; n !== null && n !== root; n = n.parent, up += 1) {
        if (n.tag === tag) {
          cur = n.parent ?? root;
          depth -= up;
          break;
        }
      }
      continue;
    }
    const rawAttrs = m[3] ?? '';
    const node: HtmlNode = { tag, attrs: parseAttrs(rawAttrs.replace(/\/\s*$/, '')), children: [], parent: cur };
    cur.children.push(node);
    // Nesting is capped: past MAX_DEPTH an opening becomes a sibling, so a close's ancestor search and every
    // recursive walk stay bounded on a document of unclosed tags.
    if (!VOID.has(tag) && !/\/\s*$/.test(rawAttrs) && depth < MAX_DEPTH) {
      cur = node;
      depth += 1;
    }
  }
  return root;
}

/** The node's text, words separated at block boundaries, whitespace collapsed. `skip` drops matching subtrees. */
export function textOf(node: HtmlNode, skip?: (n: HtmlNode) => boolean): string {
  const parts: string[] = [];
  const walk = (n: HtmlNode): void => {
    for (const c of n.children) {
      if (typeof c === 'string') parts.push(c);
      else if (skip === undefined || !skip(c)) {
        const block = BLOCK.test(c.tag);
        if (block) parts.push(' ');
        walk(c);
        if (block) parts.push(' ');
      }
    }
  };
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function findAll(node: HtmlNode, pred: (n: HtmlNode) => boolean, opts: { descendIntoMatches?: boolean } = {}): HtmlNode[] {
  const out: HtmlNode[] = [];
  const walk = (n: HtmlNode): void => {
    for (const c of n.children) {
      if (typeof c === 'string') continue;
      if (pred(c)) {
        out.push(c);
        if (opts.descendIntoMatches !== true) continue;
      }
      walk(c);
    }
  };
  walk(node);
  return out;
}

function hasClass(n: HtmlNode, cls: string): boolean {
  return (n.attrs['class'] ?? '').split(/\s+/).includes(cls);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function idOrNull(v: string | undefined): string | null {
  return v !== undefined && ID.test(v) ? v : null;
}

const isSlide = (n: HtmlNode): boolean => n.tag === 'section' && (hasClass(n, 'wi-slide') || 'data-slide-id' in n.attrs);
const isNotes = (n: HtmlNode): boolean => n.tag === 'aside' && (hasClass(n, 'notes') || 'data-notes-for' in n.attrs);

/** Cut `s` at `cap` characters with an ellipsis. */
function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

export interface OutlineItem {
  /** 1-based place in the document. */
  n: number;
  /** "slide" for a deck's slides, "section" otherwise, "heading" for a document with neither. */
  unit: 'slide' | 'section' | 'heading';
  wid: string | null;
  slideId: string | null;
  text: string;
  notes: string | null;
}

export interface ArtifactOutline {
  title: string | null;
  items: OutlineItem[];
  /** Items past the cap were left out. */
  more: number;
}

/** The outline: a deck's slides, else top-level `data-wid` sections, else its h1–h3 headings. */
export function outlineOf(html: string, opts: { maxItems?: number; itemChars?: number } = {}): ArtifactOutline {
  const maxItems = opts.maxItems ?? 40;
  const itemChars = opts.itemChars ?? 400;
  const root = parseHtml(html);
  const titleNode = findAll(root, (n) => n.tag === 'title')[0];
  const h1 = findAll(root, (n) => n.tag === 'h1')[0];
  const title = titleNode !== undefined && textOf(titleNode) !== '' ? textOf(titleNode) : h1 !== undefined ? textOf(h1) : null;
  let nodes = findAll(root, isSlide);
  let unit: OutlineItem['unit'] = 'slide';
  if (nodes.length === 0) {
    nodes = findAll(root, (n) => n.tag === 'section' && /^section-\d+$/.test(n.attrs['data-wid'] ?? ''));
    unit = 'section';
  }
  if (nodes.length === 0) {
    nodes = findAll(root, (n) => /^h[1-3]$/.test(n.tag));
    unit = 'heading';
  }
  const items = nodes.slice(0, maxItems).map((node, i) => {
    const notesNodes = findAll(node, isNotes);
    const notes = notesNodes.map((x) => textOf(x)).filter((t) => t !== '').join(' ');
    return {
      n: i + 1,
      unit,
      // Ids from the document are data too: only one that is an id is shown, never a value that carries text.
      wid: idOrNull(node.attrs['data-wid']),
      slideId: idOrNull(node.attrs['data-slide-id']),
      text: cap(textOf(node, isNotes), itemChars),
      notes: notes === '' ? null : cap(notes, itemChars),
    };
  });
  return { title: title === null ? null : cap(title, 200), items, more: Math.max(0, nodes.length - maxItems) };
}

export interface AnchorText {
  wid: string;
  found: boolean;
  /** The slide (1-based) the part sits on, for a deck. */
  slide: number | null;
  tag: string | null;
  text: string;
}

/** The text of each selected part, by `data-wid`, with the slide it sits on. */
export function anchorTexts(html: string, wids: readonly string[], itemChars = 600): AnchorText[] {
  const root = parseHtml(html);
  const slides = findAll(root, isSlide);
  return wids.map((wid) => {
    const node = findAll(root, (n) => n.attrs['data-wid'] === wid, { descendIntoMatches: true })[0];
    if (node === undefined) return { wid, found: false, slide: null, tag: null, text: '' };
    let slide: number | null = null;
    for (let p: HtmlNode | null = node; p !== null; p = p.parent) {
      const at = slides.indexOf(p);
      if (at !== -1) {
        slide = at + 1;
        break;
      }
    }
    return { wid, found: true, slide, tag: node.tag, text: cap(textOf(node), itemChars) };
  });
}
