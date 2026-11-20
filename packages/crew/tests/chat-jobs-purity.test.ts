import { expect, it, vi } from 'vitest';

vi.mock('../src/core/adapter.js', () => { throw new Error('pure chat cards must not load the engine adapter'); });

it('resolves chat cards without loading the engine adapter', async () => {
  const { resolveJob } = await import('../src/api/chat-jobs.js');
  expect(resolveJob).toBeTypeOf('function');
});
