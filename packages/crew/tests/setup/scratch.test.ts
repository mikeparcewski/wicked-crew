import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { removeScratch } from './scratch.js';

vi.mock('node:fs', () => ({ rmSync: vi.fn() }));

describe('removeScratch (crew#429)', () => {
  it('uses Node retry semantics for a concurrently repopulated scratch tree', () => {
    removeScratch('/tmp/crew429-scratch');

    expect(rmSync).toHaveBeenCalledWith('/tmp/crew429-scratch', {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  });
});
