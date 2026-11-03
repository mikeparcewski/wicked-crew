/**
 * A source's catalog (DES-APPS-001 §5.1, §5.2 "what a model sees"): STRUCTURE only — names, types,
 * keys, row estimates, the enum literals the schema declares. Never a value read from a row.
 */

import type { PolicyCatalog, PolicyRelationKind } from '../policy/types.js';

export interface CatalogColumn {
  name: string;
  /** The source's own type text (`integer`, `character varying(80)`, `support.priority`). */
  type: string;
  nullable: boolean;
  /** Enum literals the schema declares for this column's type (Postgres enum, MySQL ENUM). */
  enumValues?: string[];
}

export interface CatalogForeignKey {
  name: string;
  columns: string[];
  references: { schema: string | null; table: string; columns: string[] };
}

export interface CatalogRelation {
  /** Postgres schema / MySQL database; `null` for SQLite. */
  schema: string | null;
  name: string;
  kind: PolicyRelationKind;
  /** The planner's estimate (Postgres `reltuples`, MySQL `table_rows`, SQLite exact count of the snapshot); `null` = unknown. */
  rowEstimate: number | null;
  columns: CatalogColumn[];
  primaryKey: string[];
  foreignKeys: CatalogForeignKey[];
  /** Postgres: row security enabled (or forced) on the table. */
  rowSecurity?: boolean;
}

export interface SqlCatalog {
  dialect: 'postgres' | 'mysql' | 'sqlite';
  /** Postgres/MySQL: the database the login is connected to. */
  database: string | null;
  relations: CatalogRelation[];
  describedAt: string;
}

/** The policy's view of a catalog: each relation's kind by qualified name, and the views allowed by name. */
export function policyCatalog(catalog: SqlCatalog, viewsAllowed: readonly string[] = []): PolicyCatalog {
  const relations = new Map<string, PolicyRelationKind>();
  for (const r of catalog.relations) relations.set(r.schema === null ? r.name : `${r.schema}.${r.name}`, r.kind);
  return { relations, viewsAllowed: new Set(viewsAllowed), defaultSchema: catalog.dialect === 'mysql' ? catalog.database : null };
}
