/**
 * The native adapter behind the gate (DES-KNOWLEDGE-DATA-001 §6.3): K1's Postgres driver, which the governed
 * Postgres path keeps. Everything K1 gives stays: the ONE dialer (every address checked, pinned), `verify-full`
 * TLS, the session's `default_transaction_read_only`, `search_path = pg_catalog, pg_temp` and
 * `statement_timeout` startup parameters, a `READ ONLY` transaction, the 10 s deadline at the source plus a
 * cancel, and the **locked, in-transaction relation checks** (`pgExpectRelations`), which Toolbox cannot give.
 *
 * What the gate adds here:
 * - the LIMIT rewrite (`cap + 1` rows, so the driver never buffers past the cap);
 * - for `unit`, the per-cell projection, built from what prepare reports INSIDE the read's transaction (after
 *   the relation locks are taken, so a column cannot change type between the describe and the read), and the
 *   rewritten text checked by the policy again before it runs;
 * - for `unit`, the agent session limits (no parallel workers, `work_mem` 16 MB).
 */

import type { SqlCatalog } from '../../sources/catalog/types.js';
import { policyCatalog } from '../../sources/catalog/types.js';
import { pgRead } from '../../sources/drivers/postgres.js';
import { type SqlColumn, type SqlConnectArgs, type SqlReadResult, SourceQueryError } from '../../sources/drivers/types.js';
import { expectations } from '../../sources/sql.js';
import { limitRewrite, projectedRewrite, recheckPg } from '../gate/pg.js';

export interface NativeReadRequest {
  connect: SqlConnectArgs;
  catalog: SqlCatalog;
  viewsAllowed: readonly string[];
  /** The agent's (or person's) statement, already admitted by the policy, cut out of its text. */
  statement: string;
  /** The relations the policy resolved (`relKey`s), for the live checks. */
  keys: readonly string[];
  params: unknown[];
  context: 'unit' | 'person';
  rowCap: number;
  /** `unit`: the per-cell cap at the source (characters). */
  cellChars: number;
  /** What the driver holds at most while reading (approximate bytes). */
  maxBytes: number;
  deadlineMs: number;
  /** TESTS ONLY: the source-side timeout, when it should differ from the deadline. */
  sourceTimeoutMs?: number;
  /** Tests and the probes: sees the exact text that runs. */
  onText?: (text: string) => void;
}

export interface NativeReadResult extends SqlReadResult {
  /** The text that ran (the rewrite), for the record's tests only; never answered to an agent. */
  text: string;
}

/** One read on a native Postgres source, through the rewrite. Throws `SourceQueryError` (class + SQLSTATE). */
export async function nativePgRead(r: NativeReadRequest): Promise<NativeReadResult> {
  const pc = policyCatalog(r.catalog, r.viewsAllowed);
  const handle = { driver: 'postgres' as const, connect: r.connect, catalog: r.catalog, viewsAllowed: r.viewsAllowed };
  const expect = expectations(handle, r.keys);
  let ran = '';
  if (r.context === 'person') {
    const text = limitRewrite(r.statement, r.rowCap);
    const ok = await recheckPg(text, pc);
    if (!ok.ok) throw new SourceQueryError(null, 'refused', ok.detail, 'rewrite');
    r.onText?.(text);
    const res = await pgRead(r.connect, text, r.params, {
      maxRows: r.rowCap,
      maxBytes: r.maxBytes,
      deadlineMs: r.deadlineMs,
      expect,
      ...(r.sourceTimeoutMs !== undefined ? { sourceTimeoutMs: r.sourceTimeoutMs } : {}),
    });
    return { ...res, text };
  }
  const res = await pgRead(r.connect, r.statement, r.params, {
    maxRows: r.rowCap,
    maxBytes: r.maxBytes,
    deadlineMs: r.deadlineMs,
    agentLimits: true,
    expect,
    ...(r.sourceTimeoutMs !== undefined ? { sourceTimeoutMs: r.sourceTimeoutMs } : {}),
    shape: async (described: SqlColumn[]) => {
      const text = projectedRewrite(r.statement, described.map((c) => c.type), r.rowCap, r.cellChars);
      const ok = await recheckPg(text, pc);
      if (!ok.ok) throw new SourceQueryError(null, 'refused', ok.detail, 'rewrite');
      ran = text;
      r.onText?.(text);
      return text;
    },
  });
  return { ...res, text: ran };
}
