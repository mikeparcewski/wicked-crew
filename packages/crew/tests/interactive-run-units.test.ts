// crew#935 (X-MIG M9): the interactive seams narrate the run's PLANNED units, not a def. The
// engine announces each new unit with `unitPlanned`; a re-plan announces only the units it adds and
// moves the later ones down, so the fold inserts at the ord and shifts.

import { describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import { describeStep, plannedUnitOf, RunUnits } from '../src/interactive/run-units.js';

const planned = (ord: number, id: string, role: string, executorType = 'agent'): CoreEvent =>
  ({ type: 'unitPlanned', session: 'r', ord, description: `${id} — the intent ||| do it`, role, executorType }) as unknown as CoreEvent;

describe('plannedUnitOf', () => {
  it('reads the step id off the description, the role and whether it is a tool unit', () => {
    expect(plannedUnitOf(planned(2, 'draft', 'creator'))).toEqual({ ord: 2, unit: { id: 'draft', role: 'creator', tool: false } });
    expect(plannedUnitOf(planned(3, 'verify', 'neutral', 'tool'))?.unit.tool).toBe(true);
    // A description with no intent is the bare step id.
    expect(plannedUnitOf({ type: 'unitPlanned', ord: 1, description: 'pa-scope' } as CoreEvent)?.unit).toEqual({ id: 'pa-scope', role: 'neutral', tool: false });
  });
  it('ignores every other frame and a malformed one', () => {
    expect(plannedUnitOf({ type: 'unitDispatched', ord: 1 } as CoreEvent)).toBeNull();
    expect(plannedUnitOf({ type: 'unitPlanned', ord: 0, description: 'x' } as CoreEvent)).toBeNull();
    expect(plannedUnitOf({ type: 'unitPlanned', ord: 1, description: '  ' } as CoreEvent)).toBeNull();
  });
});

describe('RunUnits', () => {
  it('counts the planned units, not a def: pa-scope + the creator + the floor critique', () => {
    const u = new RunUnits();
    expect(u.position(1)).toBe('1'); // nothing planned yet: no denominator is invented
    expect(u.observe(planned(1, 'pa-scope', 'neutral'))).toBe(true);
    u.observe(planned(2, 'draft', 'creator'));
    expect(u.position(2)).toBe('2/2');
    expect(u.isWriter(2)).toBe(true);
    expect(u.isWriter(1)).toBe(false);
    // The re-plan after the PA's rating inserts the floor's design step BEFORE the creator and its
    // critique after: the creator moves to ord 3 without being re-announced.
    u.observe(planned(2, 'design', 'neutral'));
    u.observe(planned(4, 'critique', 'evaluator'));
    expect([1, 2, 3, 4].map((o) => u.idAt(o))).toEqual(['pa-scope', 'design', 'draft', 'critique']);
    expect(u.isWriter(3)).toBe(true);
    expect(u.isEvaluator(4)).toBe(true);
    expect(u.position(3)).toBe('3/4');
    expect(u.observe({ type: 'unitDispatched', ord: 3 } as CoreEvent)).toBe(false);
  });
  it('a tool unit is never the writer, and an unplanned ord reads as its number', () => {
    const u = new RunUnits();
    u.observe(planned(1, 'verify', 'creator', 'tool'));
    expect(u.isTool(1)).toBe(true);
    expect(u.isWriter(1)).toBe(false);
    expect(u.idAt(5)).toBe('phase 5');
    expect(u.position(5)).toBe('5/5');
  });
  it('a re-announced unit moves, never duplicates', () => {
    const u = new RunUnits();
    u.observe(planned(1, 'a', 'neutral'));
    u.observe(planned(2, 'b', 'creator'));
    u.observe(planned(1, 'b', 'creator'));
    expect([1, 2].map((o) => u.idAt(o))).toEqual(['b', 'a']);
  });
  it('the PA step says what it does', () => {
    expect(describeStep('pa-scope')).toMatch(/rating the ask/);
    expect(describeStep('outline')).toBe('outline');
  });
});
