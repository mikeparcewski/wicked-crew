/**
 * The SOURCE STAGE (DES-APPS-001 §9.2 step 3, §6.2): K2a's `AppSourceStage` seam, implemented over the
 * sources slice's checks. For each query and action the staged check names, it checks the declaration
 * against the source as it is now and answers its contract hash and the source's pin; or findings, and
 * nothing lands. It NEVER executes a read or a write:
 *
 *  - sql: the read policy, then Parse/Describe (`checkSqlQuery`); the described result columns against the
 *    declared output (names, count; Postgres types); the parameters the source inferred against the
 *    declared ones (`$n` / the n-th `?` is the n-th declared parameter, and every one is used);
 *  - graphql: one `query` operation valid against the introspected schema; its variables are exactly the
 *    declared parameters;
 *  - rest / mcp: the tool exists, the person's saved schema is still the server's, the person accepted it
 *    as a read; its arguments are the tool's and name declared parameters;
 *  - crew: an allowlisted route with every path parameter supplied;
 *  - API actions: the tool (as above, any class: a write is what the grant is for), or one GraphQL
 *    mutation with one root field, valid against the schema, its variables exactly the action's arguments;
 *  - row writes (Postgres only): the table safety check WITH the declaration (K1), then every value against
 *    its column: the one input form a parameter, literal, viewer claim or crew value can carry.
 *
 * Words in a finding are crew's own, or a source's identifiers: never a source's message text (a cast
 * error echoes a value, DES §5.2), because an agent reads the findings.
 */

import { buildClientSchema, type IntrospectionQuery, Kind, parse, validate } from 'graphql';

import type { AppAction, AppCheckFinding, AppParamSchema, AppParamsSchema, AppQuery, AppRowWriteAction, McpToolClass } from '../../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass } from '../../mcp/classify.js';
import { McpRegistryError, type McpRegistry } from '../../mcp/registry.js';
import { describeMysql } from '../../sources/catalog/mysql.js';
import { describePg } from '../../sources/catalog/postgres.js';
import { policyCatalog, type SqlCatalog } from '../../sources/catalog/types.js';
import { CREW_SOURCE_ROUTES } from '../../sources/crew-source.js';
import { DialRefusedError, type DialOptions } from '../../sources/dialer.js';
import { pgReadOnly } from '../../sources/drivers/postgres.js';
import { SourceQueryError } from '../../sources/drivers/types.js';
import { checkGraphqlRead } from '../../sources/graphql.js';
import { sqlConnectArgs } from '../../sources/kinds.js';
import { checkReadPolicy } from '../../sources/policy/index.js';
import { pgTableSafety, type SafetyColumn } from '../../sources/safety/postgres.js';
import { checkSqlQuery, type SqlSourceHandle } from '../../sources/sql.js';
import { snapshotPath } from '../../sources/uploads.js';
import { baseTypeSql, pgExactFitIn, type FitItem } from '../actions/pg-fit.js';
import { crewNow, crewValueFits, inputForm, paramFits, writableKind } from '../actions/values.js';
import { ArgTypeError, checkGraphqlVariables, checkToolArgs, type Provider, providerOf } from './arg-types.js';
import type { AppSourceStage, AppSourceStageInput, AppSourceStageResult } from '../check.js';
import { crewQueryContract, graphqlMutationContract, graphqlQueryContract, graphqlRootSignatures, paramOrder, relationTerms, rowWriteContract, splitTable, sqlQueryContract, toolActionContract, toolQueryContract } from './contract.js';
import { lookupSource, pinOf, queryKindFits, type AppSource } from './sources.js';
import { crewPathValueOk, parseCrewQueryText, parseToolQueryText, type QueryArg } from './texts.js';

export interface SourceStageDeps {
  registry: McpRegistry | null;
  /** Tests: how connections resolve. */
  dial?: DialOptions;
  /** Tests: where upload snapshots are. */
  snapshotDir?: string;
}

/** A finding the item could not get past. */
class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stage: AppCheckFinding['stage'] = 'source',
  ) {
    super(message);
  }
}

const INTEGRAL_PG = new Set(['smallint', 'integer', 'bigint']);
const NUMERIC_PG = new Set([...INTEGRAL_PG, 'numeric', 'real', 'double precision']);
const TEXT_PG = new Set(['text', 'character varying', 'character', 'name']);

/** Whether a declared parameter can be sent to a Postgres placeholder the server inferred as `pgType`. */
function paramTypeFits(p: AppParamSchema, pgType: string): boolean {
  const base = pgType.replace(/\(.*\)$/, '').replace(/\[\]$/, '');
  if (pgType.endsWith('[]')) return p.type === 'array' && p.items !== undefined && paramTypeFits({ type: p.items.type }, base);
  if (p.type === 'array') return false;
  if (p.type === 'boolean') return base === 'boolean' || TEXT_PG.has(base);
  // An integer fills any number; a fraction (`number`) never an integral placeholder (codex r1).
  if (p.type === 'integer') return NUMERIC_PG.has(base) || TEXT_PG.has(base);
  if (p.type === 'number') return (NUMERIC_PG.has(base) && !INTEGRAL_PG.has(base)) || TEXT_PG.has(base);
  // A string: anything but a number or a boolean (dates, uuids, enums, json are typed from text).
  return !NUMERIC_PG.has(base) && base !== 'boolean' && base !== 'unknown';
}

/** Whether a Postgres result column of `pgType` can carry a declared output column type. */
function outputTypeFits(declared: AppQuery['output'][number]['type'], pgType: string): boolean {
  const base = pgType.replace(/\(.*\)$/, '');
  switch (declared) {
    case 'integer':
      return base === 'smallint' || base === 'integer' || base === 'bigint';
    case 'number':
      return NUMERIC_PG.has(base);
    case 'boolean':
      return base === 'boolean';
    case 'date':
      return base === 'date';
    case 'datetime':
      return base === 'timestamp without time zone' || base === 'timestamp with time zone';
    case 'string':
      return true; // rendered as text
  }
}

/** An error from reaching a source, in crew's words only. */
function unreachable(err: unknown): Refused {
  if (err instanceof Refused) return err;
  if (err instanceof ArgTypeError) return new Refused(err.code, err.message);
  if (err instanceof DialRefusedError) return new Refused(err.code, `the connection to the source was refused (${err.code})`);
  if (err instanceof McpRegistryError) return new Refused(err.code, `the source cannot be used (${err.code})`);
  if (err instanceof SourceQueryError) {
    const st = err.sqlstate !== null ? ` (SQLSTATE ${err.sqlstate})` : '';
    return new Refused(err.errorClass === 'timeout' ? 'source_timeout' : err.errorClass === 'refused' ? (err.refusal ?? 'source_refused') : 'source_unavailable', `the source answered ${err.errorClass}${st}`);
  }
  return new Refused('source_unavailable', 'the source could not be reached to check this');
}

/** The declared output against the described result columns. */
function checkOutput(q: AppQuery, columns: Array<{ name: string; type: string }>, typed: boolean): void {
  const names = columns.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new Refused('output_columns', `the query returns a column name twice (${names.join(', ')}): alias each one`);
  if (columns.length !== q.output.length) throw new Refused('output_columns', `the query returns ${columns.length} columns (${names.join(', ')}); ${q.output.length} are declared`);
  for (const o of q.output) {
    const c = columns.find((x) => x.name === o.name);
    if (c === undefined) throw new Refused('output_columns', `the query returns no column ${JSON.stringify(o.name)} (it returns ${names.join(', ')})`);
    if (typed && !outputTypeFits(o.type, c.type)) throw new Refused('output_type', `column ${o.name} is ${c.type} at the source, which is not a declared ${o.type}`);
  }
}

/** Each argument's provider (a declared parameter, or a literal); an undeclared parameter is refused. */
function providers(args: Record<string, QueryArg>, params: AppParamsSchema | undefined): Record<string, Provider> {
  const out: Record<string, Provider> = Object.create(null) as Record<string, Provider>;
  for (const [k, a] of Object.entries(args)) {
    try {
      out[k] = providerOf(a, params);
    } catch (err) {
      if (err instanceof ArgTypeError) throw new Refused(err.code, err.message, 'spec');
      throw err;
    }
  }
  return out;
}

/** A query's parameters as the providers of a GraphQL document's variables, by name. */
function paramProviders(params: AppParamsSchema | undefined): Record<string, Provider> {
  return providers(Object.fromEntries(Object.keys(params?.properties ?? {}).map((n) => [n, { kind: 'param' as const, name: n }])), params);
}

const classOf = (t: { annotations: Parameters<typeof deriveToolClass>[0]; classOverride: McpToolClass | null }): McpToolClass => effectiveToolClass(deriveToolClass(t.annotations), t.classOverride);

/** One check call's secrets (resolved once per source) and fresh catalogs (described once per source). */
type SecretOf = ((s: AppSource & { config: unknown }) => Promise<string | null>) & { fresh: (name: string, describe: () => Promise<SqlCatalog>) => Promise<SqlCatalog> };

export class AppsSourceStage implements AppSourceStage {
  constructor(private readonly deps: SourceStageDeps) {}

  async check(input: AppSourceStageInput): Promise<AppSourceStageResult> {
    const out: AppSourceStageResult = { findings: [], sources: {}, queries: {}, actions: {}, uploads: {} };
    const sources = new Map<string, Promise<AppSource | null>>();
    const secrets = new Map<string, Promise<string | null>>();
    const source = (name: string): Promise<AppSource | null> => {
      let s = sources.get(name);
      if (s === undefined) {
        s = lookupSource(this.deps.registry, name);
        sources.set(name, s);
      }
      return s;
    };
    const freshCatalogs = new Map<string, Promise<SqlCatalog>>();
    const secretOf = ((s: AppSource & { config: unknown }): Promise<string | null> => {
      let p = secrets.get(s.name);
      if (p === undefined) {
        p = (async () => {
          const r = await this.deps.registry!.callSecret((s as { config: Parameters<McpRegistry['callSecret']>[0] }).config);
          if (r.missing) throw new Refused('secret_missing', `the source ${s.name}'s secret resolves to nothing; set it first`);
          return r.secret;
        })();
        secrets.set(s.name, p);
      }
      return p;
    }) as SecretOf;
    secretOf.fresh = (name, describe) => {
      let p = freshCatalogs.get(name);
      if (p === undefined) {
        p = describe();
        freshCatalogs.set(name, p);
      }
      return p;
    };
    const pinSource = (s: AppSource): void => {
      out.sources[s.name] = s.pin;
      if (s.kind === 'sql' && s.config.sql?.driver === 'sqlite' && typeof s.config.sql.snapshot === 'string') out.uploads[s.name] = { digest: s.config.sql.snapshot };
    };

    for (const id of input.queries) {
      const i = input.spec.queries.findIndex((q) => q.id === id);
      const q = input.spec.queries[i];
      if (q === undefined) {
        out.findings.push({ stage: 'source', code: 'unknown_query', path: '$.queries', message: `the check was asked about query ${id}, which the spec does not hold` });
        continue;
      }
      try {
        const s = await source(q.source);
        if (s === null) throw new Refused('unknown_source', `no source named ${q.source}`);
        if (!queryKindFits(q.kind, s)) throw new Refused('source_kind', `a ${q.kind} query cannot read ${q.source}, a ${s.kind} source`);
        out.queries[q.id] = await this.query(q, Object.hasOwn(input.queryText, q.id) ? input.queryText[q.id]! : '', s, secretOf);
        pinSource(s);
      } catch (err) {
        const r = unreachable(err);
        out.findings.push({ stage: r.stage, code: r.code, path: `$.queries[${i}]`, message: `query ${q.id}: ${r.message}` });
      }
    }
    for (const id of input.actions) {
      const i = input.spec.actions.findIndex((a) => a.id === id);
      const a = input.spec.actions[i];
      if (a === undefined) {
        out.findings.push({ stage: 'source', code: 'unknown_action', path: '$.actions', message: `the check was asked about action ${id}, which the spec does not hold` });
        continue;
      }
      try {
        const s = await source(a.source);
        if (s === null) throw new Refused('unknown_source', `no source named ${a.source}`);
        out.actions[a.id] = await this.action(a, s, secretOf);
        pinSource(s);
      } catch (err) {
        const r = unreachable(err);
        out.findings.push({ stage: r.stage, code: r.code, path: `$.actions[${i}]`, message: `action ${a.id}: ${r.message}` });
      }
    }
    return out;
  }

  private async query(q: AppQuery, text: string, s: AppSource, secretOf: SecretOf): Promise<string> {
    if (s.kind === 'crew') {
      const parsed = parseCrewQueryText(text);
      if (!parsed.ok) throw new Refused('query_text', parsed.why, 'spec');
      const route = CREW_SOURCE_ROUTES.find((r) => r.path === parsed.value.route);
      if (route === undefined) throw new Refused('crew_route', `the crew source does not read ${parsed.value.route}`);
      for (const p of route.params) if (!Object.hasOwn(parsed.value.params, p)) throw new Refused('crew_route', `${route.path} needs :${p}`);
      for (const p of Object.keys(parsed.value.params)) if (!route.params.includes(p)) throw new Refused('crew_route', `${route.path} has no :${p}`);
      // Each map on its own (codex/pi r1: a spread let a query value hide a path argument's parameter).
      const path = providers(parsed.value.params, q.params);
      providers(parsed.value.query, q.params);
      // A path segment is always there and never '', '.', '..' or ill-formed (the reader refuses those, codex r2).
      for (const [k, p] of Object.entries(path)) {
        if (p.kind === 'param' && !p.always) throw new Refused('crew_route', `:${k} of ${route.path} comes from parameter ${p.name}, which is optional with no default`);
        const known = p.kind === 'literal' ? [p.value] : p.kind === 'param' ? [...(p.schema.enum ?? []), ...(p.schema.default !== undefined ? [p.schema.default] : [])] : [];
        for (const v of known) if (!crewPathValueOk(v)) throw new Refused('crew_route', `:${k} of ${route.path} cannot be ${JSON.stringify(v)}`);
      }
      return crewQueryContract(route);
    }
    if (s.kind === 'rest' || s.kind === 'mcp-http' || s.kind === 'mcp-stdio') {
      const parsed = parseToolQueryText(text);
      if (!parsed.ok) throw new Refused('query_text', parsed.why, 'spec');
      const t = await this.tool(s, parsed.value.tool);
      if (classOf(t) !== 'read') throw new Refused('not_a_read', `${s.name}/${parsed.value.tool} is not accepted as a read on the source sheet`);
      checkToolArgs(providers(parsed.value.args, q.params), t.inputSchema);
      return toolQueryContract(s.kind, t, q.params);
    }
    if (s.kind === 'graphql') {
      const introspection = s.description?.introspection;
      if (introspection === undefined) throw new Refused('not_described', `${s.name} has not been described: describe it first`);
      const c = checkGraphqlRead(text, introspection);
      if (!c.ok) throw new Refused(c.code, c.detail, 'policy');
      const declared = Object.keys(q.params?.properties ?? {});
      for (const d of declared) if (!c.variables.includes(d)) throw new Refused('unused_param', `parameter ${d} is not a variable of the document`);
      checkGraphqlVariables(text, introspection, paramProviders(q.params));
      const sigs = graphqlRootSignatures(text, introspection, 'query');
      if (sigs === null) throw new Refused('invalid', 'the document selects a root field the schema does not have');
      return graphqlQueryContract(sigs, q.params);
    }
    if (s.kind !== 'sql') throw new Refused('source_kind', `a ${q.kind} query cannot read ${q.source}`);
    const description = s.description;
    if (description === null) throw new Refused('not_described', `${s.name} has not been described: describe it first`);
    const catalog = description.catalog as SqlCatalog;
    const sql = s.config.sql;
    const driver = sql?.driver === 'sqlite' ? 'sqlite' : sql?.driver === 'mysql' ? 'mysql' : 'postgres';
    const views = s.config.viewsAllowed ?? [];
    const policy = await checkReadPolicy(driver, text, policyCatalog(catalog, driver === 'sqlite' ? [] : views));
    if (!policy.ok) throw new Refused(policy.code, policy.detail, 'policy');
    let handle: SqlSourceHandle;
    if (driver === 'sqlite') handle = { driver: 'sqlite', snapshotPath: snapshotPath(sql?.snapshot ?? '', this.deps.snapshotDir), catalog };
    else handle = { driver, connect: sqlConnectArgs(s.config, await secretOf(s), this.deps.dial ?? {}), catalog, viewsAllowed: views };
    const c = await checkSqlQuery(handle, text);
    if (!c.ok) {
      const fromSource = c.code === 'prepare' || c.code === 'authorizer';
      throw new Refused(c.code, fromSource ? `the source refused the query${c.sqlstate != null ? ` (SQLSTATE ${c.sqlstate})` : ''}` : c.detail, fromSource ? 'source' : 'policy');
    }
    const order = paramOrder(q.params);
    if (c.describe.params.length !== order.length) {
      throw new Refused('params', `the query uses ${c.describe.params.length} placeholders; ${order.length} parameters are declared ($n is the n-th declared parameter, and every one is used)`);
    }
    if (driver === 'postgres') {
      c.describe.params.forEach((t, n) => {
        const p = q.params!.properties[order[n]!]!;
        if (!paramTypeFits(p, t)) throw new Refused('param_type', `$${n + 1} (${order[n]}) is declared ${p.type}${p.type === 'array' ? ` of ${p.items?.type}` : ''}, and the source reads it as ${t}`);
      });
    }
    checkOutput(q, c.describe.columns, driver === 'postgres');
    // The contract hashes the STORED catalog (what a read recomputes later), so it must still be the
    // source's: a relation that changed since the describe is refused here (codex r1).
    if (driver !== 'sqlite') {
      const fresh = await this.fresh(s, driver, secretOf);
      const keys = policy.keys ?? [];
      if (canonicalJson(relationTerms(catalog, keys)) !== canonicalJson(relationTerms(fresh, keys))) {
        throw new Refused('catalog_stale', `what query ${q.id} reads at ${s.name} changed since the source was described: describe it again`);
      }
    }
    const contract = sqlQueryContract(driver, catalog, policy.keys ?? [], q.params);
    if (contract === null) throw new Refused('not_described', `${s.name}'s description does not cover every relation the query reads: describe it again`);
    return contract;
  }

  /** A tool of `s`, saved as the server shows it, read with `s`'s own config (codex r1: no other save's). */
  private async tool(s: AppSource & { config: Parameters<McpRegistry['callSecret']>[0] }, name: string) {
    const t = await this.deps.registry!.appTool(s.name, name);
    if (t === null) throw new Refused('unknown_tool', `${s.name} has no tool ${name}`);
    if (pinOf(t.config).descriptorHash !== s.pin.descriptorHash) throw new Refused('source_changed', `${s.name} was saved again while it was being checked: check again`);
    if (!t.bound) throw new Refused('tool_not_saved', `${s.name}/${name} is not saved as the server shows it now (or the server is off): save the source again`);
    return t.tool;
  }

  /** A fresh describe of a network SQL source's catalog: once per check call, never reused across calls. */
  private fresh(s: Extract<AppSource, { kind: 'sql' }>, driver: 'postgres' | 'mysql', secretOf: SecretOf): Promise<SqlCatalog> {
    return secretOf.fresh(s.name, async () => {
      const args = sqlConnectArgs(s.config, await secretOf(s), this.deps.dial ?? {});
      return driver === 'postgres' ? describePg(args) : describeMysql(args);
    });
  }

  private async action(a: AppAction, s: AppSource, secretOf: SecretOf): Promise<string> {
    if (a.kind === 'row-write') return this.rowWrite(a, s, secretOf);
    if (a.call.kind === 'tool') {
      if (s.kind !== 'rest' && s.kind !== 'mcp-http' && s.kind !== 'mcp-stdio') throw new Refused('source_kind', `a tool action calls a REST or MCP server; ${a.source} is a ${s.kind} source`);
      const t = await this.tool(s, a.call.tool);
      checkToolArgs(actionProviders(a.args, a.params), t.inputSchema);
      return toolActionContract(s.kind, t);
    }
    if (s.kind !== 'graphql') throw new Refused('source_kind', `a mutation action calls a GraphQL source; ${a.source} is a ${s.kind} source`);
    const introspection = s.description?.introspection;
    if (introspection === undefined) throw new Refused('not_described', `${s.name} has not been described: describe it first`);
    const sigs = checkMutation(a.call.mutation, introspection, Object.keys(a.args));
    checkGraphqlVariables(a.call.mutation, introspection, actionProviders(a.args, a.params));
    return graphqlMutationContract(sigs);
  }

  private async rowWrite(a: AppRowWriteAction, s: AppSource, secretOf: SecretOf): Promise<string> {
    if (s.kind !== 'sql' || s.config.sql?.driver !== 'postgres') throw new Refused('writes_not_supported', `row writes are Postgres only in v1; ${a.source} is not a Postgres source`);
    const { schema, name } = splitTable(a.table);
    const set = Object.keys(a.set ?? {});
    const key = Object.keys(a.key);
    const args = sqlConnectArgs(s.config, await secretOf(s), this.deps.dial ?? {});
    const r = await pgTableSafety(args, schema, name, { op: a.op, set, key });
    if (!r.safe) throw new Refused(r.reasons[0]?.code ?? 'unsafe_table', r.reasons.map((x) => x.detail).join('; '));
    const fixed = checkRowValues(a, r.columns);
    // A value the app fixes (a literal, crew's now) must survive its column's full type: the database says (P28, pi r1).
    if (fixed.length > 0) {
      const misfits = await pgReadOnly(args, (tx) => pgExactFitIn(tx, fixed));
      if (misfits.length > 0) throw new Refused('value_does_not_fit', misfits.map((m) => `the app's value for ${a.table}.${m.column} ${m.why}`).join('; '));
    }
    return rowWriteContract({ schema, table: name, op: a.op, set, key, fingerprint: r.fingerprint });
  }
}

/** One mutation, one root field, valid against the schema; its variables exactly the action's arguments. Answers the field's signature. */
export function checkMutation(mutation: string, introspection: IntrospectionQuery, args: string[]): string[] {
  let doc;
  try {
    doc = parse(mutation, { noLocation: true, maxTokens: 10_000 });
  } catch {
    throw new Refused('parse', 'the mutation does not parse', 'policy');
  }
  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  if (ops.length !== 1 || doc.definitions.length !== 1) throw new Refused('operations', 'a mutation action is a document with exactly one operation and no fragments', 'policy');
  const op = ops[0] as Extract<(typeof doc.definitions)[number], { kind: Kind.OPERATION_DEFINITION }>;
  if (op.operation !== 'mutation') throw new Refused('not_mutation', `a ${op.operation} is not a mutation`, 'policy');
  if (op.selectionSet.selections.length !== 1 || op.selectionSet.selections[0]!.kind !== Kind.FIELD) throw new Refused('root_fields', 'a mutation action selects exactly one root field', 'policy');
  let errors: readonly Error[];
  try {
    errors = validate(buildClientSchema(introspection), doc);
  } catch {
    throw new Refused('schema', "the source's described schema is not valid; describe the source again");
  }
  if (errors.length > 0) throw new Refused('invalid', errors.map((e) => e.message).join('; '), 'policy');
  const vars = (op.variableDefinitions ?? []).map((v) => v.variable.name.value);
  for (const v of vars) if (!args.includes(v)) throw new Refused('unknown_argument', `the mutation's variable $${v} has no argument`);
  for (const n of args) if (!vars.includes(n)) throw new Refused('unknown_argument', `the argument ${n} is not a variable of the mutation`);
  const sigs = graphqlRootSignatures(mutation, introspection, 'mutation');
  if (sigs === null) throw new Refused('invalid', 'the mutation selects a field the schema does not have');
  return sigs;
}

/** Every set and key value against its column's one input form (DES §7.4 "Values must fit exactly"). */
export function checkRowValues(a: AppRowWriteAction, columns: readonly SafetyColumn[]): FitItem[] {
  const fixed: FitItem[] = [];
  const props = a.params?.properties ?? {};
  const entries: Array<[string, NonNullable<AppRowWriteAction['set']>[string]]> = [...Object.entries(a.set ?? {}), ...Object.entries(a.key)];
  for (const [col, v] of entries) {
    const c = columns.find((x) => x.name === col);
    if (c === undefined) throw new Refused('unknown_column', `${a.table} has no column ${col}`);
    if (c.identity === 'a' && Object.hasOwn(a.set ?? {}, col)) throw new Refused('identity_column', `${a.table}.${col} is GENERATED ALWAYS AS IDENTITY: the database allocates it, which v1 row writes do not do`);
    const kind = writableKind(c);
    if (kind === null) throw new Refused('written_type', `${a.table}.${col} is ${c.type}, which a v1 row write cannot write or key on`);
    const at = `${a.table}.${col} (${c.type})`;
    if (v.kind === 'param') {
      const p = Object.hasOwn(props, v.name) ? props[v.name]! : undefined;
      if (p === undefined) throw new Refused('unknown_param', `parameter ${JSON.stringify(v.name)} is not declared`, 'spec');
      if (p.from !== undefined) {
        if (p.from === 'viewer.groups' || (kind !== 'text' && kind !== 'varchar')) throw new Refused('value_type', `${at} cannot take ${p.from}: a viewer claim goes into a text column`);
        continue;
      }
      const problem = paramFits(kind, p, c);
      if (problem !== null) throw new Refused('value_type', `${at}: ${problem} (parameter ${v.name} is ${p.type}${p.format !== undefined ? `, format ${p.format}` : ''})`);
      // Values the schema already names must also survive the column's full type (codex r2).
      for (const known of [...(p.enum ?? []), ...(p.default !== undefined ? [p.default] : [])]) {
        const f = inputForm(kind, known, { nullable: !c.notnull, ...(c.enumLabels !== undefined ? { enumLabels: c.enumLabels } : {}) });
        if (f.ok && f.text !== null) fixed.push({ column: col, full: c.type, base: baseTypeSql(c), text: f.text });
      }
    } else if (v.kind === 'literal') {
      const f = inputForm(kind, v.value, { nullable: !c.notnull, ...(c.enumLabels !== undefined ? { enumLabels: c.enumLabels } : {}) });
      if (!f.ok) throw new Refused('value_type', `the literal for ${at} ${f.why}`);
      if (f.text !== null) fixed.push({ column: col, full: c.type, base: baseTypeSql(c), text: f.text });
    } else if (v.kind === 'viewer') {
      if (kind !== 'text' && kind !== 'varchar') throw new Refused('value_type', `${at} cannot take the viewer's ${v.claim}: a viewer claim goes into a text column`);
    } else if (!crewValueFits(kind, v.value)) {
      throw new Refused('value_type', `${at} cannot take crew's ${v.value === 'now' ? 'now (a timestamp)' : 'new uuid'}`);
    } else {
      // A value of exactly the precision crew fills (milliseconds for now; a canonical uuid) must survive the
      // column's full type: timestamp(0) would round now, varchar(3) would cut a uuid (codex/pi r2).
      const sample = v.value === 'now' ? crewNow(kind, new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678))) : 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      fixed.push({ column: col, full: c.type, base: baseTypeSql(c), text: sample });
    }
  }
  return fixed;
}

/** An action's argument values as providers. */
function actionProviders(args: Record<string, import('../../core/types.js').AppValue>, params: AppParamsSchema | undefined): Record<string, Provider> {
  const out: Record<string, Provider> = Object.create(null) as Record<string, Provider>;
  for (const [k, v] of Object.entries(args)) {
    try {
      out[k] = providerOf(v, params);
    } catch (err) {
      if (err instanceof ArgTypeError) throw new Refused(err.code, err.message, 'spec');
      throw err;
    }
  }
  return out;
}
