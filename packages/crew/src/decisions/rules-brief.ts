/**
 * The steering rules a governed run is checked against (operator ruling 2026-11-05, end-to-end pass E7: "validate them
 * via third party", not creator citations; DES-RULE-CHECK-001 S1: "cutting off isn't an option").
 *
 * A workflow launch's brief gains a marked block that names EVERY rule in force for the run's project, each with its
 * match against the job (the engine's `matchRules`): **applies** (a fact selects it), **may apply** (nothing scopes
 * it either way), or **not applicable** (a recorded fact rules it out). It is an index, not the rules: each rule to
 * check is one line of id, severity and the start of its statement ({@link ONE_LINER_MAX} characters, while the block
 * fits {@link RULES_BLOCK_MAX_BYTES}); a not-applicable rule is its id alone. One line names the exact command a seat
 * pulls a rule's whole statement with ({@link RULES_PULL_COMMAND}: `rules.recall` through garden's shim, which crew's
 * estate relay answers from the same in-force set the rule judge reads). Agents start with their prompt and tools and
 * pull what they need (operator, 2026-11-11): the statements are no longer pushed into every unit's prompt.
 * The review and QE seats judge each rule to check (garden's governed-worker E7: KEPT / BROKEN / N/A / DEFERRED /
 * UNASSESSED, a broken rule fails review); the builder is told it does not mark its own compliance.
 *
 * Like the learnings block (`learnings/recall.ts`), the deliver text takes it back out (`core/deliver-text.ts`) and a
 * relaunch from an earlier run's problem replaces it, never stacks it. Nothing here records a verdict: per-rule
 * verdicts in the assurance receipt are DES-RULE-CHECK-001 S2.
 */

import type { ConformanceRule } from '../core/types.js';
import { orderBySeverity } from './rules-text.js';
import { inertIssueText } from '../core/linked-issues.js';

export const RULES_BRIEF_OPEN = '<!-- wicked-crew:rules -->';
export const RULES_BRIEF_CLOSE = '<!-- /wicked-crew:rules -->';

/**
 * The whole block's size in UTF-8 bytes (headers, the pull command, ids, one-liners). The block rides in every unit's
 * prompt, so it is an index a seat pulls from, not the rules: every rule is named first; one-liners are added while
 * they fit.
 */
export const RULES_BLOCK_MAX_BYTES = 4 * 1024;
/** A rule's one-liner: the start of its statement, at most this many characters. */
export const ONE_LINER_MAX = 100;
/**
 * The exact command a seat pulls a rule's whole statement with: `rules.recall` through garden's read-only estate shim,
 * which crew's estate relay answers from the rules in force for the run's project (`mcp/estate-relay.ts`).
 */
export const RULES_PULL_COMMAND = `wicked-garden run scripts/_estate_client.py --readonly call '{"tool":"rules.recall","arguments":{"ids":["<id>"]}}'`;
/** A listable id: one token of at most 120 characters (the `[rule:<id>]` citation's own bound). */
const LISTABLE_ID = /^[^\s<>"]{1,120}$/u;

export type RuleMatchStatus = 'applies' | 'may_apply' | 'not_applicable';
export interface RuleMatchFact {
  kind: string;
  detail: string;
}
/** One rule's match (the engine's `matchRules` wire shape). */
export interface RuleMatch {
  rule_id: string;
  status: RuleMatchStatus;
  facts: RuleMatchFact[];
}

/** What a launch knows about the job when it matches the rules. */
export interface RuleMatchJob {
  workflow?: string | null;
  /** The job's steps as the gate sees them; a launch passes none (its steps are set with its plan). */
  steps?: Array<{ tokens: string[]; kind?: string | null }> | null;
  /** The step kinds the workflow runs (`build`, `test`, …), for the reading order only. */
  kinds?: string[] | null;
  project?: string | null;
  /** (DES-RULE-CHECK-001, coord E7 rerun) The job's repository: a rule that names it applies. */
  repo?: string | null;
}

type BriefRule = Pick<ConformanceRule, 'id' | 'severity' | 'statement'> & Partial<ConformanceRule>;

const UNMATCHED: RuleMatchFact = { kind: 'unmatched', detail: 'the engine did not match it; the review checks it' };

/**
 * Every rule matched, none dropped: the engine's answer in its order, and any rule it did not answer for (an addon
 * without `matchRules`, a failure, a short answer) as "may apply". `match` is the engine binding or `null`.
 */
export async function matchRulesForJob(
  rules: ReadonlyArray<BriefRule>,
  job: RuleMatchJob,
  match: ((argsJson: string) => Promise<string>) | null,
  log?: (m: string) => void,
): Promise<RuleMatch[]> {
  let answered: RuleMatch[] = [];
  if (match !== null && rules.length > 0) {
    try {
      const out = JSON.parse(await match(JSON.stringify({ rules, job }))) as { matches?: unknown };
      if (Array.isArray(out.matches)) {
        answered = out.matches.filter(
          (m): m is RuleMatch =>
            m !== null &&
            typeof m === 'object' &&
            typeof (m as RuleMatch).rule_id === 'string' &&
            ['applies', 'may_apply', 'not_applicable'].includes((m as RuleMatch).status) &&
            Array.isArray((m as RuleMatch).facts),
        );
      }
    } catch (err) {
      log?.(`[rules] the engine could not match the rules; every rule is listed as may apply: ${err instanceof Error ? err.message : String(err)}`);
      answered = [];
    }
  }
  const known = new Set(rules.map((r) => r.id));
  const seen = new Set<string>();
  const out: RuleMatch[] = [];
  for (const m of answered) {
    if (!known.has(m.rule_id) || seen.has(m.rule_id)) continue;
    seen.add(m.rule_id);
    out.push(m);
  }
  for (const r of orderBySeverity(rules)) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push({ rule_id: r.id, status: 'may_apply', facts: [UNMATCHED] });
    }
  }
  return out;
}

/** Text that cannot open or close a daemon marker: whitespace folded first, then every `<!--` and `-->` made inert. */
function inert(text: string): string {
  return inertIssueText(text.replace(/\s+/gu, ' ').trim()).replaceAll('-->', '--&gt;');
}

/**
 * An id as listed: the id itself when it is one bounded token, else the id whole as a JSON string with `<` and `>`
 * escaped (`\u003c`, `\u003e`), so it stays reversible, distinct from every other id, and cannot form a marker
 * (xreview r1 on S1: truncating or folding merged distinct ids).
 */
function shownId(id: string): string {
  if (LISTABLE_ID.test(id)) return id;
  return JSON.stringify(id).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
}

/** The start of a statement, on one line, at most {@link ONE_LINER_MAX} characters (an ellipsis says it was cut). */
function oneLiner(statement: string): string {
  const words = inert(statement);
  const chars = [...words];
  return chars.length > ONE_LINER_MAX ? `${chars.slice(0, ONE_LINER_MAX - 1).join('').trimEnd()}…` : words;
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8') + 1; // + the newline

/**
 * The marked block, or `null` when no rule is in force: a count line, who checks what, the pull command, then every
 * rule in `matches` on a line while the ids fit {@link RULES_BLOCK_MAX_BYTES}: first every id (with its severity),
 * then, in reading order, each rule-to-check's one-liner while the block still fits. Not-applicable rules are listed
 * by id. Should the ids alone not fit (hundreds of rules, or ids of thousands of characters), one line says how many
 * were not named and how to pull them all, never silently.
 */
export function rulesBriefBlock(rules: ReadonlyArray<BriefRule>, matches: ReadonlyArray<RuleMatch>): string | null {
  if (matches.length === 0) return null;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const groups: Array<{ head: string; ms: RuleMatch[]; na: boolean }> = [
    { head: 'Applies to this job:', ms: matches.filter((m) => m.status === 'applies'), na: false },
    { head: 'May apply:', ms: matches.filter((m) => m.status === 'may_apply'), na: false },
    { head: "Not applicable to this job (a fact of the rule's own scope rules it out):", ms: matches.filter((m) => m.status === 'not_applicable'), na: true },
  ].filter((g) => g.ms.length > 0);
  const na = matches.filter((m) => m.status === 'not_applicable').length;
  const applies = matches.filter((m) => m.status === 'applies').length;
  const check = matches.length - na;
  const head = [
    RULES_BRIEF_OPEN,
    `Steering rules for this job: ${matches.length} in force, ${check} to check (${applies} apply, ${check - applies} may apply), ${na} not applicable. Each is listed by id (severity): the start of its statement.`,
    'The review and QE steps check the work against each rule to check (kept, broken or not applicable, with evidence);',
    'a broken rule fails review. The step that builds does not mark its own compliance.',
    `Pull a rule's whole statement before you judge it (several ids at once; no "ids" lists every rule in force): ${RULES_PULL_COMMAND}`,
  ];
  // One row per rule: its bare line (id and severity), and the full one (with its one-liner, rules to check only).
  const rows = groups.flatMap((g, gi) =>
    g.ms.map((m) => {
      const r = byId.get(m.rule_id);
      const bare = g.na ? `- ${shownId(m.rule_id)}` : `- ${shownId(m.rule_id)} (${r?.severity ?? 'info'})`;
      const line = oneLiner(r?.statement ?? '');
      return { gi, bare, full: g.na ? bare : `${bare}: ${line === '' ? '(no statement recorded)' : line}` };
    }),
  );
  const pointer = (left: number) =>
    `- … and ${left} more rule${left === 1 ? '' : 's'} in force whose ids did not fit this brief's size limit; pull them with the command above, without "ids" (page with "limit" and "offset").`;
  // The close marker is the last line: no newline follows it.
  let used = head.reduce((n, l) => n + bytes(l), 0) + Buffer.byteLength(RULES_BRIEF_CLOSE, 'utf8') + groups.reduce((n, g) => n + bytes(g.head), 0);
  // The pointer is reserved only when the ids alone do not all fit (xreview: reserving it anyway dropped ids that fit).
  if (used + rows.reduce((n, row) => n + bytes(row.bare), 0) > RULES_BLOCK_MAX_BYTES) used += bytes(pointer(rows.length));
  // Pass 1: every rule named while it fits. A row that does not fit is skipped, not the end: a later short id is still
  // named (xreview r2 on S1).
  const fits = rows.filter((row) => {
    if (used + bytes(row.bare) > RULES_BLOCK_MAX_BYTES) return false;
    used += bytes(row.bare);
    return true;
  });
  // Pass 2: the one-liner, in reading order, while the block still fits.
  const shown = fits.map((row) => {
    const extra = bytes(row.full) - bytes(row.bare);
    if (extra > 0 && used + extra <= RULES_BLOCK_MAX_BYTES) {
      used += extra;
      return { gi: row.gi, line: row.full };
    }
    return { gi: row.gi, line: row.bare };
  });
  const body = groups.flatMap((g, gi) => {
    const lines = shown.filter((x) => x.gi === gi).map((x) => x.line);
    return lines.length > 0 ? [g.head, ...lines] : [];
  });
  return [...head, ...body, ...(fits.length < rows.length ? [pointer(rows.length - fits.length)] : []), RULES_BRIEF_CLOSE].join('\n');
}

/** `problem` with every rules block the daemon appended taken back out. */
export function stripRulesBrief(problem: string): string {
  let out = problem;
  for (let at = out.indexOf(RULES_BRIEF_OPEN); at !== -1; at = out.indexOf(RULES_BRIEF_OPEN)) {
    const end = out.indexOf(RULES_BRIEF_CLOSE, at);
    const tail = end === -1 ? '' : out.slice(end + RULES_BRIEF_CLOSE.length);
    out = `${out.slice(0, at).trimEnd()}${tail}`;
  }
  return out;
}

/** Append the block to a launch's problem (an inherited block is replaced). Unchanged when no rule is in force.
 *  `listed` counts the rules to check; `notApplicable` the rules listed as ruled out. */
export function withRulesBrief(
  raw: string,
  rules: ReadonlyArray<BriefRule>,
  matches: ReadonlyArray<RuleMatch>,
): { problem: string; listed: number; notApplicable: number } {
  const problem = stripRulesBrief(raw);
  const block = rulesBriefBlock(rules, matches);
  if (block === null) return { problem, listed: 0, notApplicable: 0 };
  const notApplicable = matches.filter((m) => m.status === 'not_applicable').length;
  return { problem: `${problem.trimEnd()}\n\n${block}`, listed: matches.length - notApplicable, notApplicable };
}
