// DES-TEAMING-002 T0 — crew's side of the one-connection rule: the crew bus handle opens ONE
// long-lived better-sqlite3 connection per bus file per process and hands every caller that same one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { crewBusHandle, crewBusHandleOpens } from '../src/core/bus-handle.js';

describe('crew bus handle (T0 connection rule)', () => {
  it('opens once per file and hands every caller the same connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-bus-handle-'));
    try {
      const busPath = join(dir, 'bus.db');
      const before = crewBusHandleOpens();
      const a = crewBusHandle(busPath, { create: true });
      const b = crewBusHandle(join(dir, '.', 'bus.db'), { create: false });
      expect(b).toBe(a);
      expect(crewBusHandleOpens() - before).toBe(1);
      expect(a.prepare('PRAGMA journal_mode').all()).toEqual([{ journal_mode: 'wal' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a read route never creates the bus: a missing file throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-bus-handle-missing-'));
    try {
      expect(() => crewBusHandle(join(dir, 'absent.db'), { create: false })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
