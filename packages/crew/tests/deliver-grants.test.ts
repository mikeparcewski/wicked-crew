// crew#1885: who may read a run's delivery text with no operator bearer: that run's own deliver script, by the nonce
// its command carries (the engine-run phase) or one a post-hoc delivery registered while it runs.

import { describe, expect, it } from 'vitest';
import { deliverTextAllowed, grantPostHocDeliverText } from '../src/core/deliver-grants.js';
import { deliverPrScript } from '../src/core/deliver.js';

const RUN = 'run-1885';
const NONCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

describe('deliver text grants (crew#1885)', () => {
  it('allows the nonce an in-flight unit of the run declares in the command the composer writes, in either case, and no other', () => {
    const cmd = ['bash', '-lc', deliverPrScript('ship it', { runId: RUN, nonce: NONCE, apiOrigin: 'http://127.0.0.1:7701' })];
    const units = [{ status: 'done', tool_cmd: null }, { status: 'done', tool_cmd: ['wicked-crew', 'insights', 'facts'] }, { status: 'distributed', tool_cmd: cmd }];
    expect(deliverTextAllowed(RUN, units, NONCE)).toBe(true);
    expect(deliverTextAllowed(RUN, units, NONCE.toUpperCase())).toBe(true);
    expect(deliverTextAllowed(RUN, [{ status: 'pending', tool_cmd: cmd }], NONCE)).toBe(true);
    expect(deliverTextAllowed(RUN, units, OTHER)).toBe(false);
    expect(deliverTextAllowed(RUN, units, NONCE.slice(0, 16))).toBe(false);
    expect(deliverTextAllowed(RUN, [{ status: 'distributed', tool_cmd: null }, { status: 'distributed' }, { status: 'distributed', tool_cmd: [] }], NONCE)).toBe(false);
  });

  it("stops allowing a unit's nonce once the unit is done: the script prints it in its exit sentinel (crew#739)", () => {
    const cmd = ['bash', '-lc', deliverPrScript('ship it', { runId: RUN, nonce: NONCE, apiOrigin: 'http://127.0.0.1:7701' })];
    for (const status of ['done', 'rejected', 'failed', 'cancelled', null, undefined]) {
      expect(deliverTextAllowed(RUN, [{ status, tool_cmd: cmd }], NONCE), String(status)).toBe(false);
    }
  });

  it('allows a post-hoc nonce for its run only, while it is held, counting overlapping holds', () => {
    expect(deliverTextAllowed(RUN, [], NONCE)).toBe(false);
    const first = grantPostHocDeliverText(RUN, NONCE);
    const second = grantPostHocDeliverText(RUN, NONCE.toUpperCase());
    expect(deliverTextAllowed(RUN, [], NONCE)).toBe(true);
    expect(deliverTextAllowed('another-run', [], NONCE)).toBe(false);
    first();
    first(); // a release is idempotent: the second hold still stands
    expect(deliverTextAllowed(RUN, [], NONCE)).toBe(true);
    second();
    expect(deliverTextAllowed(RUN, [], NONCE)).toBe(false);
  });
});
