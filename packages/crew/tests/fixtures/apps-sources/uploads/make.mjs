// DES-APPS-001 shared fixtures: upload samples that are binary, MADE at test time (no binaries in the
// repo). makeXlsx(rows) writes a minimal valid first-sheet workbook; makeZipBomb(mb) a workbook whose
// sheet expands to `mb` megabytes; makeSqlite(path, {trigger, view}) a .sqlite file.

import { DatabaseSync } from 'node:sqlite';
import { constants as zc, crc32, createDeflateRaw, deflateRawSync } from 'node:zlib';

/** A zip of the given entries (deflated), as a Buffer. A `raw` entry carries its own bytes and declared size. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = e.raw === true ? e.compressed : deflateRawSync(e.data);
    const size = e.raw === true ? e.size : e.data.length;
    const crc = e.raw === true ? 0 : crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const WORKBOOK =
  '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Refunds" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const col = (i) => String.fromCharCode(65 + i);

/** A workbook whose first sheet holds `rows` (strings as shared strings, numbers as numbers). */
export function makeXlsx(rows) {
  const shared = [];
  const sheetRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">${r
          .map((v, ci) => {
            const ref = `${col(ci)}${ri + 1}`;
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
            shared.push(v);
            return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  return zip([
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS) },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sst) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
  ]);
}

/** A workbook whose sheet expands to `mb` MB of zeros while its directory declares `declared` bytes. */
export async function makeZipBomb(mb, declared = 1024) {
  const chunks = [];
  const d = createDeflateRaw({ level: zc.Z_BEST_COMPRESSION });
  d.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => d.on('end', r));
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < mb; i++) if (!d.write(block)) await new Promise((r) => d.once('drain', r));
  d.end();
  await done;
  return zip([
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS) },
    { name: 'xl/worksheets/sheet1.xml', raw: true, compressed: Buffer.concat(chunks), size: declared },
  ]);
}

/**
 * A .sqlite file at `path`: a refunds table, plus, when asked, a trigger, a view, a virtual table whose
 * schema text hides its kind behind a comment (`hiddenVirtual`), or a generated column; or an RTREE
 * table behind an ordinary table named `pragma_table_list` (`shadowPragma`).
 */
export function makeSqlite(path, { trigger = false, view = false, hiddenVirtual = false, generated = false, shadowPragma = false } = {}) {
  const db = new DatabaseSync(path, { defensive: false });
  db.exec("CREATE TABLE refunds (id INTEGER PRIMARY KEY, region TEXT, amount REAL); INSERT INTO refunds VALUES (1, 'EMEA', 10.5), (2, 'AMER', 99.99);");
  if (trigger) db.exec('CREATE TABLE audit (n TEXT); CREATE TRIGGER t AFTER INSERT ON refunds BEGIN INSERT INTO audit VALUES (new.region); END;');
  if (view) db.exec('CREATE VIEW v AS SELECT * FROM refunds;');
  if (hiddenVirtual) {
    db.exec('CREATE VIRTUAL TABLE notes USING fts5(body)');
    db.exec('PRAGMA writable_schema = ON');
    db.exec("UPDATE sqlite_schema SET sql = 'CREATE /* a table */ VIRTUAL TABLE notes USING fts5(body)' WHERE name = 'notes'");
  }
  if (generated) db.exec('CREATE TABLE g (a INTEGER, b INTEGER GENERATED ALWAYS AS (abs(a)) VIRTUAL); INSERT INTO g (a) VALUES (-3);');
  if (shadowPragma) {
    // An ordinary table named like SQLite's table-valued pragma, claiming an RTREE table is a plain one.
    db.exec('CREATE VIRTUAL TABLE geo USING rtree(id, a, b)');
    db.exec('CREATE TABLE pragma_table_list (schema TEXT, name TEXT, type TEXT, ncol INTEGER, wr INTEGER, strict INTEGER)');
    db.exec("INSERT INTO pragma_table_list SELECT 'main', name, 'table', 0, 0, 0 FROM sqlite_schema WHERE type = 'table'");
  }
  db.close();
}
