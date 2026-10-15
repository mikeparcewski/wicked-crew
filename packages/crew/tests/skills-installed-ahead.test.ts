// crew#874: `/diagnostics.skills.findings` said nothing while the installed wicked-garden was ahead of
// the published generation, so every governed run executed the older garden (the rig ran 12.39
// skills with 12.44 installed). The runtime now raises `skills.installed-ahead` and, at boot, refreshes
// and publishes on its own when the catalog holds no operator change.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillsRuntime, SKILLS_AUTO_REFRESH_ENV } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const scratch: Scaffold[] = [];
afterEach(async () => {
  // Let already scheduled constructor/health probes enter their async store seam.
  await new Promise<void>((resolve) => setImmediate(resolve));
  // crew#1021: a bounded wait can time out while a real fixture read is still running.
  // Settle the underlying reads before restoring spies or removing their temp trees.
  await Promise.all(scratch.flatMap((sc) => vi.mocked(sc.store.installedStateAsync).mock.results
    .filter((result) => result.type === 'return').map((result) => result.value)));
  vi.restoreAllMocks();
  for (const sc of scratch.splice(0)) removeScratch(sc.base);
});

/** Upgrade the scaffold's "installed" plugin: a new version and new bytes in a shipped skill. */
function upgrade(sc: Scaffold, version: string): void {
  const manifest = join(sc.upstream, '.claude-plugin', 'plugin.json');
  const json = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  writeFileSync(manifest, JSON.stringify({ ...json, version }, null, 2));
  const skill = join(sc.upstream, 'skills', 'alpha', 'refs', 'notes.md');
  writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nupstream ${version}\n`);
}

async function booted(): Promise<{ sc: Scaffold; runtime: SkillsRuntime; logs: string[] }> {
  const sc = scaffold();
  scratch.push(sc);
  const logs: string[] = [];
  const probe = vi.spyOn(sc.store, 'installedStateAsync');
  const runtime = new SkillsRuntime({ store: sc.store, log: (m) => logs.push(m), bootSnapshot: undefined, installedTtlMs: 0 });
  const health = await runtime.apply();
  // Await the constructor's background probe itself, without starting another boot probe.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(probe.mock.results.filter((result) => result.type === 'return').map((result) => result.value));
  expect(health.state).toBe('published');
  return { sc, runtime, logs };
}

const aheadOf = async (runtime: SkillsRuntime) => {
  await runtime.refreshInstalled();
  return runtime.health().findings.find((f) => f.kind === 'skills.installed-ahead');
};

describe('skills.installed-ahead (crew#874)', () => {
  it('is silent while the installed plugin is the baseline the generation was built from', async () => {
    const { runtime } = await booted();
    expect(await aheadOf(runtime)).toBeUndefined();
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'none' });
  });

  it('names both versions and the remedy once the installed garden moves ahead', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    const finding = await aheadOf(runtime);
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('installed wicked-garden 1.1.0 is ahead of the published generation 1 (built from 1.0.0)');
    expect(finding?.message).toContain('POST /skills/refresh-baseline then /skills/publish');
    expect(runtime.installedAheadFinding()?.message).toBe(finding?.message);
  });

  it('boot auto-refresh publishes the upgrade when nothing is user-edited, and the finding clears', async () => {
    const { sc, runtime, logs } = await booted();
    upgrade(sc, '1.1.0');
    const outcome = await runtime.autoRefreshOnBoot({});
    expect(outcome).toEqual({ action: 'published', gen: 2, from: '1.0.0', to: '1.1.0' });
    expect(runtime.health().current?.gen).toBe(2);
    expect(await aheadOf(runtime)).toBeUndefined();
    expect(logs.some((l) => l.includes('skills.auto-refresh'))).toBe(true);
  });

  it('a user-edited catalog is NOT refreshed on its own; the finding says why', async () => {
    const { sc, runtime } = await booted();
    const w = sc.store.writeFile('wicked-garden-gamma', 'refs/mine.md', '# operator note\n', sc.store.revision());
    expect(w.verdict).not.toBe('blocked');
    upgrade(sc, '1.1.0');
    const outcome = await runtime.autoRefreshOnBoot({});
    expect(outcome.action).toBe('skipped');
    expect(runtime.health().current?.gen).toBe(1);
    expect((await aheadOf(runtime))?.message).toContain('not refreshed automatically: the catalog holds operator changes (skill wicked-garden-gamma is override)');
  });

  it('a refresh with no publish moves the catalog, not the handed generation: the finding stays (codex r1)', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    const refreshed = sc.store.refreshBaseline(sc.store.revision());
    expect(refreshed.verdict).not.toBe('blocked');
    expect(sc.store.manifest().baseline).toBe(refreshed.baseline);
    expect((await aheadOf(runtime))?.message).toContain('installed wicked-garden 1.1.0 is ahead of the published generation 1 (built from 1.0.0)');
    // …and the boot path still finishes the job: the refresh is a no-op, the publish lands.
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'published', gen: 2 });
    expect(await aheadOf(runtime)).toBeUndefined();
  });

  it(`${SKILLS_AUTO_REFRESH_ENV}=0 turns the boot refresh off`, async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({ [SKILLS_AUTO_REFRESH_ENV]: '0' })).toMatchObject({ action: 'skipped' });
    expect(runtime.health().current?.gen).toBe(1);
    expect((await aheadOf(runtime))?.message).toContain(`${SKILLS_AUTO_REFRESH_ENV}=0`);
  });

  it('an installed garden OLDER than the baseline is called behind, never ahead', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '0.9.0');
    expect((await aheadOf(runtime))?.message).toContain('installed wicked-garden 0.9.0 is behind the published generation');
  });
});

// crew#1021: health and diagnostics read the last probe, never a synchronous bundle hash/git.
describe('installed probe request isolation (crew#1021)', () => {
  it('uses one unref deadline for the old probe and the fresh probe', async () => {
    const sc = scaffold();
    scratch.push(sc);
    const old = sc.store.installedState();
    const completions: Array<(state: typeof old) => void> = [];
    const probe = vi.spyOn(sc.store, 'installedStateAsync').mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const runtime = new SkillsRuntime({ store: sc.store, log: () => {}, bootSnapshot: undefined });
    try {
      await vi.advanceTimersByTimeAsync(1);
      let answered = false;
      const fresh = runtime.refreshInstalled({ fresh: true }).then((value) => { answered = true; return value; });
      expect((timers.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      completions[0]!(old);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(998);
      expect(answered).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await fresh).toEqual(old);
    } finally {
      for (const finish of completions) finish(old);
      probe.mockResolvedValue(old);
      await Promise.all(probe.mock.results.filter((result) => result.type === 'return').map((result) => result.value));
      timers.mockRestore();
      vi.useRealTimers();
    }
  });

  it('fresh:true waits for the pre-call background probe, then reads the upgraded install', async () => {
    const { sc, runtime } = await booted();
    const old = sc.store.installedState();
    let finish!: (state: typeof old) => void;
    const probe = vi.spyOn(sc.store, 'installedStateAsync')
      .mockClear()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    runtime.installed(); // TTL 0: begin a background probe before the upgrade/fresh call.
    await new Promise<void>((resolve) => setImmediate(resolve));
    upgrade(sc, '1.1.0');
    probe.mockResolvedValue(sc.store.installedState());
    const fresh = runtime.installedAheadFinding({ fresh: true });
    finish(old);
    expect((await fresh)?.message).toContain('1.1.0 is ahead of');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('never invokes synchronous installedState from installedAheadFinding or health', async () => {
    const { sc, runtime } = await booted();
    const sync = vi.spyOn(sc.store, 'installedState').mockImplementation(() => { throw new Error('request blocked'); });
    expect(runtime.installedAheadFinding()).toBeNull();
    runtime.health();
    expect(sync).not.toHaveBeenCalled();
  });

  it('starts silently and updates the finding when the background async probe lands', async () => {
    const sc = scaffold();
    scratch.push(sc);
    let finish!: (state: ReturnType<typeof sc.store.installedState>) => void;
    const pending = new Promise<ReturnType<typeof sc.store.installedState>>((resolve) => { finish = resolve; });
    vi.spyOn(sc.store, 'installedStateAsync').mockReturnValue(pending);
    const sync = vi.spyOn(sc.store, 'installedState');
    const runtime = new SkillsRuntime({ store: sc.store, log: () => {}, bootSnapshot: undefined });
    expect((await runtime.apply()).state).toBe('published');
    expect(runtime.installedAheadFinding()).toBeNull();
    expect(runtime.installed()).toBeNull();
    expect(sync).not.toHaveBeenCalled();
    upgrade(sc, '1.1.0');
    finish(sc.store.installedState());
    await runtime.refreshInstalled();
    expect(runtime.installedAheadFinding()?.message).toContain('1.1.0 is ahead of');
  });

  it('fresh:true waits for a successful async refresh and returns its new finding', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    const finding = await runtime.installedAheadFinding({ fresh: true });
    expect(finding?.message).toContain('1.1.0 is ahead of');
  });

  it('fresh:true retains the launch generation warning when a publish catches up during the probe', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    const installed = sc.store.installedState();
    let finish!: (state: typeof installed) => void;
    vi.spyOn(sc.store, 'installedStateAsync').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const finding = runtime.installedAheadFinding({ fresh: true });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const refreshed = sc.store.refreshBaseline(sc.store.revision());
      expect(refreshed.verdict).not.toBe('blocked');
      const published = await sc.store.publish(refreshed.revision);
      expect(published.snapshot?.gen).toBe(2);
      runtime.afterPublish();
      expect(runtime.health().current?.gen).toBe(2);
      finish(installed);
      expect((await finding)?.message).toContain('1.1.0 is ahead of the published generation 1 (built from 1.0.0)');
      expect(runtime.installedAheadFinding()).toBeNull(); // later callers use generation 2
    } finally {
      finish?.(installed);
      await finding;
    }
  });

  it('fresh:true awaits a bounded, coalesced refresh and falls back to the last value', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    await runtime.refreshInstalled();
    let finish!: (value: null) => void;
    const asyncProbe = vi.spyOn(sc.store, 'installedStateAsync').mockClear().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.useFakeTimers();
    try {
      let answered = false;
      const finding = runtime.installedAheadFinding({ fresh: true }).then((value) => { answered = true; return value; });
      await vi.advanceTimersByTimeAsync(1);
      expect(asyncProbe).toHaveBeenCalledTimes(1);
      expect(answered).toBe(false);
      const second = runtime.installedAheadFinding({ fresh: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await finding)?.message).toContain('1.1.0 is ahead of');
      expect((await second)?.message).toContain('1.1.0 is ahead of');
      expect(asyncProbe).toHaveBeenCalledTimes(1);
      finish(null);
      await vi.advanceTimersByTimeAsync(1);
      expect(asyncProbe).toHaveBeenCalledTimes(1); // expired callers must not start a follow-up probe
    } finally {
      finish?.(null);
      asyncProbe.mockResolvedValue(null);
      vi.useRealTimers();
    }
  });
});
