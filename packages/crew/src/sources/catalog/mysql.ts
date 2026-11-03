/**
 * The MySQL catalog (DES-APPS-001 §5.1): `information_schema` for the connected database only —
 * tables and views with their row estimates, columns with types and the `ENUM` lists they declare,
 * primary and foreign keys. Structure only; read-only session (drivers/mysql.ts).
 */

import { drop, mysqlConnect, mysqlError, mysqlRelationKind } from '../drivers/mysql.js';
import type { SqlConnectArgs } from '../drivers/types.js';
import type { CatalogRelation, SqlCatalog } from './types.js';

function enumValues(columnType: string): string[] | undefined {
  const m = /^enum\(([\s\S]*)\)$/i.exec(columnType);
  if (m === null) return undefined;
  const out: string[] = [];
  for (const v of (m[1] as string).matchAll(/'((?:[^']|'')*)'/g)) out.push((v[1] as string).replace(/''/g, "'"));
  return out;
}

export async function describeMysql(args: SqlConnectArgs): Promise<SqlCatalog> {
  const conn = await mysqlConnect(args);
  try {
    const db = args.source.database;
    const [tables] = (await conn.execute(
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_est FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db],
    )) as unknown as [Array<{ name: string; type: string; engine: string | null; rows_est: string | number | null }>];
    const [cols] = (await conn.execute(
      'SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
      [db],
    )) as unknown as [Array<{ tbl: string; name: string; type: string; nullable: string }>];
    const [keys] = (await conn.execute(
      `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rschema, k.REFERENCED_TABLE_NAME AS rtable,
              k.REFERENCED_COLUMN_NAME AS rcol, t.CONSTRAINT_TYPE AS ctype
         FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.TABLE_CONSTRAINTS t
           ON t.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND t.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND t.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [db],
    )) as unknown as [Array<{ tbl: string; name: string; col: string; rschema: string | null; rtable: string | null; rcol: string | null; ctype: string }>];
    const byName = new Map<string, CatalogRelation>();
    const relations: CatalogRelation[] = tables.map((t) => {
      // A FEDERATED (or unknown-engine) table reads another server: it is described as foreign, never read.
      const k = mysqlRelationKind(t.type, t.engine);
      const rel: CatalogRelation = {
        schema: db,
        name: t.name,
        kind: k === 'other' ? 'foreign' : k,
        rowEstimate: t.rows_est === null ? null : Number(t.rows_est),
        columns: [],
        primaryKey: [],
        foreignKeys: [],
      };
      byName.set(t.name, rel);
      return rel;
    });
    for (const c of cols) {
      const rel = byName.get(c.tbl);
      if (rel === undefined) continue;
      const ev = enumValues(c.type);
      rel.columns.push({ name: c.name, type: c.type, nullable: c.nullable === 'YES', ...(ev !== undefined ? { enumValues: ev } : {}) });
    }
    for (const k of keys) {
      const rel = byName.get(k.tbl);
      if (rel === undefined) continue;
      if (k.ctype === 'PRIMARY KEY') rel.primaryKey.push(k.col);
      else {
        let fk = rel.foreignKeys.find((f) => f.name === k.name);
        if (fk === undefined) {
          fk = { name: k.name, columns: [], references: { schema: k.rschema, table: k.rtable ?? '', columns: [] } };
          rel.foreignKeys.push(fk);
        }
        fk.columns.push(k.col);
        if (k.rcol !== null) fk.references.columns.push(k.rcol);
      }
    }
    return { dialect: 'mysql', database: db, relations, describedAt: new Date().toISOString() };
  } catch (err) {
    throw mysqlError(err);
  } finally {
    drop(conn);
  }
}
