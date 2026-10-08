// crew#874: `/diagnostics.skills.findings` said nothing while the installed wicked-garden was ahead of
// the published generation, so every governed run executed the older garden (the rig ran 12.39
// skills with 12.44 installed). The runtime now raises `skills.installed-ahead` and, at boot, refreshes
// and publishes on its own when the catalog holds no operator change.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SkillsRuntime, SKILLS_AUTO_REFRESH_ENV } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const scratch: Scaffold[] = [];
afterEach(() => {
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
  const runtime = new SkillsRuntime({ store: sc.store, log: (m) => logs.push(m), bootSnapshot: undefined, installedTtlMs: 0 });
  const health = await runtime.apply();
  expect(health.state).toBe('published');
  return { sc, runtime, logs };
}

const aheadOf = (runtime: SkillsRuntime) => runtime.health().findings.find((f) => f.kind === 'skills.installed-ahead');

describe('skills.installed-ahead (crew#874)', () => {
  it('is silent while the installed plugin is the baseline the generation was built from', async () => {
    const { runtime } = await booted();
    expect(aheadOf(runtime)).toBeUndefined();
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'none' });
  });

  it('names both versions and the remedy once the installed garden moves ahead', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    const finding = aheadOf(runtime);
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
    expect(aheadOf(runtime)).toBeUndefined();
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
    expect(aheadOf(runtime)?.message).toContain('not refreshed automatically: the catalog holds operator changes (skill wicked-garden-gamma is override)');
  });

  it('a refresh with no publish moves the catalog, not the handed generation: the finding stays (codex r1)', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    const refreshed = sc.store.refreshBaseline(sc.store.revision());
    expect(refreshed.verdict).not.toBe('blocked');
    expect(sc.store.manifest().baseline).toBe(refreshed.baseline);
    expect(aheadOf(runtime)?.message).toContain('installed wicked-garden 1.1.0 is ahead of the published generation 1 (built from 1.0.0)');
    // …and the boot path still finishes the job: the refresh is a no-op, the publish lands.
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'published', gen: 2 });
    expect(aheadOf(runtime)).toBeUndefined();
  });

  it(`${SKILLS_AUTO_REFRESH_ENV}=0 turns the boot refresh off`, async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({ [SKILLS_AUTO_REFRESH_ENV]: '0' })).toMatchObject({ action: 'skipped' });
    expect(runtime.health().current?.gen).toBe(1);
    expect(aheadOf(runtime)?.message).toContain(`${SKILLS_AUTO_REFRESH_ENV}=0`);
  });

  it('an installed garden OLDER than the baseline is called behind, never ahead', async () => {
    const { sc, runtime } = await booted();
    upgrade(sc, '0.9.0');
    expect(aheadOf(runtime)?.message).toContain('installed wicked-garden 0.9.0 is behind the published generation');
  });
});
