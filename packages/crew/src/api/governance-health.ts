/**
 * `GET /diagnostics` → `governance`: is the engine's governance evidence actually LANDING?
 * (crew#495, acceptance finding F-022.)
 *
 * The engine's emit seam either writes an event onto the shared store (`WICKED_ESTATE_DB`) or
 * spools it to the dead-letter outbox (`WICKED_APPS_EMIT_DEADLETTER`) with a loud stderr line
 * nobody reads. Until this module existed, neither outcome reached `/diagnostics`, so a daemon
 * that had dead-lettered every governance event for a week reported `recentErrors: []` while the
 * home board said "Governed 100%". This is the daemon's read-only answer, assembled from records
 * it already owns, under the surface's honesty rule: a number it cannot derive is `null`, never 0.
 *
 *  - `store`    — the resolved store and which rule chose it (`core/governance-store.ts`);
 *                 `null` when this process never resolved one (a library boot) — then every emit
 *                 dead-letters, and a `governance.store` finding says so.
 *  - `records`  — EVENT nodes on the store now, and how many landed since this daemon booted.
 *                 Counted through the engine binding (`Core.eventStoreCount`, wicked-core-ts ≥ the
 *                 release carrying crew#495's companion); on an older addon both are `null`.
 *  - `deadletters` — a streamed fold of the outbox: count, per-type and per-reason buckets, the
 *                 timestamp range where entries carry the engine's `ts` (older engines wrote none —
 *                 those are counted as `untimestamped`, never given an invented time), plus the
 *                 legacy HOME outbox a pre-fix engine wrote, if one exists.
 *  - `findings` — `governance.deadletter` (error) whenever the outbox holds an entry;
 *                 `governance.store` (error) when no store is resolved; `governance.legacy-outbox`
 *                 when the pre-fix HOME outbox exists — a WARNING naming the replay command when it
 *                 is this daemon's own prior outbox (default state home under that HOME), an INFO
 *                 with no recipe when the state home is isolated and the file is other daemons'
 *                 dead letters (F-2R2-006: a fresh rig must not be told to import them).
 */

import { createReadStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import {
  governanceSidecarDb,
  legacyOutboxScope,
  type GovernanceStoreLocation,
  type GovernanceStoreSource,
  type LegacyOutboxScope,
} from '../core/governance-store.js';

// ── Wire-facing shapes (mirrored by wicked-crew-api-types `DiagnosticsGovernance*`) ──────────

export interface GovernanceStoreInfo {
  path: string;
  source: GovernanceStoreSource;
}

export interface GovernanceRecords {
  total: number | null;
  /** Records landed since this daemon's API came up: the baseline is taken when the routes
   *  register, AFTER the engine has booted, so the engine's own boot-time emits are in the baseline. */
  sinceBoot: number | null;
}

export interface GovernanceDeadletters {
  path: string | null;
  count: number;
  byType: Record<string, number>;
  byReason: Record<string, number>;
  timestamped: number;
  untimestamped: number;
  oldestTs: number | null;
  newestTs: number | null;
  truncated: boolean;
  /** The pre-fix HOME outbox, when one exists — with WHOSE it is (`scope`, F-2R2-006): `own` when
   *  this daemon runs in that HOME's default state home (its earlier versions spooled it), `host`
   *  when this daemon's state home is isolated and the file is other daemons' dead letters. */
  legacyOutbox: LegacyOutbox | null;
}

export interface LegacyOutbox {
  path: string;
  bytes: number;
  scope: LegacyOutboxScope;
}

export type GovernanceFindingKind = 'governance.store' | 'governance.deadletter' | 'governance.legacy-outbox';

export interface GovernanceFinding {
  kind: GovernanceFindingKind;
  /** `info` is the one non-actionable rung: a HOME outbox that is NOT this daemon's (F-2R2-006). */
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface GovernanceHealth {
  store: GovernanceStoreInfo | null;
  records: GovernanceRecords;
  deadletters: GovernanceDeadletters;
  findings: GovernanceFinding[];
}

// ── The dead-letter fold ─────────────────────────────────────────────────────

/** Bounds on the fold's work: it runs inside a request handler, and a runaway outbox (227 MB of
 *  test junk was once observed under HOME) must not turn a diagnostics GET into a file crawl. Past
 *  the byte cap the fold stops and says so (`truncated`) — the count is then a floor, honestly
 *  labelled, never a guess at the rest. */
export const DEADLETTER_FOLD_MAX_BYTES = 256 * 1024 * 1024;
const DEADLETTER_FOLD_MAX_LINE_BYTES = 1024 * 1024;
/** Distinct event types are few (a dozen `wicked.*` names); anything past this many keys folds into `other`. */
const MAX_TYPE_KEYS = 64;

/** One folded outbox — the `deadletters` block minus the legacy HOME pointer the caller adds. */
export type DeadletterFold = Omit<GovernanceDeadletters, 'legacyOutbox'>;

export function emptyDeadletterFold(path: string | null): DeadletterFold {
  return {
    path,
    count: 0,
    byType: {},
    byReason: {},
    timestamped: 0,
    untimestamped: 0,
    oldestTs: null,
    newestTs: null,
    truncated: false,
  };
}

/** The engine's spool record (`emit.rs` `spool_record`): the envelope plus why it was spooled.
 *  `ts` / `pid` / `origin` exist only on entries a wicked-core carrying crew#495's companion wrote. */
interface SpoolRecord {
  type?: unknown;
  deadletter_reason?: unknown;
  ts?: unknown;
}

/** The bucket a reason folds into: its text before the first `:` — the engine's three shapes are
 *  `no shared store (…)`, `open shared store failed: <path + error>` and `store write failed:
 *  <error>`, and only the prefix is stable across entries. */
export function reasonBucket(reason: string): string {
  const idx = reason.indexOf(':');
  return (idx >= 0 ? reason.slice(0, idx) : reason).trim();
}

/** ECMAScript `Date`'s valid range: ±8.64e15 ms around the epoch (`toISOString` THROWS outside it). */
const MAX_EPOCH_MS = 8.64e15;

/** A usable `ts`: a finite, non-negative epoch-millisecond number inside `Date`'s range. Anything
 *  else on a spool line (a torn `1e20`, a negative, a string) is counted as untimestamped — never
 *  a `RangeError` that turns `/diagnostics` into a 500. */
export function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_EPOCH_MS;
}

/** Buckets are `Map`s while folding — the keys come from file content, and a plain object keyed by
 *  `constructor`, `toString` or `__proto__` (a torn or hostile line) would either inherit a value or
 *  drop the bucket. Serialized to a plain object once, at the end. */
function bump(counts: Map<string, number>, key: string, cap: number): void {
  const k = counts.has(key) || counts.size < cap ? key : 'other';
  counts.set(k, (counts.get(k) ?? 0) + 1);
}

/**
 * Stream-fold one outbox file. A missing file is an EMPTY fold (no dead letters — the good case),
 * an unreadable one folds what it could; a malformed line still COUNTS (it is an entry the engine
 * appended; a torn tail from a crashed daemon is exactly what a replay must not lose sight of) but
 * contributes no type or timestamp.
 */
export async function foldDeadletters(path: string): Promise<DeadletterFold> {
  const fold = emptyDeadletterFold(path);
  let size: number;
  try {
    size = (await fsp.stat(path)).size;
  } catch {
    return fold; // no outbox — nothing dead-lettered, honestly empty
  }
  if (size === 0) return fold;
  const end = Math.min(size, DEADLETTER_FOLD_MAX_BYTES) - 1;
  fold.truncated = size > DEADLETTER_FOLD_MAX_BYTES;
  let stream: ReturnType<typeof createReadStream>;
  let rl: ReturnType<typeof createInterface>;
  try {
    stream = createReadStream(path, { encoding: 'utf8', end });
    rl = createInterface({ input: stream, crlfDelay: Infinity });
  } catch {
    return fold;
  }
  const byType = new Map<string, number>();
  const byReason = new Map<string, number>();
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue;
      fold.count += 1;
      if (line.length > DEADLETTER_FOLD_MAX_LINE_BYTES) {
        fold.untimestamped += 1;
        continue;
      }
      let record: SpoolRecord;
      try {
        record = JSON.parse(line) as SpoolRecord;
      } catch {
        fold.untimestamped += 1;
        continue;
      }
      bump(byType, typeof record.type === 'string' ? record.type : 'unknown', MAX_TYPE_KEYS);
      bump(
        byReason,
        typeof record.deadletter_reason === 'string' ? reasonBucket(record.deadletter_reason) : 'unknown',
        MAX_TYPE_KEYS,
      );
      if (isEpochMs(record.ts)) {
        fold.timestamped += 1;
        if (fold.oldestTs === null || record.ts < fold.oldestTs) fold.oldestTs = record.ts;
        if (fold.newestTs === null || record.ts > fold.newestTs) fold.newestTs = record.ts;
      } else {
        fold.untimestamped += 1;
      }
    }
  } catch {
    /* a read error mid-stream: keep what folded so far */
  } finally {
    rl.close();
    stream.destroy();
  }
  fold.byType = Object.fromEntries(byType);
  fold.byReason = Object.fromEntries(byReason);
  return fold;
}

/**
 * The fold, re-run only when the outbox CHANGES (size or mtime) — one `stat` per request, never a
 * re-read for a dashboard that polls, and never a stale answer once the engine appends.
 */
export class DeadletterFoldCache {
  private value: { key: string; fold: DeadletterFold } | null = null;
  private inFlight: Promise<DeadletterFold> | null = null;

  async get(path: string): Promise<DeadletterFold> {
    let key: string;
    try {
      const st = await fsp.stat(path);
      key = `${st.size}:${st.mtimeMs}`;
    } catch {
      key = 'absent';
    }
    if (this.value !== null && this.value.key === key) return this.value.fold;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = foldDeadletters(path)
      .then((fold) => {
        this.value = { key, fold };
        return fold;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}

// ── Records on the store ─────────────────────────────────────────────────────

/** A reader over the store's EVENT nodes: `null` = the installed engine cannot count (no
 *  `eventStoreCount` binding). A missing store file counts as 0 — nothing has landed yet. */
export type EventCounter = ((dbPath: string) => Promise<number>) | null;

/**
 * Baseline-at-boot plus a short-TTL live count. `sinceBoot` is `total − baseline`; either side
 * unknown (no binding, or a read that failed) folds to `null` rather than a fabricated delta.
 */
export class GovernanceRecordCounter {
  private baseline: number | null = null;
  private live: { at: number; total: number | null } | null = null;
  private inFlight: Promise<number | null> | null = null;
  private readonly baselinePromise: Promise<void>;

  constructor(
    private readonly dbPath: string | null,
    private readonly counter: EventCounter,
    private readonly ttlMs: number = 15_000,
  ) {
    this.baselinePromise = this.read().then((n) => {
      this.baseline = n;
    });
  }

  /** Test seam: the boot baseline has been taken. */
  ready(): Promise<void> {
    return this.baselinePromise;
  }

  private async read(): Promise<number | null> {
    if (this.dbPath === null || this.counter === null) return null;
    try {
      return await this.counter(this.dbPath);
    } catch {
      return null;
    }
  }

  private async total(): Promise<number | null> {
    const now = Date.now();
    if (this.live !== null && now - this.live.at < this.ttlMs) return this.live.total;
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.read()
      .then((total) => {
        this.live = { at: Date.now(), total };
        return total;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async records(): Promise<GovernanceRecords> {
    await this.baselinePromise;
    const total = await this.total();
    const sinceBoot = total !== null && this.baseline !== null ? Math.max(0, total - this.baseline) : null;
    return { total, sinceBoot };
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Quote one argument for the operator's shell: bare when it needs no quoting, otherwise
 *  single-quoted on POSIX and double-quoted on Windows (JSON quoting is not shell quoting there). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg; // `<` `>` are redirections — never bare
  return process.platform === 'win32' ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The replay recipe every finding points at — one spelling, so the console and the log agree — and
 * TARGET-SPECIFIC: a bare recipe followed on a daemon booted with a custom `--db` or
 * `--governance-db` would replay into a different store than the one that dead-lettered. The target
 * is ALWAYS an explicit, DURABLE `--governance-db`: the flag outranks the env rungs of
 * `replayTarget()`'s ladder (a `WICKED_CREW_GOVERNANCE_DB` / `WICKED_ESTATE_DB` exported in the
 * operator's shell would otherwise win over `--db`), and a `:memory:` daemon's dead letters are
 * pointed at its durable sidecar store rather than at a target a real replay refuses. `null` target
 * = no daemon store known: the bare recipe, for a `--dry-run` inspection.
 */
export function replayCommand(outboxPath: string, target: GovernanceStoreLocation | null): string {
  const base = `wicked-crew governance replay ${shellQuote(outboxPath)}`;
  if (target === null) return base;
  const durable = target.dbPath === ':memory:' ? governanceSidecarDb(target.coreDbPath) : target.displayPath;
  return `${base} --governance-db ${shellQuote(durable)}`;
}

export interface GovernanceHealthInputs {
  location: GovernanceStoreLocation | null;
  records: GovernanceRecords;
  fold: DeadletterFold;
  /** The pre-fix HOME outbox when it exists and is non-empty — path, size and whose it is — else `null`. */
  legacyOutbox: LegacyOutbox | null;
}

export function governanceHealth(input: GovernanceHealthInputs): GovernanceHealth {
  const findings: GovernanceFinding[] = [];
  // `displayPath`, never `dbPath`: a URL spec's credentials are for the engine, not the wire.
  const store: GovernanceStoreInfo | null =
    input.location !== null ? { path: input.location.displayPath, source: input.location.source } : null;
  if (store === null) {
    findings.push({
      kind: 'governance.store',
      severity: 'error',
      message:
        'this daemon resolved no governance store — WICKED_ESTATE_DB is not exported to the engine, so every ' +
        'governance event (conformance claims, phase transitions, rule lifecycle) dead-letters instead of landing; ' +
        'boot through `wicked-crew serve` (which resolves <core db>.governance/governance.db) or pass --governance-db; ' +
        `inspect any outbox meanwhile with ${replayCommand('<outbox.ndjson>', null)} --dry-run`,
    });
  }
  if (input.fold.count > 0) {
    const path = input.fold.path ?? '(unknown outbox)';
    const newest = input.fold.newestTs !== null ? `, newest ${new Date(input.fold.newestTs).toISOString()}` : '';
    const floor = input.fold.truncated ? ' (at least — the fold stopped at its size cap)' : '';
    findings.push({
      kind: 'governance.deadletter',
      severity: 'error',
      message:
        `${input.fold.count} governance event(s) dead-lettered to ${path}${floor}${newest} — the store refused or was ` +
        `unset when they were emitted (${Object.keys(input.fold.byReason).join('; ') || 'reason unknown'}); ` +
        `replay them with ${replayCommand(path, input.location)}`,
    });
  }
  if (input.legacyOutbox !== null && input.legacyOutbox.scope === 'host') {
    // NOT this daemon's dead letters (F-2R2-006): an isolated state home shares HOME with every
    // other daemon on the host, so the file is theirs. Said at `info`, with NO replay command —
    // the recipe would import another daemon's governance events into this store.
    findings.push({
      kind: 'governance.legacy-outbox',
      severity: 'info',
      message:
        `a pre-fix dead-letter outbox exists at ${input.legacyOutbox.path} (${input.legacyOutbox.bytes} bytes) — ` +
        'found under HOME — shared across daemons on this host; not this daemon\'s' +
        (input.location !== null
          ? ` (its state home is ${dirname(input.location.coreDbPath)} and its own outbox is ${input.location.outboxPath})`
          : '') +
        '. Nothing to replay here: the daemon that runs in that home\'s default state home reports and repairs it',
    });
  } else if (input.legacyOutbox !== null) {
    const recipe = replayCommand(input.legacyOutbox.path, input.location);
    findings.push({
      kind: 'governance.legacy-outbox',
      severity: 'warning',
      message:
        `a pre-fix dead-letter outbox exists under HOME at ${input.legacyOutbox.path} (${input.legacyOutbox.bytes} bytes) — ` +
        `events this daemon's earlier versions spooled there instead of storing; inspect it with ` +
        `${recipe} --dry-run, then ` +
        (input.location !== null
          ? `replay it into this daemon's store with ${recipe}`
          : 'replay it once this daemon resolves a store') +
        ' (a replay appends the lines that fail to land back onto that same file, so this warning persists until they are repaired)',
    });
  }
  return {
    store,
    records: input.records,
    deadletters: { ...input.fold, legacyOutbox: input.legacyOutbox },
    findings,
  };
}

/**
 * `{ path, bytes, scope }` when the legacy HOME outbox exists and is non-empty (a `stat`, never a
 * read), else `null`. `scope` is {@link legacyOutboxScope} against `coreDbPath` — the daemon's core
 * db, `null` when no store resolved (then `host`: nothing to attribute the file to).
 */
export async function probeLegacyOutbox(
  path: string | null,
  coreDbPath: string | null = null,
): Promise<LegacyOutbox | null> {
  if (path === null) return null;
  try {
    const st = await fsp.stat(path);
    return st.isFile() && st.size > 0
      ? { path, bytes: st.size, scope: legacyOutboxScope(coreDbPath, path) }
      : null;
  } catch {
    return null;
  }
}

/**
 * The per-daemon diagnostics assembly the route calls: one fold cache, one record counter, one
 * legacy probe. `legacyOutboxPath` is injectable so a test never has to `stat` the developer's real
 * HOME to reason about the block.
 */
export class GovernanceDiagnostics {
  private readonly folds = new DeadletterFoldCache();
  private readonly counter: GovernanceRecordCounter;

  constructor(
    private readonly location: GovernanceStoreLocation | null,
    eventCounter: EventCounter,
    private readonly legacyOutboxPath: string | null,
  ) {
    this.counter = new GovernanceRecordCounter(location?.dbPath ?? null, eventCounter);
  }

  /** Test seam: the boot baseline has been taken. */
  ready(): Promise<void> {
    return this.counter.ready();
  }

  async health(): Promise<GovernanceHealth> {
    const outbox = this.location?.outboxPath ?? null;
    const [records, fold, legacyOutbox] = await Promise.all([
      this.counter.records(),
      outbox !== null ? this.folds.get(outbox) : Promise.resolve(emptyDeadletterFold(null)),
      // The legacy pointer is only meaningful when it is NOT this daemon's own outbox; whose it is
      // (`scope`) decides warning-with-recipe vs info-without (F-2R2-006).
      probeLegacyOutbox(
        this.legacyOutboxPath !== null && this.legacyOutboxPath !== outbox ? this.legacyOutboxPath : null,
        this.location?.coreDbPath ?? null,
      ),
    ]);
    return governanceHealth({ location: this.location, records, fold, legacyOutbox });
  }
}
