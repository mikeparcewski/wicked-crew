/** Shared shapes of the read policy (DES-APPS-001 §5.3). */

/** How a relation of the described catalog may be read. */
export type PolicyRelationKind = 'table' | 'partitioned' | 'view' | 'matview' | 'foreign';

/**
 * What the policy needs of a source's catalog, and nothing more: each relation by qualified name
 * (`schema.table`; for MySQL `database.table`) with its kind, and the views the person allowed by name.
 */
export interface PolicyCatalog {
  /** Keyed by {@link relKey} (schema and name kept apart: `"a.b".c` and `a."b.c"` are different). */
  relations: ReadonlyMap<string, PolicyRelationKind>;
  /** Each relation's column names, by {@link relKey}: a qualified reference must name a real column. */
  columns?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Postgres: relations with a foreign table among their partitions or inheritance children. */
  foreignDescendants?: ReadonlySet<string>;
  /** The views allowed by name, by {@link relKey}. */
  viewsAllowed: ReadonlySet<string>;
  /** MySQL: the connection's database, which an unqualified table name means. */
  defaultSchema?: string | null;
}

/** A relation's unambiguous key: schema and name joined by NUL (no identifier holds one). */
export function relKey(schema: string | null, name: string): string {
  return schema === null ? name : `${schema}\u0000${name}`;
}

/** A relation as written in SQL: `"schema"."name"` (quoted, so it is unambiguous too). */
export function relLabel(key: string): string {
  return key
    .split('\u0000')
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join('.');
}

export type PolicyResult =
  | {
      ok: true;
      /** The relations read, as `"schema"."name"`. */
      relations: string[];
      /** The same relations by {@link relKey} (for the live check before a read). */
      keys?: string[];
      functions: string[];
      /** The highest positional parameter (Postgres `$n`), or the count of `?` (MySQL). */
      params: number;
    }
  | {
      ok: false;
      /** A stable class of refusal (`not_select`, `function`, `cast`, `relation`, `view`, …). */
      code: string;
      /** Words for the person and the agent: what was refused and why. Never a value from a row. */
      detail: string;
    };
