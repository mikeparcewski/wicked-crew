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

const dir = mkdtempSync(join(tmpdir(), 'wicked-crew-workflows-'));
process.env['WICKED_WORKFLOWS_DIR'] = dir;

// Best-effort: an `exit` handler must be synchronous, and a worker killed outright never runs it.
// The dir is under the OS temp root either way, so the failure mode is a stray empty directory.
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS owns temp cleanup from here */
  }
});
