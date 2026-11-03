// DES-APPS-001 §5.3 — the read policy, without a database: each refusal is a text the walker or
// grammar must reject before anything reaches a source. Review folds (codex/pi r1 on K1) are named.

import { describe, expect, it } from 'vitest';

import { policyCatalog, type SqlCatalog } from '../src/sources/catalog/types.js';
import { mysqlRelationKind } from '../src/sources/drivers/mysql.js';
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

const pg = (q: string, views: string[] = ['s.v']) => checkReadPolicy('postgres', q, policyCatalog(PG, views));
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

  it('resolves q.c against q itself, never an output name or another relation (codex r2: S1)', async () => {
    // The output alias must not validate its own input: w has no column row_to_json.
    expect(await pg('SELECT w.row_to_json AS row_to_json FROM s.w w')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT w.row_to_json FROM s.w w, (SELECT 1 AS row_to_json) q')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT q.v FROM (SELECT w.id AS row_to_json FROM s.w w) q(v), s.v x(row_to_json)')).toMatchObject({ ok: true });
    // A renamed column is gone under its old name; a qualifier that is no FROM item is refused.
    expect(await pg('SELECT x.id FROM s.w AS x(a, b)')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT x.owner FROM s.w AS x(a)')).toMatchObject({ ok: true });
    expect(await pg('SELECT x.e FROM s.w AS x(a, b, c, d, e)')).toMatchObject({ ok: false, code: 'column' }); // pi r3: no phantom columns
    expect(await pg('SELECT id.text FROM s.w')).toMatchObject({ ok: false, code: 'column' });
    // Subquery and CTE columns are their output names: real ones pass, made-up ones do not.
    expect(await pg('SELECT q.row_to_json FROM (SELECT w.id AS row_to_json FROM s.w w) q')).toMatchObject({ ok: true });
    expect(await pg('SELECT q.id, q.owner FROM (SELECT * FROM s.w) q')).toMatchObject({ ok: true });
    expect(await pg('SELECT q.id FROM (SELECT w.owner FROM s.w w) q')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT q.count FROM (SELECT count(*) FROM s.w) q')).toMatchObject({ ok: true });
    expect(await pg('SELECT q.to_json FROM (SELECT 1 + 1 FROM s.w) q')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('WITH t AS (SELECT owner FROM s.w) SELECT t.id FROM t')).toMatchObject({ ok: false, code: 'column' });
    // The nearest level wins: inside, w is the inner table; outside, the outer one.
    expect(await pg('SELECT w.owner FROM s.w w WHERE EXISTS (SELECT 1 FROM s.v w WHERE w.id = 1)')).toMatchObject({ ok: true });
    expect(await pg('SELECT 1 FROM s.w w WHERE EXISTS (SELECT 1 FROM s.v w WHERE w.owner = 1)')).toMatchObject({ ok: false, code: 'column' });
    // An aliased join hides the names inside it.
    expect(await pg('SELECT j.owner FROM (s.w a JOIN s.v b ON a.id = b.id) AS j')).toMatchObject({ ok: true });
    expect(await pg('SELECT a.owner FROM (s.w a JOIN s.v b ON a.id = b.id) AS j')).toMatchObject({ ok: false, code: 'column' });
  });

  it('a join is named as Postgres names it: USING/NATURAL columns once, then the rest; a star takes no alias (codex r3)', async () => {
    // s.w(id, owner) USING (id) s.v(id): output (id, owner); renamed (x, y), so j.owner no longer exists.
    expect(await pg('SELECT j.y FROM (s.w a JOIN s.v b USING (id)) AS j(x, y)')).toMatchObject({ ok: true });
    expect(await pg('SELECT j.owner FROM (s.w a JOIN s.v b USING (id)) AS j(x, y)')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT j.z FROM (s.w a NATURAL JOIN s.v b) AS j(x, y, z)')).toMatchObject({ ok: false, code: 'column' }); // two columns, not three
    // A USING alias names only the merged columns, and adds none to a star.
    expect(await pg('SELECT u.id FROM s.w a JOIN s.v b USING (id) AS u')).toMatchObject({ ok: true });
    expect(await pg('SELECT q.id, q.owner FROM (SELECT * FROM s.w a JOIN s.v b USING (id) AS u) q(i, o)')).toMatchObject({ ok: false, code: 'column' });
    expect(await pg('SELECT q.i, q.o FROM (SELECT * FROM s.w a JOIN s.v b USING (id) AS u) q(i, o)')).toMatchObject({ ok: true });
    expect(await pg('SELECT q.display FROM (SELECT w.* AS display FROM s.w w) q')).toMatchObject({ ok: false, code: 'syntax' });
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

  it('refuses CURRENT_USER and CURRENT_ROLE, which MySQL calls without parentheses (codex r2: C6)', async () => {
    expect(await my('SELECT CURRENT_USER FROM refunds')).toMatchObject({ ok: false, code: 'function' });
    expect(await my('SELECT id FROM refunds WHERE region = CURRENT_ROLE')).toMatchObject({ ok: false, code: 'function' });
    expect(await my('SELECT CURRENT_DATE, UTC_TIME FROM refunds')).toMatchObject({ ok: true });
  });

  it('only ASCII whitespace: a "--" before a non-ASCII space, or such a space between tokens, is refused', async () => {
    expect(await my('SELECT 1 -- hidden\nFROM refunds')).toMatchObject({ ok: false, code: 'lexical' });
    expect(await my('SELECT id FROM refunds')).toMatchObject({ ok: false, code: 'lexical' });
    expect(await my('SELECT id FROM refunds -- a comment\n')).toMatchObject({ ok: true });
    expect(await my("SELECT 'naïve' AS t FROM refunds")).toMatchObject({ ok: true }); // inside a string: fine
  });
});

describe('MySQL relation kinds from information_schema (codex r2: S11)', () => {
  it('a FEDERATED table (or an engine crew does not know) is foreign, never a local table', () => {
    expect(mysqlRelationKind('BASE TABLE', 'InnoDB')).toBe('table');
    expect(mysqlRelationKind('BASE TABLE', 'MyISAM')).toBe('table');
    expect(mysqlRelationKind('BASE TABLE', 'FEDERATED')).toBe('foreign');
    expect(mysqlRelationKind('BASE TABLE', 'CONNECT')).toBe('foreign');
    expect(mysqlRelationKind('BASE TABLE', null)).toBe('foreign');
    expect(mysqlRelationKind('VIEW', null)).toBe('view');
    expect(mysqlRelationKind('SEQUENCE', 'InnoDB')).toBe('other');
  });
});

describe('SQLite placeholders (codex r1)', () => {
  it('counts ? outside strings, names and comments; refuses numbered and named placeholders', () => {
    expect(sqliteParams("SELECT '?' AS q, \"?\" FROM t WHERE a = ? /* ? */ -- ?\n AND b = ?")).toEqual({ ok: true, count: 2 });
    expect(sqliteParams('SELECT ?5')).toMatchObject({ ok: false });
    for (const q of ['SELECT :x', 'SELECT @x', 'SELECT $x']) expect(sqliteParams(q), q).toMatchObject({ ok: false });
  });

  it('refuses every named spelling, and statements that are not SELECT or WITH (codex r2: K1, C7)', () => {
    for (const q of ['SELECT :1', 'SELECT :\u00e9', 'SELECT @1', 'SELECT $1', 'SELECT 1 WHERE 1 = $\u00e9'] ) expect(sqliteParams(q), q).toMatchObject({ ok: false });
    expect(sqliteParams('SELECT a$b FROM t WHERE x = ?')).toEqual({ ok: true, count: 1 });
    for (const q of ['VALUES(1)', 'EXPLAIN SELECT 1', 'EXPLAIN QUERY PLAN SELECT 1', ' -- c\n', '']) expect(sqliteParams(q), q).toMatchObject({ ok: false });
    expect(sqliteParams('/* c */ WITH x AS (SELECT 1) SELECT * FROM x')).toEqual({ ok: true, count: 0 });
  });
});
