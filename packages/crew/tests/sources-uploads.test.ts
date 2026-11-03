// DES-APPS-001 §5.1, §5.3, §7.5 — uploads become SQLite snapshots, read under the authorizer in a
// child process. Real files: CSV with and without a header, XLSX, a .sqlite holding a trigger, a
// workbook that expands past 200 MB.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sqliteRead } from '../src/sources/drivers/sqlite.js';
import { readSqlQuery, SourcePolicyError } from '../src/sources/sql.js';
import { ingestUpload, looksLikeHeader, snapshotPath, UploadError } from '../src/sources/uploads.js';
import { makeSqlite, makeXlsx, makeZipBomb } from './fixtures/apps-sources/uploads/make.mjs';

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

  it('a long SQLite read is stopped at its deadline: the process running it is ended', async () => {
    const up = await ingestUpload('ok.sqlite', readFileSync(join(work, 'ok.sqlite')), { dir });
    const joins = Array.from({ length: 40 }, (_v, i) => `refunds t${i}`).join(', ');
    const t0 = Date.now();
    await expect(sqliteRead(snapshotPath(up.digest, dir), up.catalog, `SELECT count(*) FROM ${joins}`, [], { deadlineMs: 1_500 })).rejects.toMatchObject({ errorClass: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });
});
