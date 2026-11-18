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
import { chatSeatAdmission, type StandingSeat } from '../src/api/seat-standing.js';
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
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'seat-image-unusable-')); vi.stubEnv('HOME', home); vi.stubEnv('WICKED_CORE_EXE', '/fixture/core'); });
afterEach(() => { for (const fn of close.splice(0)) fn(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function rosterFixture(reading: ReadonlyMap<string, UnbuildableSeatImage> | null, floor = 'container') {
  // The container broker answers per seat: pi is signed out, every other seat signed in.
  const exec = vi.fn<ExecLike>(async (_file, args) => ({
    stdout: args.some((a) => a === 'pi' || a.startsWith('pi')) ? '{"status":"signed_out","detail":{}}' : '{"status":"signed_in","detail":{"expires_at":null}}',
    stderr: '',
  }));
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
async function primed(reading: ReadonlyMap<string, UnbuildableSeatImage> | null, floor = 'container') {
  const f = rosterFixture(reading, floor);
  for (const k of ['claude', 'codex', 'codex#2', 'pi']) await f.containerStatus.refresh(k);
  return f.roster;
}
const seatOf = (rows: ReturnType<ReturnType<typeof rosterWithStandingFactory>>, key: string) => rows.find((r) => r.key === key)!;
const usable = (seat: unknown): unknown => (toEngineSeat(seat) as { health?: unknown }).health;

describe('the roster: a seat whose image cannot be built is unusable, and the engine is handed it unusable', () => {
  const reason = unbuildableSeatImages(status(baseGone, { codex: { present: false } })).get('codex')!.reason;
  const reading = new Map<string, UnbuildableSeatImage>([['codex', { kind: 'base', reason }], ['pi', { kind: 'base', reason }]]);

  it('codex and its instance: no work, council, chat, work admission or QE review, inactive, engine unusable, with the cause and remedy', async () => {
    const rows = (await primed(reading))();
    for (const key of ['codex', 'codex#2']) {
      const seat = seatOf(rows, key);
      expect(seat.auth, key).toBe('signed_in');
      expect(seat, key).toMatchObject({
        seat_image_unavailable: reason,
        health: { status: 'inactive', message: reason },
        council_eligible: false, council_ineligible_reason: reason,
        work_eligible: false, work_ineligible_reason: reason,
        chat_admission: { unscoped: { ok: false, reason }, scoped: { ok: false }, scoped_bound: { ok: false } },
        work_admission: { unscoped: { ok: false, reason_code: 'seat_image_unavailable', reason }, scoped: { ok: false }, scoped_bound: { ok: false } },
        qe_reviewer: { ok: false, reason_code: 'seat_image_unavailable', reason },
      });
      expect(usable(seat)).toMatchObject({ usable: false });
      // POST /chats and re-seat call chatSeatAdmission on the decorated seat: it refuses there too.
      for (const kind of ['path', 'path-bound'] as const) {
        expect(chatSeatAdmission(seat as StandingSeat, seat.auth ?? 'unknown', kind === 'path' ? false : true, kind)).toMatchObject({ ok: false, reason });
      }
    }
    // Claude's image is there: usable.
    const claude = seatOf(rows, 'claude');
    expect(claude).toMatchObject({ health: { status: 'active' }, work_eligible: true, council_eligible: true });
    expect(claude).not.toHaveProperty('seat_image_unavailable');
    expect(usable(claude)).toMatchObject({ usable: true });
  });

  it('a pending login check does not hide the image: the seat still reads unusable', () => {
    // No broker answer yet (auth unknown, login pending).
    const seat = seatOf(rosterFixture(reading).roster(), 'codex');
    expect(seat.auth).not.toBe('signed_in');
    expect(seat).toMatchObject({ seat_image_unavailable: reason, health: { status: 'inactive', message: reason } });
    expect(chatSeatAdmission(seat as StandingSeat, seat.auth ?? 'unknown', false, 'path')).toMatchObject({ ok: false });
  });

  it('a signed-out seat keeps its own reason (its image is not needed until it is signed in)', async () => {
    const pi = seatOf((await primed(reading))(), 'pi');
    expect(pi.auth).toBe('signed_out');
    expect(pi).not.toHaveProperty('seat_image_unavailable');
    expect(pi.work_ineligible_reason).not.toBe(reason);
    expect(pi.council_ineligible_reason).not.toBe(reason);
    expect(pi.work_admission).toMatchObject({ unscoped: { ok: false, reason_code: 'signed_out' } });
  });

  it('no reading (none yet, or it failed) marks nothing: a signed-in seat stays usable', async () => {
    const codex = seatOf((await primed(null))(), 'codex');
    expect(codex.auth).toBe('signed_in');
    expect(codex).toMatchObject({ health: { status: 'active' }, work_eligible: true, council_eligible: true, work_admission: { unscoped: { ok: true } } });
    expect(codex).not.toHaveProperty('seat_image_unavailable');
    expect(usable(codex)).toMatchObject({ usable: true });
  });

  it('the host floor reads no image: unchanged', () => {
    const codex = seatOf(rosterFixture(reading, 'host').roster(), 'codex');
    expect(codex).not.toHaveProperty('seat_image_unavailable');
    expect(codex).toMatchObject({ health: { status: 'active' }, work_eligible: true });
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

  it('a read past its deadline publishes unknown and keeps the slot: never two status reads at once', async () => {
    let now = 0;
    let active = 0;
    let most = 0;
    let finish: (() => void) | undefined;
    const r = new SeatImageReading(() => {
      active += 1;
      most = Math.max(most, active);
      return new Promise<SeatImageStatus | null>((res) => { finish = () => { active -= 1; res(status()); }; });
    }, { ttlMs: 10, timeoutMs: 5, nowMs: () => now });
    r.unbuildable();
    await new Promise((res) => setTimeout(res, 20));
    expect(r.unbuildable()).toBeNull();
    now = 100;
    r.unbuildable();
    r.unbuildable();
    expect(most).toBe(1);
    finish!();
    await new Promise((res) => setTimeout(res, 0));
    expect(most).toBe(1);
  });
});
