/**
 * Which operator notes were SPOKEN (program DES-VOICE §3 "Talking to a running job"; api-types 0.161.0).
 *
 * Studio's voice mode sends a confirmed spoken steer through the same `POST /runs/:id/inject` as a typed one, with
 * `input: "voice"`. The engine's `workerMessageQueued` / `workerMessageInjected` frames carry the message but not how
 * it was given, so crew remembers the spoken ones and stamps `input: "voice"` on the frames whose message is one of
 * them: on `/ws` as they pass, and on `GET /runs/:id/events` for a page that reloads. The thread then says
 * "You (by voice)". The label grants nothing; the audit line (`run.injected`) carries it too.
 *
 * In memory and bounded (at most {@link PER_RUN} notes per run, {@link RUNS} runs, oldest dropped): a note spoken
 * before the daemon restarted reads as a plain one on the thread, and its audit line still says voice.
 */

export const PER_RUN = 32;
export const RUNS = 256;

const STAMPED = new Set(['workerMessageQueued', 'workerMessageInjected']);

export class VoiceInjectInputs {
  /** run id → the spoken notes, oldest first. Map order is insertion order: the first key is the oldest run. */
  private readonly runs = new Map<string, string[]>();

  /** A note was sent by voice to `runId`. */
  remember(runId: string, message: string): void {
    const notes = this.runs.get(runId) ?? [];
    this.runs.delete(runId);
    if (!notes.includes(message)) notes.push(message);
    while (notes.length > PER_RUN) notes.shift();
    this.runs.set(runId, notes);
    while (this.runs.size > RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
    }
  }

  /** Whether `message`, sent to `runId`, was spoken. */
  spoken(runId: string, message: string): boolean {
    return this.runs.get(runId)?.includes(message) === true;
  }

  /** The frame with `input: "voice"` when it is a queued/injected note that was spoken; otherwise the same frame. */
  stamp<E extends { type: string }>(event: E): E {
    if (!STAMPED.has(event.type)) return event;
    const f = event as E & { session?: unknown; message?: unknown; input?: unknown };
    if (f.input !== undefined || typeof f.session !== 'string' || typeof f.message !== 'string') return event;
    return this.spoken(f.session, f.message) ? { ...event, input: 'voice' } : event;
  }
}
