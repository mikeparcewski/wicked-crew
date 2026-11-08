/** A job's source pick narrows the live gate switches; an absent pick and an empty pick are different. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DataGate } from '../knowledge/gate/gate.js';
import { MCP_SERVER_NAME_RE } from '../mcp/classify.js';

export const RUN_SOURCES_MAX = 20;

export interface PickableSource {
  /** The registered source name carried by `mcp:<name>/<tool>`, not the registry UUID. */
  id: string;
  label: string;
  /** The web source, regardless of its registered name. */
  web?: true;
  /** Present when this choice cannot be picked now. */
  reason?: string;
}

export interface RunSourcesDeps {
  /** Read visible choices and their current query switches and availability; the gate identifies web. */
  sources(projectId: string | null): Promise<Array<{ id: string; reason?: string; web?: true }>>;
}

export function runSourcesDeps(gate: Pick<DataGate, 'pickable'>): RunSourcesDeps {
  return { sources: (projectId) => gate.pickable(projectId) };
}

export async function projectSources(projectId: string | null, deps: RunSourcesDeps): Promise<PickableSource[]> {
  return (await deps.sources(projectId))
    .slice()
    .sort((a, b) => Number(b.web === true) - Number(a.web === true) || a.id.localeCompare(b.id))
    .map((s) => ({ id: s.id, label: s.web === true ? 'the web' : s.id, ...(s.web === true ? { web: true as const } : {}), ...(s.reason !== undefined ? { reason: s.reason } : {}) }));
}

/**
 * (e2e-1105 CJ3) Why the web can't be read in `projectId` when it is installed but set up for other projects only:
 * "the web source is set up for project X only" (names when known, else ids). `undefined` when that is not the cause.
 */
export async function webScopeReason(
  projectId: string | null,
  deps: { scopedElsewhere(projectId: string | null): Promise<string[] | null>; projectName?(projectId: string): Promise<string | null> },
): Promise<string | undefined> {
  const ids = await deps.scopedElsewhere(projectId);
  if (ids === null) return undefined;
  if (ids.length === 0) return 'the web source is not set up for any project: choose its projects in Settings → Sources';
  const names = await Promise.all(ids.map(async (id) => (await deps.projectName?.(id).catch(() => null)) ?? id));
  if (names.length === 1) return `the web source is set up for project ${names[0]} only`;
  return `the web source is set up for projects ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} only`;
}

export async function checkSourcePick(
  projectId: string | null,
  ids: readonly string[],
  deps: RunSourcesDeps,
): Promise<{ ok: true; ids: string[] } | { ok: false; refused: Array<{ id: string; reason: string }> }> {
  const distinct = [...new Set(ids)];
  if (distinct.length > RUN_SOURCES_MAX) return { ok: false, refused: distinct.map((id) => ({ id, reason: `pick at most ${RUN_SOURCES_MAX} sources` })) };
  if (distinct.length === 0) return { ok: true, ids: [] };
  const choices = new Map((await projectSources(projectId, deps)).map((s) => [s.id, s]));
  const refused: Array<{ id: string; reason: string }> = [];
  for (const id of distinct) {
    const source = choices.get(id);
    const reason = source === undefined ? 'no source of that name in this project' : source.reason;
    if (reason !== undefined) refused.push({ id, reason });
  }
  return refused.length > 0 ? { ok: false, refused } : { ok: true, ids: distinct };
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
interface StoredPick { ids: string[]; at: number }

function validIds(ids: unknown): ids is string[] {
  return Array.isArray(ids) && new Set(ids).size <= RUN_SOURCES_MAX && ids.every((id) => typeof id === 'string' && MCP_SERVER_NAME_RE.test(id));
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Loaded once for cheap broker reads. A damaged file throws: forgetting a pick would widen a run's access.
 * The daemon owns this store; recorded picks are immutable. New picks replace the whole file before changing the cache.
 */
export class RunSourcePicks {
  private readonly runs = new Map<string, StoredPick>();

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('corrupt run source picks');
    }
    if (!object(value) || value['version'] !== 1 || !object(value['runs'])) throw new Error('corrupt run source picks');
    for (const [runId, pick] of Object.entries(value['runs'])) {
      if (!RUN_ID_RE.test(runId) || !object(pick) || !validIds(pick['ids']) || new Set(pick['ids']).size !== pick['ids'].length || typeof pick['at'] !== 'number' || !Number.isSafeInteger(pick['at']) || pick['at'] < 0) {
        throw new Error('corrupt run source picks');
      }
      this.runs.set(runId, { ids: [...pick['ids']], at: pick['at'] });
    }
  }

  get(runId: string): string[] | null {
    const pick = this.runs.get(runId);
    // Callers must not be able to widen the cached pick by mutating its array.
    return pick === undefined ? null : [...pick.ids];
  }

  set(runId: string, ids: readonly string[]): void {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Error('invalid run id');
    if (!validIds(ids)) throw new Error(`pick at most ${RUN_SOURCES_MAX} registered source names`);
    const distinct = [...new Set(ids)];
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      if (existing.ids.length === distinct.length && distinct.every((id) => existing.ids.includes(id))) return;
      throw new Error("a run's source pick can't change");
    }
    const pick = { ids: distinct, at: Date.now() };
    const next = new Map(this.runs).set(runId, pick);
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, runs: Object.fromEntries(next) }), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(tmp, this.file);
      this.runs.set(runId, pick);
      // The rename has committed. A directory-sync failure must not report the replaced pick as unwritten.
      try {
        const fd = openSync(dir, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        console.warn('run source picks: directory sync failed after replacement');
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
