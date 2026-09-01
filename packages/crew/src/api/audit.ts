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

import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
  /** Max entries returned (newest first). Default 200, capped at 1000. */
  limit?: number;
}

/** `readAll`'s filter: no limit — the whole point is that nothing gets trimmed. */
export type AuditScanFilter = Omit<AuditReadFilter, 'limit'>;

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  private dirReady = false;
  private disabled = false;

  constructor(
    readonly path: string = defaultAuditPath(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
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
  record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): void {
    if (this.disabled) return;
    const entry: AuditEntry = {
      ts: Date.now(),
      action,
      actor,
      ...(fields?.runId !== undefined ? { runId: fields.runId } : {}),
      ...(fields?.detail !== undefined ? { detail: fields.detail } : {}),
    };
    this.chain = this.chain.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.path), { recursive: true });
        this.dirReady = true;
      }
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    });
    this.chain = this.chain.catch((err) => {
      this.warn(
        `[audit] FAILED to record ${action} by ${actor.id} at ${this.path}: ${
          err instanceof Error ? err.message : String(err)
        } — the action itself succeeded; the trail has a hole`,
      );
    });
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
        entries.push(e);
      } catch {
        /* torn line — skip it, keep the trail readable */
      }
    }
    entries.reverse(); // file order is append order; the API answers newest first
    return entries;
  }
}
