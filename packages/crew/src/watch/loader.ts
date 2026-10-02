/**
 * The entry loader (DES-TRIGGER-REGISTRY-001 §4.2).
 *
 * One file per entry, `packages/crew/watch/entries/<id>.json`, versioned with crew. A violating
 * entry is REFUSED with a reason (listed in `GET /watch/health`) and every other entry still loads:
 * one bad file cannot turn watching off. Refused when:
 *   - the JSON does not parse, or its id is not `[a-z0-9-]{3,48}` or differs from the file name;
 *   - it names a check the check map does not have, or its params / threshold fail the check's schema;
 *   - `emit.as` is anything but finding | flag | proposal (no allow-like value exists in the schema);
 *   - a bus source names a type that is not a 4-segment `wicked.<domain>.<noun>.<verb>`.
 *
 * The operator may change only `enabled` and `threshold` of a shipped entry (settings `watch.entries`),
 * applied by {@link applyOverrides}; an override whose threshold fails the check's schema is ignored
 * and reported, never half-applied.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { WatchSettings } from 'wicked-crew-api-types';
import type { LoadedEntry, WatchCheck } from './types.js';

/** The shipped entries directory: `packages/crew/watch/entries` (same depth from `src/` and `dist/`). */
export const SHIPPED_ENTRIES_DIR = fileURLToPath(new URL('../../watch/entries', import.meta.url));

const ID = /^[a-z0-9-]{3,48}$/;
const BUS_TYPE = /^wicked\.[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/;

const EntrySchema = z
  .object({
    id: z.string().regex(ID, 'id must be [a-z0-9-]{3,48}'),
    version: z.number().int().min(1),
    on: z.object({ source: z.enum(['core', 'bus', 'watchdog', 'internal']), type: z.string().min(1).max(128) }).strict(),
    filter: z.record(z.unknown()).default({}),
    check: z.string().min(1),
    params: z.record(z.unknown()).default({}),
    threshold: z.record(z.unknown()).default({}),
    emit: z
      .object({
        as: z.enum(['finding', 'flag', 'proposal']),
        severity: z.enum(['high', 'medium', 'info']),
        watch_kind: z.enum(['problem', 'decision', 'done', 'quiet', 'delivery']),
        attach: z.enum(['gate']).nullable().default(null),
        rate: z.object({ per_run: z.number().int().min(1).max(1_000) }).strict(),
      })
      .strict(),
    priority: z.enum(['p0', 'p1', 'p2']),
    enabled: z.boolean(),
  })
  .strict();

export interface Refusal {
  id: string;
  reason: string;
}

export interface LoadResult {
  entries: LoadedEntry[];
  refused: Refusal[];
}

function zodReason(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(entry)'}: ${i.message}`).join('; ');
}

/** Validate one parsed entry against the schema and the check map. */
export function validateEntry(raw: unknown, fileId: string, checks: ReadonlyMap<string, WatchCheck>): LoadedEntry | Refusal {
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success) return { id: fileId, reason: zodReason(parsed.error) };
  const e = parsed.data;
  if (e.id !== fileId) return { id: fileId, reason: `id "${e.id}" differs from the file name "${fileId}.json"` };
  if (e.on.source === 'bus' && !BUS_TYPE.test(e.on.type)) {
    return { id: e.id, reason: `bus type "${e.on.type}" is not a 4-segment wicked.<domain>.<noun>.<verb> type` };
  }
  const check = checks.get(e.check);
  if (check === undefined) return { id: e.id, reason: `unknown check "${e.check}"` };
  const params = check.paramsSchema.safeParse(e.params);
  if (!params.success) return { id: e.id, reason: `params: ${zodReason(params.error)}` };
  const threshold = check.thresholdSchema.safeParse(e.threshold);
  if (!threshold.success) return { id: e.id, reason: `threshold: ${zodReason(threshold.error)}` };
  return {
    ...e,
    params: params.data as Record<string, unknown>,
    threshold: threshold.data as Record<string, unknown>,
  };
}

/** Load every `<id>.json` in `dir`. A missing directory loads nothing and says so. */
export function loadEntries(dir: string, checks: ReadonlyMap<string, WatchCheck>): LoadResult {
  const entries: LoadedEntry[] = [];
  const refused: Refusal[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    return { entries, refused: [{ id: '(entries)', reason: `cannot read ${basename(dir)}: ${(err as Error).message}` }] };
  }
  for (const name of names) {
    const fileId = name.slice(0, -'.json'.length);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (err) {
      refused.push({ id: fileId, reason: `not JSON: ${(err as Error).message}` });
      continue;
    }
    const out = validateEntry(raw, fileId, checks);
    if ('reason' in out) refused.push(out);
    else entries.push(out);
  }
  return { entries, refused };
}

/** Why a settings override was not applied (reported in health, never half-applied). */
export interface OverrideProblem {
  id: string;
  reason: string;
}

/** The effective entries: the operator's `enabled` / `threshold` overrides on the shipped ones. */
export function applyOverrides(
  entries: readonly LoadedEntry[],
  settings: WatchSettings | undefined,
  checks: ReadonlyMap<string, WatchCheck>,
): { entries: LoadedEntry[]; problems: OverrideProblem[] } {
  const problems: OverrideProblem[] = [];
  const out = entries.map((e) => {
    const o = settings?.entries?.[e.id];
    if (o === undefined) return e;
    let next: LoadedEntry = e;
    // Validated FIRST: a bad threshold leaves the whole override unapplied (enabled included).
    if (o.threshold !== undefined) {
      const parsed = checks.get(e.check)?.thresholdSchema.safeParse({ ...e.threshold, ...o.threshold });
      if (parsed?.success !== true) {
        problems.push({ id: e.id, reason: `threshold override ignored: ${parsed ? zodReason(parsed.error) : 'no check'}` });
        return e;
      }
      next = { ...next, threshold: parsed.data as Record<string, unknown> };
    }
    if (typeof o.enabled === 'boolean') next = { ...next, enabled: o.enabled };
    return next;
  });
  return { entries: out, problems };
}

/**
 * Validate a `PUT /settings` `watch` patch against the loaded entries. Returns the error text for a
 * 400, or `null`. Only `enabled` and `threshold` of a KNOWN entry, and the boolean `llm`.
 */
export function validateWatchPatch(
  patch: unknown,
  entries: readonly LoadedEntry[],
  checks: ReadonlyMap<string, WatchCheck>,
): string | null {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return 'watch must be an object';
  for (const key of Object.keys(patch)) {
    if (key !== 'entries' && key !== 'llm') return `watch.${key} is not a setting (only watch.entries and watch.llm)`;
  }
  const p = patch as { entries?: unknown; llm?: unknown };
  if (p.llm !== undefined && typeof p.llm !== 'boolean') return 'watch.llm must be a boolean';
  if (p.entries === undefined) return null;
  if (typeof p.entries !== 'object' || p.entries === null || Array.isArray(p.entries)) return 'watch.entries must be an object keyed by entry id';
  for (const [id, raw] of Object.entries(p.entries)) {
    const entry = entries.find((e) => e.id === id);
    if (entry === undefined) return `watch.entries.${id}: no such entry`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `watch.entries.${id} must be an object`;
    for (const k of Object.keys(raw)) {
      if (k !== 'enabled' && k !== 'threshold') return `watch.entries.${id}.${k} cannot be changed (only enabled and threshold)`;
    }
    const o = raw as { enabled?: unknown; threshold?: unknown };
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean') return `watch.entries.${id}.enabled must be a boolean`;
    if (o.threshold !== undefined) {
      if (typeof o.threshold !== 'object' || o.threshold === null || Array.isArray(o.threshold)) {
        return `watch.entries.${id}.threshold must be an object`;
      }
      const parsed = checks.get(entry.check)?.thresholdSchema.safeParse({ ...entry.threshold, ...o.threshold });
      if (parsed === undefined || !parsed.success) {
        return `watch.entries.${id}.threshold: ${parsed ? zodReason(parsed.error) : 'no check'}`;
      }
    }
  }
  return null;
}
