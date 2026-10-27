/**
 * The statistics the run review stands on (DES-RUNS-REVIEW-001 §4). Pure and deterministic: the same inputs give
 * the same numbers, byte for byte, so a review can be re-derived.
 *
 *  - Rates: Wilson score interval (95 %), which stays inside [0, 1] and is honest at small n.
 *  - Long-tailed data (durations, spend, retries): the median and percentiles, never the mean. The interval is a
 *    bootstrap 95 % CI of the median: 1,000 resamples from a SEEDED generator (mulberry32), so it is reproducible.
 *  - Below {@link MIN_SAMPLE} no trend is called: the comparison says "too few runs to tell".
 */

/** The smallest sample a trend may be called on, in the window and in the baseline. */
export const MIN_SAMPLE = 5;
const Z95 = 1.959963984540054;
export const BOOTSTRAP_RESAMPLES = 1000;

export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval for `successes` of `n` (95 %). `null` when n is 0. */
export function wilson(successes: number, n: number, z = Z95): Interval | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Exact at the edges (no float dust): 0 successes has lower bound 0, n successes upper bound 1.
  return { lo: successes === 0 ? 0 : Math.max(0, centre - half), hi: successes === n ? 1 : Math.min(1, centre + half) };
}

/** Linear-interpolated percentile (q in [0, 1]) of an ALREADY SORTED array. `null` when empty. */
export function percentileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number | null {
  return percentileSorted(sortedCopy(values), 0.5);
}

/** mulberry32: a small, well-mixed 32-bit PRNG. Seeded, so every bootstrap is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from a label (FNV-1a), so each metric's bootstrap has its own reproducible stream. */
export function seedOf(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Bootstrap 95 % percentile CI of the median. `null` when empty. */
export function bootstrapMedianCI(values: readonly number[], seed: number, resamples = BOOTSTRAP_RESAMPLES): Interval | null {
  const n = values.length;
  if (n === 0) return null;
  if (n === 1) return { lo: values[0] as number, hi: values[0] as number };
  const rand = mulberry32(seed);
  const medians: number[] = new Array<number>(resamples);
  const sample: number[] = new Array<number>(n);
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < n; i += 1) sample[i] = values[Math.floor(rand() * n)] as number;
    sample.sort((a, b) => a - b);
    medians[r] = percentileSorted(sample, 0.5) as number;
  }
  medians.sort((a, b) => a - b);
  return { lo: percentileSorted(medians, 0.025) as number, hi: percentileSorted(medians, 0.975) as number };
}

/** What a comparison against the baseline concluded. */
export type Verdict = 'too-few' | 'no-change' | 'improved' | 'regressed';

/**
 * Compare a window value (with its interval) against a baseline point value. Notable only when BOTH samples reach
 * {@link MIN_SAMPLE} and the window's interval EXCLUDES the baseline value. `higherIsBetter` gives the direction.
 */
export function compare(
  windowN: number,
  windowInterval: Interval | null,
  baselineN: number,
  baselineValue: number | null,
  higherIsBetter: boolean,
): Verdict {
  if (windowN < MIN_SAMPLE || baselineN < MIN_SAMPLE || windowInterval === null || baselineValue === null) return 'too-few';
  if (windowInterval.lo > baselineValue) return higherIsBetter ? 'improved' : 'regressed';
  if (windowInterval.hi < baselineValue) return higherIsBetter ? 'regressed' : 'improved';
  return 'no-change';
}

/** Round for display and storage (a review is read by people; 4 significant decimals are plenty). */
export function round(v: number | null, places = 4): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
