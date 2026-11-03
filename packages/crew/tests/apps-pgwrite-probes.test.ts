// DES-APPS-001 §7.4 (K2b): the permanent regression suite. Every probe P1-P43 of the row-write design
// (lanes/data-builder-design/review/pgwrite-probe*.sh, expected results in pgwrite-probes.out) is a test here,
// against the PRODUCT path where one exists (the table safety check, the source stage, grant, prepare and run
// through crew's routes) and as the raw Postgres behaviour the design rests on where it is a fact about
// Postgres itself. It runs on Postgres 16 AND 17 on every crew PR (CI job sources-db). No probe's behaviour
// differs between the two versions (checked on 16.15 and 17.11); a probe that came to differ would assert each
// version's result here and say why. A later change that breaks a probe fails CI.

import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { pgExactFitIn } from '../src/apps/actions/pg-fit.js';
import type { AppAction, AppActionPrepareResponse, AppDetail } from '../src/core/types.js';
import { pgReadOnly } from '../src/sources/drivers/postgres.js';
import type { SqlConnectArgs } from '../src/sources/drivers/types.js';
import { pgTableSafety, pgTableSafetyIn, type SafetyDeclaration } from '../src/sources/safety/postgres.js';
import { specWith } from './support/apps-harness.js';
import { updateAction, type WriteRig, writeRig } from './support/apps-writes.js';
import { DB_REQUIRED, type FreshPg, freshPgDatabase, LOOPBACK, PG_TARGETS } from './support/sources-db.js';

if (PG_TARGETS.length === 0) {
  describe('P1-P43 on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`P1-P43 on ${target.label}`, () => {
    let db: FreshPg;
    let rig: WriteRig;
    let n = 0;
    const args = (user = 'apps_k2b_writer', password = 'apps-k2b-writer'): SqlConnectArgs => ({
      source: { driver: 'postgres', host: '127.0.0.1', port: db.port, database: db.database, user, tls: 'disable' },
      password,
      policy: LOOPBACK,
    });
    /** A session as `user` (a plain postgres.js client, for the raw probes). */
    const as = (user: string, password: string) => {
      const url = new URL(target.url.href);
      url.username = user;
      url.password = password;
      url.pathname = `/${db.database}`;
      return postgres(url.href, { max: 1, onnotice: () => undefined }) as unknown as postgres.Sql<Record<string, never>>;
    };
    const safety = (table: string, decl: SafetyDeclaration | null = null) => pgTableSafety(args('apps_reader', 'apps-reader'), 's', table, decl);
    const codes = async (table: string, decl: SafetyDeclaration | null = null): Promise<string[]> => (await safety(table, decl)).reasons.map((r) => r.code);
    const side = async (): Promise<number> => Number((await db.admin.unsafe<Array<{ n: string }>>('SELECT count(*)::text AS n FROM s.side'))[0]?.n ?? '0');
    /** What s.side holds, for a failure's message. */
    const sideNotes = async (): Promise<string> => JSON.stringify(await db.admin.unsafe('SELECT note FROM s.side'));
    /** Land `actions` and answer the check's first finding code, or 'landed'. */
    const landCode = async (actions: AppAction[]): Promise<string> => {
      const r = await rig.h.land('desk', specWith([], actions));
      if (r.status === 200) return 'landed';
      return String((r.body as { findings?: Array<{ code: string }> }).findings?.[0]?.code ?? r.body.code);
    };
    /** A fresh action id (grants are keyed by it). */
    const id = (): string => `a${++n}`;
    /** Land, grant and prepare one action; answers the record id. */
    const ready = async (action: AppAction, params: Record<string, unknown>): Promise<string> => {
      const landed = await rig.h.land('desk', specWith([], [action]));
      expect(landed.status, JSON.stringify(landed.body)).toBe(200);
      const version = (landed.body as { app: AppDetail }).app.head.version;
      const g = await rig.h.call('POST', `/apps/desk/actions/${action.id}/grant`, { version });
      expect(g.status, JSON.stringify(g.body)).toBe(200);
      const p = await rig.h.call('POST', `/apps/desk/actions/${action.id}/prepare`, { version, params });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      return (p.body as unknown as AppActionPrepareResponse).record;
    };
    const run = (action: AppAction, record: string) => rig.h.call('POST', `/apps/desk/actions/${action.id}/run`, { record });
    /** Run `fn` as the superuser in a transaction that is always rolled back; answers what `fn` answered. */
    const rolledBack = async <T>(fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>): Promise<T> => {
      const ROLLBACK = new Error('rollback');
      let out: T | undefined;
      await db.admin
        .begin(async (tx) => {
          out = await fn(tx as never);
          throw ROLLBACK;
        })
        .catch((err: unknown) => {
          if (err !== ROLLBACK) throw err;
        });
      return out as T;
    };
    const count = async (tx: postgres.TransactionSql<Record<string, never>>, sql: string): Promise<number> => Number((await tx.unsafe<Array<{ n: string }>>(sql))[0]?.n ?? '0');
    /** DDL from another session that must wait behind the write's lock: answers the error it ended with. */
    const blocked = async (ddl: string): Promise<string> => {
      try {
        await db.admin.begin(async (tx) => {
          await tx.unsafe("SET LOCAL lock_timeout = '400ms'");
          await tx.unsafe(ddl);
          throw new Error('ran');
        });
        return 'ran';
      } catch (err) {
        return (err as { code?: string }).code === '55P03' ? 'lock_timeout' : (err as Error).message;
      }
    };

    beforeAll(async () => {
      db = await freshPgDatabase(target);
      rig = await writeRig(db, ['writer', 'repl']);
      await db.admin.unsafe('TRUNCATE s.side'); // the seed's own inserts ran some of its functions
    }, 90_000);
    afterAll(async () => {
      await rig?.h.close();
      await db?.drop();
    });
    afterEach(async () => {
      delete rig.h.hooks.beforeBegin;
      delete rig.h.hooks.afterLock;
      delete rig.h.hooks.afterCheck;
      await db.admin.unsafe('TRUNCATE s.side');
    });

    it('P1: the safety check per table: refuses the unsafe ones by their reason, accepts the plain one and a default-only one', async () => {
      const refused: Array<[string, string]> = [
        ['plain', 'cascading_key'],
        ['trig', 'user_trigger'],
        ['ruled', 'rule'],
        ['parent', 'inheritance_parent'],
        ['child', 'inheritance_child'],
        ['parted', 'partitioned'],
        ['parted_1', 'partition'],
        ['rls', 'row_security'],
        ['checked', 'check_expression'],
        ['domained', 'column_type'],
        ['v', 'not_a_table'],
      ];
      for (const [t, code] of refused) expect(await codes(t), t).toContain(code);
      expect((await safety('w')).safe).toBe(true);
      expect((await safety('defaulted')).safe).toBe(true);
      // An enum column is writable; a domain column is not.
      expect(await codes('enumd', { op: 'update', set: ['prio'], key: ['id'] })).toEqual([]);
      expect(await codes('domained', { op: 'update', set: ['owner'], key: ['id'] })).toContain('column_type');
    });

    it('P2, P22: the writer with table-level SELECT and UPDATE takes the lock, writes, and the database verifies the row', async () => {
      const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'p2' } });
      const r = await run(a, await ready(a, { id: 4821 }));
      expect(r.body).toMatchObject({ state: 'succeeded' });
      expect((await db.admin.unsafe<Array<{ o: string }>>('SELECT owner AS o FROM s.tickets WHERE id = 4821'))[0]?.o).toBe('p2');
    });

    it('P3: a key that is not there returns 0 rows: failed, "no such row", nothing written', async () => {
      const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'p3' } });
      const r = await run(a, await ready(a, { id: 999 }));
      expect(r.body).toMatchObject({ state: 'failed' });
      expect(String(r.body.reason)).toContain('no such row');
    });

    it('P4: a BEFORE trigger changes the value (the flag says false) and writes elsewhere; the rollback undoes both; s.trig cannot land', async () => {
      expect(await landCode([updateAction(id(), 'writer', 's.trig', { owner: { kind: 'literal', value: 'x' } })])).toBe('user_trigger');
      await db.admin.unsafe("INSERT INTO s.trig VALUES (1, 'a', 'low', 1) ON CONFLICT DO NOTHING");
      const r = await rolledBack(async (tx) => ({
        ok: (await tx.unsafe<Array<{ ok: boolean }>>("UPDATE ONLY s.trig SET owner = 'priya' WHERE id = 1 RETURNING (owner IS NOT DISTINCT FROM 'priya'::text) AS ok"))[0]?.ok,
        side: await count(tx, 'SELECT count(*)::text AS n FROM s.side'),
      }));
      expect(r).toEqual({ ok: false, side: 1 });
      expect(await side()).toBe(0); // the rollback undid the trigger's side write
    });

    it('P5: with row security an UPDATE matches 0 rows silently for a non-owner; s.rls cannot land', async () => {
      expect(await landCode([updateAction(id(), 'writer', 's.rls', { owner: { kind: 'literal', value: 'x' } })])).toBe('row_security');
      await db.admin.unsafe("INSERT INTO s.rls VALUES (1, 'a', 'low', 1) ON CONFLICT DO NOTHING; GRANT SELECT, UPDATE ON s.rls TO apps_k2b_writer");
      const w = as('apps_k2b_writer', 'apps-k2b-writer');
      try {
        expect(await w.unsafe("UPDATE ONLY s.rls SET owner = 'w' WHERE id = 1 RETURNING id")).toHaveLength(0);
      } finally {
        await w.end();
      }
    });

    it('P6: a DO ALSO rule writes another table while the UPDATE reports 1 row; s.ruled cannot land', async () => {
      expect(await landCode([updateAction(id(), 'writer', 's.ruled', { owner: { kind: 'literal', value: 'x' } })])).toBe('rule');
      // (s.ruled holds row 1 from the seed; an INSERT … ON CONFLICT cannot run on a table with rules.)
      const r = await rolledBack(async (tx) => ({ rows: (await tx.unsafe("UPDATE ONLY s.ruled SET owner = 'z' WHERE id = 1 RETURNING id")).length, side: await count(tx, 'SELECT count(*)::text AS n FROM s.side') }));
      expect(r).toEqual({ rows: 1, side: 1 });
    });

    it('P7: a plain UPDATE on an inheritance parent hits the child too, ONLY hits one; the generated statement says ONLY; s.parent cannot land', async () => {
      expect(await landCode([updateAction(id(), 'writer', 's.parent', { owner: { kind: 'literal', value: 'x' } })])).toBe('inheritance_parent');
      await db.admin.unsafe("INSERT INTO s.parent VALUES (1, 'a') ON CONFLICT DO NOTHING; INSERT INTO s.child VALUES (1, 'a')");
      const r = await rolledBack(async (tx) => ({
        plain: (await tx.unsafe("UPDATE s.parent SET owner = 'z' WHERE id = 1 RETURNING id")).length,
        only: (await tx.unsafe("UPDATE ONLY s.parent SET owner = 'z' WHERE id = 1 RETURNING id")).length,
      }));
      expect(r).toEqual({ plain: 2, only: 1 });
      const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'x' } });
      await rig.h.land('desk', specWith([], [a]));
      const v = (await rig.h.store.detail('desk')).head.version;
      await rig.h.call('POST', `/apps/desk/actions/${a.id}/grant`, { version: v });
      const p = await rig.h.call('POST', `/apps/desk/actions/${a.id}/prepare`, { version: v, params: { id: 4822 } });
      expect((p.body as unknown as AppActionPrepareResponse).card).toMatchObject({ statement: expect.stringContaining('UPDATE ONLY "s"."tickets"') });
    });

    it('P8: deleting a row with an ON DELETE CASCADE child also deletes the child; s.plain cannot land', async () => {
      const del: AppAction = { id: id(), kind: 'row-write', source: 'writer', table: 's.plain', op: 'delete', key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } };
      expect(await landCode([del])).toBe('cascading_key');
      await db.admin.unsafe('INSERT INTO s.kids VALUES (10, 1) ON CONFLICT DO NOTHING');
      const kids = await rolledBack(async (tx) => {
        await tx.unsafe('DELETE FROM ONLY s.plain WHERE id = 1');
        return count(tx, 'SELECT count(*)::text AS n FROM s.kids');
      });
      expect(kids).toBe(0);
    });

    it('P9: while the write holds its lock, CREATE TRIGGER, CREATE RULE and ENABLE ROW LEVEL SECURITY wait (and time out)', async () => {
      const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'p9' } });
      const record = await ready(a, { id: 4822 });
      const seen: string[] = [];
      rig.h.hooks.afterCheck = async () => {
        seen.push(await blocked('CREATE TRIGGER t9 BEFORE UPDATE ON s.tickets FOR EACH ROW EXECUTE FUNCTION s.bump()'));
        seen.push(await blocked("CREATE RULE r9 AS ON UPDATE TO s.tickets DO ALSO INSERT INTO s.side VALUES ('r9')"));
        seen.push(await blocked('ALTER TABLE s.tickets ENABLE ROW LEVEL SECURITY'));
      };
      expect((await run(a, record)).body).toMatchObject({ state: 'succeeded' });
      expect(seen).toEqual(['lock_timeout', 'lock_timeout', 'lock_timeout']);
      expect((await db.admin.unsafe<Array<{ r: boolean }>>("SELECT relrowsecurity AS r FROM pg_class WHERE oid = 's.tickets'::regclass"))[0]?.r).toBe(false);
    });

    it('P10, P23: a trigger (also one that removes itself) added between prepare and run is found under the lock; nothing is written', async () => {
      for (const fn of ['s.bump()', 's.selfdrop()']) {
        const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'late' } });
        const record = await ready(a, { id: 4823 });
        const name = fn === 's.bump()' ? 'late10' : 'late';
        // Added after every recheck, just before the write's transaction: only the check under the lock can see it.
        rig.h.hooks.beforeBegin = async () => {
          await db.admin.unsafe(`CREATE TRIGGER ${name} BEFORE UPDATE ON s.tickets FOR EACH ROW EXECUTE FUNCTION ${fn}`);
        };
        try {
          const r = await run(a, record);
          expect(r.body, fn).toMatchObject({ state: 'failed' });
          expect(String(r.body.reason)).toMatch(/fingerprint|safety check/);
          expect((await db.admin.unsafe<Array<{ o: string }>>('SELECT owner AS o FROM s.tickets WHERE id = 4823'))[0]?.o).not.toBe('late');
          expect(await side()).toBe(0);
        } finally {
          delete rig.h.hooks.beforeBegin;
          await db.admin.unsafe(`DROP TRIGGER IF EXISTS ${name} ON s.tickets`);
        }
      }
    });

    it('P11: a login with column-level UPDATE only cannot LOCK the table; granting its write names the missing GRANT', async () => {
      const w = as('apps_k2b_colwriter', 'apps-k2b-colwriter');
      try {
        await expect(w.begin((tx) => tx.unsafe('LOCK TABLE ONLY s.tickets IN ROW EXCLUSIVE MODE'))).rejects.toMatchObject({ code: '42501' });
      } finally {
        await w.end();
      }
    });

    it('P12, P13: a default through a user operator is accepted (no insert lets it run); a generated column and a disabled trigger are refused', async () => {
      expect((await safety('opdef', { op: 'insert', set: ['id', 'owner'], key: ['id'] })).safe).toBe(true);
      expect(await codes('gen')).toContain('generated_column');
      expect(await codes('dis')).toContain('user_trigger');
    });

    it('P14-P19: an expression index, a partial index, a domain key, a CHECK casting to a domain, a disabled internal trigger are refused; a side-effecting default is accepted', async () => {
      expect(await codes('idx')).toContain('index_expression');
      expect(await codes('pidx')).toContain('index_partial');
      expect(await codes('dkey')).toContain('column_type');
      expect(await codes('ccast')).toContain('check_expression');
      expect(await codes('bicheck')).toContain('check_expression');
      expect(await codes('par')).toContain('internal_trigger_disabled');
      expect((await safety('catdef', { op: 'insert', set: ['id', 'owner', 'n'], key: ['id'] })).safe).toBe(false); // n is oid: not a writable type
      expect((await safety('catdef')).safe).toBe(true); // P18: the table itself passes; P35 shows the default never runs
      // P14, P15 as Postgres: the UPDATE reports 1 row and a true flag while the function wrote a side row.
      await db.admin.unsafe("INSERT INTO s.idx VALUES (1, 'a') ON CONFLICT DO NOTHING");
      await db.admin.unsafe('TRUNCATE s.side');
      const r = await rolledBack(async (tx) => ({
        ok: (await tx.unsafe<Array<{ ok: boolean }>>("UPDATE ONLY s.idx SET owner = 'b' WHERE id = 1 RETURNING (owner IS NOT DISTINCT FROM 'b'::text) AS ok"))[0]?.ok,
        side: await count(tx, 'SELECT count(*)::text AS n FROM s.side'),
      }));
      expect(r.ok).toBe(true);
      expect(r.side).toBeGreaterThan(0);
    });

    it('P20: numeric rounds silently on assignment, and only a base-type flag catches it; the exact-fit check refuses the value before any card', async () => {
      await db.admin.unsafe('INSERT INTO s.money VALUES (1, 1.00, \'abc\', 1) ON CONFLICT DO NOTHING');
      const row = await rolledBack(async (tx) =>
        (
          await tx.unsafe<Array<{ amount: string; ok_base: boolean; ok_typmod: boolean }>>(
            "UPDATE ONLY s.money SET amount = '1.234'::numeric WHERE id = 1 RETURNING amount::text, (amount IS NOT DISTINCT FROM '1.234'::numeric) AS ok_base, (amount IS NOT DISTINCT FROM '1.234'::numeric(10,2)) AS ok_typmod",
          )
        )[0],
      );
      expect(row).toEqual({ amount: '1.23', ok_base: false, ok_typmod: true });
      const misfit = await pgReadOnly(args(), (tx) => pgExactFitIn(tx, [{ column: 'amount', full: 'numeric(10,2)', base: '"pg_catalog"."numeric"', text: '1.234' }]));
      expect(misfit).toHaveLength(1);
    });

    it('P21: printed with search_path = pg_catalog, a CHECK names the domain it casts to (the reason says so)', async () => {
      const r = await safety('ccast');
      expect(r.reasons.find((x) => x.code === 'check_expression')?.detail).toContain('dtext');
    });

    it('P24: a self-removing trigger is gone if the check ran only after the statement (why the check runs first, under the lock)', async () => {
      const after = await rolledBack(async (tx) => {
        await tx.unsafe("UPDATE ONLY s.t SET owner = 'x' WHERE id = 1");
        return count(tx, "SELECT count(*)::text AS n FROM pg_catalog.pg_trigger WHERE tgrelid = 's.t'::regclass AND NOT tgisinternal");
      });
      expect(after).toBe(0);
      expect(await codes('t')).toContain('user_trigger'); // seen when checked first
    });

    it('P25: a temporary table named pg_trigger does not hide a trigger from the check', async () => {
      const w = as('apps_k2b_writer', 'apps-k2b-writer');
      try {
        await w.unsafe('CREATE TEMP TABLE pg_trigger (tgrelid oid, tgisinternal bool)');
        const r = await w.begin((tx) => pgTableSafetyIn(tx as never, 's', 'trig'));
        expect(r.reasons.map((x) => x.code)).toContain('user_trigger');
      } finally {
        await w.end();
      }
    });

    it('P26: a login whose session_replication_role defaults to replica is refused at run, nothing written', async () => {
      const w = as('apps_k2b_repl', 'apps-k2b-repl');
      try {
        expect((await w.unsafe<Array<{ r: string }>>("SELECT current_setting('session_replication_role') AS r"))[0]?.r).toBe('replica');
      } finally {
        await w.end();
      }
      const a = updateAction(id(), 'repl', 's.tickets', { owner: { kind: 'literal', value: 'p26' } });
      const r = await run(a, await ready(a, { id: 4821 }));
      expect(r.body).toMatchObject({ state: 'failed' });
      expect(String(r.body.reason)).toContain('session_replication_role');
    });

    it('P27: SET CONSTRAINTS ALL IMMEDIATE makes a deferred foreign key fire at the statement; inserting into a table with a foreign key cannot land', async () => {
      const w = as('apps_k2b_writer', 'apps-k2b-writer');
      try {
        await expect(w.begin(async (tx) => {
          await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.unsafe('INSERT INTO s.dkid VALUES (11, 998)');
        })).rejects.toMatchObject({ code: '23503' });
      } finally {
        await w.end();
      }
      const ins: AppAction = { id: id(), kind: 'row-write', source: 'writer', table: 's.dkid', op: 'insert', set: { id: { kind: 'param', name: 'id' }, par_id: { kind: 'literal', value: 1 } }, key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } };
      expect(await landCode([ins])).toBe('fk_enforcement');
    });

    it('P28: a value the column type would round or truncate is detected (and 1.2 fits numeric(3,1))', async () => {
      const fit = await pgReadOnly(args(), (tx) =>
        pgExactFitIn(tx, [
          { column: 'a', full: 'numeric(3,1)', base: '"pg_catalog"."numeric"', text: '1.24' },
          { column: 'b', full: 'character varying(3)', base: '"pg_catalog"."varchar"', text: 'abcd' },
          { column: 'c', full: 'numeric(3,1)', base: '"pg_catalog"."numeric"', text: '1.2' },
        ]),
      );
      expect(fit.map((m) => m.column)).toEqual(['a', 'b']);
    });

    it('P29, P33, P34: operations that would run foreign-key enforcement cannot land; P32 (a column outside every key) lands and runs no enforcement', async () => {
      const params = { type: 'object' as const, properties: { id: { type: 'integer' as const } }, required: ['id'] };
      const ins: AppAction = { id: id(), kind: 'row-write', source: 'writer', table: 's.t6', op: 'insert', set: { id: { kind: 'param', name: 'id' }, par_id: { kind: 'literal', value: 1 }, owner: { kind: 'literal', value: 'x' } }, key: { id: { kind: 'param', name: 'id' } }, params };
      expect(await landCode([ins])).toBe('fk_enforcement'); // P29
      expect(await landCode([updateAction(id(), 'writer', 's.t6', { par_id: { kind: 'literal', value: 2 } })])).toBe('fk_enforcement'); // P33
      const del: AppAction = { id: id(), kind: 'row-write', source: 'writer', table: 's.t2', op: 'delete', key: { id: { kind: 'param', name: 'id' } }, params };
      expect(await landCode([del])).toBe('fk_enforcement'); // P34
      const a = updateAction(id(), 'writer', 's.t6', { owner: { kind: 'literal', value: 'p32' } });
      expect((await run(a, await ready(a, { id: 1 }))).body).toMatchObject({ state: 'succeeded' });
      expect(await side()).toBe(0); // the referenced table's index predicate never ran
    });

    it('P30: a schema swap between the check and the statement sends it to another table; the row type differs, it rolls back, no side write remains', async () => {
      await db.admin.unsafe(`
        CREATE SCHEMA support; CREATE SCHEMA replacement;
        CREATE TABLE support.tickets (id int PRIMARY KEY, owner text); INSERT INTO support.tickets VALUES (1, 'a');
        CREATE TABLE replacement.tickets (id int PRIMARY KEY, owner text); INSERT INTO replacement.tickets VALUES (1, 'a');
        CREATE FUNCTION replacement.tf() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $t$ BEGIN INSERT INTO s.side VALUES ('replacement trigger ran'); RETURN NEW; END $t$;
        CREATE TRIGGER t BEFORE UPDATE ON replacement.tickets FOR EACH ROW EXECUTE FUNCTION replacement.tf();
        GRANT USAGE ON SCHEMA support, replacement TO apps_k2b_writer;
        GRANT SELECT, UPDATE ON support.tickets, replacement.tickets TO apps_k2b_writer`);
      try {
        const a = updateAction(id(), 'writer', 'support.tickets', { owner: { kind: 'literal', value: 'x' } });
        const record = await ready(a, { id: 1 });
        rig.h.hooks.afterCheck = async () => {
          await db.admin.unsafe('ALTER SCHEMA support RENAME TO support_old; ALTER SCHEMA replacement RENAME TO support');
        };
        const r = await run(a, record);
        expect(r.body).toMatchObject({ state: 'failed' });
        expect(String(r.body.reason)).toContain('row type');
        expect(await side()).toBe(0);
        expect((await db.admin.unsafe<Array<{ o: string }>>('SELECT owner AS o FROM support_old.tickets WHERE id = 1'))[0]?.o).toBe('a');
        expect((await db.admin.unsafe<Array<{ o: string }>>('SELECT owner AS o FROM support.tickets WHERE id = 1'))[0]?.o).toBe('a');
      } finally {
        await db.admin.unsafe('DROP SCHEMA IF EXISTS support CASCADE; DROP SCHEMA IF EXISTS support_old CASCADE; DROP SCHEMA IF EXISTS replacement CASCADE');
      }
    });

    it('P31: real 16777217 does not survive while every real comparison says it does; a floating-point column cannot be written', async () => {
      const [row] = await db.admin.unsafe<Array<{ stored: string; same: boolean; exact: boolean }>>(
        "SELECT ('16777217'::real)::text AS stored, ('16777217'::real = '16777217'::real) AS same, ('16777217'::numeric = ('16777217'::real)::numeric) AS exact",
      );
      expect(row?.same).toBe(true);
      expect(row?.exact).toBe(false);
      expect(await landCode([updateAction(id(), 'writer', 's.money', { ratio: { kind: 'literal', value: 16777217 } })])).toBe('written_type');
    });

    it('P35: an insert supplying every column does not run a side-effecting default (and one that omits it would)', async () => {
      const before = Number((await db.admin.unsafe<Array<{ n: string }>>('SELECT count(*)::text AS n FROM pg_largeobject_metadata'))[0]?.n);
      // s.catdef's default calls lo_from_bytea; its column n is an oid (not writable), so the product write uses
      // a text column with the same kind of default.
      await db.admin.unsafe("CREATE TABLE s.catdef3 (id int PRIMARY KEY, owner text DEFAULT (pg_catalog.lo_from_bytea(0, 'x'::bytea))::text); GRANT SELECT, INSERT, UPDATE ON s.catdef3 TO apps_k2b_writer");
      try {
        const ins: AppAction = { id: id(), kind: 'row-write', source: 'writer', table: 's.catdef3', op: 'insert', set: { id: { kind: 'param', name: 'id' }, owner: { kind: 'literal', value: 'supplied' } }, key: { id: { kind: 'param', name: 'id' } }, params: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } };
        expect((await run(ins, await ready(ins, { id: 1 }))).body).toMatchObject({ state: 'succeeded' });
        expect(Number((await db.admin.unsafe<Array<{ n: string }>>('SELECT count(*)::text AS n FROM pg_largeobject_metadata'))[0]?.n)).toBe(before);
        const omitted = await rolledBack(async (tx) => {
          await tx.unsafe('INSERT INTO s.catdef3 (id) VALUES (2)');
          return count(tx, 'SELECT count(*)::text AS n FROM pg_largeobject_metadata');
        });
        expect(omitted).toBe(before + 1);
      } finally {
        await db.admin.unsafe('DROP TABLE s.catdef3');
      }
    });

    it('P36: RETURNING the row (its type) needs table-level SELECT: column-level SELECT is refused', async () => {
      const w = as('apps_k2b_colwriter', 'apps-k2b-colwriter');
      try {
        await expect(w.begin((tx) => tx.unsafe("UPDATE ONLY s.tickets AS w SET owner = 'x' WHERE w.id = 4821 RETURNING pg_catalog.pg_typeof(w.*)"))).rejects.toMatchObject({ code: '42501' });
      } finally {
        await w.end();
      }
    });

    it('P37: a CHECK printing as (status)::text runs a user-defined enum cast: the table cannot land while the cast exists', async () => {
      await db.admin.unsafe(`
        CREATE TYPE s.st AS ENUM ('open', 'closed');
        CREATE FUNCTION s.st_text(s.st) RETURNS text LANGUAGE plpgsql VOLATILE AS $f$ BEGIN INSERT INTO s.side VALUES ('enum cast ran'); RETURN enum_out($1)::text; END $f$;
        CREATE CAST (s.st AS text) WITH FUNCTION s.st_text(s.st);
        CREATE TABLE s.e (id int PRIMARY KEY, status s.st, body text, CHECK ((status)::text <> ''));
        INSERT INTO s.e VALUES (1, 'open', 'x');`);
      try {
        expect(await codes('e', { op: 'update', set: ['body'], key: ['id'] })).toEqual(expect.arrayContaining(['user_cast']));
        await db.admin.unsafe('TRUNCATE s.side');
        const ran = await rolledBack(async (tx) => {
          await tx.unsafe("UPDATE ONLY s.e SET body = 'y' WHERE id = 1");
          return count(tx, 'SELECT count(*)::text AS n FROM s.side');
        });
        expect(ran).toBe(1);
      } finally {
        await db.admin.unsafe('DROP TABLE s.e; DROP CAST (s.st AS text); DROP FUNCTION s.st_text(s.st); DROP TYPE s.st');
      }
    });

    it('P38: a view swapped in under the table name forges tableoid, but not its row type; the write rolls back, no side write remains', async () => {
      await db.admin.unsafe(`
        CREATE SCHEMA support; CREATE TABLE support.tickets (id int PRIMARY KEY, owner text); INSERT INTO support.tickets VALUES (4821, 'nobody');
        GRANT USAGE ON SCHEMA support TO apps_k2b_writer; GRANT SELECT, UPDATE ON support.tickets TO apps_k2b_writer`);
      const oid = (await db.admin.unsafe<Array<{ o: string }>>("SELECT 'support.tickets'::regclass::oid::text AS o"))[0]!.o;
      await db.admin.unsafe(`
        CREATE SCHEMA replacement;
        CREATE VIEW replacement.tickets AS SELECT ${oid}::oid AS tableoid, 4821 AS id, 'nobody'::text AS owner;
        CREATE FUNCTION replacement.io() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $t$ BEGIN INSERT INTO s.side VALUES ('view trigger ran'); RETURN NEW; END $t$;
        CREATE TRIGGER io INSTEAD OF UPDATE ON replacement.tickets FOR EACH ROW EXECUTE FUNCTION replacement.io();
        GRANT USAGE ON SCHEMA replacement TO apps_k2b_writer; GRANT SELECT, UPDATE ON replacement.tickets TO apps_k2b_writer`);
      try {
        const a = updateAction(id(), 'writer', 'support.tickets', { owner: { kind: 'literal', value: 'priya' } });
        const record = await ready(a, { id: 4821 });
        rig.h.hooks.afterCheck = async () => {
          await db.admin.unsafe('ALTER SCHEMA support RENAME TO support_old; ALTER SCHEMA replacement RENAME TO support');
        };
        const r = await run(a, record);
        expect(r.body).toMatchObject({ state: 'failed' });
        expect(String(r.body.reason)).toContain('row type');
        expect(await side()).toBe(0);
        expect((await db.admin.unsafe<Array<{ o: string }>>('SELECT owner AS o FROM support_old.tickets'))[0]?.o).toBe('nobody');
      } finally {
        await db.admin.unsafe('DROP SCHEMA IF EXISTS support CASCADE; DROP SCHEMA IF EXISTS support_old CASCADE; DROP SCHEMA IF EXISTS replacement CASCADE');
      }
    });

    it('P39: a foreign key comparing with a custom equality operator runs it even on an update of another column; the table cannot land', async () => {
      expect(await landCode([updateAction(id(), 'writer', 's.tickets9', { owner: { kind: 'literal', value: 'x' } })])).toBe('fk_operator');
      await db.admin.unsafe("INSERT INTO s.tickets9 VALUES (4821, 1, 'nobody') ON CONFLICT DO NOTHING");
      await db.admin.unsafe('TRUNCATE s.side');
      const ran = await rolledBack(async (tx) => {
        await tx.unsafe("UPDATE ONLY s.tickets9 SET owner = 'priya' WHERE id = 4821");
        return count(tx, 'SELECT count(*)::text AS n FROM s.side');
      });
      expect(ran).toBeGreaterThan(0);
    });

    it('P40: an UPDATE planned against expression statistics runs the expression; the table cannot land', async () => {
      expect(await landCode([updateAction(id(), 'writer', 's.tickets10', { owner: { kind: 'literal', value: 'x' } })])).toBe('statistics_expression');
      await db.admin.unsafe("INSERT INTO s.tickets10 SELECT g, 'o' || g FROM generate_series(1, 100) g ON CONFLICT DO NOTHING; ANALYZE s.tickets10; TRUNCATE s.side");
      const ran = await rolledBack(async (tx) => {
        await tx.unsafe("UPDATE ONLY s.tickets10 AS w SET owner = 'priya' WHERE w.id = 7");
        return count(tx, 'SELECT count(*)::text AS n FROM s.side');
      });
      expect(ran).toBeGreaterThan(0);
    });

    it('P41: CREATE STATISTICS gets past ROW EXCLUSIVE but waits behind the write’s SHARE ROW EXCLUSIVE', async () => {
      const w = as('apps_k2b_writer', 'apps-k2b-writer');
      try {
        let created = '';
        await w.begin(async (tx) => {
          await tx.unsafe('LOCK TABLE ONLY s.tickets IN ROW EXCLUSIVE MODE');
          created = await blocked('CREATE STATISTICS s.st41 ON id, owner FROM s.tickets');
          throw new Error('rollback');
        }).catch(() => undefined);
        expect(created).toBe('ran');
      } finally {
        await w.end();
      }
      const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'p41' } });
      const record = await ready(a, { id: 4821 });
      let seen = '';
      rig.h.hooks.afterCheck = async () => {
        seen = await blocked('CREATE STATISTICS s.st41b ON id, owner FROM s.tickets');
      };
      expect((await run(a, record)).body).toMatchObject({ state: 'succeeded' });
      expect(seen).toBe('lock_timeout');
    });

    it('P42: an insert-only login cannot take SHARE ROW EXCLUSIVE', async () => {
      const w = as('apps_k2b_inserter', 'apps-k2b-inserter');
      try {
        await expect(w.begin((tx) => tx.unsafe('LOCK TABLE ONLY s.notes IN SHARE ROW EXCLUSIVE MODE'))).rejects.toMatchObject({ code: '42501' });
      } finally {
        await w.end();
      }
    });

    it('P43: pg_typeof("w".*) is the table row type on a three-column table; a view with a column named w of that type fools only the bare alias', async () => {
      const a = updateAction(id(), 'writer', 's.tickets', { owner: { kind: 'literal', value: 'p43' } }); // three columns: id, owner, region
      expect((await run(a, await ready(a, { id: 4822 }))).body).toMatchObject({ state: 'succeeded' });
      await db.admin.unsafe(`
        CREATE SCHEMA support; CREATE TABLE support.tickets (id int PRIMARY KEY, owner text, region text); INSERT INTO support.tickets VALUES (4821, 'nobody', 'EMEA');
        GRANT USAGE ON SCHEMA support TO apps_k2b_writer; GRANT SELECT, UPDATE ON support.tickets TO apps_k2b_writer;
        CREATE SCHEMA replacement;
        CREATE VIEW replacement.tickets AS SELECT 4821 AS id, 'nobody'::text AS owner, null::support.tickets AS w;
        CREATE FUNCTION replacement.io() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $t$ BEGIN INSERT INTO s.side VALUES ('view trigger ran'); RETURN NEW; END $t$;
        CREATE TRIGGER io INSTEAD OF UPDATE ON replacement.tickets FOR EACH ROW EXECUTE FUNCTION replacement.io();
        GRANT USAGE ON SCHEMA replacement TO apps_k2b_writer; GRANT SELECT, UPDATE ON replacement.tickets TO apps_k2b_writer`);
      try {
        const rt = (await db.admin.unsafe<Array<{ t: string }>>("SELECT reltype::text AS t FROM pg_class WHERE oid = 'support.tickets'::regclass"))[0]!.t;
        const b = updateAction(id(), 'writer', 'support.tickets', { owner: { kind: 'literal', value: 'priya' } });
        const record = await ready(b, { id: 4821 });
        rig.h.hooks.afterCheck = async () => {
          await db.admin.unsafe('ALTER SCHEMA support RENAME TO support_old; ALTER SCHEMA replacement RENAME TO support');
        };
        const r = await run(b, record);
        expect(r.body).toMatchObject({ state: 'failed' });
        expect(await side(), `${await sideNotes()} ${JSON.stringify(r.body)}`).toBe(0);
        // The raw form of the same statement: the starred form is not fooled, the bare alias is.
        const row = await rolledBack(async (tx) =>
          (
            await tx.unsafe<Array<{ star: boolean; bare: boolean }>>(
              `UPDATE ONLY support.tickets AS "w" SET owner = 'priya' WHERE "w".id = 4821 RETURNING pg_catalog.pg_typeof("w".*)::oid = ${rt}::oid AS star, pg_catalog.pg_typeof("w")::oid = ${rt}::oid AS bare`,
            )
          )[0],
        );
        expect(row).toEqual({ star: false, bare: true });
      } finally {
        await db.admin.unsafe('DROP SCHEMA IF EXISTS support CASCADE; DROP SCHEMA IF EXISTS support_old CASCADE; DROP SCHEMA IF EXISTS replacement CASCADE');
      }
    });

    // ── The Postgres merge gate (2026-11-03): each confirmed finding becomes a probe here. ──

    it('P44 (gate, confirmed): with CREATE on pg_catalog, an exact-type pg_typeof overload would run in the write; such a pg_catalog refuses row writes', async () => {
      await db.admin.unsafe(`
        DO $$ BEGIN CREATE ROLE apps_k2b_g44 LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        CREATE SCHEMA g44 AUTHORIZATION apps_k2b_g44; GRANT CREATE ON SCHEMA pg_catalog TO apps_k2b_g44;
        SET ROLE apps_k2b_g44;
        CREATE TABLE g44.side (note text);
        CREATE TABLE g44.t (id int PRIMARY KEY, owner text); INSERT INTO g44.t VALUES (1, 'a');
        CREATE FUNCTION pg_catalog.pg_typeof(g44.t) RETURNS pg_catalog.regtype LANGUAGE plpgsql VOLATILE AS $f$ BEGIN INSERT INTO g44.side VALUES ('overload ran'); RETURN 'g44.t'::pg_catalog.regtype; END $f$;
        RESET ROLE;
        GRANT USAGE ON SCHEMA g44 TO apps_k2b_writer; GRANT SELECT, UPDATE ON g44.t TO apps_k2b_writer; GRANT INSERT ON g44.side TO apps_k2b_writer`);
      try {
        // As Postgres: the overload wins over the built-in polymorphic one, and the row-type check still passes.
        const raw = await rolledBack(async (tx) => {
          await tx.unsafe('SET LOCAL search_path = pg_catalog, pg_temp');
          const [row] = await tx.unsafe<Array<{ ok: boolean }>>(
            `UPDATE ONLY "g44"."t" AS "w" SET "owner" = 'x'::"pg_catalog"."text" WHERE "w"."id" = 1::"pg_catalog"."int4"
               RETURNING pg_catalog.pg_typeof("w".*)::pg_catalog.oid = (SELECT c.reltype FROM pg_catalog.pg_class c WHERE c.oid = 'g44.t'::pg_catalog.regclass) AS ok`,
          );
          return { ok: row?.ok, side: await count(tx, 'SELECT count(*)::text AS n FROM g44.side') };
        });
        expect(raw).toEqual({ ok: true, side: 1 });
        // The product: the role that can create in pg_catalog, and the object it left there, each refuse the table.
        const reasons = (await pgTableSafety(args('apps_reader', 'apps-reader'), 'g44', 't', { op: 'update', set: ['owner'], key: ['id'] })).reasons.map((r) => r.code);
        expect(reasons).toEqual(expect.arrayContaining(['catalog_create', 'catalog_object']));
        expect(await landCode([updateAction(id(), 'writer', 'g44.t', { owner: { kind: 'literal', value: 'x' } })])).toMatch(/^catalog_(create|object)$/);
        // codex r4: an exact-type overload of a function the check itself uses cannot quiet it (the guard runs first,
        // with no overloadable call, and refuses at once).
        await db.admin.unsafe("SET ROLE apps_k2b_g44; CREATE FUNCTION pg_catalog.array_to_json(text[]) RETURNS pg_catalog.json LANGUAGE sql AS $f$ SELECT '[]'::pg_catalog.json $f$; RESET ROLE");
        await db.admin.unsafe('REVOKE CREATE ON SCHEMA pg_catalog FROM apps_k2b_g44');
        const quiet = (await pgTableSafety(args('apps_reader', 'apps-reader'), 'g44', 't', { op: 'update', set: ['owner'], key: ['id'] })).reasons.map((r) => r.detail);
        expect(quiet.join(' ')).toContain('array_to_json');
        await db.admin.unsafe('DROP FUNCTION pg_catalog.array_to_json(text[])');
      } finally {
        await db.admin.unsafe(`DROP FUNCTION IF EXISTS pg_catalog.array_to_json(text[]); DROP FUNCTION IF EXISTS pg_catalog.pg_typeof(g44.t); REVOKE CREATE ON SCHEMA pg_catalog FROM apps_k2b_g44; DROP SCHEMA g44 CASCADE; DROP ROLE apps_k2b_g44`);
      }
      expect((await safety('w')).safe).toBe(true); // pg_catalog as initdb left it again
    });

    it('P45 (gate, not reproduced): an enum renamed away and a domain over it taking its name between the check and the statement: the statement fails to resolve, nothing runs or is written', async () => {
      await db.admin.unsafe(`
        CREATE TYPE s.g45 AS ENUM ('low', 'high');
        CREATE TABLE s.t45 (id int PRIMARY KEY, st s.g45); INSERT INTO s.t45 VALUES (1, 'low');
        GRANT SELECT, UPDATE ON s.t45 TO apps_k2b_writer;
        CREATE FUNCTION s.chk45(text) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $f$ BEGIN INSERT INTO s.side VALUES ('domain check ran'); RETURN true; END $f$;`);
      try {
        const a = updateAction(id(), 'writer', 's.t45', { st: { kind: 'literal', value: 'high' } });
        const record = await ready(a, { id: 1 });
        rig.h.hooks.afterCheck = async () => {
          await db.admin.unsafe('ALTER TYPE s.g45 RENAME TO g45_old; CREATE DOMAIN s.g45 AS s.g45_old CHECK (s.chk45(VALUE::text))');
        };
        const r = await run(a, record);
        expect(r.body).toMatchObject({ state: 'failed' }); // "operator does not exist: s.g45_old = s.g45": no plan, nothing executed
        expect(await side()).toBe(0);
        expect((await db.admin.unsafe<Array<{ v: string }>>('SELECT st::text AS v FROM s.t45 WHERE id = 1'))[0]?.v).toBe('low');
      } finally {
        await db.admin.unsafe('DROP TABLE IF EXISTS s.t45; DROP DOMAIN IF EXISTS s.g45; DROP TYPE IF EXISTS s.g45_old; DROP TYPE IF EXISTS s.g45; DROP FUNCTION IF EXISTS s.chk45(text)');
      }
    });
  });
}
