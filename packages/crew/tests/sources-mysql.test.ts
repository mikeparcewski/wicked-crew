// DES-APPS-001 K1 against a REAL MySQL 8 (S3, S11): describe, read through the policy, refusals that
// never reach the source, and the 10 s deadline stopping the query AT THE SOURCE (SHOW PROCESSLIST).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeMysql } from '../src/sources/catalog/mysql.js';
import { mysqlConnect, mysqlRead } from '../src/sources/drivers/mysql.js';
import type { SqlConnectArgs } from '../src/sources/drivers/types.js';
import { checkSqlQuery, readSqlQuery, SourcePolicyError, type SqlSourceHandle } from '../src/sources/sql.js';
import { countingResolver, DB_HOST, DB_REQUIRED, type FreshMysql, freshMysqlDatabase, LOOPBACK, MYSQL_TARGETS } from './support/sources-db.js';

if (MYSQL_TARGETS.length === 0) {
  describe('Apps sources on a real MySQL', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_MYSQL8_URL (CI sets it; WICKED_SOURCES_DB=required fails here instead of skipping)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but APPS_MYSQL8_URL is not set');
    });
  });
}

for (const target of MYSQL_TARGETS) {
  describe(`Apps sources on ${target.label}`, () => {
    let db: FreshMysql;
    const reader = (resolver = countingResolver()): SqlConnectArgs => ({
      source: { driver: 'mysql', host: DB_HOST, port: db.port, database: db.database, user: 'apps_reader', tls: 'disable' },
      password: 'apps-reader',
      policy: LOOPBACK,
      dial: { resolver },
    });
    beforeAll(async () => {
      db = await freshMysqlDatabase(target);
    }, 60_000);
    afterAll(async () => {
      await db?.drop();
    });

    it('describes the catalog: tables, a view, ENUM literals, keys; never a row value', async () => {
      const cat = await describeMysql(reader());
      const refunds = cat.relations.find((r) => r.name === 'refunds');
      expect(refunds).toMatchObject({ schema: db.database, kind: 'table', primaryKey: ['id'] });
      expect(refunds?.columns.find((c) => c.name === 'status')?.enumValues).toEqual(['pending', 'approved', 'rejected']);
      expect(cat.relations.find((r) => r.name === 'pending')?.kind).toBe('view');
      expect(cat.relations.find((r) => r.name === 'ledger')?.foreignKeys).toEqual([{ name: 'ledger_refund', columns: ['refund_id'], references: { schema: db.database, table: 'refunds', columns: ['id'] } }]);
      expect(JSON.stringify(cat)).not.toContain('EMEA');
    });

    it('reads through the policy: READ ONLY, prepared, a bare table name meaning the source database', async () => {
      const args = reader();
      const h: SqlSourceHandle = { driver: 'mysql', connect: args, catalog: await describeMysql(args), viewsAllowed: [] };
      const r = await readSqlQuery(h, "SELECT region, SUM(amount) AS total FROM refunds WHERE status <> ? GROUP BY region ORDER BY region", ['rejected']);
      expect(r.rows).toEqual([['AMER', '99.99'], ['EMEA', '10.50']]);
      const c = await checkSqlQuery(h, 'SELECT id, amount FROM refunds WHERE region = ?');
      expect(c).toMatchObject({ ok: true, describe: { columns: [{ name: 'id' }, { name: 'amount' }], params: ['unknown'] } });
      // A login that COULD write is still held by the READ ONLY transaction (defence in depth).
      const root = { ...args, source: { ...args.source, user: decodeURIComponent(target.url.username) }, password: decodeURIComponent(target.url.password) };
      const conn = await mysqlConnect(root);
      try {
        await conn.query('START TRANSACTION READ ONLY');
        await expect(conn.query("UPDATE refunds SET region = 'x'")).rejects.toThrow(/READ ONLY|read only/i);
      } finally {
        conn.destroy();
      }
    });

    it('S3: the read policy refuses these without reaching the source', async () => {
      const resolver = countingResolver();
      const h: SqlSourceHandle = { driver: 'mysql', connect: reader(resolver), catalog: await describeMysql(reader()), viewsAllowed: [] };
      for (const [q, code] of [
        ['DELETE FROM refunds', 'not_select'],
        ['SELECT SLEEP(60)', 'function'],
        ["SELECT LOAD_FILE('/etc/passwd')", 'function'],
        ["SELECT GET_LOCK('a', 10)", 'function'],
        ['SELECT * FROM pending', 'view'],
        ['SELECT * FROM mysql.user', 'relation'],
        ['SELECT /*!50000 SLEEP(10) */ 1', 'lexical'],
        ["SELECT 'a\\\\' , SLEEP(1) -- '", 'lexical'],
        ['SELECT * FROM refunds INTO OUTFILE \'/tmp/x\'', 'into'],
        ['SELECT * FROM refunds FOR UPDATE', 'locking'],
        ['WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT 1 FROM r) SELECT * FROM r', 'recursive'],
      ] as const) {
        const err = await readSqlQuery(h, q, []).catch((e: unknown) => e);
        expect(err, q).toBeInstanceOf(SourcePolicyError);
        expect((err as SourcePolicyError).code, q).toBe(code);
      }
      expect(resolver.calls).toBe(0);
    });

    it('a deadline the source does not enforce is met by KILL QUERY, sent to the backend the read runs on (codex r1)', async () => {
      let n = 0;
      const flip = Object.assign(async () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']), { calls: 0 });
      const marker = `kill_${Date.now()}`;
      const t0 = Date.now();
      const out = await mysqlRead(reader(flip as never), `SELECT SUM(a.n + b.n + c.n) AS ${marker} FROM big a, big b, big c`, [], { deadlineMs: 2_500, sourceTimeoutMs: 120_000 }).then(
        () => ({ ok: true, at: Date.now() - t0 }),
        (e: unknown) => ({ ok: false, at: Date.now() - t0, err: e as { errorClass?: string } }),
      );
      expect(out.ok).toBe(false);
      expect(out.at).toBeLessThan(7_000);
      expect(n).toBe(1); // the KILL connection was pinned to the read's address
      await new Promise((r) => setTimeout(r, 500));
      const [rows] = (await db.admin.query('SHOW FULL PROCESSLIST')) as unknown as [Array<{ Info: string | null }>];
      expect(rows.filter((r) => (r.Info ?? '').includes(marker) && !(r.Info ?? '').startsWith('SHOW'))).toHaveLength(0);
    }, 20_000);

    it('TLS VERIFY_IDENTITY against the server\'s self-signed certificate is refused, never downgraded (codex r1)', async () => {
      const args = reader();
      await expect(describeMysql({ ...args, source: { ...args.source, tls: 'verify-full' } })).rejects.toThrow();
    });

    it('S11: a query that would run for minutes stops at 10 s AT THE SOURCE (SHOW PROCESSLIST)', async () => {
      const marker = `deadline_${Date.now()}`;
      // A SUM over the cross join: MySQL answers a bare COUNT(*) of a join from statistics, instantly.
      const q = `SELECT SUM(a.n + b.n + c.n) AS ${marker} FROM big a, big b, big c`;
      const t0 = Date.now();
      const run = mysqlRead(reader(), q, []).then(
        () => ({ ok: true as const, at: Date.now() - t0 }),
        (e: unknown) => ({ ok: false as const, at: Date.now() - t0, err: e as { errorClass?: string } }),
      );
      const active = async (): Promise<number> => {
        const [rows] = (await db.admin.query('SHOW FULL PROCESSLIST')) as unknown as [Array<{ Info: string | null; Command: string }>];
        return rows.filter((r) => r.Command === 'Execute' || r.Command === 'Query').filter((r) => (r.Info ?? '').includes(marker) && !(r.Info ?? '').startsWith('SHOW')).length;
      };
      await new Promise((r) => setTimeout(r, 4_000));
      expect(await active()).toBe(1); // running at the source
      const out = await run;
      expect(out.ok).toBe(false);
      expect(out.at).toBeGreaterThanOrEqual(9_500);
      expect(out.at).toBeLessThan(12_500);
      if (!out.ok) expect(out.err).toMatchObject({ errorClass: 'timeout' });
      await new Promise((r) => setTimeout(r, 500));
      expect(await active()).toBe(0); // and gone from the source
    }, 30_000);
  });
}
