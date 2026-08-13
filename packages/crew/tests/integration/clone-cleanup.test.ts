// Regression tests for cloneAndRegisterRepo cleanup behaviour (crew#63, crew#81).
//
// Scenario A — pre-existing directory: clone fails → only .git is removed, caller's
//              directory and any existing contents are preserved.
// Scenario B — new directory (we created it): clone fails → whole directory is removed
//              so a retry starts fresh.
//
// `git clone` is the real operation, so these tests require git on PATH.
// They use an invalid URL so the clone always fails quickly.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../../src/core/adapter.js';

const INVALID_URL = 'not-a-valid-git-url';

let adapter: CoreAdapter;
let dbDir: string;

beforeAll(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'crew-clone-cleanup-db-'));
  adapter = new CoreAdapter({ dbPath: join(dbDir, 'core.db'), stub: true });
});

afterAll(() => {
  adapter.close();
  rmSync(dbDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('cloneAndRegisterRepo cleanup', () => {
  it('preserves a pre-existing directory and removes only .git on clone failure', async () => {
    const preexistingDir = mkdtempSync(join(tmpdir(), 'crew-preexist-'));
    // Put a sentinel file in the directory to prove we didn't delete it.
    const sentinel = join(preexistingDir, 'sentinel.txt');
    writeFileSync(sentinel, 'do-not-delete');

    try {
      await expect(
        adapter.cloneAndRegisterRepo('pre-existing', INVALID_URL, preexistingDir),
      ).rejects.toThrow();

      // The directory and its contents must survive.
      expect(existsSync(preexistingDir)).toBe(true);
      expect(existsSync(sentinel)).toBe(true);
      // Any partial .git written by the failed clone must be gone.
      expect(existsSync(join(preexistingDir, '.git'))).toBe(false);
    } finally {
      rmSync(preexistingDir, { recursive: true, force: true });
    }
  });

  it('removes a newly-created directory entirely on clone failure', async () => {
    const newDir = join(tmpdir(), `crew-new-dir-${Date.now()}`);
    expect(existsSync(newDir)).toBe(false);

    await expect(
      adapter.cloneAndRegisterRepo('new-dir', INVALID_URL, newDir),
    ).rejects.toThrow();

    // The directory was created by us → must be cleaned up so a retry starts fresh.
    expect(existsSync(newDir)).toBe(false);
  });
});
