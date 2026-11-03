/**
 * The MySQL half of the read policy (DES-APPS-001 §5.3): a hand-written grammar of the CLOSED read
 * subset. Anything this grammar does not name is a parse error, which is a refusal, so the subset is
 * closed by construction rather than by walking a permissive parser's tree.
 *
 * The lexer refuses everything where MySQL and this grammar could read the same text differently:
 * backslashes (MySQL escapes in strings unless NO_BACKSLASH_ESCAPES), executable and optimizer-hint
 * comments (`/*!`, `/*+`, which MySQL RUNS), `#` comments, a `--` not followed by whitespace,
 * double-quoted strings (ANSI_QUOTES changes their meaning), `||`/`&&`, user and system variables
 * (`@`), hex/bit/national literals and charset introducers. The session also pins `sql_mode`
 * (drivers/mysql.ts), so the server reads the text the way this file did.
 *
 * Rules (§5.3): one statement, a SELECT (UNION allowed) or a non-recursive WITH … SELECT; no INTO,
 * locking, index hints, partitions or modifiers; functions from the allowlist only, never qualified;
 * casts to scalar types; tables of the described catalog (`db.table`, or a bare name meaning the
 * source's database), views only by name, never another database's tables. Parameters are `?`.
 */

import { deniedFunction, MYSQL_CAST_TYPES, MYSQL_FUNCTIONS } from './allowlists.js';
import type { PolicyCatalog, PolicyResult } from './types.js';

type TokKind = 'ident' | 'qident' | 'num' | 'str' | 'param' | 'op' | 'eof';
interface Tok {
  kind: TokKind;
  /** Upper-cased for `ident` (keywords and names compare case-insensitively); raw otherwise. */
  v: string;
  /** The identifier as written (case kept), for table and column names. */
  raw: string;
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (code: string, message: string): never => {
  throw new Refusal(code, message);
};

const OPS = ['<=>', '<>', '!=', '<=', '>=', '(', ')', ',', '.', '*', '+', '-', '/', '%', '=', '<', '>', ';'];

function lex(text: string): Tok[] {
  if (text.includes('\\')) refuse('lexical', 'a backslash is refused in MySQL query text (MySQL and the checker could read it differently); pass the value as a parameter');
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      if (text[i + 2] === '!' || text[i + 2] === '+') refuse('lexical', 'executable (/*! … */) and optimizer-hint (/*+ … */) comments are refused: MySQL runs them');
      const end = text.indexOf('*/', i + 2);
      if (end < 0) refuse('lexical', 'an unterminated comment');
      i = end + 2;
      continue;
    }
    if (c === '-' && text[i + 1] === '-') {
      if (!/[\s]/.test(text[i + 2] ?? '\n')) refuse('lexical', 'a "--" not followed by a space is refused (MySQL reads it as two minus signs, not a comment)');
      const end = text.indexOf('\n', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '#') refuse('lexical', '# comments are refused; use /* … */ or "-- "');
    if (c === '"') refuse('lexical', 'double-quoted strings are refused (their meaning depends on ANSI_QUOTES); use single quotes for strings and backticks for names');
    if (c === '@') refuse('lexical', 'user and system variables (@…) are refused');
    if (c === "'") {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= n) refuse('lexical', 'an unterminated string');
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            v += "'";
            j += 2;
            continue;
          }
          break;
        }
        v += text[j];
        j++;
      }
      out.push({ kind: 'str', v, raw: v });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= n) refuse('lexical', 'an unterminated `name`');
        if (text[j] === '`') {
          if (text[j + 1] === '`') {
            v += '`';
            j += 2;
            continue;
          }
          break;
        }
        v += text[j];
        j++;
      }
      if (v === '') refuse('lexical', 'an empty `name`');
      out.push({ kind: 'qident', v, raw: v });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i)) as RegExpExecArray;
      const after = text[i + m[0].length] ?? '';
      if (/[A-Za-z_$]/.test(after) || (c === '0' && /^0[xXbB]/.test(text.slice(i, i + 2)))) refuse('lexical', 'hex, bit and digit-led names are refused');
      out.push({ kind: 'num', v: m[0], raw: m[0] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i)) as RegExpExecArray;
      const word = m[0];
      if (text[i + word.length] === "'") refuse('lexical', `${word}'…' literals and charset introducers are refused`);
      out.push({ kind: 'ident', v: word.toUpperCase(), raw: word });
      i += word.length;
      continue;
    }
    if (c === '?') {
      out.push({ kind: 'param', v: '?', raw: '?' });
      i++;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op === undefined) refuse('lexical', `the character ${JSON.stringify(c)} (or the operator it starts) is outside the read subset`);
    out.push({ kind: 'op', v: op as string, raw: op as string });
    i += (op as string).length;
  }
  out.push({ kind: 'eof', v: '', raw: '' });
  return out;
}

/** Words that are never a bare name here (MySQL reserves them, or they change what a statement does). */
const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'EXCEPT', 'INTERSECT', 'INTO', 'FOR', 'LOCK',
  'PROCEDURE', 'WINDOW', 'JOIN', 'ON', 'USING', 'AS', 'AND', 'OR', 'XOR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'RLIKE', 'REGEXP',
  'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'DISTINCTROW', 'ALL', 'ANY', 'SOME', 'WITH',
  'RECURSIVE', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'OUTER', 'NATURAL', 'STRAIGHT_JOIN', 'HIGH_PRIORITY', 'SQL_SMALL_RESULT',
  'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_NO_CACHE', 'SQL_CACHE', 'SQL_CALC_FOUND_ROWS', 'BY', 'ASC', 'DESC', 'DIV',
  'MOD', 'INTERVAL', 'CAST', 'CONVERT', 'BINARY', 'COLLATE', 'ESCAPE', 'ROLLUP', 'TRUE', 'FALSE', 'UNKNOWN', 'USE',
  'FORCE', 'IGNORE', 'PARTITION', 'LATERAL', 'OVER', 'ROWS', 'RANGE', 'DUAL', 'MATCH', 'AGAINST', 'SEPARATOR', 'TABLE',
  'VALUES', 'DEFAULT', 'OUTFILE', 'DUMPFILE', 'SHARE', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'CALL', 'SET', 'DO',
]);

const UNITS = new Set(['MICROSECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']);
const BARE_TIME = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP', 'UTC_DATE', 'UTC_TIMESTAMP']);

interface Scope {
  ctes: Set<string>;
  parent: Scope | null;
}

class Parser {
  private i = 0;
  readonly relations = new Set<string>();
  readonly functions = new Set<string>();
  params = 0;

  constructor(
    private readonly toks: Tok[],
    private readonly catalog: PolicyCatalog,
  ) {}

  private get t(): Tok {
    return this.toks[this.i] as Tok;
  }
  private peek(k = 1): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)] as Tok;
  }
  private isWord(w: string, tok: Tok = this.t): boolean {
    return tok.kind === 'ident' && tok.v === w;
  }
  private isOp(o: string, tok: Tok = this.t): boolean {
    return tok.kind === 'op' && tok.v === o;
  }
  private eatWord(w: string): boolean {
    if (this.isWord(w)) {
      this.i++;
      return true;
    }
    return false;
  }
  private eatOp(o: string): boolean {
    if (this.isOp(o)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expectWord(w: string): void {
    if (!this.eatWord(w)) this.unexpected(w);
  }
  private expectOp(o: string): void {
    if (!this.eatOp(o)) this.unexpected(o);
  }
  private unexpected(wanted?: string): never {
    const got = this.t.kind === 'eof' ? 'the end of the query' : JSON.stringify(this.t.raw);
    return refuse('syntax', `${got} is outside the read subset${wanted === undefined ? '' : ` (expected ${wanted})`}`);
  }

  /** A name: a backtick-quoted one, or a bare word that is not reserved. */
  private name(): string {
    const tok = this.t;
    if (tok.kind === 'qident') {
      this.i++;
      return tok.raw;
    }
    if (tok.kind === 'ident' && !RESERVED.has(tok.v)) {
      this.i++;
      return tok.raw;
    }
    return this.unexpected('a name');
  }
  private isName(tok: Tok = this.t): boolean {
    return tok.kind === 'qident' || (tok.kind === 'ident' && !RESERVED.has(tok.v));
  }

  statement(): void {
    this.query(null);
    this.eatOp(';');
    if (this.t.kind !== 'eof') refuse('statements', 'a query is exactly one statement');
  }

  query(scope: Scope | null): void {
    let inner: Scope = { ctes: new Set(), parent: scope };
    if (this.eatWord('WITH')) {
      if (this.isWord('RECURSIVE')) refuse('recursive', 'WITH RECURSIVE is outside the read subset');
      const seen: Scope = { ctes: new Set(), parent: scope };
      do {
        const cte = this.name();
        if (this.eatOp('(')) {
          do this.name();
          while (this.eatOp(','));
          this.expectOp(')');
        }
        this.expectWord('AS');
        this.expectOp('(');
        this.query({ ctes: new Set(seen.ctes), parent: scope });
        this.expectOp(')');
        seen.ctes.add(cte);
      } while (this.eatOp(','));
      inner = seen;
    }
    this.selectPrimary(inner);
    while (this.isWord('UNION')) {
      this.i++;
      if (!this.eatWord('ALL')) this.eatWord('DISTINCT');
      this.selectPrimary(inner);
    }
    if (this.isWord('EXCEPT') || this.isWord('INTERSECT')) refuse('syntax', 'EXCEPT and INTERSECT are outside the read subset; use UNION');
    if (this.eatWord('ORDER')) {
      this.expectWord('BY');
      this.orderList(inner);
    }
    if (this.eatWord('LIMIT')) {
      this.limitValue();
      if (this.eatOp(',') || this.eatWord('OFFSET')) this.limitValue();
    }
    for (const w of ['INTO', 'FOR', 'LOCK', 'PROCEDURE']) if (this.isWord(w)) refuse(w === 'INTO' ? 'into' : 'locking', `${w} … is not a read`);
  }

  private limitValue(): void {
    if (this.t.kind === 'num' && /^\d+$/.test(this.t.v)) this.i++;
    else if (this.t.kind === 'param') {
      this.i++;
      this.params++;
    } else this.unexpected('a row count');
  }

  private selectPrimary(scope: Scope): void {
    if (this.eatOp('(')) {
      this.query(scope);
      this.expectOp(')');
      return;
    }
    if (!this.isWord('SELECT')) {
      if (this.t.kind === 'ident' && ['DELETE', 'UPDATE', 'INSERT', 'REPLACE', 'CALL', 'SET', 'DO', 'TABLE', 'VALUES', 'HANDLER', 'LOAD', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'GRANT', 'SHOW', 'EXPLAIN'].includes(this.t.v)) {
        refuse('not_select', `${this.t.v} is not a read; only SELECT (or WITH … SELECT) is`);
      }
      this.unexpected('SELECT');
    }
    this.i++;
    if (!this.eatWord('ALL')) this.eatWord('DISTINCT');
    do this.selectItem(scope);
    while (this.eatOp(','));
    if (this.eatWord('FROM')) {
      if (this.isWord('DUAL')) this.i++;
      else this.tableRefs(scope);
    }
    if (this.eatWord('WHERE')) this.expr(scope);
    if (this.eatWord('GROUP')) {
      this.expectWord('BY');
      do this.expr(scope);
      while (this.eatOp(','));
      if (this.eatWord('WITH')) this.expectWord('ROLLUP');
    }
    if (this.eatWord('HAVING')) this.expr(scope);
    if (this.isWord('WINDOW')) refuse('syntax', 'named windows are outside the read subset; write OVER (…) in place');
  }

  private selectItem(scope: Scope): void {
    if (this.eatOp('*')) return;
    // qualifier.* or qualifier.qualifier.*
    if (this.isName() && this.isOp('.', this.peek()) && (this.isOp('*', this.peek(2)) || (this.isName(this.peek(2)) && this.isOp('.', this.peek(3)) && this.isOp('*', this.peek(4))))) {
      this.name();
      this.expectOp('.');
      if (this.eatOp('*')) return;
      this.name();
      this.expectOp('.');
      this.expectOp('*');
      return;
    }
    this.expr(scope);
    if (this.eatWord('AS')) this.name();
    else if (this.isName()) this.name();
  }

  private tableRefs(scope: Scope): void {
    do {
      this.tablePrimary(scope);
      this.joins(scope);
    } while (this.eatOp(','));
  }

  private joins(scope: Scope): void {
    for (;;) {
      if (this.isWord('NATURAL') || this.isWord('STRAIGHT_JOIN')) refuse('syntax', `${this.t.v} joins are outside the read subset`);
      let outer = false;
      if (this.eatWord('INNER') || this.eatWord('CROSS')) {
        this.expectWord('JOIN');
      } else if (this.eatWord('LEFT') || this.eatWord('RIGHT')) {
        outer = true;
        this.eatWord('OUTER');
        this.expectWord('JOIN');
      } else if (!this.eatWord('JOIN')) return;
      this.tablePrimary(scope);
      if (this.eatWord('ON')) this.expr(scope);
      else if (this.eatWord('USING')) {
        this.expectOp('(');
        do this.name();
        while (this.eatOp(','));
        this.expectOp(')');
      } else if (outer) this.unexpected('ON or USING');
    }
  }

  private tablePrimary(scope: Scope): void {
    if (this.isWord('LATERAL')) refuse('syntax', 'LATERAL is outside the read subset');
    if (this.eatOp('(')) {
      if (this.isWord('SELECT') || this.isWord('WITH') || this.isOp('(')) {
        this.query(scope);
        this.expectOp(')');
        this.eatWord('AS');
        this.name();
        return;
      }
      this.tableRefs(scope);
      this.expectOp(')');
      return;
    }
    const first = this.name();
    let schema: string | null = null;
    let table = first;
    if (this.eatOp('.')) {
      schema = first;
      table = this.name();
    }
    this.relation(schema, table, scope);
    if (this.isWord('PARTITION')) refuse('syntax', 'PARTITION selection is outside the read subset');
    if (this.eatWord('AS')) this.name();
    else if (this.isName()) this.name();
    if (this.isWord('USE') || this.isWord('FORCE') || this.isWord('IGNORE')) refuse('syntax', 'index hints are outside the read subset');
  }

  private relation(schema: string | null, table: string, scope: Scope | null): void {
    if (schema === null) {
      for (let s = scope; s !== null; s = s.parent) if (s.ctes.has(table)) return;
      const db = this.catalog.defaultSchema ?? null;
      if (db === null) refuse('unqualified', `the table ${table} must be qualified with its database`);
      schema = db;
    }
    const key = `${schema}.${table}`;
    const kind = this.catalog.relations.get(key);
    if (kind === undefined) refuse('relation', `${key} is not a table of this source's catalog (describe the source again if it is new)`);
    else if (kind === 'foreign') refuse('relation', `${key} is a foreign table`);
    else if ((kind === 'view' || kind === 'matview') && !this.catalog.viewsAllowed.has(key)) refuse('view', `${key} is a view the person has not allowed by name on the source sheet`);
    this.relations.add(key);
  }

  private orderList(scope: Scope): void {
    do {
      this.expr(scope);
      if (!this.eatWord('ASC')) this.eatWord('DESC');
    } while (this.eatOp(','));
  }

  // ── expressions ──

  expr(scope: Scope): void {
    this.andExpr(scope);
    while (this.eatWord('OR')) this.andExpr(scope);
    if (this.isWord('XOR')) refuse('syntax', 'XOR is outside the read subset');
  }

  private andExpr(scope: Scope): void {
    this.notExpr(scope);
    while (this.eatWord('AND')) this.notExpr(scope);
  }

  private notExpr(scope: Scope): void {
    if (this.eatWord('NOT')) {
      this.notExpr(scope);
      return;
    }
    this.predicate(scope);
  }

  private predicate(scope: Scope): void {
    this.addExpr(scope);
    for (;;) {
      if (this.t.kind === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>=', '<=>'].includes(this.t.v)) {
        this.i++;
        if (this.isWord('ANY') || this.isWord('SOME') || this.isWord('ALL')) {
          this.i++;
          this.expectOp('(');
          this.query(scope);
          this.expectOp(')');
        } else this.addExpr(scope);
        continue;
      }
      if (this.eatWord('IS')) {
        this.eatWord('NOT');
        if (!(this.eatWord('NULL') || this.eatWord('TRUE') || this.eatWord('FALSE') || this.eatWord('UNKNOWN'))) this.unexpected('NULL, TRUE, FALSE or UNKNOWN');
        continue;
      }
      const negated = this.isWord('NOT') && (this.isWord('IN', this.peek()) || this.isWord('BETWEEN', this.peek()) || this.isWord('LIKE', this.peek()));
      if (negated) this.i++;
      if (this.eatWord('IN')) {
        this.expectOp('(');
        if (this.isWord('SELECT') || this.isWord('WITH')) this.query(scope);
        else {
          do this.expr(scope);
          while (this.eatOp(','));
        }
        this.expectOp(')');
        continue;
      }
      if (this.eatWord('BETWEEN')) {
        this.addExpr(scope);
        this.expectWord('AND');
        this.addExpr(scope);
        continue;
      }
      if (this.eatWord('LIKE')) {
        this.addExpr(scope);
        if (this.eatWord('ESCAPE')) {
          if (this.t.kind !== 'str') this.unexpected('an escape string');
          this.i++;
        }
        continue;
      }
      if (negated) this.unexpected('IN, BETWEEN or LIKE');
      if (this.isWord('REGEXP') || this.isWord('RLIKE') || this.isWord('SOUNDS') || this.isWord('MEMBER')) refuse('operator', `${this.t.v} is outside the read subset`);
      return;
    }
  }

  private addExpr(scope: Scope): void {
    this.mulExpr(scope);
    while (this.isOp('+') || this.isOp('-')) {
      this.i++;
      this.mulExpr(scope);
    }
  }

  private mulExpr(scope: Scope): void {
    this.unary(scope);
    while (this.isOp('*') || this.isOp('/') || this.isOp('%') || this.isWord('DIV') || this.isWord('MOD')) {
      this.i++;
      this.unary(scope);
    }
  }

  private unary(scope: Scope): void {
    if (this.isOp('-') || this.isOp('+')) {
      this.i++;
      this.unary(scope);
      return;
    }
    this.primary(scope);
  }

  private primary(scope: Scope): void {
    const tok = this.t;
    if (tok.kind === 'num' || tok.kind === 'str') {
      this.i++;
      return;
    }
    if (tok.kind === 'param') {
      this.i++;
      this.params++;
      return;
    }
    if (this.eatOp('(')) {
      if (this.isWord('SELECT') || this.isWord('WITH')) this.query(scope);
      else {
        this.expr(scope);
        if (this.isOp(',')) refuse('syntax', 'row constructors are outside the read subset');
      }
      this.expectOp(')');
      return;
    }
    if (tok.kind === 'ident') {
      switch (tok.v) {
        case 'NULL':
        case 'TRUE':
        case 'FALSE':
          this.i++;
          return;
        case 'EXISTS':
          this.i++;
          this.expectOp('(');
          this.query(scope);
          this.expectOp(')');
          return;
        case 'CASE':
          this.i++;
          this.caseExpr(scope);
          return;
        case 'CAST':
          this.i++;
          this.expectOp('(');
          this.expr(scope);
          this.expectWord('AS');
          this.castType();
          this.expectOp(')');
          return;
        case 'INTERVAL':
          this.i++;
          this.expr(scope);
          this.unit();
          return;
        case 'DATE':
        case 'TIMESTAMP':
        case 'TIME':
          if (this.peek().kind === 'str') {
            this.i += 2; // DATE '2024-01-01' and friends
            return;
          }
          break;
        case 'CONVERT':
        case 'BINARY':
        case 'MATCH':
          refuse('syntax', `${tok.v} is outside the read subset`);
      }
      if (BARE_TIME.has(tok.v) && !this.isOp('(', this.peek())) {
        this.i++;
        return;
      }
    }
    if (this.isName() || (tok.kind === 'ident' && this.isOp('(', this.peek()))) {
      if (this.isOp('(', this.peek())) {
        this.funcCall(scope);
        return;
      }
      this.name();
      if (this.eatOp('.')) {
        this.name();
        if (this.isOp('(')) refuse('qualified_name', 'qualified routine names are refused: no stored functions');
        if (this.eatOp('.')) this.name();
      }
      return;
    }
    this.unexpected('an expression');
  }

  private caseExpr(scope: Scope): void {
    if (!this.isWord('WHEN')) this.expr(scope);
    if (!this.isWord('WHEN')) this.unexpected('WHEN');
    while (this.eatWord('WHEN')) {
      this.expr(scope);
      this.expectWord('THEN');
      this.expr(scope);
    }
    if (this.eatWord('ELSE')) this.expr(scope);
    this.expectWord('END');
  }

  private castType(): void {
    const tok = this.t;
    if (tok.kind !== 'ident' || !MYSQL_CAST_TYPES.has(tok.v)) refuse('cast', `a cast to ${tok.raw} is refused; casts go only to SIGNED, UNSIGNED, DECIMAL, CHAR, DATE, DATETIME, TIME, DOUBLE, FLOAT or JSON`);
    this.i++;
    if (tok.v === 'SIGNED' || tok.v === 'UNSIGNED') {
      if (!this.eatWord('INTEGER')) this.eatWord('INT');
      return;
    }
    if (['DECIMAL', 'CHAR', 'DATETIME', 'TIME'].includes(tok.v) && this.eatOp('(')) {
      if (this.t.kind !== 'num') this.unexpected('a length');
      this.i++;
      if (tok.v === 'DECIMAL' && this.eatOp(',')) {
        if (this.t.kind !== 'num') this.unexpected('a scale');
        this.i++;
      }
      this.expectOp(')');
    }
    if (this.isWord('CHARACTER') || this.isWord('CHARSET')) refuse('cast', 'a character set in a cast is refused');
  }

  private unit(): void {
    if (this.t.kind !== 'ident' || !UNITS.has(this.t.v)) this.unexpected('an interval unit (SECOND … YEAR)');
    this.i++;
  }

  private funcCall(scope: Scope): void {
    const tok = this.t;
    if (tok.kind !== 'ident') this.unexpected('a function');
    const fn = tok.v;
    if (deniedFunction(fn) || !MYSQL_FUNCTIONS.has(fn)) refuse('function', `${tok.raw}() is not a function a read may call`);
    this.functions.add(fn);
    this.i++;
    this.expectOp('(');
    switch (fn) {
      case 'COUNT':
        if (this.eatOp('*')) break;
        this.eatWord('DISTINCT');
        do this.expr(scope);
        while (this.eatOp(','));
        break;
      case 'EXTRACT':
        this.unit();
        this.expectWord('FROM');
        this.expr(scope);
        break;
      case 'SUBSTRING':
      case 'SUBSTR':
        this.expr(scope);
        if (this.eatWord('FROM')) {
          this.expr(scope);
          if (this.eatWord('FOR')) this.expr(scope);
        } else {
          this.expectOp(',');
          this.expr(scope);
          if (this.eatOp(',')) this.expr(scope);
        }
        break;
      case 'TRIM':
        if (this.eatWord('BOTH') || this.eatWord('LEADING') || this.eatWord('TRAILING')) {
          if (!this.isWord('FROM')) this.expr(scope);
          this.expectWord('FROM');
          this.expr(scope);
        } else {
          this.expr(scope);
          if (this.eatWord('FROM')) this.expr(scope);
        }
        break;
      case 'POSITION':
        this.addExpr(scope);
        this.expectWord('IN');
        this.expr(scope);
        break;
      case 'GROUP_CONCAT':
        this.eatWord('DISTINCT');
        do this.expr(scope);
        while (this.eatOp(','));
        if (this.eatWord('ORDER')) {
          this.expectWord('BY');
          this.orderList(scope);
        }
        if (this.eatWord('SEPARATOR')) {
          if (this.t.kind !== 'str') this.unexpected('a separator string');
          this.i++;
        }
        break;
      case 'TIMESTAMPDIFF':
      case 'TIMESTAMPADD':
        this.unit();
        this.expectOp(',');
        this.expr(scope);
        this.expectOp(',');
        this.expr(scope);
        break;
      default:
        if (this.isOp(')')) break;
        if (['SUM', 'AVG', 'MIN', 'MAX', 'JSON_ARRAYAGG'].includes(fn)) this.eatWord('DISTINCT');
        do this.expr(scope);
        while (this.eatOp(','));
    }
    this.expectOp(')');
    if (this.eatWord('OVER')) this.windowSpec(scope);
  }

  private windowSpec(scope: Scope): void {
    if (!this.isOp('(')) refuse('syntax', 'named windows are outside the read subset; write OVER (…) in place');
    this.i++;
    if (this.eatWord('PARTITION')) {
      this.expectWord('BY');
      do this.expr(scope);
      while (this.eatOp(','));
    }
    if (this.eatWord('ORDER')) {
      this.expectWord('BY');
      this.orderList(scope);
    }
    if (this.eatWord('ROWS') || this.eatWord('RANGE')) {
      if (this.eatWord('BETWEEN')) {
        this.frameBound(scope);
        this.expectWord('AND');
        this.frameBound(scope);
      } else this.frameBound(scope);
    }
    this.expectOp(')');
  }

  private frameBound(scope: Scope): void {
    if (this.eatWord('UNBOUNDED')) {
      if (!this.eatWord('PRECEDING')) this.expectWord('FOLLOWING');
      return;
    }
    if (this.eatWord('CURRENT')) {
      this.expectWord('ROW');
      return;
    }
    if (this.t.kind === 'num' || this.t.kind === 'param') {
      if (this.t.kind === 'param') this.params++;
      this.i++;
    } else this.primary(scope);
    if (!this.eatWord('PRECEDING')) this.expectWord('FOLLOWING');
  }
}

/** Check one query text against the MySQL read subset. Never connects. */
export function checkMysqlRead(text: string, catalog: PolicyCatalog): PolicyResult {
  try {
    const p = new Parser(lex(text), catalog);
    p.statement();
    return { ok: true, relations: [...p.relations].sort(), functions: [...p.functions].sort(), params: p.params };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, detail: err.message };
    throw err;
  }
}
