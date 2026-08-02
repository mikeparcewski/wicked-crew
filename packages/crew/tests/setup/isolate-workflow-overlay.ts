// Keep the test suite out of the developer's real config directory.
//
// Crew writes workflow overlay files to `$WICKED_WORKFLOWS_DIR`, defaulting to
// `~/.config/wicked-core/workflows`, on the first launch of a drop-in workflow. Under test that
// default means the suite installs files into whatever `$HOME` it runs as:
// `tests/integration/daemon-bridge.test.ts` POSTs a run with `workflow: 'domain-extraction'`, and
// the write lands in the real dir. Observed directly — `npm test` rewrote
// `~/.config/wicked-core/workflows/domain-extraction.json` with a fresh mtime.
//
// That dir is not neutral ground. A file in it silently REPLACES a compiled wicked-core built-in
// (FINDING-049), so a test suite that plants files there is a way for an overlay to appear on a
// machine nobody knowingly launched a run on — and to persist long after the test that wrote it.
//
// Redirect it per worker process, before any test file is loaded, so no future test has to
// remember. A test that needs to inspect the dir still sets its own path (see
// `builtin-overlay-shadow.test.ts`); this only removes the unsafe default.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `setupFiles` is evaluated once per test FILE, not once per process. Under vitest's default fork
// pool that is the same thing — measured on this suite, 15 files ran as 15 distinct pids carrying
// one `exit` listener each. It stops being the same thing the moment the pool is shared
// (`isolate: false`, `poolOptions.threads.singleThread`), where a per-file listener would pile up
// until Node warns at 10. The guard costs one lookup and makes the file correct under either: one
// dir and one listener per process, however many files that process ends up running.
const KEY = '__wickedCrewWorkflowOverlayDir';
const slot = globalThis as typeof globalThis & { [KEY]?: string };

if (slot[KEY] === undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'wicked-crew-workflows-'));
  slot[KEY] = dir;

  // Best-effort: an `exit` handler must be synchronous, and a worker killed outright never runs it.
  // The dir is under the OS temp root either way, so the failure mode is a stray empty directory.
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS owns temp cleanup from here */
    }
  });
}

// Re-asserted per file, not just per process: a test that points `WICKED_WORKFLOWS_DIR` somewhere of
// its own must not leak that choice into whatever file the worker picks up next.
process.env['WICKED_WORKFLOWS_DIR'] = slot[KEY];
