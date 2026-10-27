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
  tokens: number;
  /** Reassignments plus failed steps. */
  retries: number;
  stalls: number;
  benched: { cli: string; reason: string }[];
  /** For a failed run: what stopped it, as one comparable line. */
  failureSignature: string | null;
  /** A failure nobody archived, or a run open for over a day. */
  unresolved: boolean;
}

/** A run open longer than this is unresolved (it is waiting on someone, or stuck). */
export const STALE_OPEN_MS = 24 * 3_600_000;
/** One wait longer than this is clipped (a gate left over a weekend should not swamp a median). */
const MAX_WAIT_MS = 7 * 24 * 3_600_000;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

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

const TERMINAL_EVENTS = new Set(['sessionCompleted', 'sessionFailed', 'sessionCancelled']);
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
    if (TERMINAL_EVENTS.has(e.type)) endedAtMs = ts;
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
      if (typeof e['costUsd'] === 'number') { spendUsd += num(e['costUsd']); spendReported = true; }
      tokens += num(e['inputTokens']) + num(e['outputTokens']);
    }
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
    tokens,
    retries,
    stalls,
    benched: [...benched.values()],
    failureSignature,
    unresolved,
  };
}
