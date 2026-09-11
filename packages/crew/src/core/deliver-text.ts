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

import type { GateSpec, PhaseDef, SessionView, WorkUnit } from './types.js';

/** The PR title / commit subject cap — git's conventional subject width. */
export const DELIVER_TITLE_MAX = 72;

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

/** One repo check the verify phase ran (`typecheck` / `lint` / `test`), as the engine recorded it. */
export interface DeliverCheckFact {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
  spawnError: string | null;
}

/** An evaluator-role phase's recorded verdict. */
export interface DeliverVerdictFact {
  phase: string;
  seat: string | null;
  verdict: string;
  reason: string | null;
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
}

export interface DeliverText {
  /** ≤ {@link DELIVER_TITLE_MAX} characters, one line, never cut mid-word. */
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

/** The intent's first non-blank line as plain words, or `''`. */
function firstLine(intent: string): string {
  for (const raw of intent.split(/\r?\n/)) {
    const line = plainLine(raw);
    if (line !== '') return line;
  }
  return '';
}

/**
 * The PR title / commit subject: the intent's first line, whole when it fits, otherwise cut at the
 * last word boundary that leaves room for a single `…` — so the result is ≤ 72 characters and never
 * ends mid-word (the F-3R2-014 headline `…scenario CLN-2) aga`). Dangling punctuation before the
 * ellipsis is dropped. A blank intent names the run instead — through the SAME bounded cut, so a
 * long caller-supplied session id (the CLI passes `--session` through) is never cut mid-id either
 * (Copilot on #525): the body names the run id in full.
 */
export function deliverTitle(intent: string, runId: string): string {
  const line = firstLine(intent);
  // The run id is caller-supplied too (`LaunchSchema` only requires it non-empty): a newline in it
  // must not turn the title into two lines and break the framing (Copilot on #525).
  return boundedTitle(line === '' ? oneLine(`wicked-crew run ${oneLine(runId)}`) : line);
}

/** `line` whole when it fits, else cut at a word boundary with a single `…` — ≤ 72 characters. */
function boundedTitle(line: string): string {
  if (line.length <= DELIVER_TITLE_MAX) return line;
  const room = DELIVER_TITLE_MAX - 1; // one character is the ellipsis
  const head = line.slice(0, room + 1); // one past the room: a space HERE means the room ends a word
  const cut = head.lastIndexOf(' ');
  // A single 72+ character token has no boundary to cut at; then — and only then — it is cut hard.
  const kept = (cut > 0 ? head.slice(0, cut) : head.slice(0, room)).replace(/[\s,;:(\-–—]+$/u, '');
  return `${kept}…`;
}

// ── issue references ───────────────────────────────────────────────────────────────────────────

/** `fix issue #214`, `fixes #7`, `closes wicked-studio#3`, `resolved: #9` — a closing verb + a ref. */
const CLOSING_REF =
  /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b(?:\s+(?:issue|bug|for))?\s*:?\s*((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/gi;
/** Any `#N`, `repo#N` or `owner/repo#N` not glued to a word/path (so `a/b#1` is one ref, `#1a` none). */
const ANY_REF = /(?<![\w/#])((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/g;

/**
 * The issues the intent names, split into the ones it says it fixes and the rest.
 *
 * GitHub links and closes on `#N` (this repo) and `owner/repo#N` only. An OWNER-LESS `repo#N`
 * does neither — so when its repo segment names the delivery repo (`repoRef`, the registered
 * repo id the PR lands in) it is emitted as plain `#N` (review W3-K2: `fixes wicked-studio#214`
 * on a wicked-studio delivery must close #214). Any other owner-less `repo#N` rides verbatim as
 * information; `owner/repo#N` is left exactly as written.
 */
export function issueRefs(intent: string, repoRef?: string | null): IssueRefs {
  const normalize = (prefix: string | undefined, n: string): string => {
    if (prefix === undefined || prefix === '') return `#${n}`;
    if (!prefix.includes('/') && repoRef !== undefined && repoRef !== null && prefix === repoRef) return `#${n}`;
    return `${prefix}#${n}`;
  };
  const fixes: string[] = [];
  const refs: string[] = [];
  for (const m of intent.matchAll(CLOSING_REF)) {
    const ref = normalize(m[1], m[2]!);
    if (!fixes.includes(ref)) fixes.push(ref);
  }
  for (const m of intent.matchAll(ANY_REF)) {
    const ref = normalize(m[1], m[2]!);
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
export function composeDeliverText(f: DeliverTextFacts, links: IssueRefs = issueRefs(f.intent, f.repoRef)): DeliverText {
  const title = deliverTitle(f.intent, f.runId);
  const { fixes, refs } = links;
  const intent = f.intent.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, ' ').trim();
  const out: string[] = [];

  out.push('## Intent', '', intent === '' ? '_(the run recorded no intent)_' : intent, '');
  if (fixes.length > 0 || refs.length > 0) {
    for (const x of fixes) out.push(`Fixes ${x}`);
    if (refs.length > 0) out.push(`Refs: ${refs.join(', ')}`);
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
    out.push('| check | command | exit | duration |', '|---|---|---|---|');
    for (const c of f.checks) {
      out.push(`| ${cell(c.name)} | ${code(c.command)} | ${cell(exitLabel(c))} | ${duration(c.durationMs)} |`);
    }
  }
  out.push('');

  out.push('## Evaluator verdict', '');
  if (f.source === 'workflow') {
    out.push('_Not available at composition time — the run record has it._');
  } else if (f.verdicts.length === 0) {
    out.push('_This workflow has no evaluator phase._');
  } else {
    for (const v of f.verdicts) {
      const reason = v.reason !== null && v.reason.trim() !== '' ? ` — ${cell(v.reason, 400)}` : '';
      out.push(`- ${code(v.phase)} (${cell(v.seat ?? 'seat unknown')}): **${cell(v.verdict)}**${reason}`);
    }
  }
  out.push('');

  out.push(
    '---',
    '',
    `Delivered by ${FOOTER_LINK} run ${code(f.runId)}. Merge stays human: the phase opens the PR, never merges it.`,
  );
  return { title, body: out.join('\n') };
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
  return rc.checks.map((c) => ({
    name: c.name ?? '—',
    command: Array.isArray(c.argv) ? c.argv.join(' ') : '—',
    exitCode: typeof c.exit_code === 'number' ? c.exit_code : null,
    durationMs: typeof c.duration_ms === 'number' ? c.duration_ms : null,
    timedOut: c.timed_out === true,
    spawnError: typeof c.spawn_error === 'string' ? c.spawn_error : null,
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
 * `resolved.workflowId` is the DEFINITION the route resolved for the run (`resolveRunWorkflow`
 * over the full registry): the engine stores an instance id (`wf-<uuid>`) that `sessionsDetail()`
 * patches back to a name for BUILT-INS only, so a user-registered workflow would otherwise read as
 * `workflow wf-…` here. Absent, the view's id is used (with the per-run composition suffix cut).
 */
export function factsFromRun(
  view: SessionView,
  runUrl: string | null,
  resolved: { workflowId?: string | null } = {},
): DeliverTextFacts {
  const s = view.session;
  const units = [...view.units].sort((a, b) => a.ord - b.ord);
  const checks = units.flatMap(checksOf);
  return {
    runId: s.id,
    intent: s.problem ?? '',
    workflowId: resolved.workflowId ?? baseWorkflowId(s.workflow_id, s.id),
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
}): DeliverTextFacts {
  return {
    runId: input.runId,
    intent: input.intent ?? '',
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
  };
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
 * The studio bookmark for a run under a daemon origin (`http://127.0.0.1:7701/runs/<id>`), or
 * null. LOOPBACK ORIGINS ONLY (review W3-K4): a daemon bound to a LAN host or IP would otherwise
 * put that host into a public PR body; the run id itself is always named in the text.
 */
export function runUrlFor(origin: string | null | undefined, runId: string): string | null {
  if (origin === null || origin === undefined || origin === '') return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!isLoopbackHost(host)) return null;
  return `${origin.replace(/\/+$/, '')}/runs/${urlPathSegment(runId)}`;
}
