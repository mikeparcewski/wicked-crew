/**
 * The read policy (DES-APPS-001 §5.3) as ONE module, used by the source check (K1) and by the
 * executor (K2b) before any read reaches a source, at check time and at every run:
 *
 * - Postgres: libpg_query + a closed node/function/operator/cast allowlist (`pg.ts`).
 * - MySQL: a hand-written closed-subset grammar (`mysql.ts`).
 * - SQLite: the authorizer at prepare, with an empty statement tail (`sqlite.ts`, run by the snapshot
 *   runner in `drivers/sqlite.ts`); the static half here only refuses what is visible in the text
 *   before SQLite is even opened (more than one statement is caught at prepare).
 */

import { checkMysqlRead } from './mysql.js';
import { checkPgRead } from './pg.js';
import { sqliteParams } from './sqlite.js';
import type { PolicyCatalog, PolicyResult } from './types.js';

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export { checkPgCheckExpression } from './pg.js';
export { sqliteAuthorize, type SqliteAuthorizerContext, sqliteParams } from './sqlite.js';
export type { PolicyCatalog, PolicyRelationKind, PolicyResult } from './types.js';

/** The largest query text the policy reads. */
export const READ_TEXT_MAX_BYTES = 64 * 1024;

/** Check one read's text for `dialect` against the source's catalog. Never connects to the source. */
export async function checkReadPolicy(dialect: SqlDialect, text: string, catalog: PolicyCatalog): Promise<PolicyResult> {
  if (Buffer.byteLength(text, 'utf8') > READ_TEXT_MAX_BYTES) return { ok: false, code: 'too_long', detail: `a query is at most ${READ_TEXT_MAX_BYTES} bytes` };
  if (text.includes('\0')) return { ok: false, code: 'lexical', detail: 'a NUL character is refused in query text' };
  if (dialect === 'postgres') return checkPgRead(text, catalog);
  if (dialect === 'mysql') return checkMysqlRead(text, catalog);
  // SQLite: the authorizer decides at prepare (drivers/sqlite.ts). Statically: the placeholders.
  const p = sqliteParams(text);
  if (!p.ok) return { ok: false, code: 'params', detail: p.detail };
  return { ok: true, relations: [], functions: [], params: p.count };
}
