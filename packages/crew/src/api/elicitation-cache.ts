import type { CoreEvent, SessionView } from '../core/types.js';

/**
 * One pending elicitation for a run.
 *
 * Keyed by `runId`; there is at most one pending elicitation per run at a time
 * (the bridge cancels any prior slot before opening a new one).
 */
export interface ElicitationEntry {
  runId: string;
  elicitationId: string;
  message: string;
  /** Ordered set of valid responses; `null` means free-text. */
  options: string[] | null;
  /**
   * (C3, api-types 0.83.0) The index into `options` the PRODUCER of the options recommends (the
   * engine's `elicitationCreated.recommended`). Absent ⇒ nothing is preselected. Never set on a
   * free-text elicitation, and dropped when it does not name one of `options`.
   */
  recommended?: number;
  /**
   * (ask) Who asked: the engine's additive `elicitationCreated` fields for a seat's MCP `ask`
   * question — `source: "ask"`, the asking unit's `ord` and `attempt`, and the `seat` key that asked.
   * Kept only when well-formed and absent for every other producer, so a skin names the asker
   * rather than the seat the run is running now.
   */
  source?: 'ask';
  ord?: number;
  attempt?: number;
  seat?: string;
  /**
   * (api-types 0.158.0) A multi-select: the answer picks `min..=max` of `options`. Kept only when well-formed
   * against `options` (the engine normalises both bounds); absent on a single-choice or free-text question.
   */
  multi?: { min: number; max: number };
  /** When the daemon observed the elicitation — ISO-8601. */
  receivedAt: string;
}

/** The (ask) asker fields of a frame or entry: only for an ask question (`source: "ask"`), each kept only
 *  when well-formed. Another producer's frame carries none of them, whatever else it sends. */
export function askerFields(raw: {
  source?: unknown;
  ord?: unknown;
  attempt?: unknown;
  seat?: unknown;
}): Pick<ElicitationEntry, 'source' | 'ord' | 'attempt' | 'seat'> {
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (raw.source !== 'ask') return {};
  return {
    source: 'ask' as const,
    ...(count(raw.ord) ? { ord: raw.ord } : {}),
    ...(count(raw.attempt) ? { attempt: raw.attempt } : {}),
    ...(typeof raw.seat === 'string' && raw.seat.trim() !== '' ? { seat: raw.seat } : {}),
  };
}

/**
 * C3: the producer's recommended option index, kept only when it names one of `options` — a
 * non-negative integer below `options.length`. Anything else is dropped (absent ⇒ nothing
 * preselected), never clamped or guessed.
 */
export function recommendedIndex(raw: unknown, options: readonly unknown[] | null | undefined): number | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= options.length) return undefined;
  return raw;
}

/** A multi-select's bounds, kept only when both are integers with `1 <= min <= max <= options.length`. */
export function multiBounds(raw: unknown, options: readonly unknown[] | null | undefined): { min: number; max: number } | undefined {
  if (!Array.isArray(options) || options.length < 2 || typeof raw !== 'object' || raw === null) return undefined;
  const { min, max } = raw as { min?: unknown; max?: unknown };
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  if (!int(min) || !int(max) || min < 1 || min > max || max > options.length) return undefined;
  return { min, max };
}

/** Session statuses that mean the run will never elicit again. */
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

/** CoreEvent types that signal a run is terminal (matching TERMINAL_STATUSES). */
const TERMINAL_EVENTS = new Set(['sessionCompleted', 'runCancelled', 'sessionFailed']);

/**
 * Pending-elicitation display store (DES-002 §4 P-2 / §6.3).
 *
 * Keyed by `runId`. The generation counter (one per run) guards against zombie
 * entries: any mutation that makes a previously-taken entry stale bumps the
 * counter, so `restoreIfUnchanged` is a no-op after a terminal event or a new
 * elicitation arrived in the window between `take()` and a failed POST.
 *
 * # Concurrency model
 *
 * This runs on Node's single event-loop thread — all operations are synchronous
 * and therefore atomic at the JS level. `take()` atomically removes the entry
 * and returns the generation snapshot; `restoreIfUnchanged` only writes back if
 * the generation is unchanged (no intervening mutation).
 */
export class ElicitationCache {
  private readonly entries = new Map<string, ElicitationEntry>();
  /** Monotone generation counter per run. Starts at 0; every mutation increments. */
  private readonly gens = new Map<string, number>();

  private bumpGen(runId: string): void {
    this.gens.set(runId, (this.gens.get(runId) ?? 0) + 1);
  }

  /**
   * Store a new elicitation for a run, replacing any previous one.
   *
   * Caller supplies all fields except `receivedAt`, which is stamped here.
   */
  create(entry: Omit<ElicitationEntry, 'receivedAt'>): void {
    this.entries.set(entry.runId, {
      runId: entry.runId,
      elicitationId: entry.elicitationId,
      message: entry.message,
      options: entry.options ?? null,
      ...(recommendedIndex(entry.recommended, entry.options) !== undefined ? { recommended: entry.recommended as number } : {}),
      ...askerFields(entry),
      ...(multiBounds(entry.multi, entry.options) !== undefined ? { multi: multiBounds(entry.multi, entry.options)! } : {}),
      receivedAt: new Date().toISOString(),
    });
    this.bumpGen(entry.runId);
  }

  /** The current pending elicitation for a run, if any. Does not mutate. */
  get(runId: string): ElicitationEntry | undefined {
    return this.entries.get(runId);
  }

  /**
   * Atomically remove and return the entry for a run, together with the
   * generation snapshot at the moment of removal.
   *
   * Returns `undefined` when there is no pending elicitation for the run.
   * The generation counter is NOT incremented by `take` itself — only
   * subsequent mutations (new elicitation, terminal event, reconcile) bump it.
   * This is intentional: it lets `restoreIfUnchanged` detect exactly those
   * mutations without counting the take itself as a change.
   */
  take(runId: string): { entry: ElicitationEntry; gen: number } | undefined {
    const entry = this.entries.get(runId);
    if (!entry) return undefined;
    const gen = this.gens.get(runId) ?? 0;
    this.entries.delete(runId);
    return { entry, gen };
  }

  /**
   * Restore a previously taken entry if, and only if, the generation has not
   * changed since `take()`.
   *
   * Returns `true` when the entry was actually restored (and bumps the gen).
   * Returns `false` and is a no-op when any intervening mutation changed the gen.
   *
   * Intended for the POST /runs/:id/elicitation error path: if the adapter call
   * fails, attempt to restore the prompt so the UI can retry — but only if no
   * terminal event or superseding elicitation arrived in the meantime.
   */
  restoreIfUnchanged(runId: string, entry: ElicitationEntry, gen: number): boolean {
    const current = this.gens.get(runId) ?? 0;
    if (current !== gen) return false;
    this.entries.set(runId, entry);
    this.bumpGen(runId);
    return true;
  }

  /**
   * Fold one live CoreEvent into the cache.
   *
   * `elicitationCreated` → store the new prompt (replaces any prior one).
   * `elicitationResolved` → the engine says that elicitation is DEAD (answered, declined,
   *   timed out, torn down, superseded by the next session prompt — the `reason` field), so
   *   drop the entry and bump the generation. Without this, an engine-side timeout/teardown
   *   left the prompt advertised on GET forever and a late POST forwarded into a guaranteed
   *   "no matching elicitation" 500 whose error-path restore re-advertised the dead prompt —
   *   the silent-wedge shape crew#357/#358 forbid. Guarded by id: a resolved frame for an
   *   elicitation OTHER than the cached one (a late frame racing a newer prompt) must not
   *   delete the newer prompt. When no entry is present the generation still bumps — the F8
   *   posture: a POST may have `take`n the entry just before this frame arrived, and its
   *   error-path `restoreIfUnchanged` must then be a no-op.
   * Terminal events → delete the entry and bump the generation.
   * All other events → no-op.
   */
  ingest(event: CoreEvent): void {
    const runId = event.session;
    if (typeof runId !== 'string') return;

    if (event.type === 'elicitationCreated') {
      const options = Array.isArray(event.options) ? event.options : null;
      const recommended = recommendedIndex(event.recommended, options);
      this.create({
        runId,
        elicitationId: String(event.elicitationId ?? ''),
        message: String(event.message ?? ''),
        options,
        ...(recommended !== undefined ? { recommended } : {}),
        ...askerFields(event),
        ...(multiBounds(event.multi, options) !== undefined ? { multi: multiBounds(event.multi, options)! } : {}),
      });
    } else if (event.type === 'elicitationResolved') {
      const entry = this.entries.get(runId);
      if (entry !== undefined && entry.elicitationId !== String(event.elicitationId ?? '')) {
        return; // stale frame about an already-replaced elicitation — keep the newer prompt
      }
      this.entries.delete(runId);
      this.bumpGen(runId);
    } else if (TERMINAL_EVENTS.has(event.type)) {
      this.entries.delete(runId);
      this.bumpGen(runId);
    }
  }

  /**
   * Drop entries whose run is in a terminal status and bump their generation.
   *
   * Called on every GET /runs reconcile. Unlike `GateCache.reconcile` (which
   * only prunes entries that exist), this ALWAYS bumps the generation for
   * terminal-status runs, even when no entry is currently present.
   *
   * Why: a POST may have taken the entry just before reconcile runs. If the
   * run is already terminal, the subsequent `restoreIfUnchanged` in the POST
   * error path must be a no-op — the generation bump here ensures that,
   * regardless of whether the entry was present at reconcile time (F8).
   */
  reconcile(views: SessionView[]): void {
    for (const view of views) {
      if (TERMINAL_STATUSES.has(view.session.status)) {
        this.entries.delete(view.session.id);
        this.bumpGen(view.session.id);
      }
    }
  }
}
