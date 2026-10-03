/**
 * `deterministic:warned_rule` (DES-trigger-registry §4.3 row 7 "risky-call", §4.4; TR-W6).
 *
 * Steering already has the never-blocking class: a rule with `effect: warn` fires and is RECORDED on
 * the decision without blocking, and (TR-W2) the gate fold replays every fired rule id on
 * `governanceHookFired.firedPolicies`, whatever the decision. This check projects that: for each
 * fired id whose rule is `warn`, one flag naming the rule — the operator asked to be told, not
 * stopped. There is no second matcher; the rule's effect is read from the store the daemon already
 * holds (`ctx.rules`, the registry's bounded snapshot of `listConformanceRules`).
 *
 * §7: the row names the rule ID and the tool, never the rule's text and never the command — a
 * steering statement can be the operator's own words, and no operator text rides the bus. Studio
 * resolves the id to the rule.
 *
 * Decisions: `deny` is the engine's own record (not this row). `allow` and `allow_with_conditions`
 * both carry fired warn rules (the entry's filter is "any decision but deny").
 *
 * Timing: `governanceHookFired` is emitted at gate time, not live, so the flag appears when the unit
 * reaches its gate — acceptable for an advisory flag (§4.3 row 7). Coverage: an engine whose frames
 * carry no `firedPolicies` is "too old"; a store that cannot be read is "not readable".
 */

import { z } from 'zod';
import type { CheckOutput, WatchCheck, WatchRuleBrief } from '../types.js';

interface Bag {
  /** Hook frames that carried `firedPolicies` (an array, possibly empty). */
  hooks: number;
  /** Hook frames from an engine before TR-W2 (no `firedPolicies`): this projection cannot tell. */
  silent: number;
  /** Frames that fired rules while the store could not be read. */
  unreadable: number;
  raised: Set<string>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Steering severity → watch severity: the flag is as loud as the rule asked to be. */
export function watchSeverityOf(ruleSeverity: string | undefined): 'high' | 'medium' | 'info' {
  switch (ruleSeverity) {
    case 'critical':
    case 'error':
      return 'high';
    case 'warn':
      return 'medium';
    default:
      return 'info';
  }
}

export const warnedRuleCheck: WatchCheck<Record<string, never>, Record<string, never>> = {
  name: 'deterministic:warned_rule',
  lane: 'deterministic',
  paramsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  thresholdSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  async evaluate(input, state, _params, _threshold, ctx) {
    const bag = (state.bag.get('warned') as Bag | undefined) ?? { hooks: 0, silent: 0, unreadable: 0, raised: new Set() };
    state.bag.set('warned', bag);
    if (input.type !== 'governanceHookFired') return [];
    const e = input.event;
    const decision = typeof e['decision'] === 'string' ? e['decision'] : '';
    if (decision === 'deny') return []; // the deny is the engine's own record; this row is the warn class
    const fired = e['firedPolicies'];
    if (!Array.isArray(fired)) {
      bag.silent++;
      return [];
    }
    bag.hooks++;
    const ids = [...new Set(fired.filter((x): x is string => typeof x === 'string' && x !== ''))];
    if (ids.length === 0) return [];
    let rules: ReadonlyMap<string, WatchRuleBrief> | null = null;
    try {
      rules = ctx.rules !== undefined ? await ctx.rules() : null;
    } catch {
      rules = null;
    }
    if (rules === null) {
      bag.unreadable++;
      return [];
    }
    const ord = num(e['ord']);
    const attempt = num(e['attempt']);
    const tool = typeof e['toolName'] === 'string' && e['toolName'] !== '' ? e['toolName'] : 'a tool';
    const out: CheckOutput[] = [];
    for (const id of ids) {
      const rule = rules.get(id);
      if (rule === undefined || rule.effect !== 'warn') continue;
      const subject = `${ord ?? '-'}:${attempt ?? '-'}:warned:${id}`;
      if (bag.raised.has(subject)) continue;
      bag.raised.add(subject);
      out.push({
        op: 'raise',
        subject,
        kind: 'flag',
        severity: watchSeverityOf(rule.severity),
        sentence: `A rule you asked to be warned about fired on ${tool}: ${id}.`,
        facts: { rule_id: id, tool, effect: 'warn', rule_severity: rule.severity, decision },
        ord,
        attempt,
        re: `governanceHookFired#${ord ?? '-'}:${attempt ?? '-'}`,
      });
    }
    return out;
  },
  coverage(state) {
    const bag = state.bag.get('warned') as Bag | undefined;
    if (bag !== undefined && bag.hooks > 0) {
      if (bag.unreadable > 0) return { state: 'not_checked', reason: 'the rule store could not be read, so fired rules could not be classified' };
      return { state: 'checked' };
    }
    if (bag !== undefined && bag.silent > 0) {
      return { state: 'not_checked', reason: 'the engine is too old to carry the fired rules (needs wicked-core-ts >= 0.7.35)' };
    }
    return { state: 'not_checked', reason: 'no governed tool call has reached a gate yet' };
  },
  describe: () => 'When a governed tool call fires a steering rule the operator asked to be warned about (effect: warn)',
};
