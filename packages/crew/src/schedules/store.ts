/**
 * Workflow schedules (DES-RUNS-REVIEW-001 §2): a durable record per scheduled workflow saying how often the daemon
 * runs it. Generic: any workflow by id. The default entries are `review-recent-work` and `run-evals`, every 48 h.
 *
 * Same posture as the learn schedules (`src/learn/schedule-store.ts`): one JSON map in the state home
 * (`daemon-schedules.json`, the `daemon-` prefix the state-home fence already classifies;
 * `WICKED_CREW_SCHEDULES` overrides), written atomically (tmp + rename), read tolerantly per row.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crewStateHome } from '../projects/state-home.js';
import { DOMAIN_EXTRACTION_WORKFLOW } from '../api/domain-model.js';

/**
 * (J6 K1 F4, M1) Why a workflow can never run on a schedule, or `null`. A domain model maps what a person says it
 * should cover, after they see its scope; a schedule has no one to say it. Saving one is refused (routes.ts); one saved
 * before that refusal existed is listed as skipped with these words and never fires (coord W2, 2026-11-25).
 */
export function notSchedulable(workflow: string): string | null {
  return workflow === DOMAIN_EXTRACTION_WORKFLOW
    ? "a domain model run covers what a person says it should and is started by them (a repository's Requirements: Map the domain); it cannot run on a schedule"
    : null;
}

export const SCHEDULES_FILENAME = 'daemon-schedules.json';
export const MIN_EVERY_HOURS = 24;
export const MAX_EVERY_HOURS = 2160;
export const HOUR_MS = 3_600_000;
export const SCHEDULE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const DEFAULT_REVIEW_SCHEDULE_ID = 'review-recent-work';
/** The default evals' schedule (DES-DEFAULT-EVALS-001 §7). */
export const DEFAULT_EVALS_SCHEDULE_ID = 'run-evals';
export const DEFAULT_REVIEW_EVERY_HOURS = 48;

/** `launching` = the run id is reserved and the engine is being asked (it survives a restart in that window). */
export type ScheduleOutcome = 'launching' | 'launched' | 'refused' | 'completed' | 'failed' | 'cancelled' | 'skipped';
const OUTCOMES: ReadonlySet<string> = new Set(['launching', 'launched', 'refused', 'completed', 'failed', 'cancelled', 'skipped']);

export interface WorkflowSchedule {
  id: string;
  workflow: string;
  everyHours: number;
  enabled: boolean;
  /** Projects the run covers (a review reads only their runs); empty = all. */
  projectIds: string[];
  repoRef: string | null;
  /** The intent the launch carries; `null` = the workflow's own default. */
  problem: string | null;
  /** (crew#1837) The person accepted reduced assurance for this schedule: when every seat that could review the work
   *  ran some of it (a one-seat daemon), one of them reviews it, said in its brief and on the run. False until accepted. */
  reducedAssurance: boolean;
  nextDueAt: string;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastOutcome: ScheduleOutcome | null;
  /** Why the last attempt was skipped or refused, in plain words. */
  lastNote: string | null;
  /** (crew#1578) Set while the last run waits on a person and due times are skipped; null otherwise. */
  blocked: ScheduleBlocked | null;
  failures: number;
  createdAt: string;
  updatedAt: string;
}

/** (crew#1578) A schedule held by its last run waiting on a person: never cancelled for them, said plainly. */
export interface ScheduleBlocked {
  reason: 'awaiting_human';
  runId: string;
  /** ISO-8601: when the schedule first saw the run waiting (within one sweep of the gate's arrival). */
  since: string;
  /** Due times skipped while it waits (0 until one comes due). */
  missedDue: number;
  /** The gate to open: the run's page. */
  target: { kind: 'run'; runId: string };
  /** "blocked: the last run <id> is waiting for you since <time>; N due times skipped". */
  detail: string;
}

/** The row's one sentence for a blocked schedule (derived from the fields, never stored on its own). */
export function blockedDetail(runId: string, since: string, missedDue: number): string {
  return `blocked: the last run ${runId} is waiting for you since ${since}; ${missedDue} due time${missedDue === 1 ? '' : 's'} skipped`;
}

function parseBlocked(v: unknown): ScheduleBlocked | null {
  if (typeof v !== 'object' || v === null) return null;
  const b = v as Record<string, unknown>;
  if (b['reason'] !== 'awaiting_human' || !str(b['runId']) || !str(b['since']) || !Number.isFinite(Date.parse(b['since'])) || !str(b['detail'])) return null;
  const missed = b['missedDue'];
  if (typeof missed !== 'number' || !Number.isSafeInteger(missed) || missed < 0) return null;
  return { reason: 'awaiting_human', runId: b['runId'], since: b['since'], missedDue: missed, target: { kind: 'run', runId: b['runId'] }, detail: blockedDetail(b['runId'], b['since'], missed) };
}

export interface ScheduleInput {
  workflow: string;
  everyHours: number;
  enabled?: boolean | undefined;
  projectIds?: string[] | undefined;
  repoRef?: string | null | undefined;
  problem?: string | null | undefined;
  reducedAssurance?: boolean | undefined;
}

export function defaultSchedulesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_SCHEDULES'] ?? join(crewStateHome(), SCHEDULES_FILENAME);
}

const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const validEvery = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= MIN_EVERY_HOURS && v <= MAX_EVERY_HOURS;

function parseRow(id: string, raw: unknown): WorkflowSchedule | null {
  if (!SCHEDULE_ID.test(id) || typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!str(r['workflow']) || r['workflow'] === '' || !validEvery(r['everyHours']) || typeof r['enabled'] !== 'boolean') return null;
  if (!str(r['nextDueAt']) || Number.isNaN(Date.parse(r['nextDueAt']))) return null;
  const outcome = r['lastOutcome'];
  return {
    id,
    workflow: r['workflow'],
    everyHours: r['everyHours'],
    enabled: r['enabled'],
    projectIds: Array.isArray(r['projectIds']) ? r['projectIds'].filter(str) : [],
    repoRef: strOrNull(r['repoRef']),
    problem: strOrNull(r['problem']),
    reducedAssurance: r['reducedAssurance'] === true,
    nextDueAt: r['nextDueAt'],
    lastRunId: strOrNull(r['lastRunId']),
    lastRunAt: strOrNull(r['lastRunAt']),
    lastOutcome: str(outcome) && OUTCOMES.has(outcome) ? (outcome as ScheduleOutcome) : null,
    lastNote: strOrNull(r['lastNote']),
    blocked: parseBlocked(r['blocked']),
    failures: typeof r['failures'] === 'number' && r['failures'] >= 0 ? Math.floor(r['failures']) : 0,
    createdAt: str(r['createdAt']) ? r['createdAt'] : r['nextDueAt'],
    updatedAt: str(r['updatedAt']) ? r['updatedAt'] : r['nextDueAt'],
  };
}

export class ScheduleStore {
  private readonly path: string;
  private readonly rows = new Map<string, WorkflowSchedule>();
  /** Whether the file existed and parsed: the default entry is seeded once, onto a fresh store only. */
  readonly loaded: boolean;

  constructor(path?: string) {
    this.path = path ?? defaultSchedulesPath();
    let loaded = false;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { schedules?: Record<string, unknown> };
      for (const [id, raw] of Object.entries(parsed?.schedules ?? {})) {
        const row = parseRow(id, raw);
        if (row !== null) this.rows.set(id, row);
      }
      loaded = true;
    } catch {
      // Missing or malformed: start empty.
    }
    this.loaded = loaded;
  }

  /** Seed the defaults ("review recent work" and "run the default evals", every 2 days) once, on a store that has never been written. A person
   *  who deletes it later keeps it deleted. */
  seedDefault(now: Date): void {
    if (this.loaded || this.rows.size > 0) return;
    this.put(DEFAULT_REVIEW_SCHEDULE_ID, { workflow: 'review-recent-work', everyHours: DEFAULT_REVIEW_EVERY_HOURS, enabled: true }, now);
    // The default evals (DES-DEFAULT-EVALS-001 §7) on the same cadence. They come due at the same moment, and the
    // sweep launches one due row at a time in (due, id) order, so `review-recent-work` goes first.
    this.put(DEFAULT_EVALS_SCHEDULE_ID, { workflow: 'run-evals', everyHours: DEFAULT_REVIEW_EVERY_HOURS, enabled: true }, now);
  }

  list(): WorkflowSchedule[] {
    return [...this.rows.values()].sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt) || a.id.localeCompare(b.id));
  }

  get(id: string): WorkflowSchedule | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : { ...row, projectIds: [...row.projectIds] };
  }

  /** Create or update. A new row is first due one interval from now; an update keeps its history and moves
   *  `nextDueAt` only when the interval changed (then: one new interval from the last run, or from now). */
  put(id: string, input: ScheduleInput, now: Date): WorkflowSchedule {
    if (!SCHEDULE_ID.test(id)) throw new Error('a schedule id is kebab-case, at most 64 characters');
    if (!validEvery(input.everyHours)) throw new Error(`everyHours is a whole number from ${MIN_EVERY_HOURS} to ${MAX_EVERY_HOURS}`);
    const prev = this.rows.get(id);
    const iso = now.toISOString();
    const from = prev?.lastRunAt !== null && prev?.lastRunAt !== undefined ? Math.min(Date.parse(prev.lastRunAt), now.getTime()) : now.getTime();
    const due = new Date(from + input.everyHours * HOUR_MS).toISOString();
    const row: WorkflowSchedule = {
      id,
      workflow: input.workflow,
      everyHours: input.everyHours,
      enabled: input.enabled ?? prev?.enabled ?? true,
      projectIds: input.projectIds ?? prev?.projectIds ?? [],
      repoRef: input.repoRef !== undefined ? input.repoRef : (prev?.repoRef ?? null),
      problem: input.problem !== undefined ? input.problem : (prev?.problem ?? null),
      reducedAssurance: input.reducedAssurance ?? prev?.reducedAssurance ?? false,
      nextDueAt: prev === undefined || prev.everyHours !== input.everyHours ? due : prev.nextDueAt,
      lastRunId: prev?.lastRunId ?? null,
      lastRunAt: prev?.lastRunAt ?? null,
      lastOutcome: prev?.lastOutcome ?? null,
      lastNote: prev?.lastNote ?? null,
      blocked: prev?.blocked ?? null,
      failures: prev?.failures ?? 0,
      createdAt: prev?.createdAt ?? iso,
      updatedAt: iso,
    };
    this.commit(id, row, prev);
    return { ...row };
  }

  update(id: string, patch: Partial<Omit<WorkflowSchedule, 'id' | 'createdAt'>>, now: Date): WorkflowSchedule | undefined {
    const prev = this.rows.get(id);
    if (prev === undefined) return undefined;
    const row: WorkflowSchedule = { ...prev, ...patch, updatedAt: now.toISOString() };
    this.commit(id, row, prev);
    return { ...row };
  }

  delete(id: string): boolean {
    const had = this.rows.delete(id);
    if (had) this.persist();
    return had;
  }

  /** (crew#1837) Set the row and write the file; a write that fails puts the row back, so memory never holds what
   *  the file (and the audit trail, written after a save) does not. */
  private commit(id: string, row: WorkflowSchedule, prev: WorkflowSchedule | undefined): void {
    this.rows.set(id, row);
    try {
      this.persist();
    } catch (err) {
      if (prev === undefined) this.rows.delete(id);
      else this.rows.set(id, prev);
      throw err;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ schedules: Object.fromEntries(this.rows) }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
