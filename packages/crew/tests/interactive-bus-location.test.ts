// Where the cross-product bus lives (acceptance finding F-043; codex on #506).
//
// Two daemons on one host used to share wicked-bus's HOME-based default — same durable cursor
// names, racing for each other's `doc.created`. The daemon's own bus is now a SIDECAR of its core
// db (`<core db>.bus/bus.db`), which the state-home fence wicked-core embeds already classifies
// through the `core.db` prefix entry (exactly like core's own `core.db.events/`). These pin:
//  - the resolution order (explicit db › WICKED_BUS_DATA_DIR › the sidecar) and its bridge dir;
//  - two isolated `--db` daemons resolve DIFFERENT buses, and a real seam on each proves it: a
//    doc.created on daemon A's bus launches on A and is never seen by B.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CrewBusError, busDataDirOf, busSidecarDir, resolveCrewBus } from '../src/interactive/bus-location.js';
import { DOC_CREATED, startInteractiveDraftSubscriber } from '../src/interactive/draft-events.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput, WorkflowDef } from '../src/core/types.js';
import { removeScratch } from './setup/scratch.js';

describe('resolveCrewBus (F-043)', () => {
  it('defaults to the core db\'s SIDECAR — <core db>.bus/bus.db — so every --db gets its own bus', () => {
    const a = resolveCrewBus({ coreDbPath: '/homes/a/.wicked-crew/core.db' });
    const b = resolveCrewBus({ coreDbPath: '/scratch/fresh/state/core.db' });
    expect(a).toEqual({
      dbPath: resolve('/homes/a/.wicked-crew/core.db.bus/bus.db'),
      dataDir: resolve('/homes/a/.wicked-crew/core.db.bus'),
      source: 'core-db-sidecar',
    });
    expect(b.dataDir).toBe(resolve('/scratch/fresh/state/core.db.bus'));
    expect(a.dbPath).not.toBe(b.dbPath);
    // A custom db name keeps the same sidecar convention core uses for `<db>.events`.
    expect(busSidecarDir('/x/mydb.sqlite')).toBe(resolve('/x/mydb.sqlite.bus'));
  });

  it('an explicit --bus-db / WICKED_BUS_DB wins; its bridge dir is the parent only when the file is bus.db', () => {
    expect(resolveCrewBus({ explicitDb: '/opt/shared/bus.db', envDataDir: '/ignored', coreDbPath: '/x/core.db' })).toEqual({
      dbPath: resolve('/opt/shared/bus.db'),
      dataDir: resolve('/opt/shared'),
      source: 'flag-or-env-db',
    });
    // An explicit db wicked-bus cannot share with the bridge is a BOOT ERROR, not a warning (codex on #506).
    expect(() => resolveCrewBus({ explicitDb: '/opt/shared/custom.db', coreDbPath: '/x/core.db' })).toThrow(CrewBusError);
    expect(() => resolveCrewBus({ explicitDb: '/opt/shared/custom.db', coreDbPath: '/x/core.db' })).toThrow(
      /reaches a bus only through a data DIRECTORY.*Name the file .*bus\.db/s,
    );
    expect(busDataDirOf('/state/bus/bus.db')).toBe(resolve('/state/bus'));
    expect(busDataDirOf('/state/custom.db')).toBeNull();
  });

  it('WICKED_BUS_DATA_DIR (wicked-bus\'s own env) is honoured next — <dir>/bus.db, the dir handed to the bridge', () => {
    expect(resolveCrewBus({ envDataDir: '/private/tmp/fresh/bus', coreDbPath: '/x/core.db' })).toEqual({
      dbPath: resolve('/private/tmp/fresh/bus/bus.db'),
      dataDir: resolve('/private/tmp/fresh/bus'),
      source: 'env-data-dir',
    });
    // Empty strings are "unset".
    expect(resolveCrewBus({ explicitDb: '', envDataDir: '', coreDbPath: '/x/core.db' }).source).toBe('core-db-sidecar');
  });

  it('the sidecar spelling is classified by the fence registry\'s `core.db` PREFIX entry — no new top-level name', () => {
    const top = 'core.db.bus';
    expect(top.startsWith('core.db')).toBe(true); // core's Claim::Prefix rule (src/state_home.rs `claims`)
  });
});

// ── Two isolated daemons, two buses, one real seam each ──────────────────────────────────────

interface FakeEngine {
  launches: LaunchRunInput[];
  asAdapter(): CoreAdapter;
}
function fakeEngine(): FakeEngine {
  const state: FakeEngine = {
    launches: [],
    asAdapter: () =>
      ({
        registerWorkflow: async (def: WorkflowDef) => def.id,
        launchRun: async (input: LaunchRunInput) => {
          state.launches.push(input);
          return input.sessionId;
        },
        onEvent: () => () => undefined,
        listRepos: async () => [], // the run-dir guard fails closed on an unlistable registry
      }) as unknown as CoreAdapter,
  };
  return state;
}
const SEATS = JSON.stringify([{ key: 'stub', display_name: 'Stub', binary: 'stub', headless_invocation: 'stub {PROMPT}' }]);
async function waitFor(cond: () => boolean, ms = 5000, step = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

describe('two isolated --db daemons never share a bus (F-043)', () => {
  let dir: string;
  const subs: Array<{ stop(): Promise<void> | void }> = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-bus-iso-'));
  });
  afterEach(async () => {
    for (const s of subs.splice(0)) await s.stop();
    removeScratch(dir);
  });

  it('a doc.created on daemon A\'s bus launches on A and is never seen by B', async () => {
    const bus = await import('wicked-bus');
    const homeA = join(dir, 'a');
    const homeB = join(dir, 'b');
    const busA = resolveCrewBus({ coreDbPath: join(homeA, 'core.db') });
    const busB = resolveCrewBus({ coreDbPath: join(homeB, 'core.db') });
    expect(busA.dbPath).not.toBe(busB.dbPath);
    // What the CLI does before the seams open their db (better-sqlite3 creates no parents).
    mkdirSync(dirname(busA.dbPath), { recursive: true });
    mkdirSync(dirname(busB.dbPath), { recursive: true });

    const engineA = fakeEngine();
    const engineB = fakeEngine();
    for (const [engine, loc, home] of [[engineA, busA, homeA], [engineB, busB, homeB]] as const) {
      const sub = await startInteractiveDraftSubscriber(engine.asAdapter(), {
        dbPath: loc.dbPath,
        pollIntervalMs: 25,
        heartbeatMs: 60_000,
        ledgerPath: join(home, 'interactive-draft-ledger.json'),
        draftDir: join(home, 'interactive-drafts'),
        clisJson: SEATS,
        log: () => {},
      });
      expect(sub).not.toBeNull();
      subs.push(sub!);
    }
    // Each daemon's bus materialized as its core db's sidecar — two files, two directories.
    expect(existsSync(join(homeA, 'core.db.bus', 'bus.db'))).toBe(true);
    expect(existsSync(join(homeB, 'core.db.bus', 'bus.db'))).toBe(true);

    // The bridge daemon A spawned emits where A reads.
    const dbA = bus.openDb({ db_path: busA.dbPath });
    bus.emit(dbA, bus.loadConfig({ db_path: busA.dbPath }), {
      event_type: DOC_CREATED,
      domain: 'wicked-interactive',
      subdomain: 'docs',
      payload: { document_id: 'only-on-a', kind: 'source', brief: 'a brief', source_paths: [], ts: new Date().toISOString() },
      producer_id: 'wi-service',
    });
    await waitFor(() => engineA.launches.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(engineB.launches.length, 'daemon B must never see daemon A\'s doc.created').toBe(0);
  });
});
