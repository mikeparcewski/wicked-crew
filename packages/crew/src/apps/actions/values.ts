/**
 * The values a Postgres row write may carry (DES-APPS-001 §7.4 "Values must fit exactly"): ONE accepted
 * input form per written type, checked before anything reaches the database, so the conversion to the
 * column's base type is exact. Floating point, `json`, `xml`, `bytea` and arrays are not writable at all
 * (the table safety check refuses them as `written_type`).
 *
 *  - `int2`/`int4`/`int8`: a JSON integer in the type's range (int8: within ±(2^53 − 1), the range JSON
 *    carries exactly);
 *  - `numeric`: a decimal string (`-12.50`), or a JSON number that prints as one;
 *  - `text`/`varchar`: a string without NUL;
 *  - `bool`: a boolean;
 *  - `date`: `YYYY-MM-DD`, a real calendar date, years 0001-9999;
 *  - `timestamp`: `YYYY-MM-DDTHH:MM:SS` with at most six fractional digits and NO offset;
 *  - `timestamptz`: the same WITH `Z` or `±HH:MM`;
 *  - `uuid`: the canonical 8-4-4-4-12 form (sent lower case);
 *  - `jsonb`: a string holding one JSON value with no duplicate key and no NUL;
 *  - an enum: one of its labels.
 *
 * Then, at prepare, the database itself says whether each value survives the column's FULL type (its
 * typmod: `numeric(3,1)`, `varchar(3)`, `timestamp(0)`), P28.
 */

import type { AppParamSchema } from '../../core/types.js';
import type { SafetyColumn } from '../../sources/safety/postgres.js';

export type WritableKind = 'int2' | 'int4' | 'int8' | 'numeric' | 'text' | 'varchar' | 'bool' | 'date' | 'timestamp' | 'timestamptz' | 'uuid' | 'jsonb' | 'enum';

const BUILTIN_KINDS: ReadonlySet<string> = new Set(['int2', 'int4', 'int8', 'numeric', 'text', 'varchar', 'bool', 'date', 'timestamp', 'timestamptz', 'uuid', 'jsonb']);

/** The writable kind of a column, or `null` when a v1 row write cannot write or key on it. */
export function writableKind(c: Pick<SafetyColumn, 'typname' | 'typschema' | 'typtype' | 'builtin'>): WritableKind | null {
  if (c.typtype === 'e') return 'enum';
  if (c.typschema === 'pg_catalog' && c.builtin && BUILTIN_KINDS.has(c.typname)) return c.typname as WritableKind;
  return null;
}

const RANGE: Partial<Record<WritableKind, [number, number]>> = {
  int2: [-32_768, 32_767],
  int4: [-2_147_483_648, 2_147_483_647],
  int8: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1]!;
}

function dateOk(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m !== null && isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function timestampProblem(v: string, zoned: boolean): string | null {
  const m = TS_RE.exec(v);
  if (m === null || !isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) return 'is not an ISO timestamp (YYYY-MM-DDTHH:MM:SS, at most six fractional digits)';
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return 'is not a time of day';
  const off = m[8];
  if (zoned && off === undefined) return 'needs an offset (Z or ±HH:MM)';
  if (!zoned && off !== undefined) return 'has an offset, which a timestamp without time zone would drop';
  if (off !== undefined && off !== 'Z' && (Number(off.slice(1, 3)) > 23 || Number(off.slice(4, 6)) > 59)) return 'has an offset out of range';
  return null;
}

/**
 * A strict JSON reader: one value, no duplicate key in any object (JSON.parse keeps the last silently, so the
 * card and the database could disagree on what was meant). Answers the problem, or `null`.
 */
export function jsonTextProblem(text: string): string | null {
  if (text.includes('\u0000') || /\\u0000/i.test(text)) return 'holds a NUL, which jsonb refuses';
  let i = 0;
  const ws = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const fail = (why: string): never => {
    throw new Error(why);
  };
  const str = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('an unterminated string');
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (depth: number): void => {
    if (depth > 64) fail('nests deeper than 64');
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const keys = new Set<string>();
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('an object key that is not a string');
        const k = str();
        if (keys.has(k)) fail(`the key ${JSON.stringify(k)} twice`);
        keys.add(k);
        ws();
        if (text[i] !== ':') fail('a missing colon');
        i++;
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail('a malformed object');
      }
    }
    if (ch === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail('a malformed array');
      }
    }
    if (ch === '"') {
      str();
      return;
    }
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (m === null) fail('not JSON');
    i += m![0].length;
  };
  try {
    value(0);
    ws();
    if (i !== text.length) return 'is more than one JSON value';
    return null;
  } catch (err) {
    return `is not one JSON value (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * The value's one accepted form for `kind`, and the text sent to the database; or why it is refused. `null`
 * is accepted only where `nullable` (a literal: a parameter is never null).
 */
export function inputForm(kind: WritableKind, value: unknown, opts: { nullable: boolean; enumLabels?: readonly string[] }): { ok: true; text: string | null } | { ok: false; why: string } {
  if (value === null) return opts.nullable ? { ok: true, text: null } : { ok: false, why: 'is null, and the column is NOT NULL' };
  switch (kind) {
    case 'int2':
    case 'int4':
    case 'int8': {
      const [lo, hi] = RANGE[kind]!;
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { ok: false, why: `is not an integer (${kind} takes a JSON integer)` };
      if (value < lo || value > hi) return { ok: false, why: `is outside ${kind}'s range` };
      return { ok: true, text: String(value) };
    }
    case 'numeric': {
      const t = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
      if (typeof t !== 'string' || t.length > 1000 || !DECIMAL_RE.test(t)) return { ok: false, why: 'is not a decimal (numeric takes a string such as "12.50")' };
      return { ok: true, text: t };
    }
    case 'text':
    case 'varchar':
      if (typeof value !== 'string') return { ok: false, why: `is not a string (${kind})` };
      if (value.includes('\u0000')) return { ok: false, why: 'holds a NUL, which Postgres text refuses' };
      return { ok: true, text: value };
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, why: 'is not a boolean' };
      return { ok: true, text: value ? 'true' : 'false' };
    case 'date':
      if (typeof value !== 'string' || !dateOk(value)) return { ok: false, why: 'is not a date (YYYY-MM-DD)' };
      return { ok: true, text: value };
    case 'timestamp':
    case 'timestamptz': {
      if (typeof value !== 'string') return { ok: false, why: 'is not an ISO timestamp string' };
      const problem = timestampProblem(value, kind === 'timestamptz');
      return problem === null ? { ok: true, text: value } : { ok: false, why: problem };
    }
    case 'uuid':
      if (typeof value !== 'string' || !UUID_RE.test(value)) return { ok: false, why: 'is not a uuid (8-4-4-4-12 hex)' };
      return { ok: true, text: value.toLowerCase() };
    case 'jsonb': {
      if (typeof value !== 'string') return { ok: false, why: 'is not a string holding JSON (jsonb)' };
      const problem = jsonTextProblem(value);
      return problem === null ? { ok: true, text: value } : { ok: false, why: problem };
    }
    case 'enum':
      if (typeof value !== 'string') return { ok: false, why: 'is not a string (an enum label)' };
      if (opts.enumLabels !== undefined && !opts.enumLabels.includes(value)) return { ok: false, why: 'is not one of the enum labels' };
      return { ok: true, text: value };
  }
}

/** Whether a declared parameter's schema can carry this column's one input form (checked when the action lands). */
export function paramFits(kind: WritableKind, p: Pick<AppParamSchema, 'type' | 'format' | 'from'>): string | null {
  const t = p.type;
  switch (kind) {
    case 'int2':
    case 'int4':
    case 'int8':
      return t === 'integer' ? null : `${kind} takes an integer parameter`;
    case 'numeric':
      return t === 'string' || t === 'integer' || t === 'number' ? null : 'numeric takes a string (a decimal) or a number parameter';
    case 'text':
    case 'varchar':
    case 'enum':
      return t === 'string' ? null : `${kind === 'enum' ? 'an enum' : kind} takes a string parameter`;
    case 'bool':
      return t === 'boolean' ? null : 'bool takes a boolean parameter';
    case 'date':
      return t === 'string' && (p.format === undefined || p.format === 'date') ? null : 'date takes a string parameter (format date)';
    case 'timestamp':
      return t === 'string' && p.format === undefined ? null : 'timestamp (without time zone) takes a string parameter with no format (date-time carries an offset it would drop)';
    case 'timestamptz':
      return t === 'string' && (p.format === undefined || p.format === 'date-time') ? null : 'timestamptz takes a string parameter (format date-time)';
    case 'uuid':
      return t === 'string' && (p.format === undefined || p.format === 'uuid') ? null : 'uuid takes a string parameter (format uuid)';
    case 'jsonb':
      return t === 'string' ? null : 'jsonb takes a string parameter holding JSON';
  }
}

/** Which crew-filled value a column of `kind` can take. */
export function crewValueFits(kind: WritableKind, v: 'now' | 'uuid'): boolean {
  return v === 'now' ? kind === 'timestamptz' || kind === 'timestamp' : kind === 'uuid' || kind === 'text' || kind === 'varchar';
}

/** crew's `now` for a column of `kind`, microsecond precision (UTC; a `timestamp` gets the UTC wall time). */
export function crewNow(kind: WritableKind, at: Date = new Date()): string {
  const iso = at.toISOString(); // 2026-11-03T08:32:00.123Z
  const micro = `${iso.slice(0, 23)}000`;
  return kind === 'timestamptz' ? `${micro}Z` : micro;
}
