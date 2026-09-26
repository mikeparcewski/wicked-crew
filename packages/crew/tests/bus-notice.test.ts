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

// wicked-core#631: an engine without Core.busEmit/busRead leaves every bus seam off — said on
// /health.warnings, not only on the console.
import { afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { createServer } from '../src/api/server.js';
import { removeScratch } from './setup/scratch.js';

describe('an engine without busEmit/busRead (wicked-core#631)', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach(removeScratch));

  it('puts "bus seams off" on /health.warnings', async () => {
    const proto = (createRequire(import.meta.url)('wicked-core-ts') as { Core: { prototype: Record<string, unknown> } }).Core.prototype;
    const saved = { busEmit: proto['busEmit'], busRead: proto['busRead'] };
    const savedBus = process.env['WICKED_BUS_DB'];
    const dir = mkdtempSync(join(tmpdir(), 'bus-seams-off-'));
    dirs.push(dir);
    delete proto['busEmit'];
    delete proto['busRead'];
    let adapter: CoreAdapter | undefined;
    try {
      adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true, busDbPath: join(dir, 'bus.db') });
    } finally {
      Object.assign(proto, saved);
    }
    try {
      const app = await createServer(adapter, { auditPath: join(dir, 'audit.log') });
      try {
        const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
        const warnings = (res.json() as { warnings?: Array<{ kind: string; message: string }> }).warnings ?? [];
        const off = warnings.find((w) => w.kind === 'bus.seams_off');
        expect(off?.message).toMatch(/^bus seams off: engine lacks busEmit\/busRead/);
        expect(off?.message).toContain(join(dir, 'bus.db'));
      } finally {
        await app.close();
      }
    } finally {
      adapter.close();
      if (savedBus === undefined) delete process.env['WICKED_BUS_DB'];
      else process.env['WICKED_BUS_DB'] = savedBus;
    }
  });
});
