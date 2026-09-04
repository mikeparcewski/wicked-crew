// Shared retry-tolerant scratch-dir removal for daemon/engine-backed test teardown (crew#429).
//
// Every suite that boots a real `CoreAdapter` (wicked-core-ts `Core`, native/NAPI) carries a
// worktree keeper/reaper that runs on its own Rust thread with no JS-awaitable completion —
// `Core.prototype` exposes no `close`/`drain`/`join`, and `adapter.close()`
// (`src/core/adapter.ts`) tears down only the event subscription, never the engine. When git
// refuses a non-forced worktree remove, the engine logs "keeping worktree ..." and may still be
// touching paths under the test's scratch dir after `adapter.close()` returns.
//
// A plain `rmSync(dir, { recursive: true, force: true })` walks the tree bottom-up (empty a
// directory, then `rmdir` it); a reaper write landing between those two steps re-creates a child
// and turns the `rmdir` into ENOTEMPTY — intermittently, worse under parallel vitest load
// (observed on `recon-fanout-campaign.test.ts`, crew#429).
//
// `fs.rmSync`'s `maxRetries`/`retryDelay` retry specifically on EBUSY/EMFILE/ENFILE/ENOTEMPTY/
// EPERM, re-walking the whole tree on each attempt — so a path the reaper re-created is swept on
// the next pass once its tail finally settles. This is the one shared home for that retry budget.
// Pair with `quiesce.ts` (cancel + await terminal before calling this) to shrink the race window
// first. There is no JS-side guarantee the reaper has fully stopped: the npm-pinned 0.7.11 engine
// binding exposes no `Core.shutdown`/`drain`/`join`.
// A bounded retry is therefore the crew-side defence in depth; an awaitable engine drain/join is
// required to make this ordering mathematically race-free.
import { rmSync } from 'node:fs';

const REMOVE_RETRIES = 20;
const REMOVE_RETRY_DELAY_MS = 100;

/** Remove a test scratch dir, tolerating the engine's async worktree-reaper tail (crew#429). */
export function removeScratch(dir: string): void {
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}
