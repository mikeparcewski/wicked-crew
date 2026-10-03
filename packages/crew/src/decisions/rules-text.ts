/**
 * How seats learn the rules (DES-decision-capture §4.7, DC-S7) — the text halves, pure.
 *
 *  - The chat scope statement lists the chat project's in-force rules as `[rule:<id>] statement`
 *    lines, severity-ordered and capped at {@link RULES_STATEMENT_CAP}.
 *  - A rule remembered mid-chat reaches the seats as a crew-authored `wicked-context` preface on
 *    the next send, disclosed to the operator as a `system` transcript record.
 *
 * Both tell the seat to cite a rule it follows as `[rule:<id>]`, and both say what crew does with
 * that: shows it as cited — unchecked. Nothing here (and nothing anywhere in crew) turns a citation into
 * a compliance verdict; that belongs to DES-rule-check (B4).
 */

import type { ConformanceRule } from '../core/types.js';

export const RULES_STATEMENT_CAP = 20;

const SEVERITY_RANK: Record<ConformanceRule['severity'], number> = { critical: 0, error: 1, warn: 2, info: 3 };

/** Severity first (critical → info), then id — a stable order a seat and an operator both read. */
export function orderBySeverity<T extends Pick<ConformanceRule, 'id' | 'severity'>>(rules: ReadonlyArray<T>): T[] {
  return [...rules].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function oneLine(statement: string): string {
  return statement.replace(/\s+/gu, ' ').trim();
}

/** The `## Rules in force` section of the scope statement (no trailing blank line). */
export function rulesStatementLines(rules: ReadonlyArray<ConformanceRule>): string[] {
  const ordered = orderBySeverity(rules);
  const shown = ordered.slice(0, RULES_STATEMENT_CAP);
  const lines = [
    '## Rules in force',
    '',
    "These steering rules apply here. Where you follow one, cite it as `[rule:<id>]`; crew shows it",
    'as cited — unchecked (a citation, never a verdict).',
    '',
    ...shown.map((r) => `- [rule:${r.id}] ${oneLine(r.statement)}`),
  ];
  if (ordered.length > shown.length) {
    const more = ordered.length - shown.length;
    lines.push(`- … and ${more} more rule${more === 1 ? '' : 's'} (ask for them if a step turns on one).`);
  }
  return lines;
}

/** The preface a send carries when rules landed since the seats last heard from crew. */
export function rulesPreface(rules: ReadonlyArray<ConformanceRule>): string {
  const ordered = orderBySeverity(rules);
  return [
    '<wicked-context>',
    `Rule${ordered.length === 1 ? '' : 's'} remembered since your last message (cite as [rule:<id>] where you follow one):`,
    ...ordered.map((r) => `- [rule:${r.id}] ${oneLine(r.statement)}`),
    '</wicked-context>',
  ].join('\n');
}
