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

/** How long kept lines wait to be written together. */
const FLUSH_DELAY_MS = 500;
/** Lines beyond twice the distinct runs that a file may hold before it is compacted at the next start. */
const COMPACT_SLACK = 64;

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
  /** The write chain: one append at a time, each draining every line pending when it starts. */
  private writing: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set when the file could not be written: memory only for this process. */
  private off = false;
  /** The file's header names the store now at `dbPath` (read or written by this process). */
  private bound = false;
  /** The file ends inside a line (a torn write): the next append starts a new line first. */
  private torn = false;

  constructor(readonly path: string, private readonly dbPath: string) {}

  /** The kept facts for `runId`, when they were derived from the run with this fingerprint. */
  get(runId: string, fp: string): KeptFacts | undefined {
    const k = this.load().get(runId);
    return k !== undefined && k.fp === fp ? k : undefined;
  }

  /** Keep a run's positive facts (no-op when there is none or they are already kept). */
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
    // Batched by time, not by turn: a first list derives runs as their reads land, spread over seconds.
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, FLUSH_DELAY_MS);
      this.timer.unref?.();
    }
  }

  /** Write every pending line, after any write in flight. Never throws: a failed write turns the file off for this
   *  process (memory only) and costs one re-read per run on the next start. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = (this.writing ?? Promise.resolve()).then(() => this.drain());
    this.writing = run;
    void run.finally(() => {
      if (this.writing === run) this.writing = null;
    });
    return run;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0 && !this.off) {
      if (!this.bound) return; // load() binds the file before any line is kept; `off` covers a failed bind
      const lines = (this.torn ? '\n' : '') + this.pending.join('');
      this.pending = [];
      this.torn = false;
      try {
        await appendFile(this.path, lines);
      } catch {
        this.off = true;
        this.pending = [];
      }
    }
  }

  /** Start the file over for this store (its header first). */
  private bind(store: Header['store']): void {
    try {
      writeFileSync(this.path, JSON.stringify({ v: 1, store } satisfies Header) + '\n');
      this.bound = true;
      this.torn = false;
    } catch {
      this.off = true;
    }
  }

  private load(): Map<string, KeptFacts> {
    if (this.kept !== null) return this.kept;
    this.kept = new Map();
    const store = storeIdentity(this.dbPath);
    // No store file to bind to: memory only for this process. (A daemon's first fold has the engine's store open, so
    // the file exists by the time a fact is asked for; only a fake engine meets this.)
    if (store === null) {
      this.off = true;
      return this.kept;
    }
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
      this.bind(store);
      return this.kept;
    }
    this.bound = true;
    let rows = 0;
    for (const line of lines.slice(1)) {
      if (line === '') continue;
      rows++;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn or malformed line: that run is derived again
      }
      if (row === null || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const run = r['run'];
      const fp = r['fp'];
      if (r['v'] !== 1 || typeof run !== 'string' || typeof fp !== 'string') continue;
      const kept: KeptFacts = { fp };
      const launched = r['launched'];
      if (typeof launched === 'string' || launched === null) kept.launched = launched;
      const endedAt = r['endedAt'];
      if (typeof endedAt === 'number' && endedAt > 0) kept.endedAt = endedAt;
      this.kept.set(run, kept);
    }
    this.torn = text.length > 0 && !text.endsWith('\n');
    // Compaction: a run is re-appended only when its facts change (a reused id), so lines track distinct runs; a file
    // that has grown past twice them is rewritten once, here, from what was just read.
    if (rows > 2 * this.kept.size + COMPACT_SLACK) this.compact(store, this.kept);
    return this.kept;
  }

  private compact(store: Header['store'], all: ReadonlyMap<string, KeptFacts>): void {
    const out = [JSON.stringify({ v: 1, store } satisfies Header)];
    for (const [run, kept] of all) out.push(JSON.stringify({ v: 1, run, ...kept }));
    try {
      writeFileSync(this.path, out.join('\n') + '\n');
      this.torn = false;
    } catch {
      // Left as it was: the next start reads the longer file.
    }
  }
}
