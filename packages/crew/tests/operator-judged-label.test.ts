// (operator ruling 2026-10-11) The PR body's phase table says "judged by operator (<who>)" for a
// gate the operator judged because no judge could rule (core-ts ≥ 0.9.7 `assurance.operatorJudges`).
import { describe, expect, it } from 'vitest';
import { operatorJudgedLabel } from '../src/core/deliver-text.js';

describe('operatorJudgedLabel', () => {
  it('names who judged', () => {
    expect(
      operatorJudgedLabel({ assurance: { operatorJudges: [{ by: 'coordinator (agent)', at: 1, note: null, reason: null }] } }),
    ).toBe('judged by operator (coordinator (agent))');
  });
  it('is null for an ordinary gate', () => {
    expect(operatorJudgedLabel({ assurance: { ran: ['judge'] } })).toBeNull();
    expect(operatorJudgedLabel({})).toBeNull();
  });
});
