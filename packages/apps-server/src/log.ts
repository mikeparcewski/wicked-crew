/**
 * The server's two logs, as JSON lines on stdout and, when the data volume is mounted, in `/data/log/`:
 *
 * - `decisions.jsonl` (DES §8.3): one line per request that carried or needed a sign-in: the route, the
 *   token's claims that decided (never the token), the audience decision and its reason, and whether any
 *   source was called. K6b reads it to certify the Teams registration.
 * - `audit.jsonl` (DES §7.3): the write path's `apps.action.ran` / `granted` / `revoked` lines, with no values
 *   (the values stay in the action record on the same volume).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Actor, AuditLog } from './crew.js';

export class JsonLines {
  private readonly file: string | null;

  constructor(dir: string | null, name: string, private readonly out: (line: string) => void = (l) => process.stdout.write(l)) {
    this.file = dir === null ? null : join(dir, name);
    if (dir !== null) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  write(entry: Record<string, unknown>): void {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    this.out(line);
    if (this.file !== null) {
      try {
        appendFileSync(this.file, line, { mode: 0o600 });
      } catch {
        // The stdout copy stands; a full or unwritable volume does not stop the answer.
      }
    }
  }
}

/** The write path's audit sink: one line per grant, revoke and run, with no values. */
export function auditSink(lines: JsonLines): Pick<AuditLog, 'record'> {
  return {
    record(event: string, actor: Actor, opts?: { detail?: Record<string, unknown> }) {
      lines.write({ log: 'audit', event, actor: actor.id, ...(opts?.detail ?? {}) });
      return 0;
    },
  };
}
