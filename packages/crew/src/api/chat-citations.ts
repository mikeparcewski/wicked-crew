/**
 * Chat citation verification (crew#561, F-RC1-117 — Wave 1 criterion 2).
 *
 * # The defect
 *
 * A chat seat answers with citations — repo-relative paths, `path:line` refs, `path:symbol` refs
 * and commit SHAs — and the daemon relays that text UNTOUCHED. On the RC1 Phase 6 re-run the
 * opencode seat answered "summarize the last 10 commits across all 9 repos" with 26 SHAs, of which
 * **2 did not exist in any repo**, and three line refs were off by a few lines. Every citation
 * rendered as plain text, so a reader could not tell a real SHA from an invented one — and these
 * are exactly the tokens a reader pastes into `git show`, a PR or a commit message.
 *
 * The daemon is the ONE place that can tell: it already knows the chat's read roots (the scope it
 * handed the seats), and `stat` + `git cat-file -e` are cheap. So it verifies, and says what it
 * found — it never edits the seat's text. Mark, don't rewrite.
 *
 * # What is verified
 *
 * | kind     | citation                          | check |
 * |----------|-----------------------------------|-------|
 * | `path`   | `crew/src/api/routes.ts`          | the file exists under a read root |
 * | `line`   | `routes.ts:2264`, `x.ts:80-90`    | the file exists AND has that many lines; when a symbol is named right before the ref, that the symbol is ON that line — otherwise the line it IS on, as a CORRECTION |
 * | `symbol` | `execute_wrapped.rs:build_worker_command` | the file exists AND contains the symbol |
 * | `sha`    | `6d77153`, 7–40 hex               | `git cat-file -e <sha>^{commit}` in the repo the text names, else in any read root |
 *
 * # Why a false positive is worse than a miss
 *
 * Prose looks like a path (`e.g`, `something.this`) and words look like SHAs. Flagging prose
 * UNVERIFIED would train the reader to ignore the marks, which is worse than not marking. So:
 *
 *  - a bare `name.ext` token with no directory and no `:line`/`:symbol` suffix that resolves
 *    nowhere is DROPPED, not marked — it was probably never a citation;
 *  - a hex run with no digit or no `a-f` letter is not a SHA candidate (`effaced` is a word; the
 *    price is that an all-digit short SHA — ~4% of 7-char prefixes — is not checked);
 *  - a token WITH a separator or a `:line`/`:symbol` suffix IS a citation: unresolvable means
 *    `unverified`, because that shape is not prose.
 *
 * # Bounded, and never in the reply's way
 *
 * The pass runs AFTER the `chatReply` frame is broadcast (`server.ts`), so a reply is never delayed
 * by verification, and it is bounded twice: at most {@link DEFAULT_MAX_ITEMS} citations and
 * {@link DEFAULT_BUDGET_MS} of wall clock. Whatever the budget did not reach is reported
 * `unchecked` — a state of its own, never silently "verified".
 *
 * The verdicts ride `/ws` as ONE `chatCitations` frame per reply, stamped with the same `turn_id`
 * the reply carries, and the studio marks the reply from it (badge + counter). The text on the wire
 * and in the transcript is the seat's own.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { execCapped } from '../core/exec.js';

/** One read root of a chat's scope: the registered repo root and the name the seats were given. */
export interface CitationRoot {
  /** Resolved absolute path of the repo root. */
  absRoot: string;
  /** The repo's display name — the prefix the reply's rewritten paths carry (crew#618). */
  name: string;
}

/** What class of thing a citation is. */
export type ChatCitationKind = 'path' | 'line' | 'symbol' | 'sha';

/**
 * The verdict on one citation.
 *  - `verified` — it exists, exactly as cited;
 *  - `corrected` — the thing exists, but not where the reply said (the real place is `resolved`);
 *  - `unverified` — it does not exist in the chat's scope (the fabricated-SHA case);
 *  - `unchecked` — the bounded pass did not reach it. Not a claim either way.
 */
export type ChatCitationStatus = 'verified' | 'corrected' | 'unverified' | 'unchecked';

/** One citation, as verified. `raw` is the token EXACTLY as it appears in the reply. */
export interface ChatCitationItem {
  raw: string;
  kind: ChatCitationKind;
  status: ChatCitationStatus;
  /** Where the thing actually is, when the status is `corrected` (`routes.ts:2069`, `crew`). */
  resolved?: string;
  /** Why, in one short phrase — the hover text on the studio's badge. */
  note?: string;
}

/** The `/ws` frame: one per verified `chatReply`, stamped with the reply's own `turn_id`. */
export interface ChatCitationsFrame {
  type: 'chatCitations';
  chat: string;
  cliKey: string;
  turn_id?: string;
  /** Counts, so a skin renders the header without walking `items`. */
  verified: number;
  unverifiable: number;
  corrected: number;
  unchecked: number;
  items: ChatCitationItem[];
  project_id?: string;
}

/** At most this many citations are checked per reply; the rest are `unchecked`. */
export const DEFAULT_MAX_ITEMS = 80;
/** Wall-clock budget for one reply's pass, ms. Overrun ⇒ the remainder is `unchecked`. */
export const DEFAULT_BUDGET_MS = 3000;
/** Per-git-call timeout, ms. */
const GIT_TIMEOUT_MS = 2000;
/** A file bigger than this is not read for a line/symbol check (it is a citation, not a corpus). */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** How far back a `line` citation looks for the symbol the sentence names. */
const SYMBOL_CONTEXT_CHARS = 200;

/** The reads the pass needs — injected so the whole thing is testable without a repo or git. */
export interface ChatCitationDeps {
  /** Does this absolute path exist as a FILE? */
  fileExists(abs: string): boolean;
  /** The file's lines, or `null` when it cannot be read (missing, too big, binary). */
  readLines(abs: string): string[] | null;
  /** Repo-relative paths tracked in the root — used to resolve a bare `name.ext` citation. */
  listFiles(absRoot: string): Promise<string[]>;
  /** `git cat-file -e <sha>^{commit}` in the root: does the commit exist there? */
  commitExists(absRoot: string, sha: string): Promise<boolean>;
  now(): number;
}

/** A citation as EXTRACTED — before anything was checked. */
export interface RawCitation {
  raw: string;
  kind: ChatCitationKind;
  /** The path part of a path/line/symbol citation (`crew/src/x.ts`). */
  path?: string;
  /** The first line of a `line` citation. */
  line?: number;
  /** The symbol of a `symbol` citation, or the one the sentence named before a `line` citation. */
  symbol?: string;
  /** The repo a `sha` citation's sentence named, when it named one. */
  repo?: string;
}

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * A file-ish token with an optional `:line`, `:line-line` or `:symbol` suffix.
 *
 * The filename must carry an extension of 2–10 lowercase alphanumerics starting with a letter:
 * that is what keeps `e.g`, `0.7.33` and a sentence's `end.Next` out (one char, digits first,
 * uppercase respectively) while admitting `.ts`, `.rs`, `.md`, `.json`, `.tsx`, `.yml`.
 */
const PATH_RE =
  /(?<![\w/.:-])((?:[\w.-]+\/)*[\w-]+\.[a-z][a-z0-9]{1,9})(?::(\d+(?:-\d+)?|[A-Za-z_]\w*))?(?![\w-])/g;

/** A 7–40 hex run that is a whole token (never part of a path, a version or a colour). */
const SHA_RE = /(?<![\w/.:#-])([0-9a-f]{7,40})(?![\w-])/g;

/**
 * The symbol a line ref is introduced by: the last backticked IDENTIFIER that sits within ~40
 * characters of glue before the ref (`` `acceptancePhaseIds` is `acceptance.ts:80` ``). Deliberately
 * tight — a symbol from further back in the sentence would "correct" the next ref to the wrong line,
 * which is a fabricated correction of its own.
 */
const TRAILING_SYMBOL_RE = /`([A-Za-z_]\w{2,})`([^`]{0,40})$/;

/** The text before a citation, with the ref's own opening backtick removed. */
function symbolNamedBefore(text: string, at: number): string | undefined {
  const before = text.slice(Math.max(0, at - SYMBOL_CONTEXT_CHARS), at).replace(/`$/, '');
  return TRAILING_SYMBOL_RE.exec(before)?.[1];
}

/** Prose that looks like a file but is not: extension-shaped words we never treat as citations. */
const PATH_STOPWORDS = new Set(['e.g', 'i.e', 'vs.']);

/** `wicked-crew` is cited as `crew` as often as by its name: every alias a reply may use. */
export function repoAliases(root: CitationRoot): string[] {
  const out = new Set<string>([root.name]);
  if (root.name.startsWith('wicked-')) out.add(root.name.slice('wicked-'.length));
  const base = root.absRoot.split(/[\\/]/).filter((s) => s.length > 0).pop();
  if (base !== undefined && base.length > 0) {
    out.add(base);
    if (base.startsWith('wicked-')) out.add(base.slice('wicked-'.length));
  }
  return [...out].filter((a) => a.length >= 3).sort((a, b) => b.length - a.length);
}

/** The repo name the text names closest before `at`, when any (`crew \`6d77153\`` → `crew`). */
function repoNamedBefore(text: string, at: number, roots: readonly CitationRoot[]): string | undefined {
  const before = text.slice(Math.max(0, at - SYMBOL_CONTEXT_CHARS), at).toLowerCase();
  let best: { name: string; index: number } | undefined;
  for (const root of roots) {
    for (const alias of repoAliases(root)) {
      const index = before.lastIndexOf(alias.toLowerCase());
      if (index < 0) continue;
      if (best === undefined || index > best.index) best = { name: root.name, index };
    }
  }
  return best?.name;
}

/**
 * Every citation in a reply, in text order, deduplicated by (kind, raw).
 *
 * Pure: no filesystem, no git. `roots` is read only for the repo aliases a SHA's sentence may name.
 */
export function extractCitations(text: string, roots: readonly CitationRoot[]): RawCitation[] {
  const seen = new Set<string>();
  const out: RawCitation[] = [];
  const push = (c: RawCitation): void => {
    const key = `${c.kind}\u0000${c.raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  for (const m of text.matchAll(PATH_RE)) {
    const path = m[1]!;
    const suffix = m[2];
    if (PATH_STOPWORDS.has(path)) continue;
    const raw = m[0]!;
    if (suffix === undefined) {
      push({ raw, kind: 'path', path });
      continue;
    }
    if (/^\d/.test(suffix)) {
      const line = Number.parseInt(suffix.split('-')[0]!, 10);
      const symbol = symbolNamedBefore(text, m.index);
      push({ raw, kind: 'line', path, line, ...(symbol !== undefined ? { symbol } : {}) });
      continue;
    }
    push({ raw, kind: 'symbol', path, symbol: suffix });
  }

  for (const m of text.matchAll(SHA_RE)) {
    const sha = m[1]!;
    // A word, a date or a number is not a SHA: a real one carries both a digit and an a-f letter.
    if (!/\d/.test(sha) || !/[a-f]/.test(sha)) continue;
    const repo = repoNamedBefore(text, m.index, roots);
    push({ raw: sha, kind: 'sha', ...(repo !== undefined ? { repo } : {}) });
  }

  return out.sort((a, b) => text.indexOf(a.raw) - text.indexOf(b.raw));
}

// ── Verification ─────────────────────────────────────────────────────────────

/** The default deps: the real filesystem and the real git. */
export function chatCitationDeps(): ChatCitationDeps {
  return {
    fileExists(abs) {
      try {
        return statSync(abs).isFile();
      } catch {
        return false;
      }
    },
    readLines(abs) {
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
        return readFileSync(abs, 'utf8').split('\n');
      } catch {
        return null;
      }
    },
    async listFiles(absRoot) {
      try {
        const { stdout } = await execCapped('git', ['-C', absRoot, 'ls-files'], {
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        });
        return stdout.split('\n').filter((l) => l.length > 0);
      } catch {
        return [];
      }
    },
    async commitExists(absRoot, sha) {
      try {
        await execCapped('git', ['-C', absRoot, 'cat-file', '-e', `${sha}^{commit}`], {
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        });
        return true;
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
  };
}

export interface VerifyOptions {
  maxItems?: number;
  budgetMs?: number;
}

/** The result of one reply's pass. `items` is in text order; the counts match it. */
export interface ChatCitationsResult {
  verified: number;
  unverifiable: number;
  corrected: number;
  unchecked: number;
  items: ChatCitationItem[];
}

/** Where a path citation resolves under the chat's roots, with the root it came from. */
interface Resolved {
  abs: string;
  root: CitationRoot;
}

/**
 * Resolve a cited path against the read roots. Two spellings, in order:
 *  1. `<repo name>/<rest>` — the shape crew#618's rewrite produces;
 *  2. `<rest>` relative to each root — a reply that dropped the repo prefix.
 * A bare `name.ext` (no separator) falls through to the basename index instead.
 *
 * There is no absolute-path arm, because there can be no absolute citation to resolve: the pass
 * runs on the crew#618-REWRITTEN reply, where every host path under a read root is already
 * repo-relative — and a host path outside every read root is unverifiable by construction.
 */
function resolvePath(path: string, roots: readonly CitationRoot[]): Resolved | undefined {
  const slash = path.indexOf('/');
  if (slash > 0) {
    const head = path.slice(0, slash);
    const rest = path.slice(slash + 1);
    for (const root of roots) {
      if (repoAliases(root).includes(head)) {
        const abs = resolve(join(root.absRoot, rest));
        if (abs.startsWith(root.absRoot)) return { abs, root };
      }
    }
  }
  for (const root of roots) {
    const abs = resolve(join(root.absRoot, path));
    if (abs.startsWith(root.absRoot)) return { abs, root };
  }
  return undefined;
}

/** A word-boundary hit for `symbol`, 1-based; `0` when the file does not contain it. */
function lineOfSymbol(lines: readonly string[], symbol: string): number {
  const re = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i + 1;
  }
  return 0;
}

/**
 * Verify every citation in a reply, bounded. Never throws: a broken root, an unreadable file or a
 * git that is not there is a verdict (`unverified` / `unchecked`), not an error.
 */
export async function verifyCitations(
  text: string,
  roots: readonly CitationRoot[],
  deps: ChatCitationDeps = chatCitationDeps(),
  opts: VerifyOptions = {},
): Promise<ChatCitationsResult> {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = deps.now();
  const candidates = extractCitations(text, roots);
  const items: ChatCitationItem[] = [];
  /** Basename → repo-relative paths, per root; built ONCE and only if a bare name needs it. */
  let basenames: Map<string, Resolved[]> | undefined;

  const indexBasenames = async (): Promise<Map<string, Resolved[]>> => {
    if (basenames !== undefined) return basenames;
    const index = new Map<string, Resolved[]>();
    for (const root of roots) {
      for (const rel of await deps.listFiles(root.absRoot)) {
        const base = rel.split('/').pop();
        if (base === undefined) continue;
        const hits = index.get(base);
        const entry = { abs: join(root.absRoot, rel), root };
        if (hits === undefined) index.set(base, [entry]);
        else hits.push(entry);
      }
    }
    basenames = index;
    return index;
  };

  /** The file a path/line/symbol citation names, or how it failed. */
  const locate = async (
    c: RawCitation,
  ): Promise<{ at: Resolved } | { miss: 'none' | 'ambiguous' | 'prose' }> => {
    const path = c.path!;
    const direct = resolvePath(path, roots);
    if (direct !== undefined && deps.fileExists(direct.abs)) return { at: direct };
    if (!path.includes('/')) {
      const hits = (await indexBasenames()).get(path) ?? [];
      if (hits.length === 1) return { at: hits[0]! };
      if (hits.length > 1) return { miss: 'ambiguous' };
      // A bare name that is in no repo and carries no line/symbol suffix was probably prose.
      return { miss: c.kind === 'path' ? 'prose' : 'none' };
    }
    return { miss: 'none' };
  };

  for (const c of candidates) {
    if (items.length >= maxItems || deps.now() - started > budgetMs) {
      items.push({
        raw: c.raw,
        kind: c.kind,
        status: 'unchecked',
        note: 'the verification budget for this reply ran out before this citation',
      });
      continue;
    }

    if (c.kind === 'sha') {
      const named = c.repo !== undefined ? roots.find((r) => r.name === c.repo) : undefined;
      if (named !== undefined && (await deps.commitExists(named.absRoot, c.raw))) {
        items.push({ raw: c.raw, kind: 'sha', status: 'verified', resolved: named.name });
        continue;
      }
      let elsewhere: CitationRoot | undefined;
      for (const root of roots) {
        if (root === named) continue;
        if (await deps.commitExists(root.absRoot, c.raw)) {
          elsewhere = root;
          break;
        }
      }
      if (elsewhere === undefined) {
        items.push({
          raw: c.raw,
          kind: 'sha',
          status: 'unverified',
          note:
            named !== undefined
              ? `no such commit in ${named.name} — or in any other repo in this chat's scope`
              : "no such commit in any repo in this chat's scope",
        });
      } else if (named === undefined) {
        items.push({ raw: c.raw, kind: 'sha', status: 'verified', resolved: elsewhere.name });
      } else {
        items.push({
          raw: c.raw,
          kind: 'sha',
          status: 'corrected',
          resolved: elsewhere.name,
          note: `the commit is in ${elsewhere.name}, not ${named.name}`,
        });
      }
      continue;
    }

    const found = await locate(c);
    if ('miss' in found) {
      if (found.miss === 'prose') continue; // never a mark on prose
      items.push({
        raw: c.raw,
        kind: c.kind,
        status: 'unverified',
        note:
          found.miss === 'ambiguous'
            ? "several repos in this chat's scope have a file with that name — the citation does not say which"
            : "no such file in this chat's scope",
      });
      continue;
    }

    const at = found.at;
    if (c.kind === 'path') {
      items.push({ raw: c.raw, kind: 'path', status: 'verified', resolved: `${at.root.name}` });
      continue;
    }

    const lines = deps.readLines(at.abs);
    if (lines === null) {
      items.push({
        raw: c.raw,
        kind: c.kind,
        status: 'unchecked',
        note: 'the file is there, but could not be read to check the reference',
      });
      continue;
    }

    if (c.kind === 'symbol') {
      const line = lineOfSymbol(lines, c.symbol!);
      if (line > 0) items.push({ raw: c.raw, kind: 'symbol', status: 'verified', resolved: `${c.path}:${line}` });
      else
        items.push({
          raw: c.raw,
          kind: 'symbol',
          status: 'unverified',
          note: `${at.root.name} has the file, but it does not contain ${c.symbol!}`,
        });
      continue;
    }

    // kind === 'line'
    const line = c.line!;
    if (line < 1 || line > lines.length) {
      items.push({
        raw: c.raw,
        kind: 'line',
        status: 'unverified',
        note: `the file has ${lines.length} lines`,
      });
      continue;
    }
    if (c.symbol === undefined) {
      items.push({ raw: c.raw, kind: 'line', status: 'verified' });
      continue;
    }
    const cited = lines[line - 1]!;
    const re = new RegExp(`\\b${c.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(cited)) {
      items.push({ raw: c.raw, kind: 'line', status: 'verified' });
      continue;
    }
    const actual = lineOfSymbol(lines, c.symbol);
    if (actual > 0) {
      const corrected = c.raw.replace(/:\d+(?:-\d+)?$/, `:${actual}`);
      items.push({
        raw: c.raw,
        kind: 'line',
        status: 'corrected',
        resolved: corrected,
        note: `${c.symbol} is on line ${actual}, not ${line}`,
      });
    } else {
      items.push({
        raw: c.raw,
        kind: 'line',
        status: 'unverified',
        note: `line ${line} does not mention ${c.symbol}, and the file does not either`,
      });
    }
  }

  return {
    verified: items.filter((i) => i.status === 'verified').length,
    unverifiable: items.filter((i) => i.status === 'unverified').length,
    corrected: items.filter((i) => i.status === 'corrected').length,
    unchecked: items.filter((i) => i.status === 'unchecked').length,
    items,
  };
}

/**
 * The `/ws` frame for one reply's verdicts, or `null` when there is nothing to say (no citation
 * survived extraction — a chatty reply with no references marks nothing).
 */
export function citationsFrame(
  reply: { chat: string; cliKey: string; turn_id?: string; project_id?: string },
  result: ChatCitationsResult,
): ChatCitationsFrame | null {
  if (result.items.length === 0) return null;
  return {
    type: 'chatCitations',
    chat: reply.chat,
    cliKey: reply.cliKey,
    ...(reply.turn_id !== undefined ? { turn_id: reply.turn_id } : {}),
    verified: result.verified,
    unverifiable: result.unverifiable,
    corrected: result.corrected,
    unchecked: result.unchecked,
    items: result.items,
    ...(reply.project_id !== undefined ? { project_id: reply.project_id } : {}),
  };
}
