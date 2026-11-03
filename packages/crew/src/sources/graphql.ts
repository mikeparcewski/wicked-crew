/**
 * GraphQL sources (DES-APPS-001 §5.1): describe by introspection, check a document, read, all through
 * the ONE dialer (https, the source's confirmed ranges, no redirects).
 *
 * - A read is a document with EXACTLY one operation, a `query` (fragments allowed); a `mutation` is a
 *   write and a `subscription` is not a read. It is validated against the introspected schema before
 *   anything is sent.
 * - Bodies are read capped (§7.5: 10 MB, streamed and cut, never buffered whole).
 * - The secret rides in the one header the source names, resolved at the call, scrubbed from answers.
 */

import { assertValidSchema, buildClientSchema, getIntrospectionQuery, type GraphQLSchema, type IntrospectionQuery, Kind, parse, validate } from 'graphql';

import { scrubSecrets } from '../mcp/secrets.js';
import { UpstreamCallError } from '../mcp/upstream-error.js';
import { type AddressPolicy, dialFetch, type DialOptions, DialRefusedError } from './dialer.js';
import { SourceQueryError } from './drivers/types.js';

export const GRAPHQL_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
export const GRAPHQL_DEADLINE_MS = 10_000;

export interface GraphqlSource {
  url: string;
  auth: { header: string; prefix?: string } | null;
  policy: AddressPolicy;
  dial?: DialOptions;
}

/** What a model may see of a GraphQL source: the root fields and the declared enums. Structure only. */
export interface GraphqlCatalog {
  queries: Array<{ name: string; type: string; args: Array<{ name: string; type: string }> }>;
  mutations: Array<{ name: string; type: string; args: Array<{ name: string; type: string }> }>;
  enums: Array<{ name: string; values: string[] }>;
  describedAt: string;
}

async function readJsonCapped(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    if (reader === undefined) break;
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > GRAPHQL_RESPONSE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new SourceQueryError(null, 'source', `the GraphQL answer is larger than ${GRAPHQL_RESPONSE_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SourceQueryError(null, 'source', `the GraphQL endpoint did not answer JSON (HTTP ${res.status})`);
  }
}

/** POST one GraphQL request through the dialer. */
export async function graphqlPost(src: GraphqlSource, secret: string | null, body: { query: string; variables?: Record<string, unknown> }, deadlineMs = GRAPHQL_DEADLINE_MS): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (src.auth !== null && secret !== null) headers[src.auth.header] = `${src.auth.prefix ?? ''}${secret}`;
  const secrets = secret === null ? [] : [secret];
  try {
    const res = await dialFetch(src.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(deadlineMs) }, src.policy, src.dial ?? {});
    let json: unknown;
    try {
      json = await readJsonCapped(res);
    } catch (err) {
      // The status arrived before the body: an error status is an answer even when its body cannot be read or
      // is too large (K2b). A body that is not JSON already says its status.
      const notJson = err instanceof SourceQueryError && err.message.includes('did not answer JSON');
      if (res.status >= 400 && !notJson) throw new SourceQueryError(null, 'source', `the GraphQL endpoint answered HTTP ${res.status} (its body could not be read)`);
      throw err;
    }
    return scrubSecrets({ status: res.status, json }, secrets);
  } catch (err) {
    // Every failure is a source error class (the routes answer 504/502 for them), never a bare 500. A
    // dialer refusal stays itself (a 409 naming why).
    if (err instanceof SourceQueryError || err instanceof DialRefusedError) throw err;
    const name = (err as { name?: unknown })?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || (err instanceof UpstreamCallError && err.errorClass === 'timeout');
    if (timedOut) throw new SourceQueryError(null, 'timeout', `the GraphQL endpoint did not answer within ${deadlineMs / 1000} s`);
    throw new SourceQueryError(null, 'connection', scrubSecrets(`the GraphQL endpoint could not be reached: ${err instanceof Error ? err.message : String(err)}`, secrets));
  }
}

/** Introspect the endpoint; answers the schema (for checks) and its structural catalog. */
export async function describeGraphql(src: GraphqlSource, secret: string | null): Promise<{ introspection: IntrospectionQuery; catalog: GraphqlCatalog }> {
  const { status, json } = await graphqlPost(src, secret, { query: getIntrospectionQuery({ descriptions: false, directiveIsRepeatable: true }) });
  const data = (json as { data?: IntrospectionQuery } | null)?.data;
  if (status >= 400 || data?.__schema === undefined) throw new SourceQueryError(null, 'source', `introspection failed (HTTP ${status}); the endpoint may disable it`);
  try {
    const schema = buildClientSchema(data);
    // buildClientSchema does not validate everything (a query type with no fields builds): a schema
    // the checks cannot validate against is refused here, not at the first check.
    assertValidSchema(schema);
    return { introspection: data, catalog: catalogOf(schema) };
  } catch (err) {
    // The endpoint's own schema words (names it declared) can ride the message: a source error, for a human only.
    throw new SourceQueryError(null, 'source', `the introspection answer is not a valid schema: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function catalogOf(schema: GraphQLSchema): GraphqlCatalog {
  const fields = (t: ReturnType<GraphQLSchema['getQueryType']>) =>
    t === null || t === undefined
      ? []
      : Object.values(t.getFields()).map((f) => ({ name: f.name, type: String(f.type), args: f.args.map((a) => ({ name: a.name, type: String(a.type) })) }));
  const enums = Object.values(schema.getTypeMap())
    .filter((t) => !t.name.startsWith('__') && 'getValues' in t && typeof (t as { getValues?: unknown }).getValues === 'function')
    .map((t) => ({ name: t.name, values: (t as unknown as { getValues: () => Array<{ name: string }> }).getValues().map((v) => v.name) }));
  return { queries: fields(schema.getQueryType()), mutations: fields(schema.getMutationType()), enums, describedAt: new Date().toISOString() };
}

export type GraphqlCheck = { ok: true; operation: string | null; variables: string[] } | { ok: false; code: string; detail: string };

/** Check a read document: one `query` operation, valid against the schema. Never sent. */
export function checkGraphqlRead(document: string, introspection: IntrospectionQuery): GraphqlCheck {
  let doc;
  try {
    doc = parse(document, { noLocation: true, maxTokens: 10_000 });
  } catch (err) {
    return { ok: false, code: 'parse', detail: `the document does not parse: ${(err as Error).message}` };
  }
  const ops = doc.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION);
  const other = doc.definitions.filter((d) => d.kind !== Kind.OPERATION_DEFINITION && d.kind !== Kind.FRAGMENT_DEFINITION);
  if (ops.length !== 1 || other.length > 0) return { ok: false, code: 'operations', detail: 'a read is a document with exactly one operation (fragments allowed)' };
  const op = ops[0] as Extract<(typeof doc.definitions)[number], { kind: Kind.OPERATION_DEFINITION }>;
  if (op.operation !== 'query') return { ok: false, code: 'not_query', detail: `a ${op.operation} is not a read; a read is one query operation` };
  let errors: readonly Error[];
  try {
    errors = validate(buildClientSchema(introspection), doc);
  } catch {
    // A stored schema that does not validate (described before this check existed): describe again.
    return { ok: false, code: 'schema', detail: "the source's described schema is not valid; describe the source again" };
  }
  if (errors.length > 0) return { ok: false, code: 'invalid', detail: errors.map((e) => e.message).join('; ') };
  return { ok: true, operation: op.name?.value ?? null, variables: (op.variableDefinitions ?? []).map((v) => v.variable.name.value) };
}

/** One read: the check first, then the POST. Answers the endpoint's JSON (`data`, `errors`). */
export async function readGraphql(src: GraphqlSource, secret: string | null, introspection: IntrospectionQuery, document: string, variables: Record<string, unknown>): Promise<unknown> {
  const c = checkGraphqlRead(document, introspection);
  if (!c.ok) throw new SourceQueryError(null, 'refused', c.detail);
  const { status, json } = await graphqlPost(src, secret, { query: document, variables });
  if (status >= 400 && (json as { data?: unknown } | null)?.data === undefined) throw new SourceQueryError(null, 'source', `the GraphQL endpoint answered HTTP ${status}`);
  return json;
}
