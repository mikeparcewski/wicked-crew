/**
 * The crew-side actor audit trail (task #88).
 *
 * The engine's `LaunchOptions` carries no actor field, so WHO launched a run,
 * WHO approved a gate, and WHO rewrote a policy is knowledge only the daemon's
 * HTTP layer ever holds — this module is where it stops being ephemeral. One
 * JSON line per privileged action, appended to `~/.wicked-crew/audit.log`
 * (override: `WICKED_CREW_AUDIT_LOG`), read back by `GET /audit`.
 *
 * Posture: LOUD-NON-FATAL, matching the daemon's bus seams — an unwritable
 * audit file must not turn a valid gate approval into a 500, but it must be
 * SAID (once per failure) rather than swallowed. Appends are serialized on a
 * promise chain so concurrent handlers never interleave partial lines.
 */

import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { crewStateHome } from '../projects/state-home.js';
import type { Actor, AuditEntry } from '../core/types.js';

/**
 * Where the audit trail lives unless overridden: the explicit `WICKED_CREW_AUDIT_LOG` env
 * override, then the daemon's state home — the `--db` parent when the bootstrap configured one,
 * the historical `~/.wicked-crew` default otherwise (crew#353's principle, same seam as the
 * project graphs and the project settings store). A `--db`-isolated daemon must neither APPEND
 * its trail to the operator's real `~/.wicked-crew/audit.log` (every `run.launched` /
 * `settings.updated` / `project.created` did exactly that) nor HYDRATE its retry/guidance/
 * delivery indexes from the operator's real trail at boot.
 */
export function defaultAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_AUDIT_LOG'] ?? join(crewStateHome(), 'audit.log');
}

export interface AuditReadFilter {
  runId?: string;
  action?: string;
  /** Inclusive lower bound on the entry clock (`ts`, unix millis): keep entries with `ts >= since`.
   *  Applied BEFORE `limit`, so `limit` trims the newest N of the in-window entries. */
  since?: number;
  /** Max entries returned (newest first). Default 200, capped at 1000. */
  limit?: number;
}

/** `readAll`'s filter: no limit — the whole point is that nothing gets trimmed. */
export type AuditScanFilter = Omit<AuditReadFilter, 'limit'>;

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  private dirReady = false;
  private disabled = false;
  /** Called with each entry as it is recorded (a listener that throws is logged, never the caller's problem). */
  private readonly listeners: Array<(entry: AuditEntry) => void> = [];

  constructor(
    readonly path: string = defaultAuditPath(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
    /** The entry clock (unix millis). Injectable so a caller with its own clock stamps and replays on one time. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A trail that records nothing and reads back empty — the DEFAULT for
   * directly-driven route sets (unit tests call `registerRoutes` without a
   * server), so they never write the operator's real `~/.wicked-crew/audit.log`
   * or leave appends pending after close (Copilot, #250). `createServer`
   * always builds a real one; this never rides a production path.
   */
  static noop(): AuditLog {
    const log = new AuditLog();
    log.disabled = true;
    return log;
  }

  /**
   * Record one action. Fire-and-forget by design (the route's answer must not
   * wait on fsync of a sidecar), serialized so lines never interleave, loud on
   * failure. `flush()` awaits the chain — tests and shutdown use it.
   */
  /** Returns the unix-millis `ts` stamped on the entry (0 when disabled) so a caller can reuse the
   *  EXACT durable timestamp — e.g. the run-timing index, which must match what a restart rehydrates
   *  from the trail rather than drift by a second off a second `Date.now()`. */
  record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): number {
    if (this.disabled) return 0;
    const entry = this.entryOf(action, actor, fields);
    void this.append(entry).catch(() => undefined); // `append` has warned; the chain carries on
    return entry.ts;
  }

  /**
   * (crew#1124) Record one action and wait until it is on disk: resolves with its `ts` once appended AND flushed
   * (fsync), REJECTS when it was not. For the facts whose only durable copy is this trail (a Desk snooze): an answer of
   * success must mean it survives a restart, a host crash included. A trail whose last line was torn (a crash mid-line)
   * gets the line ended first, so the new entry is never glued onto the fragment and lost with it. The same serialized
   * chain as {@link record}, so lines never interleave; listeners hear the entry only once it is on disk.
   */
  async recordDurable(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): Promise<number> {
    if (this.disabled) throw new Error('the audit trail is disabled, so nothing can be recorded durably');
    const entry = this.entryOf(action, actor, fields, false);
    await this.append(entry, true);
    this.notify(entry);
    return entry.ts;
  }

  private entryOf(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }, notify = true): AuditEntry {
    const entry: AuditEntry = {
      ts: this.now(),
      action,
      actor,
      ...(fields?.runId !== undefined ? { runId: fields.runId } : {}),
      ...(fields?.detail !== undefined ? { detail: fields.detail } : {}),
    };
    if (notify) this.notify(entry);
    return entry;
  }

  private notify(entry: AuditEntry): void {
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch (err) {
        this.warn(`[audit] a listener failed on ${entry.action}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Append one entry on the chain; the returned promise rejects when the append failed (the chain itself never does). */
  private append(entry: AuditEntry, durable = false): Promise<void> {
    const write = this.chain.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      const line = `${JSON.stringify(entry)}\n`;
      if (!durable) {
        await appendFile(this.path, line, 'utf8');
        return;
      }
      await this.appendSynced(line);
    });
    this.chain = write.catch((err) => {
      this.warn(
        `[audit] FAILED to record ${entry.action} by ${entry.actor.id} at ${this.path}: ${
          err instanceof Error ? err.message : String(err)
        } — ${durable ? 'the action was refused, so nothing changed' : 'the action itself succeeded; the trail has a hole'}`,
      );
    });
    return write;
  }

  /** Append `line` after ending a torn last line, then fsync the file (and its directory when this created it). */
  private async appendSynced(line: string): Promise<void> {
    await appendLineSynced(this.path, line);
  }

  /** (workdoc-all-runs) Hear each entry as it is recorded (the working document's person-notes index). Returns the
   *  unsubscribe. A disabled trail records nothing, so its listeners hear nothing. */
  onRecord(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /** Await every append issued so far. */
  flush(): Promise<void> {
    return this.chain;
  }

  /**
   * Read the trail, newest first. A line that does not parse is skipped (a
   * torn final line after a crash is expected once) — the rest of the trail
   * still answers.
   */
  async read(filter?: AuditReadFilter): Promise<AuditEntry[]> {
    const entries = await this.scan(filter);
    const limit = Math.min(Math.max(filter?.limit ?? 200, 1), 1000);
    return entries.slice(0, limit);
  }

  /**
   * Read the trail EXHAUSTIVELY, newest first — no read cap. The hydrate path
   * for the boot-time indexes (`RetryIndex`, `GuidanceIndex`): durable facts
   * like retry lineage must not vanish because 1000+ newer launches landed on
   * top of them (BRIEF-UX-002 C5). Same cost class as `read` — that already
   * parses the whole file and only trims the returned slice — so this is a
   * one-time full-file scan at boot, measured at ~19ms on a 19k-line live trail.
   */
  readAll(filter?: AuditScanFilter): Promise<AuditEntry[]> {
    return this.scan(filter);
  }

  /** The shared full-file parse: every matching entry, newest first, uncapped. */
  private async scan(filter?: AuditScanFilter): Promise<AuditEntry[]> {
    if (this.disabled) return [];
    await this.flush();
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // nothing recorded yet
      throw err;
    }
    const entries: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (typeof e.ts !== 'number' || typeof e.action !== 'string') continue;
        if (filter?.runId !== undefined && e.runId !== filter.runId) continue;
        if (filter?.action !== undefined && e.action !== filter.action) continue;
        if (filter?.since !== undefined && e.ts < filter.since) continue;
        entries.push(e);
      } catch {
        /* torn line — skip it, keep the trail readable */
      }
    }
    entries.reverse(); // file order is append order; the API answers newest first
    return entries;
  }
}

/**
 * Append `line` to `path` and wait until it is on disk: a torn last line (a crash mid-line) is ended first, so the new
 * line is never glued onto the fragment; the file is fsynced, and its directory too when this call created the file.
 * Rejects when the line is not durable. Shared by the audit trail's durable records and crew#372's publish journal.
 */
export async function appendLineSynced(path: string, line: string, mode?: number): Promise<void> {
  const fh = await open(path, 'a+', mode);
  let created = false;
  try {
    const { size } = await fh.stat();
    created = size === 0;
    let text = line;
    if (size > 0) {
      const last = Buffer.alloc(1);
      await fh.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) text = `\n${line}`;
    }
    await fh.appendFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (created) {
    // The new file's directory entry is durable too. A platform that cannot open a directory (Windows) skips it.
    const dir = await open(dirname(path), 'r').catch(() => null);
    if (dir !== null) {
      try {
        await dir.sync();
      } catch {
        // a directory fsync is best effort where the platform refuses it
      } finally {
        await dir.close();
      }
    }
  }
}
