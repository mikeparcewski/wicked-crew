// The Nerve Center's seat images row (`seat_images`) and its fix, over the engine's
// `seat-image status --json` answer (wicked-core#1225): missing images, an unbuildable base, the
// runtime VM disk warning before a kubelet's image cleanup, and the one-at-a-time rebuild.

import { describe, expect, it } from 'vitest';

import { seatImagesRebuildFixes } from '../src/api/needs.js';
import {
  parseSeatImageStatus,
  probeSeatImages,
  SeatImageRebuilder,
  type SeatImageStatus,
} from '../src/api/seat-images.js';

function status(over: Partial<SeatImageStatus> = {}, seats: Partial<Record<string, Partial<SeatImageStatus['seats'][number]>>> = {}): SeatImageStatus {
  return {
    runtime: 'docker',
    base: { image: 'wicked-seat-base:rust', present: true, held: true },
    baseRecipe: false,
    floor: { image: 'wicked-floor:1', present: true, held: true },
    seats: ['claude', 'codex', 'agy'].map((cli) => ({ cli, image: `wicked-seat-${cli}:1`, present: true, held: true, operatorImage: false, ...(seats[cli] ?? {}) })),
    disk: { totalBytes: 100 * 2 ** 30, availBytes: 60 * 2 ** 30, usedPct: 40 },
    imageGcHighPct: 85,
    ...over,
  };
}

const probe = (st: SeatImageStatus | null, extra: Partial<Parameters<typeof probeSeatImages>[0]> = {}) =>
  probeSeatImages({ containerFloor: true, clis: ['claude', 'codex'], status: async () => st, rebuild: null, ...extra });

describe('parseSeatImageStatus', () => {
  it('reads the engine answer and refuses anything else', () => {
    const st = status();
    expect(parseSeatImageStatus(JSON.stringify(st))).toEqual(st);
    expect(parseSeatImageStatus('runtime: docker\nfloor: x present')).toBeNull();
    expect(parseSeatImageStatus('{"floor": 1, "seats": []}')).toBeNull();
    const noDisk = parseSeatImageStatus(JSON.stringify({ ...st, disk: null }))!;
    expect(noDisk.disk).toBeNull();
  });
});

describe('the seat_images row', () => {
  it('is off on the host floor', async () => {
    expect((await probe(status(), { containerFloor: false })).state).toBe('off');
  });

  it('is ok when every roster image is present and held', async () => {
    const row = await probe(status());
    expect(row.state).toBe('ok');
    expect(row.remedy).toBeNull();
  });

  it('a missing image of a CLI not on the roster is not a problem', async () => {
    expect((await probe(status({}, { agy: { present: false, held: false } }))).state).toBe('ok');
  });

  it('a missing roster image is degraded and fixable by a rebuild', async () => {
    const row = await probe(status({}, { codex: { present: false, held: false } }));
    expect(row.state).toBe('degraded');
    expect(row.details['missing']).toEqual(['codex']);
    expect(seatImagesRebuildFixes(row)).toBe(true);
  });

  it('a missing operator base with no recipe is down, and a rebuild cannot fix it', async () => {
    const row = await probe(status({ base: { image: 'wicked-seat-base:rust', present: false, held: false } }, { claude: { present: false, held: false } }));
    expect(row.state).toBe('down');
    expect(row.reason).toMatch(/nothing can rebuild it/);
    expect(row.remedy).toMatch(/WICKED_SEAT_BASE_DOCKERFILE/);
    expect(seatImagesRebuildFixes(row)).toBe(false);
  });

  it('a missing base WITH a recipe is degraded: the engine rebuilds it', async () => {
    const row = await probe(status({ base: { image: 'wicked-seat-base:rust', present: false, held: false }, baseRecipe: true }));
    expect(row.state).toBe('degraded');
    expect(row.reason).toMatch(/rebuilt from its Dockerfile/);
  });

  it('a missing operator image (WICKED_SEAT_IMAGE_<CLI>) is down and not a rebuild', async () => {
    const row = await probe(status({}, { claude: { present: false, held: false, operatorImage: true } }));
    expect(row.state).toBe('down');
    expect(seatImagesRebuildFixes(row)).toBe(false);
  });

  it('warns from 75 % VM disk (before the 85 % cleanup) and is down from 92 %', async () => {
    const at = (usedPct: number) => probe(status({ disk: { totalBytes: 100 * 2 ** 30, availBytes: (100 - usedPct) * 2 ** 30, usedPct } }));
    expect((await at(74)).state).toBe('ok');
    const warn = await at(75);
    expect(warn.state).toBe('degraded');
    expect(warn.reason).toMatch(/past 85%/);
    expect(seatImagesRebuildFixes(warn)).toBe(false);
    expect((await at(92)).state).toBe('down');
  });

  it('images present but not held are degraded until the engine holds them', async () => {
    const row = await probe(status({}, { claude: { held: false } }));
    expect(row.state).toBe('degraded');
    expect(row.details['unheld']).toEqual(['claude']);
  });

  it('an engine that does not answer in time is unknown, never ok', async () => {
    const row = await probeSeatImages({ containerFloor: true, clis: ['claude'], status: () => new Promise(() => {}), rebuild: null, timeoutMs: 20 });
    expect(row.state).toBe('unknown');
    const old = await probe(null);
    expect(old.state).toBe('unknown');
    expect(old.reason).toMatch(/older than wicked-core#1225/);
  });

  it('says a running rebuild and a failed one', async () => {
    const running = await probe(status({}, { codex: { present: false, held: false } }), {
      rebuild: { running: true, startedAt: '2026-10-31T20:00:00.000Z', finishedAt: null, rc: null, tail: [], clis: ['codex'] },
    });
    expect(running.reason).toMatch(/rebuilding since 2026-10-31T20:00:00.000Z/);
    const failed = await probe(status({}, { codex: { present: false, held: false } }), {
      rebuild: { running: false, startedAt: 'a', finishedAt: 'b', rc: 1, tail: ['codex: pull access denied'], clis: ['codex'] },
    });
    expect(failed.reason).toMatch(/the last rebuild failed \(exit 1\): codex: pull access denied/);
  });
});

describe('SeatImageRebuilder', () => {
  it('runs one rebuild at a time and keeps its result, home paths spelled ~', async () => {
    let release!: (v: { rc: number; stdout: string; stderr: string }) => void;
    const calls: string[][] = [];
    const r = new SeatImageRebuilder(
      () => '/opt/wicked-core',
      async (file, args) => {
        calls.push([file, ...args]);
        return new Promise((res) => {
          release = res;
        });
      },
    );
    const first = r.start(['claude', 'codex', 'claude', 'bad cli;rm']);
    expect(first.started).toBe(true);
    expect(calls).toEqual([['/opt/wicked-core', 'seat-image', 'build', 'claude', 'codex']]);
    const second = r.start(['claude']);
    expect(second).toMatchObject({ started: false, reason: 'a rebuild is already running' });
    release({ rc: 1, stdout: 'floor: wicked-floor:1', stderr: `claude: building failed in ${process.env['HOME'] ?? '/home/x'}/x` });
    await new Promise((res) => setTimeout(res, 0));
    const done = r.current()!;
    expect(done).toMatchObject({ running: false, rc: 1 });
    expect(done.tail.at(-1)).toMatch(/^claude: building failed in ~\/x$/);
    expect(r.start(['claude']).started).toBe(true);
  });

  it('does not start without an engine binary or a container seat', () => {
    expect(new SeatImageRebuilder(() => null, async () => ({ rc: 0, stdout: '', stderr: '' })).start(['claude'])).toMatchObject({ started: false });
    expect(new SeatImageRebuilder(() => '/x', async () => ({ rc: 0, stdout: '', stderr: '' })).start([])).toMatchObject({ started: false });
  });
});
