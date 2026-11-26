/**
 * (crew#1950) The parts of one `GET /runs/:id/gate` read, timed. On a loaded host the read took 36-52 s while the run's
 * own view took 0.08 s, and nothing said which part was slow. Every answer the handler gives carries the parts as a
 * `Server-Timing` header, and a read slower than {@link GATE_READ_SLOW_MS} logs one line naming each part, so the next
 * slow read names its cause without a lane reproducing it.
 *
 * Parts may overlap (the offers are read together), so their sum can exceed the total; a part read more than once
 * (a retried engine read) adds up. The total starts when the handler does, after the auth and other request hooks.
 * Only part names (fixed literals at each call site) and durations are ever served or logged.
 */
import { performance } from 'node:perf_hooks';

/** A gate read slower than this is logged with its parts. Studio's read gives up well after it. */
export const GATE_READ_SLOW_MS = 2_000;

/** Time one named part of a read; the value (or the throw) passes through unchanged. */
export type TimePart = <T>(name: string, read: () => Promise<T>) => Promise<T>;

/** No timing: the read as it is (a caller with no timer, the decision paths). */
export const untimed: TimePart = (_name, read) => read();

export class GateReadTimer {
  private readonly started: number;
  private readonly parts = new Map<string, number>();

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = clock();
  }

  /** Time one part; a part read more than once adds up (each read adds its own duration when it ends). */
  readonly time: TimePart = async (name, read) => {
    const at = this.clock();
    try {
      return await read();
    } finally {
      const took = this.clock() - at;
      this.parts.set(name, (this.parts.get(name) ?? 0) + took);
    }
  };

  /** Add another timer's parts to this one's (a shared read this request waited on). */
  absorb(other: GateReadTimer): void {
    for (const [name, d] of other.parts) this.parts.set(name, (this.parts.get(name) ?? 0) + d);
  }

  /** Milliseconds since the read began. */
  total(): number {
    return this.clock() - this.started;
  }

  /** The `Server-Timing` value at `total` ms: each part then the total, in the order they were first timed. */
  header(total: number = this.total()): string {
    const ms = (n: number): string => n.toFixed(1);
    return [...[...this.parts].map(([name, d]) => `${name};dur=${ms(d)}`), `total;dur=${ms(total)}`].join(', ');
  }

  /** The log line for a read that took `total` ms, or `null` when it was not slow. */
  slowLine(runId: string, status: number, total: number = this.total()): string | null {
    if (total < GATE_READ_SLOW_MS) return null;
    const parts = [...this.parts].map(([name, d]) => `${name} ${Math.round(d)} ms`).join(', ');
    return `GET /runs/${runId}/gate took ${Math.round(total)} ms (status ${status}): ${parts || 'no part timed'}`;
  }
}
