/**
 * MCP call records at rest (DES-MCP-TOOLS-001 §5, D-3): `<state home>/mcp/calls.ndjson`, one OTel
 * span-shaped record per brokered call. Arguments and results are never captured.
 *
 * The broker writes a record for every call it judged, whatever the outcome, and a call whose
 * record cannot be written is refused (`guard_error`): its result is withheld. Appends are
 * serialized on one promise chain so two concurrent calls never interleave a line. The fold into
 * `calls-daily.ndjson` after 30 days belongs to the usage slice (S7).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { McpCallRecord } from '../core/types.js';
import { mcpStateDir } from './registry-store.js';

export const MCP_CALLS_FILENAME = 'calls.ndjson';

export interface McpCallRecordSink {
  append(record: McpCallRecord): Promise<void>;
}

export class McpCallRecordFile implements McpCallRecordSink {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string = mcpStateDir()) {}

  get path(): string {
    return join(this.dir, MCP_CALLS_FILENAME);
  }

  append(record: McpCallRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    const next = this.tail.then(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(this.path, line, { mode: 0o600 });
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
