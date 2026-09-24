// DES-TEAMING-002 T0 — the bus.unavailable notice words each failure kind correctly (review round 3).
import { describe, expect, it } from 'vitest';

import { busUnavailableWarning } from '../src/core/bus-notice.js';

describe('busUnavailableWarning', () => {
  it('probe_open: crew could not open the file — a path/permissions remedy', () => {
    const w = busUnavailableWarning({ dbPath: '/x/bus.db', reason: 'ENOTDIR', kind: 'probe_open' });
    expect(w).toEqual({
      kind: 'bus.unavailable',
      severity: 'warning',
      message:
        'bus unavailable: cannot open /x/bus.db (ENOTDIR) — the engine runs without a bus (un-teamed); ' +
        'fix the path or its permissions and restart the daemon',
    });
  });

  it('bridge_not_armed: the file opened, the engine could not arm its bridge — no path/permissions claim', () => {
    const w = busUnavailableWarning({
      dbPath: '/x/bus.db',
      reason: 'bus db /x/bus.db did not answer within 2s (locked or slow)',
      kind: 'bridge_not_armed',
    });
    expect(w).toEqual({
      kind: 'bus.unavailable',
      severity: 'warning',
      message:
        'bus unavailable: the engine could not arm its bus bridge on /x/bus.db ' +
        '(bus db /x/bus.db did not answer within 2s (locked or slow)) — it launches nothing from the bus; ' +
        'find what holds the bus file locked or slow, then restart the daemon',
    });
  });
});
