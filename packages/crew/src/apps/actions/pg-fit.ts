/**
 * The exact-fit check (DES-APPS-001 §7.4 "Values must fit exactly", P28): the database itself is asked, in a
 * READ ONLY transaction and before any card is shown, whether each value survives its column's FULL type
 * (its typmod: `numeric(3,1)`, `varchar(3)`, `timestamp(0)`), compared at the base type. A value the column
 * would round or truncate, or that its type refuses, is refused by name ("1.24 does not fit amount
 * numeric(3,1)").
 */

import type postgres from 'postgres';

import type { SafetyColumn } from '../../sources/safety/postgres.js';

type Tx = postgres.TransactionSql<Record<string, never>>;

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** A column's BASE type as SQL: `"pg_catalog"."int4"`, `"s"."prio"` (quoted, schema-qualified). */
export function baseTypeSql(c: Pick<SafetyColumn, 'typschema' | 'typname'>): string {
  return `${ident(c.typschema)}.${ident(c.typname)}`;
}

export interface FitItem {
  column: string;
  /** The column's full type, as `format_type` printed it under `search_path = pg_catalog, pg_temp`. */
  full: string;
  base: string;
  /** The value's input-form text. */
  text: string;
}

/** Each item that does not fit, with why; empty = all fit. One savepoint per item: a refused input aborts only its own. */
export async function pgExactFitIn(tx: Tx, items: readonly FitItem[]): Promise<Array<{ column: string; why: string }>> {
  const misfits: Array<{ column: string; why: string }> = [];
  for (const it of items) {
    await tx.unsafe('SAVEPOINT k2b_fit');
    try {
      const rows = await tx.unsafe<Array<{ ok: boolean }>>(`SELECT ((($1::pg_catalog.text)::${it.full})::${it.base} IS NOT DISTINCT FROM ($1::pg_catalog.text)::${it.base}) AS ok`, [it.text] as never);
      await tx.unsafe('RELEASE SAVEPOINT k2b_fit');
      if (rows[0]?.ok !== true) misfits.push({ column: it.column, why: `does not fit ${it.column} ${it.full} (the column would change it)` });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      // Only an answer from the server is a value the type refused; anything else is the transport's.
      if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) throw err;
      await tx.unsafe('ROLLBACK TO SAVEPOINT k2b_fit');
      misfits.push({ column: it.column, why: `is not a value of ${it.column} ${it.full} (SQLSTATE ${code})` });
    }
  }
  return misfits;
}
