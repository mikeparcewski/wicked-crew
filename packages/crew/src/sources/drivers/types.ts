/** Shapes shared by the SQL drivers (DES-APPS-001 §5.1, §7.5). */

import type { AddressPolicy, DialOptions } from '../dialer.js';

/** `verify-full` (Postgres) / `VERIFY_IDENTITY` (MySQL); `disable` only where the dialer allows plaintext. */
export type SqlTlsMode = 'verify-full' | 'disable';

/** A network SQL source's connection descriptor: its non-secret identity. */
export interface SqlNetworkSource {
  driver: 'postgres' | 'mysql';
  host: string;
  port: number;
  database: string;
  user: string;
  tls: SqlTlsMode;
  /** A CA (PEM) the person gave for this source's TLS; replaces the system roots when set. */
  ca?: string | null;
}

export interface SqlConnectArgs {
  source: SqlNetworkSource;
  /** The password, resolved from its secret reference at connect time; never stored here. */
  password: string | null;
  policy: AddressPolicy;
  dial?: DialOptions;
}

/** The statement deadline (§7.5): 10 s per driver, enforced AT THE SOURCE and then by cancel. */
export const STATEMENT_DEADLINE_MS = 10_000;
/** A row's size, roughly (UTF-16 string lengths, 8 per other value): what a read's byte budget counts. */
export function approxRowBytes(row: readonly unknown[]): number {
  let n = 2;
  for (const v of row) n += typeof v === 'string' ? v.length + 3 : v !== null && typeof v === 'object' ? JSON.stringify(v).length + 1 : 8;
  return n;
}

/** Rows a read returns at most (§7.5); the read says `truncated` past it. */
export const READ_MAX_ROWS = 5_000;

export interface SqlColumn {
  name: string;
  /** The source's type name (Postgres `format_type`, MySQL column type). */
  type: string;
}

export interface SqlDescribe {
  columns: SqlColumn[];
  /** The parameter types the source inferred, in order. */
  params: string[];
}

export interface SqlReadResult {
  columns: SqlColumn[];
  rows: unknown[][];
  truncated: boolean;
  ms: number;
}

/**
 * A failure from the source: its SQLSTATE (or MySQL error code) and class are safe to show an agent;
 * `message` is for the person only (a cast error can echo a value, §5.2).
 */
export class SourceQueryError extends Error {
  constructor(
    readonly sqlstate: string | null,
    readonly errorClass: 'timeout' | 'refused' | 'connection' | 'source',
    message: string,
    /** A dialer refusal's code (`address_unconfirmed`, …) when the dialer refused the connection. */
    readonly refusal: string | null = null,
  ) {
    super(message);
    this.name = 'SourceQueryError';
  }
}

export interface ReadOptions {
  deadlineMs?: number;
  maxRows?: number;
  /** (K2b) Stop reading once the rows held reach about this many bytes (`truncated`): the executor's 10 MB cap, applied while reading. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** SQLite: BLOB cells as `\x` hex (a person's own query), not null (an app's read). */
  blobsAsHex?: boolean;
  /** SQLite: text cells cut at this many characters (`…` after) before the byte budget counts them (a person's own query). */
  cellChars?: number;
  /**
   * (DES-APPS-001 rev 12 §5.4) An AGENT's query: on Postgres, parallel workers off and `work_mem` capped for
   * this transaction, so one permitted read takes less of the person's database.
   */
  agentLimits?: boolean;
  /**
   * TESTS ONLY: the source-side timeout, when it should differ from the deadline, so the client-side
   * cancel (Postgres cancel, MySQL KILL QUERY) is what stops the query. Production never sets it.
   */
  sourceTimeoutMs?: number;
}
