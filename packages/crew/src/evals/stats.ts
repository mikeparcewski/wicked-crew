/**
 * The statistics the default evals stand on (DES-DEFAULT-EVALS-001 §6, the same rules as DES-RUNS-REVIEW-001 §4).
 * Pure and deterministic: the same cases give the same numbers, byte for byte.
 *
 *  - Rates: the Wilson score interval (95 %), honest at small n and always inside [0, 1].
 *  - Below {@link MIN_CASES} a figure is "too few cases": the value is still shown, no trend is called.
 *  - Calibration (ECE over 10 bins, Brier) needs {@link MIN_CALIBRATION} confident answers.
 *
 * One statistics module: the Wilson interval and the comparison rule are the run review's (`insights/stats.ts`);
 * this module only shapes them into the default evals' wire (`Rate`) and adds calibration.
 */

import { compare, MIN_SAMPLE, wilson, type Interval } from '../insights/stats.js';
import type { Calibration, Rate, TrendWord } from './types.js';

export const MIN_CASES = MIN_SAMPLE;
export const MIN_CALIBRATION = 20;

export function round4(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10_000) / 10_000;
}

/** Wilson score interval for `k` of `n` (95 %). Value and bounds are `null` when n is 0. */
export function rate(k: number, n: number, min = MIN_CASES): Rate {
  const iv = wilson(k, n);
  if (n <= 0 || iv === null) return { k: 0, n: 0, value: null, lo: null, hi: null, tooFew: true };
  return { k, n, value: round4(k / n), lo: round4(iv.lo), hi: round4(iv.hi), tooFew: n < min };
}

/** Calibration of a confidence against being right: ECE over 10 equal-width bins, and the Brier score. */
export function calibration(points: ReadonlyArray<{ confidence: number; correct: boolean }>): Calibration {
  const n = points.length;
  if (n < MIN_CALIBRATION) return { n, ece: null, brier: null, tooFew: true };
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, right: 0 }));
  let brier = 0;
  for (const p of points) {
    const c = Math.min(1, Math.max(0, p.confidence));
    const b = bins[Math.min(9, Math.floor(c * 10))]!;
    b.n += 1;
    b.conf += c;
    b.right += p.correct ? 1 : 0;
    brier += (c - (p.correct ? 1 : 0)) ** 2;
  }
  let ece = 0;
  for (const b of bins) if (b.n > 0) ece += (b.n / n) * Math.abs(b.right / b.n - b.conf / b.n);
  return { n, ece: round4(ece), brier: round4(brier / n), tooFew: false };
}

/**
 * This run's rate against the last run's point value, by the run review's rule (`compare`): notable only when both
 * reach {@link MIN_CASES} and this run's interval EXCLUDES the previous value. Higher agreement is better.
 */
export function trendOf(now: Rate, previous: { value: number | null; n: number } | null): TrendWord {
  if (previous === null) return 'first-run';
  const iv: Interval | null = now.lo !== null && now.hi !== null ? { lo: now.lo, hi: now.hi } : null;
  return compare(now.n, iv, previous.n, previous.value, true);
}
