// The SQLite snapshot runner (DES-APPS-001 §5.1, §5.3, §7.5): one JSON request on stdin, one JSON
// answer on stdout. crew starts it as a CHILD PROCESS (packages/crew/src/sources/drivers/sqlite.ts):
// the daemon itself never loads a SQLite library (wicked-core#631), and a statement past its deadline
// is stopped by ending this process (node:sqlite has no interrupt). Plain ESM outside the daemon.
// It lives outside src/ on purpose: it is not daemon code, and the daemon's SQLite guards scan src/.
import { DatabaseSync, constants } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { parseCsv, parseXlsx, detectHeader, columnNames, inferType, tableNameFor } from './upload-parse.mjs';
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
  if (req.op === 'ingest') {
    // Parsing and inference share the snapshot writer's killable process (crew#1289).
    const data = await readFile(req.input);
    const rows = req.kind === 'xlsx' ? parseXlsx(data, req.limits) : parseCsv(data.toString('utf8').replace(/^﻿/, ''), req.limits);
    if (rows.length === 0) throw { code: 'empty', message: 'the file has no rows' };
    const detected = detectHeader(rows, req.header);
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const names = columnNames(rows[0], width, detected);
    const body = detected ? rows.slice(1) : rows;
    if (body.length > req.limits.rows) throw { code: 'too_many_rows', message: `the file has more than ${req.limits.rows} rows` };
    const types = names.map((_n, i) => inferType((function* () {
      for (const r of body) yield r[i] ?? '';
    })()));
    const table = tableNameFor(req.filename);
    const quote = (n) => '"' + String(n).replace(/"/g, '""') + '"';
    const w = new DatabaseSync(req.path, { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    try {
      w.exec('CREATE TABLE ' + quote(table) + ' (' + names.map((n, i) => quote(n) + ' ' + types[i]).join(', ') + ')');
      const ins = w.prepare('INSERT INTO ' + quote(table) + ' VALUES (' + names.map(() => '?').join(', ') + ')');
      w.exec('BEGIN');
      for (const r of body) {
        ins.run(...names.map((_n, i) => {
          const raw = r[i] ?? '';
          const v = raw.trim();
          if (v === '') return null;
          if (types[i] === 'INTEGER') return BigInt(v);
          if (types[i] === 'REAL') return Number(v);
          return raw;
        }));
      }
      w.exec('COMMIT');
    } finally {
      w.close();
    }
    // Exit only once the answer is written: a pipe write is async on macOS, and an exit before it drains cuts
    // anything past 64 KiB (a wide 20-row preview) (crew#1721 coord r1).
    await new Promise((done) => process.stdout.write(JSON.stringify({ ok: true, table, header: { detected, columns: names }, sample: body.slice(0, req.limits.sampleRows).map((r) => names.map((_n, i) => r[i] ?? '')) }), done));
    process.exit(0);
  }
  if (req.op === 'strip') {
    // (crew#1731) An uploaded .sqlite's virtual tables (a full-text index, an R-tree) are dropped from crew's COPY of
    // the file, never the person's: DROP TABLE runs the module's own destroy, which drops its shadow tables too. A
    // module this SQLite does not have cannot be dropped, and the upload is refused naming it. The copy is then
    // rewritten with VACUUM INTO (live pages only, so nothing dropped, now or before the upload, stays in its free
    // pages) and put in its place. Not a plain VACUUM: that renumbers the rowids of a table without an INTEGER PRIMARY
    // KEY, which another table may refer to; VACUUM INTO keeps them (codex r1, r2).
    const quote = (n) => '"' + String(n).replace(/"/g, '""') + '"';
    const w = new DatabaseSync(req.path, { enableForeignKeyConstraints: false, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    let answer;
    try {
      w.enableDefensive(true);
      w.exec('PRAGMA trusted_schema = 0; PRAGMA journal_mode = DELETE;');
      const failed = [];
      for (const name of req.tables) {
        try {
          w.exec('DROP TABLE main.' + quote(name));
        } catch (e) {
          failed.push({ name, error: String(e && e.message || e) });
        }
      }
      if (failed.length === 0) w.exec("VACUUM INTO '" + String(req.into).replace(/'/g, "''") + "'");
      answer = { ok: true, failed };
    } finally {
      w.close();
    }
    if (answer.failed.length === 0) renameSync(req.into, req.path);
    await new Promise((done) => process.stdout.write(JSON.stringify(answer), done));
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
    // A shadow table (FTS5's `_data`, `_idx`, …) is an ordinary table that belongs to its virtual table and goes with
    // it; it is never called virtual (crew#1731). Any other kind that is not a plain table counts as virtual.
    const kindOf = (o) => {
      if (o.type !== 'table' || String(o.name).startsWith('sqlite_')) return null;
      const k = kinds.get(o.name);
      return k === 'table' ? null : k === 'shadow' ? 'shadow' : 'virtual';
    };
    out({ ok: true, objects: objects.map((o) => ({ type: o.type, name: o.name, virtual: kindOf(o) === 'virtual', shadow: kindOf(o) === 'shadow' })), tables });
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
      // The byte budget (`maxBytes`) holds while collecting: a row that would pass it is not kept.
      let bytes = 2;
      // A BLOB: null for an app's read (as before); a person's own query (`blobs: 'hex'`) sees it as
      // `\x` hex, its first 32,767 bytes (65,536 characters with the prefix), `…` past them.
      const BLOB_MAX = 32767;
      const blob = (b) => (req.blobs === 'hex' ? `\\x${Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, BLOB_MAX)).toString('hex')}${b.byteLength > BLOB_MAX ? '…' : ''}` : null);
      for (const row of stmt.iterate(...req.params)) {
        if (rows.length >= req.maxRows) { truncated = true; break; }
        // A person's query cuts long text first (`cellChars`), so a long cell shows shortened rather than
        // its whole row being left out by the byte budget.
        const text = (v) => (typeof req.cellChars === 'number' && v.length > req.cellChars ? `${v.slice(0, req.cellChars)}…` : v);
        const cells = row.map((v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? blob(v) : typeof v === 'string' ? text(v) : v));
        if (typeof req.maxBytes === 'number') {
          const n = Buffer.byteLength(JSON.stringify(cells), 'utf8') + (rows.length > 0 ? 1 : 0);
          if (bytes + n > req.maxBytes) { truncated = true; break; }
          bytes += n;
        }
        rows.push(cells);
      }
      out({ ok: true, columns, rows, truncated });
    }
  }
} catch (e) {
  const refused = !(e instanceof Error) && typeof e?.code === 'string';
  out({ ok: false, ...(refused ? { refused: true, code: e.code } : {}), error: String(e && e.message || e) });
}
