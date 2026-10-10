// crew#928 (wicked-core#854, #846): the plan-refusal tokens and the writes-nothing step fact, typed
// in `wicked-crew-api-types`. The values below are typed against the published contract, so this
// file is a COMPILE-TIME assertion enforced by `tsc --noEmit -p tsconfig.test.json`
// (`npm run typecheck`); the runtime `it` blocks keep the guard visible in the test run. The
// reason strings are the engine's own `PlanRefusal` Display text (`<token>: <detail>`).

import { describe, expect, it } from 'vitest';
import type { PlanRefusalToken, PresetStep, TeamPlanRefusedPayload, TeamPlanStep } from 'wicked-crew-api-types';

const capture: TeamPlanStep = { catalog: 'produce', id: 'capture', writes_nothing: true };
const propose: PresetStep = { catalog: 'produce', id: 'propose', writes_nothing: true };
const tokens: PlanRefusalToken[] = ['security_review_on_non_code_plan', 'writes_nothing_on_code', 'pool_raised'];

const refused: TeamPlanRefusedPayload = {
  run_id: 'r1',
  ord: null,
  attempt: null,
  by: 'engine',
  at: 1760100000000,
  re: null,
  proposal_id: 'p-1',
  base_rev: 1,
  reason:
    'security_review_on_non_code_plan: step security_review is a security_review in a plan where no step executes code ' +
    '(rule TST-1002 requires it)',
};

/** The token a skin keys on, searched for (an error message prefixes context; some reasons are prose). */
const tokenOf = (text: string): PlanRefusalToken | null =>
  /\b(security_review_on_non_code_plan|writes_nothing_on_code|pool_raised)\b/.exec(text)?.[1] ?? null;

describe('plan refusal wire (crew#928)', () => {
  it('types writes_nothing on plan and preset steps', () => {
    expect(capture.writes_nothing).toBe(true);
    expect(propose.writes_nothing).toBe(true);
  });
  it('a refusal reason starts with its stable token', () => {
    expect(tokens).toContain(tokenOf(refused.reason));
    // A preview error carries the same text behind a context prefix; a plain-text reason has no token.
    expect(tokenOf(`the plan is refused: ${refused.reason}`)).toBe('security_review_on_non_code_plan');
    expect(tokenOf('override in auto mode')).toBeNull();
    expect(refused.reason).toMatch(/rule TST-1002 requires it/);
  });
});
