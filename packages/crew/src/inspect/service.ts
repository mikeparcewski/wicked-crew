/**
 * "IS THIS GOING WELL?" — the in-flight check on a working step (operator 2026-10-30: "if it's been running long you
 * can have an agent analyze right there, to make sure no tokens are wasted and no problems are occurring").
 *
 * A person asks (`POST /runs/:id/units/:ord/inspect`, human operator only, audited). Crew reads the step's newest
 * attempt off the run's own log ({@link readUnit}: what it called, edited, said and spent) and hands that reading and
 * the step's recent frames to ONE seat that is not the step's own: an `inspect-unit` run, one turn, no repository,
 * read-only (a neutral phase that executes no code: the engine's read-only write posture), its reply one JSON object.
 * The seat words the verdict (progressing, looping, stuck, wasteful), what the step is doing and how far along it
 * is, the evidence, and one recommended action (let it run, steer with a note, stop).
 *
 * It never steers, stops or edits anything: nothing here calls the source run. The person chooses what to do with
 * the answer, through the ordinary routes. Its own cost is bounded: a wall-clock limit and a token/cost budget,
 * past either of which crew stops the check run and answers with its own reading, saying why. Every answer says
 * whose it is and what it cost.
 *
 * The answer is a record (`<dir>/<runId>.json`, newest first) and a `/ws` frame `unitInspection`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LaunchRunInput, WorkflowDef } from '../core/types.js';
import { readUnit, timeline, type InspectAction, type InspectVerdict, type UnitReading } from './reading.js';

export const INSPECT_WORKFLOW = 'inspect-unit';
export const INSPECT_WORKFLOW_FILE = fileURLToPath(new URL('../../workflows/inspect-unit.json', import.meta.url));

/** How long a check may take before crew answers with its own reading. */
export const INSPECT_TIMEOUT_MS = 4 * 60_000;
/** The check's own budget: past either, crew stops it and answers with its own reading. */
export const INSPECT_MAX_COST_USD = 0.25;
export const INSPECT_MAX_TOKENS = 400_000;
/** Seats in the order a check prefers them (the step's own seat is never asked). */
export const INSPECT_SEAT_ORDER: readonly string[] = ['claude', 'codex', 'pi', 'copilot'];
/** Records kept per run. */
const KEEP = 20;

export interface InspectionCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface InspectionRecord {
  id: string;
  runId: string;
  ord: number;
  attempt: number;
  state: 'checking' | 'done';
  requestedBy: string;
  requestedAt: number;
  finishedAt: number | null;
  /** The step's own seat. */
  workerSeat: string | null;
  /** The seat that checked (never the step's own), null when none could. */
  seat: string | null;
  /** The check's own run, null when none was launched. */
  checkRunId: string | null;
  /** Whose answer this is: the checking seat's, or crew's own reading (with why). */
  source: 'seat' | 'crew' | null;
  why: string | null;
  verdict: InspectVerdict | null;
  doing: string | null;
  progress: string | null;
  evidence: string[];
  action: InspectAction | null;
  note: string | null;
  /** Crew's own reading at the time of the ask (always there, whatever the seat answered). */
  reading: UnitReading;
  /** What the check itself spent, when its seat reported it. */
  cost: InspectionCost | null;
}

interface RunView {
  session: { id: string; status: string; unit_ix?: number; problem?: string; title?: unknown };
  units: Array<{ ord: number; status: string; assigned_cli?: string | null; description?: string | null; id?: string }>;
}

export interface InspectServiceDeps {
  adapter: {
    sessionsDetail(): Promise<unknown[]>;
    runEvents(runId: string): Promise<unknown[] | null>;
    seatsForWorkflow(workflowId: string): Promise<unknown[]>;
    launchRun(input: LaunchRunInput): Promise<string>;
    cancelRun(runId: string): Promise<unknown>;
  };
  /** The check run's reply text (its one unit's output), null when there is none. */
  replyOf(checkRunId: string): Promise<string | null>;
  dir: string;
  broadcast(frame: Record<string, unknown>): void;
  /** Launch bookkeeping for the check run (audit line, timing index). */
  launched?(checkRunId: string, sourceRunId: string): void;
  log(m: string): void;
  newId(): string;
  now?(): number;
  timeoutMs?: number;
  maxCostUsd?: number;
  maxTokens?: number;
}

export class InspectError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const seatCli = (key: string): string => key.split('#')[0] ?? key;
const VERDICTS: ReadonlySet<string> = new Set(['progressing', 'looping', 'stuck', 'wasteful']);
const ACTIONS: ReadonlySet<string> = new Set(['let_run', 'steer', 'stop']);
const END_EVENTS: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled', 'sessionCancelled']);

/** The step the run is working on now, or null (the engine's cursor on a unit that has not finished). */
export function workingOrd(view: RunView): number | null {
  if (view.session.status !== 'executing') return null;
  const ordered = [...view.units].sort((a, b) => a.ord - b.ord);
  const cursor = ordered[view.session.unit_ix ?? -1];
  if (cursor === undefined || cursor.status === 'done' || cursor.status === 'rejected') return null;
  return cursor.ord;
}

/** The seat that checks: signed in, eligible, never the step's own CLI; in {@link INSPECT_SEAT_ORDER}. */
export function pickInspectSeat(roster: readonly unknown[], workerSeat: string | null): Record<string, unknown> | null {
  const worker = workerSeat !== null ? seatCli(workerSeat) : null;
  const ok = roster.filter((s): s is Record<string, unknown> => {
    if (!isRecord(s) || typeof s['key'] !== 'string') return false;
    if (worker !== null && (seatCli(s['key']) === worker || (typeof s['cli'] === 'string' && seatCli(s['cli']) === worker))) return false;
    if (s['council_eligible'] === false || s['signed_in'] === false) return false;
    const health = s['health'];
    return !(isRecord(health) && typeof health['status'] === 'string' && health['status'] !== 'active');
  });
  const rank = (s: Record<string, unknown>): number => {
    const i = INSPECT_SEAT_ORDER.indexOf(seatCli(String(s['key'])));
    return i === -1 ? INSPECT_SEAT_ORDER.length : i;
  };
  return [...ok].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** The checking seat's answer: the last JSON object in its reply that names a verdict, checked field by field. */
export function parseInspectReply(text: string | null): Pick<InspectionRecord, 'verdict' | 'doing' | 'progress' | 'evidence' | 'action' | 'note'> | null {
  if (text === null) return null;
  for (const raw of jsonObjects(text).reverse()) {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(v) || typeof v['verdict'] !== 'string' || !VERDICTS.has(v['verdict'])) continue;
    const s = (k: string, max: number): string | null => (typeof v[k] === 'string' && (v[k] as string).trim() !== '' ? (v[k] as string).trim().slice(0, max) : null);
    // A malformed action (or a steer with no note) is not an answer: crew's own reading stands (xreview on #1233).
    if (typeof v['action'] !== 'string' || !ACTIONS.has(v['action'])) return null;
    const action = v['action'] as InspectAction;
    const note = action === 'steer' ? s('note', 600) : null;
    if (action === 'steer' && note === null) return null;
    return {
      verdict: v['verdict'] as InspectVerdict,
      doing: s('doing', 240),
      progress: s('progress', 240),
      evidence: Array.isArray(v['evidence']) ? v['evidence'].filter((e): e is string => typeof e === 'string' && e.trim() !== '').map((e) => e.trim().slice(0, 240)).slice(0, 5) : [],
      action,
      note,
    };
  }
  return null;
}

/** Every balanced `{…}` in `text` that parses as JSON, in order of where it ends: each `{` is tried as a start, so
 *  prose with a stray brace before the answer does not hide it (xreview on #1233). */
function jsonObjects(text: string): string[] {
  const out: Array<{ end: number; raw: string }> = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const raw = text.slice(start, i + 1);
          try {
            JSON.parse(raw);
            out.push({ end: i, raw });
          } catch {
            /* not JSON */
          }
          break;
        }
      }
    }
  }
  return out.sort((a, b) => a.end - b.end).map((o) => o.raw);
}

/** The check run's brief: the reading and the recent frames, inline (the seat needs no tool to read them). */
export function inspectBrief(view: RunView, ord: number, reading: UnitReading, frames: string[]): string {
  const unit = view.units.find((u) => u.ord === ord);
  const title = String(view.session.title ?? view.session.problem?.split('\n')[0] ?? view.session.id).slice(0, 160);
  const digest = {
    job: title,
    step: { ord, seat: unit?.assigned_cli ?? null, description: (unit?.description ?? '').slice(0, 400) },
    elapsed_s: reading.elapsedMs !== null ? Math.round(reading.elapsedMs / 1000) : null,
    calls: reading.calls,
    open_calls: reading.openCalls.map((o) => ({ tool: o.tool, target: o.target, for_s: Math.round(o.forMs / 1000) })),
    by_kind: reading.byKind,
    edits: reading.edits.slice(0, 15),
    said: { messages: reading.said.deltas, chars: reading.said.chars, newest: reading.said.newest },
    usage: reading.usage,
    crew_reading: { verdict: reading.verdict, evidence: reading.evidence },
  };
  let recent = frames.join('\n');
  if (recent.length > 6000) recent = `…\n${recent.slice(-6000)}`;
  return [
    `Check on step ${ord} of the job "${title}": is it going well? You only read: you change nothing and run nothing.`,
    '',
    'Its record so far (crew read it off the run\'s log):',
    JSON.stringify(digest),
    '',
    'Its recent activity, oldest first (+seconds since the step started):',
    recent === '' ? '(none recorded)' : recent,
  ].join('\n');
}

/** The in-flight checks of one daemon. */
/** The in-flight checks of one daemon. */
export class InspectService {
  private readonly now: () => number;
  /** Check run id → the record it answers. Kept until the record's answer is saved (`finalizing` meanwhile). */
  private readonly pending = new Map<string, { runId: string; id: string; timer: NodeJS.Timeout | null; finalizing: boolean }>();
  /** A start in flight per step: a second ask for the same step joins it (xreview on #1233). */
  private readonly starting = new Map<string, Promise<InspectionRecord>>();

  constructor(private readonly deps: InspectServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private file(runId: string): string {
    return join(this.deps.dir, `${encodeURIComponent(runId)}.json`);
  }

  /** The run's records, newest first. */
  list(runId: string): InspectionRecord[] {
    const f = this.file(runId);
    if (!existsSync(f)) return [];
    try {
      const v = JSON.parse(readFileSync(f, 'utf8')) as unknown;
      return Array.isArray(v) ? (v as InspectionRecord[]) : [];
    } catch {
      return [];
    }
  }

  private save(rec: InspectionRecord): void {
    mkdirSync(this.deps.dir, { recursive: true });
    const rest = this.list(rec.runId).filter((r) => r.id !== rec.id);
    const f = this.file(rec.runId);
    writeFileSync(`${f}.tmp`, JSON.stringify([rec, ...rest].slice(0, KEEP)), 'utf8');
    renameSync(`${f}.tmp`, f);
    this.deps.broadcast({ type: 'unitInspection', session: rec.runId, ord: rec.ord, inspection: rec });
  }

  /** A record still `checking` that no check of this daemon owns (it restarted mid-check) ends with crew's reading. */
  settle(runId: string): InspectionRecord[] {
    for (const r of this.list(runId)) {
      if (r.state === 'checking' && (r.checkRunId === null || !this.pending.has(r.checkRunId))) {
        this.finishWithReading(r, 'Studio\'s service restarted during the check, so this is crew\'s own reading from when it was asked.');
      }
    }
    return this.list(runId);
  }

  /**
   * At boot, before anything resumes: every check a restart interrupted is stopped (its run cancelled, so it can
   * never spend past its bound unwatched; xreview on #1233) and answered with crew's reading. Never throws.
   */
  async recover(): Promise<void> {
    let names: string[] = [];
    try {
      names = existsSync(this.deps.dir) ? readdirSync(this.deps.dir).filter((n) => n.endsWith('.json')) : [];
    } catch {
      return;
    }
    for (const name of names) {
      const runId = decodeURIComponent(name.slice(0, -'.json'.length));
      for (const r of this.list(runId)) {
        if (r.state !== 'checking' || (r.checkRunId !== null && this.pending.has(r.checkRunId))) continue;
        if (r.checkRunId !== null) {
          try {
            await this.deps.adapter.cancelRun(r.checkRunId);
          } catch {
            /* already ended */
          }
        }
        this.finishWithReading(r, 'Studio\'s service restarted during the check, so crew stopped it; this is crew\'s own reading from when it was asked.');
      }
    }
  }

  /** Start a check on step `ord` of `runId` for `requestedBy`. Answers at once with the record (`state: checking`). */
  start(runId: string, ord: number, requestedBy: string): Promise<InspectionRecord> {
    const k = `${runId}:${ord}`;
    const open = this.starting.get(k);
    if (open !== undefined) return open;
    const p = this.startOnce(runId, ord, requestedBy).finally(() => this.starting.delete(k));
    this.starting.set(k, p);
    return p;
  }

  private async startOnce(runId: string, ord: number, requestedBy: string): Promise<InspectionRecord> {
    this.settle(runId);
    const already = this.list(runId).find((r) => r.ord === ord && r.state === 'checking');
    if (already !== undefined) return already;
    const view = ((await this.deps.adapter.sessionsDetail()) as RunView[]).find((v) => v.session.id === runId);
    if (view === undefined) throw new InspectError(404, 'not_found', 'Run not found');
    const unit = view.units.find((u) => u.ord === ord);
    if (unit === undefined) throw new InspectError(404, 'not_found', `Step ${ord} not found in run ${runId}`);
    if (workingOrd(view) !== ord) {
      throw new InspectError(409, 'not_working', `Step ${ord} is not working now, so there is nothing to check.`);
    }
    const now = this.now();
    const events = ((await this.deps.adapter.runEvents(runId)) ?? []) as Record<string, unknown>[];
    const reading = readUnit(events, ord, now);
    const workerSeat = unit.assigned_cli ?? null;
    const rec: InspectionRecord = {
      id: this.deps.newId(), runId, ord, attempt: reading.attempt, state: 'checking', requestedBy, requestedAt: now,
      finishedAt: null, workerSeat, seat: null, checkRunId: null, source: null, why: null, verdict: null, doing: null,
      progress: null, evidence: [], action: null, note: null, reading, cost: null,
    };
    let seat: Record<string, unknown> | null = null;
    try {
      seat = pickInspectSeat(await this.deps.adapter.seatsForWorkflow(INSPECT_WORKFLOW), workerSeat);
    } catch (err) {
      this.deps.log(`[inspect] ${runId}#${ord}: no roster (${err instanceof Error ? err.message : String(err)})`);
    }
    if (seat === null) {
      this.finishWithReading(rec, 'No signed-in seat other than the step\'s own could check it, so this is crew\'s own reading of its record.');
      return rec;
    }
    rec.seat = String(seat['key']);
    // Armed BEFORE the launch, under the id the run will have (xreview on #1233): a frame of the check run that
    // arrives while the launch is still answering is this record's, and its clock runs from the ask.
    const checkRunId = this.deps.newId();
    rec.checkRunId = checkRunId;
    const timer = setTimeout(() => void this.expire(checkRunId), this.deps.timeoutMs ?? INSPECT_TIMEOUT_MS);
    timer.unref?.();
    this.pending.set(checkRunId, { runId, id: rec.id, timer, finalizing: false });
    this.save(rec);
    const input: LaunchRunInput = {
      problem: inspectBrief(view, ord, reading, timeline(events, ord)),
      sessionId: checkRunId,
      clisJson: JSON.stringify([seat]),
      workflow: INSPECT_WORKFLOW,
    };
    try {
      const launched = await this.deps.adapter.launchRun(input);
      if (launched !== checkRunId) this.deps.log(`[inspect] ${runId}#${ord}: the engine named the check run ${launched}, not ${checkRunId}`);
    } catch (err) {
      const p = this.pending.get(checkRunId);
      if (p !== undefined && !p.finalizing) {
        this.pending.delete(checkRunId);
        if (p.timer !== null) clearTimeout(p.timer);
        const cur = this.recordOf(runId, rec.id) ?? rec;
        cur.checkRunId = null;
        if (cur.state === 'checking') this.finishWithReading(cur, `The check could not start on ${rec.seat} (${err instanceof Error ? err.message : String(err)}), so this is crew's own reading.`);
      }
      return this.recordOf(runId, rec.id) ?? rec;
    }
    this.deps.launched?.(checkRunId, runId);
    this.deps.log(`[inspect] ${runId}#${ord} → ${INSPECT_WORKFLOW} ${checkRunId} on ${rec.seat}`);
    return this.recordOf(runId, rec.id) ?? rec;
  }

  private finishWithReading(rec: InspectionRecord, why: string): void {
    const r = rec.reading;
    Object.assign(rec, {
      state: 'done', finishedAt: this.now(), source: 'crew', why, verdict: r.verdict, doing: r.doing, progress: null,
      evidence: r.evidence, action: r.action, note: r.note,
    } satisfies Partial<InspectionRecord>);
    this.save(rec);
  }

  private recordOf(runId: string, id: string): InspectionRecord | null {
    return this.list(runId).find((r) => r.id === id) ?? null;
  }

  /** Take the check over for its ending: `null` when another path already ends it. It stays owned (so `settle` never
   *  reads it as orphaned) until {@link release}. */
  private claim(checkRunId: string): { runId: string; id: string } | null {
    const p = this.pending.get(checkRunId);
    if (p === undefined || p.finalizing) return null;
    p.finalizing = true;
    if (p.timer !== null) clearTimeout(p.timer);
    return { runId: p.runId, id: p.id };
  }

  private release(checkRunId: string): void {
    this.pending.delete(checkRunId);
  }

  /** Stop the check run (crew's own run, never the step's) and answer with crew's reading. */
  private async stopCheck(checkRunId: string, why: string): Promise<void> {
    const p = this.claim(checkRunId);
    if (p === null) return;
    try {
      try {
        await this.deps.adapter.cancelRun(checkRunId);
      } catch (err) {
        this.deps.log(`[inspect] could not stop check run ${checkRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const rec = this.recordOf(p.runId, p.id);
      if (rec !== null && rec.state === 'checking') this.finishWithReading(rec, why);
    } finally {
      this.release(checkRunId);
    }
  }

  private expire(checkRunId: string): Promise<void> {
    const mins = Math.round((this.deps.timeoutMs ?? INSPECT_TIMEOUT_MS) / 60_000);
    return this.stopCheck(checkRunId, `The check took longer than ${mins} min, so crew stopped it; this is crew's own reading.`);
  }

  /** Every `/ws` frame: the check run's usage (its budget) and end. */
  onEvent(event: Record<string, unknown>): void {
    const session = event['session'];
    if (typeof session !== 'string') return;
    const p = this.pending.get(session);
    if (p === undefined) return;
    const type = event['type'];
    if (type === 'usageProgress' || type === 'cliUsage') {
      const rec = this.recordOf(p.runId, p.id);
      if (rec === null || rec.state !== 'checking') return;
      const i = typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
      const o = typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
      const c = typeof event['costUsd'] === 'number' ? event['costUsd'] : null;
      rec.cost = { inputTokens: i, outputTokens: o, costUsd: c };
      this.save(rec);
      if (p.finalizing) return;
      const maxUsd = this.deps.maxCostUsd ?? INSPECT_MAX_COST_USD;
      const maxTok = this.deps.maxTokens ?? INSPECT_MAX_TOKENS;
      if ((c !== null && c > maxUsd) || i + o > maxTok) {
        void this.stopCheck(session, `The check reached its budget (${c !== null && c > maxUsd ? `$${maxUsd.toFixed(2)}` : `${Math.round(maxTok / 1000)}k tokens`}), so crew stopped it; this is crew's own reading.`);
      }
      return;
    }
    if (type === 'awaitingHuman') {
      void this.stopCheck(session, 'The check stopped to ask a question, which it may not; this is crew\'s own reading.');
      return;
    }
    if (typeof type === 'string' && END_EVENTS.has(type)) void this.finish(session, type);
  }

  private async finish(checkRunId: string, how: string): Promise<void> {
    const p = this.claim(checkRunId);
    if (p === null) return;
    try {
      let reply: string | null = null;
      try {
        reply = await this.deps.replyOf(checkRunId);
      } catch (err) {
        this.deps.log(`[inspect] reading check run ${checkRunId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Read the record AFTER the await: a usage frame may have moved its cost meanwhile.
      const rec = this.recordOf(p.runId, p.id);
      if (rec === null || rec.state !== 'checking') return;
      const answer = how === 'sessionCompleted' ? parseInspectReply(reply) : null;
      if (answer === null) {
        this.finishWithReading(rec, how === 'sessionCompleted'
          ? `${rec.seat ?? 'The seat'}'s answer could not be read, so this is crew's own reading.`
          : `The check on ${rec.seat ?? 'its seat'} did not finish, so this is crew's own reading.`);
        return;
      }
      Object.assign(rec, { ...answer, state: 'done', finishedAt: this.now(), source: 'seat', why: null } satisfies Partial<InspectionRecord>);
      this.save(rec);
    } finally {
      this.release(checkRunId);
    }
  }
}

/**
 * Where the records live: `WICKED_CREW_INSPECTIONS_DIR`, else `~/.wicked/inspections` — beside run learnings, NOT in the
 * daemon state home: core refuses every launch whose state home holds a top-level entry its fence registry
 * (tests/fixtures/state-home-subtrees.json, embedded in core) does not classify, so a new entry there needs a core
 * release first. Records are keyed by run id (unique), so two daemons sharing the directory never collide.
 */
export function defaultInspectionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_INSPECTIONS_DIR'] ?? join(homedir(), '.wicked', 'inspections');
}

/** The `inspect-unit` workflow def (data), as registered with the engine. */
export function loadInspectWorkflow(file = INSPECT_WORKFLOW_FILE): WorkflowDef {
  const def = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete def['$comment'];
  return def as unknown as WorkflowDef;
}
