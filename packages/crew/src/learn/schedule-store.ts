/**
 * The learn schedule (DES-learn-workflow §5): a durable record per learned topic saying how often
 * the daemon re-runs the `learn` workflow on it. Crew is the single source of truth for a
 * schedule; the topic's files in the repository do not repeat it.
 *
 * Same storage posture as `projects/settings.ts`: a small JSON map in the daemon's state home
 * (`learn-schedules.json`, following `--db`; `WICKED_CREW_LEARN_SCHEDULES` overrides), written
 * atomically (tmp + rename), read tolerantly per row (a malformed row is dropped, never the map).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LearnSchedule, LearnScheduleOutcome } from 'wicked-crew-api-types';
import { crewStateHome } from '../projects/state-home.js';

export type { LearnSchedule, LearnScheduleOutcome };

export const LEARN_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MIN_EVERY_HOURS = 24;
export const MAX_EVERY_HOURS = 2160;
const HOUR_MS = 3_600_000;
const OUTCOMES: ReadonlySet<string> = new Set(['launched', 'refused', 'completed', 'failed', 'cancelled']);

export function scheduleId(repoRef: string, slug: string): string {
  return `${repoRef}:${slug}`;
}

export function defaultSchedulesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_LEARN_SCHEDULES'] ?? join(crewStateHome(), 'learn-schedules.json');
}

const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** A row as read from disk, or `null` when it is malformed. */
function parseRow(id: string, raw: unknown): LearnSchedule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!str(r['repoRef']) || !str(r['slug']) || !LEARN_SLUG.test(r['slug']) || !str(r['topic'])) return null;
  if (id !== scheduleId(r['repoRef'], r['slug'])) return null;
  const every = r['everyHours'];
  if (typeof every !== 'number' || !Number.isInteger(every) || every < MIN_EVERY_HOURS || every > MAX_EVERY_HOURS) return null;
  if (typeof r['enabled'] !== 'boolean' || !str(r['nextDueAt']) || Number.isNaN(Date.parse(r['nextDueAt']))) return null;
  const outcome = r['lastOutcome'];
  return {
    id,
    repoRef: r['repoRef'],
    slug: r['slug'],
    topic: r['topic'],
    ...(str(r['projectId']) ? { projectId: r['projectId'] } : {}),
    everyHours: every,
    enabled: r['enabled'],
    nextDueAt: r['nextDueAt'],
    lastRunId: strOrNull(r['lastRunId']) ? r['lastRunId'] : null,
    lastRunAt: strOrNull(r['lastRunAt']) ? r['lastRunAt'] : null,
    lastOutcome: str(outcome) && OUTCOMES.has(outcome) ? (outcome as LearnScheduleOutcome) : null,
    failures: typeof r['failures'] === 'number' && r['failures'] >= 0 ? Math.floor(r['failures']) : 0,
    lastError: strOrNull(r['lastError']) ? r['lastError'] : null,
    indexedTree: strOrNull(r['indexedTree']) ? r['indexedTree'] : null,
    createdAt: str(r['createdAt']) ? r['createdAt'] : r['nextDueAt'],
    updatedAt: str(r['updatedAt']) ? r['updatedAt'] : r['nextDueAt'],
  };
}

/** What a caller asks to save (`PUT /learn/schedules/:id`). */
export interface LearnScheduleInput {
  repoRef: string;
  slug: string;
  topic: string;
  everyHours: number;
  enabled?: boolean | undefined;
  projectId?: string | undefined;
}

export class LearnScheduleStore {
  private readonly path: string;
  private readonly rows = new Map<string, LearnSchedule>();

  constructor(path?: string) {
    this.path = path ?? defaultSchedulesPath();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { schedules?: Record<string, unknown> };
      for (const [id, raw] of Object.entries(parsed?.schedules ?? {})) {
        const row = parseRow(id, raw);
        if (row !== null) this.rows.set(id, row);
      }
    } catch {
      // Missing or malformed: start empty (no schedule fires), never fail the boot.
    }
  }

  list(): LearnSchedule[] {
    return [...this.rows.values()].sort((a, b) => a.nextDueAt.localeCompare(b.nextDueAt) || a.id.localeCompare(b.id));
  }

  get(id: string): LearnSchedule | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : { ...row };
  }

  /** Create or update. A new row is first due one interval from now; an update keeps its run
   *  history and moves `nextDueAt` only when the interval changed. */
  put(input: LearnScheduleInput, now: Date): LearnSchedule {
    const id = scheduleId(input.repoRef, input.slug);
    const prev = this.rows.get(id);
    const iso = now.toISOString();
    const due = new Date(now.getTime() + input.everyHours * HOUR_MS).toISOString();
    const row: LearnSchedule = {
      id,
      repoRef: input.repoRef,
      slug: input.slug,
      topic: input.topic,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      everyHours: input.everyHours,
      enabled: input.enabled ?? prev?.enabled ?? true,
      nextDueAt: prev === undefined || prev.everyHours !== input.everyHours ? due : prev.nextDueAt,
      lastRunId: prev?.lastRunId ?? null,
      lastRunAt: prev?.lastRunAt ?? null,
      lastOutcome: prev?.lastOutcome ?? null,
      failures: prev?.failures ?? 0,
      lastError: prev?.lastError ?? null,
      indexedTree: prev?.indexedTree ?? null,
      createdAt: prev?.createdAt ?? iso,
      updatedAt: iso,
    };
    this.rows.set(id, row);
    this.persist();
    return { ...row };
  }

  /** Merge a patch into an existing row (the scheduler's bookkeeping). `undefined` when unknown. */
  update(id: string, patch: Partial<Omit<LearnSchedule, 'id' | 'repoRef' | 'slug'>>, now: Date): LearnSchedule | undefined {
    const prev = this.rows.get(id);
    if (prev === undefined) return undefined;
    const row: LearnSchedule = { ...prev, ...patch, updatedAt: now.toISOString() };
    this.rows.set(id, row);
    this.persist();
    return { ...row };
  }

  delete(id: string): boolean {
    const had = this.rows.delete(id);
    if (had) this.persist();
    return had;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ schedules: Object.fromEntries(this.rows) }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}

export const HOURS = HOUR_MS;
