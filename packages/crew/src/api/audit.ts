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
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Actor, AuditEntry } from '../core/types.js';

/** Where the audit trail lives unless overridden. */
export function defaultAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return env['WICKED_CREW_AUDIT_LOG'] ?? join(homedir(), '.wicked-crew', 'audit.log');
}

export interface AuditReadFilter {
  runId?: string;
  action?: string;
  /** Max entries returned (newest first). Default 200, capped at 1000. */
  limit?: number;
}

export class AuditLog {
  private chain: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(
    readonly path: string = defaultAuditPath(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /**
   * Record one action. Fire-and-forget by design (the route's answer must not
   * wait on fsync of a sidecar), serialized so lines never interleave, loud on
   * failure. `flush()` awaits the chain — tests and shutdown use it.
   */
  record(action: string, actor: Actor, fields?: { runId?: string; detail?: Record<string, unknown> }): void {
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
    const limit = Math.min(Math.max(filter?.limit ?? 200, 1), 1000);
    return entries.slice(0, limit);
  }
}
