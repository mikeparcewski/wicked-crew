/**
 * Uploads (DES-APPS-001 §5.1 "SQLite and files", §7.5 limits): a CSV, an XLSX (first sheet) or a
 * `.sqlite` file becomes a SQLite SNAPSHOT in crew's content-addressed store,
 * `<state home>/mcp/snapshots/<sha256>.sqlite` — outside any git repo (an app repo holds only the
 * digest) and inside the state-home entry workers are fenced out of.
 *
 * - CSV/XLSX: parsed here (no third-party parser), header detected (a first row that looks like data
 *   becomes `col_1…`), column types inferred (INTEGER, REAL, TEXT), written to a new SQLite file.
 *   The first 20 rows are returned for the PERSON's sheet only (the route never gives them to an agent).
 * - XLSX is a zip: entries are inflated with a hard output cap, so a file that expands past 200 MB is
 *   refused before it is held (a zip bomb). Zip64, encryption and unknown methods are refused.
 * - `.sqlite`: refused if it holds a view, a trigger or a virtual table (§5.1), inspected in the
 *   snapshot runner's child process, never in the daemon.
 * - Limits: 50 MB file, 200 MB after decompression, 1,000,000 rows, 200 columns, 30 s to parse.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { mcpStateDir } from '../mcp/registry-store.js';
import type { SqlCatalog } from './catalog/types.js';
import { sqliteInspect } from './drivers/sqlite.js';

export const UPLOAD_LIMITS = Object.freeze({
  fileBytes: 50 * 1024 * 1024,
  expandedBytes: 200 * 1024 * 1024,
  rows: 1_000_000,
  columns: 200,
  parseMs: 30_000,
  sampleRows: 20,
});

/** A refused upload: the route answers 400/413 with `code`. */
export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export function snapshotDir(): string {
  return join(mcpStateDir(), 'snapshots');
}

export function snapshotPath(digest: string, dir: string = snapshotDir()): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new UploadError('bad_digest', 'a snapshot digest is 64 hex characters');
  return join(dir, `${digest}.sqlite`);
}

export type UploadKind = 'csv' | 'xlsx' | 'sqlite';

export interface UploadResult {
  digest: string;
  bytes: number;
  kind: UploadKind;
  /** The table a CSV/XLSX became; `null` for a `.sqlite` file (its own tables). */
  table: string | null;
  /** CSV/XLSX: whether the first row was taken as the header, and the column names. */
  header: { detected: boolean; columns: string[] } | null;
  /** CSV/XLSX: the first rows, for the person's sheet only. */
  sample: string[][];
  catalog: SqlCatalog;
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────

function detectDelimiter(text: string): string {
  const first = text.slice(0, text.search(/\r?\n/) >= 0 ? text.search(/\r?\n/) : text.length);
  const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
}

/** RFC 4180 rows (quoted fields, doubled quotes, CRLF or LF), bounded by the limits. */
export function parseCsv(text: string, deadline: number): string[][] {
  const d = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const n = text.length;
  const endRow = (): void => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) {
      if (row.length > UPLOAD_LIMITS.columns) throw new UploadError('too_many_columns', `the file has more than ${UPLOAD_LIMITS.columns} columns`);
      rows.push(row);
      if (rows.length > UPLOAD_LIMITS.rows + 1) throw new UploadError('too_many_rows', `the file has more than ${UPLOAD_LIMITS.rows} rows`);
      if (rows.length % 10_000 === 0 && Date.now() > deadline) throw new UploadError('too_slow', `the file took more than ${UPLOAD_LIMITS.parseMs / 1000} s to parse`);
    }
    row = [];
  };
  while (i < n) {
    const c = text[i] as string;
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
  if (quoted) throw new UploadError('bad_csv', 'the file ends inside a quoted field');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// ── XLSX (a zip of XML) ──────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function zipEntries(buf: Buffer): ZipEntry[] {
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UploadError('bad_xlsx', 'the file is not an XLSX workbook (no zip directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new UploadError('bad_xlsx', 'zip64 workbooks are not supported');
  if (cdOffset + cdSize > buf.length) throw new UploadError('bad_xlsx', 'the zip directory points past the end of the file');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new UploadError('bad_xlsx', 'a damaged zip directory');
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
  private expanded = 0;
  constructor(
    private readonly buf: Buffer,
    private readonly entries: ZipEntry[],
  ) {}

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name);
  }

  /** One entry's bytes, inflated with the remaining expansion budget as a HARD cap. */
  read(name: string): string {
    const e = this.entries.find((x) => x.name === name);
    if (e === undefined) throw new UploadError('bad_xlsx', `the workbook has no ${name}`);
    if ((e.flags & 0x1) !== 0) throw new UploadError('bad_xlsx', 'encrypted workbooks are not supported');
    const p = e.localOffset;
    if (p + 30 > this.buf.length || this.buf.readUInt32LE(p) !== 0x04034b50) throw new UploadError('bad_xlsx', 'a damaged zip entry');
    const start = p + 30 + this.buf.readUInt16LE(p + 26) + this.buf.readUInt16LE(p + 28);
    const data = this.buf.subarray(start, start + e.compressedSize);
    const budget = UPLOAD_LIMITS.expandedBytes - this.expanded;
    if (e.size > budget) throw new UploadError('too_large', `the workbook expands past ${UPLOAD_LIMITS.expandedBytes / (1024 * 1024)} MB`);
    let bytes: Buffer;
    if (e.method === 0) bytes = Buffer.from(data);
    else if (e.method === 8) {
      try {
        bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, budget) });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || /buffer|too large|maxOutputLength/i.test(String((err as Error).message))) {
          throw new UploadError('too_large', `the workbook expands past ${UPLOAD_LIMITS.expandedBytes / (1024 * 1024)} MB`);
        }
        throw new UploadError('bad_xlsx', `a zip entry could not be inflated: ${(err as Error).message}`);
      }
    } else throw new UploadError('bad_xlsx', `zip method ${e.method} is not supported`);
    this.expanded += bytes.length;
    if (this.expanded > UPLOAD_LIMITS.expandedBytes) throw new UploadError('too_large', `the workbook expands past ${UPLOAD_LIMITS.expandedBytes / (1024 * 1024)} MB`);
    return bytes.toString('utf8');
  }
}

function xmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m === null ? null : xmlText(m[1] as string);
}

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** The first sheet of an XLSX workbook as rows of strings. */
export function parseXlsx(buf: Buffer, deadline: number): string[][] {
  const zip = new ZipReader(buf, zipEntries(buf));
  const workbook = zip.read('xl/workbook.xml');
  const sheetTag = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  if (sheetTag === undefined) throw new UploadError('bad_xlsx', 'the workbook has no sheet');
  const rid = attr(sheetTag, 'r:id');
  const rels = zip.read('xl/_rels/workbook.xml.rels');
  let target = 'worksheets/sheet1.xml';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) if (attr(m[0], 'Id') === rid) target = attr(m[0], 'Target') ?? target;
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const shared: string[] = [];
  if (zip.has('xl/sharedStrings.xml')) {
    for (const si of zip.read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push([...(si[1] as string).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1] as string)).join(''));
    }
  }
  const sheet = zip.read(sheetPath);
  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const row: string[] = [];
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = `<c ${cm[1] as string}>`;
      const ref = attr(head, 'r');
      const t = attr(head, 't');
      const inner = cm[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (t === 's') value = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1] as string)).join('');
      else if (t === 'b') value = v === '1' ? 'true' : 'false';
      else if (v !== undefined) value = xmlText(v);
      const idx = ref === null ? row.length : colIndex(ref);
      if (idx >= UPLOAD_LIMITS.columns) throw new UploadError('too_many_columns', `the sheet has more than ${UPLOAD_LIMITS.columns} columns`);
      while (row.length < idx) row.push('');
      row[idx] = value;
    }
    if (row.length > 0 && row.some((c) => c !== '')) rows.push(row);
    if (rows.length > UPLOAD_LIMITS.rows + 1) throw new UploadError('too_many_rows', `the sheet has more than ${UPLOAD_LIMITS.rows} rows`);
    if (rows.length % 10_000 === 0 && Date.now() > deadline) throw new UploadError('too_slow', `the file took more than ${UPLOAD_LIMITS.parseMs / 1000} s to parse`);
  }
  return rows;
}

// ── Rows → a SQLite snapshot ─────────────────────────────────────────────────────────────────

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATEISH = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A first row looks like a header when every cell is a non-empty, distinct word, none of them data-like. */
export function looksLikeHeader(first: readonly string[]): boolean {
  if (first.length === 0) return false;
  const seen = new Set<string>();
  for (const raw of first) {
    const cell = raw.trim();
    if (cell === '' || NUMBER.test(cell) || DATEISH.test(cell) || /^(true|false)$/i.test(cell)) return false;
    const k = cell.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

function columnNames(first: readonly string[], width: number, header: boolean): string[] {
  const names: string[] = [];
  for (let i = 0; i < width; i++) {
    let n = header ? (first[i] ?? '').trim().replace(/\s+/g, ' ').slice(0, 63) : '';
    if (n === '') n = `col_${i + 1}`;
    let unique = n;
    for (let k = 2; names.includes(unique); k++) unique = `${n}_${k}`;
    names.push(unique);
  }
  return names;
}

function inferType(values: Iterable<string>): 'INTEGER' | 'REAL' | 'TEXT' {
  let t: 'INTEGER' | 'REAL' | 'TEXT' | null = null;
  for (const raw of values) {
    const v = raw.trim();
    if (v === '') continue;
    if (/^[+-]?\d+$/.test(v) && Number.isSafeInteger(Number(v))) t = t ?? 'INTEGER';
    else if (NUMBER.test(v) && Number.isFinite(Number(v))) t = t === 'TEXT' ? 'TEXT' : 'REAL';
    else return 'TEXT';
  }
  return t ?? 'TEXT';
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableNameFor(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z_]/.test(base) && base.length > 0 ? base.slice(0, 63) : `data${base === '' ? '' : `_${base}`}`.slice(0, 63);
}

async function writeRowsSnapshot(tmp: string, table: string, names: string[], types: string[], rows: string[][]): Promise<void> {
  let sqlite: typeof import('node:sqlite');
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new UploadError('sqlite_unavailable', 'uploads need Node.js with node:sqlite (24.12 or later)');
  }
  const db = new sqlite.DatabaseSync(tmp);
  try {
    db.exec(`CREATE TABLE ${quote(table)} (${names.map((n, i) => `${quote(n)} ${types[i]}`).join(', ')})`);
    const ins = db.prepare(`INSERT INTO ${quote(table)} VALUES (${names.map(() => '?').join(', ')})`);
    db.exec('BEGIN');
    for (const r of rows) {
      ins.run(
        ...names.map((_n, i) => {
          const v = (r[i] ?? '').trim();
          if (v === '') return null;
          if (types[i] === 'INTEGER') return Number(v);
          if (types[i] === 'REAL') return Number(v);
          return r[i] ?? '';
        }),
      );
    }
    db.exec('COMMIT');
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}

async function store(tmp: string, dir: string): Promise<{ digest: string; bytes: number; path: string }> {
  const bytes = await readFile(tmp);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = snapshotPath(digest, dir);
  try {
    await stat(path);
    await rm(tmp, { force: true }); // the same content is already stored
  } catch {
    await chmod(tmp, 0o400);
    await rename(tmp, path);
  }
  return { digest, bytes: bytes.length, path };
}

function kindOf(filename: string, data: Buffer): UploadKind {
  if (data.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') return 'sqlite';
  if (data.readUInt32LE(0) === 0x04034b50) return 'xlsx';
  const ext = filename.toLowerCase().replace(/^.*\./, '');
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'sqlite' || ext === 'db' || ext === 'sqlite3') return 'sqlite';
  return 'csv';
}

/** Turn one uploaded file into a stored snapshot (or refuse it). */
export async function ingestUpload(filename: string, data: Buffer, opts: { dir?: string } = {}): Promise<UploadResult> {
  if (data.length > UPLOAD_LIMITS.fileBytes) throw new UploadError('too_large', `an upload is at most ${UPLOAD_LIMITS.fileBytes / (1024 * 1024)} MB`);
  if (data.length < 4) throw new UploadError('empty', 'the file is empty');
  const dir = opts.dir ?? snapshotDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmp-${randomUUID()}.sqlite`);
  const kind = kindOf(filename, data);
  try {
    if (kind === 'sqlite') {
      if (data.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new UploadError('bad_sqlite', 'the file is not a SQLite database');
      await writeFile(tmp, data, { mode: 0o600 });
      const inspected = await sqliteInspect(tmp);
      const bad = inspected.objects.filter((o) => o.type === 'view' || o.type === 'trigger' || o.virtual);
      if (bad.length > 0) {
        throw new UploadError('sqlite_code', `an uploaded .sqlite may hold only tables and indexes; it holds ${bad.map((o) => `${o.virtual ? 'the virtual table' : `the ${o.type}`} ${o.name}`).join(', ')}`);
      }
      const total = inspected.catalog.relations.reduce((a, r) => a + (r.rowEstimate ?? 0), 0);
      if (total > UPLOAD_LIMITS.rows) throw new UploadError('too_many_rows', `the database has more than ${UPLOAD_LIMITS.rows} rows`);
      if (inspected.catalog.relations.some((r) => r.columns.length > UPLOAD_LIMITS.columns)) throw new UploadError('too_many_columns', `a table has more than ${UPLOAD_LIMITS.columns} columns`);
      const s = await store(tmp, dir);
      return { digest: s.digest, bytes: s.bytes, kind, table: null, header: null, sample: [], catalog: (await sqliteInspect(s.path)).catalog };
    }
    const deadline = Date.now() + UPLOAD_LIMITS.parseMs;
    const rows =
      kind === 'xlsx'
        ? parseXlsx(data, deadline)
        : parseCsv(data.toString('utf8').replace(/^﻿/, ''), deadline);
    if (rows.length === 0) throw new UploadError('empty', 'the file has no rows');
    const first = rows[0] as string[];
    const header = looksLikeHeader(first);
    const width = Math.max(...rows.map((r) => r.length));
    const names = columnNames(first, width, header);
    const body = header ? rows.slice(1) : rows;
    if (body.length > UPLOAD_LIMITS.rows) throw new UploadError('too_many_rows', `the file has more than ${UPLOAD_LIMITS.rows} rows`);
    const types = names.map((_n, i) => inferType((function* () {
      for (const r of body) yield r[i] ?? '';
    })()));
    const table = tableNameFor(filename);
    await writeRowsSnapshot(tmp, table, names, types, body);
    const s = await store(tmp, dir);
    return {
      digest: s.digest,
      bytes: s.bytes,
      kind,
      table,
      header: { detected: header, columns: names },
      sample: body.slice(0, UPLOAD_LIMITS.sampleRows).map((r) => names.map((_n, i) => r[i] ?? '')),
      catalog: (await sqliteInspect(s.path)).catalog,
    };
  } finally {
    await rm(tmp, { force: true });
  }
}
