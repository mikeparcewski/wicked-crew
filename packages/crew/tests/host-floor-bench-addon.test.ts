// wicked-core#976 against the REAL installed wicked-core-ts (≥ 0.12.1, pinned): the production
// adapter methods on the host floor and on the container floor. The engine reads WICKED_SEAT_FLOOR
// (and the operator's clis.toml under HOME) at call time, so both are pinned per test.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { toEngineSeat } from '../src/core/engine-roster.js';

const KEYS = ['WICKED_SEAT_FLOOR', 'WICKED_CODEX_WORKTREE_OK', 'HOME', 'USERPROFILE'] as const;
let saved: Record<string, string | undefined> = {};
let home = '';

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'crew-hostfloor-'));
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  delete process.env['WICKED_CODEX_WORKTREE_OK'];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

type Seat = Record<string, unknown> & { key: string };
const roster = (): Seat[] => CoreAdapter.roster() as Seat[];
const custom = (key: string, invocation: string): Seat => ({ ...roster().find((s) => s.key === 'pi')!, key, binary: key, headless_invocation: invocation });

describe('the real engine launch bench, split by the adapter', () => {
  it('host floor: every seat but claude and a bounded codex is host-benched; worktreeBenched keeps meaning codex', () => {
    process.env['WICKED_SEAT_FLOOR'] = 'host';
    const loose = { ...roster().find((s) => s.key === 'codex')!, key: 'codex#2', headless_invocation: 'codex --yolo exec {PROMPT}' };
    const seats = [...roster(), custom('smoke-judge', 'smoke-judge {PROMPT}'), loose];
    const host = CoreAdapter.hostFloorBenched(seats)!;
    expect(host).not.toBeNull();
    expect(host.has('claude')).toBe(false);
    expect(host.has('codex')).toBe(false);
    for (const k of ['smoke-judge', 'codex#2', ...roster().map((s) => s.key).filter((k) => !['claude', 'codex'].includes(k) && !k.startsWith('claude'))]) {
      expect(host.get(k), k).toMatch(/runs only on the container floor/);
    }
    // The bound read: the codex worktree bench only — no host-floor entry leaks into it, and a codex
    // seat both rules name carries the worktree reason (it binds every call).
    const worktree = CoreAdapter.worktreeBenched(seats)!;
    expect([...worktree.keys()].sort()).toEqual(['codex', 'codex#2']);
    for (const why of worktree.values()) expect(why).toMatch(/approval request failed/);
  });

  it('container floor: no host-floor bench, no worktree bench', () => {
    process.env['WICKED_SEAT_FLOOR'] = 'container';
    const seats = [...roster(), custom('smoke-judge', 'smoke-judge {PROMPT}')];
    expect(CoreAdapter.hostFloorBenched(seats)).toEqual(new Map());
    expect(CoreAdapter.worktreeBenched(seats)).toEqual(new Map());
  });

  for (const floor of ['host', 'container']) {
    it(`${floor} floor: the roster's council standing and the engine health it becomes are unchanged`, () => {
      process.env['WICKED_SEAT_FLOOR'] = floor;
      const over = (withHostBench: boolean) =>
        rosterWithStandingFactory({
          seatHealth: new SeatHealthTracker(),
          registry: () => roster(),
          signedIn: () => true,
          env: { WICKED_WORKER_HOME: '', WICKED_SEAT_FLOOR: floor },
          probe: null,
          versions: null,
          versionPins: null,
          worktreeBench: (s) => CoreAdapter.worktreeBenched(s),
          hostFloorBench: withHostBench ? (s) => CoreAdapter.hostFloorBenched(s) : null,
          qeAdmitted: () => true,
          hostBoundary: () => null,
        })();
      const before = over(false);
      const after = over(true);
      for (const s of after as Seat[]) {
        const b = (before as Seat[]).find((x) => x.key === s.key)!;
        expect(s['council_eligible'], s.key).toBe(b['council_eligible']);
        expect((toEngineSeat(s) as Record<string, unknown>)['health'], s.key).toEqual((toEngineSeat(b) as Record<string, unknown>)['health']);
      }
      const pi = (after as Seat[]).find((s) => s.key === 'pi')!;
      if (floor === 'host') expect(pi['council_eligible']).toBe(true);
      if (floor === 'host') {
        expect(pi['host_floor_bench']).toMatch(/runs only on the container floor/);
        expect((pi['work_admission'] as Record<string, unknown>)['unscoped']).toMatchObject({ reason_code: 'host_floor_bench' });
      } else {
        expect((after as Seat[]).some((s) => 'host_floor_bench' in s || 'host_floor_unknown' in s)).toBe(false);
        expect((pi['work_admission'] as Record<string, unknown>)['unscoped']).not.toMatchObject({ reason_code: 'host_floor_bench' });
      }
    });
  }
});
