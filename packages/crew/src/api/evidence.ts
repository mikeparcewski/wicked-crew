import type { AgentSession, RecordedEvent, SessionView, WorkUnit } from '../core/types.js';

export type { RecordedEvent };

/**
 * The run evidence bundle — everything an operator needs to audit a finished run,
 * in one downloadable JSON document (`GET /runs/:id/evidence`).
 *
 * `events` is core's DURABLE EVENT LOG for the run, read back verbatim. It used to
 * be re-derived here from the unit records, because the daemon persisted no log of
 * its own — which meant an exported bundle carried a handful of pseudo-events in a
 * vocabulary this file invented (`routingDecided`) instead of what actually
 * happened. Re-derivation cannot recover what it never saw: council deliberation
 * and votes, gate depth, escalations, fallbacks, and every timestamp were simply
 * absent, and nothing in the bundle said so. (FINDING-014)
 *
 * Nothing was lost by dropping the derived events: `routing`, `assigned_cli`,
 * `denial_reason`, `phase_status` and `conformance_ref` were their only inputs and
 * they ride in `units` verbatim already.
 */
export interface EvidenceBundle {
  /** When the bundle was assembled (ISO-8601). */
  exportedAt: string;
  /** The run itself, verbatim from the run DTO. */
  session: AgentSession;
  /** The run's units in `ord` order, each with its captured transcript. */
  units: EvidenceUnit[];
  /**
   * The run's recorded event history, oldest first — the same frames `/ws` carried
   * live, each with a capture-time `ts` and an ordering `seq`.
   */
  events: RecordedEvent[];
  /**
   * Why `events` is empty, present ONLY when it is. An empty trail must never be
   * indistinguishable from a run that genuinely decided nothing — the same posture
   * `transcriptError` takes for a unit.
   */
  eventsUnavailable?: string;
  /**
   * Structured assumptions re-parsed from the transcripts (the external-transform
   * convention): third-party payload transformations agents relied on. Entries with
   * `known: false` are needs-research placeholders awaiting human review.
   */
  assumptions: EvidenceAssumption[];
}

/** One external-transform assumption parsed from a unit transcript. */
export interface EvidenceAssumption {
  ord: number;
  kind: 'external-transform';
  library: string;
  transform: string;
  known: boolean;
  detail: string;
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

/** Loads one unit's captured transcript (the adapter's `workOutput`). */
export type TranscriptLoader = (coreUnitId: string) => Promise<string | null>;

/**
 * Loads a run's recorded event history (the adapter's `runEvents`).
 *
 * `null` means the engine has no event-log binding at all — a capability gap, not an empty run.
 * The adapter returns it rather than `[]` so this module can say which of the two happened.
 */
export type EventLoader = (runId: string) => Promise<RecordedEvent[] | null>;

/**
 * The id core keys the transcript store by. Unit ids are already `<run>:<suffix>`;
 * fall back to the free-text `u<ord>` form for any unit that lacks the prefix
 * (mirrors the `/runs/:id/units/:unitKey/output` route's normalisation).
 */
function coreUnitId(runId: string, unit: WorkUnit): string {
  return unit.id.startsWith(`${runId}:`) ? unit.id : `${runId}:u${unit.ord}`;
}

/**
 * Why a run's `events` came back empty. Both cases are reported, never conflated:
 * a read that failed is an operator problem, a run with no recorded history is a
 * statement about that run.
 */
const NO_EVENTS_RECORDED =
  'core recorded no events for this run — it ran before the durable event log existed ' +
  '(FINDING-014), or its log was removed. This is not a run that made no decisions.';

/**
 * The third cause, and a different kind of problem from the other two: the engine BUILD in use
 * exposes no `runEvents` binding, so no run on this daemon has a readable trail. Reporting that as
 * "this run recorded nothing" would blame the run for a missing capability — the FINDING-050 shape,
 * distinct causes wearing one message.
 */
const NO_EVENT_LOG_BINDING =
  'the running wicked-core build exposes no durable event log (runEvents), so no decision trail ' +
  'can be read for any run on this daemon — rebuild/reinstall wicked-core-ts. This says nothing ' +
  'about what this run decided.';

/**
 * Assemble a run's evidence bundle.
 *
 * Every read degrades in place rather than failing the export: an unreadable
 * transcript becomes `transcript: null` + `transcriptError` on that unit, and an
 * unreadable event history becomes `events: []` + `eventsUnavailable`. A partial
 * bundle that says which part is missing beats no bundle at all — but it must say
 * so, or the gap reads as a fact about the run.
 */
export async function buildEvidenceBundle(
  view: SessionView,
  loadTranscript: TranscriptLoader,
  loadEvents: EventLoader,
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

  let events: RecordedEvent[] = [];
  let eventsUnavailable: string | undefined;
  try {
    const loaded = await loadEvents(view.session.id);
    if (loaded === null) {
      eventsUnavailable = NO_EVENT_LOG_BINDING;
    } else {
      events = loaded;
      if (events.length === 0) eventsUnavailable = NO_EVENTS_RECORDED;
    }
  } catch (err) {
    eventsUnavailable = `could not read the run's event history: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  return {
    exportedAt: new Date().toISOString(),
    session: view.session,
    units,
    events,
    ...(eventsUnavailable === undefined ? {} : { eventsUnavailable }),
    assumptions: units.flatMap((u) => parseAssumptions(u.ord, u.transcript)),
  };
}

const ASSUMPTION_MARKER = 'ASSUMPTION[external-transform]';
const MAX_ASSUMPTIONS_PER_UNIT = 16;

/**
 * Parse external-transform markers from one transcript — mirrors wicked-core's
 * `assumptions::parse` (same grammar, same malformed→needs-review posture) so the
 * bundle matches what the live event stream reported.
 */
export function parseAssumptions(ord: number, transcript: string | null): EvidenceAssumption[] {
  if (transcript === null) return [];
  const found: EvidenceAssumption[] = [];
  for (const raw of transcript.split('\n')) {
    const ix = raw.indexOf(ASSUMPTION_MARKER);
    if (ix === -1) continue;
    const rest = raw.slice(ix + ASSUMPTION_MARKER.length).trim();
    const sep = rest.indexOf('::');
    const fields = (sep === -1 ? rest : rest.slice(0, sep)).trim();
    const detail = (sep === -1 ? '' : rest.slice(sep + 2)).trim();

    const token = (key: string): string => {
      const kix = fields.indexOf(key);
      if (kix === -1) return '';
      return fields.slice(kix + key.length).split(/\s+/)[0] ?? '';
    };
    const span = (key: string, stops: string[]): string => {
      const kix = fields.indexOf(key);
      if (kix === -1) return '';
      const after = fields.slice(kix + key.length);
      const end = Math.min(
        ...stops.map((st) => {
          const i = after.indexOf(st);
          return i === -1 ? after.length : i;
        }),
        after.length,
      );
      return after.slice(0, end).trim();
    };

    const library = token('library=');
    const confidence = token('confidence=');
    const transform = span('transform=', ['confidence=', 'library=']);
    const wellFormed =
      library !== '' && transform !== '' && (confidence === 'known' || confidence === 'needs-research');

    found.push(
      wellFormed
        ? {
            ord,
            kind: 'external-transform',
            library: clip(library),
            transform: clip(transform),
            known: confidence === 'known',
            detail: clip(detail === '' ? '(no detail provided)' : detail),
          }
        : {
            ord,
            kind: 'external-transform',
            library: library === '' ? '(unspecified)' : clip(library),
            transform: transform === '' ? '(unspecified transformation)' : clip(transform),
            known: false,
            detail: clip(`malformed marker, review the source line: ${rest}`),
          },
    );
    if (found.length >= MAX_ASSUMPTIONS_PER_UNIT) break;
  }
  return found;
}

function clip(s: string): string {
  return s.length > 400 ? s.slice(0, 400) : s;
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
