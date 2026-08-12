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

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ docs: this.entries }, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
