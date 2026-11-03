// DES-APPS-001 K1 against a REAL MySQL 8 (S3, S11): describe, read through the policy, refusals that
// never reach the source, and the 10 s deadline stopping the query AT THE SOURCE (SHOW PROCESSLIST).

import { type AddressInfo, connect, createServer, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeMysql } from '../src/sources/catalog/mysql.js';
import { mysqlConnect, mysqlDescribe, mysqlRead } from '../src/sources/drivers/mysql.js';
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

    describe('review r2 folds (codex)', () => {
      it('T2/S10: a production read runs READ ONLY with sql_mode, max_execution_time and lock_wait_timeout pinned at the source, and stops at 5,000 rows', async () => {
        const r = await mysqlRead(reader(), 'SELECT @@transaction_read_only AS ro, @@lock_wait_timeout AS lw, @@max_execution_time AS me, @@sql_mode AS m', []);
        const [ro, lw, me, mode] = (r.rows[0] ?? []).map(String);
        expect([ro, lw, me]).toEqual(['1', '10', '10000']);
        expect(mode).toContain('NO_BACKSLASH_ESCAPES');
        const args = reader();
        const h: SqlSourceHandle = { driver: 'mysql', connect: args, catalog: await describeMysql(args), viewsAllowed: [] };
        const capped = await readSqlQuery(h, 'SELECT a.n FROM big a CROSS JOIN big b LIMIT 6000', []);
        expect(capped.rows).toHaveLength(5_000);
        expect(capped.truncated).toBe(true);
      });

      it('S2: the check runs the live relation checks too: a table replaced by a view since the describe is refused', async () => {
        await db.admin.query(`CREATE TABLE ${db.database}.r2m (id INT)`);
        try {
          const args = reader();
          const h: SqlSourceHandle = { driver: 'mysql', connect: args, catalog: await describeMysql(args), viewsAllowed: [] };
          expect(await checkSqlQuery(h, 'SELECT id FROM r2m')).toMatchObject({ ok: true });
          await db.admin.query(`DROP TABLE ${db.database}.r2m`);
          await db.admin.query(`CREATE VIEW ${db.database}.r2m AS SELECT 1 AS id`);
          expect(await checkSqlQuery(h, 'SELECT id FROM r2m')).toMatchObject({ ok: false, code: 'refused' });
        } finally {
          await db.admin.query(`DROP VIEW IF EXISTS ${db.database}.r2m`);
          await db.admin.query(`DROP TABLE IF EXISTS ${db.database}.r2m`);
        }
      });

      it('R1: a KILL connection that arrives after its race was lost is closed at once, never left holding a slot', async () => {
        // A proxy in front of the server: the read's connection passes at once; the second (the KILL
        // connection, pinned to the same address) is held back past the 3 s race.
        const opened: Array<{ forwardedAt: number; closedAt: number | null }> = [];
        const sockets = new Set<Socket>();
        const proxy = createServer((client) => {
          sockets.add(client);
          const rec = { forwardedAt: 0, closedAt: null as number | null };
          opened.push(rec);
          client.on('close', () => (rec.closedAt = Date.now()));
          client.on('error', () => undefined);
          setTimeout(
            () => {
              const up = connect(db.port, '127.0.0.1');
              sockets.add(up);
              up.on('error', () => client.destroy());
              rec.forwardedAt = Date.now();
              client.pipe(up);
              up.pipe(client);
              client.on('close', () => up.destroy());
            },
            opened.length === 2 ? 4_000 : 0,
          );
        });
        await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
        try {
          const args = { ...reader(), source: { ...reader().source, port: (proxy.address() as AddressInfo).port } };
          const marker = `late_kill_${Date.now()}`;
          await expect(mysqlRead(args, `SELECT SUM(a.n + b.n + c.n) AS ${marker} FROM big a, big b, big c`, [], { deadlineMs: 500 })).rejects.toBeDefined();
          // The killer arrives at ~4.5 s; with the fix it is closed as soon as its handshake completes.
          for (let i = 0; i < 80 && !(opened[1]?.forwardedAt && opened[1].closedAt !== null); i++) await new Promise((r) => setTimeout(r, 100));
          expect(opened.length).toBe(2);
          expect(opened[1]?.closedAt).not.toBeNull();
          expect((opened[1]?.closedAt ?? 0) - (opened[1]?.forwardedAt ?? 0)).toBeLessThan(2_000);
        } finally {
          for (const sk of sockets) sk.destroy();
          await new Promise<void>((r) => proxy.close(() => r()));
        }
      }, 20_000);

      it('a describe whose prepare the server never answers settles at its deadline (codex r4)', async () => {
        // A proxy that passes everything but swallows COM_STMT_PREPARE (command 0x16): the prepare never answers.
        const sockets = new Set<Socket>();
        const proxy = createServer((client) => {
          sockets.add(client);
          client.on('error', () => undefined);
          const up = connect(db.port, '127.0.0.1');
          sockets.add(up);
          up.on('error', () => client.destroy());
          up.pipe(client);
          let buf = Buffer.alloc(0);
          let stalled = false;
          client.on('data', (c: Buffer) => {
            if (stalled) return;
            buf = Buffer.concat([buf, c]);
            while (buf.length >= 4) {
              const len = buf.readUIntLE(0, 3);
              if (buf.length < 4 + len) break;
              const packet = buf.subarray(0, 4 + len);
              buf = buf.subarray(4 + len);
              if (packet[3] === 0 && packet[4] === 0x16) {
                stalled = true;
                return;
              }
              up.write(packet);
            }
          });
          client.on('close', () => up.destroy());
        });
        await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
        try {
          const args = { ...reader(), source: { ...reader().source, port: (proxy.address() as AddressInfo).port } };
          const t0 = Date.now();
          await expect(mysqlDescribe(args, 'SELECT n FROM big', undefined, 800)).rejects.toMatchObject({ errorClass: 'timeout' });
          expect(Date.now() - t0).toBeLessThan(3_000);
        } finally {
          for (const sk of sockets) sk.destroy();
          await new Promise<void>((r) => proxy.close(() => r()));
        }
      }, 15_000);

      it('one deadline from entry (codex r3): a connection slower than the deadline is a timeout, not a fresh 10 s after it', async () => {
        const slow = (async (host: string) => {
          await new Promise((r) => setTimeout(r, 2_500));
          return host === DB_HOST ? ['127.0.0.1'] : [];
        }) as ReturnType<typeof countingResolver>;
        const t0 = Date.now();
        await expect(mysqlRead(reader(slow), 'SELECT 1 AS one', [], { deadlineMs: 300 })).rejects.toMatchObject({ errorClass: 'timeout' });
        expect(Date.now() - t0).toBeLessThan(1_500);
      }, 15_000);

      it('a KILL connection that never gets through its handshake is abandoned when its race is lost (codex r3)', async () => {
        // The second connection (the killer) reaches a proxy that never answers: no greeting, no handshake.
        const opened: Array<{ at: number; closedAt: number | null }> = [];
        const sockets = new Set<Socket>();
        const proxy = createServer((client) => {
          sockets.add(client);
          const rec = { at: Date.now(), closedAt: null as number | null };
          opened.push(rec);
          client.on('close', () => (rec.closedAt = Date.now()));
          client.on('error', () => undefined);
          if (opened.length === 2) return; // stall
          const up = connect(db.port, '127.0.0.1');
          sockets.add(up);
          up.on('error', () => client.destroy());
          client.pipe(up);
          up.pipe(client);
          client.on('close', () => up.destroy());
        });
        await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
        try {
          const args = { ...reader(), source: { ...reader().source, port: (proxy.address() as AddressInfo).port } };
          await expect(mysqlRead(args, 'SELECT SUM(a.n + b.n + c.n) AS s FROM big a, big b, big c', [], { deadlineMs: 500 })).rejects.toBeDefined();
          const mainEnded = Date.now();
          for (let i = 0; i < 80 && opened[1]?.closedAt == null; i++) await new Promise((r) => setTimeout(r, 100));
          expect(opened.length).toBe(2);
          // Closed at the 3 s race at the latest, not at mysql2's own 10 s connect timeout ...
          expect((opened[1]?.closedAt ?? Infinity) - (opened[1]?.at ?? 0)).toBeLessThan(6_000);
          // ... and with the call: the source stopped the query itself, so the attempt ended with it (codex r4).
          expect((opened[1]?.closedAt ?? Infinity) - mainEnded).toBeLessThan(1_500);
        } finally {
          for (const sk of sockets) sk.destroy();
          await new Promise<void>((r) => proxy.close(() => r()));
        }
      }, 20_000);
    });
  });
}
