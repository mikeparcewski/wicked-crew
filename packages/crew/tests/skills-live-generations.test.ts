// Generation reaping vs LIVE runs (design v3 §1: "old generations are reaped only after no live
// session references them"). The engine reports the generation it ADMITTED per spawn as a
// `skillsSnapshotHanded` CoreEvent ({session, gen}); crew pins that EXACT generation — never
// "current at event time" (codex round 3) — plus every generation published while the session
// stays live. The spawn→report gap is covered by a LAUNCH PIN the daemon opens when it hands a
// launch to the engine (`CoreAdapter.onLaunch` → `SkillsRuntime.launched`), released ONLY by the
// engine's report for that session, the run's / campaign's terminal frame, or the engine rejecting
// the launch — never by publish count (codex round 4). The terminal frame releases the session's
// pins and reaps what nobody else holds.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CoreAdapter, type LaunchNotice } from '../src/core/adapter.js';
import type { CoreEvent } from '../src/core/types.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { LiveGenerations } from '../src/skills/live-generations.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { KEEP_GENERATIONS } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const ev = (type: string, session?: string): CoreEvent => (session === undefined ? { type } : { type, session });
/** The engine's per-spawn report: the exact generation it handed `session` (a published snapshot). */
const handed = (session: string, gen: number): CoreEvent => ({ type: 'skillsSnapshotHanded', session, gen: String(gen) });
const campaignFrame = (type: string, campaign: string, extra: Record<string, unknown> = {}): CoreEvent =>
  ({ type, campaign, ...extra }) as unknown as CoreEvent;
const sorted = (set: ReadonlySet<number>): number[] => [...set].sort((a, b) => a - b);

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
    expect(sorted(live.pinned())).toEqual([1, 2, 3]); // + published-while-live
    expect(live.liveSessions()).toEqual(['run-a']);
  });

  it('a launch pin holds the handed generation until the ENGINE accounts for it — FIVE publishes before the handoff report leave gen 1 pinned (codex round 4)', () => {
    const live = new LiveGenerations();
    live.exported(1); // the env hands gen 1 to launches
    live.launched('run', 'run-a'); // the daemon handed run-a to the engine
    expect([...live.pinned()]).toEqual([1]);
    for (let gen = 2; gen <= 6; gen += 1) {
      live.published(gen);
      live.exported(gen);
    }
    // No publish count releases the launch: gen 1 AND every generation the launch's spawn could
    // have read since are pinned until the engine says which one it used.
    expect(live.pinned().has(1)).toBe(true);
    expect(sorted(live.pinned())).toEqual([1, 2, 3, 4, 5, 6]);
    expect(live.openLaunches()).toEqual(['run:run-a']);
    // The engine reports run-a used gen 1 → the launch pin is consumed; the session pin (1) takes
    // over and lives until run-a's terminal frame.
    expect(live.observe(handed('run-a', 1))).toBe('pinned');
    expect(live.openLaunches()).toEqual([]);
    expect([...live.pinned()]).toEqual([1]);
    expect(live.observe(ev('sessionCompleted', 'run-a'))).toBe('released');
    expect([...live.pinned()]).toEqual([]);
  });

  it('a launch pin is released by the terminal frame without a report, by the engine REJECTING the launch, and by a live-cache report (gen: null)', () => {
    const live = new LiveGenerations();
    live.exported(3);
    live.launched('run', 'run-a');
    live.launched('run', 'run-b');
    live.launched('run', 'run-c');
    expect([...live.pinned()]).toEqual([3]);
    expect(live.openLaunches()).toEqual(['run:run-a', 'run:run-b', 'run:run-c']);
    expect(live.observe(ev('sessionFailed', 'run-a'))).toBe('released'); // ended before any spawn reported
    live.launchRejected('run', 'run-b'); // the engine refused the launch — nothing will read it
    live.observe({ type: 'skillsSnapshotHanded', session: 'run-c', gen: null } as unknown as CoreEvent); // fallback: read no generation
    expect(live.openLaunches()).toEqual([]);
    expect([...live.pinned()]).toEqual([]);
    // run-c is still a LIVE session (its report created the session pin, empty so far): a publish
    // would be pinned to it until its terminal frame — end it so the next probe stands alone.
    expect(live.observe(ev('sessionCompleted', 'run-c'))).toBe('released');
    // A launch opened while NOTHING is exported (fallback / unpublished) pins nothing yet — but a
    // publish before its report is pinned for it (its spawn may read the new current).
    live.exported(null);
    live.launched('run', 'run-d');
    expect([...live.pinned()]).toEqual([]);
    live.published(4);
    expect([...live.pinned()]).toEqual([4]);
    live.observe(ev('runCancelled', 'run-d'));
    expect([...live.pinned()]).toEqual([]);
  });

  it("a campaign's pin covers its engine-launched node runs until the campaign's terminal frame; a node the engine announces gets its own pin", () => {
    const live = new LiveGenerations();
    live.exported(1);
    live.launched('campaign', 'camp-1');
    live.published(2);
    live.exported(2);
    expect(live.observe(campaignFrame('campaignNodeStarted', 'camp-1', { node: 'n1', runId: 'camp-1:n1:a0' }))).toBe('pinned');
    expect(live.openLaunches()).toEqual(['campaign:camp-1', 'run:camp-1:n1:a0']);
    expect(sorted(live.pinned())).toEqual([1, 2]);
    live.observe(handed('camp-1:n1:a0', 2));
    expect(live.observe(ev('sessionCompleted', 'camp-1:n1:a0'))).toBe('released');
    expect(sorted(live.pinned())).toEqual([1, 2]); // the campaign may still launch nodes reading either
    expect(live.observe(campaignFrame('campaignPaused', 'camp-1'))).toBe('ignored');
    expect(live.observe(campaignFrame('campaignCompleted', 'camp-1'))).toBe('released');
    expect(live.openLaunches()).toEqual([]);
    expect([...live.pinned()]).toEqual([]);
  });

  it.each(['sessionCompleted', 'sessionFailed', 'runCancelled'])('%s releases every pin the session held', (terminal) => {
    const live = new LiveGenerations();
    live.observe(handed('run-a', 4));
    live.observe(handed('run-b', 4));
    live.published(5);
    expect(live.observe(ev(terminal, 'run-a'))).toBe('released');
    expect(live.liveSessions()).toEqual(['run-b']);
    expect(sorted(live.pinned())).toEqual([4, 5]); // run-b still holds both
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
    s.store.live.exported(1);
    s.store.live.launched('run', 'run-a'); // the daemon handed run-a to the engine while the env exported gen 1
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

  it('launch at gen 1 → FIVE publishes before the handoff report ⇒ gen 1 is retained on disk; released only by the report + terminal (codex round 4)', async () => {
    await publishTimes(1); // gen 1
    s.store.live.exported(1);
    s.store.live.launched('run', 'run-a');
    await publishTimes(5); // gens 2..6 — a publish-count window would have dropped the launch pin here
    expect(s.store.generationsOnDisk()).toContain(1);
    expect(s.store.live.openLaunches()).toEqual(['run:run-a']);
    s.store.observeEvent(handed('run-a', 1)); // the outstanding report finally arrives
    await publishTimes(1); // gen 7 — the session pin now holds 1 (and 7)
    expect(s.store.generationsOnDisk()).toContain(1);
    expect(s.store.live.openLaunches()).toEqual([]);
    s.store.observeEvent(ev('sessionCompleted', 'run-a'));
    expect(s.store.generationsOnDisk()).toEqual([5, 6, 7]);
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

  it('pins belong to ONE store over ONE root: a store over another root starts with none (the root is never re-aimed — codex round 5)', async () => {
    await publishTimes(2);
    s.store.observeEvent(handed('run-r', 2));
    expect([...s.store.live.pinned()]).toEqual([2]);
    const other = scaffold();
    try {
      other.store.seed();
      other.store.observeEvent(ev('sessionStarted', 'run-r')); // other root: nothing handed → no pin
      expect([...other.store.live.pinned()]).toEqual([]);
      expect([...s.store.live.pinned()]).toEqual([2]); // …and the first store's ledger is untouched
    } finally {
      removeScratch(other.base);
    }
  });
});

describe('SkillsRuntime delegates to the store', () => {
  let s: Scaffold;
  const savedEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

  beforeEach(() => {
    s = scaffold();
    s.store.seed();
  });

  afterEach(() => {
    removeScratch(s.base);
    // `afterPublish` exports the engine input; leave the process as it was.
    if (savedEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
    else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedEnv;
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

  it('afterPublish exports the verified generation for launch pins; a launch notice opens the pin, a rejection releases it', async () => {
    const runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    expect((await s.store.publish(1)).verdict).toBe('clear');
    expect(runtime.afterPublish()?.current?.gen).toBe(1);
    runtime.launched({ kind: 'run', id: 'run-a', status: 'handed' });
    runtime.launched({ kind: 'campaign', id: 'camp-1', status: 'handed' });
    expect(s.store.live.openLaunches()).toEqual(['campaign:camp-1', 'run:run-a']);
    expect([...s.store.live.pinned()]).toEqual([1]);
    runtime.launched({ kind: 'run', id: 'run-a', status: 'rejected' });
    expect(s.store.live.openLaunches()).toEqual(['campaign:camp-1']);
    for (let i = 0; i < KEEP_GENERATIONS + 2; i += 1) expect((await s.store.publish(s.store.revision())).verdict).toBe('clear');
    expect(s.store.generationsOnDisk()).toContain(1); // the campaign's launch pin holds it
    runtime.observe(campaignFrame('campaignCancelled', 'camp-1'));
    expect(s.store.generationsOnDisk()).not.toContain(1);
  });
});

describe('CoreAdapter.onLaunch — every launch the daemon hands the engine is announced BEFORE the engine call', () => {
  const SEATS = JSON.stringify([{ key: 'alpha', display_name: 'Alpha', binary: 'alpha', headless_invocation: 'alpha {PROMPT}' }]);
  let adapter: CoreAdapter;
  let dir: string;
  let priorOverlayDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-launch-'));
    priorOverlayDir = process.env['WICKED_WORKFLOWS_DIR'];
    process.env['WICKED_WORKFLOWS_DIR'] = join(dir, 'workflows'); // never the developer's real overlay dir
    adapter = new CoreAdapter({ dbPath: join(dir, 'launch.db'), stub: true });
  });

  afterEach(() => {
    adapter.close();
    if (priorOverlayDir === undefined) delete process.env['WICKED_WORKFLOWS_DIR'];
    else process.env['WICKED_WORKFLOWS_DIR'] = priorOverlayDir;
    removeScratch(dir);
  });

  it('launchRun / resumeRun / confirmGate announce `handed` for the session (ahead of the engine call, by construction); a rejected call is followed by `rejected`; unsubscribe stops the notices', async () => {
    const notices: LaunchNotice[] = [];
    const off = adapter.onLaunch((n) => notices.push(n));
    // The stub run's own outcome is not what this measures — only that the launch was announced.
    await adapter.launchRun({ problem: 'probe launch pin', sessionId: 's-launch', clisJson: SEATS }).catch(() => undefined);
    expect(notices[0]).toEqual({ kind: 'run', id: 's-launch', status: 'handed' });
    // An unknown run: the engine answers however it answers — the notices are `handed` first and,
    // when the call rejected, `rejected` after (the pin opened for it is released).
    const outcome = await adapter.confirmGate('no-such-run', true).then(
      () => 'resolved',
      () => 'rejected',
    );
    const gate = notices.filter((n) => n.id === 'no-such-run').map((n) => n.status);
    expect(gate).toEqual(outcome === 'rejected' ? ['handed', 'rejected'] : ['handed']);
    await adapter.resumeRun('s-launch').catch(() => undefined);
    expect(notices.filter((n) => n.id === 's-launch' && n.status === 'handed')).toHaveLength(2);
    off();
    await adapter.confirmGate('no-such-run-2', false).catch(() => undefined);
    expect(notices.some((n) => n.id === 'no-such-run-2')).toBe(false);
  });
});
