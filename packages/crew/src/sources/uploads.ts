/**
 * Uploads (DES-APPS-001 §5.1 "SQLite and files", §7.5 limits): a CSV, an XLSX (first sheet) or a
 * `.sqlite` file becomes a SQLite SNAPSHOT in crew's content-addressed store,
 * `<state home>/mcp/snapshots/<sha256>.sqlite` — outside any git repo (an app repo holds only the
 * digest) and inside the state-home entry workers are fenced out of.
 *
 * - CSV/XLSX: parsed in the killable runner child (crew#1289), header detected (a first row that
 *   looks like data becomes `col_1…`), types inferred (INTEGER, REAL, TEXT), written to a SQLite file.
 *   The first 20 rows are returned for the PERSON's sheet only (the route never gives them to an agent).
 * - XLSX is a zip: entries are inflated with a hard output cap, so a file that expands past 200 MB is
 *   refused before it is held (a zip bomb). Zip64, encryption and unknown methods are refused.
 * - `.sqlite`: refused if it holds a view or a trigger (§5.1), inspected in the snapshot runner's child
 *   process, never in the daemon. A virtual table (a full-text index, an R-tree) is dropped from crew's copy
 *   with its shadow tables, in the same child, and the result names it (crew#1731); one whose module this
 *   SQLite lacks cannot be dropped, and the file is refused naming it.
 * - A crash mid-upload leaves its `.tmp-*` files behind: each upload first removes the ones older than
 *   {@link STALE_TMP_MS} (crew#1724).
 * - Limits: 50 MB file, 200 MB after decompression, 1,000,000 rows, 200 columns, 30 s to parse.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { mcpStateDir } from '../mcp/registry-store.js';
import type { SqlCatalog } from './catalog/types.js';
import { isRunnerFailure, sqliteIngest, sqliteInspect, sqliteStrip } from './drivers/sqlite.js';
import { SourceQueryError } from './drivers/types.js';

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

const tooSlow = (): UploadError => new UploadError('too_slow', `the file took more than ${UPLOAD_LIMITS.parseMs / 1000} s to load`);

/** Throw `too_slow` once the upload's one absolute deadline has passed. */
function within(deadline: number): void {
  if (Date.now() > deadline) throw tooSlow();
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
  /** `.sqlite`: the virtual tables dropped from the snapshot with their shadow tables (crew#1731); `[]` otherwise. */
  dropped: string[];
  catalog: SqlCatalog;
}

/**
 * (crew#1724) A `.tmp-*` file in the snapshot store older than this is left by an upload that never finished (the daemon
 * died mid-upload). Twice the upload's deadline: a live upload's files are younger than its deadline, and the margin
 * covers the steps after its last check (storing the snapshot, the cleanup).
 */
export const STALE_TMP_MS = 2 * UPLOAD_LIMITS.parseMs;
/** The temporary files an upload writes in the store: its bytes, the snapshot being built and its journals. */
const TMP_FILE_RE = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:upload|sqlite(?:-journal|-wal|-shm)?)$/;

/**
 * The temporary files of the uploads this process is running (codex r1): never swept, however long one has stalled. Only
 * one daemon writes a state home's snapshot store, so these are all the live ones.
 */
const liveTmp = new Set<string>();

/**
 * Remove the store's stale `.tmp-*` files (crew#1724), never a live upload's. Housekeeping: a failure is never the
 * upload's. `now`: TESTS ONLY.
 */
export async function sweepStale(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!TMP_FILE_RE.test(n)) continue;
    const p = join(dir, n);
    if (liveTmp.has(p.replace(/-(?:journal|wal|shm)$/, ''))) continue;
    try {
      if (now - (await stat(p)).mtimeMs > STALE_TMP_MS) await rm(p, { force: true });
    } catch {
      // gone already, or not ours to judge now
    }
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
  if (data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) return 'xlsx';
  const ext = filename.toLowerCase().replace(/^.*\./, '');
  if (ext === 'xlsx') return 'xlsx';
  if (/^(sqlite3?|db)$/.test(ext)) return 'sqlite';
  return 'csv';
}

/** Turn one uploaded file into a stored snapshot (or refuse it). */
/**
 * Whether this runtime can hold snapshots: node:sqlite with the authorizer and defensive mode, Node.js
 * 24.12 or later. Judged from the version (the daemon itself never loads node:sqlite; the runner child
 * checks the API again and refuses with the same words).
 */
function sqliteAvailable(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 25 || (major === 25 && minor >= 1) || (major === 24 && minor >= 12);
}

/** The runner's own refusal on a runtime without the authorizer or defensive mode, as the upload's. */
function unavailable(err: unknown): UploadError | null {
  const message = typeof err === 'string' ? err : err instanceof SourceQueryError ? err.message : '';
  return /need Node\.js 24\.12/.test(message) ? new UploadError('sqlite_unavailable', UNAVAILABLE) : null;
}

const UNAVAILABLE = 'uploads need Node.js 24.12, 25.1 or later (its built-in SQLite, with the authorizer and defensive mode)';

/** `p` with every symlink of its longest existing prefix resolved (the rest does not exist yet). */
async function realPath(p: string): Promise<string> {
  const rest: string[] = [];
  for (let d = resolve(p); ; d = dirname(d)) {
    try {
      return join(await realpath(d), ...rest.reverse());
    } catch {
      if (dirname(d) === d) return resolve(p);
      rest.push(basename(d));
    }
  }
}

/**
 * The nearest git work tree holding `dir`, or `null`. Snapshots never live inside one (DES §4): the
 * repo is mounted into agent seats, so a state home inside a project checkout would put snapshot rows
 * where seats and `git add` reach. The climb follows REAL paths (a symlinked state directory does not
 * hide the checkout it points into) and stops at the user's home directory: a repository of the home
 * itself (dotfiles) is no project a seat mounts, and the store's own `.gitignore` keeps `git add` off it.
 */
async function repoAround(dir: string): Promise<string | null> {
  const home = await realPath(homedir());
  for (let d = await realPath(dir); ; d = dirname(d)) {
    if (d === home) return null;
    try {
      await stat(join(d, '.git'));
      return d;
    } catch {
      // keep climbing
    }
    if (dirname(d) === d) return null;
  }
}

/** The snapshot runner's inspection, inside what is left of the upload's deadline. */
async function inspectWithin(path: string, deadline: number): ReturnType<typeof sqliteInspect> {
  within(deadline);
  try {
    return await sqliteInspect(path, Math.max(1, deadline - Date.now()));
  } catch (err) {
    if (err instanceof SourceQueryError && err.errorClass === 'timeout') throw tooSlow();
    throw unavailable(err) ?? err;
  }
}

/**
 * @param opts.parseMs TESTS ONLY: the upload's one absolute deadline (default {@link UPLOAD_LIMITS}.parseMs),
 *   which parsing, type inference, writing and every inspection share.
 */
export async function ingestUpload(filename: string, data: Buffer, opts: { dir?: string; header?: 'yes' | 'no' | null; parseMs?: number } = {}): Promise<UploadResult> {
  const deadline = Date.now() + (opts.parseMs ?? UPLOAD_LIMITS.parseMs);
  if (data.length > UPLOAD_LIMITS.fileBytes) throw new UploadError('too_large', `an upload is at most ${UPLOAD_LIMITS.fileBytes / (1024 * 1024)} MB`);
  if (data.length === 0) throw new UploadError('empty', 'the file is empty');
  if (!sqliteAvailable()) throw new UploadError('sqlite_unavailable', UNAVAILABLE);
  const dir = opts.dir ?? snapshotDir();
  const repo = await repoAround(dir);
  if (repo !== null) throw new UploadError('snapshot_in_repo', `the snapshot store ${dir} is inside the git work tree ${repo}; snapshots are kept outside any repository (move crew's state home out of it)`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Whatever holds the store, `git add` never stages a snapshot.
  await writeFile(join(dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
  await sweepStale(dir);
  const tmp = join(dir, `.tmp-${randomUUID()}.sqlite`);
  const input = join(dir, `.tmp-${randomUUID()}.upload`);
  const kind = kindOf(filename, data);
  liveTmp.add(tmp);
  liveTmp.add(input);
  try {
    if (kind === 'sqlite') {
      if (data.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new UploadError('bad_sqlite', 'the file is not a SQLite database');
      await writeFile(tmp, data, { mode: 0o600 });
      let inspected = await inspectWithin(tmp, deadline);
      const code = inspected.objects.filter((o) => o.type !== 'table' && o.type !== 'index');
      if (code.length > 0) {
        throw new UploadError('sqlite_code', `an uploaded .sqlite may hold only tables and indexes; it holds ${code.map((o) => `the ${o.type} ${o.name}`).join(', ')}`);
      }
      // (crew#1731) Virtual tables are dropped from this copy (their shadow tables go with them), then the copy is
      // inspected again: what is left must be plain tables and indexes.
      const dropped = inspected.objects.filter((o) => o.virtual).map((o) => o.name);
      // Every table that belonged to them: one that outlives the drop (a declaration rewritten so the module's destroy
      // skips it) is refused, never kept as a plain table (codex r1).
      const theirs = new Set([...dropped, ...inspected.objects.filter((o) => o.shadow).map((o) => o.name)]);
      if (dropped.length > 0) {
        within(deadline);
        let failed: Array<{ name: string; error: string }>;
        try {
          failed = (await sqliteStrip(tmp, dropped, Math.max(1, deadline - Date.now()))).failed;
        } catch (err) {
          if (err instanceof SourceQueryError && err.errorClass === 'timeout') throw tooSlow();
          throw unavailable(err) ?? err;
        }
        if (failed.length > 0) {
          throw new UploadError('sqlite_code', `an uploaded .sqlite may hold only tables and indexes, and crew could not drop ${failed.map((f) => `the virtual table ${f.name} (${f.error})`).join(', ')} from its copy; drop ${failed.length === 1 ? 'it' : 'them'} from a copy of the file (DROP TABLE <name>) and upload that`);
        }
        inspected = await inspectWithin(tmp, deadline);
        const left = inspected.objects.filter((o) => (o.type !== 'table' && o.type !== 'index') || o.virtual || o.shadow || theirs.has(o.name));
        if (left.length > 0) throw new UploadError('sqlite_code', `an uploaded .sqlite may hold only tables and indexes; after its virtual tables were dropped it still holds ${left.map((o) => o.name).join(', ')}`);
      }
      if (inspected.generated.length > 0) throw new UploadError('sqlite_code', `an uploaded .sqlite may not hold generated or hidden columns; it holds ${inspected.generated.join(', ')}`);
      const total = inspected.catalog.relations.reduce((a, r) => a + (r.rowEstimate ?? 0), 0);
      if (total > UPLOAD_LIMITS.rows) throw new UploadError('too_many_rows', `the database has more than ${UPLOAD_LIMITS.rows} rows`);
      if (inspected.catalog.relations.some((r) => r.columns.length > UPLOAD_LIMITS.columns)) throw new UploadError('too_many_columns', `a table has more than ${UPLOAD_LIMITS.columns} columns`);
      const s = await store(tmp, dir);
      return { digest: s.digest, bytes: s.bytes, kind, table: null, header: null, sample: [], dropped, catalog: (await inspectWithin(s.path, deadline)).catalog };
    }
    await writeFile(input, data, { mode: 0o600 });
    within(deadline);
    let ingested;
    try {
      ingested = await sqliteIngest(tmp, input, kind, filename, opts.header ?? null, UPLOAD_LIMITS, Math.max(1, deadline - Date.now()));
    } catch (err) {
      if (err instanceof SourceQueryError && err.errorClass === 'timeout') throw tooSlow();
      // Only the child's own failure is the file's; a runner that could not start or answered too much passes
      // through as before (crew#1721 coord r1).
      if (isRunnerFailure(err)) throw unavailable(err) ?? new UploadError('unreadable', 'crew could not read the file (its parser failed)');
      throw unavailable(err) ?? err;
    }
    if (!ingested.ok) {
      if (ingested.refused === true) throw new UploadError(ingested.code, ingested.error);
      throw unavailable(ingested.error) ?? new UploadError('unreadable', 'crew could not read the file (its parser failed)');
    }
    const s = await store(tmp, dir);
    return {
      digest: s.digest,
      bytes: s.bytes,
      kind,
      table: ingested.table,
      header: ingested.header,
      sample: ingested.sample,
      dropped: [],
      catalog: (await inspectWithin(s.path, deadline)).catalog,
    };
  } finally {
    // The file and any journal a runner ended mid-transaction left beside it.
    await Promise.all([rm(input, { force: true }), ...['', '-journal', '-wal', '-shm'].map((s) => rm(`${tmp}${s}`, { force: true }))]);
    liveTmp.delete(tmp);
    liveTmp.delete(input);
  }
}
