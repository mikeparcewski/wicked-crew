/**
 * The document ↔ run binding as a direct read (wave 6, F-4R2-006 root fix).
 *
 * Every interactive seam (draft / edit / chat / demo) answers a document event with ONE governed
 * run and records that launch in its durable handoff ledger under a key that STARTS with the
 * document id — `<doc>` (draft, the demo's doc-created row), `<doc>:v<version>` (edit / demo
 * handoffs), `<doc>:m:<msgId>` / `<doc>:e:<eventId>` (chat asks). The `:` separator cannot appear
 * inside a doc name (interactive's DOC_NAME grammar is `^[a-z0-9][a-z0-9-]{0,63}$`), so the prefix
 * before the first `:` IS the document id — the same fact `InteractiveHandoffLedger.removeDoc`
 * already relies on for its prefix sweep.
 *
 * The studio used to recover the binding by parsing the run's `extra_write_roots` path (the seam's
 * inbox is `<seamDir>/<key>`), a client-side heuristic over a daemon-internal layout. This index
 * reads the ledgers — the system of record for "this handoff was answered by this run" — and the
 * run DTO carries `document_id` (`GET /runs`, `GET /runs/:id`) while `GET /runs?doc=<id>` filters
 * on it. The sources are the SAME four the doc-delete sweep uses (`server.ts` `dropDocLedgerRows`):
 * an armed seam's live ledger instance first, its file otherwise, read AT LOOKUP TIME under a short
 * TTL so a seam that arms later, or a launch that just landed, is seen without a restart.
 */

import { InteractiveHandoffLedger } from './ledger.js';

/** One seam's ledger — the live instance when the seam is armed, else its file. */
export interface DocRunSource {
  /** `draft` | `edit` | `chat` | `demo` — names a read failure. */
  name: string;
  ledger?: InteractiveHandoffLedger | undefined;
  path: string;
}

/** The document id a handoff-ledger key names (see the module doc). */
export function documentIdOfKey(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
}

/** Default freshness of one ledger read; the ledgers are small JSON files. */
export const DOC_RUN_INDEX_TTL_MS = 2_000;

export class DocRunIndex {
  private readonly sources: () => DocRunSource[];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly log: ((msg: string) => void) | undefined;
  /** Live stamps from seams launching in THIS process — merged over every read. */
  private readonly live = new Map<string, string>();
  private cache: {
    at: number;
    byRun: Map<string, string>;
    byDoc: Map<string, string[]>;
    /** document id → the seams (`draft` | `edit` | `chat` | `demo`) whose ledgers hold a row for it. */
    kinds: Map<string, Set<string>>;
  } | null = null;

  constructor(
    sources: () => DocRunSource[],
    opts: { ttlMs?: number; now?: () => number; log?: (msg: string) => void } = {},
  ) {
    this.sources = sources;
    this.ttlMs = opts.ttlMs ?? DOC_RUN_INDEX_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
  }

  /** Record a launch the moment a seam makes it (the ledger write lands beside it). */
  set(runId: string, documentId: string): void {
    this.live.set(runId, documentId);
    this.cache = null;
  }

  private refresh(): { byRun: Map<string, string>; byDoc: Map<string, string[]>; kinds: Map<string, Set<string>> } {
    const at = this.now();
    if (this.cache !== null && at - this.cache.at < this.ttlMs) return this.cache;
    const byRun = new Map<string, string>();
    const kinds = new Map<string, Set<string>>();
    for (const source of this.sources()) {
      try {
        const ledger = source.ledger ?? new InteractiveHandoffLedger(source.path);
        for (const [key, entry] of ledger.rows()) {
          if (typeof entry.runId !== 'string' || entry.runId === '') continue;
          const doc = documentIdOfKey(key);
          if (doc === '') continue;
          if (!byRun.has(entry.runId)) byRun.set(entry.runId, doc);
          const set = kinds.get(doc) ?? new Set<string>();
          set.add(source.name);
          kinds.set(doc, set);
        }
      } catch (err) {
        // A ledger that cannot be read leaves ITS runs unbound for this read — never the others'.
        this.log?.(
          `[runs] doc-run index: could not read the ${source.name} ledger (${
            err instanceof Error ? err.message : String(err)
          }); its runs read as unbound until it is readable`,
        );
      }
    }
    for (const [runId, doc] of this.live) if (!byRun.has(runId)) byRun.set(runId, doc);
    const byDoc = new Map<string, string[]>();
    for (const [runId, doc] of byRun) {
      const list = byDoc.get(doc) ?? [];
      list.push(runId);
      byDoc.set(doc, list);
    }
    this.cache = { at, byRun, byDoc, kinds };
    return this.cache;
  }

  /** The document this run answered, or `undefined` for a run no interactive seam launched. */
  documentOf(runId: string): string | undefined {
    return this.refresh().byRun.get(runId);
  }

  /** Every run launched for this document (ledger order; `[]` when none). */
  runsOf(documentId: string): string[] {
    return [...(this.refresh().byDoc.get(documentId) ?? [])];
  }

  /** The seams that answered this document (`draft` | `edit` | `chat` | `demo`, source order; `[]`
   *  when none) — the `kinds` a daemon-wide docs listing shows per document. */
  kindsOf(documentId: string): string[] {
    return [...(this.refresh().kinds.get(documentId) ?? [])];
  }
}
