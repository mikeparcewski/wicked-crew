// crew#1905 — which source names a rule's trigger can tell apart.
//
// Core matches a rule's `trigger.contains` (a Rust regex) against the canonical JSON of an MCP call's context
// (wicked-core src/mcp_gate.rs `context()`, serialised with sorted keys by wicked-governance `canonical_context`). A
// source's name appears there in exactly four places: `mcp.server`, `mcp.subject`, `tool` and `work`. Renaming a source
// changes only those characters, so a trigger behaves the same under both names unless some match of it can consume a
// character of a name (or, with a word boundary, a character beside one).
//
// This module answers that question without running the regex: it reads the trigger into an automaton that accepts AT
// LEAST every string the Rust regex matches (anything it cannot model exactly is widened, never narrowed), and searches
// the product of that automaton with an automaton of every context core can build for the name. A path that consumes a
// name character means the trigger may tell the names apart. Widening can only add such paths, so the answer errs
// towards "it can" (fail-closed). A trigger it cannot read at all, or too large to search, is answered as naming both.

/** Characters: ASCII 0-127 exactly, and 128 standing for every non-ASCII character. */
const SIZE = 129;
const OTHER = 128;
type CharSet = Uint8Array;

function none(): CharSet {
  return new Uint8Array(SIZE);
}
function all(): CharSet {
  return new Uint8Array(SIZE).fill(1);
}
function codeOf(ch: string): number {
  const c = ch.codePointAt(0)!;
  return c < 128 ? c : OTHER;
}
/** One character, with its other case added (a case-blind `(?i)` trigger is covered whether or not it says so). */
function charOf(ch: string, fold: boolean): CharSet {
  const s = none();
  s[codeOf(ch)] = 1;
  if (!fold) return s;
  if (codeOf(ch) === OTHER) {
    // A non-ASCII letter may fold to an ASCII one (the long s to `s`, the Kelvin sign to `k`).
    letters(s);
  } else if (/[A-Za-z]/.test(ch)) {
    s[codeOf(ch.toLowerCase())] = 1;
    s[codeOf(ch.toUpperCase())] = 1;
    s[OTHER] = 1; // and an ASCII letter to a non-ASCII one
  }
  return s;
}
/** Adds every ASCII letter to `s`. */
function letters(s: CharSet): void {
  for (let x = 65; x <= 90; x++) s[x] = 1;
  for (let x = 97; x <= 122; x++) s[x] = 1;
}
function except(...chars: string[]): CharSet {
  const s = all();
  for (const c of chars) s[codeOf(c)] = 0;
  return s;
}
function meets(a: CharSet, b: CharSet): boolean {
  for (let i = 0; i < SIZE; i++) if (a[i] === 1 && b[i] === 1) return true;
  return false;
}

/** A Thompson automaton: per state, its empty moves and its moves on a set of characters. */
class Nfa {
  readonly eps: number[][] = [];
  readonly moves: Array<Array<[CharSet, number, boolean]>> = [];
  add(): number {
    this.eps.push([]);
    this.moves.push([]);
    return this.eps.length - 1;
  }
  get size(): number {
    return this.eps.length;
  }
}

interface Frag {
  s: number;
  e: number;
}

class Unreadable extends Error {}

/**
 * Reads a Rust regex into an automaton accepting a superset of what it matches. Widenings: every bounded repeat is a
 * `*`; anchors and `\b`/`\B` match the empty string (the caller widens the name by a character for a boundary); `.`,
 * Unicode and Perl classes and any escape with a letter are any character; literal letters and positive classes match
 * either case; a negated class drops only what it lists exactly, and any part it cannot list exactly makes it any
 * character. Verbose mode (`x`) is refused: it would make spaces mean nothing.
 */
class Reader {
  private i = 0;
  boundary = false;
  constructor(private readonly src: string, private readonly nfa: Nfa) {}

  read(): Frag {
    const f = this.alt();
    if (this.i !== this.src.length) throw new Unreadable(`unexpected ${this.src[this.i]}`);
    return f;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private alt(): Frag {
    const branches = [this.concat()];
    while (this.peek() === '|') {
      this.i++;
      branches.push(this.concat());
    }
    if (branches.length === 1) return branches[0]!;
    const s = this.nfa.add();
    const e = this.nfa.add();
    for (const b of branches) {
      this.nfa.eps[s]!.push(b.s);
      this.nfa.eps[b.e]!.push(e);
    }
    return { s, e };
  }

  private concat(): Frag {
    const s = this.nfa.add();
    let end = s;
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const f = this.repeat();
      if (f === null) continue;
      this.nfa.eps[end]!.push(f.s);
      end = f.e;
    }
    return { s, e: end };
  }

  private repeat(): Frag | null {
    let f = this.atom();
    if (f === null) return null;
    for (;;) {
      const q = this.peek();
      if (q === '*' || q === '+' || q === '?') {
        this.i++;
        f = this.quantify(f, q === '+' ? 1 : 0, q !== '?');
      } else if (q === '{' && /^\{\s*\d*\s*(,\s*\d*\s*)?\}/.test(this.src.slice(this.i))) {
        const m = /^\{\s*\d*\s*(,\s*\d*\s*)?\}/.exec(this.src.slice(this.i))!;
        this.i += m[0].length;
        // {n}, {n,}, {,m} and {n,m}: widened to zero or more.
        f = this.quantify(f, 0, true);
      } else {
        break;
      }
      if (this.peek() === '?') this.i++; // lazy: the same strings
    }
    return f;
  }

  private quantify(f: Frag, min: 0 | 1, many: boolean): Frag {
    const s = this.nfa.add();
    const e = this.nfa.add();
    this.nfa.eps[s]!.push(f.s);
    this.nfa.eps[f.e]!.push(e);
    if (min === 0) this.nfa.eps[s]!.push(e);
    if (many) this.nfa.eps[f.e]!.push(f.s);
    return { s, e };
  }

  private set(cs: CharSet): Frag {
    const s = this.nfa.add();
    const e = this.nfa.add();
    this.nfa.moves[s]!.push([cs, e, false]);
    return { s, e };
  }

  private empty(): Frag {
    const s = this.nfa.add();
    return { s, e: s };
  }

  /** The next whole character (a code point, so a character outside the BMP is one character, as in Rust). */
  private next(): string {
    const c = String.fromCodePoint(this.src.codePointAt(this.i)!);
    this.i += c.length;
    return c;
  }

  private atom(): Frag | null {
    const c = this.next();
    if (c === '(') {
      if (this.src.startsWith('?', this.i)) {
        const m = /^\?(P?<[A-Za-z_][A-Za-z0-9_]*>|:|[a-zA-Z-]*:|[a-zA-Z-]*\))/.exec(this.src.slice(this.i));
        if (m === null) throw new Unreadable('group');
        const flags = /^P?</.test(m[1]!) ? '' : m[1]!.split('-')[0]!;
        if (flags.includes('x')) throw new Unreadable('verbose mode');
        this.i += m[0].length;
        if (m[1]!.endsWith(')')) return null; // flags for the rest of the group: the reading is already case-blind
      }
      const f = this.alt();
      if (this.src[this.i++] !== ')') throw new Unreadable('unclosed group');
      return f;
    }
    if (c === ')') throw new Unreadable('unopened group');
    if (c === '[') return this.set(this.cls());
    if (c === '.') return this.set(all());
    if (c === '^' || c === '$') return this.empty();
    if (c === '*' || c === '+' || c === '?') throw new Unreadable('nothing to repeat');
    if (c === '\\') return this.escape();
    // A `{` that is not a repeat (those are read after an atom): Rust's reading of it is not modelled.
    if (c === '{') throw new Unreadable('brace');
    return this.set(charOf(c, true));
  }

  private escape(): Frag {
    const c = this.src[this.i++];
    if (c === undefined) throw new Unreadable('trailing backslash');
    if (c === 'A' || c === 'z') return this.empty();
    if (c === 'b' || c === 'B' || c === '<' || c === '>') {
      this.boundary = true;
      if (this.src.startsWith('{', this.i)) this.skipBraces();
      return this.empty();
    }
    if (!/[A-Za-z0-9]/.test(c)) return this.set(charOf(c, true));
    this.skipEscapeBody(c);
    return this.set(all());
  }

  /** Steps over the rest of an escape whose meaning is widened to any character (`\x41`, `\x{..}`, `\pL`, `\p{..}`). */
  private skipEscapeBody(c: string): void {
    if (c === 'x' || c === 'u' || c === 'U' || c === 'p' || c === 'P') {
      if (this.src.startsWith('{', this.i)) this.skipBraces();
      else if (c === 'p' || c === 'P') this.i++;
      else {
        const n = c === 'x' ? 2 : c === 'u' ? 4 : 8;
        this.i += Math.min(n, (/^[0-9A-Fa-f]*/.exec(this.src.slice(this.i))![0]).length);
      }
    }
  }

  private skipBraces(): void {
    const close = this.src.indexOf('}', this.i);
    if (close === -1) throw new Unreadable('unclosed brace');
    this.i = close + 1;
  }

  /** A bracket class, after its `[`. */
  private cls(): CharSet {
    const negated = this.peek() === '^';
    if (negated) this.i++;
    const listed = none();
    let exact = true;
    const add = (ch: string): void => {
      if (negated) {
        if (codeOf(ch) !== OTHER) listed[codeOf(ch)] = 1; // dropping one non-ASCII character cannot drop them all
      } else {
        listed.set(charOf(ch, true).map((v, k) => v | listed[k]!));
      }
    };
    // A `]` first is a member, never the start of a range (Rust reads it before the other members).
    if (this.peek() === ']') {
      this.i++;
      add(']');
    }
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) throw new Unreadable('unclosed class');
      if (c === ']') {
        this.i++;
        break;
      }
      // A nested or POSIX class: its extent and meaning are not modelled.
      if (c === '[') throw new Unreadable('nested class');
      if ((c === '&' || c === '-' || c === '~') && this.src[this.i + 1] === c) {
        exact = false; // a set operation
        this.i += 2;
        continue;
      }
      const lo = this.classChar();
      if (lo === null) {
        exact = false;
        continue;
      }
      if (this.peek() === '-' && this.src[this.i + 1] !== ']' && this.src[this.i + 1] !== undefined) {
        this.i++;
        const hi = this.classChar();
        if (hi === null) {
          exact = false;
          continue;
        }
        const a = lo.codePointAt(0)!;
        const b = hi.codePointAt(0)!;
        if (b < a) throw new Unreadable('backwards range');
        if (b >= 128) {
          if (negated) exact = false;
          else {
            listed[OTHER] = 1;
            letters(listed); // a non-ASCII member may fold to an ASCII letter
          }
        }
        for (let x = a; x <= Math.min(b, 127); x++) {
          const ch = String.fromCodePoint(x);
          if (negated) listed[x] = 1;
          else listed.set(charOf(ch, true).map((v, k) => v | listed[k]!));
        }
        continue;
      }
      add(lo);
    }
    if (!exact) return all();
    if (!negated) return listed;
    const out = all();
    for (let x = 0; x < SIZE; x++) if (listed[x] === 1) out[x] = 0;
    return out;
  }

  /** One class member: a character, or null for one that stands for many (`\d`, `\pL`, …). */
  private classChar(): string | null {
    const c = this.next();
    if (c !== '\\') return c;
    const d = this.src[this.i++];
    if (d === undefined) throw new Unreadable('trailing backslash');
    if (!/[A-Za-z0-9]/.test(d)) return d;
    this.skipEscapeBody(d);
    return null;
  }
}

/**
 * The two canonical contexts core judges a trigger against, as segments; `N` is the source name.
 * - The call (mcp_gate.rs `context()`), judged before the call runs.
 * - The result (mcp_gate/output.rs `evaluate_output`): the same context with `args` removed and `raw` (the result text,
 *   a JSON string) added. serde_json keeps keys sorted, so `raw` sits between `phase_role` and `scope`.
 * Two facts both rest on: a name is 1-63 of `a-z 0-9 _ -` starting with a letter or digit (`MCP_SERVER_NAME_RE`), so it
 * is never JSON-escaped and both its edges are word characters (a `\b` there reads the same under either name; the
 * characters beside it are marked too, for one that does not); and `annotations` is core's flat `McpAnnotations`
 * (four optional booleans), so it holds no brace. A route test that spells the whole call context fires in the engine,
 * and a cross-repo test holds core's result context to this derivation.
 */
type Seg = string | 'ANY' | 'STR' | 'NOBRACE' | 'BOOL' | 'N';
const MIDDLE: readonly Seg[] = [
  ',"carrier":"', 'STR',
  '","mcp":{"annotations":{', 'NOBRACE', // flat boolean hints
  '},"class":"', 'STR', '","kind":"', 'STR', '","registered":', 'BOOL',
  ',"server":"', 'N', '","subject":"mcp:', 'N', '/', 'STR', '","tool":"', 'STR',
  '"},"mode":"', 'STR', '","phase":"', 'STR', '","phase_role":"', 'STR',
];
const END: readonly Seg[] = [
  '","scope":"', 'STR', '","seat":"', 'STR',
  '","tool":"mcp:', 'N', '/', 'STR', '","work":"mcp:', 'N', '/', 'STR', '","write_posture":"', 'STR', '"}',
];
/** The contexts, exported for the tests that hold them to core's. */
export const CONTEXTS: { readonly call: readonly Seg[]; readonly result: readonly Seg[] } = {
  call: ['{"args":', 'ANY', ...MIDDLE, ...END], // args: any JSON value
  result: ['{"carrier":"', 'STR', ...MIDDLE.slice(2), '","raw":"', 'STR', ...END], // no args; raw: a JSON string
};

/**
 * Every context for `name` (both shapes), as one automaton whose moves on a name character are marked. With `wide`, the
 * character on either side of each name is marked too (a word boundary there reads the name's edge).
 */
function contextNfa(name: string, wide: boolean): Nfa {
  const nfa = new Nfa();
  for (const shape of [CONTEXTS.call, CONTEXTS.result]) spell(nfa, shape, name, wide);
  return nfa;
}

function spell(nfa: Nfa, shape: readonly Seg[], name: string, wide: boolean): void {
  let at = nfa.add();
  const step = (cs: CharSet, mark: boolean): void => {
    const next = nfa.add();
    nfa.moves[at]!.push([cs, next, mark]);
    at = next;
  };
  const loop = (cs: CharSet): void => {
    nfa.moves[at]!.push([cs, at, false]);
  };
  shape.forEach((seg, k) => {
    if (seg === 'N') {
      for (const ch of name) step(charOf(ch, false), true);
      return;
    }
    if (seg === 'ANY') return loop(all());
    if (seg === 'NOBRACE') return loop(except('{', '}'));
    if (seg === 'STR') {
      // A JSON string's content: no bare quote or backslash; a backslash escapes the next character.
      loop(except('"', '\\'));
      const esc = nfa.add();
      nfa.moves[at]!.push([charOf('\\', false), esc, false]);
      nfa.moves[esc]!.push([all(), at, false]);
      return;
    }
    if (seg === 'BOOL') {
      const from = at;
      const join = nfa.add();
      for (const word of ['true', 'false']) {
        at = from;
        for (const ch of word) step(charOf(ch, false), false);
        nfa.eps[at]!.push(join);
      }
      at = join;
      return;
    }
    const before = shape[k - 1] === 'N';
    const after = shape[k + 1] === 'N';
    [...seg].forEach((ch, j) => step(charOf(ch, false), wide && ((before && j === 0) || (after && j === seg.length - 1))));
  });
}

/** Longest trigger read; a longer one names both names. */
const MAX_TRIGGER = 4096;

/** Work (closure steps and product states) spent on one name before it is answered as matched (fail-closed). */
const BUDGET = 2_000_000;

class OverBudget extends Error {}

/** Empty-move closures, computed when first asked for and charged to `spend`. */
function closures(nfa: Nfa, spend: () => void): (from: number) => number[] {
  const memo = new Map<number, number[]>();
  return (from) => {
    const known = memo.get(from);
    if (known !== undefined) return known;
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
      for (const n of nfa.eps[stack.pop()!]!) {
        spend();
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    const out = [...seen];
    memo.set(from, out);
    return out;
  };
}

function touches(re: Nfa, reStart: number, reAccept: number, name: string, wide: boolean): boolean | 'unjudged' {
  const ctx = contextNfa(name, wide);
  let work = 0;
  const spend = (): void => {
    if (++work > BUDGET) throw new OverBudget();
  };
  const reClose = closures(re, spend);
  const ctxClose = closures(ctx, spend);
  // A state: (trigger state, context state, whether a marked character has been consumed).
  const key = (r: number, c: number, t: number): number => (r * ctx.size + c) * 2 + t;
  const seen = new Set<number>();
  const stack: Array<[number, number, number]> = [];
  const push = (r: number, c: number, t: number): void => {
    for (const r2 of reClose(r)) {
      for (const c2 of ctxClose(c)) {
        spend();
        const k = key(r2, c2, t);
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push([r2, c2, t]);
      }
    }
  };
  try {
    // The trigger may start matching anywhere in the context.
    for (let c = 0; c < ctx.size; c++) push(reStart, c, 0);
    while (stack.length > 0) {
      const [r, c, t] = stack.pop()!;
      if (t === 1 && r === reAccept) return true;
      for (const [rs, rn] of re.moves[r]!) {
        for (const [cs, cn, mark] of ctx.moves[c]!) {
          spend();
          if (meets(rs, cs)) push(rn, cn, t === 1 || mark ? 1 : 0);
        }
      }
    }
    return false;
  } catch (e) {
    if (e instanceof OverBudget) return 'unjudged';
    throw e;
  }
}

/** What crew can say about one trigger: the names it can tell apart, and whether it was read and searched in full. */
export interface TriggerJudgement {
  names: string[];
  /** False when the trigger was not read (unsupported syntax, too long) or its search ran out of budget: it names all. */
  judged: boolean;
}

/**
 * (crew#1905) Which of `names` the trigger `contains` can tell apart in an MCP call's or result's context: each name some
 * match of it can consume a character of. Fail-closed: a trigger it cannot read, or too large to search, names all.
 */
export function judgeTrigger(contains: string, names: readonly string[]): TriggerJudgement {
  if (contains === '') return { names: [], judged: true };
  // A trigger longer than any a person writes is not read (fail-closed): reading is linear, but searching is not free.
  if (contains.length > MAX_TRIGGER) return { names: [...names], judged: false };
  const re = new Nfa();
  const reader = new Reader(contains, re);
  let frag: Frag;
  try {
    frag = reader.read();
  } catch (e) {
    if (e instanceof Unreadable) return { names: [...names], judged: false };
    throw e;
  }
  const seen = names.map((n) => touches(re, frag.s, frag.e, n, reader.boundary));
  if (seen.includes('unjudged')) return { names: [...names], judged: false };
  return { names: names.filter((_, k) => seen[k] === true), judged: true };
}

/** The names of {@link judgeTrigger}. */
export function triggerNames(contains: string, names: readonly string[]): string[] {
  return judgeTrigger(contains, names).names;
}
