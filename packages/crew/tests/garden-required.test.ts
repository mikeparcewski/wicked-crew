// crew#753: a crew-only install cannot onboard — wicked-garden is required. The daemon says so as a
// plain blocking finding naming found vs required, never silently uses an older garden, and a
// refused onboard creates no repo row (core has no unregister, so the refusal is judged first).

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import { GateCache } from '../src/api/gate-cache.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { AuditLog } from '../src/api/audit.js';
import { REQUIRED_GARDEN_VERSION, gardenMeetsMinimum, livePluginCacheDir } from '../src/skills/plugin-source.js';
import { gardenTooOldFinding, refusalPath, SkillsRuntime } from '../src/skills/runtime.js';
import { noVenv } from '../src/skills/venv.js';
import { SkillsStore } from '../src/skills/store.js';
import { removeScratch } from './setup/scratch.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { SkillsHealthFinding } from '../src/skills/runtime.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
});

const BASE_MISSING: SkillsHealthFinding = {
  kind: 'skills.base-skill',
  severity: 'error',
  message: 'the base skill "wicked-garden-governed-worker" is REQUIRED but no published snapshot is handed to the engine',
};

function routes(skills: { findings: SkillsHealthFinding[]; basePresent: boolean }) {
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
  const posture = {
    name: 'wicked-garden-governed-worker',
    policy: 'require' as const,
    present: skills.basePresent,
    inCatalog: false,
    gen: null,
    engineInput: 'wicked-garden-governed-worker',
    finding: skills.basePresent ? null : BASE_MISSING,
  };
  const runtime = {
    skills: { health: () => ({ findings: skills.findings }), baseSkill: () => posture, reportedBaseSkill: () => posture, publishingFinding: () => null } as unknown as SkillsRuntime,
  } as Partial<RuntimeDeps>;
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    runtime,
  );
  apps.push(app);
  return { app, adapter };
}

const OLD = gardenTooOldFinding({ version: '12.32.1', path: '/cfg/plugins/wicked-garden' }, 'the installed plugin');

describe('crew#753 — garden is required, and a refused onboard creates no repo row', () => {
  it('no garden (the base skill is missing): POST /repos is a 422 base_skill_refused and nothing is registered', async () => {
    const { app, adapter } = routes({ findings: [BASE_MISSING], basePresent: false });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'gamma', rootPath: '/x/gamma' } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'base_skill_refused' });
    expect((res.json() as { remedy: string }).remedy).toContain(`wicked-garden >= ${REQUIRED_GARDEN_VERSION}`);
    expect(adapter.registerRepo).not.toHaveBeenCalled();
    expect(adapter.launchOnboardingRun).not.toHaveBeenCalled();
    const again = await app.inject({ method: 'POST', url: '/api/v1/repos/repo-alpha/onboard' });
    expect(again.statusCode).toBe(422);
    expect(adapter.launchOnboardingRun).not.toHaveBeenCalled();
  });

  it('an older garden: a blocking finding naming found vs required on /health; onboard and launch are 422 garden_required, nothing registered or launched', async () => {
    const { app, adapter } = routes({ findings: [OLD], basePresent: true });
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as { warnings?: SkillsHealthFinding[] };
    expect(health.warnings).toContainEqual(expect.objectContaining({ kind: 'skills.garden', severity: 'error' }));
    const msg = health.warnings?.find((w) => w.kind === 'skills.garden')?.message ?? '';
    expect(msg).toContain('wicked-garden 12.32.1');
    expect(msg).toContain(`older than the required ${REQUIRED_GARDEN_VERSION}`);
    expect(msg).toContain('npx wicked-installer install wicked-garden');

    const reg = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'gamma', rootPath: '/x/gamma' } });
    expect(reg.statusCode).toBe(422);
    expect(reg.json()).toEqual({ code: 'garden_required', error: OLD.message, required: REQUIRED_GARDEN_VERSION });
    expect(adapter.registerRepo).not.toHaveBeenCalled();
    const run = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'x', workflow: 'bug' } });
    expect(run.statusCode).toBe(422);
    expect((run.json() as { code: string }).code).toBe('garden_required');
    expect(adapter.launchRun).not.toHaveBeenCalled();
  });

  it('a usable garden: POST /repos registers and onboards as before', async () => {
    const { app, adapter } = routes({ findings: [], basePresent: true });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { name: 'gamma', rootPath: '/x/gamma' } });
    expect(res.statusCode).toBe(201);
    expect(adapter.registerRepo).toHaveBeenCalledTimes(1);
  });

  it('the skills runtime never seeds from an older installed garden: config-error, a refusal path for the engine, the skills.garden finding', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'garden-required-')));
    dirs.push(dir);
    const cfg = join(dir, 'cfg');
    const old = join(livePluginCacheDir(cfg), '12.32.1');
    mkdirSync(join(old, '.claude-plugin'), { recursive: true });
    writeFileSync(join(old, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'wicked-garden', version: '12.32.1' }));
    const saved = { cfg: process.env['CLAUDE_CONFIG_DIR'], home: process.env['HOME'], src: process.env['WICKED_CREW_SKILLS_SOURCE'], snap: process.env['WICKED_SKILLS_SNAPSHOT'] };
    process.env['CLAUDE_CONFIG_DIR'] = cfg;
    process.env['HOME'] = join(dir, 'home'); // never the operator's real ~/.claude
    delete process.env['WICKED_CREW_SKILLS_SOURCE'];
    try {
      const store = new SkillsStore({ root: join(dir, 'skills'), registeredSkillRefs: () => new Set<string>(), provisionVenv: noVenv, warn: () => undefined });
      const rt = new SkillsRuntime({ store, log: () => undefined, bootSnapshot: undefined });
      const health = await rt.apply();
      expect(health.state).toBe('config-error');
      expect(health.findings.map((f) => f.kind)).toContain('skills.garden');
      expect(health.findings.find((f) => f.kind === 'skills.garden')?.message).toContain(`wicked-garden 12.32.1 (the installed plugin at ${old}) is older than the required ${REQUIRED_GARDEN_VERSION}`);
      expect(process.env['WICKED_SKILLS_SNAPSHOT']).toBe(refusalPath(join(dir, 'skills'), 'skills.garden'));
    } finally {
      for (const [k, v] of [['CLAUDE_CONFIG_DIR', saved.cfg], ['HOME', saved.home], ['WICKED_CREW_SKILLS_SOURCE', saved.src], ['WICKED_SKILLS_SNAPSHOT', saved.snap]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// crew 0.18.0: the draft landing floor and refine keep check (leak_scan/notes_check/keep_check), the
// editor and run-plugin conformance cases, learn's report mode and the Respond/Rework draft kinds first
// ship together in wicked-garden 12.66.0, and 12.66.1's run-plugin scaffold reports its first height (CJ9), so an
// older garden is too old.
describe('the floor is the garden that ships the scripts crew 0.18.0 calls', () => {
  it('12.66.1 is required: 12.66.0 and 12.65.x are refused, 12.66.1 and later pass', () => {
    expect(REQUIRED_GARDEN_VERSION).toBe('12.66.1');
    for (const v of ['12.40.0', '12.64.0', '12.65.1', '12.66.0']) expect(gardenMeetsMinimum(v)).toBe(false);
    for (const v of ['12.66.1', '12.66.2', '12.67.0', '13.0.0']) expect(gardenMeetsMinimum(v)).toBe(true);
    expect(gardenTooOldFinding({ version: '12.65.1', path: '/cfg/plugins/wicked-garden' }, 'the installed plugin').message)
      .toContain('wicked-garden 12.65.1 (the installed plugin at /cfg/plugins/wicked-garden) is older than the required 12.66.1');
  });
});
