#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CoreAdapter } from '../core/adapter.js';
import { ensureBridgesOnPath } from '../core/bridge-path.js';
import { bridgeReaper, reapOrphansAtBoot, startOrphanSweep } from '../core/bridge-reaper.js';
import { daemonSignalLog } from '../core/daemon-signal-log.js';
import { startServer } from '../api/server.js';
import { resolveAuthMode } from '../api/auth.js';
import { crewStateHome, setCrewStateHome, stateHomeOfDb } from '../projects/state-home.js';
import { CrewBusError, resolveCrewBus, type CrewBusLocation } from '../interactive/bus-location.js';
import {
  applyEmitOrigin,
  emitOrigin,
  EMIT_DEADLETTER_ENGINE_ENV,
  ESTATE_DB_ENGINE_ENV,
  GOVERNANCE_DB_ENV,
  GOVERNANCE_DB_FLAG,
  legacyHomeOutboxPath,
  resolveGovernanceStore,
  type GovernanceStoreLocation,
} from '../core/governance-store.js';
import { probeLegacyOutbox, replayCommand } from '../api/governance-health.js';
import { crewPackageVersion, runGovernance } from './governance.js';
import { runMcpServer } from './mcp.js';
import type { LaunchRunInput } from '../core/types.js';

const [, , command, ...argv] = process.argv;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** `true` when an env var is set to a falsy string: "", "0", "false", "no", "off" (case-insensitive, trimmed).
 *  An empty / whitespace-only value is treated as falsy so `VAR=` (common shell unset idiom) disables the feature. */
function isFalsy(val: string | undefined): boolean {
  if (val === undefined) return false;
  const v = val.trim().toLowerCase();
  return v === '' || v === '0' || v === 'false' || v === 'no' || v === 'off';
}

interface BootstrapOpts {
  dbPath: string;
  port: number;
  stub: boolean;
  engineExec: boolean;
  busDbPath: string;
  qeGateEvents: boolean;
  /** Bus db for the QE subscription; `undefined` = wicked-bus's own default resolution. */
  qeBusDbPath: string | undefined;
  /** The CROSS-PRODUCT bus (F-043): the interactive seams, the project bus, the /ws relay AND the
   *  spawned bridge meet here — see `interactive/bus-location.ts` for the resolution. */
  crewBus: CrewBusLocation;
  /** The governance store + dead-letter outbox handed to the engine (crew#495 / F-022):
   *  `--governance-db` › `WICKED_CREW_GOVERNANCE_DB` › an inherited `WICKED_ESTATE_DB` › the
   *  daemon's OWN `<core db>.governance/governance.db` — see `core/governance-store.ts`. */
  governanceStore: GovernanceStoreLocation;
  /** DEFAULT ON (#261): answer project-bound wicked-interactive doc.created with a governed draft run. */
  interactiveDraftEvents: boolean;
  /** DEFAULT ON (#261): answer wicked-interactive structural feedback handoffs with a governed edit run. */
  interactiveEditEvents: boolean;
  /** DEFAULT ON (CREW-UX-5): answer wicked-interactive conversational iteration asks (chat.posted) with a governed revision run. */
  interactiveChatEvents: boolean;
  /** DEFAULT ON (CREW-UX-9): answer wicked-interactive demo docs (doc.created kind:demo + their step feedback) with a governed spec-authoring run. */
  interactiveDemoEvents: boolean;
  /** Seat roster override for the draft/edit/chat runs (JSON array); `undefined` = production roster. */
  interactiveSeats: string | undefined;
}

/** Durable DEFAULT state home (~/.wicked-crew) — runs/evidence must survive a reboot, which the
 * OS temp dir explicitly does not. Created on demand, and ONLY on the default path: `??` keeps
 * this call out of a `--db` boot entirely (crew#353's E2E gate — an isolated daemon must not even
 * `mkdir` the operator's real `~/.wicked-crew`). Resolves through the shared state-home seam;
 * at parse time no `--db` has been threaded yet, so this IS the homedir default. */
function stateHome(): string {
  const dir = crewStateHome();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parseBootstrap(args: string[]): BootstrapOpts {
  const dbPath = flag(args, '--db') ?? join(stateHome(), 'core.db');
  const portStr = flag(args, '--port') ?? process.env['CREW_PORT'];
  const port = portStr !== undefined ? Number(portStr) : 7701;
  const stub = hasFlag(args, '--stub') || process.env['WICKED_CORE_STUB'] === '1';
  // OPT-IN: arm the event-driven execution-mediation seam (default OFF → in-process path).
  // `--engine-exec` flag or WICKED_BUS_EXEC env turns it on; `--bus-db` / WICKED_BUS_DB sets the bus db.
  const engineExec =
    hasFlag(args, '--engine-exec') ||
    (process.env['WICKED_BUS_EXEC'] !== undefined && process.env['WICKED_BUS_EXEC'] !== '');
  // The exec seam's bus db follows the SAME state home as the core db (crew#353): with `--db`
  // given, the old `stateHome()` fallback both pointed the bus at the developer's real
  // `~/.wicked-crew/bus.db` AND eagerly `mkdir`ed that directory on every boot — the isolated
  // daemon's first write into a home it was told to stay out of. `stateHomeOfDb(dbPath)` is
  // byte-identical without `--db` (the default dbPath's parent IS `~/.wicked-crew`, already
  // created by `stateHome()` above).
  const busDbPath =
    flag(args, '--bus-db') ??
    process.env['WICKED_BUS_DB'] ??
    join(stateHomeOfDb(dbPath), 'bus.db');
  // OPT-IN (Phase 6a, same shape as --engine-exec): consume the QE gate's bus
  // events (`wicked.qe.gate.*` + `wicked.qe.deploy.completed`) into the
  // acceptance freshness cache. Default OFF → the acceptance route lazy-reads
  // the ledger on demand, which needs no bus at all.
  const qeGateEvents =
    hasFlag(args, '--qe-gate-events') ||
    (process.env['WICKED_QE_GATE_EVENTS'] !== undefined && process.env['WICKED_QE_GATE_EVENTS'] !== '');
  // Which bus db the QE subscription reads: an EXPLICIT --bus-db / WICKED_BUS_DB
  // wins; otherwise wicked-bus's own default (`~/.something-wicked/wicked-bus/bus.db`) —
  // the db the QE pipeline's CLI emits to. Deliberately NOT the exec seam's
  // `~/.wicked-crew/bus.db` fallback: that default is crew-private, and the QE
  // events are cross-product traffic that never lands there.
  const qeBusDbPath = flag(args, '--bus-db') ?? process.env['WICKED_BUS_DB'];
  // The CROSS-PRODUCT bus (acceptance findings F-042/F-043) — the interactive seams, the project
  // bus, the /ws relay (which used to open wicked-bus's default REGARDLESS of --bus-db) and the
  // bridge crew spawns (handed the directory as WICKED_BUS_DATA_DIR, bridge-pool.ts) all meet on
  // ONE db: an explicit --bus-db / WICKED_BUS_DB, else WICKED_BUS_DATA_DIR, else the daemon's OWN
  // `<core db>.bus/bus.db` — a sidecar of the core db, so two daemons on one host never share a
  // bus by default. `interactive/bus-location.ts` says why a sidecar and not `<state home>/bus/`.
  let crewBus: CrewBusLocation;
  try {
    crewBus = resolveCrewBus({
      explicitDb: qeBusDbPath,
      envDataDir: process.env['WICKED_BUS_DATA_DIR'],
      coreDbPath: dbPath,
    });
  } catch (err) {
    // An explicit bus db the bridge could never share is a CONFIG error — refuse to boot rather
    // than run a daemon and its bridge on two buses (codex on crew#506).
    if (!(err instanceof CrewBusError)) throw err;
    console.error(`[crew] ${err.message}`);
    process.exit(1);
  }
  // The governance store (crew#495 / F-022). The engine's emit seam writes every `wicked.*`
  // governance event — conformance claims, phase transitions, rule lifecycle — to the estate store
  // named by WICKED_ESTATE_DB, and `serve` never set it: on every default install EVERY such event
  // dead-lettered to an outbox under the operator's HOME, silently. Resolution: an explicit
  // --governance-db / WICKED_CREW_GOVERNANCE_DB, else an inherited WICKED_ESTATE_DB (the engine's
  // own variable, honoured), else the daemon's OWN `<core db>.governance/governance.db` — a sidecar
  // for the same fence reason as the bus above. The dead-letter outbox lives in that sidecar too
  // (an explicit WICKED_APPS_EMIT_DEADLETTER wins), never under HOME.
  const governanceDbFlag = flag(args, GOVERNANCE_DB_FLAG);
  if (hasFlag(args, GOVERNANCE_DB_FLAG) && (governanceDbFlag === undefined || governanceDbFlag.startsWith('-'))) {
    console.error(`${GOVERNANCE_DB_FLAG} requires a value (got: ${governanceDbFlag ?? '(missing)'})`);
    process.exit(1);
  }
  const governanceStore = resolveGovernanceStore({
    flagDb: governanceDbFlag,
    envCrewDb: process.env[GOVERNANCE_DB_ENV],
    envEstateDb: process.env[ESTATE_DB_ENGINE_ENV],
    envOutbox: process.env[EMIT_DEADLETTER_ENGINE_ENV],
    coreDbPath: dbPath,
  });
  // DEFAULT ON (closes #261): answer wicked-interactive's `doc.created` (kind:source) with a
  // governed `interactive-draft` run. The bus is already required for the project bridge.
  // Project-bound docs launch FILED runs; unbound (Unfiled) docs launch unfiled governed runs
  // (CREW-UX-4 — slice U made Unfiled first-class, so nothing else answers them). Opt-out:
  //   --no-interactive-draft-events   or   WICKED_INTERACTIVE_DRAFT_EVENTS=0|false|no|off|""
  // The bus db follows the SAME resolution as the QE seam — explicit --bus-db / WICKED_BUS_DB wins,
  // otherwise wicked-bus's own default (which honors WICKED_BUS_DATA_DIR): interactive's service
  // resolves its bus exactly that way, so by default the two meet on the same db.
  const interactiveDraftEvents =
    !hasFlag(args, '--no-interactive-draft-events') &&
    !isFalsy(process.env['WICKED_INTERACTIVE_DRAFT_EVENTS']);
  // DEFAULT ON (closes #261, same rationale): answer wicked-interactive's structural feedback
  // handoffs (`feedback.processed`, awaiting_structural > 0) with a governed `interactive-edit`
  // run. Opt-out: --no-interactive-edit-events or WICKED_INTERACTIVE_EDIT_EVENTS=0|false|no|off|""
  const interactiveEditEvents =
    !hasFlag(args, '--no-interactive-edit-events') &&
    !isFalsy(process.env['WICKED_INTERACTIVE_EDIT_EVENTS']);
  // DEFAULT ON (CREW-UX-5, same rationale): answer wicked-interactive's conversational
  // iteration asks (`chat.posted`, role:user on an existing kind:source doc) with a governed
  // `interactive-chat` run — the doc thread's plain send had NO answerer since the ad-hoc
  // assist agent retired. Opt-out:
  //   --no-interactive-chat-events or WICKED_INTERACTIVE_CHAT_EVENTS=0|false|no|off|""
  const interactiveChatEvents =
    !hasFlag(args, '--no-interactive-chat-events') &&
    !isFalsy(process.env['WICKED_INTERACTIVE_CHAT_EVENTS']);
  // DEFAULT ON (CREW-UX-9, same rationale): answer wicked-interactive's demo docs —
  // `doc.created` (kind:demo) authors `demo.spec.mjs` and triggers the model-free recording;
  // a demo doc's step feedback (`feedback.processed`, manifest kind demo) re-authors it.
  // Opt-out: --no-interactive-demo-events or WICKED_INTERACTIVE_DEMO_EVENTS=0|false|no|off|""
  const interactiveDemoEvents =
    !hasFlag(args, '--no-interactive-demo-events') &&
    !isFalsy(process.env['WICKED_INTERACTIVE_DEMO_EVENTS']);
  // Deterministic-worker override for harnesses (a JSON AgenticCli array); unset = the roster.
  const interactiveSeats = process.env['WICKED_INTERACTIVE_SEATS'];
  return {
    dbPath, port, stub, engineExec, busDbPath, qeGateEvents, qeBusDbPath, crewBus, governanceStore,
    interactiveDraftEvents, interactiveEditEvents, interactiveChatEvents, interactiveDemoEvents,
    interactiveSeats,
  };
}

let adapterRef: CoreAdapter | undefined;

async function bootstrap(opts: BootstrapOpts): Promise<{ adapter: CoreAdapter; port: number }> {
  // Put the packaged ACP bridge shims on PATH BEFORE the engine exists — the core
  // spawns bridge binaries by bare name, and every engine subprocess inherits this
  // environment. Makes a plain `npm install` deployment fully self-contained (no
  // global installs, no hand-made symlinks).
  ensureBridgesOnPath();
  // Every crew-side durable store follows the SAME state home as the core db (crew#330 for the
  // project graphs, crew#353 for the project settings): a daemon isolated with
  // `--db $SCRATCH/core.db` must not write 40+ MB graphs — or the operator's project settings —
  // into the developer's real ~/.wicked-crew. Without --db the resolved parent IS ~/.wicked-crew,
  // so the default daemon is byte-identical; the explicit per-store env overrides
  // (WICKED_CREW_PROJECT_GRAPH_ROOT, WICKED_CREW_PROJECT_SETTINGS) still outrank this.
  setCrewStateHome(stateHomeOfDb(opts.dbPath));
  const { crewBus } = opts;
  console.error(`[crew] cross-product bus: ${crewBus.dbPath} (${crewBus.source})`);
  // wicked-bus (better-sqlite3 underneath) does not create a missing parent: the sidecar dir —
  // or an explicit dir — must exist before the seams open the db, or every seam disables itself.
  mkdirSync(dirname(crewBus.dbPath), { recursive: true });
  // The governance store (crew#495): say which rule won, stamp the origin the engine copies onto
  // any dead letter it spools, and point at a pre-fix outbox under HOME if one is still sitting
  // there — the adapter exports the store/outbox variables to the engine before it spawns.
  const { governanceStore } = opts;
  console.error(
    `[crew] governance store: ${governanceStore.displayPath} (${governanceStore.source}); ` +
      `dead letters: ${governanceStore.outboxPath} (${governanceStore.outboxSource})`,
  );
  const crewVersion = crewPackageVersion();
  applyEmitOrigin(emitOrigin({ version: crewVersion, pid: process.pid, coreDbPath: opts.dbPath }));
  const legacyOutbox = await probeLegacyOutbox(legacyHomeOutboxPath());
  if (legacyOutbox !== null && legacyOutbox.path !== governanceStore.outboxPath) {
    console.warn(
      `[crew] a pre-fix dead-letter outbox exists under HOME at ${legacyOutbox.path} (${legacyOutbox.bytes} bytes) — ` +
        `governance events earlier daemons could not store; inspect with ${replayCommand(legacyOutbox.path)} --dry-run, ` +
        'then replay it into this daemon\'s store',
    );
  }
  const adapter = new CoreAdapter({
    dbPath: opts.dbPath,
    stub: opts.stub,
    engineExec: opts.engineExec,
    busDbPath: opts.busDbPath,
    governanceStore,
  });
  adapterRef = adapter;
  const serverOptions = {
    ...(opts.qeGateEvents
      ? {
          qeGateEvents: {
            enabled: true,
            ...(opts.qeBusDbPath !== undefined ? { dbPath: opts.qeBusDbPath } : {}),
          },
        }
      : {}),
    ...(opts.interactiveDraftEvents
      ? {
          interactiveDraftEvents: {
            enabled: true,
            // The cross-product bus (F-043): explicit --bus-db / WICKED_BUS_DB › WICKED_BUS_DATA_DIR › <core db>.bus.
            dbPath: crewBus.dbPath,
            ...(opts.interactiveSeats !== undefined ? { clisJson: opts.interactiveSeats } : {}),
          },
        }
      : {}),
    ...(opts.interactiveEditEvents
      ? {
          interactiveEditEvents: {
            enabled: true,
            dbPath: crewBus.dbPath,
            ...(opts.interactiveSeats !== undefined ? { clisJson: opts.interactiveSeats } : {}),
          },
        }
      : {}),
    ...(opts.interactiveChatEvents
      ? {
          interactiveChatEvents: {
            enabled: true,
            dbPath: crewBus.dbPath,
            ...(opts.interactiveSeats !== undefined ? { clisJson: opts.interactiveSeats } : {}),
          },
        }
      : {}),
    ...(opts.interactiveDemoEvents
      ? {
          interactiveDemoEvents: {
            enabled: true,
            dbPath: crewBus.dbPath,
            ...(opts.interactiveSeats !== undefined ? { clisJson: opts.interactiveSeats } : {}),
          },
        }
      : {}),
    // Projects (DES-PROJECT-001): default-ON, loud-non-fatal. Bus-db resolution follows the
    // cross-product seams above — `wicked.crew.project.*`, the interactive activity bridge and the
    // /ws relay are cross-product traffic, and the bridge crew spawns must meet them on ONE db
    // (F-043) — NOT the exec seam's crew-private fallback.
    projectEvents: { dbPath: crewBus.dbPath },
    interactiveWsRelay: { dbPath: crewBus.dbPath },
    // F-042/F-043: what the spawned bridge is told — the bus dir this daemon's seams read, and the
    // daemon's own origin (resolved by the pool from the bound address).
    interactiveBridge: { busDataDir: crewBus.dataDir },
  };
  const { port } = await startServer(
    adapter,
    opts.port,
    undefined,
    Object.keys(serverOptions).length > 0 ? serverOptions : undefined,
  );
  // Now that the port is known, complete the origin stamp (the engine reads it at emit time).
  applyEmitOrigin(emitOrigin({ version: crewVersion, pid: process.pid, coreDbPath: opts.dbPath, port }));
  installShutdownHandlers();
  return { adapter, port };
}

function installShutdownHandlers(): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      // Reap ACP bridge children BEFORE this process goes away (crew#285): the engine's
      // in-memory kill handles die with the daemon, so this is the last actor that can
      // still find the bridges (they are our direct OS children). SIGTERM, a ~2 s grace,
      // then SIGKILL for anything that ignored it. Best-effort — a reap failure must
      // never block shutdown.
      try {
        await bridgeReaper.shutdown();
      } catch {
        /* reaping is best-effort */
      }
      // Close the single subscription so the pump thread + tsfn release and the
      // process can exit on its own.
      try {
        adapterRef?.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => {
    const at = Date.now();
    daemonSignalLog.record('SIGTERM', at);
    console.warn(`[daemon] received SIGTERM at ${new Date(at).toISOString()} pid=${process.pid} (sender pid unavailable in Node signal callbacks) (crew#411)`);
    shutdown();
  });
  process.on('SIGINT', () => {
    const at = Date.now();
    daemonSignalLog.record('SIGINT', at);
    console.warn(`[daemon] received SIGINT at ${new Date(at).toISOString()} pid=${process.pid} (sender pid unavailable in Node signal callbacks) (crew#411)`);
    shutdown();
  });
  // Normal exit (`process.exit` anywhere, main() falling off): an 'exit' handler cannot
  // await, so this is the synchronous SIGTERM sweep. After the graceful path above it is
  // a no-op re-scan; on a plain exit it is the only reaping that happens, and the
  // bridges' own stdin-EOF watchdog (packages/agent-acp-bridges) is the final backstop.
  process.on('exit', () => {
    bridgeReaper.sweepSync();
  });
}

function printReady(fields: Record<string, unknown>): void {
  // Machine-readable readiness marker for evidence harnesses.
  process.stdout.write(`WICKED_CREW_READY ${JSON.stringify(fields)}\n`);
}

async function main(): Promise<void> {
  const t0 = performance.now();

  if (command === 'serve') {
    if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
      console.log(
        'Usage: wicked-crew serve [options]\n' +
        '\n' +
        'Start the wicked-crew daemon.\n' +
        '\n' +
        'Options:\n' +
        '  --port <n>                      Port to listen on (default: 7701, env: CREW_PORT)\n' +
        '  --db <path>                     Core database path (default: ~/.wicked-crew/core.db)\n' +
        '  --bus-db <path>                 Bus database path (env: WICKED_BUS_DB) for the interactive/project seams,\n' +
        '                                  the /ws relay and the bridge crew spawns (default: $WICKED_BUS_DATA_DIR/bus.db,\n' +
        '                                  else <core db>.bus/bus.db); --engine-exec defaults to <state home>/bus.db\n' +
        '  --governance-db <path>          Governance store the engine writes conformance claims, phase transitions and\n' +
        '                                  rule-lifecycle events to (env: WICKED_CREW_GOVERNANCE_DB; an inherited\n' +
        '                                  WICKED_ESTATE_DB is honoured next; default <core db>.governance/governance.db).\n' +
        '                                  Dead letters spool to <core db>.governance/emit-outbox.ndjson, never under HOME;\n' +
        '                                  see `wicked-crew governance replay`\n' +
        '  --stub                          Use stub engine (env: WICKED_CORE_STUB=1)\n' +
        '  --engine-exec                   Arm event-driven execution seam (env: WICKED_BUS_EXEC)\n' +
        '  --qe-gate-events                Consume QE gate bus events (env: WICKED_QE_GATE_EVENTS)\n' +
        '  --no-interactive-draft-events   Disable interactive draft answering (env: WICKED_INTERACTIVE_DRAFT_EVENTS=0)\n' +
        '  --no-interactive-edit-events    Disable interactive edit answering (env: WICKED_INTERACTIVE_EDIT_EVENTS=0)\n' +
        '  --no-interactive-chat-events    Disable interactive chat answering (env: WICKED_INTERACTIVE_CHAT_EVENTS=0)\n' +
        '  --no-interactive-demo-events    Disable interactive demo answering (env: WICKED_INTERACTIVE_DEMO_EVENTS=0)\n' +
        '  -h, --help                      Print this help'
      );
      process.exit(0);
    }
    const opts = parseBootstrap(argv);
    // Boot sweep (crew#285): bridges orphaned by a PRIOR daemon generation are
    // reparented to init and would otherwise live forever — shutdown-path reaping
    // can never see them. Conservative: only ppid==1 matches, so another live
    // daemon's bridges are untouched.
    const orphans = reapOrphansAtBoot();
    if (orphans.length > 0) console.warn(`[bridge-reaper] reaped ${orphans.length} orphaned bridge/worker process(es) from a previous daemon: ${orphans.join(', ')}`);
    // Live sweep (crew#340): kill -9 on a bridge mid-run orphans its worker CLI NOW, and
    // that orphan holds the shared worker config home hostage until reaped — the boot
    // sweep only helps the NEXT daemon. Unref'd timer; SIGTERM, then SIGKILL a tick later.
    startOrphanSweep();
    const { adapter, port } = await bootstrap(opts);
    printReady({
      mode: 'serve',
      port,
      db: opts.dbPath,
      // Where the engine's governance events land (crew#495) — an evidence harness can open it
      // (a URL spec's credentials redacted; the raw value went to the engine only).
      governanceDb: opts.governanceStore.displayPath,
      stub: opts.stub,
      // The identity seam's resolved mode (task #88): `required` under
      // WICKED_RUNTIME=team / WICKED_CREW_AUTH=required, else `off` (local).
      auth: resolveAuthMode(),
      engineExec: adapter.engineExec,
      busDb: adapter.engineExec ? adapter.busDbPath : undefined,
      qeGateEvents: opts.qeGateEvents || undefined,
      // What ARMED, not what was asked for (crew#309): a stub-engine daemon refuses the four
      // interactive answering seams (see `api/server.ts`), and an evidence harness that reads
      // this line must not be told a seam is live when nothing is holding its cursor.
      interactiveDraftEvents: (opts.interactiveDraftEvents && !adapter.stub) || undefined,
      interactiveEditEvents: (opts.interactiveEditEvents && !adapter.stub) || undefined,
      interactiveChatEvents: (opts.interactiveChatEvents && !adapter.stub) || undefined,
      interactiveDemoEvents: (opts.interactiveDemoEvents && !adapter.stub) || undefined,
      startupMs: Math.round(performance.now() - t0),
    });
  } else if (command === 'start') {
    const opts = parseBootstrap(argv);
    const problem = flag(argv, '--problem') ?? 'No problem specified';
    const humanConfirm = flag(argv, '--human-confirm'); // none | all | before:<ord>
    const workflow = flag(argv, '--workflow'); // e.g. domain-extraction
    if (hasFlag(argv, '--workflow') && (workflow === undefined || workflow.startsWith('-'))) {
      console.error(`--workflow requires a value (got: ${workflow ?? '(missing)'})`);
      process.exit(1);
    }
    const repoRef = flag(argv, '--repo'); // id of a registered repo
    if (hasFlag(argv, '--repo') && (repoRef === undefined || repoRef.startsWith('-'))) {
      console.error(`--repo requires a value (got: ${repoRef ?? '(missing)'})`);
      process.exit(1);
    }
    const { adapter, port } = await bootstrap(opts);
    const input: LaunchRunInput = {
      problem,
      sessionId: flag(argv, '--session') ?? randomUUID(),
      clisJson: JSON.stringify(CoreAdapter.roster()),
    };
    if (humanConfirm !== undefined) input.humanConfirm = humanConfirm;
    if (workflow !== undefined) input.workflow = workflow;
    if (repoRef !== undefined) input.repoRef = repoRef;
    const runId = await adapter.launchRun(input);
    printReady({ mode: 'start', port, db: opts.dbPath, run: runId, startupMs: Math.round(performance.now() - t0) });
  } else if (command === 'resume') {
    const sessionId = flag(argv, '--session');
    if (!sessionId) {
      console.error('Usage: wicked-crew resume --session <id> [--db <path>] [--port <n>] [--stub]');
      process.exit(1);
    }
    const opts = parseBootstrap(argv);
    const { adapter, port } = await bootstrap(opts);
    const status = await adapter.resumeRun(sessionId);
    printReady({ mode: 'resume', port, db: opts.dbPath, run: sessionId, status, startupMs: Math.round(performance.now() - t0) });
  } else if (command === 'gate') {
    await runGate(argv);
  } else if (command === 'status') {
    await runStatus(argv);
  } else if (command === 'mcp') {
    const portStr = flag(argv, '--port');
    const port = portStr !== undefined ? Number(portStr) : 7701;
    if (!Number.isFinite(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`--port must be an integer between 1 and 65535 (got: ${portStr ?? '(missing)'})`);
      process.exit(1);
    }
    await runMcpServer(port);
  } else if (command === 'governance') {
    await runGovernance(argv);
  } else {
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: wicked-crew serve|start|resume|gate|status|mcp|governance');
    process.exit(1);
  }
}

async function runGate(args: string[]): Promise<void> {
  const runId = flag(args, '--run') ?? flag(args, '--session');
  const approve = !hasFlag(args, '--reject');
  const amend = flag(args, '--amend');
  const port = flag(args, '--port') !== undefined ? Number(flag(args, '--port')) : 7701;
  if (!runId) {
    console.error('Usage: wicked-crew gate --run <id> [--reject] [--amend <text>] [--port <n>]');
    process.exit(1);
  }
  const body: Record<string, unknown> = { approve };
  if (amend !== undefined) body['amend'] = amend;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs/${runId}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Gate action failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Gate ${approve ? 'approve' : 'reject'} applied to run ${runId}`);
}

async function runStatus(args: string[]): Promise<void> {
  const runId = flag(args, '--run') ?? flag(args, '--session');
  const port = flag(args, '--port') !== undefined ? Number(flag(args, '--port')) : 7701;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const url = runId ? `${base}/runs/${runId}` : `${base}/runs`;
  const res = await fetch(url);
  console.log(JSON.stringify(await res.json(), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
