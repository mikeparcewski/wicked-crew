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

import { randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
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
  /** TESTS ONLY: complete-line bytes parsed, including refolds (crew#1319). */
  bytesFolded = 0;
  private foldState = this.emptyFold();

  private emptyFold() {
    return { ino: null as number | null, offset: 0, lines: 0, last: new Map<string, SourceAgentQueryEntry>() };
  }

  constructor(
    dir: string = mcpStateDir(),
    /** TESTS ONLY: the directory barrier (production: fsync of the directory). */
    private readonly sync: (dir: string) => Promise<void> = (d) => syncDir(d),
    /** TESTS ONLY: compact small records (crew#1319). */
    private readonly options: { compactMinLines?: number } = {},
  ) {
    this.path = join(dir, SOURCE_QUERIES_FILENAME);
  }

  /**
   * Append one entry; resolves once it is on disk, rejects when it is not (the caller withholds the rows). A
   * torn last line (a crash mid-append) is cut first, so it can never swallow this entry.
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
      await this.compact();
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

  /** crew#1319: only called on the append chain, so folds cannot interleave with writes or compaction. */
  private async fold(): Promise<Map<string, SourceAgentQueryEntry> | null> {
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(this.path, 'r');
      const { ino, size } = await fh.stat();
      if (ino !== this.foldState.ino || size < this.foldState.offset) this.foldState = this.emptyFold();
      const state = this.foldState;
      state.ino = ino;
      let tail: Buffer = Buffer.alloc(0);
      const chunk = Buffer.alloc(64 * 1024);
      for (let pos = state.offset; pos < size; ) {
        const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos);
        if (bytesRead === 0) return null;
        pos += bytesRead;
        const data = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
        let from = 0;
        for (let nl = data.indexOf(0x0a, from); nl >= 0; nl = data.indexOf(0x0a, from)) {
          const line = data.toString('utf8', from, nl);
          const bytes = nl + 1 - from;
          state.offset += bytes;
          state.lines++;
          this.bytesFolded += bytes;
          from = nl + 1;
          if (line.trim() === '') continue;
          let e: SourceAgentQueryEntry;
          try {
            e = JSON.parse(line) as SourceAgentQueryEntry;
            if (e === null || typeof e !== 'object' || typeof e.runId !== 'string' || typeof e.source !== 'string' || typeof e.callId !== 'string' || typeof e.released !== 'boolean' || typeof e.rows !== 'number') throw new Error('damaged read record');
          } catch {
            // A repair can keep the same inode and size: retry the entire record next time.
            this.foldState = this.emptyFold();
            return null;
          }
          state.last.delete(e.callId);
          state.last.set(e.callId, e);
        }
        // crew#1319: leave an unterminated tail outside the cached offset; append cuts it off.
        tail = data.subarray(from);
      }
      return state.last;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.foldState = this.emptyFold();
        return this.foldState.last;
      }
      return null;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  }

  private async compact(): Promise<void> {
    let tmp: string | undefined;
    try {
      const entries = await this.fold();
      const state = this.foldState;
      // Trigger on REDUNDANT lines (superseded entries), not on a ratio: after one compaction a released call adds
      // 2 lines per call and a refusal 1, so a ratio test would never fire again (crew#1719 coord r1).
      if (entries === null || state.lines - state.last.size < (this.options.compactMinLines ?? 10_000)) return;
      tmp = `${this.path}.compact-${randomBytes(8).toString('hex')}`;
      const fh = await open(tmp, 'wx', 0o600);
      // One write of the whole compacted record (not one awaited write per entry inside the append).
      const text = [...entries.values()].map((entry) => `${JSON.stringify(entry)}\n`).join('');
      const offset = Buffer.byteLength(text);
      let ino: number;
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
        ino = (await fh.stat()).ino;
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
      await this.sync(dirname(this.path));
      this.foldState = { ino, offset, lines: entries.size, last: state.last };
    } catch {
      // crew#1319: the append is durable already; retry the fold rather than fail its release.
      this.foldState = this.emptyFold();
    } finally {
      if (tmp !== undefined) await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Every call's FINAL entry, oldest first; `null` when the file cannot be read (missing = none). */
  all(): Promise<SourceAgentQueryEntry[] | null> {
    const next = this.chain.then(async () => {
      const last = await this.fold();
      return last === null ? null : [...last.values()];
    });
    this.chain = next.catch(() => undefined);
    return next;
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
