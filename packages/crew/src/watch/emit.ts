/**
 * The emitter and the feed fold (DES-TRIGGER-REGISTRY-001 §4.6-§4.8).
 *
 * EMIT. Outputs are micro-batched (every 2 s, or at 16 waiting) and each row goes to the bus through
 * the engine (`emitOnBus`). A key already on the bus resolves to the existing row: success. A failed
 * emit is retried at 1, 2 and 4 s, then DROPPED with an audit line `watch.emit.failed` and counted
 * in `health.emit.failed` [D-3]: watch rows are advisory, so a lost one is disclosed, never retried
 * forever and never blocking.
 *
 * FOLD. The bus is the one record. The feed is hydrated once at arm from the bus history, then
 * updated only from rows this emitter saw acknowledged, so `GET /watch` never re-reads the bus.
 *
 * RATE. Past an entry's `emit.rate.per_run` rows on one run, a roll-up row stands for the rest: each
 * further output raises the next roll-up row (`rolled_up` = how many it stands for) and clears the
 * previous one with `reason: "rolled_up"`, `replaced_by` the new row (§4.7).
 */

import type { WatchFinding, WatchFindingCleared } from 'wicked-crew-api-types';
import { emitOnBus, readBus } from '../core/bus.js';
import { redactString } from '../mcp/redact.js';
import {
  WATCH_BUS_DOMAIN,
  WATCH_BUS_SUBDOMAIN,
  WATCH_FINDING_CLEARED,
  WATCH_FINDING_PREFIX,
  WATCH_FINDING_RAISED,
  WATCH_PRODUCER,
} from './events.js';
import { clearedKey, watchIdOf } from './keys.js';
import type { CheckOutput, LoadedEntry } from './types.js';

/** Facts are capped (§4.5): each string redacted and ≤ 200 chars, the whole object ≤ 4 KB. */
const FACT_STRING_MAX = 200;
const FACTS_MAX_BYTES = 4096;
const SENTENCE_MAX = 300;
const BATCH = 16;
const RETRY_MS = [1_000, 2_000, 4_000];

function capString(s: string, max: number): string {
  const r = redactString(s);
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

const FACT_DEPTH_MAX = 6;

/** Every string redacted and capped at any depth; deeper than the cap, or a cycle, becomes a marker. */
function scrub(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return capString(value, FACT_STRING_MAX);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (seen.has(value)) return '[cycle]';
  if (depth >= FACT_DEPTH_MAX) return '[too deep]';
  seen.add(value);
  const out = Array.isArray(value)
    ? value.slice(0, 50).map((v) => scrub(v, depth + 1, seen))
    : Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, depth + 1, seen)]));
  seen.delete(value);
  return out;
}

/** Redacted, capped facts; an over-size object is replaced by a marker rather than cut mid-structure. */
export function scrubFacts(facts: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = scrub(facts ?? {}) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(out), 'utf8') <= FACTS_MAX_BYTES ? out : { truncated: true };
}

/**
 * #780: how many folded findings a roll-up row names (by short id) — enough that a resolved one
 * leaves the roll-up and the last one clears it. Past this the roll-up still counts, but cannot
 * know when it is empty (`rolled_ids_complete: false`), so it never clears by itself.
 */
export const ROLLUP_TRACK_MAX = 50;

/** The short id a roll-up row names a folded finding by: 16 hex chars of its would-be `watch_id`. */
export function foldedId(watchId: string): string {
  return watchId.slice(2, 18);
}

/** A roll-up row's facts: the latest finding's facts plus what the roll-up stands for, within the 4 KB cap. */
function rollupFacts(facts: Record<string, unknown> | undefined, meta: RollupMeta): Record<string, unknown> {
  const scrubbed = scrub(facts ?? {}) as Record<string, unknown>;
  const merged = { ...scrubbed, ...meta };
  return Buffer.byteLength(JSON.stringify(merged), 'utf8') <= FACTS_MAX_BYTES ? merged : { truncated: true, ...meta };
}

/** What a roll-up row records about itself (in `facts`, so a restart rebuilds the chain from the bus). */
interface RollupMeta {
  /** The chain position: names the row (`rollup:<attempt>#<seq>`), independent of the count. */
  rollup_seq: number;
  /** The folded findings still open, by {@link foldedId}. */
  rolled_ids: string[];
  /** Every folded finding is named in `rolled_ids` (false past {@link ROLLUP_TRACK_MAX}). */
  rolled_ids_complete: boolean;
}

/** One feed row: the raised payload, and its clearing once one was acknowledged. */
export interface FeedRow {
  raised: WatchFinding;
  cleared: WatchFindingCleared | null;
}

/** The in-memory feed: keyed by `watch_id`, plus the (run, entry, subject) → `watch_id` index. */
/** Rows the feed holds (the routes serve at most 500): the bus stays the full record. */
const FEED_MAX_ROWS = 20_000;
/** Rate states held, one per (run, entry); an evicted one is rebuilt from the feed if it recurs. */
const RATE_MAX = 5_000;

/**
 * The in-memory feed, BOUNDED (the daemon's bus is never swept, so a lifetime fold would grow
 * without limit): past `maxRows` the oldest cleared row goes first, then the oldest row. The bus
 * stays the record; an evicted row re-raised by a replay resolves to its existing bus row.
 */
export class WatchFeed {
  readonly rows = new Map<string, FeedRow>();
  private readonly orphanClears = new Map<string, WatchFindingCleared>();
  /** Cleared rows in clearing order: the first eviction candidates. */
  private readonly clearedOrder = new Set<string>();

  constructor(private readonly maxRows = FEED_MAX_ROWS) {}

  get orphanCount(): number {
    return this.orphanClears.size;
  }

  private evict(): void {
    while (this.rows.size > this.maxRows) {
      const victim = this.clearedOrder.values().next().value ?? this.rows.keys().next().value;
      if (victim === undefined) return;
      this.rows.delete(victim);
      this.clearedOrder.delete(victim);
    }
  }

  has(watchId: string): boolean {
    return this.rows.has(watchId);
  }

  get(watchId: string): FeedRow | undefined {
    return this.rows.get(watchId);
  }

  addRaised(f: WatchFinding): void {
    if (this.rows.has(f.watch_id)) return;
    const orphan = this.orphanClears.get(f.watch_id) ?? null;
    this.orphanClears.delete(f.watch_id);
    this.rows.set(f.watch_id, { raised: f, cleared: orphan });
    if (orphan !== null) this.clearedOrder.add(f.watch_id);
    this.evict();
  }

  addCleared(c: WatchFindingCleared): void {
    const row = this.rows.get(c.watch_id);
    if (row === undefined) {
      this.orphanClears.set(c.watch_id, c);
      if (this.orphanClears.size > this.maxRows) {
        const oldest = this.orphanClears.keys().next().value;
        if (oldest !== undefined) this.orphanClears.delete(oldest);
      }
    } else if (row.cleared === null) {
      row.cleared = c;
      this.clearedOrder.add(c.watch_id);
    }
  }

  /** Fold one bus row (the boot hydrate). */
  foldBusRow(eventType: string, payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;
    if (eventType === WATCH_FINDING_RAISED) this.addRaised(payload as WatchFinding);
    else if (eventType === WATCH_FINDING_CLEARED) this.addCleared(payload as WatchFindingCleared);
  }

  /** Rows of one (run, entry), roll-ups apart (the rate count, rebuilt after a restart). */
  countFor(runId: string | null, entryId: string): { plain: number; rollups: WatchFinding[] } {
    let plain = 0;
    const rollups: WatchFinding[] = [];
    for (const { raised } of this.rows.values()) {
      if (raised.run_id !== runId || raised.entry_id !== entryId) continue;
      if (raised.rolled_up > 0) rollups.push(raised);
      else plain++;
    }
    return { plain, rollups };
  }
}

interface Pending {
  eventType: typeof WATCH_FINDING_RAISED | typeof WATCH_FINDING_CLEARED;
  key: string;
  payload: WatchFinding | WatchFindingCleared;
  /** For a proposal row: hand it to the review queue once acknowledged as NEW. */
  proposal: boolean;
  /** A plain row's rate count: given back when the row is dropped (it never reached the bus). */
  plainOf?: RateState;
  /** A roll-up row: where its chain stood before it, restored when the row is dropped. */
  restore?: { rate: RateState; att: string; to: RollupChain | undefined };
  /** A clearing that means something only once this raised row is on the bus (skipped if it was dropped). */
  dependsOn?: string;
}

export interface EmitterDeps {
  dbPath: string;
  projectOf: (runId: string) => string | undefined;
  /** `audit.record('watch.emit.failed', …)` in the daemon. */
  auditEmitFailed: (detail: Record<string, unknown>) => void;
  /** The proposals sink (§4.11): crew's existing review queue. Never self-applied. */
  submitProposal?: (finding: WatchFinding) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Flush cadence, ms (tests pass 0 and call `flush`). */
  flushMs?: number;
  log?: (msg: string) => void;
  /** Called once per acknowledged row (the registry folds nothing else). */
  onAck?: (eventType: string, payload: WatchFinding | WatchFindingCleared) => void;
}

/**
 * One attempt's roll-up chain: `n` is the newest row's position (`rollup:<att>#<n>`), `watchId` that
 * row, `count` how many findings it stands for, `open` which of them (by {@link foldedId}) are still
 * unresolved, `complete` whether `open` names every one (#780).
 */
interface RollupChain {
  n: number;
  watchId: string;
  count: number;
  open: string[];
  complete: boolean;
}

/** Rate state per (run, entry): plain rows raised, and the live roll-up chain per attempt. */
interface RateState {
  plain: number;
  rollup: Map<string, RollupChain>;
}

export class WatchEmitter {
  readonly feed = new WatchFeed();
  failed = 0;
  proposalsFailed = 0;
  private pending: Pending[] = [];
  private readonly queuedKeys = new Set<string>();
  /** Raised rows dropped after their retries (a clearing that depends on one is skipped). */
  private readonly failedKeys = new Set<string>();
  /** Raised rows taken out of `pending` and on their way to the bus (a clearing can still find them). */
  private readonly inflight = new Map<string, WatchFinding>();
  private readonly rate = new Map<string, RateState>();
  /** The newest watch row on the bus at hydrate: an emit resolving to an id at or below it found an OLD row. */
  private hydratedTail = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: EmitterDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref()));
  }

  /** Hydrate the feed once from the bus history (§4.8 step 1). */
  async hydrate(): Promise<number> {
    const rows = await readBus(this.deps.dbPath, WATCH_FINDING_PREFIX, { history: true });
    for (const r of rows) {
      this.feed.foldBusRow(r.event_type, r.payload);
      if (r.event_id > this.hydratedTail) this.hydratedTail = r.event_id;
    }
    return rows.length;
  }

  start(): void {
    const ms = this.deps.flushMs ?? 2_000;
    if (ms <= 0 || this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), ms);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  get waiting(): number {
    return this.pending.length;
  }

  private rateOf(runId: string | null, entryId: string): RateState {
    const k = `${runId ?? '-'}\u0000${entryId}`;
    let s = this.rate.get(k);
    if (s === undefined) {
      // Rebuilt from the feed after a restart, so the count and the roll-up chain carry on.
      const { plain, rollups } = this.feed.countFor(runId, entryId);
      const rollup = new Map<string, RollupChain>();
      for (const r of rollups) {
        const att = String(r.attempt ?? '-');
        const prev = rollup.get(att);
        // A row from before #780 carries no seq: its count was its position. Its folded findings are
        // unnamed, so it can never clear by itself (`complete: false`) — as before.
        const seq = typeof r.facts['rollup_seq'] === 'number' ? r.facts['rollup_seq'] : r.rolled_up;
        const ids = r.facts['rolled_ids'];
        if (prev === undefined || seq > prev.n) {
          rollup.set(att, {
            n: seq,
            watchId: r.watch_id,
            count: r.rolled_up,
            open: Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [],
            complete: r.facts['rolled_ids_complete'] === true,
          });
        }
      }
      s = { plain, rollup };
      this.rate.set(k, s);
      if (this.rate.size > RATE_MAX) {
        const oldest = this.rate.keys().next().value;
        if (oldest !== undefined && oldest !== k) this.rate.delete(oldest);
      }
    }
    return s;
  }

  private envelope(entry: LoadedEntry, runId: string | null, ord: number | null, attempt: number | null, re: string, project?: string) {
    // WT-W4: a project-scoped row names its project itself (it has no run to look one up from).
    const projectId = project ?? (runId !== null ? this.deps.projectOf(runId) : undefined);
    return {
      run_id: runId,
      ord,
      attempt,
      by: `watch:${entry.id}@${entry.version}`,
      at: this.now(),
      re,
      entry_id: entry.id,
      entry_version: entry.version,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
    };
  }

  /**
   * Queue a raise for `out` (rate and roll-up applied). `replay`: the input came from the boot
   * replay; over the rate such an output is DROPPED rather than rolled up, because the first life
   * may already have counted it and a roll-up row cannot tell (the count may then read low after a
   * restart, never high — a duplicate row is the failure G4 rules out).
   */
  raise(entry: LoadedEntry, runId: string | null, out: Extract<CheckOutput, { op: 'raise' }>, anchorAt: number, replay = false): void {
    const watchId = watchIdOf(runId, entry.id, entry.version, out.subject);
    if (this.feed.has(watchId) || this.queuedKeys.has(watchId)) return; // a replay: already the record
    const rate = this.rateOf(runId, entry.id);
    const ord = out.ord ?? null;
    const attempt = out.attempt ?? null;
    const base = (subject: string, rolledUp: number, sentence: string, meta?: RollupMeta): WatchFinding => ({
      ...this.envelope(entry, runId, ord, attempt, out.re, out.project),
      watch_id: watchIdOf(runId, entry.id, entry.version, subject),
      check: entry.check,
      kind: out.kind ?? entry.emit.as,
      severity: out.severity ?? entry.emit.severity,
      watch_kind: entry.emit.watch_kind,
      attach: entry.emit.attach,
      sentence: capString(sentence, SENTENCE_MAX),
      facts: meta === undefined ? scrubFacts(out.facts) : rollupFacts(out.facts, meta),
      anchor: runId !== null ? { run_id: runId, ord, attempt, at: anchorAt } : null,
      evidence: out.evidence ?? [],
      model: null,
      rolled_up: rolledUp,
    });
    // WT-W4: a PROJECT-scoped row is not a run's rate. `rate.per_run` bounds what one run may say;
    // project rows are bounded by their own key (one per draft) and would otherwise share one run-less
    // bucket per entry for the daemon's life, rolling up — and no longer filing — past it (codex on #788).
    if (out.project !== undefined) {
      this.push(WATCH_FINDING_RAISED, base(out.subject, 0, out.sentence), entry.emit.as === 'proposal', {});
      return;
    }
    if (rate.plain < entry.emit.rate.per_run) {
      rate.plain++;
      this.push(WATCH_FINDING_RAISED, base(out.subject, 0, out.sentence), entry.emit.as === 'proposal', { plainOf: rate });
      return;
    }
    if (replay) return;
    // Over the rate: the next roll-up row for this attempt replaces the previous one. It names the
    // findings it stands for (#780), so one that resolves leaves it and the last one clears it.
    const att = String(attempt ?? '-');
    const prev = rate.rollup.get(att);
    // A roll-up already cleared (every finding resolved, or dismissed) is not continued: the next
    // finding past the rate opens a fresh one — under a new position, never a reused watch_id.
    const prevLive = prev !== undefined && !this.closed(prev.watchId) ? prev : undefined;
    const fid = foldedId(watchId);
    if (prevLive !== undefined && prevLive.open.includes(fid)) return; // already counted there
    const n = (prev?.n ?? 0) + 1;
    const count = (prevLive?.count ?? 0) + 1;
    const all = [...(prevLive?.open ?? []), fid];
    const complete = (prevLive?.complete ?? true) && all.length <= ROLLUP_TRACK_MAX;
    const open = all.slice(0, ROLLUP_TRACK_MAX);
    const row = base(`rollup:${att}#${n}`, count, `${count} more like this on this run (latest: ${out.sentence})`, {
      rollup_seq: n,
      rolled_ids: open,
      rolled_ids_complete: complete,
    });
    rate.rollup.set(att, { n, watchId: row.watch_id, count, open, complete });
    // Coalesce a burst: while the previous roll-up row has not reached the bus yet, it is REPLACED
    // in the batch (its clearing would only name a row nobody ever saw), and a waiting clearing
    // that pointed at it now points at the new row.
    const waiting = prevLive === undefined ? -1 : this.pending.findIndex((p) => p.eventType === WATCH_FINDING_RAISED && p.key === prevLive.watchId);
    if (prevLive !== undefined && waiting !== -1) {
      const replaced = this.pending[waiting]!;
      this.queuedKeys.delete(prevLive.watchId);
      this.queuedKeys.add(row.watch_id);
      this.failedKeys.delete(row.watch_id);
      // The chain falls back to where the REPLACED row would have restored it.
      this.pending[waiting] = {
        eventType: WATCH_FINDING_RAISED,
        key: row.watch_id,
        payload: row,
        proposal: false,
        restore: { rate, att, to: replaced.restore?.to },
      };
      for (const p of this.pending) {
        const c = p.payload as { reason?: string; replaced_by?: string };
        if (p.eventType === WATCH_FINDING_CLEARED && c.reason === 'rolled_up' && c.replaced_by === prevLive.watchId) {
          c.replaced_by = row.watch_id;
          p.dependsOn = row.watch_id;
        }
      }
      return;
    }
    this.push(WATCH_FINDING_RAISED, row, false, { restore: { rate, att, to: prev } });
    if (prevLive !== undefined) {
      this.push(WATCH_FINDING_CLEARED, {
        ...this.envelope(entry, runId, ord, attempt, out.re, out.project),
        watch_id: prevLive.watchId,
        reason: 'rolled_up',
        replaced_by: row.watch_id,
      }, false, { dependsOn: row.watch_id });
    }
  }

  /** The row is cleared, or its clearing is already queued. */
  private closed(watchId: string): boolean {
    const row = this.feed.get(watchId);
    return (row !== undefined && row.cleared !== null) || this.queuedKeys.has(clearedKey(watchId));
  }

  /** A raised row this emitter knows: on the bus (the feed), on its way there, or waiting in the batch. */
  private raisedPayload(watchId: string): WatchFinding | undefined {
    return (
      this.feed.get(watchId)?.raised ??
      this.inflight.get(watchId) ??
      (this.pending.find((p) => p.eventType === WATCH_FINDING_RAISED && p.key === watchId)?.payload as WatchFinding | undefined)
    );
  }

  /**
   * #780: a finding that was folded into a roll-up (it never had a row of its own) resolved. It leaves
   * the roll-up: the roll-up is re-issued with the lower count (the `cleared{rolled_up}` + `raised`
   * pair, as when it grows), or, when it stood for nothing else, its row clears as resolved. A
   * subject no roll-up names (never raised at all) clears nothing.
   */
  private clearFolded(entry: LoadedEntry, runId: string | null, watchId: string, re: string): boolean {
    const rate = this.rateOf(runId, entry.id);
    const fid = foldedId(watchId);
    for (const [att, chain] of rate.rollup) {
      if (!chain.open.includes(fid)) continue;
      if (this.closed(chain.watchId)) return false; // dismissed or resolved already: nothing to reopen
      const open = chain.open.filter((x) => x !== fid);
      const count = Math.max(0, chain.count - 1);
      if (count === 0 || (open.length === 0 && chain.complete)) {
        rate.rollup.set(att, { ...chain, count: 0, open: [] });
        return this.clearById(chain.watchId, { reason: 'resolved' }, re);
      }
      const prevRow = this.raisedPayload(chain.watchId);
      if (prevRow === undefined) return false;
      const meta: RollupMeta = { rollup_seq: chain.n, rolled_ids: open, rolled_ids_complete: chain.complete };
      const sentence = prevRow.sentence.replace(/^\d+ more like this/, `${count} more like this`);
      // Not on the bus yet: the waiting row is corrected in the batch (nobody has seen it).
      const waiting = this.pending.find((p) => p.eventType === WATCH_FINDING_RAISED && p.key === chain.watchId);
      if (waiting !== undefined) {
        waiting.payload = { ...prevRow, rolled_up: count, sentence, facts: { ...prevRow.facts, ...meta } };
        rate.rollup.set(att, { ...chain, count, open });
        return true;
      }
      const n = chain.n + 1;
      const row: WatchFinding = {
        ...prevRow,
        at: this.now(),
        re,
        watch_id: watchIdOf(runId, entry.id, entry.version, `rollup:${att}#${n}`),
        rolled_up: count,
        sentence,
        facts: { ...prevRow.facts, ...meta, rollup_seq: n },
      };
      rate.rollup.set(att, { n, watchId: row.watch_id, count, open, complete: chain.complete });
      this.push(WATCH_FINDING_RAISED, row, false, { restore: { rate, att, to: chain } });
      this.push(
        WATCH_FINDING_CLEARED,
        {
          run_id: prevRow.run_id,
          ord: prevRow.ord,
          attempt: prevRow.attempt,
          by: prevRow.by,
          at: this.now(),
          re,
          watch_id: chain.watchId,
          entry_id: prevRow.entry_id,
          entry_version: prevRow.entry_version,
          ...(prevRow.project_id !== undefined ? { project_id: prevRow.project_id } : {}),
          reason: 'rolled_up',
          replaced_by: row.watch_id,
        } as WatchFindingCleared,
        false,
        { dependsOn: row.watch_id },
      );
      return true;
    }
    return false;
  }

  /** Queue the clearing of the row `subject` names (no-op when it was never raised or is already cleared). */
  clear(
    entry: LoadedEntry,
    runId: string | null,
    subject: string,
    how: { reason: 'resolved' } | { reason: 'dismissed'; dismissed_by: string },
    re = 'resolved',
  ): boolean {
    const watchId = watchIdOf(runId, entry.id, entry.version, subject);
    // A finding with a row of its own clears that row; one folded into a roll-up leaves it (#780).
    if (this.raisedPayload(watchId) !== undefined || how.reason !== 'resolved') return this.clearById(watchId, how, re);
    return this.clearFolded(entry, runId, watchId, re);
  }

  /** Queue the clearing of `watchId` (dismiss uses this directly). */
  clearById(watchId: string, how: { reason: 'resolved' } | { reason: 'dismissed'; dismissed_by: string }, re = 'resolved'): boolean {
    const row = this.feed.get(watchId);
    const queuedRaise = this.pending.find((p) => p.eventType === WATCH_FINDING_RAISED && (p.payload as WatchFinding).watch_id === watchId);
    const unacked = (queuedRaise?.payload as WatchFinding | undefined) ?? this.inflight.get(watchId);
    const raised = row?.raised ?? unacked;
    if (raised === undefined || (row !== undefined && row.cleared !== null) || this.queuedKeys.has(clearedKey(watchId))) return false;
    const payload = {
      run_id: raised.run_id,
      ord: raised.ord,
      attempt: raised.attempt,
      by: raised.by,
      at: this.now(),
      re,
      watch_id: watchId,
      entry_id: raised.entry_id,
      entry_version: raised.entry_version,
      ...(raised.project_id !== undefined ? { project_id: raised.project_id } : {}),
      ...how,
    } as WatchFindingCleared;
    // Not yet acknowledged: the clearing waits on its raise, and is skipped if that raise is dropped.
    this.push(WATCH_FINDING_CLEARED, payload, false, row === undefined ? { dependsOn: watchId } : {});
    return true;
  }

  private push(
    eventType: Pending['eventType'],
    payload: WatchFinding | WatchFindingCleared,
    proposal: boolean,
    extra: Pick<Pending, 'plainOf' | 'restore' | 'dependsOn'> = {},
  ): void {
    const key = eventType === WATCH_FINDING_RAISED ? (payload as WatchFinding).watch_id : clearedKey(payload.watch_id);
    this.queuedKeys.add(key);
    if (eventType === WATCH_FINDING_RAISED) this.failedKeys.delete(key);
    this.pending.push({ eventType, key, payload, proposal, ...extra });
    if (this.pending.length >= BATCH) void this.flush();
  }

  /** Emit everything waiting, in order. Concurrent calls share one pass. */
  flush(): Promise<void> {
    if (this.flushing !== null) return this.flushing.then(() => (this.pending.length > 0 ? this.flush() : undefined));
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, BATCH);
      for (const p of batch) if (p.eventType === WATCH_FINDING_RAISED) this.inflight.set(p.key, p.payload as WatchFinding);
      for (const p of batch) {
        try {
          await this.emitOne(p);
        } finally {
          this.inflight.delete(p.key);
        }
      }
    }
  }

  private async emitOne(p: Pending): Promise<void> {
    if (p.dependsOn !== undefined && this.failedKeys.has(p.dependsOn)) {
      // Its raised row never reached the bus: a clearing pointing at it would name nothing.
      this.queuedKeys.delete(p.key);
      return;
    }
    const idempotency = p.eventType === WATCH_FINDING_RAISED ? raisedKeyOf(p.payload as WatchFinding) : clearedKey(p.payload.watch_id);
    const wasNew = p.eventType === WATCH_FINDING_RAISED && !this.feed.has(p.payload.watch_id);
    let lastErr: unknown = null;
    let eventId = 0;
    for (let i = 0; i <= RETRY_MS.length; i++) {
      try {
        eventId = await emitOnBus(this.deps.dbPath, {
          event_type: p.eventType,
          domain: WATCH_BUS_DOMAIN,
          subdomain: WATCH_BUS_SUBDOMAIN,
          payload: p.payload,
          producer_id: WATCH_PRODUCER,
          idempotency_key: idempotency,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (i < RETRY_MS.length) await this.sleep(RETRY_MS[i]!);
      }
    }
    this.queuedKeys.delete(p.key);
    if (lastErr !== null) {
      this.failed++;
      if (p.eventType === WATCH_FINDING_RAISED) {
        this.failedKeys.add(p.key);
        // Give back what the dropped row took: its rate slot, or its place at the head of the chain.
        if (p.plainOf !== undefined) p.plainOf.plain = Math.max(0, p.plainOf.plain - 1);
        if (p.restore !== undefined && p.restore.rate.rollup.get(p.restore.att)?.watchId === p.key) {
          if (p.restore.to === undefined) p.restore.rate.rollup.delete(p.restore.att);
          else p.restore.rate.rollup.set(p.restore.att, p.restore.to);
        }
      }
      this.deps.auditEmitFailed({
        event_type: p.eventType,
        watch_id: p.payload.watch_id,
        entry_id: p.payload.entry_id,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      });
      return;
    }
    if (p.eventType === WATCH_FINDING_RAISED) this.feed.addRaised(p.payload as WatchFinding);
    else this.feed.addCleared(p.payload as WatchFindingCleared);
    this.deps.onAck?.(p.eventType, p.payload);
    // An emit that resolved to a row older than this boot's hydrate (one the bounded feed had
    // evicted) is not new: its proposal was filed when it was first raised.
    if (p.proposal && wasNew && eventId > this.hydratedTail && this.deps.submitProposal !== undefined) {
      try {
        await this.deps.submitProposal(p.payload as WatchFinding);
      } catch (err) {
        this.proposalsFailed++;
        this.deps.log?.(`[watch] proposal for ${p.payload.watch_id} not filed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** The raised row's idempotency key: `watch_id` is `"w-"` + the key (keys.ts `watchIdOf`). */
function raisedKeyOf(f: WatchFinding): string {
  return f.watch_id.slice(2);
}
