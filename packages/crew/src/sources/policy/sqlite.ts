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

/** SQLite's identifier characters: ASCII letters, digits, `_`, `$` and every character above U+007F. */
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

/**
 * The parameters of a SQLite read, counted by lexing the text (strings, quoted names and comments
 * skipped): only anonymous `?` placeholders are accepted, so the count is the bind count. Numbered
 * (`?5`) and named (`:x`, `:1`, `@x`, `$x`, any spelling) placeholders are refused. The statement
 * must begin with `SELECT` or `WITH` (no `VALUES`, no `EXPLAIN`): the authorizer judges what is
 * read, this judges what kind of statement it is.
 */
export function sqliteParams(text: string): { ok: true; count: number } | { ok: false; code: 'params' | 'not_select'; detail: string } {
  let count = 0;
  let i = 0;
  let first: string | null = null;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (first === null && /[A-Za-z]/.test(c)) {
      first = (/^[A-Za-z]+/.exec(text.slice(i)) as RegExpExecArray)[0].toUpperCase();
      if (first !== 'SELECT' && first !== 'WITH') return { ok: false, code: 'not_select', detail: `${first} is not a read; only SELECT (or WITH … SELECT) is` };
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return { ok: false, code: 'params', detail: 'an unterminated quoted string or name' };
      i = end + 1;
      continue;
    }
    if (c === '[') {
      const end = text.indexOf(']', i + 1);
      if (end < 0) return { ok: false, code: 'params', detail: 'an unterminated [name]' };
      i = end + 1;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '?') {
      if (/[0-9]/.test(text[i + 1] ?? '')) return { ok: false, code: 'params', detail: 'numbered placeholders (?N) are refused; use ? in order' };
      count++;
      i++;
      continue;
    }
    // `:` and `@` mean nothing else outside a string; `$` inside a name (`a$b`) is part of the name.
    if (c === ':' || c === '@' || (c === '$' && !IDENT_CHAR.test(text[i - 1] ?? ' '))) return { ok: false, code: 'params', detail: `named placeholders (${c}name) are refused; use ? in order` };
    i++;
  }
  if (first === null) return { ok: false, code: 'not_select', detail: 'an empty statement' };
  return { ok: true, count };
}

/** A hint in crew's words for a WITH read refused by SQLite's authorizer. */
export function sqliteCteHint(text: string): string | null {
  return /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*WITH\b/i.test(text)
    ? 'a WITH clause that reads a table is refused here (use a subquery in FROM)'
    : null;
}
