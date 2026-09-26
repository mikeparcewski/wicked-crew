/**
 * THE CREW BUS (wicked-core#631) — every bus row in-daemon crew code writes or reads goes through
 * the ENGINE that holds the bus.
 *
 * The daemon's bus file is the engine's (DES-TEAMING-002 T0): the engine opens it once, through its
 * bundled SQLite, and never closes it. A second SQLite library in the same process cannot share that
 * file safely: POSIX locks belong to the process, so two libraries do not exclude each other's
 * writes, and a close in either drops the other's locks (sqlite.org/howtocorrupt.html §2.2.1,
 * F-E2E-021). So crew holds no SQLite library at all. It emits with `Core.busEmit` and reads with
 * `Core.busRead`; the engine is the one writer and the one reader on its bus.
 *
 * The adapter attaches its engine to the bus file it handed it (`attachEngineBus`), and each seam
 * names the bus it uses by path. A seam whose bus no engine holds cannot arm: it throws, and the
 * seam logs and disables itself. tests/bus-no-write.test.ts fails the build if in-daemon code
 * names a SQLite library or wicked-bus.
 */

import { resolve } from 'node:path';

/** The engine's two bus calls (wicked-core-ts `Core.busEmit` / `Core.busRead`). */
export interface EngineBus {
  busEmit(eventJson: string): Promise<number>;
  busRead(afterId: number, limit: number, typePrefix?: string | null): Promise<string>;
}

/** One row, as wicked-bus `emit` takes it. */
export interface BusRow {
  event_type: string;
  domain: string;
  subdomain?: string;
  payload: unknown;
  idempotency_key?: string;
  producer_id?: string;
}

/** One `events` row as the engine reads it back: every column the file has, `payload` parsed
 *  (the stored string when it is not JSON). */
export interface BusEvent {
  event_id: number;
  event_type: string;
  domain: string;
  subdomain: string;
  payload: unknown;
  idempotency_key: string;
  emitted_at: number;
  [k: string]: unknown;
}

/** `Core.busRead`'s answer: the rows, and the cursor to pass next. */
interface BusPage {
  next: number;
  rows: BusEvent[];
}

/** Rows per read: a burst drains over a few polls instead of one unbounded read. */
const BATCH = 500;

const engines = new Map<string, EngineBus>();

/** Test seam only: the bus for a path no engine is attached to (tests/setup/bus-double.ts). */
export const busTesting: { unattached: ((dbPath: string) => EngineBus) | undefined } = {
  unattached: undefined,
};

/** The engine at `dbPath` serves every seam that names that bus (the adapter, once its engine is up). */
export function attachEngineBus(dbPath: string, engine: EngineBus): void {
  engines.set(resolve(dbPath), engine);
}

/** Undo {@link attachEngineBus} (the adapter, on close) — only if `engine` is still the one attached. */
export function detachEngineBus(dbPath: string, engine: EngineBus): void {
  const key = resolve(dbPath);
  if (engines.get(key) === engine) engines.delete(key);
}

/** The resolved path of the bus at `dbPath` when an engine holds it; throws when none does (a seam
 *  checks this at arm time, so a seam with no bus disables itself before arming anything). */
export function requireEngineBus(dbPath: string | undefined): string {
  engineFor(dbPath);
  return resolve(dbPath!);
}

/** The engine holding the bus at `dbPath`; throws when there is none. */
function engineFor(dbPath: string | undefined): EngineBus {
  if (dbPath === undefined) throw new Error('no bus named (the daemon hands each seam its engine bus)');
  const key = resolve(dbPath);
  const engine = engines.get(key) ?? busTesting.unattached?.(key);
  if (engine === undefined) {
    throw new Error(`no engine holds the bus at ${key} (the engine was handed no bus, or another one)`);
  }
  return engine;
}

/**
 * Emit one row on the bus at `dbPath`. Resolves to the row's `event_id`; a key already on the bus
 * resolves to the existing row's id (the engine's dedup: success, as wicked-bus's WB-002 was).
 * Rejects when no engine holds the bus or the engine refuses the row (`WB-001 …`).
 */
export async function emitOnBus(dbPath: string, row: BusRow): Promise<number> {
  return engineFor(dbPath).busEmit(JSON.stringify(row));
}

/** One page of live rows after `afterId` whose type starts with `typePrefix`. */
async function readPage(engine: EngineBus, afterId: number, typePrefix: string | null): Promise<BusPage> {
  return JSON.parse(await engine.busRead(afterId, BATCH, typePrefix)) as BusPage;
}

/** Every live row on the bus at `dbPath` whose type starts with `typePrefix`, oldest first. */
export async function readBus(dbPath: string, typePrefix: string): Promise<BusEvent[]> {
  const engine = engineFor(dbPath);
  const out: BusEvent[] = [];
  for (let after = 0; ; ) {
    const page = await readPage(engine, after, typePrefix);
    out.push(...page.rows);
    if (page.rows.length < BATCH || page.next <= after) return out;
    after = page.next;
  }
}

/**
 * A tap filter: `<prefix>.**` (every type under the prefix) or `<type>` (exactly that type), either
 * with an optional `@<domain>` (only that publisher) — the two wicked-bus filter forms crew's seams
 * use, meaning what they mean to wicked-bus `matchesFilter`. Any other form throws at arm.
 */
function compileFilter(filter: string): { typePrefix: string; matches: (e: BusEvent) => boolean } {
  const at = filter.indexOf('@');
  const type = at === -1 ? filter : filter.slice(0, at);
  const domain = at === -1 ? '' : filter.slice(at + 1);
  const ofDomain = (e: BusEvent): boolean => domain === '' || e.domain === domain;
  if (type.endsWith('.**') && !type.slice(0, -3).includes('*')) {
    const typePrefix = type.slice(0, -2);
    return { typePrefix, matches: (e) => ofDomain(e) && e.event_type.length > typePrefix.length };
  }
  if (type !== '' && !type.includes('*')) {
    return { typePrefix: type, matches: (e) => ofDomain(e) && e.event_type === type };
  }
  throw new Error(`unsupported bus filter ${JSON.stringify(filter)} (use <prefix>.** or an exact type, optionally @<domain>)`);
}

export interface BusTapOptions {
  /** The bus db (the one the daemon handed its engine). */
  dbPath: string | undefined;
  /** `<prefix>.**` or an exact type, optionally `@<domain>` (`wicked.interactive.**`, `wicked.qe.**`, …). */
  filter: string;
  /** Poll cadence, ms. */
  pollIntervalMs?: number | undefined;
  /** Called once per matching row, in order; awaited before the next row. */
  handler: (event: BusEvent) => void | Promise<void>;
  /** A failed read (`event` null) or a failed handler (the row). Never retried; the cursor moves on. */
  onError?: ((err: Error, event?: BusEvent | null) => void) | undefined;
}

export interface BusTap {
  /** The bus file this tap reads. */
  readonly dbPath: string;
  /** Stop polling; resolves once an in-flight handler has returned. */
  stop(): Promise<void>;
}

/**
 * Arm a tap: poll the engine's bus from its newest row (rows already on the bus are history, as
 * wicked-bus's `latest` cursor treated them), cursor in memory, handing each matching row to the
 * handler in order. Rejects when no engine holds the bus or the filter is not one crew supports
 * (the caller logs and disables its seam); a failed read goes to `onError` and the next poll
 * retries it. A
 * restart starts at the newest row again, so rows emitted while the daemon was down are not
 * delivered; a failed handler is not retried. A bus file replaced under the same path is followed:
 * the engine answers cursor 0 and the tap reads the new file from its first row.
 */
export async function tapBus(opts: BusTapOptions): Promise<BusTap> {
  const engine = engineFor(opts.dbPath);
  const dbPath = resolve(opts.dbPath!);
  const { typePrefix, matches } = compileFilter(opts.filter);
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const report = (err: unknown, event: BusEvent | null): void => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)), event);
  };
  // Where the tap starts: the bus tail as of arming. `null` until that read succeeds — a failed
  // first read is reported and retried by the next poll, never a guessed start.
  let cursor: number | null = null;
  const start = async (): Promise<void> => {
    try {
      cursor = (JSON.parse(await engine.busRead(0, 0, null)) as BusPage).next;
    } catch (err) {
      report(err, null);
    }
  };
  await start();

  const poll = async (): Promise<void> => {
    if (cursor === null) return start();
    let page: BusPage;
    try {
      page = await readPage(engine, cursor, typePrefix);
    } catch (err) {
      report(err, null);
      return;
    }
    for (const row of page.rows) {
      if (stopped) return;
      cursor = row.event_id;
      if (!matches(row)) continue;
      try {
        await opts.handler(row);
      } catch (err) {
        report(err, row);
      }
    }
    if (!stopped) cursor = page.next;
  };

  const timer = setInterval(() => {
    if (stopped || inFlight !== null) return;
    inFlight = poll().finally(() => {
      inFlight = null;
    });
  }, opts.pollIntervalMs ?? 2000);
  timer.unref();

  return {
    dbPath,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (inFlight !== null) await inFlight;
    },
  };
}
