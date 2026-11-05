/**
 * The steering rules a governed run is checked against (operator ruling 2026-11-05, end-to-end pass E7: "validate them
 * via third party", not creator citations). A workflow launch's brief gains a marked block listing the rules in force
 * for the run's project, severity-ordered and capped, so every unit's description, the reviewer's brief and the gate
 * judge's criterion carry them. The review and QE seats judge each one (garden's governed-worker E7: KEPT / BROKEN /
 * N/A / DEFERRED, a broken rule fails review); the builder is told it does not mark its own compliance.
 *
 * Like the learnings block (`learnings/recall.ts`), the deliver text takes it back out (`core/deliver-text.ts`) and a
 * relaunch from an earlier run's problem replaces it, never stacks it. Nothing here records a verdict: per-rule
 * verdicts in the assurance receipt are DES-rule-check (post-mvp).
 */

import type { ConformanceRule } from '../core/types.js';
import { orderBySeverity, RULES_STATEMENT_CAP } from './rules-text.js';
import { inertIssueText } from '../core/linked-issues.js';

export const RULES_BRIEF_OPEN = '<!-- wicked-crew:rules -->';
export const RULES_BRIEF_CLOSE = '<!-- /wicked-crew:rules -->';
/** The rule lines' total budget (xreview r1/r2): a statement is listed WHOLE or not at all (never cut, so no
 *  obligation or exception is lost); rules past the budget are counted in "N more", and the block stays far under the
 *  128 KiB single-argument limit of the host floor's argv prompt. */
const MAX_RULE_LINES_CHARS = 16_000;
/** A listable id: one token of at most 120 characters (the `[rule:<id>]` citation's own bound), never mangled. */
const LISTABLE_ID = /^[^\s<>]{1,120}$/u;

/** A statement as one brief line: whitespace folded first, then every HTML-comment opener made inert (the linked
 *  issues' invariant), so no spelling of a daemon marker survives into the brief (xreview r1). */
function ruleLine(r: Pick<ConformanceRule, 'id' | 'severity' | 'statement'>): string {
  const folded = r.statement.replace(/\s+/gu, ' ').trim();
  return `- ${r.id} (${r.severity}): ${inertIssueText(folded).replaceAll('-->', '--&gt;')}`;
}

/** The marked block, or `null` when no rule is in force. An id that is not one bounded token is not listed (it is
 *  counted with the rest), so the block stays bounded and every listed id is the rule's own. */
export function rulesBriefBlock(rules: ReadonlyArray<Pick<ConformanceRule, 'id' | 'severity' | 'statement'>>): string | null {
  const ordered = orderBySeverity(rules).filter((r) => LISTABLE_ID.test(r.id) && r.statement.trim() !== '');
  if (ordered.length === 0) return null;
  const shown: string[] = [];
  let used = 0;
  for (const r of ordered) {
    if (shown.length >= RULES_STATEMENT_CAP) break;
    const line = ruleLine(r);
    if (used + line.length > MAX_RULE_LINES_CHARS) continue;
    shown.push(line);
    used += line.length + 1;
  }
  if (shown.length === 0) return null;
  const more = rules.length - shown.length;
  return [
    RULES_BRIEF_OPEN,
    'Steering rules in force for this project. The review and QE steps check the work against each one (kept, broken',
    'or not applicable, with evidence); a broken rule fails review. The step that builds does not mark its own compliance.',
    ...shown,
    ...(more > 0 ? [`- … and ${more} more rule${more === 1 ? '' : 's'} in force, not listed here.`] : []),
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

/** Append the block to a launch's problem (an inherited block is replaced). Unchanged when no rule is in force. */
export function withRulesBrief(raw: string, rules: ReadonlyArray<Pick<ConformanceRule, 'id' | 'severity' | 'statement'>>): { problem: string; listed: number } {
  const problem = stripRulesBrief(raw);
  const block = rulesBriefBlock(rules);
  if (block === null) return { problem, listed: 0 };
  return { problem: `${problem.trimEnd()}\n\n${block}`, listed: block.split('\n').filter((l) => l.startsWith('- ') && !l.startsWith('- … and')).length };
}
