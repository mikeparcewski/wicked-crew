/**
 * The Postgres TABLE SAFETY CHECK and its fingerprint (DES-APPS-001 §7.4 rev 11): whether a table is
 * one a v1 row write may touch, and a hash of everything the answer rests on.
 *
 * It runs inside a transaction the caller owns (K2b runs it under `LOCK TABLE ONLY … IN SHARE ROW
 * EXCLUSIVE MODE`, before the statement; K1 runs it standalone in a READ ONLY transaction). It sets
 * `search_path = pg_catalog, pg_temp` locally and names every catalog object schema-qualified, so a
 * temporary table can never shadow a catalog (P25). It reads definitions, never rows.
 *
 * A table passes only when it is a plain heap table (no partition, no inheritance either way), with no
 * row security, no rules, no user triggers (enabled or not) and every internal trigger enabled, no
 * cascading foreign key into it, foreign keys on or into it comparing with `pg_catalog` operators only,
 * every column of a built-in type or an enum with no user-defined cast touching any column type, no
 * generated columns or exclusion constraints, every CHECK passing the §5.3 expression rules (printed)
 * AND depending on nothing outside `pg_catalog` but the table's enums (`pg_depend`), indexes only on
 * plain columns with built-in access methods and `pg_catalog` operator classes, no expression
 * statistics, a primary key, and — the net — no object depending on the table that depends on a
 * function, operator, type or operator class outside `pg_catalog` (other than its enums). Defaults
 * are not refused: every insert supplies every column, so no default ever runs (P35).
 *
 * The declaration check adds what a declared write needs (§7.4 "What may be declared"): the key is the
 * whole primary key; an update sets no key column, no foreign-key column and no referenced column; a
 * delete is refused when any foreign key references the table; an insert sets every column and is
 * refused when the table has a foreign key; every written or key column is of a writable type.
 */

import { createHash } from 'node:crypto';

import type postgres from 'postgres';

import { canonicalJson } from '../../mcp/classify.js';
import { pgReadOnly } from '../drivers/postgres.js';
import type { SqlConnectArgs } from '../drivers/types.js';
import { PG_WRITABLE_TYPES } from '../policy/allowlists.js';
import { checkPgCheckExpression } from '../policy/pg.js';
import type { RowWriteOp } from '../catalog/postgres.js';

type Tx = postgres.TransactionSql<Record<string, never>>;

/** A declared row write, as far as the table check needs it. */
export interface SafetyDeclaration {
  op: RowWriteOp;
  /** The columns the write sets (an insert: every column). */
  set: string[];
  /** The key columns: must be the whole primary key. */
  key: string[];
}

export interface SafetyReason {
  /** A stable class (`user_trigger`, `row_security`, `fk_enforcement`, …). */
  code: string;
  /** Words for the person, naming the object: "`support.tickets` has trigger `audit_owner`: …". */
  detail: string;
}

/** One column of the checked table, as the write path needs it (K2b: statement generation, input forms). */
export interface SafetyColumn {
  name: string;
  /** `format_type` with the typmod (`numeric(3,1)`), printed under `search_path = pg_catalog, pg_temp`. */
  type: string;
  typname: string;
  typschema: string;
  /** `pg_type.typtype`: `b` base, `e` enum, `d` domain, … */
  typtype: string;
  /** Created by initdb (oid < 16384). */
  builtin: boolean;
  notnull: boolean;
  /** `pg_attribute.attidentity`: '' none, `a` always, `d` by default. */
  identity: string;
  /** An enum column's labels, in order. */
  enumLabels?: string[];
}

export interface SafetyResult {
  table: { schema: string; name: string };
  safe: boolean;
  reasons: SafetyReason[];
  /** sha256 over the full definitions read (not counts). Equal fingerprints = nothing the check rests on changed. */
  fingerprint: string;
  /** The relation checked (`pg_class.oid`) and its row type (`pg_class.reltype`), as text; '' when not found. */
  oid: string;
  reltype: string;
  /** Its columns in order (empty when not found). */
  columns: SafetyColumn[];
}

/** Writes need this; the lock the run takes needs table-level UPDATE (P42). */
const TABLE_LEVEL = 'v1 row writes need a plain table';

interface TableRow {
  oid: string;
  reltype: string;
  relkind: string;
  ispartition: boolean;
  rowsecurity: boolean;
  forcerowsecurity: boolean;
  amname: string | null;
  am_builtin: boolean | null;
}

interface ColumnRow {
  attnum: number;
  name: string;
  type: string;
  typid: string;
  typname: string;
  typtype: string;
  typschema: string;
  /** Created by initdb (oid < 16384): BUILT IN, not merely placed in pg_catalog. */
  type_builtin: boolean;
  collation: string;
  notnull: boolean;
  generated: string;
  identity: string;
  default_expr: string | null;
}

/**
 * Run the safety check inside `tx` (the caller's transaction). `opts.oid` reads exactly that relation (the
 * write path passes the one it locked) instead of resolving `schema.name`; its CURRENT names are then what
 * the fingerprint holds, so a relation renamed since the grant (P30) never matches it.
 */
export async function pgTableSafetyIn(tx: Tx, schema: string, name: string, decl: SafetyDeclaration | null = null, opts: { oid?: string } = {}): Promise<SafetyResult> {
  await tx.unsafe('SET LOCAL search_path = pg_catalog, pg_temp');
  const q = <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => tx.unsafe<T[]>(text, params as never) as unknown as Promise<T[]>;
  const reasons: SafetyReason[] = [];
  let label = `${schema}.${name}`;
  const add = (code: string, detail: string): void => {
    reasons.push({ code, detail });
  };

  const [t] = await q<TableRow & Record<string, unknown>>(
    `SELECT c.oid::pg_catalog.int8::pg_catalog.text AS oid, c.reltype::pg_catalog.int8::pg_catalog.text AS reltype, c.relkind::pg_catalog.text AS relkind, c.relispartition AS ispartition,
            c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity, am.amname::pg_catalog.text AS amname,
            (am.oid < 16384) AS am_builtin, n.nspname::pg_catalog.text AS schema, c.relname::pg_catalog.text AS name
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
      WHERE ${opts.oid !== undefined ? 'c.oid = $1::pg_catalog.text::pg_catalog.oid' : 'n.nspname = $1 AND c.relname = $2'}`,
    opts.oid !== undefined ? [opts.oid] : [schema, name],
  );
  if (t === undefined) {
    return { table: { schema, name }, safe: false, reasons: [{ code: 'table_not_found', detail: `\`${label}\` does not exist (or this login cannot see it)` }], fingerprint: '', oid: '', reltype: '', columns: [] };
  }
  // By oid, the names are the relation's own now (the fingerprint below holds them).
  if (opts.oid !== undefined) {
    schema = String(t['schema']);
    name = String(t['name']);
    label = `${schema}.${name}`;
  }
  const T = t.oid;

  const columns = await q<ColumnRow & Record<string, unknown>>(
    `SELECT a.attnum::pg_catalog.int4 AS attnum, a.attname::pg_catalog.text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.atttypid::pg_catalog.int8::pg_catalog.text AS typid, ty.typname::pg_catalog.text AS typname, ty.typtype::pg_catalog.text AS typtype,
            tn.nspname::pg_catalog.text AS typschema, (ty.oid < 16384) AS type_builtin, a.attnotnull AS notnull, a.attgenerated::pg_catalog.text AS generated,
            a.attidentity::pg_catalog.text AS identity, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            CASE WHEN co.oid IS NULL THEN '' ELSE pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname) END AS collation
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid = ty.typnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
      WHERE a.attrelid = $1::pg_catalog.oid AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [T],
  );
  const constraints = await q<{ name: string; contype: string; def: string; deferrable: boolean; cols: string[] }>(
    `SELECT k.conname::pg_catalog.text AS name, k.contype::pg_catalog.text AS contype, pg_catalog.pg_get_constraintdef(k.oid, true) AS def,
            k.condeferrable AS deferrable,
            pg_catalog.array_to_json(ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.conkey) u(n) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n)) AS cols
       FROM pg_catalog.pg_constraint k WHERE k.conrelid = $1::pg_catalog.oid ORDER BY k.conname`,
    [T],
  );
  const fksIn = await q<{ name: string; from: string; def: string; deltype: string; updtype: string; fcols: string[]; self: boolean }>(
    `SELECT k.conname::pg_catalog.text AS name, (n.nspname || '.' || c.relname)::pg_catalog.text AS "from", pg_catalog.pg_get_constraintdef(k.oid, true) AS def,
            k.confdeltype::pg_catalog.text AS deltype, k.confupdtype::pg_catalog.text AS updtype, (k.conrelid = k.confrelid) AS self,
            pg_catalog.array_to_json(ARRAY(SELECT a.attname FROM pg_catalog.unnest(k.confkey) u(n) JOIN pg_catalog.pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n)) AS fcols
       FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid = k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND k.confrelid = $1::pg_catalog.oid ORDER BY 2, 1`,
    [T],
  );
  const fkOperators = await q<{ con: string; operator: string; op_builtin: boolean; fn_builtin: boolean }>(
    `SELECT k.conname::pg_catalog.text AS con, o.oprname::pg_catalog.text AS operator,
            (o.oid < 16384 AND o.oprnamespace = 'pg_catalog'::pg_catalog.regnamespace) AS op_builtin,
            (p.oid < 16384 AND p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace) AS fn_builtin
       FROM pg_catalog.pg_constraint k
       CROSS JOIN LATERAL pg_catalog.unnest(k.conpfeqop || k.conppeqop || k.conffeqop) AS e(op)
       JOIN pg_catalog.pg_operator o ON o.oid = e.op JOIN pg_catalog.pg_proc p ON p.oid = o.oprcode
      WHERE k.contype = 'f' AND (k.conrelid = $1::pg_catalog.oid OR k.confrelid = $1::pg_catalog.oid)`,
    [T],
  );
  const triggers = await q<{ name: string; enabled: string; internal: boolean; def: string }>(
    `SELECT g.tgname::pg_catalog.text AS name, g.tgenabled::pg_catalog.text AS enabled, g.tgisinternal AS internal, pg_catalog.pg_get_triggerdef(g.oid, true) AS def
       FROM pg_catalog.pg_trigger g WHERE g.tgrelid = $1::pg_catalog.oid ORDER BY g.tgname`,
    [T],
  );
  const rules = await q<{ name: string; def: string }>(
    `SELECT r.rulename::pg_catalog.text AS name, pg_catalog.pg_get_ruledef(r.oid, true) AS def FROM pg_catalog.pg_rewrite r WHERE r.ev_class = $1::pg_catalog.oid ORDER BY r.rulename`,
    [T],
  );
  const [inh] = await q<{ parents: string; children: string }>(
    `SELECT (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits i WHERE i.inhrelid = $1::pg_catalog.oid)::pg_catalog.text AS parents,
            (SELECT pg_catalog.count(*) FROM pg_catalog.pg_inherits i WHERE i.inhparent = $1::pg_catalog.oid)::pg_catalog.text AS children`,
    [T],
  );
  const indexes = await q<{ name: string; oid: string; opclasses: number[]; collations: number[]; def: string; exprs: boolean; partial: boolean; amname: string; am_builtin: boolean; opclass_builtin: boolean; primary: boolean }>(
    `SELECT ic.relname::pg_catalog.text AS name, i.indexrelid::pg_catalog.int8::pg_catalog.text AS oid, pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS def,
            pg_catalog.array_to_json(i.indclass::pg_catalog.oid[]::pg_catalog.int8[]) AS opclasses, pg_catalog.array_to_json(i.indcollation::pg_catalog.oid[]::pg_catalog.int8[]) AS collations, (i.indexprs IS NOT NULL) AS exprs,
            (i.indpred IS NOT NULL) AS partial, am.amname::pg_catalog.text AS amname, (am.oid < 16384) AS am_builtin,
            COALESCE((SELECT pg_catalog.bool_and(oc.oid < 16384 AND oc.opcnamespace = 'pg_catalog'::pg_catalog.regnamespace)
                        FROM pg_catalog.unnest(i.indclass::pg_catalog.oid[]) u(o) JOIN pg_catalog.pg_opclass oc ON oc.oid = u.o), true) AS opclass_builtin,
            i.indisprimary AS primary
       FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid JOIN pg_catalog.pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = $1::pg_catalog.oid ORDER BY ic.relname`,
    [T],
  );
  // Every collation the table's columns and indexes use, by its full definition (provider, locale,
  // determinism, recorded version) AND the version the server's library has now (an ICU or libc
  // upgrade changes comparisons before anyone refreshes the recorded one), and the database's own
  // collation, which the `default` collation means.
  // pg_database_collation_actual_version is Postgres 15+; older servers record no database version either.
  const [ver] = await q<{ v: number }>(`SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4 AS v`);
  const dbActual = (ver?.v ?? 0) >= 150_000 ? 'pg_catalog.pg_database_collation_actual_version(d.oid)' : 'NULL::pg_catalog.text';
  const [coll] = await q<{ defs: string[]; db: string | null; dbActual: string | null }>(
    `SELECT pg_catalog.array_to_json(ARRAY(
              SELECT pg_catalog.to_jsonb(co.*)::pg_catalog.text || ' ' || COALESCE(pg_catalog.pg_collation_actual_version(co.oid), '') FROM pg_catalog.pg_collation co
               WHERE co.oid IN (SELECT a.attcollation FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::pg_catalog.oid AND a.attnum > 0 AND NOT a.attisdropped
                                UNION SELECT pg_catalog.unnest(i.indcollation::pg_catalog.oid[]) FROM pg_catalog.pg_index i WHERE i.indrelid = $1::pg_catalog.oid)
               ORDER BY co.oid)) AS defs,
            (SELECT pg_catalog.jsonb_object_agg(e.key, e.value ORDER BY e.key)::pg_catalog.text FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(d.*)) e
              WHERE e.key IN ('datcollate', 'datctype', 'datlocprovider', 'daticulocale', 'datlocale', 'daticurules', 'datcollversion')) AS db,
            ${dbActual} AS "dbActual"
       FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`,
    [T],
  );
  const stats = await q<{ name: string; exprs: boolean; def: string }>(
    `SELECT s.stxname::pg_catalog.text AS name, (s.stxexprs IS NOT NULL) AS exprs, pg_catalog.pg_get_statisticsobjdef(s.oid) AS def
       FROM pg_catalog.pg_statistic_ext s WHERE s.stxrelid = $1::pg_catalog.oid ORDER BY s.stxname`,
    [T],
  );
  const policies = await q<{ name: string; qual: string | null; check: string | null }>(
    `SELECT p.polname::pg_catalog.text AS name, pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual, pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check
       FROM pg_catalog.pg_policy p WHERE p.polrelid = $1::pg_catalog.oid ORDER BY p.polname`,
    [T],
  );
  const typeOids = [...new Set(columns.map((c) => c.typid))];
  const typeArray = `{${typeOids.join(',')}}`;
  const casts = await q<{ source: string; target: string }>(
    `SELECT pg_catalog.format_type(c.castsource, NULL) AS source, pg_catalog.format_type(c.casttarget, NULL) AS target
       FROM pg_catalog.pg_cast c
      WHERE c.oid >= 16384 AND (c.castsource = ANY($1::pg_catalog.text::pg_catalog.oid[]) OR c.casttarget = ANY($1::pg_catalog.text::pg_catalog.oid[]))
      ORDER BY 1, 2`,
    [typeArray],
  );
  const enumOids = columns.filter((c) => c.typtype === 'e').map((c) => c.typid);
  const enumArray = `{${enumOids.join(',')}}`;
  const enumLabels = await q<{ typid: string; labels: string[] }>(
    `SELECT e.enumtypid::pg_catalog.int8::pg_catalog.text AS typid, pg_catalog.array_to_json(pg_catalog.array_agg(e.enumlabel ORDER BY e.enumsortorder)) AS labels
       FROM pg_catalog.pg_enum e WHERE e.enumtypid = ANY($1::pg_catalog.text::pg_catalog.oid[]) GROUP BY e.enumtypid ORDER BY 1`,
    [enumArray],
  );
  // The net (and the CHECK dependency rule): objects that depend on T (defaults excluded: no insert
  // ever lets one run) and, for each, what it depends on outside pg_catalog — functions, operators,
  // types (but T's own enums), operator classes and families.
  // (K2b, the Postgres merge gate) pg_catalog as initdb left it: no role but a superuser may create objects there,
  // and none created since initdb is there. Otherwise an object placed in pg_catalog can take a name the write
  // resolves (an exact-type overload of pg_typeof, an `=` for an enum), ahead of the built-in one.
  const [cat] = await q<{ creators: string[]; objects: string[] }>(
    `SELECT pg_catalog.array_to_json(ARRAY(SELECT r.rolname::pg_catalog.text FROM pg_catalog.pg_roles r
              WHERE NOT r.rolsuper AND pg_catalog.has_schema_privilege(r.oid, 'pg_catalog'::pg_catalog.regnamespace, 'CREATE') ORDER BY 1)) AS creators,
            pg_catalog.array_to_json(ARRAY(
              SELECT 'function ' || p.proname::pg_catalog.text FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace AND p.oid >= 16384
              UNION ALL SELECT 'operator ' || o.oprname::pg_catalog.text FROM pg_catalog.pg_operator o WHERE o.oprnamespace = 'pg_catalog'::pg_catalog.regnamespace AND o.oid >= 16384
              UNION ALL SELECT 'type ' || t.typname::pg_catalog.text FROM pg_catalog.pg_type t WHERE t.typnamespace = 'pg_catalog'::pg_catalog.regnamespace AND t.oid >= 16384
              ORDER BY 1)) AS objects`,
  );
  const net = await q<{ obj: string; ref: string; classid: string }>(
    `WITH dependents AS (
       SELECT DISTINCT d.classid, d.objid FROM pg_catalog.pg_depend d
        WHERE d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND d.refobjid = $1::pg_catalog.oid
          AND d.classid <> 'pg_catalog.pg_attrdef'::pg_catalog.regclass
     )
     SELECT pg_catalog.pg_describe_object(x.classid, x.objid, 0) AS obj, pg_catalog.pg_describe_object(d.refclassid, d.refobjid, 0) AS ref,
            x.classid::pg_catalog.regclass::pg_catalog.text AS classid
       FROM dependents x JOIN pg_catalog.pg_depend d ON d.classid = x.classid AND d.objid = x.objid
      WHERE (d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = d.refobjid AND (p.oid >= 16384 OR p.pronamespace <> 'pg_catalog'::pg_catalog.regnamespace)))
         OR (d.refclassid = 'pg_catalog.pg_operator'::pg_catalog.regclass
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_operator o WHERE o.oid = d.refobjid AND (o.oid >= 16384 OR o.oprnamespace <> 'pg_catalog'::pg_catalog.regnamespace)))
         OR (d.refclassid = 'pg_catalog.pg_type'::pg_catalog.regclass
               AND NOT (d.refobjid = ANY($2::pg_catalog.text::pg_catalog.oid[]))
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_type ty WHERE ty.oid = d.refobjid AND (ty.oid >= 16384 OR ty.typnamespace <> 'pg_catalog'::pg_catalog.regnamespace)
                             AND ty.typrelid <> $1::pg_catalog.oid))
         OR (d.refclassid = 'pg_catalog.pg_opclass'::pg_catalog.regclass
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_opclass oc WHERE oc.oid = d.refobjid AND (oc.oid >= 16384 OR oc.opcnamespace <> 'pg_catalog'::pg_catalog.regnamespace)))
         OR (d.refclassid = 'pg_catalog.pg_opfamily'::pg_catalog.regclass
               AND EXISTS (SELECT 1 FROM pg_catalog.pg_opfamily f WHERE f.oid = d.refobjid AND (f.oid >= 16384 OR f.opfnamespace <> 'pg_catalog'::pg_catalog.regnamespace)))
      ORDER BY 1, 2`,
    [T, enumArray],
  );

  // ── the rules ──
  if (t.relkind === 'p') add('partitioned', `\`${label}\` is a partitioned table: ${TABLE_LEVEL}`);
  else if (t.relkind !== 'r') add('not_a_table', `\`${label}\` is not a table (relkind ${t.relkind}, e.g. a view): ${TABLE_LEVEL}`);
  if (t.ispartition) add('partition', `\`${label}\` is a partition of another table: ${TABLE_LEVEL}`);
  if (t.relkind === 'r' && (t.amname !== 'heap' || t.am_builtin !== true)) add('access_method', `\`${label}\` uses the access method ${t.amname ?? 'unknown'}: ${TABLE_LEVEL} (heap)`);
  if (Number(inh?.parents ?? 0) > 0) add('inheritance_child', `\`${label}\` inherits from another table: ${TABLE_LEVEL}`);
  if (Number(inh?.children ?? 0) > 0) add('inheritance_parent', `\`${label}\` has tables that inherit from it: ${TABLE_LEVEL}`);
  if (t.rowsecurity || t.forcerowsecurity) add('row_security', `\`${label}\` has row security ${t.forcerowsecurity ? 'forced' : 'enabled'}: ${TABLE_LEVEL}`);
  for (const r of rules) add('rule', `\`${label}\` has rule \`${r.name}\`: ${TABLE_LEVEL}`);
  for (const g of triggers) {
    if (!g.internal) add('user_trigger', `\`${label}\` has trigger \`${g.name}\`${g.enabled === 'D' ? ' (disabled, but it can be enabled again)' : ''}: ${TABLE_LEVEL}`);
    else if (g.enabled !== 'O' && g.enabled !== 'A') add('internal_trigger_disabled', `\`${label}\` has its internal trigger \`${g.name}\` not enabled (foreign-key enforcement is off): ${TABLE_LEVEL}`);
  }
  for (const k of fksIn) {
    if (!['a', 'r'].includes(k.deltype) || !['a', 'r'].includes(k.updtype)) add('cascading_key', `\`${k.from}\` references \`${label}\` with a cascading or setting action (\`${k.name}\`): a write would change other rows`);
  }
  for (const o of fkOperators) {
    if (!o.op_builtin || !o.fn_builtin) add('fk_operator', `the foreign key \`${o.con}\` on or into \`${label}\` compares with an operator outside pg_catalog (\`${o.operator}\`)`);
  }
  for (const c of columns) {
    // Built in = created by initdb (oid < 16384), not merely living in pg_catalog.
    const builtin = c.typschema === 'pg_catalog' && c.type_builtin;
    if (c.typtype === 'd') add('column_type', `\`${label}.${c.name}\` has the domain type \`${c.type}\`: a domain runs its own checks`);
    else if (c.typtype !== 'e' && !builtin) add('column_type', `\`${label}.${c.name}\` has the custom type \`${c.type}\`: only built-in types and enums`);
    else if (c.typtype === 'c' || c.typtype === 'p') add('column_type', `\`${label}.${c.name}\` has the composite or pseudo type \`${c.type}\``);
    if (c.generated !== '') add('generated_column', `\`${label}.${c.name}\` is a generated column: its expression runs on every write`);
  }
  for (const c of casts) add('user_cast', `a user-defined cast from \`${c.source}\` to \`${c.target}\` touches a column type of \`${label}\``);
  const enumNames = new Set(columns.filter((c) => c.typtype === 'e').map((c) => `${c.typschema}.${c.typname}`));
  for (const k of constraints) {
    if (k.contype === 'x') add('exclusion_constraint', `\`${label}\` has the exclusion constraint \`${k.name}\``);
    if (k.contype === 'c') {
      const r = await checkPgCheckExpression(k.def, enumNames);
      if (!r.ok) add('check_expression', `the CHECK \`${k.name}\` on \`${label}\` is outside the expression rules: ${r.detail}`);
    }
  }
  for (const i of indexes) {
    if (i.exprs) add('index_expression', `\`${label}\` has the expression index \`${i.name}\``);
    if (i.partial) add('index_partial', `\`${label}\` has the partial index \`${i.name}\``);
    if (!i.am_builtin) add('index_access_method', `the index \`${i.name}\` uses the access method ${i.amname}`);
    if (!i.opclass_builtin) add('index_opclass', `the index \`${i.name}\` uses an operator class outside pg_catalog`);
  }
  for (const s of stats) if (s.exprs) add('statistics_expression', `\`${label}\` has extended statistics with expressions (\`${s.name}\`)`);
  for (const n of net) {
    const code = n.classid === 'pg_constraint' && constraints.some((k) => k.contype === 'c' && n.obj.includes(k.name)) ? 'check_dependency' : 'depend_net';
    add(code, `${n.obj} depends on ${n.ref}, outside pg_catalog: code attached to \`${label}\``);
  }
  for (const r of cat?.creators ?? []) add('catalog_create', `the role ${r} can create objects in pg_catalog, where one could take a name a write uses: v1 row writes need pg_catalog writable by superusers only`);
  for (const o of cat?.objects ?? []) add('catalog_object', `pg_catalog holds the ${o}, created after initdb: v1 row writes need pg_catalog as initdb left it`);
  const pk = constraints.find((k) => k.contype === 'p');
  if (pk === undefined) add('no_primary_key', `\`${label}\` has no primary key: the one-row guarantee rests on it`);

  // ── the declaration ──
  if (decl !== null) {
    const names = new Set(columns.map((c) => c.name));
    for (const col of [...decl.set, ...decl.key]) if (!names.has(col)) add('unknown_column', `\`${label}\` has no column \`${col}\``);
    const pkCols = new Set(pk?.cols ?? []);
    const keySet = new Set(decl.key);
    if (keySet.size !== decl.key.length) add('key_mismatch', 'the key names a column twice');
    if (new Set(decl.set).size !== decl.set.length) add('nothing_set', 'the write sets a column twice');
    if (pk !== undefined && (keySet.size !== pkCols.size || ![...pkCols].every((k) => keySet.has(k)))) {
      add('key_mismatch', `the key must be the whole primary key of \`${label}\` (${[...pkCols].join(', ')})`);
    }
    const fkOut = constraints.filter((k) => k.contype === 'f');
    const fkCols = new Set(fkOut.flatMap((k) => k.cols));
    const referenced = new Set(fksIn.flatMap((k) => k.fcols));
    if (decl.op === 'update') {
      if (decl.set.length === 0) add('nothing_set', 'an update sets at least one column');
      for (const col of decl.set) {
        if (pkCols.has(col)) add('key_write', `an update may not change the primary-key column \`${col}\``);
        if (fkCols.has(col)) add('fk_enforcement', `\`${col}\` belongs to a foreign key on \`${label}\`: updating it runs foreign-key enforcement`);
        if (referenced.has(col)) add('fk_enforcement', `\`${col}\` is referenced by a foreign key: updating it runs foreign-key enforcement`);
      }
    } else if (decl.op === 'delete') {
      if (fksIn.length > 0) add('fk_enforcement', `\`${label}\` is referenced by a foreign key (${fksIn.map((k) => `\`${k.from}.${k.name}\``).join(', ')}): a delete runs foreign-key enforcement`);
    } else {
      const all = columns.map((c) => c.name);
      if (decl.set.length !== all.length || !all.every((c) => decl.set.includes(c))) add('insert_columns', `an insert into \`${label}\` sets every column (${all.join(', ')}), so no default or sequence runs`);
      if (fkOut.length > 0) add('fk_enforcement', `\`${label}\` has a foreign key (${fkOut.map((k) => `\`${k.name}\``).join(', ')}): an insert runs foreign-key enforcement`);
    }
    for (const col of new Set([...decl.set, ...decl.key])) {
      const c = columns.find((x) => x.name === col);
      if (c === undefined) continue;
      const writable = c.typtype === 'e' || (c.typschema === 'pg_catalog' && c.type_builtin && PG_WRITABLE_TYPES.has(c.typname));
      if (!writable) add('written_type', `\`${label}.${col}\` is \`${c.type}\`, which a v1 row write cannot write or key on (floating point, json, xml, bytea and arrays are not writable)`);
    }
  }

  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        table: { schema, name, oid: t.oid, reltype: t.reltype, relkind: t.relkind, partition: t.ispartition, rowSecurity: t.rowsecurity, forceRowSecurity: t.forcerowsecurity, am: t.amname, amBuiltin: t.am_builtin },
        columns: columns.map((c) => ({ name: c.name, type: c.type, typid: c.typid, typtype: c.typtype, typschema: c.typschema, builtin: c.type_builtin, collation: c.collation, notnull: c.notnull, generated: c.generated, identity: c.identity, default: c.default_expr })),
        enums: enumLabels,
        collations: { defs: coll?.defs ?? [], database: coll?.db ?? null, databaseActual: coll?.dbActual ?? null },
        constraints: constraints.map((k) => ({ name: k.name, type: k.contype, def: k.def, deferrable: k.deferrable })),
        foreignKeysIn: fksIn.map((k) => ({ name: k.name, from: k.from, def: k.def })),
        fkOperators: fkOperators.map((o) => [o.con, o.operator, o.op_builtin, o.fn_builtin]),
        triggers: triggers.map((g) => ({ name: g.name, enabled: g.enabled, internal: g.internal, def: g.def })),
        rules: rules.map((r) => ({ name: r.name, def: r.def })),
        inheritance: inh,
        indexes: indexes.map((i) => ({ name: i.name, oid: i.oid, def: i.def, am: i.amname, opclasses: i.opclasses, collations: i.collations, exprs: i.exprs, partial: i.partial, opclassBuiltin: i.opclass_builtin })),
        statistics: stats.map((s) => ({ name: s.name, def: s.def })),
        policies,
        casts,
        net,
        catalog: { creators: cat?.creators ?? [], objects: cat?.objects ?? [] },
      }),
    )
    .digest('hex');
  const labelsOf = new Map(enumLabels.map((e) => [e.typid, e.labels] as const));
  return {
    table: { schema, name },
    safe: reasons.length === 0,
    reasons,
    fingerprint,
    oid: t.oid,
    reltype: t.reltype,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      typname: c.typname,
      typschema: c.typschema,
      typtype: c.typtype,
      builtin: c.type_builtin,
      notnull: c.notnull,
      identity: c.identity,
      ...(c.typtype === 'e' ? { enumLabels: [...(labelsOf.get(c.typid) ?? [])] } : {}),
    })),
  };
}

/** The safety check, standalone: its own READ ONLY transaction on the source. */
export async function pgTableSafety(args: SqlConnectArgs, schema: string, name: string, decl: SafetyDeclaration | null = null): Promise<SafetyResult> {
  return pgReadOnly(args, (tx) => pgTableSafetyIn(tx, schema, name, decl));
}
