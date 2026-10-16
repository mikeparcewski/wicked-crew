// wicked-core#976: the adapter reads the engine's one launch bench (`Core.worktreeBenched`) and
// splits it by `governed_only` — the host-floor bench vs every other launcher bench. The engine's
// predicate is a fake here (no engine decision is restated).

import { describe, expect, it } from 'vitest';

import { readLaunchBench } from '../src/core/adapter.js';

const HOST = 'runs only on the container floor: …';
const WORKTREE = "codex cannot work in this run's worktree on this host: …";

function engine(answer: (bound: boolean) => unknown[]) {
  const calls: Array<[string, boolean]> = [];
  const predicate = (clisJson: string, bound: boolean) => {
    calls.push([clisJson, bound]);
    return JSON.stringify(answer(bound));
  };
  return { calls, predicate };
}

describe('the engine launch bench, split by governed_only', () => {
  it('the host-floor read takes the unbound bench and keeps only the governed-only entries; the worktree read drops them', () => {
    const { calls, predicate } = engine((bound) => [
      { cli: 'pi', reason: HOST, source: 'launcher', governed_only: true },
      { cli: 'opencode', reason: HOST, source: 'launcher', governed_only: true },
      ...(bound ? [{ cli: 'codex', reason: WORKTREE, source: 'launcher' }] : []),
    ]);
    const seats = [{ key: 'claude' }, { key: 'pi' }, { key: 'opencode' }, { key: 'codex' }];
    expect(readLaunchBench(predicate, seats, false, true)).toEqual(new Map([['pi', HOST], ['opencode', HOST]]));
    expect(calls).toEqual([[JSON.stringify(seats), false]]);
    expect(readLaunchBench(predicate, seats, true, false)).toEqual(new Map([['codex', WORKTREE]]));
    expect(calls[1]![1]).toBe(true);
  });

  it('an addon that predates the host-floor bench marks nothing, and one without the predicate answers null', () => {
    const { predicate } = engine(() => [{ cli: 'codex', reason: WORKTREE, source: 'launcher' }]);
    expect(readLaunchBench(predicate, [{ key: 'codex' }], false, true)).toEqual(new Map());
    expect(readLaunchBench(undefined, [{ key: 'codex' }], false, true)).toBeNull();
  });
});
