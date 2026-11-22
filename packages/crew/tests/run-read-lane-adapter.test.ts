// crew#1779 on the real adapter: the listeners of one run-end frame share one engine read of that run, and a
// request's read (a gate read) is not queued behind them. Red before the frame lane: eight engine reads.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

/** The engine's one read connection: each read takes `ms`, served in arrival order. */
function oneConnection(ms: number, answer: (id: string) => string) {
  let tail: Promise<unknown> = Promise.resolve();
  const reads: string[] = [];
  const read = (id: string): Promise<string> => {
    reads.push(id);
    // The read sees the store as it is when the connection serves it.
    const done = tail.then(() => {
      const value = answer(id);
      return new Promise<string>((r) => setTimeout(() => r(value), ms));
    });
    tail = done;
    return done;
  };
  return { read, reads };
}

const VIEW = (id: string, status = 'completed') => JSON.stringify({ session: { id, status }, units: [] });

describe('CoreAdapter.runView: the frame lane on the real adapter', () => {
  const dirs: string[] = [];
  const adapters: CoreAdapter[] = [];
  afterEach(() => {
    for (const a of adapters.splice(0)) a.close();
  });
  afterAll(() => dirs.forEach(removeScratch));

  it('one run end read by eight listeners is one engine read; a gate read meanwhile goes straight through', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-read-lane-'));
    dirs.push(dir);
    const adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
    adapters.push(adapter);
    const conn = oneConnection(20, (id) => VIEW(id));
    (adapter as unknown as { core: { sessionDetail: (id: string) => Promise<string> } }).core.sessionDetail = conn.read;

    const seen: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i++) {
      adapter.onEvent((event) => {
        if (event.type !== 'sessionCompleted') return;
        // As the run-end listeners do: a little async work first, then the one-run read.
        seen.push((async () => {
          await Promise.resolve();
          return (await adapter.runView('run-ended'))?.session.status;
        })());
      });
    }
    (adapter as unknown as { onEngineFrame(err: Error | null, json: string): void }).onEngineFrame(
      null,
      JSON.stringify({ type: 'sessionCompleted', session_id: 'run-ended' }),
    );
    await new Promise((r) => setTimeout(r, 1));
    const t0 = performance.now();
    const gate = await adapter.runView('run-gate');
    expect(gate?.session.id).toBe('run-gate');
    // At most the one shared run-end read is ahead of it on the connection (eight 20 ms reads before the lane).
    expect(performance.now() - t0).toBeLessThan(100);
    expect(await Promise.all(seen)).toEqual(Array(8).fill('completed'));
    expect(conn.reads.filter((id) => id === 'run-ended')).toHaveLength(1);
    expect(conn.reads.filter((id) => id === 'run-gate')).toHaveLength(1);
  });
});
