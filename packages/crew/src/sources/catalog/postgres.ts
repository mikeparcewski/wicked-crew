/**
 * The Postgres catalog and privilege report (DES-APPS-001 §5.1, §7.4 "the writer login").
 *
 * Read from `pg_catalog` only, every name schema-qualified, under `search_path = pg_catalog,
 * pg_temp` (drivers/postgres.ts), in a READ ONLY transaction. Structure only: relations the login can
 * see in user schemas, their columns and types, keys, `reltuples` estimates, row-security flags and
 * enum labels. No row is read.
 *
 * The privilege report says what the login can read and change, whether it is read-only, and for
 * each declared row write the EXACT `GRANT` statements still missing (§7.4 rev 11): `USAGE` on the
 * schema; table-level `SELECT` (the returned row type reads the whole row, P36, which covers the key
 * and written columns); table-level `UPDATE` for every row write (the `SHARE ROW EXCLUSIVE` lock
 * needs it, P11/P42); and `INSERT` or `DELETE` for those operations.
 */

import type postgres from 'postgres';

import { pgReadOnly } from '../drivers/postgres.js';
import type { SqlConnectArgs } from '../drivers/types.js';
import type { PolicyRelationKind } from '../policy/types.js';
import type { CatalogRelation, SqlCatalog } from './types.js';

type Tx = postgres.TransactionSql<Record<string, never>>;

const RELKIND: Record<string, PolicyRelationKind> = { r: 'table', p: 'partitioned', v: 'view', m: 'matview', f: 'foreign' };

/** Quote an identifier for a generated statement (double quotes, doubled inside). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const USER_SCHEMAS = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_'";

/** Describe the catalog inside an open read-only transaction. */
export async function describePgIn(tx: Tx): Promise<SqlCatalog> {
  const db = await tx.unsafe<Array<{ db: string }>>('SELECT pg_catalog.current_database() AS db');
  const rels = await tx.unsafe<Array<{ oid: string; schema: string; name: string; relkind: string; reltuples: number | null; rls: boolean }>>(
    `SELECT c.oid::pg_catalog.int8::pg_catalog.text AS oid, n.nspname AS schema, c.relname AS name, c.relkind::pg_catalog.text AS relkind,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::pg_catalog.float8 END AS reltuples,
            (c.relrowsecurity OR c.relforcerowsecurity) AS rls
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${USER_SCHEMAS}
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      ORDER BY n.nspname, c.relname`,
  );
  const cols = await tx.unsafe<Array<{ rel: string; name: string; type: string; notnull: boolean; typtype: string; typid: string }>>(
    `SELECT a.attrelid::pg_catalog.int8::pg_catalog.text AS rel, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS notnull, t.typtype::pg_catalog.text AS typtype, a.atttypid::pg_catalog.int8::pg_catalog.text AS typid
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND ${USER_SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`,
  );
  const enums = await tx.unsafe<Array<{ typid: string; label: string }>>(
    `SELECT e.enumtypid::pg_catalog.int8::pg_catalog.text AS typid, e.enumlabel AS label FROM pg_catalog.pg_enum e ORDER BY e.enumtypid, e.enumsortorder`,
  );
  const keys = await tx.unsafe<Array<{ rel: string; name: string; contype: string; cols: string[]; frel: string | null; fschema: string | null; ftable: string | null; fcols: string[] | null }>>(
    `SELECT k.conrelid::pg_catalog.int8::pg_catalog.text AS rel, k.conname AS name, k.contype::pg_catalog.text AS contype,
            pg_catalog.array_to_json(ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.conkey) WITH ORDINALITY u(n, i) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i)) AS cols,
            k.confrelid::pg_catalog.int8::pg_catalog.text AS frel, fn.nspname AS fschema, fc.relname AS ftable,
            pg_catalog.array_to_json(ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.confkey) WITH ORDINALITY u(n, i) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.i)) AS fcols
       FROM pg_catalog.pg_constraint k
       JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_class fc ON fc.oid = k.confrelid LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE k.contype IN ('p', 'f') AND ${USER_SCHEMAS}`,
  );
  // Relations whose partitions or inheritance children (at any depth) include a foreign table: a plain
  // read of them reaches it (crew's own query; recursion is fine here).
  const foreignBelow = await tx.unsafe<Array<{ rel: string }>>(
    `WITH RECURSIVE d(root, child) AS (
       SELECT i.inhparent, i.inhrelid FROM pg_catalog.pg_inherits i
       UNION SELECT d.root, i.inhrelid FROM d JOIN pg_catalog.pg_inherits i ON i.inhparent = d.child
     )
     SELECT DISTINCT d.root::pg_catalog.int8::pg_catalog.text AS rel FROM d JOIN pg_catalog.pg_class c ON c.oid = d.child WHERE c.relkind = 'f'`,
  );
  const foreignRoots = new Set(foreignBelow.map((r) => r.rel));
  const enumLabels = new Map<string, string[]>();
  for (const e of enums) enumLabels.set(e.typid, [...(enumLabels.get(e.typid) ?? []), e.label]);
  const byOid = new Map<string, CatalogRelation>();
  const relations: CatalogRelation[] = rels.map((r) => {
    const rel: CatalogRelation = {
      schema: r.schema,
      name: r.name,
      kind: RELKIND[r.relkind] ?? 'table',
      rowEstimate: r.reltuples === null ? null : Math.round(Number(r.reltuples)),
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      rowSecurity: r.rls,
      ...(foreignRoots.has(r.oid) ? { foreignDescendant: true } : {}),
    };
    byOid.set(r.oid, rel);
    return rel;
  });
  for (const c of cols) {
    const rel = byOid.get(c.rel);
    if (rel === undefined) continue;
    rel.columns.push({ name: c.name, type: c.type, nullable: !c.notnull, ...(c.typtype === 'e' ? { enumValues: enumLabels.get(c.typid) ?? [] } : {}) });
  }
  for (const k of keys) {
    const rel = byOid.get(k.rel);
    if (rel === undefined) continue;
    if (k.contype === 'p') rel.primaryKey = k.cols;
    else rel.foreignKeys.push({ name: k.name, columns: k.cols, references: { schema: k.fschema, table: k.ftable ?? '', columns: k.fcols ?? [] } });
  }
  return { dialect: 'postgres', database: db[0]?.db ?? null, relations, describedAt: new Date().toISOString() };
}

/** Describe a Postgres source's catalog (structure only). */
export async function describePg(args: SqlConnectArgs): Promise<SqlCatalog> {
  return pgReadOnly(args, (tx) => describePgIn(tx));
}

// ── The privilege report ─────────────────────────────────────────────────────────────────────

export type RowWriteOp = 'insert' | 'update' | 'delete';

/** A row write as declared (DES §7.4), for the report: which table, which operation, which columns. */
export interface DeclaredRowWrite {
  schema: string;
  table: string;
  op: RowWriteOp;
  /** Columns the write sets (update: the written columns; insert: every column). */
  set: string[];
  /** The key columns (every primary-key column). */
  key: string[];
}

export interface TablePrivileges {
  schema: string;
  table: string;
  select: boolean;
  /** Some column is readable (column-level SELECT), even without table-level SELECT. */
  selectSomeColumns: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

export interface RowWriteGrants {
  write: DeclaredRowWrite;
  /** The exact GRANT statements the login still needs for this write; empty = none. */
  missing: string[];
}

export interface PgPrivilegeReport {
  login: string;
  superuser: boolean;
  /** No table-level or column-level INSERT/UPDATE/DELETE/TRUNCATE on any visible table, and not a superuser. */
  readOnly: boolean;
  tables: TablePrivileges[];
  writes: RowWriteGrants[];
}

/** The privilege report inside an open read-only transaction. */
export async function pgPrivilegesIn(tx: Tx, writes: readonly DeclaredRowWrite[] = []): Promise<PgPrivilegeReport> {
  const who = await tx.unsafe<Array<{ login: string; superuser: boolean }>>(
    `SELECT current_user::pg_catalog.text AS login, r.rolsuper AS superuser FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`,
  );
  const tables = await tx.unsafe<Array<TablePrivileges & { anyWrite: boolean }>>(
    `SELECT n.nspname AS schema, c.relname AS "table",
            pg_catalog.has_table_privilege(c.oid, 'SELECT') AS select,
            pg_catalog.has_any_column_privilege(c.oid, 'SELECT') AS "selectSomeColumns",
            pg_catalog.has_table_privilege(c.oid, 'INSERT') AS insert,
            pg_catalog.has_table_privilege(c.oid, 'UPDATE') AS update,
            pg_catalog.has_table_privilege(c.oid, 'DELETE') AS delete,
            (pg_catalog.has_any_column_privilege(c.oid, 'INSERT') OR pg_catalog.has_any_column_privilege(c.oid, 'UPDATE')
              OR pg_catalog.has_table_privilege(c.oid, 'DELETE') OR pg_catalog.has_table_privilege(c.oid, 'TRUNCATE')) AS "anyWrite"
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND ${USER_SCHEMAS} AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      ORDER BY n.nspname, c.relname`,
  );
  const login = who[0]?.login ?? '';
  const superuser = who[0]?.superuser === true;
  const out: RowWriteGrants[] = [];
  for (const w of writes) {
    const rows = await tx.unsafe<Array<{ usage: boolean | null; select: boolean | null; update: boolean | null; insert: boolean | null; delete: boolean | null }>>(
      `SELECT pg_catalog.has_schema_privilege(n.oid, 'USAGE') AS usage,
              pg_catalog.has_table_privilege(c.oid, 'SELECT') AS select, pg_catalog.has_table_privilege(c.oid, 'UPDATE') AS update,
              pg_catalog.has_table_privilege(c.oid, 'INSERT') AS insert, pg_catalog.has_table_privilege(c.oid, 'DELETE') AS delete
         FROM pg_catalog.pg_namespace n LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = $2
        WHERE n.nspname = $1`,
      [w.schema, w.table],
    );
    const p = rows[0];
    const table = `${quoteIdent(w.schema)}.${quoteIdent(w.table)}`;
    const to = quoteIdent(login);
    const missing: string[] = [];
    if (p === undefined) {
      missing.push(`-- the schema ${w.schema} does not exist or is not visible to ${login}`);
    } else {
      if (p.usage !== true) missing.push(`GRANT USAGE ON SCHEMA ${quoteIdent(w.schema)} TO ${to};`);
      if (p.select !== true) missing.push(`GRANT SELECT ON TABLE ${table} TO ${to};`);
      if (p.update !== true) missing.push(`GRANT UPDATE ON TABLE ${table} TO ${to};`);
      if (w.op === 'insert' && p.insert !== true) missing.push(`GRANT INSERT ON TABLE ${table} TO ${to};`);
      if (w.op === 'delete' && p.delete !== true) missing.push(`GRANT DELETE ON TABLE ${table} TO ${to};`);
    }
    out.push({ write: w, missing });
  }
  return {
    login,
    superuser,
    readOnly: !superuser && tables.every((t) => !t.anyWrite),
    tables: tables.map((t) => ({ schema: t.schema, table: t.table, select: t.select, selectSomeColumns: t.selectSomeColumns, insert: t.insert, update: t.update, delete: t.delete })),
    writes: out,
  };
}

/** The privilege report for a Postgres source's login. */
export async function pgPrivileges(args: SqlConnectArgs, writes: readonly DeclaredRowWrite[] = []): Promise<PgPrivilegeReport> {
  return pgReadOnly(args, (tx) => pgPrivilegesIn(tx, writes));
}
