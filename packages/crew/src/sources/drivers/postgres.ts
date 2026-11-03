/**
 * The Postgres driver (DES-APPS-001 §5.1, §5.3, §7.5): postgres.js over the ONE dialer.
 *
 * - Every connection (and every cancel request, which postgres.js opens as a new connection) is a
 *   `dialTcp` socket: resolved once, every address checked, pinned. TLS is `verify-full` (certificate
 *   and hostname verified against the name, not the pinned address) unless the person allowed
 *   plaintext for this address (loopback, or a private range confirmed as plaintext).
 * - Every session starts with `search_path = pg_catalog, pg_temp`, `standard_conforming_strings =
 *   on` (libpg_query reads strings that way; the server must too), `default_transaction_read_only`
 *   and `statement_timeout` as startup parameters. A read runs in a `READ ONLY` transaction.
 * - The deadline is enforced AT THE SOURCE (`statement_timeout`), and a client guard just after it
 *   sends a cancel and closes the connection, so a stuck read never outlives it (S11).
 * - `describe` is Parse + Describe: the statement is prepared, never executed.
 * - The daemon's own `PG*` environment never reaches a source (no password fallback).
 */

import { isIP } from 'node:net';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

import postgres from 'postgres';

import { DialRefusedError, dialTcp, plaintextAllowed } from '../dialer.js';
import { type ReadOptions, READ_MAX_ROWS, type SqlConnectArgs, type SqlDescribe, type SqlReadResult, SourceQueryError, STATEMENT_DEADLINE_MS } from './types.js';

export type PgSql = postgres.Sql<Record<string, never>>;

/** Startup parameters every crew session to a Postgres source carries. */
function sessionParameters(deadlineMs: number): Record<string, string> {
  return {
    application_name: 'wicked-crew',
    search_path: 'pg_catalog, pg_temp',
    standard_conforming_strings: 'on',
    default_transaction_read_only: 'on',
    statement_timeout: String(deadlineMs),
    idle_in_transaction_session_timeout: String(deadlineMs + 5_000),
  };
}

/** Date and time values arrive as the server's text (no JS Date: it would drop microseconds and zones). */
const TEXT_TYPES = { crewText: { to: 25, from: [1082, 1083, 1114, 1184, 1266, 1186], serialize: (x: unknown) => String(x), parse: (x: string) => x } };

/**
 * A postgres.js client for one source, one connection, closed by the caller (`end`). `readOnly`
 * false is for the row-write path (K2b), which opens its own transaction; reads never use it.
 */
export function pgClient(args: SqlConnectArgs, opts: { deadlineMs?: number; readOnly?: boolean } = {}): PgSql {
  const { source, password, policy, dial } = args;
  if (source.driver !== 'postgres') throw new Error('pgClient is for a postgres source');
  const deadlineMs = opts.deadlineMs ?? STATEMENT_DEADLINE_MS;
  // The first connection's checked address. Every later one (postgres.js opens a NEW connection to
  // send a cancel) goes to exactly that address, still under the policy, never resolving the name
  // again: a cancel must reach the backend that runs the query.
  let pinned: string | null = null;
  const params = sessionParameters(deadlineMs);
  if (opts.readOnly === false) delete params['default_transaction_read_only'];
  // verify-full: the chain AND the name. The identity is checked against the host the person gave
  // (a DNS name, or an IP literal against the certificate's IP SAN), never the dialled address; SNI
  // carries a DNS name only (TLS forbids an IP there).
  const ssl =
    source.tls === 'disable'
      ? false
      : {
          ...(isIP(source.host) === 0 ? { servername: source.host } : {}),
          checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(source.host, cert),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2' as const,
          ...(source.ca != null ? { ca: source.ca } : {}),
        };
  const options = {
    host: source.host,
    port: source.port,
    database: source.database,
    user: source.user,
    // A function, so postgres.js never falls back to the daemon's PGPASSWORD for an empty password.
    pass: () => password ?? '',
    ssl,
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 5,
    connect_timeout: 10,
    max_lifetime: 60,
    onnotice: () => undefined,
    connection: params,
    types: TEXT_TYPES as never,
    socket: async () => {
      const { socket, target } = await dialTcp(pinned ?? source.host, source.port, policy, dial ?? {});
      pinned ??= target.address;
      if (source.tls === 'disable' && !plaintextAllowed(target.cls, policy)) {
        socket.destroy();
        throw new DialRefusedError(
          'plaintext_refused',
          `a Postgres connection without TLS to ${source.host} (${target.address}) is refused: use TLS (verify-full), or confirm this ${target.cls} range as plaintext`,
        );
      }
      return socket;
    },
  };
  // `socket` (a connection factory) is a documented postgres.js option its types do not declare.
  return postgres(options as unknown as postgres.Options<Record<string, never>>) as unknown as PgSql;
}

/** Map a postgres.js / server error to a {@link SourceQueryError}. */
export function pgError(err: unknown): SourceQueryError {
  if (err instanceof SourceQueryError) return err;
  if (err instanceof DialRefusedError) return new SourceQueryError(null, 'refused', err.message, err.code);
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e?.code === 'string' ? e.code : null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  if (code === '57014') return new SourceQueryError(code, 'timeout', 'the query ran past its deadline and was cancelled at the source');
  if (code !== null && /^[0-9A-Z]{5}$/.test(code)) return new SourceQueryError(code, 'source', message);
  return new SourceQueryError(null, 'connection', message);
}

async function closeQuietly(sql: PgSql): Promise<void> {
  await sql.end({ timeout: 1 }).catch(() => undefined);
}

/** Run `fn` inside a READ ONLY transaction with `search_path = pg_catalog, pg_temp` set locally too. */
export async function pgReadOnly<T>(args: SqlConnectArgs, fn: (tx: postgres.TransactionSql<Record<string, never>>) => Promise<T>, opts: { deadlineMs?: number } = {}): Promise<T> {
  const sql = pgClient(args, opts);
  try {
    return (await sql.begin('read only', async (tx) => {
      await tx.unsafe('SET LOCAL search_path = pg_catalog, pg_temp');
      return fn(tx);
    })) as T;
  } catch (err) {
    throw pgError(err);
  } finally {
    await closeQuietly(sql);
  }
}

/** The text names of type oids, read from the source's own catalog. */
async function typeNames(tx: postgres.TransactionSql<Record<string, never>>, oids: number[]): Promise<Map<number, string>> {
  if (oids.length === 0) return new Map();
  const rows = await tx.unsafe<Array<{ oid: string; name: string }>>(
    'SELECT t.oid::pg_catalog.int8::pg_catalog.text AS oid, pg_catalog.format_type(t.oid, NULL) AS name FROM pg_catalog.pg_type t WHERE t.oid = ANY($1::pg_catalog.text::pg_catalog.oid[])',
    [`{${oids.map((o) => String(Math.trunc(o))).join(',')}}`] as never,
  );
  return new Map(rows.map((r) => [Number(r.oid), r.name]));
}

/**
 * Prepare `text` and describe it (columns and the parameter types the server inferred, from
 * unspecified types). Parse + Describe only: the statement never executes. Its relations are checked
 * live first, as a read's are (a table replaced by a view since the describe is refused here too).
 */
export async function pgDescribe(args: SqlConnectArgs, text: string, expect?: readonly RelationExpectation[]): Promise<SqlDescribe> {
  return pgReadOnly(args, async (tx) => {
    if (expect !== undefined) await pgExpectRelations(tx, expect);
    const d = (await tx.unsafe(text).describe()) as unknown as { types: number[]; columns: Array<{ name: string; type: number }> | null };
    const cols = d.columns ?? [];
    const names = await typeNames(tx, [...new Set([...d.types, ...cols.map((c) => c.type)])]);
    return {
      columns: cols.map((c) => ({ name: c.name, type: names.get(c.type) ?? `oid ${c.type}` })),
      params: d.types.map((t) => names.get(t) ?? `oid ${t}`),
    };
  });
}

/** What a read expects of its relations (from the stored catalog), checked live before it runs. */
export interface RelationExpectation {
  schema: string;
  name: string;
  /** The kinds the policy judged acceptable for it. */
  kinds: ReadonlyArray<'table' | 'partitioned' | 'view' | 'matview'>;
  /** A plain read of it must not reach a foreign table (it was read without ONLY). */
  noForeignBelow: boolean;
}

/** `"schema"."name"`, quoted for SQL. */
const qualified = (schema: string, name: string): string => `"${schema.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`;

/**
 * Before a read runs, every relation it names is checked against the live catalog: still there,
 * still of an accepted kind (a table since replaced by a view or a foreign table is refused), and,
 * when read without ONLY, with no foreign table among its partitions or children. The stored catalog
 * the policy used may be stale; the source's own catalog is not.
 *
 * Each relation is LOCKed (ACCESS SHARE, what the read takes anyway) before it is checked, and the
 * lock is held to the end of the transaction: a concurrent DROP, RENAME or CREATE OR REPLACE waits
 * for the read, so the relation checked is the one the statement reads.
 */
async function pgExpectRelations(tx: postgres.TransactionSql<Record<string, never>>, expect: readonly RelationExpectation[]): Promise<void> {
  for (const e of expect) {
    try {
      // LOCK takes tables, partitioned tables and views; a materialized view is checked unlocked.
      if (!e.kinds.includes('matview')) await tx.unsafe(`LOCK TABLE ${qualified(e.schema, e.name)} IN ACCESS SHARE MODE`);
    } catch (err) {
      // Gone (42P01), or now a kind LOCK refuses, such as a foreign table (42809): changed.
      if ((err as { code?: unknown })?.code === '42P01' || (err as { code?: unknown })?.code === '42809') {
        throw new SourceQueryError(null, 'refused', `${e.schema}.${e.name} changed at the source (it is gone or no longer a table): describe the source again`);
      }
      throw err;
    }
    const rows = await tx.unsafe<Array<{ relkind: string; foreign_below: boolean }>>(
      `WITH RECURSIVE t AS (
         SELECT c.oid, c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2
       ), d(child) AS (
         SELECT i.inhrelid FROM pg_catalog.pg_inherits i JOIN t ON i.inhparent = t.oid
         UNION SELECT i.inhrelid FROM d JOIN pg_catalog.pg_inherits i ON i.inhparent = d.child
       )
       SELECT t.relkind::pg_catalog.text AS relkind,
              EXISTS (SELECT 1 FROM d JOIN pg_catalog.pg_class c ON c.oid = d.child WHERE c.relkind = 'f') AS foreign_below
         FROM t`,
      [e.schema, e.name],
    );
    const live = rows[0];
    const kind = live === undefined ? null : ({ r: 'table', p: 'partitioned', v: 'view', m: 'matview' } as Record<string, string>)[live.relkind] ?? 'other';
    if (kind === null || !(e.kinds as readonly string[]).includes(kind)) {
      throw new SourceQueryError(null, 'refused', `${e.schema}.${e.name} changed at the source (it is ${kind ?? 'gone'} now): describe the source again`);
    }
    if (e.noForeignBelow && live?.foreign_below === true) throw new SourceQueryError(null, 'refused', `${e.schema}.${e.name} now has a foreign table below it: describe the source again`);
  }
}

/**
 * Run one read. The caller has already passed the read policy (§5.3); this is the transport:
 * READ ONLY, the deadline at the source plus a cancel guard, rows capped (`truncated` past the cap).
 */
export async function pgRead(args: SqlConnectArgs, text: string, params: unknown[], opts: ReadOptions & { expect?: readonly RelationExpectation[] } = {}): Promise<SqlReadResult> {
  const deadlineMs = opts.deadlineMs ?? STATEMENT_DEADLINE_MS;
  const maxRows = opts.maxRows ?? READ_MAX_ROWS;
  const started = Date.now();
  const sourceTimeout = opts.sourceTimeoutMs ?? deadlineMs;
  const sql = pgClient(args, { deadlineMs: sourceTimeout });
  let cancelled = false;
  // ONE absolute deadline for the whole read, armed at entry: connecting, BEGIN, the live relation
  // checks, every cursor batch and the type lookup all count (statement_timeout restarts on each
  // statement). At it: a cancel request for the running statement (on a connection pinned to this
  // backend), then the connection closed; before there is a statement, the connection closed at once.
  let q: { cancel: () => unknown } | null = null;
  const stop = (): void => {
    cancelled = true;
    if (q !== null) void Promise.resolve(q.cancel()).catch(() => undefined);
    setTimeout(() => void sql.end({ timeout: 0 }).catch(() => undefined), q === null ? 0 : 1_000).unref();
  };
  const guard = setTimeout(stop, deadlineMs);
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    const out = await sql.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(sourceTimeout))}`);
      if (opts.expect !== undefined) await pgExpectRelations(tx, opts.expect);
      const rows: unknown[][] = [];
      let columns: Array<{ name: string; type: number }> = [];
      let truncated = false;
      const query = tx.unsafe(text, params as never).values();
      q = query;
      await query.cursor(500, (batch) => {
        const b = batch as unknown as unknown[][] & { columns?: Array<{ name: string; type: number }> };
        // Only the first batch carries the columns (later ones may carry none, or null).
        if (Array.isArray(b.columns) && b.columns.length > 0) columns = b.columns;
        for (const r of b) {
          if (rows.length >= maxRows) {
            truncated = true;
            return (sql as unknown as { CLOSE: undefined }).CLOSE;
          }
          rows.push(r);
        }
        return undefined;
      });
      // A read with no rows never calls the cursor back: its columns are on the prepared statement.
      if (columns.length === 0) columns = (query as unknown as { statement?: { columns?: Array<{ name: string; type: number }> } }).statement?.columns ?? [];
      const names = await typeNames(tx, [...new Set(columns.map((c) => c.type))]);
      return { columns: columns.map((c) => ({ name: c.name, type: names.get(c.type) ?? `oid ${c.type}` })), rows, truncated };
    });
    return { ...(out as Omit<SqlReadResult, 'ms'>), ms: Date.now() - started };
  } catch (err) {
    if (cancelled) throw new SourceQueryError('57014', 'timeout', 'the query ran past its deadline and was cancelled at the source');
    throw pgError(err);
  } finally {
    clearTimeout(guard);
    await closeQuietly(sql);
  }
}
