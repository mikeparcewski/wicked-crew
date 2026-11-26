/**
 * (crew#1950) The parts of one `GET /runs/:id/gate` read, timed. On a loaded host the read took 36-52 s while the run's
 * own view took 0.08 s, and nothing said which part was slow. Every answer carries the parts as a `Server-Timing`
 * header, and a read slower than {@link GATE_READ_SLOW_MS} logs one line naming each part, so the next slow read names
 * its cause without a lane reproducing it.
 *
 * Parts may overlap (the offers are read together), so their sum can exceed the total.
 */
import { performance } from 'node:perf_hooks';

/** A gate read slower than this is logged with its parts. Studio's read gives up well after it. */
export const GATE_READ_SLOW_MS = 2_000;

export class GateReadTimer {
  private readonly started = performance.now();
  private readonly parts = new Map<string, number>();

  /** Time one part; a part read more than once adds up. The value (or the throw) passes through unchanged. */
  async time<T>(name: string, read: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try {
      return await read();
    } finally {
      this.parts.set(name, (this.parts.get(name) ?? 0) + (performance.now() - at));
    }
  }

  /** Milliseconds since the read began. */
  total(): number {
    return performance.now() - this.started;
  }

  /** The `Server-Timing` value: each part then the total, in the order they were first timed. */
  header(): string {
    const ms = (n: number): string => n.toFixed(1);
    return [...[...this.parts].map(([name, d]) => `${name};dur=${ms(d)}`), `total;dur=${ms(this.total())}`].join(', ');
  }

  /** The log line for a slow read, or `null` when it was not slow. */
  slowLine(runId: string, status: number): string | null {
    const total = this.total();
    if (total < GATE_READ_SLOW_MS) return null;
    const parts = [...this.parts].map(([name, d]) => `${name} ${Math.round(d)} ms`).join(', ');
    return `GET /runs/${runId}/gate took ${Math.round(total)} ms (status ${status}): ${parts || 'no part timed'}`;
  }
}
