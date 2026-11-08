// crew#1447: a user who upgrades crew alone keeps the skills generation an older crew published (garden
// 12.65.1 under a 12.66.1 floor, upgrade-1108). The boot ladder only re-verified that generation, so the
// scripts this crew calls from the floor's garden were missing and nothing said so: no finding, no hold.
// The runtime now judges the PUBLISHED generation's garden against the floor: below it is the blocking
// `skills.garden` finding (launch and onboarding answer 422 garden_required, /health and the Nerve Center
// say it with the command), a newer garden the boot refresh can publish clears it, and one it could not
// publish is named with the reason.
process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { GARDEN_FLOOR_REMEDY, GARDEN_PUBLISH_REMEDY, skillsRow } from '../src/api/system-snapshot.js';
import { GARDEN_UPDATE_COMMAND, REQUIRED_GARDEN_VERSION } from '../src/skills/plugin-source.js';
import { refusalPath, SkillsRuntime } from '../src/skills/runtime.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

const scratch: Scaffold[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
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

/** A root an OLDER crew published from garden 1.0.0 (the fixture), booted by a crew whose floor is `floor`. */
async function booted(floor: string | null | undefined): Promise<{ sc: Scaffold; runtime: SkillsRuntime; logs: string[] }> {
  const sc = scaffold();
  scratch.push(sc);
  const logs: string[] = [];
  const probe = vi.spyOn(sc.store, 'installedStateAsync');
  const runtime = new SkillsRuntime({
    store: sc.store,
    log: (m) => logs.push(m),
    bootSnapshot: undefined,
    installedTtlMs: 0,
    ...(floor === undefined ? {} : { gardenFloor: floor }),
  });
  const health = await runtime.apply();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all(probe.mock.results.filter((result) => result.type === 'return').map((result) => result.value));
  expect(health.state).toBe('published');
  return { sc, runtime, logs };
}

const floorFinding = async (runtime: SkillsRuntime) => {
  await runtime.refreshInstalled();
  return runtime.health().findings.find((f) => f.kind === 'skills.garden');
};

describe('crew#1447: the published generation is judged against the garden floor at boot', () => {
  it('a generation from a garden below the floor, nothing newer installed: a blocking skills.garden finding with the update command', async () => {
    const { runtime } = await booted('1.1.0');
    const finding = await floorFinding(runtime);
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('the published skills (generation 1) come from wicked-garden 1.0.0, older than the required 1.1.0');
    expect(finding?.message).toContain('launches and onboarding are held');
    expect(finding?.message).toContain(`\`${GARDEN_UPDATE_COMMAND}\``);
    expect(finding?.message).toContain('npx wicked-installer install wicked-garden');
    expect(finding?.message).toContain('restart `wicked-crew serve`');
    // The generation stays published and reported: the hold is the finding, not a lost catalog.
    expect(runtime.health().state).toBe('published');
    expect(runtime.health().current?.gen).toBe(1);
  });

  /** A root an older crew published, booted through the daemon's background ladder. */
  async function ladder(floor: string): Promise<{ sc: Scaffold; runtime: SkillsRuntime; logs: string[] }> {
    const sc = scaffold();
    scratch.push(sc);
    vi.spyOn(sc.store, 'installedStateAsync');
    await sc.store.ensureReady();
    const logs: string[] = [];
    const runtime = new SkillsRuntime({ store: sc.store, log: (m) => logs.push(m), bootSnapshot: undefined, installedTtlMs: 0, gardenFloor: floor });
    return { sc, runtime, logs };
  }

  it('when the boot ladder lands it holds the engine input at the skills.garden refusal and says it once in the log', async () => {
    const { sc, runtime, logs } = await ladder('1.1.0');
    await runtime.startBoot();
    const refusal = refusalPath(sc.store.root, 'skills.garden');
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe(refusal);
    expect(runtime.health()).toMatchObject({ state: 'published', current: { gen: 1 }, engineInput: refusal });
    expect(logs.filter((l) => l.startsWith('[skills] skills.garden: the published skills (generation 1) come from wicked-garden 1.0.0'))).toHaveLength(1);
    // Nothing reports the held generation as handed: the skill predicates answer no (codex r2).
    expect(runtime.holdsSkill('wicked-garden-gamma')).toBe(false);
    expect(runtime.exportedHolds('wicked-garden-gamma')).toBe(false);
  });

  it('while held, the base skill is judged against nothing handed, and a qualifying publish hands it again', async () => {
    const { sc, runtime } = await ladder('1.1.0');
    runtime.configureBaseSkill({ baseSkillRef: 'wicked-garden-gamma' });
    await runtime.startBoot();
    expect(runtime.baseSkill()?.present).toBe(false);
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'published', gen: 2 });
    expect(runtime.baseSkill()?.present).toBe(true);
    expect(runtime.holdsSkill('wicked-garden-gamma')).toBe(true);
  });

  it('says nothing while the ladder runs: the auto-refresh may still publish an installed garden', async () => {
    const { runtime } = await ladder('1.1.0');
    let during: string[] | null = null;
    vi.spyOn(runtime, 'autoRefreshOnBoot').mockImplementation(async () => {
      during = runtime.health().findings.map((f) => f.kind);
      return { action: 'none', reason: 'held open by the test' };
    });
    await runtime.startBoot();
    expect(during).not.toBeNull();
    expect(during).not.toContain('skills.garden');
    expect(runtime.health().findings.map((f) => f.kind)).toContain('skills.garden');
  });

  it('a later publish from a garden that meets the floor releases the hold', async () => {
    const { sc, runtime } = await ladder('1.1.0');
    await runtime.startBoot();
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'published', gen: 2 });
    expect(runtime.health().current?.gen).toBe(2);
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe(runtime.health().current?.path);
    expect(await floorFinding(runtime)).toBeUndefined();
  });

  it('a later publish still below the floor stays held', async () => {
    const { sc, runtime } = await ladder('1.2.0');
    await runtime.startBoot();
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({})).toMatchObject({ action: 'published', gen: 2 });
    expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe(refusalPath(sc.store.root, 'skills.garden'));
    expect((await floorFinding(runtime))?.message).toContain('generation 2) come from wicked-garden 1.1.0, older than the required 1.2.0');
  });

  it('a store double without discoversLive (a partial test store) is not judged and does not throw', () => {
    const store = { currentSnapshotSkills: () => null, installedStateAsync: async () => null } as unknown as ConstructorParameters<typeof SkillsRuntime>[0]['store'];
    expect(() => new SkillsRuntime({ store, log: () => {}, bootSnapshot: undefined })).not.toThrow();
  });

  it('a newer garden that meets the floor is installed: the boot refresh publishes it and the finding clears', async () => {
    const { sc, runtime } = await booted('1.1.0');
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({})).toEqual({ action: 'published', gen: 2, from: '1.0.0', to: '1.1.0' });
    expect(runtime.health().current?.gen).toBe(2);
    expect(await floorFinding(runtime)).toBeUndefined();
  });

  it('a newer garden is installed but the boot refresh could not publish it: the finding names it, the reason and the publish steps', async () => {
    const { sc, runtime } = await booted('1.1.0');
    const w = sc.store.writeFile('wicked-garden-gamma', 'refs/mine.md', '# operator note\n', sc.store.revision());
    expect(w.verdict).not.toBe('blocked');
    upgrade(sc, '1.1.0');
    expect((await runtime.autoRefreshOnBoot({})).action).toBe('skipped');
    const message = (await floorFinding(runtime))?.message ?? '';
    expect(message).toContain('wicked-garden 1.1.0 is installed but was not published (the catalog holds operator changes');
    expect(message).toContain('POST /skills/refresh-baseline (resolve any conflict it reports) then POST /skills/publish');
    expect(message).not.toContain(GARDEN_UPDATE_COMMAND);
    // A restart meets the same skip: it is not offered.
    expect(message).not.toContain('restart');
    // The installed-ahead warning ("runs use the published generation") would contradict the hold.
    expect(runtime.health().findings.map((f) => f.kind)).not.toContain('skills.installed-ahead');
    const row = skillsRow(runtime.health() as unknown as Parameters<typeof skillsRow>[0]);
    expect(row.remedy).toBe(GARDEN_PUBLISH_REMEDY);
  });

  it('a newer garden still below the floor is not offered as the fix', async () => {
    const { sc, runtime } = await booted('1.2.0');
    upgrade(sc, '1.1.0');
    expect(await runtime.autoRefreshOnBoot({ WICKED_CREW_SKILLS_AUTO_REFRESH: '0' })).toMatchObject({ action: 'skipped' });
    const message = (await floorFinding(runtime))?.message ?? '';
    expect(message).toContain('come from wicked-garden 1.0.0, older than the required 1.2.0');
    expect(message).toContain(GARDEN_UPDATE_COMMAND);
  });

  it('a generation at or above the floor, or no floor, says nothing', async () => {
    expect(await floorFinding((await booted('1.0.0')).runtime)).toBeUndefined();
    expect(await floorFinding((await booted(null)).runtime)).toBeUndefined();
  });

  it('an injected (explicit) garden source is not judged by default, as discovery does not judge one (crew#753)', async () => {
    const { runtime } = await booted(undefined);
    expect(await floorFinding(runtime)).toBeUndefined();
  });

  it('the Nerve Center skills row is down with the garden update command', async () => {
    const { runtime } = await booted('1.1.0');
    await runtime.refreshInstalled();
    const row = skillsRow(runtime.health() as unknown as Parameters<typeof skillsRow>[0]);
    expect(row.state).toBe('down');
    expect(row.reason).toContain('older than the required 1.1.0');
    expect(row.remedy).toBe(GARDEN_FLOOR_REMEDY);
    expect(GARDEN_FLOOR_REMEDY).toContain(GARDEN_UPDATE_COMMAND);
  });

  it('launch and onboarding answer 422 garden_required and /health carries the finding (the crew#753 gates, on the real runtime)', async () => {
    const { runtime } = await booted('1.1.0');
    await runtime.refreshInstalled();
    const adapter = {
      sessionsDetail: vi.fn(async () => []),
      sessions: vi.fn(async () => []),
      listRepos: vi.fn(async () => [{ id: 'repo-alpha', name: 'alpha', root_path: '/x/alpha', registered_at: 1 }]),
      registerRepo: vi.fn(async (name: string, rootPath: string) => ({ id: `repo-${name}`, name, root_path: rootPath, registered_at: 2 })),
      launchOnboardingRun: vi.fn(async (repoId: string) => `onboard-${repoId}`),
      launchRun: vi.fn(async (input: { sessionId: string }) => input.sessionId),
      getSettings: vi.fn(async () => ({ deliverDefault: 'none' })),
      engineCapabilities: vi.fn(() => ({ deliverGate: true, revisesPr: true })),
      ping: vi.fn(async () => 'ok'),
    };
    const app = Fastify({ logger: false });
    registerRoutes(
      app,
      adapter as unknown as CoreAdapter,
      new GateCache(),
      new ElicitationCache(),
      { bus: null, index: new MembershipIndex(), log: () => undefined },
      { audit: AuditLog.noop(), authMode: 'off' },
      { skills: runtime } as Partial<RuntimeDeps>,
    );
    apps.push(app);
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as { warnings?: Array<{ kind: string; severity: string; message: string }> };
    expect(health.warnings).toContainEqual(expect.objectContaining({ kind: 'skills.garden', severity: 'error' }));
    const run = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'x', workflow: 'bug' } });
    expect(run.statusCode).toBe(422);
    expect(run.json()).toMatchObject({ code: 'garden_required', required: REQUIRED_GARDEN_VERSION });
    expect((run.json() as { error: string }).error).toContain('come from wicked-garden 1.0.0');
    expect(adapter.launchRun).not.toHaveBeenCalled();
    const reg = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'gamma', rootPath: '/x/gamma' } });
    expect(reg.statusCode).toBe(422);
    expect(adapter.registerRepo).not.toHaveBeenCalled();
  });
});
