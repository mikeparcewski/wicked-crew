/** Shared shapes of the read policy (DES-APPS-001 §5.3). */

/** How a relation of the described catalog may be read. */
export type PolicyRelationKind = 'table' | 'partitioned' | 'view' | 'matview' | 'foreign';

/**
 * What the policy needs of a source's catalog, and nothing more: each relation by qualified name
 * (`schema.table`; for MySQL `database.table`) with its kind, and the views the person allowed by name.
 */
export interface PolicyCatalog {
  relations: ReadonlyMap<string, PolicyRelationKind>;
  viewsAllowed: ReadonlySet<string>;
  /** MySQL: the connection's database, which an unqualified table name means. */
  defaultSchema?: string | null;
}

export type PolicyResult =
  | {
      ok: true;
      /** The relations read, qualified. */
      relations: string[];
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
