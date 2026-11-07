// crew#944: concurrent `sessionsDetail()` reads share engine folds (at most one running, one
// queued) instead of each queueing its own fold on the engine's actor. F35: a fold is parsed once and
// shared until the store may have changed, and a caller never takes the answer of a fold that started
// before a change it could have seen.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';

let dir: string;
let adapter: CoreAdapter;
/** Each engine fold the fake was asked for, resolved by the test. */
let folds: Array<{ resolve: (json: string) => void; reject: (e: Error) => void }>;

function run(id: string): unknown {
  return {
    session: { id, workflow_id: 'feature', status: 'completed', team_plan: { rev: 1 } },
    units: [],
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sessions-detail-coalesce-'));
  adapter = new CoreAdapter({ dbPath: join(dir, 'core.db'), stub: true });
  folds = [];
  (adapter as unknown as { core: Record<string, unknown> }).core['sessionsDetail'] = () =>
    new Promise<string>((resolve, reject) => folds.push({ resolve, reject }));
});

afterEach(() => {
  adapter.close();
  removeScratch(dir);
});

const tick = () => new Promise((r) => setImmediate(r));

/** Move the views version, as any engine call that may write does (F35). */
async function write(): Promise<void> {
  (adapter as unknown as { core: Record<string, unknown> }).core['cancelRun'] = async () => '"cancelled"';
  await adapter.cancelRun('x');
}

describe('CoreAdapter.sessionsDetail coalescing (crew#944, F35)', () => {
  it('20 concurrent reads cost two engine folds, and the ones that arrived after a change mid-fold get the second', async () => {
    const first = adapter.sessionsDetail();
    await tick();
    await write();
    const rest = Array.from({ length: 19 }, () => adapter.sessionsDetail());
    await tick();
    expect(folds).toHaveLength(1); // the 19 wait for the next fold; none is queued on the engine yet
    folds[0]!.resolve(JSON.stringify([run('before')]));
    expect((await first).map((v) => v.session.id)).toEqual(['before']);
    await tick();
    expect(folds).toHaveLength(2);
    folds[1]!.resolve(JSON.stringify([run('after')]));
    const got = await Promise.all(rest);
    expect(got.every((views) => views.length === 1 && views[0]!.session.id === 'after')).toBe(true);
    // Each caller owns its views: decorating one never shows through another's.
    got[0]![0]!.session.status = 'failed';
    expect(got[1]![0]!.session.status).toBe('completed');
  });

  it('concurrent reads with no change between them share one fold', async () => {
    const reads = Array.from({ length: 20 }, () => adapter.sessionsDetail());
    await tick();
    expect(folds).toHaveLength(1);
    folds[0]!.resolve(JSON.stringify([run('x')]));
    expect((await Promise.all(reads)).every((v) => v[0]!.session.id === 'x')).toBe(true);
  });

  it('a read after the fold settles is served from it until the store may have changed', async () => {
    const a = adapter.sessionsDetail();
    await tick();
    folds[0]!.resolve('[]');
    await a;
    expect(await adapter.sessionsDetail()).toEqual([]);
    expect(folds).toHaveLength(1);
    await write();
    const b = adapter.sessionsDetail();
    await tick();
    expect(folds).toHaveLength(2);
    folds[1]!.resolve(JSON.stringify([run('x')]));
    expect((await b).map((v) => v.session.id)).toEqual(['x']);
  });

  it('a failed fold rejects its callers and is not kept; the queued fold still runs', async () => {
    const a = adapter.sessionsDetail();
    await tick();
    await write();
    const b = adapter.sessionsDetail();
    await tick();
    folds[0]!.reject(new Error('actor stopped'));
    await expect(a).rejects.toThrow('actor stopped');
    await tick();
    expect(folds).toHaveLength(2);
    folds[1]!.resolve(JSON.stringify([run('y')]));
    expect((await b).map((v) => v.session.id)).toEqual(['y']);
  });

  it('a read after a failed fold starts a fresh one', async () => {
    const a = adapter.sessionsDetail();
    await tick();
    folds[0]!.reject(new Error('actor stopped'));
    await expect(a).rejects.toThrow('actor stopped');
    const b = adapter.sessionsDetail();
    await tick();
    expect(folds).toHaveLength(2);
    folds[1]!.resolve('[]');
    expect(await b).toEqual([]);
  });
});
