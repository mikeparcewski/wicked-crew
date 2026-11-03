// DES-APPS-001 §7.4 "Values must fit exactly" (K2b): one accepted input form per written Postgres type, the
// strict JSON reader for jsonb, and which parameter schemas can carry a column's form.

import { buildSchema, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { crewNow, inputForm, jsonTextProblem, paramFits } from '../src/apps/actions/values.js';
import { checkGraphqlVariables, checkToolArgs, providerOf } from '../src/apps/exec/arg-types.js';
import { graphqlRootSignatures, sqlQueryContract, toolQueryContract } from '../src/apps/exec/contract.js';
import type { McpToolRecord } from '../src/mcp/registry-store.js';
import type { SqlCatalog } from '../src/sources/catalog/types.js';

const ok = (kind: Parameters<typeof inputForm>[0], v: unknown, nullable = false) => inputForm(kind, v, { nullable });

describe('the one input form per written type', () => {
  it('integers in range, as JSON integers; numeric as a decimal string or a whole number (a parsed fraction may already be rounded)', () => {
    expect(ok('int2', 32_767)).toEqual({ ok: true, text: '32767' });
    expect(ok('int2', 32_768).ok).toBe(false);
    expect(ok('int4', 1.5).ok).toBe(false);
    expect(ok('int8', 2 ** 53).ok).toBe(false);
    expect(ok('numeric', '-12.50')).toEqual({ ok: true, text: '-12.50' });
    expect(ok('numeric', 7)).toEqual({ ok: true, text: '7' });
    expect(ok('numeric', 0.1).ok).toBe(false);
    expect(ok('numeric', 12345678901234567890).ok).toBe(false); // pi r1: rounded by the parse
    expect(ok('numeric', '1e5').ok).toBe(false);
  });

  it('strings: no NUL, no lone surrogate (it would travel as U+FFFD, codex r1); a valid pair is fine', () => {
    expect(ok('text', 'a\u0000b').ok).toBe(false);
    expect(ok('text', '\uD800').ok).toBe(false);
    expect(ok('varchar', '\uDC00x').ok).toBe(false);
    expect(ok('text', '😀')).toEqual({ ok: true, text: '😀' });
    expect(inputForm('enum', 'high', { nullable: false, enumLabels: ['low', 'high'] }).ok).toBe(true);
    expect(inputForm('enum', 'urgent', { nullable: false, enumLabels: ['low', 'high'] }).ok).toBe(false);
  });

  it('dates and timestamps: calendar dates, six fractional digits at most; timestamptz needs an offset, timestamp refuses one', () => {
    expect(ok('date', '2026-02-29').ok).toBe(false);
    expect(ok('date', '2028-02-29').ok).toBe(true);
    expect(ok('timestamptz', '2026-11-03T08:32:00.123456Z').ok).toBe(true);
    expect(ok('timestamptz', '2026-11-03T08:32:00').ok).toBe(false);
    expect(ok('timestamp', '2026-11-03T08:32:00+01:00').ok).toBe(false);
    expect(ok('timestamp', '2026-11-03T08:32:00.1234567').ok).toBe(false);
    expect(crewNow('timestamptz', new Date('2026-11-03T08:32:00.123Z'))).toBe('2026-11-03T08:32:00.123000Z');
    expect(crewNow('timestamp', new Date('2026-11-03T08:32:00.123Z'))).toBe('2026-11-03T08:32:00.123000');
  });

  it('uuid canonical (sent lower case); null only where the column is nullable', () => {
    expect(ok('uuid', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11')).toEqual({ ok: true, text: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });
    expect(ok('uuid', 'a0eebc999c0b4ef8bb6d6bb9bd380a11').ok).toBe(false);
    expect(ok('text', null).ok).toBe(false);
    expect(ok('text', null, true)).toEqual({ ok: true, text: null });
  });

  it('jsonb: one value, no duplicate key, no decoded NUL or lone surrogate, numbers Postgres keeps exactly (codex r1)', () => {
    expect(jsonTextProblem('{"a": 1, "b": [true, null, "x"]}')).toBeNull();
    expect(jsonTextProblem('{"a": 1, "a": 2}')).toContain('twice');
    expect(jsonTextProblem('{"\\ud800": 1, "\\ud801": 2}')).not.toBeNull(); // both would encode as U+FFFD
    expect(jsonTextProblem('"\\ud800"')).not.toBeNull();
    expect(jsonTextProblem('"\\u0000"')).not.toBeNull();
    expect(jsonTextProblem('"\\\\u0000"')).toBeNull(); // six ordinary characters, not a NUL
    expect(jsonTextProblem('1e-16384')).not.toBeNull();
    expect(jsonTextProblem('1 2')).not.toBeNull();
    expect(jsonTextProblem('{"a": }')).not.toBeNull();
  });

  it('a parameter schema fits a column only when every value it can take is the column’s form (codex r1)', () => {
    expect(paramFits('numeric', { type: 'string' })).toBeNull();
    expect(paramFits('numeric', { type: 'string', format: 'date' })).not.toBeNull();
    expect(paramFits('numeric', { type: 'number' })).not.toBeNull();
    expect(paramFits('jsonb', { type: 'string', format: 'uuid' })).not.toBeNull();
    expect(paramFits('int2', { type: 'integer', default: 40_000 })).not.toBeNull();
    expect(paramFits('enum', { type: 'string', enum: ['low', 'urgent'] }, { enumLabels: ['low', 'high'] })).not.toBeNull();
    expect(paramFits('timestamp', { type: 'string', format: 'date-time' })).not.toBeNull();
    expect(paramFits('timestamptz', { type: 'string', format: 'date-time' })).toBeNull();
  });
});

describe('what an app sends against what the source takes (codex r1)', () => {
  it('a tool argument: its JSON type, its enum, a required property never optional', () => {
    const schema = { type: 'object', properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['OPEN', 'CLOSED'] } }, required: ['id'] };
    const params = { type: 'object' as const, properties: { id: { type: 'integer' as const }, s: { type: 'string' as const }, opt: { type: 'integer' as const } }, required: ['id', 's'] };
    expect(() => checkToolArgs({ id: providerOf({ kind: 'param', name: 'id' }, params) }, schema)).not.toThrow();
    expect(() => checkToolArgs({ id: providerOf({ kind: 'literal', value: 'bad' }, params) }, schema)).toThrow(/integer/);
    expect(() => checkToolArgs({ id: providerOf({ kind: 'param', name: 's' }, params) }, schema)).toThrow(/integer/);
    expect(() => checkToolArgs({ id: providerOf({ kind: 'param', name: 'opt' }, params) }, schema)).toThrow(/optional/);
    expect(() => checkToolArgs({ id: providerOf({ kind: 'literal', value: 1 }, params), status: providerOf({ kind: 'literal', value: 'DONE' }, params) }, schema)).toThrow(/values/);
  });

  it('a GraphQL variable: Int is an integer, an input object is refused, a non-null one is always filled', () => {
    const intro = introspectionFromSchema(buildSchema('input F { a: Int } enum S { OPEN CLOSED } type Q { t(id: Int!, s: S, f: F): Int } schema { query: Q }'));
    const params = { type: 'object' as const, properties: { id: { type: 'string' as const, default: 'x' }, n: { type: 'integer' as const }, req: { type: 'integer' as const }, s: { type: 'string' as const, enum: ['OPEN', 'DONE'] } }, required: ['req'] };
    const p = (name: string) => providerOf({ kind: 'param', name }, params);
    expect(() => checkGraphqlVariables('query ($id: Int!) { t(id: $id) }', intro, { id: p('id') })).toThrow(/Int/);
    expect(() => checkGraphqlVariables('query ($id: Int!) { t(id: $id) }', intro, { id: p('n') })).toThrow(/nothing/);
    expect(() => checkGraphqlVariables('query ($id: Int!) { t(id: $id) }', intro, { id: p('req') })).not.toThrow();
    expect(() => checkGraphqlVariables('query ($f: F) { t(id: 1, f: $f) }', intro, { f: p('id') })).toThrow(/input object/);
    expect(() => checkGraphqlVariables('query ($s: S) { t(id: 1, s: $s) }', intro, { s: p('s') })).toThrow(/DONE/);
  });

  it('r2: a required property needs an always-present provider (any schema); array items; an enum destination needs a closed set of values', () => {
    const params = { type: 'object' as const, properties: { opt: { type: 'string' as const }, tags: { type: 'array' as const, items: { type: 'string' as const } }, st: { type: 'string' as const, enum: ['OPEN'] }, free: { type: 'string' as const, default: 'OPEN' } }, required: [] };
    const p = (name: string) => providerOf({ kind: 'param', name }, params);
    expect(() => checkToolArgs({ x: p('opt') }, { required: ['x'] })).toThrow(/optional/);
    expect(() => checkToolArgs({ ids: p('tags') }, { properties: { ids: { type: 'array', items: { type: 'integer' } } } })).toThrow(/items/);
    const en = { properties: { status: { type: 'string', enum: ['OPEN', 'CLOSED'] } } };
    expect(() => checkToolArgs({ status: p('free') }, en)).toThrow(/enum/);
    expect(() => checkToolArgs({ status: p('st') }, en)).not.toThrow();
    expect(() => checkToolArgs({ status: providerOf({ kind: 'viewer', claim: 'email' }, params) }, en)).toThrow(/enum/);
  });

  it('r2: GraphQL takes an explicit null for a nullable variable, the minimum Int, and an enum only from a closed set', () => {
    const intro = introspectionFromSchema(buildSchema('enum S { OPEN CLOSED } type Q { t(n: Int, s: S, o: String): Int } schema { query: Q }'));
    const params = { type: 'object' as const, properties: { s: { type: 'string' as const, default: 'OPEN' }, se: { type: 'string' as const, enum: ['OPEN'] } }, required: [] };
    expect(() => checkGraphqlVariables('query ($o: String) { t(o: $o) }', intro, { o: providerOf({ kind: 'literal', value: null }, params) })).not.toThrow();
    expect(() => checkGraphqlVariables('query ($n: Int) { t(n: $n) }', intro, { n: providerOf({ kind: 'literal', value: -2147483648 }, params) })).not.toThrow();
    expect(() => checkGraphqlVariables('query ($s: S) { t(s: $s) }', intro, { s: providerOf({ kind: 'param', name: 's' }, params) })).toThrow(/enum/);
    expect(() => checkGraphqlVariables('query ($s: S) { t(s: $s) }', intro, { s: providerOf({ kind: 'param', name: 'se' }, params) })).not.toThrow();
  });

  it('r2: the GraphQL contract holds the directives a document uses and the members of a union it selects', () => {
    const a = introspectionFromSchema(buildSchema('directive @limit(count: Int = 1) on FIELD type A { id: Int } type B { id: Int } union R = A | B type Query { r: R x: Int }'));
    const b = introspectionFromSchema(buildSchema('directive @limit(count: Int = 100) on FIELD type A { id: Int } type B { id: Int } union R = A | B type Query { r: R x: Int }'));
    const c = introspectionFromSchema(buildSchema('directive @limit(count: Int = 1) on FIELD type A { id: Int } type B { id: Int } type C { id: Int } union R = A | B | C type Query { r: R x: Int }'));
    const d1 = 'query { x @limit }';
    expect(graphqlRootSignatures(d1, a, 'query')).not.toEqual(graphqlRootSignatures(d1, b, 'query'));
    const d2 = 'query { r { __typename ... on A { id } ... on B { id } } }';
    expect(graphqlRootSignatures(d2, a, 'query')).not.toEqual(graphqlRootSignatures(d2, c, 'query'));
  });

  it('r3: a known Int default is range-checked; tool array items in either spelling, and item enums, are checked; repeatable directives are in the contract', () => {
    const intro = introspectionFromSchema(buildSchema('type Q { t(n: Int): Int x: Int } schema { query: Q }'));
    const big = { type: 'object' as const, properties: { n: { type: 'integer' as const, default: 2_147_483_648 } }, required: [] };
    expect(() => checkGraphqlVariables('query ($n: Int) { t(n: $n) }', intro, { n: providerOf({ kind: 'param', name: 'n' }, big) })).toThrow(/Int/);
    const params = { type: 'object' as const, properties: { tags: { type: 'array' as const, items: { type: 'string' as const } } }, required: ['tags'] };
    const tags = providerOf({ kind: 'param', name: 'tags' }, params);
    expect(() => checkToolArgs({ ids: tags }, { properties: { ids: { type: 'array', items: { type: ['integer', 'null'] } } } })).toThrow(/items/);
    expect(() => checkToolArgs({ ids: tags }, { properties: { ids: { items: { type: 'integer' } } } })).toThrow(/items/);
    expect(() => checkToolArgs({ ids: tags }, { properties: { ids: { type: 'array', items: { type: 'string', enum: ['OPEN'] } } } })).toThrow(/item values/);
    const rep = introspectionFromSchema(buildSchema('directive @tag repeatable on FIELD type Query { x: Int }'));
    const one = introspectionFromSchema(buildSchema('directive @tag on FIELD type Query { x: Int }'));
    expect(graphqlRootSignatures('query { x @tag }', rep, 'query')).not.toEqual(graphqlRootSignatures('query { x @tag }', one, 'query'));
  });

  it('the GraphQL contract holds every selected field at any depth, fragments and meta-fields included', () => {
    const a = introspectionFromSchema(buildSchema('type Item { id: Int } type Query { item: Item }'));
    const b = introspectionFromSchema(buildSchema('type Item { id: String } type Query { item: Item }'));
    const doc = 'query { ...R __typename } fragment R on Query { item { id } }';
    const sa = graphqlRootSignatures(doc, a, 'query');
    expect(sa).not.toBeNull();
    expect(sa).not.toEqual(graphqlRootSignatures(doc, b, 'query'));
  });

  it('the SQL contract holds enum labels and row security; the tool contract the drift the registry saw', () => {
    const cat = (labels: string[], rls: boolean): SqlCatalog => ({
      dialect: 'postgres',
      database: 'd',
      describedAt: 'x',
      relations: [{ schema: 's', name: 't', kind: 'table', rowEstimate: null, rowSecurity: rls, primaryKey: ['id'], foreignKeys: [], columns: [{ name: 'p', type: 's.prio', nullable: true, enumValues: labels }] }],
    });
    const keys = ['s\u0000t'];
    const base = sqlQueryContract('postgres', cat(['low', 'high'], false), keys, undefined);
    expect(sqlQueryContract('postgres', cat(['low', 'urgent'], false), keys, undefined)).not.toBe(base);
    expect(sqlQueryContract('postgres', cat(['low', 'high'], true), keys, undefined)).not.toBe(base);
    const forced = cat(['low', 'high'], true);
    expect(sqlQueryContract('postgres', { ...forced, relations: [{ ...forced.relations[0]!, rowSecurityForced: true }] }, keys, undefined)).not.toBe(sqlQueryContract('postgres', forced, keys, undefined));
    const tool: McpToolRecord = { name: 't', description: null, inputSchema: null, outputSchema: null, annotations: { readOnlyHint: true }, classOverride: null, enabled: false, schemaHash: 'h', observedSchemaHash: 'h', present: true };
    expect(toolQueryContract('rest', { ...tool, observedSchemaHash: 'h2' }, undefined)).not.toBe(toolQueryContract('rest', tool, undefined));
    expect(toolQueryContract('rest', { ...tool, present: false }, undefined)).not.toBe(toolQueryContract('rest', tool, undefined));
  });
});
