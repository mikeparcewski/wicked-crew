// Keep the test suite out of the operator's REAL home directory (crew#396).
//
// Crew's integration tests boot the REAL engine in-process (`CoreAdapter` → `Core.spawn` /
// `Core.spawnStub`; the Rust actor reads `process.env` at spawn time) and spawn the dist CLI as a
// child (which inherits `process.env`). Un-armed, one vitest run:
//
//   - appended ~640KB / 1,304 junk NDJSON events to the real
//     `~/.something-wicked/wicked-apps/emit-outbox.ndjson` (the engine's emit dead-letter spool —
//     it accumulated 227MB of test junk before this file existed), and
//   - REWROTE `~/.wicked-worker/claude/settings.json` with the deny fence, deleting the operator's
//     hooks/, plugins/, commands/, settings.local.json there (acp_runner.rs re-sanitizes the
//     worker config home on EVERY worker spawn), and
//   - read/REWROTE the operator's real `~/.config/wicked-core/settings.json` (every
//     `createServer` boot reads it; any `PUT /settings` test rewrote it), and
//   - appended to the operator's real `~/.wicked-crew/audit.log`.
//
// This is crew's mirror of wicked-core#311 (`emit::hermetic_test_spool()` +
// `spawn::hermetic_test_worker_home()`, armed pre-main via `#[ctor]`): ONE shared helper, a
// per-process temp base, set before any test code runs, never unset. `setupFiles` is vitest's
// pre-main — it is evaluated before the test file (and everything it imports) loads, so even
// module-scope engine boots see the armed env, and every child process inherits it.
//
// The engine-side seams this arms (all pre-existing; the leak was that no crew test set them):
//   WICKED_APPS_EMIT_DEADLETTER   emit.rs `deadletter_path()` — the outbox spool FILE
//   WICKED_WORKER_HOME            acp_runner.rs `worker_config_home()` — the worker-config BASE dir
//   WICKED_BUS_DATA_DIR           wicked-bus lib/paths.js — the bus's data dir (createServer's
//                                 project-events seam opens the bus with its own resolution, which
//                                 defaults to `~/.something-wicked/wicked-bus/`; observed creating
//                                 bus.db there during a fake-$HOME probe of daemon-bridge)
// And the crew-side seams:
//   WICKED_CREW_SYSTEM_SETTINGS   core/adapter.ts `settingsFilePath()` — the system settings.json
//                                 (this one also stops boot from importing the operator's real
//                                 `worker_config_root` into the armed env)
//   WICKED_CREW_AUDIT_LOG         api/audit.ts `defaultAuditPath()`
//   WICKED_CREW_PROJECT_GRAPH_ROOT projects/graph-paths.ts `projectGraphRoot()` (createServer-based
//                                 tests never call `setProjectGraphStateHome`, so they'd fall
//                                 through to `~/.wicked-crew/project-graphs`)
//
// `applyWorkerConfigRoot` (api/seat-signin.ts) restores the value armed here — the process's
// boot-time env — whenever the settings store has no `worker_config_root`, so a daemon booted over
// empty settings can no longer reopen the un-armed window mid-suite.
//
// `tests/harness-hygiene.test.ts` is the regression guard: it fails loudly if this file stops
// being registered, stops arming, or a new test spawns a child with a stripped env.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One base dir and one exit listener per PROCESS, however many files the worker runs — the same
// guard `isolate-workflow-overlay.ts` documents (vitest's forks pool usually means one file per
// process, but that default is not ours to hold still).
const KEY = '__wickedCrewHermeticHome';
const slot = globalThis as typeof globalThis & { [KEY]?: string };

if (slot[KEY] === undefined) {
  const base = mkdtempSync(join(tmpdir(), 'wicked-crew-hermetic-'));
  mkdirSync(join(base, 'worker-home'), { recursive: true });
  slot[KEY] = base;

  // Best-effort: an `exit` handler must be synchronous, and a worker killed outright never runs
  // it. The base is under the OS temp root either way.
  process.on('exit', () => {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* the OS owns temp cleanup from here */
    }
  });
}

const base = slot[KEY];

// Re-asserted per FILE, not just per process: a test that re-aims one of these at its own fixture
// must not leak that choice into whatever file the worker picks up next. Never unset — an unset
// window is exactly the disease (crew#396).
process.env['WICKED_APPS_EMIT_DEADLETTER'] = join(base, 'emit-outbox.ndjson');
process.env['WICKED_WORKER_HOME'] = join(base, 'worker-home');
process.env['WICKED_BUS_DATA_DIR'] = join(base, 'wicked-bus');
process.env['WICKED_CREW_SYSTEM_SETTINGS'] = join(base, 'wicked-core-settings.json');
process.env['WICKED_CREW_AUDIT_LOG'] = join(base, 'audit.log');
process.env['WICKED_CREW_PROJECT_GRAPH_ROOT'] = join(base, 'project-graphs');
