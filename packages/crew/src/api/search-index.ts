/**
 * The global search index (`GET /search`; api-types 0.127.0): an in-memory text store per entity
 * type, scanned per query under a hard time budget.
 *
 * Why not SQLite FTS5: the daemon loads no SQLite library at all (wicked-core#631; enforced by
 * tests/bus-no-write.test.ts). The engine owns every SQLite file in this process, so an FTS index
 * belongs in the engine; until it has one, this store is the daemon's. It is a scan, not an
 * inverted index: each entity keeps a case-folded copy of its title and (capped) body, and a query
 * runs `indexOf` per word over them. That keeps substring and prefix matches exact and the code
 * small, and it is fast enough for an operator's store (a few MB of text is a few ms of scanning).
 *
 * It never holds the event loop: the scan yields every {@link SLICE_MS}, stops when its signal
 * aborts (the client went away: a superseded query), and stops at the time budget with
 * `partial: true` (totals are then lower bounds).
 */

import type { SearchGroup, SearchHit, SearchSpan, SearchTarget, SearchType } from '../core/types.js';

/** Every searchable type, in the order a response lists them. */
export const SEARCH_TYPES: readonly SearchType[] = ['run', 'project', 'repo', 'transcript', 'rule', 'memory', 'doc'];

/** One entity as a source hands it to the index. */
export interface SearchDoc {
  type: SearchType;
  id: string;
  title: string;
  /** Searchable text beyond the title (capped by the index at {@link SearchIndexOptions.maxBodyChars}). */
  body: string;
  /** Unix millis, when known. */
  updatedAt: number | null;
  projectId: string | null;
  status: string | null;
  target: SearchTarget;
  /** Added to the score of every match (negative for archived/retired entities). */
  boost?: number;
}

interface Stored {
  doc: SearchDoc;
  titleFold: string;
  bodyFold: string;
}

export interface SearchIndexOptions {
  /** Body text kept per entity; longer bodies keep their head and tail. Default 64 Ki chars. */
  maxBodyChars?: number;
  /** Total body text kept per type; past it the least recently updated entities leave. Default 8 Mi chars. */
  maxCharsPerType?: number;
}

export interface ParsedQuery {
  /** The trimmed query as asked. */
  text: string;
  /** Case-folded words and phrases; every one must match. */
  terms: string[];
}

export interface QueryOptions {
  types: readonly SearchType[];
  /** Hits per group. */
  limit: number;
  /** Offset into one type's ranked matches (the cursor). */
  offset?: number;
  /** Hard wall-clock budget for the scan, ms. */
  budgetMs: number;
  signal?: AbortSignal;
  /** Clock (tests). */
  now?: () => number;
  /** The recency bonus's "now" (tests), unix millis. */
  at?: number;
}

export interface QueryResult {
  groups: SearchGroup[];
  partial: boolean;
}

/** The longest stretch the scan runs before giving the event loop a turn. */
const SLICE_MS = 4;
/** Query limits (the route answers 400 past them). */
export const MAX_QUERY_CHARS = 256;
export const MIN_QUERY_CHARS = 2;
const MAX_TERMS = 8;
/** Snippet window around the best match. */
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 110;

/**
 * Lower-case without changing length, so offsets in the folded copy are offsets in the original
 * (a few code points lower-case to two units — those keep their case).
 */
export function fold(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = '';
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** Words and `"quoted phrases"`, folded, de-duplicated, at most {@link MAX_TERMS}. */
export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim();
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && terms.length < MAX_TERMS) {
    const t = fold((m[1] ?? m[2] ?? '').trim().replace(/\s+/g, ' ').replace(/^"|"$/g, ''));
    if (t !== '' && !terms.includes(t)) terms.push(t);
  }
  return { text, terms };
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

function atWordStart(s: string, i: number): boolean {
  return i === 0 || !isWordChar(s[i - 1]);
}

/** Occurrences of `t` in `s`, at most `cap`. */
function countOf(s: string, t: string, first: number, cap: number): number {
  let n = 0;
  let i = first;
  while (i !== -1 && n < cap) {
    n += 1;
    i = s.indexOf(t, i + t.length);
  }
  return n;
}

/** The match score of one entity, or 0 when a term is missing (every term must match). */
export function scoreOf(s: Stored, terms: readonly string[], at: number): number {
  let score = 0;
  for (const t of terms) {
    const ti = s.titleFold.indexOf(t);
    const bi = s.bodyFold.indexOf(t);
    if (ti === -1 && bi === -1) return 0;
    if (ti !== -1) {
      score += 10;
      if (atWordStart(s.titleFold, ti)) score += 5;
      if (ti === 0) score += 3;
    }
    if (bi !== -1) {
      score += 2 + Math.log2(1 + countOf(s.bodyFold, t, bi, 8));
      if (atWordStart(s.bodyFold, bi)) score += 1;
    }
  }
  if (terms.length > 1) {
    const phrase = terms.join(' ');
    if (s.titleFold.includes(phrase)) score += 8;
    else if (s.bodyFold.includes(phrase)) score += 3;
  }
  if (s.titleFold.trim() === terms.join(' ')) score += 10;
  if (s.doc.updatedAt !== null) {
    const days = Math.max(0, (at - s.doc.updatedAt) / 86_400_000);
    score += 3 * Math.exp(-days / 14);
  }
  return Math.max(0.01, score + (s.doc.boost ?? 0));
}

/** Every occurrence of every term in `folded`, merged into ascending, non-overlapping spans. */
export function spansOf(folded: string, terms: readonly string[]): SearchSpan[] {
  const raw: SearchSpan[] = [];
  for (const t of terms) {
    let i = folded.indexOf(t);
    while (i !== -1 && raw.length < 64) {
      raw.push([i, i + t.length]);
      i = folded.indexOf(t, i + t.length);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const out: SearchSpan[] = [];
  for (const sp of raw) {
    const last = out[out.length - 1];
    if (last !== undefined && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else out.push([sp[0], sp[1]]);
  }
  return out;
}

/**
 * The window of the body that shows the match best: around the term occurrence whose window holds
 * the most distinct terms. Whitespace is collapsed in the window (folded and original alike, so
 * spans stay aligned); `…` marks a cut.
 */
export function snippetOf(s: Stored, terms: readonly string[]): { snippet: string | null; spans: SearchSpan[] } {
  const body = s.doc.body;
  if (body.trim() === '') return { snippet: null, spans: [] };
  let best = -1;
  let bestHeld = 0;
  for (const t of terms) {
    const i = s.bodyFold.indexOf(t);
    if (i === -1) continue;
    const from = Math.max(0, i - SNIPPET_BEFORE);
    const win = s.bodyFold.slice(from, i + SNIPPET_AFTER);
    const held = terms.filter((x) => win.includes(x)).length;
    if (held > bestHeld) { best = i; bestHeld = held; }
  }
  const at = best === -1 ? 0 : best;
  // Start at a word boundary inside the lead-in, so the window never opens mid-word.
  let start = Math.max(0, at - SNIPPET_BEFORE);
  if (start > 0) {
    const sp = body.slice(start, at).search(/\s/);
    if (sp !== -1) start += sp + 1;
  }
  const end = Math.min(body.length, at + SNIPPET_AFTER);
  const collapse = (x: string): string => x.replace(/\s+/g, ' ');
  const lead = start > 0 ? '…' : '';
  const tail = end < body.length ? '…' : '';
  const text = `${lead}${collapse(body.slice(start, end)).trim()}${tail}`;
  const folded = `${lead}${collapse(s.bodyFold.slice(start, end)).trim()}${tail}`;
  return { snippet: text, spans: best === -1 ? [] : spansOf(folded, terms) };
}

/** Head and tail of a long text, joined by an elision line. */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (max - head))}`;
}

const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

export class SearchIndex {
  private readonly byType = new Map<SearchType, Map<string, Stored>>();
  private readonly charsByType = new Map<SearchType, number>();
  private readonly maxBodyChars: number;
  private readonly maxCharsPerType: number;

  constructor(opts: SearchIndexOptions = {}) {
    this.maxBodyChars = opts.maxBodyChars ?? 64 * 1024;
    this.maxCharsPerType = opts.maxCharsPerType ?? 8 * 1024 * 1024;
    for (const t of SEARCH_TYPES) {
      this.byType.set(t, new Map());
      this.charsByType.set(t, 0);
    }
  }

  private mapOf(type: SearchType): Map<string, Stored> {
    return this.byType.get(type)!;
  }

  /** Entities of `type` held. */
  count(type: SearchType): number {
    return this.mapOf(type).size;
  }

  /** Body characters of `type` held (the budget {@link SearchIndexOptions.maxCharsPerType} bounds). */
  chars(type: SearchType): number {
    return this.charsByType.get(type) ?? 0;
  }

  has(type: SearchType, id: string): boolean {
    return this.mapOf(type).has(id);
  }

  ids(type: SearchType): string[] {
    return [...this.mapOf(type).keys()];
  }

  /** Add or replace one entity. */
  upsert(input: SearchDoc): void {
    const doc = input.body.length > this.maxBodyChars ? { ...input, body: capText(input.body, this.maxBodyChars) } : input;
    const map = this.mapOf(doc.type);
    const prev = map.get(doc.id);
    if (prev !== undefined && prev.doc.title === doc.title && prev.doc.body === doc.body) {
      // Unchanged text: keep the folded copies, take the new facts (status, project, time).
      prev.doc = doc;
      return;
    }
    this.remove(doc.type, doc.id);
    map.set(doc.id, { doc, titleFold: fold(doc.title), bodyFold: fold(doc.body) });
    this.charsByType.set(doc.type, this.chars(doc.type) + doc.body.length);
    this.evict(doc.type);
  }

  remove(type: SearchType, id: string): void {
    const map = this.mapOf(type);
    const prev = map.get(id);
    if (prev === undefined) return;
    map.delete(id);
    this.charsByType.set(type, this.chars(type) - prev.doc.body.length);
  }

  /** Remove every entity of `type` whose id `drop` accepts. */
  removeWhere(type: SearchType, drop: (id: string) => boolean): void {
    for (const id of this.ids(type)) if (drop(id)) this.remove(type, id);
  }

  /** A full re-read of a source: upsert what it holds, drop what it no longer does. */
  replaceType(type: SearchType, docs: readonly SearchDoc[]): void {
    const keep = new Set(docs.map((d) => d.id));
    this.removeWhere(type, (id) => !keep.has(id));
    for (const d of docs) this.upsert(d);
  }

  /** Over budget: the least recently updated entities leave first (undated ones before dated). */
  private evict(type: SearchType): void {
    if (this.chars(type) <= this.maxCharsPerType) return;
    const byAge = [...this.mapOf(type).values()].sort((a, b) => (a.doc.updatedAt ?? -1) - (b.doc.updatedAt ?? -1));
    for (const s of byAge) {
      if (this.chars(type) <= this.maxCharsPerType) break;
      this.remove(type, s.doc.id);
    }
  }

  /**
   * Scan `types` for `q`. Yields every {@link SLICE_MS}; throws the signal's reason when it aborts;
   * stops at `budgetMs` with `partial: true`. Groups with no match are left out.
   */
  async query(q: ParsedQuery, opts: QueryOptions): Promise<QueryResult> {
    const now = opts.now ?? (() => performance.now());
    const at = opts.at ?? Date.now();
    const started = now();
    let slice = started;
    let partial = false;
    const groups: SearchGroup[] = [];
    outer: for (const type of SEARCH_TYPES) {
      if (!opts.types.includes(type)) continue;
      const matches: Array<{ s: Stored; score: number }> = [];
      // A snapshot: a write landing while the scan yields never changes what this scan walks.
      const entries = [...this.mapOf(type).values()];
      for (let i = 0; i < entries.length; i += 1) {
        if ((i & 31) === 0) {
          const t = now();
          if (t - started >= opts.budgetMs) { partial = true; this.pushGroup(groups, type, matches, q, opts); break outer; }
          if (t - slice >= SLICE_MS) {
            await yieldTurn();
            opts.signal?.throwIfAborted();
            slice = now();
          }
        }
        const s = entries[i]!;
        const score = scoreOf(s, q.terms, at);
        if (score > 0) matches.push({ s, score });
      }
      this.pushGroup(groups, type, matches, q, opts);
    }
    opts.signal?.throwIfAborted();
    return { groups, partial };
  }

  private pushGroup(groups: SearchGroup[], type: SearchType, matches: Array<{ s: Stored; score: number }>, q: ParsedQuery, opts: QueryOptions): void {
    if (matches.length === 0) return;
    matches.sort((a, b) => b.score - a.score || (b.s.doc.updatedAt ?? 0) - (a.s.doc.updatedAt ?? 0) || a.s.doc.id.localeCompare(b.s.doc.id));
    const offset = opts.offset ?? 0;
    const page = matches.slice(offset, offset + opts.limit);
    const hits: SearchHit[] = page.map(({ s, score }) => {
      const { snippet, spans } = snippetOf(s, q.terms);
      return {
        type,
        id: s.doc.id,
        title: s.doc.title,
        title_spans: spansOf(s.titleFold, q.terms),
        snippet,
        snippet_spans: spans,
        score: Math.round(score * 100) / 100,
        updated_at: s.doc.updatedAt,
        project_id: s.doc.projectId,
        status: s.doc.status,
        target: s.doc.target,
      };
    });
    const next = offset + page.length;
    groups.push({ type, total: matches.length, hits, next_cursor: next < matches.length ? String(next) : null });
  }
}
