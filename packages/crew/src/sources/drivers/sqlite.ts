/**
 * The SQLite driver (DES-APPS-001 §5.1, §5.3, §7.5): uploaded snapshots, read in a CHILD PROCESS.
 *
 * Why a child process: Node's `node:sqlite` exposes no `sqlite3_interrupt` and no progress handler,
 * and `Worker.terminate()` cannot stop native code, so the only way to stop a long statement at its
 * deadline is to end the process running it. The child also keeps a hostile `.sqlite` file's schema
 * parsing out of the daemon's own process.
 *
 * In the child, a snapshot is opened `immutable=1`, `readOnly`, `defensive`, with `query_only` and
 * `trusted_schema = 0`, then the AUTHORIZER (`policy/sqlite.ts`, passed in as its source text so the
 * policy is written once) decides every prepare: SELECT, READ of the snapshot's own tables, and
 * allowlisted functions; everything else — RECURSIVE, ATTACH, PRAGMA — is denied. The statement tail
 * must be empty. Requires Node 24.12+ (`setAuthorizer`, `enableDefensive`); older runtimes refuse.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';

import type { CatalogRelation, SqlCatalog } from '../catalog/types.js';
import { deniedFunction, SQLITE_FUNCTIONS } from '../policy/allowlists.js';
import { sqliteAuthorize, sqliteParams } from '../policy/sqlite.js';
import { type ReadOptions, READ_MAX_ROWS, type SqlDescribe, type SqlReadResult, SourceQueryError, STATEMENT_DEADLINE_MS } from './types.js';

/** The runner: one JSON request on stdin, one JSON answer on stdout. Plain ESM, no imports but node:sqlite. */
const RUNNER = `
import { DatabaseSync, constants } from 'node:sqlite';
const authorize = ${sqliteAuthorize.toString()};
let input = '';
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);
const out = (v) => process.stdout.write(JSON.stringify(v));
try {
  if (typeof DatabaseSync.prototype.setAuthorizer !== 'function' || typeof DatabaseSync.prototype.enableDefensive !== 'function') {
    throw new Error('SQLite sources need Node.js 24.12 or later (the authorizer and defensive mode)');
  }
  const db = new DatabaseSync(req.uri, { readOnly: true, enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false, allowExtension: false });
  db.enableDefensive(true);
  db.exec('PRAGMA query_only = 1; PRAGMA trusted_schema = 0;');
  if (req.op === 'inspect') {
    const objects = db.prepare("SELECT type, name, tbl_name AS tbl, sql FROM sqlite_schema ORDER BY name").all();
    // SQLite's own classification (not the schema text, which a hand-made file can word freely):
    // table, view, virtual or shadow. Through PRAGMA statements, never the table-valued pragma_*
    // functions: an ordinary table of the file named pragma_table_list would shadow those.
    const kinds = new Map(db.prepare('PRAGMA main.table_list').all().filter((r) => r.schema === 'main').map((r) => [r.name, r.type]));
    const tables = [];
    for (const o of objects) {
      if (o.type !== 'table' || String(o.name).startsWith('sqlite_')) continue;
      if (kinds.get(o.name) !== 'table') continue;
      const quoted = '"' + String(o.name).replace(/"/g, '""') + '"';
      const cols = db.prepare('PRAGMA main.table_xinfo(' + quoted + ')').all().map((c) => ({ name: c.name, type: c.type, nn: c.notnull, pk: c.pk, hidden: c.hidden }));
      const count = db.prepare('SELECT count(*) AS c FROM ' + quoted).get().c;
      tables.push({ name: o.name, sql: o.sql, columns: cols, rows: Number(count) });
    }
    out({ ok: true, objects: objects.map((o) => ({ type: o.type, name: o.name, virtual: o.type === 'table' && kinds.get(o.name) !== 'table' && !String(o.name).startsWith('sqlite_') })), tables });
  } else {
    const ctx = { tables: req.tables, functions: req.functions, denied: req.denied };
    db.setAuthorizer((action, a1, a2, dbName, tv) => authorize(constants, ctx, action, a1, a2, dbName, tv));
    let stmt;
    try {
      stmt = db.prepare(req.sql);
    } catch (e) {
      out({ ok: false, refused: true, error: String(e && e.message || e) });
      process.exit(0);
    }
    const norm = (s) => String(s).trim().replace(/;\\s*$/, '').trim();
    if (norm(stmt.sourceSQL) !== norm(req.sql)) {
      out({ ok: false, refused: true, error: 'a query is exactly one statement (the text continues after the first one)' });
      process.exit(0);
    }
    const columns = stmt.columns().map((c) => ({ name: c.name, type: c.type ?? 'expression' }));
    if (req.op === 'prepare') {
      out({ ok: true, columns, params: Array.from({ length: req.paramCount }, () => 'unknown') });
    } else {
      stmt.setReadBigInts(true);
      stmt.setReturnArrays(true);
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate(...req.params)) {
        if (rows.length >= req.maxRows) { truncated = true; break; }
        rows.push(row.map((v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? null : v)));
      }
      out({ ok: true, columns, rows, truncated });
    }
  }
} catch (e) {
  out({ ok: false, error: String(e && e.message || e) });
}
`;

interface RunnerAnswer {
  ok: boolean;
  refused?: boolean;
  error?: string;
  [k: string]: unknown;
}

/** Bytes of the runner's answer the parent reads at most. */
const ANSWER_MAX_BYTES = 64 * 1024 * 1024;

/** TESTS ONLY: told each runner child's pid, so a test can prove the process is gone. */
let onSpawnForTests: ((pid: number) => void) | null = null;
export function observeSqliteRunnerForTests(fn: ((pid: number) => void) | null): void {
  onSpawnForTests = fn;
}

/** Run one request in a fresh child; SIGKILL at the deadline. */
async function runChild(request: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal): Promise<RunnerAnswer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', RUNNER], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    if (child.pid !== undefined) onSpawnForTests?.(child.pid);
    // One decoder for the whole answer: a character split across two pipe chunks stays one character.
    const decoder = new StringDecoder('utf8');
    let stdout = '';
    let size = 0;
    let stderr = '';
    let done = false;
    const finish = (err: unknown, value?: RunnerAnswer): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      if (err !== null) reject(err);
      else resolve(value as RunnerAnswer);
    };
    const timer = setTimeout(() => finish(new SourceQueryError(null, 'timeout', 'the query ran past its deadline; its process was stopped')), deadlineMs);
    signal?.addEventListener('abort', () => finish(new SourceQueryError(null, 'timeout', 'the read was cancelled; its process was stopped')), { once: true });
    child.stdout.on('data', (c: Buffer) => {
      size += c.byteLength;
      if (size > ANSWER_MAX_BYTES) {
        finish(new SourceQueryError(null, 'source', 'the answer is larger than crew reads'));
        return;
      }
      stdout += decoder.write(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2048);
    });
    child.on('error', (err) => finish(new SourceQueryError(null, 'connection', `the SQLite runner could not start: ${err.message}`)));
    child.on('close', () => {
      if (done) return;
      try {
        finish(null, JSON.parse(stdout + decoder.end()) as RunnerAnswer);
      } catch {
        finish(new SourceQueryError(null, 'source', `the SQLite runner failed${stderr === '' ? '' : `: ${stderr.trim()}`}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function snapshotUri(path: string): string {
  return `${pathToFileURL(path).href}?immutable=1`;
}

function policyContext(catalog: SqlCatalog): { tables: string[]; functions: string[]; denied: string[] } {
  const functions = [...SQLITE_FUNCTIONS].filter((f) => !deniedFunction(f));
  return { tables: catalog.relations.map((r) => r.name), functions, denied: ['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer'] };
}

export interface SqliteInspection {
  objects: Array<{ type: string; name: string; virtual: boolean }>;
  /** Generated or hidden columns (`table.column`): a snapshot holding one is refused. */
  generated: string[];
  catalog: SqlCatalog;
}

/** Inspect a snapshot (schema objects and the catalog). No authorizer: crew's own fixed statements. */
export async function sqliteInspect(path: string, deadlineMs = 30_000): Promise<SqliteInspection> {
  const a = await runChild({ op: 'inspect', uri: snapshotUri(path) }, deadlineMs);
  if (!a.ok) throw new SourceQueryError(null, 'source', a.error ?? 'the snapshot could not be read');
  const tables = (a['tables'] as Array<{ name: string; columns: Array<{ name: string; type: string; nn: number; pk: number; hidden: number }>; rows: number }>) ?? [];
  // A generated (or hidden) column runs its stored expression on read, outside the authorizer's view
  // of the query: such a snapshot is refused by the upload, and never described as readable.
  const generated = tables.flatMap((t) => t.columns.filter((c) => c.hidden !== 0).map((c) => `${t.name}.${c.name}`));
  const relations: CatalogRelation[] = tables.map((t) => ({
    schema: null,
    name: t.name,
    kind: 'table',
    rowEstimate: t.rows,
    columns: t.columns.filter((c) => c.hidden === 0).map((c) => ({ name: c.name, type: c.type === '' ? 'ANY' : c.type, nullable: c.nn === 0 })),
    primaryKey: t.columns.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name),
    foreignKeys: [],
  }));
  return { objects: (a['objects'] as SqliteInspection['objects']) ?? [], generated, catalog: { dialect: 'sqlite', database: null, relations, describedAt: new Date().toISOString() } };
}

/** Prepare under the authorizer and describe; never execute. */
export async function sqliteDescribe(path: string, catalog: SqlCatalog, text: string): Promise<SqlDescribe> {
  const p = sqliteParams(text);
  if (!p.ok) throw new SourceQueryError(null, 'refused', p.detail);
  const a = await runChild({ op: 'prepare', uri: snapshotUri(path), sql: text, paramCount: p.count, ...policyContext(catalog) }, STATEMENT_DEADLINE_MS);
  if (!a.ok) throw new SourceQueryError(null, a.refused === true ? 'refused' : 'source', a.error ?? 'the query could not be prepared');
  return { columns: (a['columns'] as SqlDescribe['columns']) ?? [], params: (a['params'] as string[]) ?? [] };
}

/** One read: prepared under the authorizer, run in the child, stopped at the deadline. */
export async function sqliteRead(path: string, catalog: SqlCatalog, text: string, params: unknown[], opts: ReadOptions = {}): Promise<SqlReadResult> {
  const started = Date.now();
  const a = await runChild(
    { op: 'read', uri: snapshotUri(path), sql: text, params, maxRows: opts.maxRows ?? READ_MAX_ROWS, ...policyContext(catalog) },
    opts.deadlineMs ?? STATEMENT_DEADLINE_MS,
    opts.signal,
  );
  if (!a.ok) throw new SourceQueryError(null, a.refused === true ? 'refused' : 'source', a.error ?? 'the read failed');
  return { columns: (a['columns'] as SqlReadResult['columns']) ?? [], rows: (a['rows'] as unknown[][]) ?? [], truncated: a['truncated'] === true, ms: Date.now() - started };
}
