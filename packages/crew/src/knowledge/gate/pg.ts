/**
 * The gate's Postgres read text (DES-KNOWLEDGE-DATA-001 §6.3, §7.2).
 *
 * - The agent's text passes K1's read policy first (libpg_query, exact: one `SELECT` or non-recursive
 *   `WITH … SELECT`; `SET`, `BEGIN`, DDL, DML, `CALL`, `COPY`, `INTO`, multi-statement and every function
 *   outside the allowlist refused). Nothing the parser cannot parse is admitted.
 * - The statement is cut out of the text by libpg_query's own `stmt_location`/`stmt_len`, so a trailing `;`
 *   or comment never reaches the wrapper, and the wrapper puts it on its own lines (a `--` comment cannot
 *   swallow the closing parenthesis).
 * - The **LIMIT rewrite**: `SELECT … FROM (\n<q>\n) AS q LIMIT <cap+1>`, so no adapter buffers past the cap.
 * - For `unit`, the **per-cell projection** (§6.3), from the column types prepare reported: a type bounded by
 *   its type keeps it (numbers, booleans, dates and times, uuid, network addresses); `bytea` is cut by
 *   `substring`; EVERYTHING else (text, varchar, json/jsonb, xml, arrays, enums, domains, …) is
 *   `left(c::text, cells + 1)`, so a cell longer than the cap is cut at the source and the gate marks it
 *   `truncated`. The list is of what keeps, so an unknown type is cut, never sent whole.
 * - The final text goes through the same policy again before it is sent: what reaches the source is always a
 *   text the policy admitted.
 */

import { parse } from 'libpg-query';

import type { PolicyCatalog, PolicyResult } from '../../sources/policy/types.js';
import { checkReadPolicy } from '../../sources/policy/index.js';

/** Types whose values are bounded by the type itself: kept as they are (format_type names). */
const BOUNDED_TYPE = new RegExp(
  [
    '^(smallint|integer|bigint|real|double precision|boolean|date|uuid|oid|money|inet|cidr|macaddr|macaddr8)$',
    '^numeric(\\(\\d+(,\\d+)?\\))?$',
    '^(time|timestamp)(\\(\\d\\))? (with|without) time zone$',
    '^interval( [a-z ]+)?(\\(\\d\\))?$',
  ].join('|'),
);

export function boundedType(type: string): boolean {
  return BOUNDED_TYPE.test(type);
}

/**
 * The one statement of `text`, as libpg_query delimits it (byte offsets into the UTF-8 text), without a
 * trailing `;`. `null` when the text is not exactly one statement (the policy refuses it anyway).
 */
export async function statementOf(text: string): Promise<string | null> {
  let tree: { stmts?: Array<{ stmt?: unknown; stmt_location?: number; stmt_len?: number }> };
  try {
    tree = (await parse(text)) as typeof tree;
  } catch {
    return null;
  }
  const stmts = tree.stmts ?? [];
  if (stmts.length !== 1) return null;
  const s = stmts[0] as { stmt_location?: number; stmt_len?: number };
  const bytes = Buffer.from(text, 'utf8');
  const start = s.stmt_location ?? 0;
  const end = s.stmt_len === undefined || s.stmt_len === 0 ? bytes.length : start + s.stmt_len;
  if (start < 0 || end > bytes.length || start >= end) return null;
  const out = bytes.subarray(start, end).toString('utf8').trim();
  return out === '' ? null : out;
}

/** `SELECT * FROM (\n<q>\n) AS q LIMIT <cap+1>`. */
export function limitRewrite(statement: string, rowCap: number): string {
  return `SELECT * FROM (\n${statement}\n) AS q LIMIT ${Math.floor(rowCap) + 1}`;
}

/** The projection of one output column for a `unit` read (§6.3). */
export function cellExpression(ref: string, type: string, cellChars: number): string {
  if (boundedType(type)) return ref;
  if (type === 'bytea') return `pg_catalog.substring(${ref}, 1, ${Math.floor(cellChars / 2)})`;
  return `pg_catalog.left(${ref}::pg_catalog.text, ${Math.floor(cellChars) + 1})`;
}

/**
 * The rewrite with the per-cell projection: the subquery's columns renamed positionally (`q("c1", …)`, so
 * duplicate or unnamed output columns are no problem), each projected by its type, then the LIMIT.
 */
export function projectedRewrite(statement: string, columnTypes: readonly string[], rowCap: number, cellChars: number): string {
  if (columnTypes.length === 0) return limitRewrite(statement, rowCap);
  const alias = columnTypes.map((_t, i) => `"c${i + 1}"`).join(', ');
  const proj = columnTypes.map((t, i) => cellExpression(`q."c${i + 1}"`, t, cellChars)).join(', ');
  return `SELECT ${proj} FROM (\n${statement}\n) AS q(${alias}) LIMIT ${Math.floor(rowCap) + 1}`;
}

/** The policy on the agent's text, then the statement cut out of it. */
export async function admitPg(text: string, catalog: PolicyCatalog): Promise<{ ok: true; statement: string; policy: Extract<PolicyResult, { ok: true }> } | { ok: false; code: string; detail: string }> {
  const pol = await checkReadPolicy('postgres', text, catalog);
  if (!pol.ok) return pol;
  const statement = await statementOf(text);
  if (statement === null) return { ok: false, code: 'statements', detail: 'a query is exactly one statement' };
  return { ok: true, statement, policy: pol };
}

/** The final text checked by the same policy: crew's wrapper must never widen what the agent's text may do. */
export async function recheckPg(finalText: string, catalog: PolicyCatalog): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
  const pol = await checkReadPolicy('postgres', finalText, catalog);
  return pol.ok ? { ok: true } : { ok: false, code: 'rewrite', detail: `crew's rewrite of this query was refused by the read policy (${pol.code}), so nothing ran` };
}
