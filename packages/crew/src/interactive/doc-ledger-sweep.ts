/**
 * The four-ledger doc sweep (crew#338) — the crew-side half of deleting a wicked-interactive doc.
 *
 * Crew keeps one replay-dedup row per answered handoff in four durable ledgers
 * (`~/.wicked-crew/interactive-{draft,edit,chat,demo}-ledger.json`). The DRAFT leg keys by
 * DOCUMENT ID on purpose — one first draft per document lifetime — which is exactly the grammar
 * that breaks under delete: retire a doc's workspace without dropping its rows and the id stays
 * claimed forever, so a doc later created under the same name is treated as already-drafted and
 * `wicked.interactive.draft.completed` never fires for it (the studio#119 ghost).
 *
 * This module sweeps one document out of all four ledgers. Per ledger it prefers the LIVE
 * in-memory instance when the owning seam is armed — a file-level rewrite behind a live
 * instance's back would be undone by that instance's next whole-map persist, resurrecting the
 * ghost — and falls back to a fresh instance over the ledger FILE when the seam is not armed
 * (no live map exists, so the file is the only holder of state).
 *
 * Failure posture: NEVER throws, ALWAYS reports. Each ledger is swept independently and a
 * failing one (unwritable file, torn rename) is named in `errors` while the others still get
 * swept — the caller (the delete route) is contractually LOUD about a partial result. The sweep
 * is idempotent (removing absent rows removes nothing), so "re-issue the delete" is always a
 * safe retry instruction.
 */

import { InteractiveHandoffLedger } from './ledger.js';

/** One sweepable ledger: the seam's live instance when armed, else its on-disk path. */
export interface DocLedgerSource {
  /** Which seam's ledger this is (`draft` | `edit` | `chat` | `demo`) — names the error. */
  name: string;
  /** The armed seam's live ledger — read AT SWEEP TIME so a seam that armed after this source
   *  was declared is still preferred over its file. */
  ledger?: InteractiveHandoffLedger | undefined;
  /** The ledger file, for when no live instance exists. A missing file sweeps to nothing. */
  path: string;
}

/** What one sweep did — the `ledger` half of the delete route's answer (wire: crew-api-types
 *  `InteractiveDocDeleteLedgerReport`). */
export interface DocLedgerSweep {
  /** True iff every ledger was swept without error. `removed_keys` can be non-empty either way. */
  ok: boolean;
  /** Every row key actually dropped, across all four ledgers (empty = nothing was there). */
  removed_keys: string[];
  /** The ledgers that could NOT be swept, by name and cause. Present only when `ok` is false —
   *  their rows may still shadow the document's name. */
  errors?: { ledger: string; error: string }[];
}

/**
 * Sweep one document's rows out of every given ledger. Never throws; see the module doc for the
 * per-ledger isolation and live-instance-first rules.
 */
export function sweepDocLedgers(documentId: string, sources: DocLedgerSource[]): DocLedgerSweep {
  const removed: string[] = [];
  const errors: { ledger: string; error: string }[] = [];
  for (const source of sources) {
    try {
      const ledger = source.ledger ?? new InteractiveHandoffLedger(source.path);
      removed.push(...ledger.removeDoc(documentId));
    } catch (err) {
      errors.push({
        ledger: source.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { ok: errors.length === 0, removed_keys: removed, ...(errors.length > 0 ? { errors } : {}) };
}
