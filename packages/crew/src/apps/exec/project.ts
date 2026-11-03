/**
 * From a source's answer to the rows an app gets (DES-APPS-001 §7.2 step 6, §7.5): the row path and the
 * more path (a JSONPath subset), projection to EXACTLY the declared output columns, coercion and
 * validation of every value against its declared type, and the response caps.
 *
 * Coercion: Postgres `int8`/`numeric` and MySQL `BIGINT`/`DECIMAL` arrive as strings; a column declared
 * `integer` or `number` parses them and refuses a value past 2^53 or not finite. Every value is checked
 * against its declared type on every row (types a source could not confirm included). A refusal names the
 * column and the row, never the value.
 */

import type { AppCell, AppColumnType, AppOutputColumn } from '../../core/types.js';

/** §7.5 response caps. */
export const RESULT_LIMITS = { rows: 5_000, bytes: 10 * 1024 * 1024, cellBytes: 64 * 1024, depth: 8 } as const;

export class ResultError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** One step of the subset: `.name`, `[*]`, `[n]`. */
type Step = { name: string } | { all: true } | { index: number };

export function parsePath(path: string): Step[] {
  if (!path.startsWith('$')) throw new ResultError(`${path} is not a path`);
  const steps: Step[] = [];
  const re = /\.([A-Za-z_$][A-Za-z0-9_$-]*)|\[\*\]|\[(\d{1,6})\]/y;
  re.lastIndex = 1;
  while (re.lastIndex < path.length) {
    const at = re.lastIndex;
    const m = re.exec(path);
    if (m === null || m.index !== at) throw new ResultError(`${path} is not a path of .name, [*] and [n] steps`);
    if (m[1] !== undefined) steps.push({ name: m[1] });
    else if (m[2] !== undefined) steps.push({ index: Number(m[2]) });
    else steps.push({ all: true });
  }
  return steps;
}

/** Every value `path` selects in `root` (own properties only). */
export function selectPath(root: unknown, path: string): unknown[] {
  let cur: unknown[] = [root];
  for (const step of parsePath(path)) {
    const next: unknown[] = [];
    for (const v of cur) {
      if ('name' in step) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, step.name)) next.push((v as Record<string, unknown>)[step.name]);
      } else if ('index' in step) {
        if (Array.isArray(v) && step.index < v.length) next.push(v[step.index]);
      } else if (Array.isArray(v)) {
        next.push(...v);
      }
    }
    cur = next;
  }
  return cur;
}

/** Whether the more path says another page exists: a value that is there and not null, false, 0 or empty. */
export function morePathSays(root: unknown, path: string | undefined): boolean {
  if (path === undefined) return false;
  return selectPath(root, path).some((v) => v !== null && v !== undefined && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0));
}

function depthOf(v: unknown, limit: number, d = 0): number {
  if (d > limit) return d;
  if (v === null || typeof v !== 'object') return d;
  let max = d + 1;
  for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
    max = Math.max(max, depthOf(x, limit, d + 1));
    if (max > limit) return max;
  }
  return max;
}

const INT_RE = /^-?\d+$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DT_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** A datetime in ISO form: Postgres `2026-11-03 08:32:00.1+00` → `2026-11-03T08:32:00.1+00:00`. */
function isoDateTime(s: string): string | null {
  const m = DT_RE.exec(s);
  if (m === null) return null;
  let zone = m[3] ?? '';
  if (zone !== '' && zone !== 'Z') zone = zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${m[1]}T${m[2]}${zone}`;
}

/** One value as its declared type, or why not (no value in the words). */
export function coerceCell(type: AppColumnType, v: unknown): { ok: true; cell: AppCell } | { ok: false; why: string } {
  switch (type) {
    case 'integer': {
      const n = typeof v === 'string' && INT_RE.test(v.trim()) ? Number(v.trim()) : typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, why: 'is not an integer' };
      if (!Number.isSafeInteger(n)) return { ok: false, why: 'is past 2^53, which a number cannot carry exactly' };
      return { ok: true, cell: n };
    }
    case 'number': {
      const n = typeof v === 'string' && NUM_RE.test(v.trim()) ? Number(v.trim()) : typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, why: 'is not a finite number' };
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) return { ok: false, why: 'is past 2^53, which a number cannot carry exactly' };
      return { ok: true, cell: n };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true, cell: v };
      if (v === 0 || v === 1) return { ok: true, cell: v === 1 };
      return { ok: false, why: 'is not a boolean' };
    case 'date': {
      if (v instanceof Date && !Number.isNaN(v.getTime())) return { ok: true, cell: v.toISOString().slice(0, 10) };
      if (typeof v === 'string' && DATE_RE.test(v)) return { ok: true, cell: v };
      return { ok: false, why: 'is not a date' };
    }
    case 'datetime': {
      if (v instanceof Date && !Number.isNaN(v.getTime())) return { ok: true, cell: v.toISOString() };
      const iso = typeof v === 'string' ? isoDateTime(v) : null;
      return iso === null ? { ok: false, why: 'is not a date and time' } : { ok: true, cell: iso };
    }
    case 'string': {
      if (typeof v === 'string') return { ok: true, cell: v };
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return { ok: true, cell: String(v) };
      if (v instanceof Date) return { ok: true, cell: v.toISOString() };
      if (typeof v === 'object') {
        if (depthOf(v, RESULT_LIMITS.depth) > RESULT_LIMITS.depth) return { ok: false, why: `nests deeper than ${RESULT_LIMITS.depth}` };
        return { ok: true, cell: JSON.stringify(v) };
      }
      return { ok: false, why: 'is not a string' };
    }
  }
}

/**
 * Project rows to the declared columns and coerce them, within the caps. `rows` are objects keyed by column
 * name. Answers the cells and whether anything was cut (rows past the cap, the 10 MB budget, a cell past 64 KB).
 */
export function projectRows(output: readonly AppOutputColumn[], rows: Iterable<Record<string, unknown>>, alreadyTruncated = false): { rows: AppCell[][]; truncated: boolean; bytes: number } {
  const out: AppCell[][] = [];
  let truncated = alreadyTruncated;
  let bytes = 2;
  let n = 0;
  for (const r of rows) {
    n++;
    if (out.length >= RESULT_LIMITS.rows) {
      truncated = true;
      break;
    }
    const cells: AppCell[] = [];
    for (const col of output) {
      const raw = Object.hasOwn(r, col.name) ? r[col.name] : undefined;
      if (raw === null || raw === undefined) {
        if (col.nullable === false) throw new ResultError(`row ${n}: column ${col.name} is empty, and it is declared not nullable`);
        cells.push(null);
        continue;
      }
      const c = coerceCell(col.type, raw);
      if (!c.ok) throw new ResultError(`row ${n}: column ${col.name} ${c.why} (declared ${col.type})`);
      let cell = c.cell;
      if (typeof cell === 'string' && Buffer.byteLength(cell, 'utf8') > RESULT_LIMITS.cellBytes) {
        cell = Buffer.from(cell, 'utf8').subarray(0, RESULT_LIMITS.cellBytes).toString('utf8').replace(/�$/, '');
        truncated = true;
      }
      cells.push(cell);
    }
    const size = Buffer.byteLength(JSON.stringify(cells), 'utf8') + 1;
    if (bytes + size > RESULT_LIMITS.bytes) {
      truncated = true;
      break;
    }
    bytes += size;
    out.push(cells);
  }
  return { rows: out, truncated, bytes };
}

/** SQL rows (arrays aligned with `columns`) as objects by column name. */
export function sqlRowObjects(columns: ReadonlyArray<{ name: string }>, rows: readonly unknown[][]): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    columns.forEach((c, i) => {
      o[c.name] = r[i];
    });
    return o;
  });
}
