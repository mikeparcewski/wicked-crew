/**
 * `wicked-crew governance replay <outbox> [--governance-db <path> | --db <core db>] [--dry-run]`
 * (crew#495, F-022): drain a dead-letter outbox back into the governance store.
 *
 * The engine spools every `wicked.*` event it could not store as one NDJSON line (`emit.rs`
 * `spool_record`: the envelope plus `deadletter_reason`, and — on engines carrying crew#495's
 * companion — `ts`, `pid`, `origin`). This command hands that file to the engine, which writes
 * each record as the EVENT node it should have been, restoring the original `ts` where the record
 * carries one so an id-ordered scan of the store is still chronological.
 *
 * Drain order matters, because the daemon may be appending to the SAME file while this runs:
 *   1. RENAME the outbox to `<outbox>.replayed-<ISO>` first — atomic, so the daemon's next spool
 *      recreates a fresh file and no entry is lost between the read and the archive;
 *   2. replay from the archived file;
 *   3. APPEND the entries that failed to land back onto the live outbox — they stay dead letters,
 *      visible on `/diagnostics`, and the archive keeps the full record of what was attempted.
 * `--dry-run` folds the outbox in place (count, types, reasons, timestamp range) and moves nothing.
 *
 * Target store resolution is `serve`'s (`core/governance-store.ts`): `--governance-db` ›
 * `WICKED_CREW_GOVERNANCE_DB` › an inherited `WICKED_ESTATE_DB` › `<core db>.governance/
 * governance.db`, with `--db` naming the core db (default: the state home's `core.db`).
 *
 * Exit codes: 0 every entry landed (or dry run); 1 some entries failed (they are back on the
 * outbox); 2 the installed engine cannot replay (`Core.replayEmitOutbox` absent — upgrade
 * wicked-core-ts), or the arguments are wrong.
 */

import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { randomBytes } from 'node:crypto';

import { CoreAdapter, GovernanceReplayUnsupportedError, type EmitOutboxReplayReport } from '../core/adapter.js';
import { CrewBusError, resolveCrewBus } from '../interactive/bus-location.js';
import {
  EMIT_DEADLETTER_ENGINE_ENV,
  ESTATE_DB_ENGINE_ENV,
  GOVERNANCE_DB_ENV,
  GOVERNANCE_DB_FLAG,
  GovernanceStoreError,
  isStoreSpec,
  resolveGovernanceStore,
  type GovernanceStoreLocation,
} from '../core/governance-store.js';
import { foldDeadletters, type DeadletterFold } from '../api/governance-health.js';
import { crewStateHome } from '../projects/state-home.js';

export const GOVERNANCE_USAGE =
  'Usage: wicked-crew governance replay <outbox.ndjson> [--governance-db <path> | --db <core db>] [--dry-run]\n' +
  '\n' +
  'Replay a dead-letter outbox (the engine\'s NDJSON spool of governance events it could not store)\n' +
  'into the governance store. Resolution of the store matches `serve`:\n' +
  `  ${GOVERNANCE_DB_FLAG} <path>  explicit store (env: ${GOVERNANCE_DB_ENV}; an inherited ${ESTATE_DB_ENGINE_ENV} is honoured next)\n` +
  '  --db <path>              the core db whose sidecar store is the default target (<core db>.governance/governance.db;\n' +
  '                           default core db: ~/.wicked-crew/core.db)\n' +
  '  --dry-run                fold the outbox (count, types, reasons, timestamp range) and move nothing\n' +
  '\n' +
  'The outbox is archived to <outbox>.replayed-<timestamp> BEFORE replay (so a running daemon\'s next\n' +
  'spool starts a fresh file); entries that fail to land are appended back onto the outbox.\n' +
  `A daemon's own outbox is <core db>.governance/emit-outbox.ndjson (env: ${EMIT_DEADLETTER_ENGINE_ENV});\n` +
  'a pre-fix engine wrote ~/.something-wicked/wicked-apps/emit-outbox.ndjson.';

/** crew's own package version, for the origin stamp the engine copies onto dead-letter records. */
export function crewPackageVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A flag that was given must carry a value, and the value must not be another flag. */
function flagValue(args: string[], name: string): string | undefined {
  if (!args.includes(name)) return undefined;
  const value = flag(args, name);
  if (value === undefined || value.startsWith('-')) {
    throw new UsageError(`${name} requires a value (got: ${value ?? '(missing)'})`);
  }
  return value;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The flags that take a value — their value is never a positional. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--db', GOVERNANCE_DB_FLAG]);

/** The non-flag arguments, in order (`--dry-run` takes no value; `--db` / `--governance-db` do). */
export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (VALUE_FLAGS.has(a)) {
      i += 1; // skip the flag's value
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

/** Resolve the target store for a replay — `serve`'s rule, over the core db named (or defaulted),
 *  with the cross-product bus resolved the way `serve` resolves it (`WICKED_BUS_DB` ›
 *  `WICKED_BUS_DATA_DIR` › `<core db>.bus/bus.db`) so the bus db is refused as a target here too. */
export function replayTarget(args: string[], env: NodeJS.ProcessEnv = process.env): GovernanceStoreLocation {
  const coreDbPath = flagValue(args, '--db') ?? join(crewStateHome(), 'core.db');
  const bus = resolveCrewBus({ explicitDb: env['WICKED_BUS_DB'], envDataDir: env['WICKED_BUS_DATA_DIR'], coreDbPath });
  return resolveGovernanceStore({
    flagDb: flagValue(args, GOVERNANCE_DB_FLAG),
    envCrewDb: env[GOVERNANCE_DB_ENV],
    envEstateDb: env[ESTATE_DB_ENGINE_ENV],
    coreDbPath,
    busDbPath: bus.dbPath,
  });
}

/** The archive name a drained outbox is renamed to: timestamp + pid + a random nonce, so two replays
 *  of the same outbox in the same millisecond (or two processes) can never pick one name and have a
 *  later rename replace the earlier archive — the full recovery/audit copy. */
export function archiveNameFor(outbox: string, now: Date = new Date(), nonce: string = randomBytes(3).toString('hex')): string {
  return `${outbox}.replayed-${now.toISOString().replace(/[:.]/g, '-')}-${process.pid}-${nonce}`;
}

/** A fresh archive name that does not exist yet (the nonce makes a collision astronomically
 *  unlikely; the check makes it impossible to rename over an existing archive). */
function reserveArchiveName(outbox: string): string {
  for (;;) {
    const candidate = archiveNameFor(outbox);
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Put the lines that did not land back onto the live outbox — and if THAT write fails (permissions,
 * a full disk), say exactly where they are: the archive is retained (nothing is lost on disk), but
 * `/diagnostics` folds only the live path, so without this the operator would see fewer dead letters
 * than exist.
 */
export function appendFailedLines(outbox: string, archive: string, lines: string[]): void {
  try {
    appendLines(outbox, lines);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${lines.length} line(s) that failed to replay could not be written back to ${outbox} — they remain in the ` +
        `retained archive ${archive} (nothing is lost; /diagnostics does not fold the archive): ${reason}`,
    );
  }
}

/**
 * The caveat a replay that found entries `already_present` must state when the outbox holds
 * UNTIMESTAMPED (pre-stamp) entries: replay ids are content-addressed, and with no stamp to tell
 * them apart, byte-identical unstamped lines share one id — two dead letters of the same event land
 * once. `null` when there is nothing to say.
 */
export function conflationNote(alreadyPresent: number, fold: Pick<DeadletterFold, 'untimestamped'>): string | null {
  if (alreadyPresent <= 0 || fold.untimestamped <= 0) return null;
  return (
    `${alreadyPresent} entr${alreadyPresent === 1 ? 'y was' : 'ies were'} already on the store. This outbox holds ` +
    `${fold.untimestamped} untimestamped (pre-stamp) entr${fold.untimestamped === 1 ? 'y' : 'ies'}: byte-identical ` +
    'unstamped lines share one replay id, so two dead letters of the same event land once (stamped lines never conflate ' +
    'unless their ts and content both match).'
  );
}

const NL = 0x0a;

/**
 * Keep every NDJSON record whole while streaming one file onto another that a concurrent writer may
 * also be appending to. Every chunk this transform emits is a whole number of records — it buffers
 * up to the last `\n` it has seen and holds the partial tail until more arrives — so an `O_APPEND`
 * write from the other writer landing between two of our writes can only ever sit BETWEEN records,
 * never inside one (read-stream chunks are 64 KiB and not line-aligned; forwarding them raw would
 * let a fresh record be spliced into the middle of an archived one). Two repairs ride INSIDE the
 * data writes, never as separate writes a concurrent spool could slip in front of: a leading `\n`
 * always opens the first emitted chunk (the live file may gain a torn tail between any look and
 * our first write — a check-then-write cannot close that, an unconditional separator does; an
 * empty NDJSON line is skipped by every reader), and a source whose last record lacks its newline
 * gets one appended to that same final write.
 */
export class LineBoundaryGuard extends Transform {
  private carry: Buffer = Buffer.alloc(0);
  private first = true;

  constructor(private readonly leading: boolean) {
    super();
  }

  /** Push one chunk of whole records, opening the very first with the leading separator. */
  private pushRecords(data: Buffer): void {
    let out = data;
    if (this.first) {
      this.first = false;
      if (this.leading) out = Buffer.concat([Buffer.from('\n'), out]);
    }
    this.push(out);
  }

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    const data = Buffer.concat([this.carry, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    const lastNl = data.lastIndexOf(NL);
    if (lastNl < 0) {
      this.carry = data; // no complete record yet — hold everything
    } else {
      this.pushRecords(data.subarray(0, lastNl + 1)); // whole records only
      this.carry = data.subarray(lastNl + 1); // the partial tail, if any
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.carry.length > 0) {
      this.pushRecords(Buffer.concat([this.carry, Buffer.from('\n')])); // the torn last record, terminated in the same write
      this.carry = Buffer.alloc(0);
    }
    cb();
  }
}

/**
 * Append NDJSON lines to a live outbox a daemon may be writing — ONE `write()`, ALWAYS behind a
 * `\n`: the file may be absent, at a boundary, or mid-record at the instant of the write, and no
 * look beforehand can know which (the engine writes a record and its newline as two syscalls), so
 * an unconditional separator is the only race-free choice. At worst it is an empty line, which
 * every reader — the fold, the engine's replay — skips.
 */
export function appendLines(outbox: string, lines: string[]): void {
  if (lines.length === 0) return;
  appendFileSync(outbox, `\n${lines.join('\n')}\n`, 'utf8');
}

/**
 * Put an archived outbox back after a replay that threw — APPEND-ONLY, never a rename over the
 * live path: a daemon can create a fresh outbox at any instant, and an `exists`-then-`rename` would
 * replace it and lose what it had just spooled. Appending (`O_APPEND`, so a concurrent spool is
 * never clobbered — the file is created if absent) is loss-free in every interleaving; the cost is
 * the two batches' relative order when the daemon did spool meanwhile (each entry carries its own
 * `ts` on a stamping engine). Streamed, never the whole archive in memory, through
 * {@link LineBoundaryGuard}: whole records per write, the live tail separated first, a torn last
 * record terminated in its own write. The archive is removed only after its last byte is on the
 * live outbox.
 */
export async function restoreOutbox(outbox: string, archive: string): Promise<void> {
  if (statSync(archive).size > 0) {
    await pipeline(createReadStream(archive), new LineBoundaryGuard(true), createWriteStream(outbox, { flags: 'a' }));
  }
  rmSync(archive);
}

export interface ReplayOutcome {
  outbox: string;
  store: { path: string; source: string };
  archive: string | null;
  read: number;
  replayed: number;
  /** Entries an earlier replay had already landed (a re-replay is a no-op); `null` on an engine that does not report it. */
  alreadyPresent: number | null;
  failed: number;
  dryRun: boolean;
  /** The conflation caveat (see `conflationNote`), or `null`. */
  note: string | null;
  fold?: Awaited<ReturnType<typeof foldDeadletters>>;
}

/**
 * The command body, separated from process I/O so a test can drive it. Returns the outcome and the
 * exit code; throws {@link UsageError} for bad arguments and {@link GovernanceReplayUnsupportedError}
 * on an addon without the binding (the CLI maps both to exit 2).
 */
export async function replayOutbox(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ outcome: ReplayOutcome; exitCode: 0 | 1 }> {
  const outboxArg = positionalArgs(args)[0];
  if (outboxArg === undefined) throw new UsageError('missing <outbox.ndjson>');
  const outbox = resolve(outboxArg);
  if (!existsSync(outbox)) throw new UsageError(`outbox not found: ${outbox}`);
  const dryRun = args.includes('--dry-run');
  const store = replayTarget(args, env);

  if (dryRun) {
    // A dry run folds the FILE and touches no store — so the same target configuration a daemon
    // runs with (`:memory:` included) is inspectable; the refusal below guards only a real replay.
    const fold = await foldDeadletters(outbox);
    return {
      outcome: {
        outbox,
        store: { path: store.displayPath, source: store.source },
        archive: null,
        read: fold.count,
        replayed: 0,
        alreadyPresent: null,
        failed: 0,
        dryRun: true,
        note: null,
        fold,
      },
      exitCode: 0,
    };
  }

  if (store.dbPath === ':memory:') {
    throw new UsageError('refusing to replay into :memory: — name a durable store with --governance-db or --db');
  }
  if (!CoreAdapter.replayEmitOutboxSupported()) {
    throw new GovernanceReplayUnsupportedError('Replaying a dead-letter outbox');
  }
  // The sidecar (or whatever directory the store lives in) must exist before the engine opens it
  // — for a filesystem path, never for an engine spec (`postgres://…`; `:memory:` was refused above).
  if (!isStoreSpec(store.dbPath)) mkdirSync(dirname(store.dbPath), { recursive: true });

  // 1. Archive first — atomic, so nothing the daemon appends from here on is lost; the name is
  //    fresh (timestamp + pid + nonce, checked), so no earlier archive is ever renamed over.
  const archive = reserveArchiveName(outbox);
  renameSync(outbox, archive);
  // 2. Replay from the archive. If the engine THROWS (a store it cannot open, an I/O error
  //    mid-file, a permission problem) the archive goes back where the daemon spools and
  //    `/diagnostics` looks — an exception must never turn "not replayed" into "0 dead letters".
  //    Restored WHOLE: the engine may have landed some records before it threw; a later replay of
  //    those is a no-op (replay ids are deterministic per spool line), so nothing is duplicated and
  //    nothing is lost.
  let report: EmitOutboxReplayReport;
  try {
    report = await CoreAdapter.replayEmitOutbox(archive, store.dbPath);
  } catch (err) {
    await restoreOutbox(outbox, archive);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`replay failed and the outbox was restored to ${outbox} (nothing is lost): ${reason}`);
  }
  // 3. What did not land stays a dead letter on the live outbox (append: the daemon may have
  //    started a fresh file already — and may be mid-record on it, hence the boundary-safe append);
  //    a failed write-back names the archive the lines are still in.
  if (report.failed.length > 0) {
    appendFailedLines(
      outbox,
      archive,
      report.failed.map((f) => f.line),
    );
  }
  const alreadyPresent = report.already_present ?? null;
  const note = alreadyPresent !== null && alreadyPresent > 0 ? conflationNote(alreadyPresent, await foldDeadletters(archive)) : null;
  return {
    outcome: {
      outbox,
      store: { path: store.displayPath, source: store.source },
      archive,
      read: report.read,
      replayed: report.replayed,
      alreadyPresent,
      failed: report.failed.length,
      dryRun: false,
      note,
    },
    exitCode: report.failed.length > 0 ? 1 : 0,
  };
}

/** The `wicked-crew governance …` entry: prints a JSON outcome and exits with the documented code. */
export async function runGovernance(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== 'replay' || rest.includes('--help') || rest.includes('-h')) {
    console.error(GOVERNANCE_USAGE);
    process.exit(sub === 'replay' ? 0 : 2);
  }
  try {
    const { outcome, exitCode } = await replayOutbox(rest);
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.note !== null) console.error(`[governance] ${outcome.note}`);
    if (!outcome.dryRun && outcome.failed > 0) {
      console.error(`[governance] ${outcome.failed} entr${outcome.failed === 1 ? 'y' : 'ies'} did not land and were appended back onto ${outcome.outbox}`);
    }
    process.exit(exitCode);
  } catch (err) {
    if (err instanceof UsageError || err instanceof GovernanceStoreError || err instanceof CrewBusError) {
      console.error(`[governance] ${err.message}\n\n${GOVERNANCE_USAGE}`);
      process.exit(2);
    }
    if (err instanceof GovernanceReplayUnsupportedError) {
      console.error(
        `[governance] ${err.message}\n` +
          'Nothing was moved. Inspect the outbox with --dry-run; replay once the engine is upgraded.',
      );
      process.exit(2);
    }
    throw err;
  }
}
