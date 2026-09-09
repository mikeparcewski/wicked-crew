/**
 * Which published generations a LIVE run may still be reading (design v3 DECISION 1: "old
 * generations are reaped only after no live session references them").
 *
 * The engine resolves `WICKED_SKILLS_SNAPSHOT` at every worker spawn and reports the generation it
 * ADMITTED as a `skillsSnapshotHanded` CoreEvent ({session, gen, …}) — the authoritative record of
 * which generation each session's spawn was actually handed. Crew pins from that:
 *
 *   - a session is tracked from its first event; a `skillsSnapshotHanded` pins the EXACT generation
 *     the engine reports (its `gen` field), never "whatever `current` happens to be when crew
 *     observes some later event" — a worker that acquired generation 1 keeps generation 1 pinned
 *     even after a publish has advanced `current` to 2 (codex round 3);
 *   - every generation published WHILE the session is live is pinned to it too — its next unit
 *     spawn reads (and will report) the new `current`;
 *   - the terminal frame (`sessionCompleted` / `sessionFailed` / `runCancelled` — the same triple
 *     api/seat-health.ts drops assignments on) releases every pin the session held.
 *
 * Until the engine's event arrives, a LAUNCH could already have read the generation crew last
 * handed out (`WICKED_SKILLS_SNAPSHOT` is exported at boot / after every publish). Crew records
 * that generation as a LAUNCH PIN when it hands the env (runtime.afterPublish → `launched`), and
 * reaping keeps any launch-pinned generation until an engine event confirms which generation the
 * launch used. Launch pins are bounded to the most recent window so the set cannot grow without
 * limit — a launch that read a generation older than that has long since reported (or ended), and
 * the engine's `skillsSnapshotHanded` has taken over as the durable session pin.
 *
 * The ledger is in-memory: the engine is in-process, so a daemon restart ends every worker it
 * spawned, and a resumed run's next spawn reads (and reports) `current`.
 */

import type { CoreEvent } from '../core/types.js';

/** The frames after which a session spawns nothing more. */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled']);

/** The engine's per-spawn record of the generation it handed a session. */
const SKILLS_SNAPSHOT_HANDED = 'skillsSnapshotHanded';

/**
 * How far back a launch pin is retained. A launch reading a generation older than the newest
 * `LAUNCH_PIN_WINDOW` handed generations has already spawned and reported its
 * `skillsSnapshotHanded` (which becomes the durable session pin); keeping the window small bounds
 * the set while still bridging the spawn→event gap. Matches the reaper's `KEEP_GENERATIONS`.
 */
const LAUNCH_PIN_WINDOW = 3;

export type LiveGenerationObservation = 'pinned' | 'released' | 'ignored';

/** The generation a `skillsSnapshotHanded` reports, or `null` (a live-cache fallback carries no
 *  reapable generation — `gen: null`). */
function handedGeneration(event: CoreEvent): number | null {
  const gen = (event as { gen?: unknown }).gen;
  if (typeof gen !== 'string' || !/^\d+$/.test(gen)) return null;
  const n = Number(gen);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export class LiveGenerations {
  private readonly sessions = new Map<string, Set<number>>();
  /** Generations crew has handed to launches but no engine event has yet confirmed — kept pinned
   *  through the spawn→`skillsSnapshotHanded` gap, bounded to the recent window. */
  private readonly launchPins = new Set<number>();

  /**
   * Fold one CoreEvent: track a live session, pin the EXACT generation the engine reports on a
   * `skillsSnapshotHanded`, release on a terminal frame. A non-`skillsSnapshotHanded` event only
   * tracks the session — it never pins "current at event time" (the bug this replaces): the
   * generation a spawn actually used comes from the engine's own report, and the pre-report window
   * is covered by the launch pin recorded when the env was handed.
   */
  observe(event: CoreEvent): LiveGenerationObservation {
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
    if (event.type === SKILLS_SNAPSHOT_HANDED) {
      const gen = handedGeneration(event);
      if (gen !== null) {
        gens.add(gen);
        // The engine confirmed which generation this launch used — its conservative launch pin is
        // now covered by a durable session pin that lives until the session's terminal frame.
        this.launchPins.delete(gen);
      }
    }
    return 'pinned';
  }

  /**
   * Crew handed `WICKED_SKILLS_SNAPSHOT` at generation `gen` to new launches (runtime.afterPublish).
   * A launch reading it may spawn a worker before crew observes the engine's `skillsSnapshotHanded`,
   * so the generation is pinned until such an event confirms it. Bounded to the recent window: a
   * pin older than that is dropped (the launch has long since reported or ended).
   */
  launched(gen: number | null): void {
    if (gen === null) return;
    this.launchPins.add(gen);
    for (const g of this.launchPins) {
      if (g < gen - LAUNCH_PIN_WINDOW) this.launchPins.delete(g);
    }
  }

  /** A generation was just published: every live session may read it at its next spawn. */
  published(gen: number): void {
    for (const gens of this.sessions.values()) gens.add(gen);
  }

  /** The union of every live session's pins and the open launch pins — what the reaper must keep. */
  pinned(): ReadonlySet<number> {
    const out = new Set<number>(this.launchPins);
    for (const gens of this.sessions.values()) for (const gen of gens) out.add(gen);
    return out;
  }

  /** Live sessions being tracked (diagnostics + tests). */
  liveSessions(): string[] {
    return [...this.sessions.keys()].sort();
  }
}
