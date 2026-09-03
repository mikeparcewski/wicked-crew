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
    /\bi\s+(?:fixed|implemented|added|changed|edited|wrote|created|updated|refactored|regenerated)\b|\bran\s+tests?\b|\btests?\s+(?:pass|passed|green)\b|\ball tests\b|\bthe fix\b|\bcommitted\b|\bsuccessfully\b|\bchanged\s+\d+\s+(?:file|package)|\bdiff --git\b|\b\d+\s+passed\b/i;

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
 * The one rule that turns an event into a cache mutation.
 *
 * Shared verbatim by the live stream and by durable replay so a rebuilt gate cannot disagree with
 * what the live stream would have produced from the same events. Two hand-written folds would be
 * free to drift, and the drift would only ever show up after a restart — the exact condition nobody
 * exercises.
 */
function fold(entries: Map<string, GateCacheEntry>, event: CoreEvent): void {
  const session = typeof event.session === 'string' ? event.session : undefined;
  if (session === undefined) return;
  switch (event.type) {
    case 'awaitingHuman':
      if (typeof event.ord === 'number' && typeof event.prompt === 'string') {
        const refusal = detectRefusal(event.prompt);
        entries.set(session, {
          ord: event.ord,
          prompt: event.prompt,
          lifecycle: 'open',
          receivedAt: observedAt(event),
          // Spread only when matched, so a normal gate's entry is byte-identical (no `refusal` key).
          ...(refusal !== undefined ? { refusal } : {}),
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
 * never read. `rebuild` is that read, which demotes this map to what it was always meant to be: a
 * latency optimisation, not the system of record.
 *
 * NOTE: the full HITL lifecycle from §3.3 (advisory / hard-expiry timers, append-only message log,
 * auto-cancel-on-expiry, synthesized `gateLifecycle` frames) is a deliberate follow-on. This
 * increment caches only the prompt so a late-joining browser can render the gate; `lifecycle` is
 * always `open`.
 */
export class GateCache {
  private readonly entries = new Map<string, GateCacheEntry>();

  /** Fold one live CoreEvent into the cache. */
  ingest(event: CoreEvent): void {
    fold(this.entries, event);
  }

  /**
   * Rebuild one run's gate from its durable event history and adopt the result (FINDING-051).
   *
   * `events` is the run's log oldest-first. Folding all of it yields the last `awaitingHuman` not
   * followed by a resumed/terminal event — i.e. an open gate, or nothing.
   *
   * Deliberately does NOT cross-check the run's live status first: that costs a `sessionsDetail()`
   * on a read path, and the write side is already guarded — approving a run that has moved on is
   * refused by the `status === 'awaiting_human'` check on `POST /runs/:id/gate`. So the worst a
   * stale replay can do is show a prompt that then declines to be approved, and `reconcile` drops
   * it on the next list. The failure mode is a confusing read, never a bad write.
   */
  rebuild(runId: string, events: CoreEvent[]): GateCacheEntry | undefined {
    const replayed = new Map<string, GateCacheEntry>();
    for (const event of events) fold(replayed, event);
    const entry = replayed.get(runId);
    if (entry) this.entries.set(runId, entry);
    return entry;
  }

  /** The cached open gate for a run, if any. */
  get(runId: string): GateCacheEntry | undefined {
    return this.entries.get(runId);
  }

  /**
   * Adopt an entry hydrated from the DURABLE `interaction_requests` table (DES-PROJECT-001
   * §5.3). With that table, this cache is finally what its own comments always claimed — a
   * latency layer over durable truth: the route reads the table on a miss and parks the result
   * here so the next poll is a map hit. `rebuild` (event-log replay) remains the fallback for
   * engines predating the table.
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
