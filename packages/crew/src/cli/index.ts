#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CoreAdapter } from '../core/adapter.js';
import { ensureBridgesOnPath } from '../core/bridge-path.js';
import { startServer } from '../api/server.js';
import type { LaunchRunInput } from '../core/types.js';

const [, , command, ...argv] = process.argv;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

interface BootstrapOpts {
  dbPath: string;
  port: number;
  stub: boolean;
  engineExec: boolean;
  busDbPath: string;
}

/** Durable state home (~/.wicked-crew) — runs/evidence must survive a reboot, which the
 * OS temp dir explicitly does not. Created on demand; --db/--bus-db still override. */
function stateHome(): string {
  const dir = join(homedir(), '.wicked-crew');
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
  const busDbPath =
    flag(args, '--bus-db') ??
    process.env['WICKED_BUS_DB'] ??
    join(stateHome(), 'bus.db');
  return { dbPath, port, stub, engineExec, busDbPath };
}

let adapterRef: CoreAdapter | undefined;

async function bootstrap(opts: BootstrapOpts): Promise<{ adapter: CoreAdapter; port: number }> {
  // Put the packaged ACP bridge shims on PATH BEFORE the engine exists — the core
  // spawns bridge binaries by bare name, and every engine subprocess inherits this
  // environment. Makes a plain `npm install` deployment fully self-contained (no
  // global installs, no hand-made symlinks).
  ensureBridgesOnPath();
  const adapter = new CoreAdapter({
    dbPath: opts.dbPath,
    stub: opts.stub,
    engineExec: opts.engineExec,
    busDbPath: opts.busDbPath,
  });
  adapterRef = adapter;
  const { port } = await startServer(adapter, opts.port);
  installShutdownHandlers();
  return { adapter, port };
}

function installShutdownHandlers(): void {
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Close the single subscription so the pump thread + tsfn release and the
    // process can exit on its own.
    try {
      adapterRef?.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function printReady(fields: Record<string, unknown>): void {
  // Machine-readable readiness marker for evidence harnesses.
  process.stdout.write(`WICKED_CREW_READY ${JSON.stringify(fields)}\n`);
}

async function main(): Promise<void> {
  const t0 = performance.now();

  if (command === 'serve') {
    const opts = parseBootstrap(argv);
    const { adapter, port } = await bootstrap(opts);
    printReady({
      mode: 'serve',
      port,
      db: opts.dbPath,
      stub: opts.stub,
      engineExec: adapter.engineExec,
      busDb: adapter.engineExec ? adapter.busDbPath : undefined,
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
  } else {
    console.error(`Unknown command: ${command ?? '(none)'}`);
    console.error('Usage: wicked-crew serve|start|resume|gate|status');
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
