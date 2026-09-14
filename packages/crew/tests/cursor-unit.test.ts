// The cursor unit both stall paths share (`core/cursor.ts`): the automatic escalation's
// `listExecuting` mapper (`api/server.ts`) and the manual `POST /runs/:id/reassign` lever
// (`api/routes.ts`). DES-L3 addendum §7 (10): `resolveCursorUnit` reports `executor: 'tool'` iff the
// cursor unit carries a non-null `tool_cmd` — the fact PR-L3-W's whole notify-instead-of-reassign
// arm keys on, and the one a wrong field name would ship green (the arms are otherwise only ever
// driven from hand-built literals).
import { describe, expect, it } from 'vitest';
import { resolveCursorUnit } from '../src/core/cursor.js';
import type { SessionView } from '../src/core/types.js';

/** A run view with `unit_ix` and units exactly as the engine's DTO carries them. */
function view(
  unitIx: number,
  units: Array<{ ord: number; cli?: string | null; tool_cmd?: string[] | null; role?: string }>,
): SessionView {
  return {
    session: { id: 'r-1', status: 'executing', unit_ix: unitIx },
    units: units.map((u, i) => ({
      id: `r-1:u${i}`,
      ord: u.ord,
      assigned_cli: u.cli ?? null,
      ...(u.tool_cmd !== undefined ? { tool_cmd: u.tool_cmd } : {}),
      ...(u.role !== undefined ? { role: u.role } : {}),
    })),
  } as unknown as SessionView;
}

describe('resolveCursorUnit — executor (DES-L3 addendum §7 (10), crew #580 / #581)', () => {
  it("is 'tool' iff the cursor unit's tool_cmd is non-null", () => {
    expect(resolveCursorUnit(view(0, [{ ord: 1, tool_cmd: ['bash', '-lc', 'deliver'] }]))?.executor).toBe('tool');
    // An EMPTY array is still a tool unit: the engine spells "no tool" as null, not as [].
    expect(resolveCursorUnit(view(0, [{ ord: 1, tool_cmd: [] }]))?.executor).toBe('tool');
    expect(resolveCursorUnit(view(0, [{ ord: 1, tool_cmd: null, cli: 'claude' }]))?.executor).toBe('agent');
    // Absent entirely (an older engine's unit DTO) reads as an agent unit — today's ladder.
    expect(resolveCursorUnit(view(0, [{ ord: 1, cli: 'claude' }]))?.executor).toBe('agent');
  });

  it('judges the CURSOR, not the run: a tool unit elsewhere in the plan does not make the cursor a tool', () => {
    // Units out of order with ords ≠ indexes, the way the engine stores them: unit_ix 1 of
    // ords [2,4,6] is ord 4 — the agent unit — even though ord 6 is the deliver script.
    const v = view(1, [
      { ord: 6, tool_cmd: ['bash', '-lc', 'deliver'] },
      { ord: 2, cli: 'claude' },
      { ord: 4, cli: 'codex', role: 'evaluator' },
    ]);
    expect(resolveCursorUnit(v)).toEqual({ ord: 4, cli: 'codex', executor: 'agent', role: 'evaluator' });
  });

  it('carries the cursor seat and role through, and omits both when the engine has not assigned them', () => {
    expect(resolveCursorUnit(view(0, [{ ord: 3, cli: null, tool_cmd: ['x'] }]))).toEqual({ ord: 3, executor: 'tool' });
    expect(resolveCursorUnit(view(0, [{ ord: 3, cli: 'pi', role: 'creator' }]))).toEqual({
      ord: 3,
      cli: 'pi',
      executor: 'agent',
      role: 'creator',
    });
  });

  it('a view with no units, or a unit_ix naming none, has no cursor at all', () => {
    expect(resolveCursorUnit(view(0, []))).toBeUndefined();
    expect(resolveCursorUnit(view(7, [{ ord: 1, cli: 'claude' }]))).toBeUndefined();
  });
});
