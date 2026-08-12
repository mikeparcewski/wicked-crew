/**
 * Opt-in consumption of the QE gate's wicked-bus events.
 *
 * The QE pipeline announces gate results on the bus — the wire contract the
 * retired wicked-testing package's `lib/gate.mjs` established and garden's qe
 * skills now emit (Phase 6c kept these event names and payload fields STABLE
 * by decision — only the emitters' `domain` stamp rebranded to `qe`):
 *
 *   wicked.qe.gate.passed | wicked.qe.gate.failed | wicked.qe.gate.conditional
 *     payload (8 canonical fields): run_id, context, gate_verdict, exit_code,
 *     verdict_summary, mode, completed_at, scenario_count
 *     idempotency key: `qe:gate.result:{context}:{sha256(run_id)[0:16]}:0`
 *   wicked.qe.deploy.completed
 *     payload: run_id, project_id (emitted alongside a PASS)
 *
 * Consumption is OPT-IN behind crew's existing bus seam (like `--bus-db` /
 * `WICKED_BUS_EXEC`): when armed, a durable wicked-bus subscriber folds each
 * event into this in-memory cache so acceptance reads see gate results the
 * moment they happen; when the bus is absent, nothing here runs and the
 * acceptance route's lazy ledger read is the (always-correct) fallback. The
 * cache is a freshness signal — the ledger stays the system of record for the
 * gate decision, so a lost or replayed event can never flip a verdict.
 */

import type { BusEvent } from 'wicked-bus';

/** The gate-result event types (the old gate.mjs wire contract, verbatim). */
export const QE_GATE_EVENT_TYPES = [
  'wicked.qe.gate.passed',
  'wicked.qe.gate.failed',
  'wicked.qe.gate.conditional',
] as const;

/** The cross-product deploy signal emitted alongside a PASS. */
export const QE_DEPLOY_EVENT_TYPE = 'wicked.qe.deploy.completed';

/**
 * One durable-subscription filter covering both families above
 * (`prefix.**` = one or more remaining segments in wicked-bus filter grammar).
 */
export const QE_BUS_FILTER = 'wicked.qe.**';

/** Subscriber identity on the bus (registration + cursor resume key). */
export const QE_BUS_PLUGIN = 'wicked-crew';

/** A folded gate/deploy event, as the acceptance route serves it. */
export interface QeGateEventEntry {
  eventType: string;
  /** The QE run the result is about (`run_id`). */
  runId: string;
  /** The emitter's context — the QE project id (`context` / `project_id`). */
  context: string | null;
  /** PASS | FAIL | CONDITIONAL | SYSTEM_ERROR (gate events; null on deploy). */
  gateVerdict: string | null;
  exitCode: number | null;
  verdictSummary: string | null;
  mode: string | null;
  completedAt: string | null;
  scenarioCount: number | null;
  /** When THIS daemon observed the event (bus delivery time), ISO-8601. */
  observedAt: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Latest-gate-result cache, keyed by QE run id and by context.
 *
 * At-least-once delivery means the same logical event may arrive more than
 * once; folding is idempotent by construction (same event ⇒ same entry). No
 * eviction: entries are one small record per QE run/context and the daemon is
 * local-first — a restart simply starts empty and the ledger read covers it.
 */
export class QeGateCache {
  private readonly byRun = new Map<string, QeGateEventEntry>();
  private readonly byContext = new Map<string, QeGateEventEntry>();
  private latestEntry: QeGateEventEntry | undefined;

  /**
   * Fold one bus event. Returns `true` when the event was a recognized
   * `wicked.qe.*` gate/deploy frame and was cached; unknown types are ignored
   * (the durable filter is a prefix, so future qe events pass through here).
   */
  ingest(eventType: string, payload: unknown, observedAt = new Date().toISOString()): boolean {
    const isGate = (QE_GATE_EVENT_TYPES as readonly string[]).includes(eventType);
    const isDeploy = eventType === QE_DEPLOY_EVENT_TYPE;
    if (!isGate && !isDeploy) return false;
    if (typeof payload !== 'object' || payload === null) return false;
    const p = payload as Record<string, unknown>;
    const runId = str(p['run_id']);
    if (runId === null) return false; // both contracts require run_id

    const entry: QeGateEventEntry = {
      eventType,
      runId,
      // Gate events carry `context`; the deploy signal spells it `project_id`.
      context: str(p['context']) ?? str(p['project_id']),
      gateVerdict: isGate ? str(p['gate_verdict']) : null,
      exitCode: isGate ? num(p['exit_code']) : null,
      verdictSummary: isGate ? str(p['verdict_summary']) : null,
      mode: isGate ? str(p['mode']) : null,
      completedAt: isGate ? str(p['completed_at']) : null,
      scenarioCount: isGate ? num(p['scenario_count']) : null,
      observedAt,
    };

    // The deploy signal must not shadow the gate result it accompanies: for the
    // same run, a gate event always wins the byRun/byContext slots; the deploy
    // frame only fills them when no gate result was seen (e.g. cursor_init
    // 'latest' catching the tail of an emission pair).
    const existing = this.byRun.get(runId);
    if (!(isDeploy && existing !== undefined && existing.gateVerdict !== null)) {
      this.byRun.set(runId, entry);
      if (entry.context !== null) this.byContext.set(entry.context, entry);
    }
    this.latestEntry = entry;
    return true;
  }

  /** The latest cached result for a QE run id. */
  forRun(runId: string): QeGateEventEntry | undefined {
    return this.byRun.get(runId);
  }

  /** The latest cached result for a context (QE project id). */
  forContext(context: string): QeGateEventEntry | undefined {
    return this.byContext.get(context);
  }

  /** The most recently observed event, whatever it was keyed by. */
  latest(): QeGateEventEntry | undefined {
    return this.latestEntry;
  }

  /** Number of distinct QE runs with a cached result (diagnostics / tests). */
  size(): number {
    return this.byRun.size;
  }
}

/** Options for {@link startQeGateSubscriber}. */
export interface QeGateSubscriberOptions {
  /**
   * Bus SQLite db path. Omit to let wicked-bus resolve its own default
   * (`~/.something-wicked/wicked-bus/bus.db`) — which is where the QE
   * pipeline's CLI emits unless redirected, so the default is usually right.
   */
  dbPath?: string;
  /** Poll cadence, ms (default 5000; tests use a short interval). */
  pollIntervalMs?: number;
  /** Diagnostics sink (default: console.error). */
  log?: (message: string) => void;
}

/** Handle for a running subscription. */
export interface QeGateSubscription {
  stop(): Promise<void> | void;
}

/**
 * Start the durable `wicked.qe.**` subscriber and fold events into `cache`.
 *
 * Graceful degradation, matching how other wicked consumers subscribe
 * (wicked-brain's memory subscriber): wicked-bus is dynamically imported, and
 * a missing package / unopenable db returns `null` instead of throwing — the
 * caller opted in, so the degradation is LOGGED, but a daemon must still boot
 * on a machine whose bus is broken (acceptance falls back to lazy ledger
 * reads, which never needed the bus).
 *
 * `cursor_init: 'latest'`: the cache is a live freshness signal, not history —
 * replaying an old bus backlog into it would let a stale event masquerade as
 * fresh. History belongs to the ledger.
 */
export async function startQeGateSubscriber(
  cache: QeGateCache,
  opts: QeGateSubscriberOptions = {},
): Promise<QeGateSubscription | null> {
  const log = opts.log ?? ((m: string) => console.error(m));

  let bus: typeof import('wicked-bus');
  try {
    bus = await import('wicked-bus');
  } catch (err) {
    log(
      `[qe-gate-events] wicked-bus is not importable — gate events disabled, acceptance stays on lazy ledger reads: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  let db: unknown;
  try {
    db = bus.openDb(opts.dbPath !== undefined ? { db_path: opts.dbPath } : {});
  } catch (err) {
    log(
      `[qe-gate-events] could not open the bus db${opts.dbPath !== undefined ? ` at ${opts.dbPath}` : ''} — gate events disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }

  const sub = bus.subscribe({
    db,
    plugin: QE_BUS_PLUGIN,
    filter: QE_BUS_FILTER,
    cursor_init: 'latest',
    pollIntervalMs: opts.pollIntervalMs ?? 5000,
    // The handler only folds into an in-memory map; a retry loop or DLQ entry
    // for it would be noise. It never throws by construction.
    maxRetries: 0,
    handler: (event: BusEvent) => {
      cache.ingest(event.event_type, event.payload);
    },
    onError: (err: Error, event?: BusEvent) => {
      log(
        `[qe-gate-events] handler error on event ${String(event?.event_id ?? '?')}: ${err.message}`,
      );
    },
  });

  return {
    stop: () => sub.stop(),
  };
}
