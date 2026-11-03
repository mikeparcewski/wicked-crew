/**
 * One SQL source, checked and read through the read policy FIRST (DES-APPS-001 §5.3: "A read must pass
 * it before it reaches the source, at check time and at every run").
 *
 * - {@link checkSqlQuery}: the per-kind source check — the policy, then prepare/describe on the source
 *   (Postgres Parse/Describe, MySQL COM_STMT_PREPARE, SQLite prepare under the authorizer), never
 *   execute. Answers the output columns and the parameter types the source inferred.
 * - {@link readSqlQuery}: the policy, then one read with the deadline and the row cap.
 *
 * A refused query never opens a connection (the tests count dials).
 */

import { policyCatalog, type SqlCatalog } from './catalog/types.js';
import { mysqlDescribe, mysqlRead } from './drivers/mysql.js';
import { pgDescribe, pgRead } from './drivers/postgres.js';
import { sqliteDescribe, sqliteRead } from './drivers/sqlite.js';
import type { ReadOptions, SqlConnectArgs, SqlDescribe, SqlReadResult } from './drivers/types.js';
import { checkReadPolicy, type PolicyResult } from './policy/index.js';

export type SqlSourceHandle =
  | { driver: 'postgres' | 'mysql'; connect: SqlConnectArgs; catalog: SqlCatalog; viewsAllowed: readonly string[] }
  | { driver: 'sqlite'; snapshotPath: string; catalog: SqlCatalog };

/** A query the read policy refused; nothing reached the source. */
export class SourcePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SourcePolicyError';
  }
}

async function policy(h: SqlSourceHandle, text: string): Promise<Extract<PolicyResult, { ok: true }>> {
  const r = await checkReadPolicy(h.driver, text, policyCatalog(h.catalog, h.driver === 'sqlite' ? [] : h.viewsAllowed));
  if (!r.ok) throw new SourcePolicyError(r.code, r.detail);
  return r;
}

export type SqlCheckResult = { ok: true; describe: SqlDescribe; relations: string[] } | { ok: false; code: string; detail: string };

/** The per-kind source check: policy, then prepare/describe. Never executes the query. */
export async function checkSqlQuery(h: SqlSourceHandle, text: string): Promise<SqlCheckResult> {
  let relations: string[];
  try {
    relations = (await policy(h, text)).relations;
  } catch (err) {
    if (err instanceof SourcePolicyError) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
  if (h.driver === 'sqlite') return { ok: true, describe: await sqliteDescribe(h.snapshotPath, h.catalog, text), relations };
  return { ok: true, describe: h.driver === 'postgres' ? await pgDescribe(h.connect, text) : await mysqlDescribe(h.connect, text), relations };
}

/** One read: the policy, then the driver (deadline at the source, row cap). */
export async function readSqlQuery(h: SqlSourceHandle, text: string, params: unknown[], opts: ReadOptions = {}): Promise<SqlReadResult> {
  await policy(h, text);
  if (h.driver === 'sqlite') return sqliteRead(h.snapshotPath, h.catalog, text, params, opts);
  return h.driver === 'postgres' ? pgRead(h.connect, text, params, opts) : mysqlRead(h.connect, text, params, opts);
}
