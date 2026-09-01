/**
 * Durable handoff ledger shared by crew's wicked-interactive seams (task #86, Phase 7c).
 *
 * Extracted from the draft leg (draft-events.ts, PR #241) when the structural-edit leg arrived,
 * because both seams need the same replay-dedup discipline with DIFFERENT key grammars:
 *
 *  - the DRAFT leg keys by document id — one first draft per document lifetime;
 *  - the EDIT leg keys by `<doc>:v<version>` — one governed edit per HANDOFF, because the same
 *    document legitimately produces many structural handoffs over its life (versioned targeting).
 *
 * The ledger itself is key-agnostic: a durable map `key → HandoffLedgerEntry`, JSON on disk,
 * written atomically (tmp + rename). The bus cursor alone cannot carry this: at-least-once
 * delivery means the same trigger can arrive again after a crash between handling and cursor
 * advance, and in-memory state dies with the process. The ledger is the system of record for
 * "this handoff was answered"; each seam's in-flight map is just the live half.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/** One ledger row — the lifecycle of a handoff a seam answered. */
export interface HandoffLedgerEntry {
  runId: string;
  launchedAt: string;
  /** Set once the closing event (draft.completed / edit.completed) was emitted. */
  emittedAt?: string;
  /** Set when the governed run ended without a usable result; kept so a redelivered trigger
   *  does not silently relaunch a run an operator should look at first. */
  failedAt?: string;
}

/** Legacy on-disk row shape from the draft leg's first release (field was `draftEmittedAt`). */
interface LegacyEntry extends HandoffLedgerEntry {
  draftEmittedAt?: string;
}

export class InteractiveHandoffLedger {
  private readonly path: string;
  private entries: Record<string, HandoffLedgerEntry>;

  constructor(path: string) {
    this.path = path;
    this.entries = {};
    try {
      // The persisted top-level field stays `docs` for wire-compat with ledgers the draft leg
      // already wrote to operator machines (~/.wicked-crew/interactive-draft-ledger.json).
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { docs?: Record<string, LegacyEntry> };
      if (parsed && typeof parsed === 'object' && parsed.docs && typeof parsed.docs === 'object') {
        for (const [key, entry] of Object.entries(parsed.docs)) {
          // Per-row validation: one malformed row (null, primitive, missing/empty fields) costs
          // that row alone — letting it throw into the outer catch would blank the WHOLE ledger
          // and defeat replay-dedup for every handoff already answered. A kept row must satisfy
          // the full HandoffLedgerEntry contract (non-empty runId + launchedAt strings).
          if (
            typeof entry !== 'object' ||
            entry === null ||
            typeof entry.runId !== 'string' ||
            entry.runId.length === 0 ||
            typeof entry.launchedAt !== 'string'
          ) {
            continue;
          }
          const { draftEmittedAt, ...rest } = entry;
          this.entries[key] = {
            ...rest,
            // Migrate the draft leg's original field name in place.
            ...(rest.emittedAt === undefined && draftEmittedAt !== undefined
              ? { emittedAt: draftEmittedAt }
              : {}),
          };
        }
      }
    } catch {
      // Missing or malformed ledger — start empty. Malformed is deliberately NOT fatal: a
      // corrupt ledger must not stop the daemon, and the worst case is one duplicate closing
      // emit, which the deterministic bus idempotency key still dedupes.
    }
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.entries, key);
  }

  get(key: string): HandoffLedgerEntry | undefined {
    return this.entries[key];
  }

  recordLaunch(key: string, runId: string): void {
    this.entries[key] = { runId, launchedAt: new Date().toISOString() };
    this.persist();
  }

  recordEmitted(key: string): void {
    const entry = this.entries[key];
    if (entry) {
      entry.emittedAt = new Date().toISOString();
      this.persist();
    }
  }

  recordFailure(key: string): void {
    const entry = this.entries[key];
    if (entry) {
      entry.failedAt = new Date().toISOString();
      this.persist();
    }
  }

  size(): number {
    return Object.keys(this.entries).length;
  }

  /**
   * Drop every row belonging to one document (crew#338 — a deleted/retired doc must not leave
   * ghost rows that shadow its name forever). BOTH key grammars are swept, which is why this is
   * a prefix sweep and not a single `delete entries[docId]`:
   *
   *  - the exact key `<doc>` (draft leg + the demo leg's doc-created row);
   *  - every `<doc>:<suffix>` key (edit/demo `<doc>:v<version>`, chat `<doc>:m:<msgId>` /
   *    `<doc>:e:<eventId>`).
   *
   * The `:` separator cannot appear inside a doc name (interactive's DOC_NAME grammar is
   * `^[a-z0-9][a-z0-9-]{0,63}$`), so the prefix can never match a sibling document's rows.
   *
   * Idempotent by construction — removing rows that are not there removes nothing — which is
   * what makes it safe under at-least-once redelivery of the retire fact. Persisted atomically
   * (tmp + rename, like every other write) and ONLY when something was actually removed, so a
   * sweep of a doc this ledger never answered does not create or rewrite the file.
   *
   * @returns the removed keys (empty = nothing to remove).
   */
  removeDoc(documentId: string): string[] {
    const prefix = `${documentId}:`;
    const removed: string[] = [];
    for (const key of Object.keys(this.entries)) {
      if (key === documentId || key.startsWith(prefix)) {
        delete this.entries[key];
        removed.push(key);
      }
    }
    if (removed.length > 0) this.persist();
    return removed;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ docs: this.entries }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
