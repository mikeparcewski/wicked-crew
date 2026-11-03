// DES-APPS-001 §5.3 — the read policy, without a database: each refusal is a text the walker or
// grammar must reject before anything reaches a source. Review folds (codex/pi r1 on K1) are named.

import { describe, expect, it } from 'vitest';

import { policyCatalog, type SqlCatalog } from '../src/sources/catalog/types.js';
import { checkReadPolicy, sqliteParams } from '../src/sources/policy/index.js';
import { relKey } from '../src/sources/policy/types.js';

const rel = (schema: string, name: string, kind: SqlCatalog['relations'][number]['kind'], columns: string[], extra: Partial<SqlCatalog['relations'][number]> = {}) => ({
  schema,
  name,
  kind,
  rowEstimate: null,
  columns: columns.map((c) => ({ name: c, type: 'text', nullable: true })),
  primaryKey: [],
  foreignKeys: [],
  ...extra,
});

const PG: SqlCatalog = {
  dialect: 'postgres',
  database: 'db',
  describedAt: '',
  relations: [
    rel('s', 'w', 'table', ['id', 'owner']),
    rel('s', 'v', 'view', ['id']),
    rel('s', 'fparent', 'table', ['id'], { foreignDescendant: true }),
    rel('a.b', 'c', 'view', ['x']),
    rel('a', 'b.c', 'table', ['x']),
  ],
};
const MY: SqlCatalog = { dialect: 'mysql', database: 'fin', describedAt: '', relations: [rel('fin', 'refunds', 'table', ['id', 'amount', 'region'])] };

const pg = (q: string, views: string[] = []) => checkReadPolicy('postgres', q, policyCatalog(PG, views));
const my = (q: string) => checkReadPolicy('mysql', q, policyCatalog(MY));

describe('Postgres: qualified column references must name columns (codex r1: functional notation)', () => {
  it('refuses w.row_to_json (Postgres would call row_to_json(w)), accepts real and aliased columns', async () => {
    expect(await pg('SELECT w.row_to_json FROM s.w AS w')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT w.to_jsonb FROM s.w w')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT q.json_agg FROM (SELECT owner FROM s.w) q')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT w.owner, w.id FROM s.w AS w WHERE w.id = $1')).toMatchObject({ ok: true });
    expect(await pg('SELECT q.n FROM (SELECT count(*) AS n FROM s.w) q')).toMatchObject({ ok: true });
    expect(await pg('SELECT x.a FROM s.w AS x(a, b)')).toMatchObject({ ok: true });
    expect(await pg('WITH t(k) AS (SELECT id FROM s.w) SELECT t.k FROM t')).toMatchObject({ ok: true });
  });
});

describe('Postgres: a plain read of a table with a foreign descendant is refused (codex r1: inheritance)', () => {
  it('refuses s.fparent, accepts ONLY s.fparent', async () => {
    expect(await pg('SELECT id FROM s.fparent')).toMatchObject({ ok: false, code: 'relation' });
    expect(await pg('SELECT id FROM ONLY s.fparent')).toMatchObject({ ok: true });
  });
});

describe('relation keys keep schema and name apart (codex r1)', () => {
  it('"a.b".c (a view) and a."b.c" (a table) are different relations', async () => {
    expect(await pg('SELECT x FROM "a.b".c')).toMatchObject({ ok: false, code: 'view' });
    expect(await pg('SELECT x FROM a."b.c"')).toMatchObject({ ok: true, relations: ['"a"."b.c"'] });
    expect(policyCatalog(PG, ['s.v']).viewsAllowed.has(relKey('s', 'v'))).toBe(true);
    expect(await pg('SELECT id FROM s.v', ['s.v'])).toMatchObject({ ok: true });
  });
});

describe('MySQL: what the server would read differently is refused (codex r1)', () => {
  it('a function name must be followed directly by "(": with a space MySQL calls a stored routine', async () => {
    expect(await my('SELECT COUNT (*) FROM refunds')).toMatchObject({ ok: false, code: 'function' });
    expect(await my('SELECT ROUND /* x */ (amount) FROM refunds')).toMatchObject({ ok: false, code: 'function' });
    expect(await my('SELECT COUNT(*), ROUND(amount, 2) FROM refunds')).toMatchObject({ ok: true });
  });

  it('only ASCII whitespace: a "--" before a non-ASCII space, or such a space between tokens, is refused', async () => {
    expect(await my('SELECT 1 -- hidden\nFROM refunds')).toMatchObject({ ok: false, code: 'lexical' });
    expect(await my('SELECT id FROM refunds')).toMatchObject({ ok: false, code: 'lexical' });
    expect(await my('SELECT id FROM refunds -- a comment\n')).toMatchObject({ ok: true });
    expect(await my("SELECT 'naïve' AS t FROM refunds")).toMatchObject({ ok: true }); // inside a string: fine
  });
});

describe('SQLite placeholders (codex r1)', () => {
  it('counts ? outside strings, names and comments; refuses numbered and named placeholders', () => {
    expect(sqliteParams("SELECT '?' AS q, \"?\" FROM t WHERE a = ? /* ? */ -- ?\n AND b = ?")).toEqual({ ok: true, count: 2 });
    expect(sqliteParams('SELECT ?5')).toMatchObject({ ok: false });
    for (const q of ['SELECT :x', 'SELECT @x', 'SELECT $x']) expect(sqliteParams(q), q).toMatchObject({ ok: false });
  });
});
