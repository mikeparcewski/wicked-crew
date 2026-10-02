/**
 * The check lanes (DES-TRIGGER-REGISTRY-001 §4.6).
 *
 * DETERMINISTIC. In-process and sequential (the registry drains one input at a time, so a run's
 * inputs are evaluated in order). Each check has a 5 ms budget: a breach is counted, not cut. A
 * check that throws or does not settle within its timeout yields NO output (a failed check never
 * emits "fine") and is reported to the registry, which raises `registry-check-failed` past its
 * threshold.
 *
 * LLM. Not in this slice: the `llm:*` lane, its seat port and `Core.checkOnce` land with TR-W9a/W9.
 * No shipped check is `lane: "llm"`, and the registry refuses to run one (health `llm.enabled:false`).
 */

import type { CheckCtx, CheckOutput, KeyPointInput, LoadedEntry, RunWatchState, WatchCheck } from './types.js';

export interface LaneStats {
  runs: number;
  budgetBreaches: number;
  failures: number;
  timeouts: number;
}

export interface DeterministicLaneOptions {
  /** Per-check budget, ms (a breach is counted). */
  budgetMs?: number;
  /** A check that has not settled by then is abandoned and counted as timed out. */
  timeoutMs?: number;
  /** A check threw or timed out. */
  onFailure?: (entryId: string, reason: 'threw' | 'timeout', err: unknown) => void;
  clock?: () => number;
}

const TIMED_OUT = Symbol('timed-out');

export class DeterministicLane {
  /** The failure report, guarded: a throwing reporter never makes `run` reject. */
  private report(entryId: string, reason: 'threw' | 'timeout', err: unknown): void {
    try {
      this.opts.onFailure?.(entryId, reason, err);
    } catch {
      /* counted above; the report itself is best-effort */
    }
  }

  readonly stats: LaneStats = { runs: 0, budgetBreaches: 0, failures: 0, timeouts: 0 };
  private readonly budgetMs: number;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(private readonly opts: DeterministicLaneOptions = {}) {
    this.budgetMs = opts.budgetMs ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 1_000;
    this.clock = opts.clock ?? (() => performance.now());
  }

  /** Never throws. */
  async run(check: WatchCheck, entry: LoadedEntry, input: KeyPointInput, state: RunWatchState, ctx: CheckCtx): Promise<CheckOutput[]> {
    if (check.lane !== 'deterministic') return [];
    this.stats.runs++;
    const t0 = this.clock();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = check.evaluate(input, state, entry.params, entry.threshold, ctx);
      const settled = Array.isArray(result)
        ? result
        : await Promise.race([
            result,
            new Promise<typeof TIMED_OUT>((resolve) => {
              timer = setTimeout(() => resolve(TIMED_OUT), this.timeoutMs);
              timer.unref();
            }),
          ]);
      if (settled === TIMED_OUT) {
        this.stats.timeouts++;
        this.report(entry.id, 'timeout', null);
        return [];
      }
      return Array.isArray(settled) ? settled : [];
    } catch (err) {
      this.stats.failures++;
      this.report(entry.id, 'threw', err);
      return [];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.clock() - t0 > this.budgetMs) this.stats.budgetBreaches++;
    }
  }
}
