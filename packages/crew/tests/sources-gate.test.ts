// DES-KNOWLEDGE-DATA-001 §19 B2 against REAL Postgres (CI: 16 and 17): the data gate's negative controls through
// the broker, on the native entry always, and on a second registry entry for the same database on the Toolbox
// runtime when WICKED_TOOLBOX_BIN names the pinned v1.15.0 binary (the 155 MB binary is not downloaded in CI;
// the fake-process suite, knowledge-gate-toolbox.test.ts, covers the supervisor there).
//
// - The spike's probes 03-06 through the gate: SET, DDL, DML, two statements, file and settings functions are
//   refused before anything runs; a value-echoing error comes back as its SQLSTATE only; a slow read is stopped
//   at the deadline and is gone from pg_stat_activity; a read of 360,000 rows comes back capped at 200.
// - A one-row 10 MB text cell is cut AT THE SOURCE for a unit (native), or kills only that source's process
//   (Toolbox); an int8 column keeps its type.
// - With the Toolbox entry's timeout removed, a kill holds the source closed until its session is gone.
// - A login whose password holds a quote and a newline connects on both runtimes; a scan finds the password in
//   no file, log or answer.
// - The person's query runs through the gate and answers as before.

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { LOCAL_ACTOR } from '../src/api/auth.js';
import { registerMcpRoutes } from '../src/api/mcp.js';
import type { McpCallResponse, SourceQueryResponse } from '../src/core/types.js';
import { McpBroker } from '../src/mcp/broker.js';
import { McpCallRecordFile } from '../src/mcp/call-records.js';
import { McpRegistry } from '../src/mcp/registry.js';
import { McpRegistryStore } from '../src/mcp/registry-store.js';
import type { SecretStore } from '../src/mcp/secrets.js';
import { yamlQuotedBody } from '../src/knowledge/adapters/toolbox/document.js';
import { ToolboxSupervisor } from '../src/knowledge/adapters/toolbox/supervisor.js';
import { DataGate } from '../src/knowledge/gate/gate.js';
import { SourceReadLog } from '../src/knowledge/gate/record.js';
import { registerGateRoutes } from '../src/knowledge/gate/routes.js';
import { describePg } from '../src/sources/catalog/postgres.js';
import { registerSourceRoutes } from '../src/sources/routes.js';
import { readSqlQuery } from '../src/sources/sql.js';
import { countingResolver, DB_HOST, DB_REQUIRED, type FreshPg, freshPgDatabase, PG_TARGETS } from './support/sources-db.js';

const TOOLBOX_BIN = process.env['WICKED_TOOLBOX_BIN'] ?? '';
// CI's sources-db job fetches the pinned binary and sets WICKED_TOOLBOX=required: a missing one fails, never skips.
if (process.env['WICKED_TOOLBOX'] === 'required' && TOOLBOX_BIN === '') throw new Error('WICKED_TOOLBOX=required, but WICKED_TOOLBOX_BIN is not set');
const SECRET = `kd"b2\nreader'pw\\${randomUUID().slice(0, 8)}`;
const SECRET_FORMS = [SECRET, yamlQuotedBody(SECRET), JSON.stringify(SECRET).slice(1, -1)];
const LOOPBACK = { allow: ['127.0.0.0/8'], plaintext: false };
const NATIVE_ID = '3f0c9a1e-0000-4000-8000-00000000a001';
const TB_ID = '3f0c9a1e-0000-4000-8000-00000000a002';
const NODL_ID = '3f0c9a1e-0000-4000-8000-00000000a003';
const DEADLINE = 2_500;

class NoSecrets implements SecretStore {
  readonly available = true;
  async get(): Promise<string | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

const UNIT = { runId: 'run-g', ord: 1, attempt: 1, phase: 'unit-1', seat: 'claude' };
const resolver = () => async (json: string) => {
  if ((JSON.parse(json) as { token: string }).token !== 'wmt_g') throw new Error('invalid_token: unknown');
  return JSON.stringify({ unit: UNIT, projectId: 'proj_g', repoId: null, codeGraphDb: null });
};
const lister = () => async (json: string) => {
  const { calls } = JSON.parse(json) as { calls: Array<{ server: string; tool: string }> };
  return JSON.stringify({ unit: UNIT, tools: calls.map((c) => ({ subject: `mcp:${c.server}/${c.tool}`, class: 'read', decision: 'ask', ruleIds: ['engine:mcp-first-use'] })) });
};

const gatedTools = () =>
  ['list_tables', 'execute_sql'].map((name) => ({
    name,
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    classOverride: null,
    enabled: true,
    schemaHash: `h-${name}`,
    observedSchemaHash: `h-${name}`,
    present: true,
    disclosure: { class: name === 'execute_sql' ? 'rows' : 'structure', schemaHash: `h-${name}` },
  }));

const stamp = new Date().toISOString();
const common = { command: null, args: [], url: null, enabled: true, health: { state: 'ok', consecutiveFailures: 0, checkedAt: stamp, lastError: null }, registeredAt: stamp, updatedAt: stamp, tools: [], agents: { see: true, query: true, projects: ['proj_g'], everyProject: false } };

if (PG_TARGETS.length === 0) {
  describe('the data gate on a real Postgres', () => {
    it.skipIf(!DB_REQUIRED)('needs APPS_PG16_URL / APPS_PG17_URL (CI sets them; WICKED_SOURCES_DB=required fails here instead of skipping)', () => {
      throw new Error('WICKED_SOURCES_DB=required, but neither APPS_PG16_URL nor APPS_PG17_URL is set');
    });
  });
}

for (const target of PG_TARGETS) {
  describe(`the data gate on ${target.label}`, () => {
    let db: FreshPg;
    let app: FastifyInstance;
    let base: string;
    let audit: AuditLog;
    let sup: ToolboxSupervisor;
    let gate: DataGate;
    const role = `kd_b2_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const texts: string[] = [];
    const answers: string[] = [];

    beforeAll(async () => {
      db = await freshPgDatabase(target);
      // A read login whose password holds a quote and a newline (dollar-quoted: the text is taken as it is).
      await db.admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD $kdpw$${SECRET}$kdpw$`);
      await db.admin.unsafe(`GRANT CONNECT ON DATABASE ${db.database} TO ${role}`);
      await db.admin.unsafe(`GRANT USAGE ON SCHEMA s TO ${role}`);
      await db.admin.unsafe(
        "CREATE TABLE s.wide (id int PRIMARY KEY, n bigint, note text, doc jsonb, raw bytea); INSERT INTO s.wide SELECT g, g::bigint * 1000, 'row-' || g, jsonb_build_object('g', g), '\\x00ff'::bytea FROM generate_series(1, 600) g",
      );
      await db.admin.unsafe(`GRANT SELECT ON s.wide, s.plain TO ${role}`);
      base = mkdtempSync(join(tmpdir(), 'kd-b2-db-'));
      const mcpDir = join(base, 'mcp');
      mkdirSync(mcpDir, { recursive: true });
      const doc = () => ({ kind: 'source', type: 'postgres', host: '127.0.0.1', port: String(db.port), user: role, password: '${WICKED_SRC_1}', database: db.database });
      const servers: Array<Record<string, unknown>> = [
        {
          ...common,
          id: NATIVE_ID,
          name: 'pg',
          kind: 'sql',
          auth: { ref: 'env:KD_B2_PG_SECRET' },
          sql: { driver: 'postgres', host: DB_HOST, port: db.port, database: db.database, user: role, tls: 'disable' },
          viewsAllowed: [],
          address: LOOPBACK,
        },
      ];
      if (TOOLBOX_BIN !== '') {
        for (const [id, name] of [
          [TB_ID, 'pg-tb'],
          [NODL_ID, 'pg-tb-nodl'],
        ] as const) {
          servers.push({ ...common, id, name, kind: 'toolbox-source', runtime: 'toolbox', auth: { ref: 'env:KD_B2_PG_SECRET' }, toolbox: doc(), address: LOOPBACK, tls: { mode: 'disable', ca: null }, descriptorVersion: 2, policyVersion: 'postgres/1@toolbox-v1.15.0', tools: gatedTools() });
        }
      }
      writeFileSync(join(mcpDir, 'registry.json'), JSON.stringify({ version: 1, servers }));
      const store = new McpRegistryStore(mcpDir);
      const dial = { resolver: countingResolver() };
      let prober: DataGate | null = null;
      const registry = new McpRegistry({
        store,
        secrets: new NoSecrets(),
        probe: async () => ({ ok: false, error: 'no probe' }) as never,
        discover: () => [],
        env: { KD_B2_PG_SECRET: SECRET },
        toolboxProbe: (c, s) => (prober as DataGate).toolboxProbe(c, s),
      });
      audit = new AuditLog(join(base, 'audit.log'), () => undefined);
      const record = new SourceReadLog(mcpDir);
      sup = new ToolboxSupervisor({ binary: async () => TOOLBOX_BIN, runRoot: join(mcpDir, 'adapters', 'toolbox', 'run') });
      gate = new DataGate({
        store,
        catalogs: registry.catalogs,
        secret: async (ref) => (ref === 'env:KD_B2_PG_SECRET' ? SECRET : null),
        record,
        audit,
        resolver,
        lister,
        toolbox: sup,
        dial,
        deadlineMs: DEADLINE,
        recheckMs: 60_000,
        omitStatementTimeout: (id) => id === NODL_ID,
        onText: (t) => texts.push(t),
      });
      prober = gate;
      const broker = new McpBroker({ registry, engine: () => null, records: new McpCallRecordFile(mcpDir), gate });
      app = Fastify({ logger: false });
      registerMcpRoutes(app, { registry, broker, toolLister: lister, gate, audit, actorOf: () => LOCAL_ACTOR });
      registerSourceRoutes(app, { registry, audit, actorOf: () => LOCAL_ACTOR, gate, dial, queryDeadlineMs: DEADLINE });
      registerGateRoutes(app, { store, record, audit, actorOf: () => LOCAL_ACTOR });
      await app.ready();
      for (const name of ['pg', ...(TOOLBOX_BIN !== '' ? ['pg-tb', 'pg-tb-nodl'] : [])]) {
        const t = await app.inject({ method: 'POST', url: `/api/v1/sources/${name}/test` });
        expect(t.json(), `${name}: ${t.body}`).toMatchObject({ ok: true });
      }
    }, 180_000);

    afterAll(async () => {
      sup?.stopAll();
      await app?.close();
      await db?.drop();
      const b = await import('postgres');
      const admin = b.default(target.url.href, { max: 1, onnotice: () => undefined });
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.end();
      if (base !== undefined) rmSync(base, { recursive: true, force: true });
    }, 60_000);

    const call = async (server: string, sql: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_g', subject: `mcp:${server}/execute_sql`, args: { sql } } });
      answers.push(res.body);
      const body = res.json() as McpCallResponse;
      const content = (body.result as { content?: Array<{ text: string }> } | undefined)?.content;
      return { status: res.statusCode, body, answer: content?.[0] !== undefined ? (JSON.parse(content[0].text) as Record<string, unknown>) : null };
    };
    const activeWith = async (marker: string): Promise<number> => {
      const rows = await db.admin.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      return Number(rows[0]?.n ?? 0);
    };
    const servers = () => ['pg', ...(TOOLBOX_BIN !== '' ? ['pg-tb'] : [])];

    it('probe 03/04: SET, DDL, DML, two statements, settings, file and large-object functions are refused before anything runs', async () => {
      for (const server of servers()) {
        texts.length = 0;
        for (const sql of [
          'SET default_transaction_read_only = off',
          'CREATE TEMP TABLE kd (a int)',
          'UPDATE s.plain SET owner = owner',
          'SELECT 1; SELECT 2',
          "SELECT current_setting('transaction_read_only')",
          'SELECT inet_server_addr(), version()',
          "SELECT pg_read_file('/etc/passwd')",
          "SELECT lo_import('/etc/passwd')",
          'SELECT pg_sleep(20)',
          'SET ROLE postgres',
        ]) {
          const r = await call(server, sql);
          expect(r.answer?.['refused'], `${server}: ${sql}`).toMatch(/^(not_select|statements|function|parse)$/);
        }
        expect(texts, server).toEqual([]);
      }
    });

    it("probe 03: a value-echoing error comes back as its SQLSTATE only", async () => {
      for (const server of servers()) {
        const r = await call(server, "SELECT 'k3-secret-value-123'::int AS x");
        expect(r.answer, server).toMatchObject({ refused: 'source_error', sqlstate: '22P02' });
        expect(JSON.stringify(r.body), server).not.toContain('k3-secret-value-123');
      }
    });

    it('probe 04/04b: 360,000 rows come back capped at 200, and an int8 column keeps its type', async () => {
      for (const server of servers()) {
        texts.length = 0;
        const r = await call(server, 'SELECT a.id, b.note FROM s.wide AS a CROSS JOIN s.wide AS b');
        expect(r.status, `${server}: ${JSON.stringify(r.body)}`).toBe(200);
        expect(r.answer, server).toMatchObject({ rowCount: 200, truncated: true, rowCap: 200 });
        expect(texts[0], server).toMatch(/LIMIT 201$/);
        const n = await call(server, 'SELECT count(*) AS n, max(w.n) AS top FROM s.wide AS w');
        expect(n.answer?.['rows'], server).toEqual([[600, 600000]]);
        if (server === 'pg') expect(n.answer?.['columns']).toEqual([{ name: 'n', type: 'bigint' }, { name: 'top', type: 'bigint' }]);
      }
    });

    it('a one-row 10 MB text cell is cut AT THE SOURCE for a unit on the native runtime', async () => {
      texts.length = 0;
      const r = await call('pg', "SELECT lpad('', 10000000, 'x') AS big, 7::int8 AS n");
      expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
      expect(texts[0]).toContain('pg_catalog.left(q."c1"::pg_catalog.text, 2001)');
      expect(texts[0]).toContain('q."c2"');
      const row = (r.answer?.['rows'] as unknown[][])[0] as [string, number];
      expect(row[0].length).toBe(2001);
      expect(row[1]).toBe(7);
      expect(r.answer?.['truncated']).toBe(true);
    });

    it.skipIf(TOOLBOX_BIN === '')('on the Toolbox runtime the same cell passes the 1 MiB read bound and kills only that process', async () => {
      const mine = sup.current(TB_ID)?.pid ?? null;
      const other = sup.current(NODL_ID)?.pid ?? null;
      expect(mine).not.toBeNull();
      const r = await call('pg-tb', "SELECT lpad('', 10000000, 'x') AS big");
      expect(r.answer).toMatchObject({ refused: 'too_large' });
      const gone = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      };
      for (let i = 0; i < 100 && !gone(mine as number); i++) await new Promise((res) => setTimeout(res, 50));
      expect(gone(mine as number)).toBe(true);
      expect(sup.current(NODL_ID)?.pid).toBe(other);
      // a wide read past the bound too, and then the source answers again
      expect((await call('pg-tb', "SELECT a.id, lpad('', 10000, 'x') AS pad FROM s.wide AS a")).answer).toMatchObject({ refused: 'too_large' });
      expect((await call('pg-tb', 'SELECT count(*) AS n FROM s.wide AS w')).answer).toMatchObject({ rows: [[600]] });
    }, 120_000);

    it('probe 04/05: a slow read is stopped at the deadline, and its work is gone at the source', async () => {
      for (const server of servers()) {
        const marker = `kd_b2_slow_${server.replace(/-/g, '_')}`;
        const started = Date.now();
        const r = await call(server, `SELECT count(*) AS ${marker} FROM s.wide AS a, s.wide AS b, s.wide AS c, s.wide AS d`);
        expect(r.answer, server).toMatchObject({ refused: 'deadline' });
        expect(Date.now() - started, server).toBeLessThan(DEADLINE + 8_000);
        let n = await activeWith(marker);
        for (let i = 0; i < 40 && n > 0; i++) {
          await new Promise((res) => setTimeout(res, 250));
          n = await activeWith(marker);
        }
        expect(n, server).toBe(0);
      }
    }, 120_000);

    it.skipIf(TOOLBOX_BIN === '')('with the timeout parameter removed, a kill holds the source closed until its remote session is confirmed gone', async () => {
      const marker = 'kd_b2_nodl';
      const r = await call('pg-tb-nodl', `SELECT count(*) AS ${marker} FROM s.wide AS a, s.wide AS b, s.wide AS c, s.wide AS d`);
      expect(r.answer).toMatchObject({ refused: 'deadline' });
      // the process is gone, the remote work is not: no source-side deadline stops it
      expect(await activeWith(marker)).toBe(1);
      const sched = gate.schedulers.get(NODL_ID);
      expect(sched?.state()).toMatchObject({ reserved: true, concurrency: 1 });
      expect((await call('pg-tb-nodl', 'SELECT count(*) AS n FROM s.wide AS w')).answer).toMatchObject({ refused: 'remote_work_pending' });
      expect(await sched?.recheck()).toBe(false);
      expect((await call('pg-tb-nodl', 'SELECT count(*) AS n FROM s.wide AS w')).answer).toMatchObject({ refused: 'remote_work_pending' });
      // the session ends at the source (here: its backend is terminated, as a finished query would end)
      await db.admin.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%${marker}%' AND pid <> pg_backend_pid()`);
      for (let i = 0; i < 40 && (await activeWith(marker)) > 0; i++) await new Promise((res) => setTimeout(res, 250));
      expect(await sched?.recheck()).toBe(true);
      expect((await call('pg-tb-nodl', 'SELECT count(*) AS n FROM s.wide AS w')).answer).toMatchObject({ rows: [[600]] });
    }, 120_000);

    it('a parameterized read is prepared with its own parameters', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/mcp/call', payload: { token: 'wmt_g', subject: 'mcp:pg/execute_sql', args: { sql: "SELECT w.id, w.note FROM s.wide AS w WHERE w.id = $1 AND w.note = $2 ORDER BY w.id", params: [7, 'row-7'] } } });
      answers.push(res.body);
      const body = res.json() as McpCallResponse;
      const a = JSON.parse((body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}') as Record<string, unknown>;
      expect(a, res.body.slice(0, 400)).toMatchObject({ rows: [[7, 'row-7']] });
    });

    it.skipIf(TOOLBOX_BIN === '')('a Toolbox source previewed and saved the ordinary way serves reads once a person switches query on', async () => {
      const body = { name: 'pg-tb-saved', kind: 'toolbox-source', runtime: 'toolbox', toolbox: { kind: 'source', type: 'postgres', host: '127.0.0.1', port: String(db.port), user: role, password: '${WICKED_SRC_1}', database: db.database }, tls: { mode: 'disable' }, auth: { ref: 'env:KD_B2_PG_SECRET' }, address: LOOPBACK };
      const p = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers/preview', payload: body });
      expect(p.statusCode, p.body).toBe(200);
      for (const f of SECRET_FORMS) expect(p.body.includes(f)).toBe(false);
      const saved = await app.inject({ method: 'POST', url: '/api/v1/mcp/servers', payload: { previewHash: (p.json() as { previewHash: string }).previewHash } });
      expect(saved.statusCode, saved.body).toBeLessThan(300);
      expect((await app.inject({ method: 'POST', url: '/api/v1/sources/pg-tb-saved/test' })).json()).toMatchObject({ ok: true, tls: 'off' });
      const off = await call('pg-tb-saved', 'SELECT count(*) AS n FROM s.wide AS w');
      expect(off.answer).toMatchObject({ refused: 'unknown_source' });
      expect((await app.inject({ method: 'PUT', url: '/api/v1/sources/pg-tb-saved/agents', payload: { projects: ['proj_g'], query: true } })).statusCode).toBe(200);
      expect((await call('pg-tb-saved', 'SELECT count(*) AS n FROM s.wide AS w')).answer).toMatchObject({ rows: [[600]] });
    }, 120_000);

    it("the person's query runs through the gate (scheduler, LIMIT rewrite) and answers as before", async () => {
      texts.length = 0;
      const sql = 'SELECT p.id, p.owner, p.amount FROM s.plain AS p ORDER BY p.id';
      const check = await app.inject({ method: 'POST', url: '/api/v1/sources/pg/query', payload: { sql } });
      const c = check.json() as SourceQueryResponse & { confirm?: string };
      expect(c).toMatchObject({ ran: false, check: { ok: true } });
      const ran = await app.inject({ method: 'POST', url: '/api/v1/sources/pg/query', payload: { sql, confirm: c.confirm } });
      expect(ran.statusCode, ran.body).toBe(200);
      // As before: the same answer the pre-gate path (K1's readSqlQuery, no rewrite) gives for the same text.
      const catalog = await describePg({ source: { driver: 'postgres', host: DB_HOST, port: db.port, database: db.database, user: role, tls: 'disable' }, password: SECRET, policy: LOOPBACK, dial: { resolver: countingResolver() } });
      const before = await readSqlQuery(
        { driver: 'postgres', connect: { source: { driver: 'postgres', host: DB_HOST, port: db.port, database: db.database, user: role, tls: 'disable' }, password: SECRET, policy: LOOPBACK, dial: { resolver: countingResolver() } }, catalog, viewsAllowed: [] },
        sql,
        [],
        { maxRows: 50 },
      );
      expect(ran.json()).toMatchObject({ ran: true, columns: before.columns, rows: before.rows, truncated: false, rowCap: 50 });
      expect(before.rows).toEqual([[1, 'a', '1.00'], [2, 'b', '2.00']]);
      expect(texts).toEqual([`SELECT * FROM (\n${sql}\n) AS q LIMIT 51`]);
    });

    it('a scan finds the password in no file, log or answer', async () => {
      await audit.flush();
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(base);
      expect(files.length).toBeGreaterThan(2);
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        for (const s of SECRET_FORMS) expect(text.includes(s), `${f} holds the secret`).toBe(false);
      }
      for (const a of answers) for (const s of SECRET_FORMS) expect(a.includes(s)).toBe(false);
      if (TOOLBOX_BIN !== '') for (const s of SECRET_FORMS) expect(sup.current(TB_ID)?.stderr ?? '').not.toContain(s);
    });
  });
}
