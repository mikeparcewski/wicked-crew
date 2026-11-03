/**
 * The SQLite driver (DES-APPS-001 §5.1, §5.3, §7.5): uploaded snapshots, read in a CHILD PROCESS.
 *
 * Why a child process: Node's `node:sqlite` exposes no `sqlite3_interrupt` and no progress handler,
 * and `Worker.terminate()` cannot stop native code, so the only way to stop a long statement at its
 * deadline is to end the process running it. The child also keeps a hostile `.sqlite` file's schema
 * parsing out of the daemon's own process.
 *
 * The child is `runners/sqlite-runner.mjs`, a plain file outside src/: the daemon itself never loads a
 * SQLite library (wicked-core#631); new snapshots are written there too. In the child, a snapshot is
 * opened `immutable=1`, `readOnly`, `defensive`, with `query_only` and `trusted_schema = 0`, then the
 * AUTHORIZER (`policy/sqlite.ts`, sent in each request as its source text so the policy is written
 * once) decides every prepare: SELECT, READ of the snapshot's own tables, and
 * allowlisted functions; everything else — RECURSIVE, ATTACH, PRAGMA — is denied. The statement tail
 * must be empty. Requires Node 24.12+ (`setAuthorizer`, `enableDefensive`); older runtimes refuse.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { CatalogRelation, SqlCatalog } from '../catalog/types.js';
import { deniedFunction, SQLITE_FUNCTIONS } from '../policy/allowlists.js';
import { childEnvWithBootEstateDb, ESTATE_DB_ENGINE_ENV } from '../../core/governance-store.js';
import { sqliteAuthorize, sqliteParams } from '../policy/sqlite.js';
import { type ReadOptions, READ_MAX_ROWS, type SqlDescribe, type SqlReadResult, SourceQueryError, STATEMENT_DEADLINE_MS } from './types.js';

/**
 * The runner: a plain ESM file outside src/ (packages/crew/runners/sqlite-runner.mjs), the same three
 * levels above this module in src/ and in dist/. One JSON request on stdin, one JSON answer on stdout.
 */
const RUNNER_PATH = fileURLToPath(new URL('../../../runners/sqlite-runner.mjs', import.meta.url));

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

/**
 * The runner's environment: none of the daemon's. Routed through the child-env helper like every
 * spawn, then the estate store's variable is dropped as well: the runner reads no store, and a
 * connection string there can carry a credential.
 */
export function runnerEnv(boot?: string): NodeJS.ProcessEnv {
  const env = childEnvWithBootEstateDb({}, ...(boot !== undefined ? [boot] : []));
  delete env[ESTATE_DB_ENGINE_ENV];
  return env;
}

/** Run one request in a fresh child; SIGKILL at the deadline. */
async function runChild(request: Record<string, unknown>, deadlineMs: number, signal?: AbortSignal): Promise<RunnerAnswer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', RUNNER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env: runnerEnv() });
    // A runner ended mid-request (its deadline) closes the pipe under a large write: that EPIPE is the
    // kill's own echo, never an error of the daemon's (an unhandled stream error would end the process).
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
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

function policyContext(catalog: SqlCatalog): { tables: string[]; functions: string[]; denied: string[]; authorizer: string } {
  const functions = [...SQLITE_FUNCTIONS].filter((f) => !deniedFunction(f));
  return { tables: catalog.relations.map((r) => r.name), functions, denied: ['load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer'], authorizer: sqliteAuthorize.toString() };
}

export interface SqliteInspection {
  objects: Array<{ type: string; name: string; virtual: boolean }>;
  /** Generated or hidden columns (`table.column`): a snapshot holding one is refused. */
  generated: string[];
  catalog: SqlCatalog;
}

/**
 * Write a new snapshot at `path` from parsed rows (CSV/XLSX uploads), in the runner: one table, the
 * given column types, one transaction; ended at `deadlineMs`.
 */
export async function sqliteCreate(path: string, table: string, names: string[], types: string[], rows: string[][], deadlineMs: number): Promise<void> {
  const a = await runChild({ op: 'create', path, table, names, types, rows }, deadlineMs);
  if (!a.ok) throw new SourceQueryError(null, 'source', a.error ?? 'the snapshot could not be written');
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
    { op: 'read', uri: snapshotUri(path), sql: text, params, maxRows: opts.maxRows ?? READ_MAX_ROWS, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}), ...(opts.blobsAsHex === true ? { blobs: 'hex' } : {}), ...(opts.cellChars !== undefined ? { cellChars: opts.cellChars } : {}), ...policyContext(catalog) },
    opts.deadlineMs ?? STATEMENT_DEADLINE_MS,
    opts.signal,
  );
  if (!a.ok) throw new SourceQueryError(null, a.refused === true ? 'refused' : 'source', a.error ?? 'the read failed');
  return { columns: (a['columns'] as SqlReadResult['columns']) ?? [], rows: (a['rows'] as unknown[][]) ?? [], truncated: a['truncated'] === true, ms: Date.now() - started };
}
