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

import { record, z } from '../../zod.js';

import type { AppToolQueryText, AppCrewQueryText } from '../../core/types.js';

const PARAM = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const Arg = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('param'), name: z.string().regex(PARAM) }),
  z.strictObject({ kind: z.literal('literal'), value: z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]) }),
]);
const Args = record(z.string().min(1).max(128), Arg).refine((r) => Object.keys(r).length <= 50, 'at most 50 arguments');

export const ToolQueryTextSchema = z.strictObject({ tool: z.string().min(1).max(128), args: Args.optional() });
export const CrewQueryTextSchema = z.strictObject({ route: z.string().min(1).max(128), params: record(z.string().regex(PARAM), Arg).optional(), query: Args.optional() });

export type QueryArg = z.infer<typeof Arg>;

type Parsed<T> = { ok: true; value: T } | { ok: false; why: string };

/** Whether a parsed value holds the key `__proto__` anywhere (a record parser would drop it silently, codex r1). */
function holdsProto(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object' || depth > 16) return false;
  if (!Array.isArray(v) && Object.hasOwn(v, '__proto__')) return true;
  return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).some((x) => holdsProto(x, depth + 1));
}

function parseJson<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the query text is not JSON' };
  }
  if (holdsProto(v)) return { ok: false, why: 'the query text uses the key __proto__' };
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

/** A value a crew-source path segment may take (the reader refuses the rest before any request). */
export function crewPathValueOk(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const t = String(v);
  return t !== '' && t !== '.' && t !== '..' && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
}
