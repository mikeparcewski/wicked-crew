// crew#661 — a phase that would run WITHOUT a skill its workflow declares must be visible where an
// operator looks, not only as one warn line on stdout at boot.
//
// The live repro (2026-09-23, 0.7.39): the published snapshot lacked `wicked-garden-draft`, so
// interactive-draft / -edit / -chat armed with NO skill_ref and every run on them proceeded
// unarmed — nothing in /diagnostics, /health, or on the run.
//
// Real pieces throughout: a real skills store over the committed fixture plugin (which does NOT
// carry the draft skill), a real SkillsRuntime, the three real seams armed over a real bus, the
// real route set, a real audit trail on disk. Expected values are literals from the issue and the
// workflow defs as written — never read back out of the code under test.

process.env['WICKED_MEMORY_EMBEDDER'] = 'hash';

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditLog } from '../src/api/audit.js';
import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes, type RuntimeDeps } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { DiagnosticsResponse, HealthResponse, SessionView, WorkflowDef } from '../src/core/types.js';
import { INTERACTIVE_CHAT_WORKFLOW_DEF, startInteractiveChatSubscriber } from '../src/interactive/chat-events.js';
import { INTERACTIVE_DRAFT_WORKFLOW_DEF, startInteractiveDraftSubscriber } from '../src/interactive/draft-events.js';
import { INTERACTIVE_EDIT_WORKFLOW_DEF, startInteractiveEditSubscriber } from '../src/interactive/edit-events.js';
import { QeGateCache } from '../src/qe/gate-events.js';
import { MembershipIndex } from '../src/projects/membership-index.js';
import { SKILLS_SNAPSHOT_ENGINE_ENV } from '../src/skills/engine-env.js';
import { BASE_SKILL_REF_ENGINE_ENV } from '../src/skills/base-skill.js';
import { PhaseSkillArming, RunSkillGapIndex } from '../src/skills/phase-skill-gaps.js';
import { SkillsRuntime } from '../src/skills/runtime.js';
import { removeScratch } from './setup/scratch.js';
import { scaffold, type Scaffold } from './support/skills-fixture.js';

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

/** The minimal engine the seams arm against (the chat-seam precedent in interactive-draft-skill.test.ts). */
function engine(): { registered: WorkflowDef[]; adapter: CoreAdapter } {
  const registered: WorkflowDef[] = [];
  const adapter = {
    registerWorkflow: async (def: WorkflowDef) => {
      registered.push(def);
      return def.id;
    },
    launchRun: async () => 'r',
    onEvent: () => () => undefined,
  } as unknown as CoreAdapter;
  return { registered, adapter };
}

/** Arm the three real drafting seams exactly as `createServer` wires them: the skill predicate goes through the arming probe. */
async function armSeams(runtime: SkillsRuntime, arming: PhaseSkillArming): Promise<WorkflowDef[]> {
  const eng = engine();
  const held = (name: string): boolean => runtime.holdsSkill(name);
  const common = { pollIntervalMs: 25, clisJson: '[]', log: () => undefined };
  const draft = await startInteractiveDraftSubscriber(eng.adapter, {
    ...common,
    dbPath: join(dir, 'bus-d.db'),
    ledgerPath: join(dir, 'ld.json'),
    draftDir: join(dir, 'd'),
    skillHeld: arming.probe('interactive-draft', INTERACTIVE_DRAFT_WORKFLOW_DEF, held),
  });
  const edit = await startInteractiveEditSubscriber(eng.adapter, {
    ...common,
    dbPath: join(dir, 'bus-e.db'),
    ledgerPath: join(dir, 'le.json'),
    editDir: join(dir, 'e'),
    skillHeld: arming.probe('interactive-edit', INTERACTIVE_EDIT_WORKFLOW_DEF, held),
  });
  const chat = await startInteractiveChatSubscriber(eng.adapter, {
    ...common,
    dbPath: join(dir, 'bus-c.db'),
    ledgerPath: join(dir, 'lc.json'),
    chatDir: join(dir, 'c'),
    skillHeld: arming.probe('interactive-chat', INTERACTIVE_CHAT_WORKFLOW_DEF, held),
  });
  for (const sub of [draft, edit, chat]) {
    expect(sub).not.toBeNull();
    subs.push(sub!);
  }
  return eng.registered;
}

function routes(runtime: RuntimeDeps, adapter: Partial<Record<string, unknown>> = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    { ping: async () => 'pong', ...adapter } as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    new QeGateCache(),
    { bus: null, index: new MembershipIndex(), log: () => undefined },
    { audit: AuditLog.noop(), authMode: 'off' },
    runtime,
  );
  apps.push(app);
  return app;
}

describe('GET /diagnostics names every subsystem whose phases armed without their declared skill (crew#661)', () => {
  it('a published snapshot WITHOUT wicked-garden-draft → one structured entry per drafting seam, a skills.phase-skill finding each, and /health warns', async () => {
    const runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    await runtime.apply();
    expect(runtime.health().state).toBe('published');
    expect(runtime.holdsSkill(DRAFT)).toBe(false); // the fixture catalog does not carry it — the precondition

    const arming = new PhaseSkillArming(() => runtime.health().current?.gen ?? null, () => 1_700_000_000_000);
    const registered = await armSeams(runtime, arming);
    // The seams really did arm UNARMED (the degraded state the entry must describe).
    for (const def of registered) for (const p of def.phases) expect(p.skill_ref).toBeNull();

    const app = routes({ skills: runtime, phaseSkills: arming });
    await app.ready();
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    const gaps = diag.skills.phaseSkillGaps;
    expect(gaps?.map(withoutRemedy)).toEqual([
      { subsystem: 'interactive-chat', workflow: 'interactive-chat', phases: ['understand', 'revise'], skill: DRAFT, gen: 1, armedAt: 1_700_000_000_000 },
      { subsystem: 'interactive-draft', workflow: 'interactive-draft', phases: ['outline', 'draft'], skill: DRAFT, gen: 1, armedAt: 1_700_000_000_000 },
      { subsystem: 'interactive-edit', workflow: 'interactive-edit', phases: ['edit'], skill: DRAFT, gen: 1, armedAt: 1_700_000_000_000 },
    ]);
    for (const g of gaps!) {
      expect(g.remedy).toContain('republish the skills snapshot');
      expect(g.remedy).toContain(DRAFT);
      expect(g.remedy).toContain('restart crew');
    }
    const findings = diag.skills.findings.filter((f) => f.kind === 'skills.phase-skill');
    expect(findings).toHaveLength(3);
    for (const f of findings) {
      expect(f.severity).toBe('warning');
      expect(f.message).toContain(`'${DRAFT}'`);
      expect(f.message).toContain('generation 1');
    }
    expect(findings.map((f) => f.message.split(':')[0])).toEqual(['interactive-chat', 'interactive-draft', 'interactive-edit']);

    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect(health.status).toBe('ok');
    expect((health.warnings ?? []).filter((w) => w.kind === 'skills.phase-skill')).toHaveLength(3);
  });

  it('a published snapshot that HOLDS wicked-garden-draft → no entry, no finding, no warning', async () => {
    const runtime = new SkillsRuntime({ store: s.store, log: () => undefined });
    await runtime.apply(); // boot: seed + first publish (generation 1, no draft skill)
    const rev = s.store.manifest().revision;
    const added = s.store.add(DRAFT, { 'SKILL.md': `---\nname: ${DRAFT}\ndescription: the document quality floor\n---\n\n# Draft\n\nRun the self-check.\n` }, rev);
    expect(added.verdict).not.toBe('blocked');
    const published = await s.store.publish(added.revision);
    expect(published.snapshot?.gen).toBe(2);
    runtime.afterPublish();
    expect(runtime.holdsSkill(DRAFT)).toBe(true); // the precondition

    const arming = new PhaseSkillArming(() => runtime.health().current?.gen ?? null);
    const registered = await armSeams(runtime, arming);
    for (const def of registered) for (const p of def.phases) expect(p.skill_ref).toBe(DRAFT);

    const app = routes({ skills: runtime, phaseSkills: arming });
    await app.ready();
    const diag = (await app.inject({ method: 'GET', url: '/api/v1/diagnostics' })).json() as DiagnosticsResponse;
    expect(diag.skills.phaseSkillGaps).toEqual([]);
    expect(diag.skills.findings.filter((f) => f.kind === 'skills.phase-skill')).toEqual([]);
    const health = (await app.inject({ method: 'GET', url: '/api/v1/health' })).json() as HealthResponse;
    expect((health.warnings ?? []).filter((w) => w.kind === 'skills.phase-skill')).toEqual([]);
  });
});

describe('a run launched on an unarmed seam says so on the run record (degrade-and-disclose, crew#661)', () => {
  const RUN = 'run-661';
  const OTHER = 'run-armed';
  const view = (id: string, workflow: string): SessionView =>
    ({
      session: { id, workflow_id: workflow, problem: 'p', status: 'completed', clis: [], extra_write_roots: [], archived_at: null, archive_note: null },
      units: [],
    }) as unknown as SessionView;

  it('the handed launch on an unarmed workflow is recorded durably, survives a restart, and rides GET /runs/:id as skill_gaps; other runs carry no field', async () => {
    const arming = new PhaseSkillArming(() => 4);
    arming.record('interactive-chat', INTERACTIVE_CHAT_WORKFLOW_DEF, DRAFT, false);
    arming.record('interactive-draft', INTERACTIVE_DRAFT_WORKFLOW_DEF, DRAFT, true);

    const trail = join(dir, 'audit.log');
    const audit = new AuditLog(trail, () => undefined);
    const live = new RunSkillGapIndex();
    const warn = vi.fn();
    live.onLaunch({ kind: 'run', id: RUN, status: 'handed', workflow: 'interactive-chat' }, arming, audit, DAEMON, warn);
    live.onLaunch({ kind: 'run', id: OTHER, status: 'handed', workflow: 'interactive-draft' }, arming, audit, DAEMON, warn);
    live.onLaunch({ kind: 'run', id: 'resumed', status: 'handed' }, arming, audit, DAEMON, warn);
    await audit.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`run ${RUN}`);

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
