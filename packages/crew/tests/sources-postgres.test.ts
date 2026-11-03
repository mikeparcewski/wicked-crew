// DES-APPS-001 K1 against REAL Postgres 16 and 17 (S3, S10, S11, S17's table check): describe, read,
// the read policy refusing without reaching the source, the 10 s deadline stopping the query AT THE
// SOURCE (pg_stat_activity), the table safety check over the probe tables, and the privilege report.

import { mkdtempSync, rmSync } from 'node:fs';
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
      expect(ok).toMatchObject({ ok: true, describe: { columns: [{ name: 'n', type: 'bigint' }, { name: 'top', type: 'numeric' }], params: ['text'] }, relations: ['s.plain'] });
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
      registerSourceRoutes(app, { registry, audit, actorOf: () => actor, rowWriteGrants: { withdrawForSource: async (n) => (withdrawn.push(n), 3) } });
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
        // A read in flight while the switch goes off keeps running and completes.
        const src = await registry.source('support');
        const reading = pgRead(sqlConnectArgs(src.config, 'apps-reader'), 'SELECT sum(a.n + b.n) AS s FROM s.big a, s.big b', []);
        await new Promise((r) => setTimeout(r, 150));
        const off = await app.inject({ method: 'PUT', url: '/api/v1/sources/support/allow-writes', payload: { allowed: false } });
        expect(off.json()).toEqual({ name: 'support', allowWrites: false, withdrawnGrants: 3 });
        expect(withdrawn).toEqual(['support']);
        const r = await reading;
        expect(r.rows).toEqual([['64016000000']]);
        expect((await registry.get('support')).descriptorHash).toBe(hash);
        await audit.flush();
        const lines = (await audit.read()).filter((e) => e.action.startsWith('apps.source.writes_'));
        expect(lines.map((e) => [e.action, e.actor.kind])).toEqual(expect.arrayContaining([['apps.source.writes_allowed', 'human'], ['apps.source.writes_disallowed', 'human']]));
        expect(lines).toHaveLength(2);
      } finally {
        await app.close();
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('policyCatalog keys relations by schema-qualified name', async () => {
      const pc = policyCatalog(await describePg(login('apps_reader', 'apps-reader')), ['s.v']);
      expect(pc.relations.get('s.w')).toBe('table');
      expect(pc.viewsAllowed.has('s.v')).toBe(true);
    });
  });
}
