// crew#1880 (DES-1880): the facts a run's event log answers that never change once written, kept beside the store so
// a daemon start does not read every run's log again. At 4k runs the first run list after a start read ~8,000 logs
// (each terminal run twice: its launch name for `run_identity`, its terminal frame for `ended_at`) and took 7-80 s.
//
// Kept: only POSITIVE facts, each the FIRST of its frame kind (a later frame, e.g. after a resume, never changes it):
// the first `sessionStarted.workflowId` and the first terminal frame's `ts`. A negative (no launch frame, no terminal
// frame) is never kept, so a run whose log later gains the frame is read again on the next start, as before.
// Bound to the store by a header (the db file's dev, inode and birth time: a new file discards everything) and each
// line to its run by a hash of the run's `problem` (a run id can be caller-chosen and reused by another store).
// Residual (crew#1891): a different store copied over the live file in place, reusing an id with the same problem.
import { appendFile } from 'node:fs/promises';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import type { RecordedEvent } from './types.js';

/** The engine's terminal frames (the same set `RunTimingIndex` dates a run from). */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(['sessionCompleted', 'sessionFailed', 'runCancelled']);

/** What one read of a run's log answers. `launched`: string | null (free text) when the log holds a `sessionStarted`,
 *  `undefined` when it holds none. `endedAt`: the first terminal frame's capture `ts` (millis), or null. */
export interface LogFacts {
  launched: string | null | undefined;
  endedAt: number | null;
}

export function factsFromEvents(events: readonly RecordedEvent[]): LogFacts {
  const started = events.find((e) => e.type === 'sessionStarted') as Record<string, unknown> | undefined;
  // The engine spells it `workflowId` on the frame (core-ts `CoreEventJson`).
  const raw = started?.['workflowId'];
  const terminal = events.find((e) => TERMINAL_EVENTS.has(e.type) && typeof e.ts === 'number' && e.ts > 0);
  return {
    launched: started === undefined ? undefined : typeof raw === 'string' ? raw : null,
    endedAt: terminal !== undefined ? (terminal.ts as number) : null,
  };
}

/** The per-run binding: a short hash of the run's `problem` (immutable on a run; no crew code rewrites it). */
export function runFingerprint(problem: unknown): string {
  return createHash('sha256').update(typeof problem === 'string' ? problem : '').digest('hex').slice(0, 16);
}

/** A kept fact set: a key is present only when its fact is (positive facts only). */
export interface KeptFacts {
  fp: string;
  launched?: string | null;
  endedAt?: number;
}

interface Header {
  v: 1;
  store: { dev: number; ino: number; birth: number };
}

function storeIdentity(dbPath: string): Header['store'] | null {
  try {
    const s = statSync(dbPath);
    return { dev: s.dev, ino: s.ino, birth: Math.round(s.birthtimeMs) };
  } catch {
    return null;
  }
}

const sameStore = (a: Header['store'], b: unknown): boolean => {
  const o = b as Partial<Header['store']> | null | undefined;
  return o != null && o.dev === a.dev && o.ino === a.ino && o.birth === a.birth;
};

/**
 * `<db>.run-facts.jsonl` (a `core.db`-prefix sidecar: classified in the state-home registry, fenced from workers).
 * Opened lazily on first use, when the engine has the store open. One process writes it; two daemons on one store
 * (not fenced) append whole lines derived from the same logs, so an interleave only duplicates (last line wins).
 */
export class RunFactsFile {
  private kept: Map<string, KeptFacts> | null = null;
  /** Lines waiting for the next flush (one append per batch, not one write per run). */
  private pending: string[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private scheduled = false;
  /** Set when the file could not be written: memory only for this process. */
  private off = false;
  /** The file's header names the store now at `dbPath` (read or written by this process). */
  private bound = false;

  constructor(readonly path: string, private readonly dbPath: string) {}

  /** The kept facts for `runId`, when they were derived from the run with this fingerprint. */
  get(runId: string, fp: string): KeptFacts | undefined {
    const k = this.load().get(runId);
    return k !== undefined && k.fp === fp ? k : undefined;
  }

  /** Keep a run's positive facts (no-op when there is none). */
  put(runId: string, fp: string, facts: LogFacts): void {
    const kept: KeptFacts = { fp };
    if (facts.launched !== undefined) kept.launched = facts.launched;
    if (facts.endedAt !== null) kept.endedAt = facts.endedAt;
    if (kept.launched === undefined && kept.endedAt === undefined) return;
    const prior = this.load().get(runId);
    if (prior !== undefined && prior.fp === fp && prior.launched === kept.launched && prior.endedAt === kept.endedAt) return;
    this.load().set(runId, kept);
    if (this.off) return;
    this.pending.push(JSON.stringify({ v: 1, run: runId, ...kept }) + '\n');
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        void this.flush();
      });
    }
  }

  /** Write every pending line (one append). Never throws: a failed write costs a re-read on the next start. */
  flush(): Promise<void> {
    if (this.pending.length === 0 || this.off) return this.flushing;
    if (!this.bound && !this.bind()) return this.flushing; // no store file yet: the lines wait for it
    const lines = this.pending.join('');
    this.pending = [];
    this.flushing = this.flushing.then(() =>
      appendFile(this.path, lines).catch(() => {
        this.off = true;
      }),
    );
    return this.flushing;
  }

  /** Start the file over for the store now at `dbPath` (its header first). False while there is no store file. */
  private bind(): boolean {
    const store = storeIdentity(this.dbPath);
    if (store === null) return false;
    try {
      writeFileSync(this.path, JSON.stringify({ v: 1, store } satisfies Header) + '\n');
      this.bound = true;
    } catch {
      this.off = true;
    }
    return this.bound;
  }

  private load(): Map<string, KeptFacts> {
    if (this.kept !== null) return this.kept;
    this.kept = new Map();
    const store = storeIdentity(this.dbPath);
    // No store file yet (the engine has not created it): nothing on disk can be this store's; the file is started
    // over once the store exists (`flush` binds it then).
    if (store === null) return this.kept;
    let text = '';
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      text = '';
    }
    const lines = text.split('\n');
    let header: unknown;
    try {
      header = JSON.parse(lines[0] ?? '');
    } catch {
      header = undefined;
    }
    const h = header as Partial<Header> | undefined;
    if (h?.v !== 1 || !sameStore(store, h.store)) {
      // A missing, unreadable or foreign file (a new store at this path): start it over.
      this.bind();
      return this.kept;
    }
    this.bound = true;
    for (const line of lines.slice(1)) {
      if (line === '') continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a torn or malformed line: that run is derived again
      }
      const run = row['run'];
      const fp = row['fp'];
      if (row['v'] !== 1 || typeof run !== 'string' || typeof fp !== 'string') continue;
      const kept: KeptFacts = { fp };
      const launched = row['launched'];
      if (typeof launched === 'string' || launched === null) kept.launched = launched;
      const endedAt = row['endedAt'];
      if (typeof endedAt === 'number' && endedAt > 0) kept.endedAt = endedAt;
      this.kept.set(run, kept);
    }
    return this.kept;
  }
}
