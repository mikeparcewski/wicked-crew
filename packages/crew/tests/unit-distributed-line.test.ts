// wicked-core#590 S5: a `unitDistributed` frame is narrated by ONE helper that branches on
// `routingMethod`. A `teamed` frame (the S5 engine's every seated unit — no council convened,
// `agreementPct` / `returned` / `seated` / `dissent` all `null`) must never read as a council pick;
// the council wording is reserved for recorded `council` / `degraded` frames, and the
// `evaluator_distinct` / `tool` frames keep the wording they had.
import { describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import { unitDistributedLine } from '../src/interactive/council-outcome.js';

const distributed = (extra: Record<string, unknown>): CoreEvent =>
  ({ type: 'unitDistributed', session: 's', ord: 2, cli: 'claude', ...extra }) as unknown as CoreEvent;

// The engine's bytes for a teamed frame, verbatim (`tests/wire-contract.test.ts` pins the shape).
const TEAMED = distributed({
  routingMethod: 'teamed',
  agreementPct: null,
  returned: null,
  seated: null,
  dissent: null,
  degradedReason: null,
  seatConstraint: null,
  distinctnessFallback: null,
});

describe('unitDistributedLine (wicked-core#590 S5)', () => {
  it('narrates a teamed frame as a routing, with no council or agreement language', () => {
    const line = unitDistributedLine(TEAMED, 'for outline');
    expect(line).toBe('Routed claude for outline…');
    expect(line).not.toMatch(/council/i);
    expect(line).not.toMatch(/agreement/i);
    expect(line).not.toMatch(/picked/i);
  });

  it('reads the snake_case spelling of routingMethod too (a normalising relay)', () => {
    expect(unitDistributedLine(distributed({ routing_method: 'teamed' }), 'to write the draft')).toBe(
      'Routed claude to write the draft…',
    );
  });

  it('keeps the degradedReason on a teamed frame — the eligible set can still be smaller than the roster', () => {
    const line = unitDistributedLine(
      distributed({ routingMethod: 'teamed', degradedReason: '4 of 5 seats benched: codex (signed out — launcher)' }),
      'for outline',
    );
    expect(line).toBe('Routed claude for outline (4 of 5 seats benched: codex (signed out — launcher))…');
    expect(line).not.toMatch(/council/i);
  });

  it('keeps the council wording for a recorded council frame, agreement and all', () => {
    expect(
      unitDistributedLine(distributed({ routingMethod: 'council', agreementPct: 100, seated: 5, returned: 5 }), 'for outline'),
    ).toBe('Council picked claude for outline (100% agreement)…');
    expect(
      unitDistributedLine(distributed({ routingMethod: 'council', agreementPct: 60, seated: 5, returned: 2 }), 'to rework 3 targeted blocks'),
    ).toBe('Council picked claude to rework 3 targeted blocks (60% agreement) (2 of 5 seats answered — 3 benched)…');
  });

  it('keeps the council wording for a degraded frame and for an older frame with no routingMethod', () => {
    expect(
      unitDistributedLine(
        distributed({ routingMethod: 'degraded', degradedReason: 'no seat returned a vote; first roster seat' }),
        'for outline',
      ),
    ).toBe('Council picked claude for outline (no seat returned a vote; first roster seat)…');
    expect(unitDistributedLine(distributed({ agreement_pct: 100 }), 'for outline')).toBe(
      'Council picked claude for outline (100% agreement)…',
    );
  });

  it('keeps the wording evaluator_distinct and tool frames had', () => {
    expect(unitDistributedLine(distributed({ routingMethod: 'evaluator_distinct', cli: 'codex' }), 'for review')).toBe(
      'Council picked codex for review…',
    );
    expect(unitDistributedLine(distributed({ routingMethod: 'tool', cli: 'node' }), 'for outline')).toBe(
      'Council picked node for outline…',
    );
  });

  it('falls back to "a worker" when the frame names no cli', () => {
    expect(unitDistributedLine(distributed({ routingMethod: 'teamed', cli: undefined }), 'for outline')).toBe(
      'Routed a worker for outline…',
    );
  });
});
