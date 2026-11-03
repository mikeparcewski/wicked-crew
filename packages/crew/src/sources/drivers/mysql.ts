/**
 * The MySQL driver (DES-APPS-001 §5.1, §5.3, §7.5): mysql2 over the ONE dialer.
 *
 * - The connection's stream is a `dialTcp` socket (resolved once, every address checked, pinned);
 *   TLS is VERIFY_IDENTITY against the hostname unless the person allowed plaintext for the address.
 * - The session pins `sql_mode` (NO_BACKSLASH_ESCAPES, no ANSI_QUOTES, no PIPES_AS_CONCAT), so the
 *   server reads query text the way the read policy's grammar did, and `max_execution_time`.
 * - A read runs in `START TRANSACTION READ ONLY` as a server-side prepared statement (parameter values
 *   never become SQL). The deadline is enforced at the source (`max_execution_time`) AND by
 *   `KILL QUERY` from a second connection, which also covers statements the server does not time.
 * - A connection is discarded after any error (§5.1): every call opens its own and closes it.
 * - `describe` is COM_STMT_PREPARE: columns and parameter count, never executed.
 */

import type { Socket } from 'node:net';

import mysql2 from 'mysql2';
import { createConnection, type Connection, type FieldPacket } from 'mysql2/promise';

import { DialRefusedError, dialTcp, plaintextAllowed } from '../dialer.js';
import { type ReadOptions, READ_MAX_ROWS, type SqlConnectArgs, type SqlDescribe, type SqlReadResult, SourceQueryError, STATEMENT_DEADLINE_MS } from './types.js';

/** The session's SQL mode: MySQL 8's defaults plus NO_BACKSLASH_ESCAPES; no ANSI_QUOTES, no PIPES_AS_CONCAT. */
export const MYSQL_SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,NO_BACKSLASH_ESCAPES';

/**
 * Storage engines whose rows live in this server. Any other engine (FEDERATED reads another server;
 * an engine this list does not know) is treated as foreign: never read (fail closed).
 */
const LOCAL_ENGINES = new Set(['INNODB', 'MYISAM', 'MEMORY', 'ARCHIVE', 'CSV', 'MRG_MYISAM', 'BLACKHOLE', 'NDB', 'NDBCLUSTER', 'TEMPTABLE', 'PERFORMANCE_SCHEMA']);

/** A relation's kind from `information_schema.TABLES` (`TABLE_TYPE`, `ENGINE`), for the catalog and the live check alike. */
export function mysqlRelationKind(tableType: string, engine: string | null): 'table' | 'view' | 'foreign' | 'other' {
  if (tableType === 'VIEW' || tableType === 'SYSTEM VIEW') return 'view';
  if (tableType !== 'BASE TABLE') return 'other';
  return engine !== null && LOCAL_ENGINES.has(engine.toUpperCase()) ? 'table' : 'foreign';
}

/** A column type code as its MySQL name (`LONGLONG`, `NEWDECIMAL`, `VAR_STRING`, …). */
function typeName(f: { columnType?: number; type?: number }): string {
  const code = f.columnType ?? f.type;
  const names = (mysql2 as unknown as { Types: Record<number, string> }).Types;
  return code === undefined ? 'unknown' : (names[code] ?? String(code));
}

async function dialedSocket(args: SqlConnectArgs, pin: string | null): Promise<{ socket: Socket; address: string }> {
  const { source, policy, dial } = args;
  const { socket, target } = await dialTcp(pin ?? source.host, source.port, policy, dial ?? {});
  if (source.tls === 'disable' && !plaintextAllowed(target.cls, policy)) {
    socket.destroy();
    throw new DialRefusedError('plaintext_refused', `a MySQL connection without TLS to ${source.host} (${target.address}) is refused: use TLS (VERIFY_IDENTITY), or confirm this ${target.cls} range as plaintext`);
  }
  // TLS checks the certificate against the socket's host when mysql2 sends no server name (it sends
  // none for an IP literal): make that the source's own host, never the dialled address or `localhost`.
  (socket as Socket & { _host?: string })._host = source.host;
  return { socket, address: target.address };
}

/** One connection for one source, session pinned. The caller ends it. */
/**
 * One connection for one source, session pinned. The caller ends it. `pin` dials exactly that
 * (already checked) address: the KILL QUERY connection must reach the server running the query.
 */
export async function mysqlConnect(args: SqlConnectArgs, deadlineMs = STATEMENT_DEADLINE_MS, pin: string | null = null): Promise<Connection & { crewAddress?: string }> {
  const { source, password } = args;
  if (source.driver !== 'mysql') throw new Error('mysqlConnect is for a mysql source');
  const { socket: stream, address } = await dialedSocket(args, pin);
  let conn: Connection;
  try {
    conn = await createConnection({
      // The NAME, for TLS's server name; the bytes go over the dialled stream.
      host: source.host,
      port: source.port,
      user: source.user,
      password: password ?? '',
      database: source.database,
      stream,
      ...(source.tls === 'disable' ? {} : { ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2', ...(source.ca != null ? { ca: source.ca } : {}) } }),
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      connectTimeout: 10_000,
      flags: ['-LOCAL_FILES', '-MULTI_STATEMENTS'],
    });
  } catch (err) {
    stream.destroy();
    throw mysqlError(err);
  }
  try {
    // max_execution_time stops a SELECT at the source; lock_wait_timeout stops a wait on a metadata or
    // table lock, which max_execution_time does not cover (seconds, rounded up).
    await conn.query(
      `SET SESSION sql_mode = '${MYSQL_SQL_MODE}', SESSION max_execution_time = ${Math.max(1, Math.floor(deadlineMs))}, SESSION lock_wait_timeout = ${Math.max(1, Math.ceil(deadlineMs / 1000))}`,
    );
    await conn.query('SET SESSION TRANSACTION READ ONLY');
  } catch (err) {
    conn.destroy();
    throw mysqlError(err);
  }
  return Object.assign(conn, { crewAddress: address });
}

export function mysqlError(err: unknown): SourceQueryError {
  if (err instanceof SourceQueryError) return err;
  if (err instanceof DialRefusedError) return new SourceQueryError(null, 'refused', err.message, err.code);
  const e = err as { errno?: unknown; sqlState?: unknown; code?: unknown; message?: unknown };
  const message = typeof e?.message === 'string' ? e.message : String(err);
  const sqlstate = typeof e?.sqlState === 'string' ? e.sqlState : null;
  // 3024: ER_QUERY_TIMEOUT (max_execution_time); 1317: ER_QUERY_INTERRUPTED (KILL QUERY).
  if (e?.errno === 3024 || e?.errno === 1317) return new SourceQueryError(sqlstate ?? 'HY000', 'timeout', 'the query ran past its deadline and was stopped at the source');
  if (typeof e?.errno === 'number') return new SourceQueryError(sqlstate, 'source', message);
  return new SourceQueryError(null, 'connection', message);
}

/** Describe `text` with COM_STMT_PREPARE: never executed. Its relations are checked live first (as a read's). */
export async function mysqlDescribe(args: SqlConnectArgs, text: string, expect?: readonly MysqlRelationExpectation[]): Promise<SqlDescribe> {
  const conn = await mysqlConnect(args);
  // A prepare can wait on a metadata lock: the deadline ends it (the connection is dropped).
  let timedOut = false;
  const guard = setTimeout(() => {
    timedOut = true;
    conn.destroy();
  }, STATEMENT_DEADLINE_MS);
  try {
    if (expect !== undefined) await mysqlExpectRelations(conn, expect);
    const stmt = await conn.prepare(text);
    try {
      const info = (stmt as unknown as { statement: { columns?: Array<FieldPacket & { columnType?: number }>; parameters?: unknown[] } }).statement;
      return {
        columns: (info.columns ?? []).map((c) => ({ name: c.name, type: typeName(c) })),
        params: (info.parameters ?? []).map(() => 'unknown'),
      };
    } finally {
      await stmt.close();
    }
  } catch (err) {
    if (timedOut) throw new SourceQueryError(null, 'timeout', 'describing the query ran past its deadline');
    throw mysqlError(err);
  } finally {
    clearTimeout(guard);
    conn.destroy();
  }
}

/** How long the KILL QUERY connection (and then the KILL) may take before the read's connection is dropped. */
const KILL_CONNECT_MS = 3_000;

/** What a read expects of its relations, checked live before it runs (as drivers/postgres.ts). */
export interface MysqlRelationExpectation {
  schema: string;
  name: string;
  kinds: ReadonlyArray<'table' | 'view'>;
}

async function mysqlExpectRelations(conn: Connection, expect: readonly MysqlRelationExpectation[]): Promise<void> {
  for (const e of expect) {
    const [rows] = (await conn.execute('SELECT TABLE_TYPE AS t, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [e.schema, e.name])) as unknown as [
      Array<{ t: string; engine: string | null }>,
    ];
    const row = rows[0];
    const kind = row === undefined ? null : mysqlRelationKind(row.t, row.engine);
    if (kind === null || !(e.kinds as readonly string[]).includes(kind)) throw new SourceQueryError(null, 'refused', `${e.schema}.${e.name} changed at the source (it is ${kind ?? 'gone'} now): describe the source again`);
  }
}

/**
 * Run one read (the policy has already passed). READ ONLY, prepared, `max_execution_time` at the
 * source, and `KILL QUERY` from a second dialled connection at the deadline.
 */
export async function mysqlRead(args: SqlConnectArgs, text: string, params: unknown[], opts: ReadOptions & { expect?: readonly MysqlRelationExpectation[] } = {}): Promise<SqlReadResult> {
  const deadlineMs = opts.deadlineMs ?? STATEMENT_DEADLINE_MS;
  const maxRows = opts.maxRows ?? READ_MAX_ROWS;
  const started = Date.now();
  const conn = await mysqlConnect(args, opts.sourceTimeoutMs ?? deadlineMs);
  let killed = false;
  let ended = false;
  const kill = async (): Promise<void> => {
    if (killed || ended) return;
    killed = true;
    // The KILL connection goes to the very address the read runs on, and gives up quickly; when it
    // cannot be had, the read's own connection is dropped as the last resort. A killer connection that
    // arrives after the race was lost is closed at once, never left holding a server slot.
    let raceOver = false;
    const attempt = mysqlConnect(args, 5_000, conn.crewAddress ?? null).then(
      (c) => {
        if (raceOver) {
          c.destroy();
          return null;
        }
        return c;
      },
      () => null,
    );
    const killer = await Promise.race([attempt, new Promise<null>((r) => setTimeout(() => r(null), KILL_CONNECT_MS).unref())]);
    raceOver = true;
    if (killer === null || ended) {
      killer?.destroy();
      conn.destroy();
      return;
    }
    try {
      // The KILL itself is bounded too: a killer that hangs drops the read's connection instead.
      const sent = killer.query(`KILL QUERY ${Math.trunc(conn.threadId)}`).then(() => true);
      const ok = await Promise.race([sent, new Promise<false>((r) => setTimeout(() => r(false), KILL_CONNECT_MS).unref())]);
      if (!ok) conn.destroy();
    } catch {
      conn.destroy(); // the query may have just ended; either way it is not left running on our side
    } finally {
      killer.destroy();
    }
  };
  const guard = setTimeout(() => void kill(), deadlineMs);
  opts.signal?.addEventListener('abort', () => void kill(), { once: true });
  try {
    await conn.query('START TRANSACTION READ ONLY');
    if (opts.expect !== undefined) await mysqlExpectRelations(conn, opts.expect);
    // Streamed: rows past the cap are never held; the query is stopped at the source once it is hit.
    const core = (conn as unknown as { connection: { execute: (o: unknown, p: unknown) => NodeJS.EventEmitter } }).connection;
    const { rows, fields, truncated } = await new Promise<{ rows: unknown[][]; fields: FieldPacket[]; truncated: boolean }>((resolve, reject) => {
      const rows: unknown[][] = [];
      let fields: FieldPacket[] = [];
      let truncated = false;
      const q = core.execute({ sql: text, rowsAsArray: true }, params);
      q.on('fields', (f: FieldPacket[]) => {
        fields = f;
      });
      q.on('result', (row: unknown[]) => {
        if (rows.length >= maxRows) {
          if (!truncated) {
            truncated = true;
            void kill();
          }
          return;
        }
        rows.push(row);
      });
      q.on('error', (err: unknown) => (truncated ? resolve({ rows, fields, truncated }) : reject(err)));
      q.on('end', () => resolve({ rows, fields, truncated }));
    });
    if (!truncated) await conn.query('COMMIT');
    return {
      columns: (fields ?? []).map((f) => ({ name: f.name, type: typeName(f as { columnType?: number }) })),
      rows,
      truncated,
      ms: Date.now() - started,
    };
  } catch (err) {
    if (killed && Date.now() - started >= deadlineMs) throw new SourceQueryError('70100', 'timeout', 'the query ran past its deadline and was stopped at the source (KILL QUERY)');
    throw mysqlError(err);
  } finally {
    ended = true;
    clearTimeout(guard);
    conn.destroy();
  }
}
