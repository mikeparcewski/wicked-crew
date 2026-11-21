// Upload parsers live only in the killable runner child (crew#1289). Limits come from uploads.ts.
import { inflateRawSync } from 'node:zlib';

const refusal = (code, message) => ({ code, message });

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────

function detectDelimiter(text) {
  // The first record, with quoted fields taken out (a quoted field may hold any delimiter).
  let first = '';
  let quoted = false;
  for (let i = 0; i < text.length && i < 1_000_000; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
    else if (!quoted) first += c;
  }
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length]);
  return counts.sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
}

/** RFC 4180 rows (quoted fields, doubled quotes, CRLF or LF), bounded by the limits. */
export function parseCsv(text, limits) {
  const d = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) {
      if (row.length > limits.columns) throw refusal('too_many_columns', `the file has more than ${limits.columns} columns`);
      rows.push(row);
      if (rows.length > limits.rows + 1) throw refusal('too_many_rows', `the file has more than ${limits.rows} rows`);
    }
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === d) {
      row.push(field);
      field = '';
      if (row.length > limits.columns) throw refusal('too_many_columns', `the file has more than ${limits.columns} columns`);
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (quoted) throw refusal('bad_csv', 'the file ends inside a quoted field');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// ── XLSX (a zip of XML) ──────────────────────────────────────────────────────────────────────

function zipEntries(buf) {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw refusal('bad_xlsx', 'the file is not an XLSX workbook (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw refusal('bad_xlsx', 'zip64 workbooks are not supported');
  if (cdOffset + cdSize > buf.length) throw refusal('bad_xlsx', 'the zip directory points past the end of the file');
  const out = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw refusal('bad_xlsx', 'a damaged zip directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, flags, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

class ZipReader {
  expanded = 0;
  constructor(buf, entries, limits) {
    this.buf = buf;
    this.entries = entries;
    this.limits = limits;
  }

  has(name) {
    return this.entries.some((e) => e.name === name);
  }

  /** One entry's bytes, inflated with the remaining expansion budget as a HARD cap. */
  read(name) {
    const e = this.entries.find((x) => x.name === name);
    if (e === undefined) throw refusal('bad_xlsx', `the workbook has no ${name}`);
    if ((e.flags & 0x1) !== 0) throw refusal('bad_xlsx', 'encrypted workbooks are not supported');
    const p = e.localOffset;
    if (p + 30 > this.buf.length || this.buf.readUInt32LE(p) !== 0x04034b50) throw refusal('bad_xlsx', 'a damaged zip entry');
    const start = p + 30 + this.buf.readUInt16LE(p + 26) + this.buf.readUInt16LE(p + 28);
    const data = this.buf.subarray(start, start + e.compressedSize);
    const budget = this.limits.expandedBytes - this.expanded;
    if (e.size > budget) throw refusal('too_large', `the workbook expands past ${this.limits.expandedBytes / (1024 * 1024)} MB`);
    let bytes;
    if (e.method === 0) bytes = Buffer.from(data);
    else if (e.method === 8) {
      try {
        bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, budget) });
      } catch (err) {
        const code = err.code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /buffer|too large|maxOutputLength/i.test(String(err.message))) {
          throw refusal('too_large', `the workbook expands past ${this.limits.expandedBytes / (1024 * 1024)} MB`);
        }
        throw refusal('bad_xlsx', `a zip entry could not be inflated: ${err.message}`);
      }
    } else throw refusal('bad_xlsx', `zip method ${e.method} is not supported`);
    this.expanded += bytes.length;
    if (this.expanded > this.limits.expandedBytes) throw refusal('too_large', `the workbook expands past ${this.limits.expandedBytes / (1024 * 1024)} MB`);
    return bytes.toString('utf8');
  }
}

function xmlText(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m === null ? null : xmlText(m[1]);
}

function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * The bodies of `<tag …>…</tag>` (and `<tag …/>`) in order, scanned linearly. An element whose end
 * never comes ends the scan. `withHead` also answers the opening tag (for attributes).
 */
function* elements(xml, tag, withHead = false) {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    let i = xml.indexOf(open, at);
    while (i >= 0 && !/[\s>/]/.test(xml[i + open.length] ?? '')) i = xml.indexOf(open, i + 1);
    if (i < 0) return;
    const headEnd = xml.indexOf('>', i);
    if (headEnd < 0) return;
    const head = xml.slice(i, headEnd + 1);
    if (head.endsWith('/>')) {
      yield withHead ? { head, body: '' } : '';
      at = headEnd + 1;
      continue;
    }
    const end = xml.indexOf(close, headEnd + 1);
    if (end < 0) return;
    const body = xml.slice(headEnd + 1, end);
    yield withHead ? { head, body } : body;
    at = end + close.length;
  }
}

/** The concatenated text of every `<t>` in a fragment (a shared string's runs, an inline string). */
function texts(fragment) {
  let out = '';
  for (const t of elements(fragment, 't')) out += xmlText(t);
  return out;
}

/** The first sheet of an XLSX workbook as rows of strings. */
export function parseXlsx(buf, limits) {
  const zip = new ZipReader(buf, zipEntries(buf), limits);
  const workbook = zip.read('xl/workbook.xml');
  const sheetTag = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  if (sheetTag === undefined) throw refusal('bad_xlsx', 'the workbook has no sheet');
  const rid = attr(sheetTag, 'r:id');
  const rels = zip.read('xl/_rels/workbook.xml.rels');
  let target = 'worksheets/sheet1.xml';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) if (attr(m[0], 'Id') === rid) target = attr(m[0], 'Target') ?? target;
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  // Every scan below is linear (indexOf from a moving cursor, never a lazy regex over the rest of the
  // text), so a hostile sheet of unclosed tags costs one pass, not one pass per tag.
  const shared = [];
  if (zip.has('xl/sharedStrings.xml')) {
    const sst = zip.read('xl/sharedStrings.xml');
    let sharedBytes = 0;
    for (const si of elements(sst, 'si')) {
      const t = texts(si);
      sharedBytes += t.length;
      if (sharedBytes > limits.expandedBytes) throw refusal('too_large', `the workbook's strings expand past ${limits.expandedBytes / (1024 * 1024)} MB`);
      shared.push(t);
    }
  }
  const sheet = zip.read(sheetPath);
  const rows = [];
  // Shared strings are referenced, not copied: count what the cells hold once resolved, so a small
  // sheet repeating one large string cannot become a snapshot far past the expansion limit.
  let cellBytes = 0;
  for (const rowXml of elements(sheet, 'row')) {
    const row = [];
    for (const cell of elements(rowXml, 'c', true)) {
      const ref = attr(cell.head, 'r');
      const t = attr(cell.head, 't');
      const inner = cell.body;
      const vStart = inner.indexOf('<v>');
      const vEnd = vStart < 0 ? -1 : inner.indexOf('</v>', vStart + 3);
      const v = vStart < 0 || vEnd < 0 ? undefined : inner.slice(vStart + 3, vEnd);
      let value = '';
      if (t === 's') value = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') value = texts(inner);
      else if (t === 'b') value = v === '1' ? 'true' : 'false';
      else if (v !== undefined) value = xmlText(v);
      const idx = ref === null ? row.length : colIndex(ref);
      if (idx >= limits.columns) throw refusal('too_many_columns', `the sheet has more than ${limits.columns} columns`);
      while (row.length < idx) row.push('');
      row[idx] = value;
      cellBytes += value.length;
      if (cellBytes > limits.expandedBytes) throw refusal('too_large', `the sheet's values expand past ${limits.expandedBytes / (1024 * 1024)} MB`);
    }
    if (row.length > 0 && row.some((c) => c !== '')) rows.push(row);
    if (rows.length > limits.rows + 1) throw refusal('too_many_rows', `the sheet has more than ${limits.rows} rows`);
  }
  return rows;
}

// ── Rows → a SQLite snapshot ─────────────────────────────────────────────────────────────────

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Whether to take the first row as the header. Without the person's choice it must look like one AND
 * differ in shape from the data under it (some column whose first cell is a word while its values
 * are numbers or dates): an all-text first row could be a record — a name, an email — and column
 * names are structure an agent sees. A human's explicit choice (`header=yes|no`) wins.
 */
export function detectHeader(rows, choice) {
  if (choice !== null) return choice === 'yes';
  const first = rows[0] ?? [];
  if (!looksLikeHeader(first) || rows.length < 2) return false;
  const body = rows.slice(1, 201);
  return first.some((_c, i) => {
    const values = body.map((r) => (r[i] ?? '').trim()).filter((v) => v !== '');
    return values.length > 0 && values.every((v) => NUMBER.test(v) || DATEISH.test(v) || /^(true|false)$/i.test(v));
  });
}

/**
 * A column name as people write one: a letter or `_` first, then letters, digits, spaces and a little
 * punctuation (`Amount (USD)`, `Q3 %`, `order-id`), at most 64 characters. No `@`, `.`, `:` or `/`:
 * an email address, a domain, a URL or a time is a value, never a name.
 */
const NAME_LIKE = /^[\p{L}_][\p{L}\p{N}\p{Zs}_\-()%#&]{0,63}$/u;

/** A first row looks like a header when every cell is a distinct column name, none of them data-like. */
export function looksLikeHeader(first) {
  if (first.length === 0) return false;
  const seen = new Set();
  for (const raw of first) {
    const cell = raw.trim();
    if (cell === '' || NUMBER.test(cell) || DATEISH.test(cell) || /^(true|false)$/i.test(cell) || !NAME_LIKE.test(cell)) return false;
    const k = cell.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

export function columnNames(first, width, header) {
  const names = [];
  const taken = new Set(); // SQLite compares names case-insensitively
  for (let i = 0; i < width; i++) {
    let n = header ? (first[i] ?? '').trim().replace(/\s+/g, ' ').slice(0, 56) : '';
    if (n === '') n = `col_${i + 1}`;
    let unique = n;
    for (let k = 2; taken.has(unique.toLowerCase()); k++) unique = `${n}_${k}`;
    taken.add(unique.toLowerCase());
    names.push(unique);
  }
  return names;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function isInt64(v) {
  if (!/^[+-]?\d{1,20}$/.test(v)) return false;
  const b = BigInt(v);
  return b >= INT64_MIN && b <= INT64_MAX;
}

/** INTEGER (stored exactly, as a 64-bit integer), REAL, or TEXT; an integer past int64 makes the column TEXT. */
export function inferType(values) {
  let t = null;
  for (const raw of values) {
    const v = raw.trim();
    if (v === '') continue;
    if (/^[+-]?\d+$/.test(v)) {
      if (!isInt64(v)) return 'TEXT';
      t = t ?? 'INTEGER';
    } else if (NUMBER.test(v) && Number.isFinite(Number(v))) t = t === 'TEXT' ? 'TEXT' : 'REAL';
    else return 'TEXT';
  }
  return t ?? 'TEXT';
}

export function tableNameFor(filename) {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(base) && base.length > 0 ? base.slice(0, 63) : `data${base === '' ? '' : `_${base}`}`.slice(0, 63);
}
