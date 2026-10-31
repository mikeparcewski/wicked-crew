/**
 * Which operator notes were SPOKEN (program DES-VOICE §3 "Talking to a running job"; api-types 0.161.0).
 *
 * Studio's voice mode sends a confirmed spoken steer through the same `POST /runs/:id/inject` as a typed one, with
 * `input: "voice"`. The engine's `workerMessageQueued` / `workerMessageInjected` frames carry the message and target
 * but not how it was given, so crew remembers each spoken SEND (an occurrence: run, message, target, when) and stamps
 * `input: "voice"` on the frames that send produced: on `/ws` as they pass, and on `GET /runs/:id/events` for a page
 * that reloads. The thread then says "You (by voice)". The label grants nothing; the audit line (`run.injected`)
 * carries it too.
 *
 * One occurrence stamps at most one queued frame and one injected frame, the first of each with its message and
 * target at or after it was sent (the injected frame ends it). So a typed note with the same words, sent before or
 * after, is never labelled voice (xreview on crew#1242).
 *
 * In memory and bounded (at most {@link PER_RUN} spoken sends per run, {@link RUNS} runs, oldest dropped): a note
 * spoken before the daemon restarted reads as typed on the thread, and its audit line still says voice. Only a send the
 * engine took counts toward the bounds ({@link VoiceInjectInputs.settle}); a refused one is forgotten and evicts nothing.
 */

export const PER_RUN = 32;
export const RUNS = 256;
/** How far a recorded frame's capture time may sit before the send it belongs to (clock and capture skew, ms). */
export const SKEW_MS = 2_000;

const QUEUED = 'workerMessageQueued';
const INJECTED = 'workerMessageInjected';

interface Occurrence {
  id: number;
  message: string;
  target: string;
  at: number;
  /** Live (`/ws`) frames this send has stamped. */
  queued: boolean;
  injected: boolean;
}

type Frame = { type: string; session?: unknown; message?: unknown; target?: unknown; input?: unknown; ts?: unknown };

export class VoiceInjectInputs {
  /** run id → its spoken sends, oldest first. Map order is insertion order: the first key is the oldest run. */
  private readonly runs = new Map<string, Occurrence[]>();
  private next = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * A note is being sent by voice to `runId` (before the engine call: its queued frame can arrive first). Nothing is
   * evicted yet: {@link settle} once the engine took it, {@link forget} if it refused.
   */
  remember(runId: string, message: string, target = 'all'): number {
    const id = this.next++;
    const list = this.runs.get(runId) ?? [];
    list.push({ id, message, target, at: this.now(), queued: false, injected: false });
    if (!this.runs.has(runId)) this.runs.set(runId, list);
    return id;
  }

  /** The engine took the send: the run becomes the newest, and the oldest sends and runs past the bounds go. */
  settle(runId: string): void {
    const list = this.runs.get(runId);
    if (list === undefined) return;
    this.runs.delete(runId);
    this.runs.set(runId, list);
    while (list.length > PER_RUN) list.shift();
    while (this.runs.size > RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined || oldest === runId) break;
      this.runs.delete(oldest);
    }
  }

  /** The engine refused the send: it never happened, so it stamps nothing and evicted nothing. */
  forget(runId: string, token: number): void {
    const list = this.runs.get(runId);
    if (list === undefined) return;
    const i = list.findIndex((o) => o.id === token);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.runs.delete(runId);
  }

  /** A live frame: stamped when it is the next unstamped frame of a spoken send. */
  stamp<E extends { type: string }>(event: E): E {
    const f = event as E & Frame;
    if ((f.type !== QUEUED && f.type !== INJECTED) || f.input !== undefined || typeof f.session !== 'string' || typeof f.message !== 'string') return event;
    const target = typeof f.target === 'string' ? f.target : 'all';
    const o = this.runs.get(f.session)?.find((x) => !x.injected && x.message === f.message && x.target === target && (f.type === INJECTED || !x.queued));
    if (o === undefined) return event;
    if (f.type === QUEUED) o.queued = true;
    else o.injected = true;
    return { ...event, input: 'voice' };
  }

  /**
   * A run's recorded history (`GET /runs/:id/events`), in capture order: each spoken send claims the first queued and
   * the first injected frame with its message and target captured at or after it was sent. Pure over the history: the
   * live claims are not touched, and the same history always reads the same.
   */
  stampHistory<E extends { type: string }>(runId: string, events: readonly E[]): E[] {
    const sends = this.runs.get(runId);
    if (sends === undefined || sends.length === 0) return [...events];
    const claimed = new Set<number>();
    const stampAt = new Set<number>();
    for (const o of sends) {
      let queuedDone = false;
      for (let i = 0; i < events.length; i++) {
        if (claimed.has(i)) continue;
        const f = events[i] as E & Frame;
        if ((f.type !== QUEUED && f.type !== INJECTED) || f.message !== o.message) continue;
        if ((typeof f.target === 'string' ? f.target : 'all') !== o.target) continue;
        if (typeof f.ts === 'number' && f.ts < o.at - SKEW_MS) continue;
        if (f.type === QUEUED) {
          if (queuedDone) continue;
          queuedDone = true;
          claimed.add(i);
          stampAt.add(i);
          continue;
        }
        claimed.add(i);
        stampAt.add(i);
        break;
      }
    }
    return events.map((e, i) => (stampAt.has(i) && (e as E & Frame).input === undefined ? { ...e, input: 'voice' } : e));
  }
}
