/**
 * The `.json` query texts (DES-APPS-001 §4 `queries/<id>.json`): a REST operation or MCP tool with its
 * arguments, or a read of the built-in crew source. An argument is a declared parameter or a literal fixed
 * by the app; viewer values are declared on the query's parameters (`from`), never here.
 *
 *   rest / mcp:  { "tool": "<registry tool>", "args": { "<arg>": {"kind": "param", "name": "<param>"} | {"kind": "literal", "value": <scalar>} } }
 *   crew:        { "route": "/runs/:id", "params": { "id": <arg> }, "query": { "<name>": <arg> } }
 *
 * GraphQL documents take their variables from the query's parameters by name; SQL binds `$n` / `?` to the
 * n-th declared parameter.
 */

import { z } from 'zod';

import type { AppToolQueryText, AppCrewQueryText } from '../../core/types.js';

const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const Arg = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('param'), name: z.string().regex(PARAM) }).strict(),
  z.object({ kind: z.literal('literal'), value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]) }).strict(),
]);
const Args = z.record(z.string().min(1).max(128), Arg).refine((r) => Object.keys(r).length <= 50, 'at most 50 arguments');

export const ToolQueryTextSchema = z.object({ tool: z.string().min(1).max(128), args: Args.optional() }).strict();
export const CrewQueryTextSchema = z
  .object({ route: z.string().min(1).max(128), params: z.record(z.string().regex(PARAM), Arg).optional(), query: Args.optional() })
  .strict();

export type QueryArg = z.infer<typeof Arg>;

type Parsed<T> = { ok: true; value: T } | { ok: false; why: string };

function parseJson<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the query text is not JSON' };
  }
  const r = schema.safeParse(v);
  if (!r.success) return { ok: false, why: r.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'text'}: ${i.message}`).join('; ') };
  return { ok: true, value: r.data };
}

export function parseToolQueryText(text: string): Parsed<AppToolQueryText> {
  const r = parseJson(text, ToolQueryTextSchema);
  return r.ok ? { ok: true, value: { tool: r.value.tool, args: r.value.args ?? {} } } : r;
}

export function parseCrewQueryText(text: string): Parsed<AppCrewQueryText> {
  const r = parseJson(text, CrewQueryTextSchema);
  return r.ok ? { ok: true, value: { route: r.value.route, params: r.value.params ?? {}, query: r.value.query ?? {} } } : r;
}

/** The parameters an argument map names (each must be declared). */
export function argParams(args: Record<string, QueryArg>): string[] {
  return Object.values(args).flatMap((a) => (a.kind === 'param' ? [a.name] : []));
}
