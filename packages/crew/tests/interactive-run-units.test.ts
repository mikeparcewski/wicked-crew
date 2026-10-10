// crew#935 (X-MIG M9): the interactive seams narrate the run's PLANNED units, not a def. The
// engine announces each new unit with `unitPlanned`; a re-plan announces only the units it adds and
// moves the later ones down, so the fold inserts at the ord and shifts.

import { describe, expect, it } from 'vitest';

import type { CoreAdapter } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { awaitingHumanLine, describeStep, plannedUnitOf, plannedUnitsOfRun, resyncRunUnits, ResyncGate, RunUnits } from '../src/interactive/run-units.js';

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

describe('the fold re-read from the run, and the paused-run line', () => {
  it('plannedUnitsOfRun: ord order, step id after `<run>:`, a tool_cmd unit is a tool', () => {
    expect(
      plannedUnitsOfRun('r', [
        { id: 'r:revise', ord: 2, role: 'creator' },
        { id: 'r:pa-scope', ord: 1, role: null },
        { id: 'r:verify', ord: 3, role: 'neutral', tool_cmd: ['node', 'v.js'] },
      ]),
    ).toEqual([
      { id: 'pa-scope', role: 'neutral', tool: false },
      { id: 'revise', role: 'creator', tool: false },
      { id: 'verify', role: 'neutral', tool: true },
    ]);
  });
  it('resyncRunUnits drops a unit a gate edit removed (no frame announces a removal)', async () => {
    const u = new RunUnits();
    for (const [ord, id, role] of [[1, 'pa-scope', 'neutral'], [2, 'understand', 'neutral'], [3, 'revise', 'creator']] as const) {
      u.observe(planned(ord, id, role));
    }
    const adapter = {
      sessionsDetail: async () => [
        { session: { id: 'other' }, units: [{ id: 'other:x', ord: 1 }] },
        { session: { id: 'r' }, units: [{ id: 'r:pa-scope', ord: 1, role: 'neutral' }, { id: 'r:revise', ord: 2, role: 'creator' }] },
      ],
    } as unknown as CoreAdapter;
    await resyncRunUnits(adapter, 'r', u);
    expect(u.idAt(2)).toBe('revise');
    expect(u.isWriter(2)).toBe(true);
    expect(u.position(2)).toBe('2/2');
    // An engine that cannot answer leaves the fold as it was.
    await resyncRunUnits({} as CoreAdapter, 'r', u);
    await resyncRunUnits({ sessionsDetail: async () => { throw new Error('boom'); } } as unknown as CoreAdapter, 'r', u);
    expect(u.position(2)).toBe('2/2');
  });
  it('awaitingHumanLine names the plan approval (or the step) and where to answer', () => {
    const u = new RunUnits();
    u.observe(planned(2, 'revise', 'creator'));
    expect(awaitingHumanLine({ type: 'awaitingHuman', ord: 1, prompt: 'Approve?', gateKind: 'plan_approval' } as CoreEvent, 'run-9', u)).toBe(
      'The run is paused: the plan needs approval before the work starts (Approve?). Answer it on run run-9 (studio → Runs); the document lands after that.',
    );
    const long = awaitingHumanLine({ type: 'awaitingHuman', ord: 2, prompt: 'x'.repeat(400), gateKind: 'escalation' } as CoreEvent, 'run-9', u);
    expect(long).toContain('revise needs a person');
    expect(long.length).toBeLessThan(300);
  });
});

describe('ResyncGate (codex r2 on crew#938)', () => {
  it('a run\'s frames after `resumed` wait for the re-read, then replay in order; other runs pass through', async () => {
    const seen: string[] = [];
    const u = new RunUnits();
    u.observe(planned(1, 'pa-scope', 'neutral'));
    u.observe(planned(2, 'design', 'neutral'));
    u.observe(planned(3, 'draft', 'creator'));
    let release!: () => void;
    const refresh = new Promise<void>((r) => { release = r; });
    const gate = new ResyncGate((e) => seen.push(`${String(e.session)}:${e.type}:${u.idAt(typeof e.ord === 'number' ? e.ord : 0)}`));
    gate.hold('r', refresh.then(() => u.replace([{ id: 'pa-scope', role: 'neutral', tool: false }, { id: 'draft', role: 'creator', tool: false }])));
    gate.deliver({ type: 'unitDispatched', session: 'r', ord: 2 } as CoreEvent);
    gate.deliver({ type: 'unitDispatched', session: 'other', ord: 1 } as CoreEvent);
    expect(seen).toEqual(['other:unitDispatched:pa-scope']);
    release();
    await refresh;
    await new Promise((r) => setTimeout(r, 0));
    // The held dispatch narrates the REFRESHED ord 2 (the gate edit dropped `design`).
    expect(seen).toEqual(['other:unitDispatched:pa-scope', 'r:unitDispatched:draft']);
    gate.deliver({ type: 'unitDone', session: 'r', ord: 2 } as CoreEvent);
    expect(seen.at(-1)).toBe('r:unitDone:draft');
  });
});
