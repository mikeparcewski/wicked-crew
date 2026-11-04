/**
 * The record of agent reads (DES-KNOWLEDGE-DATA-001 §7.9; ported from crew#1309's `sources/agent-queries.ts`):
 * `<state home>/mcp/source-queries.ndjson`, one line per rows-tool call that reached the read policy. It backs
 * the sheet's "Recent agent queries" and a job's data use (gate cards, the delivery).
 *
 * It holds NO value: never the SQL text (an agent's SQL can carry literals copied from rows), a row, a
 * parameter or a source's words. Only who (run, unit, attempt, seat), which source (name and id), the SQL's
 * sha256, the counts, the time, and whether rows were released.
 *
 * Release is two durable steps (handoff §2): an `unconfirmed` entry (`released:false`) is written before the
 * release check, and the final `released:true` entry only after the broker's own call record. The fold keeps
 * the LAST entry per call id, so any failure or crash in between leaves "not released", which is then true.
 * A file that cannot be read is `unknown`, never "no data used". It lives in the `mcp` state-home entry
 * workers are fenced out of, mode 0600.
 */

import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { mcpStateDir } from '../../mcp/registry-store.js';

export interface SourceAgentQueryEntry {
  /** The broker call's id (its span id in `calls.ndjson`). */
  callId: string;
  at: string;
  runId: string;
  unit: number;
  attempt: number;
  seat: string;
  source: string;
  /** The registry id (§5.1): the security identity. */
  sourceId: string;
  /** sha256 of the SQL text, hex. */
  sqlHash: string;
  /** `ok`: rows released. Otherwise crew's code (a policy code, `query_off`, `deadline`, `too_large`, …). */
  outcome: string;
  rows: number;
  truncated: boolean;
  ms: number;
  released: boolean;
  sqlstate?: string;
}

/** A job's use of one source, as its gate cards and delivery show it. */
export interface SourceDataUse {
  source: string;
  /** Calls that reached the policy. */
  queries: number;
  /** Calls whose rows were released to the agent. */
  released: number;
  rows: number;
  truncated: boolean;
  lastAt: string;
}

export const SOURCE_QUERIES_FILENAME = 'source-queries.ndjson';

export class SourceReadLog {
  private chain: Promise<unknown> = Promise.resolve();
  readonly path: string;

  constructor(dir: string = mcpStateDir()) {
    this.path = join(dir, SOURCE_QUERIES_FILENAME);
  }

  /**
   * Append one entry; resolves once it is on disk, rejects when it is not (the caller withholds the rows). A
   * torn last line (a crash mid-append) is closed with a newline first, so it can never swallow this entry.
   */
  append(entry: SourceAgentQueryEntry): Promise<void> {
    const next = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await appendFile(this.path, `${(await this.endsTorn()) ? '\n' : ''}${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Whether the file's last byte is not a newline (an append a crash cut short). */
  private async endsTorn(): Promise<boolean> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(this.path, 'r');
      const { size } = await fh.stat();
      if (size === 0) return false;
      const b = Buffer.alloc(1);
      await fh.read(b, 0, 1, size - 1);
      return b[0] !== 0x0a;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    } finally {
      await fh?.close();
    }
  }

  /** Every call's FINAL entry, oldest first; `null` when the file cannot be read (missing = none). */
  async all(): Promise<SourceAgentQueryEntry[] | null> {
    await this.chain;
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return null;
    }
    const last = new Map<string, SourceAgentQueryEntry>();
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line) as SourceAgentQueryEntry;
        if (typeof e.runId === 'string' && typeof e.source === 'string' && typeof e.callId === 'string') {
          last.delete(e.callId);
          last.set(e.callId, e);
        }
      } catch {
        // A torn line (a crash mid-append, never released) is skipped; the rest still reads.
      }
    }
    return [...last.values()];
  }

  /** The most recent `n` entries for `source`, newest first; `null` = the record cannot be read. */
  async recent(source: string, n = 20): Promise<SourceAgentQueryEntry[] | null> {
    const all = await this.all();
    if (all === null) return null;
    return all.filter((e) => e.source === source).slice(-n).reverse();
  }

  /** A run's data use, one line per source it queried, by name; `null` = the record cannot be read (unknown). */
  async dataUse(runId: string): Promise<SourceDataUse[] | null> {
    const all = await this.all();
    if (all === null) return null;
    const by = new Map<string, SourceDataUse>();
    for (const e of all) {
      if (e.runId !== runId) continue;
      const u = by.get(e.source) ?? { source: e.source, queries: 0, released: 0, rows: 0, truncated: false, lastAt: e.at };
      u.queries += 1;
      if (e.released) {
        u.released += 1;
        u.rows += e.rows;
        u.truncated = u.truncated || e.truncated;
      }
      if (e.at > u.lastAt) u.lastAt = e.at;
      by.set(e.source, u);
    }
    return [...by.values()].sort((a, b) => a.source.localeCompare(b.source));
  }
}
