/**
 * The key-point trigger registry (DES-TRIGGER-REGISTRY-001, TR-W5a): the runtime.
 *
 * ```
 *  daemon fan-in ──offer() O(1)──▶ ring[512] ─┐
 *  watchdog onFrame ──offerWatchdog() O(1)──▶ ├─▶ router ─▶ deterministic lane ─▶ emitter ─▶ bus ─▶ relay ─▶ /ws
 *  bus (pulled, only types an entry wants) ───┘
 * ```
 *
 * - OFF THE HOT PATH (G3). `offer` is synchronous, allocation-light, never awaited and never throws;
 *   an input no enabled entry listens for is dropped by one `Set.has`.
 * - ADVISORY BY CONSTRUCTION (G6). The registry is built with no gate, reassign or policy
 *   dependency (`tests/watch-no-authority.test.ts` fails the build if `src/watch/**` names one). It
 *   emits findings, flags and proposals; it never adds a needs-you row.
 * - ONE RECORD (§4.8). The bus. The feed is hydrated from it once at arm; each live run's persisted
 *   events (and its wanted bus rows) are replayed through the entries at boot; every key is built
 *   from producer-assigned identity, so a replay resolves to the rows already there.
 * - NO BUS, NO WATCHING (§6). Without an engine bus the registry does not arm, and health says why.
 */

import type {
  RecordedEvent,
  WatchCoverage,
  WatchEntry,
  WatchEntryChange,
  WatchEntrySource,
  WatchFeedResponse,
  WatchFinding,
  WatchFindingCleared,
  WatchHealth,
  WatchKind,
  WatchSettings,
} from 'wicked-crew-api-types';
import { requireEngineBus } from '../core/bus.js';
import type { CoreEvent } from '../core/types.js';
import { SHIPPED_CHECKS } from './checks/index.js';
import { WatchEmitter } from './emit.js';
import { DeterministicLane } from './lanes.js';
import { applyOverrides, loadEntries, SHIPPED_ENTRIES_DIR, validateWatchPatch, type Refusal } from './loader.js';
import { PushRing } from './ring.js';
import { Router } from './router.js';
import { replayBusRows, startBusPull, startWatchWsRelay, type BusPull, type WatchRelay } from './sources.js';
import type { CheckCtx, KeyPointInput, LoadedEntry, RunWatchState, WatchCheck } from './types.js';

/** Run states kept for coverage after a run ends (oldest dropped first). */
const RUN_STATE_CAP = 500;
const FEED_LIMIT_DEFAULT = 100;
const FEED_LIMIT_MAX = 500;
const CHECK_FAILED_ENTRY = 'registry-check-failed';

export interface WatchRegistryOptions {
  /** The bus the daemon handed its engine; `undefined` = no bus, no watching. */
  dbPath: string | undefined;
  entriesDir?: string;
  checks?: ReadonlyMap<string, WatchCheck>;
  /** The `watch` key of crew's settings (the operator's on/off and thresholds). */
  settings: () => Promise<WatchSettings | undefined>;
  projectOf: (runId: string) => string | undefined;
  /** Runs live at boot (their persisted events are replayed, §4.8 step 2). */
  liveRuns?: () => Promise<string[]>;
  /** A run's persisted events (`Core.runEvents`); `null` = this engine cannot say. */
  runEvents?: (runId: string) => Promise<RecordedEvent[] | null>;
  /** Where `watchEvent` frames go (the relay); omitted = no relay. */
  broadcast?: (frame: CoreEvent) => void;
  auditEmitFailed?: (detail: Record<string, unknown>) => void;
  submitProposal?: (finding: WatchFinding) => Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Emitter flush cadence (ms); 0 = flush only on demand (tests). */
  flushMs?: number;
  /** Internal tick cadence (ms) for `registry-lagging`; 0 = no timer (tests tick by hand). */
  tickMs?: number;
  /** Bus poll cadence for the relay and the pull (ms). */
  pollIntervalMs?: number;
  ringCapacity?: number;
  /** Per-check budget and timeout (ms). */
  checkBudgetMs?: number;
  checkTimeoutMs?: number;
}

export type DismissResult = 'dismissed' | 'not_found' | 'already_cleared' | 'emit_failed';

export class WatchRegistry {
  private armedFlag = false;
  private reasonText: string | null = 'not armed yet';
  private accepting = false;
  private live = false;
  private readonly checks: ReadonlyMap<string, WatchCheck>;
  private shipped: LoadedEntry[] = [];
  private refused: Refusal[] = [];
  private overrideProblems: Refusal[] = [];
  private effective: LoadedEntry[] = [];
  private settingsNow: WatchSettings | undefined;
  private router = new Router([]);
  private readonly ring: PushRing<KeyPointInput>;
  private readonly lane: DeterministicLane;
  private emitter: WatchEmitter | null = null;
  private relay: WatchRelay | null = null;
  private pull: BusPull | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private drainScheduled = false;
  private shedTickQueued = false;
  private dbPath: string | null = null;
  private readonly runStates = new Map<string, Map<string, RunWatchState>>();
  /** Live runs whose persisted events could not be read at boot (their coverage says so). */
  private readonly gapRuns = new Set<string>();
  /** The live runs could not even be listed at boot: every unseen run's coverage says so. */
  private listGap = false;
  /** While the boot replay runs, live bus rows wait here (the pull is armed BEFORE the replay). */
  private busHold: KeyPointInput[] | null = null;
  private readonly now: () => number;
  private readonly sourceState: WatchHealth['sources'] = { bus: 'down', core: 'down', watchdog: 'down' };

  constructor(private readonly opts: WatchRegistryOptions) {
    this.checks = opts.checks ?? SHIPPED_CHECKS;
    this.now = opts.now ?? Date.now;
    this.ring = new PushRing<KeyPointInput>(opts.ringCapacity ?? 512);
    // A shed asks for ONE tick, posted outside the push: pushing from inside `push` would refill the
    // ring it is shedding from (a tick per shed item, recursively).
    this.ring.onShed = () => {
      if (this.shedTickQueued) return;
      this.shedTickQueued = true;
      setImmediate(() => {
        this.shedTickQueued = false;
        this.offerInternal('registry.tick', { cause: 'shed' });
      });
    };
    this.lane = new DeterministicLane({
      ...(opts.checkBudgetMs !== undefined ? { budgetMs: opts.checkBudgetMs } : {}),
      ...(opts.checkTimeoutMs !== undefined ? { timeoutMs: opts.checkTimeoutMs } : {}),
      onFailure: (entryId, reason) => {
        // The check-failed check failing itself is counted, never fed back into itself.
        if (entryId !== CHECK_FAILED_ENTRY) this.offerInternal('registry.check_failed', { entry_id: entryId, reason });
      },
    });
  }

  get armed(): boolean {
    return this.armedFlag;
  }

  /** Arm: load entries, hydrate the feed from the bus, replay live runs, then go live. Never throws. */
  async arm(): Promise<void> {
    const log = this.opts.log ?? ((): void => undefined);
    const loaded = loadEntries(this.opts.entriesDir ?? SHIPPED_ENTRIES_DIR, this.checks);
    this.shipped = loaded.entries;
    this.refused = loaded.refused;
    for (const r of this.refused) log(`[watch] entry ${r.id} refused: ${r.reason}`);
    try {
      this.applySettings(await this.opts.settings());
    } catch (err) {
      log(`[watch] settings unreadable, shipped defaults apply: ${message(err)}`);
      this.applySettings(undefined);
    }
    let dbPath: string;
    try {
      dbPath = requireEngineBus(this.opts.dbPath);
    } catch (err) {
      this.reasonText = `no event bus: ${message(err)}`;
      log(`[watch] not armed — ${this.reasonText}`);
      return;
    }
    const emitter = new WatchEmitter({
      dbPath,
      projectOf: this.opts.projectOf,
      auditEmitFailed: this.opts.auditEmitFailed ?? ((): void => undefined),
      ...(this.opts.submitProposal !== undefined ? { submitProposal: this.opts.submitProposal } : {}),
      now: this.now,
      ...(this.opts.sleep !== undefined ? { sleep: this.opts.sleep } : {}),
      flushMs: this.opts.flushMs ?? 2_000,
      log,
    });
    try {
      await emitter.hydrate();
    } catch (err) {
      this.reasonText = `cannot read the event bus: ${message(err)}`;
      log(`[watch] not armed — ${this.reasonText}`);
      return;
    }
    this.emitter = emitter;
    this.dbPath = dbPath;
    // From here live inputs queue in the ring; they are drained once the replay is through.
    this.accepting = true;
    this.sourceState.core = 'ok';
    this.sourceState.watchdog = 'ok';
    // The live pull starts at the bus tail BEFORE the replay reads history, so no row can fall in
    // between; what it delivers meanwhile is held and processed after the replay (duplicates of a
    // replayed row resolve to the same key).
    this.busHold = [];
    await this.armBusPull(dbPath, log);
    await this.replay(dbPath, log);
    const held = this.busHold;
    this.busHold = null;
    for (const input of held) await this.process(input);
    await emitter.flush();
    if (this.opts.broadcast !== undefined) {
      this.relay = await startWatchWsRelay({
        dbPath,
        projectOf: this.opts.projectOf,
        broadcast: this.opts.broadcast,
        ...(this.opts.pollIntervalMs !== undefined ? { pollIntervalMs: this.opts.pollIntervalMs } : {}),
        log,
      });
    }
    emitter.start();
    const tickMs = this.opts.tickMs ?? 30_000;
    if (tickMs > 0) {
      this.tickTimer = setInterval(() => this.offerInternal('registry.tick', {}), tickMs);
      this.tickTimer.unref();
    }
    this.armedFlag = true;
    this.reasonText = null;
    this.live = true;
    this.schedule();
  }

  private async armBusPull(dbPath: string, log: (m: string) => void): Promise<void> {
    if (this.pull !== null) return;
    if (this.router.busTypes().length === 0) {
      this.sourceState.bus = 'ok'; // nothing to pull: no enabled entry listens on the bus
      return;
    }
    try {
      this.pull = await startBusPull({
        dbPath,
        wants: (type) => this.router.wants('bus', type) !== null,
        handle: async (input) => {
          if (this.busHold !== null) {
            this.busHold.push(input);
            return;
          }
          await this.process(input);
          await this.emitter?.flush();
        },
        ...(this.opts.pollIntervalMs !== undefined ? { pollIntervalMs: this.opts.pollIntervalMs } : {}),
        log,
      });
      this.sourceState.bus = 'ok';
    } catch (err) {
      this.sourceState.bus = 'down';
      log(`[watch] bus pull not armed: ${message(err)}`);
    }
  }

  /** §4.8 step 2: every run live at boot is re-read from its own record and evaluated. */
  private async replay(dbPath: string, log: (m: string) => void): Promise<void> {
    if (this.opts.liveRuns === undefined) return;
    let runs: string[];
    try {
      runs = await this.opts.liveRuns();
    } catch (err) {
      log(`[watch] replay skipped (cannot list live runs): ${message(err)}`);
      this.listGap = true;
      return;
    }
    const inputs: KeyPointInput[] = [];
    for (const runId of runs) {
      const events = this.opts.runEvents === undefined ? null : await this.opts.runEvents(runId).catch(() => null);
      if (events === null) {
        this.gapRuns.add(runId);
        continue;
      }
      for (const e of events) {
        if (this.router.wants('core', e.type) === null) continue;
        inputs.push({ source: 'core', type: e.type, event: e as unknown as Record<string, unknown>, runId, at: e.ts, replay: true });
      }
    }
    try {
      inputs.push(...(await replayBusRows(dbPath, this.router.busTypes(), new Set(runs))));
    } catch (err) {
      log(`[watch] bus replay failed: ${message(err)}`);
    }
    for (const input of inputs) await this.process(input);
    await this.emitter?.flush();
  }

  /** THE HOT PATH (daemon fan-in): synchronous, O(1), never throws, never awaited. */
  offer(event: CoreEvent): void {
    try {
      if (!this.accepting) return;
      const type = event.type;
      const priority = this.router.wants('core', type);
      if (priority === null) return;
      const runId = typeof event.session === 'string' ? event.session : null;
      this.ring.push({ source: 'core', type, event: event as unknown as Record<string, unknown>, runId, at: this.now() }, priority);
      this.schedule();
    } catch {
      /* never on the producer's path */
    }
  }

  /** The watchdog's frames (the `onFrame` tee): same contract as {@link offer}. */
  offerWatchdog(frame: { type: string; session?: string } & Record<string, unknown>): void {
    try {
      if (!this.accepting) return;
      const priority = this.router.wants('watchdog', frame.type);
      if (priority === null) return;
      const runId = typeof frame.session === 'string' ? frame.session : null;
      this.ring.push({ source: 'watchdog', type: frame.type, event: frame, runId, at: this.now() }, priority);
      this.schedule();
    } catch {
      /* never on the producer's path */
    }
  }

  private offerInternal(type: string, event: Record<string, unknown>): void {
    if (!this.accepting) return;
    const priority = this.router.wants('internal', type);
    if (priority === null) return;
    this.ring.push({ source: 'internal', type, event, runId: null, at: this.now() }, priority);
    this.schedule();
  }

  private schedule(): void {
    if (!this.live || this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      if (this.draining === null) {
        this.draining = this.drain().finally(() => {
          this.draining = null;
          if (this.ring.depth > 0) this.schedule();
        });
      }
    });
  }

  private async drain(): Promise<void> {
    for (let input = this.ring.shift(); input !== undefined; input = this.ring.shift()) {
      await this.process(input);
    }
  }

  private stateOf(runId: string | null, entryId: string): RunWatchState {
    const rk = runId ?? '-';
    let perRun = this.runStates.get(rk);
    if (perRun === undefined) {
      perRun = new Map();
      this.runStates.set(rk, perRun);
      if (this.runStates.size > RUN_STATE_CAP) {
        // The oldest RUN goes (the run-less '-' bucket holds the internal entries and stays).
        for (const k of this.runStates.keys()) {
          if (k !== '-' && k !== rk) {
            this.runStates.delete(k);
            break;
          }
        }
      }
    }
    let s = perRun.get(entryId);
    if (s === undefined) {
      s = { runId, seen: new Set(), bag: new Map() };
      perRun.set(entryId, s);
    }
    return s;
  }

  private ctx(): CheckCtx {
    return {
      now: this.now,
      stats: () => {
        const r = this.ring.stats();
        return {
          queueDepth: r.depth,
          queueHwm: r.hwm,
          shedTotal: r.shed_by_priority.p0 + r.shed_by_priority.p1 + r.shed_by_priority.p2,
          tailLagMs: this.pull?.tailLagMs() ?? 0,
        };
      },
    };
  }

  /** Route one input through every matching entry and hand the outputs to the emitter. */
  private async process(input: KeyPointInput): Promise<void> {
    const emitter = this.emitter;
    if (emitter === null) return;
    for (const entry of this.router.route(input)) {
      const check = this.checks.get(entry.check);
      if (check === undefined) continue;
      const state = this.stateOf(input.runId, entry.id);
      state.seen.add(input.type);
      const outputs = await this.lane.run(check, entry, input, state, this.ctx());
      for (const out of outputs) {
        if (out.op === 'raise') emitter.raise(entry, input.runId, out, input.at, input.replay === true);
        else emitter.clear(entry, input.runId, out.subject, { reason: 'resolved' });
      }
    }
  }

  /** Drain the ring and flush the emitter (tests, and shutdown). */
  async flush(): Promise<void> {
    while (this.draining !== null || this.ring.depth > 0 || this.shedTickQueued) {
      if (this.draining !== null) await this.draining;
      else if (this.ring.depth > 0) await this.drain();
      else await new Promise<void>((resolve) => setImmediate(resolve)); // the posted shed tick
    }
    await this.emitter?.flush();
  }

  /** Stop taking inputs, finish what was accepted, then close the emitter and the taps. */
  async stop(): Promise<void> {
    this.live = false;
    this.accepting = false;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    await this.pull?.stop();
    await this.flush();
    await this.emitter?.stop();
    await this.relay?.stop();
  }

  /** Tick the internal clock by hand (tests; the timer does this every 30 s). */
  tick(): void {
    this.offerInternal('registry.tick', {});
  }

  // ── settings ────────────────────────────────────────────────────────────────

  /** Apply the operator's `watch` settings: the effective entries and the router are rebuilt. */
  applySettings(watch: WatchSettings | undefined): void {
    this.settingsNow = watch;
    const { entries, problems } = applyOverrides(this.shipped, watch, this.checks);
    this.effective = entries;
    this.overrideProblems = problems;
    this.router = new Router(entries);
    // The first bus-backed entry switched on after boot: the pull arms now, not at the next restart.
    if (this.armedFlag && this.dbPath !== null && this.pull === null && this.router.busTypes().length > 0) {
      void this.armBusPull(this.dbPath, this.opts.log ?? ((): void => undefined));
    }
  }

  /** The 400 text for a bad `watch` patch, or `null`. */
  validateSettingsPatch(patch: unknown): string | null {
    return validateWatchPatch(patch, this.shipped, this.checks);
  }

  /** Merge a validated patch into the current `watch` settings, stamping who changed what and when. */
  mergeSettings(current: WatchSettings | undefined, patch: WatchSettings, actorId: string, at: number): WatchSettings {
    const next: WatchSettings = { ...(current ?? {}) };
    if (patch.llm !== undefined) next.llm = patch.llm;
    if (patch.entries !== undefined) {
      const entries = { ...(current?.entries ?? {}) };
      for (const [id, o] of Object.entries(patch.entries)) {
        const prev = entries[id] ?? {};
        const merged = { ...prev };
        if (o.enabled !== undefined) {
          merged.enabled = o.enabled;
          merged.enabled_changed = { by: actorId, at };
        }
        if (o.threshold !== undefined) {
          merged.threshold = { ...(prev.threshold ?? {}), ...o.threshold };
          merged.threshold_changed = { by: actorId, at };
        }
        entries[id] = merged;
      }
      next.entries = entries;
    }
    return next;
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  health(): WatchHealth {
    const r = this.ring.stats();
    const off: WatchEntryChange[] = [];
    const thresholds: WatchEntryChange[] = [];
    for (const e of this.effective) {
      const o = this.settingsNow?.entries?.[e.id];
      if (!e.enabled) off.push({ id: e.id, by: o?.enabled_changed?.by ?? 'shipped', at: o?.enabled_changed?.at ?? 0 });
      if (o?.threshold !== undefined && o.threshold_changed !== undefined) {
        thresholds.push({ id: e.id, by: o.threshold_changed.by, at: o.threshold_changed.at });
      }
    }
    return {
      armed: this.armedFlag,
      reason: this.armedFlag ? null : this.reasonText,
      sources: { ...this.sourceState },
      queue: { depth: r.depth, hwm: r.hwm, shed_by_priority: r.shed_by_priority },
      tail_lag_ms: this.pull?.tailLagMs() ?? 0,
      emit: { failed: this.emitter?.failed ?? 0 },
      entries: {
        loaded: this.effective.length,
        refused: [...this.refused, ...this.overrideProblems],
        off,
        thresholds_changed: thresholds,
      },
      llm: { enabled: false, inflight: 0, timeouts: 0, skipped_no_seat: 0 },
      replay: { core_gap: this.listGap || this.gapRuns.size > 0 },
    };
  }

  /** `GET /watch/entries`: the effective entries, each threshold in plain words. */
  entries(): WatchEntry[] {
    return this.effective.map((e) => ({
      ...e,
      threshold_text: this.checks.get(e.check)?.describe(e.threshold as never) ?? '',
    }));
  }

  /** `GET /watch`: the feed, newest first; with `run`, the run's coverage too. */
  feed(q: { project?: string; kind?: WatchKind; run?: string; since?: number; limit?: number }): WatchFeedResponse {
    const limit = Math.min(Math.max(1, q.limit ?? FEED_LIMIT_DEFAULT), FEED_LIMIT_MAX);
    const rows = [...(this.emitter?.feed.rows.values() ?? [])]
      .filter(({ raised }) =>
        (q.project === undefined || raised.project_id === q.project)
        && (q.kind === undefined || raised.watch_kind === q.kind)
        && (q.run === undefined || raised.run_id === q.run)
        && (q.since === undefined || raised.at >= q.since))
      .sort((a, b) => b.raised.at - a.raised.at)
      .slice(0, limit);
    const findings: WatchFinding[] = rows.map((r) => r.raised);
    const cleared: WatchFindingCleared[] = rows.flatMap((r) => (r.cleared !== null ? [r.cleared] : []));
    return {
      findings,
      cleared,
      ...(q.run !== undefined ? { coverage: this.coverage(q.run) } : {}),
    };
  }

  /** G7: per run, which entries checked and which did not (and why). Run-less entries have none. */
  coverage(runId: string): WatchCoverage[] {
    const out: WatchCoverage[] = [];
    for (const e of this.effective) {
      if (e.on.source === 'internal') continue;
      const check = this.checks.get(e.check);
      if (check === undefined) continue;
      if (!this.armedFlag) {
        out.push({ entry_id: e.id, state: 'not_checked', reason: `watching is off: ${this.reasonText ?? 'not armed'}` });
        continue;
      }
      if (!e.enabled) {
        out.push({ entry_id: e.id, state: 'not_checked', reason: 'turned off' });
        continue;
      }
      const state = this.runStates.get(runId)?.get(e.id);
      if (state === undefined && (this.listGap || this.gapRuns.has(runId))) {
        out.push({ entry_id: e.id, state: 'not_checked', reason: 'the daemon was down' });
        continue;
      }
      const c = check.coverage(state ?? { runId, seen: new Set(), bag: new Map() });
      if (c !== null) out.push({ entry_id: e.id, ...c } as WatchCoverage);
    }
    return out;
  }

  /** "Seen, not a problem": publishes `cleared{reason:"dismissed"}` for the row. */
  async dismiss(watchId: string, actorId: string): Promise<DismissResult> {
    const emitter = this.emitter;
    if (emitter === null) return 'not_found';
    const row = emitter.feed.get(watchId);
    if (row === undefined) return 'not_found';
    if (row.cleared !== null) return 'already_cleared';
    if (!emitter.clearById(watchId, { reason: 'dismissed', dismissed_by: actorId }, 'dismissed')) return 'already_cleared';
    await emitter.flush();
    return emitter.feed.get(watchId)?.cleared != null ? 'dismissed' : 'emit_failed';
  }

  /** The sources an entry can name (for the routes' validation and the docs). */
  static readonly SOURCES: readonly WatchEntrySource[] = ['core', 'bus', 'watchdog', 'internal'];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
