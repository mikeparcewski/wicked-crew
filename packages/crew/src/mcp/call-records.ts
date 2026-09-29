/**
 * MCP call records at rest (DES-MCP-TOOLS-001 §5, D-3): `<state home>/mcp/calls.ndjson`, one OTel
 * span-shaped record per brokered call. Arguments and results are never captured.
 *
 * The broker writes a record for every call it judged, whatever the outcome, and a call whose
 * record cannot be written is refused (`guard_error`): its result is withheld. Appends are
 * serialized on one promise chain so two concurrent calls never interleave a line.
 *
 * The usage slice (S7) reads the records back on the same chain. A read first folds every record
 * that started more than {@link MCP_CALLS_RAW_DAYS} days ago into `calls-daily.ndjson` (one row per
 * UTC day × subject × seat × decision: calls, errors, total ms) and rewrites `calls.ndjson` without
 * them (write a temp file, then rename). The fold runs on demand, never on a timer.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { McpCallDecision, McpCallRecord } from '../core/types.js';
import { mcpStateDir } from './registry-store.js';

export const MCP_CALLS_FILENAME = 'calls.ndjson';
export const MCP_CALLS_DAILY_FILENAME = 'calls-daily.ndjson';
/** Records stay raw this long; older ones are folded into the daily file. */
export const MCP_CALLS_RAW_DAYS = 30;

const DAY_MS = 86_400_000;
const DECISIONS = new Set<McpCallDecision>(['allow', 'ask', 'deny', 'guard_error']);

export interface McpCallRecordSink {
  append(record: McpCallRecord): Promise<void>;
}

/** One row of `calls-daily.ndjson`. */
export interface McpCallDailyRow {
  day: string;
  subject: string;
  seat: string | null;
  decision: McpCallDecision;
  calls: number;
  errors: number;
  msTotal: number;
}

export interface McpCallRecordsRead {
  records: McpCallRecord[];
  /** Lines that did not parse as a call record (kept in the file, left out of every fold). */
  skipped: number;
  /** Records this read folded into the daily file. */
  folded: number;
}

/** The records the usage fold reads. */
export interface McpCallRecordSource {
  read(now: number): Promise<McpCallRecordsRead>;
}

/** A parsed line when it has the fields the usage fold reads; otherwise `null`. */
export function parseCallRecord(line: string): McpCallRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Partial<McpCallRecord>;
  const ok =
    typeof r.spanId === 'string' &&
    typeof r.start === 'string' &&
    Number.isFinite(Date.parse(r.start)) &&
    typeof r.ms === 'number' &&
    typeof r.status?.code === 'string' &&
    DECISIONS.has(r.decision?.decision as McpCallDecision) &&
    typeof r.attrs?.['mcp.subject'] === 'string' &&
    (r.traceId === null || typeof r.traceId === 'string') &&
    (r.parentSpanId === null || typeof r.parentSpanId === 'string');
  return ok ? (r as McpCallRecord) : null;
}

/** Fold records into daily rows, sorted by day, subject, seat, decision. */
export function foldDaily(records: readonly McpCallRecord[]): McpCallDailyRow[] {
  const rows = new Map<string, McpCallDailyRow>();
  for (const r of records) {
    const day = new Date(Date.parse(r.start)).toISOString().slice(0, 10);
    const seat = r.attrs['wicked.seat'] ?? null;
    const key = JSON.stringify([day, r.attrs['mcp.subject'], seat, r.decision.decision]);
    const row = rows.get(key) ?? { day, subject: r.attrs['mcp.subject'], seat, decision: r.decision.decision, calls: 0, errors: 0, msTotal: 0 };
    row.calls += 1;
    if (r.status.code === 'error') row.errors += 1;
    row.msTotal += r.ms;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || a.subject.localeCompare(b.subject) || (a.seat ?? '').localeCompare(b.seat ?? '') || a.decision.localeCompare(b.decision),
  );
}

export class McpCallRecordFile implements McpCallRecordSink, McpCallRecordSource {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string = mcpStateDir()) {}

  get path(): string {
    return join(this.dir, MCP_CALLS_FILENAME);
  }

  get dailyPath(): string {
    return join(this.dir, MCP_CALLS_DAILY_FILENAME);
  }

  append(record: McpCallRecord): Promise<void> {
    const line = `${JSON.stringify(record)}\n`;
    return this.serialize(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(this.path, line, { mode: 0o600 });
    });
  }

  /**
   * Every record of the last {@link MCP_CALLS_RAW_DAYS} days, after folding older ones into the
   * daily file. Serialized with the appends, so no call's line is lost to the rewrite.
   */
  read(now: number): Promise<McpCallRecordsRead> {
    return this.serialize(async () => {
      let text: string;
      try {
        text = await readFile(this.path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], skipped: 0, folded: 0 };
        throw err;
      }
      const cutoff = now - MCP_CALLS_RAW_DAYS * DAY_MS;
      const keep: string[] = [];
      const records: McpCallRecord[] = [];
      const old: McpCallRecord[] = [];
      let skipped = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        const r = parseCallRecord(line);
        if (r === null) {
          skipped += 1;
          keep.push(line);
        } else if (Date.parse(r.start) < cutoff) {
          old.push(r);
        } else {
          keep.push(line);
          records.push(r);
        }
      }
      if (old.length > 0) {
        // The raw file is rewritten only after the daily rows are durable: a crash in between
        // counts those records twice in the archive, never zero times.
        const daily = foldDaily(old).map((row) => `${JSON.stringify(row)}\n`).join('');
        await appendFile(this.dailyPath, daily, { mode: 0o600 });
        const tmp = `${this.path}.${process.pid}.tmp`;
        await writeFile(tmp, keep.map((l) => `${l}\n`).join(''), { mode: 0o600 });
        await rename(tmp, this.path);
      }
      return { records, skipped, folded: old.length };
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
