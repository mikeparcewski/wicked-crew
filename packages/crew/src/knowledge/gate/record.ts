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

import { mkdir, open, readFile, stat } from 'node:fs/promises';
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

/**
 * fsync a directory, so the entries in it (a new file, a new subdirectory) are durable. Windows cannot open a
 * directory for this (NTFS journals its metadata): skipped there. Anywhere else a failure is a failure: the append
 * rejects and the caller withholds the rows, since a barrier that did not run is not a barrier.
 */
async function syncDir(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * `mkdir -p`, durably: every directory it creates is synced into its parent, from the deepest up to the first one
 * that already existed. Answers whether anything was created.
 */
export async function mkdirDurable(dir: string, sync: (d: string) => Promise<void> = syncDir): Promise<boolean> {
  const created: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    try {
      await stat(d);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      created.push(d);
      if (dirname(d) === d) break;
    }
  }
  if (created.length === 0) return false;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // The parent of each created directory holds its entry: the deepest's parent first, the existing ancestor last.
  for (const d of created) await sync(dirname(d));
  return true;
}

export class SourceReadLog {
  private chain: Promise<unknown> = Promise.resolve();
  private dirSynced = false;
  readonly path: string;

  constructor(
    dir: string = mcpStateDir(),
    /** TESTS ONLY: the directory barrier (production: fsync of the directory). */
    private readonly sync: (dir: string) => Promise<void> = (d) => syncDir(d),
  ) {
    this.path = join(dir, SOURCE_QUERIES_FILENAME);
  }

  /**
   * Append one entry; resolves once it is on disk, rejects when it is not (the caller withholds the rows). A
   * torn last line (a crash mid-append) is closed with a newline first, so it can never swallow this entry.
   */
  append(entry: SourceAgentQueryEntry): Promise<void> {
    const next = this.chain.then(async () => {
      // The directory chain first, durably (a crash must not lose the directory the record is in).
      if (!this.dirSynced) await mkdirDurable(dirname(this.path), this.sync);
      // A torn last line (a crash mid-append, never released: rows go out only after an append resolves) is cut
      // off before the next append, so the file never holds a damaged line anywhere but at its very end.
      await this.cutTornTail();
      // Synced before it resolves: the release that follows is never ahead of the record on disk.
      const fh = await open(this.path, 'a', 0o600);
      try {
        await fh.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      // The file's own directory entry too, once (a new file is not durable until its directory is).
      if (!this.dirSynced) {
        await this.sync(dirname(this.path));
        this.dirSynced = true;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** If the file's last byte is not a newline (an append a crash cut short), truncate it back to its last whole line. */
  private async cutTornTail(): Promise<void> {
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(this.path, 'r+');
      const { size } = await fh.stat();
      if (size === 0) return;
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] === 0x0a) return;
      // Find the last newline before the torn tail (a line is small: read back in 64 KiB steps).
      let end = 0;
      for (let pos = size; pos > 0 && end === 0; ) {
        const from = Math.max(0, pos - 64 * 1024);
        const buf = Buffer.alloc(pos - from);
        await fh.read(buf, 0, buf.length, from);
        const i = buf.lastIndexOf(0x0a);
        if (i >= 0) end = from + i + 1;
        pos = from;
      }
      await fh.truncate(end);
      await fh.sync();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
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
    const lines = text.split('\n');
    // The file ends in a newline unless its last append was torn (`cutTornTail` removes such a tail before the next
    // append), so only the very last segment may be damaged; a damaged line anywhere else is corruption, and a
    // record that cannot say what was released is unknown.
    for (const [i, line] of lines.entries()) {
      if (line.trim() === '') continue;
      let e: SourceAgentQueryEntry;
      try {
        e = JSON.parse(line) as SourceAgentQueryEntry;
      } catch {
        if (i === lines.length - 1) continue;
        return null;
      }
      if (typeof e.runId !== 'string' || typeof e.source !== 'string' || typeof e.callId !== 'string' || typeof e.released !== 'boolean' || typeof e.rows !== 'number') return null;
      last.delete(e.callId);
      last.set(e.callId, e);
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
