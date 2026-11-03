/**
 * The Postgres half of the read policy (DES-APPS-001 §5.3): the query text is parsed with
 * libpg_query (the server's own grammar) and walked with a CLOSED allowlist. Every node type and every
 * field of a node must be one this file names; anything else is refused, so a construct Postgres adds
 * later is refused until someone reads it. Nothing here connects to the source.
 *
 * - One statement: a `SELECT` (set operations included) or a non-recursive `WITH … SELECT`. No
 *   data-modifying CTE, locking clause, `INTO`, `VALUES` or `TABLESAMPLE`.
 * - Names: unqualified functions, operators and types resolve to built-ins because reads run with
 *   `search_path = pg_catalog, pg_temp` (drivers/postgres.ts); a function, operator or type qualified
 *   with any schema but `pg_catalog` is refused. Tables must be schema-qualified (an unqualified name
 *   is only a CTE in scope, so `pg_catalog` tables are never reachable that way).
 * - Functions, operators and casts come from `allowlists.ts`; `reg*` casts, arrays, `query_to_xml`,
 *   `pg_read_file`, `pg_sleep` and the rest are refused.
 * - Relations: base tables of the described catalog; a view or materialized view only when the person
 *   allowed it by name; a foreign table never.
 *
 * The same walker, in expression mode (no relations, no subqueries), holds a table's `CHECK`
 * definitions to these rules for the row-write safety check (§7.4).
 */

import { parse } from 'libpg-query';

import { deniedFunction, PG_CAST_TYPES, PG_FUNCTIONS, PG_OPERATORS } from './allowlists.js';
import { type PolicyCatalog, type PolicyResult, relKey, relLabel } from './types.js';

type Json = Record<string, unknown>;

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (code: string, message: string): never => {
  throw new Refusal(code, message);
};

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `{Type: fields}` → [Type, fields]; anything else is not a node. */
function unwrap(node: unknown): [string, Json] {
  if (!isObj(node)) return refuse('syntax', 'an unexpected value where an expression belongs');
  const keys = Object.keys(node);
  if (keys.length !== 1) return refuse('syntax', 'an unexpected node shape');
  const type = keys[0] as string;
  const fields = node[type];
  if (!isObj(fields)) return refuse('syntax', `an unexpected ${type} node`);
  return [type, fields];
}

function strings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((n) => {
    const [type, f] = unwrap(n);
    if (type !== 'String' || typeof f['sval'] !== 'string') return refuse('syntax', 'an unexpected name part');
    return f['sval'] as string;
  });
}

/** Fields that never hold a node: positions, flags, enum-valued kinds. */
const DATA_FIELDS = new Set(['location', 'stmt_location', 'stmt_len']);

interface Scope {
  ctes: Set<string>;
  parent: Scope | null;
}

function cteVisible(scope: Scope | null, name: string): boolean {
  for (let s = scope; s !== null; s = s.parent) if (s.ctes.has(name)) return true;
  return false;
}

export interface PgWalkOptions {
  catalog: PolicyCatalog | null;
  /** Expression mode (a `CHECK`): no relations, no subqueries. */
  expressionOnly?: boolean;
  /** Extra cast targets allowed by qualified name (a table's own enum types, for `CHECK`). */
  extraTypes?: ReadonlySet<string>;
}

class Walker {
  readonly relations = new Set<string>();
  readonly functions = new Set<string>();
  params = 0;
  /** Table aliases (and bare table names) → the relations they name, collected over the whole statement. */
  private readonly aliases = new Map<string, Set<string>>();
  /** Names the statement itself defines as columns: output names, alias column lists. */
  private readonly definedNames = new Set<string>();
  /** Qualified column references, judged after the walk (FROM is walked after the target list). */
  private readonly qualifiedRefs: Array<{ qualifier: string; column: string }> = [];

  constructor(private readonly opts: PgWalkOptions) {}

  /** Visit `fields` of a node: each key must be in `allowed` (or a data field); `allowed` says how. */
  private fields(type: string, f: Json, allowed: Record<string, 'node' | 'nodes' | 'data' | ((v: unknown) => void)>, scope: Scope | null): void {
    for (const [k, v] of Object.entries(f)) {
      if (DATA_FIELDS.has(k)) continue;
      const how = allowed[k];
      if (how === undefined) refuse('syntax', `${type}.${k} is outside the read subset`);
      else if (how === 'data') continue;
      else if (how === 'node') this.node(v, scope);
      else if (how === 'nodes') {
        if (!Array.isArray(v)) refuse('syntax', `${type}.${k} is not a list`);
        for (const item of v as unknown[]) this.node(item, scope);
      } else how(v);
    }
  }

  select(node: unknown, scope: Scope | null): void {
    const [type, f] = unwrap(node);
    if (type !== 'SelectStmt') refuse('not_select', `${type.replace(/Stmt$/, '').toUpperCase()} is not a read; only SELECT (or WITH … SELECT) is`);
    this.selectFields(f, scope);
  }

  /** A raw alias (`{aliasname, colnames}`), as RangeVar, RangeSubselect and JoinExpr carry it. */
  private alias(v: unknown): void {
    if (!isObj(v)) refuse('syntax', 'a malformed alias');
    this.fields('Alias', v as Json, { aliasname: 'data', colnames: 'data' }, null);
    for (const c of strings((v as Json)['colnames'])) this.definedNames.add(c);
  }

  /**
   * After the walk: every qualified column reference (`q.c`) must name a column the qualifier really
   * has. Postgres reads `q.c` as the function `c(q)` when `q` has no column `c` (functional notation),
   * which would call a built-in no allowlist judged; so a name that is no known column is refused.
   */
  finish(): void {
    const catalogColumns = (keys: Iterable<string>): Set<string> => {
      const out = new Set<string>();
      for (const k of keys) for (const c of this.opts.catalog?.columns?.get(k) ?? []) out.add(c);
      return out;
    };
    const known = new Set([...catalogColumns(this.relations), ...this.definedNames]);
    for (const { qualifier, column } of this.qualifiedRefs) {
      const named = this.aliases.get(qualifier);
      // A table alias: only that table's columns (or names the statement gave it). Anything else (a
      // subquery or CTE alias): a column of a table the statement reads, or a name it defines.
      const ok = named !== undefined ? catalogColumns(named).has(column) || this.definedNames.has(column) : known.has(column);
      if (!ok) refuse('column', `${qualifier}.${column} is not a known column (Postgres would call a function named ${column} on the row); name a column, or alias the expression`);
    }
  }

  /** A raw WindowDef (a FuncCall's `over`) or a wrapped one (a WINDOW clause entry). */
  private windowDef(f: Json, scope: Scope | null): void {
    this.fields('WindowDef', f, { name: 'data', refname: 'data', partitionClause: 'nodes', orderClause: 'nodes', frameOptions: 'data', startOffset: 'node', endOffset: 'node' }, scope);
  }

  /** The fields of a SELECT; set operations carry their arms as raw SelectStmt fields. */
  private selectFields(f: Json, scope: Scope | null): void {
    if (this.opts.expressionOnly === true) refuse('syntax', 'a subquery is outside a CHECK expression');
    if (f['intoClause'] !== undefined) refuse('into', 'SELECT … INTO creates a table; a read never writes');
    if (Array.isArray(f['lockingClause']) && f['lockingClause'].length > 0) refuse('locking', 'a locking clause (FOR UPDATE/SHARE) is not a read');
    if (f['valuesLists'] !== undefined) refuse('syntax', 'VALUES lists are outside the read subset');
    let inner: Scope = { ctes: new Set(), parent: scope };
    const withClause = f['withClause'];
    if (withClause !== undefined) {
      if (!isObj(withClause)) refuse('syntax', 'a malformed WITH');
      const w = withClause as Json;
      if (w['recursive'] === true) refuse('recursive', 'WITH RECURSIVE is outside the read subset');
      for (const k of Object.keys(w)) if (!['ctes', 'recursive', 'location'].includes(k)) refuse('syntax', `WITH.${k} is outside the read subset`);
      // Each CTE sees only the ones before it (non-recursive WITH); the body sees all of them.
      const seen: Scope = { ctes: new Set(), parent: scope };
      for (const cte of (w['ctes'] as unknown[]) ?? []) {
        const [ct, cf] = unwrap(cte);
        if (ct !== 'CommonTableExpr') refuse('syntax', `${ct} in WITH`);
        for (const c of strings(cf['aliascolnames'])) this.definedNames.add(c);
        this.fields('CommonTableExpr', cf, { ctename: 'data', aliascolnames: 'data', ctematerialized: 'data', ctequery: (q) => this.select(q, { ctes: new Set(seen.ctes), parent: scope }) }, scope);
        if (typeof cf['ctename'] !== 'string') refuse('syntax', 'a CTE with no name');
        seen.ctes.add(cf['ctename'] as string);
      }
      inner = seen;
    }
    if (f['distinctClause'] !== undefined) {
      // `SELECT DISTINCT` is a list holding one empty node; `DISTINCT ON (…)` lists expressions.
      for (const d of f['distinctClause'] as unknown[]) if (!(isObj(d) && Object.keys(d).length === 0)) this.node(d, inner);
    }
    this.fields(
      'SelectStmt',
      f,
      {
        withClause: 'data', // walked above
        distinctClause: 'data', // walked above
        targetList: 'nodes',
        fromClause: 'nodes',
        whereClause: 'node',
        groupClause: 'nodes',
        groupDistinct: 'data',
        havingClause: 'node',
        windowClause: 'nodes',
        sortClause: 'nodes',
        limitCount: 'node',
        limitOffset: 'node',
        limitOption: 'data',
        op: 'data',
        all: 'data',
        larg: (v) => (isObj(v) ? this.selectFields(v, inner) : refuse('syntax', 'a malformed set operation')),
        rarg: (v) => (isObj(v) ? this.selectFields(v, inner) : refuse('syntax', 'a malformed set operation')),
        lockingClause: 'data', // refused above when non-empty
      },
      inner,
    );
  }

  private typeName(tn: unknown): string {
    if (!isObj(tn)) return refuse('syntax', 'a malformed type name');
    for (const k of Object.keys(tn)) if (!['names', 'typmods', 'typemod', 'location'].includes(k)) refuse('cast', `a cast to an array, SETOF or %TYPE is outside the read subset (${k})`);
    const names = strings(tn['names']);
    const last = names[names.length - 1] ?? '';
    const qualified = names.join('.');
    if (this.opts.extraTypes?.has(qualified) === true) return qualified;
    if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) refuse('qualified_name', `a cast to ${qualified}: types outside pg_catalog are refused`);
    if (/^reg/.test(last) || !PG_CAST_TYPES.has(last)) refuse('cast', `a cast to ${qualified} is refused; casts go only to scalar types (integers, numeric, float, text, varchar, boolean, date, timestamp, timestamptz, time, interval, uuid, json, jsonb)`);
    if (Array.isArray(tn['typmods'])) for (const m of tn['typmods']) this.node(m, null);
    return last;
  }

  private operator(nameList: unknown): void {
    const names = strings(nameList);
    const sym = names[names.length - 1] ?? '';
    if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) refuse('qualified_name', `OPERATOR(${names.join('.')}): operators outside pg_catalog are refused`);
    if (!PG_OPERATORS.has(sym)) refuse('operator', `the operator ${sym} is outside the read subset`);
  }

  node(n: unknown, scope: Scope | null): void {
    const [type, f] = unwrap(n);
    switch (type) {
      case 'SelectStmt':
        return this.select(n, scope);
      case 'ResTarget':
        if (typeof f['name'] === 'string') this.definedNames.add(f['name']);
        return this.fields(type, f, { name: 'data', val: 'node' }, scope);
      case 'ColumnRef': {
        const parts = ((f['fields'] as unknown[]) ?? []).map((part) => {
          const [pt, pf] = unwrap(part);
          if (pt !== 'String' && pt !== 'A_Star') refuse('syntax', `a column reference with ${pt}`);
          return pt === 'String' ? String(pf['sval']) : '*';
        });
        if (parts.length >= 2 && parts[parts.length - 1] !== '*') this.qualifiedRefs.push({ qualifier: parts[parts.length - 2] as string, column: parts[parts.length - 1] as string });
        return this.fields(type, f, { fields: 'data' }, scope);
      }
      case 'A_Star':
        return this.fields(type, f, {}, scope);
      case 'A_Const':
        return this.fields(type, f, { ival: 'data', fval: 'data', sval: 'data', boolval: 'data', bsval: 'data', isnull: 'data' }, scope);
      case 'ParamRef':
        if (typeof f['number'] === 'number') this.params = Math.max(this.params, f['number']);
        return this.fields(type, f, { number: 'data' }, scope);
      case 'A_Expr': {
        const kind = f['kind'];
        const allowed = ['AEXPR_OP', 'AEXPR_OP_ANY', 'AEXPR_OP_ALL', 'AEXPR_DISTINCT', 'AEXPR_NOT_DISTINCT', 'AEXPR_NULLIF', 'AEXPR_IN', 'AEXPR_LIKE', 'AEXPR_ILIKE', 'AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN', 'AEXPR_BETWEEN_SYM', 'AEXPR_NOT_BETWEEN_SYM'];
        if (typeof kind !== 'string' || !allowed.includes(kind)) refuse('syntax', `${String(kind)} is outside the read subset`);
        if (!String(kind).includes('BETWEEN')) this.operator(f['name']);
        return this.fields(type, f, { kind: 'data', name: 'data', lexpr: 'node', rexpr: 'node' }, scope);
      }
      case 'List':
        return this.fields(type, f, { items: 'nodes' }, scope);
      case 'BoolExpr':
        return this.fields(type, f, { boolop: 'data', args: 'nodes' }, scope);
      case 'NullTest':
        return this.fields(type, f, { arg: 'node', nulltesttype: 'data', argisrow: 'data' }, scope);
      case 'BooleanTest':
        return this.fields(type, f, { arg: 'node', booltesttype: 'data' }, scope);
      case 'CaseExpr':
        return this.fields(type, f, { arg: 'node', args: 'nodes', defresult: 'node' }, scope);
      case 'CaseWhen':
        return this.fields(type, f, { expr: 'node', result: 'node' }, scope);
      case 'CoalesceExpr':
        return this.fields(type, f, { args: 'nodes' }, scope);
      case 'MinMaxExpr':
        return this.fields(type, f, { op: 'data', args: 'nodes' }, scope);
      case 'TypeCast':
        this.typeName(f['typeName']);
        return this.fields(type, f, { arg: 'node', typeName: 'data' }, scope);
      case 'FuncCall': {
        const names = strings(f['funcname']);
        const name = names[names.length - 1] ?? '';
        if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) refuse('qualified_name', `${names.join('.')}(): functions outside pg_catalog are refused`);
        if (deniedFunction(name) || !PG_FUNCTIONS.has(name)) refuse('function', `${name}() is not a function a read may call`);
        if (f['func_variadic'] === true) refuse('syntax', 'VARIADIC calls are outside the read subset');
        this.functions.add(name);
        return this.fields(
          type,
          f,
          {
            funcname: 'data',
            args: 'nodes',
            agg_order: 'nodes',
            agg_filter: 'node',
            over: (v) => (isObj(v) ? this.windowDef(v, scope) : refuse('syntax', 'a malformed OVER')),
            agg_within_group: 'data',
            agg_star: 'data',
            agg_distinct: 'data',
            func_variadic: 'data',
            funcformat: 'data',
          },
          scope,
        );
      }
      case 'WindowDef':
        return this.windowDef(f, scope);
      case 'SortBy':
        if (f['useOp'] !== undefined) this.operator(f['useOp']);
        return this.fields(type, f, { node: 'node', sortby_dir: 'data', sortby_nulls: 'data', useOp: 'data' }, scope);
      case 'SubLink': {
        if (this.opts.expressionOnly === true) refuse('syntax', 'a subquery is outside a CHECK expression');
        const k = f['subLinkType'];
        if (!['EXISTS_SUBLINK', 'ANY_SUBLINK', 'ALL_SUBLINK', 'EXPR_SUBLINK'].includes(String(k))) refuse('syntax', `${String(k)} subqueries are outside the read subset`);
        if (f['operName'] !== undefined) this.operator(f['operName']);
        return this.fields(type, f, { subLinkType: 'data', testexpr: 'node', operName: 'data', subselect: (v) => this.select(v, scope) }, scope);
      }
      case 'SQLValueFunction': {
        const op = String(f['op']);
        if (!/^SVFOP_(CURRENT_DATE|CURRENT_TIME|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP)(_N)?$/.test(op)) refuse('function', `${op.replace('SVFOP_', '')} is outside the read subset`);
        return this.fields(type, f, { op: 'data', typmod: 'data' }, scope);
      }
      case 'A_ArrayExpr':
        return this.fields(type, f, { elements: 'nodes' }, scope);
      case 'GroupingSet':
        return this.fields(type, f, { kind: 'data', content: 'nodes' }, scope);
      case 'RangeVar':
        this.relation(f, scope);
        return this.fields(type, f, { schemaname: 'data', relname: 'data', inh: 'data', relpersistence: 'data', alias: (v) => this.alias(v) }, scope);
      case 'RangeSubselect':
        if (this.opts.expressionOnly === true) refuse('syntax', 'a subquery is outside a CHECK expression');
        return this.fields(type, f, { lateral: 'data', subquery: (v) => this.select(v, scope), alias: (v) => this.alias(v) }, scope);
      case 'JoinExpr':
        strings(f['usingClause']);
        return this.fields(type, f, { jointype: 'data', isNatural: 'data', larg: 'node', rarg: 'node', usingClause: 'data', join_using_alias: (v) => this.alias(v), quals: 'node', alias: (v) => this.alias(v), rtindex: 'data' }, scope);
      case 'String':
        return this.fields(type, f, { sval: 'data' }, scope);
      case 'Integer':
      case 'Float':
      case 'Boolean':
        return this.fields(type, f, { ival: 'data', fval: 'data', boolval: 'data' }, scope);
      default:
        return refuse('syntax', `${type} is outside the read subset`);
    }
  }

  private relation(f: Json, scope: Scope | null): void {
    if (this.opts.expressionOnly === true || this.opts.catalog === null) refuse('relation', 'no table may be read here');
    const relname = String(f['relname'] ?? '');
    if (f['catalogname'] !== undefined) refuse('relation', `a three-part name (${String(f['catalogname'])}.…) is refused`);
    if (f['relpersistence'] !== undefined && f['relpersistence'] !== 'p') refuse('relation', 'a temporary or unlogged relation reference is refused');
    const schema = f['schemaname'];
    const aliasName = isObj(f['alias']) && typeof (f['alias'] as Json)['aliasname'] === 'string' ? String((f['alias'] as Json)['aliasname']) : relname;
    if (schema === undefined) {
      if (cteVisible(scope, relname)) return;
      refuse('unqualified', `the table ${relname} must be schema-qualified (schema.table)`);
    }
    const catalog = this.opts.catalog as PolicyCatalog;
    const key = relKey(String(schema), relname);
    const label = relLabel(key);
    const rel = catalog.relations.get(key);
    if (rel === undefined) refuse('relation', `${label} is not a table of this source's catalog (describe the source again if it is new)`);
    else if (rel === 'foreign') refuse('relation', `${label} is a foreign table; reads never touch foreign tables`);
    else if ((rel === 'view' || rel === 'matview') && !catalog.viewsAllowed.has(key)) {
      refuse('view', `${label} is a view the person has not allowed by name on the source sheet`);
    }
    // A read without ONLY includes every partition and inheritance child.
    // libpg_query writes `inh: true` for a plain read and omits it (false) for ONLY.
    if (f['inh'] === true && catalog.foreignDescendants?.has(key) === true) {
      refuse('relation', `${label} has a foreign table among its partitions or children, which a plain read would reach; read ONLY ${label}`);
    }
    this.relations.add(key);
    const set = this.aliases.get(aliasName) ?? new Set<string>();
    set.add(key);
    this.aliases.set(aliasName, set);
  }
}

/** Check one query text against the Postgres read subset. Never connects. */
export async function checkPgRead(text: string, catalog: PolicyCatalog): Promise<PolicyResult> {
  let tree: { stmts?: Array<{ stmt?: unknown }> };
  try {
    tree = (await parse(text)) as typeof tree;
  } catch (err) {
    return { ok: false, code: 'parse', detail: `the query does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) return { ok: false, code: 'statements', detail: `a query is exactly one statement (found ${stmts.length})` };
  const w = new Walker({ catalog });
  try {
    w.select(stmts[0]?.stmt, null);
    w.finish();
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
  return { ok: true, relations: [...w.relations].map(relLabel).sort(), keys: [...w.relations].sort(), functions: [...w.functions].sort(), params: w.params };
}

/**
 * Hold one printed `CHECK` expression (`pg_get_constraintdef(oid, true)` under
 * `search_path = pg_catalog, pg_temp`) to the §5.3 expression rules (§7.4). `enumTypes` are the
 * table's own enum types, by qualified name, which a check may compare against.
 */
export async function checkPgCheckExpression(definition: string, enumTypes: ReadonlySet<string>): Promise<PolicyResult> {
  const m = /^CHECK\s*\(([\s\S]*)\)(\s+NOT VALID)?(\s+NO INHERIT)?$/.exec(definition.trim());
  if (m === null) return { ok: false, code: 'syntax', detail: `an unexpected CHECK definition: ${definition}` };
  let tree: { stmts?: Array<{ stmt?: unknown }> };
  try {
    tree = (await parse(`SELECT 1 WHERE ${m[1] as string}`)) as typeof tree;
  } catch (err) {
    return { ok: false, code: 'parse', detail: `the CHECK does not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  const stmt = tree.stmts?.[0]?.stmt;
  const where = isObj(stmt) && isObj(stmt['SelectStmt']) ? (stmt['SelectStmt'] as Json)['whereClause'] : undefined;
  if ((tree.stmts?.length ?? 0) !== 1 || where === undefined) return { ok: false, code: 'syntax', detail: 'the CHECK is not one expression' };
  const w = new Walker({ catalog: null, expressionOnly: true, extraTypes: enumTypes });
  try {
    w.node(where, null);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
  return { ok: true, relations: [], functions: [...w.functions].sort(), params: 0 };
}
