// crew#1509 — the cancel checks the end-to-end suites use (tests/support/cancel-reap.ts), on a reap that outlasts
// the engine's 500 ms cancel wait: they never judge the trail mid-reap, and a real disagreement still fails.
import { describe, expect, it } from 'vitest';
import { cancelBooked, reapSettled, type Frame } from './support/cancel-reap.js';

const f = (type: string): Frame => ({ type });
const retained = (trail: readonly Frame[]): boolean => trail.some((e) => e['type'] === 'worktreeRetained');

/** Step through a timeline until the reap settles; returns the state it settled on. */
function settle(timeline: ReadonlyArray<{ trail: Frame[]; onDisk: boolean }>): { trail: Frame[]; onDisk: boolean; step: number } {
  for (const [step, s] of timeline.entries()) if (reapSettled(s.trail, s.onDisk)) return { ...s, step };
  throw new Error('the reap never settled');
}

describe('cancelBooked (crew#1509)', () => {
  it('the cancel is booked whether the retention frame lands before or after it', () => {
    expect(cancelBooked([f('unitStarted'), f('worktreeRetained'), f('runCancelled')])).toBe(true);
    expect(cancelBooked([f('unitStarted'), f('runCancelled'), f('worktreeRetained')])).toBe(true);
    expect(cancelBooked([f('unitStarted'), f('runCancelled')])).toBe(true);
  });

  it('no cancel, or any other frame after it, is not a booked cancel', () => {
    expect(cancelBooked([f('unitStarted'), f('worktreeRetained')])).toBe(false);
    expect(cancelBooked([f('runCancelled'), f('unitStarted')])).toBe(false);
    expect(cancelBooked([f('runCancelled'), f('worktreeRetained'), f('sessionFailed')])).toBe(false);
  });
});

describe('reapSettled on a reap slower than the cancel wait (crew#1509)', () => {
  it('a dirty tree whose worktreeRetained follows runCancelled: judged only once the frame is there, and then wire and disk agree', () => {
    const cancelled = [f('gateDecided'), f('runCancelled')];
    const s = settle([
      { trail: cancelled, onDisk: true }, // runCancelled is out; the reap is still deciding the tree
      { trail: cancelled, onDisk: true },
      { trail: [...cancelled, f('worktreeRetained')], onDisk: true },
    ]);
    expect(s.step).toBe(2);
    expect(cancelBooked(s.trail)).toBe(true);
    expect(retained(s.trail)).toBe(s.onDisk);
  });

  it('a clean tree still being deleted after runCancelled: judged only once it is gone, with no retention claimed', () => {
    const cancelled = [f('gateDecided'), f('runCancelled')];
    const s = settle([
      { trail: cancelled, onDisk: true }, // the old check compared here and failed: on disk, no frame
      { trail: cancelled, onDisk: true },
      { trail: cancelled, onDisk: false },
    ]);
    expect(s.step).toBe(2);
    expect(retained(s.trail)).toBe(s.onDisk);
  });

  it('a run with no worktree, or a reap done before the cancel, settles at once', () => {
    expect(reapSettled([f('runCancelled')], false)).toBe(true);
    expect(reapSettled([f('worktreeRetained'), f('runCancelled')], true)).toBe(true);
  });

  it('nothing settles before runCancelled is on the trail, even with the reap already done', () => {
    expect(reapSettled([f('unitStarted'), f('worktreeRetained')], true)).toBe(false);
    expect(reapSettled([f('unitStarted')], false)).toBe(false);
    const s = settle([
      { trail: [f('unitStarted'), f('worktreeRetained')], onDisk: true },
      { trail: [f('unitStarted'), f('worktreeRetained'), f('runCancelled')], onDisk: true },
    ]);
    expect(s.step).toBe(1);
    expect(cancelBooked(s.trail)).toBe(true);
  });

  it('a stray frame after the cancel still settles, so the cancel check fails at once instead of timing out', () => {
    const trail = [f('runCancelled'), f('sessionFailed')];
    expect(reapSettled(trail, false)).toBe(true);
    expect(cancelBooked(trail)).toBe(false);
  });

  it('a real disagreement still fails: a retention claimed for a tree that is gone settles, and the check sees it', () => {
    const s = settle([{ trail: [f('runCancelled'), f('worktreeRetained')], onDisk: false }]);
    expect(retained(s.trail)).not.toBe(s.onDisk);
  });
});
