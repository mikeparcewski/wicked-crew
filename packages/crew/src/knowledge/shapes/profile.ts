/**
 * The value-free profiler (DES-KNOWLEDGE-DATA-001 §10.2): what a source's relations hold, in counts, never in values.
 *
 * It runs as the `person` context when the person starts it from the source sheet, through the data gate's person
 * read (the source's one scheduler at the `profile` priority, K1's read policy, the LIMIT rewrite, READ ONLY, 10 s at
 * the source). Every query it sends is FIXED aggregate SQL built here from the catalog's identifiers, and every
 * answer is a count:
 *
 * - per relation: `count(*)`, and per column `count(c)` and (for a type with equality) `count(DISTINCT c)`;
 * - per join candidate: `count(DISTINCT a.c)` and the same count `FILTER (WHERE EXISTS (… b.k = a.c))`, so the key
 *   overlap of two relations is measured at the source and no key value ever enters crew.
 *
 * What it keeps (and all that it returns) is bands: rows by order of magnitude, the null fraction to the nearest 5 %,
 * a cardinality class, key candidate yes or no, and an overlap band. The exact counts stay inside this module.
 * Never: a value, a minimum or maximum, a top-N, an example, a default, a comment.
 */

import type { SqlReadResult } from '../../sources/drivers/types.js';

/** One relation as the profiler reads it: the gate's agent projection (identifiers, types, keys). */
export interface ProfileRelation {
  /** `schema.table` (the catalog doc key). */
  key: string;
  schema: string | null;
  name: string;
  columns: Array<{ name: string; type: string; nullable: boolean; enum?: string[] }>;
  primaryKey: string[];
  foreignKeys: Array<{ columns: string[]; references: { schema: string | null; table: string; columns: string[] } }>;
  /** Columns the agent projection did not list (too many): not profiled, and said so. */
  columnsNotListed?: number;
}

export type RowsBand = '0' | '1-99' | '100-9,999' | '10,000-999,999' | '1,000,000+';
export type Cardinality = 'none' | 'single' | 'low' | 'high' | 'unique' | 'unknown';
export type OverlapBand = 'empty' | 'none' | 'some' | 'most' | 'all';

export interface ColumnProfile {
  name: string;
  type: string;
  /** The null fraction to the nearest 5 % (`null` for an empty relation). */
  nullPct: number | null;
  /** Some value is null (the 5 % band can round a few nulls to 0). */
  hasNulls: boolean;
  cardinality: Cardinality;
  /** No nulls, every value distinct (or the declared primary key). */
  keyCandidate: boolean;
}

export interface JoinProfile {
  /** The referencing relation's key and columns. */
  from: string;
  columns: string[];
  /** The referenced relation's key and columns. */
  to: string;
  references: string[];
  basis: 'fk' | 'name_type';
  /** How many of the referencing side's distinct values the other side holds (one-column joins). */
  overlap: OverlapBand | null;
}

export interface RelationProfile {
  key: string;
  /** `null` when the relation could not be read (`error` says why, as a class; `budget`: the profile's time ran out). */
  rows: RowsBand | null;
  columns: ColumnProfile[];
  error: string | null;
  /** Columns not profiled because the structure lists only the first ones. */
  columnsNotListed?: number;
}

export interface SourceProfile {
  relations: RelationProfile[];
  joins: JoinProfile[];
}

/** A read the gate runs for the profiler: one fixed aggregate statement, one row of counts back. */
export type ProfileRead = (sql: string) => Promise<SqlReadResult>;

/** Columns whose type has no equality operator: `count(DISTINCT …)` would fail, so their cardinality is unknown. */
const NO_EQUALITY = /^(json\b|xml\b|point\b|line\b|lseg\b|box\b|path\b|polygon\b|circle\b)|\[\]$/i;
/** Types a join key may have (Postgres type names as the catalog spells them). */
const INTEGER = /^(smallint|integer|bigint|int2|int4|int8|serial|bigserial|smallserial)$/i;

export const qident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const qrel = (r: Pick<ProfileRelation, 'schema' | 'name'>): string => (r.schema === null ? qident(r.name) : `${qident(r.schema)}.${qident(r.name)}`);

/** At most this many `count(DISTINCT …)` per statement: each is its own sort, so a wide table is read in chunks. */
export const DISTINCT_PER_STATEMENT = 8;
/** The whole profile's time (every statement): past it, the rest is reported `budget`, never read. */
export const PROFILE_BUDGET_MS = 120_000;

/**
 * The aggregate statements for a relation (aliases `n`, `nn<i>`, `d<i>`, `i` the column's index), chunked. With
 * `distinct` off, no `count(DISTINCT …)` at all (the retry for a type whose equality the source does not have). Pure.
 */
export function relationSqls(r: ProfileRelation, distinctOn = true): string[] {
  const chunks: string[][] = [];
  let cur: string[] = ['count(*) AS n'];
  let distinct = 0;
  r.columns.forEach((c, i) => {
    const eq = distinctOn && !NO_EQUALITY.test(c.type);
    if (eq && distinct >= DISTINCT_PER_STATEMENT) {
      chunks.push(cur);
      cur = ['count(*) AS n'];
      distinct = 0;
    }
    cur.push(`count(${qident(c.name)}) AS nn${i}`);
    if (eq) {
      cur.push(`count(DISTINCT ${qident(c.name)}) AS d${i}`);
      distinct++;
    }
  });
  chunks.push(cur);
  return chunks.map((parts) => `SELECT ${parts.join(', ')} FROM ${qrel(r)}`);
}

/** The first (or only) aggregate statement of a relation. Pure. */
export function relationSql(r: ProfileRelation): string {
  return relationSqls(r)[0]!;
}

/** The overlap statement for a one-column join candidate (aliases `d`, `hit`). Pure. */
export function overlapSql(from: ProfileRelation, column: string, to: ProfileRelation, key: string): string {
  const c = `a.${qident(column)}`;
  return `SELECT count(DISTINCT ${c}) AS d, count(DISTINCT ${c}) FILTER (WHERE EXISTS (SELECT 1 FROM ${qrel(to)} b WHERE b.${qident(key)} = ${c})) AS hit FROM ${qrel(from)} a`;
}

export function rowsBand(n: number): RowsBand {
  if (n <= 0) return '0';
  if (n < 100) return '1-99';
  if (n < 10_000) return '100-9,999';
  if (n < 1_000_000) return '10,000-999,999';
  return '1,000,000+';
}

export function cardinalityOf(distinct: number | null, nonNull: number): Cardinality {
  if (distinct === null) return 'unknown';
  if (nonNull === 0) return 'none';
  if (distinct === 1) return 'single';
  if (distinct === nonNull) return 'unique';
  return distinct / nonNull >= 0.5 ? 'high' : 'low';
}

export function overlapBand(hit: number, distinct: number): OverlapBand {
  if (distinct === 0) return 'empty';
  if (hit === 0) return 'none';
  if (hit >= distinct) return 'all';
  return hit / distinct >= 0.5 ? 'most' : 'some';
}

/** A count from the one result row, by its alias; anything that is not a whole number reads as unknown. */
function countOf(res: SqlReadResult, alias: string): number | null {
  const i = res.columns.findIndex((c) => c.name === alias);
  if (i < 0) return null;
  const raw = res.rows[0]?.[i];
  const n = typeof raw === 'number' ? raw : typeof raw === 'bigint' ? Number(raw) : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const singular = (s: string): string =>
  /ies$/i.test(s) ? `${s.slice(0, -3)}y` : /(ss|us|is)$/i.test(s) ? s : /(xes|zes|ches|shes|sses)$/i.test(s) ? s.slice(0, -2) : /s$/i.test(s) ? s.slice(0, -1) : s;

/** The relation a `<x>_id` column names by convention, when one with a one-column key of the same type family exists. */
function conventionalTarget(col: { name: string; type: string }, self: ProfileRelation, all: readonly ProfileRelation[]): { to: ProfileRelation; key: string } | null {
  const m = /^(.+)_id$/i.exec(col.name);
  if (m === null || (!INTEGER.test(col.type) && !/^uuid$/i.test(col.type) && !/^(text|character varying.*|varchar.*)$/i.test(col.type))) return null;
  const stem = m[1]!.toLowerCase();
  const names = new Set([stem, `${stem}s`, `${stem}es`, stem.endsWith('y') ? `${stem.slice(0, -1)}ies` : stem]);
  // A key's type family; anything else (a date, a boolean, a missing column) is no family and never a join key.
  const family = (t: string): string | null => (INTEGER.test(t) ? 'int' : /^uuid$/i.test(t) ? 'uuid' : /^(text|character varying.*|varchar.*)$/i.test(t) ? 'text' : null);
  const keyType = (r: ProfileRelation): string => r.columns.find((c) => c.name === r.primaryKey[0])?.type ?? '';
  const mine = family(col.type);
  // Only a relation whose one-column key has the same (known) type family; then the same schema first, then any.
  const candidates = mine === null ? [] : all.filter((r) => r !== self && names.has(r.name.toLowerCase()) && r.primaryKey.length === 1 && family(keyType(r)) === mine);
  const pick = candidates.find((r) => r.schema === self.schema) ?? candidates[0];
  return pick === undefined ? null : { to: pick, key: pick.primaryKey[0]! };
}

/** The join candidates of a set of relations: declared foreign keys, then `<x>_id` by name and type. Pure. */
export function joinCandidates(relations: readonly ProfileRelation[]): Array<Omit<JoinProfile, 'overlap'> & { fromRel: ProfileRelation; toRel: ProfileRelation }> {
  // A key's target by its schema and name (a relation's key is estate's, which may quote its identifiers).
  const byName = new Map(relations.map((r) => [`${r.schema ?? ''}\u0000${r.name}`, r]));
  const out: Array<Omit<JoinProfile, 'overlap'> & { fromRel: ProfileRelation; toRel: ProfileRelation }> = [];
  const seen = new Set<string>();
  for (const r of relations) {
    // Columns a declared key already covers get no name-and-type guess.
    const covered = new Set<string>();
    for (const fk of r.foreignKeys) {
      const to = byName.get(`${fk.references.schema ?? r.schema ?? ''}\u0000${fk.references.table}`);
      if (to === undefined) continue;
      // The same columns may reference two relations: a key's identity is both of its ends.
      const id = JSON.stringify([r.key, fk.columns, to.key, fk.references.columns]);
      if (seen.has(id)) continue;
      seen.add(id);
      for (const c of fk.columns) covered.add(c);
      out.push({ from: r.key, columns: [...fk.columns], to: to.key, references: [...fk.references.columns], basis: 'fk', fromRel: r, toRel: to });
    }
    for (const c of r.columns) {
      if (covered.has(c.name) || r.primaryKey.includes(c.name)) continue;
      const t = conventionalTarget(c, r, relations);
      if (t === null) continue;
      out.push({ from: r.key, columns: [c.name], to: t.to.key, references: [t.key], basis: 'name_type', fromRel: r, toRel: t.to });
    }
  }
  return out;
}

/** Why a read failed, as a class (never the source's own words, which can echo a value). */
function failureClass(err: unknown): string {
  const e = err as { errorClass?: unknown; code?: unknown; name?: unknown };
  if (typeof e.errorClass === 'string') return e.errorClass;
  if (typeof e.code === 'string' && /^[a-z_]+$/.test(e.code)) return e.code;
  return 'failed';
}

/** The profile's work bound: a clock and when it ends (tests pass their own). */
export interface ProfileBudget {
  now: () => number;
  endsAt: number;
}

/**
 * Profile `relations` through `read` (the gate). Value-free by construction (module doc). A relation whose read fails
 * is listed with its failure class and no bands; a join whose overlap read fails keeps its declared basis only. Past
 * the budget nothing more is read: the rest is listed `budget`.
 */
export async function profileSource(relations: readonly ProfileRelation[], read: ProfileRead, budget: ProfileBudget = { now: Date.now, endsAt: Date.now() + PROFILE_BUDGET_MS }): Promise<SourceProfile> {
  const out: RelationProfile[] = [];
  const spent = (): boolean => budget.now() >= budget.endsAt;
  const more = (r: ProfileRelation): { columnsNotListed?: number } => (r.columnsNotListed !== undefined && r.columnsNotListed > 0 ? { columnsNotListed: r.columnsNotListed } : {});
  for (const r of relations) {
    let results: SqlReadResult[] = [];
    let failed: string | null = null;
    let distinctOn = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      results = [];
      failed = null;
      for (const sql of relationSqls(r, distinctOn)) {
        if (spent()) {
          failed = 'budget';
          break;
        }
        try {
          results.push(await read(sql));
        } catch (err) {
          failed = failureClass(err);
          break;
        }
      }
      // A source error on a distinct count (a column type with no equality the list did not know): once more without
      // distinct counts, so the relation keeps its row band and nulls (its cardinality is then unknown).
      if (failed !== 'source' || !distinctOn) break;
      distinctOn = false;
    }
    if (failed !== null) {
      out.push({ key: r.key, rows: null, columns: [], error: failed, ...more(r) });
      continue;
    }
    // Every chunk answers `n`; they must agree. A row-count check only: chunks are separate reads, so a write that
    // keeps the count can still land between two of them (the bands are rough by design).
    const ns = results.map((res) => countOf(res, 'n'));
    const n = ns[0] ?? null;
    if (n === null || ns.some((x) => x !== n)) {
      out.push({ key: r.key, rows: null, columns: [], error: n === null ? 'unreadable' : 'changed', ...more(r) });
      continue;
    }
    const countAt = (alias: string): number | null => {
      for (const res of results) {
        const v = countOf(res, alias);
        if (v !== null) return v;
      }
      return null;
    };
    const columns = r.columns.map((c, i): ColumnProfile => {
      const nn = countAt(`nn${i}`) ?? 0;
      const d = !distinctOn || NO_EQUALITY.test(c.type) ? null : countAt(`d${i}`);
      const nulls = n - nn;
      const cardinality = cardinalityOf(d, nn);
      return {
        name: c.name,
        type: c.type,
        nullPct: n === 0 ? null : Math.round((nulls / n) * 20) * 5,
        hasNulls: nulls > 0,
        cardinality,
        keyCandidate: (r.primaryKey.length === 1 && r.primaryKey[0] === c.name) || (n > 0 && nulls === 0 && cardinality === 'unique'),
      };
    });
    out.push({ key: r.key, rows: rowsBand(n), columns, error: null, ...more(r) });
  }
  const joins: JoinProfile[] = [];
  for (const j of joinCandidates(relations)) {
    let overlap: OverlapBand | null = null;
    if (j.columns.length === 1 && j.references.length === 1 && !spent()) {
      try {
        const res = await read(overlapSql(j.fromRel, j.columns[0]!, j.toRel, j.references[0]!));
        const d = countOf(res, 'd');
        const hit = countOf(res, 'hit');
        overlap = d === null || hit === null ? null : overlapBand(hit, d);
      } catch {
        overlap = null;
      }
    }
    // A name-and-type guess is kept only when the data agrees (most or all of its values are keys of the other side).
    if (j.basis === 'name_type' && overlap !== 'most' && overlap !== 'all') continue;
    joins.push({ from: j.from, columns: j.columns, to: j.to, references: j.references, basis: j.basis, overlap });
  }
  return { relations: out, joins };
}

/** The relation's name as code would name the entity it holds: singular and plural PascalCase. Pure. */
export function entityNames(relationName: string): string[] {
  // Words split on separators and on an existing camel/PascalCase boundary (`UserAccounts` -> User, Accounts).
  const words = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\-\s]+/).filter((p) => p !== '');
  const pascal = (s: string): string => words(s).map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase()).join('');
  const parts = words(relationName);
  if (parts.length === 0) return [];
  const last = parts[parts.length - 1]!;
  const one = pascal([...parts.slice(0, -1), singular(last)].join('_'));
  const many = pascal(relationName);
  return [...new Set([one, many])].filter((n) => /^[A-Za-z][A-Za-z0-9]*$/.test(n));
}
