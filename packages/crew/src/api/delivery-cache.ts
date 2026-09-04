/**
 * The background delivery-derivation cache — `GET /runs` p99 (perf finding #2).
 *
 * The vacuity split (crew#311) put two git probes per would-be-stranded run on the run DTOs'
 * assembly path. On the LIST route that is a fan-out: ~20 terminal worktrees × (status + log)
 * with a 10s timeout each, contending with the active worker's own git — measured p99 18.7s /
 * max 18.9s while p50 stayed 182ms and `GET /runs/:id` (the same actor read) stayed 10ms in the
 * exact same windows. The TTL memo bounded the cost per window but not the worst case: the
 * unlucky poll that lands after expiry pays every probe, serially contended.
 *
 * This cache inverts the ownership: derivation runs in the BACKGROUND and the request path only
 * ever reads a map. Concretely —
 *
 *   - a sweep every {@link DELIVERY_SWEEP_INTERVAL_MS} (= `WORKTREE_CLEAN_TTL_MS`, so labels
 *     stay exactly as fresh as the memo already promised) re-derives every candidate run:
 *     COMPLETED + repo-scoped + not already delivered — the only shape whose full derivation
 *     can differ from the stat-only one;
 *   - a terminal-frame warm ({@link warm}) derives a run ONCE when it reaches terminal state,
 *     so a finished run's label heals in seconds, not at the next tick;
 *   - the request path calls {@link read}: a hit answers the derived state; a miss degrades to
 *     the stat-only tri-state (`deliveryStateOf` — the pre-crew#311 stranded/none label) for at
 *     most one tick and NEVER blocks on (or triggers) a derivation. The list path spawns no git,
 *     ever.
 *
 * The sweep pool is capped at {@link MAX_CONCURRENT_DERIVATIONS} with an in-flight guard per
 * run, so the background layer can never storm git the way the request fan-out did. Probes are
 * injected (the shared TTL-memoized git probes in production), so the campaigns rollup — which
 * still derives on-request over the SAME probe memo — rides warm entries the sweeper refreshed.
 *
 * FAILURE RULE (PR #435 review): a derivation whose probes could not answer
 * (`VacuityProbeUnavailable` — git unspawnable, timeout, a worktree racing the engine's
 * terminal reap) is NEVER recorded — absence of an answer is not a verdict. The entry stays
 * untouched (miss ⇒ the honest stat-only degrade) and the run re-derives on a short backoff,
 * so a raced terminal-frame warm heals in seconds even where the sweep is off.
 */

import type { AgentSession, SessionView } from '../core/types.js';
import {
  deliveryStateOf,
  deliveryStateWithVacuity,
  VacuityProbeUnavailable,
  WORKTREE_CLEAN_TTL_MS,
  type DeliveryState,
  type VacuityProbes,
} from './delivery-index.js';

/** The session facts the derivation reads — the same pick `deliveryStateWithVacuity` takes. */
type SessionFacts = Pick<AgentSession, 'id' | 'status' | 'repo_ref' | 'workdir'>;

/** One tick = the trust window the per-probe memo already grants, so moving derivation off the
 *  request path changes WHO pays, never how stale a label may read. */
export const DELIVERY_SWEEP_INTERVAL_MS = WORKTREE_CLEAN_TTL_MS;

/** The background pool cap: at most this many derivations (each up to two git subprocesses) run
 *  at once, so a 50-run backlog drains as a trickle instead of a spike that contends with the
 *  active worker's git — the exact contention the request-path fan-out exhibited. */
export const MAX_CONCURRENT_DERIVATIONS = 3;

/** First retry delay after a derivation whose probes could not answer; doubles per consecutive
 *  failure up to the sweep cadence. The terminal-frame warm fires at the most turbulent instant
 *  of a run's life (the engine's terminal reap runs concurrently), so a raced first derivation
 *  is EXPECTED — the retry is what heals it in seconds even where no sweep ticks (test-built
 *  daemons keep the interval off). */
export const DERIVATION_RETRY_BASE_MS = 1_000;

export interface DeliveryDerivationCacheDeps {
  /** The candidate set per sweep — the same ~10ms actor read the routes use. */
  listViews: () => Promise<SessionView[]>;
  /** The probes behind 'stranded'/'vacuous'. In the daemon these are the SAME TTL-memoized git
   *  probes the campaigns rollup uses; only `worktreeExists` (one stat, no git) is ever invoked
   *  on the request path — the git pair runs exclusively under this cache's pool. */
  probes: VacuityProbes;
  /** A run the `DeliveryIndex` already answers needs no derivation — the read path
   *  short-circuits on the recorded URL before it ever consults this cache. */
  isDelivered: (runId: string) => boolean;
  /** Retry-backoff floor after a failed derivation (tests shorten it). */
  retryBaseMs?: number;
  log?: (msg: string) => void;
}

/** Only a COMPLETED repo-scoped run's full derivation can differ from the stat-only tri-state
 *  (`deliveryStateWithVacuity` answers `deliveryStateOf` verbatim, git-free, for every other
 *  shape) — so only these runs are ever derived or cached. */
function isCandidate(session: SessionFacts): boolean {
  return session.status === 'completed' && session.repo_ref != null;
}

export class DeliveryDerivationCache {
  /** runId → the last full derivation. Entries exist only for candidate runs; the sweep prunes
   *  ids the store no longer serves and runs the index has since recorded as delivered. */
  private readonly derived = new Map<string, DeliveryState>();
  /** The per-run in-flight guard: a run being derived is never enqueued a second time — a
   *  sweep overlapping a terminal-frame warm folds into ONE derivation, not two git pairs. */
  private readonly inFlight = new Map<string, Promise<void>>();
  /** The pool: `active` counts held permits, `waiting` holds resolvers that each RECEIVE a
   *  permit on release (the count transfers — it never dips below the true concurrency). */
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private sweeping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-run backoff after a failed derivation (reset on the next honest verdict). */
  private readonly retryDelayMs = new Map<string, number>();
  /** Pending retry timers — unref'd, and cleared on {@link stop} so a closed daemon (or a
   *  test's torn-down server) never re-derives into the void. */
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: DeliveryDerivationCacheDeps) {}

  /**
   * The request path. Synchronous by design — a cache hit answers the background-derived state;
   * a miss answers the stat-only tri-state (one `existsSync`, no git) and does NOT enqueue a
   * derivation: scheduling belongs to the sweep and the terminal warm alone, so a request can
   * never fan a poll out into subprocess spawns, however cold the cache.
   *
   * Non-candidate shapes skip the cache entirely: their stat answer IS the full derivation, and
   * skipping keeps a (theoretical) stale entry from ever outliving its run's candidacy.
   */
  read(session: SessionFacts): DeliveryState {
    if (isCandidate(session)) {
      const hit = this.derived.get(session.id);
      if (hit !== undefined) return hit;
    }
    return deliveryStateOf(session, undefined, this.deps.probes.worktreeExists);
  }

  /**
   * The terminal-frame warm: derive this run once, now, so a just-finished run's label heals in
   * probe-time instead of waiting for the next tick. Fired from the daemon's CoreEvent
   * subscription AFTER `resolveRunDelivery` settles — a just-recorded PR URL then skips the
   * derivation via `isDelivered`. Best-effort like everything on that hook: never throws.
   */
  async warm(runId: string): Promise<void> {
    try {
      if (this.deps.isDelivered(runId)) return;
      const views = await this.deps.listViews();
      const view = views.find((v) => v.session.id === runId);
      if (view === undefined || !isCandidate(view.session)) return;
      await this.schedule(view.session);
    } catch (err) {
      this.deps.log?.(
        `[runs] delivery-derivation warm for ${runId} failed (label reads stat-only until the next sweep): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * One background pass: prune entries the store no longer serves (or the index has since
   * recorded as delivered), then re-derive every candidate through the capped pool. Re-entrant
   * calls fold — a sweep still draining when the next tick fires is not stacked, so a slow git
   * day degrades to a slower refresh, never to a growing backlog.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const views = await this.deps.listViews();
      const alive = new Set(views.map((v) => v.session.id));
      for (const id of this.derived.keys()) {
        if (!alive.has(id) || this.deps.isDelivered(id)) this.derived.delete(id);
      }
      await Promise.all(
        views
          .filter((v) => isCandidate(v.session) && !this.deps.isDelivered(v.session.id))
          .map((v) => this.schedule(v.session)),
      );
    } catch (err) {
      this.deps.log?.(
        `[runs] delivery-derivation sweep failed (labels degrade to the stat-only read until the next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.sweeping = false;
    }
  }

  /** Arm the tick (and sweep once immediately, so a restarted daemon's labels heal in seconds,
   *  not at +30s). Unref'd — the interval must never hold the process open. */
  start(intervalMs: number = DELIVERY_SWEEP_INTERVAL_MS): void {
    if (this.timer !== null) return;
    void this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
  }

  /** Enqueue one run's full derivation (in-flight-guarded, pool-capped).
   *
   *  THE LOAD-BEARING RULE (PR #435 review): a derivation whose probes FAILED is never cached
   *  as if it were an honest answer. The production probes throw `VacuityProbeUnavailable` when
   *  git could not answer (a raced teardown, a timeout, a load spike) — recording that as
   *  'stranded' pinned a WRONG label on vacuous runs, forever where no sweep ticks. On failure
   *  the entry is left untouched (a miss keeps the honest stat-only degrade; a previous honest
   *  verdict stands) and the run re-derives after a short backoff, doubling up to the sweep
   *  cadence — the in-flight guard folds overlapping schedules, so retries can never storm. */
  private schedule(session: SessionFacts): Promise<void> {
    const pending = this.inFlight.get(session.id);
    if (pending !== undefined) return pending;
    const job = (async () => {
      await this.acquire();
      try {
        const state = await deliveryStateWithVacuity(session, undefined, this.deps.probes);
        // A 'stranded' verdict over a worktree that VANISHED mid-derivation is not an answer
        // either: the engine's terminal reap races the terminal-frame warm, and a half-removed
        // tree can read "dirty" (deleted paths in `git status`) the instant before its .git
        // link disappears. One stat re-check turns that race into a retry, not a pinned label.
        if (
          state.delivery === 'stranded' &&
          typeof session.workdir === 'string' &&
          session.workdir !== '' &&
          !this.deps.probes.worktreeExists(session.workdir)
        ) {
          throw new VacuityProbeUnavailable(
            `worktree ${session.workdir} vanished mid-derivation`,
            'raced the terminal reap',
          );
        }
        this.derived.set(session.id, state);
        this.retryDelayMs.delete(session.id);
      } catch (err) {
        const delay = this.retryDelayMs.get(session.id) ?? this.deps.retryBaseMs ?? DERIVATION_RETRY_BASE_MS;
        this.retryDelayMs.set(session.id, Math.min(delay * 2, DELIVERY_SWEEP_INTERVAL_MS));
        this.deps.log?.(
          `[runs] delivery derivation for ${session.id} could not answer (label reads stat-only; retrying in ${delay}ms): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          void this.warm(session.id);
        }, delay);
        timer.unref?.();
        this.retryTimers.add(timer);
      } finally {
        this.release();
        this.inFlight.delete(session.id);
      }
    })();
    this.inFlight.set(session.id, job);
    return job;
  }

  private async acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT_DERIVATIONS) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) next(); // hand the permit over — `active` is unchanged
    else this.active -= 1;
  }
}
