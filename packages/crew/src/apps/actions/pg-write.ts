/**
 * Postgres row writes (DES-APPS-001 §7.4 rev 11): the generated statement and the run.
 *
 * The statement: `ONLY`, every identifier quoted, every parameter cast to its column's BASE type
 * (`"pg_catalog"."int4"`, `"s"."prio"`), and a `RETURNING` of the written relation's row type
 * (`pg_typeof("w".*)`: the starred form, never the bare alias, P43), one flag per key column and one per
 * written column, each comparing at the base type (P20).
 *
 * The run, on a FRESH connection opened for this write and closed after it:
 *
 *   BEGIN ISOLATION LEVEL READ COMMITTED;
 *   SET LOCAL search_path = pg_catalog, pg_temp; statement_timeout 10s; lock_timeout 3s;
 *   refuse unless session_replication_role = 'origin'                                  (P26)
 *   T := '"s"."t"'::regclass, R := T's row type
 *   LOCK TABLE ONLY "s"."t" IN SHARE ROW EXCLUSIVE MODE; this backend holds it on T     (P9, P41)
 *   the table safety check BY T's OID, equal to the GRANTED fingerprint                  (P23)
 *   SET CONSTRAINTS ALL IMMEDIATE                                                        (P27)
 *   the statement → exactly 1 row, row type R, every flag true                           (P3, P5, P20, P30, P38, P43)
 *   COMMIT — or ROLLBACK, `failed` with the reason
 *
 * The outcome: committed and verified = `succeeded`; any refusal or rollback = `failed` (nothing written);
 * COMMIT sent and no answer = `unknown`.
 */

import type postgres from 'postgres';

import { pgClient } from '../../sources/drivers/postgres.js';
import type { SqlConnectArgs } from '../../sources/drivers/types.js';
import { pgTableSafetyIn, type SafetyColumn } from '../../sources/safety/postgres.js';
import { baseTypeSql } from './pg-fit.js';

type Tx = postgres.TransactionSql<Record<string, never>>;

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
export const qualifiedTable = (schema: string, table: string): string => `${ident(schema)}.${ident(table)}`;

export interface GeneratedStatement {
  text: string;
  /** Which value each `$n` carries: a set column, or a key column. */
  slots: Array<{ role: 'set' | 'key'; column: string }>;
  /** How many `ok` / key flags the statement returns. */
  flags: number;
}

/**
 * The one statement for a declared write. `set` and `key` are column names in a fixed order (the values
 * follow the slots); `columns` gives each one's base type.
 */
export function generateStatement(input: { schema: string; table: string; op: 'insert' | 'update' | 'delete'; set: readonly string[]; key: readonly string[]; columns: readonly SafetyColumn[] }): GeneratedStatement {
  const col = (n: string): SafetyColumn => {
    const c = input.columns.find((x) => x.name === n);
    if (c === undefined) throw new Error(`no column ${n}`);
    return c;
  };
  const t = qualifiedTable(input.schema, input.table);
  const slots: GeneratedStatement['slots'] = [];
  const param = (role: 'set' | 'key', column: string): string => {
    slots.push({ role, column });
    return `$${slots.length}::${baseTypeSql(col(column))}`;
  };
  const flags: string[] = [];
  const rowtype = 'pg_catalog.pg_typeof("w".*)::pg_catalog.oid::pg_catalog.int8::pg_catalog.text AS "rowtype"';
  let text: string;
  if (input.op === 'update') {
    const sets = input.set.map((c) => `${ident(c)} = ${param('set', c)}`);
    const where = input.key.map((k) => `"w".${ident(k)} = ${param('key', k)}`);
    input.key.forEach((k, i) => flags.push(`("w".${ident(k)} IS NOT DISTINCT FROM $${input.set.length + i + 1}::${baseTypeSql(col(k))}) AS "k${i}"`));
    input.set.forEach((c, i) => flags.push(`("w".${ident(c)} IS NOT DISTINCT FROM $${i + 1}::${baseTypeSql(col(c))}) AS "v${i}"`));
    text = `UPDATE ONLY ${t} AS "w" SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING ${[rowtype, ...flags].join(', ')}`;
  } else if (input.op === 'insert') {
    const values = input.set.map((c) => param('set', c));
    input.set.forEach((c, i) => flags.push(`("w".${ident(c)} IS NOT DISTINCT FROM $${i + 1}::${baseTypeSql(col(c))}) AS "v${i}"`));
    text = `INSERT INTO ${t} AS "w" (${input.set.map(ident).join(', ')}) VALUES (${values.join(', ')}) RETURNING ${[rowtype, ...flags].join(', ')}`;
  } else {
    const where = input.key.map((k) => `"w".${ident(k)} = ${param('key', k)}`);
    input.key.forEach((k, i) => flags.push(`("w".${ident(k)} IS NOT DISTINCT FROM $${i + 1}::${baseTypeSql(col(k))}) AS "k${i}"`));
    text = `DELETE FROM ONLY ${t} AS "w" WHERE ${where.join(' AND ')} RETURNING ${[rowtype, ...flags].join(', ')}`;
  }
  return { text, slots, flags: flags.length };
}

export type WriteOutcome = { state: 'succeeded'; ms: number } | { state: 'failed' | 'unknown'; reason: string; ms: number };

/** TESTS ONLY: a hook between the safety check under the lock and the statement (a race seam: P30, P38, P43). */
export interface WriteHooks {
  /** After every recheck, before the write's transaction begins (a change here is the lock's to find). */
  beforeBegin?: () => Promise<void>;
  afterLock?: () => Promise<void>;
  afterCheck?: () => Promise<void>;
}

/** Run one prepared row write. Never throws: every path ends in an outcome. */
export async function runRowWrite(
  args: SqlConnectArgs,
  w: { schema: string; table: string; op: 'insert' | 'update' | 'delete'; set: readonly string[]; key: readonly string[]; statement: string; values: ReadonlyArray<string | null>; fingerprint: string },
  hooks: WriteHooks = {},
): Promise<WriteOutcome> {
  const started = Date.now();
  const ended = new AbortController();
  const sql = pgClient(args, { readOnly: false, deadlineMs: 10_000, signal: ended.signal });
  const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => sql.unsafe<T[]>(text, params as never) as unknown as Promise<T[]>;
  const ms = (): number => Date.now() - started;
  let commitSent = false;
  let open = false;
  const fail = async (reason: string): Promise<WriteOutcome> => {
    if (open) await q('ROLLBACK').catch(() => undefined);
    open = false;
    return { state: 'failed', reason, ms: ms() };
  };
  // A client guard past the server's own timeouts: before COMMIT the transaction cannot commit without us.
  const guard = setTimeout(() => {
    void sql.end({ timeout: 0 }).catch(() => undefined);
    ended.abort();
  }, 20_000);
  try {
    await hooks.beforeBegin?.();
    await q('BEGIN ISOLATION LEVEL READ COMMITTED');
    open = true;
    await q("SET LOCAL search_path = pg_catalog, pg_temp");
    await q("SET LOCAL statement_timeout = '10s'");
    await q("SET LOCAL lock_timeout = '3s'");
    const [role] = await q<{ role: string }>("SELECT pg_catalog.current_setting('session_replication_role') AS role");
    if (role?.role !== 'origin') return await fail(`this login's session_replication_role is ${role?.role ?? 'unknown'}, which turns off foreign-key enforcement: writes need origin (P26)`);
    const name = qualifiedTable(w.schema, w.table);
    const [t] = await q<{ oid: string; reltype: string }>(
      'SELECT c.oid::pg_catalog.int8::pg_catalog.text AS oid, c.reltype::pg_catalog.int8::pg_catalog.text AS reltype FROM pg_catalog.pg_class c WHERE c.oid = $1::pg_catalog.text::pg_catalog.regclass',
      [name],
    );
    if (t === undefined) return await fail(`${w.schema}.${w.table} does not exist`);
    await q(`LOCK TABLE ONLY ${name} IN SHARE ROW EXCLUSIVE MODE`);
    // The name may have moved between resolving it and locking it: the lock must be on T.
    const [held] = await q<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks l WHERE l.locktype = 'relation' AND l.relation = $1::pg_catalog.text::pg_catalog.oid
                 AND l.pid = pg_catalog.pg_backend_pid() AND l.mode = 'ShareRowExclusiveLock' AND l.granted) AS held`,
      [t.oid],
    );
    if (held?.held !== true) return await fail(`${w.schema}.${w.table} was replaced while it was being locked; nothing was written`);
    await hooks.afterLock?.();
    const safety = await pgTableSafetyIn(sql as unknown as Tx, w.schema, w.table, { op: w.op, set: [...w.set], key: [...w.key] }, { oid: t.oid });
    if (!safety.safe) return await fail(`the table no longer passes the safety check: ${safety.reasons.map((r) => r.detail).join('; ')}`);
    if (safety.fingerprint !== w.fingerprint) return await fail(`${w.schema}.${w.table} changed since the action was granted (its safety fingerprint differs); nothing was written`);
    await hooks.afterCheck?.();
    await q('SET CONSTRAINTS ALL IMMEDIATE');
    const rows = await q<Record<string, unknown>>(w.statement, [...w.values]);
    if (rows.length === 0) return await fail('no such row (it does not exist, or row security hides it); nothing was written');
    if (rows.length !== 1) return await fail(`the statement reported ${rows.length} rows, not exactly 1; rolled back`);
    const row = rows[0]!;
    if (String(row['rowtype']) !== t.reltype) return await fail('the statement wrote a relation other than the table that was locked and checked (its row type differs); rolled back');
    const bad = Object.entries(row).filter(([k, v]) => k !== 'rowtype' && v !== true).map(([k]) => k);
    if (bad.length > 0) return await fail(`the database changed a value on the way in or the key did not match (${bad.join(', ')}); rolled back`);
    commitSent = true;
    await q('COMMIT');
    open = false;
    return { state: 'succeeded', ms: ms() };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const sqlstate = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
    if (commitSent) {
      // The server answered the COMMIT with an error: it rolled back. No answer at all: not known.
      if (sqlstate !== null) return { state: 'failed', reason: `the database refused the commit (SQLSTATE ${sqlstate}); nothing was written`, ms: ms() };
      return { state: 'unknown', reason: 'the connection was lost after COMMIT was sent: whether the row changed is not known; check the source. It is not run again', ms: ms() };
    }
    const why = sqlstate === '55P03' ? 'the table is busy (lock timeout)' : sqlstate === '57014' ? 'the write ran past its deadline' : sqlstate === '42501' ? "the login lacks a privilege the write needs (see the source's privilege report)" : sqlstate !== null ? `the database refused it (SQLSTATE ${sqlstate})` : 'the connection failed';
    return await fail(`${why}; nothing was written`);
  } finally {
    clearTimeout(guard);
    await sql.end({ timeout: 1 }).catch(() => undefined);
    ended.abort();
  }
}
