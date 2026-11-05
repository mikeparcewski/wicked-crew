/**
 * The steering rules a governed run is checked against (operator ruling 2026-11-05, end-to-end pass E7: "validate them
 * via third party", not creator citations; DES-RULE-CHECK-001 S1: "cutting off isn't an option").
 *
 * A workflow launch's brief gains a marked block that names EVERY rule in force for the run's project, each with its
 * match against the job (the engine's `matchRules`): **applies** (a fact selects it), **may apply** (nothing scopes
 * it either way), or **not applicable** (a recorded fact rules it out, said on its line). Rules to check are listed
 * with their statements whole and no count cap; not-applicable rules are listed by id with their fact, so none is
 * silent. The review and QE seats judge each rule to check (garden's governed-worker E7: KEPT / BROKEN / N/A /
 * DEFERRED, a broken rule fails review); the builder is told it does not mark its own compliance.
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
 * The whole block's size in UTF-8 bytes (headers, ids, statements, facts). The engine puts the task and the earlier
 * steps' output (up to 96 KiB) into one argv argument under the host floor's 128 KiB limit (core
 * `execute_wrapped.rs`), so the block keeps to 24 KiB and leaves room for the intent (xreview r2 on S1). Within it every
 * rule is named first; statements and facts are added while they fit.
 */
export const RULES_BLOCK_MAX_BYTES = 24 * 1024;
/** A listable id: one token of at most 120 characters (the `[rule:<id>]` citation's own bound). */
const LISTABLE_ID = /^[^\s<>"]{1,120}$/u;
/** A not-applicable line's fact, bounded (the facts name a rule's own `applies_to` tokens). */
const FACT_MAX = 400;

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

function factLine(m: RuleMatch): string {
  const words = inert(m.facts.map((f) => f.detail).join('; ')) || 'ruled out by its own scope';
  return words.length > FACT_MAX ? `${words.slice(0, FACT_MAX)}…` : words;
}

const LABEL: Record<RuleMatchStatus, string> = { applies: 'applies', may_apply: 'may apply', not_applicable: 'not applicable' };
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8') + 1; // + the newline

/**
 * The marked block, or `null` when no rule is in force. Every rule in `matches` is named on a line while the ids fit
 * {@link RULES_BLOCK_MAX_BYTES}: first every id (with its label), then, in reading order, the statements of the rules
 * to check and the facts of the rules ruled out, each added only while the block still fits. Should the ids alone
 * not fit (thousands of rules, or ids of thousands of characters), one line says how many were not named and that the
 * review reads every rule from the store, never silently. The brief is the builder's; the review's check (S2) reads
 * the store, not the brief.
 */
export function rulesBriefBlock(rules: ReadonlyArray<BriefRule>, matches: ReadonlyArray<RuleMatch>): string | null {
  if (matches.length === 0) return null;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const check = matches.filter((m) => m.status !== 'not_applicable');
  const na = matches.filter((m) => m.status === 'not_applicable');
  const applies = check.filter((m) => m.status === 'applies').length;
  const head = [
    RULES_BRIEF_OPEN,
    `Steering rules for this job: ${matches.length} in force, ${check.length} to check (${applies} apply, ${check.length - applies} may apply), ${na.length} not applicable.`,
    'The review and QE steps check the work against each rule to check (kept, broken or not applicable, with evidence);',
    'a broken rule fails review. The step that builds does not mark its own compliance.',
  ];
  const naHead = "Not applicable to this job, each by a fact of the rule's own scope:";
  // One row per rule: its bare line (label and id), and the full one (with the statement, or the fact).
  const rows = [
    ...check.map((m) => {
      const r = byId.get(m.rule_id);
      const bare = `- [${LABEL[m.status]}] ${shownId(m.rule_id)} (${r?.severity ?? 'info'})`;
      const statement = inert(r?.statement ?? '');
      const why = m.status === 'applies' ? ` (${factLine(m)})` : '';
      return { bare, full: `${bare}: ${statement === '' ? '(no statement recorded)' : statement}${why}`, na: false };
    }),
    ...na.map((m) => ({ bare: `- ${shownId(m.rule_id)}`, full: `- ${shownId(m.rule_id)}: ${factLine(m)}`, na: true })),
  ];
  const short = 'A rule listed without its statement or fact did not fit this brief\'s size limit; the review reads it from the rule store.';
  const pointer = (left: number) =>
    `- … and ${left} more rule${left === 1 ? '' : 's'} in force whose ids did not fit this brief's size limit; the review reads every rule from the rule store.`;
  const reserve = bytes(short) + bytes(pointer(rows.length));
  let used = head.reduce((n, l) => n + bytes(l), 0) + bytes(RULES_BRIEF_CLOSE) + (na.length > 0 ? bytes(naHead) : 0) + reserve;
  // Pass 1: every rule named while it fits (the pointer and the note reserved).
  // A row that does not fit is skipped, not the end: a later short id is still named (xreview r2 on S1).
  const fits = rows.filter((row) => {
    if (used + bytes(row.bare) > RULES_BLOCK_MAX_BYTES) return false;
    used += bytes(row.bare);
    return true;
  });
  const named = fits.length;
  // Pass 2: the full line, in reading order, while the block still fits.
  let anyBare = false;
  const shown = fits.map((row) => {
    const extra = bytes(row.full) - bytes(row.bare);
    if (used + extra <= RULES_BLOCK_MAX_BYTES) {
      used += extra;
      return { na: row.na, line: row.full };
    }
    anyBare = true;
    return { na: row.na, line: row.bare };
  });
  const checkLines = shown.filter((x) => !x.na).map((x) => x.line);
  const naLines = shown.filter((x) => x.na).map((x) => x.line);
  return [
    ...head,
    ...(anyBare ? [short] : []),
    ...checkLines,
    ...(naLines.length > 0 ? [naHead, ...naLines] : []),
    ...(named < rows.length ? [pointer(rows.length - named)] : []),
    RULES_BRIEF_CLOSE,
  ].join('\n');
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
