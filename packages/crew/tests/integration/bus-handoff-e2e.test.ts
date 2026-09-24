// DES-TEAMING-002 T0 — ONE daemon, ONE bus file: crew's seams and the engine meet on the same bus,
// through the REAL dist CLI and the REAL engine (`--stub` swaps the council + step runner, not the
// actor, its bus bridge or exec mediation). Cross-repo seam composition: the engine half is
// wicked-core's `WICKED_BUS_DB` handling (bus opened off the actor thread, one connection per
// process, the bus judge only under exec), so this suite runs against whatever core-ts is linked.
//
//  A. no flags: the engine is handed `<core db>.bus/bus.db` — the file `resolveCrewBus` resolves
//     and crew's project seam writes (`wicked.crew.project.created`); a `wicked.crew.run.requested`
//     on that file is launched by the engine, which answers `wicked.crew.run.launched` there; exec
//     mediation stays off (no `task.dispatched`), and no gate judge goes to the bus.
//  B. `--engine-exec`: unchanged behaviour — the run is mediated over the bus (`task.dispatched` /
//     `task.completed`), on that SAME file (it used to default to a crew-private `<state home>/bus.db`).
//  C. `--bus-db X`: X wins for the engine, exec mediation and the seams; no sidecar bus is created.
//  D. a bus that cannot open: ONE `[crew] bus unavailable` line, the engine is handed no bus (no
//     engine bus line), the daemon still serves, and `/health.warnings` carries `bus.unavailable`.
//  E. an engine WITHOUT the one-connection rule (no `Core.busConnectionStats` — what crew CI links
//     until the engine half is on wicked-core main) gets exactly the pre-T0 handoff: no bus on a
//     default boot, one line saying why; crew's seams still use the crew bus.
//
// A–C need the engine half and run only against an engine that has it; E runs only against one
// that does not. Both configurations are exercised: locally against the core PR's engine, in crew
// CI against core main's.
//
// Runs only when dist is built (CI builds before test; locally `npm run build -w packages/crew`).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as bus from 'wicked-bus';

import { baseSkillOff } from '../setup/base-skill-off.js';
import { removeScratch } from '../setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', '..', 'dist', 'cli', 'index.js');
const BOOT_TIMEOUT_MS = 90_000;
const engineHasRule =
  typeof (createRequire(import.meta.url)('wicked-core-ts') as { Core: { busConnectionStats?: unknown } }).Core
    .busConnectionStats === 'function';

interface Daemon {
  proc: ChildProcess;
  port: number;
  ready: Record<string, unknown>;
  stderr: () => string;
  stop: () => Promise<void>;
}

async function bootDaemon(dbPath: string, extraArgs: string[]): Promise<Daemon> {
  // These runs are about the bus, not grounding: the scratch HOME publishes no skills generation.
  baseSkillOff();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The daemon's OWN resolution is under test: nothing inherited may pre-empt it.
  for (const k of ['WICKED_BUS_DB', 'WICKED_BUS_EXEC', 'WICKED_BUS_DATA_DIR', 'WICKED_ESTATE_DB', 'WICKED_CREW_GOVERNANCE_DB']) {
    delete env[k];
  }
  const proc = spawn(process.execPath, [CLI, 'serve', '--stub', '--port', '0', '--db', dbPath, ...extraArgs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (c: string) => {
    stderr += c;
  });
  const ready = await new Promise<Record<string, unknown>>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon did not report ready in ${BOOT_TIMEOUT_MS}ms\n${stderr}`)), BOOT_TIMEOUT_MS);
    proc.stdout!.on('data', (chunk: string) => {
      stdout += chunk;
      const line = stdout.split('\n').find((l) => l.startsWith('WICKED_CREW_READY '));
      if (line !== undefined) {
        clearTimeout(timer);
        resolveReady(JSON.parse(line.slice('WICKED_CREW_READY '.length)) as Record<string, unknown>);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon exited (${code}) before ready\n${stderr}`));
    });
  });
  return {
    proc,
    port: ready['port'] as number,
    ready,
    stderr: () => stderr,
    stop: () =>
      new Promise<void>((done) => {
        if (proc.exitCode !== null) return done();
        proc.once('exit', () => done());
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL');
        }, 5_000).unref();
      }),
  };
}

// Reading the daemon's bus from THIS process (a different process from the daemon: ordinary
// multi-process SQLite) through the better-sqlite3 instance wicked-bus loads.
interface Row {
  event_type: string;
  domain: string;
  payload: string;
}
type Sqlite = new (p: string, o?: { readonly?: boolean; fileMustExist?: boolean }) => {
  prepare(sql: string): { all(...a: unknown[]): unknown[] };
  close(): void;
};
const Database = createRequire(createRequire(import.meta.url).resolve('wicked-bus'))('better-sqlite3') as Sqlite;

function rows(dbPath: string, typePrefix: string): Row[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT event_type, domain, payload FROM events WHERE event_type LIKE ? ORDER BY event_id')
      .all(`${typePrefix}%`) as Row[];
  } finally {
    db.close();
  }
}

async function waitForRow(dbPath: string, typePrefix: string, match: (r: Row) => boolean, timeoutMs = 30_000): Promise<Row> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = rows(dbPath, typePrefix).find(match);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`no ${typePrefix}* row matched on ${dbPath}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Put a launch request on the bus the way any external producer does. */
function requestRun(dbPath: string, sessionId: string): void {
  const db = bus.openDb({ db_path: dbPath });
  bus.emit(db, bus.loadConfig({ db_path: dbPath }), {
    event_type: 'wicked.crew.run.requested',
    domain: 'wicked-cli',
    subdomain: 'cli.run',
    payload: { problem: 'Do step one', args: { session_id: sessionId } },
  });
  (db as { close(): void }).close();
}

async function createProject(port: number, name: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBeLessThan(300);
}

/** The engine launched `session` from the bus: its `run.launched` answer is on the SAME file. */
async function engineLaunchedFrom(dbPath: string, session: string): Promise<void> {
  let launched: Row;
  try {
    launched = await waitForRow(dbPath, 'wicked.crew.run.launched', (r) => r.payload.includes(session));
  } catch (err) {
    const tail = daemon?.stderr().split('\n').slice(-40).join('\n') ?? '';
    const onBus = rows(dbPath, 'wicked.').map((r) => r.event_type).join(', ');
    throw new Error(`${(err as Error).message}\nrows on the bus: ${onBus}\ndaemon stderr (tail):\n${tail}`);
  }
  // The engine's publisher identity (CORE_DOMAIN), matched as a pattern: a quoted spelling of that
  // name is reserved for the checkout resolver (tests/core-checkout-policy.test.ts).
  expect(launched.domain).toMatch(/^wicked-core$/);
}

let scratch: string | undefined;
let daemon: Daemon | undefined;
afterEach(async () => {
  if (daemon !== undefined) await daemon.stop();
  daemon = undefined;
  if (scratch !== undefined) removeScratch(scratch);
  scratch = undefined;
});

describe.runIf(existsSync(CLI))('T0 bus handoff — one daemon, one bus file (DES-TEAMING-002)', () => {
  it.runIf(engineHasRule)('A. no flags: the engine is handed the crew bus; seams and engine meet on it; exec stays off', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-t0-a-'));
    const dbPath = join(scratch, 'state', 'core.db');
    const crewBus = `${resolve(dbPath)}.bus/bus.db`;
    daemon = await bootDaemon(dbPath, []);
    expect(daemon.ready['busDb']).toBe(crewBus);
    expect(daemon.ready['engineExec']).toBe(false);

    await createProject(daemon.port, 't0-a');
    await waitForRow(crewBus, 'wicked.crew.project.', (r) => r.payload.includes('t0-a'));
    requestRun(crewBus, 't0-a-run');
    await engineLaunchedFrom(crewBus, 't0-a-run');

    expect(rows(crewBus, 'wicked.crew.task.dispatched')).toEqual([]);
    expect(rows(crewBus, 'wicked.gate.eval.requested')).toEqual([]);
    expect(existsSync(join(scratch, 'state', 'bus.db'))).toBe(false);
    expect(daemon.stderr()).not.toMatch(/bus bridge disabled|bus unavailable/);
  }, 120_000);

  it.runIf(engineHasRule)('B. --engine-exec: mediation is unchanged and runs over the SAME crew bus', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-t0-b-'));
    const dbPath = join(scratch, 'state', 'core.db');
    const crewBus = `${resolve(dbPath)}.bus/bus.db`;
    daemon = await bootDaemon(dbPath, ['--engine-exec']);
    expect(daemon.ready['engineExec']).toBe(true);
    expect(daemon.ready['busDb']).toBe(crewBus);

    await createProject(daemon.port, 't0-b');
    await waitForRow(crewBus, 'wicked.crew.project.', (r) => r.payload.includes('t0-b'));
    requestRun(crewBus, 't0-b-run');
    await engineLaunchedFrom(crewBus, 't0-b-run');
    await waitForRow(crewBus, 'wicked.crew.task.dispatched', (r) => r.payload.includes('t0-b-run'));
    await waitForRow(crewBus, 'wicked.crew.task.completed', (r) => r.payload.includes('t0-b-run'));
    // The old crew-private exec default is gone.
    expect(existsSync(join(scratch, 'state', 'bus.db'))).toBe(false);
  }, 120_000);

  it.runIf(engineHasRule)('C. --bus-db X wins for the engine, exec mediation and the seams', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-t0-c-'));
    const dbPath = join(scratch, 'state', 'core.db');
    const explicit = join(scratch, 'shared-bus', 'bus.db');
    daemon = await bootDaemon(dbPath, ['--bus-db', explicit, '--engine-exec']);
    expect(daemon.ready['busDb']).toBe(explicit);

    await createProject(daemon.port, 't0-c');
    await waitForRow(explicit, 'wicked.crew.project.', (r) => r.payload.includes('t0-c'));
    requestRun(explicit, 't0-c-run');
    await engineLaunchedFrom(explicit, 't0-c-run');
    await waitForRow(explicit, 'wicked.crew.task.dispatched', (r) => r.payload.includes('t0-c-run'));
    expect(existsSync(`${resolve(dbPath)}.bus`)).toBe(false);
    expect(existsSync(join(scratch, 'state', 'bus.db'))).toBe(false);
  }, 120_000);

  it('D. a bus that cannot open: one line, the engine gets no bus, the daemon serves and says so', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-t0-d-'));
    const dbPath = join(scratch, 'state', 'core.db');
    mkdirSync(scratch, { recursive: true });
    const notADir = join(scratch, 'not-a-dir');
    writeFileSync(notADir, 'a file where the bus directory should be');
    const unopenable = join(notADir, 'bus.db');
    daemon = await bootDaemon(dbPath, ['--bus-db', unopenable]);

    const lines = daemon.stderr().split('\n').filter((l) => l.includes('bus unavailable'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`[crew] bus unavailable: cannot open ${unopenable}`);
    expect(daemon.stderr()).not.toContain('wicked-core: bus bridge disabled');
    expect(daemon.ready['busDb']).toBeUndefined();

    const health = (await (await fetch(`http://127.0.0.1:${daemon.port}/api/v1/health`)).json()) as {
      status: string;
      warnings?: { kind: string; severity: string; message: string }[];
    };
    expect(health.status).toBe('ok');
    const notice = health.warnings?.find((w) => w.kind === 'bus.unavailable');
    expect(notice?.severity).toBe('warning');
    expect(notice?.message).toContain('un-teamed');
  }, 120_000);

  it.runIf(!engineHasRule)('E. an engine without the one-connection rule is not handed the daemon bus (pre-T0 handoff)', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-t0-e-'));
    const dbPath = join(scratch, 'state', 'core.db');
    const crewBus = `${resolve(dbPath)}.bus/bus.db`;
    daemon = await bootDaemon(dbPath, []);
    expect(daemon.ready['busDb']).toBeUndefined();
    expect(daemon.stderr()).toContain('predates the one-connection bus rule');
    await createProject(daemon.port, 't0-e');
    await waitForRow(crewBus, 'wicked.crew.project.', (r) => r.payload.includes('t0-e'));
  }, 120_000);
});
