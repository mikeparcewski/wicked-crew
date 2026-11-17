// crew#1097: a container seat whose image is missing and cannot be built is unusable on the roster (with the cause and
// its remedy), and the engine is handed it unusable, so work stays off it. ONE rule (`unbuildableSeatImages`) for the
// roster and the Nerve Center `seat_images` row.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rosterWithStandingFactory } from '../src/api/roster-standing.js';
import { SeatContainerStatus, type ExecLike } from '../src/api/seat-container-login.js';
import { SeatHealthTracker } from '../src/api/seat-health.js';
import { probeSeatImages, SeatImageReading, unbuildableSeatImages, type SeatImageStatus, type UnbuildableSeatImage } from '../src/api/seat-images.js';
import { toEngineSeat } from '../src/core/engine-roster.js';

function status(over: Partial<SeatImageStatus> = {}, seats: Partial<Record<string, Partial<SeatImageStatus['seats'][number]>>> = {}): SeatImageStatus {
  return {
    runtime: 'docker',
    base: { image: 'wicked-seat-base:rust', present: true, held: true },
    baseRecipe: false,
    holdSupported: true,
    floor: { image: 'wicked-floor:1', present: true, held: true },
    seats: ['claude', 'codex', 'pi'].map((cli) => ({ cli, image: `wicked-seat-${cli}:1`, present: true, held: true, operatorImage: false, ...(seats[cli] ?? {}) })),
    disk: { totalBytes: 100 * 2 ** 30, availBytes: 60 * 2 ** 30, usedPct: 40 },
    imageGcHighPct: 85,
    ...over,
  };
}
const baseGone = { base: { image: 'wicked-seat-base:rust', present: false, held: false } };

describe('unbuildableSeatImages: the one rule', () => {
  it('a missing engine image on a base that is gone with no recipe cannot be built; the remedy is named', () => {
    const m = unbuildableSeatImages(status(baseGone, { codex: { present: false } }));
    expect([...m.keys()]).toEqual(['codex']);
    expect(m.get('codex')).toEqual({
      kind: 'base',
      reason: 'seat image cannot be built: the seat base wicked-seat-base:rust is missing and nothing can rebuild it; rebuild it or unset WICKED_SEAT_BASE_IMAGE',
    });
  });

  it('a base with a recipe, a present base, or a present image: the next unit builds it (nothing marked)', () => {
    expect(unbuildableSeatImages(status({ ...baseGone, baseRecipe: true }, { codex: { present: false } })).size).toBe(0);
    expect(unbuildableSeatImages(status({}, { codex: { present: false } })).size).toBe(0);
    expect(unbuildableSeatImages(status(baseGone)).size).toBe(0);
    expect(unbuildableSeatImages(status({ base: null }, { codex: { present: false } })).size).toBe(0);
  });

  it("a missing operator image is never built by the engine, whatever the base", () => {
    const m = unbuildableSeatImages(status({}, { pi: { present: false, operatorImage: true, image: 'corp/pi:7' } }));
    expect(m.get('pi')).toEqual({
      kind: 'operator',
      reason: "seat image cannot be had: the operator's own image corp/pi:7 is missing (WICKED_SEAT_IMAGE_PI; the engine never builds it); pull or build it",
    });
  });

  it('the seat_images row reads down on exactly these (its words unchanged)', async () => {
    const st = status(baseGone, { codex: { present: false }, pi: { present: false, operatorImage: true } });
    const row = await probeSeatImages({ containerFloor: true, clis: ['claude', 'codex', 'pi'], status: async () => st, rebuild: () => null });
    expect(row.state).toBe('down');
    expect(row.reason).toContain('seat images missing: codex');
    expect(row.reason).not.toContain('codex (the next unit');
    expect(row.reason).toContain("the operator's own seat image is missing for pi");
  });
});

let home: string;
const close: Array<() => void> = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'seat-image-unusable-')); });
afterEach(() => { for (const fn of close.splice(0)) fn(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

function rosterFixture(reading: ReadonlyMap<string, UnbuildableSeatImage> | null, floor = 'container') {
  const exec = vi.fn<ExecLike>(async () => ({ stdout: '{"status":"signed_in","detail":{"expires_at":null}}', stderr: '' }));
  const containerStatus = new SeatContainerStatus({ exec, gatewayDir: join(home, 'gateway') });
  const roster = rosterWithStandingFactory({
    registry: () => [{ key: 'claude' }, { key: 'codex' }, { key: 'codex#2' }, { key: 'pi' }],
    signedIn: (key) => key !== 'pi',
    seatHealth: new SeatHealthTracker(),
    env: { HOME: home, WICKED_SEAT_FLOOR: floor }, home, hostBoundary: () => null, containerStatus,
    worktreeBench: () => new Map(), qeAdmitted: () => true,
    seatImages: { unbuildable: () => reading },
  });
  close.push(() => roster.close?.());
  return { roster, containerStatus };
}

describe('the roster: a seat whose image cannot be built is unusable, and the engine is handed it unusable', () => {
  const reason = unbuildableSeatImages(status(baseGone, { codex: { present: false } })).get('codex')!.reason;
  const reading = new Map<string, UnbuildableSeatImage>([['codex', { kind: 'base', reason }], ['pi', { kind: 'base', reason }]]);

  it('codex and its instance: not eligible for work or council, inactive, chat refused, with the cause and remedy', async () => {
    const { roster, containerStatus } = rosterFixture(reading);
    await containerStatus.refresh('codex');
    for (const key of ['codex', 'codex#2']) {
      const seat = roster().find((r) => r.key === key)!;
      expect(seat, key).toMatchObject({
        health: { status: 'inactive', message: reason },
        council_eligible: false, council_ineligible_reason: reason,
        work_eligible: false, work_ineligible_reason: reason,
        chat_admission: { unscoped: { ok: false, reason }, scoped: { ok: false }, scoped_bound: { ok: false } },
      });
      expect((toEngineSeat(seat) as { health?: unknown }).health).toMatchObject({ usable: false });
    }
    // Claude's image is there: unchanged.
    const claude = roster().find((r) => r.key === 'claude')!;
    expect(claude.health).toMatchObject({ status: 'active' });
    expect(claude.council_ineligible_reason).not.toBe(reason);
  });

  it('a signed-out seat keeps its own reason (its image is not needed until it is signed in)', () => {
    const { roster } = rosterFixture(reading, 'host');
    const { roster: onContainer } = rosterFixture(reading);
    const pi = onContainer().find((r) => r.key === 'pi')!;
    expect(pi.work_ineligible_reason).not.toBe(reason);
    expect(pi.health).toMatchObject({ status: 'active' });
    expect(roster().find((r) => r.key === 'pi')!.work_ineligible_reason).not.toBe(reason);
  });

  it('no reading (none yet, or it failed) marks nothing; neither does the host floor', () => {
    const unknown = rosterFixture(null).roster().find((r) => r.key === 'codex')!;
    expect(unknown.work_ineligible_reason).not.toBe(reason);
    expect(unknown.health).toMatchObject({ status: 'active' });
    const host = rosterFixture(reading, 'host').roster().find((r) => r.key === 'codex')!;
    expect(host.work_ineligible_reason).not.toBe(reason);
    expect(host.health).toMatchObject({ status: 'active' });
  });
});

describe('SeatImageReading: off the request path', () => {
  it('a read never waits: the first answers null and starts one read; a fresh reading is served until the TTL', async () => {
    let now = 0;
    let calls = 0;
    let answer: SeatImageStatus | null = status(baseGone, { codex: { present: false } });
    const r = new SeatImageReading(async () => { calls += 1; return answer; }, { ttlMs: 1000, nowMs: () => now });
    expect(r.unbuildable()).toBeNull();
    expect(r.unbuildable()).toBeNull();
    await r.refresh();
    expect(calls).toBe(1);
    expect([...(r.unbuildable() ?? new Map()).keys()]).toEqual(['codex']);
    // Rebuilt: the next reading after the TTL clears it.
    answer = status();
    now = 1000;
    r.unbuildable();
    await r.refresh();
    expect(calls).toBe(2);
    expect(r.unbuildable()?.size).toBe(0);
  });

  it('a failed read is unknown (null), never a bench', async () => {
    const r = new SeatImageReading(async () => { throw new Error('docker down'); });
    await r.refresh();
    expect(r.unbuildable()).toBeNull();
  });
});
