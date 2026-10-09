/**
 * The deliver phase's PR + commit TEXT (crew#524, acceptance finding F-3R2-014).
 *
 * `gh pr create --fill` opened wicked-studio#249 with a title cut MID-WORD out of the intent's first
 * 72 characters (`…scenario CLN-2) aga`) and an EMPTY body: no `Fixes #214`, no run link, no record
 * of what ran or what passed — and the commit carried the same truncated headline. A reviewer got
 * nothing to review against. This module composes the text from the RUN instead. ONE composer, two
 * moments it can be asked:
 *
 *  - at DELIVERY, from the persisted run view (`GET /runs/:id/deliver-text`, text/plain): every
 *    phase the run went through with its seat and gate outcome, the repo checks the verify phase
 *    ran with their exit codes, the evaluator's verdict, and a link to the run;
 *  - at LAUNCH, from the workflow definition — the fallback the deliver script carries in case the
 *    daemon cannot answer when the PR opens (an auth-required daemon, no `curl`, a daemon that went
 *    away): the intent, the issue links, the run id and the phase list ARE known then; the runtime
 *    sections say plainly that they were not available rather than pretending.
 *
 * The title is the intent's first line, cut at a WORD boundary within {@link DELIVER_TITLE_MAX}
 * characters (never mid-word), or `wicked-crew run <id>` when the intent is blank. `Fixes #N` is
 * emitted when the intent names an issue with a closing verb (`fix issue #214`, `closes #7`); every
 * other `#N` / `repo#N` / `owner/repo#N` mention rides as `Refs:`.
 *
 * FRAMING, shared by both carriers (the daemon's text/plain answer and the script's embedded
 * fallback) so the script parses exactly one shape: line 1 = title, line 2 = blank, then the body.
 * The framed text is also, verbatim, the message of the commit the deliver phase MAKES when the
 * run left uncommitted work (`git commit -F`: git takes the first paragraph as the subject). A run
 * that committed incrementally keeps its own commits untouched — the PR title is composed from the
 * run either way; only the deliver phase's own commit is guaranteed to match it.
 */

import { homedir } from 'node:os';

import type { GateSpec, PhaseDef, SessionView, WorkUnit } from './types.js';
import { stripLinkedIssues } from './linked-issues.js';
import { rewriteHostPaths, withRootAliases, type ChatRepoRoot } from './host-paths.js';

/**
 * The PR title cap (crew#860, S17b F15 / S17a F20). GitHub ACCEPTS 256 characters, and under that
 * cap wicked-studio#586 opened as the intent's first 244 — a whole paragraph, cut mid-sentence,
 * wider than the PR list renders. A title is a headline: the intent's FIRST SENTENCE, cut at a word
 * boundary inside 100 characters; the full intent is the body's first section and the run id is
 * named there. (crew#550 P-1 — a 72-character cap severed a quoted phrase — is still honoured: the
 * cut is depth-aware, see {@link boundedTitle}.) The COMMIT subject keeps git's conventional width,
 * {@link COMMIT_SUBJECT_MAX}; a longer title then opens the commit body in full.
 */
export const DELIVER_TITLE_MAX = 100;
/** The commit subject cap — git's conventional subject width (crew#550). */
export const COMMIT_SUBJECT_MAX = 72;

/** One phase of the run, with as much as is known about it at composition time. */
export interface DeliverPhaseFact {
  id: string;
  stage: string;
  role: string;
  gate: string;
  /** The seat that did the work — `null` when unknown (launch time) or when the phase is tooling. */
  seat: string | null;
  /** The recorded gate outcome / unit status, or `—` at launch time. */
  outcome: string;
}

/** One repo check a phase's floor ran (`typecheck` / `lint` / `test`), as the engine recorded it. */
export interface DeliverCheckFact {
  /** The phase whose floor ran it (`verify`, `deliver`, …) — DES-L9. */
  phase: string;
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
  spawnError: string | null;
  /** The engine's verdict on a non-zero exit (api-types 0.38.0 `RepoCheckRun.classification`) —
   *  `floor_env_mismatch` / `pre_existing_in_sandbox` / … — so a reader never sees "tests fail"
   *  over a run the engine itself excused (review-benchmark-prs D3). `null` when none. */
  classification: string | null;
}

/** An evaluator-role phase's recorded verdict. */
export interface DeliverVerdictFact {
  phase: string;
  seat: string | null;
  verdict: string;
  reason: string | null;
}

/**
 * What a unit's seat REPORTED in its final output (crew#860): the governed-worker output contract's
 * "What you did / Commands run (with exit codes) / Counts / Findings" block — for a creator, what
 * changed and the recipe it ran; for an evaluator, its findings by severity. Read from the unit's
 * captured output by {@link extractUnitReport}; `report` is bounded markdown, never empty.
 */
export interface DeliverReportFact {
  phase: string;
  seat: string | null;
  role: 'creator' | 'evaluator';
  report: string;
  /** The commands the seat says it ran, with the exit code it pasted beside each
   *  ({@link extractRecipeExits}) — a creator's recipe, read for the done-when evidence table.
   *  Absent/empty = the output named no command with an exit code. */
  exits?: DeliverRecipeExit[];
}

/** One command a seat reported running, with the exit code it pasted (crew#860). */
export interface DeliverRecipeExit {
  command: string;
  exit: number;
}

/** Everything the composer needs. Built by {@link factsFromRun} or {@link factsFromWorkflow}. */
export interface DeliverTextFacts {
  runId: string;
  intent: string;
  workflowId: string | null;
  repoRef: string | null;
  /** The studio bookmark for the run (`<daemon origin>/runs/<id>`), when the origin is known. */
  runUrl: string | null;
  /** `run`: from the persisted run view; `workflow`: from the definition at launch (no runtime facts). */
  source: 'run' | 'workflow';
  phases: DeliverPhaseFact[];
  /** Recorded repo checks; `null` when the run recorded none. Ignored when `source` is `workflow`. */
  checks: DeliverCheckFact[] | null;
  /**
   * WHY `checks` is empty, when the engine said (wave 6, wicked-core#449 @ 9e11685: a
   * `repoChecksEvaluated` with `checks: []` carries `detectError` / `sandboxError`, persisted on
   * the unit's repo-checks report). `null` when checks ran or the engine gave no reason. Rendered
   * as "0 checks detected — <reason>", never as "checks ran".
   */
  checksNote: string | null;
  verdicts: DeliverVerdictFact[];
  /** DES-L9: the open pull request this run REVISES (its commits land there; no new PR). */
  revisesPr?: { number: number; url: string } | null;
  /** crew#550: extra git trailers for the commit (`Co-Authored-By: …`), from
   *  {@link DELIVER_TRAILERS_ENV}; absent/empty = only the `Delivered-By:` trailer. */
  trailers?: string[];
  /** crew#550 P-7: the follow-ups the evaluator flagged (its `FOLLOW-UPS:` block, read from the
   *  evaluator units' output by {@link extractFollowUps}). `[]` = read, none flagged; absent = not
   *  read (a definition-time composition), and the section is left out. */
  followUps?: string[];
  /** crew#860: the creator and evaluator seats' final reports, read from the unit outputs
   *  ({@link reportsFromOutputs}). `[]` = read, nothing reportable; absent = the outputs could not
   *  be read (a definition-time composition, or an adapter without transcripts) — said in the body. */
  reports?: DeliverReportFact[];
}

export interface DeliverText {
  /** The PR title: ≤ {@link DELIVER_TITLE_MAX} characters, one line, never cut mid-word. */
  title: string;
  /** Markdown; never empty. */
  body: string;
}

export interface IssueRefs {
  /** `#N` (or `repo#N`) mentions the intent pairs with a closing verb — emitted as `Fixes …`. */
  fixes: string[];
  /** Every other issue mention — emitted as `Refs: …`. */
  refs: string[];
}

// ── the title ──────────────────────────────────────────────────────────────────────────────────

/** Control characters other than newline/tab — never part of a title, a table cell or a commit. */
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** EVERY control character, newline and tab included — for values that must stay on one line. */
const ALL_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** `s` as one line: control characters (newlines included) become spaces, runs collapse, ends trim. */
function oneLine(s: string): string {
  return s.replace(ALL_CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

/** One line of intent reduced to plain words: markdown markers and links stripped, spaces collapsed. */
function plainLine(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, ' ')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s+|\d+\.\s+)/, '') // heading / list / quote markers
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) → text
    .replace(/\*\*|__|`/g, '') // strong / code markers
    // Paired single-marker emphasis (`*fix*`, `_fix_`), guarded by word boundaries so an identifier
    // like `snake_case_name` or a bare `a * b` is left alone.
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?![\w_])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A line that is nothing but a URL (the benchmark runs' intents opened with the bare issue link). */
const BARE_URL = /^<?https?:\/\/\S+>?$/i;
/** `owner/repo#N` from a GitHub issue / pull URL. */
const GITHUB_ISSUE_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/i;

/**
 * The intent's first non-blank PROSE line as plain words, or `''`. A line that is only a URL is
 * never a title (review-benchmark-prs D1: three PRs titled by the bare issue URL): it is skipped,
 * and when the intent has no prose at all the issue it names becomes the headline
 * (`resolve owner/repo#N`).
 */
function firstLine(intent: string): string {
  let url: string | null = null;
  for (const raw of intent.split(/\r?\n/)) {
    const line = plainLine(raw);
    if (line === '') continue;
    if (BARE_URL.test(line)) {
      url ??= line;
      continue;
    }
    return line;
  }
  const m = url === null ? null : GITHUB_ISSUE_URL.exec(url);
  return m === null ? '' : `resolve ${m[1]}/${m[2]}#${m[3]}`;
}

/** `fix:` / `feat:` / `chore:` — the conventional-commit type a workflow's delivery reads as. */
const CONVENTIONAL_TYPE_BY_WORKFLOW: Record<string, string> = {
  bug: 'fix',
  feature: 'feat',
  migration: 'refactor',
};
/**
 * A headline that already carries a CONVENTIONAL prefix (`fix(scope)!: …`) — the conventional-commit
 * type set, closed (review-L9-603 M1): an intent opening `wip: …` / `note: …` is a free-form word,
 * not a type, and gets the workflow's prefix like any other headline.
 */
const HAS_CONVENTIONAL_PREFIX = /^(?:feat|fix|refactor|chore|docs|test|build|ci|perf|style|revert)(?:\([^)]*\))?!?: /;

/**
 * The conventional-commit prefix for a headline: derived from the workflow (`bug` → `fix`,
 * `feature` → `feat`, `migration` → `refactor`, anything else → `chore`), applied only when the
 * headline does not already start with one (DES-L9; review-benchmark-prs D1).
 */
export function conventionalPrefix(workflowId: string | null | undefined): string {
  return CONVENTIONAL_TYPE_BY_WORKFLOW[workflowId ?? ''] ?? 'chore';
}

/** A `.` that ends one of these is an abbreviation, not a sentence (`e.g. the gate`, `vs. main`). */
const ABBREVIATION_BEFORE_DOT = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|resp|fig|no|vol|ca)$/i;

/**
 * The first SENTENCE of a headline line (crew#860): the text up to the first `.`, `!` or `?` that
 * is followed by whitespace or the end, at quote/bracket depth 0 (a period inside `(…)` or `"…"`
 * does not end the sentence), and not the dot of an abbreviation. A closing `.` is dropped (a
 * headline carries no full stop); `!` and `?` stay. A dot glued to the next word (`0.8.4`,
 * `deliver.ts`, `wicked-studio#586.`) never splits. No terminator ⇒ the whole line.
 */
export function firstSentence(line: string): string {
  const stack: string[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    const top = stack[stack.length - 1];
    if (top !== undefined && c === top) {
      stack.pop();
      continue;
    }
    if (c === "'") {
      if (i === 0 || line[i - 1] === ' ') stack.push("'");
      continue;
    }
    const closer = OPENERS[c];
    if (closer !== undefined) {
      stack.push(closer);
      continue;
    }
    if (stack.length > 0 || (c !== '.' && c !== '!' && c !== '?')) continue;
    // A run of terminators (`?!`, `...`) ends together; the sentence ends only when whitespace or
    // the end follows the run.
    let j = i;
    while (j + 1 < line.length && /[.!?]/.test(line[j + 1]!)) j += 1;
    if (j + 1 < line.length && !/\s/.test(line[j + 1]!)) continue;
    const head = line.slice(0, i);
    if (c === '.' && j === i && ABBREVIATION_BEFORE_DOT.test(head)) continue;
    const sentence = (c === '.' && j === i ? head : line.slice(0, j + 1)).trim();
    if (sentence === '') continue;
    return sentence;
  }
  return line;
}

/**
 * The PR title / commit subject: the FIRST SENTENCE of the intent's first prose line (crew#860),
 * whole when it fits, otherwise cut at the last word boundary that leaves room for a single `…` —
 * so the result is ≤ {@link DELIVER_TITLE_MAX} characters and never ends mid-word (the F-3R2-014
 * headline `…scenario CLN-2) aga`). Dangling punctuation before the ellipsis is dropped. A blank
 * intent names the run instead — through the SAME bounded cut, so a long caller-supplied session id
 * (the CLI passes `--session` through) is never cut mid-id either (Copilot on #525): the body names
 * the run id in full.
 */
export function deliverTitle(intent: string, runId: string, workflowId?: string | null): string {
  const line = firstSentence(firstLine(intent));
  // The run id is caller-supplied too (`LaunchSchema` only requires it non-empty): a newline in it
  // must not turn the title into two lines and break the framing (Copilot on #525).
  if (line === '') return boundedTitle(oneLine(`wicked-crew run ${oneLine(runId)}`));
  // DES-L9: a conventional prefix derived from the WORKFLOW the run drove (a free-text run has no
  // workflow and keeps the bare headline), unless the intent already wrote one.
  const prefixed =
    workflowId === undefined || workflowId === null || workflowId === '' || HAS_CONVENTIONAL_PREFIX.test(line)
      ? line
      : `${conventionalPrefix(workflowId)}: ${line}`;
  return boundedTitle(prefixed);
}

/** Characters that OPEN a quoted or bracketed phrase, and what closes each. */
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', '`': '`', '“': '”', '‘': '’' };

/**
 * `line` whole when it fits, else cut at a word boundary with a single `…` — ≤ `max` characters —
 * choosing the LAST boundary at nesting depth 0: never inside a quoted or bracketed phrase (crew#550
 * P-1: `… truncated at '(Failed):' and 'sign a seat…`). A straight apostrophe opens a quote only
 * after a space or at the start (so `daemon's` is a word, not a quote). When no depth-0 boundary
 * exists inside the room, any word boundary is taken; a single 72+ character token is cut hard.
 */
export function boundedTitle(line: string, max: number = DELIVER_TITLE_MAX): string {
  if (line.length <= max) return line;
  const room = max - 1; // one character is the ellipsis
  const head = line.slice(0, room + 1); // one past the room: a space HERE means the room ends a word
  const stack: string[] = [];
  let lastAnyCut = -1;
  let lastDepth0Cut = -1;
  for (let i = 0; i < head.length; i += 1) {
    const c = head[i]!;
    if (c === ' ') {
      lastAnyCut = i;
      if (stack.length === 0) lastDepth0Cut = i;
      continue;
    }
    const top = stack[stack.length - 1];
    if (top !== undefined && c === top) {
      stack.pop();
      continue;
    }
    if (c === "'") {
      if (i === 0 || head[i - 1] === ' ') stack.push("'");
      continue;
    }
    const closer = OPENERS[c];
    if (closer !== undefined) stack.push(closer);
  }
  const cut = lastDepth0Cut > 0 ? lastDepth0Cut : lastAnyCut;
  const kept = (cut > 0 ? head.slice(0, cut) : head.slice(0, room)).replace(/[\s,;:(\-–—]+$/u, '');
  return `${kept}…`;
}

/**
 * The commit subject for a PR title (crew#550): the title itself when it fits git's 72-character
 * subject width, else the same depth-aware word-boundary cut at 72. The deliver script puts the
 * full title at the top of the commit body whenever the two differ.
 */
export function commitSubject(title: string): string {
  return boundedTitle(title, COMMIT_SUBJECT_MAX);
}

// ── issue references ───────────────────────────────────────────────────────────────────────────

/** One `#N` / `repo#N` / `owner/repo#N` inside a closing list. */
const ONE_REF = String.raw`(?:(?:[\w.-]+\/)?[\w.-]+)?#\d+\b`;
/**
 * `fix issue #214`, `fixes #7`, `closes wicked-studio#3`, `resolved: #9` — a closing verb + a ref —
 * and a LIST after one verb (crew#635: `fix #618, #619 and #620` closed only #618, so every merge
 * left the rest open): refs joined by `,` / `and` / `&` / `+` / `/` all ride the one verb.
 */
const CLOSING_LIST = new RegExp(
  String.raw`\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b(?:\s+(?:issues?|bugs?|for))?\s*:?\s*(` +
    ONE_REF +
    String.raw`(?:\s*(?:,|&|\+|\/|\band\b)?\s*` +
    ONE_REF +
    `)*)`,
  'gi',
);
/** Any `#N`, `repo#N` or `owner/repo#N` not glued to a word/path (so `a/b#1` is one ref, `#1a` none). */
const ANY_REF = /(?<![\w/#])((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/g;

/** Does `owner/repo#N` name the delivery repository (`repoRef`, the registered repo id)? */
function sameRepo(ref: string, repoRef: string | null | undefined): boolean {
  if (repoRef === undefined || repoRef === null || repoRef === '') return false;
  const m = /^[\w.-]+\/([\w.-]+)#\d+$/.exec(ref);
  return m !== null && m[1]!.toLowerCase() === repoRef.toLowerCase();
}

/**
 * The issues the intent names, split into the ones it says it fixes and the rest.
 *
 * GitHub links and closes on `#N` (this repo) and `owner/repo#N` only. An OWNER-LESS `repo#N`
 * does neither — so when its repo segment names the delivery repo (`repoRef`, the registered
 * repo id the PR lands in) it is emitted as plain `#N` (review W3-K2: `fixes wicked-studio#214`
 * on a wicked-studio delivery must close #214). Any other owner-less `repo#N` rides verbatim as
 * information; `owner/repo#N` is left exactly as written.
 */
export function issueRefs(rawIntent: string, repoRef?: string | null): IssueRefs {
  // The daemon's linked-issues block (crew#627) is issue TEXT, not the intent: its mentions are
  // never the run's references.
  const intent = stripLinkedIssues(rawIntent);
  const normalize = (prefix: string | undefined, n: string): string => {
    if (prefix === undefined || prefix === '') return `#${n}`;
    if (!prefix.includes('/') && repoRef !== undefined && repoRef !== null && prefix === repoRef) return `#${n}`;
    return `${prefix}#${n}`;
  };
  const fixes: string[] = [];
  const refs: string[] = [];
  for (const list of intent.matchAll(CLOSING_LIST)) {
    // Inside a matched list a ref may follow `/` (`#618/#619`), which ANY_REF's guard refuses.
    for (const m of list[1]!.matchAll(/((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/g)) {
      const ref = normalize(m[1], m[2]!);
      // crew#635: an `owner/repo#N` in ANOTHER repository stays `Refs:` even under a closing verb —
      // merging this PR must not close an issue whose share of the work lives elsewhere.
      if (ref.includes('/') && !sameRepo(ref, repoRef)) continue;
      if (!fixes.includes(ref)) fixes.push(ref);
    }
  }
  for (const m of intent.matchAll(ANY_REF)) {
    const ref = normalize(m[1], m[2]!);
    if (!fixes.includes(ref) && !refs.includes(ref)) refs.push(ref);
  }
  // A bare GitHub issue / pull URL names an issue too (DES-L9; the benchmark intents were URLs):
  // it rides as `owner/repo#N` — a link GitHub renders — never as a closing reference (a URL
  // carries no verb).
  for (const m of intent.matchAll(new RegExp(GITHUB_ISSUE_URL.source, 'gi'))) {
    const ref = `${m[1]}/${m[2]}#${m[3]}`;
    if (!fixes.includes(ref) && !refs.includes(ref)) refs.push(ref);
  }
  return { fixes, refs };
}

/**
 * How much of the intent the deliver SCRIPT carries in its embedded fallback text. The script is
 * one `bash -lc` argument, and `LaunchSchema.problem` has no length cap, so an unbounded intent
 * could exceed a platform's single-argument limit (Linux: 128 KiB) and fail the phase with E2BIG
 * before it runs (Copilot on #525). The run-derived text the daemon answers is NOT bounded — it
 * travels over HTTP, never through argv.
 */
export const EMBEDDED_INTENT_CAP = 8_000;
const EMBEDDED_INTENT_NOTE =
  '_(the intent is longer than the deliver script embeds — the full text is on the run record)_';

/** `intent` bounded for embedding in the script: whole when it fits, else cut and said so. */
export function boundIntentForEmbedding(intent: string): string {
  if (intent.length <= EMBEDDED_INTENT_CAP) return intent;
  return `${intent.slice(0, EMBEDDED_INTENT_CAP).trimEnd()}\n\n${EMBEDDED_INTENT_NOTE}`;
}

/**
 * The launch-time FALLBACK text the deliver script embeds (crew#524; wave-3 isolation review): the
 * intent rides BOUNDED ({@link boundIntentForEmbedding} — the script is one argv entry) but the
 * issue references are derived from the FULL intent FIRST, so a `fixes #214` that sits past the
 * {@link EMBEDDED_INTENT_CAP} still reaches the body as `Fixes #214` — the line GitHub acts on —
 * when no daemon answers `GET /runs/:id/deliver-text`. The title is the intent's first line either
 * way. The cut copy carries the "longer than the script embeds" note, so the omission is disclosed
 * and the reference is not.
 */
export function composeEmbeddedDeliverText(f: DeliverTextFacts): DeliverText {
  return composeDeliverText({ ...f, intent: boundIntentForEmbedding(f.intent) }, issueRefs(f.intent, f.repoRef));
}

// ── the body ───────────────────────────────────────────────────────────────────────────────────

/** A markdown table cell: control characters out, pipes escaped, bounded. */
function cell(value: string | number | null | undefined, max = 200): string {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function code(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  // One line (a code span cannot span lines); backticks inside a code span would end it early, so
  // they are dropped; pipes are escaped for the table cells this lands in.
  const one = oneLine(value).replace(/`/g, '').replace(/\|/g, '\\|');
  return one === '' ? '—' : `\`${one}\``;
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function exitLabel(c: DeliverCheckFact): string {
  if (c.exitCode !== null) return String(c.exitCode);
  if (c.timedOut) return 'timed out';
  if (c.spawnError !== null && c.spawnError !== '') return `spawn error: ${c.spawnError}`;
  return '—';
}

/** The product site — never a repo owner handle (crew bakes no account name into a script). */
const FOOTER_LINK = '[wicked-crew](https://wc.wickedagile.com)';

/**
 * The PR title + body (and, through {@link framedDeliverText}, the commit message) for a run.
 * Never empty: every section either carries the recorded facts or says why it does not.
 *
 * `links` defaults to the issue references of `f.intent`; the embedded-fallback path passes the
 * references of the FULL intent while `f.intent` is the bounded copy ({@link composeEmbeddedDeliverText}).
 */
export function composeDeliverText(raw: DeliverTextFacts, links: IssueRefs = issueRefs(raw.intent, raw.repoRef)): DeliverText {
  // crew#886: redact the FACTS, not only the text — the title and table cells are cut to a width,
  // and a cut through a home path would no longer match it (codex on crew#887). The output pass
  // below stays as the backstop.
  const f = redactFacts(raw);
  const title = deliverTitle(f.intent, f.runId, f.workflowId);
  const { fixes, refs } = links;
  const intent = stripLinkedIssues(f.intent).replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, ' ').trim();
  const out: string[] = [];

  out.push('## Intent', '', intent === '' ? '_(the run recorded no intent)_' : intent, '');
  if (fixes.length > 0 || refs.length > 0) {
    for (const x of fixes) out.push(`Fixes ${x}`);
    if (refs.length > 0) {
      out.push(`Refs: ${refs.join(', ')}`);
      // crew#635: say why a Refs issue stays open, so "a human closes it" is a stated step.
      out.push('', "_Refs are not closed by this PR: the intent did not say it fixes them. Close any this PR resolves by hand._");
    }
    out.push('');
  }

  out.push('## Run', '');
  // The label is the same one-line code span as the unlinked form — a caller-supplied id cannot
  // break the line or the Markdown (the URL half is `urlPathSegment`-encoded by `runUrlFor`).
  out.push(f.runUrl !== null ? `- Run: [${code(f.runId)}](${f.runUrl})` : `- Run: ${code(f.runId)}`);
  const where = [
    f.workflowId !== null && f.workflowId !== '' ? `workflow ${code(f.workflowId)}` : null,
    f.repoRef !== null && f.repoRef !== '' ? `repo ${code(f.repoRef)}` : null,
  ].filter((s): s is string => s !== null);
  if (where.length > 0) out.push(`- ${where.join(' · ')}`);
  if (f.revisesPr !== undefined && f.revisesPr !== null) {
    // DES-L9: a revision names the PR it lands on — this text rides that PR as a comment.
    out.push(`- Revises pull request [#${f.revisesPr.number}](${f.revisesPr.url}) — this run's commits were pushed onto its branch; no new PR was opened.`);
  }
  out.push('');

  out.push('## Phases', '');
  if (f.source === 'workflow') {
    out.push(
      '_From the workflow definition at launch — the daemon could not be asked for the run record ' +
        'when this PR opened, so seats and gate outcomes are not shown. Every phase before `deliver` ' +
        'had passed its gate for the deliver phase to run._',
      '',
    );
  }
  if (f.phases.length === 0) {
    out.push('_(no phases recorded)_');
  } else {
    out.push('| phase | stage | role | seat | gate | outcome |', '|---|---|---|---|---|---|');
    for (const p of f.phases) {
      out.push(
        `| ${code(p.id)} | ${cell(p.stage)} | ${cell(p.role)} | ${cell(p.seat)} | ${cell(p.gate)} | ${cell(p.outcome)} |`,
      );
    }
  }
  out.push('');

  out.push('## Repo checks', '');
  if (f.source === 'workflow') {
    out.push('_Not available at composition time — the run record has them._');
  } else if (f.checks === null || f.checks.length === 0) {
    // Never "checks ran" over an empty report (wave 6, F-7R2-017): 0 checks were detected, and
    // when the engine said why (`repoChecksEvaluated.detectError` / `sandboxError`, #449), say it.
    out.push(
      f.checksNote !== null
        ? `_0 checks detected — ${f.checksNote}. The run recorded no repo checks._`
        : '_0 checks detected. The run recorded no repo checks (no `typecheck` / `lint` / `test` ' +
            'script was found, or the workflow has no verify phase)._',
    );
  } else {
    // DES-L9: WHICH phase's floor ran the check and the engine's own classification of a non-zero
    // exit (`floor_env_mismatch` — the checks cannot run under the floor's sandbox on this host;
    // `pre_existing_in_sandbox` — the base fails the same way), so "exit 1" is never read as
    // "tests fail" when the engine itself excused it (review-benchmark-prs D3).
    out.push('| phase | check | command | exit | classification | duration |', '|---|---|---|---|---|---|');
    for (const c of f.checks) {
      out.push(
        `| ${code(c.phase)} | ${cell(c.name)} | ${code(c.command)} | ${cell(exitLabel(c))} | ${cell(classificationLabel(c))} | ${duration(c.durationMs)} |`,
      );
    }
  }
  out.push('');

  // DES-L9: the EVALUATOR GATE — what the distinct evaluator seat concluded about the creator's
  // work, as the engine recorded it: `passed its gate` for a clean pass, else the recorded status
  // with the evaluator's own findings (`denial_reason` — the `VERDICT:` line's text) beside it.
  out.push('## Evaluator gate', '');
  if (f.source === 'workflow') {
    out.push('_Not available at composition time — the run record has it._');
  } else if (f.verdicts.length === 0) {
    out.push('_This workflow has no evaluator phase._');
  } else {
    for (const v of f.verdicts) {
      const hasReason = v.reason !== null && v.reason.trim() !== '';
      const passed = !hasReason && /^(done|approved|passed?)$/i.test(v.verdict.trim());
      const outcome = passed ? 'passed its gate' : `**${cell(v.verdict)}**${hasReason ? ` — ${cell(v.reason, 400)}` : ''}`;
      out.push(`- ${code(v.phase)} (${cell(v.seat ?? 'seat unknown')}): ${outcome}`);
    }
  }
  out.push('');

  // crew#860 (S17b F15): the DONE-WHEN EVIDENCE, one row per phase — the deterministic floor's
  // results for that phase (`typecheck 0 · lint 0`), the evaluator verdict recorded for it, and the
  // exit codes the creator PASTED for its own recipe — so a reviewer reads "what proved this" in one
  // table instead of reconstructing it from three sections and the run record.
  if (f.source === 'run') {
    out.push('## Done-when evidence', '');
    out.push(...doneWhenTable(f), '');
  }

  // crew#860 (S17b F15): the FACTS the intent's own done-when asks the PR to state — the creator's
  // "what I did / commands run with exit codes / done-when table" and each evaluator's findings —
  // already exist in the unit outputs; the PR used to carry only "passed its gate" and the operator
  // appended the table by hand. They ride here, bounded, under the seat that wrote them.
  out.push('## Creator report', '');
  const creators = (f.reports ?? []).filter((r) => r.role === 'creator');
  if (f.source === 'workflow') {
    out.push('_Not available at composition time — the run record has it._');
  } else if (f.reports === undefined) {
    out.push("_The creator's output could not be read when this PR opened — the run record has it._");
  } else if (creators.length === 0) {
    out.push('_No creator report was recorded (no creator phase, or its output carried no report)._');
  } else {
    for (const r of creators) out.push(`### ${code(r.phase)} (${cell(r.seat ?? 'seat unknown')})`, '', r.report, '');
  }
  out.push('');

  const evaluations = (f.reports ?? []).filter((r) => r.role === 'evaluator');
  if (evaluations.length > 0) {
    out.push('## Evaluator findings', '');
    for (const r of evaluations) out.push(`### ${code(r.phase)} (${cell(r.seat ?? 'seat unknown')})`, '', r.report, '');
  }

  // crew#550 P-7: what the evaluator said should happen NEXT lands on the PR, not only in its log.
  if (f.followUps !== undefined) {
    out.push('## Follow-ups', '');
    if (f.followUps.length === 0) out.push('_None flagged by the evaluator._');
    else for (const x of f.followUps) out.push(`- ${cell(x, FOLLOW_UP_MAX_CHARS)}`);
    out.push('');
  }

  out.push(
    '---',
    '',
    `Delivered by ${FOOTER_LINK} run ${code(f.runId)}. Merge stays human: the phase opens the PR, never merges it.`,
    '',
    // A git TRAILER (`Token: value`, the message's last paragraph) — the commit this text becomes
    // names the pipeline that authored it (review-benchmark-prs D4), machine-readable.
    `Delivered-By: wicked-crew run ${oneLine(f.runId)}`,
    ...(f.trailers ?? []),
  );
  return { title: redactHostPaths(title), body: redactHostPaths(out.join('\n')) };
}

/** Every string in the facts through {@link redactHostPaths} (plain data: strings, arrays, objects). */
function redactFacts<T>(value: T, home: string | null = homePrefix()): T {
  if (home === null) return value;
  const aliases = withRootAliases([{ absRoot: home, name: '~' }]);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactWith(v, aliases);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The daemon's home directory, or `null` when it is unusable as a prefix (unset, or `/`). */
function homePrefix(): string | null {
  try {
    const home = homedir().replace(/[\\/]+$/, '');
    return home === '' ? null : home;
  } catch {
    return null;
  }
}

/**
 * crew#886: the PR title, body and commit message leave the machine, and they quote seat reports
 * verbatim — a creator's "Worktree: `<home>/.wicked/repos/<repo>/wicked-worktrees/<run>`" put the
 * operator's home directory on GitHub. Every spelling of the home directory (its realpath and the
 * macOS `/private` twin too) becomes `~`, through the same rewrite crew#618 applies to chat replies
 * (`rewriteHostPaths` + `withRootAliases`): `<home>/x` → `~/x`, a bare `<home>` → `~`, and a longer
 * sibling (`<home>-old/…`) is never touched.
 */
export function redactHostPaths(text: string, home: string | null = homePrefix()): string {
  if (home === null || home === '') return text;
  return redactWith(text, withRootAliases([{ absRoot: home, name: '~' }]));
}

function redactWith(text: string, aliases: ReadonlyArray<ChatRepoRoot>): string {
  let out = rewriteHostPaths(text, aliases);
  // What leaves the machine is stricter than a chat citation: a bare home the chat rewrite keeps
  // (followed by more than closing punctuation — compact JSON `"<home>","next"`, codex on crew#887)
  // still goes, unless a path character continues it (a longer sibling such as `<home>-old`).
  for (const { absRoot } of aliases) {
    if (!out.includes(absRoot)) continue;
    const escaped = absRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w./\\\\-])${escaped}(?![\\w.-])`, 'g'), '~');
  }
  return out;
}

/** At most this many pasted recipe commands per phase in the done-when table. */
export const RECIPE_EXITS_MAX = 12;

/**
 * The done-when evidence table (crew#860): one row per phase that has ANY evidence — a floor
 * result, a recorded verdict, or pasted recipe exit codes. Every cell says what was recorded, or
 * `—` when nothing was; a phase with no evidence at all is left out (the Phases table lists it).
 */
function doneWhenTable(f: DeliverTextFacts): string[] {
  const rows: string[] = [];
  const order: string[] = [];
  for (const p of f.phases) if (!order.includes(p.id)) order.push(p.id);
  for (const x of [...(f.checks ?? []).map((c) => c.phase), ...f.verdicts.map((v) => v.phase), ...(f.reports ?? []).map((r) => r.phase)]) {
    if (!order.includes(x)) order.push(x);
  }
  for (const id of order) {
    const phase = f.phases.find((p) => p.id === id);
    const checks = (f.checks ?? []).filter((c) => c.phase === id);
    const floor = checks.map((c) => `${c.name} ${exitLabel(c)}${c.exitCode !== null && c.exitCode !== 0 && c.classification !== null ? ` (${c.classification})` : ''}`).join(' · ');
    const verdict = f.verdicts.find((v) => v.phase === id);
    const verdictCell = verdict === undefined ? '' : `${verdict.verdict}${verdict.reason !== null && verdict.reason.trim() !== '' ? ` — ${verdict.reason}` : ''}`;
    const exits = (f.reports ?? []).filter((r) => r.phase === id).flatMap((r) => r.exits ?? []).slice(0, RECIPE_EXITS_MAX);
    const recipe = exits.map((e) => `${code(e.command)} → ${e.exit}`).join('<br>');
    if (floor === '' && verdictCell === '' && recipe === '') continue;
    const seat = phase?.seat ?? f.reports?.find((r) => r.phase === id)?.seat ?? verdict?.seat ?? null;
    rows.push(`| ${code(id)} | ${cell(seat)} | ${floor === '' ? '—' : cell(floor, 400)} | ${verdictCell === '' ? '—' : cell(verdictCell, 300)} | ${recipe === '' ? '—' : recipe} |`);
  }
  if (rows.length === 0) {
    return ['_No floor results, evaluator verdicts or pasted recipe exit codes were recorded for this run._'];
  }
  return ['| phase | seat | floor (exit codes) | evaluator verdict | recipe the seat ran (pasted exit codes) |', '|---|---|---|---|---|', ...rows];
}

/** The classification cell: the engine's word for a non-zero exit, `—` for a pass or none. */
function classificationLabel(c: DeliverCheckFact): string {
  if (c.classification !== null && c.classification.trim() !== '') return c.classification;
  return c.exitCode === 0 ? '—' : c.exitCode === null && !c.timedOut && c.spawnError === null ? '—' : 'unclassified';
}

/** The one shape both carriers speak: title, blank line, body, trailing newline. */
export function framedDeliverText(text: DeliverText): string {
  return `${text.title}\n\n${text.body}\n`;
}

/**
 * The inverse of {@link framedDeliverText}, or `null` when the text is not framed that way — a
 * non-empty title line, a blank line 2, and a body with something in it (the same three conditions
 * the deliver script's `_framed` check applies before it accepts a daemon answer).
 */
export function parseFramedDeliverText(framed: string): DeliverText | null {
  const lines = framed.split('\n');
  if (lines.length < 3 || lines[0]!.trim() === '' || lines[1] !== '') return null;
  const body = lines.slice(2).join('\n').replace(/\n$/, '');
  if (body.trim() === '') return null;
  return { title: lines[0]!, body };
}

// ── facts ──────────────────────────────────────────────────────────────────────────────────────

/** A `GateSpec` (or the engine's loose string form) as a short label. */
export function gateLabel(gate: GateSpec | string | undefined): string {
  if (gate === undefined || gate === null) return '—';
  if (typeof gate === 'string') return gate;
  if ('human_confirm_if' in gate) return `human if ${gate.human_confirm_if.replace(/_/g, ' ')}`;
  if ('human_confirm' in gate) return gate.human_confirm.unconditional ? 'human' : 'human (conditional)';
  return '—';
}

/** The engine's per-unit `repo_checks` record (snake_case on the wire; not in the api-types yet). */
interface EngineRepoChecks {
  checks?: Array<{
    name?: string;
    argv?: string[];
    exit_code?: number | null;
    duration_ms?: number;
    timed_out?: boolean;
    spawn_error?: string | null;
    classification?: string | null;
  }>;
}

/** `<run id>:<phase>` → `<phase>`; anything else is returned whole. */
function phaseIdOf(unit: WorkUnit): string {
  const prefix = `${unit.session_id}:`;
  return unit.id.startsWith(prefix) ? unit.id.slice(prefix.length) : unit.id;
}

function seatOf(unit: WorkUnit): string | null {
  if (unit.routing?.method === 'tool') return 'tool';
  if (unit.assigned_cli !== null && unit.assigned_cli !== '') return unit.assigned_cli;
  const r = unit.routing;
  if (r !== null && r !== undefined && 'winner' in r) return r.winner;
  return null;
}

/**
 * Why a unit's repo-checks report detected NOTHING (wave 6, wicked-core#449 @ 9e11685): the
 * report's `detect_error` / `sandbox_error` (the persisted snake_case; the camelCase frame spelling
 * is read too until the persisted shape is pinned), with the sandbox level when named. `null` when
 * the report ran checks, or carries no reason.
 */
function checksNoteOf(unit: WorkUnit): string | null {
  const rc = (unit as WorkUnit & { repo_checks?: Record<string, unknown> | null }).repo_checks;
  if (rc === null || rc === undefined || typeof rc !== 'object') return null;
  if (Array.isArray(rc['checks']) && rc['checks'].length > 0) return null;
  const str = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = rc[k];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
    return null;
  };
  const parts: string[] = [];
  const detect = str('detect_error', 'detectError');
  if (detect !== null) parts.push(detect);
  const sandbox = str('sandbox_error', 'sandboxError');
  if (sandbox !== null) parts.push(`sandbox: ${sandbox}`);
  const level = str('sandbox_level', 'sandboxLevel');
  if (level !== null && parts.length > 0) parts.push(`sandbox level ${level}`);
  return parts.length === 0 ? null : parts.join('; ');
}

function checksOf(unit: WorkUnit): DeliverCheckFact[] {
  const rc = (unit as WorkUnit & { repo_checks?: EngineRepoChecks | null }).repo_checks;
  if (rc === null || rc === undefined || !Array.isArray(rc.checks)) return [];
  const phase = phaseIdOf(unit);
  return rc.checks.map((c) => ({
    phase,
    name: c.name ?? '—',
    command: Array.isArray(c.argv) ? c.argv.join(' ') : '—',
    exitCode: typeof c.exit_code === 'number' ? c.exit_code : null,
    durationMs: typeof c.duration_ms === 'number' ? c.duration_ms : null,
    timedOut: c.timed_out === true,
    spawnError: typeof c.spawn_error === 'string' ? c.spawn_error : null,
    classification: typeof c.classification === 'string' && c.classification !== '' ? c.classification : null,
  }));
}

/**
 * A composed per-run workflow id (`<base>-deliver-<run id>`, `<base>-verified-<run id>`; see
 * `composeDeliverWorkflow` / `composeDeliverableFloor`) reads as its base. The composed id is
 * capped at 128 characters, so for a long caller-supplied run id the marker's tail is CUT — the
 * tail is therefore matched as a prefix of the sanitised run id, not whole.
 */
export function baseWorkflowId(workflowId: string, runId: string): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
  let id = workflowId;
  for (const marker of ['-deliver-', '-verified-']) {
    const at = id.indexOf(marker);
    if (at > 0 && safeRunId.startsWith(id.slice(at + marker.length))) id = id.slice(0, at);
  }
  return id;
}

/**
 * The facts from a persisted run view — what the daemon answers on `GET /runs/:id/deliver-text`.
 * The deliver phase itself (running while it asks) is listed as `this PR`.
 *
 * `resolved.workflowId` is the run's preset or workflow NAME the route resolved from the engine's
 * record (`runIdentityOf`, seam X2) — `null` for a user plan or a free-text run, which names no
 * workflow. Absent (`undefined`), the view's id is used (with the per-run composition suffix cut).
 */
export function factsFromRun(
  view: SessionView,
  runUrl: string | null,
  resolved: {
    workflowId?: string | null;
    revisesPr?: { number: number; url: string } | null;
    /** crew#550: the evaluator follow-ups, when the caller read the evaluator units' output. */
    followUps?: string[];
    /** crew#860: the seats' final reports, when the caller read the unit outputs. */
    reports?: DeliverReportFact[];
  } = {},
): DeliverTextFacts {
  const s = view.session;
  const units = [...view.units].sort((a, b) => a.ord - b.ord);
  const checks = units.flatMap(checksOf);
  return {
    runId: s.id,
    // crew#627: the daemon's linked-issues block is taken back out — the PR names the intent.
    intent: stripLinkedIssues(s.problem ?? ''),
    // An explicit `null` is the resolver's answer (a user plan, free text): no workflow line, never
    // the engine's synthetic `wf-<run>` id.
    workflowId: resolved.workflowId !== undefined ? resolved.workflowId : baseWorkflowId(s.workflow_id, s.id),
    repoRef: s.repo_ref,
    runUrl,
    source: 'run',
    phases: units.map((u) => {
      const id = phaseIdOf(u);
      const running = u.status === 'pending' || u.status === 'distributed'; // not yet done: it is asking
      return {
        id,
        stage: u.stage,
        role: u.role ?? 'neutral',
        gate: gateLabel(u.gate),
        seat: seatOf(u),
        outcome: id === 'deliver' && running ? 'this PR' : (u.phase_status ?? u.status),
      };
    }),
    checks: checks.length > 0 ? checks : null,
    // The engine's reason for an EMPTY report, when it gave one (the first unit that says why).
    checksNote: checks.length > 0 ? null : (units.map(checksNoteOf).find((n) => n !== null) ?? null),
    verdicts: units
      .filter((u) => u.role === 'evaluator')
      .map((u) => ({
        phase: phaseIdOf(u),
        seat: seatOf(u),
        verdict: u.phase_status ?? u.status,
        reason: u.denial_reason,
      })),
    revisesPr: resolved.revisesPr ?? null,
    trailers: configuredTrailers(),
    ...(resolved.followUps !== undefined ? { followUps: resolved.followUps } : {}),
    ...(resolved.reports !== undefined ? { reports: resolved.reports } : {}),
  };
}

/** What is known at LAUNCH, from the workflow definition — the script's embedded fallback. */
export function factsFromWorkflow(input: {
  runId: string;
  intent: string | undefined;
  workflowId: string | null;
  repoRef: string | null;
  phases: PhaseDef[];
  runUrl: string | null;
  revisesPr?: { number: number; url: string } | null;
}): DeliverTextFacts {
  return {
    runId: input.runId,
    intent: stripLinkedIssues(input.intent ?? ''),
    workflowId: input.workflowId,
    repoRef: input.repoRef,
    runUrl: input.runUrl,
    source: 'workflow',
    phases: input.phases.map((p) => ({
      id: p.id,
      stage: p.kind,
      role: p.role,
      gate: gateLabel(p.gate),
      seat: p.executor?.type === 'tool' ? 'tool' : null,
      outcome: '—',
    })),
    checks: null,
    checksNote: null,
    verdicts: [],
    revisesPr: input.revisesPr ?? null,
    trailers: configuredTrailers(),
  };
}

/**
 * The environment variable naming extra commit trailers for delivered work (crew#550), one per
 * line — e.g. `Co-Authored-By: Name <address>`. Only well-formed single-line `Token: value`
 * trailers are kept; anything else is dropped rather than breaking the commit's trailer block.
 */
export const DELIVER_TRAILERS_ENV = 'WICKED_CREW_DELIVER_TRAILERS';
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: \S.*$/;

/** The configured trailers, validated; `[]` when none. */
export function configuredTrailers(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[DELIVER_TRAILERS_ENV];
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/[\u0000-\u001f\u007f]/.test(l) && TRAILER_LINE.test(l) && l.length <= 200);
}

/**
 * The environment variable naming the PUBLIC origin a PR's run link may use (crew#550 P-2) — the
 * studio address a reviewer can open (`https://studio.example.com`). Unset, a PR body names the run
 * id and carries no link: the daemon's own loopback address opens only on the daemon's host.
 */
export const PUBLIC_ORIGIN_ENV = 'WICKED_CREW_PUBLIC_ORIGIN';

/** The configured public origin, or `null`. */
export function configuredPublicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[PUBLIC_ORIGIN_ENV]?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * `s` as ONE URL path segment, RFC 3986 strict: everything but unreserved characters is
 * percent-encoded — `encodeURIComponent` alone leaves `!'()*` alone, and `'` in particular must not
 * reach a single-quoted shell literal (the deliver script bakes this in; Copilot on #525).
 */
export function urlPathSegment(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Is `host` (as `URL.hostname` spells it) the local machine — `127.0.0.0/8`, `::1`, `localhost`? */
function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The run link for a PR body under the configured PUBLIC origin ({@link configuredPublicOrigin}),
 * or null (crew#550 P-2). Never a loopback URL: `http://127.0.0.1:<port>/runs/<id>` opens only on
 * the daemon's own host, so a PR carrying it gave every other reader a dead link. A loopback,
 * unparseable or non-http(s) origin yields no link; the run id itself is always named in the text.
 */
export function runUrlFor(origin: string | null | undefined, runId: string): string | null {
  if (origin === null || origin === undefined || origin === '') return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (isLoopbackHost(url.hostname)) return null;
  return `${origin.replace(/\/+$/, '')}/runs/${urlPathSegment(runId)}`;
}

// ── evaluator follow-ups (crew#550 P-7) ────────────────────────────────────────────────────────

/** At most this many follow-ups ride a PR body; each is cut to {@link FOLLOW_UP_MAX_CHARS}. */
export const FOLLOW_UPS_MAX = 10;
export const FOLLOW_UP_MAX_CHARS = 300;

/** The heading an evaluator writes its residuals under: `FOLLOW-UPS:`, `Follow-ups:`, `## Follow ups`. */
const FOLLOW_UPS_HEADING = /^\s*(?:#{1,6}\s*)?\**\s*follow[- ]?ups?\s*\**\s*:?\s*\**\s*(.*)$/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/;
const NONE_WORD = /^(?:none|n\/a|nothing|no follow[- ]?ups?)\.?$/i;

/**
 * The follow-ups an evaluator's output flags (crew#550 P-7): the list under its `FOLLOW-UPS:`
 * heading (or the heading line's own text), ending at the first line that is neither an item nor
 * the continuation of one. `none` / `n/a` yields nothing. Every block in the text is read, in order,
 * de-duplicated, capped at {@link FOLLOW_UPS_MAX}.
 */
export function extractFollowUps(text: string): string[] {
  const out: string[] = [];
  const push = (item: string): void => {
    const t = item.replace(/\s+/g, ' ').trim();
    if (t === '' || NONE_WORD.test(t) || out.includes(t) || out.length >= FOLLOW_UPS_MAX) return;
    out.push(t);
  };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = FOLLOW_UPS_HEADING.exec(lines[i]!);
    if (head === null) continue;
    const inline = head[1]!.trim();
    if (inline !== '') push(inline);
    let current: string | null = null;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      const item = LIST_ITEM.exec(line);
      if (item !== null) {
        if (current !== null) push(current);
        current = item[1]!;
      } else if (line.trim() === '') {
        if (current !== null || inline !== '') break; // a blank line after the list ends it
      } else if (current !== null && /^\s{2,}\S/.test(line)) {
        current += ` ${line.trim()}`; // an indented continuation of the item
      } else {
        break;
      }
    }
    if (current !== null) push(current);
    i = j - 1;
  }
  return out;
}

// ── seat reports (crew#860) ────────────────────────────────────────────────────────────────────

/** How much of one seat's report rides a PR body (characters); the run record has the rest. */
export const REPORT_MAX_CHARS = 4_000;
/** At most this many reports ride a PR body (one per creator / evaluator unit, by ord). */
export const REPORTS_MAX = 6;

/**
 * The heading that OPENS a seat's final report — the governed-worker output contract's sections
 * ("What you did", "Commands run", "Counts", "Findings", "Open questions") and the shapes seats
 * actually write them in (`## What I did`, `**Commands run:**`, `Done-when`, `Evidence`, `Summary`).
 */
const REPORT_HEADING = /^\s*(?:#{1,6}\s*|\*\*|\d+[.)]\s*|[-*]\s*)*\s*(?:what (?:you|i|we) did|what (?:was|has been) done|what changed|commands? run|commands? executed|counts?|findings?|done[- ]when|evidence|open questions?|summary|report|verification|results?)\b/i;
/** The evaluator's contract line — stated separately by the composer, never repeated in the report. */
const VERDICT_LINE = /^\s*verdict:\s*(pass|fail)\s*$/i;

/**
 * A seat's final REPORT from its captured output (crew#860): the text from the first report heading
 * ({@link REPORT_HEADING}) to the end — the output contract puts the report LAST, after the work —
 * or, when no heading is found, the tail of the output (its last 40 lines), said so. `VERDICT:`
 * lines are removed (the composer states the recorded verdict beside the phase). Headings are
 * demoted below the body's own `##` / `###` so the report cannot restyle the PR; an unclosed code
 * fence is closed so it cannot swallow the footer; control characters are dropped; the result is
 * cut at a line boundary inside {@link REPORT_MAX_CHARS} and the cut is disclosed. `null` when the
 * output carries nothing reportable (empty, or whitespace only).
 */
export function extractUnitReport(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .split('\n')
    .filter((l) => !VERDICT_LINE.test(l));
  let start = lines.findIndex((l) => REPORT_HEADING.test(l));
  let note: string | null = null;
  if (start < 0) {
    start = Math.max(0, lines.length - 40);
    note = '_(no report headings found in the output — its last lines follow)_';
  }
  let block = lines.slice(start).join('\n').trim();
  if (block === '') return null;
  // Below the body's `### <phase>` heading: `#`/`##`/`###` → `####`.
  block = block.replace(/^#{1,3}(?=\s)/gm, '####');
  let cut = false;
  if (block.length > REPORT_MAX_CHARS) {
    const head = block.slice(0, REPORT_MAX_CHARS);
    const nl = head.lastIndexOf('\n');
    block = (nl > REPORT_MAX_CHARS / 2 ? head.slice(0, nl) : head).trimEnd();
    cut = true;
  }
  // An odd number of fences would leave the rest of the PR body inside a code block.
  if ((block.match(/^\s*```/gm) ?? []).length % 2 === 1) block += '\n```';
  const parts = [block];
  if (cut) parts.push('', '_(cut here — the full report is on the run record)_');
  if (note !== null) parts.unshift(note, '');
  return parts.join('\n');
}

/**
 * The seats' reports for a run (crew#860), one per creator / evaluator unit in ord order, read
 * through `readOutput` (the adapter's `workOutput`, injected so the composer stays pure). A unit
 * whose output cannot be read or carries nothing reportable contributes nothing; the result is
 * `[]` when nothing was reportable, never `undefined` — the caller says "could not read" only when
 * it has no reader at all.
 */
export async function reportsFromOutputs(
  view: SessionView,
  readOutput: (unit: WorkUnit) => Promise<string | null>,
): Promise<DeliverReportFact[]> {
  const units = [...view.units]
    .filter((u) => u.role === 'creator' || u.role === 'evaluator')
    .sort((a, b) => a.ord - b.ord);
  const out: DeliverReportFact[] = [];
  for (const u of units) {
    if (out.length >= REPORTS_MAX) break;
    let text: string | null = null;
    try {
      text = await readOutput(u);
    } catch {
      text = null;
    }
    const report = extractUnitReport(text);
    if (report === null) continue;
    const exits = extractRecipeExits(text);
    out.push({
      phase: phaseIdOf(u),
      seat: seatOf(u),
      role: u.role as 'creator' | 'evaluator',
      report,
      ...(exits.length > 0 ? { exits } : {}),
    });
  }
  return out;
}

/** `exit 0`, `exit code: 1`, `exit=2`, `exited 0`, `(exit 0)` — the exit code a seat pasted. */
const EXIT_WORD = /\bexit(?:ed)?(?:\s*code)?\s*[:=]?\s*(-?\d{1,3})\b/i;
/** `` `cmd` → 0 `` / `` `cmd` -> 0 `` / `` `cmd`: 0 `` — the arrow shapes after a code span. */
const ARROW_EXIT = /^\s*(?:→|->|=>|:|—|–)\s*(-?\d{1,3})\b/;
/** `` | `cmd` | 0 | `` — a table row whose next cell is a bare exit code. */
const TABLE_EXIT = /^\s*\|\s*(-?\d{1,3})\s*\|/;
const CODE_SPAN = /`([^`\n]{2,200})`/;

/**
 * The commands a seat's output says it ran, with the exit code it pasted beside each (crew#860) —
 * the "Commands run (with exit codes)" half of the governed-worker output contract, in the shapes
 * seats write it: `` - `npm run lint` → exit 0 ``, `` | `npx vitest run` | 0 | ``, `typecheck: exit 0`.
 * A line counts only when it names BOTH a command (a code span, else the list item's text before
 * the exit word) and an exit code; deduplicated by command (the LAST report wins — a re-run
 * supersedes), at most {@link RECIPE_EXITS_MAX}. Never throws; `[]` when nothing parses.
 */
export function extractRecipeExits(text: string | null | undefined): DeliverRecipeExit[] {
  if (text === null || text === undefined) return [];
  const found = new Map<string, number>();
  for (const raw of text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').split('\n')) {
    const span = CODE_SPAN.exec(raw);
    let command: string | null = null;
    let exit: number | null = null;
    if (span !== null) {
      command = span[1]!.trim();
      const after = raw.slice(span.index + span[0].length);
      const m = EXIT_WORD.exec(after) ?? ARROW_EXIT.exec(after) ?? TABLE_EXIT.exec(after);
      if (m !== null) exit = Number(m[1]);
    } else {
      const m = EXIT_WORD.exec(raw);
      if (m !== null) {
        const head = raw
          .slice(0, m.index)
          .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
          .replace(/[\s(:—–,-]+$/, '')
          .trim();
        if (head !== '' && head.length <= 120 && !/^(?:all|every|each)\b/i.test(head)) {
          command = head;
          exit = Number(m[1]);
        }
      }
    }
    if (command === null || exit === null || command === '' || !Number.isFinite(exit)) continue;
    const key = oneLine(command).slice(0, 120);
    found.delete(key);
    found.set(key, exit);
  }
  return [...found.entries()].slice(-RECIPE_EXITS_MAX).map(([command, exit]) => ({ command, exit }));
}
