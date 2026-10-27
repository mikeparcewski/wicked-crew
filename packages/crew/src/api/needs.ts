/**
 * The one "needs you" rule (`GET /system.attention[]`, api-types 0.140.0) and its companion,
 * `unresolved[]`.
 *
 * The operator's rule: anything that is work stuck (the system slowing or preventing it, work that
 * cannot move) is counted, prioritized by impact. So `attention[]` holds one item per ROOT CAUSE
 * holding work up right now:
 *
 * - `prevents`: work cannot move until a person acts (an open gate, a stalled run, a recent
 *   failure, a down component, a seat gap with no alternative);
 * - `slows`: the system itself slows work (host load).
 *
 * One cause that holds several runs is ONE item, naming them in `blockedRunIds`. A merge needs
 * evidence, never a similar label: the same repo failing the same check on a base that fails it
 * too (plus the run whose stated problem IS that red base, when it waits at a gate: its gate is the
 * item's action); the same down component a held run's denial names; the same seats leaving runs
 * with no distinct judge. Seat problems fold into the run item they block.
 *
 * What is NOT stuck never counts, and is never hidden either (operator, 2026-10-27: "don't let
 * the system go green with stale jobs"): superseded runs, failed runs older than 7 days and asks
 * parked at their turn gate past a day move to `unresolved[]`, each with what it cost and how to
 * resolve it. Answered asks are not stuck. Pending proposals are `toReview`.
 *
 * Order (DEFINITION §4): runs held, then prevents before slows, then a component before one run's own
 * cause (a component also holds every new run), then the longest wait (the gate's arrival, never the
 * run's launch), then the units left.
 *
 * Pure: every input is a reading the route already made.
 */

import type {
  SessionView,
  SystemAttentionItem,
  SystemCli,
  SystemInfraKey,
  SystemInfraRow,
  SystemResolveKind,
  SystemRun,
  SystemTarget,
  SystemUnresolvedItem,
} from '../core/types.js';

const DAY_MS = 86_400_000;
/** A failed run launched longer ago than this is history to resolve, not a need. */
export const FAILED_FRESH_MS = 7 * DAY_MS;
/** An ask parked at its turn gate longer than this is unresolved work. */
export const PARKED_AFTER_MS = DAY_MS;

/** The live components whose `down` (or silence) holds every live run. */
const WORK_PATH: ReadonlySet<SystemInfraKey> = new Set(['daemon', 'gateway', 'broker']);
/** What `down` means in words for the rows where "down" reads oddly. */
const DOWN_WORD: Partial<Record<SystemInfraKey, string>> = { load: 'saturated', disk: 'nearly full', state_home: 'refusing launches', skills: 'refusing launches' };
/** A held run's denial names the component it died on. */
const CITES: Partial<Record<SystemInfraKey, RegExp>> = {
  gateway: /\b(inference gateway|agw[:\s]|gateway)\b/i,
  broker: /\bbroker\b/i,
};

/** A floor denial whose base fails the same check: the red-base evidence. */
const BASE_RED = /base_red_unseparated|the run base [0-9a-f]{6,40} fails this check too|base fails (this check )?too/i;
/** The first failing check a floor denial names (`test: exit 101`). */
const CHECK_NAME = /(?:^|[\s(\]—-])([A-Za-z][\w.-]*): exit -?\d+/;
/** A run whose own stated problem is that its repo's base is red (the fix the group waits on). */
const STATES_RED_BASE = /\bbase\b[^.\n]{0,40}\bred\b|\bred base\b/i;
/** A dead-seat denial: every eligible seat failed the unit. */
const DEAD_SEAT = /dead seat|every eligible seat has (now )?failed/i;

export interface RunCost {
  costUsd: number | null;
  tokens: { input: number; output: number } | null;
}

export interface NeedsInput {
  now: number;
  /** Every run the engine lists (terminal and archived ones too), decorated. */
  views: readonly SessionView[];
  /** `runs[]`: the unfinished runs with computed liveness and their open gate. */
  runs: readonly SystemRun[];
  infra: readonly SystemInfraRow[];
  clis: readonly SystemCli[];
  /** Runs with no distinct judge in their pool (`judgeGaps`). */
  gaps: ReadonlyArray<{ run: SystemRun; creator: string | null; blockedBy: SystemCli[] }>;
  /** Whether a down component holds every live run (the container floor's gateway, …). */
  infraHoldsLive: (key: SystemInfraKey) => boolean;
  /** Per-run cost, when its log was read; absent ⇒ unknown. */
  costOf?: (runId: string) => RunCost | undefined;
}

export interface Needs {
  attention: SystemAttentionItem[];
  unresolved: SystemUnresolvedItem[];
  unresolvedSpend: { costUsd: number | null; tokens: { input: number; output: number } | null; costKnown: number };
}

const short = (id: string): string => id.slice(0, 8);
const isoOf = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const secsToMs = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v * 1000 : null);
const msOf = (v: string | null | undefined): number | null => {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const norm = (s: unknown): string => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');
const titleOf = (v: SessionView): string => (typeof v.session.title === 'string' && v.session.title !== '' ? v.session.title : v.session.problem.slice(0, 60));
const repoOf = (v: SessionView): string | null => (typeof v.session.repo_ref === 'string' && v.session.repo_ref !== '' ? v.session.repo_ref : null);
const unitsLeftOf = (v: SessionView | undefined): number => (v === undefined ? 0 : v.units.filter((u) => u.status !== 'done').length);
const isAskRun = (v: SessionView): boolean => v.session.ask_path === true || /^ask\//.test(v.session.workflow_id ?? '');
const DELIVERED = new Set(['delivered', 'pushed']);

/**
 * Which run replaced this one, if any: a run naming it in `retry_of`, or a LATER run with the same
 * repo, workflow and title that completed or delivered. A failed run with a retry is resolved by
 * that retry (`retried`); anything else superseded is still the operator's to close.
 */
export function supersession(views: readonly SessionView[]): Map<string, { by: string; retried: boolean }> {
  const out = new Map<string, { by: string; retried: boolean }>();
  for (const v of views) {
    const r = v.session.retry_of;
    if (typeof r === 'string' && r !== '' && r !== v.session.id && !out.has(r)) out.set(r, { by: v.session.id, retried: true });
  }
  const done = views
    .filter((v) => v.session.status === 'completed' || DELIVERED.has(v.session.delivery ?? ''))
    .map((v) => ({ v, at: secsToMs(v.session.created_at) }))
    .filter((x): x is { v: SessionView; at: number } => x.at !== null)
    .sort((a, b) => a.at - b.at);
  for (const v of views) {
    if (out.has(v.session.id)) continue;
    const at = secsToMs(v.session.created_at);
    const title = norm(titleOf(v));
    if (at === null || title === '') continue;
    const same = done.filter(
      (d) =>
        d.v.session.id !== v.session.id &&
        d.at > at &&
        repoOf(d.v) === repoOf(v) &&
        d.v.session.workflow_id === v.session.workflow_id &&
        norm(titleOf(d.v)) === title,
    );
    // The completed successor first (a run that delivered and then failed is a weaker link).
    const later = same.find((d) => d.v.session.status === 'completed') ?? same[0];
    if (later !== undefined) out.set(v.session.id, { by: later.v.session.id, retried: false });
  }
  return out;
}

/** An ask's TURN gate (answered by the chat's next message): a terminal gate with every unit done.
 *  An ask held at an escalation is a real gate (68c26704). */
export function isAnsweredAsk(v: SessionView, run: SystemRun | undefined): boolean {
  if (v.session.status !== 'awaiting_human' || !isAskRun(v)) return false;
  const kind = run?.gate?.kind ?? null;
  if (kind === 'escalation') return false;
  return v.session.ask_turn === true && v.units.length > 0 && v.units.every((u) => u.status === 'done');
}

interface Member {
  runId: string;
  view: SessionView | undefined;
  run: SystemRun | undefined;
  severity: 'red' | 'yellow';
  waitedMs: number | null;
}

interface Group {
  key: string;
  members: Member[];
  build: (members: Member[]) => Omit<SystemAttentionItem, 'blocks' | 'blockedRunIds' | 'waitedSince' | 'unitsLeft' | 'severity'> & { severity?: 'red' | 'yellow' };
}

function gateTarget(run: SystemRun | undefined, runId: string): SystemTarget {
  return {
    kind: 'run',
    runId,
    ...(run?.gate?.ord != null ? { gateOrd: run.gate.ord } : {}),
    ...(run?.gate?.interactionId != null ? { interactionId: run.gate.interactionId } : {}),
  };
}

/** The unit a held run's gate is about, and the words it was denied with. */
function denialOf(v: SessionView | undefined, run: SystemRun | undefined): string {
  if (v === undefined) return '';
  const ord = run?.gate?.ord ?? null;
  const at = ord !== null ? v.units.find((u) => u.ord === ord) : undefined;
  const own = typeof at?.denial_reason === 'string' ? at.denial_reason : '';
  if (own !== '') return own;
  return v.units.map((u) => u.denial_reason ?? '').find((d) => d !== '') ?? '';
}

/** The seats in a run's pool that cannot take its work, in words ("pi signed out, copilot benched"). */
function seatsOut(v: SessionView | undefined, clis: readonly SystemCli[]): string[] {
  const pool = v?.session.clis !== undefined && v.session.clis.length > 0 ? new Set(v.session.clis.map((k) => k.split('#', 1)[0])) : null;
  return clis
    .filter((c) => (pool === null || pool.has(c.cli.split('#', 1)[0]!)) && (c.state === 'signed_out' || c.state === 'benched'))
    .map((c) => `${c.cli} ${c.state === 'benched' ? `benched${c.benchedUntil !== undefined ? ` until ${c.benchedUntil.slice(11, 16)} UTC` : ''}` : 'signed out'}`);
}

function runItem(m: Member, clis: readonly SystemCli[]): ReturnType<Group['build']> {
  const r = m.run;
  const v = m.view;
  const title = v !== undefined ? titleOf(v) : `run ${short(m.runId)}`;
  if (r === undefined) {
    // A recent failed run: it stopped, and a person decides what happens to the work.
    return {
      id: `run:${m.runId}`,
      source: 'run',
      kind: 'prevents',
      title: `${title}: failed`,
      reason: `run ${short(m.runId)} failed${denialOf(v, undefined) !== '' ? `: ${denialOf(v, undefined).slice(0, 200)}` : ''}`,
      remedy: 'Open the run: retry it, or archive it with a reason.',
      target: { kind: 'run', runId: m.runId },
      action: { kind: 'open_run', label: 'Open the run' },
    };
  }
  const denial = denialOf(v, r);
  const dead = DEAD_SEAT.test(denial);
  const out = dead ? seatsOut(v, clis) : [];
  return {
    id: `run:${m.runId}`,
    source: 'run',
    kind: 'prevents',
    title: dead ? `${title}: dead seat` : title,
    reason: `${r.reason}${dead && out.length > 0 ? `; no failover: ${out.join(', ')}` : ''}`,
    remedy:
      r.liveness === 'waiting_on_you'
        ? 'Answer the gate.'
        : r.liveness === 'held'
          ? dead
            ? `Open the gate and approve the retry${out.length > 0 ? `; sign in ${out.filter((s) => s.endsWith('signed out')).map((s) => s.split(' ')[0]).join(' and ') || 'another seat'} to restore failover` : ''}.`
            : 'Open the gate and decide: retry with a note, reassign, or stop.'
          : 'Open the run: reassign the unit or stop the run. The watchdog re-dispatches a silent unit on its own after its escalation threshold.',
    target: gateTarget(r, m.runId),
    action: r.gate !== undefined ? { kind: 'open_gate', label: 'Open the gate' } : { kind: 'open_run', label: 'Open the run' },
  };
}

export function buildNeeds(input: NeedsInput): Needs {
  const { now } = input;
  const byId = new Map(input.views.map((v) => [v.session.id, v]));
  const runById = new Map(input.runs.map((r) => [r.runId, r]));
  const sup = supersession(input.views);
  const unresolved: SystemUnresolvedItem[] = [];
  const members: Member[] = [];

  const costFor = (v: SessionView): SystemUnresolvedItem['cost'] => {
    const c = input.costOf?.(v.session.id);
    const start = secsToMs(v.session.created_at);
    const end = secsToMs(v.session.ended_at) ?? (v.session.status === 'failed' || v.session.status === 'completed' || v.session.status === 'cancelled' ? null : now);
    return { costUsd: c?.costUsd ?? null, tokens: c?.tokens ?? null, wallMs: start !== null && end !== null ? Math.max(0, end - start) : null };
  };
  const pushUnresolved = (v: SessionView, why: SystemUnresolvedItem['why'], reason: string, since: number | null, actions: SystemResolveKind[], by?: string): void => {
    unresolved.push({
      id: `unresolved:${v.session.id}`,
      runId: v.session.id,
      title: titleOf(v),
      status: v.session.status,
      why,
      reason,
      ...(by !== undefined ? { supersededBy: by } : {}),
      since: isoOf(since),
      cost: costFor(v),
      actions,
    });
  };

  for (const v of input.views) {
    if (v.session.archived_at != null) continue; // resolved on the record
    const id = v.session.id;
    const run = runById.get(id);
    const s = sup.get(id);
    const status = v.session.status;
    const gateAt = msOf(run?.gate?.receivedAt ?? null);
    const endedAt = secsToMs(v.session.ended_at);
    if (status === 'failed') {
      if (s?.retried === true) continue; // retried: the retry carries the work
      if (s !== undefined) {
        const d = byId.get(s.by);
        pushUnresolved(v, 'superseded', `failed; superseded by ${short(s.by)}, which ${d !== undefined && DELIVERED.has(d.session.delivery ?? '') ? 'delivered' : 'completed'}`, endedAt, ['close_superseded', 'archive'], s.by);
        continue;
      }
      const launched = secsToMs(v.session.created_at);
      if (launched !== null && now - launched > FAILED_FRESH_MS) {
        pushUnresolved(v, 'failed', `failed ${Math.round((now - (endedAt ?? launched)) / DAY_MS)} day(s) ago and was never retried or archived`, endedAt ?? launched, ['retry', 'archive']);
        continue;
      }
      members.push({ runId: id, view: v, run: undefined, severity: 'red', waitedMs: endedAt });
      continue;
    }
    if (run === undefined) continue; // completed / cancelled: resolved
    if (s !== undefined) {
      const d = byId.get(s.by);
      const how = s.retried ? `retried as ${short(s.by)}` : `superseded by ${short(s.by)}`;
      const what = d === undefined ? '' : d.session.status === 'completed' || DELIVERED.has(d.session.delivery ?? '') ? `, which ${DELIVERED.has(d.session.delivery ?? '') ? 'delivered' : 'completed'}` : `, which is ${d.session.status.replace(/_/g, ' ')}`;
      pushUnresolved(v, 'superseded', `still open at its ${run.gate?.kind?.replace(/_/g, ' ') ?? 'last'} gate; ${how}${what}`, gateAt, ['close_superseded', 'archive'], s.by);
      continue;
    }
    if (isAnsweredAsk(v, run)) {
      if (gateAt !== null && now - gateAt > PARKED_AFTER_MS) {
        pushUnresolved(v, 'parked', `an answered ask parked at its turn for ${Math.round((now - gateAt) / 3_600_000)} h`, gateAt, ['archive']);
      }
      continue;
    }
    if (run.liveness === 'working' || run.liveness === 'quiet') continue;
    members.push({ runId: id, view: v, run, severity: run.liveness === 'waiting_on_you' ? 'yellow' : 'red', waitedMs: gateAt });
  }

  const groups = new Map<string, Group>();
  const join = (key: string, m: Member, build: Group['build']): void => {
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { key, members: [m], build });
    else if (!g.members.some((x) => x.runId === m.runId)) g.members.push(m);
  };

  // Down (or silent) components first: a held run whose denial names one joins it.
  const infraItems: Array<{ row: SystemInfraRow; kind: 'prevents' | 'slows' }> = [];
  for (const row of input.infra) {
    if (row.state === 'down') infraItems.push({ row, kind: 'prevents' });
    else if (row.state === 'degraded' && (row.key === 'load' || (row.key === 'skills' && /launches wait/i.test(row.reason)))) infraItems.push({ row, kind: 'slows' });
    else if (row.state === 'unknown' && WORK_PATH.has(row.key)) infraItems.push({ row, kind: 'slows' });
  }
  // A down component claims the held runs whose denial names it, and the stalled runs on its path
  // (a stalled run behind a dead gateway is the gateway's, not a cause of its own).
  const claimed = new Set<string>();
  for (const { row } of infraItems) {
    if (row.state !== 'down') continue;
    const cites = CITES[row.key];
    const onPath = input.infraHoldsLive(row.key);
    for (const m of members) {
      if (m.run === undefined) continue;
      if ((cites !== undefined && cites.test(denialOf(m.view, m.run))) || (onPath && m.run.liveness === 'stalled')) claimed.add(`${row.key}\u0000${m.runId}`);
    }
  }

  // Red base: same repo, same failing check, a base that fails it too.
  const baseKey = (m: Member): string | null => {
    if (m.run === undefined || m.view === undefined) return null;
    const d = denialOf(m.view, m.run);
    if (!BASE_RED.test(d)) return null;
    const repo = repoOf(m.view);
    if (repo === null) return null;
    return `base:${repo}:${CHECK_NAME.exec(d)?.[1] ?? 'checks'}`;
  };
  const rest: Member[] = [];
  for (const m of members) {
    if ([...claimed].some((c) => c.endsWith(`\u0000${m.runId}`))) continue;
    const k = baseKey(m);
    if (k !== null) {
      join(k, m, (ms) => baseRedItem(k, ms));
      continue;
    }
    rest.push(m);
  }
  // The fix the red base waits on: a run in that repo whose own problem is the red base.
  const left: Member[] = [];
  for (const m of rest) {
    const repo = m.view !== undefined ? repoOf(m.view) : null;
    const target = m.run !== undefined && m.run.gate !== undefined && repo !== null && STATES_RED_BASE.test(m.view?.session.problem ?? '')
      ? [...groups.values()].filter((g) => g.key.startsWith(`base:${repo}:`)).sort((a, b) => b.members.length - a.members.length)[0]
      : undefined;
    if (target !== undefined) target.members.push(m);
    else left.push(m);
  }
  // Runs with no distinct judge and nothing else holding them: one item per set of missing seats.
  const gapByRun = new Map(input.gaps.map((g) => [g.run.runId, g]));
  for (const m of left) {
    const gap = gapByRun.get(m.runId);
    join(`run:${m.runId}`, m, (ms) => {
      const base = runItem(ms[0]!, input.clis);
      if (gap === undefined) return base;
      const who = gap.blockedBy.map((c) => `${c.cli} ${c.state === 'benched' ? 'benched' : c.state.replace('_', ' ')}`);
      return { ...base, severity: 'red', reason: `${base.reason}; no distinct judge for ${gap.creator ?? 'its creator'}'s work${who.length > 0 ? ` (${who.join(', ')})` : ''}` };
    });
  }
  const memberIds = new Set(members.map((m) => m.runId));
  for (const gap of input.gaps) {
    if (memberIds.has(gap.run.runId)) continue;
    const v = byId.get(gap.run.runId);
    if (v !== undefined && sup.has(v.session.id)) continue;
    const seats = gap.blockedBy.map((c) => c.cli).sort().join('+');
    const key = `seat:${gap.creator ?? ''}:${seats}`;
    join(key, { runId: gap.run.runId, view: v, run: gap.run, severity: 'red', waitedMs: msOf(gap.run.gate?.receivedAt ?? null) }, (ms) => {
      const who = gap.blockedBy.map((c) => `${c.cli} ${c.state === 'benched' ? 'benched' : c.state.replace('_', ' ')}`);
      return {
        id: ms.length === 1 ? `judge:${ms[0]!.runId}` : key,
        source: 'run',
        kind: 'prevents',
        title: ms.length === 1 ? `run ${short(ms[0]!.runId)}: no distinct judge` : `${ms.length} runs: no distinct judge`,
        reason: `no seat in the pool can judge ${gap.creator ?? 'the creator'}'s work${who.length > 0 ? ` (${who.join(', ')})` : ''}`,
        remedy: 'Sign in another CLI in the run’s pool, or reassign the unit to a seat whose work another seat can judge.',
        target: gateTarget(ms[0]!.run, ms[0]!.runId),
        action: ms[0]!.run?.gate !== undefined ? { kind: 'open_gate', label: 'Open the gate' } : { kind: 'open_run', label: 'Open the run' },
      };
    });
  }
  // No seat can take any work at all: that is its own item, holding every run.
  const anyWorker = input.clis.some((c) => c.workEligible && c.state !== 'signed_out' && c.state !== 'benched');
  if (input.clis.length > 0 && !anyWorker) {
    const live = input.runs.filter((r) => !sup.has(r.runId)).map((r) => ({ runId: r.runId, view: byId.get(r.runId), run: r, severity: 'red' as const, waitedMs: null }));
    groups.set('cli:none', {
      key: 'cli:none',
      members: live,
      build: () => ({
        id: 'cli:none',
        source: 'cli',
        kind: 'prevents',
        title: 'No seat can take work',
        reason: `every CLI is signed out or benched (${seatsOut(undefined, input.clis).join(', ')})`,
        remedy: 'Sign a CLI in, or wait for a bench to lift.',
        target: { kind: 'cli', cli: input.clis[0]!.cli },
        action: input.clis.some((c) => c.canSignIn) ? { kind: 'sign_in', label: 'Sign in' } : null,
      }),
    });
  }

  const items: SystemAttentionItem[] = [];
  const finish = (g: { members: Member[] }, body: ReturnType<Group['build']>): void => {
    const ms = g.members;
    const waits = ms.map((m) => m.waitedMs).filter((x): x is number => x !== null);
    items.push({
      ...body,
      severity: body.severity ?? (ms.some((m) => m.severity === 'red') ? 'red' : 'yellow'),
      blocks: ms.length,
      blockedRunIds: ms.map((m) => m.runId),
      // A slowdown has no wait of its own: the runs it slows wait on their own causes.
      waitedSince: body.kind === 'slows' ? null : isoOf(waits.length > 0 ? Math.min(...waits) : null),
      unitsLeft: ms.reduce((a, m) => a + unitsLeftOf(m.view), 0),
    });
  };
  for (const g of groups.values()) finish(g, g.build(g.members));

  // Components: a down one holds the runs whose denial names it (and every live run when it is on
  // their path); host load slows the held runs whose next step is real work, and every new run.
  const heldMembers = members.filter((m) => m.run !== undefined);
  for (const { row, kind } of infraItems) {
    const held: Member[] = [];
    const add = (m: Member): void => {
      if (!held.some((x) => x.runId === m.runId)) held.push(m);
    };
    if (row.key === 'load') {
      for (const m of heldMembers) if (m.run!.gate?.kind === 'escalation' && m.view !== undefined && !isAskRun(m.view)) add(m);
      for (const r of input.runs) if ((r.liveness === 'working' || r.liveness === 'quiet' || r.liveness === 'stalled') && !sup.has(r.runId)) add({ runId: r.runId, view: byId.get(r.runId), run: r, severity: 'yellow', waitedMs: null });
    } else {
      for (const m of heldMembers) if (claimed.has(`${row.key}\u0000${m.runId}`)) add(m);
      if (input.infraHoldsLive(row.key)) {
        for (const r of input.runs) if ((r.liveness === 'working' || r.liveness === 'quiet' || r.liveness === 'stalled') && !sup.has(r.runId)) add({ runId: r.runId, view: byId.get(r.runId), run: r, severity: 'red', waitedMs: null });
      }
    }
    const down = row.state === 'down';
    finish(
      { members: held },
      {
        id: `infra:${row.key}`,
        severity: down ? 'red' : 'yellow',
        source: 'infra',
        kind,
        title: `${row.label}: ${row.state === 'unknown' ? 'not answering' : down ? (DOWN_WORD[row.key] ?? 'down') : 'degraded'}`,
        reason: `${row.reason}${held.length > 0 ? `; it ${kind === 'slows' ? 'slows the next step of' : 'holds'} ${held.length} run(s)${row.key === 'load' ? ' and every new run' : ''}` : ''}`,
        remedy: row.remedy ?? 'Re-check.',
        target: { kind: 'infra', key: row.key },
        action: { kind: 'recheck', label: 'Re-check' },
      },
    );
  }

  const KIND_RANK = { prevents: 0, slows: 1 } as const;
  items.sort(
    (a, b) =>
      b.blocks - a.blocks ||
      KIND_RANK[a.kind ?? 'prevents'] - KIND_RANK[b.kind ?? 'prevents'] ||
      // A component also holds every NEW run: on a tie it outranks one run's own cause.
      (a.source === 'infra' ? 0 : 1) - (b.source === 'infra' ? 0 : 1) ||
      (msOf(a.waitedSince ?? null) ?? Infinity) - (msOf(b.waitedSince ?? null) ?? Infinity) ||
      (b.unitsLeft ?? 0) - (a.unitsLeft ?? 0) ||
      a.id.localeCompare(b.id),
  );

  const costed = unresolved.filter((u) => u.cost.costUsd !== null);
  const tokened = unresolved.filter((u) => u.cost.tokens !== null);
  unresolved.sort(
    (a, b) =>
      (b.cost.costUsd ?? -1) - (a.cost.costUsd ?? -1) ||
      (msOf(a.since) ?? Infinity) - (msOf(b.since) ?? Infinity) ||
      a.runId.localeCompare(b.runId),
  );
  return {
    attention: items,
    unresolved,
    unresolvedSpend: {
      costUsd: costed.length > 0 ? Math.round(costed.reduce((s, u) => s + (u.cost.costUsd ?? 0), 0) * 10_000) / 10_000 : null,
      tokens: tokened.length > 0 ? tokened.reduce((t, u) => ({ input: t.input + u.cost.tokens!.input, output: t.output + u.cost.tokens!.output }), { input: 0, output: 0 }) : null,
      costKnown: costed.length,
    },
  };
}

function baseRedItem(key: string, ms: Member[]): ReturnType<Group['build']> {
  const [, repo, check] = key.split(':') as [string, string, string];
  const fix = ms.find((m) => STATES_RED_BASE.test(m.view?.session.problem ?? '') && baseKeyless(m));
  const floors = ms.filter((m) => m !== fix);
  const fixTitle = fix?.view !== undefined ? titleOf(fix.view) : '';
  return {
    id: key,
    source: 'run',
    kind: 'prevents',
    title: `${repo}'s base is red inside the floor sandbox`,
    reason: `${floors.length} run(s) fail \`${check}\` on a base that fails it too${fix !== undefined ? `; the fix ${short(fix.runId)} ("${fixTitle}") waits at its ${fix.run?.gate?.kind?.replace(/_/g, ' ') ?? ''} gate` : ''}`,
    remedy:
      fix !== undefined
        ? `Approve delivery of ${short(fix.runId)} ("${fixTitle}"), merge it, then retry the held floors.`
        : 'Make the base green (or use the floor override), then retry the held floors.',
    target: gateTarget((fix ?? ms[0])!.run, (fix ?? ms[0])!.runId),
    action: { kind: 'open_gate', label: fix !== undefined ? 'Open the fix’s gate' : 'Open the gate' },
  };
}

/** A run that joined a red-base group as its fix (it has no red-base denial of its own). */
function baseKeyless(m: Member): boolean {
  return !BASE_RED.test(denialOf(m.view, m.run));
}

/** The level: `red` when an attention item is red; `yellow` when anything needs a look OR is
 *  unresolved; `green` only when both are empty. */
export function needsLevel(attention: readonly SystemAttentionItem[], unresolved: readonly SystemUnresolvedItem[] = []): 'green' | 'yellow' | 'red' {
  if (attention.some((a) => a.severity === 'red')) return 'red';
  return attention.length > 0 || unresolved.length > 0 ? 'yellow' : 'green';
}

/** Fold one run's event log into what it cost (`cliUsage` frames). `null` fields when none carried it. */
export function foldRunCost(events: ReadonlyArray<{ type?: unknown; [k: string]: unknown }>): RunCost {
  let input = 0;
  let output = 0;
  let tokens = false;
  let cost = 0;
  let costed = false;
  for (const e of events) {
    if (e.type !== 'cliUsage') continue;
    const i = typeof e['inputTokens'] === 'number' ? (e['inputTokens'] as number) : undefined;
    const o = typeof e['outputTokens'] === 'number' ? (e['outputTokens'] as number) : undefined;
    if (i !== undefined || o !== undefined) {
      tokens = true;
      input += i ?? 0;
      output += o ?? 0;
    }
    if (typeof e['costUsd'] === 'number' && Number.isFinite(e['costUsd'])) {
      costed = true;
      cost += e['costUsd'] as number;
    }
  }
  return { costUsd: costed ? Math.round(cost * 10_000) / 10_000 : null, tokens: tokens ? { input, output } : null };
}

/** Per-run cost, read once per terminal run (it cannot change) and briefly for an open one. The
 *  snapshot never waits past its bound: a run not read yet reads unknown, and the next read has it. */
export class RunCostCache {
  private readonly done = new Map<string, { at: number; cost: RunCost; final: boolean }>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  get(runId: string): RunCost | undefined {
    return this.done.get(runId)?.cost;
  }

  /** Read every listed run not cached (or stale); resolves when all are read. */
  fill(runs: ReadonlyArray<{ id: string; final: boolean }>, read: (id: string) => Promise<ReadonlyArray<{ type?: unknown; [k: string]: unknown }> | null>): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const t = this.now();
    const todo = runs.filter((r) => {
      const c = this.done.get(r.id);
      return c === undefined || (!c.final && t - c.at > this.ttlMs);
    });
    if (todo.length === 0) return Promise.resolve();
    this.inFlight = (async () => {
      for (const r of todo) {
        try {
          const events = await read(r.id);
          if (events !== null) this.done.set(r.id, { at: this.now(), cost: foldRunCost(events), final: r.final });
        } catch {
          // unreadable: stays unknown, retried next read
        }
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
}
