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
import { type ReadOptions, type SqlConnectArgs, type SqlDescribe, type SqlReadResult, SourceQueryError } from './drivers/types.js';
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

/** The live expectations a read checks before it runs: each relation still of an accepted kind. */
function expectations(h: SqlSourceHandle, keys: readonly string[]): Array<{ schema: string; name: string; kinds: Array<'table' | 'partitioned' | 'view' | 'matview'>; noForeignBelow: boolean }> {
  const pc = policyCatalog(h.catalog, h.driver === 'sqlite' ? [] : h.viewsAllowed);
  return keys.map((k) => {
    const [schema, name] = k.split('\u0000') as [string, string];
    const kind = pc.relations.get(k);
    const kinds: Array<'table' | 'partitioned' | 'view' | 'matview'> = kind === 'view' || kind === 'matview' ? [kind] : ['table', 'partitioned'];
    // A relation the catalog already knows to have a foreign descendant passed the policy only under
    // ONLY; any other must not have gained one since the describe.
    return { schema, name, kinds, noForeignBelow: pc.foreignDescendants?.has(k) !== true };
  });
}

async function policy(h: SqlSourceHandle, text: string): Promise<Extract<PolicyResult, { ok: true }>> {
  const r = await checkReadPolicy(h.driver, text, policyCatalog(h.catalog, h.driver === 'sqlite' ? [] : h.viewsAllowed));
  if (!r.ok) throw new SourcePolicyError(r.code, r.detail);
  return r;
}

export type SqlCheckResult = { ok: true; describe: SqlDescribe; relations: string[] } | { ok: false; code: string; detail: string; sqlstate?: string | null };

/** The per-kind source check: policy, then prepare/describe. Never executes the query. */
export async function checkSqlQuery(h: SqlSourceHandle, text: string): Promise<SqlCheckResult> {
  let relations: string[];
  try {
    relations = (await policy(h, text)).relations;
  } catch (err) {
    if (err instanceof SourcePolicyError) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
  try {
    if (h.driver === 'sqlite') return { ok: true, describe: await sqliteDescribe(h.snapshotPath, h.catalog, text), relations };
    return { ok: true, describe: h.driver === 'postgres' ? await pgDescribe(h.connect, text) : await mysqlDescribe(h.connect, text), relations };
  } catch (err) {
    // The source refused or failed to prepare the text: a check result, not a transport failure. A
    // timeout or a lost connection stays an error.
    if (err instanceof SourceQueryError && (err.errorClass === 'refused' || err.errorClass === 'source')) {
      return { ok: false, code: err.errorClass === 'refused' ? (h.driver === 'sqlite' ? 'authorizer' : (err.refusal ?? 'refused')) : 'prepare', detail: err.message, sqlstate: err.sqlstate };
    }
    throw err;
  }
}

/** One read: the policy, then the driver (deadline at the source, row cap). */
export async function readSqlQuery(h: SqlSourceHandle, text: string, params: unknown[], opts: ReadOptions = {}): Promise<SqlReadResult> {
  const ok = await policy(h, text);
  if (h.driver === 'sqlite') return sqliteRead(h.snapshotPath, h.catalog, text, params, opts);
  const expect = expectations(h, ok.keys ?? []);
  if (h.driver === 'postgres') return pgRead(h.connect, text, params, { ...opts, expect });
  return mysqlRead(h.connect, text, params, { ...opts, expect: expect.map((e) => ({ schema: e.schema, name: e.name, kinds: e.kinds.includes('view') ? ['view'] : ['table'] })) });
}
