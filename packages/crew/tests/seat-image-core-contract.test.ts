/**
 * (crew#1526) Contract: crew reads the seat image status that the wicked-core binary SHIPPED in wicked-core-ts prints,
 * not a fixture of what it once printed. The binary runs `seat-image status --json` against a stand-in container
 * runtime (`WICKED_CONTAINER_RUNTIME`, a shell script answering `version` and `images`), so a schema drift in the
 * engine fails here, in CI, instead of turning the crew#1097 rule inert.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bundledWickedCoreExe } from '../src/core/adapter.js';
import { parseSeatImageStatus, SeatImageReading, seatImageStatusVia, unbuildableSeatImages, type SeatImageStatus } from '../src/api/seat-images.js';

const exe = bundledWickedCoreExe();
const posix = process.platform !== 'win32';

let dir = '';
let listing = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seat-image-contract-'));
  listing = join(dir, 'images.txt');
  writeFileSync(listing, '');
  const runtime = join(dir, 'docker');
  // `images` lists what the test put there; every other call (an operator image's inspect) finds nothing.
  writeFileSync(runtime, `#!/bin/sh\ncase "$1" in\n  version) echo 27.0.0 ;;\n  images) cat '${listing}' ;;\n  *) exit 1 ;;\nesac\n`);
  chmodSync(runtime, 0o755);
  vi.stubEnv('HOME', dir);
  vi.stubEnv('WICKED_CONTAINER_RUNTIME', runtime);
  // The operator's own configuration never leaks in: every seat image override and the base are cleared.
  vi.stubEnv('WICKED_SEAT_BASE_IMAGE', '');
  vi.stubEnv('WICKED_SEAT_BASE_DOCKERFILE', '');
  for (const k of new Set([...Object.keys(process.env).filter((x) => x.startsWith('WICKED_SEAT_IMAGE_')), ...['CLAUDE', 'CODEX', 'PI', 'OPENCODE', 'COPILOT', 'AGY'].map((c) => `WICKED_SEAT_IMAGE_${c}`)])) vi.stubEnv(k, '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const read = async (): Promise<SeatImageStatus> => {
  const st = await seatImageStatusVia(() => exe ?? null)();
  expect(st, 'the shipped engine\'s status parses (crew#1526: a parser that requires a field the engine no longer prints reads null)').not.toBeNull();
  return st!;
};
const list = (images: string[]) => writeFileSync(listing, images.map((i, n) => `${i}\tsha256:${String(n + 1).padStart(64, '0')}\n`).join(''));

describe.runIf(posix)('the seat image status of the engine wicked-core-ts ships', () => {
  it('a platform package carries the engine binary', () => {
    expect(exe).toBeDefined();
  });

  it('parses, with each seat\'s image and whether it is present', async () => {
    const before = await read();
    // The engine names the images; list claude's and only claude's.
    const claude = before.seats.find((s) => s.cli === 'claude');
    expect(claude, 'the default roster has a claude seat').toBeDefined();
    list([claude!.image, before.floor.image]);
    const st = await read();
    expect(st.seats.find((s) => s.cli === 'claude')).toMatchObject({ present: true, operatorImage: false });
    expect(st.seats.find((s) => s.cli === 'codex')).toMatchObject({ present: false, operatorImage: false });
    expect(st.floor.present).toBe(true);
    // A missing engine-built image is built by the next unit: never unusable.
    expect(unbuildableSeatImages(st).size).toBe(0);
    // What the parser reads is what the engine printed (no field crew requires is missing from it).
    const raw = JSON.parse((await import('node:child_process')).execFileSync(exe!, ['seat-image', 'status', '--json'], { encoding: 'utf8' })) as Record<string, unknown>;
    expect(parseSeatImageStatus(JSON.stringify(raw))).toEqual(st);
  });

  it('an operator image that is missing makes its seat unusable (crew#1097), through the roster\'s own reading', async () => {
    vi.stubEnv('WICKED_SEAT_IMAGE_CODEX', 'acme/codex-seat:1');
    const st = await read();
    expect(st.seats.find((s) => s.cli === 'codex')).toMatchObject({ image: 'acme/codex-seat:1', present: false, operatorImage: true });
    expect(unbuildableSeatImages(st).get('codex')?.kind).toBe('operator');
    const reading = new SeatImageReading(seatImageStatusVia(() => exe ?? null));
    await reading.refresh();
    expect(reading.unbuildable()?.get('codex')?.kind).toBe('operator');
  });

  it('an operator base that is gone with no recipe makes the engine-built seats unusable, through the roster\'s reading', async () => {
    vi.stubEnv('WICKED_SEAT_BASE_IMAGE', 'acme/seat-base:1');
    const st = await read();
    expect(st.base).toMatchObject({ image: 'acme/seat-base:1', present: false });
    expect(st.baseRecipe).toBe(false);
    const built = st.seats.filter((x) => !x.present && !x.operatorImage).map((x) => x.cli);
    expect(built.length).toBeGreaterThan(0);
    const reading = new SeatImageReading(seatImageStatusVia(() => exe ?? null));
    await reading.refresh();
    const cannot = reading.unbuildable();
    for (const cli of built) expect(cannot?.get(cli)?.kind, cli).toBe('base');
  });

  it('a gone base WITH a readable recipe is buildable: the engine says baseRecipe and no seat is marked', async () => {
    const recipe = join(dir, 'Dockerfile.base');
    writeFileSync(recipe, 'FROM scratch\n');
    vi.stubEnv('WICKED_SEAT_BASE_IMAGE', 'acme/seat-base:1');
    vi.stubEnv('WICKED_SEAT_BASE_DOCKERFILE', recipe);
    const st = await read();
    expect(st.base).toMatchObject({ image: 'acme/seat-base:1', present: false });
    expect(st.baseRecipe).toBe(true);
    const reading = new SeatImageReading(seatImageStatusVia(() => exe ?? null));
    await reading.refresh();
    expect(reading.unbuildable()?.size).toBe(0);
  });
});
