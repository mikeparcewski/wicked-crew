// Generation reaping vs LIVE runs (design v3 §1: "old generations are reaped only after no live
// session references them"). The engine reports the generation it hands each spawn on its own
// stderr; crew pins conservatively from the CoreEvent stream: a live session holds the generation
// `current` resolved to when it was first seen plus every generation published while it stayed
// live, and its terminal frame releases them and reaps what nobody else holds.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import { LiveGenerations } from '../src/skills/live-generations.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { KEEP_GENERATIONS } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const ev = (type: string, session?: string): CoreEvent => (session === undefined ? { type } : { type, session });

describe('LiveGenerations (the ledger)', () => {
  it('tracks a session from its first event, pins the current generation, and pins later publishes to it', () => {
    const live = new LiveGenerations();
    expect(live.observe(ev('sessionStarted'), 1)).toBe('ignored'); // no session → nothing to pin
    expect(live.observe(ev('sessionStarted', 'run-a'), 1)).toBe('pinned');
    expect(live.observe(ev('unitDistributed', 'run-a'), 1)).toBe('pinned');
    live.published(2);
    live.published(3);
    expect([...live.pinned()].sort()).toEqual([1, 2, 3]);
    expect(live.liveSessions()).toEqual(['run-a']);
  });

  it('a session first seen before any publish is tracked without a pin, and picks up the next publish', () => {
    const live = new LiveGenerations();
    expect(live.observe(ev('sessionStarted', 'run-a'), null)).toBe('pinned');
    expect([...live.pinned()]).toEqual([]);
    live.published(1);
    expect([...live.pinned()]).toEqual([1]);
  });

  it.each(['sessionCompleted', 'sessionFailed', 'runCancelled'])('%s releases every pin the session held', (terminal) => {
    const live = new LiveGenerations();
    live.observe(ev('sessionStarted', 'run-a'), 4);
    live.observe(ev('sessionStarted', 'run-b'), 4);
    live.published(5);
    expect(live.observe(ev(terminal, 'run-a'), 5)).toBe('released');
    expect(live.liveSessions()).toEqual(['run-b']);
    expect([...live.pinned()].sort()).toEqual([4, 5]); // run-b still holds both
    expect(live.observe(ev(terminal, 'run-a'), 5)).toBe('ignored'); // already released
    expect(live.observe(ev(terminal, 'run-b'), 5)).toBe('released');
    expect([...live.pinned()]).toEqual([]);
  });
});

describe('SkillsStore reaping honours live pins', () => {
  let s: Scaffold;

  beforeEach(() => {
    s = scaffold();
    s.store.seed();
  });

  afterEach(async () => {
    await s.store.pendingVenv;
    removeScratch(s.base);
  });

  const publishTimes = (n: number): void => {
    for (let i = 0; i < n; i += 1) {
      const r = s.store.publish(s.store.revision());
      expect(r.verdict).toBe('clear');
    }
  };

  it('a generation a live run started on survives the newest-three rule until the run ends, then is reaped', () => {
    publishTimes(1);
    s.store.observeEvent(ev('sessionStarted', 'run-a')); // pins gen 1
    publishTimes(KEEP_GENERATIONS + 2); // gens 2..6; 1 would be reaped without the pin
    expect(s.store.generationsOnDisk()).toEqual([1, 2, 3, 4, 5, 6]); // 2..5 pinned by `published`, 6 current
    s.store.observeEvent(ev('sessionCompleted', 'run-a'));
    expect(s.store.generationsOnDisk()).toEqual([4, 5, 6]);
  });

  it('only the generations a live run could have read are kept; unrelated older ones go at publish', () => {
    publishTimes(3); // gens 1..3, no live run
    s.store.observeEvent(ev('unitDistributed', 'run-c')); // pins 3
    publishTimes(3); // gens 4..6 — each pinned to run-c as it lands; 1 and 2 are reaped on the way
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5, 6]);
    s.store.observeEvent(ev('runCancelled', 'run-c'));
    expect(s.store.generationsOnDisk()).toEqual([4, 5, 6]);
  });

  it('a session ending before any publish reaps nothing and never throws', () => {
    s.store.observeEvent(ev('sessionStarted', 'run-z'));
    s.store.observeEvent(ev('sessionFailed', 'run-z'));
    expect(s.store.generationsOnDisk()).toEqual([]);
  });

  it('re-rooting forgets the memoized current generation (the next event reads the new root)', () => {
    publishTimes(2);
    const other = scaffold();
    try {
      other.store.seed();
      s.store.reroot(other.root);
      s.store.observeEvent(ev('sessionStarted', 'run-r')); // other root: nothing published → no pin
      expect([...s.store.live.pinned()]).toEqual([]);
    } finally {
      removeScratch(other.base);
    }
  });
});

describe('SkillsRuntime.observe delegates to the store', () => {
  let s: Scaffold;

  beforeEach(() => {
    s = scaffold();
    s.store.seed();
  });

  afterEach(async () => {
    await s.store.pendingVenv;
    removeScratch(s.base);
  });

  it('pins on a live-run event and reaps on the terminal frame', () => {
    const runtime = new SkillsRuntime({ store: s.store, mirrorHome: s.home, log: () => undefined });
    expect(s.store.publish(1).verdict).toBe('clear');
    runtime.observe(ev('sessionStarted', 'run-a'));
    for (let i = 0; i < KEEP_GENERATIONS + 1; i += 1) expect(s.store.publish(s.store.revision()).verdict).toBe('clear');
    expect(s.store.generationsOnDisk()).toEqual([1, 2, 3, 4, 5]);
    runtime.observe(ev('sessionCompleted', 'run-a'));
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5]);
  });
});
