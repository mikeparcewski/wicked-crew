// (operator ruling 2026-10-11) opencode is OPT-IN: the default launch roster leaves it out, the
// roster marks it for the launch wizard, and an explicit pick still carries it.
import { describe, expect, it } from 'vitest';
import { defaultLaunchRoster, isOptInSeat, markOptIn, OPT_IN_NOTE } from '../src/core/opt-in-seats.js';

const roster = [{ key: 'claude' }, { key: 'opencode' }, { key: 'pi' }, { key: 'opencode#2' }];

describe('opt-in seats', () => {
  it('the default launch roster leaves every opencode instance out', () => {
    expect(defaultLaunchRoster(roster).map((s) => s.key)).toEqual(['claude', 'pi']);
  });
  it('GET /roster marks it opt-in with the one-line note; other seats unchanged', () => {
    const marked = markOptIn(roster);
    expect(marked[1]).toEqual({ key: 'opencode', optIn: true, optInNote: OPT_IN_NOTE });
    expect(marked[0]).toEqual({ key: 'claude' });
    expect(OPT_IN_NOTE).toBe('opt-in: known to stall');
  });
  it('only opencode is opt-in', () => {
    expect(['claude', 'codex', 'pi', 'copilot'].some(isOptInSeat)).toBe(false);
    expect(isOptInSeat('opencode')).toBe(true);
  });
});
