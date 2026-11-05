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

export const RULES_BRIEF_OPEN = '<!-- wicked-crew:rules -->';
export const RULES_BRIEF_CLOSE = '<!-- /wicked-crew:rules -->';
/** One rule line's longest statement. */
const MAX_RULE_CHARS = 300;

/** A statement as one brief line: whitespace folded, capped, never able to open or close the block. */
function ruleLine(r: Pick<ConformanceRule, 'id' | 'severity' | 'statement'>): string {
  const t = r.statement.replaceAll(RULES_BRIEF_OPEN, '').replaceAll(RULES_BRIEF_CLOSE, '').replace(/\s+/gu, ' ').trim();
  const s = t.length > MAX_RULE_CHARS ? `${t.slice(0, MAX_RULE_CHARS - 1)}…` : t;
  const id = r.id.replaceAll(RULES_BRIEF_OPEN, '').replaceAll(RULES_BRIEF_CLOSE, '').replace(/\s+/gu, '');
  return `- ${id} (${r.severity}): ${s}`;
}

/** The marked block, or `null` when no rule is in force. */
export function rulesBriefBlock(rules: ReadonlyArray<Pick<ConformanceRule, 'id' | 'severity' | 'statement'>>): string | null {
  const ordered = orderBySeverity(rules).filter((r) => r.id.trim() !== '' && r.statement.trim() !== '');
  if (ordered.length === 0) return null;
  const shown = ordered.slice(0, RULES_STATEMENT_CAP);
  const more = ordered.length - shown.length;
  return [
    RULES_BRIEF_OPEN,
    'Steering rules in force for this project. The review and QE steps check the work against each one (kept, broken',
    'or not applicable, with evidence); a broken rule fails review. The step that builds does not mark its own compliance.',
    ...shown.map(ruleLine),
    ...(more > 0 ? [`- … and ${more} more rule${more === 1 ? '' : 's'} in force (lower severity), not listed here.`] : []),
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
  return { problem: `${problem.trimEnd()}\n\n${block}`, listed: Math.min(rules.length, RULES_STATEMENT_CAP) };
}
