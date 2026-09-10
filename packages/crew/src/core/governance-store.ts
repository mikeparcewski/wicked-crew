/**
 * WHERE THE GOVERNANCE STORE LIVES — and where its dead letters go (crew#495, acceptance
 * finding F-022). One pure resolution the CLI, the adapter, the diagnostics route and the tests
 * share, in the shape of `interactive/bus-location.ts`.
 *
 * # The defect
 *
 * The engine's emit seam (`wicked-apps-core::emit::emit_event`) publishes every cross-product
 * `wicked.*` event — the conformance claims and decisions the acceptance gate reads back
 * (`wicked.crew.governance.conformance_recorded`), phase transitions, the steering-rule lifecycle
 * (`wicked.estate.rule.ingested` / `.retired`), council traffic — as an EVENT node on the shared
 * estate store named by `WICKED_ESTATE_DB`. `serve` never set that variable, so on EVERY default
 * install EVERY such event dead-lettered: appended to an NDJSON outbox under the operator's HOME
 * (`~/.something-wicked/wicked-apps/emit-outbox.ndjson`), shared by every daemon on the host, with
 * no timestamp, no origin, and nothing on `/diagnostics` or the console to say so — 3,400+ entries
 * on one host while the home board asserted "Governed 100%".
 *
 * # Resolution, in order
 *
 *  1. `--governance-db` / `WICKED_CREW_GOVERNANCE_DB` — the operator's explicit choice;
 *  2. an inherited `WICKED_ESTATE_DB` — the engine's own variable, honoured as-is (pointing several
 *     daemons, or the estate MCP, at ONE shared store is exactly what it exists for);
 *  3. `<core db>.governance/governance.db` — a SIDECAR of the core db, the default. Why a sidecar
 *     and not `<state home>/governance.db`: wicked-core embeds crew's state-home registry
 *     (`tests/fixtures/state-home-subtrees.json`, core `src/state_home.rs`) as the worker Read
 *     fence and REFUSES every launch that meets a top-level entry the registry does not classify.
 *     The registry's `core.db` entry is a PREFIX claim (`file-with-sidecars`) that already covers a
 *     `core.db.governance/` directory, exactly as it covers core's own `core.db.events/` and crew's
 *     `core.db.bus/` (F-043). A new top-level name would need a byte-identical registry change in
 *     BOTH repos and a core release before one governed run could start beside it; the sidecar
 *     needs neither, and `GET /diagnostics.stores` lists it for free. The prefix claim is spelled
 *     for the DEFAULT basename: a `--db` named anything but `core.db` already puts the db itself,
 *     its `-wal`/`-shm`, core's own `<db>.events/` and crew's `<db>.bus/` outside the registry —
 *     this sidecar is no different, so a daemon that hosts governed runs keeps the default
 *     basename (the same residual `interactive/bus-location.ts` documents).
 *
 * Why NOT the core db itself: the single-writer actor holds `core.db` open, and the emit seam opens
 * its OWN connection per emit — pointing it at `core.db` would put a second writer on the actor's
 * store, the one race the single-writer design exists to rule out.
 *
 * # The dead-letter outbox
 *
 * When the store cannot be written (unopenable path, a write error) the engine spools the event to
 * the NDJSON outbox named by `WICKED_APPS_EMIT_DEADLETTER`. An explicit value in the daemon's
 * environment is honoured — it is the engine's own override, and the hermetic test harness relies
 * on it (`tests/setup/hermetic-home.ts`); otherwise the outbox is `<core db>.governance/
 * emit-outbox.ndjson` — under the state home, never under HOME, never shared by two daemons —
 * whichever store won. `GET /diagnostics` folds it (`governance.deadletters`) and raises a
 * `governance.deadletter` finding whenever it holds an entry; `wicked-crew governance replay`
 * drains it back into the store.
 *
 * # Why exporting `WICKED_ESTATE_DB` process-wide is safe
 *
 * The napi engine runs in this process and reads the variable at emit time, so `process.env` is
 * the only channel. The ONLY in-process reader is the emit seam — the actor opens its store by the
 * explicit `--db` path, every governance binding takes its path as an argument. Governed workers
 * never inherit it: core strips it from every spawn (`spawn.rs` `hardened()`, FINDING-067) and
 * re-points a worker's estate channel at the repo's OWN graph (`execute_wrapped.rs`). Crew's own
 * children that would resolve a store from it get the BOOT-TIME value back
 * ({@link childEnvWithBootEstateDb}) — the operator's instruction, not the daemon's sidecar.
 */

import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The `serve` / `governance` flag naming the store explicitly. */
export const GOVERNANCE_DB_FLAG = '--governance-db';
/** The crew-side env override — the flag's environment spelling. */
export const GOVERNANCE_DB_ENV = 'WICKED_CREW_GOVERNANCE_DB';
/** The ENGINE's variable: the shared estate store `wicked-apps-core::emit::emit_event` writes to
 *  (`wicked_apps_core::ESTATE_DB_ENV`). Exported by the daemon; never typed out elsewhere. */
export const ESTATE_DB_ENGINE_ENV = 'WICKED_ESTATE_DB';
/** The ENGINE's dead-letter outbox override (`wicked_apps_core::emit::DEADLETTER_ENV`). */
export const EMIT_DEADLETTER_ENGINE_ENV = 'WICKED_APPS_EMIT_DEADLETTER';
/** The ENGINE's optional origin stamp for spooled entries (`wicked_apps_core::emit::ORIGIN_ENV`,
 *  wicked-core ≥ the release carrying crew#495's companion): copied verbatim onto every
 *  dead-letter record as `origin`, beside the engine's own `ts` (epoch ms) and `pid`. An older
 *  engine ignores it — entries then carry no timestamp, which the fold reports honestly. */
export const EMIT_ORIGIN_ENGINE_ENV = 'WICKED_APPS_EMIT_ORIGIN';

/** The sidecar directory's suffix and the two files it holds. */
export const GOVERNANCE_SIDECAR_SUFFIX = '.governance';
export const GOVERNANCE_DB_FILENAME = 'governance.db';
export const EMIT_OUTBOX_FILENAME = 'emit-outbox.ndjson';

/**
 * The value of the engine's store variable when THIS PROCESS booted — the operator's instruction,
 * captured before the daemon exports its own resolution over it. Children that resolve a store from
 * the variable are handed this back ({@link childEnvWithBootEstateDb}).
 */
export const BOOT_ESTATE_DB: string | undefined = process.env[ESTATE_DB_ENGINE_ENV];

/** What decided the store — logged at boot and reported on `/diagnostics` so an operator can see which rule won. */
export type GovernanceStoreSource = 'flag' | 'env-crew' | 'env-estate' | 'core-db-sidecar';
/** What decided the outbox: the engine's own override in the environment, or the sidecar default. */
export type GovernanceOutboxSource = 'env' | 'core-db-sidecar';

export interface GovernanceStoreLocation {
  /** The estate store the engine's emit seam writes to — exported as `WICKED_ESTATE_DB`. An
   *  absolute SQLite path, or a spec the engine parses itself (`:memory:`, `postgres://…`). RAW:
   *  a URL spec may carry credentials, so this value is for the ENGINE HANDOFF only. */
  dbPath: string;
  /** `dbPath` with any URL userinfo redacted (`postgres://***@host/db`; a path is unchanged) — the
   *  ONLY spelling operator-facing surfaces print: the boot log, the readiness line,
   *  `/diagnostics.governance.store.path`, `governance replay` output (Copilot on #516). */
  displayPath: string;
  source: GovernanceStoreSource;
  /** The dead-letter outbox — exported as `WICKED_APPS_EMIT_DEADLETTER`. */
  outboxPath: string;
  outboxSource: GovernanceOutboxSource;
  /** `<core db>.governance` — created at boot so the engine's first write never fails on a missing parent. */
  sidecarDir: string;
}

export interface GovernanceStoreInput {
  /** `--governance-db` (flag), or undefined. */
  flagDb?: string | undefined;
  /** `WICKED_CREW_GOVERNANCE_DB`, or undefined/empty. */
  envCrewDb?: string | undefined;
  /** An inherited `WICKED_ESTATE_DB`, or undefined/empty. */
  envEstateDb?: string | undefined;
  /** An inherited `WICKED_APPS_EMIT_DEADLETTER`, or undefined/empty. */
  envOutbox?: string | undefined;
  /** The daemon's core db path (`--db`, or the default under the state home). */
  coreDbPath: string;
}

/** The sidecar directory the daemon's governance store and outbox live in: `<core db>.governance`. */
export function governanceSidecarDir(coreDbPath: string): string {
  return `${resolve(coreDbPath)}${GOVERNANCE_SIDECAR_SUFFIX}`;
}

/** The default store: `<core db>.governance/governance.db`. */
export function governanceSidecarDb(coreDbPath: string): string {
  return join(governanceSidecarDir(coreDbPath), GOVERNANCE_DB_FILENAME);
}

/** The default outbox: `<core db>.governance/emit-outbox.ndjson`. */
export function governanceSidecarOutbox(coreDbPath: string): string {
  return join(governanceSidecarDir(coreDbPath), EMIT_OUTBOX_FILENAME);
}

/** A URL scheme of two or more characters followed by `://` — `postgres://`, `postgresql://`. A
 *  single letter before `://` is a Windows drive written with forward slashes (`C://tmp/gov.db`),
 *  which is a PATH (Copilot on #516). */
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;

/** A store spec the engine parses itself (`:memory:`, a `postgres://…` URL) rather than a filesystem
 *  path — left exactly as written, never resolved, never `mkdir`ed for. */
export function isStoreSpec(value: string): boolean {
  return value === ':memory:' || URL_SCHEME_RE.test(value);
}

/** The userinfo of a URL spec — everything between `scheme://` and the first `@` before a `/`. */
const URL_USERINFO_RE = /^([A-Za-z][A-Za-z0-9+.-]+:\/\/)[^/@]*@/;

/** A store spec safe to print: a URL's credentials become `***` (`postgres://u:p@h/db` →
 *  `postgres://***@h/db`); `:memory:` and filesystem paths are returned unchanged. The raw value
 *  is exported to the engine and nowhere else. */
export function redactStoreSpec(value: string): string {
  return isStoreSpec(value) ? value.replace(URL_USERINFO_RE, '$1***@') : value;
}

function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Spell an explicit store absolute (relative flags land next to the cwd the operator typed them
 *  in, not wherever a later `join` happens to run), leaving engine specs untouched. */
function absoluteStore(value: string): string {
  return isStoreSpec(value) || isAbsolute(value) ? value : resolve(value);
}

/** Resolve the governance store and its outbox for one daemon — pure, so two `--db` inputs can be compared. */
export function resolveGovernanceStore(input: GovernanceStoreInput): GovernanceStoreLocation {
  const sidecarDir = governanceSidecarDir(input.coreDbPath);
  const envOutbox = present(input.envOutbox);
  const outbox: Pick<GovernanceStoreLocation, 'outboxPath' | 'outboxSource'> =
    envOutbox !== undefined
      ? { outboxPath: resolve(envOutbox), outboxSource: 'env' }
      : { outboxPath: join(sidecarDir, EMIT_OUTBOX_FILENAME), outboxSource: 'core-db-sidecar' };

  const at = (dbPath: string, source: GovernanceStoreSource): GovernanceStoreLocation => ({
    dbPath,
    displayPath: redactStoreSpec(dbPath),
    source,
    sidecarDir,
    ...outbox,
  });

  const flagDb = present(input.flagDb);
  if (flagDb !== undefined) return at(absoluteStore(flagDb), 'flag');
  const envCrewDb = present(input.envCrewDb);
  if (envCrewDb !== undefined) return at(absoluteStore(envCrewDb), 'env-crew');
  const envEstateDb = present(input.envEstateDb);
  if (envEstateDb !== undefined) return at(absoluteStore(envEstateDb), 'env-estate');
  return at(join(sidecarDir, GOVERNANCE_DB_FILENAME), 'core-db-sidecar');
}

/**
 * Hand the resolved location to the engine: export the two engine variables into `env` and create
 * the sidecar directory (the engine's SQLite open does not create a missing parent, and a spool
 * into a missing directory is a dead letter that itself fails). Called ONCE per daemon, before the
 * engine exists (`CoreAdapter`'s constructor) — the emit seam reads the variables at emit time,
 * so nothing needs a restart. A library boot that never resolves a location exports nothing, and
 * the hermetic test arming stays exactly as it was.
 */
export function applyGovernanceStoreEnv(
  location: GovernanceStoreLocation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(location.sidecarDir, { recursive: true });
  if (!isStoreSpec(location.dbPath)) mkdirSync(dirname(location.dbPath), { recursive: true });
  mkdirSync(dirname(location.outboxPath), { recursive: true });
  env[ESTATE_DB_ENGINE_ENV] = location.dbPath;
  env[EMIT_DEADLETTER_ENGINE_ENV] = location.outboxPath;
}

/**
 * The origin stamp the engine copies onto every dead-letter record — WHICH daemon spooled it, so a
 * record read months later in a drained outbox still says where it came from. Human-readable on
 * purpose; the port is appended once the daemon has bound (the engine reads the variable at emit
 * time, so the update is seen by the next spool).
 */
export function emitOrigin(fields: { version: string; pid: number; coreDbPath: string; port?: number | undefined }): string {
  const port = fields.port !== undefined ? ` port=${fields.port}` : '';
  return `wicked-crew@${fields.version} serve pid=${fields.pid}${port} db=${resolve(fields.coreDbPath)}`;
}

/** Export the origin stamp for the engine. */
export function applyEmitOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): void {
  env[EMIT_ORIGIN_ENGINE_ENV] = origin;
}

/**
 * A copy of `env` for a child that resolves ITS store from `WICKED_ESTATE_DB` (the estate MCP
 * server crew spawns for the operator proposal queue, an estate CLI without `--db`): the daemon's
 * exported governance store is the daemon's business, and the child gets back whatever the
 * process booted with — the operator's explicit store, or nothing. A newer estate binary handed the
 * daemon's `governance.db` as its graph store could migrate the file's schema past what the engine's
 * vendored store opens; restoring the boot value closes that door.
 */
export function childEnvWithBootEstateDb(
  env: NodeJS.ProcessEnv = process.env,
  bootValue: string | undefined = BOOT_ESTATE_DB,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (bootValue === undefined) delete out[ESTATE_DB_ENGINE_ENV];
  else out[ESTATE_DB_ENGINE_ENV] = bootValue;
  return out;
}

/**
 * Where a PRE-FIX engine dead-lettered under HOME — `<HOME | USERPROFILE>/.something-wicked/
 * wicked-apps/emit-outbox.ndjson`, the engine's own default (`emit.rs` `deadletter_path()`), spelled
 * here only so the daemon can TELL the operator it exists (a boot warning and a `/diagnostics`
 * finding with the replay command). Crew never writes it. `null` when no home resolves.
 */
export function legacyHomeOutboxPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = present(env['HOME']) ?? present(env['USERPROFILE']);
  if (home === undefined) return null;
  return join(home, '.something-wicked', 'wicked-apps', EMIT_OUTBOX_FILENAME);
}
