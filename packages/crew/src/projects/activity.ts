/**
 * The project activity feed (DES-PROJECT-001 §5.2) — a READ-SIDE MERGE, not a new store.
 *
 * Two sources, one normalized shape:
 * - CREW: the durable core-event log of the project's `crew.run`/`crew.chat` members
 *   (`adapter.runEvents` — the same log `/runs/:id/events` serves), entry id `crew:<run>:<seq>`.
 * - INTERACTIVE: `wicked.interactive.*` bus events carrying this `project_id`, read directly
 *   from the bus SQLite READ-ONLY through the SAME SQLite library wicked-bus itself uses
 *   (better-sqlite3, resolved from wicked-bus's own location — wicked-bus exposes
 *   subscribe-cursors, not ad-hoc history queries, and a durable cursor per feed-read would turn
 *   a GET into a write), entry id `bus:<event_id>`.
 *
 * WHY NOT `node:sqlite` (F-E2E-021): this daemon already holds long-lived better-sqlite3
 * connections on the very same bus.db (the interactive seams, the /ws relay, the project bridge).
 * SQLite's file locks are POSIX advisory locks, which the kernel releases for the WHOLE process the
 * moment ANY descriptor for that file is closed. One SQLite library instance protects itself (it
 * defers the close while sibling connections hold locks); a SECOND library instance in the same
 * process — Node's bundled SQLite behind `node:sqlite` — knows nothing about the first, so its
 * `close()` here silently released every lock the seams held on bus.db and bus.db-shm. The next
 * short-lived external emitter (`wicked-bus emit`, what wicked-estate spawns after an index) then
 * won the EXCLUSIVE lock on its own close, checkpointed and UNLINKED bus.db-wal/-shm under the
 * seams, whose reads decayed into "database disk image is malformed" on every poll for the life
 * of the daemon. Rule: ONE SQLite library per database file per process — this read goes through
 * wicked-bus's better-sqlite3, and (DES-TEAMING-002 T0) through the daemon's ONE long-lived crew bus
 * handle (`core/bus-handle.ts`): the engine's rusqlite now shares this file too, and a per-request
 * close would release ITS locks exactly as `node:sqlite`'s did the seams'.
 *
 * Newest-first, cursor on `(ts, id)` — an opaque `<ts>:<id>` token, base64url. The merge is
 * recomputed per read; members are few and the log excludes high-volume frames, so the simple
 * full-merge is the honest v1 (the ADR explicitly rejects a new store here).
 */

import { crewBusHandle } from '../core/bus-handle.js';
import type { CoreAdapter } from '../core/adapter.js';
import type { ActivityEntry } from '../core/types.js';

/** One-line human summary of a core frame (best-effort; `raw` carries the whole frame). */
function summarizeCoreEvent(frame: Record<string, unknown>, runId: string): string {
  const type = typeof frame['type'] === 'string' ? (frame['type'] as string) : 'event';
  switch (type) {
    case 'sessionStarted':
      return `run ${runId} started`;
    case 'awaitingHuman':
      return `run ${runId} paused at a human gate${
        typeof frame['prompt'] === 'string' ? `: ${(frame['prompt'] as string).slice(0, 120)}` : ''
      }`;
    case 'resumed':
      return `run ${runId} resumed`;
    case 'sessionCompleted':
      return `run ${runId} completed`;
    case 'sessionFailed':
      return `run ${runId} failed`;
    case 'runCancelled':
      return `run ${runId} cancelled`;
    case 'gateDecided':
      return `run ${runId}: gate decided (${String(frame['allow'] ?? '?')})`;
    default:
      return `run ${runId}: ${type}`;
  }
}

function summarizeInteractive(eventType: string, payload: Record<string, unknown> | null): string {
  const doc = payload !== null && typeof payload['document_id'] === 'string' ? (payload['document_id'] as string) : '?';
  const short = eventType.replace(/^wicked\.interactive\./, '');
  return `doc ${doc}: ${short}`;
}

/** Opaque cursor: base64url of `<ts>:<id>`. */
export function encodeCursor(ts: number, id: string): string {
  return Buffer.from(`${ts}:${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf(':');
    if (sep < 1) return null;
    const ts = Number(raw.slice(0, sep));
    if (!Number.isFinite(ts)) return null;
    return { ts, id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

/** Newest-first ordering on `(ts, id)` — the cursor's total order. */
function newerFirst(a: ActivityEntry, b: ActivityEntry): number {
  return b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Strictly older than the cursor position (the page the caller has not seen). */
function olderThan(entry: ActivityEntry, cur: { ts: number; id: string }): boolean {
  return entry.ts < cur.ts || (entry.ts === cur.ts && entry.id < cur.id);
}

/** The crew half: fold each member run/chat's durable log into entries. */
async function crewEntries(adapter: CoreAdapter, refs: string[]): Promise<ActivityEntry[]> {
  const entries: ActivityEntry[] = [];
  for (const ref of refs) {
    const events = await adapter.runEvents(ref);
    if (events === null) break; // no event-log binding on this addon — the crew half is empty
    for (const event of events) {
      const frame = event as unknown as Record<string, unknown>;
      const ts = typeof frame['ts'] === 'number' ? (frame['ts'] as number) : 0;
      const seq = typeof frame['seq'] === 'number' ? (frame['seq'] as number) : 0;
      entries.push({
        id: `crew:${ref}:${seq}`,
        ts,
        source: 'crew',
        kind: typeof frame['type'] === 'string' ? (frame['type'] as string) : 'event',
        ref,
        summary: summarizeCoreEvent(frame, ref),
        raw: event,
      });
    }
  }
  return entries;
}

/** The interactive half: bus events carrying this `project_id`, read-only. */
async function interactiveEntries(
  busDbPath: string | null,
  projectId: string,
): Promise<ActivityEntry[]> {
  if (busDbPath === null) return [];
  const entries: ActivityEntry[] = [];
  try {
    // The daemon's ONE long-lived crew handle on the bus (core/bus-handle.ts) — never a
    // per-request open/close, which would release the locks the engine's connection holds.
    const db = crewBusHandle(busDbPath, { create: false });
    const rows = db
      .prepare(
        `SELECT event_id, event_type, payload, emitted_at FROM events
         WHERE event_type LIKE 'wicked.interactive.%'
           AND json_extract(payload, '$.project_id') = ?
         ORDER BY emitted_at DESC LIMIT 1000`,
      )
      .all(projectId) as { event_id: number; event_type: string; payload: string; emitted_at: number }[];
    for (const row of rows) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        /* raw stays the string */
      }
      entries.push({
        id: `bus:${row.event_id}`,
        ts: row.emitted_at,
        source: 'interactive',
        kind: row.event_type,
        ref:
          payload !== null && typeof payload['document_id'] === 'string'
            ? (payload['document_id'] as string)
            : '',
        summary: summarizeInteractive(row.event_type, payload),
        raw: { event_type: row.event_type, payload: payload ?? row.payload, emitted_at: row.emitted_at },
      });
    }
  } catch {
    // No bus db / schema mismatch — the interactive half is empty, never an error:
    // a project with no bound docs must not 500 its activity feed.
    return entries;
  }
  return entries;
}

/** Build one page of the merged feed. `refs` = the project's run/chat member refs. */
export async function buildActivityPage(
  adapter: CoreAdapter,
  projectId: string,
  refs: string[],
  busDbPath: string | null,
  cursor: string | undefined,
  limit: number,
): Promise<{ entries: ActivityEntry[]; nextCursor: string | null }> {
  const merged = [...(await crewEntries(adapter, refs)), ...(await interactiveEntries(busDbPath, projectId))];
  merged.sort(newerFirst);

  let page = merged;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded !== null) page = merged.filter((e) => olderThan(e, decoded));
  }
  const entries = page.slice(0, limit);
  const last = entries[entries.length - 1];
  const nextCursor =
    entries.length === limit && page.length > limit && last !== undefined
      ? encodeCursor(last.ts, last.id)
      : null;
  return { entries, nextCursor };
}
