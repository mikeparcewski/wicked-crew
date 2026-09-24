// DES-TEAMING-002 T0 — the F-E2E-021 lock-loss class does not reproduce with TWO SQLite libraries on
// the daemon's ONE bus file.
//
// Since T0 one process holds the bus file through two SQLite libraries: crew's better-sqlite3 (its
// seams and the long-lived crew bus handle, src/core/bus-handle.ts) and the engine's bundled
// rusqlite (wicked-core-ts, handed the same file as `WICKED_BUS_DB`). POSIX advisory locks belong to
// the process and ANY close of a descriptor for the file drops all of them, so if either library
// ever closes a connection it opened, the other's locks are gone, the next external emitter wins
// EXCLUSIVE on its own close, checkpoints and unlinks `-wal`/`-shm`, and the survivors read a ghost
// WAL: new rows never appear, or "database disk image is malformed" (F-E2E-021).
//
// The churn here is what a daemon's lifetime does to the engine side: engines come and go in one
// process (each spawn is a new bus bridge; each collected `Core` used to close its connection).
// Each round spawns a stub engine on the bus, collects it, then an EXTERNAL process emits one row
// and exits (its close is the one that would unlink the WAL). After every round crew's long-lived
// handle must see every row, `quick_check` must be `ok`, and `-wal` must still exist.
//
// Needs a child `node --expose-gc` (to collect the engine deterministically), a built dist, and an
// engine that implements the rule (wicked-core-ts exposes `Core.busConnectionStats`, the engine half
// of T0). Crew CI builds the engine from wicked-core `main`, so until that half is on main this suite
// is SKIPPED there, visibly — it is not a pass. Against an engine without the rule the churn below
// reproduces the loss (see the PR for the recorded red run).

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { removeScratch } from '../setup/scratch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..', '..');
const HANDLE = join(PKG, 'dist', 'core', 'bus-handle.js');
const ROUNDS = 6;
const engineHasRule =
  typeof (createRequire(import.meta.url)('wicked-core-ts') as { Core: { busConnectionStats?: unknown } }).Core
    .busConnectionStats === 'function';

// The "daemon": crew's handle first (as serve does at boot), then engine churn, then external emits.
const DAEMON = `
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const [, , pkg, handleUrl, dir, busPath, emitter, rounds] = process.argv;
const { Core } = createRequire(join(pkg, 'package.json'))('wicked-core-ts');
const { crewBusHandle } = await import(handleUrl);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.WICKED_BUS_DB = busPath;
delete process.env.WICKED_BUS_EXEC;
const handle = crewBusHandle(busPath, { create: true });
const out = [];
for (let i = 0; i < Number(rounds); i++) {
  let core = Core.spawnStub(join(dir, 'core-' + i + '.db'));
  await core.ping();
  await sleep(300);           // the engine's bus bridge has connected
  core = null;
  globalThis.gc();
  await sleep(700);           // the collected engine's actor + bridge threads have exited
  const emitted = spawnSync(process.execPath, [emitter, busPath, String(i)], { encoding: 'utf8' });
  let seen = -1, check = 'unread', error = null;
  try {
    seen = handle.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 't0.stress.row.emitted'").all()[0].n;
    check = handle.prepare('PRAGMA quick_check').all()[0].quick_check;
  } catch (e) { error = String(e && e.message || e); }
  out.push({ round: i, emitStatus: emitted.status, emitErr: emitted.stderr, seen, check, error, wal: existsSync(busPath + '-wal') });
}
const engine = typeof Core.busConnectionStats === 'function' ? JSON.parse(Core.busConnectionStats(busPath) ?? 'null') : 'no-rule';
process.stdout.write('RESULT ' + JSON.stringify({ rounds: out, engine }) + '\\n');
process.exit(0);
`;

// The external emitter: its own process, one connection, one insert, then close and exit.
const EMITTER = `
import { createRequire } from 'node:module';
import { join } from 'node:path';
const [, , busPath, i, pkg] = process.argv;
const req = createRequire(createRequire(join(pkg, 'package.json')).resolve('wicked-bus'));
const Database = req('better-sqlite3');
const db = new Database(busPath);
db.pragma('busy_timeout = 5000');
const now = Date.now();
db.prepare('INSERT INTO events (event_type, domain, subdomain, payload, schema_version, idempotency_key, emitted_at, expires_at, dedup_expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run('t0.stress.row.emitted', 'external', 'stress', '{}', '1.0.0', 'stress-' + i + '-' + now, now, now + 3600000, now + 3600000);
db.close();
`;

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) removeScratch(scratch);
  scratch = undefined;
});

describe.runIf(existsSync(HANDLE) && engineHasRule)('T0: two SQLite libraries on one bus file keep their locks (F-E2E-021)', () => {
  it(`${ROUNDS} rounds of engine churn + external emits: every row visible, quick_check ok, -wal intact`, () => {
    scratch = mkdtempSync(join(tmpdir(), 'crew-t0-stress-'));
    const busPath = join(scratch, 'bus.db');
    const daemonScript = join(scratch, 'daemon.mjs');
    const emitterScript = join(scratch, 'emit.mjs');
    writeFileSync(daemonScript, DAEMON);
    writeFileSync(emitterScript, EMITTER.replace("const [, , busPath, i, pkg] = process.argv;", `const [, , busPath, i] = process.argv; const pkg = ${JSON.stringify(PKG)};`));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['WICKED_BUS_DB'];
    delete env['WICKED_BUS_EXEC'];
    const run = spawnSync(
      process.execPath,
      ['--expose-gc', daemonScript, PKG, pathToFileURL(HANDLE).href, scratch, busPath, emitterScript, String(ROUNDS)],
      { encoding: 'utf8', env, timeout: 90_000 },
    );
    const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `daemon script failed (${run.status}): ${run.stderr}`).toBeDefined();
    const result = JSON.parse(line!.slice('RESULT '.length)) as {
      rounds: { round: number; emitStatus: number; emitErr: string; seen: number; check: string; error: string | null; wal: boolean }[];
      engine: { opens: number; opener: string } | null;
    };
    const rounds = result.rounds;
    // Every engine the churn spawned used the ONE connection the first one's bus thread opened.
    expect(result.engine).toEqual({ opens: 1, opener: 'wicked-core-bus-poller' });
    expect(rounds).toHaveLength(ROUNDS);
    expect(
      rounds.map((r) => ({ round: r.round, emitStatus: r.emitStatus, seen: r.seen, check: r.check, error: r.error, wal: r.wal })),
    ).toEqual(
      Array.from({ length: ROUNDS }, (_, i) => ({ round: i, emitStatus: 0, seen: i + 1, check: 'ok', error: null, wal: true })),
    );
  }, 120_000);
});
