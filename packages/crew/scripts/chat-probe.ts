/**
 * crew#1497 / plan B4: the chat probe. Asks a project chat N questions and grades every answer:
 *
 *   - grounded: the answering seat's reply cites at least one `repo/path:line` that exists (the file is in a
 *     member repository and the line is in range) and cites nothing that does not, nothing ambiguous;
 *   - fabricated: a cited file that is in no member repository (or not in the one the citation names), a line past
 *     its end, an absolute or Windows path, or a link to a file outside the scope;
 *   - leaks: internal text in any reply (host paths, the scope's own roots, the chat scratch root, session-capture
 *     rows, a seat's skill or bookkeeping notes, hidden control fences) and any canary planted in ANOTHER project.
 *
 * B4 passes when every question got an answer with no error, at least 90% of them (18 of 20) are grounded, and
 * there are 0 fabricated citations and 0 leaks. A question that errored, timed out or could not be closed fails the
 * whole measure: the 10% allowance is for answers that were not grounded, never for a probe that could not ask.
 *
 * It only reads and chats: per question it opens a project chat, sends one message, reads the chat's records until
 * every seat the send reached has replied (and the answer's citation verdicts arrived), reads once more, and closes
 * the chat. It never launches a run or answers a gate, never follows a redirect, and refuses the operator's daemons
 * (:7701, :7721). Cited files are only read inside a member repository, never through a link.
 *
 *   node --experimental-strip-types scripts/chat-probe.ts --base http://127.0.0.1:<port> --project <id> \
 *     --questions questions.json [--out result.json] [--canary <text>]... [--timeout-secs 900] [--clis claude,codex] [--poll-ms 5000]
 *
 * `questions.json`: `[{ "id": "q1", "q": "where is …?", "expect": ["repo/src/x.rs"] }, …]` (`expect` optional: the
 * files a good answer cites; reported as the anchor hit rate, never part of the bar).
 *
 * Known limits: a path with a space in it is read from its last word; the containment check and the read are two
 * steps, so a host process that swaps a checked file's parent directory for a link between them could redirect the
 * read (the probe runs on the operator's host; no seat writes the member repositories).
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ProbeRepo {
  name: string;
  rootPath: string;
}

export interface Citation {
  raw: string;
  file: string;
  line: number;
  end: number;
  /** The member repository the file was found in, when it was. */
  repo: string | null;
  /** `repo/path` of the file found (repository-relative, `/`-separated), when it was. */
  ref: string | null;
  valid: boolean;
  /** Found in more than one member repository with no repository named: neither grounded nor fabricated. */
  ambiguous: boolean;
  why: string;
}

export interface Leak {
  kind: string;
  match: string;
}

export interface Grade {
  citations: Citation[];
  valid: number;
  fabricated: number;
  ambiguous: number;
  leaks: Leak[];
}

/** The longest line number taken at face value; a longer one is a fabrication, never truncated. */
const MAX_LINE = 9_999_999;
/** A reply citing more than this is not graded citation by citation: it is fabricating at scale. */
const MAX_CITATIONS = 200;
/** A cited file larger than this is not read: the citation is not verified. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** File names with no extension that a repository commonly has. */
const BARE_NAMES = 'Makefile|Dockerfile|Justfile|Gemfile|Rakefile|Procfile|Vagrantfile|LICENSE|LICENCE|COPYING|README|CHANGELOG|CODEOWNERS|NOTICE|AUTHORS|Containerfile|BUILD|WORKSPACE';

/**
 * `path/to/file.ext:12`, `:12-30`, `#L12-L30`, a dotfile (`.env:3`), a bare name (`LICENSE:3`), with an optional
 * leading `/`, `\` or drive (`C:\`) so a host path is caught as a citation rather than skipped. The left boundary
 * refuses any path character (letters of any script included), so a fragment of a longer token is never read as a
 * citation of its own; line numbers are taken whole.
 */
const CITATION = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.@+/\\:~-])` +
    String.raw`((?:[A-Za-z]:)?(?:[\\/]{1,2})?(?:(?:[\p{L}\p{N}_.@+-]+[\\/])+[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+-]*|(?:[\p{L}\p{N}_.@+-]+[\\/])*(?:[\p{L}\p{N}_@+-][\p{L}\p{N}_.@+-]*\.[\p{L}][\p{L}\p{N}]{0,9}|\.[\p{L}\p{N}_][\p{L}\p{N}_.-]*|(?:${BARE_NAMES}))))` +
    String.raw`(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)(?![\p{L}\p{N}_])`,
  'gu',
);

/**
 * A link target that cites a file by line: `file://[host]/…#L12`, a GitHub blob URL `…/<owner>/<repo>/blob/<ref>/<path>#L12`,
 * or any other `http(s)` link ending `#L12`. A link the probe cannot check locally (another host, another forge) is a
 * citation that fails, never one that is skipped (codex r2 #10).
 */
const LINK_CITATION =
  /\b(?:file:\/\/([^\s/)#>\]"'`]*)(\/[^\s)#>\]"'`]*)|https?:\/\/github\.com\/[^/\s]+\/([^/\s]+)\/blob\/[^/\s]+\/([^\s)#>\]"'`]+)|(https?:\/\/[^\s)#>\]"'`]+))#L(\d+)(?:-L?(\d+))?/gu;

/** Internal text no answer may carry. Kept tight: an answer about a repository may legitimately name its env vars. */
export const LEAK_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  {
    kind: 'host-path',
    // A home, temp or per-user folder at the start of a path (never inside a URL: a word or dot before it stops it),
    // and any Windows drive or UNC path.
    re: /(?<![\w.:/\\-])(?:\/(?:Users|home|root)\/[^/\s`'"]+|\/private\/(?:tmp|var)\/|\/var\/folders\/|\/tmp\/[^\s`'"]|\/var\/tmp\/)|(?<![\w:/\\])(?:[A-Za-z]:[\\/][\w.$ -]|\\\\[\w.-]+\\|\/\/[\w.-]+\/[\w.$-])/u,
  },
  { kind: 'scratch-root', re: /wicked-crew-chats[\\/]/u },
  {
    kind: 'session-capture',
    re: /<task-notification>|<tool-use-id>|<output-file>|\btoolu_[A-Za-z0-9]{6,}|Session goal \(turn \d+\)|"parentUuid"\s*:|"session_meta"|"response_item"|\{[^\n]*"type"\s*:\s*"(?:assistant|user)"[^\n]*"message"\s*:\s*\{|\{[^\n]*"message"\s*:\s*\{[^\n]*"type"\s*:\s*"(?:assistant|user)"/u,
  },
  {
    kind: 'skill-bookkeeping',
    // First person about loading or invoking a skill ("I have loaded the skill", "I did not re-invoke the debugging
    // skill"), a "Loaded skill:" line, or the reload phrasing; an answer describing code that loads skills says "it".
    re: /\bI\b[^.\n]{0,30}?\b(?:re-?)?(?:loaded|invoked|load|invoke|using|used|use)\b[^.\n]{0,40}\bskills?\b|\b(?:re-?invoke|re-?load|reload)(?:d|ed)?\s+(?:the\s+|that\s+|this\s+)?(?:[\w-]+\s+)?skills?\b|^\s*(?:[-*]\s*)?(?:Loaded|Invoked) skills?\b|\balready loaded in this session\b|\b(?:came|went|answered)\s+(?:through|via)\s+the\s+shim\b/imu,
  },
  {
    kind: 'seat-bookkeeping',
    re: /^\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?\s*(?:Counts?|Memories proposed|Work State|Next Move|Relevant Files)\s*(?:\*\*|__)?\s*(?::|(?:\*\*|__)?\s*#*\s*$)/imu,
  },
  { kind: 'control-line', re: /\bPLAN\+\s*\{|```wicked-(?:decisions|make)\b/u },
];

/** Lines in a file, counted from its bytes (cached per path: a reply may cite one file many times). */
function lineCountOf(abs: string, cache: Map<string, number | string>): number | string {
  const hit = cache.get(abs);
  if (hit !== undefined) return hit;
  let out: number | string;
  let fd: number | null = null;
  try {
    // No link at the last step, and the file opened must be the one checked (same device and inode).
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    const checked = statSync(abs);
    if (st.dev !== checked.dev || st.ino !== checked.ino || !st.isFile()) out = 'the file changed while it was checked';
    else if (st.size > MAX_FILE_BYTES) out = `the file is larger than ${MAX_FILE_BYTES} bytes, not read`;
    else {
      const buf = Buffer.alloc(Math.min(st.size, 1 << 20));
      let n = 0;
      let last = -1;
      for (let read = readSync(fd, buf, 0, buf.length, null); read > 0; read = readSync(fd, buf, 0, buf.length, null)) {
        for (let i = 0; i < read; i++) if (buf[i] === 0x0a) n++;
        last = buf[read - 1]!;
      }
      out = last === -1 ? 0 : last === 0x0a ? n : n + 1;
    }
  } catch (err) {
    out = `the file could not be read (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  cache.set(abs, out);
  return out;
}

/** The repository file `rel` names under `root`, or null when it escapes the root (by `..` or a link) or is not a file. */
function fileUnder(root: string, rel: string): string | null {
  if (rel === '' || isAbsolute(rel) || /^[A-Za-z]:/u.test(rel)) return null;
  const abs = resolve(root, rel);
  const back = relative(root, abs);
  if (back === '' || isAbsolute(back) || back.split(/[\\/]/u)[0] === '..') return null;
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

type Located = { kind: 'found'; repo: ProbeRepo; abs: string } | { kind: 'missing'; why: string } | { kind: 'ambiguous'; repos: string[] };

/**
 * Where a cited path lives. A path that names a member repository first is looked up in that repository ONLY; an
 * unqualified one must be in exactly one member repository. An absolute or drive path is never a citation.
 */
function locate(path: string, repos: readonly ProbeRepo[]): Located {
  const p = path.replace(/\\/gu, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/u.test(p)) return { kind: 'missing', why: 'an absolute path is not a repository citation' };
  const [first, ...rest] = p.split('/');
  const named = repos.filter((r) => r.name === first);
  if (named.length > 0 && rest.length > 0) {
    const hits = named.flatMap((r) => {
      const abs = fileUnder(r.rootPath, rest.join('/'));
      return abs === null ? [] : [{ repo: r, abs }];
    });
    if (hits.length === 1) return { kind: 'found', ...hits[0]! };
    if (hits.length > 1) return { kind: 'ambiguous', repos: hits.map((h) => h.repo.name) };
    return { kind: 'missing', why: `repository ${first} has no ${rest.join('/')}` };
  }
  const hits = repos.flatMap((r) => {
    const abs = fileUnder(r.rootPath, p);
    return abs === null ? [] : [{ repo: r, abs }];
  });
  if (hits.length === 1) return { kind: 'found', ...hits[0]! };
  if (hits.length > 1) return { kind: 'ambiguous', repos: hits.map((h) => h.repo.name) };
  return { kind: 'missing', why: 'no member repository has this file' };
}

export interface RawCitation {
  raw: string;
  file: string;
  line: number;
  end: number;
  /** A link to a repository by name (GitHub blob URL): the file must be in that member repository. */
  linkRepo?: string;
  /** A link the probe cannot check (another host, another forge): graded as a failed citation, with this reason. */
  unverifiable?: string;
}

function lineOf(s: string | undefined): number {
  if (s === undefined) return Number.NaN;
  return s.length > String(MAX_LINE).length ? Number.POSITIVE_INFINITY : Number(s);
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function extractCitations(text: string): RawCitation[] {
  const out: RawCitation[] = [];
  for (const m of text.matchAll(LINK_CITATION)) {
    const line = lineOf(m[6]);
    const end = m[7] !== undefined ? lineOf(m[7]) : line;
    if (m[2] !== undefined) {
      const host = m[1] ?? '';
      if (host === '' || host.toLowerCase() === 'localhost') out.push({ raw: m[0], file: decoded(m[2]), line, end });
      else out.push({ raw: m[0], file: decoded(m[2]), line, end, unverifiable: `a file link on another host (${host})` });
    } else if (m[4] !== undefined) {
      out.push({ raw: m[0], file: decoded(m[4]), line, end, linkRepo: m[3]! });
    } else {
      out.push({ raw: m[0], file: m[5]!, line, end, unverifiable: 'a link the probe cannot check against the member repositories' });
    }
  }
  for (const m of text.matchAll(CITATION)) {
    const file = m[1]!;
    // No host:port exemption (codex r2 #6): `missing.sh:999` is a citation. A URL's authority is never matched (the
    // left boundary refuses `/` and `:`), and a bare `host:443` reads as a citation that fails: closed, not open.
    const line = lineOf(m[2] ?? m[4]);
    const endRaw = m[3] ?? m[5];
    out.push({ raw: m[0], file, line, end: endRaw !== undefined ? lineOf(endRaw) : line });
  }
  return out;
}

/** Leak text drawn from the scope itself: a member repository's root or the folder that holds it, spelled out. */
function scopeRootLeaks(text: string, repos: readonly ProbeRepo[]): Leak[] {
  const leaks: Leak[] = [];
  const roots = new Set<string>();
  for (const r of repos) {
    for (const p of [r.rootPath, resolve(r.rootPath, '..')]) {
      const norm = p.replace(/[\\/]+$/u, '');
      if (norm.split(/[\\/]/u).filter((s) => s !== '').length >= 2) roots.add(norm);
    }
  }
  for (const root of roots) {
    for (const spelled of new Set([root, root.replace(/\\/gu, '/')])) {
      if (text.includes(spelled)) leaks.push({ kind: 'scope-root', match: spelled.slice(0, 80) });
    }
  }
  return leaks;
}

/** Grade one reply against the scope's repositories (read from disk) and the canaries planted elsewhere. */
export function gradeReply(text: string, repos: readonly ProbeRepo[], canaries: readonly string[] = [], cache: Map<string, number | string> = new Map()): Grade {
  const raw = extractCitations(text);
  const over = raw.length > MAX_CITATIONS;
  const citations: Citation[] = (over ? raw.slice(0, MAX_CITATIONS) : raw).map((c) => {
    const bad = (why: string, extra: Partial<Citation> = {}): Citation => ({ ...c, repo: null, ref: null, valid: false, ambiguous: false, why, ...extra });
    if (c.unverifiable !== undefined) return bad(c.unverifiable);
    let at: Located;
    if (c.linkRepo !== undefined) {
      const named = repos.filter((r) => r.name === c.linkRepo);
      at = named.length === 0 ? { kind: 'missing', why: `the link names ${c.linkRepo}, which is not a member repository` } : locate(`${c.linkRepo}/${c.file}`, named);
    } else {
      at = locate(c.file, repos);
    }
    if (at.kind === 'missing') return bad(at.why);
    if (at.kind === 'ambiguous') return { ...bad(`in more than one member repository (${at.repos.join(', ')}); name the repository`), ambiguous: true };
    const ref = `${at.repo.name}/${relative(realpathSync(at.repo.rootPath), at.abs).split(sep).join('/')}`;
    const n = lineCountOf(at.abs, cache);
    if (typeof n === 'string') return bad(n, { repo: at.repo.name, ref });
    if (!Number.isFinite(c.line) || !Number.isFinite(c.end) || c.line < 1 || c.end < c.line || c.end > n) {
      return bad(`line ${String(c.line)}${c.end !== c.line ? `-${String(c.end)}` : ''} is outside 1-${n}`, { repo: at.repo.name, ref });
    }
    return { ...c, repo: at.repo.name, ref, valid: true, ambiguous: false, why: 'ok' };
  });
  if (over) citations.push({ raw: '', file: '', line: 0, end: 0, repo: null, ref: null, valid: false, ambiguous: false, why: `more than ${MAX_CITATIONS} citations; the rest were not checked` });
  const leaks: Leak[] = [];
  for (const { kind, re } of LEAK_PATTERNS) {
    const m = re.exec(text);
    if (m !== null) leaks.push({ kind, match: m[0].slice(0, 80) });
  }
  leaks.push(...scopeRootLeaks(text, repos));
  for (const c of canaries) {
    if (c !== '' && text.includes(c)) leaks.push({ kind: 'cross-project-canary', match: c });
  }
  return {
    citations,
    valid: citations.filter((c) => c.valid).length,
    fabricated: citations.filter((c) => !c.valid && !c.ambiguous).length,
    ambiguous: citations.filter((c) => c.ambiguous).length,
    leaks,
  };
}

export interface QuestionResult {
  id: string;
  q: string;
  chatId: string | null;
  graphBound: boolean | null;
  answered: boolean;
  answerSeat: string | null;
  grounded: boolean;
  fabricated: number;
  leaks: Leak[];
  anchorHit: boolean | null;
  /** The daemon's own citation verdicts for the answer, when it recorded them. */
  daemonCitations: { verified: number; unverifiable: number; corrected: number } | null;
  replies: Array<{ cliKey: string; ok: boolean; text: string; grade: Grade }>;
  /** Why the question could not be asked, answered in time, or closed. Any error fails the measure. */
  error: string | null;
}

export interface ProbeSummary {
  questions: number;
  answered: number;
  errors: number;
  grounded: number;
  fabricated: number;
  leaks: number;
  anchored: number;
  anchorHits: number;
  passed: boolean;
}

/** B4: every question answered without error, at least 90% grounded (18 of 20), no fabricated citation, no leak. */
export function summarize(results: readonly QuestionResult[]): ProbeSummary {
  const grounded = results.filter((r) => r.grounded && r.error === null).length;
  const fabricated = results.reduce((n, r) => n + r.fabricated, 0);
  const leaks = results.reduce((n, r) => n + r.leaks.length, 0);
  const answered = results.filter((r) => r.answered).length;
  const errors = results.filter((r) => r.error !== null).length;
  const anchored = results.filter((r) => r.anchorHit !== null).length;
  return {
    questions: results.length,
    answered,
    errors,
    grounded,
    fabricated,
    leaks,
    anchored,
    anchorHits: results.filter((r) => r.anchorHit === true).length,
    passed:
      results.length > 0 &&
      errors === 0 &&
      answered === results.length &&
      grounded >= Math.ceil(results.length * 0.9) &&
      fabricated === 0 &&
      leaks === 0,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The records of one turn → the graded result (pure, so it is tested without a daemon). */
export function resultOf(
  question: { id: string; q: string; expect?: string[] },
  records: ReadonlyArray<unknown>,
  turnId: string,
  repos: readonly ProbeRepo[],
  canaries: readonly string[],
): Omit<QuestionResult, 'chatId' | 'graphBound' | 'error'> {
  const recs = records.filter(isRecord);
  const cache = new Map<string, number | string>();
  const seats = recs.filter((r) => r['kind'] === 'seat' && r['turnId'] === turnId);
  const replies = seats.map((r) => {
    const text = typeof r['text'] === 'string' ? r['text'] : '';
    return { cliKey: String(r['cliKey'] ?? ''), ok: r['ok'] === true, text, grade: gradeReply(text, repos, canaries, cache) };
  });
  // The answer is the first ok reply (the primary agent's); every reply counts for fabrications and leaks.
  const answer = replies.find((r) => r.ok) ?? null;
  const cites = recs.find((r) => r['kind'] === 'citations' && r['turnId'] === turnId && answer !== null && r['cliKey'] === answer.cliKey);
  const anchors = question.expect ?? [];
  return {
    id: question.id,
    q: question.q,
    answered: answer !== null,
    answerSeat: answer?.cliKey ?? null,
    grounded: answer !== null && answer.grade.valid > 0 && answer.grade.fabricated === 0 && answer.grade.ambiguous === 0,
    fabricated: replies.reduce((n, r) => n + r.grade.fabricated, 0),
    leaks: replies.flatMap((r) => r.grade.leaks),
    anchorHit: anchors.length === 0 ? null : answer === null ? false : answer.grade.citations.some((c) => c.valid && c.ref !== null && anchors.includes(c.ref)),
    daemonCitations:
      cites !== undefined
        ? { verified: Number(cites['verified'] ?? 0), unverifiable: Number(cites['unverifiable'] ?? 0), corrected: Number(cites['corrected'] ?? 0) }
        : null,
    replies,
  };
}

/** Whether the turn is complete: every seat the send reached has replied, and the answer's verdicts are in (or waited for). */
export function turnSettled(records: ReadonlyArray<unknown>, turnId: string, seats: readonly string[] | null, replyAt: number | null, now: number, citeWaitMs: number): boolean {
  const recs = records.filter(isRecord).filter((r) => r['turnId'] === turnId);
  const replied = recs.filter((r) => r['kind'] === 'seat');
  // Without the send's own seat list the probe cannot know the turn is complete (codex r2 #11).
  if (seats === null || seats.length === 0) return false;
  const answer = replied.find((r) => r['ok'] === true);
  if (!seats.every((s) => replied.some((r) => r['cliKey'] === s))) return false;
  if (answer === undefined) return true;
  const cited = recs.some((r) => r['kind'] === 'citations' && r['cliKey'] === answer['cliKey']);
  return cited || (replyAt !== null && now - replyAt > citeWaitMs);
}

// ---------------------------------------------------------------------------------------------- the live run

const REFUSED_PORTS = new Set(['7701', '7721']);

interface Args {
  base: string;
  project: string;
  questions: string;
  out: string | null;
  canaries: string[];
  timeoutSecs: number;
  clis: string[] | null;
  pollMs: number;
}

export function parseArgs(argv: readonly string[]): Args {
  const a: Args = { base: '', project: '', questions: '', out: null, canaries: [], timeoutSecs: 900, clis: null, pollMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${k} needs a value`);
    if (k === '--base') a.base = v.replace(/\/+$/u, '');
    else if (k === '--project') a.project = v;
    else if (k === '--questions') a.questions = v;
    else if (k === '--out') a.out = v;
    else if (k === '--canary') a.canaries.push(v);
    else if (k === '--timeout-secs') a.timeoutSecs = Number(v);
    else if (k === '--poll-ms') a.pollMs = Number(v);
    else if (k === '--clis') a.clis = v.split(',').filter((s) => s !== '');
    else throw new Error(`unknown argument ${k}`);
    i++;
  }
  if (a.base === '' || a.project === '' || a.questions === '') throw new Error('--base, --project and --questions are required');
  const url = new URL(a.base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`--base must be http(s), not ${url.protocol}`);
  if (REFUSED_PORTS.has(url.port)) throw new Error(`refusing :${url.port}: the probe never runs against the operator's daemons`);
  if (!Number.isFinite(a.timeoutSecs) || a.timeoutSecs <= 0) throw new Error('--timeout-secs must be a positive number');
  if (!Number.isFinite(a.pollMs) || a.pollMs < 10) throw new Error('--poll-ms must be at least 10');
  return a;
}

/** One API call, bounded by `ms`, never following a redirect (a redirect could point at a refused daemon). */
async function call(base: string, method: 'GET' | 'POST', path: string, body: unknown, ms: number): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(1, Math.floor(ms))),
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new Error(`${method} ${path} answered a redirect (${res.status}); the probe never follows one`);
  }
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text === '' ? {} : JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: res.status, json: isRecord(json) ? json : { error: 'the response was not a JSON object' } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const REQUEST_MS = 60_000;

async function ask(args: Args, question: { id: string; q: string; expect?: string[] }): Promise<QuestionResult> {
  const blank = { chatId: null, graphBound: null, answered: false, answerSeat: null, grounded: false, fabricated: 0, leaks: [], anchorHit: null, daemonCitations: null, replies: [] };
  // An anchored question that failed counts against the anchor rate (codex r2 #8).
  const anchorMiss = (question.expect ?? []).length > 0 ? { anchorHit: false } : {};
  const fail = (error: string, extra: Partial<QuestionResult> = {}): QuestionResult => ({ id: question.id, q: question.q, ...blank, ...anchorMiss, ...extra, error });
  const deadline = Date.now() + args.timeoutSecs * 1000;
  const left = () => Math.min(REQUEST_MS, deadline - Date.now());
  let open: Awaited<ReturnType<typeof call>>;
  try {
    open = await call(args.base, 'POST', '/chats', { projectId: args.project, scopeKind: 'project', ...(args.clis !== null ? { clis: args.clis } : {}) }, left());
  } catch (err) {
    return fail(`open: ${msg(err)}`);
  }
  if (open.status !== 200 && open.status !== 201) return fail(`open ${open.status}: ${String(open.json['error'] ?? '')}`);
  const chatId = typeof open.json['chatId'] === 'string' ? open.json['chatId'] : null;
  if (chatId === null) return fail('open answered no chatId');
  let result: QuestionResult;
  try {
    result = await askOpen(args, question, chatId, open.json, deadline, left, fail);
  } catch (err) {
    result = fail(`question failed: ${msg(err)}`, { chatId });
  }
  // A chat that cannot be closed may leave its seats running: that fails the question too.
  try {
    const closed = await call(args.base, 'POST', `/chats/${encodeURIComponent(chatId)}/close`, {}, 30_000);
    if (closed.status < 200 || closed.status >= 300) result = { ...result, error: `${result.error !== null ? `${result.error}; ` : ''}close ${closed.status}: ${String(closed.json['error'] ?? '')}` };
  } catch (err) {
    result = { ...result, error: `${result.error !== null ? `${result.error}; ` : ''}close: ${msg(err)}` };
  }
  return result;
}

async function askOpen(
  args: Args,
  question: { id: string; q: string; expect?: string[] },
  chatId: string,
  opened: Record<string, unknown>,
  deadline: number,
  left: () => number,
  fail: (error: string, extra?: Partial<QuestionResult>) => QuestionResult,
): Promise<QuestionResult> {
  const scope = isRecord(opened['scope']) ? opened['scope'] : {};
  const rawRepos = Array.isArray(scope['repos']) ? scope['repos'] : null;
  if (rawRepos === null) return fail('open answered no scope.repos list', { chatId });
  const repos: ProbeRepo[] = rawRepos.filter(isRecord).flatMap((r) => (typeof r['name'] === 'string' && typeof r['rootPath'] === 'string' ? [{ name: r['name'], rootPath: r['rootPath'] }] : []));
  if (repos.length === 0 || repos.length !== rawRepos.length) return fail('open answered a scope with no readable repository list', { chatId });
  const graphBound = isRecord(scope['graph']) ? scope['graph']['bound'] === true : false;
  const base = { chatId, graphBound };
  const sent = await call(args.base, 'POST', `/chats/${encodeURIComponent(chatId)}/messages`, { text: question.q }, left());
  if (sent.status !== 202 && sent.status !== 200) return fail(`send ${sent.status}: ${String(sent.json['error'] ?? '')}`, base);
  const turnId = typeof sent.json['turnId'] === 'string' ? sent.json['turnId'] : null;
  if (turnId === null) return fail('send answered no turnId', base);
  const seats = Array.isArray(sent.json['seats']) && sent.json['seats'].length > 0 && sent.json['seats'].every((s) => typeof s === 'string') ? (sent.json['seats'] as string[]) : null;
  if (seats === null) return fail('send answered no seat list; the turn cannot be known complete', base);
  const citeWaitMs = Math.min(60_000, args.pollMs * 12);
  let records: unknown[] = [];
  let replyAt: number | null = null;
  let settled = false;
  let lastError: string | null = null;
  while (Date.now() < deadline) {
    await sleep(Math.min(args.pollMs, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    let got: Awaited<ReturnType<typeof call>>;
    try {
      got = await call(args.base, 'GET', `/chats/${encodeURIComponent(chatId)}/messages`, undefined, left());
    } catch (err) {
      lastError = `read: ${msg(err)}`;
      continue;
    }
    // Only a successful read inside the deadline counts: a late or failed one is never graded.
    if (Date.now() > deadline) break;
    if (got.status !== 200 || !Array.isArray(got.json['messages'])) {
      lastError = `read ${got.status}: ${String(got.json['error'] ?? 'no messages list')}`;
      continue;
    }
    records = got.json['messages'] as unknown[];
    const now = Date.now();
    if (replyAt === null && records.filter(isRecord).some((r) => r['kind'] === 'seat' && r['turnId'] === turnId && r['ok'] === true)) replyAt = now;
    if (turnSettled(records, turnId, seats, replyAt, now, citeWaitMs)) {
      settled = true;
      break;
    }
  }
  if (!settled) {
    const graded = resultOf(question, records, turnId, repos, args.canaries);
    return { ...graded, ...base, grounded: false, error: `the turn did not settle within ${args.timeoutSecs}s${lastError !== null ? ` (last read: ${lastError})` : ''}` };
  }
  // One more read: what landed between the settling read and now is graded too.
  // It is inside the question's deadline like every other read (codex r2 #7).
  if (Date.now() >= deadline) return fail(`the turn settled at the ${args.timeoutSecs}s deadline; no final read`, base);
  const final = await call(args.base, 'GET', `/chats/${encodeURIComponent(chatId)}/messages`, undefined, left());
  if (Date.now() > deadline) return fail(`the final read ended past the ${args.timeoutSecs}s deadline`, base);
  if (final.status !== 200 || !Array.isArray(final.json['messages'])) return fail(`final read ${final.status}`, base);
  const graded = resultOf(question, final.json['messages'] as unknown[], turnId, repos, args.canaries);
  // Every seat the send reached must have answered ok: a failed seat is an operational failure (codex r2 #5).
  const failedSeats = graded.replies.filter((r) => !r.ok).map((r) => r.cliKey || '?');
  const error = !graded.answered ? 'no seat answered' : failedSeats.length > 0 ? `seat ${failedSeats.join(', ')} failed` : null;
  return { ...graded, ...base, error };
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  let questions: Array<{ id: string; q: string; expect?: string[] }>;
  try {
    args = parseArgs(argv);
    const { readFileSync } = await import('node:fs');
    const raw: unknown = JSON.parse(readFileSync(args.questions, 'utf8'));
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${args.questions} must be a non-empty JSON array`);
    questions = raw.map((q, i) => {
      if (!isRecord(q) || typeof q['q'] !== 'string' || q['q'].trim() === '') throw new Error(`question ${i + 1} has no "q" text`);
      const expect = Array.isArray(q['expect']) ? q['expect'].filter((e): e is string => typeof e === 'string') : undefined;
      return { id: typeof q['id'] === 'string' ? q['id'] : `q${i + 1}`, q: q['q'], ...(expect !== undefined ? { expect } : {}) };
    });
  } catch (err) {
    process.stderr.write(`chat-probe: ${msg(err)}\n`);
    return 2;
  }
  const results: QuestionResult[] = [];
  for (const q of questions) {
    let r: QuestionResult;
    try {
      r = await ask(args, q);
    } catch (err) {
      r = { id: q.id, q: q.q, chatId: null, graphBound: null, answered: false, answerSeat: null, grounded: false, fabricated: 0, leaks: [], anchorHit: (q.expect ?? []).length > 0 ? false : null, daemonCitations: null, replies: [], error: `question failed: ${msg(err)}` };
    }
    results.push(r);
    process.stdout.write(
      `${r.id}\t${r.grounded ? 'grounded' : 'NOT grounded'}\tfabricated=${r.fabricated}\tleaks=${r.leaks.map((l) => l.kind).join(',') || 0}` +
        `${r.error !== null ? `\tERROR ${r.error}` : ''}\n`,
    );
  }
  const summary = summarize(results);
  process.stdout.write(
    `SUMMARY grounded ${summary.grounded}/${summary.questions}, fabricated ${summary.fabricated}, leaks ${summary.leaks}, ` +
      `answered ${summary.answered}, errors ${summary.errors}, anchors ${summary.anchorHits}/${summary.anchored}: ${summary.passed ? 'PASS' : 'FAIL'}\n`,
  );
  if (args.out !== null) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, `${JSON.stringify({ base: args.base, project: args.project, summary, results }, null, 2)}\n`);
  }
  return summary.passed ? 0 : 1;
}

if (process.argv[1] !== undefined && /chat-probe\.(?:ts|js|mjs)$/u.test(process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
