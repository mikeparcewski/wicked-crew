/**
 * A source's catalog (DES-APPS-001 §5.1, §5.2 "what a model sees"): STRUCTURE only — names, types,
 * keys, row estimates, the enum literals the schema declares. Never a value read from a row.
 */

import { type PolicyCatalog, type PolicyRelationKind, relKey } from '../policy/types.js';

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
  /** Postgres: a foreign table is among its partitions or inheritance children (a plain read reaches it). */
  foreignDescendant?: boolean;
}

export interface SqlCatalog {
  dialect: 'postgres' | 'mysql' | 'sqlite';
  /** Postgres/MySQL: the database the login is connected to. */
  database: string | null;
  relations: CatalogRelation[];
  describedAt: string;
}

/**
 * The policy's view of a catalog: each relation's kind and columns by {@link relKey}, the relations a
 * plain read would carry into a foreign table, and the views allowed by name (`schema.view`, as the
 * source config names them; a name holding a dot cannot be allowed).
 */
export function policyCatalog(catalog: SqlCatalog, viewsAllowed: readonly string[] = []): PolicyCatalog {
  const relations = new Map<string, PolicyRelationKind>();
  const columns = new Map<string, ReadonlySet<string>>();
  const foreignDescendants = new Set<string>();
  for (const r of catalog.relations) {
    const k = relKey(r.schema, r.name);
    relations.set(k, r.kind);
    columns.set(k, new Set(r.columns.map((c) => c.name)));
    if (r.foreignDescendant === true) foreignDescendants.add(k);
  }
  const views = new Set<string>();
  for (const v of viewsAllowed) {
    const dot = v.indexOf('.');
    if (dot > 0) views.add(relKey(v.slice(0, dot), v.slice(dot + 1)));
  }
  return { relations, columns, foreignDescendants, viewsAllowed: views, defaultSchema: catalog.dialect === 'mysql' ? catalog.database : null };
}
