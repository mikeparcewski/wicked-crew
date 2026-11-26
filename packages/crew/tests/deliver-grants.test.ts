// crew#1885: who may read a run's delivery text with no operator bearer: that run's own deliver script, by the nonce
// in the script crew composes for its dispatched deliver unit, or a post-hoc delivery's, registered with its text while
// it runs.

import { describe, expect, it } from 'vitest';
import { deliverTextAllowed, grantPostHocDeliverText, postHocDeliverText } from '../src/core/deliver-grants.js';
import { deliverPrScript } from '../src/core/deliver.js';
import { deliverableFloorPhase } from '../src/core/deliverable-floor.js';

const RUN = 'run-1885';
const NONCE = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';

/** The deliver unit as the engine holds it: `<run>:deliver`, running the script `deliverPrScript` writes. */
function deliverUnit(status: string | null | undefined, nonce = NONCE) {
  return {
    id: `${RUN}:deliver`,
    status,
    tool_cmd: ['bash', '-lc', deliverPrScript('ship it', { runId: RUN, nonce, apiOrigin: 'http://127.0.0.1:7701' })],
  };
}

describe('deliver text grants (crew#1885)', () => {
  it('allows the nonce of the dispatched deliver unit\'s script, in either case, and no other', () => {
    const units = [{ id: `${RUN}:fix`, status: 'done', tool_cmd: null }, deliverUnit('distributed')];
    expect(deliverTextAllowed(units, NONCE)).toBe(true);
    expect(deliverTextAllowed(units, NONCE.toUpperCase())).toBe(true);
    expect(deliverTextAllowed(units, OTHER)).toBe(false);
    expect(deliverTextAllowed(units, NONCE.slice(0, 16))).toBe(false);
    // Found by catalog entry too, as deliverUnitOf finds a deliver phase under another id.
    expect(deliverTextAllowed([{ ...deliverUnit('distributed'), id: `${RUN}:ship`, catalog: 'deliver' }], NONCE)).toBe(true);
  });

  it('counts only while the unit is dispatched: not before (pending from composition) and not once it is done (its exit sentinel printed the nonce, crew#739)', () => {
    for (const status of ['pending', 'done', 'rejected', 'failed', 'cancelled', null, undefined]) {
      expect(deliverTextAllowed([deliverUnit(status)], NONCE), String(status)).toBe(false);
    }
  });

  it('never reads a nonce out of another command: a deliverable path a worker declared, or a deliver-looking script on another unit (codex r1)', () => {
    // The real deliverable-floor command, whose argv carries the declared paths verbatim.
    const floor = deliverableFloorPhase([`/tmp/DELIVER_NONCE=${NONCE}`, `DELIVER_NONCE='${NONCE}'`], 1).executor;
    const floorCmd = floor !== undefined && floor.type === 'tool' ? floor.cmd : [];
    expect(floorCmd.join(' ')).toContain(`DELIVER_NONCE=${NONCE}`);
    expect(deliverTextAllowed([{ id: `${RUN}:verify-deliverables`, status: 'distributed', tool_cmd: floorCmd }], NONCE)).toBe(false);
    // The deliver unit, but not crew's script shape (another program, or the nonce not on a line of its own).
    expect(deliverTextAllowed([{ id: `${RUN}:deliver`, status: 'distributed', tool_cmd: floorCmd }], NONCE)).toBe(false);
    expect(deliverTextAllowed([{ id: `${RUN}:deliver`, status: 'distributed', tool_cmd: ['bash', '-lc', `echo DELIVER_NONCE='${NONCE}'`] }], NONCE)).toBe(false);
    expect(deliverTextAllowed([{ id: `${RUN}:deliver`, status: 'distributed', tool_cmd: ['sh', '-c', deliverUnit('distributed').tool_cmd[2]!] }], NONCE)).toBe(false);
    // Crew's script on a unit that is not the deliver phase.
    expect(deliverTextAllowed([{ ...deliverUnit('distributed'), id: `${RUN}:build` }], NONCE)).toBe(false);
  });

  it('answers a post-hoc delivery\'s own text for its run only, while it is held, counting overlapping holds', () => {
    expect(postHocDeliverText(RUN, NONCE)).toBeNull();
    const first = grantPostHocDeliverText(RUN, NONCE, 'title\n\nbody one\n');
    const second = grantPostHocDeliverText(RUN, NONCE.toUpperCase(), 'title\n\nbody two\n');
    expect(postHocDeliverText(RUN, NONCE)).toBe('title\n\nbody two\n');
    expect(postHocDeliverText(RUN, OTHER)).toBeNull();
    expect(postHocDeliverText('another-run', NONCE)).toBeNull();
    first();
    first(); // a release is idempotent: the second hold still stands
    expect(postHocDeliverText(RUN, NONCE)).not.toBeNull();
    second();
    expect(postHocDeliverText(RUN, NONCE)).toBeNull();
  });
});
