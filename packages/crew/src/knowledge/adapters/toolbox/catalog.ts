/**
 * A Toolbox source's structure, as the read policy needs it (DES-KNOWLEDGE-DATA-001 §6.1, §6.3): Toolbox's own
 * `list_tables` (detailed) mapped to crew's `SqlCatalog`, plus ONE fixed crew query for the relations a plain
 * read would carry into a foreign table (Toolbox does not report them). Structure only: names, types, keys.
 *
 * `list_tables` lists base and partitioned tables (relkind `r`, `p`), never views or foreign tables, so neither
 * is readable on this runtime. The residual, as §6.3 states it: this allowlist is the stored catalog, not a
 * lock, so a relation that changed kind since the describe is not caught before the read; the boundary there
 * is the read-only login plus the source's read-only session.
 */

import type { CatalogRelation, SqlCatalog } from '../../../sources/catalog/types.js';
import { toolboxRows, type ToolboxResult } from './supervisor.js';

/** The relations with a foreign table among their partitions or inheritance children. */
export const FOREIGN_BELOW_SQL = `WITH RECURSIVE d(root, child) AS (
  SELECT i.inhparent, i.inhrelid FROM pg_catalog.pg_inherits i
  UNION SELECT d.root, i.inhrelid FROM d JOIN pg_catalog.pg_inherits i ON i.inhparent = d.child
)
SELECT DISTINCT n.nspname::text AS schema_name, p.relname::text AS table_name
  FROM d JOIN pg_catalog.pg_class c ON c.oid = d.child JOIN pg_catalog.pg_class p ON p.oid = d.root
  JOIN pg_catalog.pg_namespace n ON n.oid = p.relnamespace
 WHERE c.relkind = 'f'`;

interface ListedTable {
  schema_name?: unknown;
  object_name?: unknown;
  object_type?: unknown;
  columns?: Array<{ column_name?: unknown; data_type?: unknown; is_not_nullable?: unknown; ordinal_position?: unknown }>;
  constraints?: Array<{ constraint_type?: unknown; constraint_columns?: unknown; constraint_name?: unknown; foreign_key_referenced_table?: unknown; foreign_key_referenced_columns?: unknown }>;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** `schema.table` as `regclass` prints it (quoted parts when needed), split back into its parts. */
export function splitQualified(v: string): { schema: string | null; table: string } {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i] as string;
    if (quoted) {
      if (ch === '"' && v[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === '.') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.length >= 2 ? { schema: parts[parts.length - 2] as string, table: parts[parts.length - 1] as string } : { schema: null, table: parts[0] as string };
}

/** Toolbox's `list_tables` answer and the foreign-below rows as a crew catalog. */
export function toolboxCatalog(listed: ToolboxResult, foreignBelow: ToolboxResult, describedAt: string): SqlCatalog {
  const foreign = new Set(toolboxRows(foreignBelow).map((r) => `${String(r['schema_name'])}\u0000${String(r['table_name'])}`));
  const relations: CatalogRelation[] = [];
  for (const row of toolboxRows(listed)) {
    const raw = row['object_details'];
    const t = (typeof raw === 'string' ? (JSON.parse(raw) as ListedTable) : (raw as ListedTable | undefined)) ?? {};
    const schema = typeof t.schema_name === 'string' ? t.schema_name : typeof row['schema_name'] === 'string' ? row['schema_name'] : null;
    const name = typeof t.object_name === 'string' ? t.object_name : typeof row['object_name'] === 'string' ? row['object_name'] : null;
    if (schema === null || name === null) continue;
    const kind = t.object_type === 'PARTITIONED TABLE' ? 'partitioned' : 'table';
    const columns = [...(t.columns ?? [])]
      .sort((a, b) => Number(a.ordinal_position ?? 0) - Number(b.ordinal_position ?? 0))
      .filter((c) => typeof c.column_name === 'string')
      .map((c) => ({ name: c.column_name as string, type: typeof c.data_type === 'string' ? c.data_type : 'unknown', nullable: c.is_not_nullable !== true }));
    const cons = t.constraints ?? [];
    const pk = cons.find((c) => c.constraint_type === 'PRIMARY KEY');
    relations.push({
      schema,
      name,
      kind,
      rowEstimate: null,
      columns,
      primaryKey: pk === undefined ? [] : strs(pk.constraint_columns),
      foreignKeys: cons
        .filter((c) => c.constraint_type === 'FOREIGN KEY' && typeof c.foreign_key_referenced_table === 'string')
        .map((c) => {
          const ref = splitQualified(c.foreign_key_referenced_table as string);
          return { name: typeof c.constraint_name === 'string' ? c.constraint_name : '', columns: strs(c.constraint_columns), references: { schema: ref.schema, table: ref.table, columns: strs(c.foreign_key_referenced_columns) } };
        }),
      ...(foreign.has(`${schema}\u0000${name}`) ? { foreignDescendant: true } : {}),
    });
  }
  return { dialect: 'postgres', database: null, relations, describedAt };
}
