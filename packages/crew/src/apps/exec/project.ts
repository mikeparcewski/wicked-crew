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
import { SECRET_REDACTION, scrubSecrets } from '../../mcp/secrets.js';

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

/**
 * The values `path` selects in `root` (own properties only), at most `limit` of them (`more`: there were
 * others). Walked lazily, branch by branch, counting only the values the whole path reaches, so a
 * source-sized array costs no more than `limit` and an empty branch never hides a later one (codex r1, r2).
 */
export function selectPath(root: unknown, path: string, limit = Number.MAX_SAFE_INTEGER): unknown[] & { more?: boolean } {
  const out: unknown[] = [];
  let more = false;
  for (const v of walkPath(root, parsePath(path))) {
    if (out.length >= limit) {
      more = true;
      break;
    }
    out.push(v);
  }
  // `more` rides on the array without being one of its elements (non-enumerable).
  return Object.defineProperty(out, 'more', { value: more, enumerable: false }) as unknown[] & { more?: boolean };
}

/** Every value the steps reach from `v`, in order, one at a time. */
function* walkPath(v: unknown, steps: readonly Step[], at = 0): Generator<unknown> {
  if (at === steps.length) {
    yield v;
    return;
  }
  const step = steps[at]!;
  if ('name' in step) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, step.name)) yield* walkPath((v as Record<string, unknown>)[step.name], steps, at + 1);
  } else if ('index' in step) {
    if (Array.isArray(v) && step.index < v.length) yield* walkPath(v[step.index], steps, at + 1);
  } else if (Array.isArray(v)) {
    for (const x of v) yield* walkPath(x, steps, at + 1);
  }
}

/**
 * Whether the more path says another page exists: a value that is there and not null, false, 0 or empty.
 * Read lazily until one says so; past a budget of values it says yes (a page is never claimed complete
 * that was not read through; codex r2).
 */
export function morePathSays(root: unknown, path: string | undefined): boolean {
  if (path === undefined) return false;
  let seen = 0;
  for (const v of walkPath(root, parsePath(path))) {
    if (v !== null && v !== undefined && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0)) return true;
    if (++seen > 10_000) return true;
  }
  return false;
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
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** A real calendar date (years 0001-9999; codex r1 on the executor). */
function calendar(y: number, m: number, d: number): boolean {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1]!;
}

/** A datetime in ISO form: Postgres `2026-11-03 08:32:00.1+00` → `2026-11-03T08:32:00.1+00:00`; `null` when it is not a real one. */
function isoDateTime(s: string): string | null {
  const m = DT_RE.exec(s);
  if (m === null || !calendar(Number(m[1]), Number(m[2]), Number(m[3]))) return null;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59)) return null;
  let zone = m[8] ?? '';
  if (zone !== '' && zone !== 'Z') {
    zone = zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    if (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59) return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}${m[6] !== undefined ? `:${m[6]}${m[7] ?? ''}` : ''}${zone}`;
}

/** A number string's value, or why not: finite, within ±2^53, and not a nonzero value that underflowed to 0. */
function numberOf(t: string): { ok: true; n: number } | { ok: false; why: string } {
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, why: 'is not a finite number' };
  if (Math.abs(n) >= 2 ** 53) return { ok: false, why: 'is past 2^53, which a number cannot carry exactly' };
  if (n === 0 && /[1-9]/.test(t.replace(/[eE].*$/, ''))) return { ok: false, why: 'is too small to carry as a number' };
  return { ok: true, n };
}

/** One value as its declared type, or why not (no value in the words). */
export function coerceCell(type: AppColumnType, v: unknown): { ok: true; cell: AppCell } | { ok: false; why: string } {
  switch (type) {
    case 'integer': {
      if (typeof v === 'string' && INT_RE.test(v.trim())) {
        const r = numberOf(v.trim());
        return r.ok ? { ok: true, cell: r.n } : r;
      }
      const n = typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isInteger(n)) return { ok: false, why: 'is not an integer' };
      if (!Number.isSafeInteger(n) || (typeof v === 'bigint' && BigInt(n) !== v)) return { ok: false, why: 'is past 2^53, which a number cannot carry exactly' };
      return { ok: true, cell: n };
    }
    case 'number': {
      if (typeof v === 'string') {
        if (!NUM_RE.test(v.trim())) return { ok: false, why: 'is not a finite number' };
        const r = numberOf(v.trim());
        return r.ok ? { ok: true, cell: r.n } : r;
      }
      const n = typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, why: 'is not a finite number' };
      if (Math.abs(n) >= 2 ** 53) return { ok: false, why: 'is past 2^53, which a number cannot carry exactly' };
      return { ok: true, cell: n };
    }
    case 'boolean':
      if (typeof v === 'boolean') return { ok: true, cell: v };
      if (v === 0 || v === 1) return { ok: true, cell: v === 1 };
      return { ok: false, why: 'is not a boolean' };
    case 'date': {
      if (v instanceof Date && !Number.isNaN(v.getTime())) return { ok: true, cell: v.toISOString().slice(0, 10) };
      const m = typeof v === 'string' ? DATE_RE.exec(v) : null;
      if (m !== null && calendar(Number(m[1]), Number(m[2]), Number(m[3]))) return { ok: true, cell: v as string };
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
export function projectRows(output: readonly AppOutputColumn[], rows: Iterable<Record<string, unknown>>, alreadyTruncated = false, secrets: readonly string[] = []): { rows: AppCell[][]; truncated: boolean; bytes: number } {
  const live = secrets.filter((x) => x.length > 0);
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
      let raw = Object.hasOwn(r, col.name) ? r[col.name] : undefined;
      // The source's secret leaves no cell, scrubbed from the RAW value before it is coerced, cut or measured
      // (codex/pi r1 on the executor): a string loses it; a number or object that carries it is no value at all.
      if (live.length > 0 && raw !== null && raw !== undefined) raw = scrubRaw(raw, live);
      if (raw === null || raw === undefined) {
        if (col.nullable === false) throw new ResultError(`row ${n}: column ${col.name} is empty, and it is declared not nullable`);
        cells.push(null);
        continue;
      }
      const c = coerceCell(col.type, raw);
      if (!c.ok) throw new ResultError(`row ${n}: column ${col.name} ${c.why} (declared ${col.type})`);
      let cell = c.cell;
      // The text form (an object rendered as JSON) is scrubbed again before it is cut.
      if (typeof cell === 'string' && live.length > 0) cell = scrubSecrets(cell, live);
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

/**
 * A raw value with the source's secret taken out, walked to the same depth limit the cell has (codex r2): a
 * string is scrubbed; a number, bigint or boolean whose text IS the secret is no value (null at the top, the
 * redaction marker inside an object); keys are scrubbed too. Deeper than the limit refuses the row.
 */
function scrubRaw(v: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof v === 'string') return scrubSecrets(v, secrets);
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return secrets.includes(String(v)) ? (depth === 0 ? null : SECRET_REDACTION) : v;
  if (v === null || typeof v !== 'object') return v;
  if (depth >= RESULT_LIMITS.depth) throw new ResultError(`a value nests deeper than ${RESULT_LIMITS.depth}`);
  if (Array.isArray(v)) return v.map((x) => scrubRaw(x, secrets, depth + 1));
  if (v instanceof Date) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[scrubSecrets(k, secrets)] = scrubRaw(x, secrets, depth + 1);
  return out;
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
