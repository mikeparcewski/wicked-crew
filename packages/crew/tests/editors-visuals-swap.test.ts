// crew#1702 review (codex r1): a pack is another party's directory, so a card image's read must hold against a file
// system that changes under it. Two swaps, each made at a fixed point of the read:
//  - a directory on the image's way is swapped for a link to an outside directory AFTER it was checked: the open lands
//    on another file, and that file is refused (its identity is taken before the walk, not after);
//  - a FIFO stands where the image (or a pack entry) is opened: the open returns at once and the read is refused,
//    instead of blocking the daemon until something writes to the pipe.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/** One swap, run right after the walk checks `at` (and before the open). */
const swap: { at: string; run: (() => void) | null } = { at: '', run: null };

vi.mock('../src/editors/registry.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/editors/registry.js')>();
  return {
    ...m,
    notRealEntry: (path: string, want: 'dir' | 'file') => {
      const verdict = m.notRealEntry(path, want);
      if (path === swap.at && swap.run !== null) {
        const run = swap.run;
        swap.run = null;
        run();
      }
      return verdict;
    },
  };
});

const { imageDataUrl, readNoFollow } = await import('../src/editors/visuals.js');
const { readCapped } = await import('../src/editors/registry.js');

const INSIDE = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const OUTSIDE = '<svg xmlns="http://www.w3.org/2000/svg"><title>outside the pack</title></svg>';

const scratches: string[] = [];
afterEach(() => {
  swap.run = null;
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'editors-visuals-swap-'));
  scratches.push(d);
  return d;
}

describe('card image reads hold against a pack that changes under them', () => {
  it('a directory swapped for an outside link after its check: the outside image never reaches the wire', () => {
    const root = join(scratch(), 'pack');
    const outside = join(scratch(), 'elsewhere');
    mkdirSync(join(root, 'assets'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, 'assets', 'icon.svg'), INSIDE);
    writeFileSync(join(outside, 'icon.svg'), OUTSIDE);
    swap.at = join(root, 'assets');
    swap.run = () => {
      renameSync(join(root, 'assets'), join(root, 'assets-was'));
      symlinkSync(outside, join(root, 'assets'));
    };
    const reasons: string[] = [];
    const url = imageDataUrl(root, 'assets/icon.svg', 16 * 1024, (m) => reasons.push(m));
    expect(swap.run).toBeNull(); // the swap really ran between the check and the open
    expect(url).toBeNull();
    expect(reasons.join(' ')).toMatch(/changed while it was read/);
  });

  it.skipIf(process.platform === 'win32')('a FIFO where a file is opened: the read returns at once, refused', () => {
    const fifo = join(scratch(), 'icon.svg');
    execFileSync('mkfifo', [fifo]);
    // As if it was swapped in after the file checks: no writer ever comes, so a blocking open would never return.
    expect(readNoFollow(fifo, 1024)).toBeNull();
    expect(readCapped(fifo, 1024)).toBeNull();
  });
});
