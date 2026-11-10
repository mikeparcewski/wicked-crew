/**
 * One run, folded into the facts the review counts (DES-RUNS-REVIEW-001 §4). Pure: a `SessionView` and its recorded
 * events in, a {@link RunFact} out. Nothing here is estimated; a value the events do not carry is `null` or 0 and
 * says so (`spendReported`).
 */

import type { SessionView } from 'wicked-crew-api-types';

/** A recorded event as `runEvents` returns it: the frame plus `ts` (epoch ms). Read loosely, field by field. */
export type LooseEvent = { type: string; ts?: number; ord?: number } & Record<string, unknown>;

export type RunOutcome = 'passed' | 'failed' | 'cancelled' | 'open';

export interface RunOverride {
  ord: number;
  /** The escalation's condition (`floor_failed`, `judge_unavailable`, …), else `unknown`. */
  condition: string;
  /** What denied it (`repo_checks`, `substance`, …), when the engine said. */
  source: string | null;
}

export interface RunFact {
  id: string;
  title: string;
  workflow: string;
  repo: string | null;
  projectId: string | null;
  /** Every CLI that was assigned a unit. */
  agents: string[];
  createdAtMs: number;
  endedAtMs: number | null;
  status: string;
  outcome: RunOutcome;
  deliverRequested: boolean;
  delivered: boolean;
  archived: boolean;
  /** Launch → the end of a delivered run, ms. `null` when nothing was delivered. */
  timeToPrMs: number | null;
  /** Σ repo-check durations, ms (0 when no floor ran). */
  floorMs: number;
  /** Σ time parked on a person, ms (a gate or an escalation, until it was decided). */
  waitHumanMs: number;
  overrides: RunOverride[];
  spendUsd: number;
  /** Whether any `cliUsage` frame carried a cost (an unreported CLI reads 0, which is not "free"). */
  spendReported: boolean;
  /** (CS6) `cliUsage` frames that carried a cost, and usage that did not (a `cliUsage` frame with no cost, or a
   *  `cliUsageUnreported` attempt): a run is fully priced only when every one was priced (one priced frame is enough to
   *  set {@link spendReported}). */
  pricedFrames: number;
  unpricedFrames: number;
  /** (CS6) When the run reached its terminal state, as RECORDED: its terminal event, else the engine's
   *  `finished_at`; `null` when neither is (never the last event of some other kind, unlike {@link endedAtMs}). */
  terminalAtMs: number | null;
  /** (CS6) The run's events could not be read: its frame counts and {@link terminalAtMs} rest on its record only.
   *  Set by the collector (`collectRunFacts`), never by {@link runFactOf}. */
  eventsUnreadable?: boolean;
  /** (CS6) The run's resolved name (`run_identity.name`): `null` = unnamed (free text, a user plan, unknown);
   *  absent when the view carried no identity. */
  runName?: string | null;
  /** (CS6) The run is a system run (`run_identity.system`); absent when the view carried no identity. */
  system?: boolean;
  tokens: number;
  /** Reassignments plus failed steps. */
  retries: number;
  stalls: number;
  benched: { cli: string; reason: string }[];
  /** For a failed run: what stopped it, as one comparable line. */
  failureSignature: string | null;
  /** A failure nobody archived, or a run open for over a day. */
  unresolved: boolean;
  /** (program DES-POWER-MODE) Planned vs actual of a power run (the planner's calibration input); `null`
   *  on a phased run. Read from the engine's `session.power` (its `outcome` once the run ended). */
  power?: RunPowerFact | null;
}

/** Planned vs actual of one power run. */
export interface RunPowerFact {
  plannedRigor: string;
  finalRigor: string;
  plannedScore: number;
  finalScore: number;
  /** The rigor rose after intake: the planner under-sized the change. */
  raised: boolean;
  estimateMinutes: number | null;
  actualMinutes: number | null;
}

/** The run identity the adapter attached (`session.run_identity`), when it did. */
function identityOf(s: Record<string, unknown>): Pick<RunFact, 'runName' | 'system'> {
  const id = s['run_identity'] as { name?: unknown; system?: unknown } | null | undefined;
  if (id === null || id === undefined || typeof id !== 'object') return {};
  return { runName: typeof id.name === 'string' && id.name !== '' ? id.name : null, system: id.system === true };
}

const RIGOR_RANK: Record<string, number> = { light: 0, standard: 1, high: 2, highest: 3 };

/** (program DES-POWER-MODE) The planned-vs-actual fact of a power run, or `null`. */
export function powerFactOf(session: Record<string, unknown>): RunPowerFact | null {
  const p = session['power'] as Record<string, unknown> | null | undefined;
  if (p === null || p === undefined || typeof p !== 'object') return null;
  const o = p['outcome'] as Record<string, unknown> | null | undefined;
  const plan = p['plan'] as Record<string, unknown> | null | undefined;
  // A run intake refused power mode for (phased required) ran phased: it is no power run.
  if (p['available'] === false || (plan?.['phasedRequired'] ?? null) !== null) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const plannedRigor = str(o?.['plannedRigor']) ?? str(plan?.['rigor']);
  if (plannedRigor === null) return null;
  const finalRigor = str(o?.['finalRigor']) ?? str(p['rigor']) ?? plannedRigor;
  return {
    plannedRigor,
    finalRigor,
    plannedScore: n(o?.['plannedScore']) ?? n(plan?.['score']) ?? 0,
    finalScore: n(o?.['finalScore']) ?? n(plan?.['score']) ?? 0,
    // Rose AFTER intake at any point (a raise later lowered at hand-off still counts), or ended above it.
    raised:
      (RIGOR_RANK[finalRigor] ?? 0) > (RIGOR_RANK[plannedRigor] ?? 0) ||
      (Array.isArray(p['history']) ? (p['history'] as Array<Record<string, unknown>>) : []).some(
        (r) => r['trigger'] !== 'intake' && r['direction'] === 'up',
      ),
    estimateMinutes: n(o?.['estimateMinutes']) ?? n(plan?.['estimateMinutes']),
    actualMinutes: n(o?.['actualMinutes']),
  };
}

/** A run open longer than this is unresolved (it is waiting on someone, or stuck). */
export const STALE_OPEN_MS = 24 * 3_600_000;
/** One wait longer than this is clipped (a gate left over a weekend should not swamp a median). */
const MAX_WAIT_MS = 7 * 24 * 3_600_000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** The one pricing classification: a `cliUsage.costUsd` is priced when it is a finite number (a reported 0 is priced,
 *  `null` or absent is not — a CLI that reports tokens only, like codex). Run facts, the seat fold and the run view share it. */
export const isPricedCost = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Who runs each unit, from the event log: `unitDistributed.cli`, moved by `unitReassigned.newCli`, else the unit row's
 * `assigned_cli`. Feed events in `ts`-then-`seq` order through {@link UnitOwners.observe}; it answers `true` for a frame
 * it consumed as an ownership change. Shared by the seat fold and the run-usage projection.
 */
export interface UnitOwners {
  observe(e: Record<string, unknown>): boolean;
  ownerOf(ord: number): string | undefined;
}

export function unitOwners(view: SessionView): UnitOwners {
  const owner = new Map<number, string>();
  const rows = new Map(view.units.map((u) => [u.ord, u]));
  const fin = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    observe(e) {
      const ord = fin(e['ord']);
      if (ord === undefined) return false;
      if (e['type'] === 'unitDistributed' && str(e['cli']) !== null) {
        owner.set(ord, e['cli'] as string);
        return true;
      }
      if (e['type'] === 'unitReassigned') {
        const next = str(e['newCli']);
        if (next !== null) owner.set(ord, next);
        return true;
      }
      return false;
    },
    ownerOf: (ord) => owner.get(ord) ?? str(rows.get(ord)?.assigned_cli) ?? undefined,
  };
}

/** A run's priced spend and the seats whose usage carried no price (the run view's `cost_usd` / `usage_seats_unmetered`). */
export interface RunUsageCost {
  /** Σ priced `cliUsage.costUsd`; `null` when usage was recorded and none was priced. */
  cost_usd: number | null;
  /** Unique, sorted seats that reported usage without a cost (a `cliUsage` with no price, or a `cliUsageUnreported`). */
  usage_seats_unmetered: string[];
}

/** Fold a run's events into {@link RunUsageCost}; `null` when the log has no usage frame at all (nothing to say). */
export function runUsageCost(view: SessionView, events: readonly LooseEvent[]): RunUsageCost | null {
  const owners = unitOwners(view);
  const ordered = [...events].sort((a, b) => (num(a.ts) - num(b.ts)) || (num(a['seq']) - num(b['seq'])));
  let cost = 0;
  let priced = 0;
  let usage = 0;
  const unmetered = new Set<string>();
  for (const e of ordered) {
    if (owners.observe(e)) continue;
    if (e.type !== 'cliUsage' && e.type !== 'cliUsageUnreported') continue;
    usage += 1;
    if (e.type === 'cliUsage' && isPricedCost(e['costUsd'])) {
      cost += e['costUsd'];
      priced += 1;
      continue;
    }
    const ord = typeof e['ord'] === 'number' ? e['ord'] : undefined;
    const seat = (ord === undefined ? undefined : owners.ownerOf(ord)) ?? str(e['cli']) ?? undefined;
    if (seat !== undefined) unmetered.add(seat);
  }
  if (usage === 0) return null;
  return {
    cost_usd: priced === 0 ? null : Math.round(cost * 10_000) / 10_000,
    usage_seats_unmetered: [...unmetered].sort(),
  };
}

/** `created_at` is epoch seconds on the wire; a value already in ms is kept. */
export function epochMs(v: unknown): number {
  const n = num(v);
  return n > 0 && n < 1e12 ? n * 1000 : n;
}

function outcomeOf(status: string, deliverRequested: boolean, delivered: boolean): RunOutcome {
  if (status === 'completed') return deliverRequested && !delivered ? 'failed' : 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'open';
}

// The engine's cancel frame is `runCancelled` (core `event.rs`); `sessionCancelled` is kept for older logs.
const TERMINAL_EVENTS = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled', 'sessionCancelled']);
const PARK_EVENTS = new Set(['awaitingHuman', 'gateEscalated']);
const UNPARK_EVENTS = new Set(['gateDecided', 'resumed']);

export function runFactOf(view: SessionView, events: readonly LooseEvent[], nowMs: number): RunFact {
  const s = view.session as unknown as Record<string, unknown>;
  const status = String(s['status'] ?? 'unknown');
  const deliverRequested = s['deliver_requested'] === true;
  const delivered = s['delivery'] === 'delivered';
  const createdAtMs = epochMs(s['created_at']) || num(events[0]?.ts);
  const ordered = [...events].sort((a, b) => num(a.ts) - num(b.ts));

  let endedAtMs: number | null = null;
  let floorMs = 0;
  let waitHumanMs = 0;
  let spendUsd = 0;
  let spendReported = false;
  let pricedFrames = 0;
  let unpricedFrames = 0;
  let terminalEventAt: number | null = null;
  let tokens = 0;
  let retries = 0;
  let stalls = 0;
  const overrides: RunOverride[] = [];
  const benched = new Map<string, { cli: string; reason: string }>();
  // A unit parked on a person: when it parked, and the escalation (if any) a later allow overrides.
  const parked = new Map<number, number>();
  const escalated = new Map<number, { condition: string; source: string | null }>();
  let lastEscalation: string | null = null;
  let lastStepFailure: string | null = null;

  for (const e of ordered) {
    const ts = num(e.ts);
    const ord = num(e.ord);
    if (TERMINAL_EVENTS.has(e.type)) {
      endedAtMs = ts;
      terminalEventAt = ts;
    }
    if (e.type === 'repoChecksEvaluated' && Array.isArray(e['checks'])) {
      for (const c of e['checks'] as unknown[]) floorMs += num((c as Record<string, unknown> | null)?.['durationMs']);
    }
    if (PARK_EVENTS.has(e.type) && !parked.has(ord)) parked.set(ord, ts);
    if (e.type === 'gateEscalated') {
      const condition = str(e['condition']) ?? 'unknown';
      const source = str(e['denialSource']);
      escalated.set(ord, { condition, source });
      lastEscalation = source !== null ? `${condition} (${source})` : condition;
    }
    if (UNPARK_EVENTS.has(e.type) && parked.has(ord)) {
      waitHumanMs += Math.min(MAX_WAIT_MS, Math.max(0, ts - (parked.get(ord) as number)));
      parked.delete(ord);
    }
    if (e.type === 'gateDecided' && e['allow'] === true && escalated.has(ord)) {
      const esc = escalated.get(ord) as { condition: string; source: string | null };
      overrides.push({ ord, condition: esc.condition, source: esc.source });
      escalated.delete(ord);
    }
    if (e.type === 'cliUsage') {
      if (isPricedCost(e['costUsd'])) {
        spendUsd += num(e['costUsd']);
        spendReported = true;
        pricedFrames += 1;
      } else unpricedFrames += 1;
      tokens += num(e['inputTokens']) + num(e['outputTokens']);
    }
    // An agent attempt that reported no usage at all (`cliUsageUnreported`): its cost is missing from the sum.
    if (e.type === 'cliUsageUnreported') unpricedFrames += 1;
    if (e.type === 'unitReassigned') retries += 1;
    if (e.type === 'stepFailed') {
      retries += 1;
      lastStepFailure = str(e['failureKind']);
    }
    if (e.type === 'workerStalled') stalls += 1;
    if (e.type === 'seatBenched') {
      const cli = str(e['cli']);
      if (cli !== null) benched.set(cli, { cli, reason: str(e['reason']) ?? 'unknown' });
    }
  }
  const lastTs = ordered.length > 0 ? num(ordered[ordered.length - 1]?.ts) : null;
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  if (terminal && endedAtMs === null) endedAtMs = lastTs;
  // A gate still open on a live run counts its wait so far.
  if (!terminal) for (const since of parked.values()) waitHumanMs += Math.min(MAX_WAIT_MS, Math.max(0, nowMs - since));

  const outcome = outcomeOf(status, deliverRequested, delivered);
  const archived = s['archived_at'] !== null && s['archived_at'] !== undefined;
  // Agents are the seats that did work: a Tool unit (`routing.method: "tool"`, run by `bash` or `wicked-estate`) is not one.
  const agents = [...new Set(view.units.flatMap((u) => {
    const unit = u as unknown as Record<string, unknown>;
    if ((unit['routing'] as { method?: unknown } | null | undefined)?.method === 'tool') return [];
    const cli = str(unit['assigned_cli']);
    return cli === null ? [] : [cli];
  }))].sort();
  let failureSignature: string | null = null;
  if (outcome === 'failed') {
    if (status === 'completed') failureSignature = 'deliver did not land';
    else failureSignature = lastEscalation ?? lastStepFailure ?? 'unknown';
  }
  const unresolved = (outcome === 'failed' && !archived) || (outcome === 'open' && !archived && nowMs - createdAtMs > STALE_OPEN_MS);
  return {
    id: String(s['id']),
    title: (str(s['title']) ?? str(s['problem']) ?? String(s['id'])).split('\n')[0]?.slice(0, 120) ?? String(s['id']),
    workflow: str(s['workflow_id']) ?? 'free-text',
    repo: str(s['repo_ref']),
    projectId: str(s['project_id']),
    agents,
    createdAtMs,
    endedAtMs,
    status,
    outcome,
    deliverRequested,
    delivered,
    archived,
    timeToPrMs: delivered && endedAtMs !== null ? Math.max(0, endedAtMs - createdAtMs) : null,
    floorMs,
    waitHumanMs,
    overrides,
    spendUsd,
    spendReported,
    pricedFrames,
    unpricedFrames,
    terminalAtMs: terminal ? (terminalEventAt ?? (num(s['finished_at']) > 0 ? epochMs(s['finished_at']) : null)) : null,
    tokens,
    retries,
    stalls,
    benched: [...benched.values()],
    failureSignature,
    unresolved,
    power: powerFactOf(s),
    ...identityOf(s),
  };
}
