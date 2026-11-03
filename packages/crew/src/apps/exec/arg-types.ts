/**
 * Whether what an app sends fits what the source takes (DES-APPS-001 §9.2 step 3: "Arguments against the
 * input schema", "the document against the introspected schema"), checked when a version lands:
 *
 *  - a REST/MCP tool argument against the tool's saved input schema (its JSON Schema `type`, `enum`, and
 *    required properties);
 *  - a GraphQL variable against its declared type (Int, Float, String, ID, Boolean, enums, lists; an input
 *    object cannot be filled from a parameter), including whether a non-null variable is always filled.
 *
 * Each argument's PROVIDER is a declared parameter (by its schema), a literal fixed by the app, a viewer
 * claim (a string) or a crew value (`now`, `uuid`: strings).
 */

import { buildClientSchema, type GraphQLInputType, type IntrospectionQuery, isEnumType, isInputObjectType, isListType, isNonNullType, isScalarType, Kind, parse, typeFromAST } from 'graphql';

import type { AppParamSchema, AppParamsSchema, AppValue } from '../../core/types.js';

export type Provider =
  | { kind: 'param'; name: string; schema: AppParamSchema; always: boolean }
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'viewer' }
  | { kind: 'crew'; value: 'now' | 'uuid' };

export class ArgTypeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The provider an app value names, or an error for an undeclared parameter. */
export function providerOf(v: AppValue | { kind: 'param'; name: string } | { kind: 'literal'; value: string | number | boolean | null }, params: AppParamsSchema | undefined): Provider {
  if (v.kind === 'param') {
    const schema = params !== undefined && Object.hasOwn(params.properties, v.name) ? params.properties[v.name]! : undefined;
    if (schema === undefined) throw new ArgTypeError('unknown_param', `parameter ${JSON.stringify(v.name)} is not declared`);
    const always = schema.from !== undefined || schema.default !== undefined || (params?.required ?? []).includes(v.name);
    return { kind: 'param', name: v.name, schema, always };
  }
  if (v.kind === 'literal') return { kind: 'literal', value: v.value };
  if (v.kind === 'viewer') return { kind: 'viewer' };
  return { kind: 'crew', value: v.value };
}

/** The JSON types a provider sends (an integer is also a number). */
function sends(p: Provider): Set<string> {
  if (p.kind === 'viewer' || p.kind === 'crew') return new Set(['string']);
  if (p.kind === 'literal') {
    const v = p.value;
    if (v === null) return new Set(['null']);
    if (typeof v === 'number') return new Set(Number.isSafeInteger(v) ? ['integer', 'number'] : ['number']);
    return new Set([typeof v]);
  }
  const t = p.schema.from === 'viewer.groups' ? 'array' : p.schema.type;
  return new Set(t === 'integer' ? ['integer', 'number'] : [t]);
}

/** The values a provider is known to take (a literal; a parameter's enum and default). */
function knownValues(p: Provider): unknown[] {
  if (p.kind === 'literal') return [p.value];
  if (p.kind === 'param') return [...(p.schema.enum ?? []), ...(p.schema.default !== undefined ? [p.schema.default] : [])];
  return [];
}

/**
 * A tool's arguments against its saved input schema: every name is a property (when it lists them), every
 * required property is supplied, each provider sends a type the property takes, and every known value is in
 * the property's `enum`. A property without `type` takes any JSON type.
 */
export function checkToolArgs(args: Record<string, Provider>, inputSchema: Record<string, unknown> | null): void {
  const props = inputSchema !== null && typeof inputSchema['properties'] === 'object' && inputSchema['properties'] !== null ? (inputSchema['properties'] as Record<string, unknown>) : null;
  if (props !== null) {
    for (const n of Object.keys(args)) if (!Object.hasOwn(props, n)) throw new ArgTypeError('unknown_argument', `the tool takes no argument ${JSON.stringify(n)}`);
  }
  const required = Array.isArray(inputSchema?.['required']) ? (inputSchema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  for (const r of required) if (!Object.hasOwn(args, r)) throw new ArgTypeError('missing_argument', `the tool needs the argument ${JSON.stringify(r)}`);
  if (props === null) return;
  for (const [name, p] of Object.entries(args)) {
    const prop = props[name];
    if (prop === null || typeof prop !== 'object') continue;
    const declared = (prop as { type?: unknown }).type;
    const types = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared.filter((t): t is string => typeof t === 'string') : null;
    if (types !== null && types.length > 0) {
      const s = sends(p);
      if (!types.some((t) => s.has(t))) throw new ArgTypeError('argument_type', `the tool's ${name} is ${types.join(' or ')}, and the app sends ${[...s].join(' or ')}${p.kind === 'param' ? ` (parameter ${p.name})` : ''}`);
      if (required.includes(name) && p.kind === 'param' && !p.always) throw new ArgTypeError('argument_type', `the tool needs ${name}, and parameter ${p.name} is optional with no default`);
    }
    const allowed = (prop as { enum?: unknown }).enum;
    if (Array.isArray(allowed)) {
      for (const v of knownValues(p)) if (!allowed.some((a) => a === v)) throw new ArgTypeError('argument_type', `${JSON.stringify(v)} is not one of the tool's values for ${name}`);
    }
  }
}

const INT32 = 2_147_483_647;

/** Why `p` cannot fill a variable of `type`, or `null`. */
function gqlProblem(type: GraphQLInputType, hasDefault: boolean, p: Provider, name: string): string | null {
  let t: GraphQLInputType = type;
  if (isNonNullType(t)) {
    if (!hasDefault && ((p.kind === 'param' && !p.always) || (p.kind === 'literal' && p.value === null))) return `$${name} is ${String(type)}, and the app may send nothing for it`;
    t = t.ofType;
  }
  if (isListType(t)) {
    if (p.kind !== 'param' || p.schema.type !== 'array') return `$${name} is a list (${String(type)}); only an array parameter fills it`;
    const inner = getInner(t.ofType);
    const item = p.schema.from === 'viewer.groups' ? 'string' : (p.schema.items?.type ?? 'string');
    return scalarFits(inner, new Set(item === 'integer' ? ['integer', 'number'] : [item]), [], name, type);
  }
  if (p.kind === 'param' && p.schema.type === 'array') return `$${name} is ${String(type)}, not a list`;
  return scalarFits(t, sends(p), knownValues(p), name, type);
}

function getInner(t: GraphQLInputType): GraphQLInputType {
  return isNonNullType(t) ? t.ofType : t;
}

function scalarFits(t: GraphQLInputType, s: Set<string>, values: unknown[], name: string, whole: GraphQLInputType): string | null {
  if (isInputObjectType(t)) return `$${name} is the input object ${t.name}; an app parameter cannot fill it`;
  if (isListType(t) || isNonNullType(t)) return `$${name} nests lists (${String(whole)}), which an app parameter cannot fill`;
  const words = `$${name} is ${String(whole)}, and the app sends ${[...s].join(' or ')}`;
  if (isEnumType(t)) {
    if (!s.has('string')) return words;
    const names = new Set(t.getValues().map((v) => v.name));
    for (const v of values) if (typeof v !== 'string' || !names.has(v)) return `${JSON.stringify(v)} is not a value of ${t.name} ($${name})`;
    return null;
  }
  if (!isScalarType(t)) return words;
  switch (t.name) {
    case 'Int':
      if (!s.has('integer')) return words;
      for (const v of values) if (typeof v !== 'number' || !Number.isInteger(v) || Math.abs(v) > INT32) return `${JSON.stringify(v)} is not an Int ($${name})`;
      return null;
    case 'Float':
      return s.has('number') ? null : words;
    case 'String':
      return s.has('string') ? null : words;
    case 'ID':
      return s.has('string') || s.has('integer') ? null : words;
    case 'Boolean':
      return s.has('boolean') ? null : words;
    default:
      return s.has('null') && s.size === 1 ? words : null; // a custom scalar: its own coercion decides
  }
}

/**
 * The document's variables against what fills them: each variable has exactly one provider, of a type the
 * variable takes. `providers` maps a variable name to its provider (a query's parameters by name; an
 * action's arguments).
 */
export function checkGraphqlVariables(document: string, introspection: IntrospectionQuery, providers: Record<string, Provider>): void {
  const schema = buildClientSchema(introspection);
  const doc = parse(document, { noLocation: true, maxTokens: 10_000 });
  for (const def of doc.definitions) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    for (const v of def.variableDefinitions ?? []) {
      const name = v.variable.name.value;
      const p = Object.hasOwn(providers, name) ? providers[name] : undefined;
      if (p === undefined) throw new ArgTypeError('unknown_param', `the document's variable $${name} has nothing to fill it`);
      const t = typeFromAST(schema, v.type) as GraphQLInputType | undefined;
      if (t === undefined) throw new ArgTypeError('invalid', `the document's variable $${name} has a type the schema lacks`);
      const problem = gqlProblem(t, v.defaultValue !== undefined, p, name);
      if (problem !== null) throw new ArgTypeError('variable_type', problem);
    }
  }
}
