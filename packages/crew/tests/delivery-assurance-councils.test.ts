// wicked-core#888 — a post-hoc delivery's aggregated receipt keeps WHO decided the run's disputes:
// every council a unit's gate receipt recorded (its seats and the draw's seed), in unit order.
import { describe, expect, it } from 'vitest';
import { aggregateReceipt } from '../src/api/delivery-assurance.js';
import type { SessionView } from '../src/core/types.js';

const council = (seats: string[], seed: number) => ({
  verdict: 'yes',
  agreementPct: 100,
  dissent: 0,
  seats,
  seed,
  reason: null,
});

const receipt = (councils?: ReturnType<typeof council>[]) => ({
  mode: 'full',
  required: ['distinct_evaluator', 'judge'],
  ran: ['distinct_evaluator'],
  skipped: [],
  creator: 'claude',
  evaluator: 'codex',
  judge: null,
  tree: null,
  attempt: 1,
  ...(councils !== undefined ? { councils } : {}),
});

function viewOf(units: unknown[]): SessionView {
  return {
    session: { id: 'run-1', assurance: { mode: 'full', required: ['distinct_evaluator', 'judge'] } },
    units,
  } as unknown as SessionView;
}

describe('aggregateReceipt carries the run councils (wicked-core#888)', () => {
  it('lists every council of every gate, in unit order, with seats and seed', () => {
    const r = aggregateReceipt(
      viewOf([
        { ord: 2, assurance: receipt([council(['pi', 'opencode', 'copilot'], 7)]) },
        { ord: 1, assurance: receipt([council(['codex', 'pi', 'opencode'], 42)]) },
        { ord: 3, assurance: receipt() },
      ]),
      'tree-1',
    );
    expect(r?.councils).toEqual([
      council(['codex', 'pi', 'opencode'], 42),
      council(['pi', 'opencode', 'copilot'], 7),
    ]);
  });

  it('a run that convened no council has no councils key (the routine case)', () => {
    const r = aggregateReceipt(viewOf([{ ord: 1, assurance: receipt() }]), null);
    expect(r).not.toBeNull();
    expect(r && 'councils' in r).toBe(false);
  });
});
