// Generation reaping vs LIVE runs (design v3 §1: "old generations are reaped only after no live
// session references them"). The engine reports the generation it ADMITTED per spawn as a
// `skillsSnapshotHanded` CoreEvent ({session, gen}); crew pins that EXACT generation — never
// "current at event time" (codex round 3) — plus every generation published while the session
// stays live, plus a LAUNCH PIN recorded when crew hands `WICKED_SKILLS_SNAPSHOT` to bridge the
// spawn→event gap. The terminal frame releases the session's pins and reaps what nobody else holds.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CoreEvent } from '../src/core/types.js';
import { LiveGenerations } from '../src/skills/live-generations.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { KEEP_GENERATIONS } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const ev = (type: string, session?: string): CoreEvent => (session === undefined ? { type } : { type, session });
/** The engine's per-spawn report: the exact generation it handed `session` (a published snapshot). */
const handed = (session: string, gen: number): CoreEvent => ({ type: 'skillsSnapshotHanded', session, gen: String(gen) });

describe('LiveGenerations (the ledger)', () => {
  it('pins the EXACT generation the engine reports on skillsSnapshotHanded, never current-at-event', () => {
    const live = new LiveGenerations();
    expect(live.observe(handed('', 1))).toBe('ignored'); // no session → nothing to pin
    // A worker acquired generation 1; crew observes its skillsSnapshotHanded only after publishing
    // advanced current to 3. The pin is 1 (what the engine reports), NOT 3.
    expect(live.observe(ev('sessionStarted', 'run-a'))).toBe('pinned'); // tracked, nothing pinned yet
    expect([...live.pinned()]).toEqual([]);
    expect(live.observe(handed('run-a', 1))).toBe('pinned');
    expect([...live.pinned()]).toEqual([1]);
    live.published(2);
    live.published(3);
    expect([...live.pinned()].sort()).toEqual([1, 2, 3]); // + published-while-live
    expect(live.liveSessions()).toEqual(['run-a']);
  });

  it('a launch pin keeps the generation crew handed until an engine event confirms it, then is superseded', () => {
    const live = new LiveGenerations();
    live.launched(1); // crew exported WICKED_SKILLS_SNAPSHOT=gen 1 to launches
    expect([...live.pinned()]).toEqual([1]); // reaping keeps it through the spawn→event gap
    live.launched(2); // a publish advanced current; gen 1 is still within the window
    expect([...live.pinned()].sort()).toEqual([1, 2]);
    // The engine confirms run-a used gen 1 → it becomes a durable session pin; the launch pin is
    // consumed but the generation stays pinned (now until run-a's terminal frame).
    live.observe(ev('sessionStarted', 'run-a'));
    live.observe(handed('run-a', 1));
    expect([...live.pinned()].sort()).toEqual([1, 2]);
    live.observe(ev('sessionCompleted', 'run-a'));
    expect([...live.pinned()]).toEqual([2]); // only the still-open launch pin remains
  });

  it('launch pins are bounded to the recent window so the set cannot grow without limit', () => {
    const live = new LiveGenerations();
    for (let gen = 1; gen <= 10; gen += 1) live.launched(gen);
    // Only the newest window is retained (older launches have long since reported or ended).
    expect(Math.min(...live.pinned())).toBeGreaterThanOrEqual(10 - KEEP_GENERATIONS);
    expect(live.pinned().size).toBeLessThanOrEqual(KEEP_GENERATIONS + 1);
  });

  it.each(['sessionCompleted', 'sessionFailed', 'runCancelled'])('%s releases every pin the session held', (terminal) => {
    const live = new LiveGenerations();
    live.observe(handed('run-a', 4));
    live.observe(handed('run-b', 4));
    live.published(5);
    expect(live.observe(ev(terminal, 'run-a'))).toBe('released');
    expect(live.liveSessions()).toEqual(['run-b']);
    expect([...live.pinned()].sort()).toEqual([4, 5]); // run-b still holds both
    expect(live.observe(ev(terminal, 'run-a'))).toBe('ignored'); // already released
    expect(live.observe(ev(terminal, 'run-b'))).toBe('released');
    expect([...live.pinned()]).toEqual([]);
  });

  it('a live-cache handoff (gen: null) pins nothing — there is no reapable generation', () => {
    const live = new LiveGenerations();
    live.observe(ev('sessionStarted', 'run-a'));
    live.observe({ type: 'skillsSnapshotHanded', session: 'run-a', gen: null } as unknown as CoreEvent);
    expect([...live.pinned()]).toEqual([]);
  });
});

describe('SkillsStore reaping honours live pins', () => {
  let s: Scaffold;

  beforeEach(() => {
    s = scaffold();
    s.store.seed();
  });

  afterEach(() => {
    removeScratch(s.base);
  });

  const publishTimes = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      const r = await s.store.publish(s.store.revision());
      expect(r.verdict).toBe('clear');
    }
  };

  it('the generation the engine reports for a live run survives the newest-three rule until the run ends, then is reaped', async () => {
    await publishTimes(1);
    s.store.observeEvent(handed('run-a', 1)); // the engine handed run-a generation 1
    await publishTimes(KEEP_GENERATIONS + 2); // gens 2..6; 1 would be reaped without the pin
    expect(s.store.generationsOnDisk()).toEqual([1, 2, 3, 4, 5, 6]); // 2..5 pinned by `published`, 6 current
    s.store.observeEvent(ev('sessionCompleted', 'run-a'));
    expect(s.store.generationsOnDisk()).toEqual([4, 5, 6]);
  });

  it('launch at gen 1 → publish gen 2 → first event arrives ⇒ gen 1 stays pinned and unreaped (codex round 3)', async () => {
    await publishTimes(1); // gen 1, current=1
    s.store.live.launched(1); // crew handed WICKED_SKILLS_SNAPSHOT=gen 1 to a launch
    await publishTimes(1); // gen 2, current=2 — the worker acquired 1 before this
    s.store.observeEvent(ev('sessionStarted', 'run-a')); // first event, current already 2
    // The launch pin holds gen 1 even though the first event pinned nothing and current advanced.
    expect(s.store.generationsOnDisk()).toEqual([1, 2]);
    expect([...s.store.live.pinned()]).toContain(1);
    // The engine's report makes it a durable session pin; it stays past newest-three until terminal.
    s.store.observeEvent(handed('run-a', 1));
    await publishTimes(KEEP_GENERATIONS); // gens 3,4,5 — gen 1 out of newest-three
    expect(s.store.generationsOnDisk()).toContain(1);
    s.store.observeEvent(ev('sessionCompleted', 'run-a'));
    expect(s.store.generationsOnDisk()).not.toContain(1);
  });

  it('only the generations a live run could have read are kept; unrelated older ones go at publish', async () => {
    await publishTimes(3); // gens 1..3, no live run
    s.store.observeEvent(handed('run-c', 3)); // the engine handed run-c generation 3
    await publishTimes(3); // gens 4..6 — each pinned to run-c as it lands; 1 and 2 are reaped on the way
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5, 6]);
    s.store.observeEvent(ev('runCancelled', 'run-c'));
    expect(s.store.generationsOnDisk()).toEqual([4, 5, 6]);
  });

  it('a session ending before any handoff reaps nothing and never throws', () => {
    s.store.observeEvent(ev('sessionStarted', 'run-z'));
    s.store.observeEvent(ev('sessionFailed', 'run-z'));
    expect(s.store.generationsOnDisk()).toEqual([]);
  });

  it('re-rooting does not carry pins across roots (the next event reads the new root)', async () => {
    await publishTimes(2);
    const other = scaffold();
    try {
      other.store.seed();
      s.store.reroot(other.root);
      s.store.observeEvent(ev('sessionStarted', 'run-r')); // other root: nothing handed → no pin
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

  afterEach(() => {
    removeScratch(s.base);
  });

  it('pins on the engine handoff and reaps on the terminal frame', async () => {
    const runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    expect((await s.store.publish(1)).verdict).toBe('clear');
    runtime.observe(handed('run-a', 1));
    for (let i = 0; i < KEEP_GENERATIONS + 1; i += 1) expect((await s.store.publish(s.store.revision())).verdict).toBe('clear');
    expect(s.store.generationsOnDisk()).toEqual([1, 2, 3, 4, 5]);
    runtime.observe(ev('sessionCompleted', 'run-a'));
    expect(s.store.generationsOnDisk()).toEqual([3, 4, 5]);
  });
});
