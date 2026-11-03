// DES-APPS-001 §5.1, §5.3, §7.5 — uploads become SQLite snapshots, read under the authorizer in a
// child process. Real files: CSV with and without a header, XLSX, a .sqlite holding a trigger, a
// workbook that expands past 200 MB.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { observeSqliteRunnerForTests, sqliteRead } from '../src/sources/drivers/sqlite.js';
import { readSqlQuery, SourcePolicyError } from '../src/sources/sql.js';
import { detectHeader, ingestUpload, looksLikeHeader, snapshotPath, UploadError } from '../src/sources/uploads.js';
import { makeSqlite, makeXlsx, makeZipBomb, zip } from './fixtures/apps-sources/uploads/make.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'apps-sources', 'uploads');
let dir = '';
let work = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'apps-snapshots-'));
  work = mkdtempSync(join(tmpdir(), 'apps-uploads-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('uploads become content-addressed SQLite snapshots (DES §5.1)', () => {
  it('a CSV with a header: the header is detected, types inferred, the first rows for the person, the snapshot read-only', async () => {
    const up = await ingestUpload('refunds-2026.csv', readFileSync(join(FIX, 'with-header.csv')), { dir });
    expect(up.kind).toBe('csv');
    expect(up.header).toEqual({ detected: true, columns: ['id', 'region', 'amount', 'refunded_on'] });
    expect(up.table).toBe('refunds_2026');
    expect(up.sample[2]).toEqual(['3', 'APAC, south', '5', '2026-10-03']);
    const rel = up.catalog.relations[0];
    expect(rel?.columns.map((c) => [c.name, c.type])).toEqual([['id', 'INTEGER'], ['region', 'TEXT'], ['amount', 'REAL'], ['refunded_on', 'TEXT']]);
    const path = snapshotPath(up.digest, dir);
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(readdirSync(dir).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
    // Content-addressed: the same file stores once.
    const again = await ingestUpload('refunds-2026.csv', readFileSync(join(FIX, 'with-header.csv')), { dir });
    expect(again.digest).toBe(up.digest);
    const r = await sqliteRead(path, up.catalog, 'SELECT region, amount FROM refunds_2026 WHERE amount > ? ORDER BY id', [6]);
    expect(r.rows).toEqual([['EMEA', 10.5], ['AMER', 99.99]]);
  });

  it('a CSV whose first row looks like data gets col_1… names', async () => {
    const up = await ingestUpload('plain.csv', readFileSync(join(FIX, 'no-header.csv')), { dir });
    expect(up.header).toEqual({ detected: false, columns: ['col_1', 'col_2', 'col_3'] });
    expect(up.sample[0]).toEqual(['1', 'EMEA', '10.50']);
    expect(looksLikeHeader(['id', 'id'])).toBe(false);
    expect(looksLikeHeader(['region', '2026-10-01'])).toBe(false);
  });

  it('an XLSX: the first sheet, header detected', async () => {
    const up = await ingestUpload('q3.xlsx', makeXlsx([['ticket', 'owner', 'hours'], ['T-1', 'priya', 3], ['T-2', 'sam & co', 4.5]]), { dir });
    expect(up.kind).toBe('xlsx');
    expect(up.header?.columns).toEqual(['ticket', 'owner', 'hours']);
    expect(up.sample).toEqual([['T-1', 'priya', '3'], ['T-2', 'sam & co', '4.5']]);
  });

  it('an XLSX that expands past 200 MB is refused before it is held (S11)', async () => {
    const bomb = await makeZipBomb(300);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const err = await ingestUpload('bomb.xlsx', bomb, { dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('too_large');
  }, 60_000);

  it('a .sqlite holding a trigger (or a view) is refused; a plain one becomes a snapshot', async () => {
    makeSqlite(join(work, 'trig.sqlite'), { trigger: true });
    makeSqlite(join(work, 'view.sqlite'), { view: true });
    makeSqlite(join(work, 'ok.sqlite'));
    for (const f of ['trig.sqlite', 'view.sqlite']) {
      const err = await ingestUpload(f, readFileSync(join(work, f)), { dir }).catch((e: unknown) => e);
      expect(err, f).toBeInstanceOf(UploadError);
      expect((err as UploadError).code).toBe('sqlite_code');
    }
    const ok = await ingestUpload('ok.sqlite', readFileSync(join(work, 'ok.sqlite')), { dir });
    expect(ok.catalog.relations.map((r) => r.name)).toEqual(['refunds']);
  });

  it('the read policy on a snapshot: a recursive CTE, ATTACH, PRAGMA, a write and a second statement are refused', async () => {
    const up = await ingestUpload('ok.sqlite', readFileSync(join(work, 'ok.sqlite')), { dir });
    const h = { driver: 'sqlite' as const, snapshotPath: snapshotPath(up.digest, dir), catalog: up.catalog };
    for (const q of [
      'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r',
      "ATTACH DATABASE '/etc/hosts' AS x",
      'PRAGMA table_info(refunds)',
      'DELETE FROM refunds',
      'SELECT * FROM refunds; SELECT 1',
      'SELECT * FROM sqlite_schema',
      "SELECT load_extension('x')",
    ]) {
      await expect(readSqlQuery(h, q, []), q).rejects.toThrow(/not authorized|prohibited|exactly one statement/);
    }
    const r = await readSqlQuery(h, 'SELECT count(*) AS n, sum(amount) FROM refunds', []);
    expect(r.rows).toEqual([['2', 110.49]]);
    expect(SourcePolicyError).toBeDefined();
  });

  it('a long SQLite read is stopped at its deadline: the process running it is ended (codex r1)', async () => {
    const up = await ingestUpload('ok.sqlite', readFileSync(join(work, 'ok.sqlite')), { dir });
    const joins = Array.from({ length: 40 }, (_v, i) => `refunds t${i}`).join(', ');
    const pids: number[] = [];
    observeSqliteRunnerForTests((pid) => pids.push(pid));
    try {
      const t0 = Date.now();
      await expect(sqliteRead(snapshotPath(up.digest, dir), up.catalog, `SELECT count(*) FROM ${joins}`, [], { deadlineMs: 1_500 })).rejects.toMatchObject({ errorClass: 'timeout' });
      expect(Date.now() - t0).toBeLessThan(4_000);
    } finally {
      observeSqliteRunnerForTests(null);
    }
    expect(pids).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pids[0] as number, 0)).toThrow(); // ESRCH: the process is gone, not just abandoned
  });

  it('node:sqlite reports the FIRST statement as sourceSQL, which the tail check relies on (pi r1)', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    expect(db.prepare('SELECT 1; SELECT 2').sourceSQL.trim()).toBe('SELECT 1;');
    db.close();
  });

  it('a .sqlite holding a virtual table (its kind hidden in the schema text) or a generated column is refused (codex r1)', async () => {
    makeSqlite(join(work, 'vt.sqlite'), { hiddenVirtual: true });
    makeSqlite(join(work, 'gen.sqlite'), { generated: true });
    for (const f of ['vt.sqlite', 'gen.sqlite']) {
      const err = await ingestUpload(f, readFileSync(join(work, f)), { dir }).catch((e: unknown) => e);
      expect(err, f).toBeInstanceOf(UploadError);
      expect((err as UploadError).code, f).toBe('sqlite_code');
    }
  });

  it('a header is taken only when it differs in shape from the data, or a person says so (codex r1)', async () => {
    const people = Buffer.from('Priya Shah,priya@example.com\nSam Lee,sam@example.com\n');
    const auto = await ingestUpload('people.csv', people, { dir });
    expect(auto.header).toEqual({ detected: false, columns: ['col_1', 'col_2'] }); // a record never becomes column names
    const chosen = await ingestUpload('people.csv', people, { dir, header: 'yes' });
    expect(chosen.header?.columns).toEqual(['Priya Shah', 'priya@example.com']);
    expect(detectHeader([['id', 'amount'], ['1', '2.5']], null)).toBe(true);
    expect(detectHeader([['name', 'email'], ['a', 'b']], null)).toBe(false);
  });

  it('CSV edge cases: exact large integers, a two-byte file, quoted delimiters, case-insensitive names, early column limit (codex r1)', async () => {
    const big = await ingestUpload('big.csv', Buffer.from('n,label\n9007199254740993,a\n12,b\n'), { dir });
    const r = await sqliteRead(snapshotPath(big.digest, dir), big.catalog, 'SELECT n FROM big ORDER BY label', []);
    expect(r.rows).toEqual([['9007199254740993'], ['12']]);
    const tiny = await ingestUpload('one.csv', Buffer.from('1\n'), { dir });
    expect(tiny.sample).toEqual([['1']]);
    const quoted = await ingestUpload('q.csv', Buffer.from('id,note\n1,"a;b;c;d"\n'), { dir });
    expect(quoted.catalog.relations[0]?.columns.map((c) => c.name)).toEqual(['id', 'note']);
    const dupes = await ingestUpload('d.csv', Buffer.from('a b,A  B,x\n1,2,3\n'), { dir });
    expect(dupes.header?.columns).toEqual(['a b', 'A B_2', 'x']);
    const wide = Buffer.from(`${Array.from({ length: 5_000 }, (_v, i) => `c${i}`).join(',')}\n`);
    await expect(ingestUpload('wide.csv', wide, { dir })).rejects.toMatchObject({ code: 'too_many_columns' });
  });

  it('a snapshot store inside a git work tree is refused (codex r1)', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'apps-repo-'));
    mkdirSync(join(repo, '.git'));
    try {
      await expect(ingestUpload('x.csv', readFileSync(join(FIX, 'with-header.csv')), { dir: join(repo, 'state', 'mcp', 'snapshots') })).rejects.toMatchObject({ code: 'snapshot_in_repo' });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('XLSX: shared strings repeated past 200 MB are refused; unclosed rows end the scan at once (codex r1)', async () => {
    const huge = 'x'.repeat(1024 * 1024);
    const cells = Array.from({ length: 250 }, (_v, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c></row>`).join('');
    const wb = zip([
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst><si><t>${huge}</t></si></sst>`) },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<worksheet><sheetData>${cells}</sheetData></worksheet>`) },
    ]);
    await expect(ingestUpload('rep.xlsx', wb, { dir })).rejects.toMatchObject({ code: 'too_large' });
    const unclosed = zip([
      { name: 'xl/workbook.xml', data: Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<worksheet><sheetData>${'<row r="1"><c r="A1"><v>1</v></c>'.repeat(200_000)}</sheetData></worksheet>`) },
    ]);
    const t0 = Date.now();
    await expect(ingestUpload('unclosed.xlsx', unclosed, { dir })).rejects.toMatchObject({ code: 'empty' });
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 30_000);
});
