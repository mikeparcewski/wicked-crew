// DES-APPS-001 K1 against REAL Postgres 16 and 17 (S3, S10, S11, S17's table check): describe, read,
// the read policy refusing without reaching the source, the 10 s deadline stopping the query AT THE
// SOURCE (pg_stat_activity), the table safety check over the probe tables, and the privilege report.

import { mkdtempSync, rmSync } from 'node:fs';
import { type AddressInfo, createServer as createNetServer, Socket as NetSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { Actor, McpPreviewResponse, McpServer } from '../src/core/types.js';
import { probeMcpServer } from '../src/mcp/probe.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { sqlConnectArgs } from '../src/sources/kinds.js';
import { registerSourceRoutes } from '../src/sources/routes.js';

import { describePg, pgPrivileges } from '../src/sources/catalog/postgres.js';
import { policyCatalog } from '../src/sources/catalog/types.js';
import { pgClient, pgRead } from '../src/sources/drivers/postgres.js';
import type { SqlConnectArgs } from '../src/sources/drivers/types.js';
import { pgTableSafety, pgTableSafetyIn } from '../src/sources/safety/postgres.js';
import { relKey } from '../src/sources/policy/types.js';
import { checkSqlQuery, readSqlQuery, SourcePolicyError, type SqlSourceHandle } from '../src/sources/sql.js';
import { countingResolver, DB_HOST, DB_REQUIRED, type FreshPg, freshPgDatabase, LOOPBACK, PG_TARGETS } from './support/sources-db.js';

if (PG_TARGETS.length === 0) {
  describe('Apps sources on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them; WICKED_SOURCES_DB=required fails here instead of skipping)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`Apps sources on ${target.label}`, () => {
    let db: FreshPg;
    const login = (user: string, password: string, resolver = countingResolver()): SqlConnectArgs => ({
      source: { driver: 'postgres', host: DB_HOST, port: db.port, database: db.database, user, tls: 'disable' },
      password,
      policy: LOOPBACK,
      dial: { resolver },
    });
    beforeAll(async () => {
      db = await freshPgDatabase(target);
    }, 60_000);
    afterAll(async () => {
      await db?.drop();
    });

    it('describes the catalog: structure and declared enum literals, never a row value', async () => {
      const cat = await describePg(login('apps_reader', 'apps-reader'));
      const plain = cat.relations.find((r) => r.schema === 's' && r.name === 'plain');
      expect(plain).toMatchObject({ kind: 'table', primaryKey: ['id'] });
      expect(plain?.columns.map((c) => [c.name, c.type])).toEqual([['id', 'integer'], ['owner', 'text'], ['prio', 's.prio'], ['amount', 'numeric(10,2)']]);
      expect(plain?.columns.find((c) => c.name === 'prio')?.enumValues).toEqual(['low', 'high']);
      expect(cat.relations.find((r) => r.name === 'kids')?.foreignKeys).toEqual([{ name: 'kids_parent_id_fkey', columns: ['parent_id'], references: { schema: 's', table: 'plain', columns: ['id'] } }]);
      expect(cat.relations.find((r) => r.name === 'v')?.kind).toBe('view');
      expect(cat.relations.find((r) => r.name === 'parted')?.kind).toBe('partitioned');
      expect(cat.relations.find((r) => r.name === 'rls')?.rowSecurity).toBe(true);
      // s.w holds the row value 'nobody'; the catalog never carries a value.
      expect(JSON.stringify(cat)).not.toContain('nobody');
    });

    it('reads through the policy: a READ ONLY transaction, parameters bound, a view only when allowed by name', async () => {
      const args = login('apps_reader', 'apps-reader');
      const cat = await describePg(args);
      const h: SqlSourceHandle = { driver: 'postgres', connect: args, catalog: cat, viewsAllowed: [] };
      const r = await readSqlQuery(h, 'SELECT w.id, w.owner FROM s.w AS w WHERE w.id = $1', [4821]);
      expect(r.rows).toEqual([[4821, 'nobody']]);
      expect(r.columns).toEqual([{ name: 'id', type: 'integer' }, { name: 'owner', type: 'text' }]);
      const check = await checkSqlQuery(h, "SELECT date_trunc('day', now()) AS d, count(*)::int8 AS n FROM s.plain WHERE prio = $1::text::s.prio IS NOT NULL OR owner = $1");
      expect(check.ok).toBe(false); // a cast to s.prio is outside pg_catalog
      const ok = await checkSqlQuery(h, 'SELECT count(*)::int8 AS n, max(amount) AS top FROM s.plain WHERE owner = $1');
      expect(ok).toMatchObject({ ok: true, describe: { columns: [{ name: 'n', type: 'bigint' }, { name: 'top', type: 'numeric' }], params: ['text'] }, relations: ['"s"."plain"'] });
      await expect(readSqlQuery(h, 'SELECT id FROM s.v', [])).rejects.toBeInstanceOf(SourcePolicyError);
      const allowed: SqlSourceHandle = { ...h, viewsAllowed: ['s.v'] };
      expect((await readSqlQuery(allowed, 'SELECT id FROM s.v ORDER BY id', [])).rows).toEqual([[1], [2]]);
      // A write inside a read is refused by the source too (defence in depth): READ ONLY.
      const sql = pgClient(args);
      try {
        await expect(sql.begin('read only', (tx) => tx.unsafe("UPDATE s.w SET owner = 'x'"))).rejects.toThrow(/read-only/);
      } finally {
        await sql.end();
      }
    });

    it('S3: the read policy refuses each of these without reaching the source', async () => {
      const resolver = countingResolver();
      const args = login('apps_reader', 'apps-reader', resolver);
      const cat = await describePg(login('apps_reader', 'apps-reader'));
      const h: SqlSourceHandle = { driver: 'postgres', connect: args, catalog: cat, viewsAllowed: [] };
      const refused: Array<[string, string]> = [
        ['DELETE FROM s.w', 'not_select'],
        ['WITH d AS (DELETE FROM s.w RETURNING *) SELECT * FROM d', 'not_select'],
        ["SELECT pg_read_file('/etc/passwd')", 'function'],
        ['SELECT pg_sleep(60)', 'function'],
        ['SELECT 1 OPERATOR(public.##) 2', 'qualified_name'],
        ["SELECT 's.w'::regclass", 'cast'],
        ['SELECT id FROM s.v', 'view'],
        ["SELECT query_to_xml($1, true, false, '')", 'function'],
        ['SELECT * FROM pg_catalog.pg_authid', 'relation'],
        ['SELECT * FROM s.w FOR UPDATE', 'locking'],
      ];
      for (const [q, code] of refused) {
        const err = await readSqlQuery(h, q, ['x']).catch((e: unknown) => e);
        expect(err, q).toBeInstanceOf(SourcePolicyError);
        expect((err as SourcePolicyError).code, q).toBe(code);
        const c = await checkSqlQuery(h, q);
        expect(c.ok, q).toBe(false);
      }
      expect(resolver.calls).toBe(0); // not one connection was even resolved
      const counted = await db.admin.unsafe<Array<{ n: string }>>('SELECT count(*)::text AS n FROM s.w');
      expect(counted[0]?.n).toBe('2');
    });

    it('S11: a query that would run for minutes stops at 10 s AT THE SOURCE (pg_stat_activity)', async () => {
      const marker = `deadline_${Date.now()}`;
      const q = `SELECT count(*) AS ${marker} FROM s.big a, s.big b, s.big c`;
      const t0 = Date.now();
      const run = pgRead(login('apps_reader', 'apps-reader'), q, []).then(
        () => ({ ok: true as const, at: Date.now() - t0 }),
        (e: unknown) => ({ ok: false as const, at: Date.now() - t0, err: e as { sqlstate?: string; errorClass?: string } }),
      );
      const active = async (): Promise<number> => {
        const rows = await db.admin.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM pg_catalog.pg_stat_activity WHERE state = 'active' AND query LIKE '%' || $1 || '%' AND pid <> pg_catalog.pg_backend_pid()`, [marker]);
        return Number(rows[0]?.n ?? 0);
      };
      await new Promise((r) => setTimeout(r, 4_000));
      expect(await active()).toBe(1); // running at the source
      const out = await run;
      expect(out.ok).toBe(false);
      expect(out.at).toBeGreaterThanOrEqual(9_500);
      expect(out.at).toBeLessThan(12_500);
      if (!out.ok) expect(out.err).toMatchObject({ sqlstate: '57014', errorClass: 'timeout' });
      await new Promise((r) => setTimeout(r, 300));
      expect(await active()).toBe(0); // and gone from the source, not merely abandoned by crew
    }, 30_000);

    describe('the table safety check (DES §7.4 rev 11)', () => {
      const writer = (): SqlConnectArgs => login('apps_writer', 'apps-writer');
      const refusedTables: Array<[string, string, string]> = [
        ['plain', 'cascading_key', 'P8: s.kids references it ON DELETE CASCADE'],
        ['trig', 'user_trigger', 'P4: a trigger'],
        ['dis', 'user_trigger', 'P13: a disabled trigger'],
        ['par', 'internal_trigger_disabled', 'P19: a disabled internal trigger'],
        ['t', 'user_trigger', 'P24: a trigger that removes itself'],
        ['ruled', 'rule', 'P6: a rule'],
        ['parent', 'inheritance_parent', 'P7: an inheritance parent'],
        ['child', 'inheritance_child', 'P7: an inheritance child'],
        ['parted', 'partitioned', 'P1: a partitioned table'],
        ['parted_1', 'partition', 'P1: a partition'],
        ['rls', 'row_security', 'P5: row security'],
        ['domained', 'column_type', 'a domain column'],
        ['dkey', 'column_type', 'P16: a domain key'],
        ['ccast', 'check_expression', 'P17: a CHECK casting to a domain'],
        ['bicheck', 'check_expression', 'P18/P21: a side-effecting built-in in a CHECK'],
        ['gen', 'generated_column', 'P12: a generated column'],
        ['idx', 'index_expression', 'P14: an expression index'],
        ['pidx', 'index_partial', 'P15: a partial index'],
        ['v', 'not_a_table', 'a view'],
        ['tickets9', 'fk_operator', 'P39: a foreign key comparing with a custom operator'],
        ['tickets10', 'statistics_expression', 'P40: expression statistics'],
        ['checked', 'check_expression', 'a CHECK calling a user function'],
      ];
      it.each(refusedTables)('refuses s.%s (%s): %s', async (table, code) => {
        const r = await pgTableSafety(writer(), 's', table);
        expect(r.safe).toBe(false);
        expect(r.reasons.map((x) => x.code)).toContain(code);
        expect(r.reasons.find((x) => x.code === code)?.detail).toContain(`s.${table}`);
      });

      it('the CHECK rules catch each other’s gaps: P17 by both; P37 (a user cast printing as ::text) by the cast rule and pg_depend', async () => {
        expect((await pgTableSafety(writer(), 's', 'ccast')).reasons.map((x) => x.code)).toEqual(expect.arrayContaining(['check_expression', 'check_dependency']));
        // P37 lives in a transaction that is rolled back: a cast is database-wide (see the seed).
        const codes = await db.admin
          .begin(async (tx) => {
            await tx.unsafe(`CREATE TYPE s.st AS ENUM ('open', 'closed');
              CREATE FUNCTION s.st_text(s.st) RETURNS text LANGUAGE plpgsql VOLATILE AS $f$ BEGIN INSERT INTO s.side VALUES ('enum cast ran'); RETURN enum_out($1)::text; END $f$;
              CREATE CAST (s.st AS text) WITH FUNCTION s.st_text(s.st);
              CREATE TABLE s.e (id int PRIMARY KEY, status s.st, body text, CHECK ((status)::text <> ''))`);
            const r = await pgTableSafetyIn(tx as never, 's', 'e');
            // The printed CHECK alone looks harmless: a plain ::text.
            expect(r.reasons.map((x) => x.code)).not.toContain('check_expression');
            throw Object.assign(new Error('rollback'), { codes: r.reasons.map((x) => x.code) });
          })
          .catch((e: { codes?: string[] }) => e.codes ?? []);
        expect(codes).toEqual(expect.arrayContaining(['user_cast', 'check_dependency']));
      });

      it('accepts s.w and an enum column; tables whose only hazard is a default are accepted (inserts supply every column)', async () => {
        expect(await pgTableSafety(writer(), 's', 'w', { op: 'update', set: ['owner'], key: ['id'] })).toMatchObject({ safe: true, reasons: [] });
        expect(await pgTableSafety(writer(), 's', 'enumd', { op: 'update', set: ['prio'], key: ['id'] })).toMatchObject({ safe: true });
        for (const t of ['defaulted', 'opdef', 'catdef']) expect((await pgTableSafety(writer(), 's', t)).safe, t).toBe(true);
        // An insert supplying every column (so the user-function default never runs, P35) is accepted.
        expect(await pgTableSafety(writer(), 's', 'defaulted', { op: 'insert', set: ['id', 'owner'], key: ['id'] })).toMatchObject({ safe: true });
      });

      it('the declaration check: P29 insert into a table with a foreign key, P33 update of a foreign-key column, P34 delete of a referenced row; P32 is fine', async () => {
        const codes = async (t: string, decl: Parameters<typeof pgTableSafety>[3]) => (await pgTableSafety(writer(), 's', t, decl)).reasons.map((x) => x.code);
        expect(await codes('t6', { op: 'insert', set: ['id', 'par_id', 'owner'], key: ['id'] })).toContain('fk_enforcement');
        expect(await codes('t6', { op: 'update', set: ['par_id'], key: ['id'] })).toContain('fk_enforcement');
        expect(await codes('t6', { op: 'update', set: ['owner'], key: ['id'] })).toEqual([]);
        expect(await codes('t2', { op: 'delete', set: [], key: ['id'] })).toContain('fk_enforcement');
        expect(await codes('t2', { op: 'update', set: ['owner'], key: ['id'] })).toEqual([]);
        expect(await codes('w', { op: 'update', set: ['owner'], key: ['owner'] })).toContain('key_mismatch');
        expect(await codes('w', { op: 'update', set: ['id'], key: ['id'] })).toContain('key_write');
        expect(await codes('catdef', { op: 'insert', set: ['id', 'owner'], key: ['id'] })).toContain('insert_columns');
        expect(await codes('money', { op: 'update', set: ['ratio'], key: ['id'] })).toContain('written_type'); // P31: floating point
        expect(await codes('money', { op: 'update', set: ['amount'], key: ['id'] })).toEqual([]);
      });

      it('the pg_depend net refuses code attached to the table in a way the list does not name', async () => {
        await db.admin.unsafe("CREATE TABLE s.netbase (id int PRIMARY KEY, owner text); CREATE VIEW s.netview AS SELECT id, s.cat3(owner, 'x') AS o FROM s.netbase");
        const r = await pgTableSafety(writer(), 's', 'netbase');
        expect(r.reasons.map((x) => x.code)).toContain('depend_net');
        expect(r.reasons.find((x) => x.code === 'depend_net')?.detail).toContain('s.cat3');
      });

      it('P25: it reads the real catalog while a temporary pg_trigger shadows the name', async () => {
        const sql = pgClient(login('apps_writer', 'apps-writer'), { readOnly: false });
        try {
          const r = await sql.begin(async (tx) => {
            await tx.unsafe('CREATE TEMP TABLE pg_trigger (tgrelid oid, tgisinternal bool, tgname name, tgenabled "char")');
            await tx.unsafe('SET LOCAL search_path = pg_temp, pg_catalog');
            return pgTableSafetyIn(tx, 's', 'trig');
          });
          expect(r.reasons.map((x) => x.code)).toContain('user_trigger');
        } finally {
          await sql.end();
        }
      });

      it('the fingerprint hashes definitions: unchanged when nothing changes, changed by a new trigger', async () => {
        await db.admin.unsafe('CREATE TABLE s.fp (id int PRIMARY KEY, owner text)');
        const a = await pgTableSafety(writer(), 's', 'fp');
        const b = await pgTableSafety(writer(), 's', 'fp');
        expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(b.fingerprint).toBe(a.fingerprint);
        await db.admin.unsafe('CREATE TRIGGER tfp BEFORE UPDATE ON s.fp FOR EACH ROW EXECUTE FUNCTION s.tf(); ALTER TABLE s.fp DISABLE TRIGGER tfp');
        const c = await pgTableSafety(writer(), 's', 'fp');
        expect(c.fingerprint).not.toBe(a.fingerprint);
        expect(c.safe).toBe(false);
      });
    });

    it('the privilege report lists exactly the missing GRANTs (table-level privilege for the operation and SELECT, schema USAGE)', async () => {
      const w = await pgPrivileges(login('apps_writer', 'apps-writer'), [
        { schema: 's', table: 'w', op: 'update', set: ['owner'], key: ['id'] },
        { schema: 's', table: 't2', op: 'update', set: ['owner'], key: ['id'] },
        { schema: 's', table: 't2', op: 'insert', set: ['id', 'owner'], key: ['id'] },
        { schema: 's', table: 't2', op: 'delete', set: [], key: ['id'] },
      ]);
      expect(w.login).toBe('apps_writer');
      expect(w.readOnly).toBe(false);
      expect(w.writes.map((x) => x.missing)).toEqual([
        ['GRANT SELECT ON TABLE "s"."w" TO "apps_writer";', 'GRANT UPDATE ON TABLE "s"."w" TO "apps_writer";'],
        [],
        ['GRANT INSERT ON TABLE "s"."t2" TO "apps_writer";'],
        ['GRANT DELETE ON TABLE "s"."t2" TO "apps_writer";'],
      ]);
      const bare = await pgPrivileges(login('apps_bare', 'apps-bare'), [{ schema: 's', table: 't2', op: 'update', set: ['owner'], key: ['id'] }]);
      expect(bare.writes[0]?.missing).toEqual(['GRANT USAGE ON SCHEMA "s" TO "apps_bare";', 'GRANT SELECT ON TABLE "s"."t2" TO "apps_bare";', 'GRANT UPDATE ON TABLE "s"."t2" TO "apps_bare";']);
      const reader = await pgPrivileges(login('apps_reader', 'apps-reader'));
      expect(reader.readOnly).toBe(true);
      expect(reader.tables.find((t) => t.table === 'w')).toMatchObject({ select: true, update: false });
    });

    it('Allow writes (DES §7.4): off on a new source, an agent cannot turn it on, turning it off withdraws row-write grants and leaves queries running', async () => {
      const base = mkdtempSync(join(tmpdir(), 'apps-allow-writes-'));
      const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
      const registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'mcp')), secrets, probe: probeMcpServer, discover: () => [], env: { APPS_K1_PW: 'apps-reader' } });
      const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
      let actor: Actor = LOCAL_ACTOR;
      const withdrawn: string[] = [];
      const app = Fastify({ logger: false });
      registerMcpRoutes(app, { registry, audit, actorOf: () => actor });
      let live = 0; // the row-write grants K2b's store would hold
      registerSourceRoutes(app, {
        registry,
        audit,
        actorOf: () => actor,
        rowWriteGrants: {
          withdrawForSource: async (n) => {
            withdrawn.push(n);
            const k = live;
            live = 0;
            return k;
          },
        },
      });
      await app.ready();
      try {
        const config = { name: 'support', kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: db.port, database: db.database, user: 'apps_reader', tls: 'disable' }, auth: { ref: 'env:APPS_K1_PW' }, address: LOOPBACK };
        const p = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: config });
        expect(p.statusCode, p.body).toBe(200);
        const preview = p.json() as McpPreviewResponse;
        expect(preview.source?.privileges?.readOnly).toBe(true);
        expect(preview.tools).toEqual([]);
        const saved = (await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: preview.previewHash } })).json() as McpServer;
        expect(saved.allowWrites).toBe(false);
        const hash = saved.descriptorHash;
        actor = { id: 'worker-1', kind: 'agent', trust: 'admin' };
        const refused = await app.inject({ method: 'PUT', url: '/api/v1/sources/support/allow-writes', payload: { allowed: true } });
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ code: 'writes_switch_human_only' });
        expect((await registry.get('support')).allowWrites).toBe(false);
        actor = LOCAL_ACTOR;
        expect((await app.inject({ method: 'PUT', url: '/api/v1/sources/support/allow-writes', payload: { allowed: true } })).json()).toEqual({ name: 'support', allowWrites: true, withdrawnGrants: 0 });
        expect((await registry.get('support')).descriptorHash).toBe(hash); // not part of the descriptor
        live = 3; // grants made while on
        // A read in flight while the switch goes off keeps running and completes.
        const src = await registry.source('support');
        const reading = pgRead(sqlConnectArgs(src.config, 'apps-reader'), 'SELECT sum(a.n + b.n) AS s FROM s.big a, s.big b', []);
        await new Promise((r) => setTimeout(r, 150));
        const off = await app.inject({ method: 'PUT', url: '/api/v1/sources/support/allow-writes', payload: { allowed: false } });
        expect(off.json()).toEqual({ name: 'support', allowWrites: false, withdrawnGrants: 3 });
        expect(withdrawn).toEqual(['support', 'support']); // on withdraws leftovers first (none), off withdraws the 3
        const r = await reading;
        expect(r.rows).toEqual([['64016000000']]);
        expect((await registry.get('support')).descriptorHash).toBe(hash);
        await audit.flush();
        const lines = (await audit.read()).filter((e) => e.action.startsWith('apps.source.writes_'));
        expect(lines.map((e) => [e.action, e.actor.kind])).toEqual(expect.arrayContaining([['apps.source.writes_allowed', 'human'], ['apps.source.writes_disallowed', 'human']]));
        expect(lines).toHaveLength(2);
        // Off when already off changes nothing and records nothing (pi r1); it does retry the
        // withdrawal, which finds none left (codex r2: S12).
        expect((await app.inject({ method: 'PUT', url: '/api/v1/sources/support/allow-writes', payload: { allowed: false } })).json()).toEqual({ name: 'support', allowWrites: false, withdrawnGrants: 0 });
        expect(withdrawn).toEqual(['support', 'support', 'support']);
        await audit.flush();
        expect((await audit.read()).filter((e) => e.action.startsWith('apps.source.writes_'))).toHaveLength(2);
      } finally {
        await app.close();
        rmSync(base, { recursive: true, force: true });
      }
    });

    describe('review r1 folds (codex, pi)', () => {
      it('the catalog marks a table with a foreign child, and a plain read of it is refused at the policy', async () => {
        await db.admin.unsafe("CREATE EXTENSION IF NOT EXISTS postgres_fdw; CREATE SERVER k1_fs FOREIGN DATA WRAPPER postgres_fdw; CREATE TABLE s.fparent (id int); CREATE FOREIGN TABLE s.fchild () INHERITS (s.fparent) SERVER k1_fs; GRANT SELECT ON s.fparent TO apps_reader");
        const args = login('apps_reader', 'apps-reader');
        const cat = await describePg(args);
        expect(cat.relations.find((r) => r.name === 'fparent')?.foreignDescendant).toBe(true);
        const h: SqlSourceHandle = { driver: 'postgres', connect: args, catalog: cat, viewsAllowed: [] };
        await expect(readSqlQuery(h, 'SELECT id FROM s.fparent', [])).rejects.toMatchObject({ code: 'relation' });
        expect((await readSqlQuery(h, 'SELECT id FROM ONLY s.fparent', [])).rows).toEqual([]);
      });

      it('a relation replaced at the source since the describe is refused before the read runs', async () => {
        await db.admin.unsafe('CREATE TABLE s.swap (id int PRIMARY KEY); GRANT SELECT ON s.swap TO apps_reader');
        const args = login('apps_reader', 'apps-reader');
        const h: SqlSourceHandle = { driver: 'postgres', connect: args, catalog: await describePg(args), viewsAllowed: [] };
        expect((await readSqlQuery(h, 'SELECT id FROM s.swap', [])).rows).toEqual([]);
        await db.admin.unsafe('DROP TABLE s.swap; CREATE VIEW s.swap AS SELECT 1 AS id; GRANT SELECT ON s.swap TO apps_reader');
        await expect(readSqlQuery(h, 'SELECT id FROM s.swap', [])).rejects.toMatchObject({ errorClass: 'refused' });
      });

      it('a deadline the source does not enforce is still met: the cancel stops the query at the source, on the backend it runs on', async () => {
        let n = 0;
        // The name answers the confirmed address once, then something else: the cancel must not follow it.
        const flip = Object.assign(async () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']), { calls: 0 });
        const args = login('apps_reader', 'apps-reader', flip as never);
        const marker = `guard_${Date.now()}`;
        const t0 = Date.now();
        const out = await pgRead(args, `SELECT count(*) AS ${marker} FROM s.big a, s.big b, s.big c`, [], { deadlineMs: 2_500, sourceTimeoutMs: 120_000 }).then(
          () => ({ ok: true, at: Date.now() - t0 }),
          (e: unknown) => ({ ok: false, at: Date.now() - t0, err: e as { errorClass?: string } }),
        );
        expect(out.ok).toBe(false);
        expect(out.at).toBeLessThan(6_000);
        expect(n).toBe(1); // the cancel connection went to the pinned address, not a fresh resolution
        await new Promise((r) => setTimeout(r, 500));
        const rows = await db.admin.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM pg_catalog.pg_stat_activity WHERE state = 'active' AND query LIKE '%' || $1 || '%' AND pid <> pg_catalog.pg_backend_pid()`, [marker]);
        expect(rows[0]?.n).toBe('0');
      }, 20_000);

      it('TLS verify-full against a server without TLS is refused, never downgraded', async () => {
        const args = { ...login('apps_reader', 'apps-reader'), source: { ...login('apps_reader', 'apps-reader').source, tls: 'verify-full' as const } };
        await expect(describePg(args)).rejects.toThrow();
      });

      it('the safety check: a key named twice is not the whole key; a pg_catalog overload of an allowed function is user code; enum labels and collations are in the fingerprint', async () => {
        await db.admin.unsafe('CREATE TABLE s.ck (a int, b int, v text, PRIMARY KEY (a, b))');
        expect((await pgTableSafety(login('apps_writer', 'apps-writer'), 's', 'ck', { op: 'update', set: ['v'], key: ['a', 'a'] })).reasons.map((x) => x.code)).toContain('key_mismatch');
        expect((await pgTableSafety(login('apps_writer', 'apps-writer'), 's', 'ck', { op: 'update', set: ['v'], key: ['a', 'b'] })).safe).toBe(true);
        const codes = await db.admin
          .begin(async (tx) => {
            await tx.unsafe(`CREATE FUNCTION pg_catalog.lower(s.prio) RETURNS text LANGUAGE sql IMMUTABLE AS $f$ SELECT 'x' $f$;
              CREATE TABLE s.ovl (id int PRIMARY KEY, prio s.prio, CHECK (lower(prio) <> ''))`);
            const r = await pgTableSafetyIn(tx as never, 's', 'ovl');
            throw Object.assign(new Error('rollback'), { codes: r.reasons.map((x) => x.code) });
          })
          .catch((e: { codes?: string[] }) => e.codes ?? []);
        expect(codes).toContain('check_dependency');
        await db.admin.unsafe("CREATE TYPE s.lvl AS ENUM ('a', 'b'); CREATE TABLE s.fp2 (id int PRIMARY KEY, lvl s.lvl, note text)");
        const before = (await pgTableSafety(login('apps_writer', 'apps-writer'), 's', 'fp2')).fingerprint;
        await db.admin.unsafe("ALTER TYPE s.lvl ADD VALUE 'c'");
        const afterEnum = (await pgTableSafety(login('apps_writer', 'apps-writer'), 's', 'fp2')).fingerprint;
        expect(afterEnum).not.toBe(before);
        await db.admin.unsafe('ALTER TABLE s.fp2 ALTER COLUMN note TYPE text COLLATE "C"');
        expect((await pgTableSafety(login('apps_writer', 'apps-writer'), 's', 'fp2')).fingerprint).not.toBe(afterEnum);
      });

      it('a source error reaches an agent as its class and SQLSTATE only; a person gets the words', async () => {
        const base = mkdtempSync(join(tmpdir(), 'apps-errors-'));
        const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
        const registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'mcp')), secrets, probe: probeMcpServer, discover: () => [], env: { APPS_K1_PW: 'apps-reader' } });
        let actor: Actor = LOCAL_ACTOR;
        const app = Fastify({ logger: false });
        const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
        registerMcpRoutes(app, { registry, audit, actorOf: () => actor });
        registerSourceRoutes(app, { registry, audit, actorOf: () => actor });
        await app.ready();
        try {
          const cfg = { name: 'support', kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: db.port, database: db.database, user: 'apps_reader', tls: 'disable' }, auth: { ref: 'env:APPS_K1_PW' } };
          // Without a confirmed range the preview is refused with the dialer's code (codex r1).
          const refused = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: cfg });
          expect(refused.statusCode).toBe(409);
          expect(refused.json()).toMatchObject({ code: 'address_unconfirmed' });
          const p = (await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: { ...cfg, address: LOOPBACK } })).json() as McpPreviewResponse;
          expect((await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: p.previewHash } })).statusCode).toBe(201);
          const echo = "SELECT 'marker-value-4821'::int AS n FROM s.w";
          const human = (await app.inject({ method: 'POST', url: '/api/v1/sources/support/check', payload: { text: echo } })).json() as { ok: boolean; code: string; detail: string };
          expect(human).toMatchObject({ ok: false, code: 'prepare' });
          expect(human.detail).toContain('marker-value-4821');
          actor = { id: 'worker-1', kind: 'agent', trust: 'operator' };
          const agent = await app.inject({ method: 'POST', url: '/api/v1/sources/support/check', payload: { text: echo } });
          expect(agent.json()).toMatchObject({ ok: false, code: 'prepare' });
          expect(agent.body).not.toContain('marker-value-4821');
          expect(agent.body).toContain('22P02');
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      });
    });

    describe('review r2 folds (codex)', () => {
      const reader = (): SqlConnectArgs => login('apps_reader', 'apps-reader');
      const handle = async (): Promise<SqlSourceHandle> => ({ driver: 'postgres', connect: reader(), catalog: await describePg(reader()), viewsAllowed: [] });

      it('S2: the check runs the live relation checks too: a table replaced by a view since the describe is refused', async () => {
        await db.admin.unsafe('CREATE TABLE s.r2a (id int); GRANT SELECT ON s.r2a TO apps_reader');
        try {
          const h = await handle();
          expect(await checkSqlQuery(h, 'SELECT id FROM s.r2a')).toMatchObject({ ok: true });
          await db.admin.unsafe('DROP TABLE s.r2a; CREATE VIEW s.r2a AS SELECT 1 AS id; GRANT SELECT ON s.r2a TO apps_reader');
          expect(await checkSqlQuery(h, 'SELECT id FROM s.r2a')).toMatchObject({ ok: false, code: 'refused' });
        } finally {
          await db.admin.unsafe('DROP VIEW IF EXISTS s.r2a; DROP TABLE IF EXISTS s.r2a');
        }
      });

      it('R2: a relation swapped while the read waits is the relation checked: LOCK before the check, held to the end', async () => {
        await db.admin.unsafe("CREATE TABLE s.r2b (id int, owner text); INSERT INTO s.r2b VALUES (1, 'table-row'); GRANT SELECT ON s.r2b TO apps_reader");
        const b = await db.admin.reserve();
        try {
          await b.unsafe('BEGIN');
          await b.unsafe("ALTER TABLE s.r2b RENAME TO r2b_old; CREATE VIEW s.r2b AS SELECT 1 AS id, 'view-marker'::text AS owner; GRANT SELECT ON s.r2b TO apps_reader");
          const read = pgRead(reader(), 'SELECT id, owner FROM s.r2b', [], { expect: [{ schema: 's', name: 'r2b', kinds: ['table', 'partitioned'], noForeignBelow: true }] }).then(
            (r) => ({ ok: true as const, rows: r.rows }),
            (e: unknown) => ({ ok: false as const, message: String((e as Error).message) }),
          );
          // The read is waiting on the swap's lock before the swap commits.
          for (let i = 0; i < 60; i++) {
            const [w] = await db.admin.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = '${db.database}' AND usename = 'apps_reader' AND wait_event_type = 'Lock'`);
            if (w?.n !== '0') break;
            await new Promise((r) => setTimeout(r, 50));
          }
          await b.unsafe('COMMIT');
          const out = await read;
          expect(out).toMatchObject({ ok: false });
          expect((out as { message: string }).message).toMatch(/changed at the source/);
        } finally {
          await b.unsafe('ROLLBACK').catch(() => undefined);
          b.release();
          await db.admin.unsafe('DROP VIEW IF EXISTS s.r2b; DROP TABLE IF EXISTS s.r2b; DROP TABLE IF EXISTS s.r2b_old');
        }
      });

      it('C1: one deadline from entry: a connection slower than the deadline is a timeout, not a fresh 10 s after it', { timeout: 15_000 }, async () => {
        const slow = (async (host: string) => {
          await new Promise((r) => setTimeout(r, 2_500));
          return host === DB_HOST ? ['127.0.0.1'] : [];
        }) as ReturnType<typeof countingResolver>;
        const count = async (): Promise<number> =>
          Number((await db.admin.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = '${db.database}' AND usename = 'apps_reader'`))[0]?.n ?? '0');
        const before = await count();
        const t0 = Date.now();
        await expect(pgRead(login('apps_reader', 'apps-reader', slow), 'SELECT 1 AS one', [], { deadlineMs: 300 })).rejects.toMatchObject({ errorClass: 'timeout' });
        // Stopped at its deadline while still connecting, not once the 2.5 s connection is up.
        expect(Date.now() - t0).toBeLessThan(1_500);
        // And the connection that would have arrived late is never made (codex r3).
        await new Promise((r) => setTimeout(r, 3_000));
        expect(await count()).toBeLessThanOrEqual(before);
      });

      it('the relation lock is a prepare (codex r3): a column-level grant reads, ONLY does not wait on a locked child, a renamed column is caught', async () => {
        await db.admin.unsafe('CREATE TABLE s.cg (id int, secret text); GRANT SELECT (id) ON s.cg TO apps_reader; CREATE TABLE s.cd (id int, note text); GRANT SELECT ON s.cd TO apps_reader');
        const b = await db.admin.reserve();
        try {
          const h = await handle();
          // SELECT(id) only: LOCK TABLE would need a table privilege; preparing does not.
          expect((await readSqlQuery(h, 'SELECT id FROM s.cg', [])).rows).toEqual([]);
          // A child held ACCESS EXCLUSIVE by someone else: a read of ONLY the parent does not wait for it.
          await b.unsafe('BEGIN');
          await b.unsafe('LOCK TABLE s.child IN ACCESS EXCLUSIVE MODE');
          const only = await readSqlQuery(h, 'SELECT id FROM ONLY s.parent', [], { deadlineMs: 3_000 });
          expect(only.rows).toBeDefined();
          await b.unsafe('ROLLBACK');
          // A column renamed since the describe: the policy accepted c.note as a column; it is refused, not read as note(c).
          await db.admin.unsafe('ALTER TABLE s.cd RENAME COLUMN note TO note2');
          await expect(readSqlQuery(h, 'SELECT c.note FROM s.cd c', [])).rejects.toThrow(/columns changed at the source/);
        } finally {
          await b.unsafe('ROLLBACK').catch(() => undefined);
          b.release();
          await db.admin.unsafe('DROP TABLE IF EXISTS s.cg; DROP TABLE IF EXISTS s.cd');
        }
      });

      it('a peer that never answers the startup: the read times out and its socket is destroyed, not left half-open (codex r4)', async () => {
        const peers = new Set<import('node:net').Socket>();
        const silent = createNetServer({ allowHalfOpen: true }, (c) => {
          peers.add(c);
          c.on('error', () => undefined);
        });
        await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
        const port = (silent.address() as AddressInfo).port;
        try {
          const args = { ...reader(), source: { ...reader().source, port } };
          await expect(pgRead(args, 'SELECT 1', [], { deadlineMs: 300 })).rejects.toMatchObject({ errorClass: 'timeout' });
          const open = (): number =>
            (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().filter((h) => h instanceof NetSocket && h.remotePort === port && !h.destroyed).length;
          for (let i = 0; i < 40 && open() > 0; i++) await new Promise((r) => setTimeout(r, 100));
          expect(open()).toBe(0);
        } finally {
          for (const c of peers) c.destroy();
          await new Promise<void>((r) => silent.close(() => r()));
        }
      }, 15_000);

      it('a column dropped and added back (same names, new order) is a changed relation (codex r4)', async () => {
        await db.admin.unsafe('CREATE TABLE s.ord (id int, a text, b text); GRANT SELECT ON s.ord TO apps_reader');
        try {
          const h = await handle();
          expect((await readSqlQuery(h, 'SELECT o.b FROM s.ord AS o(x, y)', [])).rows).toEqual([]);
          await db.admin.unsafe('ALTER TABLE s.ord DROP COLUMN a; ALTER TABLE s.ord ADD COLUMN a text');
          await expect(readSqlQuery(h, 'SELECT o.b FROM s.ord AS o(x, y)', [])).rejects.toThrow(/columns changed at the source/);
          // Appending a column keeps the described ones leading: still fine.
          await db.admin.unsafe('ALTER TABLE s.w ADD COLUMN k1_extra int');
          expect((await readSqlQuery(h, 'SELECT w.owner FROM s.w AS w WHERE w.id = $1', [4821])).rows).toEqual([['nobody']]);
        } finally {
          await db.admin.unsafe('DROP TABLE s.ord; ALTER TABLE s.w DROP COLUMN IF EXISTS k1_extra');
        }
      });

      it('C2: a read with no rows still answers its columns', async () => {
        const r = await pgRead(reader(), 'SELECT id, owner FROM s.w WHERE false', []);
        expect(r.rows).toEqual([]);
        expect(r.columns).toEqual([{ name: 'id', type: 'integer' }, { name: 'owner', type: 'text' }]);
      });

      it('T2: a production read runs READ ONLY under the pinned search_path, and stops at 5,000 rows', async () => {
        const r = await pgRead(reader(), "SELECT current_setting('transaction_read_only') AS ro, current_setting('search_path') AS sp", []);
        expect(r.rows).toEqual([['on', 'pg_catalog, pg_temp']]);
        const capped = await readSqlQuery(await handle(), 'SELECT a.n FROM s.big a CROSS JOIN s.big b LIMIT 6000', []);
        expect(capped.rows).toHaveLength(5_000);
        expect(capped.truncated).toBe(true);
      });

      it('C3: UPDATE on an updatable view (or a foreign table, or setval) is a write: the login is not read-only', async () => {
        expect((await pgPrivileges(reader())).readOnly).toBe(true);
        await db.admin.unsafe('CREATE VIEW s.uv AS SELECT id, owner FROM s.w; GRANT UPDATE ON s.uv TO apps_reader');
        try {
          expect((await pgPrivileges(reader())).readOnly).toBe(false);
        } finally {
          await db.admin.unsafe('DROP VIEW s.uv');
        }
        await db.admin.unsafe('CREATE SEQUENCE s.sq; GRANT UPDATE ON SEQUENCE s.sq TO apps_reader');
        try {
          expect((await pgPrivileges(reader())).readOnly).toBe(false);
          // USAGE alone advances it (nextval): a write too (codex r3).
          await db.admin.unsafe('REVOKE UPDATE ON SEQUENCE s.sq FROM apps_reader; GRANT USAGE ON SEQUENCE s.sq TO apps_reader');
          expect((await pgPrivileges(reader())).readOnly).toBe(false);
        } finally {
          await db.admin.unsafe('DROP SEQUENCE s.sq');
        }
      });

      it('C4: the fingerprint tells apart collations whose dotted names print the same', async () => {
        await db.admin.unsafe('CREATE SCHEMA "k1.a"; CREATE SCHEMA k1; CREATE COLLATION "k1.a".c FROM "C"; CREATE COLLATION k1."a.c" FROM "C"');
        await db.admin.unsafe('CREATE TABLE s.colt (id int PRIMARY KEY, t text COLLATE "k1.a".c)');
        try {
          const f1 = (await pgTableSafety(reader(), 's', 'colt')).fingerprint;
          await db.admin.unsafe('ALTER TABLE s.colt ALTER COLUMN t TYPE text COLLATE k1."a.c"');
          const f2 = (await pgTableSafety(reader(), 's', 'colt')).fingerprint;
          expect(f1).toMatch(/^[0-9a-f]{64}$/);
          expect(f2).not.toBe(f1);
        } finally {
          await db.admin.unsafe('DROP TABLE s.colt; DROP SCHEMA "k1.a" CASCADE; DROP SCHEMA k1 CASCADE');
        }
      });

      it('C4 (codex r3): an index-only collation\'s definition and the database collation are in the fingerprint', async () => {
        await db.admin.unsafe('CREATE SCHEMA k1c; CREATE COLLATION k1c.c2 FROM "C"; CREATE TABLE s.ixc (id int PRIMARY KEY, t text); CREATE INDEX ixc_t ON s.ixc (t COLLATE k1c.c2)');
        try {
          const fp = async (): Promise<string> => (await pgTableSafety(reader(), 's', 'ixc')).fingerprint;
          const f1 = await fp();
          // A refreshed collation version, as ALTER COLLATION … REFRESH VERSION records after a library upgrade.
          await db.admin.unsafe("UPDATE pg_catalog.pg_collation SET collversion = 'k1-test' WHERE collname = 'c2' AND collnamespace = 'k1c'::regnamespace");
          const f2 = await fp();
          expect(f2).not.toBe(f1);
          await db.admin.unsafe(`UPDATE pg_catalog.pg_database SET datcollversion = 'k1-test' WHERE datname = '${db.database}'`);
          expect(await fp()).not.toBe(f2);
        } finally {
          await db.admin.unsafe('DROP TABLE s.ixc; DROP SCHEMA k1c CASCADE');
        }
      });

      it('S12: a failed withdrawal is retried by asking again; grants left from before never come back on', async () => {
        const base = mkdtempSync(join(tmpdir(), 'apps-withdraw-'));
        const secrets: SecretStore = { available: false, get: async () => null, has: async () => false, set: async () => undefined, delete: async () => undefined };
        const registry = new McpRegistry({ store: new McpRegistryStore(join(base, 'mcp')), secrets, probe: probeMcpServer, discover: () => [], env: { APPS_K1_PW: 'apps-reader' } });
        const audit = new AuditLog(join(base, 'audit.log'), () => undefined);
        let live = 0; // the grant store K2b will provide
        let failNext = 0;
        const app = Fastify({ logger: false });
        registerMcpRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR });
        registerSourceRoutes(app, {
          registry,
          audit,
          actorOf: () => LOCAL_ACTOR,
          rowWriteGrants: {
            withdrawForSource: async () => {
              if (failNext > 0) {
                failNext--;
                throw new Error('the grant store is unavailable');
              }
              const n = live;
              live = 0;
              return n;
            },
          },
        });
        await app.ready();
        const sw = (allowed: boolean) => app.inject({ method: 'PUT', url: '/api/v1/sources/support/allow-writes', payload: { allowed } });
        try {
          const config = { name: 'support', kind: 'sql', sql: { driver: 'postgres', host: '127.0.0.1', port: db.port, database: db.database, user: 'apps_reader', tls: 'disable' }, auth: { ref: 'env:APPS_K1_PW' }, address: LOOPBACK };
          const p = (await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: config })).json() as McpPreviewResponse;
          expect((await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: p.previewHash } })).statusCode).toBe(201);
          expect((await sw(true)).json()).toEqual({ name: 'support', allowWrites: true, withdrawnGrants: 0 });
          live = 3;
          failNext = 1;
          const failed = await sw(false);
          expect(failed.statusCode).toBe(500);
          expect(failed.json()).toMatchObject({ code: 'withdraw_failed' });
          expect((await registry.get('support')).allowWrites).toBe(false);
          // Asking again retries the withdrawal (it used to answer "nothing changed").
          expect((await sw(false)).json()).toEqual({ name: 'support', allowWrites: false, withdrawnGrants: 3 });
          // Grants left behind (a crash between the switch and the withdrawal): turning on withdraws them
          // first, and stays off when it cannot.
          live = 2;
          failNext = 1;
          const refused = await sw(true);
          expect(refused.statusCode).toBe(500);
          expect((await registry.get('support')).allowWrites).toBe(false);
          expect((await sw(true)).json()).toEqual({ name: 'support', allowWrites: true, withdrawnGrants: 2 });
          expect(live).toBe(0);
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      });
    });

    it('policyCatalog keys relations by schema-qualified name', async () => {
      const pc = policyCatalog(await describePg(login('apps_reader', 'apps-reader')), ['s.v']);
      expect(pc.relations.get(relKey('s', 'w'))).toBe('table');
      expect(pc.viewsAllowed.has(relKey('s', 'v'))).toBe(true);
      expect(pc.columns?.get(relKey('s', 'w'))).toEqual(new Set(['id', 'owner']));
    });
  });
}
