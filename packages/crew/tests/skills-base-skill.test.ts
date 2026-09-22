// The BASE skill (crew#554 — the launcher half of wicked-core#468): every governed agent unit is
// told to follow ONE role-keyed discipline skill; the engine refuses a launch at intake when the
// handed snapshot lacks it. Crew owns the default (`SystemSettings.baseSkillRef`, shipped as
// `wicked-garden-governed-worker`) and the missing-skill policy — `baseSkillPolicy: 'require'`,
// the ONLY value since D-8/D-8b (FIX-IT-ALL L4-⑧): the engine variable is ALWAYS exported and the
// engine refuses a launch at intake when the handed generation lacks the skill; `'warn'` (env left
// unset, runs proceed UNGROUNDED, a /health warning the only signal) is deleted and 400s.
//
// Pure posture → runtime over the fixture store (boot, policy flip, add + publish flips the
// posture, off) → the routes (PUT /settings validation + re-export, GET /health, GET /diagnostics,
// publish / refresh results, the typed 422 `base_skill_refused` launch body).

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import {
  DEFAULT_SETTINGS,
  type BaseSkillRefusedResponse,
  type CrewSystemSettings,
  type DiagnosticsResponse,
  type HealthResponse,
  type SkillPublishResult,
  type SkillRefreshResult,
  type SkillsManifestResponse,
} from '../src/core/types.js';
import {
  applyBaseSkillEnv,
  BASE_SKILL_INSTALL_HINT,
  BASE_SKILL_REF_ENGINE_ENV,
  baseSkillPosture,
  baseSkillRemedy,
  DEFAULT_BASE_SKILL_REF,
  describeBaseSkill,
} from '../src/skills/base-skill.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { bump, scaffold, type Scaffold } from './support/skills-fixture.js';

const GOVERNED = DEFAULT_BASE_SKILL_REF;
/** A skill the fixture catalog SHIPS (published in the first generation). */
const SHIPPED = 'wicked-garden-beta';

const savedBaseSkillEnv = process.env[BASE_SKILL_REF_ENGINE_ENV];
const savedSnapshotEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];

function restoreEnv(): void {
  if (savedBaseSkillEnv === undefined) delete process.env[BASE_SKILL_REF_ENGINE_ENV];
  else process.env[BASE_SKILL_REF_ENGINE_ENV] = savedBaseSkillEnv;
  if (savedSnapshotEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedSnapshotEnv;
}

/** The engine's own refusal text (wicked-core `SkillsError::BaseSkillRefused` Display) — what `launchRun` rejects with. */
const ENGINE_REFUSAL =
  `the base skill "${GOVERNED}" (base_skill_ref — the role-keyed discipline every unit of this run must follow) cannot be handed to the run's workers: ` +
  `the skills snapshot at /state/skills/snapshots/000001 does not hold the skills this run requires: ${GOVERNED}. ` +
  `Publish a skills snapshot that enables it, or clear base_skill_ref (the workflow def's field, or ${BASE_SKILL_REF_ENGINE_ENV}) to run without a base skill — refused at intake, before any unit was planned`;

describe('baseSkillPosture — the pure judgement', () => {
  const holds = (name: string) => (n: string) => n === name;
  const nothing = () => false;

  it('an empty (or blank) name is OFF: no posture, and the env is deleted', () => {
    expect(baseSkillPosture({ ref: '', policy: 'require' }, { gen: 3, skills: [GOVERNED] }, nothing)).toBeNull();
    expect(baseSkillPosture({ ref: '   ', policy: 'require' }, null, nothing)).toBeNull();
    process.env[BASE_SKILL_REF_ENGINE_ENV] = 'stale';
    applyBaseSkillEnv(null);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBeUndefined();
    expect(describeBaseSkill(null)).toBe('discipline skill: off');
  });

  it('present in the published generation: exported, no finding, "discipline skill: <name> gen N" (the name is trimmed)', () => {
    const p = baseSkillPosture({ ref: ` ${GOVERNED} `, policy: 'require' }, { gen: 3, skills: ['wicked-garden-beta', GOVERNED] }, holds(GOVERNED));
    expect(p).toEqual({ name: GOVERNED, policy: 'require', present: true, inCatalog: true, gen: 3, engineInput: GOVERNED, finding: null });
    applyBaseSkillEnv(p);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
    expect(describeBaseSkill(p)).toBe(`discipline skill: ${GOVERNED} gen 3`);
  });

  it('missing: exported anyway (the engine refuses at intake), an ERROR that says so and names the explicit off switch — publish when it is in the catalog, install+refresh+publish when it is not', () => {
    const p = baseSkillPosture({ ref: GOVERNED, policy: 'require' }, { gen: 3, skills: ['wicked-garden-beta'] }, nothing);
    expect(p).toMatchObject({ present: false, inCatalog: false, engineInput: GOVERNED });
    expect(p?.finding).toMatchObject({ kind: 'skills.base-skill', severity: 'error' });
    expect(p?.finding?.message).toContain('REQUIRED');
    expect(p?.finding?.message).toContain('refuses every launch at intake');
    expect(p?.finding?.message).toContain('POST /skills/refresh-baseline, then POST /skills/publish');
    expect(p?.finding?.message).toContain('set baseSkillRef ""');
    expect(p?.finding?.message).not.toContain('baseSkillPolicy "warn"');
    // D-8b: there is NO policy that leaves the env unset while the skill is missing.
    const inCatalog = baseSkillPosture({ ref: GOVERNED, policy: 'require' }, { gen: 3, skills: ['wicked-garden-beta'] }, holds(GOVERNED));
    expect(inCatalog).toMatchObject({ present: false, inCatalog: true, gen: 3, engineInput: GOVERNED });
    expect(inCatalog?.finding?.message).toContain('POST /skills/publish hands it');
    const noSnapshot = baseSkillPosture({ ref: GOVERNED, policy: 'require' }, null, nothing);
    expect(noSnapshot).toMatchObject({ present: false, gen: null, engineInput: GOVERNED });
    expect(noSnapshot?.finding?.message).toContain('no published snapshot is handed to the engine');
    applyBaseSkillEnv(p);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
    expect(describeBaseSkill(p)).toBe(`discipline skill: ${GOVERNED} MISSING — runs will be refused at intake`);
  });

  afterEach(restoreEnv);
});

describe('SkillsRuntime — the base skill follows the ladder, the policy, and every publish', () => {
  let s: Scaffold;
  let lines: string[];
  let runtime: SkillsRuntime;

  beforeEach(() => {
    s = scaffold();
    lines = [];
    runtime = new SkillsRuntime({ store: s.store, log: (m) => lines.push(m) });
  });

  afterEach(() => {
    removeScratch(s.base);
    restoreEnv();
  });

  const baseSkillLines = () => lines.filter((l) => l.startsWith('[skills] skills.base-skill:'));

  it('the shipped default over a fresh catalog WITHOUT the skill: boot EXPORTS the env (the engine refuses launches at intake), errors ONCE, and the finding rides health() — never a silent ungrounded run (D-8b)', async () => {
    expect(DEFAULT_SETTINGS.baseSkillRef).toBe(GOVERNED);
    expect(DEFAULT_SETTINGS.baseSkillPolicy).toBe('require');
    delete process.env[BASE_SKILL_REF_ENGINE_ENV];
    // Configured BEFORE the ladder (the boot order in createServer): the outcome re-judges it.
    runtime.configureBaseSkill(DEFAULT_SETTINGS);
    expect(runtime.baseSkill()).toMatchObject({ name: GOVERNED, present: false, gen: null, engineInput: GOVERNED });
    const health = await runtime.apply();
    expect(health.state).toBe('published');
    expect(health.current?.gen).toBe(1);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
    expect(health.baseSkill).toMatchObject({ name: GOVERNED, policy: 'require', present: false, inCatalog: false, gen: 1, engineInput: GOVERNED });
    expect(health.baseSkill?.finding).toMatchObject({ kind: 'skills.base-skill', severity: 'error' });
    expect(health.findings.filter((f) => f.kind === 'skills.base-skill')).toHaveLength(1);
    expect(runtime.health().findings.some((f) => f.kind === 'skills.base-skill')).toBe(true);
    // Said ONCE, after the ladder ran (the pre-boot judgement is applied silently — it would only
    // be contradicted a moment later), and once per CHANGE of the finding, not once per re-export.
    expect(baseSkillLines()).toHaveLength(1);
    expect(baseSkillLines()[0]).toContain('gen 1');
    expect(baseSkillLines()[0]).toContain(`${BASE_SKILL_REF_ENGINE_ENV} = ${GOVERNED}`);
    runtime.refreshBaseSkill();
    runtime.refreshBaseSkill();
    expect(baseSkillLines()).toHaveLength(1);
  });

  it('a skill the generation HOLDS is exported with no finding; a missing one is exported too and raises an error; "" turns it off', async () => {
    runtime.configureBaseSkill({ baseSkillRef: SHIPPED, baseSkillPolicy: 'require' });
    const health = await runtime.apply();
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(SHIPPED);
    expect(health.baseSkill).toMatchObject({ name: SHIPPED, present: true, inCatalog: true, gen: 1, engineInput: SHIPPED, finding: null });
    expect(health.findings.some((f) => f.kind === 'skills.base-skill')).toBe(false);
    expect(baseSkillLines()).toHaveLength(0);

    const required = runtime.configureBaseSkill({ baseSkillRef: GOVERNED, baseSkillPolicy: 'require' });
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
    expect(required).toMatchObject({ present: false, engineInput: GOVERNED });
    expect(required?.finding?.severity).toBe('error');
    expect(runtime.health().findings.find((f) => f.kind === 'skills.base-skill')?.severity).toBe('error');
    expect(baseSkillLines().at(-1)).toContain(`${BASE_SKILL_REF_ENGINE_ENV} = ${GOVERNED}`);

    expect(runtime.configureBaseSkill({ baseSkillRef: '', baseSkillPolicy: 'require' })).toBeNull();
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBeUndefined();
    expect(runtime.health().baseSkill).toBeNull();
    expect(runtime.health().findings.some((f) => f.kind === 'skills.base-skill')).toBe(false);
  });

  it('adding the skill to the catalog flips the remedy to "publish"; the publish that hands it exports the env, clears the finding and logs the clear', async () => {
    runtime.configureBaseSkill(DEFAULT_SETTINGS);
    await runtime.apply();
    expect(runtime.baseSkill()).toMatchObject({ present: false, inCatalog: false, gen: 1 });

    const rev = s.store.manifest().revision;
    const added = s.store.add(
      GOVERNED,
      { 'SKILL.md': `---\nname: ${GOVERNED}\n---\n\n## creator\n\nRun the checks.\n\n## evaluator\n\nWrite nothing into the tree.\n\n## neutral\n\nDo not implement.\n` },
      rev,
    );
    expect(added.verdict).not.toBe('blocked');
    // The catalog moved, the handed generation did not: still exported (the engine keeps refusing),
    // but the error's remedy now says "publish".
    const staged = runtime.refreshBaseSkill();
    expect(staged).toMatchObject({ present: false, inCatalog: true, gen: 1, engineInput: GOVERNED });
    expect(staged?.finding?.message).toContain('POST /skills/publish hands it');
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);

    const published = await s.store.publish(added.revision);
    expect(published.snapshot?.gen).toBe(2);
    const after = runtime.afterPublish();
    expect(after?.current?.gen).toBe(2);
    expect(after?.baseSkill).toMatchObject({ name: GOVERNED, present: true, inCatalog: true, gen: 2, engineInput: GOVERNED, finding: null });
    expect(after?.findings.some((f) => f.kind === 'skills.base-skill')).toBe(false);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
    expect(baseSkillLines().at(-1)).toContain(`cleared — "${GOVERNED}" is handed from generation 2`);
  });
});

describe('the routes — PUT /settings, GET /health, GET /diagnostics, publish / refresh results, the 422 launch refusal', () => {
  let s: Scaffold;
  let runtime: SkillsRuntime;
  let app: FastifyInstance | undefined;

  /** In-memory settings store with the adapter's exact merge semantics — plus the ping /health needs and a launch the engine refuses. */
  function memoryAdapter(initial?: Partial<CrewSystemSettings>): CoreAdapter {
    let store: CrewSystemSettings = { ...DEFAULT_SETTINGS, ...initial };
    return {
      ping: async () => 'pong',
      getSettings: async () => ({ ...store }),
      updateSettings: async (patch: Partial<CrewSystemSettings>) => {
        store = { ...store, ...patch };
        return { ...store };
      },
      listWorkflows: () => [],
      getWorkflow: () => undefined,
      launchRun: async () => {
        throw new Error(ENGINE_REFUSAL);
      },
    } as unknown as CoreAdapter;
  }

  const build = (adapter: CoreAdapter): FastifyInstance => {
    const fastify = Fastify({ logger: false });
    registerRoutes(fastify, adapter, new GateCache(), new ElicitationCache(), undefined, undefined, undefined, { skills: runtime });
    return fastify;
  };

  const settingsOf = (res: { json(): unknown }) => (res.json() as { settings: CrewSystemSettings }).settings;
  const health = async () => (await app!.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
  const diagnosticsSkills = async () => ((await app!.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse).skills;
  const revision = async () => ((await app!.inject({ method: 'GET', url: '/api/v1/skills' })).json() as SkillsManifestResponse).revision;

  beforeEach(async () => {
    s = scaffold();
    runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    runtime.configureBaseSkill(DEFAULT_SETTINGS);
    await runtime.apply();
    app = build(memoryAdapter());
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    removeScratch(s.base);
    restoreEnv();
  });

  it('GET /settings carries the shipped defaults; GET /health and GET /diagnostics disclose the posture (missing → error, env exported)', async () => {
    const settings = settingsOf(await app!.inject({ method: 'GET', url: '/api/v1/settings' }));
    expect(settings.baseSkillRef).toBe(GOVERNED);
    expect(settings.baseSkillPolicy).toBe('require');
    const h = await health();
    expect(h.baseSkill).toMatchObject({ name: GOVERNED, policy: 'require', present: false, gen: 1, engineInput: GOVERNED });
    expect(h.baseSkill?.finding?.kind).toBe('skills.base-skill');
    const d = await diagnosticsSkills();
    expect(d.state).toBe('published');
    expect(d.baseSkill).toEqual(h.baseSkill);
    expect(d.findings.filter((f) => f.kind === 'skills.base-skill')).toHaveLength(1);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
  });

  it('PUT /settings 400s a bad policy (incl. the deleted "warn" — D-8b), a non-string name and a name that is not a skill name — env untouched', async () => {
    process.env[BASE_SKILL_REF_ENGINE_ENV] = 'before';
    for (const [payload, key] of [
      [{ baseSkillPolicy: 'bogus' }, 'baseSkillPolicy'],
      [{ baseSkillPolicy: 'warn' }, 'baseSkillPolicy'],
      [{ baseSkillPolicy: 7 }, 'baseSkillPolicy'],
      [{ baseSkillRef: 42 }, 'baseSkillRef'],
      [{ baseSkillRef: 'has a space' }, 'baseSkillRef'],
      [{ baseSkillRef: '/etc/passwd' }, 'baseSkillRef'],
      [{ baseSkillRef: 'Upper-Case' }, 'baseSkillRef'],
    ] as const) {
      const put = await app!.inject({ method: 'PUT', url: '/api/v1/settings', payload });
      expect(put.statusCode, JSON.stringify(payload)).toBe(400);
      expect((put.json() as { error: string }).error).toContain(key);
    }
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe('before');
    expect(settingsOf(await app!.inject({ method: 'GET', url: '/api/v1/settings' })).baseSkillRef).toBe(GOVERNED);
  });

  it('PUT /settings re-judges and re-exports at once: a shipped skill → env set + present; require over a missing one → env set + error; "" → off', async () => {
    const shipped = await app!.inject({ method: 'PUT', url: '/api/v1/settings', payload: { baseSkillRef: SHIPPED } });
    expect(shipped.statusCode).toBe(200);
    expect(settingsOf(shipped).baseSkillRef).toBe(SHIPPED);
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(SHIPPED);
    expect((await health()).baseSkill).toMatchObject({ name: SHIPPED, present: true, gen: 1, engineInput: SHIPPED, finding: null });
    expect((await diagnosticsSkills()).findings.some((f) => f.kind === 'skills.base-skill')).toBe(false);

    const required = await app!.inject({ method: 'PUT', url: '/api/v1/settings', payload: { baseSkillRef: GOVERNED, baseSkillPolicy: 'require' } });
    expect(required.statusCode).toBe(200);
    expect(settingsOf(required)).toMatchObject({ baseSkillRef: GOVERNED, baseSkillPolicy: 'require' });
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);
    const d = await diagnosticsSkills();
    expect(d.baseSkill).toMatchObject({ policy: 'require', present: false, engineInput: GOVERNED });
    expect(d.findings.find((f) => f.kind === 'skills.base-skill')?.severity).toBe('error');

    const off = await app!.inject({ method: 'PUT', url: '/api/v1/settings', payload: { baseSkillRef: '' } });
    expect(off.statusCode).toBe(200);
    expect(settingsOf(off).baseSkillRef).toBe('');
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBeUndefined();
    expect((await health()).baseSkill).toBeNull();
    expect((await diagnosticsSkills()).baseSkill).toBeNull();

    // An unrelated settings write leaves the (off) posture and env exactly as they were.
    await app!.inject({ method: 'PUT', url: '/api/v1/settings', payload: { graphNodeLimit: 100 } });
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBeUndefined();
    expect((await health()).baseSkill).toBeNull();
  });

  it('POST /skills/publish and POST /skills/refresh-baseline answer the posture after the operation — a publish without the skill is the error moment (env stays exported; the engine refuses)', async () => {
    bump(s); // boot published gen 1 over this tree; an UNCHANGED publish would answer gen 1 `unchanged` (DES-L6 PR-L6-1) — change it so this one mints gen 2
    const rev = await revision();
    const published = await app!.inject({ method: 'POST', url: '/api/v1/skills/publish', payload: { expectedRevision: rev } });
    expect(published.statusCode).toBe(200);
    const body = published.json() as SkillPublishResult;
    expect(body.snapshot?.gen).toBe(2);
    expect(body.baseSkill).toMatchObject({ name: GOVERNED, present: false, gen: 2, engineInput: GOVERNED });
    expect(body.baseSkill?.finding).toMatchObject({ kind: 'skills.base-skill', severity: 'error' });
    expect(process.env[BASE_SKILL_REF_ENGINE_ENV]).toBe(GOVERNED);

    const refreshed = await app!.inject({ method: 'POST', url: '/api/v1/skills/refresh-baseline', payload: { expectedRevision: await revision() } });
    expect(refreshed.statusCode).toBe(200);
    const refresh = refreshed.json() as SkillRefreshResult;
    expect(refresh.baseSkill).toMatchObject({ name: GOVERNED, present: false, inCatalog: false, gen: 2 });
  });

  it('POST /runs the engine refused at intake for the base skill is a typed 422 base_skill_refused with the posture and a remedy — never a generic 400', async () => {
    const res = await app!.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'triage the flake', clisJson: '[]' } });
    expect(res.statusCode).toBe(422);
    const body = res.json() as BaseSkillRefusedResponse;
    expect(body.code).toBe('base_skill_refused');
    expect(body.error).toBe(ENGINE_REFUSAL);
    expect(body.baseSkill).toMatchObject({ name: GOVERNED, present: false });
    expect(body.remedy).toContain('POST /skills/refresh-baseline, then POST /skills/publish');
    expect(body.remedy).toContain('baseSkillRef ""');
    expect(body.remedy).not.toContain('baseSkillPolicy "warn"');
  });

  it('GET /health carries the base-skill ERROR in `warnings` too — "status ok, no warnings" never coexists with "refuses every launch" (F-W1-102); the finding, the warning and the 422 remedy quote ONE remedy that names the installer', async () => {
    const h = await health();
    expect(h.status).toBe('ok'); // the daemon serves — studio must load and show it (the state-home precedent)
    const finding = h.baseSkill?.finding ?? null;
    expect(finding).not.toBeNull();
    expect(h.warnings).toEqual([{ kind: 'skills.base-skill', severity: 'error', message: finding!.message }]);
    expect(finding!.message).toContain(BASE_SKILL_INSTALL_HINT);
    expect(finding!.message.endsWith(baseSkillRemedy(false))).toBe(true);
    const res = await app!.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'triage the flake', clisJson: '[]' } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as BaseSkillRefusedResponse).remedy).toBe(baseSkillRemedy(false));
    // A publish that hands the skill clears the warning with the finding — one surface, one object.
    // (Covered end to end by the publish tests above; here the shape: no finding ⇒ no warnings key.)
  });
});
