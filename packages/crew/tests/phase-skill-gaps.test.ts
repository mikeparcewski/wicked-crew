// crew#661 — a phase that would run WITHOUT a skill its workflow declares must be visible where an
// operator looks, not only as one warn line on stdout at boot.
//
// The live repro (2026-09-23, 0.7.39): the published snapshot lacked `wicked-garden-draft`, so
// interactive-draft / -edit / -chat armed with NO skill_ref and every run on them proceeded
// unarmed — nothing in /diagnostics, /health, or on the run.
//
// crew#935 (X-MIG M9) retired that degraded arming: interactive-draft / -edit / -chat are wicked-core
// built-in presets that ALWAYS run the skill, so a snapshot without it fails the run instead of
// running it unarmed — no seam arms with a gap any more, and the live arming machinery is deleted.
// Pinned here: /diagnostics and /health report no gap, an accepted launch writes no degraded record,
// and a run that DID run unarmed before keeps its trail record (`skill_gaps`).
//
// Real pieces throughout: a real skills store over the committed fixture plugin (which does NOT
// carry the draft skill), a real SkillsRuntime, the real route set, a real audit trail on disk.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import { createServer } from '../src/api/server.js';
import { CoreAdapter } from '../src/core/adapter.js';
import { DEFAULT_SETTINGS, type DiagnosticsResponse, HealthResponse, SessionView, WorkflowDef } from '../src/core/types.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { setCrewStateHome } from '../src/projects/state-home.js';
import { pluginSourceAt } from '../src/skills/plugin-source.js';
import { noVenv } from '../src/skills/venv.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { BASE_SKILL_REF_ENGINE_ENV } from '../src/skills/base-skill.js';
import { RunSkillGapIndex } from '../src/skills/phase-skill-gaps.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { FIXTURE_PLUGIN, scaffold, type Scaffold } from './support/skills-fixture.js';

const savedSnapshotEnv = process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
const savedBaseSkillEnv = process.env[BASE_SKILL_REF_ENGINE_ENV];
function restoreEnv(): void {
  if (savedSnapshotEnv === undefined) delete process.env[SKILLS_SNAPSHOT_ENGINE_ENV];
  else process.env[SKILLS_SNAPSHOT_ENGINE_ENV] = savedSnapshotEnv;
  if (savedBaseSkillEnv === undefined) delete process.env[BASE_SKILL_REF_ENGINE_ENV];
  else process.env[BASE_SKILL_REF_ENGINE_ENV] = savedBaseSkillEnv;
}

const DRAFT = 'wicked-garden-draft';
/** The remedy is prose (asserted by substring below); everything else is compared exactly. */
function withoutRemedy<T extends { remedy: string }>(g: T): Omit<T, 'remedy'> {
  const { remedy, ...rest } = g;
  void remedy;
  return rest;
}
const DAEMON = { id: 'daemon', kind: 'system', trust: 'admin' } as const;

let s: Scaffold;
let dir: string;
const subs: Array<{ stop(): Promise<void> | void }> = [];
const apps: FastifyInstance[] = [];

beforeEach(() => {
  s = scaffold();
  dir = mkdtempSync(join(tmpdir(), 'crew-661-'));
});
afterEach(async () => {
  for (const sub of subs.splice(0)) await sub.stop();
  for (const a of apps.splice(0)) await a.close();
  removeScratch(s.base);
  removeScratch(dir);
  restoreEnv();
});

function routes(runtime: RuntimeDeps, adapter: Partial<Record<string, unknown>> = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    { ping: async () => 'pong', ...adapter } as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    runtime,
  );
  apps.push(app);
  return app;
}

describe('GET /diagnostics names no phase-skill gap once the seams fail closed (crew#935)', () => {
  it('a published snapshot WITHOUT wicked-garden-draft → phaseSkillGaps [] (the field stays on the wire), no finding, no /health warning', async () => {
    const runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    await runtime.apply();
    expect(runtime.health().state).toBe('published');
    expect(runtime.holdsSkill(DRAFT)).toBe(false); // the fixture catalog does not carry it — the precondition

    const app = routes({ skills: runtime });
    await app.ready();
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    expect(diag.skills.phaseSkillGaps).toEqual([]);
    expect(diag.skills.findings.filter((f) => f.kind === 'skills.phase-skill')).toEqual([]);
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.status).toBe('ok');
    expect((health.warnings ?? []).filter((w) => w.kind === 'skills.phase-skill')).toEqual([]);
  });
});

describe('a run that ran unarmed BEFORE crew#935 keeps saying so on the run record (crew#661)', () => {
  const RUN = 'run-661';
  const OTHER = 'run-armed';
  const view = (id: string, workflow: string): SessionView =>
    ({
      session: { id, workflow_id: workflow, problem: 'p', status: 'completed', clis: [], extra_write_roots: [], archived_at: null, archive_note: null },
      units: [],
    }) as unknown as SessionView;

  it('the trail\'s run.skill.unarmed entry survives a restart and rides GET /runs/:id as skill_gaps; other runs carry no field', async () => {
    const trail = join(dir, 'audit.log');
    const audit = new AuditLog(trail, () => undefined);
    // The record a pre-crew#935 daemon wrote for a run its chat seam launched unarmed.
    audit.record('run.skill.unarmed', DAEMON, {
      runId: RUN,
      detail: { gap: { subsystem: 'interactive-chat', workflow: 'interactive-chat', phases: ['understand', 'revise'], skill: DRAFT, gen: 4, remedy: 'republish the skills snapshot' } },
    });
    await audit.flush();

    // A restarted daemon: a fresh index over the same trail.
    const rehydrated = new RunSkillGapIndex();
    await rehydrated.hydrate(new AuditLog(trail, () => undefined));

    const app = routes(
      { runSkillGaps: rehydrated },
      { sessionsDetail: async () => [view(RUN, 'interactive-chat'), view(OTHER, 'interactive-draft')], listRepos: async () => [] },
    );
    await app.ready();
    const unarmed = (await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN}` })).json() as { run: SessionView };
    expect(unarmed.run.session.skill_gaps?.map(withoutRemedy)).toEqual([
      { subsystem: 'interactive-chat', workflow: 'interactive-chat', phases: ['understand', 'revise'], skill: DRAFT, gen: 4 },
    ]);
    expect(unarmed.run.session.skill_gaps?.[0]?.remedy).toContain('republish the skills snapshot');
    const armed = (await app.inject({ method: 'GET', url: `/api/v1/runs/${OTHER}` })).json() as { run: SessionView };
    expect('skill_gaps' in armed.run.session).toBe(false);
  });
});

describe('the daemon wiring (createServer): the interactive seams arm no skill gap, so nothing is disclosed as degraded (crew#935)', () => {
  let adapter: CoreAdapter | undefined;
  afterEach(() => {
    adapter?.close();
    adapter = undefined;
  });

  /** A daemon over a real (stub-spawned) adapter posing as a real engine, with a published snapshot
   *  that does NOT hold the draft skill: the interactive-* presets fail such a run rather than run
   *  it unarmed, so the seams arm without a gap and an accepted launch writes no degraded record. */
  async function bootDaemon(): Promise<{ app: FastifyInstance; adapter: CoreAdapter; auditPath: string }> {
    const home = join(dir, 'home');
    const a = new CoreAdapter({ dbPath: join(home, 'core.db'), stub: true });
    adapter = a;
    setCrewStateHome(home);
    a.listWorkflows = () => [];
    a.getSettings = async () => ({ ...DEFAULT_SETTINGS });
    Object.defineProperty(a, 'stub', { value: false }); // the stub engine refuses every interactive seam (crew#309)
    const registered: string[] = [];
    a.registerWorkflow = async (def: WorkflowDef) => {
      registered.push(def.id);
      return def.id;
    };
    const core = (a as unknown as { core: { launchRun: (o: { sessionId?: string }) => Promise<string> } }).core;
    core.launchRun = async (o) => o.sessionId ?? 'x';
    const auditPath = join(dir, 'audit.log');
    const app = await createServer(a, {
      auth: { mode: 'off' },
      auditPath,
      projectEvents: { disabled: true },
      interactiveWsRelay: { disabled: true },
      stallWatchdog: { enabled: false },
      studioRoot: join(dir, 'no-studio'),
      skills: { source: () => pluginSourceAt(FIXTURE_PLUGIN), provisionVenv: noVenv },
      interactiveDraftEvents: { enabled: true, dbPath: join(dir, 'bus-d.db'), ledgerPath: join(dir, 'ld.json'), draftDir: join(dir, 'd'), clisJson: '[]' },
      interactiveChatEvents: { enabled: true, dbPath: join(dir, 'bus-c.db'), ledgerPath: join(dir, 'lc.json'), chatDir: join(dir, 'c'), clisJson: '[]' },
    });
    apps.push(app);
    expect(registered.filter((id) => id.startsWith('interactive-'))).toEqual([]); // presets: nothing registered
    return { app, adapter: a, auditPath };
  }

  it('/diagnostics and /health name no phase-skill gap for the interactive seams', async () => {
    const { app } = await bootDaemon();
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    expect(diag.skills.phaseSkillGaps).toEqual([]);
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect((health.warnings ?? []).filter((w) => w.kind === 'skills.phase-skill')).toEqual([]);
  });

  it('an accepted interactive launch writes no run.skill.unarmed record', async () => {
    const { app, adapter: a, auditPath } = await bootDaemon();
    await a.launchRun({ problem: 'p', sessionId: 'accepted-run', workflow: 'interactive-chat', clisJson: '[]' });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const unarmed = (existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { action: string; runId?: string })
      .filter((e) => e.action === 'run.skill.unarmed')
      .map((e) => e.runId);
    expect(unarmed).toEqual([]);
  });
});
