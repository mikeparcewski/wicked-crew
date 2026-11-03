/**
 * The SQLite half of the read policy (DES-APPS-001 §5.3 rules 1 and 5). SQLite has no AST to walk,
 * so the rules are enforced by the AUTHORIZER while the statement is prepared: `SQLITE_SELECT`,
 * `SQLITE_READ` of a table of the snapshot's `main` database (not through a view or trigger), and an
 * allowlisted `SQLITE_FUNCTION` are allowed; everything else is denied, `SQLITE_RECURSIVE`,
 * `SQLITE_ATTACH` and `SQLITE_PRAGMA` included. The statement tail must be empty (one statement).
 *
 * {@link sqliteAuthorize} is pure and self-contained on purpose: the snapshot runner
 * (`drivers/sqlite.ts`) runs in a child process and receives this function's source text, so the
 * policy is written once.
 */

export interface SqliteAuthorizerContext {
  /** The snapshot's own tables (the only relations a read may touch). */
  tables: string[];
  /** Allowed function names, lower case (`allowlists.ts` SQLITE_FUNCTIONS). */
  functions: string[];
  /** Denied function names, lower case (checked first). */
  denied: string[];
}

/** One authorizer decision. `c` is `node:sqlite`'s `constants`. Answers SQLITE_OK or SQLITE_DENY. */
export function sqliteAuthorize(
  c: Record<string, number>,
  ctx: SqliteAuthorizerContext,
  action: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  triggerOrView: string | null,
): number {
  const OK = c['SQLITE_OK'] as number;
  const DENY = c['SQLITE_DENY'] as number;
  if (action === c['SQLITE_SELECT']) return OK;
  if (action === c['SQLITE_READ']) {
    // SQLite names no database for a table read without a column (count(*)); only `main` exists here
    // (ATTACH is denied, and nothing can be created in `temp`), so a null database is `main`.
    if ((dbName !== null && dbName !== 'main') || triggerOrView !== null) return DENY;
    return arg1 !== null && ctx.tables.includes(arg1) ? OK : DENY;
  }
  if (action === c['SQLITE_FUNCTION']) {
    const name = String(arg2 ?? '').toLowerCase();
    if (ctx.denied.includes(name)) return DENY;
    return ctx.functions.includes(name) ? OK : DENY;
  }
  return DENY;
}
