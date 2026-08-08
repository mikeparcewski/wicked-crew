// FINDING-002 (residual): a user-registered workflow is written to the overlay dir AND to the
// in-memory `userWorkflows` Map, but the Map is process-local and empty on every daemon restart, and
// nothing read the dir back. So after a restart the Rust actor (which loads the overlay dir) would
// launch a workflow that `listWorkflows()` / `GET /workflows` no longer showed — it vanished from the
// registry while remaining runnable. `readOverlayWorkflows` is the reader that closes that gap; these
// tests pin the restart-hydration contract without spawning a Core.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOverlayWorkflows } from '../src/core/adapter.js';

describe('FINDING-002: overlay-dir workflow hydration', () => {
  it('surfaces a user workflow from disk, skipping built-in overlays and unreadable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wicked-overlay-'));
    try {
      // The restart case: a valid user workflow persisted to disk but NOT in the in-memory Map.
      writeFileSync(
        join(dir, 'myflow.json'),
        JSON.stringify({ id: 'myflow', phases: [{ id: 'p1' }] }),
      );
      // A built-in overlay written FOR the Rust actor — must NOT be surfaced (it would duplicate the
      // built-in in listWorkflows). This is the case the skip-guard exists for.
      writeFileSync(join(dir, 'onboarding.json'), JSON.stringify({ id: 'onboarding', phases: [] }));
      // An unparseable overlay and a non-json file — both skipped (core skips an unreadable overlay).
      writeFileSync(join(dir, 'broken.json'), '{ not valid json');
      writeFileSync(join(dir, 'notes.txt'), 'ignore me');

      const builtinIds = new Set(['onboarding']);
      const got = readOverlayWorkflows(dir, builtinIds);
      // ONLY the user workflow — proves the read happens AND the built-in overlay is skipped.
      expect(got.map((w) => w.id)).toEqual(['myflow']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the overlay dir does not exist (nothing registered yet)', () => {
    const missing = join(tmpdir(), 'wicked-overlay-does-not-exist-002');
    expect(readOverlayWorkflows(missing, new Set())).toEqual([]);
  });
});
