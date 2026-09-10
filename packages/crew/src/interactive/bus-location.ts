/**
 * WHERE THE CROSS-PRODUCT BUS LIVES (acceptance finding F-043) — one pure resolution the CLI, the
 * bridge spawn and the tests share.
 *
 * The interactive seams, the project bus and the /ws relay read one wicked-bus db, and the
 * wicked-interactive bridge crew spawns must emit onto THE SAME one. Before this, all of them
 * fell through to wicked-bus's own default — `~/.something-wicked/wicked-bus/bus.db`, keyed by
 * HOME — so two daemons on one host (an isolated `--db` daemon beside the operator's) shared one
 * bus, armed the same durable cursor names, and raced for each other's `doc.created`.
 *
 * Resolution, in order:
 *  1. an explicit `--bus-db` / `WICKED_BUS_DB` file — the operator's own choice for the seams; the
 *     bridge can only be pointed at it when the file is named `bus.db` (wicked-bus reaches a bus
 *     through a data DIRECTORY, `WICKED_BUS_DATA_DIR`, whose file is always `bus.db`);
 *  2. an explicit `WICKED_BUS_DATA_DIR` — wicked-bus's own env, honoured as-is: `<dir>/bus.db`;
 *  3. `<core db>.bus/` — the daemon's OWN bus, a SIDECAR of its core db (`core.db.bus/` beside
 *     `core.db`, `core.db-wal`, `core.db.events/`). Why a sidecar and not `<state home>/bus/`:
 *     wicked-core embeds crew's state-home registry (`tests/fixtures/state-home-subtrees.json`,
 *     core `src/state_home.rs`) as the worker Read fence and REFUSES every launch that meets a
 *     top-level entry the registry does not classify; the registry's `core.db` entry is a PREFIX
 *     claim (`file-with-sidecars` — "the name and every sidecar sharing its prefix") that already
 *     covers a `core.db.*` directory, exactly as it covers core's own `core.db.events/`. A new
 *     top-level `bus/` would need a byte-identical registry change in BOTH repos and a core
 *     release before a single governed run could start beside it; the sidecar spelling needs
 *     neither, and `GET /diagnostics.stores` lists it for free (it lists the db's sidecars).
 *     wicked-bus keeps `config.json`, `cas/`, `archive/`, `bus.sock`, `daemon.lock` beside its
 *     `bus.db`, so the bus MUST have a directory of its own — this one.
 */

import { basename, dirname, resolve } from 'node:path';

/** What decided the location — logged at boot so an operator can see which rule won. */
export type CrewBusSource = 'flag-or-env-db' | 'env-data-dir' | 'core-db-sidecar';

export interface CrewBusLocation {
  /** The bus db every cross-product seam opens. */
  dbPath: string;
  /** The directory handed to the spawned bridge as `WICKED_BUS_DATA_DIR`; `null` when the explicit
   *  db file is not named `bus.db` (wicked-bus cannot be pointed at it through a data dir). */
  dataDir: string | null;
  source: CrewBusSource;
}

export interface CrewBusInput {
  /** `--bus-db` (flag) or `WICKED_BUS_DB` (env) — an explicit db FILE, or undefined. */
  explicitDb?: string | undefined;
  /** `WICKED_BUS_DATA_DIR` — wicked-bus's own env, or undefined/empty. */
  envDataDir?: string | undefined;
  /** The daemon's core db path (`--db`, or the default under the state home). */
  coreDbPath: string;
}

/** The sidecar directory the daemon's own bus lives in: `<core db>.bus`. */
export function busSidecarDir(coreDbPath: string): string {
  const abs = resolve(coreDbPath);
  return `${abs}.bus`;
}

/**
 * The `WICKED_BUS_DATA_DIR` a bus db path implies: its parent when the file is `bus.db`, else
 * `null` — wicked-bus resolves ONLY a data directory (the file under it is always `bus.db`), so a
 * differently named db cannot be handed to the bridge, and the CLI says so instead of pointing the
 * bridge at a directory whose `bus.db` is a different database.
 */
export function busDataDirOf(busDbPath: string): string | null {
  const abs = resolve(busDbPath);
  return basename(abs) === 'bus.db' ? dirname(abs) : null;
}

/** Resolve the cross-product bus for one daemon — pure, so two `--db` inputs can be compared. */
export function resolveCrewBus(input: CrewBusInput): CrewBusLocation {
  if (input.explicitDb !== undefined && input.explicitDb !== '') {
    const dbPath = resolve(input.explicitDb);
    return { dbPath, dataDir: busDataDirOf(dbPath), source: 'flag-or-env-db' };
  }
  if (input.envDataDir !== undefined && input.envDataDir !== '') {
    const dataDir = resolve(input.envDataDir);
    return { dbPath: resolve(dataDir, 'bus.db'), dataDir, source: 'env-data-dir' };
  }
  const dataDir = busSidecarDir(input.coreDbPath);
  return { dbPath: resolve(dataDir, 'bus.db'), dataDir, source: 'core-db-sidecar' };
}
