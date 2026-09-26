/**
 * THE CREW BUS WRITER (crew#679) — the single owner of every bus row in-daemon crew code writes.
 *
 * The daemon's bus file is the engine's too (DES-TEAMING-002 T0), written through the engine's
 * bundled SQLite. Crew must not write it through its own SQLite copy in the same process: POSIX
 * locks belong to the process, so two libraries in one process do not exclude each other and a
 * concurrent write corrupts the file (sqlite.org/howtocorrupt.html §2.2.1). The engine exposes no
 * way to emit crew's rows (wicked-core-ts has no bus-emit call), so crew's writes go to ONE child
 * process instead: a plain wicked-bus emitter holding its own connection. Another process's locks
 * are real locks against the engine's, which is the case SQLite is built for; the interactive
 * bridge and the `wicked-bus` CLI already write the same file that way.
 *
 * One writer per bus file, spawned on the first emit, fed NDJSON on stdin and answering one line
 * per request, in order (so crew's rows land in the order crew emitted them). It exits when crew
 * has had nothing to write for {@link IDLE_MS}; the next emit spawns a fresh one. A writer that
 * dies fails its pending emits (the seams log and report them as they did a refused emit).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

/** One row, as wicked-bus `emit` takes it. */
export interface BusRow {
  event_type: string;
  domain: string;
  subdomain?: string;
  payload: unknown;
  idempotency_key?: string;
  producer_id?: string;
}

/** A refused emit: `error` carries wicked-bus's code (`WB-002` = the key was already emitted). */
export class BusWriteError extends Error {
  constructor(
    message: string,
    readonly error?: string,
  ) {
    super(message);
    this.name = 'BusWriteError';
  }
}

/** Exit after this long with nothing to write. */
const IDLE_MS = 30_000;

// The child: open the bus once, emit each line's row, answer `{ id, ok, event_id | error, message }`.
const CHILD = `
import { createInterface } from 'node:readline';
const [busUrl, dbPath] = process.argv.slice(1);
const bus = await import(busUrl);
const override = { db_path: dbPath };
let db, config;
try {
  config = bus.loadConfig(override);
  db = bus.openDb(override);
} catch (err) {
  process.stderr.write('cannot open the bus: ' + (err && err.message ? err.message : String(err)));
  process.exit(1);
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
createInterface({ input: process.stdin })
  .on('line', (line) => {
    let id = null;
    try {
      const req = JSON.parse(line);
      id = req.id;
      out({ id, ok: true, event_id: bus.emit(db, config, req.row).event_id });
    } catch (err) {
      out({ id, ok: false, error: err && err.error, message: err && err.message ? err.message : String(err) });
    }
  })
  .on('close', () => process.exit(0));
`;

interface Pending {
  resolve: (eventId: number) => void;
  reject: (err: Error) => void;
}
interface Writer {
  child: ChildProcess;
  pending: Map<number, Pending>;
  idle: NodeJS.Timeout | null;
}

const writers = new Map<string, Writer>();
let nextId = 1;
let busUrl: string | undefined;

/** wicked-bus's ESM entry (its `exports["."].import`): `require.resolve` would name the CJS shim. */
function wickedBusUrl(): string {
  if (busUrl === undefined) {
    const pkgJson = createRequire(import.meta.url).resolve('wicked-bus/package.json');
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { exports: { '.': { import: { default: string } } } };
    busUrl = pathToFileURL(join(dirname(pkgJson), pkg.exports['.'].import.default)).href;
  }
  return busUrl;
}

/** The writer only keeps the daemon alive while it owes an answer. */
function hold(w: Writer, on: boolean): void {
  const streams = [w.child.stdin, w.child.stdout, w.child.stderr] as unknown as Array<{ ref?(): void; unref?(): void } | null>;
  if (on) {
    w.child.ref();
    for (const s of streams) s?.ref?.();
  } else {
    w.child.unref();
    for (const s of streams) s?.unref?.();
  }
}

function writerFor(dbPath: string): Writer {
  const existing = writers.get(dbPath);
  if (existing !== undefined) return existing;
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, wickedBusUrl(), dbPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const w: Writer = { child, pending: new Map(), idle: null };
  writers.set(dbPath, w);
  let stderr = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-2000);
  });
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let msg: { id?: number; ok?: boolean; event_id?: number; error?: string; message?: string };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    const p = msg.id !== undefined ? w.pending.get(msg.id) : undefined;
    if (p === undefined) return;
    w.pending.delete(msg.id!);
    if (msg.ok === true) p.resolve(msg.event_id ?? 0);
    else p.reject(new BusWriteError(msg.message ?? 'bus emit refused', msg.error ?? undefined));
    settle(dbPath, w);
  });
  const fail = (why: string): void => {
    if (writers.get(dbPath) === w) writers.delete(dbPath);
    if (w.idle !== null) clearTimeout(w.idle);
    const err = new BusWriteError(`bus writer for ${dbPath} ${why}${stderr !== '' ? `: ${stderr.trim()}` : ''}`);
    for (const p of w.pending.values()) p.reject(err);
    w.pending.clear();
  };
  // A write to a writer that just died is EPIPE: its pending emits fail through `exit` below.
  child.stdin?.on('error', () => undefined);
  child.on('error', (err) => fail(`failed: ${err.message}`));
  child.on('exit', (code, signal) => fail(`exited (${signal ?? code})`));
  return w;
}

/** Nothing owed: stop keeping the daemon alive, and retire the writer if it stays idle. */
function settle(dbPath: string, w: Writer): void {
  if (w.pending.size > 0) return;
  hold(w, false);
  if (w.idle !== null) clearTimeout(w.idle);
  w.idle = setTimeout(() => {
    if (w.pending.size > 0) return;
    if (writers.get(dbPath) === w) writers.delete(dbPath);
    w.child.stdin?.end(); // the child exits on EOF
  }, IDLE_MS);
  w.idle.unref();
}

/**
 * Emit one row on the bus at `dbPath` through the writer. Resolves to the row's `event_id`;
 * rejects with a {@link BusWriteError} (`error: 'WB-002'` for a key already emitted).
 */
export function emitOnBus(dbPath: string, row: BusRow): Promise<number> {
  const key = resolve(dbPath);
  const w = writerFor(key);
  if (w.idle !== null) {
    clearTimeout(w.idle);
    w.idle = null;
  }
  hold(w, true);
  const id = nextId++;
  return new Promise<number>((res, rej) => {
    w.pending.set(id, { resolve: res, reject: rej });
    w.child.stdin?.write(`${JSON.stringify({ id, row })}\n`);
  });
}
