// crew#1763: the hermetic setup keeps every engine a test boots off the network for its memory embedder.
//
// Un-armed, an engine booted under a fresh HOME downloads the Model2Vec model from Hugging Face into
// `$HOME/.cache/huggingface` while its actor boots, and every route that waits on the actor waits on that
// download (the v0.18.20 Release's `/health` timed out at 30 s). This file does not set the variable itself:
// what it reads is what tests/setup/hermetic-home.ts armed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

describe('the memory embedder in tests (crew#1763)', () => {
  const saved = process.env['HOME'];
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crew-1763-'));
    mkdirSync(join(dir, 'home'));
    process.env['HOME'] = join(dir, 'home');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['HOME'];
    else process.env['HOME'] = saved;
    removeScratch(dir);
  });

  it('is armed lexical by the setup file', () => {
    expect(process.env['WICKED_MEMORY_EMBEDDER']).toBe('hash');
  });

  it('a stub engine booted under a fresh HOME fetches no model: its store records the lexical embedder', async () => {
    const dbPath = join(dir, 'core.db');
    const adapter = new CoreAdapter({ dbPath, stub: true });
    try {
      await adapter.ping();
      expect(readFileSync(`${dbPath}.mem.embedder`, 'utf8')).toBe('hash');
      expect(existsSync(join(dir, 'home', '.cache', 'huggingface'))).toBe(false);
    } finally {
      adapter.close();
    }
  });
});
