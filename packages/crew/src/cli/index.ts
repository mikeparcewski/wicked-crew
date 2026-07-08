#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, closeDb } from '../store/db.js';
import { startServer } from '../api/server.js';
import { startWorkerHotReload } from '../dispatch/workers.js';

const [, , command, ...argv] = process.argv;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

interface BootstrapOpts {
  dbPath: string;
  port: number;
  workersConfig: string;
}

function parseBootstrap(args: string[]): BootstrapOpts {
  const dbPath = flag(args, '--db') ?? join(tmpdir(), 'wicked-crew.db');
  const portStr = flag(args, '--port') ?? process.env['CREW_PORT'];
  const port = portStr !== undefined ? Number(portStr) : 7701;
  const workersConfig = flag(args, '--workers') ?? 'workers.json';
  return { dbPath, port, workersConfig };
}

/**
 * Shared daemon bootstrap: open DB, start worker hot-reload, bind server,
 * and re-create FSM actors for any sessions left incomplete by a prior
 * process (crash recovery). Returns the live DB handle and resolved port.
 */
async function bootstrap(opts: BootstrapOpts): Promise<{ db: ReturnType<typeof openDb>; port: number; resumed: string[] }> {
  const db = openDb(opts.dbPath);
  startWorkerHotReload(opts.workersConfig);
  const { resumeAllIncompleteSessions } = await import('../fsm/runner.js');
  const resumed = resumeAllIncompleteSessions(db);
  const { port } = await startServer(db, opts.port);
  installShutdownHandlers();
  return { db, port, resumed };
}

function installShutdownHandlers(): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Flush in-flight bus emits so trailing events (e.g. session.completed)
    // reach the durable bus before we exit.
    try {
      const { flushPendingEmits } = await import('../events/bus.js');
      await flushPendingEmits(3000);
    } catch { /* bus unavailable */ }
    try { closeDb(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

function printReady(fields: Record<string, unknown>): void {
  // Machine-readable readiness marker for evidence harnesses.
  process.stdout.write(`WICKED_CREW_READY ${JSON.stringify(fields)}\n`);
}

async function main(): Promise<void> {
  const t0 = performance.now();

  if (command === 'serve') {
    const opts = parseBootstrap(argv);
    const { port, resumed } = await bootstrap(opts);
    printReady({ mode: 'serve', port, db: opts.dbPath, resumed, startupMs: Math.round(performance.now() - t0) });
  } else if (command === 'start') {
    const opts = parseBootstrap(argv);
    const type = flag(argv, '--type') ?? 'feature';
    const goal = flag(argv, '--goal') ?? 'No goal specified';
    const humanGate = flag(argv, '--human-gate'); // optional: force a phase to a human gate
    const { db, port, resumed } = await bootstrap(opts);
    const { startSession } = await import('../fsm/runner.js');
    const phaseGateOverrides = humanGate ? { [humanGate]: 'human' as const } : undefined;
    const sessionId = await startSession(db, {
      type,
      goal,
      ...(phaseGateOverrides ? { phaseGateOverrides } : {}),
    });
    printReady({ mode: 'start', port, db: opts.dbPath, session: sessionId, resumed, startupMs: Math.round(performance.now() - t0) });
  } else if (command === 'resume') {
    const sessionId = flag(argv, '--session');
    if (!sessionId) {
      console.error('Usage: wicked-crew resume --session <id> [--db <path>] [--port <n>] [--workers <path>]');
      process.exit(1);
    }
    const opts = parseBootstrap(argv);
    // bootstrap() auto-resumes all incomplete sessions, including this one.
    const { db, port, resumed } = await bootstrap(opts);
    const { getSession } = await import('../store/sessions.js');
    if (!getSession(db, sessionId)) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
    printReady({ mode: 'resume', port, db: opts.dbPath, session: sessionId, resumed, startupMs: Math.round(performance.now() - t0) });
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
  const sessionId = flag(args, '--session');
  const phase = flag(args, '--phase');
  const action = flag(args, '--action') ?? 'approve';
  const conditions = flag(args, '--conditions');
  const port = flag(args, '--port') !== undefined ? Number(flag(args, '--port')) : 7701;

  if (!sessionId || !phase) {
    console.error('Usage: wicked-crew gate --session <id> --phase <phase> --action approve|reject|approve-with-conditions');
    process.exit(1);
  }

  const url = `http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/gates/${phase}/${action}`;
  const hasBody = action === 'approve-with-conditions';
  const bodyStr = hasBody ? JSON.stringify({ conditions: conditions ?? '' }) : null;

  const init: RequestInit = { method: 'POST' };
  if (bodyStr !== null) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = bodyStr;
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    const text = await res.text();
    console.error(`Gate action failed: ${res.status} ${text}`);
    process.exit(1);
  }

  console.log(`Gate ${action} applied to ${phase} for session ${sessionId}`);
}

async function runStatus(args: string[]): Promise<void> {
  const sessionId = flag(args, '--session');
  const port = flag(args, '--port') !== undefined ? Number(flag(args, '--port')) : 7701;

  const base = `http://127.0.0.1:${port}/api/v1`;
  const url = sessionId ? `${base}/sessions/${sessionId}` : `${base}/health`;

  const res = await fetch(url);
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
