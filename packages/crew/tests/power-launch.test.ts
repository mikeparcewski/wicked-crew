// Power mode at launch (program DES-POWER-MODE; operator ruling 2026-10-29): a New job runs in power
// mode unless the launch or the Settings default says otherwise, only a repo-scoped plan or preset
// launch can, and a power launch has no plan-approval gate (humanConfirm forced to none).

import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ElicitationCache } from '../src/api/elicitation-cache.js';
import { GateCache } from '../src/api/gate-cache.js';
import { registerRoutes } from '../src/api/routes.js';
import type { CoreAdapter } from '../src/core/adapter.js';
import type { LaunchRunInput } from '../src/core/types.js';
import { PersonaStore, type PersonaInput } from '../src/persona/store.js';
import { voiceBlock } from '../src/persona/voice.js';
import { removeScratch } from './setup/scratch.js';

const READ_ONLY_DEF = { id: 'bug', phases: [{ id: 'understand', kind: 'recon', role: 'creator', executes_code: false }] };

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) removeScratch(d);
});

async function launch(opts: {
  supports: boolean;
  setting?: boolean;
  body: Record<string, unknown>;
  personaVoice?: (projectId: string | null) => string | null;
}) {
  const adapter: Record<string, Mock> = {
    launchRun: vi.fn().mockResolvedValue('run-1'),
    getSettings: vi.fn().mockResolvedValue({ graphNodeLimit: 150, deliverDefault: 'none', ...(opts.setting !== undefined ? { powerModeDefault: opts.setting } : {}) }),
    getWorkflow: vi.fn().mockReturnValue(READ_ONLY_DEF),
    supportsPowerMode: vi.fn(() => opts.supports),
    listPresets: vi.fn().mockResolvedValue([{ name: 'bug', scope: 'global', steps: [], created_by: 'builtin', updated_at: 0 }]),
    listRepos: vi.fn().mockResolvedValue([{ id: 'repo-1', name: 'r', root_path: '/nowhere', default_branch: 'main', registered_at: 0 }]),
  };
  const app = Fastify({ logger: false });
  registerRoutes(
    app,
    adapter as unknown as CoreAdapter,
    new GateCache(),
    new ElicitationCache(),
    undefined,
    undefined,
    opts.personaVoice !== undefined ? { personaVoice: opts.personaVoice } : {},
  );
  await app.ready();
  apps.push(app);
  const res = await app.inject({ method: 'POST', url: '/api/v1/runs', payload: { problem: 'fix it', clisJson: '[]', ...opts.body } });
  const input = adapter.launchRun!.mock.calls[0]?.[0] as LaunchRunInput | undefined;
  return { res, input };
}

describe('POST /runs power mode', () => {
  it('keeps a registered (non-preset) workflow\'s gates: it has no orchestrator build', async () => {
    const { res, input } = await launch({ supports: true, body: { workflow: 'my-def', repoRef: 'repo-1', humanConfirm: 'all' } });
    expect(input?.power).toBeUndefined();
    expect(input?.humanConfirm).toBe('all');
    expect(res.json().powerNotice).toMatch(/plan or preset/);
  });

  it('runs a repo-scoped preset launch in power mode by default, with no plan gate', async () => {
    const { res, input } = await launch({ supports: true, body: { workflow: 'bug', repoRef: 'repo-1', humanConfirm: 'before:1' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ runId: 'run-1', power: true });
    expect(input?.power).toBe(true);
    expect(input?.humanConfirm).toBe('none');
  });

  it('honours the Settings default off, and the launch\'s own word over it', async () => {
    const off = await launch({ supports: true, setting: false, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(off.input?.power).toBeUndefined();
    expect(off.res.json().power).toBeUndefined();
    const on = await launch({ supports: true, setting: false, body: { workflow: 'bug', repoRef: 'repo-1', power: true } });
    expect(on.input?.power).toBe(true);
    const no = await launch({ supports: true, body: { workflow: 'bug', repoRef: 'repo-1', power: false, humanConfirm: 'all' } });
    expect(no.input?.power).toBeUndefined();
    expect(no.input?.humanConfirm).toBe('all');
  });

  it('runs phased, and says why, when the launch has no repo or the engine has no power mode', async () => {
    const repoless = await launch({ supports: true, body: { workflow: 'bug', power: true } });
    expect(repoless.input?.power).toBeUndefined();
    expect(repoless.res.json().powerNotice).toMatch(/repo-scoped/);
    const old = await launch({ supports: false, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(old.input?.power).toBeUndefined();
    expect(old.res.json().powerNotice).toMatch(/no power mode/);
    const oldAsked = await launch({ supports: false, body: { workflow: 'bug', repoRef: 'repo-1', power: true } });
    expect(oldAsked.res.json().powerNotice).toMatch(/no power mode/);
  });
});

// wicked-core#1216: the power orchestrator talks to the person in their personality for the run's
// project (the project's override, else theirs). A phased run has no orchestrator, so it gets none.
describe('POST /runs carries the personality to the power orchestrator', () => {
  function personas() {
    const dir = mkdtempSync(join(tmpdir(), 'persona-launch-'));
    dirs.push(dir);
    const store = new PersonaStore({ stateHome: dir });
    return {
      store,
      voice: (projectId: string | null) => {
        const p = store.effective(projectId);
        return p === null ? null : voiceBlock(p.persona);
      },
    };
  }
  const WREN: PersonaInput = { name: 'Wren', colour: '#6366f1', dials: { length: 0, warmth: 0, pushback: 2, initiative: 1 }, habits: ['cites'] };
  const ROOK: PersonaInput = { ...WREN, name: 'Rook' };

  it('sends the person\'s voice block on a power launch, and the project override wins', async () => {
    const { store, voice } = personas();
    store.save('user', WREN);
    store.save('project:proj-a', ROOK);
    const mine = await launch({ supports: true, personaVoice: voice, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(mine.input?.power).toBe(true);
    expect(mine.input?.voice).toBe(voiceBlock({ ...WREN, version: 1, updatedAt: 0 }));
    expect(mine.input?.voice).toMatch(/never what you may do/);
    const other = await launch({ supports: true, personaVoice: voice, body: { workflow: 'bug', repoRef: 'repo-1', projectId: 'proj-b' } });
    expect(other.input?.voice).toMatch(/"Wren"/);
    const overridden = await launch({ supports: true, personaVoice: voice, body: { workflow: 'bug', repoRef: 'repo-1', projectId: 'proj-a' } });
    expect(overridden.input?.voice).toMatch(/"Rook"/);
    expect(overridden.input?.voice).not.toMatch(/"Wren"/);
  });

  it('sends no voice when no personality is saved, or when the run is phased', async () => {
    const { store, voice } = personas();
    const none = await launch({ supports: true, personaVoice: voice, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(none.input?.power).toBe(true);
    expect(none.input).not.toHaveProperty('voice');
    store.save('user', WREN);
    const phased = await launch({ supports: true, personaVoice: voice, body: { workflow: 'bug', repoRef: 'repo-1', power: false } });
    expect(phased.input?.power).toBeUndefined();
    expect(phased.input).not.toHaveProperty('voice');
    const oldEngine = await launch({ supports: false, personaVoice: voice, body: { workflow: 'bug', repoRef: 'repo-1' } });
    expect(oldEngine.input).not.toHaveProperty('voice');
  });
});

