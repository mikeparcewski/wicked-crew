/**
 * Which published generations a LIVE run may still be reading (design v3 DECISION 1: "old
 * generations are reaped only after no live session references them").
 *
 * The engine resolves `WICKED_SKILLS_SNAPSHOT` at every worker spawn (`skills_snapshot::admit_unit`)
 * and reports the generation it handed out as a `[wicked-core] skills.snapshot gen=…` line on its
 * stderr — the daemon's own fd 2, which an in-process engine gives crew no stream to read back.
 * So crew pins CONSERVATIVELY from the event stream it does see, by construction never less than
 * the engine could have used:
 *
 *   - a session is tracked from its first event and pinned to the generation `current` resolved
 *     to at that moment (what a spawn in flight reads);
 *   - every generation published WHILE the session is live is pinned to it too — its next unit
 *     spawn reads the new `current`;
 *   - the terminal frame (`sessionCompleted` / `sessionFailed` / `runCancelled` — the same triple
 *     api/seat-health.ts drops assignments on) releases every pin the session held.
 *
 * A generation the engine read was `current` at some instant of the session's life, and every such
 * instant is covered by one of the two rules. The ledger is in-memory: the engine is in-process, so
 * a daemon restart ends every worker it spawned, and a resumed run's next spawn reads `current`.
 */

import type { CoreEvent } from '../core/types.js';

/** The frames after which a session spawns nothing more. */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled']);

export type LiveGenerationObservation = 'pinned' | 'released' | 'ignored';

export class LiveGenerations {
  private readonly sessions = new Map<string, Set<number>>();

  /**
   * Fold one CoreEvent: track + pin a live session to `currentGen` (a `null` generation — nothing
   * published yet — tracks the session so later publishes pin to it), release on a terminal frame.
   */
  observe(event: CoreEvent, currentGen: number | null): LiveGenerationObservation {
    const session = event.session;
    if (typeof session !== 'string' || session === '') return 'ignored';
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      return this.sessions.delete(session) ? 'released' : 'ignored';
    }
    let gens = this.sessions.get(session);
    if (gens === undefined) {
      gens = new Set<number>();
      this.sessions.set(session, gens);
    }
    if (currentGen !== null) gens.add(currentGen);
    return 'pinned';
  }

  /** A generation was just published: every live session may read it at its next spawn. */
  published(gen: number): void {
    for (const gens of this.sessions.values()) gens.add(gen);
  }

  /** The union of every live session's pins — what the reaper must keep. */
  pinned(): ReadonlySet<number> {
    const out = new Set<number>();
    for (const gens of this.sessions.values()) for (const gen of gens) out.add(gen);
    return out;
  }

  /** Live sessions being tracked (diagnostics + tests). */
  liveSessions(): string[] {
    return [...this.sessions.keys()].sort();
  }
}
