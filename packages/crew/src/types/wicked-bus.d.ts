/**
 * Minimal type surface for `wicked-bus` (plain-JS package, ships no types).
 *
 * Only the slice this daemon uses is declared — the durable subscriber path
 * (`openDb` + `subscribe`) plus the `emit`/`loadConfig` pair the tests use to
 * put real events on a real bus. Shapes are transcribed from wicked-bus
 * `lib/{db,subscribe,emit,config}.js` (v2.3.x); loose on purpose where the
 * upstream is (`db` is an opaque handle here — better-sqlite3's type is not a
 * dependency this package needs).
 */
declare module 'wicked-bus' {
  /** An opaque better-sqlite3 database handle. */
  export type BusDb = unknown;

  /** One delivered event row (`parseEvent` output: row + parsed payload). */
  export interface BusEvent {
    event_id: number;
    event_type: string;
    domain: string;
    subdomain: string;
    /** JSON-parsed when parseable; the raw string otherwise. */
    payload: unknown;
    idempotency_key: string;
    emitted_at: number;
    [k: string]: unknown;
  }

  /** Managed subscription handle (`lib/subscribe.js`). */
  export interface BusSubscription {
    subscription_id: string;
    cursor_id: string;
    /** Cancel timers, dead-letter any in-flight retry, ack the cursor. */
    stop(): Promise<void>;
    [k: string]: unknown;
  }

  export interface SubscribeOptions {
    db: BusDb;
    plugin: string;
    filter: string;
    cursor_init?: 'latest' | 'oldest';
    pollIntervalMs?: number;
    batchSize?: number;
    maxRetries?: number;
    backoffMs?: number | number[];
    handler: (event: BusEvent) => void | Promise<void>;
    onError?: (err: Error, event?: BusEvent) => void;
    onDeadLetter?: (event: BusEvent, reason: string) => void;
  }

  /** Open (or create) the bus SQLite db; `db_path` overrides the default resolution. */
  export function openDb(config?: { db_path?: string | null }): BusDb;

  /** Merged config (file + defaults); `emit` requires one. */
  export function loadConfig(overrides?: Record<string, unknown>): Record<string, unknown>;

  /** Emit one event (tests stage real bus traffic; the interactive-draft seam announces with it). */
  export function emit(
    db: BusDb,
    config: Record<string, unknown>,
    event: {
      event_type: string;
      domain: string;
      subdomain?: string;
      payload: unknown;
      idempotency_key?: string;
      /** Producer identity stamped on the row (loop-safety: consumers drop their own emissions). */
      producer_id?: string;
      correlation_id?: string;
      session_id?: string;
    },
  ): { event_id: number; idempotency_key: string };

  /** Managed long-running subscriber (durable cursor; at-least-once). */
  export function subscribe(opts: SubscribeOptions): BusSubscription;
}
