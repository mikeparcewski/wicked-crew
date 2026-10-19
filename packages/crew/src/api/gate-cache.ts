import type { CoreEvent, SessionView } from '../core/types.js';

/** A cached open human gate for a run. */
export interface GateCacheEntry {
  /** The unit `ord` the run paused before. */
  ord: number;
  /** The gate prompt (lives only on the transient event — core does not persist it). */
  prompt: string;
  /** Lifecycle state. Only `open` in this foundation increment (see the class note). */
  lifecycle: 'open';
  /** When the daemon observed the gate. */
  receivedAt: string;
  /**
   * Present ONLY when the gate prompt reads as a pure sandbox/tool refusal — the worker reported it
   * could not act, with no sign of productive work (issue #419). A warning for the operator, never a
   * gate decision; omitted entirely on a normal gate so the wire is byte-identical.
   */
  refusal?: { matched: boolean; reason: string };
  /**
   * WHY the run paused (`awaitingHuman.gateKind`; the durable row's `gate_kind`) —
   * studio#814: without it a reloaded skin could only guess the gate from its unit, and read a
   * refused hand-over's escalation (cursor still on the deliver unit) as a fresh deliver gate.
   * ABSENT when the engine did not say (an older engine, a row written before the field).
   */
  gateKind?: string;
  /**
   * The answer tokens the engine offered (`awaitingHuman.choices`; issue #969) — e.g. a
   * `team_dispute` gate's `['approve', 'request_changes', 'reject']`. Without them a client that
   * missed the live frame could draw only Approve/Reject. ABSENT when the engine offered none.
   */
  choices?: string[];
  /** The index into `choices` of the engine's recommended answer. ABSENT without `choices`. */
  recommended?: number;
}

/**
 * Detect whether a gate prompt is a PURE sandbox/tool refusal — the worker reporting it could not
 * act (read-only sandbox, rejected writes, "could not modify/regenerate"), with NO sign it did real
 * work (issue #419). Returns `{ matched: true, reason }` only when a refusal signature fires AND no
 * work-done phrase vetoes it; `undefined` otherwise. This is a WARNING signal surfaced on the gate
 * wire so an operator does not approve a refusal as if it were work — it never gates a decision.
 *
 * The bias is deliberately toward NOT flagging: a genuine work transcript that merely mentions
 * "sandbox"/"blocked", or a mixed turn that refused one tool but did real work elsewhere, must not
 * be flagged. A missed refusal is a lesser harm than a false one.
 */
export function detectRefusal(text: string): { matched: boolean; reason: string } | undefined {
  const SIGNATURES: Array<{ re: RegExp; reason: string }> = [
    { re: /blocked by[^.\n]*read-only (?:sandbox|workspace)/i, reason: 'blocked by a read-only sandbox' },
    { re: /writes?\s+(?:are|were)\s+rejected/i, reason: 'sandbox rejected writes' },
    { re: /could not (?:modify|regenerate|write|create)\b/i, reason: 'could not modify or regenerate files' },
    { re: /\bno files?\s+(?:were|was)\s+(?:changed|modified|written|created)\b/i, reason: 'no files were changed' },
    { re: /\bi\s+(?:cannot|can[’'`]?t)\s+(?:edit|modify|delete|write|create)\b/i, reason: 'refused a write operation' },
    {
      re: /network access[^.\n]*(?:unavailable|forbidden|blocked)|environment (?:forbids|prohibits)/i,
      reason: 'blocked network/environment access',
    },
  ];
  // Any of these means the turn did real work — veto the flag. Err toward NOT flagging.
  const WORK_DONE =
    /\bi\s+(?:fixed|implemented|added|changed|edited|wrote|created|updated|refactored|regenerated)\b|\bran\s+tests?\b|\btests?\s+(?:pass|passed|green)\b|\ball tests\b|\bthe fix\b|\bcommitted\b|\bsuccessfully\b|\bchanged\s+\d+\s+(?:files?|packages?)|\b\d+\s+(?:files?|packages?)\s+changed\b|\b\d+\s+(?:insertions?|deletions?)\b|\bdiff --git\b|\b\d+\s+passed\b/i;

  const hit = SIGNATURES.find((s) => s.re.test(text));
  if (hit === undefined) return undefined;
  if (WORK_DONE.test(text)) return undefined;
  return { matched: true, reason: hit.reason };
}

/**
 * When a gate was observed, ISO-8601.
 *
 * A replayed log entry carries the engine's own capture-time `ts`; a live frame does not, and for
 * one of those "now" IS the observation time. Using `ts` when it is there is not a nicety: studio
 * sorts the open-gate list newest-first on this field, so stamping a replay with `Date.now()` would
 * collapse every rebuilt gate to the restart instant and scramble their order.
 */
function observedAt(event: CoreEvent): string {
  return new Date(typeof event.ts === 'number' ? event.ts : Date.now()).toISOString();
}

/**
 * The answer set an `awaitingHuman` frame offered, kept only when well-formed (issue #969):
 * `choices` must be a non-empty array of strings, and `recommended` an integer index inside it.
 * A malformed value is dropped rather than served — a skin would render it as buttons. Spread the
 * result, so a gate the engine offered nothing on stays byte-identical on the wire.
 */
export function offeredChoices(event: CoreEvent): { choices?: string[]; recommended?: number } {
  const choices: unknown = event['choices'];
  if (!Array.isArray(choices) || choices.length === 0 || !choices.every((c) => typeof c === 'string')) return {};
  const recommended: unknown = event['recommended'];
  const inBounds = Number.isInteger(recommended) && (recommended as number) >= 0 && (recommended as number) < choices.length;
  return { choices: [...(choices as string[])], ...(inBounds ? { recommended: recommended as number } : {}) };
}

/**
 * The one rule that turns an event into a cache mutation.
 *
 * Shared verbatim by the live stream and by durable replay so a rebuilt gate cannot disagree with
 * what the live stream would have produced from the same events. Two hand-written folds would be
 * free to drift, and the drift would only ever show up after a restart — the exact condition nobody
 * exercises.
 */
/** The event types `fold` acts on — the ones that open or close a run's gate. */
const GATE_EVENTS = new Set(['awaitingHuman', 'resumed', 'sessionCompleted', 'runCancelled', 'sessionFailed']);

function fold(entries: Map<string, GateCacheEntry>, event: CoreEvent): void {
  const session = typeof event.session === 'string' ? event.session : undefined;
  if (session === undefined) return;
  switch (event.type) {
    case 'awaitingHuman':
      if (typeof event.ord === 'number' && typeof event.prompt === 'string') {
        const refusal = detectRefusal(event.prompt);
        const gateKind = typeof event['gateKind'] === 'string' && event['gateKind'] !== '' ? event['gateKind'] : undefined;
        entries.set(session, {
          ord: event.ord,
          prompt: event.prompt,
          lifecycle: 'open',
          receivedAt: observedAt(event),
          // Spread only when matched, so a normal gate's entry is byte-identical (no `refusal` key).
          ...(refusal !== undefined ? { refusal } : {}),
          ...(gateKind !== undefined ? { gateKind } : {}),
          ...offeredChoices(event),
        });
      }
      break;
    case 'resumed':
    case 'sessionCompleted':
    case 'runCancelled':
    case 'sessionFailed':
      entries.delete(session);
      break;
    default:
      break;
  }
}

/**
 * The open gate a run's event history records, or `undefined` — the last `awaitingHuman` not
 * followed by a resumed/terminal event. `events` is the run's log oldest-first. Pure: the same
 * `fold` the live stream uses, over a scratch map, so a replay cannot disagree with what the live
 * stream would have produced from the same events (FINDING-051).
 */
export function replayOpenGate(runId: string, events: CoreEvent[]): GateCacheEntry | undefined {
  const replayed = new Map<string, GateCacheEntry>();
  for (const event of events) fold(replayed, event);
  return replayed.get(runId);
}

/**
 * What one read of a run's open gate from the record yields: the gate; `null` (the record holds
 * no open gate); `'no-log'` (this build cannot read the log, so nothing can be said);
 * `'ambiguous'` (the engine's open gate rows disagree on the ord, so the record cannot say which
 * gate is open — crew#1083 round 5).
 */
export type GateRead = GateCacheEntry | null | 'no-log' | 'ambiguous';

/**
 * What `GateCache.resolve` yields: a read's result, or `'unstable'` — live gate events kept landing
 * while the record was read, so nothing could be verified (crew#1083 round 3). Retryable.
 */
export type GateResolution = GateRead | 'unstable';

/** Narrows a resolution to an open gate: `null`, `'no-log'`, `'ambiguous'` and `'unstable'` are not one. */
export function isOpenGate(resolution: GateResolution | undefined): resolution is GateCacheEntry {
  return typeof resolution === 'object' && resolution !== null;
}

/** The one log call the cache makes (`resolve`): `console` by default, the daemon's logger in `server.ts`. */
export interface GateCacheLog {
  warn(message: string): void;
}

/** How many times `resolve` runs a read that a live gate event overlapped before it stops trying. */
const RESOLVE_ATTEMPTS = 3;

/**
 * Gate-prompt cache over a durable log (DES-STUDIO-001 §3.3).
 *
 * The prompt is keyed by runId — a paused run has exactly one open gate, before `unit_ix`. Entries
 * are pruned on any resumed/terminal event for the run, and re-checked against `sessionsDetail()`
 * on every list reconcile, so the cache can neither leak nor go stale.
 *
 * That self-healing claim was true and beside the point until FINDING-051: every path here was
 * prune-only, so a daemon restart dropped the map and **nothing could put an entry back**. A parked
 * run then kept holding the operator without being able to say what it was asking. The prompt was
 * never actually lost — core records `awaitingHuman` to the event log (core#139) — it was simply
 * never read. `resolve`, fed the route's read of the durable row and the log, is that read, which
 * demotes this map to what it was always meant to be: a latency optimisation, not the system of
 * record.
 *
 * NOTE: the full HITL lifecycle from §3.3 (advisory / hard-expiry timers, append-only message log,
 * auto-cancel-on-expiry, synthesized `gateLifecycle` frames) is a deliberate follow-on. This
 * increment caches only the prompt so a late-joining browser can render the gate; `lifecycle` is
 * always `open`.
 */
export class GateCache {
  private readonly entries = new Map<string, GateCacheEntry>();
  /**
   * Per-run count of the LIVE gate-opening and gate-closing events `ingest` has folded. `resolve`
   * compares it across an async read of the record: a read some event overlapped is run again,
   * never adopted. Never pruned — one number per run seen.
   */
  private readonly revisions = new Map<string, number>();

  constructor(private readonly log: GateCacheLog = console) {}

  /** Fold one live CoreEvent into the cache. */
  ingest(event: CoreEvent): void {
    if (typeof event.session === 'string' && GATE_EVENTS.has(event.type)) {
      this.revisions.set(event.session, this.revision(event.session) + 1);
    }
    fold(this.entries, event);
  }

  private revision(runId: string): number {
    return this.revisions.get(runId) ?? 0;
  }

  /**
   * The run's open gate: the cached entry, else what `read` finds in the record — the durable row,
   * the log — adopted and returned once a read completes with no live gate event of the run's
   * having landed meanwhile. `read` must not consult this cache: it is run again when one does.
   *
   * Neither side of such an overlap is known to be the newer (crew#1083 review). The record may
   * have moved on since the read began — a live `awaitingHuman` for the next gate while an older
   * row was being read — or the engine's pump may have delivered an OLDER frame late: an
   * `awaitingHuman` for a gate the row already shows answered, or that gate's `resumed`. The
   * revision counts arrivals, not order, so the cache cannot pick a winner; the first cut let the
   * live side win and served a late ord-3 frame over a current ord-4 row, which let a decision
   * naming ord 3 pass the gate check and answer ord 4. So no winner is picked. The read is run
   * again, from scratch: the engine writes the row with the pause, so a re-read begun after the
   * overlapping frame arrived reflects whatever that frame announced, and the first read that
   * completes with nothing having landed is adopted.
   *
   * A clean read is the record's word in BOTH directions (crew#1083 round 3): a gate it finds
   * replaces whatever an overlapped `ingest` folded meanwhile, and "no open gate" / "cannot read"
   * EVICTS it — otherwise a late frame folded during attempt one outlived the clean attempt two
   * that found its gate already answered, and was served as a cache hit, unread, from then on. A
   * read that throws evicts the same way. After `RESOLVE_ATTEMPTS` overlapped reads nothing was
   * verified, so nothing is served: the entry is evicted and the result is `'unstable'`, never the
   * unverified entry — an ordinary ordered backlog (`awaitingHuman(2)`, `resumed(2)`,
   * `awaitingHuman(3)`, one landing per read) left the cache holding ord 3 while every read found
   * ord 4. The run is logged once.
   *
   * One read in flight per run (agy, round 4): while a read is running, an entry a live frame
   * folds is unverified, so a concurrent `resolve` awaits the read in flight instead of taking the
   * entry as a hit, and the entry is evicted before a re-read so a `get` meanwhile serves nothing
   * unverified either.
   */
  async resolve(runId: string, read: () => Promise<GateRead>): Promise<GateResolution> {
    const pending = this.inflight.get(runId);
    if (pending !== undefined) return pending;
    const cached = this.entries.get(runId);
    if (cached) return cached;
    const resolution = this.hydrate(runId, read).finally(() => {
      this.inflight.delete(runId);
    });
    this.inflight.set(runId, resolution);
    return resolution;
  }

  /** In-flight resolutions per run: `resolve` hands every concurrent caller the same one. */
  private readonly inflight = new Map<string, Promise<GateResolution>>();

  private async hydrate(runId: string, read: () => Promise<GateRead>): Promise<GateResolution> {
    for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt++) {
      const seen = this.revision(runId);
      let found: GateRead;
      try {
        found = await read();
      } catch (err) {
        this.entries.delete(runId);
        throw err;
      }
      if (this.revision(runId) !== seen) {
        // Whatever a live frame folded during this read is unverified until the re-read settles.
        this.entries.delete(runId);
        continue;
      }
      if (isOpenGate(found)) this.entries.set(runId, found);
      else this.entries.delete(runId);
      return found;
    }
    this.entries.delete(runId);
    this.log.warn(
      `gate cache: live gate events for run ${runId} overlapped ${RESOLVE_ATTEMPTS} reads of its open gate; nothing verified, serving no gate`,
    );
    return 'unstable';
  }

  /**
   * The cached open gate for a run, if any — and nothing while a read of it is in flight: an entry
   * a live frame folded meanwhile is unverified until that read settles, so a sync caller (the GET
   * route's hit path, a steering prompt) falls through to `resolve` and waits (agy, round 4).
   */
  get(runId: string): GateCacheEntry | undefined {
    return this.inflight.has(runId) ? undefined : this.entries.get(runId);
  }

  /**
   * Drop the run's cached gate: the engine's record shows another gate open, or none (crew#1083
   * round 7). The next read hydrates from the record.
   */
  forget(runId: string): void {
    this.entries.delete(runId);
  }

  /**
   * Seed the run's gate synchronously. Nothing can land between the caller's decision and this
   * set, so it needs no guard; a read that awaited anything goes through `resolve`.
   */
  adopt(runId: string, entry: GateCacheEntry): void {
    this.entries.set(runId, entry);
  }

  /** Drop cache entries whose run is no longer `awaiting_human` (self-healing on reconcile). */
  reconcile(views: SessionView[]): void {
    const awaiting = new Set(
      views.filter((v) => v.session.status === 'awaiting_human').map((v) => v.session.id),
    );
    for (const id of [...this.entries.keys()]) {
      if (!awaiting.has(id)) this.entries.delete(id);
    }
  }
}
