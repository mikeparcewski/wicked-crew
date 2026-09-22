import { describe, expect, it, vi } from 'vitest';

// Hoist-safe fs mock (review, #440): the mock fn is created via vi.hoisted so the factory
// below never races module evaluation, and assertions target the mock directly rather than
// an import that would fall back to the real rmSync if hoisting ever changed.
const { rmSyncMock } = vi.hoisted(() => ({ rmSyncMock: vi.fn() }));
vi.mock('node:fs', () => ({ rmSync: rmSyncMock }));

import { removeScratch } from './scratch.js';

describe('removeScratch (crew#429)', () => {
  it('uses Node retry semantics for a concurrently repopulated scratch tree', () => {
    removeScratch('/tmp/crew429-scratch');

    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/crew429-scratch', {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });
});
