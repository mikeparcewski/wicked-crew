/**
 * Which published generations a LIVE run may still be reading (design v3 DECISION 1: "old
 * generations are reaped only after no live session references them").
 *
 * The engine resolves `WICKED_SKILLS_SNAPSHOT` at every worker spawn and reports the generation it
 * ADMITTED as a `skillsSnapshotHanded` CoreEvent ({session, gen, …}) — the authoritative record of
 * which generation each session's spawn was actually handed. Crew keeps TWO kinds of pin:
 *
 *   session pins   a session is tracked from its first event; a `skillsSnapshotHanded` pins the
 *                  EXACT generation the engine reports (its `gen` field), never "whatever `current`
 *                  happens to be when crew observes some later event" (codex round 3); every
 *                  generation published WHILE the session is live is pinned to it too — its next
 *                  unit spawn reads (and will report) the new `current`; the terminal frame
 *                  (`sessionCompleted` / `sessionFailed` / `runCancelled` — the same triple
 *                  api/seat-health.ts drops assignments on) releases every pin the session held.
 *
 *   launch pins    EXPLICIT ACCOUNTING for the gap between a launch and the engine's report. When
 *                  the daemon hands a launch to the engine (`CoreAdapter.onLaunch`: launchRun,
 *                  resumeRun, confirmGate, launchCampaign, resumeCampaign — every path a spawn can
 *                  come from; the campaign's own DAG-node runs are pinned as the engine announces
 *                  them, `campaignNodeStarted`, under the campaign's umbrella pin), crew opens a pin
 *                  for that launch holding the generation the env exports RIGHT NOW, and every
 *                  generation published after that is added to it (the spawn may read any of them).
 *                  A launch pin is released ONLY when the engine reports the handed generation for
 *                  that session (`skillsSnapshotHanded` — the session pin takes over), when the
 *                  run/campaign reaches a terminal state, or when the engine REJECTED the launch
 *                  (nothing will ever read it). It never expires by publish count or age (codex
 *                  round 4: a bounded window let a run's generation be reaped while its handoff
 *                  report was still outstanding — publish count bounds nothing about handoff delay).
 *                  Reaping skips any generation with an unreleased launch pin.
 *
 * The ledger is in-memory: the engine is in-process, so a daemon restart ends every worker it
 * spawned, and a resumed run's launch (`resumeRun`) opens a fresh launch pin.
 */

import type { CoreEvent } from '../core/types.js';

/** The frames after which a session spawns nothing more. */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled']);

/** The frames after which a campaign launches no more node runs. */
const CAMPAIGN_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['campaignCompleted', 'campaignFailed', 'campaignCancelled']);

/** The engine's per-spawn record of the generation it handed a session. */
const SKILLS_SNAPSHOT_HANDED = 'skillsSnapshotHanded';

/** The engine's announcement of a campaign DAG-node run: `{campaign, node, runId}`. */
const CAMPAIGN_NODE_STARTED = 'campaignNodeStarted';

export type LiveGenerationObservation = 'pinned' | 'released' | 'ignored';

/** What the daemon hands the engine: a run (launch / resume / gate answer) or a campaign. */
export type LaunchKind = 'run' | 'campaign';

/** The generation a `skillsSnapshotHanded` reports, or `null` (a live-cache fallback carries no
 *  reapable generation — `gen: null`). */
function handedGeneration(event: CoreEvent): number | null {
  const gen = (event as { gen?: unknown }).gen;
  if (typeof gen !== 'string' || !/^\d+$/.test(gen)) return null;
  const n = Number(gen);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class LiveGenerations {
  /** Session pins: session id → the generations the engine reported + every one published since. */
  private readonly sessions = new Map<string, Set<number>>();
  /** Launch pins: `run:<id>` / `campaign:<id>` → the generations the launch may read, until it is accounted for. */
  private readonly launchPins = new Map<string, Set<number>>();
  /** The generation the env exports right now (`exported`), or `null` when none is (fallback / unpublished). */
  private exportedGen: number | null = null;

  private static key(kind: LaunchKind, id: string): string {
    return `${kind}:${id}`;
  }

  /**
   * Fold one CoreEvent: track a live session, pin the EXACT generation the engine reports on a
   * `skillsSnapshotHanded` (releasing that session's launch pin — the engine has accounted for the
   * launch), release on a terminal frame; pin a campaign's node run as the engine announces it and
   * release the campaign's pin on its terminal frame. A non-`skillsSnapshotHanded` session event
   * only tracks the session — it never pins "current at event time" (the bug codex round 3
   * replaced): the generation a spawn actually used comes from the engine's own report, and the
   * pre-report window is covered by the launch pin.
   */
  observe(event: CoreEvent): LiveGenerationObservation {
    const campaign = nonEmpty((event as { campaign?: unknown }).campaign);
    if (campaign !== undefined && event.session === undefined) {
      if (CAMPAIGN_TERMINAL_EVENT_TYPES.has(event.type)) {
        return this.launchPins.delete(LiveGenerations.key('campaign', campaign)) ? 'released' : 'ignored';
      }
      if (event.type === CAMPAIGN_NODE_STARTED) {
        const runId = nonEmpty((event as { runId?: unknown }).runId);
        if (runId === undefined) return 'ignored';
        this.launched('run', runId);
        return 'pinned';
      }
      return 'ignored';
    }
    const session = nonEmpty(event.session);
    if (session === undefined) return 'ignored';
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      const hadSession = this.sessions.delete(session);
      const hadLaunch = this.launchPins.delete(LiveGenerations.key('run', session));
      return hadSession || hadLaunch ? 'released' : 'ignored';
    }
    let gens = this.sessions.get(session);
    if (gens === undefined) {
      gens = new Set<number>();
      this.sessions.set(session, gens);
    }
    if (event.type === SKILLS_SNAPSHOT_HANDED) {
      const gen = handedGeneration(event);
      if (gen !== null) gens.add(gen);
      // The engine has accounted for this launch — which generation it used (or that it used
      // none: a live-cache fallback). The durable session pin lives until the terminal frame.
      this.launchPins.delete(LiveGenerations.key('run', session));
    }
    return 'pinned';
  }

  /**
   * The env now exports generation `gen` to new launches (`WICKED_SKILLS_SNAPSHOT`;
   * runtime.afterPublish), or nothing (`null`). A launch pin opened after this starts from it.
   */
  exported(gen: number | null): void {
    this.exportedGen = gen;
  }

  /**
   * The daemon is handing a launch to the engine (before the engine call, so no spawn can read the
   * env ahead of the pin): open its launch pin at the generation the env exports right now. The pin
   * accumulates every later publish (`published`) and is released only by the engine's report for
   * that session, the run's / campaign's terminal frame, or `launchRejected`.
   */
  launched(kind: LaunchKind, id: string): void {
    const key = LiveGenerations.key(kind, id);
    const gens = this.launchPins.get(key) ?? new Set<number>();
    if (this.exportedGen !== null) gens.add(this.exportedGen);
    this.launchPins.set(key, gens);
  }

  /** The engine REFUSED the launch (the call rejected): nothing will read it — release its pin. */
  launchRejected(kind: LaunchKind, id: string): void {
    this.launchPins.delete(LiveGenerations.key(kind, id));
  }

  /** A generation was just published: every live session and every open launch may read it at its next spawn. */
  published(gen: number): void {
    for (const gens of this.sessions.values()) gens.add(gen);
    for (const gens of this.launchPins.values()) gens.add(gen);
  }

  /** The union of every live session's pins and every open launch pin — what the reaper must keep. */
  pinned(): ReadonlySet<number> {
    const out = new Set<number>();
    for (const gens of this.sessions.values()) for (const gen of gens) out.add(gen);
    for (const gens of this.launchPins.values()) for (const gen of gens) out.add(gen);
    return out;
  }

  /** Live sessions being tracked (diagnostics + tests). */
  liveSessions(): string[] {
    return [...this.sessions.keys()].sort();
  }

  /** Launches handed to the engine and not yet accounted for (`run:<id>` / `campaign:<id>`; diagnostics + tests). */
  openLaunches(): string[] {
    return [...this.launchPins.keys()].sort();
  }
}
