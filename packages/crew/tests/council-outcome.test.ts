// F-4R2-007: the narrator is honest about a council that held on a fraction of its seats. The
// engine's wire spelling is camelCase (`CoreEvent::to_json`); snake_case is read too.

import { describe, expect, it } from 'vitest';

import { councilAgreementPct, councilOutcomeSuffix } from '../src/interactive/council-outcome.js';
import type { CoreEvent } from '../src/core/types.js';

const distributed = (extra: Record<string, unknown>): CoreEvent =>
  ({ type: 'unitDistributed', session: 's', ord: 1, cli: 'claude', routingMethod: 'council', ...extra }) as CoreEvent;

describe('councilOutcomeSuffix', () => {
  it('is empty for a whole council with no engine reason', () => {
    expect(councilOutcomeSuffix(distributed({ seated: 5, returned: 5, degradedReason: null }))).toBe('');
    expect(councilOutcomeSuffix(distributed({ seated: null, returned: null, degradedReason: null }))).toBe('');
    // A tool-routed unit carries nulls everywhere — nothing to say.
    expect(councilOutcomeSuffix(distributed({ routingMethod: 'tool', seated: null, returned: null }))).toBe('');
  });

  it('says how many seats answered when fewer ballots returned than seats were convened (the fresh-rig shape)', () => {
    expect(councilOutcomeSuffix(distributed({ seated: 5, returned: 1, degradedReason: null }))).toBe(
      ' (1 of 5 seats answered — 4 benched)',
    );
    expect(councilOutcomeSuffix(distributed({ seated: 5, returned: 2, degradedReason: null }))).toBe(
      ' (2 of 5 seats answered — 3 benched)',
    );
  });

  it('quotes the engine\'s degradedReason when it sets one, alone or beside the seat count', () => {
    expect(councilOutcomeSuffix(distributed({ seated: null, returned: null, degradedReason: 'no seat returned a vote; first roster seat' }))).toBe(
      ' (no seat returned a vote; first roster seat)',
    );
    expect(
      councilOutcomeSuffix(distributed({ seated: 5, returned: 1, degradedReason: '4 of 5 seats benched: codex, pi, copilot, opencode' })),
    ).toBe(' (1 of 5 seats answered — 4 benched; 4 of 5 seats benched: codex, pi, copilot, opencode)');
  });

  it('reads the snake_case spellings too, so a normalising relay cannot silence the line', () => {
    expect(councilOutcomeSuffix(distributed({ seated: 3, returned: 1, degraded_reason: 'x' }))).toBe(' (1 of 3 seats answered — 2 benched; x)');
    expect(councilAgreementPct(distributed({ agreementPct: 100 }))).toBe(100);
    expect(councilAgreementPct(distributed({ agreement_pct: 60 }))).toBe(60);
    expect(councilAgreementPct(distributed({ agreementPct: null }))).toBeNull();
  });
});
