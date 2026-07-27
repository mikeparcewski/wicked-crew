import type { AgentSession, RoutingInfo, SessionView, WorkUnit } from '../core/types.js';

/**
 * The run evidence bundle — everything an operator needs to audit a finished run,
 * in one downloadable JSON document (`GET /runs/:id/evidence`).
 *
 * The daemon persists no event log of its own (CoreEvent frames are fanned out
 * over `/ws` and dropped), so the decision trail is RE-DERIVED from the run DTO,
 * which is where core durably records it: `routing` carries the council/routing
 * provenance and `status`/`denial_reason`/`phase_status` carry the gate outcome.
 * Nothing here is invented — every field traces to a field on the run.
 */
export interface EvidenceBundle {
  /** When the bundle was assembled (ISO-8601). */
  exportedAt: string;
  /** The run itself, verbatim from the run DTO. */
  session: AgentSession;
  /** The run's units in `ord` order, each with its captured transcript. */
  units: EvidenceUnit[];
  /** The derived decision trail, in unit order (routing before that unit's gate). */
  events: EvidenceEvent[];
}

/** A unit as it appears in the bundle: the run DTO's unit plus its captured transcript. */
export interface EvidenceUnit extends WorkUnit {
  /** The unit's captured transcript, or `null` when core captured none. */
  transcript: string | null;
  /**
   * Why the transcript is `null` when the read itself failed — present ONLY on
   * failure, so a missing transcript is never silently indistinguishable from a
   * unit that legitimately produced no output.
   */
  transcriptError?: string;
}

/** A gate decision, re-derived from the unit's persisted outcome. */
export interface GateDecisionEvent {
  type: 'gateDecided';
  unitId: string;
  ord: number;
  /** `true` when the unit passed its gate (`done`), `false` when it was `rejected`. */
  allow: boolean;
  denialReason: string | null;
  phaseStatus: string | null;
  conformanceRef: string | null;
}

/** Council / routing provenance, re-derived from the unit's `routing`. */
export interface RoutingDecidedEvent {
  type: 'routingDecided';
  unitId: string;
  ord: number;
  assignedCli: string | null;
  routing: RoutingInfo;
}

export type EvidenceEvent = GateDecisionEvent | RoutingDecidedEvent;

/** Loads one unit's captured transcript (the adapter's `workOutput`). */
export type TranscriptLoader = (coreUnitId: string) => Promise<string | null>;

/**
 * The id core keys the transcript store by. Unit ids are already `<run>:<suffix>`;
 * fall back to the free-text `u<ord>` form for any unit that lacks the prefix
 * (mirrors the `/runs/:id/units/:unitKey/output` route's normalisation).
 */
function coreUnitId(runId: string, unit: WorkUnit): string {
  return unit.id.startsWith(`${runId}:`) ? unit.id : `${runId}:u${unit.ord}`;
}

/**
 * Re-derive the decision trail from the units. A unit contributes its routing
 * provenance (when the council/router recorded one) and its gate decision (once
 * the gate has actually resolved — a `pending`/`distributed` unit has no verdict
 * yet, and an evidence bundle must not imply one).
 */
export function evidenceEvents(units: WorkUnit[]): EvidenceEvent[] {
  const events: EvidenceEvent[] = [];
  for (const unit of [...units].sort((a, b) => a.ord - b.ord)) {
    if (unit.routing) {
      events.push({
        type: 'routingDecided',
        unitId: unit.id,
        ord: unit.ord,
        assignedCli: unit.assigned_cli,
        routing: unit.routing,
      });
    }
    if (unit.status === 'done' || unit.status === 'rejected') {
      events.push({
        type: 'gateDecided',
        unitId: unit.id,
        ord: unit.ord,
        allow: unit.status === 'done',
        denialReason: unit.denial_reason,
        phaseStatus: unit.phase_status,
        conformanceRef: unit.conformance_ref,
      });
    }
  }
  return events;
}

/**
 * Assemble a run's evidence bundle. Transcripts are read per unit; a single
 * unreadable transcript degrades that unit to `transcript: null` + a
 * `transcriptError` rather than failing the whole export — a partial bundle that
 * says which part is missing beats no bundle at all.
 */
export async function buildEvidenceBundle(
  view: SessionView,
  loadTranscript: TranscriptLoader,
): Promise<EvidenceBundle> {
  const ordered = [...view.units].sort((a, b) => a.ord - b.ord);
  const units = await Promise.all(
    ordered.map(async (unit): Promise<EvidenceUnit> => {
      try {
        return { ...unit, transcript: await loadTranscript(coreUnitId(view.session.id, unit)) };
      } catch (err) {
        return {
          ...unit,
          transcript: null,
          transcriptError: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return {
    exportedAt: new Date().toISOString(),
    session: view.session,
    units,
    events: evidenceEvents(ordered),
  };
}

/**
 * `<run-id>-evidence.json`, safe to interpolate into a `Content-Disposition`
 * header. Run ids are client-supplied (`sessionId` on launch), so anything
 * outside the filename-safe set is folded to `_` — a quote or CR in a run id
 * must never break out of the header.
 */
export function evidenceFilename(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return `${safe || 'run'}-evidence.json`;
}
