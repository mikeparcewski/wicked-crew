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
 */
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
  private readonly units: PlannedUnit[] = [];

  /** Fold one engine frame; `true` when it was a `unitPlanned` frame. */
  observe(event: CoreEvent): boolean {
    const planned = plannedUnitOf(event);
    if (planned === null) return false;
    const { ord, unit } = planned;
    const at = this.units.findIndex((u) => u.id === unit.id);
    if (at !== -1) this.units.splice(at, 1); // a re-announced unit moves, never duplicates
    this.units.splice(Math.min(ord - 1, this.units.length), 0, unit);
    return true;
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

  /** The agent creator unit: the one that writes the deliverable. */
  isWriter(ord: number): boolean {
    const u = this.at(ord);
    return u !== undefined && !u.tool && u.role === 'creator';
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
