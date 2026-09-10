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
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { CoreAdapter, GovernanceReplayUnsupportedError, type EmitOutboxReplayReport } from '../core/adapter.js';
import {
  EMIT_DEADLETTER_ENGINE_ENV,
  ESTATE_DB_ENGINE_ENV,
  GOVERNANCE_DB_ENV,
  GOVERNANCE_DB_FLAG,
  isStoreSpec,
  resolveGovernanceStore,
  type GovernanceStoreLocation,
} from '../core/governance-store.js';
import { foldDeadletters } from '../api/governance-health.js';
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

/** Resolve the target store for a replay — `serve`'s rule, over the core db named (or defaulted). */
export function replayTarget(args: string[], env: NodeJS.ProcessEnv = process.env): GovernanceStoreLocation {
  const coreDbPath = flagValue(args, '--db') ?? join(crewStateHome(), 'core.db');
  return resolveGovernanceStore({
    flagDb: flagValue(args, GOVERNANCE_DB_FLAG),
    envCrewDb: env[GOVERNANCE_DB_ENV],
    envEstateDb: env[ESTATE_DB_ENGINE_ENV],
    coreDbPath,
  });
}

/** The archive name a drained outbox is renamed to. */
export function archiveNameFor(outbox: string, now: Date = new Date()): string {
  return `${outbox}.replayed-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Put an archived outbox back after a replay that threw — APPEND-ONLY, never a rename over the
 * live path: a daemon can create a fresh outbox at any instant, and an `exists`-then-`rename` would
 * replace it and lose what it had just spooled (Copilot on #516). Appending (`O_APPEND`, so a
 * concurrent spool is never clobbered — the file is created if absent) is loss-free in every
 * interleaving; the cost is the two batches' relative order when the daemon did spool meanwhile
 * (each entry carries its own `ts` on a stamping engine). Streamed, never the whole archive in
 * memory; the archive is removed only after its last byte is on the live outbox, and a missing
 * trailing newline is repaired so a later spool never joins onto the last restored line.
 */
export async function restoreOutbox(outbox: string, archive: string): Promise<void> {
  const size = statSync(archive).size;
  await pipeline(createReadStream(archive), createWriteStream(outbox, { flags: 'a' }));
  if (size > 0) {
    const fd = openSync(archive, 'r');
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) appendFileSync(outbox, '\n', 'utf8');
    } finally {
      closeSync(fd);
    }
  }
  rmSync(archive);
}

export interface ReplayOutcome {
  outbox: string;
  store: { path: string; source: string };
  archive: string | null;
  read: number;
  replayed: number;
  failed: number;
  dryRun: boolean;
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
        failed: 0,
        dryRun: true,
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

  // 1. Archive first — atomic, so nothing the daemon appends from here on is lost.
  const archive = archiveNameFor(outbox);
  renameSync(outbox, archive);
  // 2. Replay from the archive. If the engine THROWS (a store it cannot open, an I/O error
  //    mid-file, a permission problem) the archive goes back where the daemon spools and
  //    `/diagnostics` looks — an exception must never turn "not replayed" into "0 dead letters"
  //    (Copilot on #516). Restored WHOLE: the engine may have landed some records before it threw,
  //    so a later replay can duplicate those (visible on the store, auditable via `replayed`);
  //    losing the rest would not be visible anywhere.
  let report: EmitOutboxReplayReport;
  try {
    report = await CoreAdapter.replayEmitOutbox(archive, store.dbPath);
  } catch (err) {
    await restoreOutbox(outbox, archive);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`replay failed and the outbox was restored to ${outbox} (nothing is lost): ${reason}`);
  }
  // 3. What did not land stays a dead letter on the live outbox (append: the daemon may have
  //    started a fresh file already).
  if (report.failed.length > 0) {
    appendFileSync(outbox, `${report.failed.map((f) => f.line).join('\n')}\n`, 'utf8');
  }
  return {
    outcome: {
      outbox,
      store: { path: store.displayPath, source: store.source },
      archive,
      read: report.read,
      replayed: report.replayed,
      failed: report.failed.length,
      dryRun: false,
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
    if (!outcome.dryRun && outcome.failed > 0) {
      console.error(`[governance] ${outcome.failed} entr${outcome.failed === 1 ? 'y' : 'ies'} did not land and were appended back onto ${outcome.outbox}`);
    }
    process.exit(exitCode);
  } catch (err) {
    if (err instanceof UsageError) {
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
