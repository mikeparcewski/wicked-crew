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

import { buildClientSchema, type IntrospectionQuery, Kind, parse, type GraphQLSchema } from 'graphql';

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
  const relations: unknown[] = [];
  if (driver !== 'sqlite') {
    if (catalog === null) return null;
    const byKey = new Map(catalog.relations.map((r) => [relKey(r.schema, r.name), r] as const));
    for (const k of [...new Set(relationKeys)].sort()) {
      const r = byKey.get(k);
      if (r === undefined) return null;
      relations.push({ key: k, kind: r.kind, foreignBelow: r.foreignDescendant === true, columns: r.columns.map((c) => [c.name, c.type, c.nullable]) });
    }
  }
  return sha({ v: CONTRACT_VERSION, kind: 'sql', driver, params: paramOrder(params), relations });
}

/** The person's acceptance of a registry tool, as the contract pins it. */
function toolTerms(sourceKind: string, tool: McpToolRecord): Record<string, unknown> {
  return {
    sourceKind,
    tool: tool.name,
    schemaHash: tool.schemaHash,
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

/** The signature of each root field `document` selects, against the introspected schema; `null` if one is unknown. */
export function graphqlRootSignatures(document: string, introspection: IntrospectionQuery, operation: 'query' | 'mutation'): string[] | null {
  let schema: GraphQLSchema;
  try {
    schema = buildClientSchema(introspection);
  } catch {
    return null;
  }
  const root = operation === 'query' ? schema.getQueryType() : schema.getMutationType();
  if (root === null || root === undefined) return null;
  const fields = root.getFields();
  const out: string[] = [];
  let doc;
  try {
    doc = parse(document);
  } catch {
    return null;
  }
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const sel of def.selectionSet.selections) {
      if (sel.kind !== Kind.FIELD) return null; // a fragment at the root: the check refuses it
      const f = fields[sel.name.value];
      if (f === undefined) return null;
      out.push(`${f.name}(${f.args.map((a) => `${a.name}: ${String(a.type)}`).join(', ')}): ${String(f.type)}`);
    }
  }
  return out.sort();
}

/** A GraphQL query: the signatures of the root fields it selects, and its variables (= parameters by name). */
export function graphqlQueryContract(signatures: readonly string[], params: AppParamsSchema | undefined): string {
  return sha({ v: CONTRACT_VERSION, kind: 'graphql-query', fields: [...signatures], params: Object.keys(params?.properties ?? {}).sort() });
}

/** A GraphQL mutation action: its one root field's signature. */
export function graphqlMutationContract(signature: string): string {
  return sha({ v: CONTRACT_VERSION, kind: 'graphql-mutation', field: signature });
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
