/**
 * A RUN'S CAPABILITY FENCE (DES-CATALOG-002 §2.3, §9.2 (k)). Some crew runs must reach nothing: the hidden
 * `detect-shape` turn reads a person's words (data, possibly carrying an instruction aimed at it) and answers one line.
 * Its fence is the run's identity, checked where a unit reaches anything: its MCP tool list is empty, and the broker and
 * the estate relay refuse every call (a read, a proposal) before anything runs.
 *
 * A fence answers from the run id itself (a fenced run's id carries {@link FENCED_ID_PREFIX}), crew's registry of the
 * runs it launched under a fenced name, and the name the engine recorded at launch. An ordinary run's call never
 * depends on a read: a run is fenced by what it provably is.
 */

import { randomUUID } from 'node:crypto';

/** The pick store as the fence reads it (RunSourcePicks satisfies it). */
export interface SourcePicks { get(runId: string): string[] | null }

/** Whether a run may reach a registered source: no pick = the switches alone; a pick = only its names. A store that throws = false. */
export function pickAllows(picks: SourcePicks | undefined, runId: string, sourceName: string): boolean {
  try {
    const ids = picks?.get(runId) ?? null;
    return ids === null || ids.includes(sourceName);
  } catch {
    return false;
  }
}

export const PICK_RULE = 'crew:source-pick';

/**
 * A fenced run's id carries its fence (codex r1): every `detect-shape` run id starts with this prefix (a valid UUID head),
 * so the fence holds without any state, across a restart and whatever the engine's log can be read. An ordinary run
 * drawing the same 32-bit head by chance is fenced too: the safe direction.
 */
export const FENCED_ID_PREFIX = 'de7ec75e-';

/** A new run id for a fenced run (`de7ec75e-xxxx-4xxx-yxxx-xxxxxxxxxxxx`). */
export function fencedRunId(): string {
  return `${FENCED_ID_PREFIX}${randomUUID().slice(FENCED_ID_PREFIX.length)}`;
}

/** Whether a run is fenced off every capability. */
export type RunFence = (runId: string) => Promise<boolean>;

export const FENCE_RULE = 'crew:run-fence';
export const FENCE_REASON = "this run reaches nothing: it is crew's one-turn reading of a person's words (detect-shape), which has no tools";
export const FENCE_REMEDY = 'answer from the task as given';

/** The fence over a set of fenced workflow names: crew's registry first, then the engine's recorded launch name. */
export function runFence(o: {
  /** Run ids crew launched under a fenced name (registered BEFORE the launch). */
  registered: (runId: string) => boolean;
  /** The name the engine recorded the run's launch under; `undefined` = unknown. */
  launchedAs?: (runId: string) => Promise<string | null | undefined>;
  names: ReadonlySet<string>;
}): RunFence {
  return async (runId) => {
    if (runId.startsWith(FENCED_ID_PREFIX) || o.registered(runId)) return true;
    if (o.launchedAs === undefined) return false;
    try {
      const name = await o.launchedAs(runId);
      return typeof name === 'string' && o.names.has(name);
    } catch {
      return false;
    }
  };
}

/** The names whose runs are fenced: crew's own detection turn. */
export const FENCED_WORKFLOWS: ReadonlySet<string> = new Set(['detect-shape']);

/**
 * The run ids this daemon launched under a fenced name, registered BEFORE each launch (a fast unit's first call can
 * land before the launch answers). Kept for a day after registration: a detection run lives seconds.
 */
export class FencedRuns {
  private readonly ids = new Map<string, number>();
  constructor(private readonly ttlMs = 24 * 60 * 60_000, private readonly now: () => number = Date.now) {}

  add(runId: string): void {
    this.ids.set(runId, this.now());
    if (this.ids.size > 4096) {
      const cutoff = this.now() - this.ttlMs;
      for (const [id, at] of this.ids) if (at < cutoff) this.ids.delete(id);
    }
  }

  has(runId: string): boolean {
    const at = this.ids.get(runId);
    return at !== undefined && this.now() - at <= this.ttlMs;
  }
}

/** This process's registry (one daemon per process). */
export const FENCED_RUNS = new FencedRuns();

/** The daemon's fence: the registry, then the engine's recorded launch name. */
export function daemonRunFence(launchedAs?: (runId: string) => Promise<string | null | undefined>): RunFence {
  return runFence({ registered: (id) => FENCED_RUNS.has(id), ...(launchedAs !== undefined ? { launchedAs } : {}), names: FENCED_WORKFLOWS });
}
