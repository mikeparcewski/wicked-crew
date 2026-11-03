/**
 * Contract hashes (DES-APPS-001 §4 `apps.lock.json`, §7.2 step 4, §9.4): what each query and action USES,
 * hashed, so a source that changed under an accepted version is noticed at run.
 *
 * ONE definition, used three times: the source stage (check time) writes them into the lock; the executor
 * recomputes a query's at every read and the write path an action's at grant, prepare and run. Each is
 * recomputable WITHOUT executing anything: from the source's stored catalog, the registry's tool record, the
 * GraphQL introspection, the crew route table, or (a row write) the table safety check's fingerprint.
 *
 * Every hash carries the ordered parameter names where the text binds parameters by position (`$n`, `?`):
 * the n-th declared parameter is `$n`, so a reorder of `params.properties` changes the contract and is
 * re-checked, never silently re-bound.
 */

import { createHash } from 'node:crypto';

import { buildClientSchema, type DocumentNode, getNamedType, type GraphQLSchema, type GraphQLType, type IntrospectionQuery, isAbstractType, isEnumType, isInputObjectType, isScalarType, isUnionType, parse, TypeInfo, typeFromAST, visit, visitWithTypeInfo } from 'graphql';

import type { AppParamsSchema } from '../../core/types.js';
import { canonicalJson, deriveToolClass, effectiveToolClass } from '../../mcp/classify.js';
import type { McpToolRecord } from '../../mcp/registry-store.js';
import type { SqlCatalog } from '../../sources/catalog/types.js';
import { relKey } from '../../sources/policy/types.js';

/** Bumped when a contract's definition changes: every older lock then refuses until it is checked again. */
export const CONTRACT_VERSION = 1;

const sha = (v: unknown): string => createHash('sha256').update(canonicalJson(v)).digest('hex');

/** The declared parameter names in declaration order: `$n` (and the n-th `?`) binds the n-th. */
export function paramOrder(params: AppParamsSchema | undefined): string[] {
  return params === undefined ? [] : Object.keys(params.properties);
}

/**
 * A SQL query's contract. Postgres and MySQL: the kind and every column (name, type, nullability) of each
 * relation the read policy found it reading, from the stored catalog. SQLite: the snapshot is pinned by the
 * source's descriptor (its digest), so only the parameters. `null` when a relation is not in the catalog
 * (the policy refuses such a read anyway).
 */
export function sqlQueryContract(driver: 'postgres' | 'mysql' | 'sqlite', catalog: SqlCatalog | null, relationKeys: readonly string[], params: AppParamsSchema | undefined): string | null {
  const relations = driver === 'sqlite' ? [] : relationTerms(catalog, relationKeys);
  if (relations === null) return null;
  return sha({ v: CONTRACT_VERSION, kind: 'sql', driver, params: paramOrder(params), relations });
}

/**
 * What a SQL read relies on in each relation it reads, from a catalog: its kind, whether a foreign table is
 * below it, its row security, and every column (name, type, nullability, enum labels). `null` when a
 * relation is not in the catalog. The source stage compares a fresh describe's terms with the stored ones.
 */
export function relationTerms(catalog: SqlCatalog | null, relationKeys: readonly string[]): unknown[] | null {
  if (catalog === null) return null;
  const byKey = new Map(catalog.relations.map((r) => [relKey(r.schema, r.name), r] as const));
  const out: unknown[] = [];
  for (const k of [...new Set(relationKeys)].sort()) {
    const r = byKey.get(k);
    if (r === undefined) return null;
    // Enum labels and row security are part of what a read relies on (codex r1).
    out.push({
      key: k,
      kind: r.kind,
      foreignBelow: r.foreignDescendant === true,
      rowSecurity: r.rowSecurity === true,
      rowSecurityForced: r.rowSecurityForced === true,
      columns: r.columns.map((c) => [c.name, c.type, c.nullable, c.enumValues ?? null]),
    });
  }
  return out;
}

/** The person's acceptance of a registry tool, as the contract pins it. */
function toolTerms(sourceKind: string, tool: McpToolRecord): Record<string, unknown> {
  return {
    sourceKind,
    tool: tool.name,
    schemaHash: tool.schemaHash,
    // What the server shows now, and whether it still lists the tool (codex r1): a drift the registry
    // recorded changes the contract even before anyone saves again.
    observedSchemaHash: tool.observedSchemaHash,
    present: tool.present,
    class: effectiveToolClass(deriveToolClass(tool.annotations), tool.classOverride),
    rest: tool.rest ?? null,
  };
}

/** A REST or MCP query: the tool, its saved schema, the person's read acceptance, its request mapping. */
export function toolQueryContract(sourceKind: string, tool: McpToolRecord, params: AppParamsSchema | undefined): string {
  return sha({ v: CONTRACT_VERSION, kind: 'tool-query', ...toolTerms(sourceKind, tool), params: paramOrder(params) });
}

/** A REST or MCP write action: the same terms (the class is a write the person granted). */
export function toolActionContract(sourceKind: string, tool: McpToolRecord): string {
  return sha({ v: CONTRACT_VERSION, kind: 'tool-action', ...toolTerms(sourceKind, tool) });
}

/**
 * What a GraphQL document relies on in the introspected schema, as sorted lines: every field it selects at
 * any depth (through fragments; meta-fields included) with its parent type, arguments (types and defaults)
 * and type; every variable's type; and the full definition of every enum and input type those reach. `null`
 * when the document does not parse or names what the schema lacks (the check refuses it).
 */
export function graphqlRootSignatures(document: string, introspection: IntrospectionQuery, operation: 'query' | 'mutation'): string[] | null {
  let schema: GraphQLSchema;
  let doc: DocumentNode;
  try {
    schema = buildClientSchema(introspection);
    doc = parse(document, { noLocation: true, maxTokens: 10_000 });
  } catch {
    return null;
  }
  const root = operation === 'query' ? schema.getQueryType() : schema.getMutationType();
  if (root === null || root === undefined) return null;
  const lines = new Set<string>();
  const named = new Set<string>();
  const typeInfo = new TypeInfo(schema);
  let missing = false;
  const refer = (t: GraphQLType | null | undefined): void => {
    if (t === null || t === undefined) return;
    const n = getNamedType(t);
    if (n !== undefined) named.add(n.name);
  };
  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      OperationDefinition(node) {
        if (node.operation !== operation) missing = true;
      },
      Field() {
        const parent = typeInfo.getParentType();
        const def = typeInfo.getFieldDef();
        if (parent === null || parent === undefined || def === null || def === undefined) {
          missing = true;
          return;
        }
        lines.add(`field ${parent.name}.${def.name}(${def.args.map((a) => `${a.name}: ${String(a.type)}${a.defaultValue !== undefined ? ` = ${JSON.stringify(a.defaultValue)}` : ''}`).join(', ')}): ${String(def.type)}`);
        refer(def.type);
        for (const a of def.args) refer(a.type);
      },
      Directive() {
        // A directive's definition is part of what the document relies on (codex r2).
        const d = typeInfo.getDirective();
        if (d === null || d === undefined) {
          missing = true;
          return;
        }
        lines.add(`directive @${d.name}${d.isRepeatable ? ' repeatable' : ''}(${d.args.map((a) => `${a.name}: ${String(a.type)}${a.defaultValue !== undefined ? ` = ${JSON.stringify(a.defaultValue)}` : ''}`).join(', ')}) on ${[...d.locations].sort().join(' | ')}`);
        for (const a of d.args) refer(a.type);
      },
      InlineFragment() {
        refer(typeInfo.getType());
      },
      FragmentDefinition() {
        refer(typeInfo.getType());
      },
      VariableDefinition(node) {
        const t = typeFromAST(schema, node.type);
        if (t === undefined) {
          missing = true;
          return;
        }
        lines.add(`variable $${node.variable.name.value}: ${String(t)}`);
        refer(t);
      },
    }),
  );
  if (missing) return null;
  // The definitions of the enum and input types reached, transitively through input fields.
  const seen = new Set<string>();
  const queue = [...named];
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const t = schema.getType(n);
    if (isEnumType(t)) lines.add(`enum ${t.name} { ${t.getValues().map((v) => v.name).join(' ')} }`);
    else if (isInputObjectType(t)) {
      const fields = Object.values(t.getFields());
      lines.add(`input ${t.name} { ${fields.map((f) => `${f.name}: ${String(f.type)}${f.defaultValue !== undefined ? ` = ${JSON.stringify(f.defaultValue)}` : ''}`).join(', ')} }`);
      for (const f of fields) queue.push(getNamedType(f.type).name);
    } else if (isScalarType(t)) lines.add(`scalar ${t.name}`);
    else if (isAbstractType(t)) {
      // A union's or interface's possible types: a new member changes what a row can be (codex r2).
      const members = schema.getPossibleTypes(t).map((m) => m.name).sort();
      lines.add(`${isUnionType(t) ? 'union' : 'interface'} ${t.name} = ${members.join(' | ')}`);
    }
  }
  return [...lines].sort();
}

/** A GraphQL query: what it relies on in the schema ({@link graphqlRootSignatures}), and its parameters by name. */
export function graphqlQueryContract(signatures: readonly string[], params: AppParamsSchema | undefined): string {
  return sha({ v: CONTRACT_VERSION, kind: 'graphql-query', fields: [...signatures], params: Object.keys(params?.properties ?? {}).sort() });
}

/** A GraphQL mutation action: what its document relies on in the schema. */
export function graphqlMutationContract(signatures: readonly string[]): string {
  return sha({ v: CONTRACT_VERSION, kind: 'graphql-mutation', fields: [...signatures] });
}

/** A crew-source query: the route and the published shape it answers. */
export function crewQueryContract(route: { path: string; responseType: string }): string {
  return sha({ v: CONTRACT_VERSION, kind: 'crew', route: route.path, responseType: route.responseType });
}

/**
 * A row write: the table, the operation, the columns it sets and keys on, and the table safety check's
 * fingerprint (which hashes every definition the check reads, columns and types included, DES §7.4). A
 * grant binds to this; any change to the table withdraws it.
 */
export function rowWriteContract(input: { schema: string; table: string; op: string; set: readonly string[]; key: readonly string[]; fingerprint: string }): string {
  return sha({ v: CONTRACT_VERSION, kind: 'row-write', schema: input.schema, table: input.table, op: input.op, set: [...input.set].sort(), key: [...input.key].sort(), fingerprint: input.fingerprint });
}

/** `schema.table` → its two parts (the spec's grammar allows plain identifiers only). */
export function splitTable(table: string): { schema: string; name: string } {
  const dot = table.indexOf('.');
  return { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}
