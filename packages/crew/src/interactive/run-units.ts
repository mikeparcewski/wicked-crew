/**
 * The units of an interactive run, as the engine plans them (crew#935, X-MIG M9).
 *
 * `interactive-chat`, `interactive-draft` and `interactive-edit` are wicked-core built-in presets
 * (wicked-core#860). Crew no longer registers a def for them, so it cannot count phases from a
 * def: the run carries the PA's `pa-scope` step first, the engine's floor additions (`critique`,
 * and at higher bands more), and no crew deliverable-floor unit (the engine's floor rides the last
 * creator step). The narration reads the run's own plan instead, from its `unitPlanned` frames.
 *
 * A `unitPlanned` frame names one NEW unit at its ord. A re-plan (after the PA rates the run, the
 * floor adds steps) announces only the units it adds and moves the later ones down, so each new
 * unit is inserted at its ord in the ordered list and the units after it shift by one, as the
 * engine shifts them. The step id is the description's leading token (the engine writes
 * `<step id> — <intent> ||| <instructions>`).
 *
 * A plan edited at a plan-approval gate can also DROP or reorder pending units, which no frame
 * announces; so when the run resumes the fold is re-read from the run's own unit list
 * ({@link resyncRunUnits}).
 */
import type { CoreAdapter } from '../core/adapter.js';
import type { CoreEvent } from '../core/types.js';

/** One planned unit, as narration needs it. */
export interface PlannedUnit {
  /** The plan step id (`pa-scope`, `draft`, `critique`, …). */
  id: string;
  /** `creator` | `evaluator` | `neutral`. */
  role: string;
  /** A deterministic tool unit (no seat, no council). */
  tool: boolean;
}

/** The {@link PlannedUnit} and its ord a `unitPlanned` frame announces, or `null` for any other frame. */
export function plannedUnitOf(event: CoreEvent): { ord: number; unit: PlannedUnit } | null {
  if (event.type !== 'unitPlanned' || typeof event.ord !== 'number' || event.ord < 1) return null;
  const description = typeof event.description === 'string' ? event.description.trim() : '';
  const id = description.split(/\s/, 1)[0] ?? '';
  if (id === '') return null;
  const e = event as { role?: unknown; executorType?: unknown };
  return {
    ord: event.ord,
    unit: {
      id,
      role: typeof e.role === 'string' ? e.role : 'neutral',
      tool: e.executorType === 'tool',
    },
  };
}

/** A step id as a narration line reads it: the PA's rating step says what it does. */
export function describeStep(id: string): string {
  return id === 'pa-scope' ? 'rating the ask before the work starts (pa-scope)' : id;
}

/** The run's planned units in ord order (ord n = index n − 1). */
export class RunUnits {
  /** A hole is a unit the fold has not seen announced (it keeps the later ords honest). */
  private readonly units: Array<PlannedUnit | undefined> = [];

  /** Fold one engine frame; `true` when it was a `unitPlanned` frame. */
  observe(event: CoreEvent): boolean {
    const planned = plannedUnitOf(event);
    if (planned === null) return false;
    const { ord, unit } = planned;
    const at = this.units.findIndex((u) => u?.id === unit.id);
    if (at !== -1) this.units.splice(at, 1); // a re-announced unit moves, never duplicates
    while (this.units.length < ord - 1) this.units.push(undefined);
    this.units.splice(ord - 1, 0, unit);
    return true;
  }

  /** Replace the whole list with the run's units as the engine holds them (ord order). */
  replace(units: readonly PlannedUnit[]): void {
    this.units.splice(0, this.units.length, ...units);
  }

  /** The unit at `ord`, or `undefined` before the engine planned it. */
  at(ord: number): PlannedUnit | undefined {
    return this.units[ord - 1];
  }

  /** The step id at `ord` (`phase <ord>` before it is planned). */
  idAt(ord: number): string {
    return this.at(ord)?.id ?? `phase ${ord}`;
  }

  /** A deterministic tool unit: it has no seat, so its council and routing frames are not narrated. */
  isTool(ord: number): boolean {
    return this.at(ord)?.tool === true;
  }

  /** The unit that writes the deliverable: the LAST agent creator (the engine joins the launch's
   *  declared deliverables to the plan's last creator step, so only its gate verifies the file). */
  isWriter(ord: number): boolean {
    const isCreator = (u: PlannedUnit | undefined): boolean => u !== undefined && !u.tool && u.role === 'creator';
    return isCreator(this.at(ord)) && !this.units.slice(ord).some(isCreator);
  }

  /** An evaluator unit (the engine's `critique`, a review). */
  isEvaluator(ord: number): boolean {
    return this.at(ord)?.role === 'evaluator';
  }

  /** `"<ord>/<units>"`, or `"<ord>"` before any unit is planned. */
  position(ord: number): string {
    return this.units.length > 0 ? `${ord}/${Math.max(this.units.length, ord)}` : `${ord}`;
  }
}

/** One unit of the run as `SessionView.units[]` carries it (the fields the fold reads). */
export interface RunUnitRow {
  id: string;
  ord: number;
  role?: string | null | undefined;
  tool_cmd?: string[] | null | undefined;
}

/** The run's units as {@link PlannedUnit}s in ord order; the step id is the unit id after `<run>:`. */
export function plannedUnitsOfRun(runId: string, rows: readonly RunUnitRow[]): PlannedUnit[] {
  const prefix = `${runId}:`;
  return [...rows]
    .sort((a, b) => a.ord - b.ord)
    .map((r) => ({
      id: r.id.startsWith(prefix) ? r.id.slice(prefix.length) : r.id,
      role: typeof r.role === 'string' ? r.role : 'neutral',
      tool: Array.isArray(r.tool_cmd) && r.tool_cmd.length > 0,
    }));
}

/**
 * Re-read `units` from the run's own unit list (after a gate the plan may have been edited at).
 * Narration only: an engine that cannot answer leaves the fold as it was, and nothing throws.
 */
export async function resyncRunUnits(adapter: CoreAdapter, runId: string, units: RunUnits): Promise<void> {
  if (typeof (adapter as Partial<CoreAdapter>).sessionsDetail !== 'function') return;
  try {
    const view = (await adapter.sessionsDetail()).find((v) => v.session.id === runId);
    if (view !== undefined && view.units.length > 0) {
      units.replace(plannedUnitsOfRun(runId, view.units as readonly RunUnitRow[]));
    }
  } catch {
    // The fold keeps what the frames said.
  }
}

/** The thread line for a run paused for a person (`awaitingHuman`): what it waits on and where to answer. */
export function awaitingHumanLine(event: CoreEvent, runId: string, units: RunUnits): string {
  const e = event as { gateKind?: unknown; prompt?: unknown };
  const ord = typeof event.ord === 'number' ? event.ord : 0;
  const prompt = typeof e.prompt === 'string' ? e.prompt.replace(/\s+/g, ' ').trim() : '';
  const why =
    e.gateKind === 'plan_approval'
      ? 'the plan needs approval before the work starts'
      : `${units.idAt(ord)} needs a person`;
  const clipped = prompt.length > 160 ? `${prompt.slice(0, 157)}…` : prompt;
  return (
    `The run is paused: ${why}${clipped !== '' ? ` (${clipped})` : ''}. Answer it on run ${runId} ` +
    `(studio → Runs); the document lands after that.`
  );
}

/**
 * Holds a run's engine frames while its fold is re-read ({@link resyncRunUnits}), then replays them
 * in order: a dispatch that follows `resumed` must be narrated against the REFRESHED units, not the
 * list a gate edit just changed (codex r2 on crew#938). Frames of other runs pass straight through.
 */
export class ResyncGate {
  private readonly held = new Map<string, CoreEvent[]>();

  constructor(private readonly fold: (event: CoreEvent) => void) {}

  /** Deliver one engine frame: folded now, or queued behind its run's pending re-read. */
  deliver(event: CoreEvent): void {
    const runId = typeof event.session === 'string' ? event.session : undefined;
    const queue = runId === undefined ? undefined : this.held.get(runId);
    if (queue !== undefined) {
      queue.push(event);
      return;
    }
    this.fold(event);
  }

  /** Queue `runId`'s frames until `refresh` settles, then replay them through the fold. */
  hold(runId: string, refresh: Promise<void>): void {
    if (this.held.has(runId)) return; // already held: the pending re-read covers this one
    this.held.set(runId, []);
    void refresh
      .catch(() => undefined)
      .then(() => {
        const queue = this.held.get(runId) ?? [];
        this.held.delete(runId);
        for (const e of queue) this.deliver(e);
      });
  }
}
