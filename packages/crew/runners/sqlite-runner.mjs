// The SQLite snapshot runner (DES-APPS-001 §5.1, §5.3, §7.5): one JSON request on stdin, one JSON
// answer on stdout. crew starts it as a CHILD PROCESS (packages/crew/src/sources/drivers/sqlite.ts):
// the daemon itself never loads a SQLite library (wicked-core#631), and a statement past its deadline
// is stopped by ending this process (node:sqlite has no interrupt). Plain ESM, no imports but node:sqlite.
// It lives outside src/ on purpose: it is not daemon code, and the daemon's SQLite guards scan src/.
import { DatabaseSync, constants } from 'node:sqlite';
// One UTF-8 decoder for the whole request: a character split across two pipe chunks stays one.
process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);
// The read policy's authorizer, written once (policy/sqlite.ts) and sent by the parent as its source text.
const authorize = typeof req.authorizer === 'string' ? new Function(`return (${req.authorizer});`)() : null;
const out = (v) => process.stdout.write(JSON.stringify(v));
try {
  if (typeof DatabaseSync.prototype.setAuthorizer !== 'function' || typeof DatabaseSync.prototype.enableDefensive !== 'function') {
    throw new Error('SQLite sources need Node.js 24.12, 25.1 or later (the authorizer and defensive mode)');
  }
  if (req.op === 'create') {
    // A new snapshot from parsed rows (uploads.ts): one table, typed columns, one transaction.
    const quote = (n) => '"' + String(n).replace(/"/g, '""') + '"';
    const w = new DatabaseSync(req.path, { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    try {
      w.exec('CREATE TABLE ' + quote(req.table) + ' (' + req.names.map((n, i) => quote(n) + ' ' + req.types[i]).join(', ') + ')');
      const ins = w.prepare('INSERT INTO ' + quote(req.table) + ' VALUES (' + req.names.map(() => '?').join(', ') + ')');
      w.exec('BEGIN');
      for (const r of req.rows) {
        ins.run(...req.names.map((_n, i) => {
          const raw = r[i] ?? '';
          const v = raw.trim();
          if (v === '') return null;
          if (req.types[i] === 'INTEGER') return BigInt(v);
          if (req.types[i] === 'REAL') return Number(v);
          return raw;
        }));
      }
      w.exec('COMMIT');
    } finally {
      w.close();
    }
    out({ ok: true });
    process.exit(0);
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
    const norm = (s) => String(s).trim().replace(/;\s*$/, '').trim();
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
