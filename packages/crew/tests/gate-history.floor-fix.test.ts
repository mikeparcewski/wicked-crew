// crew#891 (wicked-core#782 / #811): the engine records a floor fix — an approve with a note at a
// read-only phase's floor gate, which a distinct seat makes before only the floor re-runs — as the
// answer action `floor_fix`. The decided-gate history reads it as what it is: an approve.

import { describe, expect, it } from 'vitest';
import { decisionOf } from '../src/standing-orders/history.js';

describe('decisionOf — the floor_fix answer (crew#891)', () => {
  it('reads a floor_fix answer as an approve', () => {
    expect(decisionOf({ ord: 4, approve: true, action: 'floor_fix', amend: 'fix the lint error in src/a.ts' })).toBe('approve');
  });

  it('reads the approve-with-note that armed it (no action on the request) as an approve', () => {
    expect(decisionOf({ ord: 4, approve: true, amend: 'fix the lint error in src/a.ts' })).toBe('approve');
  });

  it('keeps the four named arms as recorded', () => {
    expect(decisionOf({ approve: false, action: 'request_changes' })).toBe('request_changes');
    expect(decisionOf({ approve: false, action: 'reject' })).toBe('reject');
    expect(decisionOf({ approve: true, action: 'edit_plan' })).toBe('edit_plan');
    expect(decisionOf({ approve: true, action: 'approve' })).toBe('approve');
  });

  it('reads an unknown token by its approve flag, so a refusal never reads as an approve', () => {
    expect(decisionOf({ approve: false, action: 'floor_fix_v2' })).toBe('reject');
  });
});
